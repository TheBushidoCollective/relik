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

import {
  encryptedSize,
  InvalidRelicIdError,
  isRendererClass,
  MAX_HEADER_BYTES,
  parseRelicId,
  RESERVED_SEGMENTS,
  type RendererClass,
} from '@relic/format';
import { type AssetSource, memoryAssets, REGISTER_SW_JS } from './assets.ts';
import { assertConfig, DEFAULT_CONFIG, type RelicConfig } from './config.ts';
import { newOccurrenceId, ProblemError, problemResponse } from './problems.ts';
import { RateLimiter } from './ratelimit.ts';
import {
  ciphertextHash,
  MemoryStorage,
  type ObjectStorage,
} from './storage.ts';
import {
  MemoryStore,
  type MintLogEntry,
  type ReasonClass,
  type RelicStore,
} from './store.ts';

const RESERVED = new Set(RESERVED_SEGMENTS);

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
}

export interface RelicApp {
  readonly config: RelicConfig;
  readonly store: RelicStore;
  readonly storage: ObjectStorage;
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
  const limiter = new RateLimiter();

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const head = segments[0];
    const ip = clientIp(request);
    const now = clock();

    if (segments.length === 0) return shell(config, '', 'publish');

    // Reserved segments win at the router, before anything is read as an ID.
    if (head !== undefined && RESERVED.has(head)) {
      return reservedRoute(segments, request, url, ip, now);
    }

