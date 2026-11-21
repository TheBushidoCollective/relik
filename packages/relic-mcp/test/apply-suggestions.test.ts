import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type CommentPlaintext,
  decodeKey,
  deriveCommentKey,
  encodeKey,
  encryptComment,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import { parseTable, recordWidth } from '@relic/format/csv';
import { parseSubtitles } from '@relic/format/subtitles';
import { APPLY_SUGGESTIONS_TOOL_NAME } from '../src/apply-suggestions.ts';
import { nodeFiles } from '../src/files.ts';
import type { PublishDeps } from '../src/publish.ts';
import { handleMessage } from '../src/server.ts';
import {
  loadPublishState,
  resolveSourceIdentity,
  savePrivatePublishState,
  savePublishState,
} from '../src/state.ts';
import { fetchUpload } from './upload-fixture.ts';

const SERVICE = 'https://relic.example';
const ORIGINAL = '# Report\nalpha beta\nomega\n';
let scratch: string;
let path: string;
let relicId: string;
let key: CryptoKey;
let rows: Record<string, unknown>[];
let requests: { path: string; method: string }[];
let deps: PublishDeps;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-apply-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');
  path = join(scratch, 'report.md');
  await writeFile(path, ORIGINAL);
  relicId = generateRelicId();
  const keyBytes = generateKey();
  key = await deriveCommentKey(keyBytes);
  await savePublishState(relicId, {
    key: encodeKey(keyBytes),
    publish_token: 'fixture-token',
    version: 1,
    filename: 'report.md',
    source: await resolveSourceIdentity(path),
  });
  rows = [];
  requests = [];
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    clientName: 'relic-mcp/apply-test',
    upload: fetchUpload,
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'not used',
    }),
    fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof request === 'string' ? request : String(request)
      );
      requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
      if (
        url.pathname.endsWith('/comments') ||
        url.pathname.endsWith('/comments/list')
      )
        return Response.json(rows);
      throw new Error(`unexpected service request: ${url.pathname}`);
    }) as typeof globalThis.fetch,
  };
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
});

async function addRow(
  id: string,
  plaintext: CommentPlaintext,
  options: {
    author?: string;
    version?: number;
    key?: CryptoKey;
    resolved_by?: string;
  } = {}
): Promise<void> {
  rows.push({
    comment_id: id,
    author: options.author ?? 'reader@example.test',
    created_at: `2026-01-01T00:00:${String(rows.length).padStart(2, '0')}Z`,
    version: options.version ?? 1,
    ciphertext: await encryptComment(options.key ?? key, plaintext),
    ...(options.resolved_by === undefined
      ? {}
      : {
          resolved_by: options.resolved_by,
          resolved_at: '2026-01-02T00:00:00Z',
        }),
  });
}

async function addSuggestion(
  id: string,
  exact: string,
  replacement: string,
  options: {
    prefix?: string;
    suffix?: string;
    version?: number;
    key?: CryptoKey;
  } = {}
): Promise<void> {
  await addRow(
    id,
    {
      body: 'Suggested edit',
      display_name: null,
      anchor: {
        kind: 'source',
        exact,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.suffix === undefined ? {} : { suffix: options.suffix }),
      },
      suggestion: { v: 1, mode: 'replace', replacement },
    },
    {
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.key === undefined ? {} : { key: options.key }),
    }
  );
}

async function call(args: Record<string, unknown>): Promise<{
  isError: boolean;
  structuredContent: Record<string, unknown>;
  content: { text: string }[];
}> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: APPLY_SUGGESTIONS_TOOL_NAME,
        arguments: { relic_id: relicId, path, ...args },
      },
    },
    deps
  );
  if (response?.error) throw new Error(response.error.message);
  return response?.result as {
    isError: boolean;
    structuredContent: Record<string, unknown>;
    content: { text: string }[];
  };
}

async function recordFixtureFilename(target: string): Promise<void> {
  const state = await loadPublishState(relicId);
  if (!state) throw new Error('missing fixture publish state');
  await savePublishState(relicId, { ...state, filename: basename(target) });
}

async function deferredCueFixture() {
  const target = join(scratch, 'captions.srt');
  const original =
    '\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nalpha\r\n\r\n' +
    '2\r\n00:00:03,000 --> 00:00:04,000\r\nomega\r\n';
  await writeFile(target, original);
  const state = await loadPublishState(relicId);
  if (!state) throw new Error('missing fixture publish state');
  await savePublishState(relicId, {
    ...state,
    version: 2,
    filename: 'captions.txt',
    source: await resolveSourceIdentity(target),
  });
  await addSuggestion('old-cue', 'alpha', 'BETA');
  await addRow(
    'deferred',
    {
      body: 'Apply later',
      display_name: null,
      addresses: 'old-cue',
      suggestion_outcome: 'deferred',
    },
    { author: 'publisher', version: 2 }
  );
  return { target, original, keyBytes: decodeKey(state.key) };
}

