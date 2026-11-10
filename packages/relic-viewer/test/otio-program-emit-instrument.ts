/**
 * Test-only instrumentation of the real viewer bundle.
 *
 * `emitRecorderPlugin()` is a Bun build plugin. It rewrites otio-program.ts as
 * it is loaded into the viewer's own graph, so each emit records
 * {kind, start, end} with performance.now into globalThis.__relicProofEmits.
 * `buildInstrumentedViewer()` builds src/main.ts with the same options as
 * buildViewer() in build.ts, plus that plugin. Production build.ts is unchanged.
 *
 * Fail closed: each landmark must match exactly once, the transform must run
 * exactly once in the build, and the recorder helper throws at the first emit
 * if the proof array is absent. Missing instrumentation is never zero emits.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BunPlugin } from 'bun';

const PKG_DIR = join(import.meta.dir, '..');
const PROGRAM_SOURCE = join(PKG_DIR, 'src', 'otio-program.ts');
const VIEWER_ENTRY = join(PKG_DIR, 'src', 'main.ts');

/** Global the proof reads. The page must install it before the viewer runs. */
export const PROOF_GLOBAL = '__relicProofEmits';

const PLAYER_LANDMARK =
  '  const emit = (): void => {\n    if (disposed) return;\n';
const SESSION_LANDMARK =
  '  private emit(): void {\n    if (this.disposed) return;\n';

/** Appended to the module. Hoisted, and fails closed when the proof array is absent. */
const RECORDER_HELPER = `
function __relicTimed(kind, body) {
  const records = globalThis.${PROOF_GLOBAL};
  if (!Array.isArray(records)) {
    throw new Error('${PROOF_GLOBAL} is not installed: instrumented emit cannot record');
  }
  const start = performance.now();
  try {
    body();
  } finally {
    records.push({ kind, start, end: performance.now() });
  }
}
`;

/** Returns the instrumented module source. Throws if a landmark is missing or duplicated. */
export function instrumentOtioProgramSource(original: string): string {
  assert.equal(
    original.split(PLAYER_LANDMARK).length,
    2,
    'player emit landmark is missing or duplicated'
  );
  assert.equal(
    original.split(SESSION_LANDMARK).length,
    2,
    'session emit landmark is missing or duplicated'
  );
  const player = original.replace(
    PLAYER_LANDMARK,
    `  const emit = (): void => __relicTimed('player', () => emitBody());\n\n  const emitBody = (): void => {\n    if (disposed) return;\n`
  );
  const session = player.replace(
    SESSION_LANDMARK,
    `  private emit(): void {\n    __relicTimed('session', () => this.emitBody());\n  }\n\n  private emitBody(): void {\n    if (this.disposed) return;\n`
  );
  return `${session}\n${RECORDER_HELPER}`;
}

/** Bun build plugin: transforms otio-program.ts wherever the viewer graph loads it. */
export function emitRecorderPlugin(state: { transforms: number }): BunPlugin {
  return {
    name: 'otio-program-emit-recorder',
    setup(build) {
      build.onLoad({ filter: /otio-program\.ts$/ }, async (args) => {
        if (args.path !== PROGRAM_SOURCE) return undefined;
        const original = await readFile(args.path, 'utf8');
        state.transforms += 1;
        return {
          contents: instrumentOtioProgramSource(original),
          loader: 'ts',
        };
      });
    },
  };
}

/** The one module the sham build rewrites: the primer's mute, which keeps it off the device stream. */
const AUDIO_OUTPUT_SOURCE = join(PKG_DIR, 'src', 'otio-audio-output.ts');
const PRIMER_MUTE_LINE_ALL = /^\s*element\.muted = false;\s*$/gm;
const PRIMER_MUTE_LINE = /^(\s*)element\.muted = false;\s*$/m;

/**
 * Returns the sham module source: the primer's element.muted = false becomes true, nothing else.
 * Throws unless that line occurs exactly once. A missing landmark is never a silent production build.
 */
export function shamPrimerSource(original: string): string {
  const hits = original.match(PRIMER_MUTE_LINE_ALL)?.length ?? 0;
  assert.equal(
    hits,
    1,
    `primer mute landmark occurs ${hits} times; the sham needs exactly one`
  );
  return original.replace(PRIMER_MUTE_LINE, '$1element.muted = true;');
}

/** Bun build plugin: rewrites otio-audio-output.ts for the sham build. Counts each rewrite. */
export function shamPrimerPlugin(state: { rewrites: number }): BunPlugin {
  return {
    name: 'otio-primer-sham',
    setup(build) {
      build.onLoad({ filter: /otio-audio-output\.ts$/ }, async (args) => {
        if (args.path !== AUDIO_OUTPUT_SOURCE) return undefined;
        const original = await readFile(args.path, 'utf8');
        state.rewrites += 1;
        return {
          contents: shamPrimerSource(original),
          loader: 'ts',
        };
      });
    },
  };
}

/**
 * Builds the real viewer entry with the production options and the recorder
 * plugin. Writes to outdir only; no production source or build file changes.
 * The caller must overlay non-graph assets (workers, service worker, sandbox)
 * from a production build, since this builds only the main graph.
 */
export async function buildInstrumentedViewer(
  outdir: string,
  options: { readonly sham?: boolean } = {}
): Promise<{
  readonly transforms: number;
  readonly shams: number;
  readonly entry: string;
}> {
  const state = { transforms: 0 };
  const shamState = { rewrites: 0 };
  const built = await Bun.build({
    entrypoints: [VIEWER_ENTRY],
    outdir,
    target: 'browser',
    format: 'esm',
    // Mirrors buildViewer() in build.ts for the main entry. Keep in step with it.
    minify: true,
    splitting: true,
    naming: '[name].js',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      emitRecorderPlugin(state),
      ...(options.sham ? [shamPrimerPlugin(shamState)] : []),
    ],
  });
  if (!built.success) {
    throw new Error(
      `instrumented viewer build failed: ${built.logs.map((log) => log.message).join('\n')}`
    );
  }
  assert.equal(
    state.transforms,
    1,
    'otio-program.ts was not transformed exactly once'
  );
  if (options.sham)
    assert.equal(
      shamState.rewrites,
      1,
      'primer mute landmark was not rewritten exactly once for the sham build'
    );
  const entry = built.outputs.find((output) => output.kind === 'entry-point');
  assert.ok(entry, 'instrumented viewer build produced no entry point');
  const texts = await Promise.all(built.outputs.map((output) => output.text()));
  assert.ok(
    texts.some((text) => text.includes(PROOF_GLOBAL)),
    'instrumented output does not reference the proof array'
  );
  return {
    transforms: state.transforms,
    shams: shamState.rewrites,
    entry: entry.path,
  };
}