    if (segments.length === 1 && head !== undefined) {
      // The shell only. No mint, no counter, no cap.
      return shell(config, head);
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
      return new Response(disclosureStatement(config), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    }

    if (head === 'install') return installPage(config);

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
   * Measured against a collector server under this exact policy: `fetch`,
   * `<img>`, `sendBeacon`, `WebSocket`, and `EventSource` produced zero
   * arrivals. `sendBeacon` returned `true` while delivering nothing, so its
   * return value is not evidence of delivery. A form with `target=_blank`
   * submitted and never arrived. `window.open` was blocked in the probe,
   * but no user gesture preceded it, so CSP is not what stopped it; popups
   * are closed by the sandbox attribute in the viewer, which is where that
   * guarantee has to live.
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
    const [first, second, third] = rest;

    if (first === 'challenge' && request.method === 'POST') {
      return challenge(ip, now);
    }
    if (first === 'grant' && request.method === 'POST') {
      return grant(request, ip, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'mint' &&
      request.method === 'POST'
    ) {
      return mint(second, ip, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'complete' &&
      request.method === 'POST'
    ) {
      return complete(second, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === 'republish' &&
      request.method === 'POST'
    ) {
      return republish(second, request, ip, now);
    }
    if (
      first === 'relics' &&
      second !== undefined &&
      third === undefined &&
      request.method === 'DELETE'
    ) {
      return operatorDelete(second, request, url, now);
    }

    return new Response('Not found', { status: 404 });
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
      `publish ${ip}`,
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
      `publish ${ip}`,
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
    if (ttlDays !== undefined && ttlDays !== null) {
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

    // The publish token is the relic's one credential: possession of it is
    // the only way to ever republish this id. It is minted here, returned
    // exactly once below, and stored only as a hash, so the store's JSON
    // documents can never leak a replayable bearer token.
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
    });

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

    const upload = await storage.signUpload(
      objectKey(relicId, 1),
      declaredCiphertext,
      config.urlValiditySeconds,
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
      `publish ${ip}`,
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
      declared
    );
    if (next === undefined) {
      return refuse('relic_not_found', { relic_id: relicId });
    }

    const upload = await storage.signUpload(
      objectKey(relicId, next.version),
      declaredCiphertext,
      config.urlValiditySeconds,
      now
    );

    return Response.json({
      relic_id: relicId,
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
  async function complete(rawId: string, now: number): Promise<Response> {
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

    if (row.publishedAt === undefined) {
      await store.markPublished(relicId, now, object.length, object.crc32c);
    }

    return Response.json({
      relic_id: relicId,
      object_length: object.length,
      object_crc32c: object.crc32c,
      relic_expires_at: relicExpiryIso(row.expiresAt),
    });
  }

  // --- view path ----------------------------------------------------------

  async function mint(
    rawId: string,
    ip: string,
    now: number
  ): Promise<Response> {
    const occurrenceId = newOccurrenceId();

    if (config.killSwitchEngaged) {
      return logAndRefuse(rawId, ip, now, occurrenceId, 'service_paused', {
        retry_after_seconds: 300,
      });
    }

    const verdict = limiter.check(`mint ${ip}`, config.mintRateLimit, now);
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

    // The current version's object and nothing else. There is deliberately
    // no way to ask for an older one: the cap, the metric, and the abuse
    // controls all key on the relic id, and a servable history would give
    // the egress arithmetic a term the cap cannot see.
    const object = await storage.stat(objectKey(relicId, row.version));

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

    if (row.publishedAt === undefined) {
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
    const sameVersion =
      previous !== undefined && previous.version === row.version;
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
        objectKey(relicId, row.version),
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
      version: row.version,
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
      },
      { headers: { 'referrer-policy': 'no-referrer' } }
    );
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
    if (existing !== undefined) {
      // Idempotent. Under a suspension clock, "already handled" and "wrong ID"
      // have to be distinguishable at a glance.
      return Response.json({ tombstone: existing, already_deleted: true });
    }

    const row = await store.getRelic(relicId);
    if (row === undefined) {
      // On this endpoint 404 means one thing only: never issued.
      return new Response('No such relic id was ever issued', { status: 404 });
    }

    const reasonClass = (url.searchParams.get('reason') ??
      'abuse') as ReasonClass;
    const reference = url.searchParams.get('reference') ?? undefined;

    // Hash before delete, every version. A delete that captures no hash
    // permanently loses the ability to blocklist that payload, and a
    // republished relic can carry a different payload per version, so
    // hashing only the current one would hand the blocklist a gap exactly
    // one republish wide.
    const hashes: string[] = [];
    for (let version = 1; version <= row.version; version++) {
      const bytes = await storage.read(objectKey(relicId, version));
      if (bytes !== undefined) hashes.push(await ciphertextHash(bytes));
    }
    // The tombstone's hash of record is the newest version that had bytes:
    // the content the relic was serving when it was taken down. An empty
    // list is the same refusal it always was.
    const hash = hashes.at(-1);
    if (hash === undefined) {
      return new Response('Refused: no bytes to hash', { status: 409 });
    }

    for (let version = 1; version <= row.version; version++) {
      await storage.delete(objectKey(relicId, version));
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

    // Blocklist in the same call, because a second call gets forgotten at 3am.
    const override = url.searchParams.get('blocklist');
    const automatic =
      reasonClass === 'abuse' || reasonClass === 'blocklist_match';
    const shouldBlocklist =
      override === 'true' ? true : override === 'false' ? false : automatic;
    if (shouldBlocklist) {
      for (const versionHash of hashes) await store.blocklist(versionHash);
    }

    return Response.json({
      relic_id: relicId,
      deleted: true,
      blocklisted: shouldBlocklist,
      ciphertext_hash: hash,
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

  // --- helpers ------------------------------------------------------------

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

  return {
    config,
    store,
    storage,
    fetch: handle,
  };
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return request.headers.get('x-real-ip') ?? 'unknown';
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
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

/**
 * A relic with no publisher-set lifetime never expires, and `null` is how
 * the wire says so. Any string in this slot would read as a deadline the
 * server has stopped enforcing, which is a different claim than having none.
 * Three emissions share this rule, so they cannot drift apart inline.
 */
function relicExpiryIso(epochMillis: number | undefined): string | null {
  return epochMillis === undefined ? null : iso(epochMillis);
}

function shell(config: RelicConfig, title: string, mode?: 'publish'): Response {
  // A static shell. No mint happens here, which is what keeps non-executing
  // link fetchers off the open counter and the download cap.
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1f6b64">
<title>Relic</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/styles.css">
<div id="relic-root" data-relic-id="${escapeHtml(title)}" data-usercontent-origin="${escapeHtml(
    new URL(config.usercontentOrigin).origin
  )}"${mode === undefined ? '' : ` data-mode="${mode}"`}></div>
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
        // The shell links a manifest, the server serves it, and the service
        // worker precaches it, but a manifest fetch falls back to default-src
        // when manifest-src is absent, so 'none' was refusing it. Observed in
        // production as Chrome reporting a csp-blocked request of type
        // Manifest, which means the install path has never worked.
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
 * How to add the MCP server.
 *
 * The origin is interpolated from config rather than written into the copy,
 * because `relic-mcp` has no default origin on purpose: a wrong one turns
 * "you did not configure me" into a DNS error on the first publish.
 *
 * Self-contained CSS. The page carries no script, so the CSP denies scripts
 * outright instead of allowing a source it does not use.
 */
function installPage(config: RelicConfig): Response {
  const origin = escapeHtml(new URL(config.serviceOrigin).origin);
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1f6b64">
<title>Add the Relik MCP server</title>
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
    border-right: 1px solid var(--rule);
    white-space: nowrap;
  }
  .bar-note {
    display: flex;
    align-items: center;
    padding: 0 1rem;
    font-size: 0.8rem;
    color: var(--ink-soft);
  }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 {
    font-family: var(--serif);
    font-size: 2rem;
    line-height: 1.15;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }
  .lede { font-size: 1.05rem; color: var(--ink-soft); margin: 0 0 2.5rem; }
  h2 {
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--patina);
    margin: 2.5rem 0 0.75rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
  }
  p { margin: 0 0 1rem; }
  pre {
    margin: 0 0 1rem;
    padding: 0.9rem 1rem;
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-left: 2px solid var(--patina);
  }
  code { font-family: var(--mono); font-size: 0.85rem; }
  .note {
    padding: 1rem 1.15rem;
    background: var(--surface);
    border: 1px solid var(--rule);
  }
  .note p:last-child { margin: 0; }
  footer {
    margin-top: 3rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rule);
    font-size: 0.85rem;
    color: var(--ink-soft);
  }
  a { color: var(--patina); }
</style>
<header class="bar">
  <div class="mark">relik.link</div>
  <div class="bar-note">Publish a file as an encrypted link</div>
</header>
<main>
  <h1>Add the Relik MCP server</h1>
  <p class="lede">Then tell your agent: <em>publish ./report.md as a relic</em>.
  It returns one link you can hand to anybody.</p>

  <h2>Claude Code</h2>
  <p>One command. <code>npx</code> fetches the server on first use and caches it.</p>
  <pre><code>claude mcp add relic \\
  --env RELIC_SERVICE_ORIGIN=${origin} \\
  -- npx -y relic-mcp@latest</code></pre>

  <h2>Claude Code, as a plugin</h2>
  <p>The npm package is the plugin, so the version can never disagree with
  itself. This also installs the publishing skill.</p>
  <pre><code>npm i -g relic-mcp
claude plugin marketplace add "$(npm root -g)/relic-mcp"
claude plugin install relic@relic</code></pre>

  <h2>Any client that takes JSON</h2>
  <p>Claude Desktop, Cursor, Windsurf, Cline, and most others read a variant of
  this. The key names differ. The shape does not.</p>
  <pre><code>{
  "mcpServers": {
    "relic": {
      "command": "npx",
      "args": ["-y", "relic-mcp@latest"],
      "env": {
        "RELIC_SERVICE_ORIGIN": "${origin}"
      }
    }
  }
}</code></pre>

  <h2>Why the origin is required</h2>
  <p>The server ships with no default origin. An unset value fails at startup
  and names the variable, instead of surfacing later as a DNS error on your
  first publish.</p>

  <h2>What leaves your machine</h2>
  <div class="note">
    <p>The server generates the key on your machine and encrypts in-process.
    Only ciphertext is uploaded. The key lives in the link fragment, and
    browsers never send a fragment to a server.</p>
    <p>Being straight about the limit: the page that decrypts is served by us,
    so that half rests on our intent rather than on something you can verify.
    The half that is structural is that we never receive the key.</p>
  </div>

  <h2>Links stay until deleted</h2>
  <p>A relic is kept until it is deleted. The publisher can ask for a
  lifetime when creating it; without one, the link does not age out.</p>

  <footer>
    <a href="/policy">What we store and what we can see</a> &middot;
    <a href="/abuse">Report a relic</a>
  </footer>
</main>
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
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  });
}

function abuseForm(config: RelicConfig): Response {
  // Works without JavaScript, as a plain form POST.
  const body = `<!doctype html>
<meta charset="utf-8">
<title>Report a relic</title>
<h1>Report a relic</h1>
<p>Paste the relic ID. Do not include the part after <code>#</code>: that is
the decryption key, and we do not want it. We strip it either way.</p>
<form method="post" action="/abuse">
  <label>Relic ID <input name="relic_id" required></label>
  <label>Category
    <select name="category" required>
      <option value="malware">Malware</option>
      <option value="phishing">Phishing</option>
      <option value="csam">CSAM</option>
      <option value="copyright">Copyright</option>
      <option value="legal_process">Legal process</option>
      <option value="other">Other</option>
    </select>
  </label>
  <label>What is wrong <textarea name="description" required></textarea></label>
  <label>Your contact <input name="contact" type="email"></label>
  <label>Issuing authority <input name="authority"></label>
  <label>Reference <input name="reference"></label>
  <button type="submit">Send report</button>
</form>
<p>We respond within ${config.abuseSlaHours} hours of arrival.</p>
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

function disclosureStatement(config: RelicConfig): string {
  const retention = Math.round(config.retentionSeconds / 86_400);
  return `# What Relic knows about your relic

Read this before you publish. The frame conditions the whole telemetry trade
on it being readable first.

## What we can never read

Your file is encrypted on your machine with a key your machine generates. The
key lives in the URL fragment, after the \`#\`. **Your browser never sends the
key to Relic's servers.** That is the correct form of the claim. Saying "the
key never reaches a server" unqualified would be wrong.

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

- **A coarse renderer class**, one of: markdown, code, html, image, media,
  archive, binary. Nothing finer.
- **The name of the tool that published it**, so we can tell whether Relic
  serves the contexts it was built for.
- **Open activity, correlated with the publishing IP address.** Upload IP and
  timestamp are retained for abuse response regardless.

This moves us from knowing nothing to knowing what kind of thing you published
and roughly how often it was fetched. It is metadata. It is never content.

## The length leak

Ciphertext length reveals plaintext length to within one record. Combined with
the class, we learn something like "an image of roughly 2.4 MB". We do not pad
to size buckets, because that cost is paid in egress by every recipient on
every fetch, forever.

## The key enters your AI session transcript

The publish tool returns the full URL including the fragment, because handing
you a usable link is the product. **The key therefore enters the model's
context and your session transcript on every publish.** Zero-knowledge holds
against us. It does not hold against your model provider or whoever stores
your transcripts. This is structural, not a defect we plan to fix.

## Publishing from the web page

The front page can encrypt and upload a file you drop on it. The key is drawn
and the file encrypted by JavaScript in your browser, and the link it hands
back is the only place the key exists: the page does not store it, and we
cannot recover it. Nothing sent to us carries the key or the filename; the
coarse class and the publishing tool's name are reported, as above. The key
does not enter a model transcript on this path.

A relic published this way cannot be updated later, because the credential
that allows an update is not kept in your browser. Publishing again makes a
new link.

## The JavaScript caveat

The code that decrypts a relic in your browser, and the code that encrypts a
file you publish from the web page, is served by us, the same party this
promise is made against, and we could serve different code tomorrow. This is
a statement about our intent, not a property you can verify.
Anyone claiming otherwise about a service of this shape is overclaiming.

## What rendered content can do

A relic that renders as HTML or JSX runs its author's code in your browser.
The frame that hosts it is served a policy that permits no remote source, so
that code cannot make an outbound request: it cannot reach the network, and
it cannot contact its author. A page that expects external images, fonts, or
scripts renders without them, because nothing is fetched.

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

## Reporting abuse

${config.serviceOrigin}/abuse. We respond within ${config.abuseSlaHours} hours
of arrival. That measures our responsiveness on reports we receive. It is not
coverage: we cannot inspect content, so unreported abuse is invisible to us.
`;
}
