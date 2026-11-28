import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { connectPipe, type CdpEvent } from '../src/cover/cdp.ts';
import { probeHtmlEntryFrame } from './multi-file-stages/markdown-links-runner.ts';

type Failure = { method: string; code: number; message: string };

function fakeFrame(failure?: Failure) {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const cdp = connectPipe(toChrome, fromChrome);
  const events: CdpEvent[] = [];
  const requests: Array<{ method: string; params?: Record<string, unknown> }> =
    [];
  cdp.onEvent((event) => events.push(event));
  toChrome.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString('utf8').slice(0, -1)) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    requests.push(request);
    const send = (message: Record<string, unknown>) => {
      fromChrome.write(`${JSON.stringify(message)}\0`);
    };
    if (request.method === 'Page.getFrameTree') {
      send({
        method: 'Page.frameAttached',
        params: { frameId: 'child-frame', parentFrameId: 'root-frame' },
        sessionId: 'session',
      });
    }
    if (failure?.method === request.method) {
      if (request.method === 'Page.createIsolatedWorld') {
        send({
          method: 'Page.frameDetached',
          params: { frameId: 'child-frame', reason: 'remove' },
          sessionId: 'session',
        });
      }
      send({
        id: request.id,
        error: { code: failure.code, message: failure.message },
      });
    } else if (request.method === 'Page.getFrameTree') {
      send({
        id: request.id,
        result: {
          frameTree: { childFrames: [{ frame: { id: 'child-frame' } }] },
        },
      });
    } else if (request.method === 'Page.createIsolatedWorld') {
      send({ id: request.id, result: { executionContextId: 42 } });
    } else if (request.method === 'Runtime.evaluate') {
      send({ id: request.id, result: { result: { value: true } } });
    } else {
      throw new Error(`Unexpected CDP request: ${request.method}`);
    }
  });
  return { cdp, events, requests };
}

describe('multi-file HTML entry frame probe', () => {
  test('reports a frame detached after the tree snapshot as gone', async () => {
    const { cdp, events, requests } = fakeFrame({
      method: 'Page.createIsolatedWorld',
      code: -32602,
      message: 'No frame for given id found',
    });
    try {
      expect(await probeHtmlEntryFrame(cdp, 'session', [])).toBe('gone');
      expect(requests.map((request) => request.method)).toEqual([
        'Page.getFrameTree',
        'Page.createIsolatedWorld',
      ]);
      expect(requests[1]?.params?.['frameId']).toBe('child-frame');
      expect(events.map((event) => event.method)).toEqual([
        'Page.frameAttached',
        'Page.frameDetached',
      ]);
    } finally {
      cdp.dispose();
    }
  });

  for (const failure of [
    {
      method: 'Page.createIsolatedWorld',
      code: -32602,
      message: 'Invalid parameters',
    },
    {
      method: 'Page.createIsolatedWorld',
      code: -32603,
      message: 'No frame for given id found',
    },
    {
      method: 'Page.getFrameTree',
      code: -32602,
      message: 'No frame for given id found',
    },
  ]) {
    test(`propagates ${failure.method} error ${failure.code}: ${failure.message}`, async () => {
      const { cdp } = fakeFrame(failure);
      try {
        await expect(
          probeHtmlEntryFrame(cdp, 'session', [])
        ).rejects.toMatchObject(failure);
      } finally {
        cdp.dispose();
      }
    });
  }

  test('evaluates the isolated world when the frame remains attached', async () => {
    const { cdp, requests } = fakeFrame();
    try {
      expect(await probeHtmlEntryFrame(cdp, 'session', [])).toBe('rendered');
      expect(requests[2]?.params?.['contextId']).toBe(42);
    } finally {
      cdp.dispose();
    }
  });
});
