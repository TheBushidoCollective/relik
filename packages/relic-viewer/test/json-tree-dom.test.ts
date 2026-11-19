import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type * as ViewModule from '../src/json-tree-view.ts';

function findHeadlessShell(): string | undefined {
  const configured = process.env['RELIC_CHROME_PATH'];
  if (configured && existsSync(configured)) return configured;
  const owned = join(
    process.env['HOME'] ?? '',
    '.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'
  );
  if (existsSync(owned)) return owned;
  const base = join(process.env['HOME'] ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const version of versions) {
      const path = join(
        base,
        version,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell'
      );
      if (existsSync(path)) return path;
    }
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
}

// Executed in an isolated headless browser, against the real DOM and the built
// view module. Every assertion here reads the page, not a model of it.
async function browserCases(
  view: typeof ViewModule,
  progress: (name: string) => Promise<unknown>
): Promise<string[]> {
  const passed: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
      );
  };
  const truth = (value: unknown, label: string): void => {
    if (!value) throw new Error(label);
  };

  function mount(source: string) {
    const root = document.createElement('div');
    root.className = 'structured-view structured-tree';
    document.body.append(root);
    const sourceView = (): HTMLElement => {
      const pre = document.createElement('pre');
      pre.className = 'source-fallback';
      pre.textContent = source;
      return pre;
    };
    const part = view.mountView({
      root,
      filename: 'data.json',
      mimetype: 'application/json',
      source,
      sourceView,
    });
    return { root, part };
  }

  function rowFor(root: HTMLElement, key: string): HTMLElement {
    for (const row of root.querySelectorAll<HTMLElement>('.jt-row')) {
      if (row.querySelector('.jt-key')?.textContent === key) return row;
    }
    throw new Error(`no row for ${key}`);
  }

  function button(root: HTMLElement, label: string): HTMLButtonElement {
    for (const node of root.querySelectorAll<HTMLButtonElement>('button')) {
      if (node.textContent === label) return node;
    }
    throw new Error(`no button ${label}`);
  }

  async function check(
    name: string,
    run: () => void | Promise<void>
  ): Promise<void> {
    try {
      await progress(name);
      await run();
      passed.push(name);
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await check(
    'hostile markup in keys and values is text, and no element is created',
    () => {
      const hostile = '<img src=x onerror=alert(1)>';
      const { root } = mount(JSON.stringify({ [hostile]: hostile }));
      eq(
        root.querySelectorAll('img, script, svg, iframe').length,
        0,
        'elements'
      );
      truth(
        root.textContent?.includes(JSON.stringify(hostile)),
        'literal text shown'
      );
    }
  );

  await check('bidi and control characters are visible escapes', () => {
    const { root } = mount('{"k\u202e":"a\u2066b\u009f"}');
    const text = root.textContent ?? '';
    truth(text.includes('\\u202e'), 'bidi key escape shown');
    truth(
      text.includes('\\u2066') && text.includes('\\u009f'),
      'value escapes shown'
    );
    truth(
      !text.includes('\u202e') && !text.includes('\u2066'),
      'raw bidi text not drawn'
    );
  });

  await check(
    'duplicate keys: the ignored one and the one that counts both say so',
    () => {
      const { root } = mount('{"a":1,"a":2}');
      const badges = [...root.querySelectorAll('.jt-dup')].map(
        (node) => node.textContent
      );
      eq(
        badges,
        ['DUPLICATE KEY · IGNORED', 'DUPLICATE KEY · THIS ONE COUNTS'],
        'badges'
      );
    }
  );

  await check(
    'a syntax error draws the reason above the source, and no tree',
    () => {
      const { root } = mount('{"a" 1}');
      const notice =
        root.querySelector('.structured-notice')?.textContent ?? '';
      truth(notice.includes('Line 1, column 6'), `position: ${notice}`);
      truth(
        notice.includes('expected a colon after the property name'),
        'reason'
      );
      eq(root.querySelector('[role="tree"]'), null, 'no tree');
      truth(root.querySelector('.source-fallback') !== null, 'source shown');
    }
  );

  await check(
    'select a node, anchor it, mark it, then collapse and expand: the mark comes back',
    () => {
      const { root, part } = mount('{"queue":{"retry":{"max_attempts":5}}}');
      const row = rowFor(root, '"max_attempts"');
      row.querySelector<HTMLElement>('.jt-key')!.click();
      const anchor = part!.selectionAnchor();
      eq(
        anchor,
        { kind: 'path', pointer: '/queue/retry/max_attempts' },
        'anchor'
      );
      truth(part!.paintMark(anchor!, 'c1'), 'paint landed');
      truth(
        rowFor(root, '"max_attempts"').querySelector('.jt-mark') !== null,
        'mark painted'
      );
      button(root, 'Collapse all').click();
      eq(root.querySelector('.jt-mark'), null, 'hidden after collapse');
      eq(
        [...root.querySelectorAll('.jt-key')].map((n) => n.textContent),
        ['$', '"queue"'],
        'collapsed rows'
      );
      button(root, 'Expand all').click();
      truth(
        rowFor(root, '"max_attempts"').querySelector('.jt-mark') !== null,
        'mark after expand'
      );
      button(root, 'Collapse all').click();
      part!.reveal(anchor!);
      truth(
        rowFor(root, '"max_attempts"').getAttribute('aria-selected') === 'true',
        'reveal selects'
      );
      part!.dispose();
    }
  );

  await check('a legacy quote paints on the node its text sits in', () => {
    const { root, part } = mount('{"queue":{"retry":{"max_attempts":5}}}');
    truth(
      part!.paintMark(
        {
          kind: 'quote',
          exact: '5',
          prefix: 'max_attempts":',
          suffix: '}',
        } as never,
        'c2'
      ),
      'quote landed'
    );
    truth(
      rowFor(root, '"max_attempts"').querySelector('.jt-mark') !== null,
      'mark on value'
    );
    part!.clearMarks();
    eq(root.querySelector('.jt-mark'), null, 'cleared');
  });

  await check(
    'an ignored duplicate has no comment, and the comment control says why',
    () => {
      const { root, part } = mount('{"a":1,"a":2}');
      const first = root.querySelectorAll<HTMLElement>('.jt-row')[1]!;
      first.querySelector<HTMLElement>('.jt-key')!.click();
      eq(part!.selectionAnchor(), undefined, 'no anchor');
      truth(button(root, 'Comment').disabled, 'comment disabled');
    }
  );

  await check(
    'the comment control hands the selected anchor to the reader',
    () => {
      const { root } = mount('{"a":{"b":1}}');
      let received: unknown;
      root.addEventListener('relic:structured-comment', (event) => {
        received = (event as CustomEvent).detail;
      });
      rowFor(root, '"b"').querySelector<HTMLElement>('.jt-key')!.click();
      button(root, 'Comment').click();
      eq(
        received,
        { anchor: { kind: 'path', pointer: '/a/b' } },
        'event detail'
      );
    }
  );

  await check(
    'arrow keys move the selection and keep aria-activedescendant on it',
    () => {
      const { root } = mount('{"queue":{"retry":{"n":1}}}');
      const scroller = root.querySelector<HTMLElement>('[role="tree"]')!;
      scroller.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        })
      );
      eq(
        rowFor(root, '"queue"').getAttribute('aria-selected'),
        'true',
        'down to queue'
      );
      scroller.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        })
      );
      eq(
        rowFor(root, '"retry"').getAttribute('aria-selected'),
        'true',
        'right enters queue'
      );
      eq(
        scroller.getAttribute('aria-activedescendant'),
        rowFor(root, '"retry"').id,
        'active descendant'
      );
    }
  );

  await check(
    'a 50,000-value array draws only a window, and scrolls to the rest',
    async () => {
      const values = Array.from({ length: 50_000 }, (_, index) => index);
      const started = performance.now();
      const { root } = mount(JSON.stringify(values));
      const elapsed = performance.now() - started;
      const scroller = root.querySelector<HTMLElement>('[role="tree"]')!;
      const drawn = root.querySelectorAll('.jt-row').length;
      truth(drawn > 0 && drawn < 100, `window size ${drawn}`);
      const spacer = root.querySelector<HTMLElement>('.jt-spacer')!;
      eq(spacer.offsetHeight, 50_001 * 24, 'spacer height');
      scroller.scrollTop = 24 * 1000;
      scroller.dispatchEvent(new Event('scroll'));
      truth(
        [...root.querySelectorAll('.jt-key')].some(
          (node) => node.textContent === '1000'
        ),
        'row 1000 drawn after scroll'
      );
      truth(elapsed < 3000, `mount took ${elapsed.toFixed(0)} ms`);
    }
  );

  return passed;
}

