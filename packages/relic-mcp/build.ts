/**
 * Bundle the client into one readable Node ESM file.
 *
 * Deliberately NOT minified. The JavaScript encryption path stays readable so
 * an agent or person can inspect what happens before trusting it. The
 * source-included Node-API confined opener for .otiod is the narrow compiled
 * exception; it ships as audited source and target-specific prebuilts. A
 * minified JavaScript bundle would still be a black box wearing a `.js`
 * extension.
 *
 * One file rather than a tree, because the alternative is publishing
 * `@relic/format` separately and asking a reader to follow imports across
 * packages to answer "what happens to my file".
 */

import { chmod, mkdir } from 'node:fs/promises';
import { buildCover } from '@relic/viewer/build';

const out = new URL('./dist/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
await buildCover({ outdir: `${out}cover/` });

// Read before the build, not after, because the bundle is stamped with this
// version and the manifests are generated from the same value. The release
// workflow rewrites package.json before invoking this, so what gets stamped
// is exactly what gets published.
const pkg = (await Bun.file('./package.json').json()) as {
  version: string;
  name: string;
  description: string;
  author?: unknown;
  homepage?: string;
  repository?: unknown;
};

const built = await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: out,
  target: 'node',
  format: 'esm',
  minify: false,
  splitting: false,
  naming: 'relic-mcp.js',
  // The version the server reports to clients. Substituted here so it cannot
  // drift from the tarball the way a literal in the source did.
  define: {
    'process.env.RELIC_MCP_VERSION': JSON.stringify(pkg.version),
    'process.env.RELIC_MCP_COVER_DIR': JSON.stringify('./cover/'),
  },
  // No banner: Bun preserves the entrypoint's own shebang, and adding a
  // second one puts `#!` on line 2, which is a syntax error rather than a
  // comment.
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const nativeLoader = await Bun.build({
  entrypoints: ['./src/native-secure-open.ts'],
  outdir: out,
  target: 'node',
  format: 'esm',
  minify: false,
  splitting: false,
  naming: 'native-secure-open.js',
});

if (!nativeLoader.success) {
  for (const log of nativeLoader.logs) console.error(log);
  process.exit(1);
}

await Bun.write(
  `${out}native-secure-open.d.ts`,
  await Bun.file('./native/secure-open.d.ts').text()
);

const bundle = `${out}relic-mcp.js`;
const text = await Bun.file(bundle).text();

if (!text.startsWith('#!/usr/bin/env node')) {
  console.error('bundle lost its shebang; `npx relic-mcp` would not run');
  process.exit(1);
}

// `bin` entries have to be executable in the published tarball.
await chmod(bundle, 0o755);

console.log(
  `built dist/relic-mcp.js: ${text.split('\n').length} readable lines`
);

/**
 * Generate the Claude Code manifests from package.json.
 *
 * The package and the plugin are the same artifact: installing from npm and
 * installing from the repo have to describe the same thing, and a version that
 * only matches because somebody remembered to edit it in four places will stop
 * matching. Generating them means package.json is the one source of truth, and
 * a stale manifest cannot be committed because it is not committed at all.
 */
// Read above, before the build, because the bundle is stamped from it too.

const PLUGIN_DESCRIPTION =
  'Publish a file from your machine as an encrypted, shareable link. The ' +
  'agent encrypts locally, uploads only ciphertext, and hands back a URL ' +
  'whose fragment holds the key, so the service stores something it cannot ' +
  'read.';

const author = { name: 'The Bushido Collective', url: 'https://thebushido.co' };
const homepage = 'https://github.com/TheBushidoCollective/relic';

await mkdir('./.claude-plugin', { recursive: true });

await Bun.write(
  './.claude-plugin/plugin.json',
  `${JSON.stringify(
    {
      name: 'relic',
      version: pkg.version,
      description: PLUGIN_DESCRIPTION,
      mcpServers: './mcp-servers.json',
      author,
      homepage,
      repository: homepage,
      license: 'UNLICENSED',
      keywords: [
        'claude-code',
        'claude-code-plugin',
        'sharing',
        'encryption',
        'zero-knowledge',
        'publishing',
      ],
    },
    null,
    2
  )}\n`
);

// The package is also a marketplace of one, so `claude plugin marketplace add
// <path to the installed package>` works with no clone and no network.
await Bun.write(
  './.claude-plugin/marketplace.json',
  `${JSON.stringify(
    {
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'relic',
      description:
        'Relic: zero-knowledge publishing for agent output. Turns a local ' +
        'file into a shareable link without handing the file to anybody.',
      owner: author,
      plugins: [
        {
          name: 'relic',
          description: PLUGIN_DESCRIPTION,
          version: pkg.version,
          source: './',
          author,
          homepage,
          category: 'productivity',
        },
      ],
      metadata: { version: pkg.version },
    },
    null,
    2
  )}\n`
);

console.log(`wrote plugin manifests at version ${pkg.version}`);
