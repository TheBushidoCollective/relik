/**
 * The viewer's core, with no DOM in it, so every rule below is testable.
 *
 * What `spec/format.md` section 5 hands this unit, in order:
 *
 * - The fragment is read once and stripped via `history.replaceState` (2.5),
 *   which obliges a copy-link affordance and a dead-page state after reload.
 * - The viewing origin sends `Referrer-Policy: no-referrer` (section 0).
 * - The renderer class never routes (3.6), and the declared-versus-sniffed
 *   disagreement rule runs against the envelope header's declared mimetype
 *   and filename.
 * - Unknown versions refuse in both places (3.7), and `idlen != 0` refuses
 *   after the fetch (3.4).
 * - A decrypt failure does not mean "wrong key" (3.5).
 */

import {
  ContentTooLargeError,
  DecryptFailedError,
  deriveRendererClass,
  encodeFragment,
  FORMAT_VERSION,
  INSECURE_ADVICE,
  INSECURE_DETAIL,
  INSECURE_TITLE,
  KeyIdPresentError,
  leastPrivileged,
  LOAD_OPENING,
  MalformedContainerError,
  MalformedFragmentError,
  openEnvelope,
  openRelicStream,
  parseFragment,
  parseRelicId,
  PHASE_DECRYPTING,
  PHASE_FETCHING,
  PHASE_RENDERING,
  plaintextSizeUpperBound,
  privilegeTier,
  type RendererClass,
  sniffContentClass,
  TransferIncompleteError,
  TruncatedContainerError,
  UnknownVersionError,
  VersionMismatchError,
  versionDigest,
} from '@relic/format';
import { isComponentSource } from './jsx.ts';
import type { VaultEntry } from './vault.ts';
export type { VaultEntry };

import type { CommentedRelic } from './relic-rows.ts';

/** Refuse before allocating anything this large. */
export const MAX_RENDER_BYTES = 100 * 1024 * 1024;

export interface LoadContents {
  readonly filename: string;
  readonly length: number;
}

export type LoadProgress =
  | { readonly phase: 'opening' }
  | {
      readonly phase: 'fetching';
      readonly received: number;
      readonly total: number;
      readonly contents?: LoadContents | undefined;
    }
  | {
      readonly phase: 'decrypting';
      readonly opened: number;
      readonly contents: LoadContents;
    };

export interface CachedPrefix {
  readonly prefix: Uint8Array;
  readonly mint: MintResponse;
}

export interface LoadResume {
  readonly fragment: string;
  readonly mint?: MintResponse | undefined;
}

export type ViewerState =
  | { kind: 'ready'; view: ReadyView }
  | {
      kind: 'dead';
      dead: DeadView;
      cachedPrefix?: CachedPrefix | undefined;
      cachedCiphertext?: CachedPrefix | undefined;
      resume?: LoadResume | undefined;
    };

export interface ReadyView {
  readonly filename: string;
  readonly declaredMimetype: string;
  readonly content: Uint8Array;
  readonly route: RenderRoute;
  /**
   * Set when the declared type and the sniffed type disagreed. The recipient
   * is told, because silently downgrading is how a viewer trains people to
   * ignore it.
   */
  readonly downgradeNotice: string | undefined;
  /** Backs the copy-link affordance the fragment strip obliges. */
  readonly shareUrl: string;
  /** The ciphertext revision this view was decrypted from. */
  readonly version: number;
  /** The newest revision available to this link holder. */
  readonly currentVersion: number;
  /**
   * Lowercase hex SHA-256 of the exact ciphertext bytes this view was
   * decrypted from. A decision is bound to this, so the panel can refuse to
   * run a ceremony when the service holds a different file for the version.
   */
  readonly versionDigest: string;
}

/** Where content is allowed to render. Never derived from the server. */
export type RenderRoute =
  | 'markdown'
  | 'code'
  | 'image'
  | 'sandboxed-html'
  | 'sandboxed-jsx'
  | 'media'
  | 'otio'
  | 'pdf'
  | 'download';

export type DeadAction =
  | 'retry'
  | 'reopen-original-link'
  | 'report'
  | 'retry-report'
  | 'none';

export interface DeadView {
  readonly headline: string;
  readonly detail: string;
  /** Shown only where the recipient can actually act on it. */
  readonly action: DeadAction;
  readonly code: string;
}

export interface MintResponse {
  readonly url: string;
  readonly url_expires_at: string;
  readonly relic_expires_at: string | null;
  readonly object_length: number;
  readonly object_crc32c: string;
  readonly mints_remaining: number;
  /** The revision this URL signs. */
  readonly version: number;
  /** The newest revision retained for this relic. */
  readonly current_version: number;
}

export type HistoricalVersionState =
  | { readonly kind: 'ready'; readonly view: ReadyView }
  | {
      readonly kind: 'unavailable';
      readonly code: string;
      readonly detail: string;
    };

/**
 * Somewhere to keep a key so a reload does not lose it.
 *
 * The fragment is stripped from the address bar the moment it is read, which
 * is what makes a reload land on a page with no key. That is a real cost paid
 * for a real benefit, and remembering the key on the recipient's own machine
 * buys back the reload without putting the key back in the URL.
 *
 * It does change who can open the relic. Anyone with this browser profile can
 * reopen it for as long as the entry lives, without ever having the link.
 * That is a deliberate trade, it is scoped to the service origin, and it is
 * stated in the disclosure rather than done quietly.
 */
