import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeKey, generateKey, generateRelicId } from '@relic/format';
import type { CoverOutcome } from '@relic/format/cover';
import { buildZipArchive } from '../src/otio-bundle.ts';
import type {
  ProgramRenderer,
  ProgramRenderOutput,
} from '../src/program/render.ts';
import {
  type FileReader,
  type PublishDeps,
  PublishError,
  publish,
} from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { type SourceIdentity, savePublishState } from '../src/state.ts';

const SERVICE = 'https://relic.example';
const ENCODER = new TextEncoder();
const CHALLENGE_LIMIT = 100;
let stateDir: string;
let previousState: string | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'relic-precheck-'));
  previousState = process.env['RELIC_PUBLISH_STATE'];
  process.env['RELIC_PUBLISH_STATE'] = join(stateDir, 'publish-state.json');
  // An unrelated record, so the state file exists and publish's lookup reads it.
  await savePublishState(generateRelicId(), {
    key: encodeKey(generateKey()),
    publish_token: 'unrelated-token',
    version: 1,
    source: identityFor('/elsewhere/unrelated.txt'),
    filename: 'unrelated.txt',
    content_sha256: '1'.repeat(64),
    published_at: new Date().toISOString(),
    expires_at: null,
    cover_uploaded: false,
  });
});

afterEach(async () => {
  if (previousState === undefined) delete process.env['RELIC_PUBLISH_STATE'];
  else process.env['RELIC_PUBLISH_STATE'] = previousState;
  await rm(stateDir, { recursive: true, force: true });
});

function identityFor(path: string): SourceIdentity {
  return {
    identity: `test:${path}`,
    kind: 'realpath',
    path,
    description: `test source ${path}`,
  };
}

function filesFrom(disk: Map<string, Uint8Array>): FileReader {
  return {
    resolve: (path) => (path.startsWith('/') ? path : `/work/${path}`),
    basename: (path) => path.slice(path.lastIndexOf('/') + 1),
    async stat(path) {
      const bytes = disk.get(path);
      return bytes === undefined
        ? { kind: 'other' }
        : { kind: 'file', size: bytes.length };
    },
    async read(path) {
      const bytes = disk.get(path);
      if (bytes === undefined) throw new Error('ENOENT');
      return bytes;
    },
    async openBundleRoot() {
      throw new Error('bundle roots are not used in this test');
    },
  } as FileReader;
}

interface Harness {
  readonly deps: PublishDeps;
  readonly requests: string[];
  readonly renders: { count: number };
}

/** A service that answers the challenge with the cap and the basis, and refuses every other call. */
function harnessFor(disk: Map<string, Uint8Array>): Harness {
  const requests: string[] = [];
  const renders = { count: 0 };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'nonce',
        size_limit_bytes: CHALLENGE_LIMIT,
        size_basis: 'whole-archive',
      });
    }
    if (/^\/api\/relics\/[^/]+\/comments$/.test(url.pathname)) {
      return Response.json([]);
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  }) as typeof globalThis.fetch;
  const renderProgram: ProgramRenderer = async (job) => {
    renders.count += 1;
    return {
      browser: 'none',
      outcomes: job.timelineIds.map(() => ({
        status: 'unavailable' as const,
        reasons: [{ code: 'unsupported-browser' as const, message: 'test' }],
      })),
    } as unknown as ProgramRenderOutput;
  };
  const deps: PublishDeps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: filesFrom(disk),
    fetch,
    upload: async () => ({ status: 200 }),
    clientName: 'relic-mcp/precheck-test',
    identifySource: async (path) => identityFor(path),
    renderCover: async () =>
      ({
        status: 'skipped',
        reason: 'browser_disabled',
        detail: 'test',
      }) as CoverOutcome,
    renderProgram,
  };
  return { deps, requests, renders };
}

/** An .otioz whose archive is well over the 100-byte challenge cap. */
function oversizedOtioz(): Uint8Array {
  return buildZipArchive([
    { name: 'content.otio', data: ENCODER.encode('{}'.repeat(200)), method: 8 },
    { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
  ]);
}

async function refusalOf(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishError) return error;
    throw error;
  }
  throw new Error('expected the publish to be refused');
}

describe('publish and republish refuse an oversized .otioz the same way', () => {
  test('publish refuses before any grant or render, with the size basis', async () => {
    const archive = oversizedOtioz();
    const disk = new Map([['/work/show.otioz', archive]]);
    const harness = harnessFor(disk);
    const error = await refusalOf(
      publish({ path: 'show.otioz' }, harness.deps)
    );
    expect(error.code).toBe('local_size_precheck_failed');
    expect(error.details).toEqual({
      size_limit_bytes: CHALLENGE_LIMIT,
      declared_size_bytes: archive.length,
      size_basis: 'whole-archive',
    });
    expect(harness.requests.some((r) => r.includes('/api/grant'))).toBe(false);
    expect(harness.renders.count).toBe(0);
  });

  test('republish refuses before the republish grant or render, with the same details as publish', async () => {
    const archive = oversizedOtioz();
    const publishDisk = new Map([['/work/show.otioz', archive]]);
    const publishHarness = harnessFor(publishDisk);
    const publishError = await refusalOf(
      publish({ path: 'show.otioz' }, publishHarness.deps)
    );

    const relicId = generateRelicId();
    await savePublishState(relicId, {
      key: encodeKey(generateKey()),
      publish_token: 'publish-token',
      version: 1,
      source: identityFor('/work/show.otioz'),
      filename: 'show.otioz',
      content_sha256: '0'.repeat(64),
      published_at: new Date().toISOString(),
      expires_at: null,
      cover_uploaded: false,
    });
    const republishDisk = new Map([['/work/show.otioz', archive]]);
    const harness = harnessFor(republishDisk);
    const error = await refusalOf(
      republish({ relic_id: relicId, path: 'show.otioz' }, harness.deps)
    );
    expect(error.code).toBe('local_size_precheck_failed');
    expect(error.details).toEqual(publishError.details);
    expect(
      harness.requests.some((r) =>
        r.includes(`/api/relics/${relicId}/republish`)
      )
    ).toBe(false);
    expect(harness.renders.count).toBe(0);
  });
});
