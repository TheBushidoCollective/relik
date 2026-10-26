/**
 * Shared proof steps for Relic email code sign-in (spec §2 and §6 slice P).
 *
 * Used by:
 *   - packages/relic-mcp/test/email-code-sign-in-path.ts (loopback proof)
 *   - packages/relic-mcp/test/email-code-sign-in-live-probe.ts (live service probe)
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelicStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import { callMcp, launchProofBrowser } from './decision-proof-steps.ts';

export interface CapturedSignInMail {
  readonly to: string;
  readonly link: string;
  readonly code: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailCodeSignInOptions {
  readonly serviceOrigin: string;
  readonly scratchDir: string;
  readonly statePath: string;
  readonly mcpCommand: readonly string[];
  readonly chromePath: string;
  readonly readerEmail: string;
  readonly awaitSignInMail: (email: string) => Promise<CapturedSignInMail>;
  readonly isLive?: boolean;
  readonly store?: RelicStore;
  readonly promptForCodeAndLink?: (
    email: string
  ) => Promise<{ code: string; link: string }>;
}

export interface EmailCodeSignInResult {
  readonly relicId: string;
  readonly readerEmail: string;
}

export async function runEmailCodeSignInSequence(
  options: EmailCodeSignInOptions
): Promise<EmailCodeSignInResult> {
  const {
    serviceOrigin,
    scratchDir,
    statePath,
    mcpCommand,
    chromePath,
    readerEmail,
    awaitSignInMail,
    isLive = false,
    store: _store,
    promptForCodeAndLink,
  } = options;

  // Step 1: Publish document (title: '', cover: false, ttl_days: 1)
  const docPath = join(scratchDir, 'proof-email-code-sign-in.txt');
  await writeFile(
    docPath,
    'Relic Email Code Sign-In Proof Document\nA reader signs in with a 6-digit code typed in-place.\n'
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

  console.log(`EMAIL_CODE_STEP_1_PUBLISH_OK relic_id=${relicId}`);

  // Launch headless browser
  const chromeDiscovery = await discoverChrome(chromePath);
  assert.equal(
    chromeDiscovery.kind,
    'found',
    `Chrome not found: ${chromeDiscovery.kind === 'not_found' ? chromeDiscovery.detail : chromeDiscovery.kind}`
  );
  if (chromeDiscovery.kind !== 'found') throw new Error('Chrome unreachable');

  const browser = await launchProofBrowser(chromeDiscovery.path, serviceOrigin);

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
    // Open comment thread sidebar if not open
    await browser.evaluate<void>(`
      (() => {
        const thread = document.querySelector('#comment-thread');
        if (thread && !thread.classList.contains('is-open')) {
          const btn = document.querySelector('button.action-comments') || document.querySelector('button.thread-tab');
          if (btn instanceof HTMLElement) btn.click();
        }
      })()
    `);

    // Wait for compose form
    await browser.waitForSelector('#comment-thread form.compose');

    // Type reader address into #comment-thread form.compose and submit
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

    // Obtain code and link
    let mailedCode: string;
    let mailedLink: string;

    if (isLive && promptForCodeAndLink) {
      const prompted = await promptForCodeAndLink(readerEmail);
      mailedCode = prompted.code;
      mailedLink = prompted.link;
    } else {
      const mail = await awaitSignInMail(readerEmail);
      assert.ok(mail, 'mail did not arrive');
      const subjectMatch = mail.subject.match(
        /^(\d{6}) is your Relic sign-in code$/
      );
      assert.ok(
        subjectMatch,
        `mail subject does not match expected format: "${mail.subject}"`
      );
      mailedCode = subjectMatch[1] ?? '';
      assert.equal(
        mailedCode,
        mail.code,
        'extracted code does not match mail code'
      );
      assert.ok(
        mail.link?.includes('/api/auth/callback?token='),
        'link missing from mail'
      );
      mailedLink = mail.link;

      console.log(
        'EMAIL_CODE_STEP_2_CODE_MAILED subject_has_code=true link_present=true'
      );
    }

    // Wait for data-sign-in-code-input to appear
    await browser.waitForSelector('[data-sign-in-code-input]');
    // Ensure sidebar is open so the input has layout and focus
    await browser.evaluate<void>(`
      (() => {
        const thread = document.querySelector('#comment-thread');
        if (thread && !thread.classList.contains('is-open')) {
          const btn = document.querySelector('button.action-comments') || document.querySelector('button.thread-tab');
          if (btn instanceof HTMLElement) btn.click();
        }
      })()
    `);
    // Set up measurements for navigations=0
    // 1. window.__relicCodeProofMarker survives
    await browser.evaluate<void>(`
      (() => {
        window.__relicCodeProofMarker = 'relic-code-marker-ok';
      })()
    `);

    // 2. performance.timeOrigin unchanged
    const timeOriginBefore = await browser.evaluate<number>(
      'performance.timeOrigin'
    );

    // 3. zero main-frame Page.frameNavigated events
    let mainFrameNavigatedCount = 0;
    const stopNavListener = browser.cdp.onEvent((event) => {
      if (
        event.method === 'Page.frameNavigated' &&
        event.sessionId === browser.sessionId
      ) {
        const params = event.params as
          | { frame?: { parentId?: string } }
          | undefined;
        // Main frame has no parentId
        if (!params?.frame?.parentId) {
          mainFrameNavigatedCount++;
        }
      }
    });
    // Focus input and type the extracted code with CDP Input.insertText
    await browser.evaluate<void>(`
      (() => {
        const el = document.querySelector('[data-sign-in-code-input]');
        if (el instanceof HTMLElement) {
          el.scrollIntoView();
          el.focus();
        }
      })()
    `);
    await browser.clickSelector('[data-sign-in-code-input]');
    await browser.cdp.send(
      'Input.insertText',
      { text: mailedCode },
      browser.sessionId
    );
    await browser.waitForSelector('[data-passkey-offer]');

    // Stop navigation listener
    stopNavListener();

    // Verify navigations=0 measurements
    const marker = await browser.evaluate<string | undefined>(
      'window.__relicCodeProofMarker'
    );
    assert.equal(
      marker,
      'relic-code-marker-ok',
      'window.__relicCodeProofMarker did not survive code sign-in'
    );

    const timeOriginAfter = await browser.evaluate<number>(
      'performance.timeOrigin'
    );
    assert.equal(
      timeOriginAfter,
      timeOriginBefore,
      'performance.timeOrigin changed across code sign-in'
    );

    assert.equal(
      mainFrameNavigatedCount,
      0,
      `main-frame Page.frameNavigated events fired: ${mainFrameNavigatedCount}`
    );

    const offerShown = await browser.evaluate<boolean>(`
      Boolean(document.querySelector('[data-passkey-offer]'))
    `);
    assert.equal(
      offerShown,
      true,
      'data-passkey-offer not shown after code sign-in'
    );

    console.log(
      'EMAIL_CODE_STEP_3_SIGNED_IN_IN_PLACE navigations=0 offer=shown'
    );

    // Step 4: Post comment through textarea.compose-textarea and verify author=<address>
    const commentBodyText = 'Verified reader email-code sign-in comment proof.';
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

    // Wait for comment to land and verify via MCP
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

    console.log(`EMAIL_CODE_STEP_4_COMMENT_OK author=${commentAuthor}`);

    // Step 5: Follow the magic link from that email and verify it answers 401
    const linkRes = await fetch(mailedLink, {
      method: 'GET',
      redirect: 'manual',
    });
    assert.equal(
      linkRes.status,
      401,
      `expected callback to answer 401 when followed after code was spent, got ${linkRes.status}`
    );

    console.log('EMAIL_CODE_STEP_5_LINK_SPENT callback=401');

    return { relicId, readerEmail };
  } finally {
    await browser.close();
  }
}