export interface KeyVault {
  /**
   * Remember a key against a relic, until the relic expires.
   *
   * Number.POSITIVE_INFINITY means the relic has no lifetime, so the key is
   * kept until the relic is deleted; the forget-on-dead path evicts it then.
   */
  remember(
    relicId: string,
    fragment: string,
    expiresAt: number,
    meta?: {
      readonly title?: string | undefined;
      readonly renderer?: string | undefined;
    }
  ): void;
  recall(relicId: string): string | undefined;
  forget(relicId: string): void;
  list?(): readonly VaultEntry[];
  exportEntries?(): string;
  importEntries?(json: string): {
    readonly added: number;
    readonly skipped: number;
  };
}

export interface ViewerDeps {
  readonly serviceOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /** Reads `location.hash` exactly once, then hands it over. */
  readonly takeFragment?: () => string;
  /** Calls `history.replaceState` to drop the fragment from the address bar. */
  readonly stripFragment?: () => void;
  readonly locationHref: string;
  readonly keyVault: KeyVault;
  readonly now?: () => number;
  readonly secureContext?: () => boolean;
}

/**
 * The link to hand somebody else: this page, plus the key.
 *
 * Keeps the origin and path the reader is actually on, so a custom domain or a
 * proxy in front of the service produces a link that works from where they got
 * it rather than one pointing at whatever the service calls itself.
 */
export function shareUrlFor(href: string, fragment: string): string {
  const url = new URL(href);
  url.hash = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  return url.toString();
}

function teeAndDigest(source: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const reader = source.getReader();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) {
          chunks.push(value);
          totalLength += value.length;
          controller.enqueue(value);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  const computeDigest = async (): Promise<string> => {
    const full = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      full.set(c, offset);
      offset += c.length;
    }
    return versionDigest(full);
  };
  return { stream, computeDigest };
}

