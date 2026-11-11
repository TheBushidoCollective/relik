import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  COVER_CAP_BYTES,
  COVER_HEIGHT,
  COVER_WIDTH,
  type CoverSource,
  crc32,
} from '@relic/format/cover';
import type { CdpConnection, CdpEvent } from '../src/cover/cdp.ts';
import type { RunningChrome } from '../src/cover/chrome.ts';
import {
  chromeCoverRenderer,
  COVER_MAX_SOURCE_BYTES,
} from '../src/cover/render.ts';
import { handleRequestPaused } from '../src/cover/virtual-origin.ts';

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const typeAndData = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(typeAndData));
  return chunk;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function makeIhdr(
  width = COVER_WIDTH,
  height = COVER_HEIGHT,
  bitDepth = 8,
  colorType = 2
): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return makeChunk('IHDR', data);
}

function makeValidPng(): Uint8Array {
  const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * 3));
  const idat = makeChunk('IDAT', deflateSync(rawPixels));
  const iend = makeChunk('IEND', new Uint8Array(0));
  return concat(PNG_SIGNATURE, makeIhdr(), idat, iend);
}

function makeOversizedPng(): Uint8Array {
  const scanlineLen = 1 + COVER_WIDTH * 3;
  const rawPixels = new Uint8Array(COVER_HEIGHT * scanlineLen);
  for (let y = 0; y < COVER_HEIGHT; y++) {
    const start = y * scanlineLen;
    rawPixels[start] = 0;
    crypto.getRandomValues(rawPixels.subarray(start + 1, start + scanlineLen));
  }
  const bigCompressed = deflateSync(rawPixels);
  return concat(
    PNG_SIGNATURE,
    makeIhdr(),
    makeChunk('IDAT', bigCompressed),
    makeChunk('IEND', new Uint8Array(0))
  );
}

function makeValidJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...new Array(64).fill(1),
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x02,
    0x76,
    0x04,
    0xb0,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xc4,
    0x00,
    0x1f,
    0x00,
    0x00,
    0x01,
    0x05,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b,
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x12,
    0x34,
    0xff,
    0x00,
    0x56,
    0xff,
    0xd9,
  ]);
}

class FakeCdpConnection implements CdpConnection {
  readonly calls: Array<{
    method: string;
    params?: Record<string, unknown> | undefined;
    sessionId?: string | undefined;
  }> = [];
  private eventListeners: Array<(event: CdpEvent) => void> = [];
  public closed = Promise.resolve();

  constructor(
    public screenshotPngData: string,
    public screenshotJpegData?: string,
    public protocolValue: unknown = 1,
    public renderReturnValue: unknown = { ok: true },
    public hangOnSend = false
  ) {}

  emit(event: CdpEvent): void {
    for (const l of this.eventListeners) {
      l(event);
    }
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    if (this.hangOnSend) {
      return new Promise(() => {});
    }
    this.calls.push({ method, params, sessionId });

    if (method === 'Target.createTarget') {
      return { targetId: 't-123' };
    }
    if (method === 'Target.attachToTarget') {
      return { sessionId: 'sess-456' };
    }
    if (method === 'Runtime.evaluate') {
      const expr = params?.['expression'] as string;
      if (expr?.includes('window.__relicCover.protocol')) {
        return { result: { value: this.protocolValue } };
      }
      if (expr?.startsWith('window.__relicCover.render(')) {
        return { result: { value: this.renderReturnValue } };
      }
    }
    if (method === 'Page.captureScreenshot') {
      const format = params?.['format'];
      if (format === 'png') {
        return { data: this.screenshotPngData };
      }
      return { data: this.screenshotJpegData ?? '' };
    }
    return {};
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  async waitForEvent(
    method: string,
    options: {
      readonly sessionId?: string;
      readonly timeoutMs: number;
      readonly predicate?: (event: CdpEvent) => boolean;
    }
  ): Promise<CdpEvent> {
    if (options.sessionId !== undefined) {
      return { method, params: {}, sessionId: options.sessionId };
    }
    return { method, params: {} };
  }

  dispose(): void {}
}

class FakeRunningChrome implements RunningChrome {
  public closeCount = 0;
  constructor(
    readonly cdp: CdpConnection,
    readonly product = 'FakeChrome/1.0'
  ) {}

