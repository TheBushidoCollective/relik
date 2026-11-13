// Proof-only viewer build: the production viewer with its retained-slot requirement
// pinned to the old fixed three-slot ring. It is never a product build and adds no hook
// to production code. It builds from a copy of the viewer tree, so the production source
// and its own build output are never modified.
//
// The transform matches one exact landmark in the source. It fails when the landmark is
// absent or appears more than once, so a renamed or reformatted function cannot be
// silently skipped.
//
// Workspace placement: the copy is built in a directory created with mkdtemp as a SIBLING
// of the viewer root (in the viewer's parent directory), never inside it. Copying a
// directory into its own subtree is rejected by fs.cp (ERR_FS_CP_EINVAL), so the sibling
// placement is what makes the copy possible at all. The build reads mediabunny from
// ./node_modules relative to its own file, so the workspace links the viewer's
// node_modules; package imports from the copied source then resolve exactly as they do
// for the production build. Each run removes only the directory it created.
//
// Usage (CI, then the proof run):
//   bun packages/relic-mcp/test/proof-viewer-three-slot.ts <outdir>
//   RELIC_VIEWER_DIST=<outdir> RELIC_OTIO_PROOF_VIEWER_MANIFEST=<outdir>/proof-viewer-manifest.json \
//     bun packages/relic-mcp/test/otio-path.ts

import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const THREE_SLOT_SOURCE = 'src/otio-video-decoders.ts';

// Every workspace this script creates is named with this prefix. Copies never include
// any directory with the prefix, so a foreign workspace never enters a build.
export const WORKSPACE_PREFIX = '.proof-three-slot-';

// requiredResidentSlots: the requirement grows with the measured lead and offset. The
// three-slot build pins it to the fixed ring, so the viewer must refuse explicitly
// wherever three slots cannot hold the causal phase.
export const THREE_SLOT_LANDMARK = [
  '  const reach = vsyncSeconds + leadSeconds + offsetSeconds;',
  '  return Math.max(',
  '    SNAPSHOT_SLOTS_PER_DECODER,',
  '    1 + Math.ceil(reach / wMinSeconds)',
  '  );',
].join('\n');

export const THREE_SLOT_REPLACEMENT =
  '  return SNAPSHOT_SLOTS_PER_DECODER; // proof-only three-slot transform';

export function applyThreeSlotTransform(source: string): {
  text: string;
  landmarkCount: number;
} {
  const landmarkCount = source.split(THREE_SLOT_LANDMARK).length - 1;
  if (landmarkCount !== 1)
    throw new Error(
      `three-slot landmark found ${landmarkCount} times in ${THREE_SLOT_SOURCE}; expected exactly one`
    );
  return {
    text: source.replace(THREE_SLOT_LANDMARK, THREE_SLOT_REPLACEMENT),
    landmarkCount,
  };
}

export function defaultViewerRoot(): string {
  return fileURLToPath(new URL('../../relic-viewer/', import.meta.url));
}

export function workspaceParent(viewerRoot: string): string {
  return dirname(resolve(viewerRoot));
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

// Runs `use` inside a directory this call created as a sibling of viewerRoot. The
// directory is the only path removed, on success or failure. Its node_modules is linked
// from the viewer so package-relative resolution matches the production build.
export async function withOwnedWorkspace<T>(
  viewerRoot: string,
  use: (work: string) => Promise<T>
): Promise<T> {
  const root = resolve(viewerRoot);
  const work = await mkdtemp(join(workspaceParent(root), WORKSPACE_PREFIX));
  try {
    const installed = join(root, 'node_modules');
    if (!(await pathExists(installed)))
      throw new Error(
        `viewer node_modules missing at ${installed}; install dependencies before the proof build`
      );
    await symlink(installed, join(work, 'node_modules'), 'dir');
    return await use(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Copy filter for the viewer tree. It keeps the source, and never copies node_modules
// (linked instead), dist, or any workspace directory, including the exact path being
// built into. The workspace is a sibling, so it is never inside the copied tree, but the
// check stays so a misplaced workspace can never recurse into itself.
export function includeInCopy(
  viewerRoot: string,
  work: string,
  src: string
): boolean {
  const absolute = resolve(src);
  const own = resolve(work);
  if (absolute === own || absolute.startsWith(own + sep)) return false;
  const rel = relative(resolve(viewerRoot), absolute);
  if (rel === '') return true;
  const first = rel.split(sep)[0] ?? '';
  if (first === 'node_modules' || first === 'dist') return false;
  if (first.startsWith(WORKSPACE_PREFIX)) return false;
  return true;
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export interface ThreeSlotManifest {
  kind: 'three-slot';
  outdir: string;
  source: string;
  landmarkCount: number;
  landmarkSha256: string;
  originalSourceSha256: string;
  transformedSourceSha256: string;
}

export async function buildThreeSlotViewer(
  outdir: string,
  viewerRoot: string = defaultViewerRoot()
): Promise<ThreeSlotManifest> {
  const root = resolve(viewerRoot);
  return withOwnedWorkspace(root, async (work) => {
    await cp(root, work, {
      recursive: true,
      filter: (src) => includeInCopy(root, work, src),
    });
    const sourcePath = join(work, THREE_SLOT_SOURCE);
    const original = await readFile(sourcePath, 'utf8');
    const transformed = applyThreeSlotTransform(original);
    await writeFile(sourcePath, transformed.text);
    // The copied build.ts exists only after this run copies the viewer tree, so its path is runtime-selected.
    const { buildViewer } = (await import(
      pathToFileURL(join(work, 'build.ts')).href
    )) as { buildViewer: (options: { outdir: string }) => Promise<string> };
    await buildViewer({ outdir: `${resolve(outdir)}/` });
    const manifest: ThreeSlotManifest = {
      kind: 'three-slot',
      outdir: resolve(outdir),
      source: THREE_SLOT_SOURCE,
      landmarkCount: transformed.landmarkCount,
      landmarkSha256: sha256(THREE_SLOT_LANDMARK),
      originalSourceSha256: sha256(original),
      transformedSourceSha256: sha256(transformed.text),
    };
    await writeFile(
      join(outdir, 'proof-viewer-manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    return manifest;
  });
}

if (import.meta.main) {
  const outdir = resolve(
    process.argv[2] ??
      fileURLToPath(
        new URL('../../relic-viewer/dist-proof-three-slot/', import.meta.url)
      )
  );
  const manifest = await buildThreeSlotViewer(outdir);
  console.log(`PROOF_VIEWER_THREE_SLOT ${manifest.outdir}`);
}
