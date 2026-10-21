/**
 * The publish flow.
 *
 * This runs on the publisher's machine and it is the only place the plaintext
 * and the key ever exist together. The app server is structurally not in
 * either leg: the client PUTs ciphertext straight to storage under a signed
 * grant.
 *
 * There is no server-returned script anywhere in here, and that is a locked
 * frame constraint rather than a style preference. CVE-2025-6514 earned CVSS
 * 9.6 for the accidental version of exactly the shape a returned script would
 * make deliberate.
 */

import { inflateRawSync } from 'node:zlib';
import {
  deriveRendererClass,
  deriveShareProof,
  encodeKey,
  encryptRelic,
  generateKey,
  generateRelicId,
  indexOtioZip,
  normalizeTitle,
  parseOtioJson,
  PLAINTEXT_CAP_BYTES,
  type RendererClass,
  relicUrl,
  shareVerifierFor,
} from '@relic/format';
import type {
  CoverOutcome,
  CoverReport,
  CoverSource,
} from '@relic/format/cover';
import { keyToMnemonic } from '@relic/format/mnemonic';
import { uploadCover } from './cover/upload.ts';
import { bundleOtiod } from './otio-bundle.ts';
import {
  loadPublishedSource,
  resolveSourceIdentity,
  type SourceIdentity,
  savePublishState,
} from './state.ts';

/**
 * Codes for the legs the app server is not in.
 *
 * `spec/service.md` 1.1 owns app-server-originated failures. A purely local
 * file error and a failure on the client-to-storage upload leg have no
 * app-server status, so they get codes here, and these never collide with the
 * server's. The state codes join them for the same reason: the publish state
 * is this machine's alone, so its failures are this machine's to report.
 *
 * The `local_comment_*` codes take the `local_` prefix `spec/publish.md` 2.2
 * reserves for a client-side refusal with no leg, rather than a bare
 * `comment_` one. The service owns its own comment refusals, and an
 * unprefixed name here would eventually collide with one of them.
 */
export type ClientCode =
  | 'source_not_found'
  | 'source_is_directory'
  | 'source_not_regular_file'
  | 'source_unreadable'
  | 'source_already_published'
  | 'local_size_precheck_failed'
  | 'upload_failed'
  | 'service_unreachable'
  | 'grant_missing_publish_token'
  | 'no_local_publish_state'
  | 'local_state_unreadable'
  | 'local_state_write_failed'
  | 'local_comment_body_empty'
  | 'local_comment_body_too_long'
  | 'local_comment_name_too_long'
  | 'local_comment_anchor_invalid'
  | 'local_comment_anchor_unsupported'
  | 'local_comment_anchor_kind_unknown'
  | 'local_comment_anchor_quote_empty'
  | 'local_comment_anchor_quote_too_long'
  | 'local_comment_anchor_context_invalid'
  | 'local_comment_anchor_context_too_long'
  | 'local_comment_anchor_pin_invalid'
  | 'local_comment_anchor_rect_invalid'
  | 'local_comment_anchor_rect_out_of_bounds'
  | 'local_comment_anchor_rect_zero_area'
  | 'local_comment_anchor_rect_overhang'
  | 'local_comment_anchor_time_missing'
  | 'local_comment_anchor_time_invalid'
  | 'local_comment_anchor_time_out_of_range'
  | 'local_comment_anchor_time_span_invalid'
  | 'local_comment_anchor_page_missing'
  | 'local_comment_anchor_page_out_of_range'
  | 'local_comment_addresses_invalid'
  | 'local_comment_addresses_too_long'
  | 'local_share_emails_invalid'
  | 'unaddressed_comments'
  | 'duplicate_version'
  | 'empty_acknowledgement_note'
  | 'invalid_acknowledgement_comment_id'
  | 'duplicate_acknowledgement'
  | 'unknown_comment_id'
  | 'unreadable_comment_cannot_be_addressed'
  | 'invalid_acknowledgements'
  | 'local_version_scope_invalid'
  | 'current_version_unavailable'
  | 'local_comment_not_found'
  | 'local_comment_unreadable'
  | 'app_response_unusable'
  | 'otio_bundle_invalid';
