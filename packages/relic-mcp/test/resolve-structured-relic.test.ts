import { fetchUpload } from './upload-fixture.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import type { CommentRecord } from '../src/comments.ts';
import { postComment, readComments } from '../src/comments.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { handleMessage, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;

function shimFetch(): typeof globalThis.fetch {
  const shim = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.origin === SERVICE) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }
    if (url.hostname === 'storage.invalid') {
      const key = url.pathname.replace(/^\/(?:upload|o)\//, '');
      if (init?.method === 'PUT') {
        storage.put(key, new Uint8Array(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const bytes = await storage.read(key);
      if (bytes === undefined) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  return Object.assign(shim, { preconnect: globalThis.fetch.preconnect });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-structured-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  storage = new MemoryStorage();
  store = new MemoryStore();
  app = createApp({
    storage,
    store,
    mailer: {
      send: async () => {},
      sendMail: async (_to: string, _mail: OutboundMail) => {},
    },
  });
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: shimFetch(),
    upload: fetchUpload,
    clientName: 'relic-mcp/resolve-structured-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
});

async function publishText(name: string, text: string): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, text);
  const published = await publish({ path, cover: false }, deps);
  return published.relic_id;
}

async function readBack(relicId: string): Promise<CommentRecord[]> {
  const read = await readComments(relicId, deps, {
    version: '*',
    resolve_anchors: true,
  });
  return [...read.comments];
}

const SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'alpha',
  '',
  '2',
  '00:00:01,000 --> 00:00:03,000',
  'beta',
  '',
].join('\n');

describe('structured anchors through a published relic', () => {
  test('a time anchor on an SRT relic resolves to its cues, not to the non-video refusal', async () => {
    const relicId = await publishText('lines.srt', SRT);
    await postComment(
      {
        relic_id: relicId,
        body: 'Check the overlap.',
        anchor: { kind: 'time', t: 1.5 },
      },
      deps
    );
    const [comment] = await readBack(relicId);
    expect(comment?.resolved).toMatchObject({
      kind: 'time',
      status: 'resolved',
      cue_count: 2,
    });
    expect(
      comment?.resolved?.kind === 'time' && 'cues' in comment.resolved
    ).toBe(true);
    if (comment?.resolved?.kind !== 'time' || !('cues' in comment.resolved)) {
      throw new Error('expected a cue resolution');
    }
    expect(comment.resolved.cues.map((cue) => cue.text)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  test('a cell anchor on a CSV relic resolves against the published file', async () => {
    const relicId = await publishText('parts.csv', 'name,qty\nwidget,3\n');
    await postComment(
      {
        relic_id: relicId,
        body: 'Wrong qty.',
        anchor: { kind: 'cell', row: 2, col: 2 },
      },
      deps
    );
    const [comment] = await readBack(relicId);
    expect(comment?.resolved).toMatchObject({
      kind: 'cell',
      status: 'resolved',
      text: '3',
      header: 'qty',
      line: 2,
    });
  });

  test('a cell past the end of the file is a not-found result, not an error', async () => {
    const relicId = await publishText('short.csv', 'a,b\nc,d\n');
    await postComment(
      {
        relic_id: relicId,
        body: 'Row 9?',
        anchor: { kind: 'cell', row: 9, col: 1 },
      },
      deps
    );
    const [comment] = await readBack(relicId);
    expect(comment?.resolved).toMatchObject({
      kind: 'cell',
      status: 'unresolvable',
      explanation: expect.stringContaining('row 9 is past the end of the file'),
    });
  });

  test('a path anchor on a notebook relic resolves with its cell type', async () => {
    const notebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          source: ['x = 1'],
          outputs: [],
        },
      ],
    });
    const relicId = await publishText('demo.ipynb', notebook);
    await postComment(
      {
        relic_id: relicId,
        body: 'Rename this.',
        anchor: { kind: 'path', pointer: '/cells/0' },
      },
      deps
    );
    const [comment] = await readBack(relicId);
    expect(comment?.resolved).toMatchObject({
      kind: 'path',
      status: 'resolved',
      type: 'cell',
      cell_type: 'code',
      excerpt: 'x = 1',
    });
  });

  test('the public read tool prints hostile cell text JSON-encoded and capped', async () => {
    const hostile = '<img src=x onerror=alert(1)>\u202e\u001b[31m';
    const relicId = await publishText('hostile.csv', `"${hostile}",2\n`);
    await postComment(
      {
        relic_id: relicId,
        body: 'Look at this.',
        anchor: { kind: 'cell', row: 1, col: 1 },
      },
      deps
    );
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: READ_COMMENTS_TOOL_NAME,
          arguments: { relic_id: relicId, version: '*', resolve_anchors: true },
        },
      },
      deps
    );
    const result = response?.result;
    const blocks =
      typeof result === 'object' && result !== null && 'content' in result
        ? result.content
        : undefined;
    const first = Array.isArray(blocks) ? blocks[0] : undefined;
    if (
      typeof first !== 'object' ||
      first === null ||
      !('text' in first) ||
      typeof first.text !== 'string'
    ) {
      throw new Error('expected a text content block from the read tool');
    }
    const text = first.text;
    expect(text).toContain('"<img src=x onerror=alert(1)>\\u202e\\u001b[31m"');
    expect(text).not.toContain('\u202e');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('"<img src=x onerror=alert(1)>');
  });
});
