/**
 * Shared proof steps for Relic passkey decisions (spec §7).
 *
 * Used by both:
 *   - packages/relic-mcp/test/decision-path.ts (loopback proof)
 *   - packages/relic-mcp/test/decision-live-probe.ts (live service probe)
 *
 * Implements the 10-step sequence:
 *   1. Publish v1, republish v2, republish v3. Record v3 version_digest.
 *   2. Open /<id>#r1<key> in headless browser over CDP pipe.
 *   3. Request sign-in magic link and follow it in the same context.
 *   4. Open decision panel, choose Approve, set up passkey (TOFU), confirm.
 *   5. Check (a): relic_read_decisions returns approve, matching digest -> DECISION_A_OK.
 *   6. Check (b): direct POST with publish_token gives 403 decision_requires_reader -> DECISION_B_OK.
 *   7. Check (d): reject v3, read returns 2 records with latest reject -> DECISION_D_OK.
 *   8. Check (c): republish v4; v4 is empty, v3 still has 2 records -> DECISION_C_OK.
 *   9. Check (e): post GREENLIGHT reader and publisher comments; wildcard read is still 2 -> DECISION_E_OK.
 *  10. Negative controls:
 *        - v2 digest for v3 gives 409
 *        - second authenticator with isUserVerified:false gives 403 user_verified
 *        - replaying captured assertion gives 403 challenge
 *      -> DECISION_NEG_OK.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  decodeKey,
  deriveCommentKey,
  deriveShareProof,
  encodeKey,
  encryptComment,
  versionDigest,
} from '@relic/format';
import type {
  AuthenticationResponseJSON,
  DecisionRecord,
  RegistrationResponseJSON,
} from '@relic/format';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

export interface DecisionProofOptions {
  readonly serviceOrigin: string;
  readonly scratchDir: string;
  readonly statePath: string;
  readonly mcpCommand: readonly string[];
  readonly chromePath: string;
  readonly readerEmail: string;
  readonly resolveMagicLink: (email: string) => Promise<string>;
  readonly isLive?: boolean;
}

export interface DecisionProofResult {
  readonly relicId: string;
  readonly v3Digest: string;
  readonly readerEmail: string;
}

export interface RunningProofBrowser {
  readonly child: ChildProcess;
  readonly cdp: CdpConnection;
  readonly sessionId: string;
  readonly profile: string;
  readonly authenticatorId: string;
  evaluate<T>(expression: string): Promise<T>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
  clickSelector(selector: string, timeoutMs?: number): Promise<void>;
  typeAndSubmitSignIn(email: string, timeoutMs?: number): Promise<void>;
  getCookies(): Promise<Array<{ name: string; value: string }>>;
  getLastCapturedDecisionPost(): string | undefined;
  close(): Promise<void>;
}

/**
 * Execute a relic-mcp tool call over Node stdio.
 */
