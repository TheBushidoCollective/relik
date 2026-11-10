import { createCipheriv, createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';

const EXPECTED_LABELS = [
  'plain',
  'gzip-single',
  'gzip-double',
  'gzip-double/v2',
  'already-nt',
  'quoted-cc',
  'mislabeled',
  'control-single',
  'control-double',
  'control-mislabeled',
  'large',
  'vector',
  'absent',
];
const DIGEST_LABELS = [
  'plain',
  'gzip-single',
  'gzip-double',
  'gzip-double/v2',
  'already-nt',
  'quoted-cc',
  'mislabeled',
];
const LARGE_BYTES = 500 * 1024 * 1024;
let stage = 'setup';

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function env(name: string): string {
  const value = process.env[name];
  requireCondition(
    typeof value === 'string' && value.length > 0,
    `missing ${name}`
  );
  return value;
}

export function validateProofIdentity(
  bucket: string,
  email: string,
  project: string
) {
  const bucketMatch =
    /^relic-gcs-proof-([1-9][0-9]{0,18})-([1-9][0-9]{0,2})$/.exec(bucket);
  requireCondition(bucketMatch !== null, 'invalid bucket');
  requireCondition(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project),
    'invalid project'
  );
  requireCondition(
    email ===
      `rgp-${bucketMatch[1]}-${bucketMatch[2]}@${project}.iam.gserviceaccount.com`,
    'invalid proof identity'
  );
}

function selectedHeaders(
  headers: Record<string, string | string[] | undefined>
) {
  const value = (name: string): string | null => {
    const field = headers[name];
    return Array.isArray(field) ? field.join(', ') : (field ?? null);
  };
  return {
    'content-encoding': value('content-encoding'),
    'content-length': value('content-length'),
    'content-range': value('content-range'),
  };
}

interface RawObservation {
  status: number;
  bytes: number;
  sha256: string;
  headers: {
    'content-encoding': string | null;
    'content-length': string | null;
    'content-range': string | null;
  };
}

async function rawRead(url: string, headers: Record<string, string> = {}) {
  const { promise, resolve, reject } = Promise.withResolvers<RawObservation>();
  const pending = httpsRequest(url, { method: 'GET', headers }, (response) => {
    const digest = createHash('sha256');
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 3 * 1024 * 1024) {
        response.destroy();
        reject(new Error('signed response exceeded fixture bound'));
        return;
      }
      digest.update(chunk);
    });
    response.on('error', () => reject(new Error('signed response failed')));
    response.on('end', () => {
      if (!response.complete) {
        reject(new Error('signed response incomplete'));
        return;
      }
      resolve({
        status: response.statusCode ?? 0,
        bytes,
        sha256: digest.digest('hex'),
        headers: selectedHeaders(response.headers),
      });
    });
  });
  pending.on('error', () => reject(new Error('signed request failed')));
  pending.end();
  return promise;
}

function metadataProjection(value: unknown) {
  requireCondition(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'invalid metadata'
  );
  const object = value as Record<string, unknown>;
  const result: Record<string, string | null> = {};
  for (const key of [
    'generation',
    'metageneration',
    'md5Hash',
    'crc32c',
    'size',
    'contentType',
    'contentEncoding',
    'cacheControl',
  ]) {
    const field = object[key];
    requireCondition(
      field === undefined || typeof field === 'string',
      'invalid metadata field'
    );
    result[key] = field ?? null;
  }
  return result;
}

async function createLargeFile(path: string, seed: string, byteCount: number) {
  const cipher = createCipheriv(
    'aes-256-ctr',
    Buffer.from(seed, 'hex'),
    Buffer.alloc(16)
  );
  const zeros = Buffer.alloc(1024 * 1024);
  async function* data() {
    let remaining = byteCount;
    while (remaining > 0) {
      const count = Math.min(remaining, zeros.length);
      yield cipher.update(zeros.subarray(0, count));
      remaining -= count;
    }
    const final = cipher.final();
    if (final.length > 0) yield final;
  }
  await pipeline(
    Readable.from(data()),
    createWriteStream(path, { mode: 0o600, flags: 'wx' })
  );
  requireCondition(
    Bun.file(path).size === byteCount,
    'large fixture length differs'
  );
}

