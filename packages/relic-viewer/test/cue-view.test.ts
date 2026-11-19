import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type * as BridgeModule from '../src/structured-view-bridge.ts';

// The cue list, driven in an isolated headless browser: a throwaway profile,
// the page served over loopback, and the browser stopped afterwards. The cases
// use real DOM ranges, selection and events, through the structured-view
// bridge the route uses, so the anchor a reader gets is the one a comment is
// written with.

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

// The mock's S1 cue list (docs/plans/structured-formats/mockup.html): a STYLE
// block, two NOTE blocks, speakers, italics, and the hostile `<img>` cue.
const S1_VTT = [
  'WEBVTT',
  '',
  'STYLE',
  '::cue(v[voice="Lena Brandt"]) { color: #a7ded6; }',
  '',
  'NOTE',
  'Recorded 2026-09-11 at Tamarack yard.',
  '',
  '00:00:01.200 --> 00:00:04.800',
  '<v Lena Brandt>This is Larkspur Field 4.12, on a tablet with no signal.',
  '',
  '00:00:05.100 --> 00:00:08.900',
  '<v Lena Brandt>I\u2019m filling in a hydrant inspection the way the crews do it.',
  '',
  '00:00:09.300 --> 00:00:12.600',
  '<i>Tap, tap. Photo of the bonnet.</i>',
  '',
  '00:00:13.000 --> 00:00:17.400',
  '<v Lena Brandt>The form saves to the device. The queue banner says <i>one form waiting</i>.',
  '',
  '00:00:17.900 --> 00:00:21.200',
  '<v Marcus Ohene>And if she drives out of the dead zone?',
  '',
  '00:00:21.400 --> 00:00:25.900',
  '<v Lena Brandt>It sends on its own. No button. The server checks every form by checksum.',
  '',
  '00:00:26.300 --> 00:00:30.100',
  '<v Marcus Ohene>What you must not do is clear the app\u2019s data while forms are waiting.',
  '',
  '00:00:30.500 --> 00:00:34.800',
  '<v Marcus Ohene>Those forms live only on the device until the server confirms them.',
  '',
  '00:00:35.200 --> 00:00:38.600',
  '<i>Banner turns green: 0 forms waiting.</i>',
  '',
  '00:00:39.000 --> 00:00:43.400',
  '<v Lena Brandt>That\u2019s the whole trick. Fill it in where you stand.',
  '',
  '00:00:43.800 --> 00:00:46.200',
  '<v Lena Brandt>Sync when you can.',
  '',
  '00:00:46.900 --> 00:00:51.000',
  '<img src=x onerror=alert(1)> Ask the crew lead before a device changes hands.',
  '',
  '00:00:51.400 --> 00:00:55.000',
  '<v Marcus Ohene>Version 4.12 is on the managed tablets from Monday.',
  '',
].join('\n');

// The mock's S3: an SRT with four blocks that cannot be read as cues.
const S3_SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'First cue.',
  '',
  'x',
  '00:00:03,000 -> 00:00:04,000',
  'Broken arrow.',
  '',
  '3',
  '00:00:05,000 --> 00:00:04,000',
  'Ends before it starts.',
  '',
  '4',
  '00:00:06,000 --> 00:00:07,000',
  '',
  '5',
  '00:01,000 --> 00:00:09,000',
  'No hours in SubRip.',
  '',
  '6',
  '00:00:10,000 --> 00:00:11,000',
  'Last cue.',
  '',
].join('\n');

const fixtures = { s1: S1_VTT, s3: S3_SRT };