export async function callMcp(
  cmd: readonly string[],
  scratchDir: string,
  statePath: string,
  serviceOrigin: string,
  toolName: string,
  args: Record<string, unknown>,
  chromePath = 'none'
): Promise<Record<string, unknown>> {
  const child = Bun.spawn([...cmd], {
    cwd: scratchDir,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: serviceOrigin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CHROME_PATH: chromePath,
      RELIC_CLIENT_NAME: 'relic-mcp/decision-proof',
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
  assert.ok(
    lines.length > 0,
    `no JSON-RPC response from relic-mcp for ${toolName}`
  );
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
 * Launch an isolated headless Chrome instance over a CDP pipe,
 * attest its launch parameters, and attach a virtual CTAP2 WebAuthn authenticator.
 */
export async function launchProofBrowser(
  chromeExecutable: string,
  serviceOrigin: string
): Promise<RunningProofBrowser> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-decision-chrome-'));
  const shared = chromeArgs(chromeExecutable, profile);

  const urlObj = new URL(serviceOrigin);
  const host = urlObj.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1';

  let customArgs: string[];
  if (isLoopback) {
    const port = urlObj.port || '80';
    customArgs = [
      ...shared.map((arg) => {
        if (arg === '--proxy-bypass-list=<-loopback>') {
          return `--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;${host}:${port};127.0.0.1:${port};localhost:${port}`;
        }
        if (arg === '--host-resolver-rules=MAP * ~NOTFOUND') {
          return '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';
        }
        return arg;
      }),
      '--autoplay-policy=no-user-gesture-required',
    ];
  } else {
    customArgs = [
      ...shared.map((arg) => {
        if (arg === '--proxy-bypass-list=<-loopback>') {
          return `--proxy-bypass-list=<-loopback>;${host};*.${host}`;
        }
        if (arg === '--host-resolver-rules=MAP * ~NOTFOUND') {
          return `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}, EXCLUDE *.${host}`;
        }
        if (arg.startsWith('--proxy-server=')) {
          return '--no-proxy-server';
        }
        return arg;
      }),
      '--autoplay-policy=no-user-gesture-required',
    ];
  }

  const launch = createBrowserHeadlessLaunch(customArgs, profile);
  let child: ChildProcess;
  try {
    child = spawn(chromeExecutable, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  assert.ok(
    toChrome instanceof Writable,
    'Chrome fd 3 did not expose a writable debug pipe'
  );
  assert.ok(
    fromChrome instanceof Readable,
    'Chrome fd 4 did not expose a readable debug pipe'
  );

  const cdp = connectPipe(toChrome, fromChrome);
  await attestBrowserHeadless(cdp, launch);

  const created = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('WebAuthn.enable', {}, sessionId);

  const auth = (await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    sessionId
  )) as { authenticatorId: string };

  let lastCapturedDecisionPost: string | undefined;

  cdp.onEvent((event) => {
    if (
      event.method === 'Network.requestWillBeSent' &&
      event.sessionId === sessionId
    ) {
      const params = event.params as {
        request?: {
          url?: string;
          method?: string;
          postData?: string;
        };
      };
      const req = params.request;
      if (
        req?.method === 'POST' &&
        req.url?.includes('/decisions') &&
        !req.url.includes('/options') &&
        !req.url.includes('/list')
      ) {
        if (req.postData) {
          lastCapturedDecisionPost = req.postData;
        }
      }
    }
  });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const res = (await cdp.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 20000,
      },
      sessionId
    )) as {
      result?: { value?: T };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };

    const ex = res.exceptionDetails;
    assert.ok(
      !ex,
      `page evaluate failed: ${ex?.text ?? ex?.exception?.description ?? JSON.stringify(res)}`
    );
    return res.result?.value as T;
  };

  const waitForSelector = async (
    selector: string,
    timeoutMs = 15000
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`
      ).catch(() => false);
      if (found) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
    }
    throw new Error(`Timed out waiting for selector: ${selector}`);
  };

  const clickSelector = async (
    selector: string,
    timeoutMs = 15000
  ): Promise<void> => {
    await waitForSelector(selector, timeoutMs);
    const clicked = await evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (el instanceof HTMLElement) {
        el.click();
        return true;
      }
      return false;
    })()`);
    assert.ok(clicked, `failed to click selector: ${selector}`);
  };

  const typeAndSubmitSignIn = async (
    email: string,
    timeoutMs = 15000
  ): Promise<void> => {
    await waitForSelector('[data-decision-signin]', timeoutMs);
    await evaluate<void>(`(() => {
      const container = document.querySelector('[data-decision-signin]');
      if (!container) throw new Error('data-decision-signin container not found');
      const input = container.querySelector('input[type="email"]') as HTMLInputElement | null;
      if (!input) throw new Error('email input not found in data-decision-signin');
      input.value = ${JSON.stringify(email)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const form = container.querySelector('form');
      if (form) {
        const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (submitBtn) {
          submitBtn.click();
        } else {
          form.requestSubmit();
        }
      }
    })()`);
  };

  const getCookies = async (): Promise<
    Array<{ name: string; value: string }>
  > => {
    const res = (await cdp.send(
      'Network.getCookies',
      { urls: [serviceOrigin] },
      sessionId
    )) as { cookies?: Array<{ name: string; value: string }> };
    return res.cookies ?? [];
  };

  const close = async (): Promise<void> => {
    await cleanupOwnedBrowserStartup({
      child,
      connection: cdp,
      forgetChild: undefined,
      profile,
      removeProfile: undefined,
    });
  };

  return {
    child,
    cdp,
    sessionId,
    profile,
    authenticatorId: auth.authenticatorId,
    evaluate,
    waitForSelector,
    clickSelector,
    typeAndSubmitSignIn,
    getCookies,
    getLastCapturedDecisionPost: () => lastCapturedDecisionPost,
    close,
  };
}

