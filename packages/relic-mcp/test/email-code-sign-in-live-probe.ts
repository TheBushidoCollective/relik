/**
 * Production live probe for Relic email code sign-in (spec §2 and §6 slice P).
 *
 *   RELIC_EMAIL_CODE_PROBE_MAILBOX=user@example.com RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/email-code-sign-in-live-probe.ts
 *
 * Exercises email code sign-in against a live service deployment (default https://relik.link).
 *
 * Requirements:
 *   - RELIC_EMAIL_CODE_PROBE_MAILBOX: mailbox address (never committed, taken from env).
 *   - Derives a fresh plus-tagged address per run: <local>+relic-code-<runId>@<domain>.
 *   - Refuses to run if the reader address has no +tag.
 *   - Prints PROBE_AWAIT_SIGN_IN_CODE email=<addr> and blocks on stdin for the code.
 *   - Prints PROBE_AWAIT_SIGN_IN_LINK email=<addr> and blocks on stdin for that email's link.
 *   - Never prints the relic URL or key.
 *   - Ends with EMAIL_CODE_SIGN_IN_LIVE_OK relic=<id> navigations=0 link=401.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { discoverChrome } from '../src/cover/chrome.ts';
import { runEmailCodeSignInSequence } from './email-code-sign-in-steps.ts';

const serviceOrigin = (
  process.env['RELIC_SERVICE_ORIGIN'] ?? 'https://relik.link'
).replace(/\/+$/, '');

const probeMailbox = process.env['RELIC_EMAIL_CODE_PROBE_MAILBOX'];
if (!probeMailbox?.includes('@')) {
  console.error(
    'RELIC_EMAIL_CODE_PROBE_MAILBOX must be set to a valid email address (e.g. RELIC_EMAIL_CODE_PROBE_MAILBOX=user@example.com)'
  );
  process.exit(1);
}

const [localPart, domainPart] = probeMailbox.trim().split('@');
if (!localPart || !domainPart) {
  console.error('Invalid email structure in RELIC_EMAIL_CODE_PROBE_MAILBOX');
  process.exit(1);
}
const baseLocal = localPart.split('+')[0];
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const readerEmail = `${baseLocal}+relic-code-${runId}@${domainPart}`;

if (!readerEmail.includes('+relic-code-')) {
  console.error('Refusing to run: reader address must have a fresh +tag');
  process.exit(1);
}

const probeClient = process.env['RELIC_EMAIL_CODE_PROBE_CLIENT'] ?? 'source';

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
const scratch = await mkdtemp(join(tmpdir(), 'relic-email-code-live-probe-'));
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

async function promptForCodeAndLink(
  email: string
): Promise<{ code: string; link: string }> {
  console.log(`PROBE_AWAIT_SIGN_IN_CODE email=${email}`);
  const rawCode = (await readLineFromStdin()).trim();
  const codeMatch = rawCode.match(/\b\d{6}\b/);
  if (!codeMatch) {
    throw new Error(
      'Received invalid sign-in code on stdin. Expected 6 digits.'
    );
  }
  const code = codeMatch[0];

  console.log(`PROBE_AWAIT_SIGN_IN_LINK email=${email}`);
  const inputLink = (await readLineFromStdin()).trim();
  const escapedOrigin = serviceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkPattern = new RegExp(
    `${escapedOrigin}/api/auth/callback\\?token=[A-Za-z0-9_-]{43}`
  );
  const match = inputLink.match(linkPattern);
  if (!match) {
    throw new Error(
      `Received invalid magic link on stdin. Expected matching: ${linkPattern.source}`
    );
  }
  const link = match[0];
  return { code, link };
}

try {
  const result = await runEmailCodeSignInSequence({
    serviceOrigin,
    scratchDir: scratch,
    statePath,
    mcpCommand: resolveCommand(),
    chromePath,
    readerEmail,
    awaitSignInMail: async () => {
      throw new Error('awaitSignInMail not used in live probe');
    },
    isLive: true,
    promptForCodeAndLink,
  });

  console.log(
    `EMAIL_CODE_SIGN_IN_LIVE_OK relic=${result.relicId} navigations=0 link=401`
  );
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
