/**
 * Publishing from the page, with no DOM in it so every rule is testable.
 *
 * This is the same three-message contract `relic-mcp` speaks (`spec/
 * publish.md` section 3): challenge, grant, then ciphertext straight to
 * storage. The file is encrypted in this page with a key drawn from the
 * browser's CSPRNG, and the key goes into the returned link and nowhere
 * else. No request below carries it.
 *
 * What differs from the local client, and why:
 *
 * - The publish token the grant returns is discarded. Keeping it would mean a
 *   per-relic credential in the browser, and a relic published here is
 *   therefore not republishable from here. The disclosure says so.
 * - There is no cover image. A cover is rendered by a headless browser on the
 *   publisher's machine, which a page cannot be.
 * - The challenge is taken again on every retry. The server consumes a nonce
 *   at grant time even when the grant is then refused, so reusing it after a
 *   collision would fail with `invalid_challenge_nonce`.
 * - The page holds the whole file and its ciphertext in memory, so it has a
 *   lower ceiling than the service. See `BROWSER_PUBLISH_LIMIT_BYTES`.
 */

import {
  deriveRendererClass,
  deriveShareProof,
  encryptFolderStream,
  encryptedSize,
  folderPlaintext,
  encryptRelic,
  generateKey,
  generateRelicId,
  guessMimetype,
  normalizeTitle,
  type RendererClass,
  relicUrl,
  shareVerifierFor,
} from '@relic/format';
import type { BrowserFolder } from './browser-folder-preflight.ts';
import { formatBytes } from './viewer.ts';

/** Reported to the server as the publishing client, like `relic-mcp` does. */
export const PUBLISHING_CLIENT = 'relik-web';

/**
 * What this page will encrypt, whatever the service allows.
 *
 * Encrypting holds the plaintext and the ciphertext at once, so a file costs
 * about twice its size in the tab, and a hundred megabytes is roughly where
 * the viewer already starts asking before it opens a relic. A larger file is
 * what the local client is for. It is a decimal figure, not a binary one, so
 * the limit in the message matches the size the file manager shows for the
 * file.
 */
export const BROWSER_PUBLISH_LIMIT_BYTES = 100_000_000;

/** Draws of id and key before a collision is reported as a failure. */
const MAX_ATTEMPTS = 4;

export type PublishCode =
  | 'source_unreadable'
  | 'size_over_cap'
  | 'publish_rate_limited'
  | 'service_paused'
  | 'service_unreachable'
  | 'service_response_unusable'
  | 'upload_failed'
  | 'digest_mismatch'
  | 'grant_refused';

export class PublishFailure extends Error {
  override readonly name = 'PublishFailure';
  constructor(
    readonly code: PublishCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
  }
}

/** A file the page has been handed, read only once the cap is known. */
export interface PublishSource {
  readonly name: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
}

export interface PublishOptions {
  /**
   * The plaintext title, as the publisher typed it. It is normalized before it
   * is sent, and an empty result means no title is sent at all.
   */
  readonly title: string;
}

export interface PublishDeps {
  readonly serviceOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /**
   * PUT the ciphertext and resolve with the HTTP status.
   *
   * Injected because `fetch` cannot report upload progress, and a hundred
   * megabytes with no movement looks like a hang. Rejects when the transport
   * itself fails.
   */
  readonly upload: (
    url: string,
    body: Uint8Array,
    onProgress: (sent: number, total: number) => void
  ) => Promise<number>;
}

export type PublishPhase =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'encrypting' }
  | {
      readonly kind: 'uploading';
      readonly sent: number;
      readonly total: number;
    }
  | { readonly kind: 'finishing' };

export interface PublishResult {
  /** The full link, key included. It exists nowhere but here. */
  readonly url: string;
  readonly relicId: string;
  readonly filename: string;
  readonly rendererClass: RendererClass;
  /**
   * The title the service now holds, after normalization, or undefined when
   * none was sent. Reported because a client that rewrites a title without
   * saying so has published a name nobody chose.
   */
  readonly title: string | undefined;
  /** Null when the relic has no lifetime, which is the default. */
  readonly relicExpiresAt: string | null;
}