const shell = findHeadlessShell();
const cssPath = resolve(import.meta.dir, '../src/json-tree-view.css');

describe('JSON tree view in the browser', () => {
  test.skipIf(!shell)(
    'draws, marks, navigates and refuses hostile markup without creating elements',
    async () => {
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../src/json-tree-view.ts')],
        target: 'browser',
        format: 'esm',
        splitting: false,
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const script = await build.outputs[0]!.text();
      const css = readFileSync(cssPath, 'utf8');
      const stage: string[] = [];
      const { promise, resolve: report } = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const page = `<!doctype html><meta charset="utf-8">
      <link rel="stylesheet" href="/assets/json-tree-view.css">
      <body><script type="module">
      import * as view from '/json-tree-view.js';
      try {
        await new Promise((ready) => {
          const link = document.querySelector('link');
          if (link.sheet) ready(); else link.addEventListener('load', ready);
        });
        const passed = await (${browserCases.toString()})(view, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {}));
        await fetch('/result', {method: 'POST', body: JSON.stringify({passed})});
      } catch (error) {
        await fetch('/result', {method: 'POST', body: JSON.stringify({error: error && (error.stack || error.message) || String(error)})});
      }
      </script>`;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/progress') {
            stage.push(await request.text());
            return new Response('ok');
          }
          if (url.pathname === '/result') {
            report(
              (await request.json()) as { passed?: string[]; error?: string }
            );
            return new Response('ok');
          }
          if (url.pathname === '/json-tree-view.js')
            return new Response(script, {
              headers: { 'content-type': 'text/javascript' },
            });
          if (url.pathname === '/assets/json-tree-view.css')
            return new Response(css, {
              headers: { 'content-type': 'text/css' },
            });
          return new Response(page, {
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      const profile = join(tmpdir(), `relic-json-tree-${crypto.randomUUID()}`);
      const browser = spawn(
        shell!,
        [
          basename(shell!).includes('headless-shell')
            ? '--headless'
            : '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--mute-audio',
          `--window-size=1440,900`,
          `http://127.0.0.1:${server.port}/`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      try {
        const exited = Promise.withResolvers<never>();
        browser.once('error', exited.reject);
        browser.once('exit', (code) =>
          exited.reject(
            new Error(`headless browser exited before reporting: ${code}`)
          )
        );
        const stalled = Promise.withResolvers<never>();
        // A real timer on purpose: this drives a real browser, and a hang has to
        // fail with evidence before bun's own test limit hides it.
        const timer = setTimeout(() => {
          stalled.reject(
            new Error(
              `the page did not report within 60 s; cases started: ${JSON.stringify(stage)}`
            )
          );
        }, 60_000);
        let result: { passed?: string[]; error?: string };
        try {
          result = await Promise.race([
            promise,
            exited.promise,
            stalled.promise,
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (result.error) throw new Error(result.error);
        expect(result.passed).toHaveLength(10);
      } finally {
        browser.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null) {
          await once(browser, 'exit');
        }
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    120_000
  );
});
