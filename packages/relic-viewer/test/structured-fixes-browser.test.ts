import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * Structured views in a real DOM: scroll redraw, display caps, escaped labels,
 * clipboard text and the pointer Comment rule (security review SF-UNCAPPED-
 * REDRAW, SF-BIDI-LABELS, SF-CLIPBOARD-RAW, SF-POINTER-UNWRITABLE). Runs in an
 * isolated headless shell with a throwaway profile, never the user's browser.
 */

function findHeadlessShell(): string | undefined {
  const configured = process.env['RELIC_CHROME_PATH'];
  if (configured && existsSync(configured)) return configured;
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

// Runs in the page. Self-contained: it reads only its arguments and the DOM.
async function pageCases(
  api: {
    mountDataTable: (
      root: HTMLElement,
      table: unknown,
      options: { filename: string }
    ) => { dispose(): void };
    mountJsonTree: (mount: unknown) => { dispose(): void } | undefined;
    mountCues: (mount: unknown) =>
      | {
          paintMark(anchor: unknown, id: string): boolean;
          clearMarks(): void;
          dispose(): void;
        }
      | undefined;
    parseTable: (text: string) => {
      ok: boolean;
      table?: unknown;
      reason?: string;
    };
  },
  report: (name: string) => Promise<unknown>
): Promise<string[]> {
  const passed: string[] = [];
  const truth = (value: unknown, label: string): void => {
    if (!value) throw new Error(label);
  };
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) {
      throw new Error(
        `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
      );
    }
  };
  const frames = (): Promise<void> =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  const click = (el: Element | null | undefined, label: string): void => {
    if (!el) throw new Error(`no element: ${label}`);
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      );
    }
  };
  const byText = (root: HTMLElement, text: string): HTMLButtonElement => {
    const found = [...root.querySelectorAll('button')].find(
      (button) => button.textContent === text
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
  };

  // Clipboard writes are recorded, not sent: the page has no clipboard grant.
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });

  const mountTable = (text: string, filename: string) => {
    const parsed = api.parseTable(text);
    if (!parsed.ok || parsed.table === undefined) {
      throw new Error(`refused: ${parsed.reason}`);
    }
    const root = document.createElement('section');
    document.body.append(root);
    const part = api.mountDataTable(root, parsed.table, { filename });
    const grid = root.querySelector<HTMLElement>('.dt-grid');
    if (grid === null) throw new Error('no grid');
    grid.style.height = '200px';
    grid.style.overflow = 'auto';
    return { root, part, grid };
  };

  const mountTree = (source: string) => {
    const root = document.createElement('section');
    document.body.append(root);
    const part = api.mountJsonTree({
      root,
      filename: 'fixture.json',
      mimetype: 'application/json',
      source,
      sourceView: () => document.createElement('pre'),
      reportUnshown: () => {},
    });
    const scroller = root.querySelector<HTMLElement>('.jt-scroll');
    if (scroller === null || part === undefined) {
      throw new Error(`tree refused: ${root.textContent?.slice(0, 200)}`);
    }
    scroller.style.height = '200px';
    scroller.style.overflow = 'auto';
    return { root, part, scroller };
  };

  const check = async (
    name: string,
    run: () => void | Promise<void>
  ): Promise<void> => {
    await report(name);
    copied.length = 0;
    await run();
    passed.push(name);
  };

  await check(
    'a 1 px scroll keeps the drawn table rows, a window move redraws',
    async () => {
      const lines = ['n,v'];
      for (let i = 0; i < 200; i++) lines.push(`r${i},${i}`);
      const f = mountTable(lines.join('\n'), 'rows.csv');
      try {
        await frames();
        f.grid.dispatchEvent(new Event('scroll'));
        await frames();
        const before = f.grid.querySelector('.dt-row');
        truth(before, 'rows are drawn');
        f.grid.scrollTop = 1;
        f.grid.dispatchEvent(new Event('scroll'));
        await frames();
        truth(before?.isConnected, 'a 1 px scroll rebuilt the drawn rows');
        f.grid.scrollTop = 1200;
        f.grid.dispatchEvent(new Event('scroll'));
        await frames();
        truth(
          !before?.isConnected,
          'a scroll that moved the window did not redraw'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  await check(
    'a long cell is cut for display, its row line and grid label escape bidi',
    async () => {
      const long = 'y'.repeat(3072) + 'END';
      const f = mountTable(`name\u202Efix,n\n${long},1\n`, 'fix\u202Eb.csv');
      try {
        click(f.grid.querySelector('[data-r="1"][data-c="0"]'), 'cell');
        eq(
          f.root.querySelector('.dt-sub')?.textContent,
          'Row 2, name\\u{202E}fix',
          'row line'
        );
        const value = f.root.querySelector('.dt-value')?.textContent ?? '';
        truth(
          value.length <= 514,
          `inspector value is ${value.length} characters`
        );
        truth(!value.includes('END'), 'the cut left the tail in the inspector');
        const cellText = f.grid.querySelector(
          '[data-r="1"][data-c="0"] .dt-text'
        );
        truth(
          (cellText?.textContent ?? '').length <= 514,
          'the grid cell is not capped'
        );
        truth(
          !f.root.textContent?.includes('\u202e'),
          'raw bidi reached the page'
        );
        truth(
          f.grid.getAttribute('aria-label')?.includes('fix\\u{202E}b.csv'),
          'the grid label carries the raw filename'
        );
        truth(
          !f.grid.getAttribute('aria-label')?.includes('\u202e'),
          'the grid label carries a raw bidi control'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  await check(
    'copying a cell with ESC and LF gives the escape, not the raw bytes',
    async () => {
      const f = mountTable('k,v\n"\u001b[201~\nid",1\n', 'esc.csv');
      try {
        click(f.grid.querySelector('[data-r="1"][data-c="0"]'), 'cell');
        click(f.root.querySelector('.dt-copy'), 'copy');
        eq(copied[0], '\\u{1B}[201~\nid', 'the clipboard text');
        truth(
          !copied[0]?.includes('\u001b'),
          'a raw ESC reached the clipboard'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  await check('a decoded U+202E key shows escaped in the pointer', async () => {
    const f = mountTree('{"\\u202Eabc":1}');
    try {
      click(
        f.root.querySelectorAll('.jt-row')[1]?.querySelector('.jt-key'),
        'member'
      );
      eq(
        f.root.querySelector('.jt-pointer')?.textContent,
        '/\\u202eabc',
        'pointer'
      );
      truth(
        !f.root.textContent?.includes('\u202e'),
        'raw bidi reached the page'
      );
    } finally {
      f.part.dispose();
      f.root.remove();
    }
  });

  await check(
    'Copy path writes the escaped pointer, never raw ESC or LF',
    async () => {
      const f = mountTree('{"\\u001b[201~\\nid":1}');
      try {
        click(
          f.root.querySelectorAll('.jt-row')[1]?.querySelector('.jt-key'),
          'member'
        );
        click(byText(f.root, 'Copy path'), 'copy path');
        eq(copied[0], '/\\u001b[201~0\\u000aid', 'the copied path');
        truth(
          !copied[0]?.includes('\u001b') && !copied[0]?.includes('\n'),
          'raw control reached the clipboard'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  await check(
    'a key holding a CR keeps Comment off, with the reason',
    async () => {
      const f = mountTree('{"a\\rb":1}');
      try {
        click(
          f.root.querySelectorAll('.jt-row')[1]?.querySelector('.jt-key'),
          'member'
        );
        const comment = byText(f.root, 'Comment');
        eq(
          comment.disabled,
          true,
          'Comment is enabled for an unwritable pointer'
        );
        truth(
          comment.title.includes('NUL or carriage return'),
          `the reason is "${comment.title}"`
        );
        eq(
          f.root.querySelector('.jt-pointer')?.textContent,
          '/a\\u000db',
          'pointer'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  await check(
    'a 1 px scroll keeps the drawn tree rows, a window move redraws',
    async () => {
      const members: string[] = [];
      for (let i = 0; i < 200; i++) members.push(`"k${i}":${i}`);
      const f = mountTree(`{${members.join(',')}}`);
      try {
        await frames();
        f.scroller.dispatchEvent(new Event('scroll'));
        await frames();
        const before = f.scroller.querySelector('.jt-row');
        truth(before, 'rows are drawn');
        f.scroller.scrollTop = 1;
        f.scroller.dispatchEvent(new Event('scroll'));
        await frames();
        truth(before?.isConnected, 'a 1 px scroll rebuilt the drawn rows');
        f.scroller.scrollTop = 1200;
        f.scroller.dispatchEvent(new Event('scroll'));
        await frames();
        truth(
          !before?.isConnected,
          'a scroll that moved the window did not redraw'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  await check('a 1 MB key is cut for display', async () => {
    const f = mountTree(`{"${'k'.repeat(1 << 20)}":1}`);
    try {
      const key = f.root
        .querySelectorAll('.jt-row')[1]
        ?.querySelector('.jt-key');
      truth(
        (key?.textContent ?? '').length <= 514,
        `the key label is ${key?.textContent?.length} characters`
      );
    } finally {
      f.part.dispose();
      f.root.remove();
    }
  });

  await check(
    'a comment spanning every cue marks 500 of them, and the title says so',
    async () => {
      const cues: string[] = [];
      const stamp = (s: number): string => {
        const h = String(Math.floor(s / 3600)).padStart(2, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const sec = String(s % 60).padStart(2, '0');
        return `${h}:${m}:${sec},000`;
      };
      for (let i = 0; i < 2000; i++) {
        cues.push(
          `${i + 1}\n${stamp(i * 2)} --> ${stamp(i * 2 + 2)}\ncue ${i}\n`
        );
      }
      const root = document.createElement('section');
      document.body.append(root);
      const part = api.mountCues({
        root,
        filename: 'long.srt',
        mimetype: 'application/x-subrip',
        source: cues.join('\n'),
        sourceView: () => document.createElement('pre'),
        reportUnshown: () => {},
      });
      try {
        truth(part, 'the cues were refused');
        truth(
          part?.paintMark({ kind: 'time', t: 0, t_end: 4000 }, 'whole'),
          'the span was not painted'
        );
        const marks = root.querySelectorAll<HTMLElement>('.cue-mark');
        eq(marks.length, 500, 'marks on the cues');
        truth(
          marks[0]?.title.includes('spans 2000 cues') === true,
          `the title is "${marks[0]?.title}"`
        );
      } finally {
        part?.dispose();
        root.remove();
      }
    }
  );

  await check(
    'a table cell mark repaints its own cell and no other',
    async () => {
      const lines = ['a,b'];
      for (let i = 0; i < 20; i++) lines.push(`x${i},y${i}`);
      const f = mountTable(lines.join('\n'), 'cells.csv');
      try {
        f.grid.dispatchEvent(new Event('scroll'));
        await frames();
        truth(
          f.part.paintMark({ kind: 'cell', row: 3, col: 2 }, 'one'),
          'the mark was not painted'
        );
        truth(
          f.grid
            .querySelector('[data-r="2"][data-c="1"]')
            ?.classList.contains('is-marked'),
          'the marked cell has no is-marked class'
        );
        truth(
          !f.grid
            .querySelector('[data-r="2"][data-c="0"]')
            ?.classList.contains('is-marked'),
          'a neighbouring cell is marked'
        );
      } finally {
        f.part.dispose();
        f.root.remove();
      }
    }
  );

  return passed;
}

const shell = findHeadlessShell();

describe('structured views in the browser', () => {
  test.skipIf(!shell)(
    'redraw, caps, escaped labels, clipboard and the pointer rule hold in a real DOM',
    async () => {
      const build = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, 'structured-fixes-browser-entry.ts'),
        ],
        target: 'browser',
        format: 'esm',
        splitting: false,
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const script = await build.outputs[0]!.text();
      const { promise, resolve: report } = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const seen: string[] = [];
      const started: string[] = [];
      const stderr = { tail: '' };
      const page = `<!doctype html><meta charset="utf-8"><script type="module">
        import * as api from '/structured-fixes.js';
        try {
          const passed = await (${pageCases.toString()})(api, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {}));
          await fetch('/result', {method: 'POST', body: JSON.stringify({passed})});
        } catch (error) {
          await fetch('/result', {method: 'POST', body: JSON.stringify({error: (error && (error.stack || error.message)) || String(error)})});
        }
      </script>`;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          seen.push(`${request.method} ${url.pathname}`);
          if (url.pathname === '/progress') {
            started.push(await request.text());
            return new Response('ok');
          }
          if (url.pathname === '/result') {
            report(
              (await request.json()) as { passed?: string[]; error?: string }
            );
            return new Response('ok');
          }
          if (url.pathname === '/structured-fixes.js') {
            return new Response(script, {
              headers: { 'content-type': 'text/javascript' },
            });
          }
          return new Response(page, {
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      const profile = join(
        tmpdir(),
        `relic-structured-fixes-${crypto.randomUUID()}`
      );
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
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--disable-breakpad',
          '--mute-audio',
          `http://127.0.0.1:${server.port}/`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      browser.stderr?.on('data', (chunk: Buffer) => {
        stderr.tail = (stderr.tail + chunk.toString('utf8')).slice(-4096);
      });
      try {
        const exited = Promise.withResolvers<never>();
        browser.once('error', exited.reject);
        browser.once('exit', (code) =>
          exited.reject(
            new Error(`headless browser exited before reporting: ${code}`)
          )
        );
        const stalled = Promise.withResolvers<never>();
        const timer = setTimeout(() => {
          stalled.reject(
            new Error(
              `the page did not report within 120 s. requests: ${JSON.stringify(seen)}; ` +
                `cases started: ${JSON.stringify(started)}; stderr: ${JSON.stringify(stderr.tail)}`
            )
          );
        }, 120_000);
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
    150000
  );
});
