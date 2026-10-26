/**
 * A RelicStore backed by Google Cloud Storage.
 *
 * The server previously ran on `MemoryStore` in production, which meant a
 * relic existed only inside the instance that minted it. It did not survive a
 * new revision, a scale to zero, or a request routed to a sibling instance.
 * The ciphertext was durable the whole time; the row that made it reachable
 * was not, so publishing produced links that worked until they abruptly did
 * not.
 *
 * GCS rather than a database, because the deployment already has a bucket, an
 * attached identity, and no other stateful dependency. Adding one would mean
 * new infrastructure, new IAM, and a second thing to be down. The cost is that
 * a counter has to be built out of compare-and-swap instead of being handed to
 * us, which `consumeMint` does below with `ifGenerationMatch`.
 *
 * Every method here is a network call. That is a real latency cost against the
 * previous in-memory reads, and it is the price of the relic still being there
 * on the second request.
 */

import type { RendererClass } from '@relic/format';

import { sha256Hex } from './gcs.ts';
import { ProblemError } from './problems.ts';
import {
  type AbuseReport,
  type AuthLinkRow,
  applyCommentPatch,
  type CommentedRelic,
  type CommentPatch,
  type CommentRow,
  type DecisionRow,
  type DedupEntry,
  looksLikeEmail,
  type MintLogEntry,
  normalizeEmail,
  type OptOutRow,
  type PasskeyRecord,
  type RelicCover,
  type RelicRow,
  type RelicStore,
  type SessionRow,
  type ShareRow,
  type SignInCodeBudgetRow,
  type SignInCodeRow,
  type Tombstone,
  type WebauthnChallengeRow,
} from './store.ts';

export interface GcsStoreOptions {
  readonly bucket: string;
  /** Key prefix for metadata objects. Kept clear of the ciphertext prefix. */
  readonly prefix?: string;
  readonly getAccessToken: () => Promise<string>;
  readonly host?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Retries for a contended compare-and-swap. */
  readonly casAttempts?: number;
}

const DEFAULT_HOST = 'https://storage.googleapis.com';

/** A document plus the generation it was read at, for compare-and-swap. */
interface Versioned<T> {
  readonly value: T;
  readonly generation: string;
}
function toCommentRow(raw: CommentRow): CommentRow {
  return {
    id: raw.id,
    relicId: raw.relicId,
    author: raw.author,
    createdAt: raw.createdAt,
    ciphertext: raw.ciphertext,
    version: typeof raw.version === 'number' ? raw.version : undefined,
    addresses: typeof raw.addresses === 'string' ? raw.addresses : undefined,
    editedAt: typeof raw.editedAt === 'number' ? raw.editedAt : undefined,
    resolvedAt: typeof raw.resolvedAt === 'number' ? raw.resolvedAt : undefined,
    resolvedBy: typeof raw.resolvedBy === 'string' ? raw.resolvedBy : undefined,
  };
}

/**
 * The document one comment occupies in the bucket. Optional keys are
 * omitted rather than written as null, so an old reader and a fresh reader
 * agree on what absence means and legacy rows stay legacy rows.
 */
function commentDoc(row: CommentRow): Record<string, unknown> {
  return {
    id: row.id,
    relicId: row.relicId,
    author: row.author,
    createdAt: row.createdAt,
    ciphertext: row.ciphertext,
    ...(typeof row.version === 'number' ? { version: row.version } : {}),
    ...(typeof row.addresses === 'string' ? { addresses: row.addresses } : {}),
    ...(row.editedAt !== undefined ? { editedAt: row.editedAt } : {}),
    ...(row.resolvedAt !== undefined ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolvedBy !== undefined ? { resolvedBy: row.resolvedBy } : {}),
  };
}

