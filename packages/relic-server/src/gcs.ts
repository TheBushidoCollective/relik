/**
 * Google Cloud Storage, through V4 signed URLs only.
 *
 * Publishing clients PUT ciphertext straight to GCS and recipients GET it
 * from GCS under signed URLs. The app server is outside both of those data
 * paths. Control-plane operations can stream stored ciphertext for hashing,
 * but never receive the decryption key.
 *
 * Data requests use signed URLs. Before hashing, the JSON API reads and,
 * when needed, updates object metadata to prevent GCS transcoding.
 *
 * The kill switch is worth stating plainly, because it shapes the validity
 * window. Disabling minting does nothing to URLs already minted: the residual
 * drain is live URLs times remaining validity times object size. Rotating the
 * signing key is the only second-stage stop and it is indiscriminate, killing
 * every outstanding URL including honest in-flight downloads. So the validity
 * window is a cost-control parameter, not a convenience one.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ObjectStat, ObjectStorage, SignedUpload } from './storage.ts';

/**
 * What V4 signing needs: an identity to name in the credential scope, and
 * something that can produce an RSA signature for it.
 *
 * Split behind an interface so production never needs a downloaded key. On
 * Cloud Run the signature is produced by the IAM Credentials API using the
 * attached service account, so there is no private key anywhere: not on disk,
 * not in an environment variable, and not in a secret to rotate. A downloaded
 * key would be a static credential with no expiry, which is exactly what the
 * house pattern exists to avoid.
 */
export interface Signer {
  readonly clientEmail: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** OAuth token for metadata changes, when the signer has ambient credentials. */
  getAccessToken?(): Promise<string>;
}

export interface GcsOptions {
  readonly bucket: string;
  readonly signer: Signer;
  /** Prefix inside the bucket. Relic ids are appended to it. */
  readonly prefix?: string;
  readonly host?: string;
  /** Optional injection points for a local storage fake. */
  readonly getAccessToken?: () => Promise<string>;
  readonly metadataFetch?: typeof globalThis.fetch;
  readonly rawRequest?: (
    url: string,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void
  ) => ClientRequest;
}

/** GCS caps signed URL lifetime here, and it is asserted rather than assumed. */
export const MAX_EXPIRES_SECONDS = 604_800;

const ALGORITHM = 'GOOG4-RSA-SHA256';
const DEFAULT_HOST = 'storage.googleapis.com';

/**
 * RFC 3986 encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone, and GCS canonicalization does
 * not. A mismatch here produces a signature that verifies against a different
 * request than the one being made, which fails as an opaque 403 at upload
 * time rather than as anything diagnosable.
 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Object paths keep their separators; every other reserved character escapes. */
export function encodeObjectPath(path: string): string {
  return path.split('/').map(rfc3986).join('/');
}