  async close(): Promise<void> {
    this.closeCount++;
  }
}

describe('cover-render', () => {
  let tempAssetDir: string;

  beforeAll(async () => {
    tempAssetDir = await mkdtemp(join(tmpdir(), 'relic-cover-assets-'));
    await writeFile(
      join(tempAssetDir, 'index.html'),
      '<!doctype html><title>Cover</title>'
    );
    await writeFile(join(tempAssetDir, 'cover.js'), '// cover.js');
    await writeFile(join(tempAssetDir, 'cover.css'), '/* cover.css */');
    await writeFile(join(tempAssetDir, 'styles.css'), '/* styles.css */');
    await writeFile(
      join(tempAssetDir, 'frame.html'),
      '<!doctype html><title>Frame</title>'
    );
    await writeFile(join(tempAssetDir, 'pdf.worker.mjs'), '// worker');
  });

  afterAll(async () => {
    await rm(tempAssetDir, { recursive: true, force: true });
  });

  test('uses the fallback over 100 MiB without opening Chrome and keeps the boundary eligible', async () => {
    let discoveries = 0;
    const renderer = chromeCoverRenderer(
      {
        chromePath: undefined,
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 10000,
      },
      {
        discoverChrome: async () => {
          discoveries += 1;
          return { kind: 'disabled', detail: 'disabled for test' };
        },
      }
    );
    const bytes = new Uint8Array(COVER_MAX_SOURCE_BYTES + 1);
    bytes.set(PNG_SIGNATURE);
    const source: CoverSource = {
      filename: 'large.png',
      mimetype: 'image/png',
      rendererClass: 'image',
      bytes,
    };

    expect(await renderer(source)).toMatchObject({
      status: 'skipped',
      reason: 'over_render_ceiling',
    });
    expect(discoveries).toBe(0);
    expect(
      await renderer({
        ...source,
        bytes: bytes.subarray(0, COVER_MAX_SOURCE_BYTES),
      })
    ).toMatchObject({ status: 'skipped', reason: 'browser_disabled' });
    expect(discoveries).toBe(1);
  });

  test('asserts exact CDP call sequence and returns rendered outcome', async () => {
    const validPng = makeValidPng();
    const fakeCdp = new FakeCdpConnection(
      Buffer.from(validPng).toString('base64')
    );
    let launchedChrome: FakeRunningChrome | undefined;

    const renderer = chromeCoverRenderer(
      {
        chromePath: '/dummy/chrome',
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 10000,
      },
      {
        discoverChrome: async () => ({
          kind: 'found',
          path: '/dummy/chrome',
          source: 'default',
        }),
        launchChrome: async () => {
          launchedChrome = new FakeRunningChrome(fakeCdp);
          return launchedChrome;
        },
      }
    );

    const source: CoverSource = {
      filename: 'doc.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: new TextEncoder().encode('# Heading\nHello world\n'),
    };

    const outcome = await renderer(source);
    expect(outcome.status).toBe('rendered');
    if (outcome.status === 'rendered') {
      expect(outcome.type).toBe('image/png');
      expect(outcome.kind).toBe('markdown');
    }
    // Assert exact CDP sequence per contract:
    // 1. Target.createTarget
    // 2. Target.attachToTarget
    // 3. Fetch.enable
    // 4. Page.enable
    // 5. Runtime.enable
    // 6. Emulation.setDeviceMetricsOverride
    // 7. Emulation.setEmulatedMedia
    // 8. Page.navigate
    // 9. Runtime.evaluate (protocol)
    // 10. Runtime.evaluate (render)
    // 11. Page.captureScreenshot
    const callMethods = fakeCdp.calls.map((c) => c.method);
    expect(callMethods).toEqual([
      'Target.createTarget',
      'Target.attachToTarget',
      'Fetch.enable',
      'Page.enable',
      'Runtime.enable',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setEmulatedMedia',
      'Page.navigate',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Page.captureScreenshot',
    ]);

    // Check parameters on key calls
    expect(fakeCdp.calls[0]?.params).toEqual({ url: 'about:blank' });
    expect(fakeCdp.calls[1]?.params).toEqual({
      targetId: 't-123',
      flatten: true,
    });
    expect(fakeCdp.calls[5]?.params).toEqual({
      width: 600,
      height: 315,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(fakeCdp.calls[6]?.params).toEqual({
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    expect(fakeCdp.calls[7]?.params).toEqual({
      url: 'https://cover.relic.invalid/index.html',
    });
    expect(fakeCdp.calls[10]?.params).toEqual({
      format: 'png',
      captureBeyondViewport: false,
    });

    // Verify close was called
    expect(launchedChrome?.closeCount).toBe(1);
  });

  test('asserts JPEG fallback when PNG exceeds size cap', async () => {
    const oversizedPng = makeOversizedPng();
    expect(oversizedPng.length).toBeGreaterThan(COVER_CAP_BYTES);

    const validJpeg = makeValidJpeg();
    const fakeCdp = new FakeCdpConnection(
      Buffer.from(oversizedPng).toString('base64'),
      Buffer.from(validJpeg).toString('base64')
    );

    const renderer = chromeCoverRenderer(
      {
        chromePath: '/dummy/chrome',
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 10000,
      },
      {
        discoverChrome: async () => ({
          kind: 'found',
          path: '/dummy/chrome',
          source: 'default',
        }),
        launchChrome: async () => new FakeRunningChrome(fakeCdp),
      }
    );

    const source: CoverSource = {
      filename: 'code.js',
      mimetype: 'text/javascript',
      rendererClass: 'code',
      bytes: new TextEncoder().encode('const x = 1;\n'),
    };

    const outcome = await renderer(source);
    expect(outcome.status).toBe('rendered');
    if (outcome.status === 'rendered') {
      expect(outcome.type).toBe('image/jpeg');
      expect(outcome.kind).toBe('code');
    }

    // Should have captured PNG, then captured JPEG q85
    const screenshotCalls = fakeCdp.calls.filter(
      (c) => c.method === 'Page.captureScreenshot'
    );
    expect(screenshotCalls.length).toBe(2);
    expect(screenshotCalls[0]?.params).toEqual({
      format: 'png',
      captureBeyondViewport: false,
    });
    expect(screenshotCalls[1]?.params).toEqual({
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: false,
    });
  });

  test('mutation proof: remove Fetch.failRequest fallback branch and a test must fail', async () => {
    const fakeCdp = new FakeCdpConnection('');
    const sessionId = 'sess-test';

    // 1. Valid request to /index.html is fulfilled
    const validEvent: CdpEvent = {
      method: 'Fetch.requestPaused',
      sessionId,
      params: {
        requestId: 'req-1',
        request: { url: 'https://cover.relic.invalid/index.html' },
      },
    };
    await handleRequestPaused(fakeCdp, sessionId, validEvent, {
      assetDir: tempAssetDir,
    });

    const fulfillCall = fakeCdp.calls.find(
      (c) => c.method === 'Fetch.fulfillRequest'
    );
    expect(fulfillCall).toBeDefined();
    expect(fulfillCall?.params?.['requestId']).toBe('req-1');

    // 2. Request to disallowed or external URL must fail with BlockedByClient
    const maliciousEvent: CdpEvent = {
      method: 'Fetch.requestPaused',
      sessionId,
      params: {
        requestId: 'req-2',
        request: { url: 'https://attacker.example.com/exfiltrate' },
      },
    };
    await handleRequestPaused(fakeCdp, sessionId, maliciousEvent, {
      assetDir: tempAssetDir,
    });

    const failCall = fakeCdp.calls.find(
      (c) => c.method === 'Fetch.failRequest'
    );
    expect(failCall).toBeDefined();
    expect(failCall?.params).toEqual({
      requestId: 'req-2',
      errorReason: 'BlockedByClient',
    });
  });

  test('closes Chrome always, even when CDP command throws an error', async () => {
    const fakeCdp = new FakeCdpConnection('');
    // Override send to throw
    fakeCdp.send = async () => {
      throw new Error('Connection abruptly closed by peer');
    };

    let launchedChrome: FakeRunningChrome | undefined;
    const renderer = chromeCoverRenderer(
      {
        chromePath: '/dummy/chrome',
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 10000,
      },
      {
        discoverChrome: async () => ({
          kind: 'found',
          path: '/dummy/chrome',
          source: 'default',
        }),
        launchChrome: async () => {
          launchedChrome = new FakeRunningChrome(fakeCdp);
          return launchedChrome;
        },
      }
    );

    const source: CoverSource = {
      filename: 'file.html',
      mimetype: 'text/html',
      rendererClass: 'html',
      bytes: new TextEncoder().encode('<p>hi</p>'),
    };

    const outcome = await renderer(source);
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('render_failed');
    }
    expect(launchedChrome?.closeCount).toBe(1);
  });

  test('kills Chrome and returns render_timeout when deadline expires', async () => {
    const validPng = makeValidPng();
    // Hang on send to trigger deadline
    const fakeCdp = new FakeCdpConnection(
      Buffer.from(validPng).toString('base64'),
      undefined,
      1,
      { ok: true },
      true
    );

    let launchedChrome: FakeRunningChrome | undefined;
    const renderer = chromeCoverRenderer(
      {
        chromePath: '/dummy/chrome',
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 20,
      },
      {
        discoverChrome: async () => ({
          kind: 'found',
          path: '/dummy/chrome',
          source: 'default',
        }),
        launchChrome: async () => {
          launchedChrome = new FakeRunningChrome(fakeCdp);
          return launchedChrome;
        },
      }
    );

    const source: CoverSource = {
      filename: 'doc.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: new TextEncoder().encode('# Test\n'),
    };

    const outcome = await renderer(source);
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('render_timeout');
    }
    expect(launchedChrome?.closeCount).toBeGreaterThanOrEqual(1);
  });

  test('deadline resolves render_timeout even when RunningChrome close() never settles and page never finishes', async () => {
    const validPng = makeValidPng();
    const fakeCdp = new FakeCdpConnection(
      Buffer.from(validPng).toString('base64'),
      undefined,
      1,
      { ok: true },
      true
    );

    let killed = false;
    const fakeHangingChrome: RunningChrome = {
      cdp: fakeCdp,
      product: 'HangingChrome/1.0',
      close: () => new Promise(() => {}),
      kill: () => {
        killed = true;
      },
    };

    const renderer = chromeCoverRenderer(
      {
        chromePath: '/dummy/chrome',
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 25,
      },
      {
        discoverChrome: async () => ({
          kind: 'found',
          path: '/dummy/chrome',
          source: 'default',
        }),
        launchChrome: async () => fakeHangingChrome,
      }
    );

    const source: CoverSource = {
      filename: 'hanging.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: new TextEncoder().encode('# Hanging Test\n'),
    };

    const outcome = await renderer(source);
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('render_timeout');
      expect(outcome.detail).toContain('25ms');
    }
    expect(killed).toBe(true);
  });
  test('fails with render_failed if protocol check does not equal 1', async () => {
    const validPng = makeValidPng();
    const fakeCdp = new FakeCdpConnection(
      Buffer.from(validPng).toString('base64'),
      undefined,
      0 // wrong protocol
    );

    let launchedChrome: FakeRunningChrome | undefined;
    const renderer = chromeCoverRenderer(
      {
        chromePath: '/dummy/chrome',
        ffmpegPath: undefined,
        assetDir: tempAssetDir,
        deadlineMs: 10000,
      },
      {
        discoverChrome: async () => ({
          kind: 'found',
          path: '/dummy/chrome',
          source: 'default',
        }),
        launchChrome: async () => {
          launchedChrome = new FakeRunningChrome(fakeCdp);
          return launchedChrome;
        },
      }
    );

    const source: CoverSource = {
      filename: 'doc.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: new TextEncoder().encode('# Heading\n'),
    };

    const outcome = await renderer(source);
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('render_failed');
      expect(outcome.detail).toBe(
        'cover renderer assets are from a different build'
      );
    }
    expect(launchedChrome?.closeCount).toBe(1);
  });
});