export function gcsStore(options: GcsStoreOptions): RelicStore {
  const host = options.host ?? DEFAULT_HOST;
  const doFetch = options.fetch ?? globalThis.fetch;
  const prefix = (options.prefix ?? 'm').replace(/^\/+|\/+$/g, '');
  const casAttempts = options.casAttempts ?? 5;

  const key = (...parts: readonly string[]): string =>
    [prefix, ...parts].join('/');

  async function authorized(
    url: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const token = await options.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return doFetch(url, { ...init, headers });
  }

  /**
   * Read a document and the generation it was read at.
   *
   * A missing object is `undefined` rather than an error: "no such relic" is
   * an ordinary answer here, not a failure.
   */
  async function get<T>(name: string): Promise<Versioned<T> | undefined> {
    const url =
      `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}` +
      `/o/${encodeURIComponent(name)}?alt=media`;

    const response = await authorized(url);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `gcs get ${name} returned ${response.status}: ${await response.text()}`
      );
    }

    // The generation of the bytes just read. Writing back with it as a
    // precondition is what makes a read-modify-write safe against a concurrent
    // instance doing the same thing.
    const generation = response.headers.get('x-goog-generation') ?? '';
    return { value: (await response.json()) as T, generation };
  }

  /**
   * Write a document, optionally only if it is still at `generation`.
   *
   * `ifGenerationMatch=0` means "only if it does not exist", which is how a
   * create is distinguished from an overwrite.
   */
  async function put(
    name: string,
    body: unknown,
    generation?: string
  ): Promise<boolean> {
    const params = new URLSearchParams({ uploadType: 'media', name });
    if (generation !== undefined) {
      params.set('ifGenerationMatch', generation);
    }

    const url =
      `${host}/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o` +
      `?${params.toString()}`;

    const response = await authorized(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Somebody else wrote first. The caller decides whether to retry or to
    // treat losing the race as the answer.
    if (response.status === 412) return false;

    if (!response.ok) {
      throw new Error(
        `gcs put ${name} returned ${response.status}: ${await response.text()}`
      );
    }
    return true;
  }

  async function remove(name: string, generation?: string): Promise<boolean> {
    const params = new URLSearchParams();
    if (generation !== undefined) {
      params.set('ifGenerationMatch', generation);
    }
    const qs = params.toString();
    const url =
      `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}` +
      `/o/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`;
    const response = await authorized(url, { method: 'DELETE' });
    if (
      generation !== undefined &&
      (response.status === 412 || response.status === 404)
    ) {
      return false;
    }
    if (!response.ok && response.status !== 404) {
      throw new Error(`gcs delete ${name} returned ${response.status}`);
    }
    return true;
  }

  async function mapConcurrent<TIn, TOut>(
    items: readonly TIn[],
    limit: number,
    fn: (item: TIn) => Promise<TOut>
  ): Promise<TOut[]> {
    const results: TOut[] = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(limit, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) break;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await fn(item);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** Every object under a prefix, following pagination to the end. */
  async function list<T>(
    under: string,
    concurrency = 16
  ): Promise<readonly T[]> {
    const names: string[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ prefix: under });
      if (pageToken !== undefined) params.set('pageToken', pageToken);

      const url =
        `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}/o` +
        `?${params.toString()}`;

      const response = await authorized(url);
      if (!response.ok) {
        throw new Error(`gcs list ${under} returned ${response.status}`);
      }

      const body = (await response.json()) as {
        items?: readonly { name: string }[];
        nextPageToken?: string;
      };
      for (const item of body.items ?? []) names.push(item.name);
      pageToken = body.nextPageToken;
    } while (pageToken !== undefined);

    const docs = await mapConcurrent(names, concurrency, (name) =>
      get<T>(name)
    );
    return docs
      .filter((d): d is Versioned<T> => d !== undefined)
      .map((d) => d.value);
  }
  async function putMedia(
    name: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void> {
    const params = new URLSearchParams({ uploadType: 'media', name });
    const url =
      `${host}/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o` +
      `?${params.toString()}`;

    const response = await authorized(url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: body as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(
        `gcs put media ${name} returned ${response.status}: ${await response.text()}`
      );
    }
  }

  async function getMedia(name: string): Promise<Uint8Array | undefined> {
    const url =
      `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}` +
      `/o/${encodeURIComponent(name)}?alt=media`;

    const response = await authorized(url);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `gcs get media ${name} returned ${response.status}: ${await response.text()}`
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function listObjectNames(under: string): Promise<readonly string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ prefix: under });
      if (pageToken !== undefined) params.set('pageToken', pageToken);

      const url =
        `${host}/storage/v1/b/${encodeURIComponent(options.bucket)}/o` +
        `?${params.toString()}`;

      const response = await authorized(url);
      if (!response.ok) {
        throw new Error(`gcs list ${under} returned ${response.status}`);
      }

      const body = (await response.json()) as {
        items?: readonly { name: string }[];
        nextPageToken?: string;
      };
      for (const item of body.items ?? []) names.push(item.name);
      pageToken = body.nextPageToken;
    } while (pageToken !== undefined);

    return names;
  }

  return {
    async getRelic(id: string): Promise<RelicRow | undefined> {
      return (await get<RelicRow>(key('relic', `${id}.json`)))?.value;
    },

    async putRelic(row: RelicRow): Promise<void> {
      await put(key('relic', `${row.id}.json`), row);
    },

    async markPublished(
      id: string,
      at: number,
      objectLength: number,
      crc32c: string
    ): Promise<void> {
      await mutateRelic(id, (row) => ({
        ...row,
        publishedAt: at,
        objectLength,
        objectCrc32c: crc32c,
      }));
    },
    async putCover(
      id: string,
      cover: RelicCover,
      bytes: Uint8Array
    ): Promise<'stored' | 'stale_version' | 'not_found'> {
      const objectName = key('cover', id, cover.sha256);
      await putMedia(objectName, bytes, cover.type);

      const rowName = key('relic', `${id}.json`);
      let stored = false;
      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<RelicRow>(rowName);
        if (current === undefined) {
          await remove(objectName);
          return 'not_found';
        }
        if (current.value.version !== cover.version) {
          await remove(objectName);
          return 'stale_version';
        }
        const next: RelicRow = {
          ...current.value,
          cover,
        };
        if (await put(rowName, next, current.generation)) {
          stored = true;
          break;
        }
      }

      if (!stored) {
        await remove(objectName);
        throw new Error(
          `gcs relic ${id} lost ${casAttempts} compare-and-swap races; ` +
            'refusing to write cover derived from stale state'
        );
      }

      const prefixUnder = `${key('cover', id)}/`;
      const allNames = await listObjectNames(prefixUnder);
      for (const name of allNames) {
        if (name !== objectName) {
          await remove(name);
        }
      }

      return 'stored';
    },

    async getCoverBytes(
      id: string,
      sha256: string
    ): Promise<Uint8Array | undefined> {
      return getMedia(key('cover', id, sha256));
    },

    async listCovers(id: string): Promise<readonly string[]> {
      const prefixUnder = `${key('cover', id)}/`;
      const names = await listObjectNames(prefixUnder);
      return names.map((name) => name.slice(prefixUnder.length));
    },

    async deleteCovers(id: string): Promise<number> {
      const prefixUnder = `${key('cover', id)}/`;
      const names = await listObjectNames(prefixUnder);
      for (const name of names) {
        await remove(name);
      }

      const rowName = key('relic', `${id}.json`);
      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<RelicRow>(rowName);
        if (current === undefined) break;
        const next: RelicRow = {
          ...current.value,
          cover: undefined,
        };
        if (await put(rowName, next, current.generation)) {
          break;
        }
      }

      return names.length;
    },

    /**
     * Opening a version is a read-modify-write like any other, so it rides
     * the same generation-checked retry. Two instances granting a
     * republish concurrently must not both hand out the same `v{n}`.
     */
    async beginVersion(
      id: string,
      rendererClass: RendererClass,
      declaredSizeBytes: number,
      titleUpdate?: { readonly title: string | undefined },
      ownerUpdate?: { readonly ownerEmail: string | undefined },
      noticePending?: boolean,
      shareVerifierUpdate?: { readonly shareVerifier: string }
    ): Promise<RelicRow | undefined> {
      return mutateRelic(id, (row) => {
        const { noticePending: _priorPending, ...restRow } = row;
        return {
          ...restRow,
          version: row.version + 1,
          rendererClass,
          declaredSizeBytes,
          publishedAt: undefined,
          objectLength: undefined,
          objectCrc32c: undefined,
          cover: undefined,
          title: titleUpdate !== undefined ? titleUpdate.title : row.title,
          ownerEmail:
            ownerUpdate !== undefined ? ownerUpdate.ownerEmail : row.ownerEmail,
          shareVerifier:
            shareVerifierUpdate !== undefined
              ? shareVerifierUpdate.shareVerifier
              : row.shareVerifier,
          ...(noticePending === true ? { noticePending: true } : {}),
        };
      });
    },

    async claimVersionNotice(
      id: string,
      version: number
    ): Promise<RelicRow | undefined> {
      const rowName = key('relic', `${id}.json`);
      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<RelicRow>(rowName);
        if (current === undefined) return undefined;
        if (
          current.value.version !== version ||
          current.value.noticePending !== true
        ) {
          return undefined;
        }
        const { noticePending: _pending, ...restRow } = current.value;
        const next: RelicRow = {
          ...restRow,
        };
        if (await put(rowName, next, current.generation)) {
          return next;
        }
      }
      throw new Error(
        `gcs relic ${id} lost ${casAttempts} compare-and-swap races; refusing to claim version notice`
      );
    },

    /**
     * Spend one open against the cap, and return the new total.
     *
     * This is the one place two instances can genuinely race: both read a
     * count of 4, both write 5, and the relic gets an extra open it was not
     * owed. The write is therefore conditional on the generation the count was
     * read at, and a lost race is retried against fresh state rather than
     * papered over.
     */
    async consumeMint(id: string): Promise<number> {
      const updated = await mutateRelic(id, (row) => ({
        ...row,
        mintsUsed: row.mintsUsed + 1,
      }));
      return updated?.mintsUsed ?? 0;
    },

    async getTombstone(id: string): Promise<Tombstone | undefined> {
      return (await get<Tombstone>(key('tomb', `${id}.json`)))?.value;
    },

    async putTombstone(stone: Tombstone): Promise<void> {
      await put(key('tomb', `${stone.id}.json`), stone);
    },

    /**
     * Challenges are shared, not per-instance.
     *
     * They have to be: a challenge issued by one instance is redeemed by
     * whichever instance the grant lands on, and with a per-instance map that
     * is a coin flip on every publish.
     */
    async issueChallenge(ip: string, now: number): Promise<string> {
      const nonce = crypto.randomUUID();
      await put(key('challenge', `${nonce}.json`), {
        nonce,
        issuedAt: now,
        ip,
      });
      return nonce;
    },

    async consumeChallenge(
      nonce: string,
      now: number,
      ttl: number
    ): Promise<boolean> {
      const name = key('challenge', `${nonce}.json`);
      const found = await get<{ issuedAt: number }>(name);
      if (found === undefined) return false;

      // Delete before judging freshness, so a stale nonce cannot be retried
      // and so a valid one is single-use even under concurrent redemption.
      await remove(name);
      return now - found.value.issuedAt <= ttl * 1000;
    },

    async appendMintLog(entry: MintLogEntry): Promise<void> {
      // Name carries the timestamp so the log sorts lexicographically, and a
      // random suffix so two mints in the same millisecond cannot collide.
      const suffix = crypto.randomUUID().slice(0, 8);
      const stamp = String(entry.at).padStart(16, '0');
      await put(key('mintlog', `${stamp}-${suffix}.json`), entry);
    },

    async readMintLog(): Promise<readonly MintLogEntry[]> {
      const entries = await list<MintLogEntry>(`${prefix}/mintlog/`);
      return [...entries].sort((a, b) => a.at - b.at);
    },

    async recentMint(
      id: string,
      ip: string,
      now: number,
      windowSeconds: number
    ): Promise<DedupEntry | undefined> {
      const found = await get<DedupEntry>(dedupKey(id, ip));
      if (found === undefined) return undefined;
      if (now - found.value.at > windowSeconds * 1000) return undefined;
      return found.value;
    },

    async rememberMint(
      id: string,
      ip: string,
      entry: DedupEntry
    ): Promise<void> {
      await put(dedupKey(id, ip), entry);
    },

    async isBlocklisted(hash: string): Promise<boolean> {
      return (await get(key('block', `${hash}.json`))) !== undefined;
    },

    async blocklist(hash: string): Promise<void> {
      await put(key('block', `${hash}.json`), { hash });
    },

    async putAbuseReport(report: AbuseReport): Promise<void> {
      const suffix = crypto.randomUUID().slice(0, 8);
      const stamp = String(report.receivedAt).padStart(16, '0');
      await put(key('abuse', `${stamp}-${suffix}.json`), report);
    },

    async readAbuseReports(): Promise<readonly AbuseReport[]> {
      const reports = await list<AbuseReport>(`${prefix}/abuse/`);
      return [...reports].sort((a, b) => a.receivedAt - b.receivedAt);
    },

    // Comments live one object per comment under the relic's own folder, so
    // a thread is a prefix listing and a relic's whole thread is one delete
    // sweep. A single document holding the array would need a
    // compare-and-swap per comment, and two readers commenting at once would
    // make one of them lose their words rather than merely retry.
    async putComment(row: CommentRow): Promise<void> {
      await put(key('comment', row.relicId, `${row.id}.json`), commentDoc(row));
      if (row.author !== 'publisher' && looksLikeEmail(row.author)) {
        try {
          const normalized = row.author.trim().toLowerCase();
          const authorHash = await sha256Hex(normalized);
          const commenterKey = key(
            'commenter',
            row.relicId,
            `${authorHash}.json`
          );
          await put(commenterKey, { address: normalized }, '0');
        } catch (error) {
          console.error('Failed to update commenter index in GCS', error);
        }
      }

      // does not require an unbounded bucket scan. A failed index write must
      // not lose the comment, which has already landed above.
      try {
        const authorKey = await sha256Hex(row.author);
        const indexName = key('author_relic', authorKey, `${row.relicId}.json`);
        const existing = await get<CommentedRelic>(indexName);
        const lastCommentAt =
          existing !== undefined
            ? Math.max(existing.value.lastCommentAt, row.createdAt)
            : row.createdAt;
        await put(indexName, { relicId: row.relicId, lastCommentAt });
      } catch (error) {
        console.error('Failed to update author relic index in GCS', error);
      }
    },

    async getComment(
      relicId: string,
      commentId: string
    ): Promise<CommentRow | undefined> {
      const doc = await get<CommentRow>(
        key('comment', relicId, `${commentId}.json`)
      );
      if (doc === undefined) return undefined;
      return toCommentRow(doc.value);
    },

    async listComments(relicId: string): Promise<readonly CommentRow[]> {
      const rows = await list<CommentRow>(`${prefix}/comment/${relicId}/`);
      return rows
        .map(toCommentRow)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    },

    async deleteComment(relicId: string, commentId: string): Promise<void> {
      await remove(key('comment', relicId, `${commentId}.json`));
    },

    // A patch is a read-modify-write on somebody's words, so it rides the
    // same generation-checked retry `consumeMint` does: a lost update here
    // would silently discard a person's edit or un-resolve feedback a
    // publisher had already settled, and neither is an acceptable answer to
    // losing a race.
    async updateComment(
      relicId: string,
      commentId: string,
      patch: CommentPatch
    ): Promise<CommentRow | undefined> {
      const name = key('comment', relicId, `${commentId}.json`);

      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<CommentRow>(name);
        if (current === undefined) return undefined;

        const next = applyCommentPatch(toCommentRow(current.value), patch);
        if (await put(name, commentDoc(next), current.generation)) return next;
      }

      throw new Error(
        `gcs comment ${relicId}/${commentId} lost ${casAttempts} ` +
          'compare-and-swap races; refusing to overwrite on stale state'
      );
    },

    async deleteCommentsForRelic(relicId: string): Promise<number> {
      const rows = await list<CommentRow>(`${prefix}/comment/${relicId}/`);
      for (const row of rows) {
        await remove(key('comment', relicId, `${row.id}.json`));
      }
      const authors = new Set(rows.map((row) => row.author));
      for (const author of authors) {
        const authorKey = await sha256Hex(author);
        await remove(key('author_relic', authorKey, `${relicId}.json`));
      }
      const commenterPrefix = `${key('commenter', relicId)}/`;
      const commenterNames = await listObjectNames(commenterPrefix);
      for (const name of commenterNames) {
        await remove(name);
      }
      return rows.length;
    },

    async listCommenters(relicId: string): Promise<readonly string[]> {
      const markerName = key('commenter', relicId, '_complete.json');
      const marker = await get(markerName);
      if (marker === undefined) {
        const comments = await this.listComments(relicId);
        for (const comment of comments) {
          if (
            comment.author !== 'publisher' &&
            looksLikeEmail(comment.author)
          ) {
            try {
              const normalized = comment.author.trim().toLowerCase();
              const authorHash = await sha256Hex(normalized);
              const commenterKey = key(
                'commenter',
                relicId,
                `${authorHash}.json`
              );
              await put(commenterKey, { address: normalized }, '0');
            } catch (error) {
              console.error('Failed to backfill commenter in GCS', error);
            }
          }
        }
        try {
          await put(markerName, { completedAt: Date.now() });
        } catch (error) {
          console.error(
            'Failed to write commenter completion marker in GCS',
            error
          );
        }
      }

      const prefixUnder = `${key('commenter', relicId)}/`;
      const names = (await listObjectNames(prefixUnder)).filter(
        (name) => !name.slice(prefixUnder.length).startsWith('_')
      );
      const docs = await Promise.all(
        names.map((name) => get<{ address: string }>(name))
      );
      const addresses = docs
        .filter(
          (d): d is Versioned<{ address: string }> =>
            d !== undefined && typeof d.value?.address === 'string'
        )
        .map((d) => d.value.address);
      return addresses.sort();
    },

    async deleteCommenter(relicId: string, author: string): Promise<void> {
      const authorHash = await sha256Hex(author.trim().toLowerCase());
      await remove(key('commenter', relicId, `${authorHash}.json`));
    },
    async listCommentedRelics(
      author: string
    ): Promise<readonly CommentedRelic[]> {
      const authorKey = await sha256Hex(author);
      const entries = await list<CommentedRelic>(
        `${prefix}/author_relic/${authorKey}/`
      );
      return [...entries].sort(
        (a, b) =>
          b.lastCommentAt - a.lastCommentAt || (a.relicId < b.relicId ? -1 : 1)
      );
    },

    // A link and a session are both keyed by the hash of the secret, never
    // by the secret, so the bucket cannot hand anybody a usable credential
    // even to somebody who can list it.
    async putAuthLink(row: AuthLinkRow): Promise<void> {
      await put(key('authlink', `${row.tokenHash}.json`), row);
    },

    async consumeAuthLink(tokenHash: string): Promise<AuthLinkRow | undefined> {
      const name = key('authlink', `${tokenHash}.json`);
      const current = await get<AuthLinkRow>(name);
      if (current === undefined) return undefined;
      // Spend it whether or not it was still valid, so a replay finds
      // nothing rather than an expired row somebody might forgive later.
      if (!(await remove(name, current.generation))) return undefined;
      return current.value;
    },

    async putSignInCode(row: SignInCodeRow): Promise<void> {
      await put(
        key('challenge', 'sign-in-code', `${row.requestHash}.json`),
        row
      );
    },

    async getSignInCode(
      requestHash: string
    ): Promise<SignInCodeRow | undefined> {
      const found = await get<SignInCodeRow>(
        key('challenge', 'sign-in-code', `${requestHash}.json`)
      );
      return found?.value;
    },

    async deleteSignInCode(requestHash: string): Promise<void> {
      await remove(key('challenge', 'sign-in-code', `${requestHash}.json`));
    },

    async reserveSignInCodeAttempt(
      addressHash: string,
      now: number,
      limit: number,
      windowMs: number
    ): Promise<boolean> {
      const name = key(
        'challenge',
        'sign-in-code-budget',
        `${addressHash}.json`
      );
      for (let i = 0; i < casAttempts; i++) {
        const current = await get<SignInCodeBudgetRow>(name);
        const inWindow =
          current !== undefined &&
          now >= current.value.windowStart &&
          now < current.value.windowStart + windowMs;
        const before = inWindow ? current.value.attempts : 0;
        const windowStart = inWindow ? current.value.windowStart : now;
        const next: SignInCodeBudgetRow = {
          addressHash,
          windowStart,
          attempts: before + 1,
        };
        const ok = await put(name, next, current?.generation ?? '0');
        if (ok) {
          return before < limit;
        }
      }
      throw new Error(
        `gcs sign-in code budget lost ${casAttempts} compare-and-swap races; refusing to allow an attempt that was never charged`
      );
    },

    async putSession(row: SessionRow): Promise<void> {
      await put(key('session', `${row.tokenHash}.json`), row);
      try {
        const emailKey = await sha256Hex(row.email.toLowerCase().trim());
        await put(key('verified_identity', `${emailKey}.json`), {
          email: row.email,
          verifiedAt: row.createdAt,
        });
      } catch (error) {
        console.error('Failed to write verified identity index in GCS', error);
      }
    },

    async getSession(tokenHash: string): Promise<SessionRow | undefined> {
      return (await get<SessionRow>(key('session', `${tokenHash}.json`)))
        ?.value;
    },

    async recordVerifiedIdentity(
      email: string,
      at = Date.now()
    ): Promise<void> {
      const emailKey = await sha256Hex(email.toLowerCase().trim());
      await put(key('verified_identity', `${emailKey}.json`), {
        email,
        verifiedAt: at,
      });
    },

    async hasVerifiedIdentity(email: string): Promise<boolean> {
      const emailKey = await sha256Hex(email.toLowerCase().trim());
      const res = await get<{ email: string; verifiedAt: number }>(
        key('verified_identity', `${emailKey}.json`)
      );
      return res !== undefined;
    },

    async putShare(row: ShareRow): Promise<boolean> {
      const emailHash = await sha256Hex(row.email);
      const name = key('share', row.relicId, `${emailHash}.json`);
      return put(name, row, '0');
    },

    async listShares(relicId: string): Promise<readonly ShareRow[]> {
      const rows = await list<ShareRow>(`${key('share', relicId)}/`);
      return [...rows].sort(
        (a, b) => a.addedAt - b.addedAt || a.email.localeCompare(b.email)
      );
    },

    async deleteSharesForRelic(relicId: string): Promise<number> {
      const prefixUnder = `${key('share', relicId)}/`;
      const names = await listObjectNames(prefixUnder);
      for (const name of names) {
        await remove(name);
      }
      try {
        await mutateRelic(relicId, (row) => ({
          ...row,
          sharesCount: 0,
        }));
      } catch {
        // Relic might not exist or be tombstoned
      }
      return names.length;
    },

    async reserveShares(
      relicId: string,
      count: number,
      maxLimit: number
    ): Promise<{ allowed: boolean; currentCount: number }> {
      const name = key('relic', `${relicId}.json`);

      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<RelicRow>(name);
        if (current === undefined) {
          return { allowed: false, currentCount: 0 };
        }

        let currentCount = current.value.sharesCount;
        if (currentCount === undefined) {
          const existing = await this.listShares(relicId);
          currentCount = existing.length;
        }

        if (currentCount + count > maxLimit) {
          return { allowed: false, currentCount };
        }

        const next: RelicRow = {
          ...current.value,
          sharesCount: currentCount + count,
        };

        if (await put(name, next, current.generation)) {
          return { allowed: true, currentCount: currentCount + count };
        }
      }

      throw new Error(
        `gcs relic ${relicId} lost ${casAttempts} compare-and-swap races; ` +
          'refusing to write share reservation derived from stale state'
      );
    },

    async releaseShares(relicId: string, count: number): Promise<void> {
      try {
        await mutateRelic(relicId, (row) => ({
          ...row,
          sharesCount: Math.max(0, (row.sharesCount ?? 0) - count),
        }));
      } catch {
        // Ignore if relic is gone
      }
    },

    async putOptOut(row: OptOutRow): Promise<void> {
      const name = key('optout', row.relicId, `${row.addressHash}.json`);
      await put(name, row, '0');
    },

    async listOptOuts(relicId: string): Promise<readonly string[]> {
      const prefixUnder = `${key('optout', relicId)}/`;
      const names = await listObjectNames(prefixUnder);
      return names.map((name) => {
        const file = name.slice(prefixUnder.length);
        return file.endsWith('.json') ? file.slice(0, -5) : file;
      });
    },

    async deleteOptOutsForRelic(relicId: string): Promise<number> {
      const prefixUnder = `${key('optout', relicId)}/`;
      const names = await listObjectNames(prefixUnder);
      for (const name of names) {
        await remove(name);
      }
      return names.length;
    },

    async isOptedOut(relicId: string, addressHash: string): Promise<boolean> {
      const name = key('optout', relicId, `${addressHash}.json`);
      const row = await get<OptOutRow>(name);
      return row !== undefined;
    },
    async unsubscribeKey(): Promise<Uint8Array> {
      const secretName = key('secret', 'unsubscribe-key.json');
      const existing = await get<{ key: string; createdAt: number }>(
        secretName
      );
      if (existing !== undefined) {
        return new Uint8Array(Buffer.from(existing.value.key, 'base64url'));
      }
      const random = new Uint8Array(32);
      crypto.getRandomValues(random);
      const encoded = Buffer.from(random).toString('base64url');
      const stored = await put(
        secretName,
        { key: encoded, createdAt: Date.now() },
        '0'
      );
      if (stored) {
        return random;
      }
      const readBack = await get<{ key: string; createdAt: number }>(
        secretName
      );
      if (readBack === undefined) {
        throw new Error(
          'gcs unsubscribe key could not be written or read back'
        );
      }
      return new Uint8Array(Buffer.from(readBack.value.key, 'base64url'));
    },

    async recordVersionDigest(
      id: string,
      version: number,
      sha256: string
    ): Promise<string | undefined> {
      const vKey = String(version);
      const name = key('relic', `${id}.json`);
      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<RelicRow>(name);
        if (current === undefined) return undefined;
        const existing = current.value.versionDigests?.[vKey];
        if (existing !== undefined) {
          return existing;
        }
        const next: RelicRow = {
          ...current.value,
          versionDigests: {
            ...(current.value.versionDigests ?? {}),
            [vKey]: sha256,
          },
        };
        if (await put(name, next, current.generation)) {
          return sha256;
        }
      }
      throw new Error(
        `gcs relic ${id} lost ${casAttempts} compare-and-swap races; refusing to record version digest`
      );
    },

    async appendDecision(row: DecisionRow): Promise<void> {
      const name = key('decision', row.relicId, `${row.id}.json`);
      const ok = await put(name, row, '0');
      if (!ok) {
        throw new Error(`decision ${row.id} already exists`);
      }
    },

    async listDecisions(relicId: string): Promise<readonly DecisionRow[]> {
      const prefixUnder = `${key('decision', relicId)}/`;
      const rows = await list<DecisionRow>(prefixUnder, 16);
      return [...rows].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      );
    },

    async deleteDecisionsForRelic(relicId: string): Promise<number> {
      const prefixUnder = `${key('decision', relicId)}/`;
      const names = await listObjectNames(prefixUnder);
      for (const name of names) {
        await remove(name);
      }
      return names.length;
    },

    async deleteDecision(
      relicId: string,
      decisionId: string
    ): Promise<boolean> {
      const name = key('decision', relicId, `${decisionId}.json`);
      return remove(name);
    },
    async getPasskeys(email: string): Promise<PasskeyRecord | undefined> {
      const norm = normalizeEmail(email);
      const hash = await sha256Hex(norm);
      const name = key('passkey', `${hash}.json`);
      return (await get<PasskeyRecord>(name))?.value;
    },

    async createPasskeys(record: PasskeyRecord): Promise<boolean> {
      const norm = normalizeEmail(record.email);
      const hash = await sha256Hex(norm);
      const name = key('passkey', `${hash}.json`);
      const created = await put(name, record, '0');
      if (created) {
        try {
          const handleHash = await sha256Hex(record.userHandle);
          const handleName = key('passkey-handle', `${handleHash}.json`);
          await put(
            handleName,
            { emailHash: hash, createdAt: Date.now() },
            '0'
          );
        } catch (err) {
          console.warn(
            'failed to maintain passkey handle index on create',
            err
          );
        }
      }
      return created;
    },

    async updatePasskeys(
      email: string,
      change: (r: PasskeyRecord) => PasskeyRecord
    ): Promise<PasskeyRecord | undefined> {
      const norm = normalizeEmail(email);
      const hash = await sha256Hex(norm);
      const name = key('passkey', `${hash}.json`);

      for (let attempt = 0; attempt < casAttempts; attempt++) {
        const current = await get<PasskeyRecord>(name);
        if (current === undefined) return undefined;

        const next = change(current.value);

        for (const nextCred of next.credentials) {
          const stored = current.value.credentials.find(
            (c) => c.credentialId === nextCred.credentialId
          );
          if (stored !== undefined) {
            if (nextCred.signCount < stored.signCount) {
              throw new ProblemError('passkey_verification_failed', {
                passkey_check: 'counter',
              });
            }
          }
        }

        if (await put(name, next, current.generation)) {
          try {
            const handleHash = await sha256Hex(next.userHandle);
            const handleName = key('passkey-handle', `${handleHash}.json`);
            await put(
              handleName,
              { emailHash: hash, createdAt: Date.now() },
              '0'
            );
          } catch (err) {
            console.warn(
              'failed to maintain passkey handle index on update',
              err
            );
          }
          return next;
        }
      }

      throw new Error(
        `gcs passkey ${email} lost ${casAttempts} compare-and-swap races; refusing to write passkey derived from stale state`
      );
    },

    async putWebauthnChallenge(row: WebauthnChallengeRow): Promise<void> {
      const name = key('challenge', 'webauthn', `${row.challengeHash}.json`);
      await put(name, row);
    },

    async consumeWebauthnChallenge(
      challengeHash: string
    ): Promise<WebauthnChallengeRow | undefined> {
      const name = key('challenge', 'webauthn', `${challengeHash}.json`);
      const found = await get<WebauthnChallengeRow>(name);
      if (found === undefined) return undefined;
      const deleted = await remove(name, found.generation);
      if (!deleted) return undefined;
      return found.value;
    },
    async getPasskeysByUserHandle(
      userHandle: string
    ): Promise<PasskeyRecord | undefined> {
      const handleHash = await sha256Hex(userHandle);
      const name = key('passkey-handle', `${handleHash}.json`);
      const index = await get<{ emailHash: string; createdAt: number }>(name);
      if (index === undefined) return undefined;
      const passkeyName = key('passkey', `${index.value.emailHash}.json`);
      const record = (await get<PasskeyRecord>(passkeyName))?.value;
      if (record === undefined || record.userHandle !== userHandle) {
        return undefined;
      }
      return record;
    },
    async passkeyDecoyKey(): Promise<Uint8Array> {
      const secretName = key('secret', 'passkey-decoy-key.json');
      const existing = await get<{ key: string; createdAt: number }>(
        secretName
      );
      if (existing !== undefined) {
        return new Uint8Array(Buffer.from(existing.value.key, 'base64url'));
      }
      const random = new Uint8Array(32);
      crypto.getRandomValues(random);
      const encoded = Buffer.from(random).toString('base64url');
      const stored = await put(
        secretName,
        { key: encoded, createdAt: Date.now() },
        '0'
      );
      if (stored) {
        return random;
      }
      const readBack = await get<{ key: string; createdAt: number }>(
        secretName
      );
      if (readBack === undefined) {
        throw new Error(
          'gcs passkey decoy key could not be written or read back'
        );
      }
      return new Uint8Array(Buffer.from(readBack.value.key, 'base64url'));
    },
  };

  function dedupKey(id: string, ip: string): string {
    // The IP is part of a key in a bucket, so it is hashed rather than spelled
    // out. Same reason the mint log records what it records and no more.
    return key('dedup', id, `${fnv1a(ip)}.json`);
  }

  /**
   * Read-modify-write a relic row under its generation, retrying on loss.
   *
   * Returns undefined if the row is gone, which callers treat the same way
   * they treat a relic that never existed.
   */
  async function mutateRelic(
    id: string,
    change: (row: RelicRow) => RelicRow
  ): Promise<RelicRow | undefined> {
    const name = key('relic', `${id}.json`);

    for (let attempt = 0; attempt < casAttempts; attempt++) {
      const current = await get<RelicRow>(name);
      if (current === undefined) return undefined;

      const next = change(current.value);
      if (await put(name, next, current.generation)) return next;
    }

    throw new Error(
      `gcs relic ${id} lost ${casAttempts} compare-and-swap races; ` +
        'refusing to write a count derived from stale state'
    );
  }
}

/** Small non-cryptographic hash, used only to avoid writing an IP into a key. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
