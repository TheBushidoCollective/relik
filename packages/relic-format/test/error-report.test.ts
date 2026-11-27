import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import * as reportApi from '../src/error-report.ts';
import {
  classOf,
  ERROR_CLASSES,
  ERROR_REPORT_DISCLOSED_FIELDS,
  ERROR_REPORT_LOG_RETENTION_DAYS,
  type ErrorFrame,
  type ErrorReport,
  fingerprintOf,
  MCP_ROUTES,
  nodeFramesFrom,
  parseClientReport,
  parseLoggedReport,
  type ReportSource,
  SERVER_ROUTES,
  viewerFramesFrom,
  VIEWER_ROUTES,
} from '../src/error-report.ts';
import { generateRelicId } from '../src/id.ts';
import { sha256Hex } from '../src/sha256.ts';

const revision = 'a'.repeat(40);
const secretId = generateRelicId();
const secretFragment = `#${'a'.repeat(43)}`;
const canaries = [
  secretId,
  'jane.doe@example.com',
  '/Users/jane/Secret Plans.pdf',
  secretFragment,
];

function report(source: ReportSource = 'viewer'): ErrorReport {
  if (source === 'server') {
    return {
      v: 1,
      source,
      errorClass: 'Error',
      route: 'GET /:id',
      revision,
      frames: [
        { file: 'packages/relic-server/src/app.ts', line: 10, column: 4 },
      ],
      count: 1,
    };
  }
  if (source === 'mcp') {
    return {
      v: 1,
      source,
      errorClass: 'Error',
      route: 'relic_show',
      revision: '0.20.0',
      frames: [{ file: 'dist/relic-mcp.js', line: 10, column: 4 }],
      count: 1,
    };
  }
  return {
    v: 1,
    source,
    errorClass: 'Error',
    route: 'public-open',
    revision,
    frames: [{ file: 'assets/viewer.js', line: 10, column: 4 }],
    count: 1,
  };
}

function expectNoCanaries(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) expect(serialized).not.toContain(canary);
}

