/**
 * Builds the rendered-program proof composition into a scratch directory as a standard `.otiod`
 * bundle. The document comes from the pinned OpenTimelineIO 0.18.1 generator and the media from
 * ffmpeg. The OTIO library's own placement is written beside the bundle, never inside it.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProgramVariant =
  | 'positive'
  | 'global-start'
  | 'custom-wipe'
  | 'unknown-effect';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/program/', import.meta.url)
);

function run(command: string, args: readonly string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    const stderr = Buffer.concat(err).toString('utf8');
    if (code !== 0)
      reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    else resolve(Buffer.concat(out).toString('utf8'));
  });
  return promise;
}

export interface BuiltProgramFixture {
  /** Directory to publish: a standard `.otiod` bundle. */
  readonly bundleDir: string;
  /** Library placement from OpenTimelineIO, for the self tests only. */
  readonly libraryOraclePath: string;
}

export async function buildProgramFixture(
  scratch: string,
  variant: ProgramVariant = 'positive'
): Promise<BuiltProgramFixture> {
  const bundleDir = join(scratch, `${variant}.otiod`);
  const libraryOraclePath = join(scratch, `${variant}-library-oracle.json`);
  await mkdir(join(bundleDir, 'media'), { recursive: true });
  await run('uv', [
    'run',
    '--with',
    'opentimelineio==0.18.1',
    'python3',
    join(fixtureRoot, 'generate-program-fixture.py'),
    bundleDir,
    '--variant',
    variant,
    '--oracle-out',
    libraryOraclePath,
  ]);
  await run('bash', [
    join(fixtureRoot, 'generate-program-media.sh'),
    bundleDir,
  ]);
  return { bundleDir, libraryOraclePath };
}

export async function readLibraryOracle(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