export async function load(
  rawRelicId: string,
  deps: ViewerDeps,
  onProgress?: (p: LoadProgress) => void,
  resume?: LoadResume
): Promise<ViewerState> {
  let relicId: string;
  try {
    relicId = parseRelicId(rawRelicId);
  } catch {
    return {
      kind: 'dead',
      dead: {
        headline: 'No such relic',
        detail:
          'This link does not point at anything. It may have been mistyped.',
        action: 'none',
        code: 'invalid_relic_id',
      },
    };
  }
  const isSecure =
    deps.secureContext !== undefined
      ? deps.secureContext()
      : (typeof globalThis.isSecureContext === 'undefined' ||
          globalThis.isSecureContext) &&
        globalThis.crypto?.subtle !== undefined;

  if (!isSecure) {
    return {
      kind: 'dead',
      dead: {
        headline: INSECURE_TITLE,
        detail: `${INSECURE_DETAIL}\n\n${INSECURE_ADVICE}`,
        action: 'none',
        code: 'insecure_context',
      },
    };
  }

  let fragment: string;
  let fromVault = false;

  if (resume !== undefined) {
    fragment = resume.fragment;
  } else {
    const raw = deps.takeFragment
      ? deps.takeFragment()
      : (() => {
          try {
            return new URL(deps.locationHref).hash;
          } catch {
            return '';
          }
        })();

    if (raw === undefined || raw === '' || raw === '#') {
      const recalled = deps.keyVault.recall(relicId);
      if (recalled !== undefined) {
        fragment = recalled;
        fromVault = true;
      } else {
        return {
          kind: 'dead',
          dead: {
            headline: 'This link is missing its key',
            detail:
              'The part of the link after the # is the decryption key, and it ' +
              'is not here. This usually means the page was reloaded, which ' +
              'drops it. Open the original link again.',
            action: 'reopen-original-link',
            code: 'fragment_missing',
          },
        };
      }
    } else {
      fragment = raw.startsWith('#') ? raw.slice(1) : raw;
      deps.stripFragment?.();
    }
  }

  if (fragment.startsWith('#')) {
    fragment = fragment.slice(1);
  }

  const shareUrl = shareUrlFor(deps.locationHref, fragment);

  let key: Uint8Array;
  let version: number;
  try {
    ({ key, version } = parseFragment(fragment));
  } catch (error) {
    if (error instanceof UnknownVersionError) {
      return dead(
        'This relic uses a newer format',
        'This viewer does not know how to read it. Nothing was fetched.',
        'none',
        'unknown_version'
      );
    }
    if (fromVault) deps.keyVault.forget(relicId);
    if (error instanceof MalformedFragmentError) {
      return dead(
        'This link looks truncated',
        'The key in the link is not the right length. Links can lose ' +
          'characters when they are pasted or wrapped. Ask the sender to ' +
          'send it again.',
        'reopen-original-link',
        'fragment_malformed'
      );
    }
    throw error;
  }

  let mintResponse: MintResponse;
  const now = deps.now ? deps.now() : Date.now();

  if (resume?.mint && Date.parse(resume.mint.url_expires_at) - now >= 60_000) {
    mintResponse = resume.mint;
  } else {
    onProgress?.({ phase: 'opening' });
    const minted = await mint(relicId, deps);
    if ('dead' in minted) {
      if (minted.dead.code !== 'service_unreachable' && fromVault) {
        deps.keyVault.forget(relicId);
      }
      return {
        kind: 'dead',
        dead: minted.dead,
        resume: { fragment },
      };
    }
    mintResponse = minted.mint;
  }
  onProgress?.({
    phase: 'fetching',
    received: 0,
    total: mintResponse.object_length,
  });

  const upperBound = plaintextSizeUpperBound(mintResponse.object_length);
  if (upperBound > MAX_RENDER_BYTES) {
    return dead(
      'This relic is too large to open here',
      `It holds up to ${formatBytes(upperBound)}, past what this viewer will ` +
        'load into a browser tab.',
      'none',
      'too_large'
    );
  }

  let fetched: Response;
  try {
    fetched = await deps.fetch(mintResponse.url);
  } catch {
    return dead(
      'This relic could not be opened',
      'Something went wrong reaching the service.',
      'retry',
      'service_unreachable',
      undefined,
      { fragment, mint: mintResponse }
    );
  }

  if (!fetched.ok) {
    return dead(
      'This relic is no longer available',
      'It was removed after this page started loading.',
      'report',
      'removed_after_mint'
    );
  }

  if (!fetched.body) {
    return dead(
      'The download was cut short',
      'The transfer did not complete. This is a network problem, not a ' +
        'problem with the link.',
      'retry',
      'truncated_transfer',
      undefined,
      { fragment, mint: mintResponse }
    );
  }
  const { stream: bodyStream, computeDigest } = teeAndDigest(fetched.body);

  let cachedPrefixData: CachedPrefix | undefined;
  let envelopeFired = false;
  let loadContents: LoadContents | undefined;

  try {
    const opened = await openRelicStream(bodyStream, key, {
      objectLength: mintResponse.object_length,
      fragmentVersion: version,
      maxContentBytes: MAX_RENDER_BYTES,
      onPrefix: (prefix) => {
        cachedPrefixData = { prefix, mint: mintResponse };
      },
      onEnvelope: (env) => {
        envelopeFired = true;
        const entry = env.entries[0];
        if (entry) {
          loadContents = { filename: entry.filename, length: entry.length };
        }
      },
      onProgress: (prog) => {
        if (prog.receivedBytes < prog.objectLength) {
          onProgress?.({
            phase: 'fetching',
            received: prog.receivedBytes,
            total: prog.objectLength,
            contents: loadContents,
          });
        } else {
          if (loadContents && prog.openedContentBytes < loadContents.length) {
            onProgress?.({
              phase: 'decrypting',
              opened: prog.openedContentBytes,
              contents: loadContents,
            });
          } else {
            onProgress?.({
              phase: 'fetching',
              received: prog.receivedBytes,
              total: prog.objectLength,
              contents: loadContents,
            });
          }
        }
      },
    });

    const entry = opened.envelope.entries[0];
    if (entry === undefined) {
      return dead(
        'This relic is empty',
        'Its envelope declares no content.',
        'none',
        'empty_envelope'
      );
    }

    const route = routeFor(entry.filename, entry.mimetype, opened.content);

    deps.keyVault.remember(
      relicId,
      fragment,
      mintResponse.relic_expires_at === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(mintResponse.relic_expires_at),
      { title: entry.filename, renderer: route.route }
    );

    const digest = await computeDigest();
    return {
      kind: 'ready',
      view: {
        filename: entry.filename,
        declaredMimetype: entry.mimetype,
        content: opened.content,
        route: route.route,
        downgradeNotice: route.notice,
        shareUrl,
        version: mintResponse.version,
        currentVersion: mintResponse.current_version,
        versionDigest: digest,
      },
    };
  } catch (error) {
    if (error instanceof TransferIncompleteError) {
      return {
        kind: 'dead',
        dead: {
          headline: 'The download was cut short',
          detail:
            'The transfer did not complete. This is a network problem, not a ' +
            'problem with the link.',
          action: 'retry',
          code: 'truncated_transfer',
        },
        resume: { fragment, mint: mintResponse },
      };
    }

    if (error instanceof DecryptFailedError && error.recordSeq === 0) {
      if (fromVault) deps.keyVault.forget(relicId);
      return {
        kind: 'dead',
        dead: {
          headline: 'This relic could not be opened',
          detail:
            'The file did not decrypt. That can mean the link was altered or ' +
            'shortened, or that the stored file was changed. There is no way ' +
            'to tell which from here.',
          action: 'reopen-original-link',
          code: 'decrypt_failed',
        },
        cachedPrefix: cachedPrefixData,
        cachedCiphertext: cachedPrefixData,
      };
    }

    if (envelopeFired) {
      return {
        kind: 'dead',
        dead: {
          headline: DAMAGED_TITLE,
          detail: DAMAGED_DETAIL,
          action: 'retry-report',
          code: 'content_damaged',
        },
        resume: { fragment, mint: mintResponse },
      };
    }

    if (error instanceof KeyIdPresentError) {
      return dead(
        'This relic is malformed',
        'It sets a header field this format forbids.',
        'none',
        'keyid_present'
      );
    }

    if (error instanceof VersionMismatchError) {
      return dead(
        'This relic does not match its link',
        'The format version inside the file disagrees with the one in the ' +
          'link. The link may have been altered.',
        'none',
        'version_mismatch'
      );
    }

    if (error instanceof ContentTooLargeError) {
      return dead(
        'This relic is too large to open here',
        `It holds up to ${formatBytes(error.declaredBytes)}, past what this viewer will ` +
          'load into a browser tab.',
        'none',
        'too_large'
      );
    }

    return dead(
      'This relic could not be read',
      'Its contents are not in a shape this viewer understands.',
      'none',
      'malformed_container'
    );
  }
}