describe('report shape and privacy', () => {
  test('accepts and copies exactly the disclosed fields for each source', () => {
    expect(ERROR_REPORT_DISCLOSED_FIELDS).toEqual([
      'v',
      'source',
      'errorClass',
      'route',
      'revision',
      'frames',
      'count',
    ]);
    expect(ERROR_REPORT_LOG_RETENTION_DAYS).toBe(30);
    for (const source of ['server', 'viewer', 'mcp'] as const) {
      const input = report(source);
      const output = parseLoggedReport(input);
      expect(output).toEqual(input);
      expect(output).not.toBe(input);
      expect(output?.frames).not.toBe(input.frames);
      expect(output?.frames[0]).not.toBe(input.frames[0]);
      expect(Object.keys(output ?? {})).toEqual([
        ...ERROR_REPORT_DISCLOSED_FIELDS,
      ]);
      expectNoCanaries(output);
      if (source === 'server') expect(parseClientReport(input)).toBeNull();
      else expect(parseClientReport(input)).toEqual(input);
    }
  });

  test('rejects every canary in each string field, frame file, and extra field', () => {
    for (const source of ['server', 'viewer', 'mcp'] as const) {
      const valid = report(source);
      for (const canary of canaries) {
        for (const key of [
          'source',
          'errorClass',
          'route',
          'revision',
        ] as const) {
          expect(parseLoggedReport({ ...valid, [key]: canary })).toBeNull();
          expect(parseClientReport({ ...valid, [key]: canary })).toBeNull();
        }
        expect(
          parseLoggedReport({
            ...valid,
            frames: [{ file: canary, line: 1, column: 0 }],
          })
        ).toBeNull();
        for (const key of ['message', 'url', 'stack']) {
          expect(parseLoggedReport({ ...valid, [key]: canary })).toBeNull();
          expect(parseClientReport({ ...valid, [key]: canary })).toBeNull();
        }
        expect(parseLoggedReport({ ...valid, [canary]: 'extra' })).toBeNull();
      }
      expectNoCanaries(parseLoggedReport(valid));
    }
    expect(
      parseClientReport({
        ...report(),
        frames: [
          {
            file: `assets/chunk-${secretFragment.slice(1)}.js`,
            line: 1,
            column: 0,
          },
        ],
      })
    ).toBeNull();
  });

  test('rejects unknown, missing, non-data, and symbol keys without throwing', () => {
    const valid = report();
    for (const key of ERROR_REPORT_DISCLOSED_FIELDS) {
      const copy: Record<string, unknown> = { ...valid };
      delete copy[key];
      expect(parseLoggedReport(copy)).toBeNull();
    }
    expect(parseLoggedReport({ ...valid, message: 'anything' })).toBeNull();
    expect(
      parseLoggedReport({ ...valid, [Symbol('extra')]: 'anything' })
    ).toBeNull();
    expect(
      parseLoggedReport({
        ...valid,
        get route() {
          throw new Error('untrusted getter');
        },
      })
    ).toBeNull();
    expect(
      parseLoggedReport(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('untrusted proxy');
            },
          }
        )
      )
    ).toBeNull();
    for (const invalid of [null, undefined, false, 1, 'report', []]) {
      expect(parseLoggedReport(invalid)).toBeNull();
      expect(parseClientReport(invalid)).toBeNull();
    }
  });

  test('enforces source, class, route, version, count and cross-source limits', () => {
    const valid = report();
    for (const change of [
      { v: 2 },
      { v: '1' },
      { source: 'other' },
      { errorClass: 'NotARealError' },
      { route: 'GET /:id' },
      { route: 'relic_show' },
      { revision: 'A'.repeat(40) },
      { revision: 'a'.repeat(39) },
      { revision: `${revision}\n` },
      { revision: '0.20.0' },
      { count: 0 },
      { count: 1_000_001 },
      { count: 1.1 },
      { count: Number.NaN },
      { count: Number.POSITIVE_INFINITY },
      { count: '1' },
    ])
      expect(parseLoggedReport({ ...valid, ...change })).toBeNull();
    expect(parseClientReport({ ...valid, count: 2 })).toBeNull();
    expect(parseLoggedReport({ ...valid, count: 2 })?.count).toBe(2);
    expect(parseLoggedReport({ ...valid, count: 1_000_000 })?.count).toBe(
      1_000_000
    );
    expect(parseClientReport(report('server'))).toBeNull();
    expect(parseLoggedReport(report('server'))).not.toBeNull();
    for (const bad of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '10000.2.3',
      '1.2.3-dev',
      '1.2',
      '1.2.3\n',
    ]) {
      expect(parseLoggedReport({ ...report('mcp'), revision: bad })).toBeNull();
    }
    expect(
      parseLoggedReport({ ...report('mcp'), revision: '9999.0.1234' })
    ).not.toBeNull();
  });

  test('enforces exact frame keys, lengths, numeric bounds and source-specific file patterns', () => {
    const valid = report();
    const frame = valid.frames[0]!;
    expect(parseLoggedReport({ ...valid, frames: [] })?.frames).toEqual([]);
    expect(
      parseLoggedReport({ ...valid, frames: Array(8).fill(frame) })?.frames
    ).toHaveLength(8);
    expect(
      parseLoggedReport({ ...valid, frames: Array(9).fill(frame) })
    ).toBeNull();
    for (const invalid of [
      null,
      [],
      { file: frame.file, line: 1 },
      { ...frame, stack: 'extra' },
      { ...frame, line: 0 },
      { ...frame, line: 10_000_001 },
      { ...frame, line: 1.5 },
      { ...frame, column: -1 },
      { ...frame, column: 10_000_001 },
      { ...frame, column: Number.NaN },
      { ...frame, column: '0' },
      { ...frame, file: '/assets/viewer.js' },
      { ...frame, file: 'assets/viewer.js\n' },
      { ...frame, file: 'assets/chunk-ABC12345.js' },
      { ...frame, file: 'assets/chunk-123456789.js' },
      { ...frame, file: 'assets/sandbox.js' },
      { ...frame, file: 'dist/relic-mcp.js' },
    ])
      expect(parseLoggedReport({ ...valid, frames: [invalid] })).toBeNull();
    expect(
      parseLoggedReport({
        ...valid,
        frames: [
          { file: 'assets/chunk-1tft2rar.js', line: 10_000_000, column: 0 },
        ],
      })
    ).not.toBeNull();
    expect(
      parseLoggedReport({
        ...report('server'),
        frames: [
          {
            file: 'packages/relic-format/src/private/keys.ts',
            line: 1,
            column: 10_000_000,
          },
        ],
      })
    ).not.toBeNull();
    for (const file of [
      '/Users/jane/packages/relic-server/src/app.ts',
      'packages/relic-server/src/App.ts',
      'packages/relic-server/src/../app.ts',
      'packages/relic-viewer/src/main.ts',
      'packages/relic-server/src/app.ts\n',
    ])
      expect(
        parseLoggedReport({
          ...report('server'),
          frames: [{ file, line: 1, column: 0 }],
        })
      ).toBeNull();
    expect(
      parseLoggedReport({
        ...report('mcp'),
        frames: [{ file: 'dist/native-secure-open.js', line: 1, column: 0 }],
      })
    ).not.toBeNull();
    for (const file of [
      'dist/relic-mcp.js\n',
      '/relic-mcp/dist/relic-mcp.js',
      'dist/other.js',
    ]) {
      expect(
        parseLoggedReport({
          ...report('mcp'),
          frames: [{ file, line: 1, column: 0 }],
        })
      ).toBeNull();
    }
  });

  test('checks optional trusted revisions and assets only for their corresponding sources', () => {
    const viewer = {
      ...report(),
      frames: [{ file: 'assets/chunk-1tft2rar.js', line: 1, column: 0 }],
    };
    const revisions = new Set([revision]);
    const viewerFiles = new Set(['assets/chunk-1tft2rar.js']);
    expect(
      parseClientReport(viewer, { revisions: new Set(), viewerFiles })
    ).toBeNull();
    expect(
      parseClientReport(viewer, { revisions, viewerFiles: new Set() })
    ).toBeNull();
    expect(parseClientReport(viewer, { revisions, viewerFiles })).toEqual(
      viewer
    );
    expect(
      parseLoggedReport(viewer, { revisions: new Set(), viewerFiles })
    ).toBeNull();
    expect(
      parseLoggedReport(viewer, { revisions, viewerFiles: new Set() })
    ).toBeNull();
    expect(parseLoggedReport(viewer, { revisions, viewerFiles })).toEqual(
      viewer
    );
    expect(parseClientReport(viewer)).toEqual(viewer);

    const mcp = report('mcp');
    expect(parseClientReport(mcp, { mcpVersions: new Set() })).toBeNull();
    expect(parseLoggedReport(mcp, { mcpVersions: new Set() })).toBeNull();
    expect(
      parseClientReport(mcp, { mcpVersions: new Set([mcp.revision]) })
    ).toEqual(mcp);
    expect(
      parseLoggedReport(mcp, { mcpVersions: new Set([mcp.revision]) })
    ).toEqual(mcp);
    expect(parseClientReport(mcp, { revisions: new Set() })).toEqual(mcp);
    expect(
      parseLoggedReport(report('server'), { mcpVersions: new Set() })
    ).toEqual(report('server'));
    expect(
      parseLoggedReport(report('server'), { revisions: new Set() })
    ).toBeNull();
  });

  test('sets contain only unique values and the required surface labels', () => {
    for (const values of [
      ERROR_CLASSES,
      SERVER_ROUTES,
      VIEWER_ROUTES,
      MCP_ROUTES,
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(VIEWER_ROUTES).toEqual([
      'public-open',
      'private-reader',
      'dashboard',
      'publish',
      'document',
    ]);
    expect(MCP_ROUTES).toContain('process');
    expect(SERVER_ROUTES).toContain('GET /api/presence/:roomId');
    expect(SERVER_ROUTES).toContain('OTHER /assets/*');
    expect(SERVER_ROUTES).toContain('other');
  });
});

