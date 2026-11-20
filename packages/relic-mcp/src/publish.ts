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

import {
  deriveRendererClass,
  encodeKey,
  encryptRelic,
  generateKey,
  generateRelicId,
  guessMimetype,
  type RendererClass,
  relicUrl,
} from '@relic/format';
import { savePublishState } from './state.ts';

/**
 * Codes for the legs the app server is not in.
 *
 * `spec/service.md` 1.1 owns app-server-originated failures. A purely local
 * file error and a failure on the client-to-storage upload leg have no
 * app-server status, so they get codes here, and these never collide with the
 * server's. The state codes join them for the same reason: the publish state
 * is this machine's alone, so its failures are this machine's to report.
 */
export type ClientCode =
  | 'source_not_found'
  | 'source_is_directory'
  | 'source_not_regular_file'
  | 'source_unreadable'
  | 'local_size_precheck_failed'
  | 'upload_failed'
  | 'service_unreachable'
  | 'grant_missing_publish_token'
  | 'no_local_publish_state'
  | 'local_state_unreadable'
  | 'local_state_write_failed';

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

/** Filesystem access, injected so the flow is testable without a disk. */
export interface FileReader {
  stat(
    path: string
  ): Promise<
    { kind: 'file'; size: number } | { kind: 'directory' } | { kind: 'other' }
  >;
  read(path: string): Promise<Uint8Array>;
  resolve(path: string): string;
  basename(path: string): string;
}

export interface PublishInput {
  readonly path: string;
  readonly filename?: string | undefined;
  /**
   * A publisher-chosen lifetime in days. Undefined means the relic is kept
   * until someone deletes it. The field is omitted from the grant entirely
   * when unset, so the server's default decides, never a zero that happens
   * to survive the wire.
   */
  readonly ttl_days?: number | undefined;
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
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
}

export interface PublishDeps {
  readonly serviceOrigin: string;
  readonly relicOrigin: string;
  readonly files: FileReader;
  readonly fetch: typeof globalThis.fetch;
  readonly clientName: string;
  /** Retries on a colliding ID, which format.md 1.4 obliges the client to do. */
  readonly maxCollisionRetries?: number;
}

export async function publish(
  input: PublishInput,
  deps: PublishDeps
): Promise<PublishResult> {
  const source = await readSource(input.path, deps.files);

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

  // The class is derived from bytes this process already holds, never taken as
  // a tool input. Exposing it as a parameter would make the taxonomy
  // model-attested, and the metric's second clause would then have an
  // unreliable narrator reporting its only input.
  const rendererClass = deriveRendererClass(source.bytes, filename);

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
      grant = await postJson(deps, `${deps.serviceOrigin}/api/grant`, {
        challenge_nonce: challenge['challenge_nonce'],
        relic_id: relicId,
        renderer_class: rendererClass,
        publishing_client: deps.clientName,
        declared_size_bytes: source.bytes.length,
        declared_ciphertext_bytes: container.length,
        // Omitted rather than sent as anything, so an unset lifetime is the
        // server's default (kept until deleted) and never a value this
        // client guessed on the publisher's behalf.
        ...(input.ttl_days === undefined ? {} : { ttl_days: input.ttl_days }),
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

    // 4. Record what a republish needs, before success is reported. State a
    //    human cannot rebuild by hand only exists once it is on disk; a
    //    publish that returns without this step is a link that can never be
    //    updated from here, silently.
    try {
      await savePublishState(relicId, {
        key: encodeKey(key),
        publish_token: publishToken,
        version: 1,
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

    return {
      url,
      relic_id: relicId,
      version: 1,
      // Null is a real state now, the default one; String(null) would hand
      // the caller the four characters "null" where a date used to be.
      relic_expires_at:
        grant['relic_expires_at'] == null
          ? null
          : String(grant['relic_expires_at']),
      renderer_class: rendererClass,
      filename,
      resolved_path: source.resolvedPath,
      report_url: String(grant['report_url']),
      disclosure_url: String(grant['disclosure_url']),
    };
  }

  throw (
    lastCollision ??
    new PublishError('service_unreachable', 'could not obtain a grant')
  );
}

export async function readSource(
  path: string,
  files: FileReader
): Promise<SourceFile> {
  const resolvedPath = files.resolve(path);
  const stat = await files.stat(resolvedPath);

  if (stat.kind === 'directory') {
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

  let bytes: Uint8Array;
  try {
    bytes = await files.read(resolvedPath);
  } catch (error) {
    throw new PublishError(
      'source_unreadable',
      `could not read ${resolvedPath}: ${(error as Error).message}`
    );
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

  const parsed = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    // Clients key on `code`, never on prose. RFC 9457 says so about its own
    // `detail` member: consumers should not parse it for information.
    throw new ServerRefusal(
      String(parsed['code'] ?? 'unknown'),
      response.status,
      parsed
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
