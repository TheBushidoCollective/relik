import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { sandboxPolicy } from '../../../relic-server/src/sandbox-policy.ts';
import { connectPipe } from '../../src/cover/cdp.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';

export async function runFolderStage(
  stage: 'markdown-links' | 'html-entry'
): Promise<void> {
  const chrome = findHeadlessShell();
  if (!chrome) {
    if (chromeRequired) throw new Error('Headless Chrome is required');
    console.log(`MULTI_FILE_STAGE ${stage} SKIP (headless shell missing)`);
    return;
  }
  const built = await Bun.build({
    entrypoints: [
      new URL('./markdown-links-browser.ts', import.meta.url).pathname,
    ],
    target: 'browser',
    splitting: false,
  });
  if (!built.success || !built.outputs[0])
    throw new Error('browser fixture bundle failed');
  const script = await built.outputs[0].text();
  const sandbox = await Bun.file(
    new URL('../../../relic-viewer/dist/sandbox.html', import.meta.url)
  ).text();
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const origin = `http://127.0.0.1:${server.port}`;
      if (path === '/sandbox.html')
        return new Response(sandbox, {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': sandboxPolicy(origin, sandbox),
          },
        });
      if (path === '/viewer.css')
        return new Response(
          Bun.file(
            new URL('../../../relic-viewer/src/styles.css', import.meta.url)
          ),
          { headers: { 'content-type': 'text/css' } }
        );
      if (path === '/fixture.js')
        return new Response(script, {
          headers: { 'content-type': 'text/javascript' },
        });
      return new Response(
        '<head><link rel="stylesheet" href="/viewer.css"></head><body><script type="module" src="/fixture.js"></script></body>',
        {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': [
              "default-src 'none'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data:",
              "media-src 'self' blob: data:",
              "manifest-src 'self'",
              `connect-src 'self' ${origin} wss://127.0.0.1:${server.port} https:`,
              `frame-src ${origin}/sandbox.html`,
              "base-uri 'none'",
              "form-action 'none'",
            ].join('; '),
          },
        }
      );
    },
  });
  const profile = await mkdtemp(join(tmpdir(), 'relic-v2-'));
  const child = spawn(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  try {
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
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      session
    );
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${server.port}/` },
      session
    );
    const evaluate = async (expression: string): Promise<unknown> => {
      const response = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        session
      );
      if (response.exceptionDetails)
        throw new Error(JSON.stringify(response.exceptionDetails));
      const result = response.result;
      if (!result || typeof result !== 'object' || !('value' in result))
        throw new Error('no CDP value');
      return result.value;
    };
    const wait = (condition: string) =>
      evaluate(
        `new Promise((resolve,reject)=>{const end=Date.now()+30000;const check=()=>{if(${condition})resolve(true);else if(Date.now()>end)reject(Error('condition failed: '+${JSON.stringify(condition)}));else setTimeout(check,20)};check()})`
      );
    await wait("document.body?.dataset.fixtureReady==='yes'");
    if (stage === 'markdown-links') {
      await wait(
        "document.querySelector('img[alt=Picture]')?.naturalWidth>0 && document.querySelector('img[alt=\\\"Root picture\\\"]')?.naturalWidth>0"
      );
      await wait(
        `[...document.querySelectorAll('.md-entry-link')].some(a=>a.textContent==='Decoded budget') && !document.querySelector('img[alt="Decoded budget"]')`
      );
      const imageUrl = await evaluate(
        `document.querySelector('img[alt=Picture]').src`
      );
      assert.equal(
        await evaluate(
          `(()=>{const p=document.querySelector('.prose'); const links=[...p.querySelectorAll('a')]; return ['Outside','Missing','Protocol','Case','Backslash'].every(t=>!links.some(a=>a.textContent===t)) && links.some(a=>a.textContent==='External'&&a.target==='_blank') && links.some(a=>a.textContent==='Vector') && !p.querySelector('img[alt=Vector]') && links.some(a=>a.textContent==='Budget exceeded') && !p.querySelector('img[alt="Budget exceeded"]')})()`
        ),
        true
      );
      assert.equal(
        await evaluate(
          `(document.querySelector('a.md-entry-link').click(),true)`
        ),
        true
      );
      await wait(
        "document.querySelector('.folder-breadcrumb')?.textContent.includes('docs') && document.querySelector('.prose')?.textContent.includes('Target document')"
      );
      assert.equal(
        await evaluate(`document.querySelector('.stage-wrap').scrollTop > 0`),
        true,
        'fragment scrolls to the target heading'
      );
      assert.equal(
        await evaluate(
          `!location.href.includes('docs') && !location.href.includes('section')`
        ),
        true
      );
      assert.equal(
        await evaluate(
          `(()=>{const {promise,resolve}=Promise.withResolvers();const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src=${JSON.stringify(imageUrl)};return promise})()`
        ),
        true
      );
      await evaluate('(history.back(),true)');
      await wait(
        "document.querySelector('.prose')?.textContent.includes('Folder readme')"
      );
      await evaluate(
        `([...document.querySelectorAll('.md-entry-link')].find(a=>a.textContent==='Root').click(),true)`
      );
      await wait(
        "document.querySelector('.prose')?.textContent.includes('Target document')"
      );
      await evaluate('(history.back(),true)');
      await wait(
        "document.querySelector('.prose')?.textContent.includes('Folder readme')"
      );
      for (const [width, height, label] of [
        [1280, 900, 'desktop'],
        [390, 844, 'mobile'],
      ] as const) {
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 1, mobile: false },
          session
        );
        const shot = await cdp.send(
          'Page.captureScreenshot',
          { format: 'png' },
          session
        );
        await writeFile(
          `/tmp/relic-v2-${label}.png`,
          Buffer.from(String(shot.data), 'base64')
        );
      }
    } else {
      await evaluate(
        `(document.querySelector('.folder-row[title="index.html"]').click(),true)`
      );
      await wait(
        "document.querySelector('.stage-sandboxed-html iframe')!==null"
      );
      assert.equal(
        await evaluate(
          `document.body.innerText.includes('Files this page links to are not loaded here.')`
        ),
        true
      );
      const tree = await cdp.send('Page.getFrameTree', {}, session);
      const children = (
        tree.frameTree as { childFrames?: { frame: { id: string } }[] }
      ).childFrames;
      assert.equal(children?.length, 1);
      const world = await cdp.send(
        'Page.createIsolatedWorld',
        { frameId: children?.[0]?.frame.id, worldName: 'v2-proof' },
        session
      );
      const contextId = world.executionContextId;
      let rendered = false;
      for (let attempt = 0; attempt < 200 && !rendered; attempt++) {
        const result = await cdp.send(
          'Runtime.evaluate',
          {
            contextId,
            expression: "document.body.textContent.includes('HTML entry')",
            returnByValue: true,
          },
          session
        );
        rendered = Boolean((result.result as { value?: boolean })?.value);
        if (!rendered) await Bun.sleep(20);
      }
      assert.equal(rendered, true, 'HTML entry renders in the sandbox');
      assert.equal(
        requests.filter(
          (path) => path.endsWith('/style.css') || path.endsWith('/a.png')
        ).length,
        0
      );
    }
    console.log(`MULTI_FILE_STAGE ${stage} OK`);
  } finally {
    cdp.dispose();
    child.kill();
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}