describe('stack scrubbing', () => {
  const origin = 'https://relik.link';
  const forbidden = [
    `    at open (https://relik.link/${secretId}${secretFragment}:1:2)`,
    '    at ext (chrome-extension://abc/assets/viewer.js:1:2)',
    '    at ext (moz-extension://abc/assets/viewer.js:1:2)',
    '    at local (file:///Users/jane/Secret Plans.pdf:1:2)',
    '    at blob (blob:https://relik.link/assets/viewer.js:1:2)',
    '    at outside (https://evil.example/assets/viewer.js:1:2)',
    '    at lookalike (https://relik.link.evil.example/assets/viewer.js:1:2)',
  ];

  test('extracts Chromium frames only from allowed same-origin assets', () => {
    const stack = [
      `Error: ${canaries.join(' ')}`,
      `    at render (https://relik.link/assets/viewer.js?private=${secretId}${secretFragment}:42:5)`,
      '    at https://relik.link/assets/chunk-1tft2rar.js?cache=1:9:0',
      ...forbidden,
    ].join('\n');
    const frames = viewerFramesFrom(stack, origin);
    expect(frames).toEqual([
      { file: 'assets/viewer.js', line: 42, column: 5 },
      { file: 'assets/chunk-1tft2rar.js', line: 9, column: 0 },
    ]);
    expectNoCanaries(frames);
  });

  for (const script of ['model-view.js', 'pdf.worker.js']) {
    test(`keeps ${script} frames without URLs or lookalikes`, () => {
      const file = `assets/${script}`;
      const stack = [
        `at load (https://relik.link/${file}:1:2)`,
        `at load (https://relik.link/${file}?id=${secretId}${secretFragment}:3:4)`,
        `at load (https://evil.example/${file}:5:6)`,
        `at load (https://relik.link/${file}-${secretId}.js:7:8)`,
      ].join('\n');
      const frames = viewerFramesFrom(stack, origin);
      expect(frames).toEqual([
        { file, line: 1, column: 2 },
        { file, line: 3, column: 4 },
      ]);
      expectNoCanaries(frames);
      const fixedReport = { ...report(), frames: [frames[0]!] };
      expect(parseClientReport(fixedReport)).toEqual(fixedReport);
      expect(
        parseClientReport(fixedReport, { viewerFiles: new Set([file]) })
      ).toEqual(fixedReport);
      expect(
        parseClientReport(fixedReport, {
          viewerFiles: new Set(['assets/viewer.js']),
        })
      ).toBeNull();
      for (const invalidFile of [
        `${file}-${secretId}.js`,
        `${file}?${secretId}`,
        `${file}${secretFragment}`,
      ]) {
        expect(
          parseClientReport({
            ...report(),
            frames: [{ file: invalidFile, line: 1, column: 0 }],
          })
        ).toBeNull();
      }
      expect(fingerprintOf(fixedReport)).toBe(
        createHash('sha256')
          .update(`relik-error-report/v1\nviewer\nError\npublic-open\n${file}`)
          .digest('hex')
          .slice(0, 16)
      );
    });
  }

  test('drops landing, service worker, worker, worklet, and sandbox scripts', () => {
    const excluded = [
      '/assets/landing.js',
      '/sw.js',
      '/assets/model-parse-worker.js',
      '/assets/spreadsheet-parse-worker.js',
      '/assets/otio-audio-pcm-worker.js',
      '/assets/otio-video-timing-worker.js',
      '/assets/otio-transport-gate-worklet.js',
      '/assets/sandbox.js',
      '/assets/frame-docx.frame.js',
      '/assets/frame-epub.frame.js',
    ];
    for (const path of excluded) {
      const stack = `at load (https://relik.link${path}:1:2)`;
      expect(viewerFramesFrom(stack, origin)).toEqual([]);
      expect(
        parseClientReport({
          ...report(),
          frames: [{ file: path.slice(1), line: 1, column: 2 }],
        })
      ).toBeNull();
    }
  });

  test('extracts Firefox and Safari frames without function, query or fragment', () => {
    const firefox = [
      `render@https://relik.link/assets/viewer.js?email=${canaries[1]}:14:3`,
      '@https://relik.link/assets/chunk-a1b2c3d4.js:7:8',
      `open@https://relik.link/${secretId}${secretFragment}:11:22`,
      'fetch@moz-extension://abc/assets/viewer.js:9:3',
    ].join('\n');
    const safari = [
      `start@https://relik.link/assets/register-sw.js?secret=${secretId}:5:9`,
      `global code@https://relik.link/${secretId}${secretFragment}:1:1`,
      'read@file:///Users/jane/Secret Plans.pdf:2:2',
    ].join('\n');
    const firefoxFrames = viewerFramesFrom(firefox, origin);
    const safariFrames = viewerFramesFrom(safari, origin);
    expect(firefoxFrames).toEqual([
      { file: 'assets/viewer.js', line: 14, column: 3 },
      { file: 'assets/chunk-a1b2c3d4.js', line: 7, column: 8 },
    ]);
    expect(safariFrames).toEqual([
      { file: 'assets/register-sw.js', line: 5, column: 9 },
    ]);
    expectNoCanaries([firefoxFrames, safariFrames]);
  });

  test('rejects invalid origins and bounds, and caps surviving frames at eight', () => {
    const frame = 'at render (https://relik.link/assets/viewer.js:1:0)';
    expect(viewerFramesFrom(frame, 'null')).toEqual([]);
    expect(viewerFramesFrom(frame, 'file:///')).toEqual([]);
    expect(viewerFramesFrom(frame, 'https://jane@relik.link')).toEqual([]);
    expect(
      viewerFramesFrom('at https://relik.link/assets/viewer.js:0:1', origin)
    ).toEqual([]);
    expect(
      viewerFramesFrom(
        'at https://relik.link/assets/viewer.js:1:10000001',
        origin
      )
    ).toEqual([]);
    expect(
      viewerFramesFrom(Array(12).fill(frame).join('\n'), origin)
    ).toHaveLength(8);
  });

  test('retains only permitted Bun and Node server source paths', () => {
    const stack = [
      `Error: ${canaries.join(' ')}`,
      `    at handle (/Users/jane/${secretId}/packages/relic-server/src/app.ts:101:7)`,
      'validate@/Users/jane/project/packages/relic-format/src/private/keys.ts:7:0',
      '    at file:///Users/jane/project/packages/relic-format/src/id.ts:8:2',
      '    at packages/relic-server/src/mail.ts:3:5',
      '    at /Users/jane/Secret Plans.pdf:1:2',
      '    at https://evil.example/packages/relic-server/src/app.ts:3:5',
      '    at /Users/jane/mypackages/relic-server/src/app.ts:3:5',
      '    at /Users/jane/packages/relic-viewer/src/main.ts:3:5',
    ].join('\n');
    const frames = nodeFramesFrom(stack, 'server');
    expect(frames).toEqual([
      { file: 'packages/relic-server/src/app.ts', line: 101, column: 7 },
      { file: 'packages/relic-format/src/private/keys.ts', line: 7, column: 0 },
      { file: 'packages/relic-format/src/id.ts', line: 8, column: 2 },
      { file: 'packages/relic-server/src/mail.ts', line: 3, column: 5 },
    ]);
    expectNoCanaries(frames);
  });

  test('retains only the two MCP bundles from a matching installation or dist', () => {
    const stack = [
      `Error: ${canaries.join(' ')}`,
      `    at run (/Users/jane/${secretId}/node_modules/relic-mcp/dist/relic-mcp.js:10:11)`,
      'open@file:///Users/jane/node_modules/relic-mcp/dist/native-secure-open.js:12:0',
      '    at dist/relic-mcp.js:1:2',
      '    at /Users/jane/other/dist/relic-mcp.js:1:2',
      '    at https://evil.example/relic-mcp/dist/relic-mcp.js:1:2',
      '    at /Users/jane/relic-mcp/dist/secret.js:1:2',
      '    at /Users/jane/relic-mcp/dist/relic-mcp.js.map:1:2',
    ].join('\n');
    const frames = nodeFramesFrom(stack, 'mcp');
    expect(frames).toEqual([
      { file: 'dist/relic-mcp.js', line: 10, column: 11 },
      { file: 'dist/native-secure-open.js', line: 12, column: 0 },
      { file: 'dist/relic-mcp.js', line: 1, column: 2 },
    ]);
    expectNoCanaries(frames);
    expect(nodeFramesFrom(stack, 'server')).toEqual([]);
    expect(
      nodeFramesFrom(
        Array(12).fill('at dist/relic-mcp.js:1:0').join('\n'),
        'mcp'
      )
    ).toHaveLength(8);
  });
});