export class PublishError extends Error {
  override readonly name = 'PublishError';
  constructor(
    readonly code: ClientCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
  }
}

/** A refusal the app server originated, carrying its problem document. */
export class ServerRefusal extends Error {
  override readonly name = 'ServerRefusal';
  constructor(
    readonly code: string,
    readonly status: number,
    readonly problem: Readonly<Record<string, unknown>>
  ) {
    super(String(problem['detail'] ?? code));
  }
}

export interface SourceFile {
  readonly bytes: Uint8Array;
  readonly basename: string;
  readonly resolvedPath: string;
}

export interface ConfinedBundleFile {
  /** Size returned by fstat on the held native descriptor. */
  readonly size: number;
  /** Reads from that descriptor only, refusing more than maxBytes. */
  readBounded(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ConfinedBundleDirectory {
  /**
   * Opens a bundle-relative regular file under the pinned root descriptor.
   * The implementation must not reopen or resolve a string pathname in JS.
   */
  openRegular(relativePath: string): Promise<ConfinedBundleFile>;
  close(): Promise<void>;
}

/** Filesystem access, injected so the flow is testable without a disk. */
export interface FileReader {
  stat(
    path: string
  ): Promise<
    | { kind: 'file'; size: number }
    | { kind: 'directory' }
    | { kind: 'symlink' }
    | { kind: 'other' }
  >;
  read(path: string): Promise<Uint8Array>;
  resolve(path: string): string;
  basename(path: string): string;
  /** Required for .otiod. It is the only authority for bundle descendants. */
  openBundleRoot(path: string): Promise<ConfinedBundleDirectory>;
}

export interface PublishInput {
  readonly path: string;
  readonly filename?: string | undefined;
  /**
   * Optional plaintext title shown in link previews and the browser tab.
   * Defaults to the filename. Stored by the service in the clear so unfurlers
   * can render a card. Pass "" to publish without a title.
   */
  readonly title?: string | undefined;
  /**
   * A publisher-chosen lifetime in days. Undefined means the relic is kept
   * until someone deletes it. The field is omitted from the grant entirely
   * when unset, so the server's default decides, never a zero that happens
   * to survive the wire.
   */
  readonly ttl_days?: number | undefined;
  /**
   * Bypass prior-publish refusal only when a second independent URL is
   * intentional. False and undefined both preserve the existing URL.
   */
  readonly force_new?: boolean | undefined;
  /**
   * Optional cover image flag. Defaults to true. Pass false to decline
   * rendering and uploading a cover image for link previews.
   */
  readonly cover?: boolean | undefined;
}

export interface PublishResult {
  readonly url: string;
  readonly relic_id: string;
  /**
   * Always 1 here: a fresh id is a fresh relic, and the client knows it
   * without asking. Republish counts upward from the local state file.
   */
  readonly version: number;
  /** Null when the relic has no lifetime, which is now the default. */
  readonly relic_expires_at: string | null;
  readonly renderer_class: RendererClass;
  readonly filename: string;
  /**
   * Stored by the service in the clear for link previews. Null when published
   * without a title.
   */
  readonly title: string | null;
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
  readonly key_phrase: string;
  readonly cover: CoverReport;
}

export interface PublishDeps {
  readonly serviceOrigin: string;
  readonly relicOrigin: string;
  readonly files: FileReader;
  readonly fetch: typeof globalThis.fetch;
  readonly clientName: string;
  /** Test seam for a filesystem that does not exist outside memory. */
  readonly identifySource?: (path: string) => Promise<SourceIdentity>;
  /** Retries on a colliding ID, which format.md 1.4 obliges the client to do. */
  readonly maxCollisionRetries?: number;
  /** Path to ffmpeg binary, or null to simulate ffmpeg being absent. */
  readonly ffmpegPath?: string | null;
  readonly renderCover: (source: CoverSource) => Promise<CoverOutcome>;
}

export interface RepublishToolCall {
  readonly name: 'relic_republish';
  readonly arguments: {
    readonly relic_id: string;
    readonly path: string;
  };
}

export interface PriorPublish {
  readonly relic_id: string;
  readonly version: number;
  readonly source: SourceIdentity;
}

export interface PublishedSourceLookup {
  readonly resolved_path: string;
  readonly source: SourceIdentity;
  readonly match?: PriorPublish | undefined;
}

/** The complete call an agent can make without retaining an earlier session. */
export function republishToolCall(
  relicId: string,
  path: string
): RepublishToolCall {
  return {
    name: 'relic_republish',
    arguments: { relic_id: relicId, path },
  };
}

async function lookupResolvedSource(
  resolvedPath: string,
  deps: PublishDeps
): Promise<PublishedSourceLookup> {
  let source: SourceIdentity;
  try {
    source = await (deps.identifySource ?? resolveSourceIdentity)(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PublishError(
      code === 'ENOENT' ? 'source_not_found' : 'source_unreadable',
      `could not resolve source identity for ${resolvedPath}: ` +
        (error as Error).message,
      { path: resolvedPath }
    );
  }

  try {
    const published = await loadPublishedSource(source);
    return {
      resolved_path: resolvedPath,
      source,
      ...(published === undefined
        ? {}
        : {
            match: {
              relic_id: published.relic_id,
              version: published.state.version,
              source: published.source,
            },
          }),
    };
  } catch (error) {
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }
}

/** Look up a path in local state without reading its bytes or calling a server. */
export async function lookupPublishedSource(
  path: string,
  deps: PublishDeps
): Promise<PublishedSourceLookup> {
  return lookupResolvedSource(deps.files.resolve(path), deps);
}

export async function publish(
  input: PublishInput,
  deps: PublishDeps
): Promise<PublishResult> {
  const source = await readSource(input.path, deps.files);
  const sourceLookup = await lookupResolvedSource(source.resolvedPath, deps);
  if (sourceLookup.match !== undefined && input.force_new !== true) {
    const match = sourceLookup.match;
    const republishCall = republishToolCall(
      match.relic_id,
      source.resolvedPath
    );
    const cost = 'a second URL that nobody holding the first one will ever see';
    throw new PublishError(
      'source_already_published',
      `${match.source.description} is already version ${match.version} of ` +
        `relic ${match.relic_id}. Publishing it as new would cost ${cost}. ` +
        `Call relic_republish(${JSON.stringify(republishCall.arguments)}) ` +
        'instead. Set force_new to true only when you intend a separate relic.',
      {
        relic_id: match.relic_id,
        version: match.version,
        source_identity: match.source.identity,
        source_description: match.source.description,
        cost,
        republish_call: republishCall,
      }
    );
  }

  // 1. Challenge. This returns the cap before a grant is requested, so the
  //    precheck below uses a number that came from the server moments ago
  //    rather than a compiled-in constant that goes stale. Policy is never
  //    cached locally; the one thing publish now keeps on disk is state, in
  //    state.ts, and it is secrets, not policy.
  const challenge = await postJson(
    deps,
    `${deps.serviceOrigin}/api/challenge`,
    {}
  );
  const sizeLimit = Number(challenge['size_limit_bytes']);
  const sizeBasis = String(challenge['size_basis']);

  if (source.bytes.length > sizeLimit) {
    throw new PublishError(
      'local_size_precheck_failed',
      `${source.basename} is ${source.bytes.length} bytes, over the ` +
        `${sizeLimit}-byte cap`,
      {
        size_limit_bytes: sizeLimit,
        declared_size_bytes: source.bytes.length,
        size_basis: sizeBasis,
      }
    );
  }

  const filename = input.filename ?? source.basename;
  const normalizedTitle = normalizeTitle(input.title ?? filename);
  // The class is derived from bytes this process already holds, never taken as
  // a tool input. Exposing it as a parameter would make the taxonomy
  // model-attested, and the metric's second clause would then have an
  // unreliable narrator reporting its only input.
  const rendererClass = deriveRendererClass(source.bytes, filename);
  // What this version's plaintext is, recorded so the next republish from
  // this machine can tell a change from a re-upload of the same thing.
  const digest = await contentDigest({
    content: source.bytes,
    filename,
    title: normalizedTitle,
  });

  const requested = input.cover !== false;
  let coverOutcome: CoverOutcome;
  if (!requested) {
    coverOutcome = {
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'declined by publisher',
    };
  } else {
    try {
      coverOutcome = await deps.renderCover({
        bytes: source.bytes,
        filename,
        mimetype: guessMimetype(filename, rendererClass),
        rendererClass,
      });
    } catch (error) {
      coverOutcome = {
        status: 'skipped',
        reason: 'render_failed',
        detail: (error as Error).message,
      };
    }
  }

  const retries = deps.maxCollisionRetries ?? 3;
  let lastCollision: ServerRefusal | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 2. The client owns the ID and the key before anything leaves the
    //    machine, drawn independently from the platform CSPRNG. Neither
    //    derives from the other: deriving the key from the ID would put the
    //    key in the operator's hands, since the operator has every ID.
    const relicId = generateRelicId();
    const key = generateKey();

    // Encrypt before requesting the grant, so the grant can pin the object's
    // exact byte length. A fresh salt is drawn per attempt, so this has to sit
    // inside the retry loop alongside the id and the key.
    const container = await encryptRelic({
      content: source.bytes,
      filename,
      mimetype: guessMimetype(filename, rendererClass),
      key,
    });

    let grant: Record<string, unknown>;
    try {
      const shareVerifier = await shareVerifierFor(await deriveShareProof(key));
      grant = await postJson(deps, `${deps.serviceOrigin}/api/grant`, {
        challenge_nonce: challenge['challenge_nonce'],
        relic_id: relicId,
        renderer_class: rendererClass,
        publishing_client: deps.clientName,
        declared_size_bytes: source.bytes.length,
        declared_ciphertext_bytes: container.length,
        title: normalizedTitle,
        // Omitted rather than sent as anything, so an unset lifetime is the
        // server's default (kept until deleted) and never a value this
        // client guessed on the publisher's behalf.
        ...(input.ttl_days === undefined ? {} : { ttl_days: input.ttl_days }),
        share_verifier: shareVerifier,
      });
    } catch (error) {
      if (
        error instanceof ServerRefusal &&
        error.code === 'relic_id_collision'
      ) {
        // Astronomical bad luck or a broken RNG. Both should fail loudly if
        // they persist, which is why the retry count is small.
        lastCollision = error;
        continue;
      }
      throw error;
    }
    // The grant hands the publish token over exactly once, here. Without it
    // this machine can never issue another version of the relic, so a grant
    // missing it is refused before any bytes move, rather than after the
    // object exists and the omission is somebody's support ticket.
    const publishToken = grant['publish_token'];
    if (typeof publishToken !== 'string' || publishToken.length === 0) {
      throw new PublishError(
        'grant_missing_publish_token',
        'the grant carried no publish_token, so the relic would never be ' +
          'republishable from this machine',
        { relic_id: relicId }
      );
    }

    // 3. Straight to storage, then report completion. Both legs are shared
    //    with republish, because a version-2 object earns the same handling
    //    a version-1 one does.
    await putContainer(deps, relicId, String(grant['upload_url']), container);
    await reportComplete(deps, relicId);

    const url = relicUrl(deps.relicOrigin, relicId, key);
    const relicExpiresAt =
      grant['relic_expires_at'] == null
        ? null
        : String(grant['relic_expires_at']);

    // 4. Record what a republish needs, before success is reported. State a
    //    human cannot rebuild by hand only exists once it is on disk; a
    //    publish that returns without this step is a link that can never be
    //    updated from here, silently.
    //
    //    The filename, the timestamp, and the lifetime are recorded with it.
    //    None is needed to republish, and all three are what makes the relic
    //    findable afterwards: without them an inventory has to spend one of
    //    the relic's finite opens to learn its own name back, and the
    //    publish date is knowledge the service will not hand a client at all,
    //    so a publish that does not write it down loses it for good.
    try {
      await savePublishState(relicId, {
        key: encodeKey(key),
        publish_token: publishToken,
        version: 1,
        source: sourceLookup.source,
        filename,
        content_sha256: digest,
        published_at: new Date().toISOString(),
        expires_at: relicExpiresAt,
        cover_uploaded: false,
      });
    } catch (error) {
      // The relic itself is live and the URL works, so both are handed over
      // in the failure rather than lost to the error path. What failed is
      // only the local record, but that failure is permanent for this
      // machine, so it is reported as a failure.
      throw new PublishError(
        'local_state_write_failed',
        'the relic is published and the link works, but recording it for ' +
          `later republishing failed, so it cannot be republished from this ` +
          `machine: ${(error as Error).message}`,
        { relic_id: relicId, url }
      );
    }

    let coverReport: CoverReport;
    if (!requested) {
      coverReport = { status: 'declined' };
    } else if (coverOutcome.status === 'skipped') {
      coverReport = {
        status: 'skipped',
        reason: coverOutcome.reason,
        detail: coverOutcome.detail,
      };
    } else {
      coverReport = await uploadCover(deps, {
        relicId,
        publishToken,
        version: 1,
        kind: coverOutcome.kind,
        type: coverOutcome.type,
        bytes: coverOutcome.bytes,
      });
      if (coverReport.status === 'uploaded') {
        try {
          await savePublishState(relicId, {
            key: encodeKey(key),
            publish_token: publishToken,
            version: 1,
            source: sourceLookup.source,
            filename,
            content_sha256: digest,
            published_at: new Date().toISOString(),
            expires_at: relicExpiresAt,
            cover_uploaded: true,
          });
        } catch {
          // If the second write fails the publish still succeeds
        }
      }
    }

    return {
      url,
      relic_id: relicId,
      version: 1,
      // Null is a real state now, the default one; String(null) would hand
      // the caller the four characters "null" where a date used to be.
      relic_expires_at: relicExpiresAt,
      renderer_class: rendererClass,
      filename,
      title: normalizedTitle.length === 0 ? null : normalizedTitle,
      resolved_path: source.resolvedPath,
      report_url: String(grant['report_url']),
      disclosure_url: String(grant['disclosure_url']),
      key_phrase: keyToMnemonic(key).join(' '),
      cover: coverReport,
    };
  }

  throw (
    lastCollision ??
    new PublishError('service_unreachable', 'could not obtain a grant')
  );
}

/**
 * Name one version's plaintext, so the next one can be recognised as the
 * same.
 *
 * Over the name and title as well as the bytes, because those two ride in
 * the envelope and show on the card: retitling a relic changes what a
 * recipient is handed even when the content does not, so it is a real
 * version. The header is JSON and cannot contain a NUL, which is what keeps
 * the separator unambiguous without a length prefix.
 *
 * Never sent anywhere. It is a local record of what this machine last put
 * behind the link; the service is not asked and does not know.
 */
export async function contentDigest(input: {
  readonly content: Uint8Array;
  readonly filename: string;
  readonly title: string;
}): Promise<string> {
  const header = new TextEncoder().encode(
    `${JSON.stringify([input.filename, input.title])}\0`
  );
  const material = new Uint8Array(header.length + input.content.length);
  material.set(header, 0);
  material.set(input.content, header.length);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    material.slice().buffer as ArrayBuffer
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function readSource(
  path: string,
  files: FileReader
): Promise<SourceFile> {
  const resolvedPath = files.resolve(path);
  const stat = await files.stat(resolvedPath);

  if (stat.kind === 'symlink') {
    throw new PublishError(
      'source_not_regular_file',
      `${resolvedPath} is a symlink`
    );
  }

  if (stat.kind === 'directory') {
    const base = files.basename(resolvedPath);
    if (base.toLowerCase().endsWith('.otiod')) {
      // Securely package the .otiod bundle into a standard deterministic .otioz archive.
      const bundled = await bundleOtiod(resolvedPath, files);
      return {
        bytes: bundled.bytes,
        basename: bundled.defaultFilename,
        resolvedPath: bundled.resolvedPath,
      };
    }
    // format.md 3.1 fixes entry count at exactly 1 in version 1, so a
    // directory cannot be represented as a multi-entry relic at all.
    // Publishing one would mean silently tarring it into an opaque blob that
    // takes class `archive` and is download-only, producing an unrenderable
    // relic and no error.
    throw new PublishError(
      'source_is_directory',
      `${resolvedPath} is a directory. Create an archive yourself and ` +
        'publish that, so the download-only outcome is yours to choose.'
    );
  }

  if (stat.kind === 'other') {
    // A FIFO, socket, or device node is readable and has no stable size,
    // which breaks the declared-size contract before it starts.
    throw new PublishError(
      'source_not_regular_file',
      `${resolvedPath} is not a regular file`
    );
  }

  if (
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > PLAINTEXT_CAP_BYTES
  ) {
    throw new PublishError(
      'local_size_precheck_failed',
      `${resolvedPath} size (${stat.size} bytes) exceeds the ${PLAINTEXT_CAP_BYTES}-byte plaintext cap`
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await files.read(resolvedPath);
  } catch (error) {
    throw new PublishError(
      'source_unreadable',
      `could not read ${resolvedPath}: ${(error as Error).message}`
    );
  }

  if (bytes.length > PLAINTEXT_CAP_BYTES) {
    throw new PublishError(
      'local_size_precheck_failed',
      `${resolvedPath} changed beyond the ${PLAINTEXT_CAP_BYTES}-byte plaintext cap while being read`
    );
  }

  const base = files.basename(resolvedPath).toLowerCase();
  if (base.endsWith('.otioz')) {
    // Validate existing .otioz archive structurally before grant/upload.
    try {
      await indexOtioZip(bytes, {
        maxExpandedBytes: PLAINTEXT_CAP_BYTES,
        inflater: async (compressed, _uncompressedSize, maxBytes) =>
          new Uint8Array(
            inflateRawSync(compressed, { maxOutputLength: maxBytes })
          ),
      });
    } catch (err) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Invalid .otioz archive: ${(err as Error).message}`
      );
    }
  } else if (base.endsWith('.otio')) {
    // Validate raw .otio JSON structurally.
    try {
      const parsed = parseOtioJson(bytes);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('root must be a JSON object');
      }
    } catch (err) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Invalid .otio JSON: ${(err as Error).message}`
      );
    }
  }

  return { bytes, basename: files.basename(resolvedPath), resolvedPath };
}

export async function postJson(
  deps: PublishDeps,
  url: string,
  body: unknown
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PublishError(
      'service_unreachable',
      `could not reach ${url}: ${(error as Error).message}`
    );
  }

  const parsed = await readJson(response);
  // Every publish leg answers with an object. A body that is not one is read
  // as empty rather than crashing the caller on its first member read.
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * PATCH a JSON document on the app server.
 *
 * The comment edit and resolve legs are the callers, and both answer with a
 * single comment object, so the shape is narrowed there rather than here. The
 * leg is otherwise identical to `postJson`: the token rides in the body, and a
 * service refusal throws as a named problem document.
 */
export async function patchJson(
  deps: PublishDeps,
  url: string,
  body: unknown
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PublishError(
      'service_unreachable',
      `could not reach ${url}: ${(error as Error).message}`
    );
  }

  const parsed = await readJson(response);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * GET a JSON document from the app server.
 *
 * Separate from `postJson` only because the payload may legitimately be an
 * array: the comment list is one. The refusal handling is the same leg and
 * the same rules, so it is shared rather than restated.
 */
export async function getJson(
  deps: PublishDeps,
  url: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(url);
  } catch (error) {
    throw new PublishError(
      'service_unreachable',
      `could not reach ${url}: ${(error as Error).message}`
    );
  }
  return readJson(response);
}

/**
 * Throw the app server's refusal, or hand back whatever it answered with.
 *
 * The shape is deliberately `unknown`: the grant legs answer with an object
 * and the comment list answers with an array, so narrowing belongs to the
 * caller that knows which it asked for.
 */
async function readJson(response: Response): Promise<unknown> {
  const parsed = await response.json().catch(() => undefined);

  if (!response.ok) {
    // Clients key on `code`, never on prose. RFC 9457 says so about its own
    // `detail` member: consumers should not parse it for information. A body
    // that is not a problem document still has to produce a refusal, so an
    // unusable one degrades to `unknown` rather than throwing here.
    const problem =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    throw new ServerRefusal(
      String(problem['code'] ?? 'unknown'),
      response.status,
      problem
    );
  }

  return parsed;
}

/**
 * PUT the ciphertext to storage under a signed URL.
 *
 * Shared by publish and republish because the leg is identical and its
 * details are load-bearing: the grant signed this exact length, so it is
 * sent explicitly rather than left to whatever the runtime infers from the
 * body.
 */
export async function putContainer(
  deps: PublishDeps,
  relicId: string,
  uploadUrl: string,
  container: Uint8Array
): Promise<void> {
  const upload = await deps.fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-length': String(container.length) },
    body: container as unknown as BodyInit,
  });
  if (!upload.ok) {
    throw new PublishError(
      'upload_failed',
      `upload returned ${upload.status}`,
      {
        relic_id: relicId,
        status: upload.status,
      }
    );
  }
}