/**
 * Execute the 10-step decisions proof sequence.
 */
export async function runDecisionProofSequence(
  options: DecisionProofOptions
): Promise<DecisionProofResult> {
  const {
    serviceOrigin,
    scratchDir,
    statePath,
    mcpCommand,
    chromePath,
    readerEmail,
    resolveMagicLink,
  } = options;

  // Step 1: Publish v1, republish v2, republish v3. Record v3 version_digest.
  const v1Path = join(scratchDir, 'proof-v1.txt');
  const v2Path = join(scratchDir, 'proof-v2.txt');
  const v3Path = join(scratchDir, 'proof-v3.txt');
  const v4Path = join(scratchDir, 'proof-v4.txt');

  await writeFile(v1Path, 'Relic Decision Proof Version 1\n');
  await writeFile(v2Path, 'Relic Decision Proof Version 2\n');
  await writeFile(v3Path, 'Relic Decision Proof Version 3\n');
  await writeFile(v4Path, 'Relic Decision Proof Version 4\n');

  const pubRes = await callMcp(
    mcpCommand,
    scratchDir,
    statePath,
    serviceOrigin,
    'relic_publish',
    {
      path: v1Path,
      title: '',
      cover: false,
      ttl_days: 1,
    }
  );

  const relicId = pubRes['relic_id'] as string;
  assert.ok(relicId, 'publish did not return relic_id');

  const stateRaw = JSON.parse(await readFile(statePath, 'utf8')) as {
    relics?: Record<string, { key?: string; publish_token?: string }>;
  };
  const relicState = stateRaw.relics?.[relicId];
  assert.ok(relicState?.key, 'state file did not contain relic key');
  assert.ok(
    relicState.publish_token,
    'state file did not contain publish_token'
  );
  const key = relicState.key;
  const publishToken = relicState.publish_token;

  const rawKey = decodeKey(key);
  const shareProof = encodeKey(await deriveShareProof(rawKey));

  const repub2 = await callMcp(
    mcpCommand,
    scratchDir,
    statePath,
    serviceOrigin,
    'relic_republish',
    {
      relic_id: relicId,
      path: v2Path,
      title: '',
      cover: false,
    }
  );
  const v2Digest =
    (repub2['version_digest'] as string | undefined) ??
    (await versionDigest(
      new TextEncoder().encode('Relic Decision Proof Version 2\n')
    ));

  const repub3 = await callMcp(
    mcpCommand,
    scratchDir,
    statePath,
    serviceOrigin,
    'relic_republish',
    {
      relic_id: relicId,
      path: v3Path,
      title: '',
      cover: false,
    }
  );
  const v3Digest =
    (repub3['version_digest'] as string | undefined) ??
    (await versionDigest(
      new TextEncoder().encode('Relic Decision Proof Version 3\n')
    ));
  assert.ok(v3Digest, 'version_digest missing for v3');
  console.log(`STEP_1_PUBLISH_OK relic_id=${relicId} v3_digest=${v3Digest}`);

  // Step 2: Open /<id>#r1<key> in headless browser over CDP pipe.
  const chromeDiscovery = await discoverChrome(chromePath);
  assert.equal(
    chromeDiscovery.kind,
    'found',
    `Chrome not found: ${chromeDiscovery.kind === 'not_found' ? chromeDiscovery.detail : chromeDiscovery.kind}`
  );
  if (chromeDiscovery.kind !== 'found') throw new Error('Chrome unreachable');

  const browser = await launchProofBrowser(chromeDiscovery.path, serviceOrigin);

  let readerCookie = '';

  try {
    const relicUrl = `${serviceOrigin}/${relicId}#r1${key}`;
    const pageLoaded = browser.cdp.waitForEvent('Page.loadEventFired', {
      sessionId: browser.sessionId,
      timeoutMs: 25000,
    });
    await browser.cdp.send(
      'Page.navigate',
      { url: relicUrl },
      browser.sessionId
    );
    await pageLoaded;
    console.log('STEP_2_BROWSER_OPEN_OK');

    // Step 3: Request sign-in magic link and follow it in the same context.
    // Open the decisions panel to access sign-in host:
    await browser.clickSelector('button.action-decisions[data-decision-open]');
    await browser.typeAndSubmitSignIn(readerEmail);

    const magicLinkUrl = await resolveMagicLink(readerEmail);
    assert.ok(magicLinkUrl, 'resolveMagicLink returned empty link');

    const authLoaded = browser.cdp.waitForEvent('Page.loadEventFired', {
      sessionId: browser.sessionId,
      timeoutMs: 25000,
    });
    await browser.cdp.send(
      'Page.navigate',
      { url: magicLinkUrl },
      browser.sessionId
    );
    await authLoaded;

    // Ensure session cookie is captured
    const cookies = await browser.getCookies();
    const sessionCookie = cookies.find((c) => c.name === 'relic_session');
    if (sessionCookie) {
      readerCookie = `relic_session=${sessionCookie.value}`;
    }

    // Step 4: Open decision panel, choose Approve, set up passkey (TOFU), confirm.
    await browser.clickSelector('button.action-decisions[data-decision-open]');
    await browser.waitForSelector(
      'dialog.decision-panel[data-decision-version]'
    );
    await browser.clickSelector('[data-decision-verdict="approve"]');

    // First time for this address requires passkey creation
    await browser.waitForSelector('[data-passkey-create]');
    await browser.clickSelector('[data-passkey-create]');

    // Confirm decision with passkey assertion
    await browser.waitForSelector('[data-decision-confirm]');
    await browser.clickSelector('[data-decision-confirm]');

    await browser.waitForSelector(
      '[data-decision-outcome][data-state="recorded"]'
    );

    // Refresh cookies in case session was updated
    if (!readerCookie) {
      const refreshedCookies = await browser.getCookies();
      const s = refreshedCookies.find((c) => c.name === 'relic_session');
      if (s) readerCookie = `relic_session=${s.value}`;
    }

    // Step 5: Check (a) - relic_read_decisions for v3 returns approve and matching digest
    const resA = await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_read_decisions',
      {
        relic_id: relicId,
        version: 3,
      }
    );
    assert.equal(resA['relic_id'], relicId);
    assert.equal(resA['current_version'], 3);
    const decisionsA = (resA['decisions'] ?? []) as readonly DecisionRecord[];
    assert.equal(decisionsA.length, 1);
    const d3 = decisionsA[0];
    assert.ok(d3, 'expected decision record on v3');
    assert.equal(d3.version, 3);
    assert.equal(d3.verdict, 'approve');
    assert.equal(d3.author, readerEmail.trim().toLowerCase());
    assert.equal(d3.version_digest, v3Digest);
    console.log(`DECISION_A_OK version=3 verdict=approve author=${d3.author}`);

    // Step 6: Check (b) - direct POST with publish_token gives 403 decision_requires_reader
    const bRes = await fetch(
      `${serviceOrigin}/api/relics/${relicId}/decisions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: 3,
          verdict: 'approve',
          publish_token: publishToken,
        }),
      }
    );
    assert.equal(bRes.status, 403);
    const bBody = (await bRes.json()) as { code?: string };
    assert.equal(bBody.code, 'decision_requires_reader');
    console.log('DECISION_B_OK code=decision_requires_reader status=403');

    // Step 7: Check (d) - reject v3, read returns 2 records with latest reject
    await browser.clickSelector('[data-decision-verdict="reject"]');
    await browser.waitForSelector('[data-decision-confirm]');
    await browser.clickSelector('[data-decision-confirm]');
    await browser.waitForSelector(
      '[data-decision-outcome][data-state="recorded"]'
    );

    const resD = await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_read_decisions',
      {
        relic_id: relicId,
        version: 3,
      }
    );
    const decisionsD = (resD['decisions'] ?? []) as readonly DecisionRecord[];
    assert.equal(decisionsD.length, 2);
    const dFirst = decisionsD[0];
    const dSecond = decisionsD[1];
    assert.ok(dFirst && dSecond, 'expected two decision records on v3');
    assert.equal(dFirst.verdict, 'approve');
    assert.equal(dSecond.verdict, 'reject');
    assert.equal(dSecond.author, readerEmail.trim().toLowerCase());
    console.log('DECISION_D_OK count=2 latest=reject');

    // Step 8: Check (c) - republish v4; v4 is empty, v3 still has 2 records
    await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_republish',
      {
        relic_id: relicId,
        path: v4Path,
        title: '',
        cover: false,
      }
    );

    const resCv4 = await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_read_decisions',
      {
        relic_id: relicId,
        version: 4,
      }
    );
    const decisionsCv4 = (resCv4['decisions'] ??
      []) as readonly DecisionRecord[];
    assert.equal(decisionsCv4.length, 0);

    const resCv3 = await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_read_decisions',
      {
        relic_id: relicId,
        version: 3,
      }
    );
    const decisionsCv3 = (resCv3['decisions'] ??
      []) as readonly DecisionRecord[];
    assert.equal(decisionsCv3.length, 2);
    console.log('DECISION_C_OK v4_count=0 v3_count=2');

    // Step 9: Check (e) - post reader comment and publisher comment both "GREENLIGHT"; decisions unchanged
    const commentKey = await deriveCommentKey(rawKey);
    const readerCiphertext = await encryptComment(commentKey, {
      body: 'GREENLIGHT',
      display_name: null,
      anchor: null,
    });

    const readerCommentRes = await fetch(
      `${serviceOrigin}/api/relics/${relicId}/comments`,
      {
        method: 'POST',
        headers: {
          cookie: readerCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ciphertext: readerCiphertext }),
      }
    );
    assert.equal(readerCommentRes.status, 201);

    await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_comment',
      {
        relic_id: relicId,
        body: 'GREENLIGHT',
      }
    );

    const resE = await callMcp(
      mcpCommand,
      scratchDir,
      statePath,
      serviceOrigin,
      'relic_read_decisions',
      {
        relic_id: relicId,
        version: '*',
      }
    );
    const decisionsE = (resE['decisions'] ?? []) as readonly DecisionRecord[];
    assert.equal(decisionsE.length, 2);
    console.log('DECISION_E_OK total_decisions=2');

    // Step 10: Negative controls
    // Negative 1: posting v2 digest for v3 gives 409 decision_digest_mismatch
    const optRes = await fetch(
      `${serviceOrigin}/api/relics/${relicId}/decisions/options`,
      {
        method: 'POST',
        headers: {
          cookie: readerCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: 3,
          verdict: 'approve',
          share_proof: shareProof,
        }),
      }
    );
    assert.equal(optRes.status, 200);
    const optData = (await optRes.json()) as {
      public_key: { challenge: string; rpId: string };
    };

    const assertionForMismatch =
      await browser.evaluate<AuthenticationResponseJSON>(`
      (() => {
        const pk = ${JSON.stringify(optData.public_key)};
        function b64urlToBuf(s) {
          const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
          const bin = atob(b64);
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          return buf.buffer;
        }
        function bufToB64url(buf) {
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        }
        return navigator.credentials.get({
          publicKey: {
            ...pk,
            challenge: b64urlToBuf(pk.challenge)
          }
        }).then(cred => ({
          id: cred.id,
          rawId: cred.id,
          type: cred.type,
          response: {
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            authenticatorData: bufToB64url(cred.response.authenticatorData),
            signature: bufToB64url(cred.response.signature),
            userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null
          }
        }));
      })()
    `);

    const mismatchRes = await fetch(
      `${serviceOrigin}/api/relics/${relicId}/decisions`,
      {
        method: 'POST',
        headers: {
          cookie: readerCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: 3,
          verdict: 'approve',
          share_proof: shareProof,
          version_digest: v2Digest, // Mismatched digest
          credential: assertionForMismatch,
        }),
      }
    );
    assert.equal(mismatchRes.status, 409);
    const mismatchBody = (await mismatchRes.json()) as { code?: string };
    assert.equal(mismatchBody.code, 'decision_digest_mismatch');

    // Negative 2: second authenticator with isUserVerified:false gives 403 user_verified
    const auth2 = (await browser.cdp.send(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: false,
          isUserVerified: false,
          automaticPresenceSimulation: true,
        },
      },
      browser.sessionId
    )) as { authenticatorId: string };

    const regOptRes = await fetch(
      `${serviceOrigin}/api/auth/passkeys/options`,
      {
        method: 'POST',
        headers: {
          cookie: readerCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );
    assert.equal(regOptRes.status, 200);
    const regOptData = (await regOptRes.json()) as {
      mode: string;
      public_key: { challenge: string; rp?: { id: string }; rpId?: string };
    };

    const unverifiedRegistration =
      await browser.evaluate<RegistrationResponseJSON>(`
      (() => {
        function b64urlToBuf(s) {
          const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
          const bin = atob(b64);
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          return buf.buffer;
        }
        function bufToB64url(buf) {
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        }
        const challenge = b64urlToBuf(${JSON.stringify(regOptData.public_key.challenge)});
        const rpId = ${JSON.stringify(new URL(serviceOrigin).hostname)};
        return navigator.credentials.create({
          publicKey: {
            challenge,
            rp: { id: rpId, name: 'Relic' },
            user: { id: new Uint8Array([1, 2, 3]), name: ${JSON.stringify(readerEmail)}, displayName: ${JSON.stringify(readerEmail)} },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'discouraged' }
          }
        }).then(cred => ({
          id: cred.id,
          rawId: cred.id,
          type: cred.type,
          response: {
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            attestationObject: bufToB64url(cred.response.attestationObject)
          }
        }));
      })()
    `);

    const unverifiedRes = await fetch(`${serviceOrigin}/api/auth/passkeys`, {
      method: 'POST',
      headers: {
        cookie: readerCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ credential: unverifiedRegistration }),
    });
    assert.equal(unverifiedRes.status, 403);
    const unverifiedBody = (await unverifiedRes.json()) as {
      code?: string;
      passkey_check?: string;
    };
    assert.equal(unverifiedBody.code, 'passkey_verification_failed');
    assert.equal(unverifiedBody.passkey_check, 'user_verified');

    await browser.cdp.send(
      'WebAuthn.removeVirtualAuthenticator',
      { authenticatorId: auth2.authenticatorId },
      browser.sessionId
    );

    // Negative 3: replaying the captured assertion gives 403 challenge
    const capturedPost = browser.getLastCapturedDecisionPost();
    assert.ok(capturedPost, 'no decision POST request was captured to replay');

    const replayRes = await fetch(
      `${serviceOrigin}/api/relics/${relicId}/decisions`,
      {
        method: 'POST',
        headers: {
          cookie: readerCookie,
          'content-type': 'application/json',
        },
        body: capturedPost,
      }
    );
    assert.equal(replayRes.status, 403);
    const replayBody = (await replayRes.json()) as {
      code?: string;
      passkey_check?: string;
    };
    assert.equal(replayBody.code, 'passkey_verification_failed');
    assert.equal(replayBody.passkey_check, 'challenge');

    console.log(
      'DECISION_NEG_OK digest_mismatch=409 user_verified=403 challenge_replay=403'
    );

    return {
      relicId,
      v3Digest,
      readerEmail,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
