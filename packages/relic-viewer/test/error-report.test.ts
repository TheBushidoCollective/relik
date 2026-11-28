import { describe, expect, spyOn, test } from 'bun:test';
import { generateRelicId } from '@relic/format';
import { parseClientReport } from '@relic/format/error-report';
import * as ts from 'typescript';
import { reporterPageStateReferences } from './error-report-guard.ts';
import {
  installErrorReporter,
  reportViewerError,
} from '../src/error-report.ts';

const origin = 'https://viewer.example';
const revision = 'a'.repeat(40);
const canaries = [
  generateRelicId(),
  'jane.doe@example.com',
  '/Users/jane/Secret Plans.pdf',
  `#${'b'.repeat(43)}`,
];

type Listener = (event: never) => void;
type CapturedRequest = { input: RequestInfo | URL; init: RequestInit };

function forbidden(): never {
  throw new Error('a private page property was read');
}

function fixture(
  data: Record<string, string | undefined> = { revision },
  response: () => Promise<Response> = async () =>
    new Response(null, { status: 204 })
) {
  const listeners = new Map<string, Listener>();
  const calls: CapturedRequest[] = [];
  const win = {
    origin,
    addEventListener(type: string, callback: Listener) {
      listeners.set(type, callback);
    },
    get location() {
      return forbidden();
    },
    get localStorage() {
      return forbidden();
    },
    get sessionStorage() {
      return forbidden();
    },
    get document() {
      return forbidden();
    },
    get name() {
      return forbidden();
    },
  } as unknown as Window;
  const dataset = new Proxy(data, {
    get(target, property) {
      if (
        property === 'revision' ||
        property === 'view' ||
        property === 'relicAccess'
      )
        return target[property];
      return forbidden();
    },
  });
  const root = { dataset } as unknown as HTMLElement;
  const send = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init: init ?? {} });
    return response();
  };
  return {
    calls,
    listeners,
    install: () => installErrorReporter(win, root, send),
    emit(type: string, event: unknown) {
      listeners.get(type)?.(event as never);
    },
  };
}

function errorAt(line: number, kind: 'Error' | 'TypeError' = 'Error'): Error {
  const error =
    kind === 'TypeError' ? new TypeError('hidden') : new Error('hidden');
  error.stack = `Error: hidden\n    at open (${origin}/assets/viewer.js:${line}:7)`;
  return error;
}

function assertNoCanaries(value: unknown): void {
  const rendered = JSON.stringify(value);
  for (const canary of canaries) expect(rendered).not.toContain(canary);
}