async function mint(
  rawRelicId: string,
  deps: ViewerDeps,
  requestedVersion?: number
): Promise<{ mint: MintResponse } | { dead: DeadView }> {
  let relicId: string;
  try {
    relicId = parseRelicId(rawRelicId);
  } catch {
    return { dead: deadFromProblem('invalid_relic_id') };
  }
  let response: Response;
  try {
    response = await deps.fetch(
      `${deps.serviceOrigin}/api/relics/${encodeURIComponent(relicId)}/mint`,
      requestedVersion === undefined
        ? { method: 'POST' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ version: requestedVersion }),
          }
    );
  } catch {
    return {
      dead: {
        headline: 'This relic could not be opened',
        detail: 'Something went wrong reaching the service.',
        action: 'retry',
        code: 'service_unreachable',
      },
    };
  }

  if (response.ok) {
    return { mint: (await response.json()) as MintResponse };
  }

  const problem = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { dead: deadFromProblem(String(problem['code'] ?? 'unknown')) };
}

/**
 * Mint, fetch, and decrypt one retained revision without disturbing the
 * current view. The key is recovered from the in-memory share URL that already
 * backs Copy link. Neither plaintext nor a comparison result crosses the
 * service boundary.
 */
export async function loadHistoricalVersion(
  relicId: string,
  requestedVersion: number,
  current: ReadyView,
  deps: ViewerDeps,
  onProgress?: (p: LoadProgress) => void
): Promise<HistoricalVersionState> {
  if (
    !Number.isInteger(requestedVersion) ||
    requestedVersion < 1 ||
    requestedVersion > current.currentVersion
  ) {
    return {
      kind: 'unavailable',
      code: 'version_invalid',
      detail:
        `Version ${requestedVersion} does not exist. Choose a version from 1 ` +
        `through ${current.currentVersion}.`,
    };
  }

  if (current.version === requestedVersion) {
    return { kind: 'ready', view: current };
  }

  let key: Uint8Array;
  let formatVersion: number;
  try {
    ({ key, version: formatVersion } = parseFragment(
      new URL(current.shareUrl).hash
    ));
  } catch {
    return {
      kind: 'unavailable',
      code: 'version_key_unavailable',
      detail:
        'The in-memory key is no longer available for this comparison. Reopen ' +
        'the original link.',
    };
  }

  onProgress?.({ phase: 'opening' });
  const minted = await mint(relicId, deps, requestedVersion);
  if ('dead' in minted) {
    return {
      kind: 'unavailable',
      code: minted.dead.code,
      detail:
        `Version ${requestedVersion} could not be loaded for comparison. ` +
        `${minted.dead.detail} Version ${current.version} remains open.`,
    };
  }
  const mintResponse = minted.mint;

  if (
    mintResponse.version !== requestedVersion ||
    mintResponse.current_version !== current.currentVersion
  ) {
    return {
      kind: 'unavailable',
      code: 'version_mismatch',
      detail:
        'The service signed a different version than the viewer requested. ' +
        `Version ${current.version} remains open.`,
    };
  }

  const upperBound = plaintextSizeUpperBound(mintResponse.object_length);
  if (upperBound > MAX_RENDER_BYTES) {
    return {
      kind: 'unavailable',
      code: 'version_too_large',
      detail:
        `Version ${requestedVersion} holds up to ${formatBytes(upperBound)}, ` +
        `past what this viewer will open. Version ${current.version} ` +
        'remains open.',
    };
  }

  let fetched: Response;
  try {
    fetched = await deps.fetch(mintResponse.url);
  } catch {
    return {
      kind: 'unavailable',
      code: 'version_fetch_failed',
      detail:
        `Version ${requestedVersion} could not be downloaded. Version ` +
        `${current.version} remains open.`,
    };
  }

  if (!fetched.ok) {
    return {
      kind: 'unavailable',
      code: 'version_fetch_failed',
      detail:
        `Version ${requestedVersion} could not be downloaded. Version ` +
        `${current.version} remains open.`,
    };
  }

  if (!fetched.body) {
    return {
      kind: 'unavailable',
      code: 'version_truncated',
      detail:
        `Version ${requestedVersion} did not finish downloading. Version ` +
        `${current.version} remains open.`,
    };
  }
  const { stream: bodyStream, computeDigest } = teeAndDigest(fetched.body);

  let loadContents: LoadContents | undefined;

  try {
    const opened = await openRelicStream(bodyStream, key, {
      objectLength: mintResponse.object_length,
      fragmentVersion: formatVersion,
      maxContentBytes: MAX_RENDER_BYTES,
      onEnvelope: (env) => {
        const entry = env.entries[0];
        if (entry) {
          loadContents = { filename: entry.filename, length: entry.length };
        }
      },
      onProgress: (prog) => {
        if (prog.receivedBytes < prog.objectLength) {
          onProgress?.({
            phase: 'fetching',
            received: prog.receivedBytes,
            total: prog.objectLength,
            contents: loadContents,
          });
        } else {
          if (loadContents && prog.openedContentBytes < loadContents.length) {
            onProgress?.({
              phase: 'decrypting',
              opened: prog.openedContentBytes,
              contents: loadContents,
            });
          } else {
            onProgress?.({
              phase: 'fetching',
              received: prog.receivedBytes,
              total: prog.objectLength,
              contents: loadContents,
            });
          }
        }
      },
    });

    const entry = opened.envelope.entries[0];
    if (entry === undefined) {
      return {
        kind: 'unavailable',
        code: 'version_empty',
        detail:
          `Version ${requestedVersion} has no content. Version ` +
          `${current.version} remains open.`,
      };
    }

    if (opened.content.length > MAX_RENDER_BYTES) {
      return {
        kind: 'unavailable',
        code: 'version_too_large',
        detail:
          `Version ${requestedVersion} is larger than this viewer will open. ` +
          `Version ${current.version} remains open.`,
      };
    }

    const route = routeFor(entry.filename, entry.mimetype, opened.content);
    const digest = await computeDigest();
    return {
      kind: 'ready',
      view: {
        filename: entry.filename,
        declaredMimetype: entry.mimetype,
        content: opened.content,
        route: route.route,
        downgradeNotice: route.notice,
        shareUrl: current.shareUrl,
        version: mintResponse.version,
        currentVersion: mintResponse.current_version,
        versionDigest: digest,
      },
    };
  } catch (error) {
    if (error instanceof TransferIncompleteError) {
      return {
        kind: 'unavailable',
        code: 'version_truncated',
        detail:
          `Version ${requestedVersion} did not finish downloading. Version ` +
          `${current.version} remains open.`,
      };
    }
    return {
      kind: 'unavailable',
      code: 'version_decrypt_failed',
      detail:
        `Version ${requestedVersion} could not be decrypted. Version ` +
        `${current.version} remains open.`,
    };
  }
}

