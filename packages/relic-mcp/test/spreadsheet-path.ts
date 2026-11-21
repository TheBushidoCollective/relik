import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import {
  writeZipLocalHeader,
  writeZipCentralRecord,
  writeZipEnd,
  type ZipEntryRecord,
} from '@relic/format';
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
      '<workbook><sheets><sheet name="First" r:id="r1"/><sheet name="Second" r:id="r2"/><sheet name="Bad&#x202e;name" r:id="r3"/><sheet name="Hidden" state="hidden" r:id="r4"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Type="urn:office/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="urn:office/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="r3" Type="urn:office/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="r4" Type="urn:office/worksheet" Target="worksheets/sheet4.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>First value</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c><c r="B1" t="inlineStr"><is><t>Calculated</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Second value</t></is></c><c r="B2"><f>1+1</f><v>42</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet3.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Restricted value</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet4.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Hidden value</t></is></c></row></sheetData></worksheet>',
    'padding.bin': 'x'.repeat(17 * 1024 * 1024),
  };
  const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  files['xl/workbook.xml'] = files['xl/workbook.xml']!.replace(
    '<workbook',
    `<workbook xmlns="${sheetNs}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
  );
  files['xl/_rels/workbook.xml.rels'] = files[
    'xl/_rels/workbook.xml.rels'
  ]!.replace(
    '<Relationships',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
  );
  for (const name of Object.keys(files)) {
    if (name.startsWith('xl/worksheets/'))
      files[name] = files[name]!.replace(
        '<worksheet',
        `<worksheet xmlns="${sheetNs}"`
      );
  }
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, value]) => {
    const bytes = encoder.encode(value);
    const compressed = name.startsWith('xl/worksheets/');
    return {
      name: encoder.encode(name),
      bytes,
      packed: compressed ? deflateRawSync(bytes) : bytes,
      method: compressed ? (8 as const) : (0 as const),
    };
  });
  const records: ZipEntryRecord[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    records.push({
      nameBytes: entry.name,
      method: entry.method,
      crc32: crc32(entry.bytes),
      compressedSize: entry.packed.length,
      uncompressedSize: entry.bytes.length,
      localHeaderOffset: offset,
    });
    offset += 30 + entry.name.length + entry.packed.length;
    directorySize += 46 + entry.name.length;
  }
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (let i = 0; i < entries.length; i++) {
    at += writeZipLocalHeader(out, at, records[i]!);
    out.set(entries[i]!.packed, at);
    at += entries[i]!.packed.length;
  }
  const directoryOffset = at;
  for (const record of records) at += writeZipCentralRecord(out, at, record);
  writeZipEnd(out, at, {
    entryCount: records.length,
    directorySize,
    directoryOffset,
    comment: new Uint8Array(),
  });
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
  const bytes = workbook();
  assert.ok(
    bytes.length > 16 * 1024 * 1024,
    'fixture must exceed the bounded range-read limit'
  );
  await writeFile(path, bytes);
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
        assert.equal(
          await evaluate(
            `document.querySelector('.dt-cell[data-r="1"][data-c="1"]')?.textContent`
          ),
          '42'
        );
        await click('.dt-cell[data-r="1"][data-c="1"]');
        await wait(
          `document.querySelector('.dt-value')?.textContent?.includes('Formula: 1+1')`
        );
        await wait(
          `document.querySelector('.popover-comment')?.getAttribute('aria-label') === 'Comment on "cell B2 of Second"'`
        );
        // Check the interval before the new selection's deferred offer runs.
        // A real click below still exercises the full user path.
        assert.equal(
          await evaluate(`(() => {
            const cell = document.querySelector('.dt-cell[data-r="1"][data-c="0"]');
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            const dismissed = !document.querySelector('.popover-offer');
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
            return dismissed;
          })()`),
          true,
          'a new selection must dismiss the previous cell offer immediately'
        );
      }
      if (width === 1440) {
        await click('.dt-cell[data-r="1"][data-c="0"]');
        await click(
          `.popover-comment[aria-label='Comment on "cell A2 of Second"']`
        );
        await wait(
          `document.querySelector('.popover-composer .popover-target')?.textContent === 'Commenting on cell A2 of Second'`
        );
        await click('.popover-composer .popover-field');
        await send('Input.insertText', { text: 'Second sheet note' });
        await click('.popover-composer .popover-tools .is-primary');
        // The pending target is marked too. Wait for the saved comment's
        // card before treating the mark as a persisted one.
        await wait(
          `document.querySelector('.popover-card:not(.popover-composer) .comment-body')?.textContent?.includes('Second sheet note')`
        );
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
      // Sheet labels use the shared lowercase \uXXXX display escape.
      assert.equal(
        await evaluate(
          `document.querySelector('.spreadsheet-tabs button:nth-child(3)')?.textContent`
        ),
        'Bad\\u202ename'
      );
      await wait(
        `document.querySelector('.dt-cell[data-r="1"][data-c="0"]')?.textContent === 'Restricted value'`
      );
      await wait(
        `document.querySelector('.structured-view [role="status"]')?.textContent?.includes('Comments are unavailable')`
      );
      assert.equal(
        await evaluate(`Boolean(document.querySelector('.dt-hc-comment'))`),
        false
      );
      await click('.dt-cell[data-r="1"][data-c="0"]');
      assert.equal(
        await evaluate(`Boolean(document.querySelector('.popover-comment'))`),
        false
      );
      assert.equal(
        await evaluate(
          `document.querySelector('select[aria-label="Hidden sheets"] option[value="3"]')?.textContent`
        ),
        'Hidden'
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