export function toTimestamp(epochMillis: number): string {
  return `${new Date(epochMillis).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

export function toDatestamp(epochMillis: number): string {
  return toTimestamp(epochMillis).slice(0, 8);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as BufferSource
  );
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Import a PKCS#8 PEM for RSASSA-PKCS1-v1_5 signing. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export interface SignRequestInput {
  readonly method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  readonly host: string;
  /** Already-encoded, leading slash included. */
  readonly path: string;
  readonly clientEmail: string;
  readonly expiresSeconds: number;
  readonly now: number;
  /** Extra headers to sign. `host` is always included. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SignedRequestParts {
  readonly canonicalRequest: string;
  readonly query: string;
  readonly signedHeaders: string;
}

/**
 * Build the canonical request and the string to sign.
 *
 * Split out from signing so the construction is testable without a key, which
 * matters because every field here is a place a silent mismatch turns into an
 * opaque 403 at the moment a publish is happening.
 */
export function buildSignedRequest(
  input: SignRequestInput
): SignedRequestParts {
  if (input.expiresSeconds > MAX_EXPIRES_SECONDS) {
    throw new Error(
      `expiry ${input.expiresSeconds}s exceeds the GCS ceiling of ` +
        `${MAX_EXPIRES_SECONDS}s`
    );
  }

  const timestamp = toTimestamp(input.now);
  const scope = `${toDatestamp(input.now)}/auto/storage/goog4_request`;

  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim();
  }

  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');

  // Query parameters are sorted by encoded key, then encoded value.
  const parameters: Array<[string, string]> = [
    ['X-Goog-Algorithm', ALGORITHM],
    ['X-Goog-Credential', `${input.clientEmail}/${scope}`],
    ['X-Goog-Date', timestamp],
    ['X-Goog-Expires', String(input.expiresSeconds)],
    ['X-Goog-SignedHeaders', signedHeaders],
  ];

  const query = parameters
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    input.path,
    query,
    canonicalHeaders,
    signedHeaders,
    // Signed URLs do not commit to a body hash.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  return { canonicalRequest, query, signedHeaders };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The exact bytes a signature is computed over.
 *
 * One definition, used by the signer and asserted directly by the tests, so
 * the two cannot drift into signing different things.
 */
export async function stringToSignFor(
  input: SignRequestInput
): Promise<string> {
  const parts = buildSignedRequest(input);
  return [
    ALGORITHM,
    toTimestamp(input.now),
    `${toDatestamp(input.now)}/auto/storage/goog4_request`,
    await sha256Hex(parts.canonicalRequest),
  ].join('\n');
}

/** Sign a request and return the full URL. */
export async function signUrl(
  input: SignRequestInput,
  signer: Signer
): Promise<string> {
  const parts = buildSignedRequest(input);
  const signature = await signer.sign(
    new TextEncoder().encode(await stringToSignFor(input))
  );

  return (
    `https://${input.host}${input.path}?${parts.query}` +
    `&X-Goog-Signature=${hex(signature)}`
  );
}

/**
 * Signs with a downloaded PKCS#8 key.
 *
 * For local development and for the tests, which need a signature they can
 * verify against a known public key. Production uses `iamSigner`.
 */
export function privateKeySigner(
  clientEmail: string,
  privateKeyPem: string
): Signer {
  const keyPromise = importPrivateKey(privateKeyPem);
  return {
    clientEmail,
    async sign(bytes: Uint8Array): Promise<Uint8Array> {
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        await keyPromise,
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
      );
      return new Uint8Array(signature);
    },
  };
}

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1';

/** Read the attached service account's email and access token on Cloud Run. */
async function metadata(path: string): Promise<string> {
  const response = await fetch(`${METADATA_ROOT}/${path}`, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!response.ok) {
    throw new Error(`metadata ${path} returned ${response.status}`);
  }
  return (await response.text()).trim();
}

/**
 * Signs through the IAM Credentials API using the ambient identity.
 *
 * No key material exists anywhere in the deployment. The access token comes
 * from the metadata server and is short-lived, and the signing capability is
 * an IAM role on the service account rather than a file.
 *
 * The cost, stated because it is a real one: every signature is a network
 * round trip to `iamcredentials.googleapis.com`, so a mint is slower than it
 * would be with a local key and it fails when that API is unreachable. That
 * is the correct trade against holding a credential that never expires.
 */
export function iamSigner(options: {
  readonly clientEmail: string;
  readonly getAccessToken: () => Promise<string>;
}): Signer {
  return {
    clientEmail: options.clientEmail,
    getAccessToken: options.getAccessToken,
    async sign(bytes: Uint8Array): Promise<Uint8Array> {
      const token = await options.getAccessToken();
      const response = await fetch(
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
          `${encodeURIComponent(options.clientEmail)}:signBlob`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            payload: btoa(String.fromCharCode(...bytes)),
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `signBlob returned ${response.status}: ${await response.text()}`
        );
      }

      const body = (await response.json()) as { signedBlob: string };
      return Uint8Array.from(atob(body.signedBlob), (ch) => ch.charCodeAt(0));
    },
  };
}

let cachedToken: { value: string; expiresAt: number } | undefined;

/**
 * The attached identity's OAuth token, for APIs that take a bearer token
 * rather than a signature.
 *
 * Cached until shortly before it expires. The metadata server is a local hop
 * and caches too, but the store below calls this on every read and write, and
 * a per-operation round trip is a latency floor worth not having.
 */
