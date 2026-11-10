import { fetchUpload } from './upload-fixture.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  type CoverOutcome,
  type CoverReport,
  crc32,
} from '@relic/format/cover';
import { uploadCover } from '../src/cover/upload.ts';
import { nodeFiles } from '../src/files.ts';
import {
  contentDigest,
  type PublishDeps,
  PublishError,
  publish,
  ServerRefusal,
} from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { handleMessage } from '../src/server.ts';
import {
  loadPublishInventory,
  loadPublishState,
  savePublishState,
} from '../src/state.ts';

const SERVICE = 'https://relic.example';

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const typeAndData = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(typeAndData));
  return chunk;
}

function makeIhdr(
  width = COVER_WIDTH,
  height = COVER_HEIGHT,
  bitDepth = 8,
  colorType = 2
): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return makeChunk('IHDR', data);
}

function makeValidPng(): Uint8Array {
  const bpp = 3;
  const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * bpp));
  const idat = makeChunk('IDAT', deflateSync(rawPixels));
  const iend = makeChunk('IEND', new Uint8Array(0));
  const total = PNG_SIGNATURE.length + 25 + idat.length + iend.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [PNG_SIGNATURE, makeIhdr(), idat, iend]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

describe('cover upload and error mapping', () => {
  const validPng = makeValidPng();

  test('uploaded case with valid PNG and 200 response', async () => {
    let requestedUrl = '';
    let requestedMethod = '';
    let requestedBody = '';

    const deps = {
      serviceOrigin: SERVICE,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedMethod = init?.method ?? 'GET';
        requestedBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            cover_url: `${SERVICE}/relic123/cover/abcdef.png`,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }) as typeof globalThis.fetch,
    };

    const report = await uploadCover(deps, {
      relicId: 'relic123',
      publishToken: 'token456',
      version: 1,
      kind: 'markdown',
      type: 'image/png',
      bytes: validPng,
    });

    expect(requestedUrl).toBe(`${SERVICE}/api/relics/relic123/cover`);
    expect(requestedMethod).toBe('POST');
    const parsedBody = JSON.parse(requestedBody) as Record<string, unknown>;
    expect(parsedBody['publish_token']).toBe('token456');
    expect(parsedBody['version']).toBe(1);
    expect(parsedBody['kind']).toBe('markdown');
    expect(parsedBody['type']).toBe('image/png');
    expect(typeof parsedBody['data']).toBe('string');

    expect(report).toEqual({
      status: 'uploaded',
      kind: 'markdown',
      type: 'image/png',
      url: `${SERVICE}/relic123/cover/abcdef.png`,
      bytes: validPng.length,
    });
  });

  test('404 response maps to service_unsupported', async () => {
    const deps = {
      serviceOrigin: SERVICE,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    };

    const report = await uploadCover(deps, {
      relicId: 'relic123',
      publishToken: 'token456',
      version: 1,
      kind: 'markdown',
      type: 'image/png',
      bytes: validPng,
    });

    expect(report.status).toBe('skipped');
    if (report.status === 'skipped') {
      expect(report.reason).toBe('service_unsupported');
      expect(report.detail).toBe(
        `the service at ${SERVICE} does not accept cover images (HTTP 404)`
      );
    }
  });

  test('ServerRefusal 404 with unknown code maps to service_unsupported', async () => {
    const deps = {
      serviceOrigin: SERVICE,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new ServerRefusal('unknown', 404, {});
      }) as unknown as typeof globalThis.fetch,
    };

    const report = await uploadCover(deps, {
      relicId: 'relic123',
      publishToken: 'token456',
      version: 1,
      kind: 'markdown',
      type: 'image/png',
      bytes: validPng,
    });

    expect(report.status).toBe('skipped');
    if (report.status === 'skipped') {
      expect(report.reason).toBe('service_unsupported');
      expect(report.detail).toBe(
        `the service at ${SERVICE} does not accept cover images (HTTP 404)`
      );
    }
  });

  test('problem document maps to service_refused', async () => {
    const deps = {
      serviceOrigin: SERVICE,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            code: 'invalid_cover',
            detail: 'dimensions must be 1200x630',
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }
        );
      }) as unknown as typeof globalThis.fetch,
    };

    const report = await uploadCover(deps, {
      relicId: 'relic123',
      publishToken: 'token456',
      version: 1,
      kind: 'markdown',
      type: 'image/png',
      bytes: validPng,
    });

    expect(report.status).toBe('skipped');
    if (report.status === 'skipped') {
      expect(report.reason).toBe('service_refused');
      expect(report.detail).toBe('invalid_cover: dimensions must be 1200x630');
    }
  });

  test('network failure maps to upload_failed', async () => {
    const deps = {
      serviceOrigin: SERVICE,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new TypeError('fetch failed: connection refused');
      }) as unknown as typeof globalThis.fetch,
    };

    const report = await uploadCover(deps, {
      relicId: 'relic123',
      publishToken: 'token456',
      version: 1,
      kind: 'markdown',
      type: 'image/png',
      bytes: validPng,
    });

    expect(report.status).toBe('skipped');
    if (report.status === 'skipped') {
      expect(report.reason).toBe('upload_failed');
      expect(report.detail).toContain('connection refused');
    }
  });

  test('invalid raster bytes fail validation and map to render_failed', async () => {
    const deps = {
      serviceOrigin: SERVICE,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new Error('fetch should not be called for invalid bytes');
      }) as unknown as typeof globalThis.fetch,
    };

    const report = await uploadCover(deps, {
      relicId: 'relic123',
      publishToken: 'token456',
      version: 1,
      kind: 'markdown',
      type: 'image/png',
      bytes: new Uint8Array([0, 1, 2, 3]),
    });

    expect(report.status).toBe('skipped');
    if (report.status === 'skipped') {
      expect(report.reason).toBe('render_failed');
      expect(report.detail).toContain('signature');
    }
  });
});

