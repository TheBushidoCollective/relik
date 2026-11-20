import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { type CommentAnchor, encodeKey } from '@relic/format';
import type * as ContentModule from '../src/content.ts';
import type * as CommentsModule from '../src/comments.ts';
import type * as QuoteModule from '../src/annotate-quote.ts';
import type * as StageModule from '../src/main.ts';
import type * as ViewerModule from '../src/viewer.ts';
import type * as FormatModule from '@relic/format';

// The structured views' comment path, in an isolated headless browser. The page
// runs the real stage, selection offer, composer, thread and mark painting from
// `main.ts`; only the transport is a stub, and it keeps what it is sent, as the
// service does, so a reloaded comment paints through the real decrypt path. Each
// case does what a reader does (a click, a selection, a Comment control, a post,
// a toggle) and reads back the anchor the transport received, from the sealed
// body the page wrote. The page waits on DOM mutations and transport calls, never
// on a clock.

const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_BYTES = new Uint8Array(16).map((_, index) => (index * 7 + 3) & 0xff);
const FRAGMENT = `#r1${encodeKey(KEY_BYTES)}`;

const CSV = 'item,qty,note\nbolt,4,steel\nnut,12,brass\nwasher,7,zinc\n';
const JSON_TEXT = '{\n  "name": "Larkspur",\n  "tags": ["a", "b"]\n}\n';
const VTT = [
  'WEBVTT',
  '',
  '00:00:01.200 --> 00:00:04.800',
  'This is Larkspur Field 4.12.',
  '',
  '00:00:05.100 --> 00:00:08.900',
  'The form saves to the device.',
  '',
].join('\n');
const IPYNB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Survey\n'] },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      outputs: [],
      source: ['print(1)\n'],
    },
  ],
});

const fixtures = {
  csv: CSV,
  json: JSON_TEXT,
  vtt: VTT,
  ipynb: IPYNB,
  fragment: FRAGMENT,
  key: Array.from(KEY_BYTES),
  relicId: RELIC_ID,
};

interface PageModules {
  readonly stage: typeof StageModule;
  readonly viewer: typeof ViewerModule;
  readonly content: typeof ContentModule;
  readonly quote: typeof QuoteModule;
  readonly comments: typeof CommentsModule;
  readonly format: typeof FormatModule;
}

/** A relic as the route fixtures build it, for the viewer's stage. */
interface ViewFixture {
  readonly filename: string;
  readonly declaredMimetype: string;
  readonly content: ContentModule.RelicContent;
  readonly document: {
    readonly bytes: Uint8Array;
    readonly truncated: boolean;
  };
  readonly route: string;
  readonly downgradeNotice: undefined;
  readonly shareUrl: string;
  readonly version: number;
  readonly currentVersion: number;
  readonly versionDigest: string;
}

/** The fixtures the page receives: the files, the relic key and its id. */
interface PageFixtures {
  readonly csv: string;
  readonly json: string;
  readonly vtt: string;
  readonly ipynb: string;
  readonly fragment: string;
  readonly key: readonly number[];
  readonly relicId: string;
}

