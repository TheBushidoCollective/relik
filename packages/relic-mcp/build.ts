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
import {
  observeAwait,
  observeBegin,
  observeComplete,
  observeError,
  observeEvent,
} from '../../scripts/full-suite-observation.ts';
import { buildCover } from '@relic/viewer/build';

const buildLifecycle = observeBegin('relic-mcp-build', 'top_level_build');
process.once('exit', (code) => {
  observeEvent('relic-mcp-build', 'process-exit', 'process_exit', 'complete', {
    exit_code: code,
  });
});

try {
  const out = new URL('./dist/', import.meta.url).pathname;
  await observeAwait('relic-mcp-build', 'dist_directory_mkdir', () =>
    mkdir(out, { recursive: true })
  );
  await observeAwait('relic-mcp-build', 'cover_build', () =>
    buildCover({ outdir: `${out}cover/` })
  );

  // Read before the build, not after, because the bundle is stamped with this
  // version and the manifests are generated from the same value. The release
  // workflow rewrites package.json before invoking this, so what gets stamped
  // is exactly what gets published.
  const pkg = (await observeAwait('relic-mcp-build', 'package_read', () =>
    Bun.file('./package.json').json()
  )) as {
    version: string;
    name: string;
    description: string;
    author?: unknown;
    homepage?: string;
    repository?: unknown;
  };

  const built = await observeAwait('relic-mcp-build', 'mcp_bundle_build', () =>
    Bun.build({
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
    })
  );

  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }

  const nativeLoader = await observeAwait(
    'relic-mcp-build',
    'native_loader_build',
    () =>
      Bun.build({
        entrypoints: ['./src/native-secure-open.ts'],
        outdir: out,
        target: 'node',
        format: 'esm',
        minify: false,
        splitting: false,
        naming: 'native-secure-open.js',
      })
  );

  if (!nativeLoader.success) {
    for (const log of nativeLoader.logs) console.error(log);
    process.exit(1);
  }

  const nativeDeclaration = await observeAwait(
    'relic-mcp-build',
    'native_declaration_read',
    () => Bun.file('./native/secure-open.d.ts').text()
  );
  await observeAwait('relic-mcp-build', 'native_declaration_write', () =>
    Bun.write(`${out}native-secure-open.d.ts`, nativeDeclaration)
  );

  const bundle = `${out}relic-mcp.js`;
  const text = await observeAwait('relic-mcp-build', 'bundle_read', () =>
    Bun.file(bundle).text()
  );

  if (!text.startsWith('#!/usr/bin/env node')) {
    console.error('bundle lost its shebang; `npx relic-mcp` would not run');
    process.exit(1);
  }

  // `bin` entries have to be executable in the published tarball.
  await observeAwait('relic-mcp-build', 'bundle_chmod', () =>
    chmod(bundle, 0o755)
  );

  const bundleConsoleWrite = observeBegin(
    'relic-mcp-build',
    'bundle_console_write'
  );
  console.log(
    `built dist/relic-mcp.js: ${text.split('\n').length} readable lines`
  );
  observeComplete(bundleConsoleWrite);

  /**
   * Generate the Claude Code manifests and their MCP launch configuration from
   * package.json. The package and plugin are one artifact, so installing either
   * must describe the same client version without a separately maintained pin.
   *
   * mcp-servers.json is committed as the current generated output so a checkout
   * remains installable before its first build. Every release build overwrites it.
   */
  const PLUGIN_DESCRIPTION =
    'Publish a file from your machine as an encrypted, shareable link. The ' +
    'agent encrypts locally, uploads only ciphertext, and hands back a URL ' +
    'whose fragment holds the key, so the service stores something it cannot ' +
    'read.';

  const author = {
    name: 'The Bushido Collective',
    url: 'https://thebushido.co',
  };
  const homepage = 'https://github.com/TheBushidoCollective/relic';

  const pluginMcpServers = {
    relic: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', `${pkg.name}@${pkg.version}`],
      env: {
        RELIC_CLIENT_NAME: `relic-plugin/${pkg.version}`,
      },
    },
  };

  await observeAwait('relic-mcp-build', 'mcp_servers_write', () =>
    Bun.write(
      './mcp-servers.json',
      `${JSON.stringify(pluginMcpServers, null, 2)}\n`
    )
  );

  await observeAwait('relic-mcp-build', 'plugin_directory_mkdir', () =>
    mkdir('./.claude-plugin', { recursive: true })
  );

  await observeAwait('relic-mcp-build', 'plugin_manifest_write', () =>
    Bun.write(
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
    )
  );

  // The package is also a marketplace of one, so `claude plugin marketplace add
  // <path to the installed package>` works with no clone and no network.
  await observeAwait('relic-mcp-build', 'marketplace_manifest_write', () =>
    Bun.write(
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
    )
  );

  const manifestConsoleWrite = observeBegin(
    'relic-mcp-build',
    'manifest_console_write'
  );
  console.log(
    `wrote plugin manifests and launch config at version ${pkg.version}`
  );
  observeComplete(manifestConsoleWrite);
  observeComplete(buildLifecycle);
} catch (error) {
  observeError(buildLifecycle, error);
  throw error;
}
