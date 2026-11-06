import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
const meta = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!meta || typeof meta.inputs !== 'object' || typeof meta.outputs !== 'object') throw Error('missing build metadata');
const paths = Object.keys(meta.inputs).map(path => posix.normalize(path.replace(/^\.\//, ''))).sort();
const roots = ['packages/relic-server/src/', 'packages/relic-format/src/'];
for (const path of paths) {
  if (path.startsWith('/') || path.includes('..') || path.includes('node_modules/') || path === 'packages/relic-server/src/index.ts' || !(path === 'scripts/ephemeral-operator.ts' || roots.some(root => path.startsWith(root)))) throw Error('unreviewed bundle input');
}
if (!paths.includes('scripts/ephemeral-operator.ts') || !paths.includes('packages/relic-server/src/app.ts') || !paths.includes('packages/relic-server/src/gcsstore.ts')) throw Error('missing required bundle input');
const allowed = new Set(['node:crypto', 'node:zlib']);
for (const entry of [...Object.values(meta.inputs), ...Object.values(meta.outputs)]) {
  for (const item of entry.imports ?? []) if (item.external && !allowed.has(item.path)) throw Error('unreviewed runtime import');
}
writeFileSync(process.argv[3], paths.join('\n') + '\n');
