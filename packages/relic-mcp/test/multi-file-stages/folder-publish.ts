import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  openAnyRelic,
  openFolder,
  parseFragment,
  decodeManifest,
  generateRelicId,
  isRenderable,
  streamFolderContent,
  PLAINTEXT_CAP_BYTES,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, PublishError, type PublishDeps } from '../../src/publish.ts';
import { republish } from '../../src/republish.ts';
import { publishPrivate, republishPrivate } from '../../src/private.ts';
import { loadPublishState, savePrivatePublishState } from '../../src/state.ts';
import {
  cachedEntryFormat,
  loadCachedVersionFormat,
} from '../../src/suggestion-format.ts';
import { walkFolder } from '../../src/folder-source.ts';

const tmp = await mkdtemp(join(tmpdir(), 'relic-folder-path-'));
const previousState = process.env.RELIC_PUBLISH_STATE;
process.env.RELIC_PUBLISH_STATE = join(tmp, 'state.json');
try {
  const root = join(tmp, 'source');
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, '.gitignore'), '.env\ndist/\n');
  await writeFile(join(root, '.env'), 'secret');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'hidden.txt'), 'secret');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.DS_Store'), 'metadata');
  await writeFile(join(root, 'Icon\r'), 'metadata');
  await writeFile(join(root, 'README.md'), 'hello');
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'a.json'), '{"a":1}');
  await symlink('/etc/passwd', join(root, 'link'));
  execFileSync('mkfifo', [join(root, 'pipe')]);
  const calls: string[] = [];
  const signedLengths = new Map<string, number>();
  class PinnedMemoryStorage extends MemoryStorage {
    override async signUpload(
      key: string,
      size: number,
      validity: number,
      now: number
    ) {
      const signed = await super.signUpload(key, size, validity, now);
      signedLengths.set(signed.url, size);
      return signed;
    }
  }
  const storage = new PinnedMemoryStorage();
  const store = new MemoryStore();
  const app = createApp({ store, storage });
  const origin = 'https://relic.example';
  let grantBody: Record<string, unknown> | undefined;
  let uploaded: Uint8Array | undefined;
  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    clientName: 'folder-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test',
    }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.origin === origin) {
        if (url.pathname === '/api/grant')
          grantBody = JSON.parse(String(init?.body));
        const headers = new Headers(init?.headers);
        headers.set('x-forwarded-for', '198.51.100.10');
        const response = await app.fetch(
          new Request(url, { ...init, headers })
        );
        if (!response.ok)
          console.error(
            `real app ${init?.method ?? 'GET'} ${url.pathname}: ${response.status} ${await response.clone().text()}`
          );
        return response;
      }
      if (
        url.hostname === 'storage.invalid' &&
        url.pathname.startsWith('/o/')
      ) {
        const bytes = await storage.read(url.pathname.slice(3));
        return bytes
          ? new Response(bytes as unknown as BodyInit)
          : new Response(null, { status: 404 });
      }
      throw new Error('unexpected fixture request');
    }) as typeof globalThis.fetch,
    upload: async (url, headers, bytes) => {
      calls.push(`PUT ${new URL(url).pathname}`);
      const pinned = signedLengths.get(url);
      assert.equal(Number(headers['content-length']), pinned);
      assert.equal(bytes.length, pinned);
      storage.put(new URL(url).pathname.replace(/^\/upload\//, ''), bytes);
      uploaded = bytes;
      return { status: 200 };
    },
  };
  const result = await publish({ path: root, cover: false }, deps);
  assert.equal(result.shape, 'folder');
  assert.equal(result.folder?.file_count, 3);
  assert.equal(result.folder?.source, 'directory');
  assert.equal(result.folder?.files_total_bytes, 23);
  assert.equal(result.folder?.default_entry, 'README.md');
  assert.deepEqual(result.folder?.sample, [
    '.gitignore',
    'README.md',
    'data/a.json',
  ]);
  assert.equal(result.folder?.left_out.count, 8);
  assert.deepEqual(result.folder?.left_out.by_reason, {
    git_metadata: 1,
    gitignore: 2,
    node_modules: 1,
    not_regular_file: 1,
    os_metadata: 1,
    symlink: 1,
    unpublishable_name: 1,
  });
  assert.equal(result.folder?.left_out.sample.length, 8);
  assert.ok(uploaded);
  assert.equal(grantBody?.['renderer_class'], 'folder');
  assert.equal(
    grantBody?.['declared_size_bytes'],
    result.folder!.files_total_bytes + result.folder!.file_list_bytes
  );
  assert.equal(grantBody?.['declared_ciphertext_bytes'], uploaded.length);
  const freshChallenge = await deps.fetch(`${origin}/api/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(freshChallenge.status, 200);
  const challenge = (await freshChallenge.json()) as {
    challenge_nonce: string;
  };
  const wrongLength = await app.fetch(
    new Request(`${origin}/api/grant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10',
      },
      body: JSON.stringify({
        ...grantBody,
        challenge_nonce: challenge.challenge_nonce,
        relic_id: generateRelicId(),
        declared_ciphertext_bytes: uploaded.length + 1,
      }),
    })
  );
  assert.equal(wrongLength.status, 400);
  assert.equal(
    ((await wrongLength.json()) as { code: string }).code,
    'invalid_publish_metadata'
  );
  assert.equal(
    (await store.getRelic(result.relic_id))?.rendererClass,
    'folder'
  );
  assert.equal(isRenderable('folder'), true);
  const card = await app.fetch(new Request(`${origin}/${result.relic_id}`));
  assert.equal(card.status, 200);
  assert.match(await card.text(), /A folder of files\./);
  const fragment = parseFragment(new URL(result.url).hash);
  assert.ok(fragment);
  const firstFormat = await loadCachedVersionFormat(
    result.relic_id,
    1,
    fragment.key
  );
  assert.ok(firstFormat);
  assert.deepEqual(
    cachedEntryFormat(
      firstFormat,
      'data/a.json',
      fragment.key,
      result.relic_id,
      1
    ),
    {
      found: true,
      extension: 'json',
    }
  );
  assert.deepEqual(
    cachedEntryFormat(
      firstFormat,
      'data/b.csv',
      fragment.key,
      result.relic_id,
      1
    ),
    {
      found: false,
      extension: null,
    }
  );
  const mintResponse = await deps.fetch(
    `${origin}/api/relics/${result.relic_id}/mint`,
    { method: 'POST' }
  );
  assert.equal(mintResponse.status, 200);
  const mint = (await mintResponse.json()) as {
    url: string;
    object_length: number;
  };
  const downloaded = await deps.fetch(mint.url);
  assert.equal(downloaded.status, 200);
  assert.ok(downloaded.body);
  const contentChunks: Uint8Array[] = [];
  const header = await streamFolderContent(downloaded.body, fragment.key, {
    objectLength: mint.object_length,
    onContent(chunk) {
      contentChunks.push(chunk);
    },
  });
  const content = Buffer.concat(contentChunks);
  const manifest = decodeManifest(
    content.subarray(0, header.manifestLength),
    header
  );
  const expected = new Map([
    ['.gitignore', Buffer.from('.env\ndist/\n')],
    ['README.md', Buffer.from('hello')],
    ['data/a.json', Buffer.from('{"a":1}')],
  ]);
  assert.equal(manifest.entries.length, expected.size);
  for (const entry of manifest.entries) {
    const bytes = expected.get(entry.path);
    assert.ok(bytes);
    assert.deepEqual(
      content.subarray(entry.offset, entry.offset + entry.length),
      bytes
    );
  }
  const opened = await openAnyRelic(uploaded, fragment.key, {
    admitted: [1, 2],
  });
  assert.deepEqual(
    openFolder(opened).manifest.entries.map((entry) => entry.path),
    ['.gitignore', 'README.md', 'data/a.json']
  );
  const copy = join(tmp, 'copy');
  await mkdir(copy);
  await cp(join(root, '.gitignore'), join(copy, '.gitignore'));
  await cp(join(root, '.env'), join(copy, '.env'));
  await cp(join(root, 'dist'), join(copy, 'dist'), { recursive: true });
  await cp(join(root, 'README.md'), join(copy, 'README.md'));
  await cp(join(root, 'data'), join(copy, 'data'), { recursive: true });
  const copyList = await walkFolder(copy);
  assert.ok(copyList.ok);
  assert.deepEqual(
    copyList.files.map((file) => file.path),
    ['.gitignore', 'README.md', 'data/a.json']
  );
  const publishModule = pathToFileURL(
    join(import.meta.dir, '../../src/publish.ts')
  ).href;
  const filesModule = pathToFileURL(
    join(import.meta.dir, '../../src/files.ts')
  ).href;
  const lookupCode = `import {lookupPublishedSource} from ${JSON.stringify(publishModule)}; import {nodeFiles} from ${JSON.stringify(filesModule)}; const result=await lookupPublishedSource(${JSON.stringify(root)}, {files:nodeFiles}); console.log(JSON.stringify(result.match));`;
  const lookup = JSON.parse(
    execFileSync(process.execPath, ['-e', lookupCode], { encoding: 'utf8' })
  );
  assert.equal(lookup.relic_id, result.relic_id);
  assert.equal(lookup.shape, 'folder');
  calls.length = 0;
  await assert.rejects(
    republish({ relic_id: result.relic_id, path: root, cover: false }, deps),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'duplicate_version'
  );
  assert.equal(calls.length, 0);
  await writeFile(join(root, 'README.md'), 'updated');
  await rm(join(root, 'data', 'a.json'));
  await writeFile(join(root, 'data', 'b.csv'), 'a,b\n');
  const next = await republish(
    { relic_id: result.relic_id, path: root, cover: false, notify: false },
    deps
  );
  assert.equal(next.shape, 'folder');
  assert.equal(next.version, 2);
  const formats = (await loadPublishState(result.relic_id))?.version_formats;
  assert.deepEqual(formats, {
    '1': { shape: 'folder' },
    '2': { shape: 'folder' },
  });
  const nextFormat = await loadCachedVersionFormat(
    result.relic_id,
    2,
    fragment.key
  );
  assert.ok(nextFormat);
  assert.deepEqual(
    cachedEntryFormat(
      nextFormat,
      'data/a.json',
      fragment.key,
      result.relic_id,
      2
    ),
    {
      found: false,
      extension: null,
    }
  );
  assert.deepEqual(
    cachedEntryFormat(
      nextFormat,
      'data/b.csv',
      fragment.key,
      result.relic_id,
      2
    ),
    {
      found: true,
      extension: 'csv',
    }
  );
  assert.deepEqual(
    cachedEntryFormat(
      firstFormat,
      'data/a.json',
      fragment.key,
      result.relic_id,
      1
    ),
    {
      found: true,
      extension: 'json',
    }
  );
  assert.ok(uploaded);
  const reopened = await openAnyRelic(uploaded, fragment.key, {
    admitted: [1, 2],
  });
  assert.equal(openFolder(reopened).header.version, 2);
  calls.length = 0;
  const swapRoot = join(tmp, 'swap');
  const outside = join(tmp, 'outside');
  await mkdir(swapRoot);
  await mkdir(join(swapRoot, 'dir'));
  await mkdir(outside);
  await writeFile(join(swapRoot, 'dir', 'file'), 'safe');
  await writeFile(join(outside, 'file'), 'evil');
  let swapped = false;
  const swappingFiles = {
    ...nodeFiles,
    async openBundleRoot(path: string) {
      const rootHandle = await nodeFiles.openBundleRoot(path);
      return {
        async openRegular(relativePath: string) {
          if (!swapped) {
            swapped = true;
            await rename(join(swapRoot, 'dir'), join(swapRoot, 'old'));
            await symlink(outside, join(swapRoot, 'dir'));
          }
          return rootHandle.openRegular(relativePath);
        },
        close: () => rootHandle.close(),
      };
    },
  };
  calls.length = 0;
  await assert.rejects(
    publish(
      { path: swapRoot, cover: false },
      { ...deps, files: swappingFiles }
    ),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'path_escapes_root'
  );
  assert.equal(calls.length, 0);
  const changed = join(tmp, 'changed');
  await mkdir(changed);
  await writeFile(join(changed, 'file'), 'old');
  let changedOnce = false;
  const changedFiles = {
    ...nodeFiles,
    async openBundleRoot(path: string) {
      const held = await nodeFiles.openBundleRoot(path);
      return {
        async openRegular(relativePath: string) {
          if (!changedOnce) {
            changedOnce = true;
            await writeFile(join(changed, 'file'), 'longer');
          }
          return held.openRegular(relativePath);
        },
        close: () => held.close(),
      };
    },
  };
  calls.length = 0;
  await assert.rejects(
    publish({ path: changed, cover: false }, { ...deps, files: changedFiles }),
    (error: unknown) =>
      error instanceof PublishError &&
      error.code === 'file_changed_during_publish'
  );
  assert.equal(calls.length, 0);
  const empty = join(tmp, 'empty');
  await mkdir(empty);
  calls.length = 0;
  await assert.rejects(
    publish({ path: empty, cover: false }, deps),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'folder_empty'
  );
  assert.equal(calls.length, 0);
  const excluded = join(tmp, 'excluded');
  await mkdir(excluded);
  await symlink('/etc/passwd', join(excluded, 'link'));
  await assert.rejects(
    publish({ path: excluded, cover: false }, deps),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'all-excluded'
  );
  const collision = join(tmp, 'collision');
  await mkdir(collision);
  await writeFile(join(collision, 'ı'), 'a');
  await writeFile(join(collision, 'I'), 'b');
  await assert.rejects(
    publish({ path: collision, cover: false }, deps),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'path_collision'
  );
  const many = join(tmp, 'many');
  await mkdir(many);
  for (let i = 0; i < 5001; i++) await writeFile(join(many, `f${i}`), '');
  await assert.rejects(
    publish({ path: many, cover: false }, deps),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'too_many_files'
  );
  const oversized = join(tmp, 'oversized');
  await mkdir(oversized);
  await writeFile(join(oversized, 'sparse'), '');
  await truncate(join(oversized, 'sparse'), PLAINTEXT_CAP_BYTES);
  await assert.rejects(
    publish({ path: oversized, cover: false }, deps),
    (error: unknown) =>
      error instanceof PublishError &&
      error.code === 'local_size_precheck_failed'
  );
  assert.equal(calls.length, 0);
  for (const [path, code] of [
    [empty, 'folder_empty'],
    [collision, 'path_collision'],
    [many, 'too_many_files'],
  ] as const) {
    await assert.rejects(
      publishPrivate({ path }, deps),
      (error: unknown) => error instanceof PublishError && error.code === code
    );
    assert.equal(calls.length, 0);
  }
  await savePrivatePublishState(result.relic_id, {
    access: 'private',
    service_origin: deps.serviceOrigin,
    publish_token: 'token',
    version: 1,
    version_keys: {},
    owner_identity_id: 'owner',
    device_id: 'device',
    shape: 'folder',
  });
  await assert.rejects(
    republishPrivate({ relic_id: result.relic_id, path: empty }, deps),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'folder_empty'
  );
  assert.equal(calls.length, 0);
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = empty;
    await assert.rejects(
      publish({ path: copy, cover: false }, deps),
      (error: unknown) =>
        error instanceof PublishError && error.code === 'gitignore_unavailable'
    );
    assert.equal(calls.length, 0);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
  console.log('MULTI_FILE_STAGE folder-publish OK');
} finally {
  if (previousState === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = previousState;
  await rm(tmp, { recursive: true, force: true });
}
