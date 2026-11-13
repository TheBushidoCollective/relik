/**
 * Build-time only: bundles the program render page into plain files that a
 * Node host can serve. Bun is used for bundling; the output needs no Bun.
 *
 *   bun run packages/relic-viewer/src/program-render/build.ts <outDir>
 *
 * Writes exactly index.html and index.js into outDir.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Relic program render</title>
<script type="module" src="./index.js"></script>
`;

export async function buildProgramPage(outDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(here, 'page.ts')],
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join('\n');
    throw new Error(`Program page build failed:\n${messages}`);
  }
  const script = result.outputs[0];
  if (!script) throw new Error('Program page build produced no output');
  await mkdir(outDir, { recursive: true });
  await Bun.write(join(outDir, 'index.js'), await script.text());
  await Bun.write(join(outDir, 'index.html'), INDEX_HTML);
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: build.ts <outDir>');
  await buildProgramPage(outDir);
}