describe('classification and grouping', () => {
  test('classifies constructor before name, accepts standard names, and handles hostile values', () => {
    for (const value of [
      null,
      undefined,
      'Error',
      3,
      false,
      Symbol('error'),
      () => {},
    ]) {
      expect(classOf(value)).toBe('NonError');
    }
    expect(classOf(new TypeError('hidden'))).toBe('TypeError');
    expect(classOf(new DOMException('hidden', 'AbortError'))).toBe(
      'AbortError'
    );
    expect(classOf({ name: 'ProblemError' })).toBe('ProblemError');
    expect(classOf({ constructor: TypeError, name: 'RangeError' })).toBe(
      'TypeError'
    );
    expect(classOf({ name: canaries[1] })).toBe('Other');
    expect(
      classOf({
        get constructor() {
          throw new Error('hidden');
        },
        name: 'AbortError',
      })
    ).toBe('AbortError');
    expect(
      classOf(
        new Proxy(
          {},
          {
            get() {
              throw new Error('hidden');
            },
          }
        )
      )
    ).toBe('Other');
  });

  test('uses the exact fingerprint wire string and ignores revision and positions', () => {
    const base = {
      ...report(),
      frames: [
        { file: 'assets/chunk-1tft2rar.js', line: 15, column: 0 },
        { file: 'assets/viewer.js', line: 8, column: 1 },
        { file: 'assets/register-sw.js', line: 9, column: 2 },
        { file: 'assets/viewer.js', line: 10, column: 2 },
      ],
    };
    const wire =
      'relik-error-report/v1\nviewer\nError\npublic-open\nassets/chunk.js\nassets/viewer.js\nassets/register-sw.js';
    const expected = createHash('sha256')
      .update(wire)
      .digest('hex')
      .slice(0, 16);
    expect(fingerprintOf(base)).toBe(expected);
    expect(
      fingerprintOf({
        source: base.source,
        errorClass: base.errorClass,
        route: base.route,
        frames: base.frames.map(({ file }) => ({ file })),
      })
    ).toBe(expected);
    const changedFrames: ErrorFrame[] = [
      { file: 'assets/chunk-a1b2c3d4.js', line: 99, column: 100 },
      { file: 'assets/viewer.js', line: 1, column: 0 },
      { file: 'assets/register-sw.js', line: 100, column: 3 },
      { file: 'assets/register-sw.js', line: 100, column: 3 },
    ];
    expect(
      fingerprintOf({
        ...base,
        revision: 'f'.repeat(40),
        frames: changedFrames,
      })
    ).toBe(expected);
    expect(fingerprintOf({ ...base, errorClass: 'TypeError' })).not.toBe(
      expected
    );
    expect(fingerprintOf({ ...base, source: 'server' })).not.toBe(expected);
    expect(fingerprintOf({ ...base, route: 'dashboard' })).not.toBe(expected);
    expect(
      fingerprintOf({
        ...base,
        frames: [{ file: 'assets/viewer.js', line: 15, column: 0 }],
      })
    ).not.toBe(expected);
    const empty = { ...base, frames: [] };
    expect(fingerprintOf(empty)).toBe(
      createHash('sha256')
        .update('relik-error-report/v1\nviewer\nError\npublic-open\n')
        .digest('hex')
        .slice(0, 16)
    );
  });
});

