import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  decryptComment,
  deriveCommentKey,
  encryptComment,
  parseFragment,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';
import { connectPipe } from '../../src/cover/cdp.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, type PublishDeps } from '../../src/publish.ts';

const chrome = findHeadlessShell();
if (!chrome) {
  if (chromeRequired) throw new Error('Headless Chrome is required');
  console.log('MULTI_FILE_STAGE comments-viewer SKIP (headless shell missing)');
} else {
  const temp = await mkdtemp(join(tmpdir(), 'relic-comments-viewer-'));
  const prior = process.env.RELIC_PUBLISH_STATE;
  process.env.RELIC_PUBLISH_STATE = join(temp, 'state.json');
  const store = new MemoryStore();
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      handler ? handler(request) : new Response('not ready', { status: 503 }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const storage = new MemoryStorage(`${origin}/__storage`);
  const app = createApp({
    config: {
      serviceOrigin: origin,
      usercontentOrigin: `http://localhost:${server.port}`,
    },
    store,
    storage,
    assets: diskAssets(
      new URL('../../../relic-viewer/dist', import.meta.url).pathname
    ),
  });
  handler = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__storage/o/')) {
      const bytes = await storage.read(path.slice('/__storage/o/'.length));
      return bytes
        ? new Response(bytes as unknown as BodyInit)
        : new Response(null, { status: 404 });
    }
    return app.fetch(request);
  };
  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    clientName: 'comments-viewer-path',
    files: nodeFiles,
    fetch: globalThis.fetch,
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test',
    }),
    upload: async (url, _headers, bytes) => {
      storage.put(
        new URL(url).pathname.replace(/^\/__storage\/upload\//, ''),
        bytes
      );
      return { status: 200 };
    },
  };
  const child = spawn(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--remote-debugging-pipe',
      `--user-data-dir=${join(temp, 'profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  try {
    const root = join(temp, 'files');
    await mkdir(root);
    await writeFile(
      join(root, 'a.md'),
      '# A\n\nAlpha paragraph to annotate.\n'
    );
    await writeFile(join(root, 'b.md'), '# B\n\nBeta paragraph to annotate.\n');
    const published = await publish(
      { path: root, cover: false, decisions: true },
      deps
    );
    const key = await deriveCommentKey(
      parseFragment(new URL(published.url).hash).key
    );
    await store.putComment({
      id: crypto.randomUUID(),
      relicId: published.relic_id,
      author: 'publisher',
      createdAt: Date.now(),
      version: 1,
      ciphertext: await encryptComment(key, {
        body: 'Whole note',
        display_name: null,
      }),
    });
    const token = crypto.randomUUID();
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    );
    const tokenHash = Array.from(hash, (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    const now = Date.now();
    await store.putSession({
      tokenHash,
      email: 'reviewer@example.test',
      createdAt: now,
      expiresAt: now + 3600000,
    });
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const session = attached.sessionId as string;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send(
      'Network.setCookie',
      {
        name: 'relic_session',
        value: token,
        url: origin,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      session
    );
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      session
    );
    await cdp.send('Page.navigate', { url: published.url }, session);
    async function evaluate(expression: string): Promise<unknown> {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        session
      );
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      const value = result.result;
      if (!value || typeof value !== 'object' || !('value' in value))
        throw new Error('CDP returned no value');
      return value.value;
    }
    async function until(expression: string): Promise<void> {
      const result = await evaluate(
        `(async()=>{for(let i=0;i<750;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,20))}return false})()`
      );
      assert.equal(result, true, expression);
    }
    await until(
      "document.querySelector('.folder-row[title=\"a.md\"]') && document.querySelector('.compose-textarea') && document.querySelector('.doc p')"
    );
    await evaluate(
      `(()=>{const p=document.querySelector('.doc p');const range=document.createRange();range.setStart(p.firstChild,0);range.setEnd(p.firstChild,5);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));return true})()`
    );
    await until("document.querySelector('.popover-comment')");
    await evaluate(
      "(document.querySelector('.popover-comment').click(), true)"
    );
    await until("document.querySelector('textarea.popover-field')");
    await evaluate(
      `(()=>{const f=document.querySelector('textarea.popover-field');f.value='A note';f.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.popover-card.popover-composer .popover-action.is-primary').click();return true})()`
    );
    await until(
      "document.querySelector('.folder-row[title=\"a.md\"]')?.textContent.includes('1 comment')"
    );
    await evaluate(
      '(document.querySelector(\'.folder-row[title="b.md"]\').click(), true)'
    );
    await until(
      'document.querySelector(\'.folder-row[title="b.md"][aria-current="true"]\') && document.querySelector(\'.compose-textarea\')'
    );
    await evaluate(
      `(()=>{const f=document.querySelector('.compose-textarea');f.value='B note';f.dispatchEvent(new Event('input',{bubbles:true}));f.closest('form').requestSubmit();return true})()`
    );
    await until(
      "document.querySelector('.folder-row[title=\"b.md\"]')?.textContent.includes('1 comment') && document.querySelector('.thread-list')?.textContent.includes('B note')"
    );
    let text = await evaluate(
      "document.querySelector('.thread-list').textContent"
    );
    assert.ok(
      typeof text === 'string' &&
        text.includes('Whole relic') &&
        text.includes('Whole note') &&
        text.includes('B note') &&
        !text.includes('A note')
    );
    await evaluate(
      '(document.querySelector(\'.folder-row[title="a.md"]\').click(), true)'
    );
    await until(
      "document.querySelector('.folder-row[title=\"a.md\"][aria-current=\"true\"]') && document.querySelector('.thread-list')?.textContent.includes('A note')"
    );
    text = await evaluate("document.querySelector('.thread-list').textContent");
    assert.ok(
      typeof text === 'string' &&
        text.includes('Whole note') &&
        text.includes('A note') &&
        !text.includes('B note')
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.folder-row[title=\"b.md\"]').textContent.includes('1 comment')"
      ),
      true
    );
    const comments = await store.listComments(published.relic_id);
    const plaintext = await Promise.all(
      comments.map((row) => decryptComment(key, row.ciphertext))
    );
    const a = plaintext.find((row) => row.body === 'A note');
    const b = plaintext.find((row) => row.body === 'B note');
    assert.equal(a?.entry, 'a.md');
    assert.equal(b?.entry, 'b.md');
    assert.ok(a?.anchor && !('entry' in a.anchor));
    assert.equal(
      plaintext.find((row) => row.body === 'Whole note')?.entry,
      undefined
    );
    await until("document.querySelector('[data-decision-open]')");
    await evaluate(
      "(document.querySelector('[data-decision-open]').click(), true)"
    );
    await until(
      "document.querySelector('.decision-body')?.textContent.includes('A decision here applies to every file in version 1.')"
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('[data-decision-verdict]').length"
      ),
      2
    );
    console.log('MULTI_FILE_STAGE comments-viewer OK');
  } finally {
    cdp.dispose();
    child.kill();
    server.stop(true);
    if (prior === undefined) delete process.env.RELIC_PUBLISH_STATE;
    else process.env.RELIC_PUBLISH_STATE = prior;
    await rm(temp, { recursive: true, force: true });
  }
}