// Runs in the page. Everything it needs arrives as an argument, because the
// function is serialised and sent to the browser as text.
async function browserCases(
  modules: PageModules,
  fixtures: PageFixtures,
  progress: (name: string) => Promise<unknown>
): Promise<string[]> {
  const { stage, content, quote, comments, format } = modules;
  const passed: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
      );
  };
  function truth(value: unknown, label: string): asserts value {
    if (!value) throw new Error(label);
  }
  const check = async (name: string, body: () => Promise<void>) => {
    await progress(name);
    await body();
    passed.push(name);
  };

  // Resolves when the DOM matches, from mutation records and nothing else. The
  // label is reported first, so a wait that never ends names the step it was in.
  const until = (label: string, predicate: () => boolean): Promise<void> => {
    void progress(`waiting: ${label}`);
    if (predicate()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const observer = new MutationObserver(() => {
      if (!predicate()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return promise;
  };

  const key = await format.deriveCommentKey(new Uint8Array(fixtures.key));
  const cipher = comments.commentCipher(key);

  // Each transport write, in order, with its sealed body, so a case reads the
  // anchor the service received rather than the one the page meant to send.
  const posted: string[] = [];
  const postWaiters: Array<() => void> = [];

  let records: unknown[] = [];
  window.addEventListener('unhandledrejection', (event) => {
    void progress(`unhandled: ${String(event.reason?.stack ?? event.reason)}`);
  });
  window.addEventListener('error', (event) => {
    void progress(`error: ${event.message}`);
  });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void progress(`transport: ${init?.method ?? 'GET'} ${String(input)}`);
    const url = String(input);
    if (url.endsWith('/api/auth/session')) {
      return Response.json({ email: 'ada@example.com' });
    }
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const wire = JSON.parse(init.body) as { ciphertext: string };
      posted.push(wire.ciphertext);
      records = [
        ...records,
        {
          comment_id: `c${posted.length}`,
          author: 'ada@example.com',
          created_at: '2026-11-19T00:00:00Z',
          edited_at: null,
          resolved_at: null,
          resolved_by: null,
          ciphertext: wire.ciphertext,
        },
      ];
      for (const wake of postWaiters.splice(0)) wake();
      return Response.json({
        comment_id: `c${posted.length}`,
        author: 'ada@example.com',
      });
    }
    if (init?.method === 'GET' || init?.method === undefined) {
      return Response.json(records);
    }
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;

  const encoder = new TextEncoder();
  const viewOf = (
    filename: string,
    mimetype: string,
    route: string,
    text: string
  ): ViewFixture => ({
    filename,
    declaredMimetype: mimetype,
    content: content.contentFromBytes(encoder.encode(text)),
    document: { bytes: encoder.encode(text), truncated: false },
    route,
    downgradeNotice: undefined,
    shareUrl: `https://relik.example/${fixtures.relicId}${fixtures.fragment}`,
    version: 1,
    currentVersion: 1,
    versionDigest: '0'.repeat(64),
  });

  // The route's stage and comment thread, wired as the viewer wires them. A
  // seeded comment is sealed with the relic's key, so it travels the real path.
  const mountRelic = async (
    view: ViewFixture,
    seeds: Array<{ id: string; body: string; anchor: CommentAnchor }> = []
  ) => {
    records = await Promise.all(
      seeds.map(async (seed) => ({
        comment_id: seed.id,
        author: 'ada@example.com',
        created_at: '2026-11-18T00:00:00Z',
        edited_at: null,
        resolved_at: null,
        resolved_by: null,
        ciphertext: await cipher.seal({
          body: seed.body,
          display_name: null,
          anchor: seed.anchor,
          addresses: null,
        }),
      }))
    );
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:900px;height:700px';
    const wrap = stage.buildStageWrap(
      view as never,
      'https://relik-usercontent.example'
    );
    host.appendChild(wrap);
    const thread = stage.buildThread(
      view as never,
      fixtures.relicId,
      {
        serviceOrigin: 'https://relik.example',
        fetch: transport,
        takeFragment: () => fixtures.fragment,
        stripFragment: () => {},
        locationHref: `https://relik.example/${fixtures.relicId}`,
        keyVault: {
          remember: () => {},
          recall: () => undefined,
          forget: () => {},
        },
      } as never,
      () => undefined
    );
    document.body.replaceChildren(host, thread.element);
    await thread.ready;
    void progress(
      `mount: thread ready, status: ${JSON.stringify(thread.element.textContent?.slice(0, 240))}`
    );
    thread.attach(host);
    await until('the thread has loaded', () => {
      return thread.element.dataset['threadReady'] === 'true';
    });
    await thread.idle();
    return { host, thread };
  };

  // A reader's press and release over a drawn cell. The table re-renders its rows
  // on mousedown, so the cell the press started on can be detached by the time
  // the button is released. The release lands on the cell now under the pointer,
  // which is the one the same selector finds after the render.
  const press = (host: HTMLElement, selector: string): void => {
    const start = host.querySelector(selector);
    if (start === null) throw new Error(`no element for ${selector}`);
    start.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    );
    const release = host.querySelector(selector);
    if (release === null)
      throw new Error(`no element after press: ${selector}`);
    release.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  // A reader's selection of a whole element's text, as the cue list makes it.
  const selectText = (element: Element): void => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  const openComposerWith = async (host: HTMLElement, label: string) => {
    await until(
      `the composer opens for ${label}`,
      () => host.querySelector('.popover-composer .popover-field') !== null
    );
    return host.querySelector<HTMLElement>('.popover-composer');
  };
  const postFromComposer = async (host: HTMLElement, body: string) => {
    const field = host.querySelector<HTMLTextAreaElement>(
      '.popover-composer .popover-field'
    );
    if (field === null) throw new Error('the composer has no field');
    field.value = body;
    const submit = host.querySelector<HTMLButtonElement>(
      '.popover-composer .popover-tools .is-primary'
    );
    if (submit === null) throw new Error('the composer has no Post button');
    const wrote = Promise.withResolvers<void>();
    postWaiters.push(wrote.resolve);
    submit.click();
    await wrote.promise;
  };
  // The most recent post. Posts are shared by every case, so a case reads what
  // it wrote last, never an index that another case may have filled.
  const anchorPosted = async (): Promise<CommentAnchor> => {
    const sealed = posted.at(-1);
    if (sealed === undefined) throw new Error('nothing was posted');
    const body = await cipher.open(sealed);
    return body.anchor as CommentAnchor;
  };
  const targetLabel = (host: HTMLElement): string =>
    host.querySelector('.popover-target')?.textContent ?? '';
  const offerComment = async (host: HTMLElement): Promise<void> => {
    await until(
      'the selection offer opens',
      () => host.querySelector('.popover-comment') !== null
    );
    host.querySelector<HTMLButtonElement>('.popover-comment')?.click();
  };

  await check(
    'a CSV cell offers a comment and posts a cell anchor',
    async () => {
      const { host } = await mountRelic(
        viewOf('data.csv', 'text/csv', 'code', fixtures.csv)
      );
      await until(
        'the table draws',
        () => host.querySelector('.dt-cell') !== null
      );
      // Record 1 is the "bolt" row, which is row 2 of the file; column 1 is qty.
      const bolt = '.dt-cell[data-r="1"][data-c="1"]';
      truth(host.querySelector(bolt), 'the bolt qty cell is drawn');
      press(host, bolt);
      await offerComment(host);
      await openComposerWith(host, 'the cell');
      truth(
        targetLabel(host).startsWith('Commenting on cell'),
        `chip: ${targetLabel(host)}`
      );
      await postFromComposer(host, 'Check this quantity');
      eq(
        await anchorPosted(),
        { kind: 'cell', row: 2, col: 2 },
        'the posted cell anchor'
      );
    }
  );

  await check(
    'a CSV column header posts a row 1 cell anchor for that column',
    async () => {
      const { host } = await mountRelic(
        viewOf('data.csv', 'text/csv', 'code', fixtures.csv)
      );
      await until(
        'the table draws',
        () => host.querySelector('.dt-hc-comment') !== null
      );
      host.querySelectorAll<HTMLButtonElement>('.dt-hc-comment')[1]?.click();
      await openComposerWith(host, 'the column header');
      await postFromComposer(host, 'Header note');
      eq(
        await anchorPosted(),
        { kind: 'cell', row: 1, col: 2 },
        'the posted header anchor'
      );
    }
  );

  await check('a JSON node comment posts a path anchor', async () => {
    const { host } = await mountRelic(
      viewOf('data.json', 'application/json', 'code', fixtures.json)
    );
    await until('the tree draws', () => host.querySelector('.jt-row') !== null);
    // The "name" row: the row's own node is selected by its click.
    const row = [...host.querySelectorAll<HTMLElement>('.jt-row')].find(
      (item) => item.textContent?.includes('name')
    );
    truth(row, 'the name row is drawn');
    row.click();
    await until('the Comment control is enabled', () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent?.trim() === 'Comment' && !button.disabled
      )
    );
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find(
        (button) => button.textContent?.trim() === 'Comment' && !button.disabled
      )
      ?.click();
    await openComposerWith(host, 'the node');
    await postFromComposer(host, 'Look at this value');
    eq(
      await anchorPosted(),
      { kind: 'path', pointer: '/name' },
      'the posted node pointer'
    );
  });

  await check('a cue comment posts a time anchor for that cue', async () => {
    const { host } = await mountRelic(
      viewOf('talk.vtt', 'text/vtt', 'code', fixtures.vtt)
    );
    await until(
      'the cue list draws',
      () => host.querySelector('.cue-text') !== null
    );
    const cue = host.querySelector<HTMLElement>('.cue-text');
    truth(cue, 'a cue text is drawn');
    selectText(cue);
    await offerComment(host);
    await openComposerWith(host, 'the cue');
    truth(targetLabel(host).includes('subtitle'), `chip: ${targetLabel(host)}`);
    await postFromComposer(host, 'Quote check');
    eq(
      await anchorPosted(),
      { kind: 'time', t: 1.2, t_end: 4.8 },
      'the posted cue span'
    );
  });

  await check(
    'a cue selected to its last character posts the cue span, not a quote',
    async () => {
      const { host } = await mountRelic(
        viewOf('talk.vtt', 'text/vtt', 'code', fixtures.vtt)
      );
      await until(
        'the cue list draws',
        () => host.querySelector('.cue-text') !== null
      );
      const cue = host.querySelector<HTMLElement>('.cue-text');
      truth(cue, 'a cue text is drawn');
      // A reader's selection from the cue's first character to the end of its
      // last text node. The end is a text offset, not the element boundary.
      const walker = document.createTreeWalker(cue, NodeFilter.SHOW_TEXT);
      let firstText: Text | undefined;
      let lastText: Text | undefined;
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        firstText ??= node as Text;
        lastText = node as Text;
      }
      truth(firstText && lastText, 'the cue has text nodes');
      const range = document.createRange();
      range.setStart(firstText, 0);
      range.setEnd(lastText, lastText.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      cue.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await offerComment(host);
      await openComposerWith(host, 'the cue');
      await postFromComposer(host, 'Full cue');
      eq(
        await anchorPosted(),
        { kind: 'time', t: 1.2, t_end: 4.8 },
        'the posted cue span'
      );
    }
  );

  // A drag that begins in a row's margin can put the selection's start at the
  // very end of the previous cue's text, and one that stops short can end at the
  // very start of the next cue's. Touching an edge selects none of that cue.
  const touching = async (
    label: string,
    ends: {
      from: 'end-of-first' | 'start-of-first';
      to: 'end-of-second' | 'start-of-second';
    },
    expected: { kind: 'time'; t: number; t_end: number }
  ): Promise<void> => {
    await check(label, async () => {
      const { host } = await mountRelic(
        viewOf('talk.vtt', 'text/vtt', 'code', fixtures.vtt)
      );
      await until(
        'two cues draw',
        () => host.querySelectorAll('.cue-text').length > 1
      );
      const texts = Array.from(host.querySelectorAll<HTMLElement>('.cue-text'));
      const first = texts[0];
      const second = texts[1];
      truth(first && second, 'two cue texts are drawn');
      const edge = (cue: HTMLElement, atEnd: boolean): [Text, number] => {
        const walker = document.createTreeWalker(cue, NodeFilter.SHOW_TEXT);
        let found: Text | undefined;
        for (
          let node = walker.nextNode();
          node !== null;
          node = walker.nextNode()
        ) {
          if (atEnd || found === undefined) found = node as Text;
        }
        truth(found, 'the cue has text nodes');
        return [found, atEnd ? found.length : 0];
      };
      const [fromNode, fromOffset] = edge(first, ends.from === 'end-of-first');
      const [toNode, toOffset] = edge(second, ends.to === 'end-of-second');
      const range = document.createRange();
      range.setStart(fromNode, fromOffset);
      range.setEnd(toNode, toOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      second.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await offerComment(host);
      await openComposerWith(host, 'the cue');
      await postFromComposer(host, 'Edge');
      eq(await anchorPosted(), expected, 'the posted cue span');
    });
  };
  await touching(
    'a selection starting at the end of one cue does not take that cue in',
    { from: 'end-of-first', to: 'end-of-second' },
    { kind: 'time', t: 5.1, t_end: 8.9 }
  );
  await touching(
    'a selection ending at the start of the next cue does not take it in',
    { from: 'start-of-first', to: 'start-of-second' },
    { kind: 'time', t: 1.2, t_end: 4.8 }
  );

  await check(
    'a notebook cell comment posts a path anchor for that cell',
    async () => {
      const { host } = await mountRelic(
        viewOf(
          'survey.ipynb',
          'application/x-ipynb+json',
          'notebook',
          fixtures.ipynb
        )
      );
      await until(
        'the notebook draws',
        () =>
          host.querySelector('.nb-comment[data-pointer="/cells/1"]') !== null
      );
      host
        .querySelector<HTMLButtonElement>(
          '.nb-comment[data-pointer="/cells/1"]'
        )
        ?.click();
      await openComposerWith(host, 'the cell');
      await postFromComposer(host, 'Why print here');
      eq(
        await anchorPosted(),
        { kind: 'path', pointer: '/cells/1' },
        'the posted cell pointer'
      );
    }
  );
  await check(
    'an output comment control is not clipped by its own block',
    async () => {
      const withOutput = JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: 'code',
            execution_count: 1,
            metadata: {},
            source: ['print(1)\n'],
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
          },
        ],
      });
      const { host } = await mountRelic(
        viewOf(
          'output.ipynb',
          'application/x-ipynb+json',
          'notebook',
          withOutput
        )
      );
      await until(
        'the output control draws',
        () => host.querySelector('.nb-out .nb-tools .nb-comment') !== null
      );
      // A reader's hover reveals the toolbar. The test has no pointer, so the
      // reveal is set directly, as the hover rule sets it.
      const tools = host.querySelector<HTMLElement>('.nb-out .nb-tools');
      truth(tools, 'the output toolbar is drawn');
      tools.style.display = 'flex';
      const control = tools.querySelector<HTMLElement>('.nb-comment');
      truth(control, 'the output comment control is drawn');
      control.scrollIntoView({ block: 'center' });
      const box = control.getBoundingClientRect();
      const centre = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      truth(
        centre !== null && control.contains(centre),
        `the centre of the output control is the control, not ${centre?.className ?? 'nothing'}`
      );
    }
  );

  await check(
    'a legacy quote is placed by the tree and never wrapped in its rows',
    async () => {
      const seed = {
        id: 'legacy',
        body: 'old note',
        anchor: { kind: 'quote', exact: 'Larkspur' } as CommentAnchor,
      };
      const { host } = await mountRelic(
        viewOf('data.json', 'application/json', 'code', fixtures.json),
        [seed]
      );
      await until(
        'the tree draws and paints the legacy mark',
        () => host.querySelector('.jt-mark') !== null
      );
      eq(
        host.querySelectorAll('mark.relic-text-mark').length,
        0,
        'no text is wrapped in the tree'
      );
      const surface = { host, content: host } as never;
      eq(
        quote.quoteAdapter.supports(surface),
        false,
        'the generic quote adapter declines a drawn tree'
      );
      eq(
        quote.structuredQuoteAdapter.supports(surface),
        true,
        'the tree takes the quote itself'
      );
    }
  );

  await check(
    'a cell comment paints, and the View source toggle keeps it both ways',
    async () => {
      const { host } = await mountRelic(
        viewOf('data.csv', 'text/csv', 'code', fixtures.csv)
      );
      await until(
        'the table draws',
        () => host.querySelector('.dt-cell') !== null
      );
      press(host, '.dt-cell[data-r="1"][data-c="1"]');
      await offerComment(host);
      await openComposerWith(host, 'the cell');
      await postFromComposer(host, 'Keep this mark');
      const markedCell = '.dt-cell.is-marked[data-r="1"][data-c="1"]';
      await until(
        'the cell mark paints',
        () => host.querySelector(markedCell) !== null
      );

      const toggle = host.querySelector<HTMLButtonElement>(
        '.toggle-row .action'
      );
      truth(toggle, 'the toggle row carries a View source button');
      eq(
        toggle.textContent?.trim(),
        'View source',
        'the toggle starts as View source'
      );
      toggle.click();
      await until(
        'the source view replaces the table',
        () => host.querySelector('.dt-cell') === null
      );
      truth(
        host.querySelector('.code-body, pre, table'),
        'the source view is drawn'
      );
      eq(
        toggle.textContent?.trim(),
        'View table',
        'the toggle now offers the table'
      );

      toggle.click();
      await until(
        'the table returns with its mark',
        () => host.querySelector(markedCell) !== null
      );
      eq(
        toggle.textContent?.trim(),
        'View source',
        'the toggle offers the source again'
      );
    }
  );

  return passed;
}

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