export async function metadataAccessToken(now = Date.now()): Promise<string> {
  if (cachedToken !== undefined && now < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const raw = await metadata('instance/service-accounts/default/token');
  const parsed = JSON.parse(raw) as {
    access_token: string;
    expires_in: number;
  };

  // A minute of headroom, so a token cannot expire in flight.
  cachedToken = {
    value: parsed.access_token,
    expiresAt: now + Math.max(0, parsed.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

/** The signer a Cloud Run deployment uses: ambient identity, no key. */
export async function metadataSigner(): Promise<Signer> {
  const clientEmail = await metadata('instance/service-accounts/default/email');
  return iamSigner({
    clientEmail,
    getAccessToken: async () => {
      const raw = await metadata('instance/service-accounts/default/token');
      return (JSON.parse(raw) as { access_token: string }).access_token;
    },
  });
}

interface DigestMetadata {
  readonly generation: string;
  readonly metageneration: string;
  readonly length: number;
  readonly contentEncoding: string | undefined;
  readonly cacheControl: string | undefined;
}

function digestMetadata(value: unknown): DigestMetadata {
  if (typeof value !== 'object' || value === null) {
    throw new Error('digest metadata is invalid');
  }
  const data = value as Record<string, unknown>;
  if (
    typeof data['generation'] !== 'string' ||
    !/^[1-9]\d*$/.test(data['generation']) ||
    typeof data['metageneration'] !== 'string' ||
    !/^[1-9]\d*$/.test(data['metageneration']) ||
    typeof data['size'] !== 'string' ||
    !/^\d+$/.test(data['size']) ||
    !Number.isSafeInteger(Number(data['size'])) ||
    (data['contentEncoding'] !== undefined &&
      typeof data['contentEncoding'] !== 'string') ||
    (data['cacheControl'] !== undefined &&
      typeof data['cacheControl'] !== 'string')
  ) {
    throw new Error('digest metadata is missing a valid generation or size');
  }
  return {
    generation: data['generation'],
    metageneration: data['metageneration'],
    length: Number(data['size']),
    contentEncoding: data['contentEncoding'] as string | undefined,
    cacheControl: data['cacheControl'] as string | undefined,
  };
}

function hasNoTransform(cacheControl: string | undefined): boolean {
  if (!cacheControl) return false;
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < cacheControl.length; i++) {
    const char = cacheControl[i];
    if (escaped) {
      escaped = false;
    } else if (quoted && char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      if (
        cacheControl.slice(start, i).trim().toLowerCase() === 'no-transform'
      ) {
        return true;
      }
      start = i + 1;
    }
  }
  return (
    !quoted && cacheControl.slice(start).trim().toLowerCase() === 'no-transform'
  );
}

/** Node HTTP streams encoded response bytes; fetch transparently decompresses. */
function rawGet(
  url: string,
  headers: Record<string, string>,
  request: NonNullable<GcsOptions['rawRequest']>
): Promise<IncomingMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const pending = request(url, { method: 'GET', headers }, resolve);
  pending.on('error', reject);
  pending.end();
  return promise;
}

/** Exchange a locally signed service-account assertion for the JSON API. */
async function tokenForSigner(
  signer: Signer,
  doFetch: typeof globalThis.fetch
): Promise<{ value: string; expiresAt: number }> {
  const issued = Math.floor(Date.now() / 1000);
  const audience = 'https://oauth2.googleapis.com/token';
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({
      iss: signer.clientEmail,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: audience,
      iat: issued,
      exp: issued + 3600,
    }),
  ].join('.');
  const signature = await signer.sign(new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
  const response = await doFetch(audience, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`digest token exchange failed with ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (
    typeof body['access_token'] !== 'string' ||
    body['access_token'].length === 0 ||
    typeof body['expires_in'] !== 'number' ||
    !Number.isFinite(body['expires_in']) ||
    body['expires_in'] <= 0
  ) {
    throw new Error('digest token exchange returned invalid credentials');
  }
  return {
    value: body['access_token'],
    expiresAt: Date.now() + Math.max(0, body['expires_in'] - 60) * 1000,
  };
}

export function gcsStorage(options: GcsOptions): ObjectStorage {
  const host = options.host ?? DEFAULT_HOST;
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const doFetch = options.metadataFetch ?? globalThis.fetch;
  const request =
    options.rawRequest ??
    ((
      url: string,
      init: RequestOptions,
      callback: (r: IncomingMessage) => void
    ) => httpsRequest(url, init, callback));
  let signerToken: { value: string; expiresAt: number } | undefined;

  const accessToken = async (): Promise<string> => {
    if (options.getAccessToken) return options.getAccessToken();
    if (options.signer.getAccessToken) return options.signer.getAccessToken();
    if (!signerToken || Date.now() >= signerToken.expiresAt) {
      signerToken = await tokenForSigner(options.signer, doFetch);
    }
    return signerToken.value;
  };

  const objectFor = (relicId: string): string =>
    prefix.length > 0 ? `${prefix}/${relicId}` : relicId;

  const pathFor = (relicId: string): string =>
    `/${encodeObjectPath(options.bucket)}/${encodeObjectPath(objectFor(relicId))}`;

  const sign = async (
    method: SignRequestInput['method'],
    relicId: string,
    expiresSeconds: number,
    now: number,
    headers?: Record<string, string>
  ): Promise<string> =>
    signUrl(
      {
        method,
        host,
        path: pathFor(relicId),
        clientEmail: options.signer.clientEmail,
        expiresSeconds,
        now,
        ...(headers === undefined ? {} : { headers }),
      },
      options.signer
    );

  return {
    async signUpload(
      relicId: string,
      contentLength: number,
      validitySeconds: number,
      now: number
    ): Promise<SignedUpload> {
      // `Content-Length` is signed, so the upload must be exactly this many
      // bytes or the signature fails. That is stronger than a cap: it pins
      // the object's size rather than bounding it, and a signed PUT would
      // otherwise ignore the declared length entirely.
      //
      // No `x-goog-meta-*` is signed, because nothing needs custom object
      // metadata and anything content-descriptive is barred from living there.
      const headers = { 'content-length': String(contentLength) };
      const url = await sign('PUT', relicId, validitySeconds, now, headers);

      return {
        url,
        method: 'PUT',
        headers,
        expiresAt: now + validitySeconds * 1000,
        contentLength,
      };
    },

    async signDownload(
      relicId: string,
      validitySeconds: number,
      now: number
    ): Promise<{ url: string; expiresAt: number }> {
      return {
        url: await sign('GET', relicId, validitySeconds, now),
        expiresAt: now + validitySeconds * 1000,
      };
    },

    async stat(relicId: string): Promise<ObjectStat | undefined> {
      const now = Date.now();
      const url = await sign('HEAD', relicId, 60, now);
      const response = await fetch(url, { method: 'HEAD' });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`stat failed with ${response.status}`);
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      // `x-goog-hash` looks like `crc32c=xxxx==,md5=yyyy==`. CRC32C is the
      // one GCS recommends for integrity checks, and it is non-editable.
      const hashes = response.headers.get('x-goog-hash') ?? '';
      const crc32c =
        /crc32c=([^,]+)/.exec(hashes)?.[1] ??
        response.headers.get('x-goog-stored-content-crc32c') ??
        '';
      const generation = response.headers.get('x-goog-generation') ?? undefined;

      return { length, crc32c, generation };
    },

    async delete(relicId: string): Promise<void> {
      const url = await sign('DELETE', relicId, 60, Date.now());
      const response = await fetch(url, { method: 'DELETE' });
      // 404 is success here: delete is idempotent and a missing object means
      // the outcome already holds.
      if (!response.ok && response.status !== 404) {
        throw new Error(`delete failed with ${response.status}`);
      }
    },

    async setCustomTime(relicId: string, customTime: number): Promise<void> {
      // The lifecycle rule erases an object one day after its customTime, so a
      // private ciphertext carries its relic's expiry (decision 7). GCS accepts
      // this only for an object that exists.
      const url =
        `https://${host}/storage/v1/b/${rfc3986(options.bucket)}` +
        `/o/${rfc3986(objectFor(relicId))}`;
      const response = await doFetch(url, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customTime: new Date(customTime).toISOString(),
        }),
      });
      if (!response.ok) {
        throw new Error(`customTime update failed with ${response.status}`);
      }
    },

    async digest(relicId: string): Promise<string | undefined> {
      const metadataUrl =
        `https://${host}/storage/v1/b/${rfc3986(options.bucket)}` +
        `/o/${rfc3986(objectFor(relicId))}`;
      const token = await accessToken();
      const authorization = `Bearer ${token}`;
      const metadataResponse = await doFetch(metadataUrl, {
        headers: { authorization },
      });
      if (metadataResponse.status === 404) return undefined;
      if (!metadataResponse.ok) {
        throw new Error(
          `digest metadata failed with ${metadataResponse.status}`
        );
      }
      let object = digestMetadata(await metadataResponse.json());

      // Even Accept-Encoding: gzip does not prevent GCS from transcoding a
      // doubly compressed object. Set no-transform on the stored metadata,
      // preserving all other fields and the existing cache directives.
      if (object.contentEncoding && !hasNoTransform(object.cacheControl)) {
        const cacheControl = object.cacheControl
          ? `no-transform, ${object.cacheControl}`
          : 'no-transform';
        const params = new URLSearchParams({
          ifGenerationMatch: object.generation,
          ifMetagenerationMatch: object.metageneration,
        });
        const patched = await doFetch(`${metadataUrl}?${params}`, {
          method: 'PATCH',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ cacheControl }),
        });
        if (!patched.ok) {
          throw new Error(
            `digest metadata update failed with ${patched.status}`
          );
        }
        const updated = digestMetadata(await patched.json());
        if (
          updated.generation !== object.generation ||
          updated.length !== object.length ||
          updated.contentEncoding !== object.contentEncoding ||
          BigInt(updated.metageneration) !==
            BigInt(object.metageneration) + 1n ||
          updated.cacheControl !== cacheControl
        ) {
          throw new Error('digest metadata update did not preserve the object');
        }
        object = updated;
      }

      const headers = {
        'accept-encoding': 'gzip',
        'x-goog-if-generation-match': object.generation,
        'x-goog-if-metageneration-match': object.metageneration,
      };
      const url = await sign('GET', relicId, 60, Date.now(), headers);
      const response = await rawGet(url, headers, request);
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(
          `digest failed with ${response.statusCode ?? 'no status'}`
        );
      }

      const responseCl = response.headers['content-length'];
      const responseGeneration = response.headers['x-goog-generation'];
      const responseMetageneration = response.headers['x-goog-metageneration'];
      const responseEncoding = response.headers['content-encoding'] ?? '';
      const expectedEncoding = (object.contentEncoding ?? '')
        .trim()
        .toLowerCase();
      if (
        (responseCl !== undefined &&
          (!/^\d+$/.test(responseCl) ||
            !Number.isSafeInteger(Number(responseCl)) ||
            Number(responseCl) !== object.length)) ||
        (responseGeneration !== undefined &&
          responseGeneration !== object.generation) ||
        (responseMetageneration !== undefined &&
          responseMetageneration !== object.metageneration) ||
        typeof responseEncoding !== 'string' ||
        responseEncoding.trim().toLowerCase() !== expectedEncoding
      ) {
        response.destroy();
        throw new Error('digest response metadata mismatch');
      }

      const hash = createHash('sha256');
      let bytesHashed = 0;
      for await (const chunk of response) {
        const bytes = chunk as Uint8Array;
        bytesHashed += bytes.byteLength;
        if (bytesHashed > object.length) {
          response.destroy();
          throw new Error('digest length exceeds stored object size');
        }
        hash.update(bytes);
      }
      if (!response.complete || bytesHashed !== object.length) {
        throw new Error(
          `digest length mismatch: stored=${object.length}, hashed=${bytesHashed}`
        );
      }
      return hash.digest('hex');
    },
  };
}
