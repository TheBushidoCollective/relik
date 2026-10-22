import { describe, expect, test } from 'bun:test';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';
import {
  OTIO_VIDEO_TIMING_LIMITS,
  type OtioVideoTimingDemuxApi,
  type OtioVideoTimingPacket,
  scanOtioVideoTimingWithApi,
  windowsFromOtioVideoPackets,
} from '../src/otio-video-timing-scanner.ts';

type FakeDemuxOptions = {
  readonly format?: unknown;
  readonly tracks?: readonly { readonly id: number }[];
  readonly packets?: readonly OtioVideoTimingPacket[];
  readonly read?: readonly [number, number];
  readonly warning?: 'warn' | 'error';
};

type FakeDemuxState = {
  sourceOptions:
    | {
        readonly getSize: () => number;
        readonly read: (start: number, end: number) => Promise<Uint8Array>;
        readonly dispose: () => void;
        readonly maxCacheSize: number;
        readonly prefetchProfile: 'none';
      }
    | undefined;
  inputDisposals: number;
  packetOptions: unknown[];
  readonly listeners: Record<
    'warn' | 'error',
    Set<(args: unknown[]) => unknown>
  >;
};

function fakeDemux(options: FakeDemuxOptions = {}): {
  readonly api: OtioVideoTimingDemuxApi;
  readonly state: FakeDemuxState;
} {
  const mp4 = { format: 'MP4' };
  const qtff = { format: 'QTFF' };
  const webm = { format: 'WEBM' };
  const state: FakeDemuxState = {
    sourceOptions: undefined,
    inputDisposals: 0,
    packetOptions: [],
    listeners: { warn: new Set(), error: new Set() },
  };

  class FakeSource {
    constructor(
      readonly options: NonNullable<FakeDemuxState['sourceOptions']>
    ) {
      state.sourceOptions = options;
    }
  }

  class FakeInput {
    constructor(readonly options: { readonly source: FakeSource }) {}

    async getFormat(): Promise<unknown> {
      if (options.read) {
        await this.options.source.options.read(
          options.read[0],
          options.read[1]
        );
      }
      return options.format ?? webm;
    }

    async getVideoTracks(): Promise<{ readonly id: number }[]> {
      if (options.warning) {
        for (const listener of state.listeners[options.warning]) listener([]);
      }
      return [...(options.tracks ?? [{ id: 1 }])];
    }

    dispose(): void {
      state.inputDisposals += 1;
      this.options.source.options.dispose();
    }
  }

  class FakeSink {
    constructor(readonly track: { readonly id: number }) {}

    async getFirstPacket(
      packetOptions: unknown
    ): Promise<OtioVideoTimingPacket | null> {
      state.packetOptions.push(packetOptions);
      return options.packets?.[0] ?? null;
    }

    async getNextPacket(
      packet: OtioVideoTimingPacket,
      packetOptions: unknown
    ): Promise<OtioVideoTimingPacket | null> {
      state.packetOptions.push(packetOptions);
      const packets = options.packets ?? [];
      const index = packets.indexOf(packet);
      return packets[index + 1] ?? null;
    }
  }

  const api: OtioVideoTimingDemuxApi = {
    CustomSource:
      FakeSource as unknown as OtioVideoTimingDemuxApi['CustomSource'],
    Input: FakeInput as unknown as OtioVideoTimingDemuxApi['Input'],
    EncodedPacketSink:
      FakeSink as unknown as OtioVideoTimingDemuxApi['EncodedPacketSink'],
    Logging: {
      on(event, listener) {
        state.listeners[event].add(listener);
        return () => state.listeners[event].delete(listener);
      },
    },
    MP4: mp4,
    QTFF: qtff,
    WEBM: webm,
  };
  return { api, state };
}

function windows(timing: OtioVideoTiming): {
  readonly starts: number[];
  readonly ends: number[];
} {
  if (timing.kind !== 'windows')
    throw new Error(`expected windows: ${timing.reason}`);
  return { starts: [...timing.starts], ends: [...timing.ends] };
}