const shell = findHeadlessShell();
describe('structured views: the comment path in the browser', () => {
  test.skipIf(!shell)(
    'selects, comments and toggles through the real stage',
    async () => {
      // One build with splitting, so the modules the page imports share one
      // instance: the adapter registry the stage paints through is the one
      // the page's quote adapter reads.
      const build = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, '../src/main.ts'),
          resolve(import.meta.dir, '../src/viewer.ts'),
          resolve(import.meta.dir, '../src/content.ts'),
          resolve(import.meta.dir, '../src/annotate-quote.ts'),
          resolve(import.meta.dir, '../src/comments.ts'),
          Bun.resolveSync('@relic/format', import.meta.dir),
        ],
        target: 'browser',
        format: 'esm',
        splitting: true,
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const modules = new Map<string, string>();
      for (const output of build.outputs)
        modules.set(`/${basename(output.path)}`, await output.text());
      const started: string[] = [];
      const stderr = { tail: '' };
      const { promise, resolve: report } = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/cue-view.css"><link rel="stylesheet" href="/assets/json-tree-view.css"><link rel="stylesheet" href="/assets/data-table.css"><link rel="stylesheet" href="/assets/notebook-view.css"><script type="module">
      import * as stage from '/main.js';
      import * as viewer from '/viewer.js';
      import * as content from '/content.js';
      import * as quote from '/annotate-quote.js';
      import * as comments from '/comments.js';
      import * as format from '/index.js';
      const fixtures = ${JSON.stringify(fixtures)};
      try { const passed = await (${browserCases.toString()})({ stage, viewer, content, quote, comments, format }, fixtures, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {})); await fetch('/result', {method: 'POST', body: JSON.stringify({passed})}); }
      catch (error) { await fetch('/result', {method: 'POST', body: JSON.stringify({error: error && (error.stack || error.message) || String(error)})}); }
    </script>`;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
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
          if (
            url.pathname.startsWith('/assets/') &&
            url.pathname.endsWith('.css')
          ) {
            const css = resolve(
              import.meta.dir,
              `../src/${url.pathname.slice('/assets/'.length)}`
            );
            if (existsSync(css))
              return new Response(await Bun.file(css).text(), {
                headers: { 'content-type': 'text/css' },
              });
          }
          return new Response(page, {
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      const profile = join(
        tmpdir(),
        `relic-structured-comments-${crypto.randomUUID()}`
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
        // A real timer on purpose: a browser that hangs emits no event to await.
        const stallTimer = setTimeout(() => {
          stalled.reject(
            new Error(
              `the page did not report within 120 s; cases started: ${JSON.stringify(started)}; stderr tail: ${JSON.stringify(stderr.tail)}`
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
          clearTimeout(stallTimer);
        }
        if (result.error) throw new Error(result.error);
        expect(result.passed).toHaveLength(11);
      } finally {
        browser.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null) {
          await once(browser, 'exit');
        }
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    150_000
  );
});