// Runs in the page. Every name it uses is an argument or a global, because the
// function is serialised and sent to the browser as text.
async function browserCases(
  bridge: typeof BridgeModule,
  fixtures: { s1: string; s3: string },
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
  const check = async (name: string, body: () => Promise<void> | void) => {
    await progress(name);
    await body();
    passed.push(name);
  };
  const mountCues = (source: string, filename: string, mimetype: string) => {
    const root = document.createElement('section');
    document.body.append(root);
    const handle = bridge.mountStructuredView(root, 'cues', {
      filename,
      mimetype,
      source,
      sourceView: () => {
        const pre = document.createElement('pre');
        pre.className = 'source';
        pre.textContent = source;
        return pre;
      },
    });
    return { root, handle };
  };
  const cueRows = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('li.cue:not(.is-block)'));
  const rowAt = (root: HTMLElement, index: number): HTMLElement => {
    const row = root.querySelector<HTMLElement>(
      `li.cue[data-cue-index="${index}"]`
    );
    if (row === null) throw new Error(`no cue ${index}`);
    return row;
  };
  const selectText = (range: Range): void => {
    const selection = document.getSelection();
    if (selection === null) throw new Error('no selection');
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const find = (root: HTMLElement, query: string): void => {
    const input = root.querySelector<HTMLInputElement>('input.cues-find');
    if (input === null) throw new Error('no find box');
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  await check('S1: cues, speakers, italics and blocks draw', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    eq(handle.structured, true, 'drawn');
    eq(cueRows(root).length, 13, 'cue rows');
    eq(root.querySelectorAll('li.cue.is-block').length, 2, 'block rows');
    eq(
      root.querySelector('.cue-speaker')?.textContent,
      'Lena Brandt',
      'speaker'
    );
    eq(
      rowAt(root, 3).querySelector('em')?.textContent,
      'Tap, tap. Photo of the bonnet.',
      'italic run'
    );
    eq(
      root.querySelector('.cues-summary')?.textContent,
      '13 cues \u00b7 0:55 \u00b7 2 speakers \u00b7 WebVTT',
      'summary'
    );
    handle.dispose();
    root.remove();
  });

  await check('S1: markup in a cue creates no element', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    eq(
      root.querySelectorAll('img, script, iframe, object, embed').length,
      0,
      'elements'
    );
    eq(
      rowAt(root, 12).querySelector('.cue-text')?.textContent,
      '<img src=x onerror=alert(1)> Ask the crew lead before a device changes hands.',
      'hostile cue as text'
    );
    handle.dispose();
    root.remove();
  });

  await check('select cue 3 -> time anchor -> mark painted', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    rowAt(root, 3).click();
    const anchor = handle.selectionAnchor();
    eq(anchor, { kind: 'time', t: 9.3, t_end: 12.6 }, 'cue 3 anchor');
    eq(handle.paintMark(anchor as never, 'c1'), true, 'painted');
    truth(
      rowAt(root, 3).querySelector('[data-comment-id="c1"]'),
      'mark in cue 3'
    );
    truth(
      !rowAt(root, 2).querySelector('[data-comment-id="c1"]'),
      'no mark in cue 2'
    );
    truth(rowAt(root, 3).classList.contains('is-commented'), 'row marked');
    handle.clearMarks();
    truth(!root.querySelector('[data-comment-id]'), 'cleared');
    handle.dispose();
    root.remove();
  });

  await check('a selection across cues is one time range', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    const range = document.createRange();
    range.setStart(rowAt(root, 2).querySelector('.cue-text') as Node, 0);
    range.setEnd(rowAt(root, 4).querySelector('.cue-text') as Node, 0);
    selectText(range);
    eq(
      handle.selectionAnchor(),
      { kind: 'time', t: 5.1, t_end: 17.4 },
      'range'
    );
    handle.dispose();
    root.remove();
  });

  await check(
    'a part of one cue stays a quote, not a time anchor',
    async () => {
      const { root, handle } = mountCues(
        fixtures.s1,
        'field-app-demo.vtt',
        'text/vtt'
      );
      await handle.ready;
      const em = rowAt(root, 3).querySelector('em')?.firstChild as Node;
      const range = document.createRange();
      range.setStart(em, 0);
      range.setEnd(em, 3);
      selectText(range);
      eq(handle.selectionAnchor(), undefined, 'partial cue');
      handle.dispose();
      root.remove();
    }
  );

  await check('find filters cues and counts matches', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    find(root, 'checksum');
    eq(cueRows(root).filter((row) => !row.hidden).length, 1, 'visible cues');
    eq(root.querySelector('.cues-find-count')?.textContent, '1 match', 'count');
    find(root, '');
    eq(cueRows(root).filter((row) => row.hidden).length, 0, 'all shown again');
    handle.dispose();
    root.remove();
  });

  await check('arrow keys move focus between cues', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    const first = rowAt(root, 1);
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    eq(document.activeElement?.getAttribute('data-cue-index'), '2', 'down');
    rowAt(root, 2).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    eq(document.activeElement?.getAttribute('data-cue-index'), '13', 'end');
    handle.dispose();
    root.remove();
  });

  await check('Enter selects a cue and gives its time anchor', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    const row = rowAt(root, 6);
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    eq(
      handle.selectionAnchor(),
      { kind: 'time', t: 21.4, t_end: 25.9 },
      'enter'
    );
    handle.dispose();
    root.remove();
  });

  await check('View source replaces the cue list with the source', async () => {
    const { root, handle } = mountCues(
      fixtures.s1,
      'field-app-demo.vtt',
      'text/vtt'
    );
    await handle.ready;
    root.querySelector<HTMLButtonElement>('.cues-action')?.click();
    eq(handle.structured, false, 'no longer drawn');
    truth(root.querySelector('pre.source'), 'source shown');
    root.remove();
  });

  await check('S3: skipped blocks are noticed and the rest reads', async () => {
    const { root, handle } = mountCues(
      fixtures.s3,
      'field-app-demo.srt',
      'application/x-subrip'
    );
    await handle.ready;
    eq(cueRows(root).length, 2, 'cues');
    eq(
      root.querySelector('.cues-notice')?.textContent,
      '4 blocks could not be read as cues. View source to see them.',
      'notice'
    );
    handle.dispose();
    root.remove();
  });

  await check(
    'a file with no cues shows its source with a notice',
    async () => {
      const { root, handle } = mountCues(
        'WEBVTT\n\nNOTE only a note',
        'notes.vtt',
        'text/vtt'
      );
      await handle.ready;
      eq(
        root.querySelector('.cues-notice')?.textContent,
        'This file has no readable cues, so its text is shown.',
        'notice'
      );
      truth(root.querySelector('pre.source'), 'source present');
      eq(root.querySelectorAll('li.cue').length, 0, 'no rows');
      handle.dispose();
      root.remove();
    }
  );

  await check('bidi characters show as visible escapes', async () => {
    const { root, handle } = mountCues(
      '1\n00:00:01,000 --> 00:00:02,000\nA\u202eB',
      'bidi.srt',
      'application/x-subrip'
    );
    await handle.ready;
    const text = rowAt(root, 1).querySelector('.cue-text')?.textContent ?? '';
    truth(text.includes('[U+202E]'), 'escape shown');
    truth(!text.includes('\u202e'), 'raw control gone');
    handle.dispose();
    root.remove();
  });

  return passed;
}

