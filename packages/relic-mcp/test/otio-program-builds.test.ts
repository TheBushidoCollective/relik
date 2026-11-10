import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyRouting,
  ViewerRouter,
  type ViewerBuild,
  viewerBuild,
} from './otio-program-builds.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'primer-builds-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A build directory with the given files. Returns the build description. */
async function makeBuild(
  name: string,
  files: Record<string, string>,
  outputs: readonly string[]
): Promise<ViewerBuild> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files))
    await writeFile(join(dir, file), text);
  return viewerBuild(name, dir, outputs);
}

describe('routing: a build is served only when it is whole', () => {
  test('a build whose chunk references all exist and are its own passes', async () => {
    const build = await makeBuild(
      'ok',
      {
        'main.js': 'import("./chunk-abc12345.js");',
        'chunk-abc12345.js': 'export const x=1;',
      },
      ['main.js', 'chunk-abc12345.js']
    );
    expect(await verifyRouting(build)).toEqual([]);
  });

  test('a reference to a chunk that is not in the directory is rejected', async () => {
    const build = await makeBuild(
      'missing',
      { 'main.js': 'import("./chunk-abc12345.js");' },
      ['main.js', 'chunk-abc12345.js']
    );
    const failures = await verifyRouting(build);
    expect(
      failures.some((f) => f.includes('output chunk-abc12345.js is missing'))
    ).toBe(true);
    expect(
      failures.some(
        (f) =>
          f.includes('references ./chunk-abc12345.js') ||
          f.includes('references chunk-abc12345.js')
      )
    ).toBe(true);
  });

  test('a chunk that exists in the directory but this build did not write is rejected', async () => {
    // Negative control for the cross-arm bug: a graph chunk left over from another build must not
    // be served as if it belonged to this one.
    const build = await makeBuild(
      'foreign',
      {
        'main.js': 'import("./chunk-abc12345.js");',
        'chunk-abc12345.js': 'export const x=1;',
      },
      ['main.js']
    );
    const failures = await verifyRouting(build);
    expect(failures.some((f) => f.includes('did not write'))).toBe(true);
  });

  test('a non-graph worker present in the directory is allowed without being an output', async () => {
    const build = await makeBuild(
      'worker',
      {
        'main.js': 'new Worker(new URL("./pcm-worker.js", import.meta.url));',
        'pcm-worker.js': 'self.onmessage=()=>{};',
      },
      ['main.js']
    );
    expect(await verifyRouting(build)).toEqual([]);
  });

  test('a build without main.js is rejected', async () => {
    const build = await makeBuild('nomain', { 'chunk-a1.js': 'x' }, [
      'chunk-a1.js',
    ]);
    expect(
      (await verifyRouting(build)).some((f) => f.includes('no main.js'))
    ).toBe(true);
  });
});

describe('ViewerRouter: one complete build answers each request', () => {
  test('requests are answered from the active build, and switching changes the answer', async () => {
    const production = await makeBuild(
      'production',
      { 'main.js': 'PROD', 'chunk-p0000001.js': 'x' },
      ['main.js', 'chunk-p0000001.js']
    );
    const sham = await makeBuild(
      'sham',
      { 'main.js': 'SHAM', 'chunk-s0000001.js': 'y' },
      ['main.js', 'chunk-s0000001.js']
    );
    const router = new ViewerRouter(production);

    const first = await router.get('/main.js');
    expect(new TextDecoder().decode(first!.body)).toBe('PROD');

    await router.activate(sham);
    const second = await router.get('/main.js');
    expect(new TextDecoder().decode(second!.body)).toBe('SHAM');
    expect(router.active.name).toBe('sham');
  });

  test('the served record names the build that answered, and resets', async () => {
    const production = await makeBuild('production', { 'main.js': 'PROD' }, [
      'main.js',
    ]);
    const sham = await makeBuild('sham', { 'main.js': 'SHAM' }, ['main.js']);
    const router = new ViewerRouter(production);

    await router.get('/main.js');
    expect(router.servedBuilds()).toEqual(['production']);
    router.resetServed();
    expect(router.servedBuilds()).toEqual([]);

    await router.activate(sham);
    await router.get('/main.js');
    expect(router.servedBuilds()).toEqual(['sham']);
  });

  test('activating a broken build throws and leaves the previous build served', async () => {
    const production = await makeBuild('production', { 'main.js': 'PROD' }, [
      'main.js',
    ]);
    const broken = await makeBuild(
      'broken',
      { 'main.js': 'import("./chunk-zzzzzzzz.js");' },
      ['main.js']
    );
    const router = new ViewerRouter(production);
    await expect(router.activate(broken)).rejects.toThrow(
      'cannot serve broken'
    );
    expect(router.active.name).toBe('production');
    expect(new TextDecoder().decode((await router.get('/main.js'))!.body)).toBe(
      'PROD'
    );
  });

  test('a path outside the active build is not served', async () => {
    const production = await makeBuild('production', { 'main.js': 'PROD' }, [
      'main.js',
    ]);
    const router = new ViewerRouter(production);
    expect(await router.get('/../main.js')).toBeUndefined();
  });
});
