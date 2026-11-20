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
 * - The publish token the grant returns is discarded. Holding it would mean
 *   keeping a per-relic credential in the browser, which is a "my relics"
 *   list under another name, and the frame rules that out. A relic published
 *   from the page therefore cannot be republished from it.
 * - The challenge is taken again on every retry. The server consumes a nonce
 *   at grant time even when the grant is then refused, so reusing it after a
 *   collision would fail with `invalid_challenge_nonce`.
 */

import {
  deriveRendererClass,
  encryptRelic,
  generateKey,
  generateRelicId,
  guessMimetype,
  type RendererClass,
  relicUrl,
} from '@relic/format';
import { formatBytes } from './viewer.ts';

/** Reported to the server as the publishing client, like `relic-mcp` does. */
export const PUBLISHING_CLIENT = 'relik-web';

/** Draws of id and key before a collision is reported as a failure. */
const MAX_ATTEMPTS = 4;

export type PublishCode =
  | 'source_unreadable'
  | 'size_over_cap'
  | 'publish_rate_limited'
  | 'service_paused'
  | 'service_unreachable'
  | 'upload_failed'
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
  /** Null when the relic has no lifetime, which is the default. */
  readonly relicExpiresAt: string | null;
  readonly reportUrl: string;
  readonly disclosureUrl: string;
}

export async function publishFile(
  source: PublishSource,
  deps: PublishDeps,
  onPhase: (phase: PublishPhase) => void = () => undefined
): Promise<PublishResult> {
  onPhase({ kind: 'preparing' });

  // The challenge returns the cap before anything is read, so a file over it
  // is refused using the server's number and never loaded into memory.
  let challenge = await post(deps, '/api/challenge', {});
  const sizeLimit = Number(challenge['size_limit_bytes']);
  if (Number.isFinite(sizeLimit) && source.size > sizeLimit) {
    throw oversize(source.size, sizeLimit);
  }

  let bytes: Uint8Array;
  try {
    bytes = await source.read();
  } catch {
    // A dropped folder arrives as a file that cannot be read, which is the
    // common way to land here.
    throw new PublishFailure(
      'source_unreadable',
      `${source.name} could not be read. A folder cannot be published; ` +
        'make an archive and publish that.'
    );
  }

  const filename = source.name;
  const rendererClass = deriveRendererClass(bytes, filename);

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
    // link works whether or not this lands.
    await post(deps, `/api/relics/${relicId}/complete`, {}).catch(
      () => undefined
    );

    return {
      url: relicUrl(deps.serviceOrigin, relicId, key),
      relicId,
      filename,
      rendererClass,
      relicExpiresAt:
        grant['relic_expires_at'] == null
          ? null
          : String(grant['relic_expires_at']),
      reportUrl: String(grant['report_url']),
      disclosureUrl: String(grant['disclosure_url']),
    };
  }

  throw new PublishFailure(
    'grant_refused',
    'Could not reserve an id for this file. Try again.'
  );
}

function oversize(declared: number, limit: number): PublishFailure {
  return new PublishFailure(
    'size_over_cap',
    `This file is ${formatBytes(declared)}. The limit is ${formatBytes(limit)}.`,
    { size_limit_bytes: limit, declared_size_bytes: declared }
  );
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
    throw oversize(
      Number(parsed['declared_size_bytes']),
      Number(parsed['size_limit_bytes'])
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