export async function publishFile(
  source: PublishSource,
  options: PublishOptions,
  deps: PublishDeps,
  onPhase: (phase: PublishPhase) => void = () => undefined
): Promise<PublishResult> {
  onPhase({ kind: 'preparing' });

  // The challenge returns the cap before anything is read, so a file over it
  // is refused using the server's number and never loaded into memory.
  let challenge = await post(deps, '/api/challenge', {});
  const serverLimit = challenge['size_limit_bytes'];
  if (
    typeof serverLimit !== 'number' ||
    !Number.isSafeInteger(serverLimit) ||
    serverLimit <= 0
  ) {
    throw new PublishFailure(
      'service_response_unusable',
      'The service sent a challenge with no usable size limit. Try again later.'
    );
  }
  const limit = Math.min(serverLimit, BROWSER_PUBLISH_LIMIT_BYTES);
  if (source.size > limit) {
    throw new PublishFailure(
      'size_over_cap',
      `This file is ${formatBytes(source.size)}. This page publishes files up to ${formatBytes(limit)}` +
        (serverLimit > limit
          ? `; your coding agent can publish up to ${formatBytes(serverLimit)}.`
          : '.'),
      { size_limit_bytes: limit, declared_size_bytes: source.size }
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await source.read();
  } catch {
    throw new PublishFailure(
      'source_unreadable',
      `${source.name} could not be read. Check that the file is available on this device.`
    );
  }

  const filename = source.name;
  const rendererClass = deriveRendererClass(bytes, filename);
  const title = normalizeTitle(options.title);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) challenge = await post(deps, '/api/challenge', {});

    // The id and the key are drawn independently, here, from the platform
    // CSPRNG. Neither derives from the other, because the operator holds
    // every id.
    const relicId = generateRelicId();
    const key = generateKey();

    onPhase({ kind: 'encrypting' });
    const container = await encryptRelic({
      content: bytes,
      filename,
      mimetype: guessMimetype(filename, rendererClass),
      key,
    });

    let grant: Record<string, unknown>;
    try {
      grant = await post(deps, '/api/grant', {
        challenge_nonce: challenge['challenge_nonce'],
        relic_id: relicId,
        renderer_class: rendererClass,
        publishing_client: PUBLISHING_CLIENT,
        declared_size_bytes: bytes.length,
        declared_ciphertext_bytes: container.length,
        ...(title.length > 0 ? { title } : {}),
        // Lets a reader who holds the link share it from the viewer. It is
        // a hash of a value derived from the key, so it reveals nothing of
        // the key itself.
        share_verifier: await shareVerifierFor(await deriveShareProof(key)),
      });
    } catch (error) {
      if (
        error instanceof PublishFailure &&
        error.code === 'grant_refused' &&
        (error.details['app_code'] === 'relic_id_collision' ||
          error.details['app_code'] === 'invalid_challenge_nonce')
      ) {
        continue;
      }
      throw error;
    }

    let status: number;
    try {
      status = await deps.upload(
        String(grant['upload_url']),
        container,
        (sent, total) => onPhase({ kind: 'uploading', sent, total })
      );
    } catch {
      throw new PublishFailure(
        'upload_failed',
        'The upload was interrupted before it finished. Nothing was ' +
          'published; try again.'
      );
    }
    if (status < 200 || status >= 300) {
      throw new PublishFailure(
        'upload_failed',
        status === 403
          ? 'The upload window closed before the file finished sending. ' +
              'Try again.'
          : `Storage refused the upload (${status}). Nothing was published.`,
        { storage_status: status }
      );
    }

    onPhase({ kind: 'finishing' });
    // An optimisation, never a requirement: the object is uploaded and the
    // link works whether or not this lands. What it adds is the service's own
    // digest of the stored object, which is checked below when it arrives.
    const completion = await post(
      deps,
      `/api/relics/${relicId}/complete`,
      {}
    ).catch(() => undefined);
    const serverDigest = completion?.['version_digest'];
    if (typeof serverDigest === 'string') {
      const local = await sha256Hex(container);
      if (local !== serverDigest) {
        throw new PublishFailure(
          'digest_mismatch',
          'The stored copy did not match what this page sent, so the link ' +
            'was not shown. Publish the file again.',
          { relic_id: relicId }
        );
      }
    }

    return {
      url: relicUrl(deps.serviceOrigin, relicId, key),
      relicId,
      filename,
      rendererClass,
      title: title.length > 0 ? title : undefined,
      relicExpiresAt:
        grant['relic_expires_at'] == null
          ? null
          : String(grant['relic_expires_at']),
    };
  }

  throw new PublishFailure(
    'grant_refused',
    'Could not reserve an id for this file. Try again.'
  );
}

