import { PRIVATE_CARD } from './card.ts';
import { privateActivityMail } from './mail.ts';
import { readableVersions, standingOf } from './private/access.ts';
/**
 * The app server.
 *
 * Two rules shape the whole router and neither is negotiable:
 *
 * 1. **The mint is never a side effect of serving `/{id}`**
 *    (`spec/service.md` section 2). That path returns a static shell with no
 *    mint, no counter increment, and no cap consumption, which keeps
 *    non-executing link fetchers off both the open counter and the download
 *    cap. Slack states plainly that it does not honor robots.txt, so the
 *    control has to be structural rather than advisory.
 * 2. **Reserved path segments beat IDs at the router**
 *    (`spec/format.md` 1.5). An issued ID shadowing `/abuse` would be
 *    launch-blocking, since the abuse intake is a go/no-go obligation.
 */

import { inflateSync } from 'node:zlib';
import {
  COMMENT_ADDRESSES_LIMIT_BYTES,
  encryptedSize,
  InvalidRelicIdError,
  isHostedService,
  isRendererClass,
  isStorableTitle,
  LOAD_EXPLANATION,
  LOAD_OPENING,
  MAX_HEADER_BYTES,
  NOSCRIPT_DETAIL,
  NOSCRIPT_TITLE,
  normalizeEmail,
  parseRelicId,
  POLICY_LINK_LABEL,
  REPORT_LINK_LABEL,
  RESERVED_SEGMENTS,
  type PasskeyDescriptorJSON,
  type RendererClass,
} from '@relic/format';
import {
  COVER_TYPES,
  type CoverKind,
  type CoverType,
  coverExtension,
  isCoverKind,
  validateCoverRaster,
} from '@relic/format/cover';
import { type AssetSource, memoryAssets, REGISTER_SW_JS } from './assets.ts';
import { COVER_ALT, cardCopy } from './card.ts';
import { assertConfig, DEFAULT_CONFIG, type RelicConfig } from './config.ts';
import {
  changeNoticeMail,
  commentNoticeMail,
  commentNotificationMail,
  MailRefusedError,
  type OutboundMail,
  passkeyAddedMail,
  replyNotificationMail,
} from './mail.ts';
import { newOccurrenceId, ProblemError, problemResponse } from './problems.ts';
import { RateLimiter, rateLimitKey } from './ratelimit.ts';
import { MemoryStorage, type ObjectStorage } from './storage.ts';
import {
  type CommentPatch,
  type DecisionRow,
  type DecisionVerdict,
  MemoryStore,
  type MintLogEntry,
  type PasskeyCredential,
  type PasskeyRecord,
  type ReasonClass,
  type RelicCover,
  type RelicRow,
  type RelicStore,
  type SessionRow,
  type Tombstone,
} from './store.ts';
import {
  parseBase64url,
  verifyAssertion,
  verifyRegistration,
  WebauthnError,
} from './webauthn.ts';
import { PURPOSE_KINDS, issueAttestNonce } from './private/attest.ts';
import {
  accessEventsFor,
  backfillWraps,
  bindCredential,
  currentIdentity,
  designateRecovery,
  identityState,
  lookupRecovery,
  ownedAndShared,
  registerIdentity,
  setRetention,
} from './private/identity.ts';
import {
  approveDevice,
  deviceContext,
  enrollDevice,
  enrollmentStatus,
  listOwnerDevices,
  revokeDevice,
} from './private/devices.ts';
import {
  logAccess,
  ownerRecord,
  publishTokenOk,
  requireRead,
} from './private/access.ts';
import { checkPrivatePublish, refusePrivatePolicy } from './private/publish.ts';
import {
  completeSeal,
  deleteRelic,
  declineRequest,
  deliverKey,
  grantAccess,
  listGrants,
  listRequests,
  privateAccessView,
  recipientsState,
  requestAccess,
  reissueUpload,
  revokeAccess,
} from './private/relic.ts';
import {
  identityPublicJson,
  liveRelic,
  privateRow,
  type PrivateEnv,
} from './private/context.ts';
import type { AttestPurpose } from '@relic/format/private';
import type { IdentityRecord } from './store.ts';
import type { ProblemCode } from './problems.ts';

const RESERVED = new Set(RESERVED_SEGMENTS);

/**
 * Outbound mail, as one method behind an interface.
 *
 * The service had no mail dependency before identity arrived, and this is
 * the whole of the new surface. Narrow on purpose: a magic link is the only
 * thing this product ever sends, tests run against a recorder rather than a
 * network, and a production deployment supplies one implementation without
 * any route knowing which.
 */
export interface BatchMailItem {
  readonly email: string;
  readonly mail: OutboundMail;
}

export interface Mailer {
  send(email: string, link: string, code?: string): Promise<void>;
  sendMail?(email: string, mail: OutboundMail): Promise<void>;
  sendBatch?(items: readonly BatchMailItem[]): Promise<void>;
}

/**
 * The default. It records nothing and sends nothing, so a deployment that
 * forgets to configure mail cannot silently leak addresses to a half-built
 * integration; sign-in simply never completes, which is loud.
 */
export const NULL_MAILER: Mailer = {
  async send(): Promise<void> {},
  async sendMail(): Promise<void> {},
  async sendBatch(): Promise<void> {},
};
let warnedPasskeyNoticeDisabled = false;

export function resetPasskeyNoticeWarningForTesting(): void {
  warnedPasskeyNoticeDisabled = false;
}

export interface AppOptions {
  readonly config?: Partial<RelicConfig>;
  readonly store?: RelicStore;
  readonly storage?: ObjectStorage;
  /** Injected so tests control time and the server never trusts a client. */
  readonly now?: () => number;
  /** Per-operator credentials for the authenticated surface under `/api`. */
  readonly operatorTokens?: ReadonlyMap<string, string>;
  /** Where the viewer shell's static files come from. */
  readonly assets?: AssetSource;
  /** Where a magic link goes. Defaults to sending nothing at all. */
  readonly mailer?: Mailer | undefined;
  readonly limiter?: RateLimiter | undefined;
  readonly addressLimiter?: RateLimiter | undefined;
}

export interface RelicApp {
  readonly config: RelicConfig;
  readonly store: RelicStore;
  readonly storage: ObjectStorage;
  readonly limiter: RateLimiter;
  readonly addressLimiter: RateLimiter;
  fetch(request: Request): Promise<Response>;
}

