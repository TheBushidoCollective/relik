/**
 * Operator-run production probe for Relic private shares (plan section 5 S8).
 *
 *   RELIC_ORIGIN=https://relik.link RELIC_CHROME_PATH=<owned headless shell> \
 *   PROBE_OPERATOR_EMAIL=<your mailbox> \
 *   bun packages/relic-mcp/test/private-shares-live-probe.ts --i-am-the-operator
 *
 * Writes real private relics and identities to the production service, under
 * `+tag` addresses on the operator's own mailbox. Every step runs as in the
 * loopback path, with three differences: the mail is read from the operator
 * (the probe prints PROBE_AWAIT_MAIL and reads the mail from stdin, ending with a
 * line containing only `.END`), the store-level checks are not observable and
 * print unobserved, and step 6 (which swaps a stored request) is not run.
 *
 * The probe ends with the owner's hard delete of the relic it created (step 11).
 * If a step fails after the relic exists, the failure line names the step, and the
 * probe prints the tag and the owner address so the operator can find the relic on
 * the owner's dashboard and delete it there.
 * It refuses to run without --i-am-the-operator, RELIC_ORIGIN, PROBE_OPERATOR_EMAIL
 * and RELIC_CHROME_PATH, and it refuses to run in CI.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type CapturedMail,
  type Mailbox,
  type PrivateShareEnv,
  runPrivateShares,
} from './private-shares-steps.ts';

function refuse(reason: string): never {
  console.error(`PRIVATE_SHARES_LIVE_REFUSED ${reason}`);
  process.exit(2);
}

if (process.env['CI'] || process.env['GITHUB_ACTIONS']) {
  refuse('this probe writes to production and never runs in CI');
}
if (!process.argv.includes('--i-am-the-operator')) {
  refuse('pass --i-am-the-operator to confirm you run this against production');
}
const origin = process.env['RELIC_ORIGIN'];
if (!origin || !origin.startsWith('https://'))
  refuse('RELIC_ORIGIN must be the https service origin');
const operatorEmail = process.env['PROBE_OPERATOR_EMAIL'];
if (!operatorEmail || !operatorEmail.includes('@'))
  refuse('PROBE_OPERATOR_EMAIL must name your mailbox');
const chromePath = process.env['RELIC_CHROME_PATH'];
if (!chromePath || chromePath === 'none')
  refuse('RELIC_CHROME_PATH must name an owned headless Chrome');

const [localPart = '', domain = ''] = operatorEmail.split('@');
const tag = `probe${Date.now().toString(36)}`;
const address = (role: string): string =>
  `${localPart}+${tag}-${role}@${domain}`;

const relicMcpBundle = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
const scratch = await mkdtemp(join(tmpdir(), 'relic-private-shares-live-'));
const statePath = join(scratch, 'publish-state.json');

const lines = createInterface({ input: process.stdin });
const pending: string[] = [];
const waiters: Array<(line: string) => void> = [];
lines.on('line', (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else pending.push(line);
});

async function readLine(): Promise<string> {
  const queued = pending.shift();
  if (queued !== undefined) return queued;
  const { promise, resolve } = Promise.withResolvers<string>();
  waiters.push(resolve);
  return promise;
}

/** Reads one pasted mail: a `Subject:` line, the body, and a line with only `.END`. */
async function readMail(to: string): Promise<CapturedMail> {
  let subject = '';
  const body: string[] = [];
  let line = await readLine();
  if (line.startsWith('Subject: ')) {
    subject = line.slice('Subject: '.length);
    line = await readLine();
  }
  while (line !== '.END') {
    body.push(line);
    line = await readLine();
  }
  const text = body.join('\n');
  const code = text.match(/\b\d{6}\b/)?.[0];
  const link = text.match(/https?:\/\/\S+/)?.[0];
  return {
    to,
    subject,
    text,
    link: link ?? '',
    ...(code === undefined ? {} : { code }),
  };
}

const seen: CapturedMail[] = [];
const mailbox: Mailbox = {
  mark: () => seen.length,
  all: () => seen,
  async await(to, since, match, label) {
    console.log(`PROBE_AWAIT_MAIL to=${to} label=${label}`);
    for (;;) {
      const mail = await readMail(to);
      seen.push(mail);
      if (
        mail.to.toLowerCase() === to.toLowerCase() &&
        match(mail) &&
        seen.indexOf(mail) >= since
      ) {
        return mail;
      }
      console.log(`PROBE_MAIL_SKIPPED subject=${mail.subject}`);
    }
  },
};

const env: PrivateShareEnv = {
  serviceOrigin: origin,
  scratchDir: scratch,
  statePath,
  mcpCommand: ['node', relicMcpBundle],
  chromePath,
  owner: address('owner'),
  reader: address('reader'),
  third: address('third'),
  noPrf: address('noprf'),
  mailbox,
  receipt: (_step, line) => {
    console.log(line);
  },
  defect: (id, evidence) => {
    console.error(`DEFECT ${id}: ${evidence}`);
  },
};

try {
  await runPrivateShares(env);
  console.log(`PRIVATE_SHARES_LIVE_DONE relic_origin=${origin} tag=${tag}`);
} catch (error) {
  console.error(
    `PRIVATE_SHARES_LIVE_FAILED tag=${tag} owner=${address('owner')} ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  lines.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
