/**
 * Viewer builds for the proofs, served one arm at a time.
 *
 * A build is a complete directory: its entry, every hashed chunk it wrote, and the non-graph
 * assets copied from production (workers, service worker, sandbox). Arms never share a served
 * directory, and no file is copied into another build's directory. Switching arms switches which
 * complete directory is served. Production is never written to; VIEWER_DIST stays read-only.
 *
 * Routing is checked before a build is served:
 *   - every output the build reports must exist in its directory;
 *   - every `./name.js` its JavaScript references must exist in that directory;
 *   - every hashed chunk it references must be one of its own outputs, so a graph chunk can never
 *     load from another arm.
 * Non-graph files such as workers are not outputs of the graph build. They are present in the
 * directory as copies of production, and the existence rule covers them.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type Asset,
  type AssetSource,
  diskAssets,
} from '@relic/server/src/assets.ts';

export interface ViewerBuild {
  /** Label used in receipts and in served-build records. */
  readonly name: string;
  /** Complete served directory for this build. Never written to after creation. */
  readonly dir: string;
  /** Basenames of the JavaScript this build's graph wrote, including main.js. */
  readonly outputs: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** `./name.js` references, as the bundler writes them in import() and worker URLs. */
const REFERENCE = /\.\/([A-Za-z0-9_.-]+\.js)/g;
const CHUNK = /^chunk-/;

/** A build from the output paths a bundler reported. Paths may be absolute or basenames. */
export function viewerBuild(
  name: string,
  dir: string,
  outputs: readonly string[]
): ViewerBuild {
  return { name, dir, outputs: outputs.map((output) => basename(output)) };
}

/** Every top-level .js file in a directory, as basenames. */
export async function listJavaScript(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.js')).sort();
}

/** The build's graph bytes, keyed by basename. The build directory is only read. */
export async function readBuild(
  build: ViewerBuild
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const output of build.outputs) {
    const path = join(build.dir, output);
    if (!(await exists(path)))
      throw new Error(
        `${build.name}: output ${output} is missing from ${build.dir}`
      );
    out.set(output, new Uint8Array(await readFile(path)));
  }
  return out;
}

/** Routing failures for one build. Empty means the build can be served as a whole. */
export async function verifyRouting(build: ViewerBuild): Promise<string[]> {
  const failures: string[] = [];
  if (!build.outputs.includes('main.js'))
    failures.push(`${build.name}: no main.js in its outputs`);
  for (const output of build.outputs) {
    if (!(await exists(join(build.dir, output))))
      failures.push(
        `${build.name}: output ${output} is missing from ${build.dir}`
      );
  }
  for (const output of build.outputs) {
    if (!output.endsWith('.js')) continue;
    // A missing output is already recorded above. Reading it would throw ENOENT instead.
    if (!(await exists(join(build.dir, output)))) continue;
    const text = await readFile(join(build.dir, output), 'latin1');
    for (const match of text.matchAll(REFERENCE)) {
      const reference = match[1]!;
      if (!(await exists(join(build.dir, reference))))
        failures.push(
          `${build.name}: ${output} references ${reference}, which is missing from ${build.dir}`
        );
      else if (CHUNK.test(reference) && !build.outputs.includes(reference))
        failures.push(
          `${build.name}: ${output} references chunk ${reference}, which this build did not write`
        );
    }
  }
  return failures;
}

/**
 * Serves whichever complete build is active. Each request is answered from that build's directory
 * only. The served record lists the build names that answered JavaScript requests since the last
 * reset, so a trial can prove which build actually ran.
 */
export class ViewerRouter implements AssetSource {
  #active: ViewerBuild;
  readonly #served = new Set<string>();

  constructor(initial: ViewerBuild) {
    this.#active = initial;
  }

  get active(): ViewerBuild {
    return this.#active;
  }

  /** Makes a build the one served, once its routing is verified. Throws otherwise. */
  async activate(build: ViewerBuild): Promise<void> {
    const failures = await verifyRouting(build);
    if (failures.length)
      throw new Error(`cannot serve ${build.name}: ${failures.join('; ')}`);
    this.#active = build;
  }

  resetServed(): void {
    this.#served.clear();
  }

  /** Build names that answered JavaScript requests since the last reset, sorted. */
  servedBuilds(): string[] {
    return [...this.#served].sort();
  }

  async get(pathname: string): Promise<Asset | undefined> {
    const asset = await diskAssets(this.#active.dir).get(pathname);
    if (asset && pathname.endsWith('.js')) this.#served.add(this.#active.name);
    return asset;
  }
}