/** Maps the server's codes onto what a recipient should actually be told. */
export function deadFromProblem(code: string): DeadView {
  switch (code) {
    case 'invalid_relic_id':
    case 'relic_not_found':
      return view(
        'No such relic',
        'This link does not point at anything. It may have been mistyped.',
        'none'
      );
    case 'relic_expired':
      return view(
        'This relic has expired',
        'Relics are deleted on a fixed schedule and cannot be extended. Ask ' +
          'the sender to publish it again.',
        'none'
      );
    case 'relic_never_published':
      return view(
        'This relic was never uploaded',
        'The sender started publishing it and it never finished. Ask them ' +
          'to publish it again.',
        'none'
      );
    case 'relic_not_yet_published':
      // Temporary. It must not read as a dead link.
      return view(
        'Still uploading',
        'The sender is still uploading this relic. It will be ready shortly.',
        'retry'
      );
    case 'relic_removed':
      return view(
        'This relic was removed',
        'It is no longer available. If you believe this was a mistake, you ' +
          'can contact us.',
        'report'
      );
    case 'download_cap_exhausted':
      return view(
        'This link has been opened too many times',
        'Each relic can be opened a fixed number of times. Waiting will not ' +
          'help. Ask the sender to publish it again.',
        'none'
      );
    case 'mint_rate_limited':
      return view(
        'Too many requests',
        'Give it a moment and try again.',
        'retry'
      );
    case 'service_paused':
      return view(
        'Relic is paused',
        'The service is temporarily not serving relics. Try again later.',
        'retry'
      );
    case 'invalid_relic_id':
      return view(
        'This link is not valid',
        'The relic id in the link is not a well-formed one.',
        'none'
      );
    default:
      return view(
        'This relic could not be opened',
        'Something went wrong reaching the service.',
        'retry'
      );
  }

  function view(
    headline: string,
    detail: string,
    action: DeadView['action']
  ): DeadView {
    return { headline, detail, action, code };
  }
}

export interface RouteDecision {
  readonly route: RenderRoute;
  readonly notice: string | undefined;
}

/**
 * Decide where content is allowed to render.
 *
 * The declared type comes from the envelope header, which sits inside the
 * AEAD and is therefore tamper-evident, and the sniffed type comes from the
 * decrypted bytes. When they disagree, route to the least privileged path
 * either type would allow, and say so.
 *
 * The renderer class is emitted into the served head as card metadata, but
 * it is not an input here. This function's parameters are the whole routing
 * surface, so routing on the class would require an explicit signature change
 * rather than a silent edit. A publisher-asserted routing input on the origin
 * holding the fragment secret is exactly the shape that turns a lie into
 * fragment theft in one step. The guard test in card-metadata-guard.test.ts
 * enforces that the built bundles never read the card metadata.
 */
export function routeFor(
  filename: string,
  declaredMimetype: string,
  content: Uint8Array
): RouteDecision {
  const declared = classFromMimetype(declaredMimetype, filename);
  // Content only. Feeding the filename into the sniff would make this
  // comparison measure the declared name against itself, and it would agree
  // in exactly the case the rule exists to catch.
  let sniffed = sniffContentClass(content);

  // JSX is the one class the byte sniffer cannot see: telling a component
  // from prose takes a parser, `@relic/format` stays dependency-free, and no
  // cheap prefix separates the two. So the question is asked here, with the
  // compiler, and only when the declared class already says `jsx`.
  //
  // The gate is the declared class rather than content alone, and that is
  // deliberate. Asking it of every textual relic would sniff every valid
  // JavaScript file as `jsx` and downgrade it with a spurious notice, so the
  // parse is spent only where the answer can change the route. The answer
  // itself is content-truth the publisher cannot influence: prose fails to
  // parse and falls back to `code`, and the only route the upgrade can
  // produce is the sandboxed frame, never inline rendering on this origin.
  // A component that does not parse is shown as source, which is the
  // least-privileged telling of a lie.
  if (declared === 'jsx' && sniffed === 'code') {
    const source = new TextDecoder('utf-8', { fatal: false }).decode(content);
    if (isComponentSource(source, filename)) sniffed = 'jsx';
  }

  // Tiers, not classes. `markdown` and `code` are both escaped text and
  // carry identical privilege, and the sniffer cannot tell them apart, so
  // comparing classes would downgrade every Markdown relic ever published.
  if (privilegeTier(declared) === privilegeTier(sniffed)) {
    return { route: routeForClass(declared), notice: undefined };
  }

  const resolved = leastPrivileged(declared, sniffed);
  return {
    route: routeForClass(resolved),
    notice:
      `This file is named like ${describe(declared)} but its contents look ` +
      `like ${describe(sniffed)}. It is being shown the safer way.`,
  };
}