interface ClassDeclaration {
  name: string;
  base: string;
}

function declaredErrorClasses(
  sources: readonly { name: string; text: string }[]
): Set<string> {
  const declarations: ClassDeclaration[] = [];
  for (const { name, text } of sources) {
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const aliases = new Map<string, string>();
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          aliases.set(
            binding.name.text,
            binding.propertyName?.text ?? binding.name.text
          );
        }
      }
    }
    function visit(node: ts.Node): void {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const variable =
          node.parent &&
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name)
            ? node.parent.name.text
            : undefined;
        const name = node.name?.text ?? variable;
        const clause = node.heritageClauses?.find(
          (item) => item.token === ts.SyntaxKind.ExtendsKeyword
        );
        const base = clause?.types[0]?.expression;
        const baseName =
          base &&
          (ts.isIdentifier(base)
            ? base.text
            : ts.isPropertyAccessExpression(base)
              ? base.name.text
              : undefined);
        if (name && baseName)
          declarations.push({ name, base: aliases.get(baseName) ?? baseName });
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  const baseClasses = [
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
    'DOMException',
  ];
  const errors = new Set(baseClasses);
  let previous = 0;
  while (previous !== errors.size) {
    previous = errors.size;
    for (const declaration of declarations) {
      if (errors.has(declaration.base)) errors.add(declaration.name);
    }
  }
  for (const name of baseClasses) errors.delete(name);
  return errors;
}

