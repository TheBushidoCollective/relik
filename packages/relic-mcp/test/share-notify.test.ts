import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeKey, deriveCommentKey, encryptComment } from '@relic/format';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { handleMessage, SHARE_TOOL_NAME } from '../src/server.ts';
import { loadPublishState } from '../src/state.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;
let sentMails: { to: string; mail: OutboundMail }[] = [];
let fakeNow = Date.now();

function shimFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));

    if (url.origin === SERVICE) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }

    if (url.hostname === 'storage.invalid') {
      const key = url.pathname.replace(/^\/(?:upload|o)\//, '');

      if (init?.method === 'PUT') {
        const body = init.body as Uint8Array;
        storage.put(key, new Uint8Array(body));
        return new Response(null, { status: 200 });
      }

      const bytes = await storage.read(key);
      if (bytes === undefined) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-share-notify-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  storage = new MemoryStorage();
  store = new MemoryStore();
  sentMails = [];
  fakeNow = Date.now();
  app = createApp({
    storage,
    store,
    now: () => fakeNow,
    mailer: {
      send: async () => {},
      sendMail: async (to, mail) => {
        sentMails.push({ to, mail });
      },
    },
  });
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: shimFetch(),
    clientName: 'relic-mcp/share-notify-test',
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

async function createSession(
  email = 'reader@example.test',
  expiresAt = fakeNow + 3600 * 1000
): Promise<string> {
  const token = `session-token-${Math.random()}`;
  const tokenHash = await sha256Hex(token);
  await store.putSession({
    tokenHash,
    email,
    createdAt: fakeNow,
    expiresAt,
  });
  return `relic_session=${token}`;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    deps
  );
  return (response?.result ?? {}) as Record<string, unknown>;
}

describe('share-notify integration with server', () => {
  test('commenter plus two shared addresses produces 3 notices with 1 email per recipient', async () => {
    const filePath = join(scratch, 'draft.md');
    await writeFile(filePath, '# Draft v1\n');
    const published = await publish(
      { path: filePath, title: 'Draft Doc' },
      deps
    );

    // 1. Seed verified reader and post a comment
    const cookie = await createSession('reader@example.test');
    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('State missing');
    const key = decodeKey(state.key);
    const commentKey = await deriveCommentKey(key);
    const ciphertext = await encryptComment(commentKey, {
      body: 'Reader feedback on v1',
      display_name: null,
      anchor: null,
    });

    const commentRes = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.11',
        },
        body: JSON.stringify({ ciphertext }),
      })
    );
    expect(commentRes.status).toBe(201);
    const commentJson = (await commentRes.json()) as { comment_id: string };
    const commentId = commentJson.comment_id;

    // 2. Share to two addresses
    const shareRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: published.relic_id,
      emails: ['Ada@example.test', 'grace@example.test'],
    });
    expect(shareRes['isError']).toBe(false);

    // 3. Republish v2 with addresses
    sentMails = [];
    await writeFile(filePath, '# Draft v2\n');
    const repubRes = await republish(
      {
        relic_id: published.relic_id,
        path: filePath,
        addresses: [{ comment_id: commentId, note: 'Fixed based on feedback' }],
      },
      deps
    );
    expect(repubRes.version).toBe(2);

    // Exactly 3 notices sent
    expect(sentMails.length).toBe(3);
    const recipients = sentMails.map((m) => m.to).sort();
    expect(recipients).toEqual([
      'ada@example.test',
      'grace@example.test',
      'reader@example.test',
    ]);

    // Reader receives exactly 1 email
    const readerMails = sentMails.filter((m) => m.to === 'reader@example.test');
    expect(readerMails.length).toBe(1);

    // Notices are keyless and contain stop headers
    for (const { mail } of sentMails) {
      expect(mail.text).not.toContain('#');
      expect(mail.html).not.toContain('#');
      expect(mail.headers?.['List-Unsubscribe']).toBeDefined();
      expect(mail.headers?.['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click'
      );
    }
  });

  test('notify: false sends 0 notices', async () => {
    const filePath = join(scratch, 'quiet.md');
    await writeFile(filePath, '# Quiet v1\n');
    const published = await publish({ path: filePath }, deps);

    await callTool(SHARE_TOOL_NAME, {
      relic_id: published.relic_id,
      emails: ['user@example.test'],
    });

    sentMails = [];
    fakeNow += 11 * 60 * 1000;
    await writeFile(filePath, '# Quiet v2\n');
    const repubRes = await republish(
      {
        relic_id: published.relic_id,
        path: filePath,
        notify: false,
      },
      deps
    );
    expect(repubRes.version).toBe(2);
    expect(sentMails.length).toBe(0);
  });

  test('notify: false skips the change notice but still tells the commenter their comment was answered', async () => {
    const filePath = join(scratch, 'ack.md');
    await writeFile(filePath, '# Ack v1\n');
    const published = await publish({ path: filePath, title: 'Ack Doc' }, deps);
    const cookie = await createSession('reader@example.test');
    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('State missing');
    const commentKey = await deriveCommentKey(decodeKey(state.key));
    const ciphertext = await encryptComment(commentKey, {
      body: 'Reader feedback on v1',
      display_name: null,
      anchor: null,
    });
    const commentRes = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.11',
        },
        body: JSON.stringify({ ciphertext }),
      })
    );
    expect(commentRes.status).toBe(201);
    const { comment_id: commentId } = (await commentRes.json()) as {
      comment_id: string;
    };
    sentMails = [];
    await writeFile(filePath, '# Ack v2\n');
    const repubRes = await republish(
      {
        relic_id: published.relic_id,
        path: filePath,
        title: 'Ack Doc',
        notify: false,
        addresses: [{ comment_id: commentId, note: 'Fixed in v2.' }],
      },
      deps
    );
    expect(repubRes.version).toBe(2);
    expect(repubRes.notify).toBe(false);
    expect(repubRes.acknowledgements).toHaveLength(1);
    expect(sentMails.map(({ to, mail }) => [to, mail.subject])).toEqual([
      ['reader@example.test', 'Your comment on "Ack Doc" was answered'],
    ]);
    expect(sentMails[0]?.mail.text).toContain(
      'The publisher answered your comment on "Ack Doc".'
    );
  });

  test('a repeated share counts once', async () => {
    const filePath = join(scratch, 'repeat.md');
    await writeFile(filePath, '# Repeat v1\n');
    const published = await publish({ path: filePath }, deps);

    const share1 = await callTool(SHARE_TOOL_NAME, {
      relic_id: published.relic_id,
      emails: ['dup@example.test'],
    });
    const s1 = share1['structuredContent'] as {
      added: number;
      shared_count: number;
    };
    expect(s1.added).toBe(1);
    expect(s1.shared_count).toBe(1);

    const share2 = await callTool(SHARE_TOOL_NAME, {
      relic_id: published.relic_id,
      emails: ['dup@example.test'],
    });
    const s2 = share2['structuredContent'] as {
      added: number;
      shared_count: number;
    };
    expect(s2.added).toBe(0);
    expect(s2.shared_count).toBe(1);

    sentMails = [];
    fakeNow += 11 * 60 * 1000;
    await writeFile(filePath, '# Repeat v2\n');
    await republish({ relic_id: published.relic_id, path: filePath }, deps);

    expect(sentMails.length).toBe(1);
    expect(sentMails[0]?.to).toBe('dup@example.test');
  });

  test('the store holds no #', async () => {
    const filePath = join(scratch, 'hashless.md');
    await writeFile(filePath, '# Hashless v1\n');
    const published = await publish({ path: filePath }, deps);

    await callTool(SHARE_TOOL_NAME, {
      relic_id: published.relic_id,
      emails: ['check@example.test'],
    });

    const relicRow = await store.getRelic(published.relic_id);
    expect(relicRow).toBeDefined();
    for (const [_key, val] of Object.entries(relicRow ?? {})) {
      if (typeof val === 'string') {
        expect(val).not.toContain('#');
      }
    }

    const shares = await store.listShares(published.relic_id);
    for (const share of shares) {
      for (const [_key, val] of Object.entries(share)) {
        if (typeof val === 'string') {
          expect(val).not.toContain('#');
        }
      }
    }
  });
});