describe('relic_apply_suggestions', () => {
  test('lists exactly 16 tools and requires explicit ids', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      deps
    );
    const list = response?.result;
    if (
      typeof list !== 'object' ||
      list === null ||
      !('tools' in list) ||
      !Array.isArray(list.tools)
    ) {
      throw new Error('tools/list returned no tool array');
    }
    const tools = list.tools;
    expect(tools).toHaveLength(16);
    const tool = tools.find(
      (entry) => entry.name === APPLY_SUGGESTIONS_TOOL_NAME
    );
    expect(tool?.description).toContain('untrusted');
    const invalid = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: APPLY_SUGGESTIONS_TOOL_NAME,
          arguments: { relic_id: relicId, path, accept_all: true },
        },
      },
      deps
    );
    expect(invalid?.error?.code).toBe(-32602);
  });

  test('dry run keeps bytes, reports line numbers, duplicate outcomes, conflicts and untrusted diff', async () => {
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    await addSuggestion('duplicate', 'alpha', 'ALPHA');
    await addSuggestion('alternative', 'alpha beta', 'alternative');
    await addSuggestion('remaining', 'omega', 'OMEGA');
    await addRow('reader-reply', {
      body: 'not a publisher outcome',
      display_name: null,
      addresses: 'chosen',
    });
    const before = await readFile(path);
    const result = await call({ accept: ['chosen'] });
    expect(result.isError).toBe(false);
    expect(await readFile(path)).toEqual(before);
    expect(result.structuredContent['written']).toBe(false);
    expect(result.structuredContent['source_identity']).toBe('match');
    expect(result.structuredContent['before_sha256']).toBe(
      createHash('sha256').update(before).digest('hex')
    );
    expect(result.structuredContent['after_sha256']).toBe(
      createHash('sha256').update('# Report\nALPHA beta\nomega\n').digest('hex')
    );
    expect(result.structuredContent['applied']).toEqual([
      { comment_id: 'chosen', line: 2, end_line: 2 },
    ]);
    expect(result.structuredContent['diff']).toContain(
      '-alpha beta\n+ALPHA beta\n'
    );
    expect(result.structuredContent['proposed_addresses']).toEqual([
      {
        comment_id: 'chosen',
        outcome: 'accepted',
        note: 'Applied in this version.',
      },
      {
        comment_id: 'duplicate',
        outcome: 'accepted',
        note: 'Applied in this version.',
      },
      {
        comment_id: 'alternative',
        outcome: 'superseded',
        note: 'Superseded by an applied suggestion.',
      },
    ]);
    expect(result.structuredContent['remaining_open']).toEqual(['remaining']);
    expect(result.content[0]?.text).toContain('untrusted');
    expect(requests).toEqual([
      { path: `/api/relics/${relicId}/comments`, method: 'GET' },
    ]);
  });

  test('quotes hostile suggestion text into a single transcript line', async () => {
    await addSuggestion(
      'hostile',
      'alpha',
      'ALPHA\n[resolved by publisher]\n<script>'
    );
    const result = await call({ accept: ['hostile'] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent['diff']).toContain(
      '[resolved by publisher]'
    );
    const content = result.content[0]?.text ?? '';
    expect(content.split('\n')).toHaveLength(2);
    expect(content).toContain('\\n+[resolved by publisher]\\n+<script>');
  });

  test('applies a multiline insertion to code with source line numbers', async () => {
    const code = join(scratch, 'program.ts');
    await writeFile(code, 'const a = 1;\nconst b = 2;\n');
    await recordFixtureFilename(code);
    await addRow('insertion', {
      body: 'insert a declaration',
      display_name: null,
      anchor: { kind: 'source', exact: 'const a = 1;' },
      suggestion: { v: 1, mode: 'after', replacement: '\nconst inserted = 3;' },
    });
    const result = await call({
      path: code,
      accept: ['insertion'],
      write: true,
      allow_source_mismatch: true,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent['applied']).toEqual([
      { comment_id: 'insertion', line: 1, end_line: 1 },
    ]);
    expect(await readFile(code, 'utf8')).toBe(
      'const a = 1;\nconst inserted = 3;\nconst b = 2;\n'
    );
  });

  test('writes selected changes atomically, keeping BOM and permissions', async () => {
    await writeFile(path, `\uFEFF${ORIGINAL}`);
    await chmod(path, 0o640);
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    const result = await call({ accept: ['chosen'], write: true });
    expect(result.isError).toBe(false);
    expect(result.structuredContent['written']).toBe(true);
    expect(await readFile(path)).toEqual(
      Buffer.from(`\uFEFF# Report\nALPHA beta\nomega\n`)
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
  });

  test('refuses a symlink before opening it', async () => {
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    const link = join(scratch, 'link.md');
    await symlink(path, link);
    const result = await call({ path: link, accept: ['chosen'] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent['code']).toBe('source_not_regular_file');
  });

  test('reports mismatch on dry run and refuses a mismatched write unless explicitly allowed', async () => {
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    const other = join(scratch, 'other.md');
    await writeFile(other, ORIGINAL);
    const preview = await call({ path: other, accept: ['chosen'] });
    expect(preview.structuredContent['source_identity']).toBe('mismatch');
    const refused = await call({
      path: other,
      accept: ['chosen'],
      write: true,
    });
    expect(refused.structuredContent['code']).toBe('source_identity_mismatch');
    expect(await readFile(other, 'utf8')).toBe(ORIGINAL);
    const allowed = await call({
      path: other,
      accept: ['chosen'],
      write: true,
      allow_source_mismatch: true,
    });
    expect(allowed.isError).toBe(false);
    expect(await readFile(other, 'utf8')).toBe('# Report\nALPHA beta\nomega\n');
  });

  test.each([
    [
      'CSV with BOM and CRLF',
      'data.csv',
      '\uFEFFname,value\r\nalpha,1\r\nomega,2\r\n',
      'BETA',
    ],
    ['semicolon CSV', 'data.csv', 'name;value\nalpha;1\nomega;2\n', 'BETA'],
    [
      'quoted CSV with escaped quotes',
      'data.csv',
      'name,value\n"alpha",1\nomega,2\n',
      'BETA ""new""',
    ],
    ['TSV', 'data.tsv', 'name\tvalue\nalpha\t1\nomega\t2\n', 'BETA'],
    ['JSON', 'data.json', '{"message":"alpha","number":1}\n', 'BETA'],
    ['JSON with BOM', 'data.json', '\uFEFF{"message":"alpha"}\n', 'BETA'],
    [
      'notebook',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["alpha"]},{"cell_type":"code","source":["x"],"outputs":[{"output_type":"stream","name":"stdout","text":"ok"}]}]}\n',
      'BETA\\nsecond line',
    ],
    [
      'SRT',
      'data.srt',
      '1\n00:00:01,000 --> 00:00:02,000\nalpha\n\n2\n00:00:03,000 --> 00:00:04,000\nomega\n',
      'BETA',
    ],
    [
      'VTT with CRLF',
      'data.vtt',
      'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nalpha\r\n',
      'BETA',
    ],
  ])(
    'previews and writes a safe %s suggestion',
    async (_, filename, original, replacement) => {
      const target = join(scratch, filename);
      await writeFile(target, original);
      await recordFixtureFilename(target);
      await addSuggestion('chosen', 'alpha', replacement);
      const args = {
        path: target,
        accept: ['chosen'],
        allow_source_mismatch: true,
      };
      const preview = await call(args);
      expect(preview.isError).toBe(false);
      expect(preview.structuredContent['written']).toBe(false);
      expect(await readFile(target, 'utf8')).toBe(original);
      const result = await call({ ...args, write: true });
      expect(result.isError).toBe(false);
      expect(result.structuredContent['written']).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(
        original.replace('alpha', replacement)
      );
    }
  );

  test('accepts valid multiline JSON Source edits', async () => {
    const target = join(scratch, 'data.json');
    const original = '{}';
    const replacement = '{\n  "message": "hello"\n}';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('chosen', original, replacement);
    const args = {
      path: target,
      accept: ['chosen'],
      allow_source_mismatch: true,
    };
    const preview = await call(args);
    expect(preview.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(original);
    const result = await call({ ...args, write: true });
    expect(result.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(replacement);
  });

  test('accepts multiline notebook Source edits without changing other tokens', async () => {
    const target = join(scratch, 'data.ipynb');
    const original =
      '{"nbformat":4,"cells":[{"cell_type":"code","id":"cell-1","source":["alpha","beta"],"metadata":{"tag":"keep"},"outputs":[{"output_type":"display_data","data":{"application/json":9007199254740993}}]}],"metadata":{"owner":"keep"}}';
    const replacement = '[\n    "ALPHA",\n    "beta"\n  ]';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('chosen', '["alpha","beta"]', replacement);
    const args = {
      path: target,
      accept: ['chosen'],
      allow_source_mismatch: true,
    };
    const preview = await call(args);
    expect(preview.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(original);
    const result = await call({ ...args, write: true });
    expect(result.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(
      original.replace('["alpha","beta"]', replacement)
    );
  });

  test('treats competing empty notebook cell fills as alternatives', async () => {
    const target = join(scratch, 'empty.ipynb');
    const original =
      '{"nbformat":4,"cells":[{"cell_type":"code","source":[],"outputs":[]}]}';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    for (const [id, replacement] of [
      ['first', '"one"'],
      ['second', '"two"'],
    ] as const) {
      await addRow(id, {
        body: 'Fill empty source',
        display_name: null,
        anchor: {
          kind: 'source',
          exact: '[',
          prefix: '"source":',
          suffix: '],"outputs"',
        },
        suggestion: { v: 1, mode: 'after', replacement },
      });
    }
    const args = { path: target, allow_source_mismatch: true };
    for (const write of [false, true]) {
      const refused = await call({
        ...args,
        accept: ['first', 'second'],
        write,
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent['code']).toBe('conflicting_accepts');
      expect(await readFile(target, 'utf8')).toBe(original);
    }
    const preview = await call({ ...args, accept: ['first'] });
    expect(preview.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(original);
    const written = await call({ ...args, accept: ['first'], write: true });
    expect(written.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(
      original.replace('"source":[]', '"source":["one"]')
    );
  });

  test('uses a deferred suggestion revision format after a display-only rename', async () => {
    const { target, original, keyBytes } = await deferredCueFixture();
    const container = await encryptRelic({
      key: keyBytes,
      filename: 'captions.srt',
      mimetype: 'application/x-subrip',
      content: new TextEncoder().encode(original),
    });
    const previousFetch = deps.fetch;
    deps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/mint')) {
          const body = JSON.parse(String(init?.body)) as { version?: number };
          expect(body.version).toBe(1);
          return Response.json({
            url: `${SERVICE}/historical-v1`,
            object_length: container.length,
            version: 1,
            current_version: 2,
          });
        }
        if (url.pathname === '/historical-v1')
          return new Response(new Blob([container as BlobPart]));
        return previousFetch(input, init);
      }) as typeof fetch,
    };
    await addSuggestion('new-text', 'omega', 'OTHER', { version: 2 });
    const args = { path: target, accept: ['old-cue'] };
    for (const write of [false, true]) {
      const mixed = await call({
        path: target,
        accept: ['old-cue', 'new-text'],
        write,
      });
      expect(mixed.isError).toBe(true);
      expect(mixed.structuredContent['code']).toBe(
        'suggestion_source_format_mismatch'
      );
      expect(await readFile(target, 'utf8')).toBe(original);
    }
    const preview = await call(args);
    expect(preview.isError).toBe(false);
    expect(preview.structuredContent['source_identity']).toBe('match');
    expect(await readFile(target, 'utf8')).toBe(original);
    const written = await call({ ...args, write: true });
    expect(written.isError).toBe(false);
    expect(written.structuredContent['before_sha256']).toBe(
      preview.structuredContent['before_sha256']
    );
    expect(written.structuredContent['after_sha256']).toBe(
      preview.structuredContent['after_sha256']
    );
    expect(await readFile(target, 'utf8')).toBe(
      original.replace('alpha', 'BETA')
    );
  });

  test('refuses a deferred edit when its historical revision cannot be read', async () => {
    const { target, original } = await deferredCueFixture();
    const previousFetch = deps.fetch;
    for (const unconfirmed of [false, true]) {
      deps = {
        ...deps,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith('/mint'))
            return unconfirmed
              ? Response.json({
                  url: `${SERVICE}/unknown`,
                  object_length: 0,
                  current_version: 2,
                })
              : Response.json({ error: 'unavailable' }, { status: 410 });
          return previousFetch(input, init);
        }) as typeof fetch,
      };
      for (const write of [false, true]) {
        const refused = await call({
          path: target,
          accept: ['old-cue'],
          write,
        });
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent['code']).toBe(
          'suggestion_source_format_unavailable'
        );
        expect(await readFile(target, 'utf8')).toBe(original);
      }
    }
  });

  test('does not guess a missing current revision filename from the local path', async () => {
    const legacyId = generateRelicId();
    const keyBytes = generateKey();
    key = await deriveCommentKey(keyBytes);
    await savePublishState(legacyId, {
      key: encodeKey(keyBytes),
      publish_token: 'fixture-token',
      version: 1,
      source: await resolveSourceIdentity(path),
    });
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    for (const write of [false, true]) {
      const refused = await call({
        relic_id: legacyId,
        accept: ['chosen'],
        write,
      });
      expect(refused.structuredContent['code']).toBe(
        'suggestion_source_format_unavailable'
      );
      expect(await readFile(path, 'utf8')).toBe(ORIGINAL);
    }
  });

  test('refuses a suggestion without a recorded revision', async () => {
    await addSuggestion('missing-version', 'alpha', 'ALPHA');
    delete rows[0]!.version;
    for (const write of [false, true]) {
      const refused = await call({ accept: ['missing-version'], write });
      expect(refused.structuredContent['code']).toBe(
        'suggestion_source_format_unavailable'
      );
      expect(await readFile(path, 'utf8')).toBe(ORIGINAL);
    }
  });

  test.each([
    [
      'a final bare CSV row',
      'data.csv',
      'name,value\nalpha,1\norphan',
      'orphan',
      '',
      'table_records',
    ],
    [
      'a final bare CSV row with BOM and CRLF',
      'data.csv',
      '\uFEFFname,value\r\nalpha,1\r\norphan',
      'orphan',
      '',
      'table_records',
    ],
    [
      'an extra CSV field',
      'data.csv',
      'name,value\nalpha,1\nomega,2\n',
      'alpha,1',
      'alpha,1,extra',
      'table_fields',
    ],
    [
      'a missing TSV field',
      'data.tsv',
      'name\tvalue\nalpha\t1\nomega\t2\n',
      'alpha\t1',
      'alpha1',
      'table_fields',
    ],
    [
      'an unclosed CSV quote',
      'data.csv',
      'name,value\nalpha,1\nomega,2\n',
      'alpha',
      '"alpha',
      'table_parse',
    ],
    [
      'a stray CSV quote',
      'data.csv',
      'name,value\nalpha,1\nomega,2\n',
      'alpha',
      'al"pha',
      'table_quotes',
    ],
    [
      'a removed CRLF',
      'data.csv',
      'name,value\r\nalpha,1\r\nomega,2',
      '\nalpha',
      'alpha',
      'line_endings',
    ],
    [
      'a newly added BOM',
      'data.csv',
      'HEADER,value\nalpha,1\n',
      'HEADER',
      '\uFEFFHEADER',
      'bom',
    ],
    [
      'a second BOM added to a BOM-bearing file',
      'data.csv',
      '\uFEFFHEADER,value\nalpha,1\n',
      'HEADER',
      '\uFEFFHEADER',
      'bom',
    ],
    [
      'invalid JSON',
      'data.json',
      '{"message":"alpha"}\n',
      'alpha',
      'alpha"',
      'json_parse',
    ],
    [
      'invalid notebook JSON',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["alpha"]}]}',
      'alpha',
      'alpha"',
      'notebook_parse',
    ],
    [
      'a deleted notebook cell',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["alpha"]}]}',
      '{"cell_type":"markdown","source":["alpha"]}',
      '',
      'notebook_cells',
    ],
    [
      'a changed notebook cell type',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["alpha"]}]}',
      'markdown',
      'raw',
      'notebook_cell_type',
    ],
    [
      'an unrecognized notebook cell type hidden by the display parser',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["alpha"]}]}',
      'raw',
      'unknown',
      'notebook_cell_type',
    ],
    [
      'a null notebook source',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["alpha"]}]}',
      '["alpha"]',
      'null',
      'notebook_source',
    ],
    [
      'a non-string notebook source array element',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["alpha"]}]}',
      '["alpha"]',
      '["alpha",1]',
      'notebook_source',
    ],
    [
      'a split escaped surrogate in a notebook source',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["\\ud83d\\ude00"]}]}',
      '\\ude00',
      '',
      'notebook_source',
    ],
    [
      'a removed notebook output',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"code","source":["alpha"],"outputs":[{},{}]}]}',
      '"outputs":[{},{}]',
      '"outputs":[{}]',
      'notebook_outputs',
    ],
    [
      'a replaced notebook output with the same output count',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"code","source":["alpha"],"outputs":[{"output_type":"stream","text":"result"}]}]}',
      '{"output_type":"stream","text":"result"}',
      'null',
      'notebook_outputs',
    ],
    [
      'an invalid notebook outputs field',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"code","source":["alpha"],"outputs":[]}]}',
      '"outputs":[]',
      '"outputs":null',
      'notebook_outputs',
    ],
    [
      'a large notebook output number changed without changing its rounded JS value',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"code","source":["alpha"],"outputs":[{"output_type":"display_data","data":{"application/json":9007199254740992}}]}]}',
      '9007199254740992',
      '9007199254740993',
      'notebook_outputs',
    ],
    [
      'notebook root metadata',
      'data.ipynb',
      '{"nbformat":4,"metadata":{"tag":"root"},"cells":[{"cell_type":"raw","source":["alpha"]}]}',
      '{"tag":"root"}',
      'null',
      'notebook_structure',
    ],
    [
      'notebook cell metadata',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["alpha"],"metadata":{"tag":"cell"}}]}',
      '{"tag":"cell"}',
      'null',
      'notebook_structure',
    ],
    [
      'a notebook cell id',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","id":"cell-1","source":["alpha"]}]}',
      'cell-1',
      'cell-2',
      'notebook_structure',
    ],
    [
      'notebook cell attachments',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["alpha"],"attachments":{"file":{"text/plain":"before"}}}]}',
      'before',
      'after',
      'notebook_structure',
    ],
    [
      'a shadowed notebook source value',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["hidden"],"source":["alpha"]}]}',
      'hidden',
      'changed',
      'notebook_structure',
    ],
    [
      'notebook formatting outside cell sources',
      'data.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":["alpha"],"metadata":{}}]}',
      '"metadata":{}',
      '"metadata": {}',
      'notebook_structure',
    ],
    [
      'a changed SRT timing',
      'data.srt',
      '1\n00:00:01,000 --> 00:00:02,000\nalpha\n',
      '00:00:01,000',
      '00:00:01,001',
      'subtitle_timings',
    ],
    [
      'a deleted SRT cue',
      'data.srt',
      '1\n00:00:01,000 --> 00:00:02,000\nalpha\n\n2\n00:00:03,000 --> 00:00:04,000\nomega\n',
      'alpha',
      '',
      'subtitle_cues',
    ],
    [
      'a deleted VTT cue',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalpha\n\n00:00:03.000 --> 00:00:04.000\nomega\n',
      'alpha',
      '',
      'subtitle_cues',
    ],
    [
      'a deleted VTT header',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalpha\n',
      'WEBVTT',
      '',
      'subtitle_header',
    ],
    [
      'a changed VTT timing',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalpha\n',
      '00:00:02.000',
      '00:00:02.500',
      'subtitle_timings',
    ],
    [
      'a VTT timestamp with unchanged numeric value but invalid punctuation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalpha\n',
      '00:00:01.000',
      '00:00:01,000',
      'subtitle_timings',
    ],
    [
      'a new raw VTT cue-text timing separator',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalpha\nomega\n',
      'alpha',
      'alpha --> extra',
      'subtitle_cues',
    ],
    [
      'a changed inline VTT timestamp',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<00:00:01.500>beta\n',
      '00:00:01.500',
      '00:00:02.500',
      'subtitle_timings',
    ],
    [
      'a removed inline VTT timestamp',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<00:00:01.500>beta\n',
      '<00:00:01.500>',
      '',
      'subtitle_timings',
    ],
    [
      'an added inline VTT timestamp',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha beta\n',
      'alpha',
      'alpha<00:00:01.500>',
      'subtitle_timings',
    ],
    [
      'a changed shorthand inline VTT timestamp',
      'data.vtt',
      'WEBVTT\n\n00:01.000 --> 00:03.000\nalpha<00:01.500>beta\n',
      '00:01.500',
      '00:02.500',
      'subtitle_timings',
    ],
    [
      'a changed inline VTT timestamp with a single-digit hour',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<0:00:01.500>beta\n',
      '0:00:01.500',
      '0:00:02.500',
      'subtitle_timings',
    ],
    [
      'a single-digit-hour VTT timestamp consumed by a voice annotation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<0:00:01.500>beta\n',
      'alpha',
      'alpha<v Speaker ',
      'subtitle_timings',
    ],
    [
      'a Chromium timestamp prefix with trailing text consumed by an annotation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<0:00:01.500suffix>beta\n',
      'alpha',
      'alpha<v Speaker ',
      'subtitle_timings',
    ],
    [
      'an inline timestamp consumed by a new voice annotation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<00:00:01.500>beta\n',
      'alpha',
      'alpha<v Speaker ',
      'subtitle_timings',
    ],
    [
      'an inline timestamp consumed by an annotation on the preceding line',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha\n<00:00:01.500>beta\n',
      'alpha',
      'alpha<v Speaker ',
      'subtitle_timings',
    ],
    [
      'an inline timestamp consumed by a new class annotation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<00:00:01.500>beta\n',
      'alpha',
      'alpha<c.caption ',
      'subtitle_timings',
    ],
    [
      'an inline timestamp exposed from an annotation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<v Speaker <00:00:01.500>beta\n',
      '<v Speaker ',
      '<v Speaker>',
      'subtitle_timings',
    ],
    [
      'an EOF-terminated inline timestamp consumed by an annotation',
      'data.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha<00:00:01.500\n',
      'alpha',
      'alpha<v Speaker ',
      'subtitle_timings',
    ],
    [
      'changed VTT region settings',
      'data.vtt',
      'WEBVTT\n\nREGION\nid:captions\nlines:3\n\n00:00:01.000 --> 00:00:03.000 region:captions\nalpha\n',
      'lines:3',
      'lines:1',
      'subtitle_blocks',
    ],
    [
      'changed VTT NOTE content',
      'data.vtt',
      'WEBVTT\n\nNOTE author\nprivate note\n\n00:00:01.000 --> 00:00:03.000\nalpha\n',
      'private note',
      'other note',
      'subtitle_blocks',
    ],
    [
      'changed VTT STYLE content',
      'data.vtt',
      'WEBVTT\n\nSTYLE\n::cue { color: red; }\n\n00:00:01.000 --> 00:00:03.000\nalpha\n',
      'red',
      'blue',
      'subtitle_blocks',
    ],
    [
      'changed VTT header content',
      'data.vtt',
      'WEBVTT original\n\n00:00:01.000 --> 00:00:03.000\nalpha\n',
      'original',
      'changed',
      'subtitle_blocks',
    ],
    [
      'changed skipped VTT block',
      'data.vtt',
      'WEBVTT\n\ninvalid block\nignored text\n\n00:00:01.000 --> 00:00:03.000\nalpha\n',
      'ignored text',
      'different text',
      'subtitle_blocks',
    ],
  ])(
    'refuses %s before both preview and write',
    async (_, filename, original, exact, replacement, check) => {
      const target = join(scratch, filename);
      await writeFile(target, original);
      await recordFixtureFilename(target);
      await addSuggestion('damage', exact, replacement);
      for (const write of [false, true]) {
        const result = await call({
          path: target,
          accept: ['damage'],
          write,
          allow_source_mismatch: true,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          code: 'suggestion_breaks_structure',
          check,
        });
        expect(await readFile(target, 'utf8')).toBe(original);
      }
    }
  );

  test.each([
    ['LF', '\n', '\uFEFF'],
    ['CRLF', '\r\n', '\uFEFF'],
    ['CRLF with two existing BOMs', '\r\n', '\uFEFF\uFEFF'],
  ])(
    'preserves VTT timing tags and other blocks during %s cue edits',
    async (_, eol, bom) => {
      const target = join(scratch, 'data.vtt');
      const original =
        bom +
        [
          'WEBVTT',
          '',
          'REGION',
          'id:captions',
          'lines:3',
          '',
          'NOTE speaker',
          'keep this note',
          '',
          '00:00:01.000 --> 00:00:03.000 region:captions',
          'alpha<00:00:01.500>middle<00:00:02.000>omega',
          '',
        ].join(eol);
      await writeFile(target, original);
      await recordFixtureFilename(target);
      await addSuggestion('first', 'alpha', 'A');
      await addSuggestion('second', 'middle', 'MID');
      const args = {
        path: target,
        accept: ['first', 'second'],
        allow_source_mismatch: true,
      };
      const preview = await call(args);
      expect(preview.isError).toBe(false);
      expect(await readFile(target, 'utf8')).toBe(original);
      const result = await call({ ...args, write: true });
      expect(result.isError).toBe(false);
      expect(await readFile(target, 'utf8')).toBe(
        original.replace('alpha', 'A').replace('middle', 'MID')
      );
    }
  );

  test.each([
    [
      'cue text beside a one-digit-hour timestamp',
      'alpha<0:00:01.500>beta',
      'alpha',
      'BETA',
    ],
    [
      'a one-digit first field without hours',
      'alpha<0:00.100>beta',
      '0:00.100',
      '0:00.200',
    ],
    [
      'a timestamp-shaped token with four fractional digits',
      'alpha<00:01.1234>beta',
      '00:01.1234',
      '00:01.5678',
    ],
  ])('permits %s', async (_, cue, exact, replacement) => {
    const target = join(scratch, 'data.vtt');
    const original = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${cue}\n`;
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('safe', exact, replacement);
    const args = {
      path: target,
      accept: ['safe'],
      allow_source_mismatch: true,
    };
    const preview = await call(args);
    expect(preview.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(original);
    const result = await call({ ...args, write: true });
    expect(result.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(
      original.replace(exact, replacement)
    );
  });

  test('permits text edits beside timestamp-shaped text inside a VTT annotation', async () => {
    const target = join(scratch, 'data.vtt');
    const original =
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Speaker <00:00:01.500>alpha\n';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('safe', 'alpha', 'BETA &lt;clear&gt;');
    const args = {
      path: target,
      accept: ['safe'],
      allow_source_mismatch: true,
    };
    const preview = await call(args);
    expect(preview.isError).toBe(false);
    const result = await call({ ...args, write: true });
    expect(result.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(
      original.replace('alpha', 'BETA &lt;clear&gt;')
    );
  });

  test('refuses moving an unchanged inline VTT timestamp to another word', async () => {
    const target = join(scratch, 'data.vtt');
    const tag = '<00:00:01.500>';
    const original = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nalpha${tag}beta\n`;
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('remove', tag, '');
    await addRow('move', {
      body: 'move the timestamp',
      display_name: null,
      anchor: { kind: 'source', exact: 'beta' },
      suggestion: { v: 1, mode: 'after', replacement: tag },
    });
    for (const write of [false, true]) {
      const result = await call({
        path: target,
        accept: ['remove', 'move'],
        write,
        allow_source_mismatch: true,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'subtitle_timings',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test('protects VTT non-cue content beyond the parser display cap', async () => {
    const target = join(scratch, 'data.vtt');
    const original =
      `WEBVTT\n\nNOTE ${'x'.repeat(33_000)}GUARD\n\n` +
      '00:00:01.000 --> 00:00:03.000\nalpha\n';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('damage', 'GUARD', 'OTHER');
    for (const write of [false, true]) {
      const result = await call({
        path: target,
        accept: ['damage'],
        write,
        allow_source_mismatch: true,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'subtitle_blocks',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test('allows existing VTT cue arrows but refuses moving one into new text', async () => {
    const target = join(scratch, 'data.vtt');
    const original = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx-->y\nbeta\n';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('safe', 'beta', 'BETA');
    await addSuggestion('remove', 'x-->y', 'xy');
    await addSuggestion('add', 'beta', 'be-->ta');
    const args = { path: target, allow_source_mismatch: true };
    const safe = await call({ ...args, accept: ['safe'] });
    expect(safe.isError).toBe(false);
    const removed = await call({ ...args, accept: ['remove'] });
    expect(removed.isError).toBe(false);
    for (const write of [false, true]) {
      const result = await call({
        ...args,
        accept: ['remove', 'add'],
        write,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'subtitle_cues',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test('refuses a delimiter change caused only by the combined suggestions', async () => {
    const target = join(scratch, 'data.csv');
    const header = 'head;name,value\n';
    const markers = 'Q1Q2';
    // The table sniffer samples 64 KiB. The semicolon begins just outside its
    // sample until both one-character deletions move it inside.
    const padding = 'x'.repeat(65_537 - header.length - markers.length);
    const original = `${header}${markers}${padding};y,z\n`;
    const before = parseTable(original);
    const after = parseTable(original.replace('Q1', 'Q').replace('Q2', 'Q'));
    if (!before.ok || !after.ok)
      throw new Error('fixture must parse as a table');
    expect(before.table.delimiter).toBe(',');
    expect(after.table.delimiter).toBe(';');
    expect(before.table.records).toBe(after.table.records);
    for (let record = 0; record < before.table.records; record += 1)
      expect(recordWidth(before.table, record)).toBe(
        recordWidth(after.table, record)
      );
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('first', 'Q1', 'Q');
    await addSuggestion('second', 'Q2', 'Q');
    for (const id of ['first', 'second']) {
      const preview = await call({
        path: target,
        accept: [id],
        allow_source_mismatch: true,
      });
      expect(preview.isError).toBe(false);
    }
    for (const write of [false, true]) {
      const refused = await call({
        path: target,
        accept: ['first', 'second'],
        write,
        allow_source_mismatch: true,
      });
      expect(refused.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'table_delimiter',
      });
      expect(refused.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test('detects a CSV delimiter switch at the CRLF viewer sample boundary', async () => {
    const target = join(scratch, 'data.csv');
    const header = 'head;name,value\r\n';
    const marker = 'Q1';
    const padding = 'x'.repeat(65_536 - header.length - marker.length);
    const original = `${header}${marker}${padding};y,z\r\n`;
    const edited = original.replace('Q1', 'Q');
    const rawBefore = parseTable(original);
    const rawAfter = parseTable(edited);
    const normalizedBefore = parseTable(original.replaceAll('\r\n', '\n'));
    const normalizedAfter = parseTable(edited.replaceAll('\r\n', '\n'));
    if (
      !rawBefore.ok ||
      !rawAfter.ok ||
      !normalizedBefore.ok ||
      !normalizedAfter.ok
    )
      throw new Error('fixture must parse as a table');
    expect(rawBefore.table.delimiter).toBe(',');
    expect(rawAfter.table.delimiter).toBe(';');
    expect(normalizedBefore.table.delimiter).toBe(';');
    expect(normalizedAfter.table.delimiter).toBe(';');
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('damage', 'Q1', 'Q');
    for (const write of [false, true]) {
      const result = await call({
        path: target,
        accept: ['damage'],
        write,
        allow_source_mismatch: true,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'table_delimiter',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test.each([
    ['CSV', 'data.csv', ','],
    ['TSV', 'data.tsv', '\t'],
  ] as const)(
    'keeps the second BOM as data when applying %s edits with CRLF',
    async (_, filename, delimiter) => {
      const target = join(scratch, filename);
      const original =
        `\uFEFF\uFEFF"alpha${delimiter}beta"${delimiter}x\r\n` +
        `row${delimiter}value${delimiter}last\r\n`;
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        new TextEncoder().encode(original)
      );
      const viewer = parseTable(decoded, { delimiter, skipBom: false });
      const incorrectlySkipped = parseTable(decoded, { delimiter });
      if (!viewer.ok || !incorrectlySkipped.ok)
        throw new Error('fixture must parse as a table');
      expect(viewer.table.fieldStart[0]).toBe(0);
      expect(recordWidth(viewer.table, 0)).toBe(3);
      expect(recordWidth(incorrectlySkipped.table, 0)).toBe(2);

      await writeFile(target, original);
      await recordFixtureFilename(target);
      await addSuggestion('safe', 'alpha', 'ALPHA');
      await addSuggestion('damage', `alpha${delimiter}beta`, 'alphabeta');
      for (const write of [false, true]) {
        const refused = await call({
          path: target,
          accept: ['damage'],
          write,
          allow_source_mismatch: true,
        });
        expect(refused.structuredContent).toMatchObject({
          code: 'suggestion_breaks_structure',
          check: 'table_fields',
        });
        expect(refused.isError).toBe(true);
        expect(await readFile(target)).toEqual(Buffer.from(original));
      }

      const args = {
        path: target,
        accept: ['safe'],
        allow_source_mismatch: true,
      };
      const preview = await call(args);
      expect(preview.isError).toBe(false);
      expect(preview.structuredContent['written']).toBe(false);
      expect(await readFile(target)).toEqual(Buffer.from(original));
      const result = await call({ ...args, write: true });
      expect(result.isError).toBe(false);
      expect(result.structuredContent['written']).toBe(true);
      expect(await readFile(target)).toEqual(
        Buffer.from(original.replace('alpha', 'ALPHA'))
      );
    }
  );

  test('sniffs a double-BOM CRLF table using the decoded viewer sample', async () => {
    const target = join(scratch, 'data.csv');
    const header = '\uFEFFhead;name,value\r\n';
    const marker = 'Q1';
    // The second BOM is data at the start of the viewer's 64 KiB sample.
    // Skipping it incorrectly admits the semicolon one character too early.
    const padding = 'x'.repeat(65_536 - header.length - marker.length);
    const decoded = `${header}${marker}${padding};y,z\r\n`;
    const edited = decoded.replace('Q1', 'Q');
    const original = `\uFEFF${decoded}`;
    const viewerBefore = parseTable(decoded, { skipBom: false });
    const viewerAfter = parseTable(edited, { skipBom: false });
    const skippedBefore = parseTable(decoded);
    const skippedAfter = parseTable(edited);
    const normalizedBefore = parseTable(decoded.replaceAll('\r\n', '\n'), {
      skipBom: false,
    });
    const normalizedAfter = parseTable(edited.replaceAll('\r\n', '\n'), {
      skipBom: false,
    });
    if (
      !viewerBefore.ok ||
      !viewerAfter.ok ||
      !skippedBefore.ok ||
      !skippedAfter.ok ||
      !normalizedBefore.ok ||
      !normalizedAfter.ok
    )
      throw new Error('fixture must parse as a table');
    expect(viewerBefore.table.delimiter).toBe(',');
    expect(viewerAfter.table.delimiter).toBe(';');
    expect(skippedBefore.table.delimiter).toBe(';');
    expect(skippedAfter.table.delimiter).toBe(';');
    expect(normalizedBefore.table.delimiter).toBe(';');
    expect(normalizedAfter.table.delimiter).toBe(';');

    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('damage', marker, 'Q');
    for (const write of [false, true]) {
      const refused = await call({
        path: target,
        accept: ['damage'],
        write,
        allow_source_mismatch: true,
      });
      expect(refused.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'table_delimiter',
      });
      expect(refused.isError).toBe(true);
      expect(await readFile(target)).toEqual(Buffer.from(original));
    }
  });

  test('refuses combined CSV edits that move an unchanged cell across a separator', async () => {
    const target = join(scratch, 'data.csv');
    const original = 'name,value\nfoo,bar\nomega,2\n';
    const changed = 'name,value\n"foo,bar",x\nomega,2\n';
    const before = parseTable(original);
    const after = parseTable(changed);
    if (!before.ok || !after.ok)
      throw new Error('fixture must parse as a table');
    expect(before.table.delimiter).toBe(after.table.delimiter);
    expect(before.table.records).toBe(after.table.records);
    for (let record = 0; record < before.table.records; record += 1)
      expect(recordWidth(before.table, record)).toBe(
        recordWidth(after.table, record)
      );
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('first', 'foo', '"foo');
    await addRow('second', {
      body: 'insert after the neighboring value',
      display_name: null,
      anchor: { kind: 'source', exact: 'bar' },
      suggestion: { v: 1, mode: 'after', replacement: '",x' },
    });
    for (const write of [false, true]) {
      const result = await call({
        path: target,
        accept: ['first', 'second'],
        write,
        allow_source_mismatch: true,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'table_boundaries',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test('maps duplicate selected CSV suggestions only once', async () => {
    const target = join(scratch, 'data.csv');
    const original = 'name,value\nalpha,1\n';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('first', 'alpha', 'BETA');
    await addSuggestion('duplicate', 'alpha', 'BETA');
    const result = await call({
      path: target,
      accept: ['first', 'duplicate'],
      write: true,
      allow_source_mismatch: true,
    });
    expect(result.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('name,value\nBETA,1\n');
  });

  test('does not let a recovered subtitle block mask a lost cue', async () => {
    const target = join(scratch, 'data.srt');
    const original =
      '1\n00:00:01,000 ~~> 00:00:02,000\nghost\n\n' +
      '1\n00:00:01,000 --> 00:00:02,000\nalpha\n';
    const changed =
      '1\n00:00:01,000 --> 00:00:02,000\nghost\n\n' +
      '1\n00:00:01,000 ~~> 00:00:02,000\nalpha\n';
    const before = parseSubtitles(original, 'srt');
    const after = parseSubtitles(changed, 'srt');
    if (!before.ok || !after.ok) throw new Error('fixture must contain a cue');
    expect(before.file.cueCount).toBe(after.file.cueCount);
    expect(before.file.skipped).toBe(after.file.skipped);
    const oldCue = before.file.entries[0];
    const newCue = after.file.entries[0];
    if (oldCue?.kind !== 'cue' || newCue?.kind !== 'cue')
      throw new Error('fixture entries must be cues');
    expect([oldCue.start, oldCue.end]).toEqual([newCue.start, newCue.end]);
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('recover', '~~>', '-->');
    await addSuggestion('damage', '-->', '~~>');
    for (const write of [false, true]) {
      const result = await call({
        path: target,
        accept: ['recover', 'damage'],
        write,
        allow_source_mismatch: true,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'subtitle_cues',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
  });

  test('refuses a split Unicode character but accepts a whole-character notebook edit', async () => {
    const target = join(scratch, 'data.ipynb');
    const original =
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["Hi 😀 there"]}]}';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('damage', '\ud83d', '');
    await addSuggestion('safe', '😀', '🤝');
    const args = { path: target, allow_source_mismatch: true };
    for (const write of [false, true]) {
      const result = await call({ ...args, accept: ['damage'], write });
      expect(result.structuredContent).toMatchObject({
        code: 'suggestion_breaks_structure',
        check: 'unicode',
      });
      expect(result.isError).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(original);
    }
    const safe = await call({ ...args, accept: ['safe'], write: true });
    expect(safe.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(original.replace('😀', '🤝'));
  });

  test('uses the published structured filename for a differently named local source', async () => {
    const target = join(scratch, 'data.json');
    const original = '\uFEFFname,value\r\nalpha,1\r\nomega,2\r\n';
    await writeFile(target, original);
    const state = await loadPublishState(relicId);
    if (state === undefined) throw new Error('missing fixture state');
    await savePublishState(relicId, {
      ...state,
      source: await resolveSourceIdentity(target),
      filename: 'data.csv',
    });
    await addSuggestion('safe', 'alpha', 'BETA');
    await addSuggestion('damage', 'alpha', 'alpha,extra');
    const args = { path: target };
    const refused = await call({ ...args, accept: ['damage'], write: true });
    expect(refused.structuredContent).toMatchObject({
      code: 'suggestion_breaks_structure',
      check: 'table_fields',
    });
    expect(await readFile(target, 'utf8')).toBe(original);
    const result = await call({ ...args, accept: ['safe'], write: true });
    expect(result.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(
      original.replace('alpha', 'BETA')
    );
  });

  test.each([
    ['CSV', 'data.json', 'published.csv', 'name,value\nalpha,1\n'],
    ['JSON', 'data.csv', 'published.json', '{"message":"alpha"}\n'],
    [
      'notebook',
      'data.json',
      'published.ipynb',
      '{"nbformat":4,"cells":[{"cell_type":"markdown","source":["alpha"]}]}',
    ],
  ])(
    'uses the published %s format instead of a conflicting local suffix',
    async (_, localName, publishedName, original) => {
      const target = join(scratch, localName);
      await writeFile(target, original);
      const state = await loadPublishState(relicId);
      if (state === undefined) throw new Error('missing fixture state');
      await savePublishState(relicId, {
        ...state,
        source: await resolveSourceIdentity(target),
        filename: publishedName,
      });
      await addSuggestion('safe', 'alpha', 'BETA');
      const preview = await call({ path: target, accept: ['safe'] });
      expect(preview.isError).toBe(false);
      const result = await call({
        path: target,
        accept: ['safe'],
        write: true,
      });
      expect(result.isError).toBe(false);
      expect(await readFile(target, 'utf8')).toBe(
        original.replace('alpha', 'BETA')
      );
    }
  );

  test('preflights all folder entries before writing any structured file', async () => {
    const folder = join(scratch, 'folder');
    await mkdir(folder);
    const csv = join(folder, 'good.csv');
    const json = join(folder, 'bad.json');
    const originalCsv = 'name,value\nalpha,1\n';
    const originalJson = '{"message":"omega"}\n';
    await writeFile(csv, originalCsv);
    await writeFile(json, originalJson);
    await addRow('safe', {
      body: 'safe',
      display_name: null,
      entry: 'good.csv',
      anchor: { kind: 'source', exact: 'alpha' },
      suggestion: { v: 1, mode: 'replace', replacement: 'BETA' },
    });
    await addRow('damage', {
      body: 'damage',
      display_name: null,
      entry: 'bad.json',
      anchor: { kind: 'source', exact: 'omega' },
      suggestion: { v: 1, mode: 'replace', replacement: 'omega"' },
    });
    const result = await call({
      path: folder,
      accept: ['safe', 'damage'],
      write: true,
      allow_source_mismatch: true,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'suggestion_breaks_structure',
      check: 'json_parse',
    });
    expect(await readFile(csv, 'utf8')).toBe(originalCsv);
    expect(await readFile(json, 'utf8')).toBe(originalJson);
  });

  test('requires a valid source for touched notebook cells without rejecting untouched ones', async () => {
    const target = join(scratch, 'data.ipynb');
    const original =
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":null,"metadata":{"tag":"old"}},{"cell_type":"markdown","source":["alpha"]}]}';
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('invalid', '"old"', '"new"');
    await addSuggestion('safe', 'alpha', 'BETA');
    const args = { path: target, allow_source_mismatch: true };
    const refused = await call({ ...args, accept: ['invalid'], write: true });
    expect(refused.structuredContent).toMatchObject({
      code: 'suggestion_breaks_structure',
      check: 'notebook_source',
    });
    expect(await readFile(target, 'utf8')).toBe(original);
    const safe = await call({ ...args, accept: ['safe'], write: true });
    expect(safe.isError).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(
      original.replace('alpha', 'BETA')
    );
  });

  test('counts notebook outputs beyond the viewer output cap', async () => {
    const target = join(scratch, 'data.ipynb');
    const tail = ',{"output_type":"stream","name":"stderr","text":"last"}';
    const outputs = `${Array(200).fill('{}').join(',')}${tail}`;
    const original = `{"nbformat":4,"cells":[{"cell_type":"code","source":["alpha"],"outputs":[${outputs}]}]}`;
    await writeFile(target, original);
    await recordFixtureFilename(target);
    await addSuggestion('damage', tail, '');
    const result = await call({
      path: target,
      accept: ['damage'],
      write: true,
      allow_source_mismatch: true,
    });
    expect(result.structuredContent).toMatchObject({
      code: 'suggestion_breaks_structure',
      check: 'notebook_outputs',
    });
    expect(result.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(original);
  });

  test.each([
    [
      'mixed table endings',
      'data.csv',
      'name,value\r\nalpha,1\n',
      'mixed_line_endings',
    ],
    ['a lone table CR', 'data.csv', 'name,value\ralpha,1', 'has_cr'],
    ['CRLF JSON', 'data.json', '{\r\n"message":"alpha"\r\n}', 'has_cr'],
    [
      'CRLF notebook',
      'data.ipynb',
      '{\r\n"nbformat":4,"cells":[{"cell_type":"raw","source":["alpha"]}]\r\n}',
      'has_cr',
    ],
  ])(
    'refuses %s using the shared source convention',
    async (_, filename, source, reason) => {
      const target = join(scratch, filename);
      await writeFile(target, source);
      await recordFixtureFilename(target);
      await addSuggestion('chosen', 'alpha', 'ALPHA');
      const result = await call({
        path: target,
        accept: ['chosen'],
        write: true,
        allow_source_mismatch: true,
      });
      expect(result.structuredContent).toMatchObject({
        code: 'source_not_suggestible',
        reason,
      });
      expect(await readFile(target, 'utf8')).toBe(source);
    }
  );

  test('reports unrecorded identity without inventing a mismatch', async () => {
    const legacy = generateRelicId();
    const bytes = generateKey();
    key = await deriveCommentKey(bytes);
    await savePublishState(legacy, {
      key: encodeKey(bytes),
      publish_token: 'fixture-token',
      version: 1,
      filename: 'report.md',
    });
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    const result = await call({ relic_id: legacy, accept: ['chosen'] });
    expect(result.structuredContent['source_identity']).toBe('unrecorded');
  });

  test('rejects CR and unsupported renderer classes', async () => {
    await writeFile(path, '# Report\r\nalpha beta\r\n');
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    const cr = await call({ accept: ['chosen'] });
    expect(cr.structuredContent).toMatchObject({
      code: 'source_not_suggestible',
      reason: 'has_cr',
    });
    const html = join(scratch, 'index.html');
    await writeFile(html, '<p>alpha</p>');
    await recordFixtureFilename(html);
    const unsupported = await call({ path: html, accept: ['chosen'] });
    expect(unsupported.structuredContent).toMatchObject({
      code: 'suggestions_unsupported_class',
      renderer_class: 'html',
    });
  });

  test('refuses two conflicting accepted ids but accepts duplicate aliases once', async () => {
    await addSuggestion('first', 'alpha', 'ALPHA');
    await addSuggestion('same', 'alpha', 'ALPHA');
    await addSuggestion('conflict', 'alpha beta', 'replacement');
    const refused = await call({ accept: ['first', 'conflict'] });
    expect(refused.structuredContent['code']).toBe('conflicting_accepts');
    const duplicate = await call({ accept: ['same'] });
    expect(duplicate.isError).toBe(false);
    expect(duplicate.structuredContent['applied']).toEqual([
      { comment_id: 'same', line: 2, end_line: 2 },
    ]);
    expect(duplicate.structuredContent['proposed_addresses']).toEqual([
      {
        comment_id: 'first',
        outcome: 'accepted',
        note: 'Applied in this version.',
      },
      {
        comment_id: 'same',
        outcome: 'accepted',
        note: 'Applied in this version.',
      },
      {
        comment_id: 'conflict',
        outcome: 'superseded',
        note: 'Superseded by an applied suggestion.',
      },
    ]);
  });

  test('reports ambiguous and lost anchors per id in one refusal', async () => {
    await writeFile(path, 'alpha and alpha\n');
    await addSuggestion('ambiguous', 'alpha', 'one');
    await addSuggestion('lost', 'missing', 'two');
    const result = await call({ accept: ['ambiguous', 'lost'] });
    expect(result.structuredContent).toMatchObject({
      code: 'suggestion_unapplicable',
      suggestions: [
        { comment_id: 'ambiguous', reason: 'ambiguous' },
        { comment_id: 'lost', reason: 'lost' },
      ],
    });
  });

  test('rejects settled, ordinary and unreadable rows and permits deferred suggestions', async () => {
    await addSuggestion('declined', 'alpha', 'ALPHA');
    await addRow(
      'outcome',
      {
        body: 'No',
        display_name: null,
        addresses: 'declined',
        suggestion_outcome: 'declined',
      },
      { author: 'publisher' }
    );
    await addRow('ordinary', { body: 'Regular comment', display_name: null });
    rows.push({
      comment_id: 'unreadable',
      author: 'reader@example.test',
      version: 1,
      ciphertext: 'broken',
    });
    await addSuggestion('deferred', 'beta', 'BETA');
    await addRow(
      'deferral',
      {
        body: 'Later',
        display_name: null,
        addresses: 'deferred',
        suggestion_outcome: 'deferred',
      },
      { author: 'publisher' }
    );
    expect(
      (await call({ accept: ['declined'] })).structuredContent
    ).toMatchObject({ code: 'suggestion_not_pending', state: 'declined' });
    expect(
      (await call({ accept: ['ordinary'] })).structuredContent['code']
    ).toBe('not_a_suggestion');
    expect(
      (await call({ accept: ['unreadable'] })).structuredContent['code']
    ).toBe('suggestion_unreadable');
    expect((await call({ accept: ['deferred'] })).isError).toBe(false);
  });

  test('refuses an unsupported future anchor rather than misapplying it', async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const body = new TextEncoder().encode(
      JSON.stringify({
        body: 'future anchor',
        display_name: null,
        anchor: { kind: 'future-cell', exact: 'alpha' },
        suggestion: { v: 1, mode: 'replace', replacement: 'ALPHA' },
      })
    );
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, body)
    );
    rows.push({
      comment_id: 'future',
      author: 'reader@example.test',
      version: 1,
      ciphertext: Buffer.concat([nonce, ciphertext]).toString('base64url'),
    });
    const result = await call({ accept: ['future'] });
    expect(result.structuredContent['code']).toBe(
      'suggestion_unsupported_anchor'
    );
  });

  test('refuses if the bytes change between preview and write', async () => {
    await addSuggestion('chosen', 'alpha', 'ALPHA');
    let reads = 0;
    deps = {
      ...deps,
      files: {
        ...nodeFiles,
        async read(file) {
          const bytes = await nodeFiles.read(file);
          reads++;
          return reads === 2
            ? new TextEncoder().encode('changed during apply\n')
            : bytes;
        },
      },
    };
    const result = await call({ accept: ['chosen'], write: true });
    expect(result.structuredContent['code']).toBe(
      'source_changed_during_apply'
    );
    expect(await readFile(path, 'utf8')).toBe(ORIGINAL);
  });

  test('private all-version reads decrypt rows and the selected revision with their own keys', async () => {
    const privateId = generateRelicId();
    const version1 = generateKey();
    const version2 = generateKey();
    const key1 = await deriveCommentKey(version1);
    const key2 = await deriveCommentKey(version2);
    await savePrivatePublishState(privateId, {
      access: 'private',
      service_origin: SERVICE,
      publish_token: 'private-token',
      version: 2,
      version_keys: { '1': encodeKey(version1), '2': encodeKey(version2) },
      owner_identity_id: 'owner',
      device_id: 'device',
      source: await resolveSourceIdentity(path),
    });
    await addSuggestion('private', 'alpha', 'ALPHA', { version: 1, key: key1 });
    await addRow(
      'reply',
      { body: 'Seen', display_name: null, addresses: 'private' },
      { author: 'publisher', version: 2, key: key2 }
    );
    const container = await encryptRelic({
      key: version1,
      filename: 'report.md',
      mimetype: 'text/markdown',
      content: new TextEncoder().encode(ORIGINAL),
    });
    const previousFetch = deps.fetch;
    deps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/mint')) {
          requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
          const body = JSON.parse(String(init?.body)) as {
            version?: number;
            publish_token?: string;
          };
          expect(body).toEqual({ version: 1, publish_token: 'private-token' });
          return Response.json({
            url: `${SERVICE}/private-history-v1`,
            object_length: container.length,
            version: 1,
            current_version: 2,
          });
        }
        if (url.pathname === '/private-history-v1') {
          requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
          return new Response(new Blob([container as BlobPart]));
        }
        return previousFetch(input, init);
      }) as typeof fetch,
    };
    const result = await call({ relic_id: privateId, accept: ['private'] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent['applied']).toEqual([
      { comment_id: 'private', line: 2, end_line: 2 },
    ]);
    expect(requests).toEqual([
      { path: `/api/relics/${privateId}/comments/list`, method: 'POST' },
      { path: `/api/relics/${privateId}/mint`, method: 'POST' },
      { path: '/private-history-v1', method: 'GET' },
    ]);
  });
});
