import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPrivatePublishState,
  loadPublishInventory,
  type PrivatePublishState,
  type PublishState,
  savePrivatePublishState,
  savePublishState,
} from '../src/state.ts';

let dir: string;
let statePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-private-state-'));
  statePath = join(dir, 'publish-state.json');
  process.env['RELIC_PUBLISH_STATE'] = statePath;
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAA';
const PRIVATE_KEY = 'BBBBBBBBBBBBBBBBBBBBBB';
const RELIC_A = '0123456789abcdefghjkmnpqrs';
const RELIC_B = 'tvwxyz0123456789abcdefghjk';

function publicState(): PublishState {
  return { key: PUBLIC_KEY, publish_token: 'public-token', version: 1 };
}

function privateState(): PrivatePublishState {
  return {
    access: 'private',
    service_origin: 'https://svc.test',
    publish_token: 'private-token',
    version: 1,
    version_keys: { '1': PRIVATE_KEY },
    owner_identity_id: 'a'.repeat(64),
    device_id: 'b'.repeat(64),
  };
}

describe('private entries in the publish state file', () => {
  test('a private entry and a public entry coexist, and only the public one is inventoried', async () => {
    await savePublishState(RELIC_A, publicState());
    await savePrivatePublishState(RELIC_B, privateState());

    expect((await loadPrivatePublishState(RELIC_B))?.version_keys['1']).toBe(
      PRIVATE_KEY
    );
    const inventory = await loadPublishInventory();
    expect(inventory.records.map((record) => record.relic_id)).toEqual([
      RELIC_A,
    ]);
  });

  test('a public write preserves the private bucket and any top-level key this client does not know', async () => {
    await writeFile(
      statePath,
      JSON.stringify({ future_feature: { keep: true } })
    );
    await savePrivatePublishState(RELIC_B, privateState());
    await savePublishState(RELIC_A, publicState());

    const raw = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw['future_feature']).toEqual({ keep: true });
    expect(
      Object.keys(raw['private_relics'] as Record<string, unknown>)
    ).toEqual([RELIC_B]);
    expect(Object.keys(raw['relics'] as Record<string, unknown>)).toEqual([
      RELIC_A,
    ]);
  });

  test('the state file is written 0600', async () => {
    await savePrivatePublishState(RELIC_B, privateState());
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  test('a malformed private entry is refused without echoing its contents', async () => {
    await writeFile(
      statePath,
      JSON.stringify({
        private_relics: {
          [RELIC_B]: { access: 'private', version_keys: { '1': PRIVATE_KEY } },
        },
      })
    );
    const failure = await loadPrivatePublishState(RELIC_B).then(
      () => undefined,
      (error: unknown) => error as Error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message.includes(PRIVATE_KEY)).toBe(false);
  });
});
