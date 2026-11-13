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
let stateDir: string;
let previousState: string | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'relic-refusal-'));
  previousState = process.env['RELIC_PUBLISH_STATE'];
  process.env['RELIC_PUBLISH_STATE'] = join(stateDir, 'publish-state.json');
  // A record for an unrelated source, so the state file exists and is readable.
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

/** A filesystem that lives in a Map, for the paths the flow reads. */
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

/** Deps whose service answers the challenge with `challenge` and every other service call with a 500. */
function harnessFor(
  disk: Map<string, Uint8Array>,
  challenge: unknown
): Harness {
  const requests: string[] = [];
  const renders = { count: 0 };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/challenge') return Response.json(challenge);
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
    clientName: 'relic-mcp/refusal-test',
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

const BAD_CHALLENGES: unknown[] = [
  { size_limit_bytes: '524288000' },
  { size_limit_bytes: Number.NaN },
  { size_limit_bytes: 0 },
  { size_limit_bytes: -1 },
  { size_limit_bytes: 1.5 },
  { size_limit_bytes: null },
  { size_limit_bytes: 2 ** 53 },
  {},
];

async function refusalOf(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishError) return error;
    throw error;
  }
  throw new Error('expected the publish to be refused');
}

describe('publish refuses a bad challenge before any grant or render', () => {
  test('every bad size limit is app_response_unusable on the challenge leg, with no grant', async () => {
    for (const challenge of BAD_CHALLENGES) {
      const disk = new Map([['/work/a.txt', ENCODER.encode('hello')]]);
      const harness = harnessFor(disk, challenge);
      const error = await refusalOf(publish({ path: 'a.txt' }, harness.deps));
      expect(error.code).toBe('app_response_unusable');
      expect(error.details['leg']).toBe('challenge');
      expect(
        harness.requests.filter((r) => r.includes('/api/grant'))
      ).toHaveLength(0);
      expect(harness.requests.some((r) => r.includes('/api/challenge'))).toBe(
        true
      );
      expect(harness.renders.count).toBe(0);
    }
  });
});

describe('republish refuses a bad challenge before any grant or render', () => {
  test('an OTIO republish with a bad size limit is refused with no grant and no program', async () => {
    const relicId = generateRelicId();
    const archive = buildZipArchive([
      { name: 'content.otio', data: ENCODER.encode('{}'), method: 8 },
      { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
    ]);
    const disk = new Map([['/work/show.otioz', archive]]);
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
    const harness = harnessFor(disk, { size_limit_bytes: '524288000' });
    const error = await refusalOf(
      republish({ relic_id: relicId, path: 'show.otioz' }, harness.deps)
    );
    expect(error.code).toBe('app_response_unusable');
    expect(error.details['leg']).toBe('challenge');
    expect(
      harness.requests.filter((r) =>
        r.includes(`/api/relics/${relicId}/republish`)
      )
    ).toHaveLength(0);
    expect(harness.renders.count).toBe(0);
  });
});