/**
 * Report a finished upload, so the server has a true publish timestamp.
 *
 * An optimization, never a requirement: the confirmation is the message
 * that gets lost, which is why the client owns the ID and the key before
 * anything leaves the machine. The first mint anchors the timestamp if
 * this call disappears.
 */
export async function reportComplete(
  deps: PublishDeps,
  relicId: string
): Promise<void> {
  try {
    await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${relicId}/complete`,
      {}
    );
  } catch {
    // Deliberately swallowed. The object is uploaded and the link is valid.
  }
}

const MIMETYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  gz: 'application/gzip',
  pdf: 'application/pdf',
  // Component source declares what it is. text/plain or text/javascript
  // would both read as `code` on the far side and the relic would render
  // as escaped source, silently, which is the one outcome a component
  // author would never guess had happened.
  jsx: 'text/jsx',
  tsx: 'text/tsx',
};

const CLASS_FALLBACK: Readonly<Record<RendererClass, string>> = {
  markdown: 'text/markdown',
  code: 'text/plain',
  html: 'text/html',
  jsx: 'text/jsx',
  // Declared precisely rather than as octet-stream, unlike the other binary
  // formats below it. The viewer routes a pdf to a renderer, and the sniffed
  // and declared classes are reconciled by taking the least privileged of the
  // two, so an octet-stream fallback here would demote a real PDF to a
  // download whenever the publishing client could not read an extension.
  pdf: 'application/pdf',
  image: 'application/octet-stream',
  media: 'application/octet-stream',
  otio: 'application/x-otioz',
  archive: 'application/octet-stream',
  binary: 'application/octet-stream',
};

/**
 * The declared mimetype for the envelope header.
 *
 * It is untrusted display text on the far side, and the viewer treats a
 * disagreement between it and the sniffed type by routing to the least
 * privileged path either would allow.
 */
export function guessMimetype(
  filename: string,
  rendererClass: RendererClass
): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot > 0 && dot < base.length - 1) {
    const found = MIMETYPES[base.slice(dot + 1)];
    if (found !== undefined) return found;
  }
  return CLASS_FALLBACK[rendererClass];
}