describe('viewer error reporting', () => {
  test('reporter source never references private page state', async () => {
    const source = await Bun.file(
      new URL('../src/error-report.ts', import.meta.url)
    ).text();
    const tree = ts.createSourceFile(
      'error-report.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(reporterPageStateReferences(tree)).toEqual([]);
  });

  test('page-state guard rejects direct, computed, and aliased references', () => {
    for (const source of [
      'location.hash',
      'window["location"]["hash"]',
      'const { location: stolen } = window',
      'history.back()',
      'document.cookie',
      'document.referrer',
      'document.title',
      'localStorage.getItem("key")',
      'sessionStorage.getItem("key")',
      'indexedDB.open("private")',
      'window.name',
      'new URL("https://example.test/#key").hash',
      'Reflect.get(window, "name")',
      'const key = "location"; win[key]',
      'Reflect.get(win, key)',
    ]) {
      const tree = ts.createSourceFile(
        'bad.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      expect(reporterPageStateReferences(tree).length).toBeGreaterThan(0);
    }
    const safe = ts.createSourceFile(
      'safe.ts',
      'const route = "document"; win.origin; root.dataset["view"]; frames[0];',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(reporterPageStateReferences(safe)).toEqual([]);
  });

  test('never reads or sends the page fragment and title', () => {
    const key = canaries[3]!;
    const accesses: string[] = [];
    const requests: string[] = [];
    const listeners = new Map<string, Listener>();
    const win = {
      origin,
      get location() {
        accesses.push('location');
        return { hash: key };
      },
      get document() {
        accesses.push('document');
        return { title: key };
      },
      addEventListener(type: string, listener: Listener) {
        listeners.set(type, listener);
      },
    } as unknown as Window;
    installErrorReporter(
      win,
      { dataset: { revision } } as unknown as HTMLElement,
      async (_input, init) => {
        requests.push(String(init?.body));
        return new Response(null, { status: 204 });
      }
    );
    listeners.get('error')?.({ error: errorAt(14) } as never);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain(key);
    expect(parseClientReport(JSON.parse(requests[0]!))).not.toBeNull();
    expect(accesses).toEqual([]);
  });

  test('never serializes attacker-controlled values', () => {
    const capturedLogs: unknown[] = [];
    const logs = (['log', 'warn', 'error', 'debug'] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        capturedLogs.push(args);
      })
    );
    try {
      const page = fixture({
        revision,
        view: 'document',
        relicAccess: 'public',
      });
      page.install();
      const error = new TypeError(canaries.join(' '));
      error.name = canaries[1]!;
      error.stack = [
        `TypeError: ${canaries.join(' ')}`,
        `    at ${canaries.join('_')} (${origin}/assets/viewer.js?secret=${encodeURIComponent(canaries.join(' '))}${canaries[3]}:42:7)`,
        `    at ${canaries.join('_')} (${origin}/assets/${encodeURIComponent(canaries.join(' '))}.js:3:4)`,
        `    at ${canaries.join('_')} (https://attacker.example/assets/viewer.js:9:1)`,
        `    at next (${origin}/assets/chunk-a1b2c3d4.js?secret=${encodeURIComponent(canaries[1]!)}:8:1)`,
        ...canaries.map((canary) => `    at ${canary}:2:3`),
      ].join('\n');
      Object.assign(error, {
        cause: canaries.join(' '),
        filename: canaries[2],
        url: `${origin}/${canaries.join('/')}`,
      });
      const event = {
        error,
        get message() {
          return forbidden();
        },
        get filename() {
          return forbidden();
        },
        get lineno() {
          return forbidden();
        },
        get colno() {
          return forbidden();
        },
      };
      page.emit('error', event);
      expect(page.calls).toHaveLength(1);
      const call = page.calls[0]!;
      expect(call.input).toBe('/api/error-reports');
      expect(call.init).toEqual({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: expect.any(String),
        credentials: 'omit',
        keepalive: true,
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      const body = JSON.parse(call.init.body as string);
      assertNoCanaries([page.calls, capturedLogs]);
      expect(parseClientReport(body)).toEqual({
        v: 1,
        source: 'viewer',
        errorClass: 'TypeError',
        route: 'document',
        revision,
        frames: [
          { file: 'assets/viewer.js', line: 42, column: 7 },
          { file: 'assets/chunk-a1b2c3d4.js', line: 8, column: 1 },
        ],
        count: 1,
      });
      expect(capturedLogs).toEqual([]);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  test('drops each canary from every error and root string field', () => {
    for (const canary of canaries) {
      const page = fixture({
        revision,
        view: canary,
        relicAccess: canary,
      });
      page.install();
      const error = {
        name: canary,
        message: canary,
        cause: canary,
        filename: canary,
        stack: `${canary}\n    at ${canary} (${origin}/assets/viewer.js?secret=${encodeURIComponent(canary)}:42:7)`,
      };
      page.emit('error', {
        error,
        message: canary,
        filename: canary,
        lineno: canary,
        colno: canary,
      });
      expect(page.calls).toHaveLength(1);
      const body = JSON.parse(page.calls[0]!.init.body as string);
      expect(parseClientReport(body)?.errorClass).toBe('Other');
      expect(body.route).toBe('public-open');
      assertNoCanaries(page.calls);
    }
  });

  test('installs only for an exact lowercase 40-hex revision', () => {
    for (const invalid of [
      undefined,
      '',
      'a'.repeat(39),
      'A'.repeat(40),
      `${revision}\n`,
      ...canaries,
    ]) {
      const page = fixture({ revision: invalid });
      page.install();
      expect(page.listeners.size).toBe(0);
      reportViewerError(errorAt(1));
      expect(page.calls).toEqual([]);
    }
    const page = fixture();
    page.install();
    expect([...page.listeners.keys()].sort()).toEqual([
      'error',
      'unhandledrejection',
    ]);
  });

  test('derives only fixed surfaces from the root attributes', () => {
    for (const [data, expected] of [
      [{}, 'public-open'],
      [{ view: 'dashboard' }, 'dashboard'],
      [{ view: 'publish' }, 'publish'],
      [{ view: 'document' }, 'document'],
      [{ view: 'dashboard', relicAccess: 'private' }, 'private-reader'],
      [{ view: canaries.join(' '), relicAccess: canaries[0] }, 'public-open'],
    ] as const) {
      const page = fixture({ revision, ...data });
      page.install();
      reportViewerError(errorAt(1));
      expect(page.calls).toHaveLength(1);
      expect(JSON.parse(page.calls[0]!.init.body as string).route).toBe(
        expected
      );
      assertNoCanaries(page.calls);
    }
  });

  test('accepts only object errors with at least one allowlisted same-origin frame', () => {
    const page = fixture();
    page.install();
    for (const value of [undefined, null, 'secret', 1, false, () => {}]) {
      page.emit('error', { error: value, message: canaries.join(' ') });
      page.emit('unhandledrejection', { reason: value });
      reportViewerError(value);
    }
    for (const stack of [
      undefined,
      canaries.join(' '),
      'at https://attacker.example/assets/viewer.js:1:2',
      `at ${origin}/assets/sandbox.js:1:2`,
      `at ${origin}/assets/viewer.js:0:2`,
    ]) {
      page.emit('unhandledrejection', {
        reason: { stack, message: canaries.join(' ') },
      });
    }
    expect(page.calls).toEqual([]);
    page.emit('unhandledrejection', { reason: errorAt(3) });
    expect(page.calls).toHaveLength(1);
  });

  test('reports fixed scripts and code-split chunks from the viewing origin', () => {
    for (const file of [
      'viewer.js',
      'register-sw.js',
      'model-view.js',
      'pdf.worker.js',
      'chunk-a1b2c3d4.js',
    ]) {
      const page = fixture();
      page.install();
      const error = errorAt(1);
      error.stack = `at ${origin}/assets/${file}:2:3`;
      reportViewerError(error);
      expect(page.calls).toHaveLength(1);
      const body = JSON.parse(page.calls[0]!.init.body as string);
      expect(parseClientReport(body)?.frames).toEqual([
        { file: `assets/${file}`, line: 2, column: 3 },
      ]);
    }
  });

  test('deduplicates by class and first frame and caps the page at five sends', () => {
    const page = fixture();
    page.install();
    page.emit('error', { error: errorAt(1) });
    const repeated = errorAt(1);
    repeated.stack += `\n    at other (${origin}/assets/chunk-a1b2c3d4.js:4:2)`;
    page.emit('unhandledrejection', { reason: repeated });
    reportViewerError(errorAt(1));
    expect(page.calls).toHaveLength(1);
    reportViewerError(errorAt(1, 'TypeError'));
    for (let line = 2; line <= 5; line++) reportViewerError(errorAt(line));
    expect(page.calls).toHaveLength(5);
    expect(
      page.calls.map(
        ({ init }) => JSON.parse(init.body as string).frames[0].line
      )
    ).toEqual([1, 1, 2, 3, 4]);
  });

  test('ignores a 404, rejected or synchronously failed send without retry', async () => {
    for (const response of [
      async () => new Response(null, { status: 404 }),
      async () => {
        throw new Error(canaries.join(' '));
      },
      () => {
        throw new Error(canaries.join(' '));
      },
    ]) {
      const page = fixture({ revision }, response);
      page.install();
      expect(() => reportViewerError(errorAt(1))).not.toThrow();
      reportViewerError(errorAt(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(page.calls).toHaveLength(1);
      assertNoCanaries(page.calls);
    }
  });

  test('swallows hostile getters and a window that cannot install listeners', () => {
    const page = fixture();
    page.install();
    const throwing = new Proxy({}, { get: forbidden });
    expect(() => page.emit('error', throwing)).not.toThrow();
    expect(() => page.emit('unhandledrejection', throwing)).not.toThrow();
    expect(() => reportViewerError(throwing)).not.toThrow();
    expect(page.calls).toEqual([]);
    expect(() =>
      installErrorReporter(
        {
          get origin() {
            return forbidden();
          },
        } as unknown as Window,
        { dataset: { revision } } as unknown as HTMLElement,
        () => forbidden()
      )
    ).not.toThrow();
  });
});
