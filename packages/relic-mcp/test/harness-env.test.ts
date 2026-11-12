import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessEnv, operatorFileClash } from './harness-env.ts';

const OPERATOR_KEYS = '/Users/operator/.relic/device-keys.json';
const OPERATOR_CACHE = '/Users/operator/.relic/metadata-cache.json';
const SAVED = { ...process.env };

beforeEach(() => {
  process.env['RELIC_DEVICE_KEYS'] = OPERATOR_KEYS;
  process.env['RELIC_METADATA_CACHE'] = OPERATOR_CACHE;
  process.env['RELIC_ORIGIN'] = 'https://operator.example';
  process.env['RELIC_MCP_HTTP'] = '1';
  process.env['RELIC_MCP_HOST'] = '0.0.0.0';
  process.env['HARNESS_KEEP'] = 'kept';
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in SAVED)) delete process.env[name];
  }
  Object.assign(process.env, SAVED);
});

const settings = {
  serviceOrigin: 'https://relik.test',
  chromePath: 'none',
  clientName: 'relic-mcp/harness-test',
};

describe('the environment a harness gives its spawned relic-mcp', () => {
  test('the operator’s device keys and metadata cache never reach the child', () => {
    const env = harnessEnv(
      '/scratch/run-1',
      '/scratch/run-1/state.json',
      settings
    );
    expect(env['RELIC_DEVICE_KEYS']).toBe('/scratch/run-1/device-keys.json');
    expect(env['RELIC_METADATA_CACHE']).toBe(
      '/scratch/run-1/metadata-cache.json'
    );
    expect(env['RELIC_DEVICE_KEYS']).not.toBe(OPERATOR_KEYS);
    expect(env['RELIC_METADATA_CACHE']).not.toBe(OPERATOR_CACHE);
  });

  test('no other operator RELIC_ setting is inherited, and the harness’s own settings are set', () => {
    const env = harnessEnv(
      '/scratch/run-1',
      '/scratch/run-1/state.json',
      settings
    );
    expect(env['RELIC_ORIGIN']).toBeUndefined();
    expect(env['RELIC_MCP_HTTP']).toBeUndefined();
    expect(env['RELIC_MCP_HOST']).toBeUndefined();
    expect(env['RELIC_SERVICE_ORIGIN']).toBe('https://relik.test');
    expect(env['RELIC_PUBLISH_STATE']).toBe('/scratch/run-1/state.json');
    expect(env['RELIC_CHROME_PATH']).toBe('none');
    expect(env['RELIC_CLIENT_NAME']).toBe('relic-mcp/harness-test');
  });

  test('ordinary variables are inherited unchanged', () => {
    const env = harnessEnv(
      '/scratch/run-1',
      '/scratch/run-1/state.json',
      settings
    );
    expect(env['HARNESS_KEEP']).toBe('kept');
    expect(env['PATH']).toBe(process.env['PATH']);
  });
});

describe('the live probe refuses operator files that already exist', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-env-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a RELIC_DEVICE_KEYS naming an existing file is a clash', () => {
    const real = join(dir, 'device-keys.json');
    writeFileSync(real, '{}');
    const clash = operatorFileClash(
      { RELIC_DEVICE_KEYS: real },
      (path) => path === real
    );
    expect(clash).toContain('RELIC_DEVICE_KEYS');
  });

  test('a RELIC_METADATA_CACHE naming an existing file is a clash', () => {
    const real = join(dir, 'metadata-cache.json');
    writeFileSync(real, '{}');
    const clash = operatorFileClash(
      { RELIC_METADATA_CACHE: real },
      (path) => path === real
    );
    expect(clash).toContain('RELIC_METADATA_CACHE');
  });

  test('paths that do not exist yet, or no paths at all, are not a clash', () => {
    const fresh = join(dir, 'not-yet.json');
    expect(
      operatorFileClash({ RELIC_DEVICE_KEYS: fresh }, () => false)
    ).toBeUndefined();
    expect(operatorFileClash({}, () => true)).toBeUndefined();
  });
});