export function routeForClass(cls: RendererClass): RenderRoute {
  switch (cls) {
    case 'markdown':
      return 'markdown';
    case 'code':
      return 'code';
    case 'image':
      return 'image';
    case 'media':
      return 'media';
    case 'otio':
      return 'otio';
    case 'html':
      return 'sandboxed-html';
    case 'jsx':
      // Same frame as HTML, different payload: transpiled text posted in
      // rather than markup. Never inline on this origin.
      return 'sandboxed-jsx';
    case 'pdf':
      return 'pdf';
    default:
      // Archives and arbitrary binaries are download-only in the
      // first release. The framing keeps range decryption available so this
      // can change without a new container.
      return 'download';
  }
}

function classFromMimetype(mimetype: string, filename: string): RendererClass {
  const type = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';

  if (type === 'text/markdown') return 'markdown';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'image/svg+xml') return 'html'; // SVG carries script
  if (type === 'text/jsx' || type === 'text/tsx') return 'jsx';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'application/x-otio' || type === 'application/x-otioz')
    return 'otio';
  if (
    type === 'application/zip' ||
    type === 'application/gzip' ||
    type === 'application/x-tar'
  ) {
    return 'archive';
  }
  if (type.startsWith('text/') || type === 'application/json') return 'code';
  if (type === 'application/octet-stream') {
    // Uninformative, so fall back to the name, which is the only other
    // declared signal.
    return deriveRendererClass(new Uint8Array([0x20]), filename);
  }
  return 'binary';
}

function describe(cls: RendererClass): string {
  switch (cls) {
    case 'markdown':
      return 'a Markdown document';
    case 'code':
      return 'a text or code file';
    case 'html':
      return 'a web page';
    case 'jsx':
      return 'a React component';
    case 'pdf':
      return 'a PDF document';
    case 'image':
      return 'an image';
    case 'media':
      return 'audio or video';
    case 'otio':
      return 'an OpenTimelineIO timeline';
    case 'archive':
      return 'an archive';
    default:
      return 'a binary file';
  }
}

export const DAMAGED_TITLE = 'The stored file is damaged';
export const DAMAGED_DETAIL =
  'The start of the file decrypted with this link, so the link is fine. A later part did not, which means the stored file was changed or damaged.';

