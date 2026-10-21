#!/usr/bin/env node
/**
 * Entry point for the local MCP server.
 *
 * Plain Node, no Bun APIs, because this ships to npm and runs under whatever
 * runtime `npx` happens to have. Fetch, TextEncoder, and web streams are
 * standard from Node 18 on; Web Crypto is initialized below for that release.
 *
 * stdio by default, which is what every agent runner expects. Set
 * `RELIC_MCP_HTTP=1` to serve the Streamable HTTP transport instead.
 *
 * Nothing is written to stdout except JSON-RPC. Diagnostics go to stderr,
 * because a stray stdout write corrupts the protocol stream.
 */

import { webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { coverAssetDir } from './cover/assets.ts';
import { chromeCoverRenderer, DEFAULT_DEADLINE_MS } from './cover/render.ts';
import { nodeFiles } from './files.ts';
import { createHttpHandler } from './http.ts';
import { runInstall, USAGE } from './installer.ts';
import { requiredOrigin, resolveOrigin } from './origin.ts';
import type { PublishDeps } from './publish.ts';
import { serveStdio } from './server.ts';

// Node 18 exposes Web Crypto through node:crypto without a global binding.
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

// Subcommands are handled before anything that needs configuration, so
// `--help` works on a machine that has never set an origin.
const argv = process.argv.slice(2);

if (argv[0] === 'install') {
  await runInstall(argv.slice(1));
  process.exit(0);
}

if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

// Unset means the hosted service, which is what almost every install wants
// and is why nothing has to name it. Set it to publish to your own; see
// origin.ts for the cost that buys and how the destination stays visible.
const serviceOrigin = resolveOrigin(
  'RELIC_SERVICE_ORIGIN',
  process.env['RELIC_SERVICE_ORIGIN']
);

const deps: PublishDeps = {
  serviceOrigin,
  // Where the shareable link points, when a reverse proxy or custom domain
  // fronts the API. Defaults to the API's own origin, which is the common case.
  relicOrigin:
    process.env['RELIC_ORIGIN'] === undefined
      ? serviceOrigin
      : requiredOrigin('RELIC_ORIGIN', process.env['RELIC_ORIGIN']),
  files: nodeFiles,
  fetch: globalThis.fetch,
  // Recorded against the grant, so the service can tell what published. No
  // version baked in: a literal here goes stale the first release nobody
  // remembers to edit, and a wrong version in a log is worse than none.
  // Whatever installs this can set the variable to something more specific.
  clientName: process.env['RELIC_CLIENT_NAME'] ?? 'relic-mcp',
  // Renders the cover in the publisher's own Chrome, Chromium or Edge, with
  // networking closed. RELIC_CHROME_PATH names the browser, or turns covers
  // off with `none`; unset means the per-platform discovery in chrome.ts.
  renderCover: chromeCoverRenderer({
    chromePath: process.env['RELIC_CHROME_PATH'],
    ffmpegPath: undefined,
    assetDir: coverAssetDir(),
    deadlineMs: DEFAULT_DEADLINE_MS,
  }),
};

if (process.env['RELIC_MCP_HTTP'] === '1') {
  const port = Number(process.env['RELIC_MCP_PORT'] ?? 7333);
  // Loopback, not 0.0.0.0. This process can read any file its user can, so
  // binding it to a network interface hands that reach to the network.
  const hostname = process.env['RELIC_MCP_HOST'] ?? '127.0.0.1';

  const allowedOrigins = (process.env['RELIC_MCP_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const handler = createHttpHandler(deps, { allowedOrigins });

  createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void (async () => {
        const url = new URL(
          incoming.url ?? '/',
          `http://${incoming.headers.host ?? `${hostname}:${port}`}`
        );

        if (url.pathname !== '/mcp') {
          outgoing.writeHead(404).end('Not found');
          return;
        }

        const method = incoming.method ?? 'GET';
        const request = new Request(url, {
          method,
          headers: incoming.headers as Record<string, string>,
          ...(method === 'GET' || method === 'HEAD'
            ? {}
            : { body: Buffer.concat(chunks) }),
        });

        const response = await handler(request);
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries())
        );
        const body = await response.arrayBuffer();
        outgoing.end(Buffer.from(body));
      })();
    });
  }).listen(port, hostname, () => {
    console.error(`relic-mcp listening on http://${hostname}:${port}/mcp`);
  });
} else {
  // Node's stdin is a classic Readable; the transport reads a web stream.
  await serveStdio(
    deps,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    (line) => {
      process.stdout.write(`${line}\n`);
    }
  );
}
