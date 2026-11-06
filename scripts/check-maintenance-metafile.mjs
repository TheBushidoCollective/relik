import { readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateMetafile(meta) {
  if (!meta || typeof meta.inputs !== 'object' || typeof meta.outputs !== 'object') throw Error('missing build metadata');
  const paths = Object.keys(meta.inputs).map(path => posix.normalize(path.replace(/^\.\//, ''))).sort();
  const roots = ['packages/relic-server/src/', 'packages/relic-format/src/'];
  for (const path of paths) {
    if (path.startsWith('/') || path.includes('..') || path.includes('node_modules/') || path === 'packages/relic-server/src/index.ts' || !(path === 'scripts/ephemeral-operator.ts' || roots.some(root => path.startsWith(root)))) throw Error('unreviewed bundle input');
  }
  if (!paths.includes('scripts/ephemeral-operator.ts') || !paths.includes('packages/relic-server/src/app.ts') || !paths.includes('packages/relic-server/src/gcsstore.ts')) throw Error('missing required bundle input');
  const allowed = new Set(['node:crypto', 'crypto', 'node:zlib', 'zlib']);
  for (const entry of [...Object.values(meta.inputs), ...Object.values(meta.outputs)]) {
    for (const item of entry.imports ?? []) {
      if (item.external && !allowed.has(item.path)) {
        const name = typeof item.path === 'string' && /^[A-Za-z0-9@_./:+-]{1,120}$/.test(item.path) && !item.path.startsWith('/') && !item.path.includes('..') ? item.path : '<invalid-module-name>';
        throw Error('unreviewed runtime import: ' + name);
      }
    }
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const meta = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  writeFileSync(process.argv[3], validateMetafile(meta).join('\n') + '\n');
}