function dead(
  headline: string,
  detail: string,
  action: DeadView['action'] = 'none',
  code = 'error',
  cachedPrefix?: CachedPrefix,
  resume?: LoadResume
): ViewerState {
  return {
    kind: 'dead',
    dead: { headline, detail, action, code },
    cachedPrefix,
    cachedCiphertext: cachedPrefix,
    resume,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function formatTransfer(received: number, total: number): string {
  if (total < 1000) {
    return `${Math.round(received)} of ${Math.round(total)} B`;
  }
  if (total < 1_000_000) {
    return `${(received / 1000).toFixed(1)} of ${(total / 1000).toFixed(1)} KB`;
  }
  if (total < 1_000_000_000) {
    return `${(received / 1_000_000).toFixed(1)} of ${(total / 1_000_000).toFixed(1)} MB`;
  }
  return `${(received / 1_000_000_000).toFixed(1)} of ${(total / 1_000_000_000).toFixed(1)} GB`;
}

export function progressLine(p: LoadProgress): string {
  switch (p.phase) {
    case 'opening':
      return LOAD_OPENING;
    case 'fetching':
      return `${PHASE_FETCHING} ${formatTransfer(p.received, p.total)}`;
    case 'decrypting':
      return `${PHASE_DECRYPTING} ${formatTransfer(p.opened, p.contents.length)}`;
  }
}

export function isKeyEntryRecoverable(code: string): boolean {
  return (
    code === 'fragment_missing' ||
    code === 'fragment_malformed' ||
    code === 'decrypt_failed'
  );
}

export interface ResolvedKey {
  readonly key: Uint8Array;
  readonly version: number;
  readonly fragment: string;
}

export type KeyResolutionResult =
  | { readonly kind: 'key'; readonly resolved: ResolvedKey }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Resolves user-entered text into a relic key and fragment.
 * Accepts a bare fragment (#r1... or r1...), a full share URL,
 * or a spoken mnemonic phrase. Dynamically imports the mnemonic
 * module to keep the wordlist out of the eager shell bundle.
 */
export async function resolveEnteredKey(
  input: string
): Promise<KeyResolutionResult> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { kind: 'invalid', message: 'That is not a key.' };
  }

  let fragmentCandidate: string | undefined;
  if (trimmed.startsWith('r1')) {
    fragmentCandidate = trimmed;
  } else if (trimmed.startsWith('#r1')) {
    fragmentCandidate = trimmed.slice(1);
  } else if (trimmed.includes('#r1')) {
    fragmentCandidate = trimmed.slice(trimmed.indexOf('#r1') + 1);
  }

  if (fragmentCandidate !== undefined) {
    try {
      const parsed = parseFragment(fragmentCandidate);
      return {
        kind: 'key',
        resolved: {
          key: parsed.key,
          version: parsed.version,
          fragment: fragmentCandidate,
        },
      };
    } catch {
      return { kind: 'invalid', message: 'That is not a key.' };
    }
  }

  // Dynamic import of mnemonic module so the wordlist stays out of the eager bundle.
  const { isMnemonicLike, mnemonicToKey } = await import(
    '@relic/format/mnemonic'
  );

  const mnemonicCandidate = trimmed.startsWith('#')
    ? trimmed.slice(1).trim()
    : trimmed;

  if (isMnemonicLike(mnemonicCandidate)) {
    try {
      const key = mnemonicToKey(mnemonicCandidate);
      return {
        kind: 'key',
        resolved: {
          key,
          version: FORMAT_VERSION,
          fragment: encodeFragment(key),
        },
      };
    } catch {
      return { kind: 'invalid', message: 'That is not a key.' };
    }
  }

  return { kind: 'invalid', message: 'That is not a key.' };
}

export type KeyEntryAttemptResult =
  | { readonly kind: 'ready'; readonly view: ReadyView }
  | { readonly kind: 'invalid'; readonly message: string }
  | {
      readonly kind: 'wrong_key';
      readonly message: string;
      readonly cachedPrefix?: CachedPrefix | undefined;
    }
  | { readonly kind: 'dead'; readonly dead: DeadView };

/**
 * Attempts to open a relic using manually entered key material.
 * Performs decryption locally: the key material is never sent in any network request.
 */
export async function openRelicWithKey(
  relicId: string,
  input: string,
  deps: ViewerDeps,
  cachedPrefix?: CachedPrefix,
  onProgress?: (p: LoadProgress) => void
): Promise<KeyEntryAttemptResult> {
  const resolution = await resolveEnteredKey(input);
  if (resolution.kind === 'invalid') {
    return { kind: 'invalid', message: resolution.message };
  }

  const { key, version, fragment } = resolution.resolved;

  if (cachedPrefix !== undefined) {
    try {
      await openEnvelope(cachedPrefix.prefix, key, version);
    } catch (err) {
      if (err instanceof DecryptFailedError) {
        return {
          kind: 'wrong_key',
          message: 'That key does not open this relic.',
          cachedPrefix,
        };
      }
    }
  }

  let mintResponse: MintResponse;
  const now = deps.now ? deps.now() : Date.now();

  if (
    cachedPrefix?.mint &&
    Date.parse(cachedPrefix.mint.url_expires_at) - now >= 60_000
  ) {
    mintResponse = cachedPrefix.mint;
  } else {
    onProgress?.({ phase: 'opening' });
    const minted = await mint(relicId, deps);
    if ('dead' in minted) {
      return { kind: 'dead', dead: minted.dead };
    }
    mintResponse = minted.mint;
  }

  const upperBound = plaintextSizeUpperBound(mintResponse.object_length);
  if (upperBound > MAX_RENDER_BYTES) {
    return {
      kind: 'dead',
      dead: {
        headline: 'This relic is too large to open here',
        detail:
          `It holds up to ${formatBytes(upperBound)}, past what this viewer will ` +
          'load into a browser tab.',
        action: 'none',
        code: 'too_large',
      },
    };
  }

  let fetched: Response;
  try {
    fetched = await deps.fetch(mintResponse.url);
  } catch {
    return {
      kind: 'dead',
      dead: {
        headline: 'This relic could not be opened',
        detail: 'Something went wrong reaching the service.',
        action: 'retry',
        code: 'service_unreachable',
      },
    };
  }

  if (!fetched.ok) {
    return {
      kind: 'dead',
      dead: {
        headline: 'This relic is no longer available',
        detail: 'It was removed after this page started loading.',
        action: 'report',
        code: 'removed_after_mint',
      },
    };
  }

  if (!fetched.body) {
    return {
      kind: 'dead',
      dead: {
        headline: 'The download was cut short',
        detail:
          'The transfer did not complete. This is a network problem, not a ' +
          'problem with the link.',
        action: 'retry',
        code: 'truncated_transfer',
      },
    };
  }

  let newCachedPrefix: CachedPrefix | undefined = cachedPrefix;
  let envelopeFired = false;
  let loadContents: LoadContents | undefined;

  try {
    const { stream: bodyStream, computeDigest } = teeAndDigest(fetched.body);
    const opened = await openRelicStream(bodyStream, key, {
      objectLength: mintResponse.object_length,
      fragmentVersion: version,
      maxContentBytes: MAX_RENDER_BYTES,
      onPrefix: (prefix) => {
        newCachedPrefix = { prefix, mint: mintResponse };
      },
      onEnvelope: (env) => {
        envelopeFired = true;
        const entry = env.entries[0];
        if (entry) {
          loadContents = { filename: entry.filename, length: entry.length };
        }
      },
      onProgress: (prog) => {
        if (prog.receivedBytes < prog.objectLength) {
          onProgress?.({
            phase: 'fetching',
            received: prog.receivedBytes,
            total: prog.objectLength,
            contents: loadContents,
          });
        } else {
          if (loadContents && prog.openedContentBytes < loadContents.length) {
            onProgress?.({
              phase: 'decrypting',
              opened: prog.openedContentBytes,
              contents: loadContents,
            });
          } else {
            onProgress?.({
              phase: 'fetching',
              received: prog.receivedBytes,
              total: prog.objectLength,
              contents: loadContents,
            });
          }
        }
      },
    });

    const entry = opened.envelope.entries[0];
    if (entry === undefined) {
      return {
        kind: 'dead',
        dead: {
          headline: 'This relic is empty',
          detail: 'Its envelope declares no content.',
          action: 'none',
          code: 'empty_envelope',
        },
      };
    }

    const route = routeFor(entry.filename, entry.mimetype, opened.content);
    const shareUrl = shareUrlFor(deps.locationHref, fragment);

    const expiresAt =
      mintResponse.relic_expires_at === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(mintResponse.relic_expires_at);

    deps.keyVault.remember(relicId, fragment, expiresAt, {
      title: entry.filename,
      renderer: route.route,
    });

    const digest = await computeDigest();
    return {
      kind: 'ready',
      view: {
        filename: entry.filename,
        declaredMimetype: entry.mimetype,
        content: opened.content,
        route: route.route,
        downgradeNotice: route.notice,
        shareUrl,
        version: mintResponse.version,
        currentVersion: mintResponse.current_version,
        versionDigest: digest,
      },
    };
  } catch (error) {
    if (error instanceof DecryptFailedError && error.recordSeq === 0) {
      return {
        kind: 'wrong_key',
        message: 'That key does not open this relic.',
        cachedPrefix: newCachedPrefix,
      };
    }
    if (envelopeFired) {
      return {
        kind: 'dead',
        dead: {
          headline: DAMAGED_TITLE,
          detail: DAMAGED_DETAIL,
          action: 'retry-report',
          code: 'content_damaged',
        },
      };
    }
    if (error instanceof TransferIncompleteError) {
      return {
        kind: 'dead',
        dead: {
          headline: 'The download was cut short',
          detail:
            'The transfer did not complete. This is a network problem, not a ' +
            'problem with the link.',
          action: 'retry',
          code: 'truncated_transfer',
        },
      };
    }
    if (error instanceof KeyIdPresentError) {
      return {
        kind: 'dead',
        dead: {
          headline: 'This relic is malformed',
          detail: 'It sets a header field this format forbids.',
          action: 'none',
          code: 'keyid_present',
        },
      };
    }
    if (error instanceof VersionMismatchError) {
      return {
        kind: 'dead',
        dead: {
          headline: 'This relic does not match its link',
          detail:
            'The format version inside the file disagrees with the one in the ' +
            'link. The link may have been altered.',
          action: 'none',
          code: 'version_mismatch',
        },
      };
    }
    if (error instanceof ContentTooLargeError) {
      return {
        kind: 'dead',
        dead: {
          headline: 'This relic is too large to open here',
          detail:
            `It holds up to ${formatBytes(error.declaredBytes)}, past what this viewer will ` +
            'load into a browser tab.',
          action: 'none',
          code: 'too_large',
        },
      };
    }
    return {
      kind: 'dead',
      dead: {
        headline: 'This relic could not be read',
        detail: 'Its contents are not in a shape this viewer understands.',
        action: 'none',
        code: 'malformed_container',
      },
    };
  }
}

export async function loadCommentedRelics(
  deps: ViewerDeps
): Promise<readonly CommentedRelic[] | null> {
  try {
    const response = await deps.fetch(`${deps.serviceOrigin}/api/auth/relics`, {
      method: 'GET',
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('relics' in body)) {
      return null;
    }
    const rawRelics = body.relics;
    if (!Array.isArray(rawRelics)) {
      return null;
    }
    const result: CommentedRelic[] = [];
    for (const r of rawRelics) {
      if (typeof r !== 'object' || r === null) continue;
      if (!('relic_id' in r) || typeof r.relic_id !== 'string') continue;
      const title =
        'title' in r && typeof r.title === 'string' ? r.title : r.relic_id;
      const rendererClass =
        'renderer_class' in r && typeof r.renderer_class === 'string'
          ? r.renderer_class
          : 'generic';
      const version =
        'version' in r && typeof r.version === 'number' ? r.version : 1;
      const publishedAt =
        'published_at' in r && typeof r.published_at === 'string'
          ? r.published_at
          : '';
      const expiresAt =
        'expires_at' in r && typeof r.expires_at === 'string'
          ? r.expires_at
          : null;
      const lastCommentAt =
        'last_comment_at' in r && typeof r.last_comment_at === 'string'
          ? r.last_comment_at
          : '';
      result.push({
        relic_id: r.relic_id,
        title,
        renderer_class: rendererClass,
        version,
        published_at: publishedAt,
        expires_at: expiresAt,
        last_comment_at: lastCommentAt,
      });
    }
    return result;
  } catch {
    return null;
  }
}

export const AUDIO_EXTENSIONS: Record<string, true> = {
  mp3: true,
  wav: true,
  aac: true,
  ogg: true,
  flac: true,
  m4a: true,
  weba: true,
  opus: true,
};

export function isAudioMedia(mimetype: string, filename: string): boolean {
  const mime = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime.startsWith('audio/')) return true;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return AUDIO_EXTENSIONS[ext] === true;
}