const shell = findHeadlessShell();
describe('the cue list in the browser', () => {
  test.skipIf(!shell)(
    'selects cues, paints their marks and refuses hostile markup',
    async () => {
      const build = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, '../src/structured-view-bridge.ts'),
          resolve(import.meta.dir, '../src/cue-view.ts'),
        ],
        target: 'browser',
        format: 'esm',
        splitting: false,
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const modules = new Map<string, string>();
      for (const output of build.outputs)
        modules.set(`/${output.path.split('/').at(-1)}`, await output.text());
      const seen: string[] = [];
      const started: string[] = [];
      const stderr = { tail: '' };
      const { promise, resolve: report } = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const page = `<!doctype html><meta charset="utf-8"><script type="module">
      import * as bridge from '/structured-view-bridge.js';
      const fixtures = ${JSON.stringify(fixtures)};
      try { const passed = await (${browserCases.toString()})(bridge, fixtures, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {})); await fetch('/result', {method: 'POST', body: JSON.stringify({passed})}); }
      catch (error) { await fetch('/result', {method: 'POST', body: JSON.stringify({error: error && (error.stack || error.message) || String(error)})}); }
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
          const module = modules.get(url.pathname);
          if (module !== undefined)
            return new Response(module, {
              headers: { 'content-type': 'text/javascript' },
            });
          return new Response(page, {
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      const profile = join(tmpdir(), `relic-cue-view-${crypto.randomUUID()}`);
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
        // A real timer on purpose: this drives a real browser, and a hang has no event to await.
        const stallTimer = setTimeout(() => {
          stalled.reject(
            new Error(
              `the page did not report within 60 s. requests seen: ${JSON.stringify(seen)}; ` +
                `cases started: ${JSON.stringify(started)}; stderr tail: ${JSON.stringify(stderr.tail)}`
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
          clearTimeout(stallTimer);
        }
        if (result.error) throw new Error(result.error);
        expect(result.passed).toHaveLength(12);
      } finally {
        browser.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null) {
          await once(browser, 'exit');
        }
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    90000
  );
});
