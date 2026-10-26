/**
 * Production live probe for Relic passkey sign-in (spec §5, slice S5).
 *
 *   RELIC_PASSKEY_PROBE_MAILBOX=user@example.com bun packages/relic-mcp/test/passkey-sign-in-live-probe.ts
 *
 * Exercises passkey sign-in against a live service deployment (default https://relik.link).
 *
 * Requirements:
 *   - RELIC_PASSKEY_PROBE_MAILBOX: mailbox address (never committed, taken from env).
 *   - Derives a fresh plus-tagged address per run: <local>+relic-passkey-<runId>@<domain>.
 *   - Refuses to run if the reader address has no +tag.
 *   - Prints PROBE_AWAIT_MAGIC_LINK email=<addr> and blocks on stdin for the callback link.
 *   - Never prints the relic URL or key.
 *   - Ends with PASSKEY_SIGN_IN_LIVE_OK relic=<id> client=relic-mcp@<version>.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { discoverChrome } from '../src/cover/chrome.ts';
import { runPasskeySignInSequence } from './passkey-sign-in-steps.ts';

const serviceOrigin = (
  process.env['RELIC_SERVICE_ORIGIN'] ?? 'https://relik.link'
).replace(/\/+$/, '');

const probeMailbox = process.env['RELIC_PASSKEY_PROBE_MAILBOX'];
if (!probeMailbox?.includes('@')) {
  console.error(
    'RELIC_PASSKEY_PROBE_MAILBOX must be set to a valid email address (e.g. RELIC_PASSKEY_PROBE_MAILBOX=user@example.com)'
  );
  process.exit(1);
}

const [localPart, domainPart] = probeMailbox.trim().split('@');
if (!localPart || !domainPart) {
  console.error('Invalid email structure in RELIC_PASSKEY_PROBE_MAILBOX');
  process.exit(1);
}
const baseLocal = localPart.split('+')[0];
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const readerEmail = `${baseLocal}+relic-passkey-${runId}@${domainPart}`;

if (!readerEmail.includes('+relic-passkey-')) {
  console.error(
    'Refusing to run: reader address must have a fresh +tag to isolate TOFU passkey registration'
  );
  process.exit(1);
}

const probeClient = process.env['RELIC_PASSKEY_PROBE_CLIENT'] ?? 'npx:0.14.0';

const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

function resolveCommand(): readonly string[] {
  if (probeClient.startsWith('npx:')) {
    const pkg = probeClient.slice(4);
    return ['npx', '-y', `relic-mcp@${pkg}`];
  }
  return ['node', bundlePath];
}

async function resolveChrome(): Promise<string> {
  const envChrome = process.env['RELIC_CHROME_PATH'];
  if (envChrome && envChrome !== 'none') {
    return envChrome;
  }
  const discovered = await discoverChrome(undefined);
  if (discovered.kind === 'found') {
    return discovered.path;
  }
  throw new Error(
    'RELIC_CHROME_PATH must be set to an executable Chrome binary or headless shell'
  );
}

const chromePath = await resolveChrome();
const scratch = await mkdtemp(join(tmpdir(), 'relic-passkey-live-probe-'));
const statePath =
  process.env['RELIC_PUBLISH_STATE'] ?? join(scratch, 'state.json');

async function readLineFromStdin(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question('');
  } finally {
    rl.close();
  }
}

async function resolveMagicLink(email: string): Promise<string> {
  console.log(`PROBE_AWAIT_MAGIC_LINK email=${email}`);
  const input = (await readLineFromStdin()).trim();
  const escapedOrigin = serviceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapedOrigin}/api/auth/callback\\?token=[A-Za-z0-9_-]{43}`
  );
  const match = input.match(pattern);
  if (!match) {
    throw new Error(
      `Received invalid magic link on stdin. Expected matching: ${pattern.source}`
    );
  }
  return match[0];
}

try {
  const result = await runPasskeySignInSequence({
    serviceOrigin,
    scratchDir: scratch,
    statePath,
    mcpCommand: resolveCommand(),
    chromePath,
    readerEmail,
    resolveMagicLink,
    isLive: true,
  });

  const clientTag = probeClient.startsWith('npx:')
    ? `relic-mcp@${probeClient.slice(4)}`
    : 'relic-mcp@source';
  console.log(
    `PASSKEY_SIGN_IN_LIVE_OK relic=${result.relicId} client=${clientTag}`
  );
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