describe('OTIO packet presentation windows', () => {
  test('sorts decode-order records by actual PTS, preserves positive origins, and leaves gaps uncovered', () => {
    const timing = windowsFromOtioVideoPackets(
      [
        { timestamp: 5.2, duration: 0.05 },
        { timestamp: 5, duration: 0.1 },
        { timestamp: 5.5, duration: 0 },
      ],
      null
    );

    expect(windows(timing)).toEqual({
      starts: [5, 5.2],
      ends: [5.1, 5.25],
    });
  });

  test('uses next actual WebM packet PTS and leaves a zero-duration terminal packet unknown', () => {
    const timing = windowsFromOtioVideoPackets(
      [
        { timestamp: 0, duration: 0.033 },
        { timestamp: 0.033, duration: 0.034 },
        { timestamp: 0.067, duration: 0 },
      ],
      null
    );

    expect(windows(timing)).toEqual({
      starts: [0, 0.033],
      ends: [0.033, 0.067],
    });
  });

  test('clips negative preroll without shifting the presentation origin', () => {
    const timing = windowsFromOtioVideoPackets(
      [{ timestamp: -0.5, duration: 1 }],
      null
    );

    expect(windows(timing)).toEqual({ starts: [0], ends: [0.5] });
  });

  test('rejects duplicate PTS, unsafe edit tails, and exhausted index capacity', () => {
    expect(
      windowsFromOtioVideoPackets(
        [
          { timestamp: 0, duration: 0.1 },
          { timestamp: 0, duration: 0.1 },
        ],
        null
      )
    ).toEqual({ kind: 'unknown', reason: 'invalid-packet-timing' });

    expect(
      windowsFromOtioVideoPackets(
        [
          { timestamp: 0, duration: 0.5 },
          { timestamp: 1.25, duration: 0.5 },
        ],
        { start: 0, end: 1, movieTimescale: 1000 }
      )
    ).toEqual({ kind: 'unknown', reason: 'edit-window-mismatch' });

    expect(
      windowsFromOtioVideoPackets(
        [{ timestamp: 0, duration: 0.1 }],
        null,
        Float64Array.BYTES_PER_ELEMENT * 2 - 1
      )
    ).toEqual({ kind: 'unknown', reason: 'index-budget' });
  });
});

describe('OTIO metadata scanner budgets and cleanup', () => {
  test('uses metadata-only sequential retrieval, fixed source limits, and removes resources', async () => {
    const { api, state } = fakeDemux({
      packets: [
        { timestamp: 0.04, duration: 0.04 },
        { timestamp: 0, duration: 0.04 },
      ],
    });

    const result = await scanOtioVideoTimingWithApi(
      new Blob([new Uint8Array(64)]),
      'video/anything-is-not-trusted',
      api
    );

    expect(windows(result)).toEqual({
      starts: [0, 0.04],
      ends: [0.04, 0.08],
    });
    expect(state.sourceOptions?.maxCacheSize).toBe(
      OTIO_VIDEO_TIMING_LIMITS.maxSourceCacheBytes
    );
    expect(state.sourceOptions?.prefetchProfile).toBe('none');
    expect(state.packetOptions).toEqual([
      { metadataOnly: true, skipLiveWait: true },
      { metadataOnly: true, skipLiveWait: true },
      { metadataOnly: true, skipLiveWait: true },
    ]);
    expect(state.inputDisposals).toBe(1);
    expect(state.listeners.warn.size).toBe(0);
    expect(state.listeners.error.size).toBe(0);
  });

  test('fails explicit scanner caps and warnings without returning partial windows', async () => {
    const tooLarge = {
      size: OTIO_VIDEO_TIMING_LIMITS.maxFileBytes + 1,
    } as Blob;
    await expect(
      scanOtioVideoTimingWithApi(tooLarge, 'video/webm', fakeDemux().api)
    ).resolves.toEqual({ kind: 'unknown', reason: 'file-too-large' });

    const packetCap = fakeDemux({
      packets: [
        { timestamp: 0, duration: 0.1 },
        { timestamp: 0.1, duration: 0.1 },
        { timestamp: 0.2, duration: 0.1 },
      ],
    });
    await expect(
      scanOtioVideoTimingWithApi(
        new Blob([new Uint8Array(64)]),
        'video/webm',
        packetCap.api,
        { limits: { maxPackets: 2 } }
      )
    ).resolves.toEqual({ kind: 'unknown', reason: 'packet-budget' });

    const readCap = fakeDemux({ read: [0, 16] });
    await expect(
      scanOtioVideoTimingWithApi(
        new Blob([new Uint8Array(16)]),
        'video/webm',
        readCap.api,
        { limits: { maxReadBytes: 8 } }
      )
    ).resolves.toEqual({ kind: 'unknown', reason: 'read-budget' });

    const warning = fakeDemux({ warning: 'warn' });
    await expect(
      scanOtioVideoTimingWithApi(
        new Blob([new Uint8Array(64)]),
        'video/webm',
        warning.api
      )
    ).resolves.toEqual({ kind: 'unknown', reason: 'demux-warning' });
  });

  test('uses byte classification and rejects ambiguous tracks before guessing', async () => {
    const unsupported = fakeDemux({ format: { not: 'a supported format' } });
    await expect(
      scanOtioVideoTimingWithApi(
        new Blob([new Uint8Array(64)]),
        'video/mp4',
        unsupported.api
      )
    ).resolves.toEqual({ kind: 'unknown', reason: 'unsupported-container' });

    const ambiguous = fakeDemux({ tracks: [] });
    await expect(
      scanOtioVideoTimingWithApi(
        new Blob([new Uint8Array(64)]),
        'video/webm',
        ambiguous.api
      )
    ).resolves.toEqual({ kind: 'unknown', reason: 'ambiguous-video-track' });
  });
});
