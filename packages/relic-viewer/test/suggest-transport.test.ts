import { describe, expect, test } from 'bun:test';
import { deriveCommentKey, type CommentPlaintext } from '@relic/format';
import { codeSegments } from '../src/markdown-source.ts';
import {
  SuggestDraftModel,
  type PendingSuggestion,
  type SuggestCommit,
} from '../src/suggest-draft.ts';
import {
  SuggestTransport,
  suggestCipher,
  type SuggestCipher,
} from '../src/suggest-transport.ts';

const reader = 'reader@example.com';
const version = 3;
const keyBytes = new Uint8Array([
  9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10,
]);

type WriteCommit = Extract<SuggestCommit, { kind: 'save' | 'delete' }>;
interface Row {
  comment_id: string;
  author: string;
  ciphertext: string;
  version: number | null;
}
interface Call {
  url: string;
  method: string;
  body: string | null;
  keepalive: boolean;
}

class FakeService {
  readonly rows: Row[] = [];
  readonly calls: Call[] = [];
  readonly openedWrites: CommentPlaintext[] = [];
  loseNextResponse = false;
  failNextBeforeWrite = false;
  private serial = 0;

  constructor(readonly cipher: SuggestCipher) {}

  async seed(
    plaintext: CommentPlaintext,
    author = reader,
    rowVersion = version
  ): Promise<string> {
    const id = `seed-${++this.serial}`;
    this.rows.push({
      comment_id: id,
      author,
      ciphertext: await this.cipher.seal(plaintext),
      version: rowVersion,
    });
    return id;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    this.calls.push({ url, method, body, keepalive: init?.keepalive === true });
    if (method === 'GET') return Response.json(this.rows);
    if (this.failNextBeforeWrite) {
      this.failNextBeforeWrite = false;
      throw new Error('offline before write');
    }
    const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    if (method === 'DELETE') {
      const index = this.rows.findIndex((row) => row.comment_id === id);
      if (index < 0) return new Response(null, { status: 404 });
      this.rows.splice(index, 1);
      if (this.loseNextResponse) {
        this.loseNextResponse = false;
        throw new Error('lost response');
      }
      return new Response(null, { status: 204 });
    }
    if (body === null) throw new Error('missing body');
    const request: unknown = JSON.parse(body);
    if (
      typeof request !== 'object' ||
      request === null ||
      !('ciphertext' in request) ||
      typeof request.ciphertext !== 'string'
    ) {
      throw new Error('bad request');
    }
    // Every accepted write is opened by the real format reader.
    this.openedWrites.push(await this.cipher.open(request.ciphertext));
    if (method === 'POST') {
      if (!('version' in request) || typeof request.version !== 'number')
        throw new Error('missing version');
      const row: Row = {
        comment_id: `comment-${++this.serial}`,
        author: reader,
        ciphertext: request.ciphertext,
        version: request.version,
      };
      this.rows.push(row);
      if (this.loseNextResponse) {
        this.loseNextResponse = false;
        throw new Error('lost response');
      }
      return Response.json(
        { comment_id: row.comment_id, author: row.author },
        { status: 201 }
      );
    }
    if (method === 'PATCH') {
      const row = this.rows.find((item) => item.comment_id === id);
      if (!row) return new Response(null, { status: 404 });
      row.ciphertext = request.ciphertext;
      if (this.loseNextResponse) {
        this.loseNextResponse = false;
        throw new Error('lost response');
      }
      return Response.json({ comment_id: id, author: row.author });
    }
    throw new Error(`unexpected method ${method}`);
  };
}

function draft(
  source: string,
  pending: readonly PendingSuggestion[] = []
): SuggestDraftModel {
  return new SuggestDraftModel({
    source,
    segments: codeSegments(source),
    delimiters: [],
    version,
    reader,
    pending,
  });
}

function writable(result: SuggestCommit): WriteCommit {
  if (result.kind !== 'save' && result.kind !== 'delete')
    throw new Error(`unexpected ${result.kind}`);
  return result;
}

async function fixture(now = () => 0, sealOverride?: SuggestCipher['seal']) {
  const cipher = suggestCipher(await deriveCommentKey(keyBytes));
  const service = new FakeService(cipher);
  const transport = new SuggestTransport({
    serviceOrigin: 'https://relik.example',
    relicId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    version,
    reader,
    fetch: service.fetch,
    now,
    seal: sealOverride ?? cipher.seal,
    open: cipher.open,
  });
  return { cipher, service, transport };
}

