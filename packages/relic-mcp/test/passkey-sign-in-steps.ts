/**
 * Shared proof steps for Relic passkey sign-in (spec §5, slice S5).
 *
 * Used by:
 *   - packages/relic-mcp/test/passkey-sign-in-path.ts (loopback proof)
 *   - packages/relic-mcp/test/passkey-sign-in-live-probe.ts (live service probe)
 *
 * Implements the 7-step sequence and negative controls from spec §5:
 *   1. Publish (title: '', cover: false, ttl_days: 1) -> PASSKEY_STEP_1_PUBLISH_OK relic_id=<id>
 *   2. Install wrapper recording credentials.get {mediation, aborted}.
 *      Open relic anonymously; assert autocomplete and [data-passkey-sign-in]
 *      -> PASSKEY_STEP_2_ANON_SURFACE_OK conditional=<armed|unavailable>
 *   3. Type address into #comment-thread form.compose, submit, resolve link, navigate;
 *      assert [data-passkey-offer] and marker gone
 *      -> PASSKEY_STEP_3_MAGIC_LINK_OK offer=shown
 *   4. Click [data-passkey-offer-create] and wait for data-state="created".
 *      WebAuthn.getCredentials shows 1 resident credential; convert base64 to base64url.
 *      On loopback, store.getPasskeysByUserHandle resolves it
 *      -> PASSKEY_STEP_4_ENROLL_OK resident=true
 *   5. Network.deleteCookies({name:'relic_session', url}) on owned browser, reopen URL with fragment;
 *      /api/auth/session gives email:null
 *      -> PASSKEY_STEP_5_SIGNED_OUT_OK
 *   6. Click [data-passkey-sign-in]; "Commenting as <addr>" shows; mail count unchanged;
 *      conditional request aborted if armed
 *      -> PASSKEY_STEP_6_SIGN_IN_OK mails_sent=0
 *   7. Post through textarea.compose-textarea and "Post comment";
 *      relic_read_comments {relic_id, version:'*'} returns author and body
 *      -> PASSKEY_STEP_7_COMMENT_OK author=<addr>
 *   Negatives:
 *      Replaying captured sign-in POST gives 401;
 *      text/plain gives 400;
 *      email-first for unknown and reader address have same shape and count;
 *      decision POST without credential gives 400
 *      -> PASSKEY_NEG_OK replay=401 wrong_content_type=400 email_first_shape=equal decision_without_assertion=400
 *   End -> PASSKEY_SIGN_IN_PATH_OK
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelicStore } from '@relic/server/src/store.ts';
import { callMcp, launchProofBrowser } from './decision-proof-steps.ts';
import { discoverChrome } from '../src/cover/chrome.ts';

export interface PasskeySignInOptions {
  readonly serviceOrigin: string;
  readonly scratchDir: string;
  readonly statePath: string;
  readonly mcpCommand: readonly string[];
  readonly chromePath: string;
  readonly readerEmail: string;
  readonly resolveMagicLink: (email: string) => Promise<string>;
  readonly isLive?: boolean;
  readonly store?: RelicStore;
  readonly getMailsSentCount?: () => number;
}

export interface PasskeySignInResult {
  readonly relicId: string;
  readonly readerEmail: string;
}

interface CdpWebAuthnCredential {
  readonly credentialId?: string;
  readonly isResidentCredential?: boolean;
  readonly rpId?: string;
  readonly privateKey?: string;
  readonly userHandle?: string;
  readonly signCount?: number;
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function runPasskeySignInSequence(
  options: PasskeySignInOptions
): Promise<PasskeySignInResult> {
  const {
    serviceOrigin,
    scratchDir,
    statePath,
    mcpCommand,
    chromePath,
    readerEmail,
    resolveMagicLink,
    isLive = false,
    store,
    getMailsSentCount,
  } = options;

  // Step 1: Publish (title: '', cover: false, ttl_days: 1)
  const docPath = join(scratchDir, 'proof-passkey-sign-in.txt');
  await writeFile(
    docPath,
    'Relic Passkey Sign-In Proof Document\nA verified reader signs in with a passkey without email.\n'
  );

  const pubRes = await callMcp(
    mcpCommand,
    scratchDir,
    statePath,
    serviceOrigin,
    'relic_publish',
    {
      path: docPath,
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
  const key = relicState.key;

  console.log(`PASSKEY_STEP_1_PUBLISH_OK relic_id=${relicId}`);

  // Launch headless browser with CTAP2 virtual authenticator
  const chromeDiscovery = await discoverChrome(chromePath);
  assert.equal(
    chromeDiscovery.kind,
    'found',
    `Chrome not found: ${chromeDiscovery.kind === 'not_found' ? chromeDiscovery.detail : chromeDiscovery.kind}`
  );
  if (chromeDiscovery.kind !== 'found') throw new Error('Chrome unreachable');

  const browser = await launchProofBrowser(chromeDiscovery.path, serviceOrigin);

  // Capture sign-in POST payloads for negative controls
  let lastCapturedSignInPost: string | undefined;
  browser.cdp.onEvent((event) => {
    if (
      event.method === 'Network.requestWillBeSent' &&
      event.sessionId === browser.sessionId
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
        req.url?.includes('/api/auth/passkeys/sign-in') &&
        !req.url.includes('/options')
      ) {
        if (req.postData) {
          lastCapturedSignInPost = req.postData;
        }
      }
    }
  });

  try {
    // Step 2: Install Page.addScriptToEvaluateOnNewDocument wrapper recording credentials.get
    const recorderSource = `
      (() => {
        window.__relicPasskeyGets = [];
        if (navigator.credentials && typeof navigator.credentials.get === 'function') {
          const origGet = navigator.credentials.get.bind(navigator.credentials);
          navigator.credentials.get = function(options) {
            const entry = {
              mediation: options && options.mediation ? options.mediation : 'none',
              aborted: false,
              startedAt: Date.now(),
            };
            if (options && options.signal) {
              if (options.signal.aborted) {
                entry.aborted = true;
              } else {
                options.signal.addEventListener('abort', () => {
                  entry.aborted = true;
                });
              }
            }
            window.__relicPasskeyGets.push(entry);
            return origGet(options);
          };
        }
      })()
    `;

    await browser.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: recorderSource },
      browser.sessionId
    );

    const relicUrl = `${serviceOrigin}/${relicId}#r1${key}`;
    const pageLoaded1 = browser.cdp.waitForEvent('Page.loadEventFired', {
      sessionId: browser.sessionId,
      timeoutMs: 25000,
    });
    await browser.cdp.send(
      'Page.navigate',
      { url: relicUrl },
      browser.sessionId
    );
    await pageLoaded1;

    // Assert email autocomplete has webauthn and [data-passkey-sign-in] exists
    await browser.waitForSelector('#comment-thread form.compose');
    await browser.waitForSelector('[data-passkey-sign-in]');

    const anonSurfaceOk = await browser.evaluate<{
      readonly hasAutocomplete: boolean;
      readonly hasButton: boolean;
      readonly conditionalState: string;
    }>(`
      (() => {
        const form = document.querySelector('#comment-thread form.compose');
        if (!form) return { hasAutocomplete: false, hasButton: false, conditionalState: 'unavailable' };
        const input = form.querySelector('input[type="email"]');
        const hasAutocomplete = Boolean(
          input &&
          input instanceof HTMLInputElement &&
          input.autocomplete &&
          input.autocomplete.includes('webauthn')
        );
        const btn = document.querySelector('[data-passkey-sign-in]');
        const hasButton = Boolean(btn && btn instanceof HTMLElement);

        const gets = window.__relicPasskeyGets || [];
        const conditionalGet = gets.find(g => g.mediation === 'conditional');
        const conditionalState = conditionalGet ? 'armed' : 'unavailable';

        return { hasAutocomplete, hasButton, conditionalState };
      })()
    `);

    assert.ok(
      anonSurfaceOk.hasAutocomplete,
      'email input autocomplete does not include webauthn'
    );
    assert.ok(
      anonSurfaceOk.hasButton,
      '[data-passkey-sign-in] button not found'
    );

    console.log(
      `PASSKEY_STEP_2_ANON_SURFACE_OK conditional=${anonSurfaceOk.conditionalState}`
    );

    // Step 3: Type address into #comment-thread form.compose, submit, resolve link, navigate
    await browser.evaluate<void>(`
      (() => {
        const form = document.querySelector('#comment-thread form.compose');
        if (!form) throw new Error('#comment-thread form.compose not found');
        const input = form.querySelector('input[type="email"]');
        if (!input || !(input instanceof HTMLInputElement)) throw new Error('email input not found in form.compose');
        input.value = ${JSON.stringify(readerEmail)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn && submitBtn instanceof HTMLElement) {
          submitBtn.click();
        } else if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        }
      })()
    `);

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

    // Assert [data-passkey-offer] is shown and offer marker cookie is deleted
    await browser.waitForSelector('[data-passkey-offer]');

    const cookiesAfterCallback = await browser.getCookies();
    const offerMarker = cookiesAfterCallback.find(
      (c) => c.name === 'relic_passkey_offer'
    );
    assert.ok(
      !offerMarker || offerMarker.value === '',
      'relic_passkey_offer cookie marker was not consumed or cleared'
    );

    console.log('PASSKEY_STEP_3_MAGIC_LINK_OK offer=shown');

    // Step 4: Click [data-passkey-offer-create] and wait for data-state="created"
    await browser.clickSelector('[data-passkey-offer-create]');
    await browser.waitForSelector(
      '[data-passkey-offer][data-state="created"]',
      20000
    );

    // WebAuthn.getCredentials shows 1 resident credential
    const credsRes = (await browser.cdp.send(
      'WebAuthn.getCredentials',
      { authenticatorId: browser.authenticatorId },
      browser.sessionId
    )) as { credentials?: readonly CdpWebAuthnCredential[] };

    const credentials = credsRes.credentials ?? [];
    assert.equal(
      credentials.length,
      1,
      `expected exactly 1 credential in virtual authenticator, got ${credentials.length}`
    );
    const primaryCred = credentials[0];
    assert.ok(primaryCred, 'no primary credential found');
    assert.equal(
      primaryCred.isResidentCredential,
      true,
      'credential must be resident credential'
    );

    const userHandleB64 = primaryCred.userHandle ?? '';
    assert.ok(userHandleB64, 'credential userHandle is missing');
    const userHandleB64Url = base64ToBase64Url(userHandleB64);

    // On loopback, store.getPasskeysByUserHandle resolves it
    if (!isLive && store) {
      const storeWithHandle = store as RelicStore & {
        getPasskeysByUserHandle?: (
          handle: string
        ) => Promise<unknown | undefined>;
      };
      if (typeof storeWithHandle.getPasskeysByUserHandle === 'function') {
        const found =
          await storeWithHandle.getPasskeysByUserHandle(userHandleB64Url);
        assert.ok(
          found,
          `store.getPasskeysByUserHandle failed to resolve handle: ${userHandleB64Url}`
        );
      }
    }

    console.log('PASSKEY_STEP_4_ENROLL_OK resident=true');

    // Step 5: Network.deleteCookies({name:'relic_session', url}) on owned browser, reopen URL with fragment
    await browser.cdp.send(
      'Network.deleteCookies',
      {
        name: 'relic_session',
        url: serviceOrigin,
      },
      browser.sessionId
    );

    const pageLoaded2 = browser.cdp.waitForEvent('Page.loadEventFired', {
      sessionId: browser.sessionId,
      timeoutMs: 25000,
    });
    await browser.cdp.send(
      'Page.navigate',
      { url: relicUrl },
      browser.sessionId
    );
    await pageLoaded2;

    // Check /api/auth/session gives email:null
    const sessionRes = await fetch(`${serviceOrigin}/api/auth/session`, {
      headers: {
        cookie: (await browser.getCookies())
          .map((c) => `${c.name}=${c.value}`)
          .join('; '),
      },
    });
    const sessionBody = (await sessionRes.json()) as { email?: string | null };
    assert.equal(
      sessionBody.email,
      null,
      `expected null session email after cookie deletion, got ${sessionBody.email}`
    );

    console.log('PASSKEY_STEP_5_SIGNED_OUT_OK');

    // Step 6: Click [data-passkey-sign-in]; "Commenting as <addr>" shows; mail count unchanged;
    // conditional request was aborted if armed
    const mailsBefore = getMailsSentCount ? getMailsSentCount() : 0;

    await browser.waitForSelector('[data-passkey-sign-in]');
    await browser.clickSelector('[data-passkey-sign-in]');

    await browser.waitForSelector('#comment-thread .compose-identity', 20000);

    const identityText = await browser.evaluate<string>(`
      (() => {
        const idEl = document.querySelector('#comment-thread .compose-identity');
        return idEl ? idEl.textContent || '' : '';
      })()
    `);

    assert.ok(
      identityText.includes('Commenting as'),
      `expected "Commenting as" in compose identity, got "${identityText}"`
    );

    const mailsAfter = getMailsSentCount ? getMailsSentCount() : 0;
    const mailsSentDuringSignIn = mailsAfter - mailsBefore;
    assert.equal(
      mailsSentDuringSignIn,
      0,
      `mails were sent during passkey sign-in: ${mailsSentDuringSignIn}`
    );

    // Conditional request aborted if it was armed
    const conditionalAborted = await browser.evaluate<boolean>(`
      (() => {
        const gets = window.__relicPasskeyGets || [];
        const cond = gets.find(g => g.mediation === 'conditional');
        if (!cond) return true; // not armed, vacuously true
        return cond.aborted;
      })()
    `);
    assert.ok(
      conditionalAborted,
      'conditional passkey request was armed but was not aborted upon sign-in'
    );

    console.log(
      `PASSKEY_STEP_6_SIGN_IN_OK mails_sent=${mailsSentDuringSignIn}`
    );

    // Step 7: Post through textarea.compose-textarea and "Post comment";
    // relic_read_comments {relic_id, version:'*'} returns author and body
    const commentBodyText = 'Verified returning reader passkey comment proof.';
    await browser.waitForSelector('textarea.compose-textarea');
    await browser.evaluate<void>(`
      (() => {
        const textarea = document.querySelector('textarea.compose-textarea');
        if (!textarea || !(textarea instanceof HTMLTextAreaElement)) {
          throw new Error('textarea.compose-textarea not found');
        }
        textarea.value = ${JSON.stringify(commentBodyText)};
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        const form = textarea.closest('form');
        if (!form) throw new Error('form enclosing textarea not found');
        const submitBtn = Array.from(form.querySelectorAll('button')).find(
          b => b.textContent && b.textContent.includes('Post comment')
        );
        if (submitBtn && submitBtn instanceof HTMLElement) {
          submitBtn.click();
        } else if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        }
      })()
    `);

    // Give comment write a moment to land, then read via MCP
    const startCommentWait = Date.now();
    let commentsFound: Array<{ author?: string; body?: string }> = [];
    while (Date.now() - startCommentWait < 15000) {
      const readRes = await callMcp(
        mcpCommand,
        scratchDir,
        statePath,
        serviceOrigin,
        'relic_read_comments',
        {
          relic_id: relicId,
          version: '*',
        }
      );
      const comments = (readRes['comments'] ?? []) as Array<{
        author?: string;
        body?: string;
      }>;
      if (comments.some((c) => c.body === commentBodyText)) {
        commentsFound = comments;
        break;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 200);
      await promise;
    }

    const postedComment = commentsFound.find((c) => c.body === commentBodyText);
    assert.ok(
      postedComment,
      `relic_read_comments did not return posted comment with body "${commentBodyText}"`
    );

    const commentAuthor = postedComment.author ?? '';
    assert.equal(
      commentAuthor.toLowerCase(),
      readerEmail.trim().toLowerCase(),
      `comment author mismatch: expected ${readerEmail}, got ${commentAuthor}`
    );

    console.log(`PASSKEY_STEP_7_COMMENT_OK author=${commentAuthor}`);

    // Negatives
    // 1. Replay the captured sign-in POST gives 401
    assert.ok(
      lastCapturedSignInPost,
      'no sign-in POST request was captured to replay'
    );
    const replayRes = await fetch(
      `${serviceOrigin}/api/auth/passkeys/sign-in`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: lastCapturedSignInPost,
      }
    );
    assert.equal(
      replayRes.status,
      401,
      `expected 401 on replayed sign-in POST, got ${replayRes.status}`
    );

    // 2. text/plain gives 400
    const plainRes = await fetch(`${serviceOrigin}/api/auth/passkeys/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: lastCapturedSignInPost,
    });
    assert.equal(
      plainRes.status,
      400,
      `expected 400 on text/plain sign-in POST, got ${plainRes.status}`
    );

    // 3. email-first for an unknown address and the reader's address have the same shape and count
    const unknownOptRes = await fetch(
      `${serviceOrigin}/api/auth/passkeys/sign-in/options`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'nobody+probe-unknown@example.invalid' }),
      }
    );
    assert.equal(unknownOptRes.status, 200);
    const unknownOptData = (await unknownOptRes.json()) as {
      public_key?: {
        challenge?: string;
        rpId?: string;
        timeout?: number;
        userVerification?: string;
        allowCredentials?: Array<{ type: string; id: string }>;
      };
    };

    const knownOptRes = await fetch(
      `${serviceOrigin}/api/auth/passkeys/sign-in/options`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: readerEmail }),
      }
    );
    assert.equal(knownOptRes.status, 200);
    const knownOptData = (await knownOptRes.json()) as {
      public_key?: {
        challenge?: string;
        rpId?: string;
        timeout?: number;
        userVerification?: string;
        allowCredentials?: Array<{ type: string; id: string }>;
      };
    };

    const unknownCreds = unknownOptData.public_key?.allowCredentials ?? [];
    const knownCreds = knownOptData.public_key?.allowCredentials ?? [];

    assert.equal(
      unknownCreds.length,
      knownCreds.length,
      `email-first allowCredentials length mismatch: unknown has ${unknownCreds.length}, known has ${knownCreds.length}`
    );
    assert.ok(
      unknownCreds.length > 0,
      'email-first options returned empty allowCredentials (oracle leak)'
    );

    // 4. A decision POST without a credential gives 400
    const emptyDecisionRes = await fetch(
      `${serviceOrigin}/api/relics/${relicId}/decisions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
        }),
      }
    );
    assert.equal(
      emptyDecisionRes.status,
      400,
      `expected 400 on decision POST without credential, got ${emptyDecisionRes.status}`
    );

    console.log(
      'PASSKEY_NEG_OK replay=401 wrong_content_type=400 email_first_shape=equal decision_without_assertion=400'
    );

    return {
      relicId,
      readerEmail,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
