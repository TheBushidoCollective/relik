import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crc32,
  encodeManifest,
  openAnyRelic,
  openFolder,
  parseFragment,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { isRecord } from '../../../relic-format/src/guards.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';
import { launchProofBrowser } from '../decision-proof-steps.ts';

type ZipFile = {
  name: string | Buffer;
  body: string;
  symlink?: boolean;
  encrypted?: boolean;
  method?: number;
  size?: number;
};
function zip(files: ZipFile[]): Uint8Array {
  const parts: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name),
      body = Buffer.from(file.body);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(file.method ?? 0, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.size ?? body.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(file.method ?? 0, 10);
    central.writeUInt32LE(crc32(body), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.size ?? body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      ((file.symlink
        ? 0xa1ff
        : name[name.length - 1] === 47
          ? 0x41ed
          : 0x81a4) <<
        16) >>>
        0,
      38
    );
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

export async function runBrowserPublishStage(
  kind: 'zip' | 'folder'
): Promise<void> {
  const chrome = findHeadlessShell();
  if (!chrome) {
    if (chromeRequired) throw new Error('Headless Chrome is required');
    console.log(
      `MULTI_FILE_STAGE browser-${kind} SKIP (headless shell missing)`
    );
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'relic-browser-folder-'));
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const service = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      return handler
        ? handler(request)
        : new Response('Not ready', { status: 503 });
    },
  });
  const origin = `http://localhost:${service.port}`;
  const storage = new MemoryStorage(`${origin}/__storage`);
  const app = createApp({
    config: {
      serviceOrigin: origin,
      usercontentOrigin: `http://127.0.0.1:${service.port}`,
    },
    store: new MemoryStore(),
    storage,
    assets: diskAssets(
      new URL('../../../relic-viewer/dist/', import.meta.url).pathname
    ),
  });
  // Calls the publisher itself makes: a challenge, a grant, a completion and
  // the upload. A viewer page also makes reads of its own in the background,
  // and those are not what these assertions are about.
  let apiCalls = 0;
  handler = async (request) => {
    const url = new URL(request.url);
    if (
      url.pathname === '/api/challenge' ||
      url.pathname === '/api/grant' ||
      /^\/api\/relics\/[^/]+\/complete$/.test(url.pathname) ||
      url.pathname.startsWith('/__storage/upload/')
    )
      apiCalls++;
    if (
      url.pathname.startsWith('/__storage/upload/') &&
      request.method === 'PUT'
    ) {
      storage.put(
        url.pathname.slice('/__storage/upload/'.length),
        new Uint8Array(await request.arrayBuffer())
      );
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
      const data = await storage.read(
        url.pathname.slice('/__storage/o/'.length)
      );
      return data
        ? new Response(Buffer.from(data))
        : new Response('Not found', { status: 404 });
    }
    return app.fetch(request);
  };
  const browser = await launchProofBrowser(chrome, origin);
  const waitText = async (text: string): Promise<void> => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (
        await browser
          .evaluate<boolean>(
            `document.body.innerText.includes(${JSON.stringify(text)})`
          )
          .catch(() => false)
      )
        return;
      await Bun.sleep(50);
    }
    throw new Error(`Timed out waiting for ${text}`);
  };
  const navigate = async (url: string) => {
    await browser.cdp.send('Page.navigate', { url }, browser.sessionId);
  };
  const drop = async (path: string) => {
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await browser.cdp.send(
        'Input.dispatchDragEvent',
        { type, x: 640, y: 300, data },
        browser.sessionId
      );
  };
  const publishAndCheck = async (
    expected: Record<string, string>
  ): Promise<string> => {
    assert.equal(apiCalls, 0, 'preflight made a request');
    await browser.clickSelector('.pub-row .action.primary');
    await browser.waitForSelector('.pub-link');
    assert.ok(apiCalls > 0, 'the counter sees the publisher own calls');
    const link = await browser.evaluate<string>(
      `document.querySelector('.pub-link').value`
    );
    const url = new URL(link),
      key = parseFragment(url.hash)?.key;
    assert.ok(key);
    const encrypted = await storage.read(url.pathname.slice(1));
    assert.ok(encrypted);
    const folder = openFolder(
      await openAnyRelic(encrypted, key, { admitted: [1, 2] })
    );
    assert.deepEqual(
      folder.manifest.entries.map((entry) => entry.path).sort(),
      Object.keys(expected).sort()
    );
    for (const [index, entry] of folder.manifest.entries.entries())
      assert.equal(
        new TextDecoder().decode(folder.entryBytes(index)),
        expected[entry.path]
      );
    return link;
  };
  try {
    await browser.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      browser.sessionId
    );
    await navigate(`${origin}/publish`);
    await browser.waitForSelector('.pub-drop');
    if (kind === 'zip') {
      const bytes = zip([
        { name: 'README.md', body: '# Guide' },
        { name: 'data/a.json', body: '{"ok":true}' },
        { name: 'notes.txt', body: 'notes' },
        { name: 'data/', body: '' },
        { name: '__MACOSX/._data', body: 'noise' },
        { name: 'link', body: 'target', symlink: true },
      ]);
      const path = join(scratch, 'fixture.zip');
      await writeFile(path, bytes);
      await drop(path);
      await waitText('3 files included');
      await waitText('os metadata: 1');
      await waitText('symlink: 1');
      await waitText('directory: 1');
      const link = await publishAndCheck({
        'README.md': '# Guide',
        'data/a.json': '{"ok":true}',
        'notes.txt': 'notes',
      });
      await navigate(link);
      await waitText('Guide');
      apiCalls = 0;
      await drop(path);
      await waitText('3 files included');
      assert.equal(apiCalls, 0, 'viewer ZIP preflight made a request');
      await publishAndCheck({
        'README.md': '# Guide',
        'data/a.json': '{"ok":true}',
        'notes.txt': 'notes',
      });
      await navigate(`${origin}/publish`);
      await browser.waitForSelector('.pub-drop');
      apiCalls = 0;
      await drop(path);
      await waitText('3 files included');
      assert.equal(apiCalls, 0);
      await browser.clickSelector('.pub-expand');
      await browser.waitForSelector('.pub-title');
      await browser.clickSelector('.pub-row .action.primary');
      await browser.waitForSelector('.pub-link');
      const opaqueLink = await browser.evaluate<string>(
        `document.querySelector('.pub-link').value`
      );
      const opaqueUrl = new URL(opaqueLink);
      const opaqueKey = parseFragment(opaqueUrl.hash)?.key;
      assert.ok(opaqueKey);
      const opaqueBytes = await storage.read(opaqueUrl.pathname.slice(1));
      assert.ok(opaqueBytes);
      const opaque = await openAnyRelic(opaqueBytes, opaqueKey, {
        admitted: [1, 2],
      });
      assert.equal(opaque.envelope.version, 1);
      assert.deepEqual(Buffer.from(opaque.content), Buffer.from(bytes));
      const hostile: { name: string; data: Uint8Array; reason: string }[] = [
        {
          name: 'traversal.zip',
          data: zip([{ name: '../bad', body: 'x' }]),
          reason: 'traversal',
        },
        {
          name: 'absolute.zip',
          data: zip([{ name: '/bad', body: 'x' }]),
          reason: 'Absolute',
        },
        {
          name: 'encrypted.zip',
          data: zip([{ name: 'bad', body: 'x', encrypted: true }]),
          reason: 'encrypted',
        },
        {
          name: 'collision.zip',
          data: zip([
            { name: 'a', body: 'x' },
            { name: 'A', body: 'x' },
          ]),
          reason: 'collide',
        },
        {
          name: 'utf8.zip',
          data: zip([{ name: Buffer.from([255]), body: 'x' }]),
          reason: 'UTF-8',
        },
        {
          name: 'forbidden.zip',
          data: zip([{ name: 'bad\u202ename.txt', body: 'x' }]),
          reason: 'forbidden_character',
        },
        {
          name: 'long-name.zip',
          data: zip([{ name: `${'a'.repeat(256)}.txt`, body: 'x' }]),
          reason: 'segment_too_long',
        },
        {
          name: 'bomb.zip',
          data: zip([{ name: 'bad', body: 'x', size: 100_000_001, method: 8 }]),
          reason: 'limit',
        },
        {
          name: 'count.zip',
          data: zip(
            Array.from({ length: 5001 }, (_, i) => ({
              name: `f${i}`,
              body: '',
            }))
          ),
          reason: 'entries',
        },
      ];
      const zip64 = Buffer.from(zip([{ name: 'a', body: 'a' }]));
      zip64.writeUInt16LE(0xffff, zip64.length - 14);
      hostile.push({ name: 'zip64.zip', data: zip64, reason: 'ZIP64' });
      for (const item of hostile) {
        const target = join(scratch, item.name);
        await writeFile(target, item.data);
        await navigate(`${origin}/publish`);
        await browser.waitForSelector('.pub-drop');
        apiCalls = 0;
        await drop(target);
        await browser.waitForSelector('.pub-review-status');
        await waitText(item.reason);
        await waitText('You can publish the ZIP as one file instead.');
        assert.equal(apiCalls, 0, `${item.name} contacted the API`);
      }
      const docx = join(scratch, 'fixture.docx');
      await writeFile(docx, bytes);
      await navigate(`${origin}/publish`);
      await browser.waitForSelector('.pub-drop');
      apiCalls = 0;
      await drop(docx);
      await browser.waitForSelector('.pub-title');
      assert.equal(apiCalls, 0);
      assert.equal(
        await browser.evaluate<boolean>(
          `document.body.innerText.includes('Folder:')`
        ),
        false
      );
      await browser.clickSelector('.pub-row .action.primary');
      await browser.waitForSelector('.pub-link');
      const docxUrl = new URL(
        await browser.evaluate<string>(
          `document.querySelector('.pub-link').value`
        )
      );
      const docxKey = parseFragment(docxUrl.hash)?.key;
      assert.ok(docxKey);
      const docxBytes = await storage.read(docxUrl.pathname.slice(1));
      assert.ok(docxBytes);
      assert.equal(
        (await openAnyRelic(docxBytes, docxKey, { admitted: [1, 2] })).envelope
          .version,
        1
      );
      console.log('MULTI_FILE_STAGE browser-zip OK');
    } else {
      const root = join(scratch, 'folder');
      await mkdir(join(root, 'nested'), { recursive: true });
      await mkdir(join(root, 'dist'), { recursive: true });
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
      const files: Record<string, string> = {
        'README.md': '# Guide',
        '.gitignore': '.env\ndist/\n',
        '.env': 'secret',
        'nested/.gitignore': '*.tmp\n',
        'nested/file.tmp': 'omit',
        'nested/a.json': '{"ok":true}',
        'dist/out.js': 'generated',
        'node_modules/pkg/index.js': 'dependency',
        '.DS_Store': 'noise',
      };
      for (const [path, contents] of Object.entries(files))
        await writeFile(join(root, path), contents);
      await drop(root);
      await waitText('4 files included');
      await waitText('gitignore: 3');
      await waitText('node modules: 1');
      await waitText('os metadata: 1');
      const expected = {
        '.gitignore': '.env\ndist/\n',
        'README.md': '# Guide',
        'nested/.gitignore': '*.tmp\n',
        'nested/a.json': '{"ok":true}',
      };
      const link = await publishAndCheck(expected);
      await navigate(`${origin}/publish`);
      await browser.waitForSelector('.pub-drop');
      const document = await browser.cdp.send(
        'DOM.getDocument',
        {},
        browser.sessionId
      );
      if (
        !isRecord(document['root']) ||
        typeof document['root']['nodeId'] !== 'number'
      )
        throw new Error('No document node');
      const input = await browser.cdp.send(
        'DOM.querySelector',
        {
          nodeId: document['root']['nodeId'],
          selector: 'input[webkitdirectory]',
        },
        browser.sessionId
      );
      if (typeof input['nodeId'] !== 'number')
        throw new Error('No folder input');
      apiCalls = 0;
      await browser.cdp.send(
        'DOM.setFileInputFiles',
        { nodeId: input['nodeId'], files: [root] },
        browser.sessionId
      );
      await waitText('4 files included');
      assert.equal(apiCalls, 0);
      await navigate(link);
      await waitText('Guide');
      apiCalls = 0;
      await drop(root);
      await waitText('4 files included');
      await publishAndCheck(expected);
      if (process.env['RELIC_LARGE_FOLDER_PROOF']) {
        const largeRoot = join(scratch, 'large');
        await mkdir(largeRoot);
        const manifest = encodeManifest(0, [
          { path: 'large.txt', mimetype: 'text/plain', length: 0 },
        ]);
        const size = 100_000_000 - manifest.length;
        await writeFile(join(largeRoot, 'large.txt'), Buffer.alloc(size, 65));
        await navigate(`${origin}/publish`);
        await browser.waitForSelector('.pub-drop');
        apiCalls = 0;
        await drop(largeRoot);
        await waitText('1 file included');
        assert.equal(apiCalls, 0);
        await browser.clickSelector('.pub-row .action.primary');
        await browser.waitForSelector('.pub-link', 120000);
        const largeUrl = new URL(
          await browser.evaluate<string>(
            `document.querySelector('.pub-link').value`
          )
        );
        const largeKey = parseFragment(largeUrl.hash)?.key;
        assert.ok(largeKey);
        const encrypted = await storage.read(largeUrl.pathname.slice(1));
        assert.ok(encrypted);
        const opened = openFolder(
          await openAnyRelic(encrypted, largeKey, { admitted: [1, 2] })
        );
        assert.equal(opened.header.contentLength, 100_000_000);
        assert.equal(opened.entryBytes(0).length, size);
        assert.ok(opened.entryBytes(0).every((byte) => byte === 65));
        console.log(
          `BROWSER_FOLDER_SIZE_PROOF content_bytes=${opened.header.contentLength} file_bytes=${size}`
        );
      }
      console.log('MULTI_FILE_STAGE browser-folder OK');
    }
  } finally {
    await browser.close();
    service.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
}