async function main() {
  const token = env('GCS_PROOF_TOKEN');
  const bucket = env('GCS_PROOF_BUCKET');
  const project = env('GCS_PROOF_PROJECT');
  const email = env('GCS_PROOF_CLIENT_EMAIL');
  const prefix = env('GCS_PROOF_PREFIX');
  const seed = env('GCS_PROOF_LARGE_SEED');
  const bytesText = env('GCS_PROOF_LARGE_BYTES');
  const candidate = env('GCS_PROOF_CANDIDATE_SHA');
  const bunVersion = env('GCS_PROOF_BUN_VERSION');
  validateProofIdentity(bucket, email, project);
  requireCondition(prefix === 'r', 'invalid prefix');
  requireCondition(/^[0-9a-f]{64}$/.test(seed), 'invalid seed');
  requireCondition(
    bytesText === '0' || bytesText === String(LARGE_BYTES),
    'invalid large size'
  );
  requireCondition(/^[0-9a-f]{40}$/.test(candidate), 'invalid candidate SHA');
  requireCondition(
    /^\d+\.\d+\.\d+$/.test(bunVersion) && Bun.version === bunVersion,
    'Bun version differs'
  );
  for (const key of [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_RUNTIME_TOKEN',
    'GITHUB_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    requireCondition(
      process.env[key] === undefined,
      'forbidden credential present'
    );
  }
  requireCondition(
    !existsSync('/var/run/docker.sock'),
    'Docker socket present'
  );
  const manifest = JSON.parse(env('GCS_PROOF_MANIFEST')) as Record<
    string,
    unknown
  >;
  requireCondition(
    manifest !== null &&
      typeof manifest === 'object' &&
      !Array.isArray(manifest),
    'invalid manifest'
  );
  requireCondition(
    Object.keys(manifest).length === EXPECTED_LABELS.length &&
      EXPECTED_LABELS.every((label) => Object.hasOwn(manifest, label)),
    'manifest labels differ'
  );
  const ids = new Set<string>();
  for (const label of EXPECTED_LABELS) {
    const id = manifest[label];
    requireCondition(
      typeof id === 'string',
      'manifest identifier is not a string'
    );
    if (label === 'gzip-double/v2') {
      requireCondition(
        id === `${manifest['gzip-double']}/v2`,
        'invalid versioned object'
      );
    } else {
      requireCondition(
        /^[a-z]{26}$/.test(id) && !ids.has(id),
        'invalid or duplicate object identifier'
      );
      ids.add(id);
    }
  }
  const id = (label: string): string => manifest[label] as string;
  const objectKey = (label: string): string => `${prefix}/${id(label)}`;
  const metadataUrl = (label: string): string =>
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectKey(label))}`;
  const authorization = `Bearer ${token}`;
  async function metadata(label: string) {
    const response = await fetch(metadataUrl(label), {
      headers: { authorization },
    });
    requireCondition(response.status === 200, 'metadata read failed');
    const value = (await response.json()) as Record<string, unknown>;
    requireCondition(
      value.name === objectKey(label),
      'metadata object differs'
    );
    return metadataProjection(value);
  }

  stage = 'candidate-import';
  // The trusted harness imports the candidate only after its isolation checks pass.
  const candidateModule = await import(
    '/candidate/packages/relic-server/src/gcs.ts'
  );
  for (const symbol of [
    'gcsStorage',
    'iamSigner',
    'signUrl',
    'encodeObjectPath',
  ]) {
    requireCondition(
      typeof candidateModule[symbol] === 'function',
      `missing ${symbol}`
    );
  }
  const signer = candidateModule.iamSigner({
    clientEmail: email,
    getAccessToken: async () => token,
  });
  const storage = candidateModule.gcsStorage({ bucket, prefix, signer });
  requireCondition(typeof storage.digest === 'function', 'missing digest');
  for (const symbol of ['signUpload', 'signDownload', 'stat']) {
    requireCondition(
      typeof storage[symbol] === 'function',
      `missing ${symbol}`
    );
  }

  let large: unknown = null;
  if (bytesText !== '0') {
    stage = 'large-create';
    const path = '/work/large-fixture.bin';
    await createLargeFile(path, seed, LARGE_BYTES);
    try {
      stage = 'large-upload';
      const upload = await storage.signUpload(
        id('large'),
        LARGE_BYTES,
        4500,
        Date.now()
      );
      const signedHeaders = new URL(upload.url).searchParams.get(
        'X-Goog-SignedHeaders'
      );
      requireCondition(
        signedHeaders === 'content-length;host' &&
          upload.method === 'PUT' &&
          upload.contentLength === LARGE_BYTES &&
          upload.headers['content-length'] === String(LARGE_BYTES),
        'large upload signature differs'
      );
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(upload.headers)) {
        if (name.toLowerCase() !== 'content-length')
          headers[name] = String(value);
      }
      // Upload in a separate process so any Bun upload buffers cannot hide
      // allocations made later by the digest in this process's RSS baseline.
      const child = Bun.spawn(
        [process.execPath, '/harness/harness.ts', '--upload-child'],
        {
          env: {
            HOME: '/tmp',
            GCS_PROOF_UPLOAD_URL: upload.url,
            GCS_PROOF_UPLOAD_BUCKET: bucket,
            GCS_PROOF_UPLOAD_ID: id('large'),
            GCS_PROOF_UPLOAD_HEADERS: JSON.stringify(headers),
          },
          stdout: 'ignore',
          stderr: 'ignore',
        }
      );
      requireCondition((await child.exited) === 0, 'large upload failed');
    } finally {
      await unlink(path);
    }
    stage = 'large-digest';
    const stat = await storage.stat(id('large'));
    requireCondition(stat !== undefined, 'large stat missing');
    const beforeRss = process.memoryUsage.rss();
    let peakRss = beforeRss;
    const timer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, 10);
    let digest: string | undefined;
    try {
      digest = await storage.digest(id('large'));
    } finally {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
      clearInterval(timer);
    }
    // Linux reports the process high-water mark even for peaks between samples.
    const statusText = await Bun.file('/proc/self/status').text();
    const highWater = /^VmHWM:\s+([0-9]+)\s+kB$/m.exec(statusText);
    requireCondition(highWater !== null, 'memory high-water mark unavailable');
    peakRss = Math.max(peakRss, Number(highWater[1]) * 1024);
    requireCondition(
      typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest),
      'large digest missing'
    );
    large = {
      upload_status: 200,
      signed_headers: 'content-length;host',
      stat,
      digest,
      metadata: await metadata('large'),
      memory_baseline: beforeRss,
      memory_peak: peakRss,
    };
  }

  stage = 'before-reads';
  async function signedRead(
    label: string,
    headers: Record<string, string> = {}
  ) {
    const download = await storage.signDownload(id(label), 300, Date.now());
    return await rawRead(download.url, headers);
  }
  const singleBefore = await storage.stat(id('gzip-single'));
  requireCondition(singleBefore !== undefined, 'single stat missing');
  const reads: Record<string, unknown> = {
    before_single_plain: await signedRead('gzip-single'),
    before_single_gzip: await signedRead('gzip-single', {
      'accept-encoding': 'gzip',
    }),
    before_double_plain: await signedRead('gzip-double'),
    before_double_gzip: await signedRead('gzip-double', {
      'accept-encoding': 'gzip',
    }),
  };
  for (const value of Object.values(reads) as Array<{ status: number }>) {
    requireCondition(value.status === 200, 'signed read before digest failed');
  }

  stage = 'digests';
  const digests: Record<string, unknown> = {};
  for (const label of DIGEST_LABELS) {
    const digest = await storage.digest(id(label));
    requireCondition(
      typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest),
      'fixture digest missing'
    );
    digests[label] = { digest, metadata: await metadata(label) };
  }
  const repeatDigest = await storage.digest(id('gzip-single'));
  requireCondition(
    typeof repeatDigest === 'string' && /^[0-9a-f]{64}$/.test(repeatDigest),
    'repeat digest missing'
  );
  const repeatSingle = {
    digest: repeatDigest,
    metadata: await metadata('gzip-single'),
  };

  stage = 'after-reads';
  const afterDouble = await signedRead('gzip-double');
  const rangeDouble = await signedRead('gzip-double', {
    range: 'bytes=0-1023',
  });
  requireCondition(
    afterDouble.status === 200 &&
      afterDouble.headers['content-encoding'] === 'gzip',
    'post-digest raw read failed'
  );
  requireCondition(
    rangeDouble.status === 206 && rangeDouble.headers['content-range'] !== null,
    'post-digest range failed'
  );
  reads.after_double_plain = afterDouble;
  reads.after_double_range = rangeDouble;
  const doubleDownload = await storage.signDownload(
    id('gzip-double'),
    300,
    Date.now()
  );
  const fetched = await fetch(doubleDownload.url);
  requireCondition(fetched.status === 200, 'Bun fetch failed');
  const fetchedBody = new Uint8Array(await fetched.arrayBuffer());
  reads.after_double_fetch = {
    status: fetched.status,
    bytes: fetchedBody.length,
    sha256: createHash('sha256').update(fetchedBody).digest('hex'),
    headers: {
      'content-encoding': fetched.headers.get('content-encoding'),
      'content-length': fetched.headers.get('content-length'),
      'content-range': fetched.headers.get('content-range'),
    },
  };
  const singleAfter = await storage.stat(id('gzip-single'));
  requireCondition(
    singleAfter !== undefined,
    'single stat missing after digest'
  );

  stage = 'preconditions';
  const currentSingle = await metadata('gzip-single');
  requireCondition(
    currentSingle.generation !== null && currentSingle.generation !== '1',
    'generation is not stale'
  );
  async function staleRead(header: string, value: string): Promise<number> {
    const headers = { [header]: value };
    const url = await candidateModule.signUrl(
      {
        method: 'GET',
        host: 'storage.googleapis.com',
        path: `/${candidateModule.encodeObjectPath(bucket)}/${candidateModule.encodeObjectPath(objectKey('gzip-single'))}`,
        clientEmail: email,
        expiresSeconds: 60,
        now: Date.now(),
        headers,
      },
      signer
    );
    return (await rawRead(url, headers)).status;
  }
  const staleMeta = await staleRead('x-goog-if-metageneration-match', '1');
  const staleGeneration = await staleRead('x-goog-if-generation-match', '1');
  const patch = await fetch(
    `${metadataUrl('gzip-single')}?ifMetagenerationMatch=1`,
    {
      method: 'PATCH',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ cacheControl: 'invalid-stale-proof-write' }),
    }
  );
  requireCondition(
    staleMeta === 412 && staleGeneration === 412 && patch.status === 412,
    'stale precondition did not fail'
  );
  const preconditions = {
    metageneration: staleMeta,
    generation: staleGeneration,
    json_patch: patch.status,
    metadata: await metadata('gzip-single'),
  };

  stage = 'absent';
  const missing = await storage.digest(id('absent'));
  requireCondition(missing === undefined, 'absent digest was not undefined');

  stage = 'vector';
  const vectorBody = gzipSync(Buffer.alloc(1001), { level: 0 });
  requireCondition(vectorBody.length === 1024, 'vector length differs');
  const vectorUpload = await storage.signUpload(
    id('vector'),
    vectorBody.length,
    300,
    Date.now()
  );
  requireCondition(
    new URL(vectorUpload.url).searchParams.get('X-Goog-SignedHeaders') ===
      'content-length;host',
    'vector signed headers differ'
  );
  const vectorResponse = await fetch(vectorUpload.url, {
    method: 'PUT',
    body: vectorBody,
    headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' },
  });
  const vector: Record<string, unknown> = {
    status: vectorResponse.status,
    upload_sha256: createHash('sha256').update(vectorBody).digest('hex'),
    metadata: null,
    digest: null,
    metadata_after_digest: null,
  };
  await vectorResponse.arrayBuffer();
  if (vectorResponse.status === 200) {
    const vectorMetadata = await metadata('vector');
    vector.metadata = vectorMetadata;
    if (vectorMetadata.contentEncoding !== null) {
      const vectorDigest = await storage.digest(id('vector'));
      requireCondition(
        typeof vectorDigest === 'string' && /^[0-9a-f]{64}$/.test(vectorDigest),
        'vector digest missing'
      );
      vector.digest = vectorDigest;
      vector.metadata_after_digest = await metadata('vector');
    }
  }

  stage = 'write-result';
  const result = {
    version: 1,
    candidate,
    bucket,
    runtime: { bun: Bun.version },
    reads,
    stats: { single_before: singleBefore, single_after: singleAfter },
    digests,
    repeat_single: repeatSingle,
    preconditions,
    absent: null,
    large,
    vector,
  };
  await Bun.write('/work/result.json', `${JSON.stringify(result)}\n`);
  console.log('GCS_PROOF_HARNESS_COMPLETE');
}

if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--upload-child') {
      const bucket = env('GCS_PROOF_UPLOAD_BUCKET');
      const identifier = env('GCS_PROOF_UPLOAD_ID');
      const url = new URL(env('GCS_PROOF_UPLOAD_URL'));
      requireCondition(
        /^relic-gcs-proof-[1-9][0-9]{0,18}-[1-9][0-9]{0,2}$/.test(bucket) &&
          /^[a-z]{26}$/.test(identifier) &&
          url.protocol === 'https:' &&
          url.host === 'storage.googleapis.com' &&
          url.username === '' &&
          url.password === '' &&
          url.pathname === `/${bucket}/r/${identifier}` &&
          url.searchParams.get('X-Goog-SignedHeaders') ===
            'content-length;host',
        'invalid large upload URL'
      );
      const headers = JSON.parse(env('GCS_PROOF_UPLOAD_HEADERS')) as Record<
        string,
        unknown
      >;
      requireCondition(
        typeof headers === 'object' &&
          headers !== null &&
          !Array.isArray(headers) &&
          Object.entries(headers).every(
            ([name, value]) =>
              name.toLowerCase() !== 'content-length' &&
              name.toLowerCase() !== 'host' &&
              typeof value === 'string' &&
              !/[\r\n]/.test(value)
          ),
        'invalid large upload headers'
      );
      const response = await fetch(url, {
        method: 'PUT',
        headers: headers as Record<string, string>,
        body: Bun.file('/work/large-fixture.bin'),
      });
      requireCondition(response.status === 200, 'large upload failed');
      await response.arrayBuffer();
    } else {
      requireCondition(process.argv.length === 2, 'invalid harness arguments');
      await main();
    }
  } catch {
    // Candidate code runs in this process. Do not print its errors, URLs or credentials.
    console.error(`GCS_PROOF_ERROR harness stage=${stage}`);
    process.exitCode = 1;
  }
}
