/**
 * Live service change notification and sharing probe.
 *
 *   RELIC_NOTIFY_PROBE_TO=a@example.test,b@example.test bun packages/relic-mcp/test/notify-live-probe.ts
 *
 * Exercises change notifications and sharing against a live deployment.
 * Supports:
 *   RELIC_SERVICE_ORIGIN: destination service, defaults to https://relik.link
 *   RELIC_NOTIFY_PROBE_TO: comma-separated list of recipient email addresses (required)
 *   RELIC_NOTIFY_PROBE_CLIENT: 'source' (local dist bundle) or 'npx:<version>'
 *   RELIC_NOTIFY_PROBE_PHASE: 'send' | 'after-stop' | 'quiet', defaults to 'send'
 *   RELIC_PUBLISH_STATE: optional fixed state path
 *   RELIC_OPERATOR_TOKEN: optional operator token for cleanup DELETE
 *
 * Never prints the share URL, because the URL fragment contains the key.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceOrigin = (
  process.env['RELIC_SERVICE_ORIGIN'] ?? 'https://relik.link'
).replace(/\/+$/, '');

const probeToRaw = process.env['RELIC_NOTIFY_PROBE_TO'];
if (!probeToRaw || probeToRaw.trim().length === 0) {
  console.error(
    'RELIC_NOTIFY_PROBE_TO must be set to at least one recipient email address (e.g. RELIC_NOTIFY_PROBE_TO=a@example.test,b@example.test)'
  );
  process.exit(1);
}
const probeRecipients = probeToRaw
  .split(',')
  .map((addr) => addr.trim())
  .filter((addr) => addr.length > 0);

const probeClient = process.env['RELIC_NOTIFY_PROBE_CLIENT'] ?? 'source';
const probePhase = process.env['RELIC_NOTIFY_PROBE_PHASE'] ?? 'send';
const operatorToken = process.env['RELIC_OPERATOR_TOKEN'];

const scratch = await mkdtemp(join(tmpdir(), 'relic-notify-live-probe-'));
const statePath =
  process.env['RELIC_PUBLISH_STATE'] ?? join(scratch, 'state.json');

const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

function resolveCommand(): string[] {
  if (probeClient.startsWith('npx:')) {
    const pkg = probeClient.slice(4);
    return ['npx', `relic-mcp@${pkg}`];
  }
  return ['node', bundlePath];
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cmd = resolveCommand();
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: serviceOrigin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/notify-live-probe',
      RELIC_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(exit, 0, `relic-mcp exited with code ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  assert.ok(lines.length > 0, 'no JSON-RPC response from relic-mcp');
  const response = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<
    string,
    unknown
  >;
  assert.ok(
    !response['error'],
    `JSON-RPC error from ${toolName}: ${JSON.stringify(response['error'])}`
  );
  const result = response['result'] as Record<string, unknown>;
  assert.ok(
    !result['isError'],
    `tool error from ${toolName}: ${JSON.stringify(result['content'])}`
  );
  return (result['structuredContent'] ?? {}) as Record<string, unknown>;
}

/**
 * The relic the send phase published, read from the publish state file the
 * client keeps: its `relics` map, keyed by relic id. The later phases run in
 * fresh processes, so the state file is the only place the id survives.
 */
async function probeRelicId(): Promise<string> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    relics?: Record<string, unknown>;
  };
  const ids = Object.keys(state.relics ?? {});
  assert.equal(
    ids.length,
    1,
    `expected exactly one relik in ${statePath}; set RELIC_PUBLISH_STATE to the send phase's state file`
  );
  return ids[0] as string;
}

const fixturePath = join(scratch, 'probe-doc.md');

try {
  if (probePhase === 'send') {
    // 1. Publish fixture with 1-day TTL, empty title, and cover: false
    await writeFile(fixturePath, '# Live Probe v1\n');
    const pubRes = await callMcp('relic_publish', {
      path: fixturePath,
      title: '',
      cover: false,
      ttl_days: 1,
    });
    const relicId = String(pubRes['relic_id']);
    assert.ok(relicId, 'publish returned no relic_id');

    // 2. Share to probe recipients
    const shareRes = await callMcp('relic_share', {
      relic_id: relicId,
      emails: probeRecipients,
    });
    const registered = (shareRes['registered'] as string[]) ?? [];
    assert.equal(
      registered.length,
      probeRecipients.length,
      `expected ${probeRecipients.length} registered shares, got ${registered.length}`
    );

    // 3. Republish v2. Untitled again: a republish without a title takes the
    //    new filename, and the notice would then carry it.
    await writeFile(fixturePath, '# Live Probe v2\n');
    const repubRes = await callMcp('relic_republish', {
      relic_id: relicId,
      path: fixturePath,
      title: '',
      cover: false,
    });
    assert.equal(Number(repubRes['version']), 2);

    console.log(`PROBE relic_id=${relicId} version=2`);
  } else if (probePhase === 'after-stop') {
    const relicId = await probeRelicId();

    await writeFile(fixturePath, '# Live Probe v3\n');
    const repubRes = await callMcp('relic_republish', {
      relic_id: relicId,
      path: fixturePath,
      title: '',
      cover: false,
    });
    assert.equal(Number(repubRes['version']), 3);

    console.log(`PROBE relic_id=${relicId} version=3`);
  } else if (probePhase === 'quiet') {
    const relicId = await probeRelicId();

    await writeFile(fixturePath, '# Live Probe v4\n');
    const repubRes = await callMcp('relic_republish', {
      relic_id: relicId,
      path: fixturePath,
      title: '',
      cover: false,
      notify: false,
    });
    assert.equal(Number(repubRes['version']), 4);

    console.log(`PROBE relic_id=${relicId} version=4`);

    if (operatorToken) {
      const delUrl = `${serviceOrigin}/api/relics/${relicId}?reason=operator_error`;
      const delRes = await fetch(delUrl, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      assert.equal(
        delRes.status,
        200,
        `DELETE failed with status ${delRes.status}`
      );
      const delData = (await delRes.json()) as Record<string, unknown>;
      console.log(
        `DELETED shares_deleted=${delData['shares_deleted']} opt_outs_deleted=${delData['opt_outs_deleted']}`
      );
    } else {
      console.log(
        'CLEANUP_NOTE: Operator token not provided; relik and share records will expire automatically.'
      );
    }
  }
} finally {
  if (!process.env['RELIC_PUBLISH_STATE']) {
    await rm(scratch, { recursive: true, force: true });
  }
}
