import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { CdpEvent } from '../src/cover/cdp.ts';
import type { RunningChrome } from '../src/cover/chrome.ts';
import {
  type ProgramRenderJob,
  RENDER_MESSAGES,
  renderInBrowser,
} from '../src/program/render.ts';

const DOCUMENT_SHA = 'd'.repeat(64);
const CHUNK_BINDING = '__relicProgramChunk';
const PAGES = { html: new Uint8Array(), js: new Uint8Array() };
const PROGRAM = {
  frame_rate: { num: 24, den: 1 },
  frames: 24,
  width: 320,
  height: 240,
  video_codec: 'avc1.42001f',
  video_bitrate: 1_000_000,
  audio_codec: 'mp4a.40.2',
  audio_rate: 48000,
  channels: 2,
  audio_samples: 48000,
  range: {
    start_time: { value: 0, rate: 24 },
    duration: { value: 24, rate: 24 },
  },
};

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A scripted browser over the same CDP surface renderInBrowser uses. Each
 * render request is answered with the next MP4 in `mp4s`, delivered as one
 * chunk, so a test controls exactly what the page returns.
 */
function scriptedBrowser(ids: readonly string[], mp4s: readonly Uint8Array[]) {
  const listeners: Array<(event: CdpEvent) => void> = [];
  const requests: Record<string, unknown>[] = [];
  const cdp = {
    onEvent(listener: (event: CdpEvent) => void) {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    async waitForEvent() {
      return {} as CdpEvent;
    },
    async send(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> {
      if (method === 'Browser.getVersion')
        return { product: 'HeadlessChrome/fake' };
      if (method === 'Target.createBrowserContext')
        return { browserContextId: 'ctx' };
      if (method === 'Target.createTarget') return { targetId: 'target' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params['expression']);
      if (expression.startsWith('window.__relicProgram && ')) {
        return { result: { value: 1 } };
      }
      const prefix = 'window.__relicProgram.render(';
      const request = JSON.parse(expression.slice(prefix.length, -1)) as Record<
        string,
        unknown
      >;
      requests.push(request);
      const index = request['timeline_index'] as number;
      const mp4 = mp4s[index]!;
      const payload = `0:${Buffer.from(mp4).toString('base64')}`;
      for (const listener of [...listeners]) {
        listener({
          sessionId: 'session',
          method: 'Runtime.bindingCalled',
          params: { name: CHUNK_BINDING, payload },
        } as unknown as CdpEvent);
      }
      return {
        result: {
          value: {
            ok: true,
            document_sha256: DOCUMENT_SHA,
            timeline_id: ids[index],
            byte_length: mp4.length,
            sha256: sha(mp4),
            program: PROGRAM,
          },
        },
      };
    },
  };
  const running = {
    cdp,
    close: async () => {},
  } as unknown as RunningChrome;
  return { running, requests };
}

function jobFor(
  ids: readonly string[],
  maxTotalBytes: number
): ProgramRenderJob {
  return {
    contentText: '{}',
    documentSha256: DOCUMENT_SHA,
    timelineIds: ids,
    media: [],
    readMedia: async () => new Uint8Array(),
    maxTotalBytes,
    forceEncoderAbsent: false,
  };
}

const IDS = ['timeline-a', 'timeline-b'];
const deadline = () => Date.now() + 60_000;

describe('the render budget spans every timeline of one job', () => {
  test('the second timeline is capped at the budget left after the first', async () => {
    const mp4a = new Uint8Array(600).fill(1);
    const mp4b = new Uint8Array(300).fill(2);
    const { running, requests } = scriptedBrowser(IDS, [mp4a, mp4b]);
    const output = await renderInBrowser(
      running,
      PAGES,
      jobFor(IDS, 1000),
      deadline()
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]!['max_bytes']).toBe(1000);
    expect(requests[1]!['max_bytes']).toBe(400);
    expect(output.outcomes[0]!.status).toBe('rendered');
    expect(output.outcomes[1]!.status).toBe('rendered');
  });

  test('a budget spent by the first timeline skips the second evaluate with budgetSpent', async () => {
    const mp4a = new Uint8Array(600).fill(1);
    const mp4b = new Uint8Array(10).fill(2);
    const { running, requests } = scriptedBrowser(IDS, [mp4a, mp4b]);
    const output = await renderInBrowser(
      running,
      PAGES,
      jobFor(IDS, 600),
      deadline()
    );
    expect(requests).toHaveLength(1);
    const second = output.outcomes[1]!;
    expect(second.status).toBe('unavailable');
    if (second.status === 'unavailable') {
      expect(second.reasons[0]!.code).toBe('size-cap-exceeded');
      expect(second.reasons[0]!.message).toBe(RENDER_MESSAGES.budgetSpent);
    }
  });

  test('a chunk above the timeline cap is a length mismatch and never rendered', async () => {
    const mp4 = new Uint8Array(600).fill(1);
    const { running } = scriptedBrowser(['timeline-a'], [mp4]);
    const output = await renderInBrowser(
      running,
      PAGES,
      jobFor(['timeline-a'], 400),
      deadline()
    );
    const outcome = output.outcomes[0]!;
    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') {
      expect(outcome.reasons[0]!.message).toBe(RENDER_MESSAGES.lengthMismatch);
    }
  });
});