test('every declared application error class is allowlisted, including indirect subclasses', () => {
  const packagesDir = resolve(import.meta.dir, '../..');
  const paths = [
    ...new Bun.Glob('*/src/**/*').scanSync({
      cwd: packagesDir,
      absolute: true,
      onlyFiles: true,
    }),
  ].filter((path) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path));
  expect(paths.length).toBeGreaterThan(0);
  const discovered = declaredErrorClasses(
    paths.map((name) => ({ name, text: readFileSync(name, 'utf8') }))
  );
  expect(discovered.has('ProblemError')).toBe(true);
  expect(discovered.has('MalformedContainerError')).toBe(true);
  expect(discovered.has('KeyIdPresentError')).toBe(true);
  const known = new Set<string>(ERROR_CLASSES);
  expect([...discovered].filter((name) => !known.has(name)).sort()).toEqual([]);

  const synthetic = declaredErrorClasses([
    {
      name: 'first.ts',
      text: 'class NewPrivacyError extends Error {}\nclass ChildPrivacyError extends NewPrivacyError {}\n// class Fake extends Error {}',
    },
    {
      name: 'second.ts',
      text: "import { ChildPrivacyError as Base } from './x';\nclass AliasedPrivacyError extends Base {}",
    },
    {
      name: 'third.tsx',
      text: 'const component = <div />;\nclass TypedPrivacyError extends TypeError {}',
    },
  ]);
  expect([...synthetic].filter((name) => !known.has(name)).sort()).toEqual([
    'AliasedPrivacyError',
    'ChildPrivacyError',
    'NewPrivacyError',
    'TypedPrivacyError',
  ]);
});

