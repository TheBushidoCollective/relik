import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { connectPipe } from '../../src/cover/cdp.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';

const chrome = findHeadlessShell();
if (!chrome) {
  if (chromeRequired) throw new Error('Headless Chrome is required');
  console.log('MULTI_FILE_STAGE open-entries SKIP (headless shell missing)');
} else {
  const built = await Bun.build({
    entrypoints: [
      new URL('./open-entries-browser.ts', import.meta.url).pathname,
    ],
    target: 'browser',
    splitting: false,
  });
  if (!built.success || !built.outputs[0])
    throw new Error('browser fixture bundle failed');
  const script = await built.outputs[0].text();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === '/fixture.js'
        ? new Response(script, {
            headers: { 'content-type': 'text/javascript' },
          })
        : new Response(
            '<body><script type="module" src="/fixture.js"></script></body>',
            {
              headers: {
                'content-type': 'text/html',
                'content-security-policy':
                  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
              },
            }
          );
    },
  });
  const profile = await mkdtemp(join(tmpdir(), 'relic-open-entries-'));
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
      'Page.navigate',
      { url: `http://127.0.0.1:${server.port}/` },
      session
    );
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
    assert.equal(
      await evaluate(
        `new Promise((resolve,reject)=>{const end=Date.now()+15000; const check=()=>{if(document.body?.dataset.fixtureReady==='yes')resolve(true);else if(Date.now()>end)reject(Error('fixture did not open'));else setTimeout(check,20)};check()})`
      ),
      true
    );
    assert.equal(
      await evaluate(`document.body.innerText.includes('Folder readme')`),
      true
    );
    assert.equal(
      await evaluate(
        `(async()=>{[...document.querySelectorAll('nav button')].find(x=>x.textContent==='data/a.json').click();for(let i=0;i<500;i++){if(document.querySelector('.stage-code .structured-tree'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
      ),
      true
    );
    assert.equal(
      await evaluate(
        `(async()=>{[...document.querySelectorAll('nav button')].find(x=>x.textContent==='img/p.png').click();for(let i=0;i<500;i++){if(document.querySelector('.stage-image img.relic-image'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
      ),
      true
    );
    console.log('MULTI_FILE_STAGE open-entries OK');
  } finally {
    cdp.dispose();
    child.kill();
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}
