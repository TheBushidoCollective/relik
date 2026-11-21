import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { planStoredZip } from '@relic/format';
import { crc32 } from '@relic/format/zip-index';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const shell = process.env['RELIC_CHROME_PATH'];
if (!shell)
  throw new Error('RELIC_CHROME_PATH must name the owned headless shell');
const scratch = await mkdtemp(join(tmpdir(), 'relic-xlsx-path-'));
const store = new MemoryStore();
let handler: ((request: Request) => Promise<Response>) | undefined;
const server = Bun.serve({
  port: 0,
  fetch: (request) =>
    handler ? handler(request) : new Response('Starting', { status: 503 }),
});
const origin = `http://127.0.0.1:${server.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const now = Date.now();
const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  now: () => now,
  operatorTokens: new Map([['operator-token', 'test-operator-secret']]),
  assets: diskAssets(join(import.meta.dir, '../../relic-viewer/dist')),
  mailer: { send: async () => {}, sendMail: async () => {} },
});
handler = async (request) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/__storage/upload/') && request.method === 'PUT') {
    storage.put(
      path.slice('/__storage/upload/'.length),
      new Uint8Array(await request.arrayBuffer())
    );
    return new Response(null, { status: 200 });
  }
  if (path.startsWith('/__storage/o/') && request.method === 'GET') {
    const bytes = await storage.read(path.slice('/__storage/o/'.length));
    return bytes
      ? new Response(Buffer.from(bytes), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      : new Response('missing', { status: 404 });
  }
  return app.fetch(request);
};
function workbook(): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="First" r:id="r1"/><sheet name="Second" r:id="r2"/><sheet name="Bad&#x202e;name" r:id="r3"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Type="urn:office/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="urn:office/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="r3" Type="urn:office/worksheet" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>First value</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Second value</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet3.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Restricted value</t></is></c></row></sheetData></worksheet>',
  };
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, value]) => ({
    name,
    bytes: encoder.encode(value),
  }));
  const plan = planStoredZip(
    entries.map((e) => ({
      name: e.name,
      size: e.bytes.length,
      crc32: crc32(e.bytes),
    }))
  );
  const out = new Uint8Array(plan.totalBytes);
  let at = 0;
  entries.forEach((entry, i) => {
    const header = plan.localHeaders[i]!;
    out.set(header, at);
    at += header.length;
    out.set(entry.bytes, at);
    at += entry.bytes.length;
  });
  out.set(plan.centralDirectory, at);
  at += plan.centralDirectory.length;
  out.set(plan.end, at);
  return out;
}
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(
    ['node', join(import.meta.dir, '../dist/relic-mcp.js')],
    {
      cwd: scratch,
      env: {
        ...process.env,
        RELIC_SERVICE_ORIGIN: origin,
        RELIC_PUBLISH_STATE: join(scratch, 'state.json'),
        RELIC_CHROME_PATH: 'none',
        RELIC_OTIO_CHROME_PATH: 'none',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, stderr);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!).result as Record<
    string,
    unknown
  >;
  assert.notEqual(result['isError'], true, JSON.stringify(result));
  return result;
}
const children = new Set<ReturnType<typeof spawn>>();
try {
  const token = 'xlsx-reader-token';
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  const tokenHash = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await store.putSession({
    tokenHash,
    email: 'reader@example.test',
    createdAt: now,
    expiresAt: now + 3600000,
  });
  const path = join(scratch, 'sheets.xlsx');
  await writeFile(path, workbook());
  const published = await callTool('relic_publish', {
    path,
    title: 'Sheets',
    cover: false,
  });
  const content = published['structuredContent'] as Record<string, unknown>;
  const url = String(content['url']);
  assert.ok(url.includes('#'));
  for (const width of [1440, 390]) {
    const profile = await mkdtemp(join(tmpdir(), 'relic-xlsx-chrome-'));
    const shared = chromeArgs(shell, profile).map((arg) =>
      arg === '--proxy-bypass-list=<-loopback>'
        ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${server.port}`
        : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
    );
    const launch = createBrowserHeadlessLaunch(shared, profile);
    const child = spawn(shell, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    const cdp = connectPipe(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable
    );
    try {
      await attestBrowserHeadless(cdp, launch);
      const created = (await cdp.send('Target.createTarget', {
        url: 'about:blank',
      })) as { targetId: string };
      const attached = (await cdp.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      })) as { sessionId: string };
      const sid = attached.sessionId;
      const send = (method: string, params?: Record<string, unknown>) =>
        cdp.send(method, params, sid);
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Network.enable');
      await send('Network.setCookie', {
        name: 'relic_session',
        value: token,
        url: origin,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      });
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width === 390,
      });
      const loaded = cdp.waitForEvent('Page.loadEventFired', {
        sessionId: sid,
        timeoutMs: 20000,
      });
      await send('Page.navigate', { url });
      await loaded;
      const evaluate = async <T>(expression: string): Promise<T> => {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result['exceptionDetails'])
          throw new Error(JSON.stringify(result['exceptionDetails']));
        return (result['result'] as { value: T }).value;
      };
      const wait = async (expression: string) => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (await evaluate<boolean>(`Boolean(${expression})`)) return;
          await Bun.sleep(50);
        }
        throw new Error(`timeout: ${expression}`);
      };
      const click = async (selector: string) => {
        await wait(`document.querySelector(${JSON.stringify(selector)})`);
        const p = await evaluate<{ x: number; y: number }>(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`
        );
        for (const [type, buttons] of [
          ['mouseMoved', 0],
          ['mousePressed', 1],
          ['mouseReleased', 0],
        ] as const)
          await send('Input.dispatchMouseEvent', {
            type,
            x: p.x,
            y: p.y,
            button: type === 'mouseMoved' ? 'none' : 'left',
            buttons,
            clickCount: type === 'mouseMoved' ? 0 : 1,
          });
      };
      await wait(
        `document.querySelectorAll('.spreadsheet-tabs button').length === 3 && document.querySelector('.dt-cell[data-r="1"][data-c="0"]')`
      );
      assert.equal(
        await evaluate(
          `document.querySelector('.dt-cell[data-r="1"][data-c="0"]')?.textContent`
        ),
        'First value'
      );
      await click('.spreadsheet-tabs button:nth-child(2)');
      await wait(
        `document.querySelector('.dt-cell[data-r="1"][data-c="0"]')?.textContent === 'Second value'`
      );
      if (width === 1440) {
        await click('.dt-cell[data-r="1"][data-c="0"]');
        await click('.popover-comment');
        await click('.popover-composer .popover-field');
        await send('Input.insertText', { text: 'Second sheet note' });
        await click('.popover-composer .popover-tools .is-primary');
        await wait(
          `document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked')`
        );
      } else {
        await wait(
          `document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked')`
        );
      }
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await click('.spreadsheet-tabs button:nth-child(1)');
      await wait(
        `document.querySelector('.dt-cell[data-r="1"][data-c="0"]')?.textContent === 'First value'`
      );
      assert.equal(
        await evaluate(
          `Boolean(document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked'))`
        ),
        false
      );
      if (width === 1440) {
        await click('.thread-tab');
        await click('.thread-list [data-comment-id]');
        await wait(
          `document.querySelector('.dt-cell[data-r="1"][data-c="0"]')?.textContent === 'Second value'`
        );
        await wait(
          `document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked')`
        );
      }
      await click('.spreadsheet-tabs button:nth-child(2)');
      await wait(
        `document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked')`
      );
      const reloaded = cdp.waitForEvent('Page.loadEventFired', {
        sessionId: sid,
        timeoutMs: 20000,
      });
      await send('Page.reload');
      await reloaded;
      await wait(
        `document.querySelectorAll('.spreadsheet-tabs button').length === 3`
      );
      assert.equal(
        await evaluate(
          `Boolean(document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked'))`
        ),
        false
      );
      await click('.spreadsheet-tabs button:nth-child(2)');
      await wait(
        `document.querySelector('.dt-cell[data-r="1"][data-c="0"].is-marked')`
      );
      await click('.spreadsheet-tabs button:nth-child(3)');
      await wait(
        `document.querySelector('.dt-cell[data-r="1"][data-c="0"]')?.textContent === 'Restricted value'`
      );
      await wait(
        `document.querySelector('.structured-view [role="status"]')?.textContent?.includes('Comments are unavailable')`
      );
      await click('.dt-cell[data-r="1"][data-c="0"]');
      assert.equal(
        await evaluate(`Boolean(document.querySelector('.popover-comment'))`),
        false
      );
      console.log(`SPREADSHEET_PATH_WIDTH_OK ${width}`);
    } finally {
      cdp.dispose();
      child.kill('SIGKILL');
      children.delete(child);
      await rm(profile, { recursive: true, force: true });
    }
  }
  console.log('SPREADSHEET_PATH_OK');
} finally {
  for (const child of children) child.kill('SIGKILL');
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
