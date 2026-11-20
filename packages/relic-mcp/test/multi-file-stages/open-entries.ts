import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { indexZip } from '@relic/format';
import { connectPipe } from '../../src/cover/cdp.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';
import { checkTree } from './open-tree.ts';

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
      if (new URL(request.url).pathname === '/viewer.css') {
        return new Response(
          Bun.file(
            new URL('../../../relic-viewer/src/styles.css', import.meta.url)
          ),
          { headers: { 'content-type': 'text/css' } }
        );
      }
      return new URL(request.url).pathname === '/fixture.js'
        ? new Response(script, {
            headers: { 'content-type': 'text/javascript' },
          })
        : new Response(
            '<head><link rel="stylesheet" href="/viewer.css"></head><body><script type="module" src="/fixture.js"></script></body>',
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
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: profile,
    });
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
        `(async()=>{document.querySelector('.folder-row[title="data/a.json"]').click();for(let i=0;i<500;i++){if(document.querySelector('.stage-code .structured-tree'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
      ),
      true
    );
    await evaluate(
      `(document.querySelector('.action-download').click(), true)`
    );
    let downloaded: Buffer | undefined;
    for (let i = 0; i < 200 && !downloaded; i++) {
      try {
        downloaded = await readFile(join(profile, 'a.json'));
      } catch {
        await Bun.sleep(20);
      }
    }
    assert.equal(downloaded?.toString(), '{"hello":"world"}');
    await evaluate(
      `([...document.querySelectorAll('.folder-heading button')].find(x=>x.textContent==='Download all').click(), true)`
    );
    let archive: Buffer | undefined;
    for (let i = 0; i < 200 && !archive; i++) {
      try {
        archive = await readFile(join(profile, 'example.zip'));
      } catch {
        await Bun.sleep(20);
      }
    }
    assert.ok(archive);
    const zip = await indexZip(archive, {
      maxArchiveBytes: archive.length,
      maxEntries: 3,
      maxEntryBytes: 1000,
      maxTotalBytes: 3000,
    });
    assert.equal(zip.ok, true);
    if (!zip.ok) throw new Error(zip.reason);
    const expected = new Map([
      ['README.md', Buffer.from('# Folder readme')],
      ['data/a.json', Buffer.from('{"hello":"world"}')],
      [
        'img/p.png',
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          'base64'
        ),
      ],
    ]);
    assert.equal(zip.index.entries.size, expected.size);
    for (const [name, content] of expected) {
      const result = await zip.index.read(name);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error(result.reason);
      assert.deepEqual(Buffer.from(result.bytes), content);
    }
    assert.equal(
      await evaluate(
        `(async()=>{document.querySelector('.folder-row[title="img/p.png"]').click();for(let i=0;i<500;i++){if(document.querySelector('.stage-image img.relic-image'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
      ),
      true
    );
    await checkTree(
      evaluate,
      async (width, height) => {
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 1, mobile: false },
          session
        );
      },
      async (label, dark) => {
        await cdp.send(
          'Emulation.setEmulatedMedia',
          {
            features: [
              { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
            ],
          },
          session
        );
        const shot = await cdp.send(
          'Page.captureScreenshot',
          { format: 'png' },
          session
        );
        await writeFile(
          `/tmp/relic-v1c-${label}.png`,
          Buffer.from(String(shot.data), 'base64')
        );
      }
    );
    const measurements = await evaluate('window.measureZipFixtures()');
    assert.ok(Array.isArray(measurements) && measurements.length === 2);
    console.log(
      `MULTI_FILE_TIMING runtime=chromium zip=${JSON.stringify(measurements)}`
    );
    await cdp.send('Page.reload', {}, session);
    assert.equal(
      await evaluate(
        `(async()=>{for(let i=0;i<500;i++){if(document.querySelector('.folder-breadcrumb')?.textContent.includes('README.md'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
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