describe('encrypted suggestion transport', () => {
  test('POST and PATCH bodies use the existing route and every payload round-trips identically', async () => {
    const { service, transport } = await fixture();
    const model = draft('hello world');
    model.replace(6, 11, '<script>\n\t**literal**', 'code');
    const create = writable(model.commit('Reader'));
    if (create.kind !== 'save') throw new Error('expected create');
    expect(await transport.prepare(create)).toEqual({ kind: 'ready' });
    expect(transport.shouldWarnBeforeUnload).toBe(true);
    expect(await transport.commit()).toEqual({
      kind: 'posted',
      commentId: 'comment-1',
    });
    expect(service.openedWrites).toEqual([create.plaintext]);
    expect(service.calls[0]?.url).toBe(
      'https://relik.example/api/relics/aaaaaaaaaaaaaaaaaaaaaaaaaa/comments'
    );
    const post = JSON.parse(service.calls[0]!.body!) as {
      ciphertext: string;
      version: number;
    };
    expect(post.version).toBe(version);
    expect(post.ciphertext.length).toBeLessThanOrEqual(8192);
    expect(service.calls[0]!.body).not.toContain('<script>');

    const pending: PendingSuggestion = {
      id: 'comment-1',
      author: reader,
      displayName: 'Reader',
      version,
      start: 6,
      end: 11,
      inserted: '<script>\n\t**literal**',
    };
    const edit = draft('hello world', [pending]);
    edit.replace(11, 11, '!', 'code');
    const patch = writable(edit.commit('Reader'));
    if (patch.kind !== 'save') throw new Error('expected patch');
    await transport.prepare(patch);
    expect(await transport.commit()).toEqual({
      kind: 'posted',
      commentId: 'comment-1',
    });
    expect(service.calls.map((call) => call.method)).toEqual(['POST', 'PATCH']);
    expect(service.openedWrites).toEqual([create.plaintext, patch.plaintext]);
    expect(JSON.parse(service.calls[1]!.body!)).toHaveProperty('ciphertext');
    expect(JSON.parse(service.calls[1]!.body!)).not.toHaveProperty('version');
  });

  test('typing beside your own pending suggestion PATCHes once; restoring source DELETEs it', async () => {
    const { service, transport } = await fixture();
    const initial = draft('hello world');
    initial.replace(6, 11, 'earth', 'code');
    const created = writable(initial.commit(null));
    if (created.kind !== 'save') throw new Error('expected save');
    const id = await service.seed(created.plaintext);
    const pending: PendingSuggestion = {
      id,
      author: reader,
      displayName: 'Reader',
      version,
      start: 6,
      end: 11,
      inserted: 'earth',
    };
    const adjacent = draft('hello world', [pending]);
    adjacent.replace(11, 11, 's', 'code');
    await transport.prepare(writable(adjacent.commit(null)));
    await transport.commit();
    expect(service.calls.map((call) => call.method)).toEqual(['PATCH']);
    expect(service.rows).toHaveLength(1);
    const revert = draft('hello world', [{ ...pending, inserted: 'earths' }]);
    revert.editInsertion(0, 6, 'world', 'code', id);
    expect(revert.commit(null)).toEqual({ kind: 'delete', existingId: id });
    await transport.prepare(writable(revert.commit(null)));
    await transport.commit();
    expect(service.calls.map((call) => call.method)).toEqual([
      'PATCH',
      'DELETE',
    ]);
    expect(service.rows).toHaveLength(0);
  });

  test('pagehide sends the newest pre-sealed body once, even when an older seal finishes later', async () => {
    const cipher = suggestCipher(await deriveCommentKey(keyBytes));
    const service = new FakeService(cipher);
    const delayed = Promise.withResolvers<string>();
    let count = 0;
    const seal: SuggestCipher['seal'] = async (plain) => {
      if (++count === 1) return delayed.promise;
      return cipher.seal(plain);
    };
    const transport = new SuggestTransport({
      serviceOrigin: 'https://relik.example',
      relicId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      version,
      reader,
      fetch: service.fetch,
      now: () => 0,
      seal,
      open: cipher.open,
    });
    const model = draft('abc');
    model.replace(1, 1, 'x', 'code');
    const old = writable(model.commit(null));
    if (old.kind !== 'save') throw new Error('expected save');
    const oldPreparation = transport.prepare(old);
    model.editInsertion(1, 1, 'y', 'code');
    const latest = writable(model.commit(null));
    if (latest.kind !== 'save') throw new Error('expected save');
    await transport.prepare(latest);
    const first = transport.flushOnPageHide();
    const second = transport.flushOnPageHide();
    delayed.resolve(await cipher.seal(old.plaintext));
    expect(await oldPreparation).toEqual({ kind: 'superseded' });
    await Promise.all([first, second]);
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]?.keepalive).toBe(true);
    expect(service.openedWrites).toEqual([latest.plaintext]);
    expect(count).toBe(2);
    expect(await transport.flushOnPageHide()).toEqual({ kind: 'skipped' });
  });

  test('pagehide during sealing waits for that seal instead of sending stale text', async () => {
    const cipher = suggestCipher(await deriveCommentKey(keyBytes));
    const service = new FakeService(cipher);
    const delayed = Promise.withResolvers<void>();
    const seal: SuggestCipher['seal'] = async (plain) => {
      await delayed.promise;
      return cipher.seal(plain);
    };
    const transport = new SuggestTransport({
      serviceOrigin: 'https://relik.example',
      relicId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      version,
      reader,
      fetch: service.fetch,
      now: () => 0,
      seal,
      open: cipher.open,
    });
    const model = draft('abc');
    model.replace(1, 1, 'new', 'code');
    const change = writable(model.commit(null));
    if (change.kind !== 'save') throw new Error('expected save');
    const preparing = transport.prepare(change);
    const flushing = transport.flushOnPageHide();
    expect(service.calls).toHaveLength(0);
    delayed.resolve();
    await preparing;
    expect(await flushing).toEqual({ kind: 'posted', commentId: 'comment-1' });
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]?.keepalive).toBe(true);
    expect(service.openedWrites).toEqual([change.plaintext]);
  });

  test('retry refetches and does not duplicate a POST whose response was lost', async () => {
    const { service, transport } = await fixture();
    const model = draft('hello world');
    model.replace(6, 11, 'earth', 'code');
    const change = writable(model.commit(null));
    await transport.prepare(change);
    service.loseNextResponse = true;
    expect(await transport.commit()).toEqual({
      kind: 'not-posted',
      reason: 'network',
    });
    expect(transport.state.status).toBe('not-posted');
    expect(transport.shouldWarnBeforeUnload).toBe(true);
    const retry = transport.retry();
    const simultaneousRetry = transport.retry();
    expect(await retry).toEqual({ kind: 'posted', commentId: 'comment-1' });
    expect(await simultaneousRetry).toEqual({
      kind: 'posted',
      commentId: 'comment-1',
    });
    expect(service.rows).toHaveLength(1);
    expect(service.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(transport.shouldWarnBeforeUnload).toBe(false);
  });

  test('retry posts once if the first request never reached the service', async () => {
    const { service, transport } = await fixture();
    const model = draft('abc');
    model.replace(0, 0, 'start', 'code');
    await transport.prepare(writable(model.commit(null)));
    service.failNextBeforeWrite = true;
    expect(await transport.commit()).toEqual({
      kind: 'not-posted',
      reason: 'network',
    });
    expect(await transport.retry()).toEqual({
      kind: 'posted',
      commentId: 'comment-1',
    });
    expect(service.rows).toHaveLength(1);
    expect(service.calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'POST',
    ]);
  });

  test('retry does not confuse another reader or another version with this reader’s suggestion', async () => {
    const { service, transport } = await fixture();
    const model = draft('abc');
    model.replace(0, 1, 'X', 'code');
    const change = writable(model.commit(null));
    if (change.kind !== 'save') throw new Error('expected save');
    await service.seed(change.plaintext, 'other@example.com', version);
    await service.seed(change.plaintext, reader, version - 1);
    await transport.prepare(change);
    service.failNextBeforeWrite = true;
    await transport.commit();
    await transport.retry();
    expect(service.rows).toHaveLength(3);
    expect(service.calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'POST',
    ]);
  });

  test('an unreadable own row blocks retry instead of risking a duplicate', async () => {
    const { service, transport } = await fixture();
    service.rows.push({
      comment_id: 'broken',
      author: reader,
      version,
      ciphertext: 'bad',
    });
    const model = draft('abc');
    model.replace(0, 1, 'X', 'code');
    await transport.prepare(writable(model.commit(null)));
    service.failNextBeforeWrite = true;
    await transport.commit();
    expect(await transport.retry()).toEqual({
      kind: 'not-posted',
      reason: 'malformed-thread',
    });
    expect(service.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(transport.discard()).toBe(true);
    expect(transport.shouldWarnBeforeUnload).toBe(false);
  });

  test('visibility and focus refresh share a ten-second throttle and never run with a draft open', async () => {
    let now = 0;
    const { service, transport } = await fixture(() => now);
    transport.setDraftOpen(true);
    expect(await transport.refreshOnActivity()).toEqual({ kind: 'skipped' });
    expect(service.calls).toHaveLength(0);
    transport.setDraftOpen(false);
    expect(await transport.refreshOnActivity()).toEqual({
      kind: 'ready',
      comments: [],
    });
    now = 9999;
    expect(await transport.refreshOnActivity()).toEqual({ kind: 'skipped' });
    now = 10000;
    expect(await transport.refreshOnActivity()).toEqual({
      kind: 'ready',
      comments: [],
    });
    transport.setDraftOpen(true);
    now = 20000;
    expect(await transport.refreshOnActivity()).toEqual({ kind: 'skipped' });
    expect(service.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  });
});