type ReportApi = typeof reportApi;

const negativeControls: {
  name: string;
  find: string;
  replace: string;
  guard: (api: ReportApi) => void;
}[] = [
  {
    name: 'extra report keys',
    find: 'ownKeys.length !== keys.length',
    replace: 'ownKeys.length < keys.length',
    guard: (api) =>
      expect(
        api.parseClientReport({ ...report(), message: canaries[1] })
      ).toBeNull(),
  },
  {
    name: 'error class membership',
    find: '!ERROR_CLASS_SET.has(errorClass)',
    replace: 'false',
    guard: (api) =>
      expect(
        api.parseLoggedReport({ ...report(), errorClass: 'InjectedError' })
      ).toBeNull(),
  },
  {
    name: 'source-specific route membership',
    find: '!ROUTE_SETS[source].has(route)',
    replace: 'false',
    guard: (api) =>
      expect(
        api.parseClientReport({ ...report(), route: 'relic_show' })
      ).toBeNull(),
  },
  {
    name: 'revision shape',
    find: "!(source === 'mcp' ? MCP_VERSION : REVISION).test(revision)",
    replace: 'false',
    guard: (api) =>
      expect(
        api.parseClientReport({ ...report(), revision: canaries[1] })
      ).toBeNull(),
  },
  {
    name: 'frame count',
    find: 'frames.length > 8',
    replace: 'frames.length > 80',
    guard: (api) =>
      expect(
        api.parseClientReport({
          ...report(),
          frames: Array(9).fill(report().frames[0]),
        })
      ).toBeNull(),
  },
  {
    name: 'frame file allowlist',
    find: '!fileAllowed(file, source)',
    replace: 'false',
    guard: (api) =>
      expect(
        api.parseClientReport({
          ...report(),
          frames: [{ file: canaries[1], line: 1, column: 0 }],
        })
      ).toBeNull(),
  },
  {
    name: 'frame position bounds',
    find: '!positionInBounds(column, 0)',
    replace: 'false',
    guard: (api) =>
      expect(
        api.parseClientReport({
          ...report(),
          frames: [{ file: 'assets/viewer.js', line: 1, column: -1 }],
        })
      ).toBeNull(),
  },
  {
    name: 'declared error classes',
    find: "  'ProblemError',\n",
    replace: '',
    guard: (api) => expect(api.ERROR_CLASSES).toContain('ProblemError'),
  },
  {
    name: 'viewer origin',
    find: 'url.origin !== page.origin ||',
    replace: 'false ||',
    guard: (api) =>
      expect(
        api.viewerFramesFrom(
          'at open (https://evil.example/assets/viewer.js:1:2)',
          'https://relik.link'
        )
      ).toEqual([]),
  },
  {
    name: 'server stack path',
    find: 'if (!SERVER_FILE.test(file)) continue;',
    replace: 'if (false) continue;',
    guard: (api) =>
      expect(
        api.nodeFramesFrom('at /Users/jane/secret.ts:1:2', 'server')
      ).toEqual([]),
  },
  {
    name: 'fingerprint chunk normalization',
    find: "? 'assets/chunk.js' : file",
    replace: '? file : file',
    guard: (api) => {
      const first = {
        ...report(),
        frames: [{ file: 'assets/chunk-1tft2rar.js', line: 1, column: 0 }],
      };
      const second = {
        ...first,
        frames: [{ file: 'assets/chunk-a1b2c3d4.js', line: 1, column: 0 }],
      };
      expect(api.fingerprintOf(first)).toBe(api.fingerprintOf(second));
    },
  },
  {
    name: 'non-object classification',
    find: "return 'NonError';",
    replace: "return 'Other';",
    guard: (api) => expect(api.classOf('untrusted')).toBe('NonError'),
  },
  {
    name: 'client count restriction',
    find: 'report.count === 1',
    replace: 'true',
    guard: (api) =>
      expect(api.parseClientReport({ ...report(), count: 2 })).toBeNull(),
  },
  {
    name: 'client source restriction',
    find: "report.source !== 'server'",
    replace: 'true',
    guard: (api) => expect(api.parseClientReport(report('server'))).toBeNull(),
  },
  {
    name: 'known viewer assets',
    find: '!known.viewerFiles.has(file)',
    replace: 'false',
    guard: (api) =>
      expect(
        api.parseClientReport(report(), { viewerFiles: new Set() })
      ).toBeNull(),
  },
];

for (const control of negativeControls) {
  test(`negative control detects broken ${control.name}`, () => {
    const sourcePath = new URL('../src/error-report.ts', import.meta.url);
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toContain(control.find);
    const mutant = source.replace(control.find, control.replace);
    const javascript = ts.transpileModule(mutant, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const load = runInNewContext(
      `(require) => { const exports = {}; ${javascript}\n return exports; }`,
      { TextEncoder, URL }
    );
    const broken: ReportApi = load((name: string) => {
      if (name !== './sha256.ts') throw new Error('unexpected mutant import');
      return { sha256Hex };
    });
    control.guard(reportApi);
    expect(() => control.guard(broken)).toThrow();
  });
}