describe('publish flow with cover options', () => {
  let scratch: string;
  let renderCoverCalls: number;
  let coverRequests: string[];

  const validPng = makeValidPng();

  function fakeFetch(simulateUpload200 = true): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/challenge')) {
        return new Response(
          JSON.stringify({
            challenge_nonce: 'nonce1',
            size_limit_bytes: 10_000_000,
            size_basis: 'bytes',
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/grant')) {
        return new Response(
          JSON.stringify({
            upload_url: `${SERVICE}/storage/upload`,
            publish_token: 'pubtoken123',
            report_url: `${SERVICE}/report`,
            disclosure_url: `${SERVICE}/policy`,
            relic_expires_at: null,
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/storage/upload')) {
        return new Response(null, { status: 200 });
      }
      if (url.includes('/complete')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/cover')) {
        coverRequests.push(url);
        if (simulateUpload200) {
          return new Response(
            JSON.stringify({
              cover_url: `${SERVICE}/relic/cover/sha.png`,
            }),
            { status: 200 }
          );
        }
        return new Response('Not Found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;
  }

  function makeTestDeps(
    fetchFn: typeof globalThis.fetch,
    renderOutcome?: CoverOutcome
  ): PublishDeps {
    return {
      serviceOrigin: SERVICE,
      relicOrigin: SERVICE,
      files: nodeFiles,
      fetch: fetchFn,
      upload: fetchUpload,
      clientName: 'test',
      renderCover: async () => {
        renderCoverCalls++;
        return (
          renderOutcome ?? {
            status: 'rendered',
            kind: 'markdown',
            type: 'image/png',
            bytes: validPng,
          }
        );
      },
    };
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cover-publish-test-'));
    process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');
    renderCoverCalls = 0;
    coverRequests = [];
  });

  afterEach(async () => {
    delete process.env['RELIC_PUBLISH_STATE'];
    await rm(scratch, { recursive: true, force: true });
  });

  test('cover: false makes zero renderCover calls and zero /cover requests', async () => {
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Document\n\nContent.\n');

    const deps = makeTestDeps(fakeFetch());
    const result = await publish({ path: filePath, cover: false }, deps);

    expect(renderCoverCalls).toBe(0);
    expect(coverRequests.length).toBe(0);
    expect(result.cover).toEqual({ status: 'declined' });

    const state = await loadPublishState(result.relic_id);
    expect(state).toBeDefined();
    expect(state?.cover_uploaded).toBe(false);
  });

  test('a large-source fallback is reported without uploading a cover', async () => {
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Document\n\nContent.\n');
    const outcome: CoverOutcome = {
      status: 'skipped',
      reason: 'over_render_ceiling',
      detail: 'Cover source exceeds the limit; using the generic cover',
    };
    const deps = makeTestDeps(fakeFetch(), outcome);
    const result = await publish({ path: filePath }, deps);

    expect(renderCoverCalls).toBe(1);
    expect(coverRequests).toHaveLength(0);
    expect(result.cover).toEqual(outcome);
    const state = await loadPublishState(result.relic_id);
    expect(state?.cover_uploaded).toBe(false);
  });

  test('uploaded case with fake renderer and 200 cover upload', async () => {
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Document\n\nContent.\n');

    const deps = makeTestDeps(fakeFetch(true));
    const result = await publish({ path: filePath, cover: true }, deps);

    expect(renderCoverCalls).toBe(1);
    expect(coverRequests.length).toBe(1);
    expect(result.cover).toEqual({
      status: 'uploaded',
      kind: 'markdown',
      type: 'image/png',
      url: `${SERVICE}/relic/cover/sha.png`,
      bytes: validPng.length,
    });

    const state = await loadPublishState(result.relic_id);
    expect(state).toBeDefined();
    expect(state?.cover_uploaded).toBe(true);
  });

  test('failed cover upload never fails publish', async () => {
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Document\n\nContent.\n');

    const deps = makeTestDeps(fakeFetch(false));
    const result = await publish({ path: filePath }, deps);

    expect(renderCoverCalls).toBe(1);
    expect(coverRequests.length).toBe(1);
    expect(result.cover.status).toBe('skipped');
    if (result.cover.status === 'skipped') {
      expect(result.cover.reason).toBe('service_unsupported');
    }

    const state = await loadPublishState(result.relic_id);
    expect(state).toBeDefined();
    expect(state?.cover_uploaded).toBe(false);
  });
});

describe('republish duplicate gate table (five rows)', () => {
  let scratch: string;
  let renderCoverCalls: number;
  let coverRequests: string[];

  const validPng = makeValidPng();

  function fakeFetch(): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/comments')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/republish')) {
        return new Response(
          JSON.stringify({
            upload_url: `${SERVICE}/storage/upload`,
            report_url: `${SERVICE}/report`,
            disclosure_url: `${SERVICE}/policy`,
            relic_expires_at: null,
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/storage/upload')) {
        return new Response(null, { status: 200 });
      }
      if (url.includes('/complete')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/cover')) {
        coverRequests.push(url);
        return new Response(
          JSON.stringify({
            cover_url: `${SERVICE}/relic/cover/sha2.png`,
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;
  }

  function makeTestDeps(renderOutcome?: CoverOutcome): PublishDeps {
    return {
      serviceOrigin: SERVICE,
      relicOrigin: SERVICE,
      files: nodeFiles,
      fetch: fakeFetch(),
      upload: fetchUpload,
      clientName: 'test',
      renderCover: async () => {
        renderCoverCalls++;
        return (
          renderOutcome ?? {
            status: 'rendered',
            kind: 'markdown',
            type: 'image/png',
            bytes: validPng,
          }
        );
      },
    };
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cover-gate-test-'));
    process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');
    renderCoverCalls = 0;
    coverRequests = [];
  });

  afterEach(async () => {
    delete process.env['RELIC_PUBLISH_STATE'];
    await rm(scratch, { recursive: true, force: true });
  });

  async function seedState(
    relicId: string,
    contentSha256: string,
    coverUploaded: boolean
  ): Promise<void> {
    await savePublishState(relicId, {
      key: 'AAAAAAAAAAAAAAAAAAAAAA',
      publish_token: 'tok123',
      version: 1,
      filename: 'doc.md',
      content_sha256: contentSha256,
      published_at: new Date().toISOString(),
      expires_at: null,
      cover_uploaded: coverUploaded,
    });
  }

  test('Row 1: !same -> proceeds normally', async () => {
    const relicId = 'relicaaaaaaaaaaaaaaaaaaaaa';
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Version Two\n');

    await seedState(
      relicId,
      '0000000000000000000000000000000000000000000000000000000000000000',
      false
    );

    const deps = makeTestDeps();
    const result = await republish({ relic_id: relicId, path: filePath }, deps);
    expect(result.version).toBe(2);
  });

  test('Row 2: same && !requested && !previous -> duplicate_version', async () => {
    const relicId = 'relicaaaaaaaaaaaaaaaaaaaaa';
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Same Content\n');

    const deps = makeTestDeps();
    // Real digest
    const digest = await contentDigest({
      content: new TextEncoder().encode('# Same Content\n'),
      filename: 'doc.md',
      title: 'doc.md',
    });

    await seedState(relicId, digest, false);

    await expect(
      republish({ relic_id: relicId, path: filePath, cover: false }, deps)
    ).rejects.toThrow(PublishError);
  });

  test('Row 3: same && !requested && previous -> proceed (removes the cover)', async () => {
    const relicId = 'relicaaaaaaaaaaaaaaaaaaaaa';
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Same Content\n');

    const deps = makeTestDeps();
    const digest = await contentDigest({
      content: new TextEncoder().encode('# Same Content\n'),
      filename: 'doc.md',
      title: 'doc.md',
    });

    // previously had cover_uploaded: true
    await seedState(relicId, digest, true);

    const result = await republish(
      { relic_id: relicId, path: filePath, cover: false },
      deps
    );

    expect(result.version).toBe(2);
    expect(result.cover).toEqual({ status: 'declined' });
    expect(renderCoverCalls).toBe(0);
    expect(coverRequests.length).toBe(0);

    const state = await loadPublishState(relicId);
    expect(state?.cover_uploaded).toBe(false);
  });

  test('Row 4: same && requested && previous -> duplicate_version', async () => {
    const relicId = 'relicaaaaaaaaaaaaaaaaaaaaa';
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Same Content\n');

    const deps = makeTestDeps();
    const digest = await contentDigest({
      content: new TextEncoder().encode('# Same Content\n'),
      filename: 'doc.md',
      title: 'doc.md',
    });

    // previously had cover_uploaded: true, now requested cover: true
    await seedState(relicId, digest, true);

    await expect(
      republish({ relic_id: relicId, path: filePath, cover: true }, deps)
    ).rejects.toThrow(PublishError);
  });

  test('Row 5a: same && requested && !previous with rendered outcome -> proceed (adds cover)', async () => {
    const relicId = 'relicaaaaaaaaaaaaaaaaaaaaa';
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Same Content\n');

    const deps = makeTestDeps();
    const digest = await contentDigest({
      content: new TextEncoder().encode('# Same Content\n'),
      filename: 'doc.md',
      title: 'doc.md',
    });

    // previously had cover_uploaded: false, now requested cover: true
    await seedState(relicId, digest, false);

    const result = await republish(
      { relic_id: relicId, path: filePath, cover: true },
      deps
    );

    expect(result.version).toBe(2);
    expect(result.cover.status).toBe('uploaded');
    expect(renderCoverCalls).toBe(1);
    expect(coverRequests.length).toBe(1);

    const state = await loadPublishState(relicId);
    expect(state?.cover_uploaded).toBe(true);
  });

  test('Row 5b: same && requested && !previous with skipped outcome -> duplicate_version with detail', async () => {
    const relicId = 'relicaaaaaaaaaaaaaaaaaaaaa';
    const filePath = join(scratch, 'doc.md');
    await writeFile(filePath, '# Same Content\n');

    const deps = makeTestDeps({
      status: 'skipped',
      reason: 'browser_not_found',
      detail: 'no local Chrome found',
    });
    const digest = await contentDigest({
      content: new TextEncoder().encode('# Same Content\n'),
      filename: 'doc.md',
      title: 'doc.md',
    });

    await seedState(relicId, digest, false);

    try {
      await republish({ relic_id: relicId, path: filePath, cover: true }, deps);
      expect.unreachable('should have thrown duplicate_version');
    } catch (error) {
      expect(error instanceof PublishError).toBe(true);
      const pubError = error as PublishError;
      expect(pubError.code).toBe('duplicate_version');
      expect(pubError.message).toContain(
        'and no cover could be rendered: no local Chrome found'
      );
    }
  });
});

describe('state validation of cover_uploaded', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cover-state-val-'));
    process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');
  });

  afterEach(async () => {
    delete process.env['RELIC_PUBLISH_STATE'];
    await rm(scratch, { recursive: true, force: true });
  });

  test('accepts boolean and undefined, rejects non-boolean values', async () => {
    const stateFile = join(scratch, 'state.json');
    const validRow = {
      key: 'AAAAAAAAAAAAAAAAAAAAAA',
      publish_token: 'token123',
      version: 1,
      cover_uploaded: true,
    };
    await writeFile(
      stateFile,
      JSON.stringify({
        relics: {
          validrelic1: validRow,
          validrelic2: { ...validRow, cover_uploaded: false },
          validrelic3: { ...validRow, cover_uploaded: undefined },
        },
      })
    );

    const s1 = await loadPublishState('validrelic1');
    expect(s1?.cover_uploaded).toBe(true);

    const s2 = await loadPublishState('validrelic2');
    expect(s2?.cover_uploaded).toBe(false);

    const s3 = await loadPublishState('validrelic3');
    expect(s3?.cover_uploaded).toBeUndefined();

    // Now write an invalid non-boolean value
    await writeFile(
      stateFile,
      JSON.stringify({
        relics: {
          badrelic: { ...validRow, cover_uploaded: 'yes' },
        },
      })
    );

    await expect(loadPublishState('badrelic')).rejects.toThrow(
      'holds a malformed entry for relic badrelic'
    );

    const inventory = await loadPublishInventory();
    expect(inventory.malformed).toContain('badrelic');
  });
});

describe('server result text formatting for cover', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cover-server-text-'));
    process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');
  });

  afterEach(async () => {
    delete process.env['RELIC_PUBLISH_STATE'];
    await rm(scratch, { recursive: true, force: true });
  });

  function makeServerDeps(outcome: CoverOutcome): PublishDeps {
    return {
      serviceOrigin: SERVICE,
      relicOrigin: SERVICE,
      files: nodeFiles,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/challenge')) {
          return new Response(
            JSON.stringify({
              challenge_nonce: 'nonce1',
              size_limit_bytes: 10_000_000,
              size_basis: 'bytes',
            }),
            { status: 200 }
          );
        }
        if (url.endsWith('/api/grant')) {
          return new Response(
            JSON.stringify({
              upload_url: `${SERVICE}/storage/upload`,
              publish_token: 'pubtoken123',
              report_url: `${SERVICE}/report`,
              disclosure_url: `${SERVICE}/policy`,
              relic_expires_at: null,
            }),
            { status: 200 }
          );
        }
        if (url.endsWith('/storage/upload') || url.includes('/complete')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes('/cover')) {
          return new Response(
            JSON.stringify({
              cover_url: `${SERVICE}/relic/cover/abc.png`,
            }),
            { status: 200 }
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof globalThis.fetch,
      upload: fetchUpload,
      clientName: 'test',
      renderCover: async () => outcome,
    };
  }

  test('uploaded cover produces exact disclosure phrase in text', async () => {
    const docPath = join(scratch, 'doc.md');
    await writeFile(docPath, '# Hello World\n');

    const validPng = makeValidPng();
    const deps = makeServerDeps({
      status: 'rendered',
      kind: 'markdown',
      type: 'image/png',
      bytes: validPng,
    });

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'relic_publish',
          arguments: { path: docPath },
        },
      },
      deps
    );

    const result = response?.result as {
      content: { text: string }[];
      structuredContent: { cover: CoverReport };
    };
    expect(result.structuredContent.cover.status).toBe('uploaded');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(
      'Cover image: uploaded. Link previews now show the top of the rendered document. It is NOT encrypted: the service and anyone holding the link, even without the key, can see it. Republish with cover: false to remove it.'
    );
  });

  test('declined cover produces exact decline phrase in text', async () => {
    const docPath = join(scratch, 'doc.md');
    await writeFile(docPath, '# Hello World\n');

    const deps = makeServerDeps({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'declined',
    });

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'relic_publish',
          arguments: { path: docPath, cover: false },
        },
      },
      deps
    );

    const result = response?.result as {
      content: { text: string }[];
      structuredContent: { cover: CoverReport };
    };
    expect(result.structuredContent.cover.status).toBe('declined');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(
      'Cover image: none, as asked. Link previews show the generic Relic card.'
    );
  });

  test('skipped cover produces exact detail phrase in text', async () => {
    const docPath = join(scratch, 'doc.md');
    await writeFile(docPath, '# Hello World\n');

    const deps = makeServerDeps({
      status: 'skipped',
      reason: 'ffmpeg_not_found',
      detail: 'ffmpeg is needed to depict audio and video and was not found.',
    });

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'relic_publish',
          arguments: { path: docPath },
        },
      },
      deps
    );

    const result = response?.result as {
      content: { text: string }[];
      structuredContent: { cover: CoverReport };
    };
    expect(result.structuredContent.cover.status).toBe('skipped');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(
      'Cover image: none. ffmpeg is needed to depict audio and video and was not found. Link previews show the generic Relic card.'
    );
  });
});