/** Publish an already reviewed folder without sending any paths outside ciphertext. */
export async function publishFolder(
  folder: BrowserFolder,
  options: PublishOptions,
  deps: PublishDeps,
  onPhase: (phase: PublishPhase) => void = () => undefined
): Promise<PublishResult> {
  onPhase({ kind: 'preparing' });
  let challenge = await post(deps, '/api/challenge', {});
  const serverLimit = challenge['size_limit_bytes'];
  if (
    typeof serverLimit !== 'number' ||
    !Number.isSafeInteger(serverLimit) ||
    serverLimit <= 0
  )
    throw new PublishFailure(
      'service_response_unusable',
      'The service sent a challenge with no usable size limit. Try again later.'
    );
  const limit = Math.min(serverLimit, BROWSER_PUBLISH_LIMIT_BYTES);
  if (folder.contentLength > limit)
    throw new PublishFailure(
      'size_over_cap',
      `The files and their list exceed this page's ${formatBytes(limit)} limit.`
    );
  const prepared = folderPlaintext(folder);
  const title = normalizeTitle(options.title);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) challenge = await post(deps, '/api/challenge', {});
    const relicId = generateRelicId();
    const key = generateKey();
    onPhase({ kind: 'encrypting' });
    const container = new Uint8Array(
      encryptedSize(
        prepared.header.contentLength,
        undefined,
        prepared.headerBytes.length
      )
    );
    let offset = 0;
    const reader = encryptFolderStream({ ...folder, key }).getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      container.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    if (offset !== container.length)
      throw new PublishFailure(
        'source_unreadable',
        'The folder changed while it was being read. Nothing was published.'
      );
    let grant: Record<string, unknown>;
    try {
      grant = await post(deps, '/api/grant', {
        challenge_nonce: challenge['challenge_nonce'],
        relic_id: relicId,
        renderer_class: 'folder',
        publishing_client: PUBLISHING_CLIENT,
        declared_size_bytes: prepared.header.contentLength,
        declared_ciphertext_bytes: container.length,
        ...(title.length > 0 ? { title } : {}),
        share_verifier: await shareVerifierFor(await deriveShareProof(key)),
      });
    } catch (error) {
      if (
        error instanceof PublishFailure &&
        error.code === 'grant_refused' &&
        (error.details['app_code'] === 'relic_id_collision' ||
          error.details['app_code'] === 'invalid_challenge_nonce')
      )
        continue;
      throw error;
    }
    let status: number;
    try {
      status = await deps.upload(
        String(grant['upload_url']),
        container,
        (sent, total) => onPhase({ kind: 'uploading', sent, total })
      );
    } catch {
      throw new PublishFailure(
        'upload_failed',
        'The upload was interrupted. Nothing was published; try again.'
      );
    }
    if (status < 200 || status >= 300)
      throw new PublishFailure(
        'upload_failed',
        `Storage refused the upload (${status}). Nothing was published.`,
        { storage_status: status }
      );
    onPhase({ kind: 'finishing' });
    const completion = await post(
      deps,
      `/api/relics/${relicId}/complete`,
      {}
    ).catch(() => undefined);
    const digest = completion?.['version_digest'];
    if (typeof digest === 'string' && (await sha256Hex(container)) !== digest)
      throw new PublishFailure(
        'digest_mismatch',
        'The stored copy did not match. Publish the folder again.',
        { relic_id: relicId }
      );
    return {
      url: relicUrl(deps.serviceOrigin, relicId, key),
      relicId,
      filename: folder.name,
      rendererClass: 'folder',
      title: title.length > 0 ? title : undefined,
      relicExpiresAt:
        grant['relic_expires_at'] == null
          ? null
          : String(grant['relic_expires_at']),
    };
  }
  throw new PublishFailure(
    'grant_refused',
    'Could not reserve an id for this folder. Try again.'
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

async function post(
  deps: PublishDeps,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(`${deps.serviceOrigin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PublishFailure(
      'service_unreachable',
      'Could not reach the service. Check your connection and try again.'
    );
  }

  const parsed = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (response.ok) return parsed;

  // Clients key on `code`, never on prose (RFC 9457 says so about `detail`).
  const code = String(parsed['code'] ?? '');

  if (code === 'publish_rate_limited' || response.status === 429) {
    const seconds = Number(parsed['retry_after_seconds']);
    throw new PublishFailure(
      'publish_rate_limited',
      Number.isFinite(seconds) && seconds > 0
        ? `Too many publishes from this network. Try again in ${waitText(seconds)}.`
        : 'Too many publishes from this network. Try again later.',
      { retry_after_seconds: seconds }
    );
  }
  if (code === 'service_paused' || response.status === 503) {
    throw new PublishFailure(
      'service_paused',
      'Publishing is paused right now. Try again later.'
    );
  }
  if (code === 'size_over_cap') {
    throw new PublishFailure(
      'size_over_cap',
      `This file is ${formatBytes(Number(parsed['declared_size_bytes']))}. ` +
        `The service limit is ${formatBytes(Number(parsed['size_limit_bytes']))}.`,
      {
        size_limit_bytes: parsed['size_limit_bytes'],
        declared_size_bytes: parsed['declared_size_bytes'],
      }
    );
  }
  throw new PublishFailure(
    'grant_refused',
    `The service refused this publish${code === '' ? '' : ` (${code})`}.`,
    { app_code: code, app_status: response.status }
  );
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}