export function createApp(options: AppOptions = {}): RelicApp {
  const config: RelicConfig = { ...DEFAULT_CONFIG, ...options.config };
  assertConfig(config);

  const store = options.store ?? new MemoryStore();
  const storage = options.storage ?? new MemoryStorage();
  const clock = options.now ?? (() => Date.now());
  const operators = options.operatorTokens ?? new Map<string, string>();
  const assets = options.assets ?? memoryAssets({});
  const mailer = options.mailer;
  const limiter =
    options.limiter ??
    new RateLimiter({
      maxEntries: config.limiterMaxEntries,
      sweepInterval: config.limiterSweepInterval,
    });
  const addressLimiter =
    options.addressLimiter ??
    new RateLimiter({
      maxEntries: config.addressLimiterMaxEntries,
      sweepInterval: config.limiterSweepInterval,
    });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const head = segments[0];
    const ip = clientIp(request, config);
    const now = clock();

    // The homepage is a landing page, not the viewer. It used to be the shell
    // fed the literal string "Relic" as an id, so the first thing a visitor
    // saw was a relic that does not exist.
    if (segments.length === 0) return landingPage(config);

    // Reserved segments win at the router, before anything is read as an ID.
    if (head !== undefined && RESERVED.has(head)) {
      return reservedRoute(segments, request, url, ip, now);
    }

    if (segments.length === 1 && head !== undefined) {
      let decodedHead = head;
      try {
        decodedHead = decodeURIComponent(head);
      } catch {}
      // The shell only. No mint, no counter, no cap.
      return shell(config, decodedHead, store, now);
    }
    if (
      segments.length === 3 &&
      segments[1] === 'cover' &&
      head !== undefined &&
      segments[2] !== undefined &&
      !RESERVED.has(head) &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return coverRoute(head, segments[2], request, now);
    }

    return new Response('Not found', { status: 404 });
  }

  async function reservedRoute(
    segments: readonly string[],
    request: Request,
    url: URL,
    ip: string,
    now: number
  ): Promise<Response> {
    const head = segments[0];

    if (head === 'health') {
      return Response.json({ status: 'ok' });
    }

    if (head === 'robots.txt') {
      // Stops indexing by compliant crawlers. It does not stop fetching, and
      // no control in this system rests on it.
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex' },
      });
    }

    if (head === 'policy') {
      // A browser navigating here gets the markdown player. Everything else,
      // including the player's own fetch, gets the markdown itself, and `?raw`
      // is the way to the source for a browser that cannot run the player.
      const wantsPage =
        segments.length === 1 &&
        !url.searchParams.has('raw') &&
        (request.headers.get('accept') ?? '').includes('text/html');
      if (wantsPage) {
        return shell(config, {
          view: 'document',
          path: '/policy',
          title: DISCLOSURE_TITLE,
          description:
            'What Relic stores, what it can see, and what it never receives.',
        });
      }
      return new Response(disclosureStatement(config), {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          vary: 'accept',
        },
      });
    }

    // The same page as the homepage, so install copy cannot drift.
    if (head === 'install') return landingPage(config);
    if (head === 'dashboard' || head === 'dashb0ard') {
      if (segments.length === 1 && request.method === 'GET') {
        return shell(config, { view: 'dashboard' }, store, now);
      }
      if (segments.length === 1) {
        return new Response('Method not allowed', { status: 405 });
      }
      return new Response('Not found', { status: 404 });
    }

    if (head === 'abuse') {
      if (request.method === 'GET') return abuseForm(config);
      if (request.method === 'POST') return abuseSubmit(request, now);
      return new Response('Method not allowed', { status: 405 });
    }

    if (head === 'api')
      return apiRoute(segments.slice(1), request, url, ip, now);

    if (head === 'assets')
      return serveAsset(segments.slice(1).join('/'), request);
    if (head === 'manifest.webmanifest')
      return serveAsset('manifest.webmanifest', request);
    if (head === 'favicon.ico') return serveAsset('icon.svg', request);
    if (head === 'sw.js') return serveAsset('sw.js', request);
    // Served on the usercontent origin in production. One binary serves both
    // here, and the deployment routes by Host.
    if (head === 'sandbox.html') return serveSandbox(request);

    return new Response('Not found', { status: 404 });
  }

  /**
   * Gzips a text response when the client offered it.
   *
   * Everything this server sends with `no-store` now pays its full size on
   * every view, and the frame's page carries its whole dependency bundle
   * inline, because an opaque origin cannot fetch even its own assets. That
   * put the page near 190 KB, where the wire cost stops being a rounding
   * error. Nothing upstream compresses: Cloud Run does not, and the live
   * response carried no `content-encoding` before this.
   *
   * Safe here because no response this touches mixes a secret with
   * attacker-supplied input, which is the condition compression side
   * channels need. These are static build artifacts. Ciphertext is never
   * served by this process; it goes straight from the bucket to the browser.
   */
  function textResponse(
    body: Uint8Array | string,
    request: Request,
    headers: Record<string, string>
  ): Response {
    const offered = request.headers.get('accept-encoding') ?? '';
    if (!offered.toLowerCase().includes('gzip')) {
      return new Response(body as unknown as BodyInit, { headers });
    }

    // Assets are read from disk or encoded from a string literal, so the view
    // is never backed by a SharedArrayBuffer. The cast states that, since the
    // ambient Uint8Array type admits one and gzipSync does not.
    const bytes =
      typeof body === 'string' ? body : (body as Uint8Array<ArrayBuffer>);

    return new Response(Bun.gzipSync(bytes) as unknown as BodyInit, {
      headers: {
        ...headers,
        'content-encoding': 'gzip',
        // Any cache keying this response must key the encoding with it.
        vary: 'accept-encoding',
      },
    });
  }

  async function serveAsset(name: string, request: Request): Promise<Response> {
    if (name === 'register-sw.js') {
      return textResponse(REGISTER_SW_JS, request, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
    }

    const asset = await assets.get(name);
    if (asset === undefined) return new Response('Not found', { status: 404 });

    if (name.endsWith('.png')) {
      return new Response(asset.body as unknown as BodyInit, {
        headers: {
          'content-type': asset.contentType,
          'cache-control': 'public, max-age=31536000, immutable',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return textResponse(asset.body, request, {
      'content-type': asset.contentType,
      // The shell and its assets are all no-store. The build emits stable
      // filenames, so an HTTP cache would serve the previous deploy's code
      // against the new server for its whole TTL; measured in the field as
      // a shipped fix that did not run for up to an hour. Repeat visits are
      // cached by the service worker, which revalidates per navigation.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...(name === 'model-parse-worker.js'
        ? {
            'content-security-policy':
              "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'",
          }
        : {}),
    });
  }

  /**
   * The usercontent origin's page.
   *
   * `frame-ancestors` is the half of the boundary this response owns: only
   * the service origin may frame it, so the page cannot be embedded by a
   * third party to borrow the rendering path.
   *
   * The other half is that the frame cannot reach the network at all. The
   * iframe sandbox omits `allow-same-origin`, so the document runs in an
   * opaque origin where `'self'` matches nothing, which makes "only our
   * host" mean "only what is inlined in this response": the frame's own
   * scripts and the bundle it carries. Every fetch directive is closed.
   * `blob:` remains in `script-src` for one reason: the JSX mount imports a
   * module built from posted code, and that import is local.
   *
   * Measured against a collector server under this policy: `fetch`,
   * `<img>`, `sendBeacon`, `WebSocket`, and `EventSource` produced zero
   * arrivals. `sendBeacon` returned `true` while delivering nothing, so its
   * return value is not evidence of delivery. A form with `target=_blank`
   * submitted and never arrived. `window.open` was blocked in the probe,
   * but no user gesture preceded it, so CSP is not what stopped it; popups
   * are closed by the sandbox attribute in the viewer.
   *
   * WebRTC egress: Chrome ignores CSP `webrtc 'block'`. Runtime containment
   * in the sandboxed frame neutralizes `RTCPeerConnection` constructors across
   * the global prototype chain and blocks nested frame creation so author code
   * cannot reach an unpatched realm. This is a tested deny-list in the frame's
   * JavaScript realm rather than an architectural impossibility, serving as
   * defense in depth alongside the opaque sandbox. Future browser APIs or parser
   * entry points could reopen egress channels before we patch them. Legitimate
   * relics cannot use nested frames or workers.
   */
  async function serveSandbox(request: Request): Promise<Response> {
    const asset = await assets.get('sandbox.html');
    if (asset === undefined) return new Response('Not found', { status: 404 });

    return textResponse(asset.body, request, {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'cache-control': 'no-store',
      // The directive list and its order are the contract; the test suite
      // asserts this exact string so a loosening fails instead of shipping.
      'content-security-policy': [
        "default-src 'none'",
        // 'unsafe-inline' is the document.write path both render routes
        // use; blob: is the module the JSX mount builds from posted code.
        // No scheme source remains, so no CDN or remote module can load.
        "script-src 'unsafe-inline' blob:",
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
        'media-src data: blob:',
        "worker-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${new URL(config.serviceOrigin).origin}`,
        "webrtc 'block'",
      ].join('; '),
    });
  }

  async function apiRoute(
    rest: readonly string[],
    request: Request,
    url: URL,
    ip: string,
    now: number
  ): Promise<Response> {
    const [first, second, third, fourth] = rest;
    const privateResponse = await privateApi(rest, request, url, ip, now);
    if (privateResponse !== undefined) return privateResponse;

    if (first === 'challenge' && request.method === 'POST') {
      return challenge(ip, now);
    }
    if (first === 'grant' && request.method === 'POST') {
      return guarded(() => grant(request, ip, now));
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'mint' &&
      request.method === 'POST'
    ) {
      return mint(second, request, ip, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'complete' &&
      request.method === 'POST'
    ) {
      return complete(second, now, ip);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'republish' &&
      request.method === 'POST'
    ) {
      return republishRoute(second, request, ip, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'cover' &&
      fourth === undefined &&
      request.method === 'POST'
    ) {
      return uploadCover(second, request, ip, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === undefined &&
      request.method === 'DELETE'
    ) {
      return operatorDelete(second, request, url, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'share' &&
      fourth === undefined &&
      request.method === 'POST'
    ) {
      return guarded(() => share(second, request, ip, now));
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'unsubscribe' &&
      fourth === undefined &&
      (request.method === 'GET' ||
        request.method === 'HEAD' ||
        request.method === 'POST')
    ) {
      return unsubscribe(second, request, url, ip, now);
    }

    // Comments. The read is deliberately unauthenticated: anybody holding
    // the link can already fetch and decrypt the content, and every body
    // here is ciphertext this server cannot open, so a gate would cost
    // reach without buying secrecy.
    if (first === 'relics' && second !== undefined && third === 'comments') {
      if (fourth !== undefined) {
        const refusal = await privateCommentRefusal(
          second,
          fourth,
          request,
          now
        );
        if (refusal !== undefined) return refusal;
      }
      if (fourth === undefined && request.method === 'GET') {
        return listComments(second, request, now);
      }
      if (fourth === undefined && request.method === 'POST') {
        return postComment(second, request, now);
      }
      if (fourth !== undefined && request.method === 'DELETE') {
        return deleteComment(second, fourth, request, now);
      }
      if (fourth !== undefined && request.method === 'PATCH') {
        return patchComment(second, fourth, request, now);
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // Magic-link sign-in. The only identity in the product, and it exists
    // so a comment can be attributed to somebody reachable.
    if (first === 'auth' && second === 'request' && request.method === 'POST') {
      return authRequest(request, ip, now);
    }
    if (first === 'auth' && second === 'code' && request.method === 'POST') {
      return authCode(request, ip, now);
    }
    if (first === 'auth' && second === 'callback' && request.method === 'GET') {
      return authCallback(url, now);
    }
    if (first === 'auth' && second === 'session' && request.method === 'GET') {
      return authSession(request, now);
    }
    if (first === 'auth' && second === 'relics') {
      if (third === undefined && request.method === 'GET') {
        return authRelics(request, now);
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // Decisions:
    // - relics/{id}/decisions: POST record; POST .../options; POST .../list; any other method or path returns 405.
    if (first === 'relics' && second !== undefined && third === 'decisions') {
      if (fourth === undefined && request.method === 'POST') {
        return guarded(() => postDecision(second, request, ip, now));
      }
      if (
        fourth === 'options' &&
        rest[4] === undefined &&
        request.method === 'POST'
      ) {
        return guarded(() => postDecisionOptions(second, request, ip, now));
      }
      if (
        fourth === 'list' &&
        rest[4] === undefined &&
        request.method === 'POST'
      ) {
        return guarded(() => listDecisions(second, request, ip, now));
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // Passkeys:
    // - auth/passkeys: POST register; POST .../options; otherwise 405.
    if (first === 'auth' && second === 'passkeys') {
      if (third === undefined && request.method === 'POST') {
        return postPasskey(request, ip, now);
      }
      if (
        third === 'options' &&
        fourth === undefined &&
        request.method === 'POST'
      ) {
        return postPasskeyOptions(request, ip, now);
      }
      if (
        third === 'sign-in' &&
        fourth === undefined &&
        request.method === 'POST'
      ) {
        return postPasskeySignIn(request, ip, now);
      }
      if (
        third === 'sign-in' &&
        fourth === 'options' &&
        rest[4] === undefined &&
        request.method === 'POST'
      ) {
        return postPasskeySignInOptions(request, ip, now);
      }
      return new Response('Method not allowed', { status: 405 });
    }

    return new Response('Not found', { status: 404 });
  }

  // --- private shares -----------------------------------------------------

  /** The private-share environment, for one request's clock. */
  function privateEnv(now: number): PrivateEnv {
    return {
      store,
      storage,
      config,
      now,
      sendMail: async (to, mail) => {
        if (mailer?.sendMail !== undefined) await mailer.sendMail(to, mail);
      },
      limit: (scope, key, budget) => {
        const verdict = limiter.check(rateLimitKey(scope, key), budget, now);
        if (!verdict.allowed) {
          throw new ProblemError('private_rate_limited', {
            retry_after_seconds: verdict.retryAfterSeconds,
          });
        }
      },
      objectKey,
      assertPasskey: (record, credential, challenge, at) =>
        verifyStoredAssertion(record, credential, challenge, at),
    };
  }

  async function sessionOf(
    request: Request,
    now: number
  ): Promise<SessionRow | undefined> {
    const token = sessionCookie(request);
    if (token === undefined) return undefined;
    const session = await store.getSession(await sha256Hex(token));
    return session !== undefined && session.expiresAt > now
      ? session
      : undefined;
  }

  /** A JSON object body, under the route's own malformed-request code. */
  async function privateBody(
    request: Request,
    code: ProblemCode
  ): Promise<Record<string, unknown>> {
    const type = request.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      throw new ProblemError(code);
    }
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new ProblemError(code);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ProblemError(code);
    }
    return parsed as Record<string, unknown>;
  }

  /** Turns a private-share refusal into its problem response. */
  async function guarded(run: () => Promise<Response>): Promise<Response> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProblemError)
        return refuse(error.code, error.options);
      throw error;
    }
  }

  /**
   * Attestation purposes that act on one relic and need its owner. Device and
   * recovery purposes are identity-scoped: they need the signed-in identity only.
   */
  const OWNER_PURPOSES: ReadonlySet<string> = new Set([
    'grant',
    'revoke',
    'delete',
  ]);

  /**
   * Every private-share route (plan 4.7). Returns undefined for a path it
   * does not own, so the public routes answer as before.
   */
  async function privateApi(
    rest: readonly string[],
    request: Request,
    url: URL,
    ip: string,
    now: number
  ): Promise<Response | undefined> {
    const [first, second, third, fourth, fifth] = rest;
    const post = request.method === 'POST';
    const get = request.method === 'GET';
    const env = privateEnv(now);

    if (first === 'attest' && second === 'nonce' && rest.length === 2 && post) {
      return guarded(async () => {
        const session = await sessionOf(request, now);
        if (session === undefined) return refuse('sign_in_required');
        const body = await privateBody(request, 'invalid_statement');
        const purpose = body['purpose'];
        if (typeof purpose !== 'string' || !(purpose in PURPOSE_KINDS)) {
          throw new ProblemError('invalid_statement', {
            statement_check: 'purpose',
          });
        }
        env.limit('attest', session.email, config.privateRateLimit);
        const email = normalizeEmail(session.email);
        const relicId =
          typeof body['relic_id'] === 'string' ? body['relic_id'] : undefined;
        if (purpose !== 'identity_register') {
          const identity = await currentIdentity(env, email);
          if (identity === undefined) return refuse('identity_required');
          if (OWNER_PURPOSES.has(purpose)) {
            if (relicId === undefined) {
              throw new ProblemError('invalid_statement', {
                statement_check: 'relic',
              });
            }
            const owner = await ownerRecord(
              env,
              privateRow(await liveRelic(env, relicId))
            );
            if (owner.identityId !== identity.identityId)
              return refuse('owner_required');
          }
        }
        return Response.json(
          await issueAttestNonce(env, {
            email,
            purpose: purpose as AttestPurpose,
            passkeys: await store.getPasskeys(email),
            relicId,
            credentialId:
              typeof body['credential_id'] === 'string'
                ? body['credential_id']
                : undefined,
          })
        );
      });
    }

    if (first === 'identity') {
      const matched =
        (second === undefined && (get || post)) ||
        second === 'credentials' ||
        second === 'settings' ||
        second === 'recovery' ||
        second === 'backfill' ||
        second === 'relics' ||
        second === 'access-log';
      if (!matched) return undefined;
      return guarded(async () => {
        const session = await sessionOf(request, now);
        if (session === undefined) return refuse('sign_in_required');
        const email = normalizeEmail(session.email);
        if (second === undefined && get) {
          return Response.json(
            await identityState(env, email, await store.getPasskeys(email))
          );
        }
        if (second === undefined && post) {
          const body = await privateBody(request, 'invalid_identity');
          env.limit('identity-write', email, config.privateRateLimit);
          const record = await registerIdentity(env, {
            email,
            session,
            passkeys: await store.getPasskeys(email),
            bundle: body['encrypted_bundle'],
            replace: body['replace'] === true,
            attestation: body['attestation'],
          });
          return Response.json(
            { identity: identityPublicJson(record) },
            { status: 201 }
          );
        }
        if (second === 'credentials' && post) {
          const body = await privateBody(request, 'invalid_identity');
          env.limit('identity-write', email, config.privateRateLimit);
          const binding = await bindCredential(env, {
            email,
            passkeys: await store.getPasskeys(email),
            bundle: body['encrypted_bundle'],
            attestation: body['attestation'],
          });
          return Response.json(
            { credential_id: binding.credentialId },
            { status: 201 }
          );
        }
        if (second === 'settings' && post) {
          const body = await privateBody(request, 'invalid_statement');
          const days = await setRetention(env, {
            email,
            passkeys: await store.getPasskeys(email),
            attestation: body['attestation'],
          });
          return Response.json({ access_log_retention_days: days });
        }
        if (second === 'recovery' && third === 'lookup' && post) {
          const body = await privateBody(request, 'invalid_identity');
          if (typeof body['email'] !== 'string') {
            throw new ProblemError('invalid_identity', {
              identity_check: 'email',
            });
          }
          return Response.json({
            party: await lookupRecovery(env, body['email'], email),
          });
        }
        if (second === 'recovery' && third === undefined && post) {
          const body = await privateBody(request, 'invalid_statement');
          return Response.json({
            recovery: await designateRecovery(env, {
              email,
              passkeys: await store.getPasskeys(email),
              attestation: body['attestation'],
            }),
          });
        }
        if (second === 'backfill' && post) {
          const body = await privateBody(request, 'invalid_wrap');
          return Response.json(
            await backfillWraps(env, { email, wraps: body['wraps'] })
          );
        }
        if (second === 'relics' && get) {
          const identity = await currentIdentity(env, email);
          if (identity === undefined) {
            return Response.json({ owned: [], shared_with_me: [] });
          }
          const coverage = url.searchParams.get('coverage') === '1';
          return Response.json(await ownedAndShared(env, identity, coverage));
        }
        if (second === 'access-log' && get) {
          const identity = await currentIdentity(env, email);
          if (identity === undefined) return refuse('identity_required');
          return Response.json({
            events: await accessEventsFor(
              env,
              identity,
              url.searchParams.get('relic_id') ?? undefined
            ),
          });
        }
        return new Response('Method not allowed', { status: 405 });
      });
    }

    if (first === 'devices') {
      return guarded(async () => {
        if (second === 'enrollments' && third === undefined && post) {
          env.limit('device-enroll', ip, config.deviceEnrollmentRateLimit);
          const body = await privateBody(request, 'invalid_device');
          return Response.json(await enrollDevice(env, body), { status: 201 });
        }
        if (
          second === 'enrollments' &&
          third !== undefined &&
          fourth === undefined &&
          get
        ) {
          return Response.json(await enrollmentStatus(env, third));
        }
        if (second === 'enrollments' && fourth === 'approve' && post) {
          const session = await sessionOf(request, now);
          if (session === undefined) return refuse('sign_in_required');
          const email = normalizeEmail(session.email);
          const body = await privateBody(request, 'invalid_statement');
          const device = await approveDevice(env, {
            email,
            enrollmentId: third ?? '',
            passkeys: await store.getPasskeys(email),
            attestation: body['attestation'],
          });
          return Response.json({ device });
        }
        if (second === undefined && get) {
          const session = await sessionOf(request, now);
          if (session === undefined) return refuse('sign_in_required');
          return Response.json({
            devices: await listOwnerDevices(env, normalizeEmail(session.email)),
          });
        }
        if (third === 'revoke' && fourth === undefined && post) {
          const session = await sessionOf(request, now);
          if (session === undefined) return refuse('sign_in_required');
          const email = normalizeEmail(session.email);
          const body = await privateBody(request, 'invalid_statement');
          const device = await revokeDevice(env, {
            email,
            deviceId: second ?? '',
            passkeys: await store.getPasskeys(email),
            attestation: body['attestation'],
          });
          return Response.json({ device });
        }
        if (third === 'context' && post) {
          const body = await privateBody(request, 'invalid_device');
          return Response.json(
            await deviceContext(env, {
              deviceId: second ?? '',
              path: url.pathname,
              body,
              auth: body['device_auth'],
            })
          );
        }
        return new Response('Method not allowed', { status: 405 });
      });
    }

    if (first === 'relics' && second !== undefined && third !== undefined) {
      const relicId = second;
      return guarded(async () => {
        if (third === 'access' && fourth === undefined && get) {
          const row = await liveRelic(env, relicId);
          const session = await sessionOf(request, now);
          if (row.access !== 'private') {
            return Response.json({
              access: 'public',
              relic_id: relicId,
              owned_by_me:
                session !== undefined &&
                row.ownerEmail !== undefined &&
                normalizeEmail(session.email) ===
                  normalizeEmail(row.ownerEmail),
            });
          }
          if (session === undefined) return refuse('sign_in_required');
          return Response.json(
            await privateAccessView(env, relicId, session.email)
          );
        }
        if (third === 'complete' && fourth === undefined && post) {
          const row = await store.getRelic(relicId);
          if (row?.access === 'private')
            return completePrivate(relicId, request, now);
          return undefined as never;
        }
        if (third === 'cover' && fourth === undefined && post) {
          const row = await store.getRelic(relicId);
          if (row?.access === 'private') {
            return refuse('private_policy_violation', {
              policy_check: 'cover',
            });
          }
          return undefined as never;
        }
        if (third === 'comments' && fourth === 'list' && post) {
          const body = await privateBody(request, 'invalid_comment');
          const row = await liveRelic(env, relicId);
          if (!(await publishTokenOk(row, body['publish_token']))) {
            return refuse('invalid_publish_token');
          }
          return listComments(relicId, request, now, body['publish_token']);
        }
        const session = await sessionOf(request, now);
        if (third === 'requests' && fourth === undefined && post) {
          if (session === undefined) return refuse('sign_in_required');
          const body = await privateBody(request, 'invalid_statement');
          const email = normalizeEmail(session.email);
          const result = await requestAccess(env, {
            email,
            relicId,
            passkeys: await store.getPasskeys(email),
            attestation: body['attestation'],
          });
          return Response.json(
            { status: 'pending', requested_at: result.requested_at },
            { status: result.created ? 201 : 200 }
          );
        }
        if (third === 'requests' && fourth === undefined && get) {
          if (session === undefined) return refuse('sign_in_required');
          return Response.json({
            requests: await listRequests(
              env,
              normalizeEmail(session.email),
              relicId
            ),
          });
        }
        if (
          third === 'requests' &&
          fourth !== undefined &&
          fifth === 'decline' &&
          post
        ) {
          if (session === undefined) return refuse('sign_in_required');
          await declineRequest(
            env,
            normalizeEmail(session.email),
            relicId,
            fourth
          );
          return Response.json({});
        }
        if (third === 'grants' && fourth === undefined && post) {
          if (session === undefined) return refuse('sign_in_required');
          const body = await privateBody(request, 'invalid_wrap');
          const email = normalizeEmail(session.email);
          const result = await grantAccess(env, {
            email,
            relicId,
            passkeys: await store.getPasskeys(email),
            attestation: body['attestation'],
            wraps: body['wraps'],
          });
          return Response.json({ grant: result.grant }, { status: 201 });
        }
        if (third === 'grants' && fourth === undefined && get) {
          if (session === undefined) return refuse('sign_in_required');
          return Response.json({
            grants: await listGrants(
              env,
              normalizeEmail(session.email),
              relicId
            ),
          });
        }
        if (third === 'revocations' && fourth === undefined && post) {
          if (session === undefined) return refuse('sign_in_required');
          const body = await privateBody(request, 'invalid_statement');
          const email = normalizeEmail(session.email);
          return Response.json(
            await revokeAccess(env, {
              email,
              relicId,
              passkeys: await store.getPasskeys(email),
              attestation: body['attestation'],
              rendererClass: body['renderer_class'],
              declaredSizeBytes: body['declared_size_bytes'],
              declaredCiphertextBytes: body['declared_ciphertext_bytes'],
            })
          );
        }
        if (third === 'recipients' && fourth === undefined && post) {
          const body = await privateBody(
            request,
            'invalid_publish_token'
          ).catch(() => ({}) as Record<string, unknown>);
          return Response.json(
            await recipientsState(env, relicId, {
              publishToken: body['publish_token'],
              email:
                session === undefined
                  ? undefined
                  : normalizeEmail(session.email),
            })
          );
        }
        if (
          third === 'versions' &&
          fourth !== undefined &&
          fifth === 'key' &&
          post
        ) {
          const version = Number(fourth);
          const body = await privateBody(request, 'invalid_wrap').catch(
            () => ({}) as Record<string, unknown>
          );
          if (typeof body['publish_token'] === 'string') {
            return Response.json(
              await deliverKey(env, relicId, version, {
                kind: 'publish',
                token: body['publish_token'],
                recipientKeyId: body['recipient_key_id'],
              })
            );
          }
          if (session === undefined) return refuse('sign_in_required');
          return Response.json(
            await deliverKey(env, relicId, version, {
              kind: 'session',
              email: normalizeEmail(session.email),
            })
          );
        }
        if (
          third === 'versions' &&
          fourth !== undefined &&
          fifth === 'upload-grant' &&
          post
        ) {
          if (session === undefined) return refuse('sign_in_required');
          return Response.json(
            await reissueUpload(
              env,
              normalizeEmail(session.email),
              relicId,
              Number(fourth)
            )
          );
        }
        if (third === 'delete' && fourth === undefined && post) {
          if (session === undefined) return refuse('sign_in_required');
          const body = await privateBody(request, 'invalid_statement');
          const email = normalizeEmail(session.email);
          return Response.json(
            await deleteRelic(env, {
              email,
              relicId,
              passkeys: await store.getPasskeys(email),
              attestation: body['attestation'],
            })
          );
        }
        if (third === 'owner' && fourth === undefined && post) {
          const row = await liveRelic(env, relicId);
          if (row.ownerIdentityId !== undefined) return refuse('owner_exists');
          return refuse('private_policy_violation', {
            policy_check: 'owner_email',
          });
        }
        return undefined as never;
      }).then((response) => response ?? undefined);
    }

    return undefined;
  }

  /** The mint for a private relic: wrap-gated, with no raw-IP mint log (plan 4.18 item 5). */
  async function mintPrivate(
    relicId: string,
    row: RelicRow,
    body: Record<string, unknown>,
    version: number,
    request: Request,
    now: number
  ): Promise<Response> {
    return guarded(async () => {
      const env = privateEnv(now);
      if (row.expiresAt !== undefined && now >= row.expiresAt) {
        return refuse('relic_expired', { relic_id: relicId });
      }
      let actor: IdentityRecord | undefined;
      if (typeof body['publish_token'] === 'string') {
        if (!(await publishTokenOk(row, body['publish_token']))) {
          return refuse('invalid_publish_token');
        }
      } else {
        const session = await sessionOf(request, now);
        if (session === undefined) {
          return refuse('private_access_denied', { relic_id: relicId });
        }
        actor = await currentIdentity(env, session.email);
        await requireRead(
          env,
          row,
          await ownerRecord(env, row),
          actor,
          version
        );
      }
      const object = await storage.stat(objectKey(relicId, version));
      if (object === undefined) {
        return refuse('relic_not_yet_published', {
          relic_id: relicId,
          retry_after_seconds: 5,
        });
      }
      if (row.mintsUsed >= config.downloadCap) {
        return refuse('download_cap_exhausted', {
          relic_id: relicId,
          download_cap: config.downloadCap,
        });
      }
      const validity =
        row.expiresAt === undefined
          ? config.urlValiditySeconds
          : Math.min(
              config.urlValiditySeconds,
              Math.floor((row.expiresAt - now) / 1000)
            );
      if (validity < config.minViableValiditySeconds) {
        return refuse('relic_expired', { relic_id: relicId });
      }
      const signed = await storage.signDownload(
        objectKey(relicId, version),
        validity,
        now
      );
      const capRemaining =
        config.downloadCap - (await store.consumeMint(relicId));
      if (actor !== undefined && row.ownerIdentityId !== undefined) {
        await logAccess(env, row.ownerIdentityId, relicId, 'wrap_fetch', {
          version,
          actorIdentityId: actor.identityId,
          subjectIdentityId: actor.identityId,
        });
      }
      return Response.json(
        {
          url: signed.url,
          url_expires_at: iso(signed.expiresAt),
          relic_expires_at: relicExpiryIso(row.expiresAt),
          object_length: object.length,
          object_crc32c: object.crc32c,
          mints_remaining: capRemaining,
          version,
          current_version: row.version,
        },
        { headers: { 'referrer-policy': 'no-referrer' } }
      );
    });
  }

  /** A private seal (plan 4.12): the digest is the stored object's, never the body's. */
  async function completePrivate(
    relicId: string,
    request: Request,
    now: number
  ): Promise<Response> {
    return guarded(async () => {
      const env = privateEnv(now);
      const body = await privateBody(request, 'invalid_seal');
      const row = await liveRelic(env, relicId);
      const object = await storage.stat(objectKey(relicId, row.version));
      const digest = await storage.digest(objectKey(relicId, row.version));
      if (object === undefined || digest === undefined) {
        return refuse('relic_not_yet_published', {
          relic_id: relicId,
          retry_after_seconds: 5,
        });
      }
      const result = await completeSeal(env, {
        relicId,
        seal: body['seal'],
        wraps: body['wraps'],
        publishToken: body['publish_token'],
        objectLength: object.length,
        objectCrc32c: object.crc32c,
        digest,
      });
      // Decision 7: the ciphertext erases one day after the relic expires. The
      // object exists once it is sealed, so this is the first point it can be set.
      if (row.expiresAt !== undefined) {
        await storage.setCustomTime(
          objectKey(relicId, result.version),
          row.expiresAt
        );
      }
      return Response.json({
        relic_id: relicId,
        version: result.version,
        version_digest: result.digest,
        object_length: object.length,
        object_crc32c: object.crc32c,
        relic_expires_at: relicExpiryIso(row.expiresAt),
        access: 'private',
        access_epoch: result.access_epoch,
        owner_epoch: result.owner_epoch,
        sealed_version: result.version,
      });
    });
  }

  // --- publish path -------------------------------------------------------

  /**
   * The challenge returns the cap before a grant is requested, so a client can
   * refuse locally with the server's own number rather than a compiled-in
   * constant that goes stale.
   */
  async function challenge(ip: string, now: number): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }
    const verdict = limiter.check(
      rateLimitKey('publish', ip),
      config.publishRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('publish_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    const nonce = await store.issueChallenge(ip, now);
    return Response.json({
      challenge_nonce: nonce,
      size_limit_bytes: config.plaintextCapBytes,
      size_basis: 'plaintext',
      disclosure_url: `${config.serviceOrigin}/policy`,
      report_url: `${config.serviceOrigin}/abuse`,
      challenge_expires_at: iso(now + config.challengeTtlSeconds * 1000),
      private_shares: {
        default_ttl_days: config.privateDefaultTtlDays,
        max_ttl_days: config.privateMaxTtlDays,
      },
    });
  }

  async function grant(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }

    const verdict = limiter.check(
      rateLimitKey('publish', ip),
      config.publishRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('publish_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    const body = (await readJson(request)) as Record<string, unknown>;

    const nonce = body['challenge_nonce'];
    if (typeof nonce !== 'string') {
      return refuse('invalid_challenge_nonce');
    }
    const live = await store.consumeChallenge(
      nonce,
      now,
      config.challengeTtlSeconds
    );
    if (!live) return refuse('invalid_challenge_nonce');

    // The client generates the ID before requesting a grant, so the server
    // validates rather than issues.
    let relicId: string;
    try {
      relicId = parseRelicId(String(body['relic_id'] ?? ''));
    } catch (error) {
      const failure =
        error instanceof InvalidRelicIdError ? error.failure : 'alphabet';
      return refuse('invalid_relic_id', { id_validation_failure: failure });
    }

    const rendererClass = body['renderer_class'];
    const publishingClient = body['publishing_client'];
    if (
      typeof rendererClass !== 'string' ||
      !isRendererClass(rendererClass) ||
      typeof publishingClient !== 'string' ||
      publishingClient.length === 0 ||
      publishingClient.length > 128
    ) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }
    const access = body['access'];
    if (access !== undefined && access !== 'public' && access !== 'private') {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }
    const isPrivate = access === 'private';
    let privateOwner: IdentityRecord | undefined;
    if (isPrivate) refusePrivatePolicy(body);

    let title: string | undefined;
    if ('title' in body && body['title'] !== undefined) {
      if (typeof body['title'] !== 'string') {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
      const trimmed = body['title'].trim();
      if (trimmed.length === 0) {
        title = undefined;
      } else if (!isStorableTitle(trimmed)) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      } else {
        title = trimmed;
      }
    }
    const rawOwner = body['owner_email'] ?? body['owner'];
    let ownerEmail: string | undefined;
    if (rawOwner !== undefined && rawOwner !== null) {
      if (typeof rawOwner !== 'string' || !looksLikeEmail(rawOwner.trim())) {
        return refuse('invalid_publish_metadata', {
          relic_id: relicId,
          detail: 'Invalid owner notification address.',
        });
      }
      const normalizedOwner = rawOwner.trim();
      const verified = await store.hasVerifiedIdentity(normalizedOwner);
      if (!verified) {
        return refuse('invalid_publish_metadata', {
          relic_id: relicId,
          detail:
            'Owner notification address has no verified identity with the service. Sign in once to verify your address.',
        });
      }
      ownerEmail = normalizedOwner;
    }

    let shareVerifier: string | undefined;
    if (
      'share_verifier' in body &&
      body['share_verifier'] !== undefined &&
      body['share_verifier'] !== null
    ) {
      const rawVerifier = body['share_verifier'];
      if (
        typeof rawVerifier !== 'string' ||
        !/^[0-9a-f]{64}$/.test(rawVerifier)
      ) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
      shareVerifier = rawVerifier;
    }

    const declared = Number(body['declared_size_bytes']);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }
    if (declared > config.plaintextCapBytes) {
      return refuse('size_over_cap', {
        relic_id: relicId,
        size_limit_bytes: config.plaintextCapBytes,
        declared_size_bytes: declared,
        size_basis: 'plaintext',
      });
    }

    // A lifetime is the publisher's choice, not the service's. Absent or
    // null means the relic never expires. Anything that is not a safe
    // integer of whole days inside the ceiling is a malformed ask, refused
    // with the rest of the bad metadata rather than silently defaulted.
    const ttlDays = body['ttl_days'];
    let expiresAt: number | undefined;
    if (!isPrivate && ttlDays !== undefined && ttlDays !== null) {
      if (
        typeof ttlDays !== 'number' ||
        !Number.isSafeInteger(ttlDays) ||
        ttlDays < 1 ||
        ttlDays > config.maxTtlDays
      ) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
      expiresAt = now + ttlDays * 86_400 * 1000;
    }

    // Never overwrite. A collision is astronomical bad luck or a broken RNG,
    // and both should fail loudly.
    if (
      (await store.getRelic(relicId)) !== undefined ||
      (await store.getTombstone(relicId)) !== undefined
    ) {
      return refuse('relic_id_collision', { relic_id: relicId });
    }

    // The grant signs the object's exact byte length, so the upload has to be
    // precisely that size or the signature fails. That is stronger than a cap
    // and it costs nothing extra, because for non-empty content the ciphertext
    // length is a pure function of the plaintext length: record 0 is always
    // padded to a full record, so the envelope header's size drops out.
    //
    // The client sends what it computed and the server checks it against its
    // own arithmetic rather than trusting it. A disagreement means the two
    // ends have drifted on the format, which is caught here loudly instead of
    // producing an object nobody can open.
    const declaredCiphertext = Number(body['declared_ciphertext_bytes']);
    if (!Number.isSafeInteger(declaredCiphertext) || declaredCiphertext <= 0) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }
    if (declaredCiphertext > config.ciphertextCapBytes) {
      return refuse('size_over_cap', {
        relic_id: relicId,
        size_limit_bytes: config.plaintextCapBytes,
        declared_size_bytes: declared,
        size_basis: 'plaintext',
      });
    }
    if (declared > 0) {
      // Exact for non-empty content.
      if (declaredCiphertext !== encryptedSize(declared)) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
    } else if (
      declaredCiphertext > encryptedSize(0, undefined, MAX_HEADER_BYTES)
    ) {
      // Zero-byte content is the one case where the envelope header's size is
      // visible in the object length, so it is bounded rather than pinned.
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }

    // The publish token is the relic's one credential: possession of it is
    // the only way to ever republish this id. It is minted here, returned
    // exactly once below, and stored only as a hash, so the store's JSON
    // documents can never leak a replayable bearer token.
    // A private relic takes its lifetime and owner from the signing device.
    if (isPrivate) {
      const verdict = await checkPrivatePublish(privateEnv(now), {
        body,
        relicId,
        declaredSizeBytes: declared,
      });
      privateOwner = verdict.owner;
      expiresAt = verdict.expiresAt;
    }
    const publishToken = mintPublishToken();

    await store.putRelic({
      id: relicId,
      publishIp: ip,
      grantedAt: now,
      expiresAt,
      rendererClass: rendererClass as RendererClass,
      publishingClient,
      declaredSizeBytes: declared,
      version: 1,
      publishTokenHash: await sha256Hex(publishToken),
      mintsUsed: 0,
      title,
      ownerEmail,
      shareVerifier,
      ...(isPrivate
        ? {
            access: 'private' as const,
            ownerIdentityId: privateOwner?.identityId,
            accessEpoch: 0,
          }
        : {}),
    });
    if (privateOwner !== undefined) {
      await store.putOwnedRelic({
        relicId,
        ownerIdentityId: privateOwner.identityId,
        access: 'private',
        at: now,
      });
    }

    const upload = await storage.signUpload(
      objectKey(relicId, 1),
      declaredCiphertext,
      config.uploadUrlValiditySeconds,
      now
    );

    return Response.json({
      relic_id: relicId,
      // The only time the token ever appears. A client that loses it can
      // never republish; the server cannot recover it by construction.
      publish_token: publishToken,
      upload_url: upload.url,
      upload_method: upload.method,
      upload_headers: upload.headers,
      upload_expires_at: iso(upload.expiresAt),
      relic_expires_at: relicExpiryIso(expiresAt),
      report_url: `${config.serviceOrigin}/abuse`,
      disclosure_url: `${config.serviceOrigin}/policy`,
      ...(isPrivate
        ? {
            access: 'private',
            access_epoch: 0,
            owner_epoch: privateOwner?.recipientsEpoch,
          }
        : {}),
    });
  }

  /**
   * A republish to a private relic (plan 4.7, 4.13): the publish token is
   * required, a title or share verifier is refused, and the response names the
   * access mode and both epochs. Public relics go straight to republish.
   */
  async function republishRoute(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const row = await store.getRelic(rawId);
    if (row?.access !== 'private') return republish(rawId, request, ip, now);
    let parsed: Record<string, unknown>;
    try {
      parsed = (await request.clone().json()) as Record<string, unknown>;
    } catch {
      return refuse('invalid_publish_token');
    }
    const title = parsed['title'];
    if (
      (typeof title === 'string' && title.trim().length > 0) ||
      (title !== undefined && title !== null && typeof title !== 'string')
    ) {
      return refuse('private_policy_violation', { policy_check: 'title' });
    }
    if (
      parsed['share_verifier'] !== undefined &&
      parsed['share_verifier'] !== null
    ) {
      return refuse('private_policy_violation', {
        policy_check: 'share_verifier',
      });
    }
    if (!(await publishTokenOk(row, parsed['publish_token']))) {
      return refuse('invalid_publish_token');
    }
    const response = await republish(rawId, request, ip, now);
    if (!response.ok) return response;
    const owner = await ownerRecord(privateEnv(now), row);
    const opened = (await store.getRelic(rawId)) ?? row;
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({
      ...body,
      access: 'private',
      access_epoch: opened.accessEpoch ?? 0,
      owner_epoch: owner.recipientsEpoch,
    });
  }

  /**
   * A republish: the same relic id, new bytes, authorized by the publish
   * token rather than by a fresh grant.
   *
   * The token check is a hash comparison, and the comparison is constant
   * time, because a timing side channel on the one bearer credential this
   * surface has would be the whole ballgame for a brute force.
   *
   * The takedown is consulted before the token is even hashed. A tombstoned
   * id refuses forever whatever credential is presented, so no amount of
   * token theft or brute force undoes a removal. That ordering is the abuse
   * control; the reverse order would make it a suggestion.
   *
   * The new version's object lands beside the old one, which stays in place
   * until the publish completes: a republish in flight must not be able to
   * destroy the only servable bytes, and a delete arriving mid-upload still
   * finds every version to hash and remove.
   */
  async function republish(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }

    // A republish is a publish. The same per-IP budget covers both, so a
    // holder guessing at tokens cannot outrun the publish limiter.
    const verdict = limiter.check(
      rateLimitKey('publish', ip),
      config.publishRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('publish_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    const tombstone = await store.getTombstone(relicId);
    if (tombstone !== undefined) {
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    const body = (await readJson(request)) as Record<string, unknown>;

    const presented = body['publish_token'];
    if (typeof presented !== 'string') {
      return refuse('invalid_publish_token', { relic_id: relicId });
    }
    const presentedHash = await sha256Hex(presented);
    if (!timingSafeEqual(presentedHash, row.publishTokenHash)) {
      return refuse('invalid_publish_token', { relic_id: relicId });
    }

    const rendererClass = body['renderer_class'];
    if (typeof rendererClass !== 'string' || !isRendererClass(rendererClass)) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }

    let titleUpdate: { readonly title: string | undefined } | undefined;
    if ('title' in body && body['title'] !== undefined) {
      if (typeof body['title'] !== 'string') {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
      const trimmed = body['title'].trim();
      if (trimmed.length === 0) {
        titleUpdate = { title: undefined };
      } else if (!isStorableTitle(trimmed)) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      } else {
        titleUpdate = { title: trimmed };
      }
    }
    let ownerUpdate: { readonly ownerEmail: string | undefined } | undefined;
    if ('owner_email' in body || 'owner' in body) {
      const rawOwner = body['owner_email'] ?? body['owner'];
      if (
        rawOwner === null ||
        (typeof rawOwner === 'string' && rawOwner.trim().length === 0)
      ) {
        ownerUpdate = { ownerEmail: undefined };
      } else if (
        typeof rawOwner !== 'string' ||
        !looksLikeEmail(rawOwner.trim())
      ) {
        return refuse('invalid_publish_metadata', {
          relic_id: relicId,
          detail: 'Invalid owner notification address.',
        });
      } else {
        const normalizedOwner = rawOwner.trim();
        const verified = await store.hasVerifiedIdentity(normalizedOwner);
        if (!verified) {
          return refuse('invalid_publish_metadata', {
            relic_id: relicId,
            detail:
              'Owner notification address has no verified identity with the service. Sign in once to verify your address.',
          });
        }
        ownerUpdate = { ownerEmail: normalizedOwner };
      }
    }

    let notify = true;
    if ('notify' in body && body['notify'] !== undefined) {
      if (typeof body['notify'] !== 'boolean') {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
      notify = body['notify'];
    }

    let shareVerifierUpdate: { readonly shareVerifier: string } | undefined;
    if (
      'share_verifier' in body &&
      body['share_verifier'] !== undefined &&
      body['share_verifier'] !== null
    ) {
      const rawVerifier = body['share_verifier'];
      if (
        typeof rawVerifier !== 'string' ||
        !/^[0-9a-f]{64}$/.test(rawVerifier)
      ) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
      shareVerifierUpdate = { shareVerifier: rawVerifier };
    }

    const declared = Number(body['declared_size_bytes']);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }
    if (declared > config.plaintextCapBytes) {
      return refuse('size_over_cap', {
        relic_id: relicId,
        size_limit_bytes: config.plaintextCapBytes,
        declared_size_bytes: declared,
        size_basis: 'plaintext',
      });
    }

    const declaredCiphertext = Number(body['declared_ciphertext_bytes']);
    if (!Number.isSafeInteger(declaredCiphertext) || declaredCiphertext <= 0) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }
    if (declaredCiphertext > config.ciphertextCapBytes) {
      return refuse('size_over_cap', {
        relic_id: relicId,
        size_limit_bytes: config.plaintextCapBytes,
        declared_size_bytes: declared,
        size_basis: 'plaintext',
      });
    }
    if (declared > 0) {
      if (declaredCiphertext !== encryptedSize(declared)) {
        return refuse('invalid_publish_metadata', { relic_id: relicId });
      }
    } else if (
      declaredCiphertext > encryptedSize(0, undefined, MAX_HEADER_BYTES)
    ) {
      return refuse('invalid_publish_metadata', { relic_id: relicId });
    }

    const next = await store.beginVersion(
      relicId,
      rendererClass as RendererClass,
      declared,
      titleUpdate,
      ownerUpdate,
      notify,
      shareVerifierUpdate
    );
    if (next === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }
    await store.deleteCovers(relicId);

    const upload = await storage.signUpload(
      objectKey(relicId, next.version),
      declaredCiphertext,
      config.uploadUrlValiditySeconds,
      now
    );

    return Response.json({
      relic_id: relicId,
      version: next.version,
      upload_url: upload.url,
      upload_method: upload.method,
      upload_headers: upload.headers,
      upload_expires_at: iso(upload.expiresAt),
      relic_expires_at: relicExpiryIso(row.expiresAt),
      report_url: `${config.serviceOrigin}/abuse`,
      disclosure_url: `${config.serviceOrigin}/policy`,
    });
  }

  /**
   * The publishing client reports a finished upload, giving the server a true
   * publish timestamp.
   *
   * It is an optimization, never a requirement. `format.md` 1.3 is explicit
   * that the confirmation is the message that gets lost, which is why the
   * client owns the ID and the key before anything leaves the machine, and why
   * `relic_never_published` exists for the case where nothing ever lands.
   *
   * The timestamp matters because the frame's 120-second window is anchored to
   * publish time. Anchoring it to the first mint instead would drop every
   * first genuine open, which is precisely the event the metric's first clause
   * exists to count.
   */
  async function complete(
    rawId: string,
    now: number,
    ip: string
  ): Promise<Response> {
    const verdict = limiter.check(
      rateLimitKey('complete', ip),
      config.publishRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('publish_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    const row = await store.getRelic(relicId);
    if (row === undefined)
      return refuse('relic_not_found', { relic_id: relicId });

    const object = await storage.stat(objectKey(relicId, row.version));
    if (object === undefined) {
      return refuse('relic_not_yet_published', {
        relic_id: relicId,
        retry_after_seconds: 5,
      });
    }

    const justPublished = row.publishedAt === undefined;
    if (justPublished) {
      await store.markPublished(relicId, now, object.length, object.crc32c);
    }

    if (row.noticePending === true) {
      try {
        await announceVersion(relicId, row.version, now);
      } catch (error) {
        console.error('relic: change notice failed:', error);
      }
    }

    let versionDigest: string | null =
      row.versionDigests?.[String(row.version)] ?? null;
    if (
      versionDigest === null &&
      (justPublished || row.versionDigests?.[String(row.version)] === undefined)
    ) {
      try {
        const computed = await singleFlightDigest(relicId, row.version);
        if (computed !== undefined) {
          const recorded = await store.recordVersionDigest(
            relicId,
            row.version,
            computed
          );
          versionDigest = recorded ?? computed;
        }
      } catch (error) {
        console.error(
          'relic: failed to compute version digest in complete:',
          error
        );
        versionDigest = null;
      }
    }

    return Response.json({
      relic_id: relicId,
      version: row.version,
      version_digest: versionDigest,
      object_length: object.length,
      object_crc32c: object.crc32c,
      relic_expires_at: relicExpiryIso(row.expiresAt),
    });
  }
  async function uploadCover(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }

    const verdict = limiter.check(
      rateLimitKey('cover', ip),
      config.publishRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('publish_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch (error) {
      const failure =
        error instanceof InvalidRelicIdError ? error.failure : 'alphabet';
      return refuse('invalid_relic_id', { id_validation_failure: failure });
    }

    const tombstone = await store.getTombstone(relicId);
    if (tombstone !== undefined) {
      return refuse('relic_removed', { relic_id: relicId });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return refuse('invalid_cover', { cover_validation_failure: 'structure' });
    }

    const MAX_UPLOAD_BODY_BYTES = 720_000;
    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (
        Number.isNaN(contentLength) ||
        contentLength > MAX_UPLOAD_BODY_BYTES
      ) {
        return refuse('invalid_cover', { cover_validation_failure: 'size' });
      }
    }

    let rawBytes: Uint8Array;
    if (!request.body) {
      return refuse('invalid_cover', { cover_validation_failure: 'structure' });
    }
    try {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_UPLOAD_BODY_BYTES) {
          reader.cancel();
          return refuse('invalid_cover', { cover_validation_failure: 'size' });
        }
        chunks.push(value);
      }
      rawBytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        rawBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch {
      return refuse('invalid_cover', { cover_validation_failure: 'structure' });
    }

    let body: Record<string, unknown>;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      const parsed = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return refuse('invalid_cover', {
          cover_validation_failure: 'structure',
        });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return refuse('invalid_cover', { cover_validation_failure: 'structure' });
    }

    const publishToken = body['publish_token'];
    if (typeof publishToken !== 'string') {
      return refuse('invalid_publish_token', { relic_id: relicId });
    }
    const tokenHash = await sha256Hex(publishToken);
    if (!timingSafeEqual(tokenHash, row.publishTokenHash)) {
      return refuse('invalid_publish_token', { relic_id: relicId });
    }

    const version = body['version'];
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version !== row.version
    ) {
      return refuse('cover_version_stale', {
        relic_id: relicId,
        current_version: row.version,
      });
    }

    const object = await storage.stat(objectKey(relicId, row.version));
    if (object === undefined) {
      return refuse('relic_not_yet_published', { relic_id: relicId });
    }

    const kind = body['kind'];
    const type = body['type'];
    if (
      !isCoverKind(kind) ||
      typeof type !== 'string' ||
      !(COVER_TYPES as readonly string[]).includes(type)
    ) {
      return refuse('invalid_cover', { cover_validation_failure: 'structure' });
    }

    const data = body['data'];
    if (
      typeof data !== 'string' ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
      return refuse('invalid_cover', { cover_validation_failure: 'structure' });
    }

    const rasterBytes = Uint8Array.from(Buffer.from(data, 'base64'));
    if (rasterBytes.byteLength > config.coverCapBytes) {
      return refuse('invalid_cover', {
        cover_validation_failure: 'size',
        size_limit_bytes: config.coverCapBytes,
      });
    }

    const validation = validateCoverRaster(
      rasterBytes,
      (compressed, maxOutputLength) =>
        inflateSync(compressed, { maxOutputLength })
    );
    if (!validation.ok) {
      return refuse('invalid_cover', {
        cover_validation_failure: validation.failure,
        detail: validation.detail,
      });
    }

    if (validation.type !== type) {
      return refuse('invalid_cover', {
        cover_validation_failure: 'signature',
        detail: `Declared type ${type} does not match detected raster type ${validation.type}`,
      });
    }

    const sha256 = await sha256Hex(rasterBytes);
    const cover: RelicCover = {
      version: row.version,
      sha256,
      type: type as CoverType,
      kind: kind as CoverKind,
      bytes: rasterBytes.byteLength,
      uploadedAt: now,
    };

    const putResult = await store.putCover(relicId, cover, rasterBytes);
    if (putResult === 'stale_version') {
      return refuse('cover_version_stale', {
        relic_id: relicId,
        current_version:
          (await store.getRelic(relicId))?.version ?? row.version,
      });
    }
    if (putResult === 'not_found') {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    const ext = coverExtension(cover.type);
    const coverUrl = `${config.serviceOrigin.replace(/\/+$/, '')}/${relicId}/cover/${sha256}.${ext}`;
    return Response.json({
      relic_id: relicId,
      version: cover.version,
      kind: cover.kind,
      type: cover.type,
      sha256: cover.sha256,
      bytes: cover.bytes,
      cover_url: coverUrl,
    });
  }

  // --- view path ----------------------------------------------------------

  async function mint(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const occurrenceId = newOccurrenceId();

    if (config.killSwitchEngaged) {
      return logAndRefuse(rawId, ip, now, occurrenceId, 'service_paused', {
        retry_after_seconds: 300,
      });
    }

    const verdict = limiter.check(
      rateLimitKey('mint', ip),
      config.mintRateLimit,
      now
    );
    if (!verdict.allowed) {
      return logAndRefuse(rawId, ip, now, occurrenceId, 'mint_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    // Normalize before keying, or the cap fragments across ID spellings and
    // stops being a cap.
    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch (error) {
      const failure =
        error instanceof InvalidRelicIdError ? error.failure : 'alphabet';
      return logAndRefuse(rawId, ip, now, occurrenceId, 'invalid_relic_id', {
        id_validation_failure: failure,
      });
    }

    const tombstone = await store.getTombstone(relicId);
    if (tombstone !== undefined) {
      // The fact of removal is disclosed. The reason is not: a system that
      // normally names the reason cannot go quiet on one takedown without the
      // silence itself being the disclosure.
      return logAndRefuse(relicId, ip, now, occurrenceId, 'relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return logAndRefuse(relicId, ip, now, occurrenceId, 'relic_not_found', {
        relic_id: relicId,
      });
    }

    const body = (await readJson(request)) as Record<string, unknown>;
    const explicitVersion = body['version'];
    const version =
      explicitVersion === undefined ? row.version : explicitVersion;
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > row.version
    ) {
      return logAndRefuse(
        relicId,
        ip,
        now,
        occurrenceId,
        'invalid_relic_version',
        { relic_id: relicId }
      );
    }
    if (row.access === 'private') {
      return mintPrivate(relicId, row, body, version, request, now);
    }

    const object = await storage.stat(objectKey(relicId, version));

    // A relic with no publisher-set lifetime cannot land here; its only end
    // is deletion.
    if (row.expiresAt !== undefined && now >= row.expiresAt) {
      // Expired and never-published are distinguished, because the ID is
      // unguessable and only somebody handed the link can ask.
      const code =
        object === undefined ? 'relic_never_published' : 'relic_expired';
      return logAndRefuse(relicId, ip, now, occurrenceId, code, {
        relic_id: relicId,
      });
    }

    if (object === undefined) {
      // Temporary: the grant is live and the bytes have not landed. The
      // viewer says "still uploading", never anything that reads as a dead
      // link.
      return logAndRefuse(
        relicId,
        ip,
        now,
        occurrenceId,
        'relic_not_yet_published',
        { relic_id: relicId, retry_after_seconds: 5 }
      );
    }

    if (row.publishedAt === undefined && version === row.version) {
      // The completion call never arrived, so the true publish time is
      // unknown. Anchor at the grant instead, because the upload begins
      // immediately after it.
      //
      // Anchoring at `now` would be wrong in a way that breaks the metric
      // rather than merely biasing it: the window would then always cover the
      // first mint, so the first genuine recipient open would be dropped every
      // single time. The residual cost of the grant anchor is that a slow
      // upload shifts the window earlier, letting a publisher self-check land
      // outside it. That is the known inflation bias the frame already
      // documents as permanent, not a new one.
      await store.markPublished(
        relicId,
        row.grantedAt,
        object.length,
        object.crc32c
      );
    }

    if (version === row.version && row.noticePending === true) {
      try {
        await announceVersion(relicId, row.version, now);
      } catch (error) {
        console.error('relic: change notice failed:', error);
      }
    }

    if (row.mintsUsed >= config.downloadCap) {
      // Not a rate limit: waiting never helps and the object still exists.
      return logAndRefuse(
        relicId,
        ip,
        now,
        occurrenceId,
        'download_cap_exhausted',
        { relic_id: relicId, download_cap: config.downloadCap }
      );
    }

    // Clamp to min(url_validity, relic_expiry). Accepting the overhang would
    // extend how long abuse circulates past the deadline the publisher set.
    // A relic with no deadline mints at the full window: there is nothing to
    // clamp against, and inventing one would reinstate the fixed TTL by the
    // back door.
    const validity =
      row.expiresAt === undefined
        ? config.urlValiditySeconds
        : Math.min(
            config.urlValiditySeconds,
            Math.floor((row.expiresAt - now) / 1000)
          );
    if (validity < config.minViableValiditySeconds) {
      return logAndRefuse(relicId, ip, now, occurrenceId, 'relic_expired', {
        relic_id: relicId,
      });
    }

    const previous = await store.recentMint(
      relicId,
      ip,
      now,
      config.mintDedupSeconds
    );

    let url: string;
    let urlExpiresAt: number;
    const sameVersion = previous !== undefined && previous.version === version;
    const stillViable =
      sameVersion &&
      previous !== undefined &&
      previous.urlExpiresAt - now >= config.minViableValiditySeconds * 1000;

    if (stillViable && previous !== undefined) {
      // A deduped mint returns the URL already issued, never a fresh one.
      // Several concurrently valid URLs against one unit of cap would add a
      // term to the worst-case egress arithmetic at zero cap cost.
      url = previous.url;
      urlExpiresAt = previous.urlExpiresAt;
    } else {
      const signed = await storage.signDownload(
        objectKey(relicId, version),
        validity,
        now
      );
      url = signed.url;
      urlExpiresAt = signed.expiresAt;
    }

    // A repeat inside the window is not a distinct open, and it still
    // consumes the cap. The two counters answer different questions: the open
    // counter is the metric, the cap is the cost control. A repeat against a
    // new version is a first look at new content, not a reload, so only a
    // same-version previous entry dedupes.
    const isDedup = sameVersion;
    const capRemaining =
      config.downloadCap - (await store.consumeMint(relicId));
    await store.rememberMint(relicId, ip, {
      url,
      urlExpiresAt,
      at: now,
      version,
    });

    const publishedAt = row.publishedAt ?? row.grantedAt;
    const dropReason = isDedup
      ? 'dedup'
      : ip === row.publishIp
        ? 'publishing_ip_match'
        : now - publishedAt < config.postPublishWindowSeconds * 1000
          ? 'post_publish_window'
          : undefined;

    await store.appendMintLog({
      relicId,
      ip,
      at: now,
      endpoint: 'mint',
      outcome: 'granted',
      code: undefined,
      countedAsOpen: dropReason === undefined,
      dropReason,
      consumedCap: true,
      capRemaining,
      occurrenceId,
    });

    return Response.json(
      {
        url,
        url_expires_at: iso(urlExpiresAt),
        relic_expires_at: relicExpiryIso(row.expiresAt),
        object_length: object.length,
        object_crc32c: object.crc32c,
        mints_remaining: capRemaining,
        version,
        current_version: row.version,
      },
      { headers: { 'referrer-policy': 'no-referrer' } }
    );
  }

  // --- change notices, comment notifications, and sharing -----------------

  interface RecipientMeta {
    readonly reason: 'commented' | 'shared' | 'owner';
    readonly sharedBy?: 'publisher' | 'reader' | undefined;
  }

  type NotificationEvent =
    | {
        readonly type: 'version';
        readonly version: number;
      }
    | {
        readonly type: 'comment';
        readonly author: string;
        readonly addresses?: string | undefined;
      };

  async function fanOutNotifications(params: {
    readonly relicId: string;
    readonly row: RelicRow;
    readonly now: number;
    readonly event: NotificationEvent;
  }): Promise<void> {
    const { relicId, row, now, event } = params;
    const initialRow = (await store.getRelic(relicId)) ?? row;
    if ((await store.getTombstone(relicId)) !== undefined) {
      return;
    }
    if (initialRow.expiresAt !== undefined && initialRow.expiresAt <= now) {
      return;
    }
    if (initialRow.mintsUsed >= config.downloadCap) {
      return;
    }
    if (
      mailer === undefined ||
      mailer === NULL_MAILER ||
      (mailer.sendBatch === undefined &&
        mailer.sendMail === undefined &&
        mailer.send === undefined)
    ) {
      const noticeKind =
        event.type === 'version' ? 'change notice' : 'comment notification';
      console.error(`relic: ${noticeKind} mailer unavailable`);
      return;
    }
    const fuseCheck = limiter.peek(
      'change-notice',
      config.changeNoticeRateLimit,
      now
    );
    if (!fuseCheck.allowed) {
      console.error('relic: change notice rate limit reached');
      return;
    }

    const [commenters, shares, optOuts, unsubKey] = await Promise.all([
      store.listCommenters(relicId),
      store.listShares(relicId),
      store.listOptOuts(relicId),
      store.unsubscribeKey(),
    ]);

    let answeredAddr: string | undefined;
    if (event.type === 'comment' && event.addresses !== undefined) {
      const addressedComment = await store.getComment(relicId, event.addresses);
      if (
        addressedComment !== undefined &&
        addressedComment.author !== 'publisher' &&
        looksLikeEmail(addressedComment.author)
      ) {
        const candidate = addressedComment.author.trim().toLowerCase();
        if (candidate !== event.author.trim().toLowerCase()) {
          answeredAddr = candidate;
        }
      }
    }

    const recipients = new Map<string, RecipientMeta>();

    for (const commenter of commenters) {
      recipients.set(commenter, { reason: 'commented' });
    }

    for (const share of shares) {
      const addr = share.email.trim().toLowerCase();
      if (!recipients.has(addr)) {
        recipients.set(addr, {
          reason: 'shared',
          sharedBy: share.sharedBy,
        });
      }
    }

    const normalizedOwner = row.ownerEmail?.trim().toLowerCase();
    if (event.type === 'version') {
      if (normalizedOwner !== undefined) {
        recipients.delete(normalizedOwner);
      }
    } else {
      const authorLower = event.author.trim().toLowerCase();
      if (event.author === 'publisher') {
        if (normalizedOwner !== undefined) {
          recipients.delete(normalizedOwner);
        }
      } else {
        if (normalizedOwner !== undefined && normalizedOwner !== authorLower) {
          if (!recipients.has(normalizedOwner)) {
            recipients.set(normalizedOwner, { reason: 'owner' });
          }
        }
        recipients.delete(authorLower);
      }
    }

    const optOutSet = new Set(optOuts);
    const canonicalRelicId = parseRelicId(relicId);
    const relicUrl = `${config.serviceOrigin}/${relicId}`;
    const logPrefix =
      event.type === 'version' ? 'change notice send' : 'comment notification';

    interface PreparedRecipient {
      readonly address: string;
      readonly addressHash: string;
      readonly mail: OutboundMail;
    }

    const prepared: PreparedRecipient[] = [];

    for (const [address, meta] of recipients) {
      const addressHash = await sha256Hex(address);
      if (optOutSet.has(addressHash)) {
        continue;
      }

      const recipientVerdict = limiter.peek(
        `notify ${relicId} ${address}`,
        config.notificationRateLimit,
        now
      );
      if (!recipientVerdict.allowed) {
        continue;
      }

      const globalVerdict = limiter.peek(
        'change-notice',
        config.changeNoticeRateLimit,
        now
      );
      if (!globalVerdict.allowed) {
        console.error('relic: change notice rate limit reached');
        break;
      }

      const tokenBytes = await hmacSha256(
        unsubKey,
        `relic-unsubscribe:v1:${canonicalRelicId}:${addressHash}`
      );
      const token = Buffer.from(tokenBytes).toString('base64url');
      const stopUrl = `${config.serviceOrigin}/api/relics/${relicId}/unsubscribe?addr=${addressHash}&token=${token}`;

      let mail: OutboundMail;
      if (row.access === 'private') {
        // A private relic's mail names no title and no commenter (plan 4.14).
        mail = privateActivityMail({ relicUrl, stopUrl });
      } else if (event.type === 'version') {
        mail = changeNoticeMail({
          title: row.title,
          version: event.version,
          relicUrl,
          stopUrl,
          reason: meta.reason,
          sharedBy: meta.sharedBy,
        });
      } else {
        const commenterName =
          event.author === 'publisher' ? 'The publisher' : event.author;
        if (answeredAddr !== undefined && address === answeredAddr) {
          mail = replyNotificationMail({
            title: row.title,
            replier: commenterName,
            relicUrl,
            stopUrl,
          });
        } else if (
          normalizedOwner !== undefined &&
          address === normalizedOwner
        ) {
          mail = commentNotificationMail({
            title: row.title,
            commenter: commenterName,
            relicUrl,
            stopUrl,
          });
        } else {
          mail = commentNoticeMail({
            title: row.title,
            commenter: commenterName,
            relicUrl,
            stopUrl,
            reason: meta.reason,
            sharedBy: meta.sharedBy,
          });
        }
      }

      prepared.push({ address, addressHash, mail });
    }

    if (typeof mailer.sendBatch === 'function') {
      const MAX_BATCH = 100;
      for (let i = 0; i < prepared.length; i += MAX_BATCH) {
        const dispatchRow = await store.getRelic(relicId);
        if (
          dispatchRow === undefined ||
          (await store.getTombstone(relicId)) !== undefined ||
          (dispatchRow.expiresAt !== undefined &&
            dispatchRow.expiresAt <= now) ||
          dispatchRow.mintsUsed >= config.downloadCap
        ) {
          break;
        }
        const chunk = prepared.slice(i, i + MAX_BATCH);
        const activeChunk: Array<{
          email: string;
          addressHash: string;
          mail: OutboundMail;
        }> = [];
        for (const item of chunk) {
          if (await store.isOptedOut(relicId, item.addressHash)) {
            continue;
          }
          const recipientVerdict = limiter.peek(
            `notify ${relicId} ${item.address}`,
            config.notificationRateLimit,
            now
          );
          if (!recipientVerdict.allowed) {
            continue;
          }
          const globalVerdict = limiter.peek(
            'change-notice',
            config.changeNoticeRateLimit,
            now
          );
          if (!globalVerdict.allowed) {
            console.error('relic: change notice rate limit reached');
            break;
          }

          limiter.check(
            `notify ${relicId} ${item.address}`,
            config.notificationRateLimit,
            now
          );
          limiter.check('change-notice', config.changeNoticeRateLimit, now);

          activeChunk.push({
            email: item.address,
            addressHash: item.addressHash,
            mail: item.mail,
          });
        }
        if (activeChunk.length > 0) {
          try {
            await mailer.sendBatch(
              activeChunk.map((it) => ({ email: it.email, mail: it.mail }))
            );
          } catch (error) {
            let status: number | undefined;
            let code = 'unknown';
            if (error instanceof MailRefusedError) {
              status = error.status;
              code = error.code;
            } else if (typeof error === 'object' && error !== null) {
              if ('status' in error && typeof error.status === 'number') {
                status = error.status;
              } else if (
                'statusCode' in error &&
                typeof error.statusCode === 'number'
              ) {
                status = error.statusCode;
              }
              if ('code' in error && typeof error.code === 'string') {
                code = error.code;
              } else if (error instanceof Error) {
                code = error.name;
              }
            }
            const statusDetail = status !== undefined ? `${status} ` : '';
            for (const it of activeChunk) {
              console.error(
                `relic: ${logPrefix} failed for recipient ${it.addressHash}: ${statusDetail}${code}`
              );
            }
          }
        }
      }
    } else if (typeof mailer.sendMail === 'function') {
      for (const item of prepared) {
        const dispatchRow = await store.getRelic(relicId);
        if (
          dispatchRow === undefined ||
          (await store.getTombstone(relicId)) !== undefined ||
          (dispatchRow.expiresAt !== undefined &&
            dispatchRow.expiresAt <= now) ||
          dispatchRow.mintsUsed >= config.downloadCap
        ) {
          break;
        }
        if (await store.isOptedOut(relicId, item.addressHash)) {
          continue;
        }
        const recipientVerdict = limiter.peek(
          `notify ${relicId} ${item.address}`,
          config.notificationRateLimit,
          now
        );
        if (!recipientVerdict.allowed) {
          continue;
        }
        const globalVerdict = limiter.peek(
          'change-notice',
          config.changeNoticeRateLimit,
          now
        );
        if (!globalVerdict.allowed) {
          console.error('relic: change notice rate limit reached');
          break;
        }
        limiter.check(
          `notify ${relicId} ${item.address}`,
          config.notificationRateLimit,
          now
        );
        limiter.check('change-notice', config.changeNoticeRateLimit, now);
        try {
          await mailer.sendMail(item.address, item.mail);
        } catch (error) {
          console.error(
            `relic: ${logPrefix} failed for recipient ${item.addressHash}: ${sanitizeMailError(error, item.address)}`
          );
        }
      }
    } else if (typeof mailer.send === 'function') {
      for (const item of prepared) {
        const dispatchRow = await store.getRelic(relicId);
        if (
          dispatchRow === undefined ||
          (await store.getTombstone(relicId)) !== undefined ||
          (dispatchRow.expiresAt !== undefined &&
            dispatchRow.expiresAt <= now) ||
          dispatchRow.mintsUsed >= config.downloadCap
        ) {
          break;
        }
        if (await store.isOptedOut(relicId, item.addressHash)) {
          continue;
        }
        const recipientVerdict = limiter.peek(
          `notify ${relicId} ${item.address}`,
          config.notificationRateLimit,
          now
        );
        if (!recipientVerdict.allowed) {
          continue;
        }
        const globalVerdict = limiter.peek(
          'change-notice',
          config.changeNoticeRateLimit,
          now
        );
        if (!globalVerdict.allowed) {
          console.error('relic: change notice rate limit reached');
          break;
        }
        limiter.check(
          `notify ${relicId} ${item.address}`,
          config.notificationRateLimit,
          now
        );
        limiter.check('change-notice', config.changeNoticeRateLimit, now);
        try {
          await mailer.send(item.address, item.mail.text);
        } catch (error) {
          console.error(
            `relic: ${logPrefix} failed for recipient ${item.addressHash}: ${sanitizeMailError(error, item.address)}`
          );
        }
      }
    }
  }

  async function announceVersion(
    relicId: string,
    version: number,
    now: number
  ): Promise<void> {
    if ((await store.getTombstone(relicId)) !== undefined) {
      return;
    }

    const claimedRow = await store.claimVersionNotice(relicId, version);
    if (claimedRow === undefined) {
      return;
    }

    await fanOutNotifications({
      relicId,
      row: claimedRow,
      now,
      event: { type: 'version', version },
    });
  }
  async function checkShareProof(
    row: RelicRow,
    raw: unknown
  ): Promise<'ok' | 'unavailable' | 'malformed' | 'mismatch'> {
    if (row.shareVerifier === undefined || row.shareVerifier === '') {
      return 'unavailable';
    }
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) {
      return 'malformed';
    }
    const proofBytes = Buffer.from(raw, 'base64url');
    if (proofBytes.byteLength !== 32) {
      return 'malformed';
    }
    const computedVerifier = await sha256Hex(proofBytes);
    if (!timingSafeEqual(computedVerifier, row.shareVerifier)) {
      return 'mismatch';
    }
    return 'ok';
  }

  async function share(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }

    const ipVerdict = limiter.check(
      rateLimitKey('share', ip),
      config.shareRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return refuse('share_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJson(request);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return refuse('invalid_share', {
          relic_id: relicId,
          share_max_per_call: config.shareMaxPerCall,
        });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return refuse('invalid_share', {
        relic_id: relicId,
        share_max_per_call: config.shareMaxPerCall,
      });
    }

    const hasPublishToken =
      'publish_token' in body && body['publish_token'] !== undefined;
    const hasShareProof =
      'share_proof' in body && body['share_proof'] !== undefined;
    if (row.access === 'private' && hasShareProof) {
      return refuse('private_policy_violation', {
        relic_id: relicId,
        policy_check: 'share_proof',
      });
    }

    if (
      (hasPublishToken && hasShareProof) ||
      (!hasPublishToken && !hasShareProof && row.access !== 'private')
    ) {
      return refuse('invalid_share', {
        relic_id: relicId,
        share_max_per_call: config.shareMaxPerCall,
      });
    }

    let sharedBy: 'publisher' | 'reader';

    if (hasPublishToken) {
      sharedBy = 'publisher';
      const token = body['publish_token'];
      if (typeof token !== 'string' || token.length === 0) {
        return refuse('invalid_publish_token', { relic_id: relicId });
      }
      const tokenHash = await sha256Hex(token);
      if (!timingSafeEqual(tokenHash, row.publishTokenHash)) {
        return refuse('invalid_publish_token', { relic_id: relicId });
      }
      if (row.expiresAt !== undefined && row.expiresAt <= now) {
        return refuse('relic_expired', { relic_id: relicId });
      }
      if (row.mintsUsed >= config.downloadCap) {
        return refuse('download_cap_exhausted', {
          relic_id: relicId,
          download_cap: config.downloadCap,
        });
      }
    } else {
      sharedBy = 'reader';
      if (row.expiresAt !== undefined && row.expiresAt <= now) {
        return refuse('relic_expired', { relic_id: relicId });
      }
      if (row.mintsUsed >= config.downloadCap) {
        return refuse('download_cap_exhausted', {
          relic_id: relicId,
          download_cap: config.downloadCap,
        });
      }

      const token = sessionCookie(request);
      if (token === undefined) {
        return refuse('invalid_session', { relic_id: relicId });
      }
      const session = await store.getSession(await sha256Hex(token));
      if (session === undefined || session.expiresAt <= now) {
        return refuse('invalid_session', { relic_id: relicId });
      }

      if (row.access === 'private') {
        // Readers of a private relic prove access by a live wrap, not a fragment proof (plan 4.7).
        await privateReach(row, request, now, undefined);
      } else {
        const proofResult = await checkShareProof(row, body['share_proof']);
        if (proofResult === 'unavailable') {
          return refuse('share_unavailable', {
            relic_id: relicId,
            detail:
              'This relic was published before sharing existed. Its publisher can republish it to turn sharing on.',
          });
        }
        if (proofResult === 'malformed') {
          return refuse('invalid_share', {
            relic_id: relicId,
            share_max_per_call: config.shareMaxPerCall,
          });
        }
        if (proofResult === 'mismatch') {
          return refuse('invalid_share_proof', { relic_id: relicId });
        }
      }

      const readerVerdict = limiter.check(
        `share-reader ${relicId} ${session.email}`,
        config.readerShareRateLimit,
        now
      );
      if (!readerVerdict.allowed) {
        return refuse('share_rate_limited', {
          relic_id: relicId,
          retry_after_seconds: readerVerdict.retryAfterSeconds,
        });
      }
    }

    const rawEmails = body['emails'];
    if (
      !Array.isArray(rawEmails) ||
      rawEmails.length === 0 ||
      rawEmails.length > config.shareMaxPerCall
    ) {
      return refuse('invalid_share', {
        relic_id: relicId,
        share_max_per_call: config.shareMaxPerCall,
      });
    }

    const validEmails: string[] = [];
    for (let i = 0; i < rawEmails.length; i++) {
      const entry = rawEmails[i];
      if (typeof entry !== 'string' || !looksLikeEmail(entry.trim())) {
        return refuse('invalid_share', {
          relic_id: relicId,
          share_max_per_call: config.shareMaxPerCall,
          detail: `Invalid email address at index ${i}`,
        });
      }
      validEmails.push(entry);
    }

    const existingShares = await store.listShares(relicId);
    const existingEmailSet = new Set(existingShares.map((s) => s.email));

    const normalizedDeduped: string[] = [];
    const seenInCall = new Set<string>();
    const newAddresses: string[] = [];

    for (const entry of validEmails) {
      const norm = entry.trim().toLowerCase();
      if (!seenInCall.has(norm)) {
        seenInCall.add(norm);
        normalizedDeduped.push(norm);
        if (!existingEmailSet.has(norm)) {
          newAddresses.push(norm);
        }
      }
    }
    if (newAddresses.length === 0) {
      if ((await store.getTombstone(relicId)) !== undefined) {
        return refuse('relic_removed', {
          relic_id: relicId,
          report_url: `${config.serviceOrigin}/abuse`,
        });
      }
      return Response.json({
        relic_id: relicId,
        emails: normalizedDeduped,
        added: 0,
        shared_count: existingShares.length,
        share_limit: config.shareMaxPerRelic,
        title: row.title ?? null,
      });
    }

    const reservation = await store.reserveShares(
      relicId,
      newAddresses.length,
      config.shareMaxPerRelic
    );
    if (!reservation.allowed) {
      return refuse('share_limit_reached', {
        relic_id: relicId,
        share_limit: config.shareMaxPerRelic,
        shared_count: reservation.currentCount,
      });
    }

    let actualInserts = 0;
    try {
      for (const email of newAddresses) {
        const inserted = await store.putShare({
          relicId,
          email,
          addedAt: now,
          sharedBy,
        });
        if (inserted) {
          actualInserts++;
        }
      }
    } finally {
      const unneeded = newAddresses.length - actualInserts;
      if (unneeded > 0) {
        await store.releaseShares(relicId, unneeded);
      }
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      await store.deleteSharesForRelic(relicId);
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }

    const finalSharedCount =
      reservation.currentCount - (newAddresses.length - actualInserts);

    return Response.json({
      relic_id: relicId,
      emails: normalizedDeduped,
      added: actualInserts,
      shared_count: finalSharedCount,
      share_limit: config.shareMaxPerRelic,
      title: row.title ?? null,
    });
  }

  function unsubscribeResponse(
    status: number,
    h1: string,
    bodyHtml: string,
    retryAfter?: number,
    isHead = false
  ): Response {
    const headers = new Headers({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (retryAfter !== undefined) {
      headers.set('retry-after', String(retryAfter));
    }
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h1}</title><h1>${h1}</h1>${bodyHtml}`;
    if (isHead) {
      return new Response(null, { status, headers });
    }
    return new Response(html, { status, headers });
  }

  async function unsubscribe(
    rawId: string,
    request: Request,
    url: URL,
    ip: string,
    now: number
  ): Promise<Response> {
    const isHead = request.method === 'HEAD';
    const ipVerdict = limiter.check(
      rateLimitKey('unsubscribe', ip),
      config.unsubscribeRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return unsubscribeResponse(
        429,
        'Too many requests',
        '<p>Try again in a few minutes.</p>',
        ipVerdict.retryAfterSeconds,
        isHead
      );
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return unsubscribeResponse(
        400,
        'This link does not work',
        '<p>It may have been cut short. Open the stop link from the email again.</p>',
        undefined,
        isHead
      );
    }

    const addr = url.searchParams.get('addr');
    const token = url.searchParams.get('token');
    if (
      addr === null ||
      !/^[0-9a-f]{64}$/.test(addr) ||
      token === null ||
      token === ''
    ) {
      return unsubscribeResponse(
        400,
        'This link does not work',
        '<p>It may have been cut short. Open the stop link from the email again.</p>',
        undefined,
        isHead
      );
    }

    const unsubKey = await store.unsubscribeKey();
    const expectedSig = await hmacSha256(
      unsubKey,
      `relic-unsubscribe:v1:${relicId}:${addr}`
    );
    const expectedToken = Buffer.from(expectedSig).toString('base64url');
    if (!timingSafeEqual(expectedToken, token)) {
      return unsubscribeResponse(
        400,
        'This link does not work',
        '<p>It may have been cut short. Open the stop link from the email again.</p>',
        undefined,
        isHead
      );
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      return unsubscribeResponse(
        200,
        'Nothing to stop',
        '<p>This relic is no longer available, so it sends no emails.</p>',
        undefined,
        isHead
      );
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return unsubscribeResponse(
        200,
        'Nothing to stop',
        '<p>This relic is no longer available, so it sends no emails.</p>',
        undefined,
        isHead
      );
    }

    const T = row.title ? `"${escapeHtml(row.title)}"` : 'this relic';

    if (request.method === 'POST') {
      await store.putOptOut({
        relicId,
        addressHash: addr,
        at: now,
      });
      if ((await store.getTombstone(relicId)) !== undefined) {
        await store.deleteOptOutsForRelic(relicId);
        return unsubscribeResponse(
          200,
          'Nothing to stop',
          '<p>This relic is no longer available, so it sends no emails.</p>',
          undefined,
          isHead
        );
      }
      return unsubscribeResponse(
        200,
        'Stopped',
        `<p>This address will get no more emails about ${T}.</p>`,
        undefined,
        isHead
      );
    }

    const action = `${config.serviceOrigin}/api/relics/${relicId}/unsubscribe?addr=${addr}&amp;token=${token}`;
    const formHtml = `<p>Stop emails about ${T}?</p><form method="POST" action="${action}"><button type="submit">Stop these emails</button></form><p>Only this relic's emails stop.</p>`;
    return unsubscribeResponse(200, 'Stop emails', formHtml, undefined, isHead);
  }

  // --- operator surface ---------------------------------------------------

  /**
   * The only authenticated surface in a product whose first locked non-goal is
   * no identity anywhere. The non-goal bounds the product, not the operator's
   * tooling. It sits under the reserved `api` prefix, so it can never collide
   * with an issued ID, and it returns 401 and 403 normally.
   */
  async function operatorDelete(
    rawId: string,
    request: Request,
    url: URL,
    now: number
  ): Promise<Response> {
    const operator = authenticateOperator(request);
    if (operator === undefined) {
      return new Response('Unauthorized', { status: 401 });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    const existing = await store.getTombstone(relicId);
    const row = await store.getRelic(relicId);
    if (existing === undefined && row === undefined) {
      // On this endpoint 404 means one thing only: never issued.
      return new Response('No such relic id was ever issued', { status: 404 });
    }

    const reasonClass = (url.searchParams.get('reason') ??
      'abuse') as ReasonClass;
    const reference = url.searchParams.get('reference') ?? undefined;

    // An owner tombstone carries no ciphertext hash: the owner removed the bytes.
    const operatorStone = existing?.kind === 'owner' ? undefined : existing;
    let hash: string | undefined = operatorStone?.ciphertextHash;

    if (existing === undefined) {
      if (row === undefined) {
        return new Response('No such relic id was ever issued', {
          status: 404,
        });
      }

      // Hash before delete, every version. A delete that captures no hash
      // permanently loses the ability to blocklist that payload, and a
      // republished relic can carry a different payload per version, so
      // hashing only the current one would hand the blocklist a gap exactly
      // one republish wide.
      const hashes: string[] = [];
      for (let version = 1; version <= row.version; version++) {
        const versionHash = await storage.digest(objectKey(relicId, version));
        if (versionHash !== undefined) hashes.push(versionHash);
      }
      // The tombstone's hash of record is the newest version that had bytes:
      // the content the relic was serving when it was taken down. An empty
      // list is the same refusal it always was.
      hash = hashes.at(-1);
      if (hash === undefined) {
        return new Response('Refused: no bytes to hash', { status: 409 });
      }

      await store.putTombstone({
        id: relicId,
        publishIp: row.publishIp,
        publishedAt: row.publishedAt,
        publishingClient: row.publishingClient,
        rendererClass: row.rendererClass,
        ciphertextHash: hash,
        deletedAt: now,
        operator,
        reasonClass,
        reportReference: reference,
      });

      const override = url.searchParams.get('blocklist');
      const automatic =
        reasonClass === 'abuse' || reasonClass === 'blocklist_match';
      const shouldBlocklist =
        override === 'true' ? true : override === 'false' ? false : automatic;
      if (shouldBlocklist) {
        for (const versionHash of hashes) await store.blocklist(versionHash);
      }
    } else {
      const override = url.searchParams.get('blocklist');
      const automatic =
        reasonClass === 'abuse' || reasonClass === 'blocklist_match';
      const shouldBlocklist =
        override === 'true' ? true : override === 'false' ? false : automatic;
      if (shouldBlocklist && hash !== undefined) {
        await store.blocklist(hash);
      }
    }

    // Resume every sweep idempotently, whether first run or retrying an existing tombstone
    const maxVersion = row?.version ?? 1;
    for (let version = 1; version <= maxVersion; version++) {
      await storage.delete(objectKey(relicId, version));
    }
    const coversRemoved = await store.deleteCovers(relicId);
    const commentsRemoved = await store.deleteCommentsForRelic(relicId);
    const sharesDeleted = await store.deleteSharesForRelic(relicId);
    const optOutsDeleted = await store.deleteOptOutsForRelic(relicId);
    const decisionsDeleted = await store.deleteDecisionsForRelic(relicId);
    if (row?.access === 'private') {
      await store.deleteWraps(relicId, {});
      await store.deleteSeals(relicId);
      await store.deleteGrantsForRelic(relicId);
      await store.deleteAccessRequestsForRelic(relicId);
      if (row.ownerIdentityId !== undefined) {
        await store.deleteOwnedRelic(row.ownerIdentityId, relicId);
      }
    }
    const override = url.searchParams.get('blocklist');
    const automatic =
      reasonClass === 'abuse' || reasonClass === 'blocklist_match';
    const shouldBlocklist =
      override === 'true' ? true : override === 'false' ? false : automatic;

    if (existing !== undefined) {
      return Response.json({
        tombstone: existing,
        already_deleted: true,
        ciphertext_hash: hash,
        comments_deleted: commentsRemoved,
        covers_deleted: coversRemoved,
        shares_deleted: sharesDeleted,
        opt_outs_deleted: optOutsDeleted,
        decisions_deleted: decisionsDeleted,
      });
    }

    return Response.json({
      relic_id: relicId,
      deleted: true,
      blocklisted: shouldBlocklist,
      ciphertext_hash: hash,
      comments_deleted: commentsRemoved,
      covers_deleted: coversRemoved,
      shares_deleted: sharesDeleted,
      opt_outs_deleted: optOutsDeleted,
      decisions_deleted: decisionsDeleted,
    });
  }

  function authenticateOperator(request: Request): string | undefined {
    const header = request.headers.get('authorization');
    if (header === null || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length);
    for (const [name, secret] of operators) {
      if (secret === token) return name;
    }
    return undefined;
  }

  // --- abuse intake -------------------------------------------------------

  async function abuseSubmit(request: Request, now: number): Promise<Response> {
    const form = await request.formData();
    const submitted = String(form.get('relic_id') ?? '');

    // The server-side strip is the one that counts, because it is the only
    // one a no-JavaScript submission reaches. A stored fragment would put the
    // key in the operator's hands and convert "we structurally cannot read it"
    // into "we chose not to".
    const relicId = stripToRelicId(submitted);

    const category = String(form.get('category') ?? 'other');
    const valid = [
      'malware',
      'phishing',
      'csam',
      'copyright',
      'legal_process',
      'other',
    ];
    if (!valid.includes(category)) {
      return new Response('Unknown category', { status: 400 });
    }
    if (
      (category === 'copyright' || category === 'legal_process') &&
      (form.get('authority') === null || form.get('reference') === null)
    ) {
      return new Response('Authority and reference are required', {
        status: 400,
      });
    }

    await store.putAbuseReport({
      relicId,
      category: category as never,
      description: String(form.get('description') ?? ''),
      contact: optional(form.get('contact')),
      authority: optional(form.get('authority')),
      reference: optional(form.get('reference')),
      receivedAt: now,
    });

    return new Response(
      `Report received. We respond within ${config.abuseSlaHours} hours.`,
      { status: 202, headers: { 'content-type': 'text/plain' } }
    );
  }

  // --- comments -----------------------------------------------------------

  /**
   * The versions a caller may read on a private relic (plan 4.7). The publish
   * token reads every version; otherwise a signed-in identity reads the
   * versions a live wrap opens for it. Throws the refusal when neither holds.
   */
  async function privateReach(
    row: RelicRow,
    request: Request,
    now: number,
    publishToken: unknown
  ): Promise<'all' | readonly number[]> {
    if (
      typeof publishToken === 'string' &&
      (await publishTokenOk(row, publishToken))
    ) {
      return 'all';
    }
    const session = await sessionOf(request, now);
    if (session === undefined) throw new ProblemError('sign_in_required');
    const env = privateEnv(now);
    const owner = await ownerRecord(env, row);
    const me = await currentIdentity(env, session.email);
    if (me === undefined) {
      throw new ProblemError('private_access_denied', { relic_id: row.id });
    }
    const standing = await standingOf(env, row, owner, me);
    if (
      standing.role === 'none' ||
      standing.role === 'requested' ||
      standing.role === 'declined' ||
      standing.role === 'revoked'
    ) {
      throw new ProblemError('private_access_denied', { relic_id: row.id });
    }
    return readableVersions(env, row, me.kemKeyId);
  }

  /**
   * PATCH and DELETE on a private comment need the same access as reading the
   * comment's version. The author check that follows stays as it was.
   */
  async function privateCommentRefusal(
    rawId: string,
    commentId: string,
    request: Request,
    now: number
  ): Promise<Response | undefined> {
    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return undefined;
    }
    const row = await store.getRelic(relicId);
    if (row === undefined || row.access !== 'private') return undefined;
    const comment = await store.getComment(relicId, commentId);
    if (comment === undefined || comment.version === undefined)
      return undefined;
    try {
      const reach = await privateReach(row, request, now, undefined);
      if (reach !== 'all' && !reach.includes(comment.version)) {
        return refuse('private_access_denied', { relic_id: relicId });
      }
    } catch (error) {
      if (error instanceof ProblemError)
        return refuse(error.code, error.options);
      throw error;
    }
    return undefined;
  }
  /**
   * The thread, oldest first, to anybody who asks.
   *
   * Unauthenticated on purpose. A reader holding the link already holds the
   * key to the content; every body here is ciphertext derived from that same
   * key (`format.md` 3.13), so an authenticated read would narrow who can
   * fetch bytes the server cannot read either way. What it would buy is
   * nothing; what it would cost is the no-accounts reading path.
   */
  async function listComments(
    rawId: string,
    request: Request,
    now: number,
    publishToken?: unknown
  ): Promise<Response> {
    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    // A tombstoned relic has no thread. Serving comments for content that
    // has been taken down would leave a readable discussion of a payload
    // the operator was obliged to remove.
    if ((await store.getTombstone(relicId)) !== undefined) {
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }
    const listed = await store.getRelic(relicId);
    if (listed === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    let rows = await store.listComments(relicId);
    if (listed.access === 'private') {
      let reach: 'all' | readonly number[];
      try {
        reach = await privateReach(listed, request, now, publishToken);
      } catch (error) {
        if (error instanceof ProblemError)
          return refuse(error.code, error.options);
        throw error;
      }
      if (reach !== 'all') {
        rows = rows.filter(
          (row) => row.version !== undefined && reach.includes(row.version)
        );
      }
    }
    return json(
      rows.map((row) => ({
        comment_id: row.id,
        author: row.author,
        created_at: new Date(row.createdAt).toISOString(),
        ciphertext: row.ciphertext,
        version: row.version ?? null,
        edited_at:
          row.editedAt === undefined
            ? null
            : new Date(row.editedAt).toISOString(),
        resolved_at:
          row.resolvedAt === undefined
            ? null
            : new Date(row.resolvedAt).toISOString(),
        resolved_by: row.resolvedBy ?? null,
      }))
    );
  }

  /**
   * Leave a comment, authorized either by a verified-email session or by the
   * relic's publish token.
   *
   * Two paths because an agent has no mailbox and cannot verify one, and the
   * feature is worth little if the publishing side cannot answer back. Both
   * are attribution rather than authorization: anybody holding the link plus
   * any real mailbox can comment, which `frame.md`'s identity entry states
   * outright so nobody reads a verified address as an access control.
   */
  async function postComment(
    rawId: string,
    request: Request,
    now: number
  ): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }
    const fetchedRow = await store.getRelic(relicId);
    if (fetchedRow === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }
    const row = { ...fetchedRow };

    const body = (await readJson(request)) as Record<string, unknown>;
    const author = await resolveAuthor(body, request, row.publishTokenHash);
    if (author === undefined) {
      return refuse('invalid_session', { relic_id: relicId });
    }

    const explicitVersion = body['version'];
    let commentVersion: number;
    if (explicitVersion === undefined) {
      commentVersion = row.version;
    } else if (
      typeof explicitVersion !== 'number' ||
      !Number.isSafeInteger(explicitVersion) ||
      explicitVersion < 1 ||
      explicitVersion > row.version
    ) {
      return refuse('invalid_relic_version', { relic_id: relicId });
    } else {
      commentVersion = explicitVersion;
    }
    if (row.access === 'private') {
      if (explicitVersion === undefined) {
        return refuse('invalid_relic_version', { relic_id: relicId });
      }
      let reach: 'all' | readonly number[];
      try {
        reach = await privateReach(row, request, now, body['publish_token']);
      } catch (error) {
        if (error instanceof ProblemError)
          return refuse(error.code, error.options);
        throw error;
      }
      if (reach !== 'all' && !reach.includes(commentVersion)) {
        return refuse('private_access_denied', { relic_id: relicId });
      }
    }

    // The one thing this server can check about a comment. The plaintext
    // caps live in `@relic/format` ahead of encryption and cannot be
    // re-derived from here, so validating the encoding is the whole of the
    // server's business with this field.
    const ciphertext = body['ciphertext'];
    if (!validCommentCiphertext(ciphertext)) {
      return refuse('invalid_comment', { relic_id: relicId });
    }
    const rawAddresses = body['addresses'];
    let addresses: string | undefined;
    if (rawAddresses !== undefined && rawAddresses !== null) {
      if (
        typeof rawAddresses !== 'string' ||
        rawAddresses.length === 0 ||
        new TextEncoder().encode(rawAddresses).length >
          COMMENT_ADDRESSES_LIMIT_BYTES
      ) {
        return refuse('invalid_comment', { relic_id: relicId });
      }
      addresses = rawAddresses;
    }

    const commentId = newCommentId();
    await store.putComment({
      id: commentId,
      relicId,
      author,
      createdAt: now,
      ciphertext,
      version: commentVersion,
      addresses,
    });

    try {
      await dispatchCommentNotifications({
        relicId,
        row,
        author,
        addresses,
        now,
      });
    } catch (error) {
      console.error(
        `relic: comment notification failed: ${sanitizeMailError(error)}`
      );
    }

    return json(
      {
        comment_id: commentId,
        author,
        created_at: new Date(now).toISOString(),
      },
      201
    );
  }

  async function dispatchCommentNotifications(params: {
    readonly relicId: string;
    readonly row: RelicRow;
    readonly author: string;
    readonly addresses: string | undefined;
    readonly now: number;
  }): Promise<void> {
    const { relicId, row, author, addresses, now } = params;
    await fanOutNotifications({
      relicId,
      row,
      now,
      event: { type: 'comment', author, addresses },
    });
  }

  function sanitizeMailError(error: unknown, recipient?: string): string {
    let message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : String(error);
    if (recipient !== undefined && recipient.length > 0) {
      const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      message = message.replace(
        new RegExp(escaped, 'gi'),
        '[redacted-recipient]'
      );
    }
    return message.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      '[redacted-email]'
    );
  }

  /**
   * Delete your own comment, and nobody else's.
   *
   * The operator's route to removing a comment is deleting the relic, which
   * takes the whole thread with it. There is deliberately no per-comment
   * operator surface: it would be a moderation capability, and moderation
   * needs permissions, which is still a locked non-goal.
   */
  async function deleteComment(
    rawId: string,
    commentId: string,
    request: Request,
    _now: number
  ): Promise<Response> {
    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    const existing = await store.getComment(relicId, commentId);
    if (existing === undefined) {
      return refuse('comment_not_found', {
        relic_id: relicId,
        comment_id: commentId,
      });
    }

    const row = await store.getRelic(relicId);
    const author = await resolveAuthor(
      (await readJson(request)) as Record<string, unknown>,
      request,
      row?.publishTokenHash ?? ''
    );
    if (author === undefined || author !== existing.author) {
      return refuse('comment_forbidden', {
        relic_id: relicId,
        comment_id: commentId,
      });
    }

    await store.deleteComment(relicId, commentId);
    if (author !== 'publisher' && looksLikeEmail(author)) {
      const normalized = author.trim().toLowerCase();
      const remaining = await store.listComments(relicId);
      const stillCommented = remaining.some(
        (c) => c.author.trim().toLowerCase() === normalized
      );
      if (!stillCommented) {
        await store.deleteCommenter(relicId, normalized);
      }
    }
    return new Response(null, { status: 204 });
  }
  /**
   * The one thing this server can check about a comment body, for both
   * write paths. The plaintext caps live in `@relic/format` ahead of
   * encryption and cannot be re-derived here, so validating the transport
   * encoding against the same cap in both places is the whole of the
   * server's business with the field, and the reason it is one function
   * rather than two copies that could drift apart.
   */
  function validCommentCiphertext(ciphertext: unknown): ciphertext is string {
    return (
      typeof ciphertext === 'string' &&
      isBase64Url(ciphertext) &&
      ciphertext.length <= config.commentCiphertextCapChars
    );
  }

  /**
   * Change a comment after the fact: replace its sealed body, or settle it
   * as resolved, or both in one call.
   *
   * There is no edit history (`frame.md`): the service holds one ciphertext
   * per comment and an edit overwrites it, so the honest thing on offer is
   * the fact that an edit happened, stamped `edited_at`, not the earlier
   * text. An edit is authorized for the comment's author alone, by the same
   * rule delete uses. Resolution is authorized for the author or the holder
   * of the relic's publish token, because a publisher settling feedback on
   * their own relic is the point of the state; it is deliberately clear
   * data, since it decides whether a republish is blocked, which this
   * server answers before any key exists on its side.
   */
  async function patchComment(
    rawId: string,
    commentId: string,
    request: Request,
    now: number
  ): Promise<Response> {
    if (config.killSwitchEngaged) {
      return refuse('service_paused', { retry_after_seconds: 300 });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }
    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    const existing = await store.getComment(relicId, commentId);
    if (existing === undefined) {
      return refuse('comment_not_found', {
        relic_id: relicId,
        comment_id: commentId,
      });
    }

    const raw = await readJson(request);
    const body: Record<string, unknown> =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const rawCiphertext = body['ciphertext'];
    const rawResolved = body['resolved'];
    if (rawCiphertext === undefined && rawResolved === undefined) {
      return refuse('nothing_to_change', {
        relic_id: relicId,
        comment_id: commentId,
      });
    }

    const author = await resolveAuthor(body, request, row.publishTokenHash);

    // The sealed body belongs to its author alone: the verified address
    // that made it, or the publish token when the comment was made as the
    // publisher. A session address can never equal `publisher`, so this one
    // comparison covers both credentials.
    if (rawCiphertext !== undefined) {
      if (author === undefined || author !== existing.author) {
        return refuse('comment_forbidden', {
          relic_id: relicId,
          comment_id: commentId,
        });
      }
    }

    // Settling feedback on your own relic is the point of the state, so the
    // publish token may resolve a comment its holder did not make.
    if (rawResolved !== undefined) {
      const mayResolve =
        author !== undefined &&
        (author === existing.author || author === 'publisher');
      if (!mayResolve) {
        return refuse('comment_forbidden', {
          relic_id: relicId,
          comment_id: commentId,
        });
      }
    }

    let patch: CommentPatch = {};
    if (rawCiphertext !== undefined) {
      if (!validCommentCiphertext(rawCiphertext)) {
        return refuse('invalid_comment', { relic_id: relicId });
      }
      patch = { ...patch, ciphertext: rawCiphertext, editedAt: now };
    }
    if (rawResolved !== undefined) {
      if (typeof rawResolved !== 'boolean') {
        return refuse('invalid_comment', { relic_id: relicId });
      }
      // Authorization has already established `author` for a resolution.
      patch = {
        ...patch,
        resolved: rawResolved ? { at: now, by: author as string } : null,
      };
    }

    const updated = await store.updateComment(relicId, commentId, patch);
    if (updated === undefined) {
      return refuse('comment_not_found', {
        relic_id: relicId,
        comment_id: commentId,
      });
    }

    return json({
      comment_id: updated.id,
      author: updated.author,
      created_at: new Date(updated.createdAt).toISOString(),
      edited_at:
        updated.editedAt === undefined
          ? null
          : new Date(updated.editedAt).toISOString(),
      resolved_at:
        updated.resolvedAt === undefined
          ? null
          : new Date(updated.resolvedAt).toISOString(),
      resolved_by: updated.resolvedBy ?? null,
    });
  }

  /**
   * Which identity is making this write, or undefined for none.
   *
   * Checked in the order the two paths cost: a publish token is a hash
   * comparison against a row already loaded, a session is a store read.
   */
  async function resolveAuthor(
    body: Record<string, unknown>,
    request: Request,
    publishTokenHash: string
  ): Promise<string | undefined> {
    const presented = body['publish_token'];
    if (typeof presented === 'string' && publishTokenHash !== '') {
      const hash = await sha256Hex(presented);
      if (timingSafeEqual(hash, publishTokenHash)) return 'publisher';
      return undefined;
    }

    const token = sessionCookie(request);
    if (token === undefined) return undefined;
    const session = await store.getSession(await sha256Hex(token));
    if (session === undefined) return undefined;
    if (session.expiresAt <= clock()) return undefined;
    return session.email;
  }

  // --- magic-link sign-in -------------------------------------------------

  /**
   * Ask for a sign-in link.
   *
   * Always 202, whatever happened. A different answer for a known and an
   * unknown address turns this endpoint into an address oracle, and there is
   * no version of that which is worth the marginally better error message.
   */
  async function authRequest(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const nonce = newAuthToken();
    const requestCookie = `relic_sign_in_request=${nonce}; Path=/api/auth/code; HttpOnly; Secure; SameSite=Strict; Max-Age=${config.authLinkTtlSeconds}`;

    const verdict = limiter.check(
      rateLimitKey('auth', ip),
      config.authRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('auth_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    const body = (await readJson(request)) as Record<string, unknown>;
    const email = body['email'];

    if (typeof email === 'string' && looksLikeEmail(email)) {
      const token = newAuthToken();
      const expiresAt = now + config.authLinkTtlSeconds * 1000;
      const linkTokenHash = await sha256Hex(token);
      await store.putAuthLink({
        tokenHash: linkTokenHash,
        email,
        expiresAt,
        returnTo: authReturnTo(body),
      });

      const code = newSignInCode();
      const requestHash = await signInRequestHash(nonce);
      const codeMac = await signInCodeMac(nonce, code);
      const addressHash = await sha256Hex(normalizeEmail(email));
      await store.putSignInCode({
        requestHash,
        codeMac,
        linkTokenHash,
        addressHash,
        expiresAt,
      });

      // The plaintext address reaches the mailer here, and that is not
      // avoidable: mail cannot be sent to a hash. `frame.md` names this as
      // one of identity's prices rather than pretending a stored hash undoes
      // it.
      //
      // A refusal from the provider must not become the response. The 202
      // above is the whole reason this endpoint is not an address oracle, and
      // a 500 for a deliverable address and a 202 for an undeliverable one
      // would rebuild the oracle out of error codes. So the failure goes to
      // the log, where the operator can see it and the caller cannot.
      if (mailer !== undefined) {
        try {
          await mailer.send(
            email,
            `${config.serviceOrigin}/api/auth/callback?token=${token}`,
            code
          );
        } catch (error) {
          // The subject now carries the code and the provider's refusal can
          // echo a subject or an address, so neither may reach the log.
          console.error(
            `relic: sign-in mail failed: ${sanitizeMailError(error, email).replaceAll(code, '[redacted-code]')}`
          );
        }
      }
    }

    const headers = new Headers();
    headers.set('set-cookie', requestCookie);
    return new Response(null, { status: 202, headers });
  }

  async function authCode(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const verdict = limiter.check(
      rateLimitKey('auth-code', ip),
      config.signInCodeRateLimit,
      now
    );
    if (!verdict.allowed) {
      return refuse('auth_rate_limited', {
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }

    const contentType = request.headers.get('content-type');
    if (
      contentType === null ||
      !contentType.toLowerCase().startsWith('application/json')
    ) {
      return refuse('invalid_sign_in_code');
    }

    let rawBody: unknown;
    try {
      rawBody = await readBoundedJson(request, 'invalid_sign_in_code');
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      return refuse('invalid_sign_in_code');
    }
    if (
      rawBody === null ||
      typeof rawBody !== 'object' ||
      Array.isArray(rawBody)
    ) {
      return refuse('invalid_sign_in_code');
    }
    const body = rawBody as Record<string, unknown>;
    const rawCode = body['code'];
    if (typeof rawCode !== 'string') {
      return refuse('invalid_sign_in_code');
    }
    const code = rawCode.replace(/[ -]/g, '');
    if (!/^[0-9]{6}$/.test(code)) {
      return refuse('invalid_sign_in_code');
    }

    // The request's `now` was taken when its headers arrived, and the body
    // can finish much later. Every time-dependent check below uses the time
    // the check runs, so a slow body cannot outlive the code or be charged to
    // an attempt window it was not in.
    const checkedAt = clock();
    const nonce = signInRequestCookie(request);
    if (nonce === undefined || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
      return refuse('sign_in_code_failed');
    }

    const requestHash = await signInRequestHash(nonce);
    const row = await store.getSignInCode(requestHash);
    if (row === undefined || row.expiresAt <= checkedAt) {
      return refuse('sign_in_code_failed');
    }

    let allowed: boolean;
    try {
      allowed = await store.reserveSignInCodeAttempt(
        row.addressHash,
        checkedAt,
        config.signInCodeAddressAttemptLimit.limit,
        config.signInCodeAddressAttemptLimit.windowSeconds * 1000
      );
    } catch {
      return new Response(null, { status: 500 });
    }
    if (!allowed) {
      return refuse('sign_in_code_failed');
    }

    const expectedMac = await signInCodeMac(nonce, code);
    if (!timingSafeEqual(expectedMac, row.codeMac)) {
      return refuse('sign_in_code_failed');
    }

    const link = await store.consumeAuthLink(row.linkTokenHash);
    await store.deleteSignInCode(row.requestHash);
    if (link === undefined || link.expiresAt <= checkedAt) {
      return refuse('sign_in_code_failed');
    }

    const readerCookie = await mintReaderSession(link.email, checkedAt, 'code');
    const offerCookie = passkeyOfferCookie();
    const clearRequestCookie =
      'relic_sign_in_request=; Path=/api/auth/code; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.append('set-cookie', readerCookie);
    headers.append('set-cookie', offerCookie);
    headers.append('set-cookie', clearRequestCookie);

    return new Response(JSON.stringify({ email: link.email }), {
      status: 200,
      headers,
    });
  }
  /** Mints a session cookie and persists the session row. */
  async function mintReaderSession(
    email: string,
    now: number,
    via: 'link' | 'passkey' | 'code'
  ): Promise<string> {
    const session = newAuthToken();
    await store.putSession({
      tokenHash: await sha256Hex(session),
      email,
      createdAt: now,
      expiresAt: now + config.sessionTtlSeconds * 1000,
      via,
    });
    await store.recordVerifiedIdentity(email, now);

    return [
      `relic_session=${session}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      `Max-Age=${config.sessionTtlSeconds}`,
    ].join('; ');
  }

  function mayAddFirstPasskey(session: SessionRow, now: number): boolean {
    const via = session.via ?? 'link';
    return (
      (via === 'link' || via === 'code') &&
      now - session.createdAt <= config.passkeyFreshLinkSeconds * 1000
    );
  }

  function passkeyOfferCookie(): string {
    return [
      'relic_passkey_offer=1',
      'Path=/',
      'Secure',
      'SameSite=Lax',
      `Max-Age=${config.passkeyOfferMarkerSeconds}`,
    ].join('; ');
  }

  async function sendPasskeyNotice(
    address: string,
    now: number,
    added: { readonly first: boolean; readonly passkeys: number }
  ): Promise<void> {
    if (mailer === undefined || typeof mailer.sendMail !== 'function') {
      if (!warnedPasskeyNoticeDisabled) {
        warnedPasskeyNoticeDisabled = true;
        console.warn(
          'relic: passkey notices are disabled: mailer has no sendMail'
        );
      }
      return;
    }
    const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `passkey notice timed out after ${config.passkeyNoticeTimeoutMs}ms`
          )
        ),
      config.passkeyNoticeTimeoutMs
    );
    try {
      await Promise.race([
        mailer.sendMail(
          address,
          passkeyAddedMail({ address, at: now, ...added })
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      console.error(
        `relic: passkey notice failed for recipient ${await sha256Hex(normalizeEmail(address))}: ${sanitizeMailError(error, address)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Follow the link: spend the token, mint a session, land back on the relic.
   *
   * The redirect target keeps whatever fragment the caller asked to return
   * to. The key lives in that fragment, so dropping it would leave a
   * verified reader unable to decrypt the thing they just signed in to
   * discuss.
   */
  async function authCallback(url: URL, now: number): Promise<Response> {
    const token = url.searchParams.get('token');
    if (token === null) return refuse('invalid_session');

    const link = await store.consumeAuthLink(await sha256Hex(token));
    if (link === undefined || link.expiresAt <= now) {
      return refuse('invalid_session');
    }

    const readerCookie = await mintReaderSession(link.email, now, 'link');
    const offerCookie = passkeyOfferCookie();

    const headers = new Headers();
    headers.set('location', link.returnTo);
    headers.append('set-cookie', readerCookie);
    headers.append('set-cookie', offerCookie);

    return new Response(null, {
      status: 303,
      headers,
    });
  }

  /**
   * First-paint identity. 200 with `email: null` when nobody is signed in,
   * never 401, because every anonymous load would otherwise hit a status
   * the public surface is not allowed to emit except on a write.
   */
  async function authSession(request: Request, now: number): Promise<Response> {
    const token = sessionCookie(request);
    if (token === undefined) return json({ email: null });
    const session = await store.getSession(await sha256Hex(token));
    if (session === undefined || session.expiresAt <= now) {
      return json({ email: null });
    }
    return json({ email: session.email });
  }

  /**
   * The caller's commented relics, for their dashboard.
   *
   * 401 when there is no valid session, RFC 9457 problem document.
   * Scope is strictly the caller's verified address.
   * Absent, tombstoned, and expired relics are filtered out.
   */
  async function authRelics(request: Request, now: number): Promise<Response> {
    const token = sessionCookie(request);
    if (token === undefined) return refuse('invalid_session');
    const session = await store.getSession(await sha256Hex(token));
    if (session === undefined || session.expiresAt <= now) {
      return refuse('invalid_session');
    }

    const commented = await store.listCommentedRelics(session.email);
    const items = await Promise.all(
      commented.map(async (entry) => {
        const [tombstone, row] = await Promise.all([
          store.getTombstone(entry.relicId),
          store.getRelic(entry.relicId),
        ]);
        if (tombstone !== undefined) return null;
        if (row === undefined) return null;
        if (row.expiresAt !== undefined && now >= row.expiresAt) return null;
        return {
          relic_id: row.id,
          title: row.title ?? null,
          renderer_class: row.rendererClass,
          version: row.version,
          published_at:
            row.publishedAt !== undefined
              ? new Date(row.publishedAt).toISOString()
              : null,
          expires_at:
            row.expiresAt !== undefined
              ? new Date(row.expiresAt).toISOString()
              : null,
          last_comment_at: new Date(entry.lastCommentAt).toISOString(),
        };
      })
    );

    const relics = items.filter(
      (item): item is NonNullable<typeof item> => item !== null
    );
    relics.sort(
      (a, b) =>
        b.last_comment_at.localeCompare(a.last_comment_at) ||
        (a.relic_id < b.relic_id ? -1 : 1)
    );

    return json({ relics });
  }

  // --- decisions and passkeys ---------------------------------------------

  const inFlightDigests = new Map<string, Promise<string | undefined>>();

  async function singleFlightDigest(
    relicId: string,
    version: number
  ): Promise<string | undefined> {
    const flightKey = `${relicId}:${version}`;
    const inFlight = inFlightDigests.get(flightKey);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const promise = (async () => {
      try {
        return await storage.digest(objectKey(relicId, version));
      } finally {
        inFlightDigests.delete(flightKey);
      }
    })();
    inFlightDigests.set(flightKey, promise);
    return promise;
  }

  async function digestOnRecord(
    row: RelicRow,
    version: number
  ): Promise<string> {
    const vKey = String(version);
    const existing = row.versionDigests?.[vKey];
    if (existing !== undefined) return existing;

    const key = objectKey(row.id, version);
    const stat = await storage.stat(key);
    if (stat === undefined) {
      throw new ProblemError('relic_not_yet_published', {
        relic_id: row.id,
        retry_after_seconds: 5,
      });
    }

    const digest = await singleFlightDigest(row.id, version);
    if (digest === undefined) {
      throw new ProblemError('relic_not_yet_published', {
        relic_id: row.id,
        retry_after_seconds: 5,
      });
    }

    const recorded = await store.recordVersionDigest(row.id, version, digest);
    return recorded ?? digest;
  }

  async function readBoundedJson(
    request: Request,
    malformedCode: ProblemError['code']
  ): Promise<unknown> {
    const MAX_BOUNDED_JSON_BYTES = 65_536;
    const clHeader = request.headers.get('content-length');
    if (clHeader !== null) {
      const cl = Number.parseInt(clHeader, 10);
      if (Number.isNaN(cl) || cl > MAX_BOUNDED_JSON_BYTES) {
        throw new ProblemError(malformedCode);
      }
    }
    if (!request.body) {
      return undefined;
    }
    let rawBytes: Uint8Array;
    try {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BOUNDED_JSON_BYTES) {
          await reader.cancel();
          throw new ProblemError(malformedCode);
        }
        chunks.push(value);
      }
      rawBytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        rawBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch (err) {
      if (err instanceof ProblemError) throw err;
      throw new ProblemError(malformedCode);
    }
    if (rawBytes.byteLength === 0) {
      return undefined;
    }
    let text: string;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      text = decoder.decode(rawBytes);
    } catch {
      throw new ProblemError(malformedCode);
    }
    if (text.trim().length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProblemError(malformedCode);
    }
  }

  function extractClientDataChallenge(credential: unknown): string {
    if (
      typeof credential !== 'object' ||
      credential === null ||
      typeof (credential as Record<string, unknown>)['response'] !== 'object' ||
      (credential as Record<string, unknown>)['response'] === null
    ) {
      throw new ProblemError('invalid_passkey', { passkey_check: 'shape' });
    }
    const resp = (credential as Record<string, unknown>)['response'] as Record<
      string,
      unknown
    >;
    if (typeof resp['clientDataJSON'] !== 'string') {
      throw new ProblemError('invalid_passkey', { passkey_check: 'shape' });
    }
    try {
      parseBase64url(resp['clientDataJSON']);
    } catch {
      throw new ProblemError('invalid_passkey', { passkey_check: 'encoding' });
    }
    let rawJson: string;
    try {
      rawJson = Buffer.from(resp['clientDataJSON'], 'base64url').toString(
        'utf-8'
      );
    } catch {
      throw new ProblemError('invalid_passkey', { passkey_check: 'encoding' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new ProblemError('invalid_passkey', { passkey_check: 'shape' });
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['challenge'] !== 'string'
    ) {
      throw new ProblemError('invalid_passkey', { passkey_check: 'shape' });
    }
    return (parsed as Record<string, unknown>)['challenge'] as string;
  }

  interface DecisionPrefixResult {
    readonly relicId: string;
    readonly row: RelicRow;
    readonly body: Record<string, unknown>;
    readonly email: string;
    readonly version: number;
    readonly verdict: DecisionVerdict;
  }

  async function checkDecisionPrefix(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<DecisionPrefixResult> {
    if (config.killSwitchEngaged) {
      throw new ProblemError('service_paused', { retry_after_seconds: 300 });
    }

    const ipVerdict = limiter.check(
      rateLimitKey('decision', ip),
      config.decisionRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      throw new ProblemError('decision_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      throw new ProblemError('invalid_relic_id');
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      throw new ProblemError('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      throw new ProblemError('relic_not_found', { relic_id: relicId });
    }

    if (row.expiresAt !== undefined && row.expiresAt <= now) {
      throw new ProblemError('relic_expired', { relic_id: relicId });
    }

    const parsedBody = await readBoundedJson(request, 'invalid_decision');
    if (
      parsedBody === null ||
      typeof parsedBody !== 'object' ||
      Array.isArray(parsedBody)
    ) {
      throw new ProblemError('invalid_decision', { relic_id: relicId });
    }
    const body = parsedBody as Record<string, unknown>;

    if ('publish_token' in body) {
      throw new ProblemError('decision_requires_reader', { relic_id: relicId });
    }

    const token = sessionCookie(request);
    if (token === undefined) {
      throw new ProblemError('sign_in_required', { relic_id: relicId });
    }
    const session = await store.getSession(await sha256Hex(token));
    if (session === undefined || session.expiresAt <= now) {
      throw new ProblemError('sign_in_required', { relic_id: relicId });
    }
    const email = normalizeEmail(session.email);

    const verdict = body['verdict'];
    if (verdict !== 'approve' && verdict !== 'reject') {
      throw new ProblemError('invalid_decision', { relic_id: relicId });
    }

    const version = body['version'];
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > row.version
    ) {
      throw new ProblemError('invalid_relic_version', { relic_id: relicId });
    }

    if (row.access === 'private') {
      // Readers of a private relic prove access by a live wrap, not a fragment proof (plan 4.7).
      await privateReach(row, request, now, undefined);
    } else {
      const proofResult = await checkShareProof(row, body['share_proof']);
      if (proofResult === 'unavailable') {
        throw new ProblemError('decision_unavailable', { relic_id: relicId });
      }
      if (proofResult === 'malformed') {
        throw new ProblemError('invalid_decision', { relic_id: relicId });
      }
      if (proofResult === 'mismatch') {
        throw new ProblemError('invalid_share_proof', { relic_id: relicId });
      }
    }

    return { relicId, row, body, email, version, verdict };
  }

  async function postDecisionOptions(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    try {
      const { relicId, row, email, version, verdict } =
        await checkDecisionPrefix(rawId, request, ip, now);

      const passkeyRecord = await store.getPasskeys(email);
      if (
        passkeyRecord === undefined ||
        passkeyRecord.credentials.length === 0
      ) {
        return refuse('passkey_required', { relic_id: relicId });
      }

      const digest = await digestOnRecord(row, version);

      const challengeBytes = new Uint8Array(32);
      crypto.getRandomValues(challengeBytes);
      const challenge = Buffer.from(challengeBytes).toString('base64url');
      const challengeHash = await sha256Hex(challenge);

      await store.putWebauthnChallenge({
        challengeHash,
        email,
        purpose: 'decide',
        expiresAt: now + config.passkeyChallengeTtlSeconds * 1000,
        relicId,
        version,
        verdict,
      });

      const rpId = new URL(config.serviceOrigin).hostname;

      return json({
        version,
        version_digest: digest,
        public_key: {
          challenge,
          rpId,
          timeout: 300000,
          userVerification: 'required',
          allowCredentials: passkeyRecord.credentials.map((c) => ({
            type: 'public-key',
            id: c.credentialId,
            transports:
              c.transports && c.transports.length > 0
                ? c.transports
                : ['internal'],
          })),
        },
      });
    } catch (error) {
      if (error instanceof ProblemError) {
        return refuse(error.code, error.options);
      }
      throw error;
    }
  }
  async function verifyStoredAssertion(
    record: PasskeyRecord,
    credential: unknown,
    clientChallenge: string,
    now: number
  ): Promise<
    | { ok: true; credentialId: string }
    | {
        ok: false;
        code: 'invalid_passkey' | 'passkey_verification_failed';
        check: string;
      }
  > {
    const credId = (credential as Record<string, unknown> | null | undefined)?.[
      'id'
    ];
    if (typeof credId !== 'string') {
      return { ok: false, code: 'invalid_passkey', check: 'shape' };
    }

    const cred = record.credentials.find((c) => c.credentialId === credId);
    if (cred === undefined) {
      return {
        ok: false,
        code: 'passkey_verification_failed',
        check: 'credential',
      };
    }

    const rpId = new URL(config.serviceOrigin).hostname;
    const origin = new URL(config.serviceOrigin).origin;

    let assertion: { credentialId: string; signCount: number };
    try {
      assertion = await verifyAssertion(credential, {
        challenge: clientChallenge,
        origin,
        rpId,
        stored: cred,
        userHandle: record.userHandle,
      });
    } catch (err) {
      if (err instanceof WebauthnError) {
        return {
          ok: false,
          code:
            err.kind === 'malformed'
              ? 'invalid_passkey'
              : 'passkey_verification_failed',
          check: err.check,
        };
      }
      return { ok: false, code: 'invalid_passkey', check: 'shape' };
    }

    try {
      await store.updatePasskeys(record.email, (current) => {
        const target = current.credentials.find(
          (c) => c.credentialId === cred.credentialId
        );
        if (
          target !== undefined &&
          (target.signCount > 0 || assertion.signCount > 0) &&
          assertion.signCount <= target.signCount
        ) {
          throw new ProblemError('passkey_verification_failed', {
            passkey_check: 'counter',
          });
        }
        return {
          ...current,
          credentials: current.credentials.map((c) =>
            c.credentialId === cred.credentialId
              ? { ...c, signCount: assertion.signCount, lastUsedAt: now }
              : c
          ),
        };
      });
    } catch (err) {
      if (err instanceof ProblemError) {
        const code =
          err.code === 'invalid_passkey'
            ? 'invalid_passkey'
            : 'passkey_verification_failed';
        return {
          ok: false,
          code,
          check: err.options.passkey_check ?? 'counter',
        };
      }
      throw err;
    }

    return { ok: true, credentialId: cred.credentialId };
  }

  async function postDecision(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    try {
      const { relicId, row, body, email, version, verdict } =
        await checkDecisionPrefix(rawId, request, ip, now);

      const clientDigest = body['version_digest'];
      if (
        typeof clientDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(clientDigest)
      ) {
        return refuse('invalid_decision', { relic_id: relicId });
      }

      const credential = body['credential'];
      if (
        typeof credential !== 'object' ||
        credential === null ||
        Array.isArray(credential)
      ) {
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }

      const passkeyRecord = await store.getPasskeys(email);
      if (
        passkeyRecord === undefined ||
        passkeyRecord.credentials.length === 0
      ) {
        return refuse('passkey_required', { relic_id: relicId });
      }

      let clientChallenge: string;
      try {
        clientChallenge = extractClientDataChallenge(credential);
      } catch (err) {
        if (err instanceof ProblemError) {
          return refuse(err.code, err.options);
        }
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }

      const challengeHash = await sha256Hex(clientChallenge);
      const challengeRow = await store.consumeWebauthnChallenge(challengeHash);
      if (
        challengeRow === undefined ||
        challengeRow.purpose !== 'decide' ||
        challengeRow.email !== email ||
        challengeRow.relicId !== relicId ||
        challengeRow.version !== version ||
        challengeRow.verdict !== verdict ||
        challengeRow.expiresAt < now
      ) {
        return refuse('passkey_verification_failed', {
          passkey_check: 'challenge',
        });
      }

      const verified = await verifyStoredAssertion(
        passkeyRecord,
        credential,
        clientChallenge,
        now
      );
      if (!verified.ok) {
        return refuse(verified.code, { passkey_check: verified.check });
      }

      const recordDigest = await digestOnRecord(row, version);
      if (clientDigest !== recordDigest) {
        return refuse('decision_digest_mismatch', {
          relic_id: relicId,
          version,
          version_digest: recordDigest,
        });
      }

      const decisionId = Buffer.from(
        crypto.getRandomValues(new Uint8Array(16))
      ).toString('base64url');
      const createdAt = now;
      const decisionRow: DecisionRow = {
        id: decisionId,
        relicId,
        version,
        verdict,
        author: email,
        createdAt,
        versionDigest: recordDigest,
        credentialId: verified.credentialId,
      };
      const tombstoneBefore = await store.getTombstone(relicId);
      if (tombstoneBefore !== undefined) {
        return refuse('relic_removed', {
          relic_id: relicId,
          report_url: `${config.serviceOrigin}/abuse`,
        });
      }

      await store.appendDecision(decisionRow);

      const tombstoneAfter = await store.getTombstone(relicId);
      if (tombstoneAfter !== undefined) {
        try {
          await store.deleteDecision(relicId, decisionId);
        } catch {
          // best-effort cleanup
        }
        return refuse('relic_removed', {
          relic_id: relicId,
          report_url: `${config.serviceOrigin}/abuse`,
        });
      }
      return json(
        {
          relic_id: relicId,
          id: decisionId,
          version,
          verdict,
          author: email,
          created_at: new Date(createdAt).toISOString(),
          version_digest: recordDigest,
        },
        201
      );
    } catch (error) {
      if (error instanceof ProblemError) {
        return refuse(error.code, error.options);
      }
      throw error;
    }
  }

  async function listDecisions(
    rawId: string,
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const ipVerdict = limiter.check(
      rateLimitKey('decision-read', ip),
      config.decisionReadRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return refuse('decision_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return refuse('invalid_relic_id');
    }

    if ((await store.getTombstone(relicId)) !== undefined) {
      return refuse('relic_removed', {
        relic_id: relicId,
        report_url: `${config.serviceOrigin}/abuse`,
      });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    let body: Record<string, unknown>;
    try {
      const parsedBody = await readBoundedJson(request, 'invalid_decision');
      if (
        parsedBody === null ||
        typeof parsedBody !== 'object' ||
        Array.isArray(parsedBody)
      ) {
        return refuse('invalid_decision', { relic_id: relicId });
      }
      body = parsedBody as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      return refuse('invalid_decision', { relic_id: relicId });
    }

    const proofResult = await checkShareProof(row, body['share_proof']);
    if (proofResult === 'unavailable') {
      return refuse('decision_unavailable', { relic_id: relicId });
    }
    if (proofResult === 'malformed') {
      return refuse('invalid_decision', { relic_id: relicId });
    }
    if (proofResult === 'mismatch') {
      return refuse('invalid_share_proof', { relic_id: relicId });
    }

    const rawVersion = body['version'];
    let targetVersion: number | '*';
    if (rawVersion === undefined) {
      targetVersion = row.version;
    } else if (rawVersion === '*') {
      targetVersion = '*';
    } else if (
      typeof rawVersion === 'number' &&
      Number.isSafeInteger(rawVersion) &&
      rawVersion >= 1 &&
      rawVersion <= row.version
    ) {
      targetVersion = rawVersion;
    } else {
      return refuse('invalid_relic_version', { relic_id: relicId });
    }

    const allDecisions = await store.listDecisions(relicId);
    const filtered =
      targetVersion === '*'
        ? [...allDecisions]
        : allDecisions.filter((d) => d.version === targetVersion);

    filtered.sort(
      (a, b) =>
        a.version - b.version ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
    );

    return json({
      relic_id: relicId,
      current_version: row.version,
      decisions: filtered.map((d) => ({
        id: d.id,
        version: d.version,
        verdict: d.verdict,
        author: d.author,
        created_at: new Date(d.createdAt).toISOString(),
        version_digest: d.versionDigest,
      })),
    });
  }

  async function postPasskeyOptions(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const token = sessionCookie(request);
    if (token === undefined) {
      return refuse('sign_in_required');
    }
    const session = await store.getSession(await sha256Hex(token));
    if (session === undefined || session.expiresAt <= now) {
      return refuse('sign_in_required');
    }
    const email = normalizeEmail(session.email);

    const ipVerdict = limiter.check(
      rateLimitKey('passkey', ip),
      config.passkeyRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return refuse('passkey_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed = await readBoundedJson(request, 'invalid_passkey');
      if (parsed !== undefined) {
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          return refuse('invalid_passkey', { passkey_check: 'shape' });
        }
        body = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    const rpId = new URL(config.serviceOrigin).hostname;

    const hasCredential =
      'credential' in body && body['credential'] !== undefined;
    // A replacement passkey for private shares (4.4): the existing passkey
    // proves the session, and the new credential may duplicate an old one so
    // the identity can be re-keyed. Only the create branch reads this.
    const forPrivateShares = body['for_private_shares'] === true;

    if (hasCredential) {
      const credential = body['credential'];
      if (
        typeof credential !== 'object' ||
        credential === null ||
        Array.isArray(credential)
      ) {
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }

      const passkeyRecord = await store.getPasskeys(email);
      if (
        passkeyRecord === undefined ||
        passkeyRecord.credentials.length === 0
      ) {
        return refuse('passkey_required');
      }

      let clientChallenge: string;
      try {
        clientChallenge = extractClientDataChallenge(credential);
      } catch (err) {
        if (err instanceof ProblemError) {
          return refuse(err.code, err.options);
        }
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }

      const challengeHash = await sha256Hex(clientChallenge);
      const challengeRow = await store.consumeWebauthnChallenge(challengeHash);
      if (
        challengeRow === undefined ||
        challengeRow.purpose !== 'enroll' ||
        challengeRow.email !== email ||
        challengeRow.expiresAt < now
      ) {
        return refuse('passkey_verification_failed', {
          passkey_check: 'challenge',
        });
      }

      const verified = await verifyStoredAssertion(
        passkeyRecord,
        credential,
        clientChallenge,
        now
      );
      if (!verified.ok) {
        return refuse(verified.code, { passkey_check: verified.check });
      }

      const challengeBytes = new Uint8Array(32);
      crypto.getRandomValues(challengeBytes);
      const newChallenge = Buffer.from(challengeBytes).toString('base64url');
      const newChallengeHash = await sha256Hex(newChallenge);

      await store.putWebauthnChallenge({
        challengeHash: newChallengeHash,
        email,
        purpose: 'register',
        assertedBy: verified.credentialId,
        userHandle: passkeyRecord.userHandle,
        expiresAt: now + config.passkeyChallengeTtlSeconds * 1000,
      });

      return json({
        mode: 'create',
        public_key: {
          challenge: newChallenge,
          rp: { id: rpId, name: 'Relic' },
          user: {
            id: passkeyRecord.userHandle,
            name: email,
            displayName: email,
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 300000,
          attestation: 'none',
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
          excludeCredentials: forPrivateShares
            ? []
            : passkeyRecord.credentials.map((c) => ({
                type: 'public-key',
                id: c.credentialId,
                transports:
                  c.transports && c.transports.length > 0
                    ? c.transports
                    : ['internal'],
              })),
          extensions: { prf: {} },
        },
      });
    }

    const passkeyRecord = await store.getPasskeys(email);
    if (passkeyRecord === undefined || passkeyRecord.credentials.length === 0) {
      if (!mayAddFirstPasskey(session, now)) {
        return refuse('passkey_fresh_link_required');
      }
      const userHandleBytes = new Uint8Array(32);
      crypto.getRandomValues(userHandleBytes);
      const userHandle = Buffer.from(userHandleBytes).toString('base64url');

      const challengeBytes = new Uint8Array(32);
      crypto.getRandomValues(challengeBytes);
      const challenge = Buffer.from(challengeBytes).toString('base64url');
      const challengeHash = await sha256Hex(challenge);

      await store.putWebauthnChallenge({
        challengeHash,
        email,
        purpose: 'register',
        userHandle,
        expiresAt: now + config.passkeyChallengeTtlSeconds * 1000,
      });

      return json({
        mode: 'create',
        public_key: {
          challenge,
          rp: { id: rpId, name: 'Relic' },
          user: { id: userHandle, name: email, displayName: email },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 300000,
          attestation: 'none',
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
          excludeCredentials: [],
          extensions: { prf: {} },
        },
      });
    }

    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challenge = Buffer.from(challengeBytes).toString('base64url');
    const challengeHash = await sha256Hex(challenge);

    await store.putWebauthnChallenge({
      challengeHash,
      email,
      purpose: 'enroll',
      expiresAt: now + config.passkeyChallengeTtlSeconds * 1000,
    });

    return json({
      mode: 'assert',
      public_key: {
        challenge,
        rpId,
        timeout: 300000,
        userVerification: 'required',
        allowCredentials: passkeyRecord.credentials.map((c) => ({
          type: 'public-key',
          id: c.credentialId,
          transports:
            c.transports && c.transports.length > 0
              ? c.transports
              : ['internal'],
        })),
      },
    });
  }

  async function postPasskey(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const token = sessionCookie(request);
    if (token === undefined) {
      return refuse('sign_in_required');
    }
    const session = await store.getSession(await sha256Hex(token));
    if (session === undefined || session.expiresAt <= now) {
      return refuse('sign_in_required');
    }
    const email = normalizeEmail(session.email);

    const ipVerdict = limiter.check(
      rateLimitKey('passkey', ip),
      config.passkeyRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return refuse('passkey_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readBoundedJson(request, 'invalid_passkey');
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    const credential = body['credential'];
    if (
      typeof credential !== 'object' ||
      credential === null ||
      Array.isArray(credential)
    ) {
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    let clientChallenge: string;
    try {
      clientChallenge = extractClientDataChallenge(credential);
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    const challengeHash = await sha256Hex(clientChallenge);
    const challengeRow = await store.consumeWebauthnChallenge(challengeHash);
    if (
      challengeRow === undefined ||
      challengeRow.purpose !== 'register' ||
      challengeRow.email !== email ||
      challengeRow.expiresAt < now
    ) {
      return refuse('passkey_verification_failed', {
        passkey_check: 'challenge',
      });
    }

    const rpId = new URL(config.serviceOrigin).hostname;
    const origin = new URL(config.serviceOrigin).origin;

    let verified: {
      credentialId: string;
      publicKeyJwk: JsonWebKey;
      alg: -7 | -257;
      signCount: number;
      transports: readonly string[];
    };
    try {
      verified = await verifyRegistration(credential, {
        challenge: clientChallenge,
        origin,
        rpId,
      });
    } catch (err) {
      if (err instanceof WebauthnError) {
        return refuse(
          err.kind === 'malformed'
            ? 'invalid_passkey'
            : 'passkey_verification_failed',
          { passkey_check: err.check }
        );
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    if (challengeRow.assertedBy === undefined) {
      const userHandle =
        challengeRow.userHandle ??
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          'base64url'
        );

      const newCred: PasskeyCredential = {
        credentialId: verified.credentialId,
        publicKeyJwk: verified.publicKeyJwk,
        alg: verified.alg,
        signCount: verified.signCount,
        transports: verified.transports,
        createdAt: now,
      };

      const record: PasskeyRecord = {
        email,
        address: session.email,
        userHandle,
        credentials: [newCred],
      };

      const created = await store.createPasskeys(record);
      if (!created) {
        return refuse('passkey_assertion_required');
      }
      await sendPasskeyNotice(session.email, now, { first: true, passkeys: 1 });
      return json(
        {
          email,
          credential_id: verified.credentialId,
          created_at: new Date(now).toISOString(),
          passkeys: 1,
        },
        201
      );
    }

    const assertedBy = challengeRow.assertedBy;
    try {
      const updated = await store.updatePasskeys(email, (current) => {
        const hasAsserted = current.credentials.some(
          (c) => c.credentialId === assertedBy
        );
        if (!hasAsserted) {
          throw new ProblemError('passkey_verification_failed', {
            passkey_check: 'credential',
          });
        }
        const isDuplicate = current.credentials.some(
          (c) => c.credentialId === verified.credentialId
        );
        if (isDuplicate) {
          throw new ProblemError('passkey_verification_failed', {
            passkey_check: 'credential',
          });
        }
        const newCred: PasskeyCredential = {
          credentialId: verified.credentialId,
          publicKeyJwk: verified.publicKeyJwk,
          alg: verified.alg,
          signCount: verified.signCount,
          transports: verified.transports,
          createdAt: now,
          registeredWith: assertedBy,
        };
        return {
          ...current,
          credentials: [...current.credentials, newCred],
        };
      });

      if (updated === undefined) {
        return refuse('passkey_required');
      }
      await sendPasskeyNotice(session.email, now, {
        first: false,
        passkeys: updated.credentials.length,
      });
      return json(
        {
          email,
          credential_id: verified.credentialId,
          created_at: new Date(now).toISOString(),
          passkeys: updated.credentials.length,
        },
        201
      );
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      throw err;
    }
  }

  async function signInAllowList(
    norm: string
  ): Promise<PasskeyDescriptorJSON[]> {
    const [passkeyRecord, decoyKey] = await Promise.all([
      store.getPasskeys(norm),
      store.passkeyDecoyKey(),
    ]);

    const size = config.passkeySignInAllowListSize;
    const n = config.passkeyDecoyIdLengths.length;

    const decoys: PasskeyDescriptorJSON[] = [];
    for (let i = 0; i < size; i++) {
      const lenSig = await hmacSha256(
        decoyKey,
        `relic-passkey-decoy:v1:length:${norm}:${i}`
      );
      const lenIdx = (lenSig[0] ?? 0) % n;
      const len = config.passkeyDecoyIdLengths[lenIdx] ?? 32;

      const chunks: Uint8Array[] = [];
      let gathered = 0;
      let j = 0;
      while (gathered < len) {
        const block = await hmacSha256(
          decoyKey,
          `relic-passkey-decoy:v1:id:${norm}:${i}:${j}`
        );
        chunks.push(block);
        gathered += block.length;
        j++;
      }
      const full = new Uint8Array(gathered);
      let offset = 0;
      for (const chunk of chunks) {
        full.set(chunk, offset);
        offset += chunk.length;
      }
      const id = Buffer.from(full.subarray(0, len)).toString('base64url');
      decoys.push({ type: 'public-key', id });
    }

    const realDescriptors: PasskeyDescriptorJSON[] = (
      passkeyRecord?.credentials ?? []
    ).map((c) => ({
      type: 'public-key',
      id: c.credentialId,
    }));

    const neededDecoys = Math.max(0, size - realDescriptors.length);
    const combined = [...realDescriptors, ...decoys.slice(0, neededDecoys)];
    combined.sort((a, b) => a.id.localeCompare(b.id));
    return combined;
  }

  async function postPasskeySignInOptions(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const ipVerdict = limiter.check(
      rateLimitKey('passkey-sign-in-options', ip),
      config.passkeySignInOptionsRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return refuse('passkey_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed = await readBoundedJson(request, 'invalid_passkey');
      if (parsed !== undefined) {
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          return refuse('invalid_passkey', { passkey_check: 'shape' });
        }
        body = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(
          err.code,
          err.options?.passkey_check ? err.options : { passkey_check: 'shape' }
        );
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    let email: string | undefined;
    if ('email' in body && body['email'] !== undefined) {
      if (
        typeof body['email'] !== 'string' ||
        body['email'].length > 320 ||
        !looksLikeEmail(body['email'])
      ) {
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }
      email = body['email'];
      const emailHash = await sha256Hex(normalizeEmail(email));
      const addressVerdict = addressLimiter.check(
        `passkey-sign-in-options-email ${emailHash}`,
        config.passkeySignInOptionsAddressRateLimit,
        now
      );
      if (!addressVerdict.allowed) {
        return refuse('passkey_rate_limited', {
          retry_after_seconds: addressVerdict.retryAfterSeconds,
        });
      }
    }

    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challenge = Buffer.from(challengeBytes).toString('base64url');
    const challengeHash = await sha256Hex(challenge);

    await store.putWebauthnChallenge({
      challengeHash,
      purpose: 'sign_in',
      expiresAt: now + config.passkeyChallengeTtlSeconds * 1000,
      ...(email !== undefined ? { email: normalizeEmail(email) } : {}),
    });

    const allowCredentials =
      email !== undefined ? await signInAllowList(normalizeEmail(email)) : [];

    const rpId = new URL(config.serviceOrigin).hostname;
    return json({
      public_key: {
        challenge,
        rpId,
        timeout: config.passkeyChallengeTtlSeconds * 1000,
        userVerification: 'required',
        allowCredentials,
      },
    });
  }

  async function postPasskeySignIn(
    request: Request,
    ip: string,
    now: number
  ): Promise<Response> {
    const ipVerdict = limiter.check(
      rateLimitKey('passkey-sign-in', ip),
      config.passkeySignInRateLimit,
      now
    );
    if (!ipVerdict.allowed) {
      return refuse('passkey_rate_limited', {
        retry_after_seconds: ipVerdict.retryAfterSeconds,
      });
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readBoundedJson(request, 'invalid_passkey');
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return refuse('invalid_passkey', { passkey_check: 'shape' });
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(
          err.code,
          err.options?.passkey_check ? err.options : { passkey_check: 'shape' }
        );
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    const credential = body['credential'];
    if (
      typeof credential !== 'object' ||
      credential === null ||
      Array.isArray(credential)
    ) {
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    let clientChallenge: string;
    try {
      clientChallenge = extractClientDataChallenge(credential);
    } catch (err) {
      if (err instanceof ProblemError) {
        return refuse(err.code, err.options);
      }
      return refuse('invalid_passkey', { passkey_check: 'shape' });
    }

    const challengeHash = await sha256Hex(clientChallenge);
    const challengeRow = await store.consumeWebauthnChallenge(challengeHash);
    if (
      challengeRow === undefined ||
      challengeRow.purpose !== 'sign_in' ||
      challengeRow.expiresAt <= now
    ) {
      return refuse('passkey_sign_in_failed');
    }

    let record: PasskeyRecord | undefined;
    if (challengeRow.email !== undefined) {
      const addressHash = await sha256Hex(normalizeEmail(challengeRow.email));
      const addressVerdict = addressLimiter.check(
        `passkey-sign-in-email ${addressHash}`,
        config.passkeySignInAddressRateLimit,
        now
      );
      if (!addressVerdict.allowed) {
        return refuse('passkey_rate_limited', {
          retry_after_seconds: addressVerdict.retryAfterSeconds,
        });
      }
      record = await store.getPasskeys(challengeRow.email);
    } else {
      const resp = (credential as Record<string, unknown>)['response'] as
        | Record<string, unknown>
        | undefined;
      const userHandle = resp?.['userHandle'];
      if (
        typeof userHandle !== 'string' ||
        !/^[A-Za-z0-9_-]{1,86}$/.test(userHandle)
      ) {
        return refuse('passkey_sign_in_failed');
      }
      record = await store.getPasskeysByUserHandle(userHandle);
      if (record !== undefined) {
        const handleHash = await sha256Hex(userHandle);
        const handleVerdict = addressLimiter.check(
          `passkey-sign-in-handle ${handleHash}`,
          config.passkeySignInHandleRateLimit,
          now
        );
        if (!handleVerdict.allowed) {
          // Usernameless sign-in only learns the target record after loading
          // by userHandle. Refusing with 429 here would become an oracle,
          // revealing whether the probed userHandle exists. Refuse with the
          // identical 401 passkey_sign_in_failed as unknown records.
          return refuse('passkey_sign_in_failed');
        }
      }
    }

    if (record === undefined) {
      return refuse('passkey_sign_in_failed');
    }

    const verified = await verifyStoredAssertion(
      record,
      credential,
      clientChallenge,
      now
    );
    if (!verified.ok) {
      return refuse('passkey_sign_in_failed');
    }

    const address = record.address ?? record.email;
    const cookie = await mintReaderSession(address, now, 'passkey');

    return new Response(JSON.stringify({ email: address }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': cookie,
      },
    });
  }
  // --- helpers ------------------------------------------------------------

  function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function refuse(
    code: ProblemError['code'],
    options: ConstructorParameters<typeof ProblemError>[1] = {}
  ): Response {
    return problemResponse(
      new ProblemError(code, options),
      config.serviceOrigin
    );
  }

  async function logAndRefuse(
    relicId: string,
    ip: string,
    now: number,
    occurrenceId: string,
    code: ProblemError['code'],
    options: ConstructorParameters<typeof ProblemError>[1] = {}
  ): Promise<Response> {
    const entry: MintLogEntry = {
      relicId,
      ip,
      at: now,
      endpoint: 'mint',
      outcome: 'refused',
      code,
      // A refused mint is never an open and never consumes the cap.
      countedAsOpen: false,
      dropReason: 'refused',
      consumedCap: false,
      capRemaining: config.downloadCap,
      occurrenceId,
    };
    await store.appendMintLog(entry);
    return problemResponse(
      new ProblemError(code, options),
      config.serviceOrigin,
      occurrenceId
    );
  }
  function coverNotFound(): Response {
    return new Response('Not found', {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
      },
    });
  }

  async function coverRoute(
    rawId: string,
    name: string,
    request: Request,
    now: number
  ): Promise<Response> {
    const nameMatch = /^([0-9a-f]{64})\.(png|jpg)$/.exec(name);
    if (nameMatch === null) {
      return coverNotFound();
    }
    const expectedSha256 = nameMatch[1];
    const expectedExt = nameMatch[2];

    let relicId: string;
    try {
      relicId = parseRelicId(rawId);
    } catch {
      return coverNotFound();
    }

    let tombstone: Tombstone | undefined;
    let row: RelicRow | undefined;
    try {
      tombstone = await store.getTombstone(relicId);
      if (tombstone !== undefined) return coverNotFound();
      row = await store.getRelic(relicId);
    } catch {
      return new Response('Service unavailable', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }

    if (row === undefined) return coverNotFound();
    if (row.expiresAt !== undefined && now >= row.expiresAt) {
      return coverNotFound();
    }
    if (row.cover === undefined) return coverNotFound();
    if (row.cover.version !== row.version) return coverNotFound();
    if (row.cover.sha256 !== expectedSha256) return coverNotFound();
    if (coverExtension(row.cover.type) !== expectedExt) return coverNotFound();

    let bytes: Uint8Array | undefined;
    try {
      bytes = await store.getCoverBytes(relicId, row.cover.sha256);
    } catch {
      return new Response('Service unavailable', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }

    if (bytes === undefined) return coverNotFound();

    const headers = {
      'content-type': row.cover.type,
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'content-security-policy': "default-src 'none'; sandbox",
    };

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(bytes as unknown as BodyInit, { status: 200, headers });
  }

  return {
    config,
    store,
    storage,
    limiter,
    addressLimiter,
    fetch: handle,
  };
}

/**
 * Derives the trusted client IP from the incoming request.
 *
 * In production on relik.link, traffic arrives through a Google Cloud Global
 * External Application Load Balancer in front of Cloud Run
 * (see deploy/terraform/resource.google_compute_lb.service.tf and
 * deploy/terraform/modules/relic/module.service.tf).
 *
 * Google Cloud Load Balancing documentation: External Application Load Balancer
 * overview, "X-Forwarded-For header"
 * (https://cloud.google.com/load-balancing/docs/https#x-forwarded-for_header):
 *   "The load balancer appends two IP addresses to the X-Forwarded-For header,
 *    separated by a single comma, in the following order:
 *    1. The IP address of the client that connects to the load balancer
 *    2. The IP address of the load balancer's forwarding rule
 *    ...
 *    If the incoming request already includes an X-Forwarded-For header,
 *    the load balancer appends its values to the existing header:
 *    X-Forwarded-For: <existing-value>,<client-ip>,<load-balancer-ip>"
 *
 * For direct Cloud Run without an external load balancer, the platform appends
 * the client IP as the last hop:
 * (https://cloud.google.com/run/docs/triggering/https-request):
 *   X-Forwarded-For: <existing-value>, <client-ip>
 *
 * We count hops from the right based on config.trustedProxyHops:
 * - External Application Load Balancer: 2 hops from the right (index -2).
 * - Direct Cloud Run: 1 hop from the right (index -1).
 * - Local or dev without proxy: 0 (or no proxy header), falling back to X-Real-IP
 *   or 127.0.0.1.
 *
 * Entries to the left of the trusted hop are caller-controlled and never trusted.
 * If the header contains fewer entries than trustedProxyHops, the caller did
 * not transit the expected proxy chain, so the header cannot be trusted; we fall
 * back to X-Real-IP or 127.0.0.1.
 */
export function clientIp(request: Request, config: RelicConfig): string {
  const hops = config.trustedProxyHops;
  if (hops > 0) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded !== null) {
      const entries = forwarded
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (entries.length >= hops) {
        const candidate = entries[entries.length - hops];
        if (candidate !== undefined) return candidate;
      }
    }
  }
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp !== undefined && realIp.length > 0) return realIp;
  return '127.0.0.1';
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function optional(value: FormDataEntryValue | null): string | undefined {
  if (value === null) return undefined;
  const text = String(value);
  return text.length === 0 ? undefined : text;
}

/** Accept a full URL and strip the origin and everything from `#`. */
export function stripToRelicId(submitted: string): string {
  const withoutFragment = submitted.split('#')[0] ?? '';
  const trimmed = withoutFragment.trim();
  try {
    const url = new URL(trimmed);
    return url.pathname.split('/').filter((s) => s.length > 0)[0] ?? '';
  } catch {
    return (
      trimmed
        .split('/')
        .filter((s) => s.length > 0)
        .pop() ?? trimmed
    );
  }
}

function iso(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}

/**
 * The storage object name for one version of a relic's ciphertext.
 *
 * Version 1 keeps the bare path the bucket already serves objects from;
 * versions 2 and up add a suffix. This is pinned by what production already
 * holds, not open to choice here: five objects live at the bare path and
 * must keep resolving, so the layout rule is backward compatibility rather
 * than a migration.
 */
function objectKey(relicId: string, version: number): string {
  return version === 1 ? relicId : `${relicId}/v${version}`;
}

/** The relic's bearer credential for republishing: 32 random bytes. */
function mintPublishToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // base64url: the token travels in JSON bodies, and this alphabet holds no
  // character a JSON string or a shell would treat specially.
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as BufferSource
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time equality, for the publish token's hash comparison.
 *
 * Both sides are fixed-length hex digests, so even the length branch
 * discloses nothing, and an attacker timing wrong-token responses gets no
 * prefix oracle on the one credential this surface checks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let index = 0; index < a.length && index < b.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function hmacSha256(
  keyBytes: Uint8Array,
  message: string
): Promise<Uint8Array> {
  const buf = keyBytes.slice().buffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    buf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message)
  );
  return new Uint8Array(signature);
}

/**
 * A relic with no publisher-set lifetime never expires, and `null` is how
 * the wire says so. Any string in this slot would read as a deadline the
 * server has stopped enforcing, which is a different claim than having none.
 * Three emissions share this rule, so they cannot drift apart inline.
 */
function relicExpiryIso(epochMillis: number | undefined): string | null {
  return epochMillis === undefined ? null : iso(epochMillis);
}

const CARD_IMAGE_ALT =
  "Relic's accession label with an empty field stack: a relic's record with nothing filled in.";

async function shell(
  config: RelicConfig,
  target:
    | string
    | { readonly view: 'dashboard' }
    | {
        readonly view: 'document';
        readonly path: string;
        readonly title: string;
        readonly description: string;
      },
  store?: RelicStore,
  now = Date.now()
): Promise<Response> {
  // A static shell. No mint happens here, which is what keeps non-executing
  // link fetchers off the open counter and the download cap.
  let storedTitle: string | undefined;
  let storedRendererClass: RendererClass | undefined;
  let storedPrivate = false;
  let storedCover: RelicCover | undefined;
  let canonicalId: string | undefined;

  if (typeof target === 'string') {
    try {
      canonicalId = parseRelicId(target);
    } catch {
      canonicalId = undefined;
    }
    if (store !== undefined && canonicalId !== undefined) {
      try {
        const tombstone = await store.getTombstone(canonicalId);
        if (tombstone === undefined) {
          const row = await store.getRelic(canonicalId);
          if (row !== undefined && row.access === 'private') {
            // The regulated profile shows no title, cover or class (plan 4.13).
            storedPrivate = true;
          } else if (row !== undefined) {
            const isExpired =
              row.expiresAt !== undefined && now >= row.expiresAt;
            if (!isExpired) {
              storedRendererClass = row.rendererClass;
              if (row.title !== undefined && row.title.length > 0) {
                storedTitle = row.title;
              }
              if (
                row.cover !== undefined &&
                row.cover.version === row.version
              ) {
                storedCover = row.cover;
              }
            }
          }
        }
      } catch {
        // A store read failure must still serve the shell with the constant card,
        // never a 500.
        storedTitle = undefined;
        storedRendererClass = undefined;
        storedCover = undefined;
      }
    }
  }

  const serviceOrigin = config.serviceOrigin.replace(/\/+$/, '');
  const doc =
    typeof target === 'string' || target.view !== 'document'
      ? undefined
      : target;
  const ogUrl =
    typeof target === 'string'
      ? canonicalId !== undefined
        ? `${serviceOrigin}/${canonicalId}`
        : `${serviceOrigin}/`
      : doc !== undefined
        ? `${serviceOrigin}${doc.path}`
        : `${serviceOrigin}/dashboard`;
  const ogImage =
    storedCover !== undefined && canonicalId !== undefined
      ? `${serviceOrigin}/${canonicalId}/cover/${storedCover.sha256}.${coverExtension(storedCover.type)}`
      : `${serviceOrigin}/assets/card.v1.png`;
  const ogImageType =
    storedCover !== undefined ? storedCover.type : 'image/png';
  const ogImageAlt =
    storedCover !== undefined ? COVER_ALT[storedCover.kind] : CARD_IMAGE_ALT;
  const card = storedPrivate ? PRIVATE_CARD : cardCopy(storedRendererClass);
  const cardTitle = doc?.title ?? storedTitle ?? card.title;
  const cardDescription = doc?.description ?? card.description;
  const documentTitle =
    doc !== undefined
      ? `${doc.title} · Relic`
      : storedTitle !== undefined
        ? `${storedTitle} · Relic`
        : storedRendererClass !== undefined
          ? card.title
          : 'Relic';

  const baseRootAttributes =
    typeof target === 'string'
      ? canonicalId !== undefined
        ? `data-relic-id="${escapeHtml(canonicalId)}" data-usercontent-origin="${escapeHtml(
            new URL(config.usercontentOrigin).origin
          )}"`
        : `data-usercontent-origin="${escapeHtml(
            new URL(config.usercontentOrigin).origin
          )}"`
      : doc !== undefined
        ? `data-view="document" data-document="${escapeHtml(doc.path)}" data-usercontent-origin="${escapeHtml(
            new URL(config.usercontentOrigin).origin
          )}"`
        : `data-view="dashboard" data-usercontent-origin="${escapeHtml(
            new URL(config.usercontentOrigin).origin
          )}"`;
  const rootAttributes = storedPrivate
    ? `${baseRootAttributes} data-relic-access="private"`
    : baseRootAttributes;

  const body = `<!doctype html>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Relic">
<meta property="og:title" content="${escapeHtml(cardTitle)}">
<meta property="og:description" content="${escapeHtml(cardDescription)}">
<meta property="og:url" content="${escapeHtml(ogUrl)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:type" content="${escapeHtml(ogImageType)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(cardTitle)}">
<meta name="twitter:description" content="${escapeHtml(cardDescription)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
<title>${escapeHtml(documentTitle)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1f6b64">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/styles.css">${
    typeof target === 'string'
      ? '\n<noscript><style>.stage-loading,[data-load-custody]{display:none}</style></noscript>'
      : ''
  }${
    typeof target === 'string'
      ? `\n<header class="bar" data-load-bar>
<div class="mark">relik.link</div>
<div class="identity">
<div class="filename" data-load-custody>${escapeHtml(LOAD_OPENING)}</div>
<div class="identity-meta"><span class="accession">${canonicalId !== undefined ? escapeHtml(canonicalId) : ''}</span></div>
</div>
<div class="actions">
<a class="action" href="/policy" aria-label="${escapeHtml(POLICY_LINK_LABEL)}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="icon"><path d="M5.7 3.3 2 7l3.7 3.7.7-.7L3.4 7l3-3-.7-.7zm4.6 0-.7.7 3 3-3 3 .7.7L14 7l-3.7-3.7z"/></svg><span>${escapeHtml(POLICY_LINK_LABEL)}</span></a>
<a class="action" href="/abuse" aria-label="${escapeHtml(REPORT_LINK_LABEL)}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="icon"><path d="M3 1h1v14H3V1zm2 1h8l-2 3 2 3H5V2z"/></svg><span>${escapeHtml(REPORT_LINK_LABEL)}</span></a>
</div>
</header>
<main class="stage stage-loading" data-load-plate data-load-phase="opening">
<div class="card load-card">
<p id="load-phase" class="load-phase" role="status" aria-live="polite">${escapeHtml(LOAD_OPENING)}</p>
<div class="load-meter" role="progressbar" aria-labelledby="load-phase"></div>
<p data-load-transfer></p>
<p data-load-contents hidden></p>
<p class="card-note">${escapeHtml(LOAD_EXPLANATION)}</p>
</div>
</main>
<noscript>
<main class="stage stage-noscript">
<div class="card">
<h1 class="card-title">${escapeHtml(NOSCRIPT_TITLE)}</h1>
<p class="card-note">${escapeHtml(NOSCRIPT_DETAIL)}</p>
<div class="card-actions">
<a class="action" href="/policy" aria-label="${escapeHtml(POLICY_LINK_LABEL)}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="icon"><path d="M5.7 3.3 2 7l3.7 3.7.7-.7L3.4 7l3-3-.7-.7zm4.6 0-.7.7 3 3-3 3 .7.7L14 7l-3.7-3.7z"/></svg><span>${escapeHtml(POLICY_LINK_LABEL)}</span></a>
<a class="action" href="/abuse" aria-label="${escapeHtml(REPORT_LINK_LABEL)}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="icon"><path d="M3 1h1v14H3V1zm2 1h8l-2 3 2 3H5V2z"/></svg><span>${escapeHtml(REPORT_LINK_LABEL)}</span></a>
</div>
</div>
</main>
</noscript>`
      : ''
  }
${
  doc !== undefined
    ? `<noscript><main class="stage"><div class="card"><p class="card-note">This page needs JavaScript to render. <a href="${escapeHtml(doc.path)}?raw=1">Read it as plain markdown</a>.</p></div></main></noscript>\n`
    : ''
}<div id="relic-root" ${rootAttributes}></div>
<script type="module" src="/assets/viewer.js"></script>
<script type="module" src="/assets/register-sw.js"></script>
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'cache-control': 'no-store',
      'content-security-policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob: data:",
        "manifest-src 'self'",
        `connect-src 'self' ${new URL(config.serviceOrigin).origin} https:`,
        `frame-src ${new URL(config.usercontentOrigin).origin}`,
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  });
}

/**
 * The homepage and install page, aimed at a publisher.
 *
 * It replaces two defects at once. `/` used to serve the viewer shell with a
 * placeholder relic id, so the homepage rendered as a relic that does not
 * exist, and the manifest's `start_url` is `/`, so installing the app landed
 * on that same broken screen.
 *
 * The origin is interpolated from config rather than written into the copy,
 * because `relic-mcp` has no default origin on purpose: a wrong one turns
 * "you did not configure me" into a DNS error on the first publish.
 *
 * `/` and `/install` serve the same bytes, so install instructions cannot
 * drift. The page carries no script and a CSP that denies scripts outright.
 * It used to load a client script that listed the relics held in this
 * browser's local vault; that list now lives only at `/dashboard`, and the
 * header links there, so the landing page never touches the key vault.
 *
 * The screenshots are real renders of the viewer, produced by
 * `scripts/landing-shots.ts` and served from `/assets/`. `img-src 'self'`
 * covers them.
 */
export function landingPage(config: RelicConfig): Response {
  const origin = escapeHtml(new URL(config.serviceOrigin).origin);
  const host = escapeHtml(new URL(config.serviceOrigin).host);
  // The hosted service does not ask a reader to configure which host they are
  // already using. A self-hosted deployment has to, because its client would
  // otherwise resolve the hosted default and publish to the wrong place, so
  // the same page carries the variable there and omits it here.
  const hosted = isHostedService(config.serviceOrigin);
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1f6b64">
<title>Relic: share a file the server cannot read</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<style>
  :root {
    color-scheme: light dark;
    --ground: #f1f2f0;
    --surface: #fbfbfa;
    --ink: #16191a;
    --ink-soft: #5a6163;
    --rule: #d2d5d2;
    --rule-strong: #b3b8b4;
    --patina: #1f6b64;
    --serif: Charter, "Iowan Old Style", "Source Serif Pro", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #101314;
      --surface: #171b1c;
      --ink: #e6e9e7;
      --ink-soft: #969e9d;
      --rule: #2a3032;
      --rule-strong: #3b4345;
      --patina: #4fb3a6;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.55;
  }
  a { color: var(--patina); }
  p { margin: 0 0 1rem; }
  code { font-family: var(--mono); font-size: 0.85rem; }
  .bar {
    display: flex;
    align-items: stretch;
    min-height: 3.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--rule-strong);
  }
  .mark {
    display: flex;
    align-items: center;
    padding: 0 1rem;
    font-family: var(--mono);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--ink);
    text-decoration: none;
    border-right: 1px solid var(--rule);
    white-space: nowrap;
  }
  .bar nav { display: flex; flex: 1; min-width: 0; }
  .bar nav a {
    display: flex;
    align-items: center;
    padding: 0 1rem;
    font-size: 0.85rem;
    color: var(--ink-soft);
    text-decoration: none;
  }
  .bar nav a:hover,
  .bar nav a:focus-visible { color: var(--ink); text-decoration: underline; }
  .mine {
    display: flex;
    align-items: center;
    padding: 0 1.25rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--ink);
    text-decoration: none;
    border-left: 1px solid var(--rule-strong);
    white-space: nowrap;
  }
  .mine:hover,
  .mine:focus-visible { background: var(--ground); color: var(--patina); }
  .wrap { max-width: 72rem; margin: 0 auto; padding: 0 1.5rem; }
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
    gap: 4rem;
    align-items: start;
    padding-top: 4.5rem;
    padding-bottom: 4.5rem;
  }
  h1 {
    font-family: var(--serif);
    font-size: clamp(2.3rem, 4.8vw, 3.6rem);
    text-wrap: balance;
    line-height: 1.04;
    letter-spacing: -0.015em;
    font-weight: 600;
    margin: 0 0 1.25rem;
  }
  h2 {
    font-family: var(--serif);
    font-size: clamp(1.6rem, 3vw, 2.2rem);
    line-height: 1.12;
    letter-spacing: -0.01em;
    font-weight: 600;
    margin: 0 0 1rem;
  }
  h3 { font-family: var(--serif); font-size: 1.15rem; margin: 0 0 0.5rem; }
  .lede { font-size: 1.15rem; color: var(--ink-soft); max-width: 34rem; margin-bottom: 2rem; }
  .say { font-weight: 600; margin-bottom: 0.5rem; }
  pre {
    margin: 0 0 1rem;
    padding: 1rem 1.1rem;
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--patina);
  }
  pre code { font-size: 0.88rem; line-height: 1.7; }
  .after { color: var(--ink-soft); font-size: 0.95rem; max-width: 34rem; }
  .tag { margin: 0; }
  .tag-part { padding: 0.25rem 0 0.25rem 1.25rem; border-left: 3px solid var(--ink-soft); }
  .tag-part + .tag-part { margin-top: 1.5rem; border-left-color: var(--patina); }
  .tag-url {
    display: block;
    font-size: 1.3rem;
    line-height: 1.55;
    word-break: break-all;
  }
  .u-host { display: block; color: var(--ink-soft); }
  .u-hash { color: var(--patina); font-weight: 700; }
  .u-key { color: var(--patina); }
  .tag-part p { margin: 0.5rem 0 0; font-size: 0.92rem; color: var(--ink-soft); max-width: 24rem; }
  .tag figcaption { margin-top: 1.5rem; font-size: 0.8rem; color: var(--ink-soft); }
  .band { border-top: 1px solid var(--rule-strong); padding: 4.5rem 0; }
  .band.alt { background: var(--surface); }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 8fr);
    gap: 3.5rem;
    align-items: start;
  }
  .split p { color: var(--ink-soft); }
  .shot { margin: 0; }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
  }
  .shot figcaption { margin-top: 0.6rem; font-size: 0.85rem; color: var(--ink-soft); max-width: 38rem; }
  .transcript { font-size: 0.85rem; }
  .transcript code { display: block; white-space: pre-wrap; word-break: break-all; }
  .transcript .who { color: var(--ink-soft); }
  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2.5rem;
    align-items: start;
    margin-top: 2.5rem;
  }
  .pair .shot:last-child { margin-top: 4.5rem; }
  .notes {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 3.5rem;
    margin-top: 3.5rem;
  }
  dl.types { margin: 0; }
  dl.types div {
    display: grid;
    grid-template-columns: 9.5rem minmax(0, 1fr);
    gap: 1rem;
    padding: 0.55rem 0;
    border-top: 1px solid var(--rule);
  }
  dl.types div:last-child { border-bottom: 1px solid var(--rule); }
  dl.types dt { font-family: var(--serif); font-weight: 600; }
  dl.types dd { margin: 0; color: var(--ink-soft); font-size: 0.95rem; }
  details { border-top: 1px solid var(--rule); padding: 0.9rem 0; }
  details:last-of-type { border-bottom: 1px solid var(--rule); }
  summary {
    cursor: pointer;
    font-family: var(--serif);
    font-size: 1.12rem;
    font-weight: 600;
  }
  details > :not(summary) { margin-top: 0.9rem; }
  .elsewhere > * { max-width: 46rem; }
  .elsewhere p { color: var(--ink-soft); }
  .ledger {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 3.5rem;
    max-width: 62rem;
    margin: 0 0 3rem;
  }
  .ledger > div + div h3 { color: var(--patina); }
  .ledger ul { list-style: none; margin: 0; padding: 0; }
  .ledger li {
    padding: 0.7rem 0;
    border-top: 1px solid var(--rule);
    color: var(--ink-soft);
    font-size: 0.96rem;
  }
  .ledger li:last-child { border-bottom: 1px solid var(--rule); }
  .ledger li strong { color: var(--ink); font-weight: 600; }
  .limits { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 3.5rem; max-width: 62rem; }
  .limits p { color: var(--ink-soft); }
  .limits p strong { color: var(--ink); }
  footer { border-top: 1px solid var(--rule-strong); padding: 1.5rem 0 3rem; font-size: 0.85rem; color: var(--ink-soft); }
  @media (max-width: 52rem) {
    .hero, .split, .pair, .notes, .limits, .ledger { grid-template-columns: minmax(0, 1fr); gap: 2.5rem; }
    .hero { padding-top: 3rem; padding-bottom: 3rem; }
    .band { padding: 3rem 0; }
    .pair .shot:last-child { margin-top: 0; }
  }
  @media (max-width: 40rem) {
    .bar nav { display: none; }
    .mine { margin-left: auto; }
    dl.types div { grid-template-columns: minmax(0, 1fr); gap: 0.1rem; }
  }
</style>
<header class="bar">
  <a class="mark" href="/">${host}</a>
  <nav aria-label="Page sections">
    <a href="#install">Install</a>
    <a href="#recipient">What they see</a>
    <a href="#limits">What we hold</a>
  </nav>
  <a class="mine" href="/dashboard">Your relics</a>
</header>
<main>
  <div class="wrap hero" id="install">
    <div>
      <h1>Share a file we can&rsquo;t read.</h1>
      <p class="lede">Your agent encrypts the file on your machine and hands you
      one link. Whoever you give the link to opens it in a browser. We keep the
      ciphertext. The key lives in the link, and browsers never send that part
      to a server.</p>
      <p class="say">Add it to Claude Code:</p>
      <pre><code>${
        hosted
          ? ''
          : `export RELIC_SERVICE_ORIGIN=${origin}
`
      }claude plugin marketplace add TheBushidoCollective/relik
claude plugin install relic@relic</code></pre>
      <p class="after">Then tell your agent <em>publish ./report.md as a relic</em>.
      The plugin includes a skill that teaches it when sharing a file is the
      right move and what to tell you about the link. Using another client?
      <a href="#elsewhere">It installs there too</a>.</p>
    </div>
    <figure class="tag" aria-label="The two halves of a relic link">
      <div class="tag-part">
        <code class="tag-url"><span class="u-host">${host}/</span>01JC9M4T7KQZ2V8XH5RN3PWEYD</code>
        <p>This much reaches our servers. It says where the ciphertext is stored.</p>
      </div>
      <div class="tag-part">
        <code class="tag-url"><span class="u-hash">#</span><span class="u-key">q7Tn-V2x_kLw9Zr4HbYc1sUe8GdPj3MoA6iFtXnQ0aE</span></code>
        <p>This much never does. It is the key, and the browser keeps it.</p>
      </div>
      <figcaption>An example link, not a live one.</figcaption>
    </figure>
  </div>

  <section class="band alt">
    <div class="wrap split">
      <div>
        <h2>One sentence to publish</h2>
        <p>The agent passes a path, never the file&rsquo;s contents, so the
        plaintext does not enter your conversation. It encrypts here, uploads
        the ciphertext, and gives the link back.</p>
        <pre class="transcript"><code><span class="who">you</span>    publish ./release-notes.html as a relic
<span class="who">agent</span>  Published. ${host}/01JC9M4T7KQZ2V8XH5RN3PWEYD#q7Tn-&hellip;</code></pre>
        <p>Send the link anywhere. Opening it takes a browser and the whole
        link, including the part after the <code>#</code>. Reading needs no
        account and no install.</p>
      </div>
      <figure class="shot">
        <img src="/assets/landing-html.png" width="1440" height="900" loading="lazy"
          alt="A published HTML page open in the Relic viewer, rendered in a sandboxed frame.">
        <figcaption>What the other person sees for an HTML file: the page,
        rendered in their browser in a frame with no network access.</figcaption>
      </figure>
    </div>
  </section>

  <section class="band" id="recipient">
    <div class="wrap">
      <h2>It opens as the thing it is</h2>
      <p class="after">The viewer decrypts in the reader&rsquo;s browser and renders by
      type, in the reader&rsquo;s light or dark setting.</p>
      <div class="pair">
        <figure class="shot">
          <img src="/assets/landing-markdown.png" width="1440" height="900" loading="lazy"
            alt="A Markdown README open in the Relic viewer, rendered as a formatted document.">
          <figcaption>Markdown, as published. This is this project&rsquo;s own README.</figcaption>
        </figure>
        <figure class="shot">
          <img src="/assets/landing-code-dark.png" width="1440" height="900" loading="lazy"
            alt="A source file open in the Relic viewer in its dark theme, with syntax highlighting.">
          <figcaption>Code, in the dark theme, with highlighting.</figcaption>
        </figure>
      </div>
      <div class="notes">
        <dl class="types">
          <div><dt>Markdown, code, text, images</dt><dd>Rendered inline.</dd></div>
          <div><dt>PDF</dt><dd>An in-browser document viewer.</dd></div>
          <div><dt>Audio, video</dt><dd>An in-browser player.</dd></div>
          <div><dt>OpenTimelineIO</dt><dd>A timeline player with tracks, trims and dissolves.</dd></div>
          <div><dt>HTML, JSX</dt><dd>A sandboxed frame on a separate origin, with no network. Inline what the page needs.</dd></div>
          <div><dt>Anything else</dt><dd>A download.</dd></div>
        </dl>
        <div>
          <h3>They can answer, and you can update</h3>
          <p>A reader can comment on the file. The comment text is encrypted the
          same way the file is, and commenting asks for a verified email address.
          Your agent reads the comments back.</p>
          <p>Publish a new version and the link stays the same, so everyone who
          has it sees the update. Earlier versions stay readable to anyone
          holding the link. A relic is kept until it is deleted, unless you give
          it a lifetime when you publish.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="band alt" id="elsewhere">
    <div class="wrap elsewhere">
      <h2>Other ways to install</h2>
      <p>The same server runs in any client that speaks MCP.</p>
      <details open>
        <summary>Claude Code, server only</summary>
        <pre><code>claude mcp add relic ${
          hosted
            ? ''
            : `\\
  --env RELIC_SERVICE_ORIGIN=${origin} \\
  `
        }-- npx -y relic-mcp@latest</code></pre>
        <p><code>npx</code> fetches the server on first use and caches it. You
        get the tools without the skill.</p>
      </details>
      <details>
        <summary>Cursor, Windsurf, Codex, VS Code, Gemini CLI, Claude Desktop</summary>
        <pre><code>npx -y relic-mcp@latest install${hosted ? '' : ` --origin ${origin}`}                 # what is installed on this machine
npx -y relic-mcp@latest install --client cursor${hosted ? '' : ` --origin ${origin}`}  # add it there</code></pre>
        <p>It knows where each client keeps its config, merges into what is
        already there, and backs the file up first. Client names: claude-desktop,
        cursor, windsurf, gemini, vscode, codex.</p>
      </details>
      <details>
        <summary>Any client that takes JSON</summary>
        <pre><code>{
  "mcpServers": {
    "relic": {
      "command": "npx",
      "args": ["-y", "relic-mcp@latest"]${
        hosted
          ? ''
          : `,
      "env": {
        "RELIC_SERVICE_ORIGIN": "${origin}"
      }`
      }
    }
  }
}</code></pre>
        <p>The key names differ between clients. The shape does not.</p>
      </details>
    </div>
  </section>

  <section class="band" id="limits">
    <div class="wrap">
      <h2>What we hold, and what we never receive</h2>
      <div class="ledger">
        <div>
          <h3>We hold</h3>
          <ul>
            <li><strong>The file, as ciphertext.</strong></li>
            <li><strong>A title, in the clear.</strong> It defaults to your filename and shows in link previews.</li>
            <li><strong>A cover image of the first screen,</strong> unless you decline it when you publish.</li>
            <li><strong>A coarse file type,</strong> the publishing tool&rsquo;s name, and the upload time and IP address, kept for abuse response.</li>
            <li><strong>Addresses you share to,</strong> and the addresses of people who comment.</li>
          </ul>
        </div>
        <div>
          <h3>We never receive</h3>
          <ul>
            <li><strong>The key.</strong> It sits after the <code>#</code>, and browsers never send a fragment to a server.</li>
            <li><strong>The file&rsquo;s contents</strong> in any form we could read.</li>
            <li><strong>The text of a comment.</strong> It is encrypted the way the file is.</li>
            <li><strong>The keys a browser remembers</strong> for relics it opened. They stay in that browser&rsquo;s local storage.</li>
          </ul>
        </div>
      </div>
      <div class="limits">
        <div>
          <h3>The link is the credential</h3>
          <p>Anyone holding the whole link can read the file, and there are no
          per-recipient permissions to revoke. Treat it like a password. A chat
          client or ticket system that cuts off the fragment hands over a link
          that cannot decrypt anything.</p>
        </div>
        <div>
          <h3>The limit, stated plainly</h3>
          <p>The page that decrypts is served by us, so that half
          rests on our intent rather than on something you can verify. The half that is
          structural is that we never receive the key. The link also passes
          through your agent, so it is in your transcript, and whoever can read
          that can open the file.</p>
        </div>
      </div>
    </div>
  </section>
</main>
<footer>
  <div class="wrap">
    <a href="/policy">What we store and what we can see</a> &middot;
    <a href="/abuse">Report a relic</a> &middot;
    <a href="https://github.com/TheBushidoCollective/relik">Source</a>
  </div>
</footer>
`;
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      // robots.txt already disallows everything on this origin. The header is
      // the per-response half of the same control.
      'x-robots-tag': 'noindex',
      'content-security-policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        // The page links the manifest so a browser can offer to install it,
        // and a manifest fetch falls back to default-src when manifest-src is
        // absent, which silently refused it on the shell for weeks.
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  });
}

function abuseForm(config: RelicConfig): Response {
  // Works without JavaScript, as a plain form POST.
  const host = escapeHtml(new URL(config.serviceOrigin).host);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1f6b64">
<title>Report a relic</title>
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<style>
  :root {
    color-scheme: light dark;
    --ground: #f1f2f0;
    --surface: #fbfbfa;
    --ink: #16191a;
    --ink-soft: #5a6163;
    --rule: #d2d5d2;
    --rule-strong: #b3b8b4;
    --field-rule: #7b8380; /* 3.46:1 against ground, 3.76:1 against surface. */
    --patina: #1f6b64;
    --button-ink: #fbfbfa;
    --serif: Charter, "Iowan Old Style", "Source Serif Pro", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #101314;
      --surface: #171b1c;
      --ink: #e6e9e7;
      --ink-soft: #969e9d;
      --rule: #2a3032;
      --rule-strong: #3b4345;
      --field-rule: #65716f; /* 3.68:1 against ground, 3.43:1 against surface. */
      --patina: #4fb3a6;
      --button-ink: #101314;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font: 1rem/1.55 var(--sans);
  }
  a { color: var(--patina); text-underline-offset: 0.2em; }
  a:hover { text-decoration-thickness: 2px; }
  :focus-visible { outline: 2px solid var(--patina); outline-offset: 4px; }
  .bar {
    display: flex;
    align-items: stretch;
    min-height: 3.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--rule-strong);
  }
  .mark {
    display: flex;
    align-items: center;
    padding: 0.75rem 1rem;
    border-right: 1px solid var(--rule);
    color: var(--ink);
    font: 600 0.78rem/1.5 var(--mono);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .wrap { max-width: 72rem; margin: 0 auto; padding: 0 1.5rem; }
  main.wrap {
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 7fr);
    gap: clamp(2.5rem, 6vw, 6rem);
    align-items: start;
    padding-top: 4rem;
    padding-bottom: 4rem;
  }
  h1 {
    margin: 0 0 1.5rem;
    font: 600 clamp(2.3rem, 4.8vw, 3.2rem)/1.08 var(--serif);
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  p { margin: 0; }
  .guidance { color: var(--ink-soft); max-width: 30rem; }
  .guidance strong { color: var(--ink); font-weight: 600; }
  code { font: 0.95em var(--mono); }
  .response {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rule-strong);
    color: var(--ink-soft);
    font-size: 0.9rem;
  }
  form {
    min-width: 0;
    padding: 1.75rem 2rem 2rem;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
  }
  .field { margin-bottom: 1.4rem; min-width: 0; }
  label { display: block; margin-bottom: 0.4rem; font-size: 0.9rem; font-weight: 600; }
  .optional { color: var(--ink-soft); font-weight: 400; }
  input, select, textarea {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 2.875rem;
    border: 1px solid var(--field-rule);
    border-radius: 2px;
    padding: 0.65rem 0.75rem;
    background: var(--ground);
    color: var(--ink);
    font: inherit;
    line-height: 1.4;
  }
  select { padding-right: 2rem; }
  textarea { min-height: 9rem; resize: vertical; }
  input:focus-visible, select:focus-visible, textarea:focus-visible {
    border-color: var(--patina);
    outline-offset: 2px;
  }
  .pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.25rem; }
  button {
    min-height: 2.875rem;
    padding: 0.65rem 1.25rem;
    border: 1px solid var(--patina);
    border-radius: 2px;
    background: var(--patina);
    color: var(--button-ink);
    font: 600 0.95rem/1.4 var(--sans);
    cursor: pointer;
  }
  button:hover { background: var(--ink); border-color: var(--ink); color: var(--surface); }
  footer {
    border-top: 1px solid var(--rule-strong);
    padding: 1.5rem 0 2rem;
    font-size: 0.85rem;
  }
  @media (max-width: 52rem) {
    main.wrap { grid-template-columns: minmax(0, 1fr); gap: 2rem; padding-top: 2.5rem; padding-bottom: 2.5rem; }
    .guidance { max-width: 38rem; }
    .response { margin-top: 1.25rem; }
  }
  @media (max-width: 40rem) {
    .wrap { padding-left: 1.25rem; padding-right: 1.25rem; }
    form { padding: 1.25rem; }
    .pair { grid-template-columns: minmax(0, 1fr); gap: 0; }
    button { width: 100%; }
  }
</style>
</head>
<body>
<header class="bar">
  <a class="mark" href="/">${host}</a>
</header>
<main class="wrap">
  <div>
    <h1>Report a relic</h1>
    <p class="guidance" id="key-guidance">Paste the relic ID. <strong>Do not include the part after <code>#</code>:</strong> that is
the decryption key, and we do not want it. We strip it either way.</p>
    <p class="response">We respond within ${config.abuseSlaHours} hours of arrival.</p>
  </div>
  <form method="post" action="/abuse">
    <div class="field">
      <label for="relic-id">Relic ID</label>
      <input id="relic-id" name="relic_id" required aria-describedby="key-guidance" autocapitalize="none" spellcheck="false">
    </div>
    <div class="field">
      <label for="category">Category</label>
      <select id="category" name="category" required>
        <option value="malware">Malware</option>
        <option value="phishing">Phishing</option>
        <option value="csam">CSAM</option>
        <option value="copyright">Copyright</option>
        <option value="legal_process">Legal process</option>
        <option value="other">Other</option>
      </select>
    </div>
    <div class="field">
      <label for="description">What is wrong</label>
      <textarea id="description" name="description" required></textarea>
    </div>
    <div class="field">
      <label for="contact">Your contact <span class="optional">(optional)</span></label>
      <input id="contact" name="contact" type="email" autocomplete="email">
    </div>
    <div class="pair">
      <div class="field">
        <label for="authority">Issuing authority <span class="optional">(optional)</span></label>
        <input id="authority" name="authority">
      </div>
      <div class="field">
        <label for="reference">Reference <span class="optional">(optional)</span></label>
        <input id="reference" name="reference">
      </div>
    </div>
    <button type="submit">Send report</button>
  </form>
</main>
<footer>
  <div class="wrap"><a href="/policy">What we store and what we can see</a></div>
</footer>
</body>
</html>
`;
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
      )[ch] as string
  );
}

const DISCLOSURE_TITLE = 'What Relic knows about your relic';

function disclosureStatement(config: RelicConfig): string {
  const retention = Math.round(config.retentionSeconds / 86_400);
  return `# ${DISCLOSURE_TITLE}

Read this before you publish. The frame conditions the whole telemetry trade
on it being readable first.

## What we can never read

Your file is encrypted on your machine with a key your machine generates. The
key lives in the URL fragment, after the \`#\`. **Your browser never sends the
key to Relic's servers.** That is the correct form of the claim. Saying "the
key never reaches a server" unqualified would be wrong.

A link whose key does not open a relic stops downloading after the first block,
so our storage provider and anyone watching the connection can tell the open
stopped early but never see the key.

## What your own browser keeps

Opening a relic strips the key out of the address bar immediately, which means
a reload would otherwise lose it. So the viewer remembers the key in your
browser's local storage for that relic, until the relic expires, and clears it
as soon as the relic is gone.

It never leaves your machine, and it is stored under Relic's origin rather than
the usercontent origin that renders content. The trade is real and worth
stating plainly: for as long as the entry lives, anyone using this browser
profile can reopen that relic without ever having been sent the link. Clearing
site data for this origin removes every remembered key.

## What we do know

- **A coarse renderer class**, one of: markdown, code, html, jsx, image, pdf, model,
  media, archive, binary, otio. Nothing finer. It is now also on the relic's card, so the kind
  of thing that was published is readable by anyone who fetches the link, not
  only by the operator.
- **The name of the tool that published it**, so we can tell whether Relic
  serves the contexts it was built for.
- **Open activity, correlated with the publishing IP address.** Upload IP and
  timestamp are retained for abuse response regardless.
- **A title, in the clear.** The publishing tool defaults it to your
  filename. We store it, the relic's page carries it in its metadata, and
  every link preview shows it.
- **A cover image, unencrypted.** By default relic-mcp renders the first screen
  of the file on your machine and uploads a 1200x630 preview image. The server
  stores it and serves it at \`/\${id}/cover/\${sha256}.{png|jpg}\` for link previews;
  anyone who fetches the link, unfurl services, and their caches can see it
  without the decryption key. Publishing with \`cover: false\` or republishing
  with \`cover: false\` clears the cover. Takedown deletes it. When a relic expires,
  the cover stops serving immediately while the underlying storage object
  remains until deletion per our soft-delete retention policy. For OpenTimelineIO
  timeline relics (otio), unencrypted first-screen media rendering is skipped by
  default; link previews use a generic card carrying the publisher-declared title
  and format label, preventing referenced media frames and track metadata from
  leaking into unencrypted cover previews.
  STL and OBJ models also use a generic card, rather than exposing geometry in a preview.
This moves us from knowing nothing to knowing what kind of thing you published
and roughly how often it was fetched. It is metadata. It is never content.

## The length leak

Ciphertext length reveals plaintext length to within one record. Combined with
the class, we learn something like "an image of roughly 2.4 MB". We do not pad
to size buckets, because that cost is paid in egress by every recipient on
every fetch, forever.

## The title is not encrypted

A relic carries a plaintext title so that a pasted link previews as something
legible rather than as a blank card on an unfamiliar domain, which is what a
phishing link looks like. The publishing tool defaults that title to your
filename.

It is the one thing about your relic that anyone who fetches the link can read
without the key: the chat client drawing a preview, a mail scanner following
the URL, a crawler that ignores our robots file, and us. **If the name is the
sensitive part, publish without a title.** The content is unaffected either
way; it is encrypted before it leaves your machine.

The card also names the kind of file, using the coarse renderer class above
rather than anything finer. **Declining a title does not hide it.** The class is
derived from the bytes rather than chosen, so anyone who fetches the link learns
what kind of thing was published even when you publish without a title.

A relic that is removed or has expired stops serving its title with the rest
of it.

## The key enters your AI session transcript

The publish tool returns the full URL including the fragment, because handing
you a usable link is the product. **The key therefore enters the model's
context and your session transcript on every publish.** Zero-knowledge holds
against us. It does not hold against your model provider or whoever stores
your transcripts. This is structural, not a defect we plan to fix.

## Republishing keeps the earlier versions

**Anyone holding a relic's link can fetch every version it has ever held, so
republishing does not withdraw earlier content.** The same fragment key
decrypts every version in your browser. Republishing is not a redaction
mechanism.

## Comments, email notices, and sharing

Anyone holding a relic's link can read its comments and add one. Comment
bodies are encrypted with a key derived from the link, so we cannot read them.
We do keep who commented on which relic and when: a commenter is the email address they verified with a sign-in email, by following its link or typing its code, stored in the clear beside each comment. A sign-in email, and every email below, passes the address through our mail provider. A sign-in code works once, only in the browser that asked for it: until it is used or the storage cleanup removes it, which takes about a day, the service keeps it as a hash keyed by a random value that only that browser holds, and for a day it counts code attempts for each address, filed under a hash of the address. A reader who added a passkey can later sign in to the same address with it, and that sends no email.

**When someone comments or a relic gets a new version, we email the people following it.**
That is every verified address that commented on it, every address its publisher or a reader
shared it with, and the relic's owner address, minus the author of the comment and anyone
who stopped emails for that relic. A new comment email names the commenter (their verified
email address, or "The publisher" for comments posted with the publish token), so everyone
on the list, including third-party shared addresses, sees the commenter's address. The email
cannot quote the comment and links to the relic without its key. The publisher gets owner-specific
wording ("commented on your relic"), an answered commenter gets reply wording ("answered your comment"),
and everyone else gets a notice with the reason they are following the relic. When a new version is
published, the email announces the new version number. A publisher can skip the email for a version.

**Burst limiter and spend fuse.** Comment notices and version notices share the same rate
limits: at most one email per recipient per relic per 10 minutes, collapsing rapid comments or
version republishes with replies into a single email. Outbound notices across all relics are
capped by a global fuse to bound mail spend.

**Sharing gives us addresses, never the link.** A publisher, or a signed-in reader holding
the key, can register addresses on a relic so they receive these emails. Web sharing by a reader
is gated by a proof derived from the key: the service learns the proof, but never the key, and does
not store who shared it. We store each address in the clear, linked to the relic, and we do not ask
its owner first. The email that carries the link goes from the sharer's own mail, not from us, so
the key never reaches our servers.

**One stop link stops every email about that relic.** Every email (comment, reply, owner, and version)
carries an unauthenticated stop link and RFC 8058 one-click unsubscribe headers. It stops all emails
about that relic to that address. We record that it was used as a SHA-256 of the address beside the
relic id. A hash of an email address is not anonymous: anyone who can guess the address can match it.

Deleting a relic deletes its comments, its shared addresses, and its stop records. An expired
relic sends no more emails, and those records stay until it is deleted, like the rest of it.

## Decisions and passkeys

**Decisions.** When a signed-in reader approves or rejects a version in the viewer, the service stores that decision in the clear: the verdict, the reader's verified email address, the version number, the SHA-256 of that version's ciphertext, the id of the passkey that confirmed it, and the time. Anyone holding the relic's link can read its decisions. Decisions are never edited or deleted, except that removing a relic removes its decisions with it.

**Passkeys.** A passkey is registered to a reader's verified address. It confirms decisions, and it can sign that reader in instead of a link. The service keeps one record per address, filed under a hash of the address: the address itself, the random user handle its passkeys carry, and for each passkey its public key, credential id, signature counter, and when it was created and last used. A second entry, filed under a hash of the user handle, points to that record, so a passkey can sign you in without your typing the address. The first passkey registered for an address is trusted on first use, and only a session that a sign-in email started in the previous ${config.passkeyFreshLinkSeconds / 60} minutes, by its link or its code, can begin adding it; adding another requires confirming with an existing one. Whenever a passkey is added, the service emails that address to say so, with the time and how many passkeys the address has. That email has no stop link, because it is about the address rather than a relic. Signing in with a passkey sends no email, updates that passkey's counter and last-used time, and starts the same session a link does, except that the session records a passkey started it. If you type your address to use a passkey, the service answers the same way whether or not that address has one. The service never receives a private key.

**Version digests.** To bind a decision to exact content, the service reads each version's ciphertext once and stores its SHA-256. It reads ciphertext only and holds no key.

## The JavaScript caveat

The code that decrypts your relic in the browser is served by us, the same
party this promise is made against, and we could serve different code
tomorrow. This is a statement about our intent, not a property you can verify.
Anyone claiming otherwise about a service of this shape is overclaiming.

## What rendered content can do

A relic that renders as HTML or JSX runs its author's code in your browser.
The frame that hosts it is served a policy that permits no remote source, so
that code cannot make outbound HTTP, WebSocket, or worker requests: it cannot
fetch external resources, and a page that expects external images, fonts, or
scripts renders without them. Because Chrome does not enforce Content-Security-Policy
over WebRTC ICE candidate gathering, the viewer frame installs a runtime deny-list
that neutralizes WebRTC constructors across the prototype chain and blocks nested
frame creation to prevent UDP STUN egress. This containment is tested defense in
depth rather than an architectural impossibility: future platform APIs could reopen
channels, and nested frames or workers in HTML and JSX relics are denied.

**The isolation is about network and cross-origin reach, not safety.** The
code still runs locally in your browser, can consume your CPU, and can
render whatever its author wrote. The isolation does not mean the content
is safe or has been reviewed.

## The key can leave without us doing anything wrong

Pasting the URL into a link shortener transmits the key to that service.
Enterprise mail security products that rewrite links may transmit it to their
vendor. We have not yet completed the empirical test that would tell us which
of those happens, so we do not assert either way.

## Retention, per sink

- Application records and tombstones: ${retention} days
- Mint log: ${retention} days
- Edge and load balancer logs: ${retention} days
- Abuse intake mailbox and ticket queue: ${retention} days
- Soft-deleted object bytes: 7 days after deletion

**Deleted does not mean erased.** Deletion stops serving immediately, which is
the half that answers an abuse notice. The bytes persist in soft-delete for a
further retention period, and we never promise erasure.

## Lifetime

A relic is kept until it is deleted. The publisher can set a lifetime when
creating it, and once that lifetime has passed the link is dead; without one,
time alone never retires a relic. Deletion still is not erasure, as the
retention section above says. Each relic can be opened ${config.downloadCap}
times before the link stops working.

> **Private relics.** A private relic's link carries no key. Each reader who is let in has their own copy of each version's key, encrypted to a key only their passkey can unlock; the service stores those encrypted copies and never the keys. To let someone in, the service records who asked and who granted, the email addresses involved, the public keys, and a signed record of each grant and revocation. It keeps an access log of requests, grants, revocations, key fetches and deletions for the owner, for the retention the owner sets. It also stores each person's private-share key encrypted under a secret held by their passkey. Private relics carry no title or cover, always expire, and their notification emails say only that there is activity on a relic. The JavaScript that decrypts them comes from this service, the same as for every relic.

## Reporting abuse

${config.serviceOrigin}/abuse. We respond within ${config.abuseSlaHours} hours
of arrival. That measures our responsiveness on reports we receive. It is not
coverage: we cannot inspect content, so unreported abuse is invisible to us.
`;
}

/** Base64url and nothing else: the one property the server can check. */
function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * A comment id. Random rather than sequential, so a thread's size and the
 * order two relics were commented on are not readable off the ids.
 */
function newCommentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/** A magic-link or session secret: 32 random bytes, like the publish token. */
function newAuthToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Enough of a check to avoid mailing obvious nonsense, and no more. Address
 * validity is decided by whether the link is followed, which is the only
 * test that actually proves a mailbox is reachable.
 */
function looksLikeEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

/**
 * Where the magic link lands. `return_to` if it is a same-origin path,
 * otherwise `/{relic_id}` when the viewer sent the id instead, otherwise
 * `/`. Absolute URLs and protocol-relative ones are dropped, because a
 * sign-in link that leaves the service would take the session cookie with
 * it or, worse, the fragment if a later redirect inherited one.
 */
function authReturnTo(body: Record<string, unknown>): string {
  const returnTo = body['return_to'];
  if (
    typeof returnTo === 'string' &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//')
  ) {
    return returnTo;
  }
  const relicId = body['relic_id'];
  if (typeof relicId === 'string') {
    try {
      return `/${parseRelicId(relicId)}`;
    } catch {
      return '/';
    }
  }
  return '/';
}

/** The session cookie, if the request carries one. */
function sessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'relic_session' && rest.length > 0) return rest.join('=');
  }
  return undefined;
}

/** The sign-in request cookie, if the request carries one. */
function signInRequestCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'relic_sign_in_request' && rest.length > 0)
      return rest.join('=');
  }
  return undefined;
}

/** sha256Hex(`relic-sign-in-request:v1:${nonce}`) */
async function signInRequestHash(nonce: string): Promise<string> {
  return sha256Hex(`relic-sign-in-request:v1:${nonce}`);
}

/** hex(HMAC-SHA256(key = the nonce's 32 base64url-decoded bytes, `relic-sign-in-code:v1:${code}`)), via hmacSha256 (app.ts:5021) */
async function signInCodeMac(nonce: string, code: string): Promise<string> {
  const keyBytes = Buffer.from(nonce, 'base64url');
  const macBytes = await hmacSha256(keyBytes, `relic-sign-in-code:v1:${code}`);
  return Buffer.from(macBytes).toString('hex');
}

/** Six decimal digits, uniform: draws >= 4_294_000_000 are redrawn, then value % 1_000_000, zero-padded. */
function newSignInCode(): string {
  const buf = new Uint32Array(1);
  let val = 0;
  do {
    crypto.getRandomValues(buf);
    val = buf[0] ?? 0;
  } while (val >= 4_294_000_000);
  return String(val % 1_000_000).padStart(6, '0');
}

export { signInRequestHash, signInCodeMac, newSignInCode };
