import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type * as EditorModule from '../src/suggest-editor.ts';
import type * as MarkdownModule from '../src/markdown-source.ts';
import type {
  PendingSuggestion,
  SuggestCommit,
  SuggestDraft,
} from '../src/suggest-draft.ts';

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

// Executed in an isolated headless browser. These use actual DOM Ranges, events,
// MutationObserver and the real adapter, not an approximation of those APIs.
async function browserCases(
  editorModule: typeof EditorModule,
  markdown: typeof MarkdownModule
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
  const turn = (): Promise<void> => Promise.resolve();

  function fixture(
    source: string,
    pending: readonly PendingSuggestion[] = [],
    paint?: (root: HTMLElement) => void
  ) {
    const map = markdown.renderMarkdownWithSource(source);
    const chrome = document.createElement('div');
    const root = document.createElement('article');
    root.className = 'prose';
    root.innerHTML = map.html;
    document.body.append(chrome, root);
    paint?.(root);
    const commits: SuggestCommit[] = [];
    const refusals: string[] = [];
    const changes: (SuggestDraft | null)[] = [];
    const adapter = editorModule.mountSuggestEditor({
      root,
      chrome,
      source,
      segments: map.segments,
      delimiters: map.delimiters,
      version: 1,
      reader: 'reader@example.com',
      pending,
      onCommit: (change) => commits.push(change),
      onRefusal: (message) => refusals.push(message),
      onDraftChange: (change) => changes.push(change),
    });
    return { source, map, chrome, root, adapter, commits, refusals, changes };
  }

  function textNode(root: HTMLElement, index: number): Text {
    const span = root.querySelector(`[data-seg="${index}"]`);
    if (!span) throw new Error(`missing segment ${index}`);
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) throw new Error(`missing text ${index}`);
    return node as Text;
  }
  function select(a: Node, start: number, b: Node = a, end = start): void {
    const range = document.createRange();
    range.setStart(a, start);
    range.setEnd(b, end);
    const selection = document.getSelection();
    if (!selection) throw new Error('missing selection');
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function input(
    root: HTMLElement,
    inputType: string,
    data: string | null = null,
    dataTransfer?: DataTransfer
  ): boolean {
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType,
      data,
      ...(dataTransfer ? { dataTransfer } : {}),
    });
    root.dispatchEvent(event);
    return event.defaultPrevented;
  }
  function transfer(plain: string | null, html: string | null): DataTransfer {
    const result = new DataTransfer();
    if (plain !== null) result.setData('text/plain', plain);
    if (html !== null) result.setData('text/html', html);
    return result;
  }
  function cleanup(f: {
    adapter: EditorModule.SuggestEditor;
    root: HTMLElement;
    chrome: HTMLElement;
  }): void {
    f.adapter.cancel();
    f.adapter.destroy();
    f.root.remove();
    f.chrome.remove();
  }
  async function check(
    name: string,
    run: () => void | Promise<void>
  ): Promise<void> {
    try {
      await run();
      passed.push(name);
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await check('bold draft and single commit on leaving the block', async () => {
    const f = fixture('Write **bold words** here.\n\nNext paragraph.');
    truth(f.adapter.setSuggesting(true), 'toggle');
    const bold = f.map.segments.findIndex(
      (segment) => segment.text === 'bold words'
    );
    const text = textNode(f.root, bold);
    select(text, 0, text, 4);
    truth(input(f.root, 'insertText', 'clear'), 'beforeinput prevented');
    eq(f.commits.length, 0, 'typing cannot post');
    eq(f.adapter.draft?.struck, 'bold', 'struck');
    eq(
      f.root.querySelector('ins[data-sg-draft]')?.textContent,
      'clear',
      'inserted'
    );
    eq(
      f.root.querySelector('del[data-sg-draft]')?.textContent,
      'bold',
      'drawn strike'
    );
    truth(f.chrome.textContent?.includes('Struck 4 / 512 B'), 'strike counter');
    truth(
      f.chrome.textContent?.includes('Inserted 5 / 2,048 B'),
      'insert counter'
    );
    truth(
      f.chrome.textContent?.includes('Leave the paragraph to post'),
      'hint'
    );
    const next = f.map.segments.findIndex(
      (segment) => segment.text === 'Next paragraph.'
    );
    select(textNode(f.root, next), 2);
    document.dispatchEvent(new Event('selectionchange'));
    f.root.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    eq(f.commits.length, 1, 'single post');
    eq(f.commits[0]?.kind, 'save', 'save');
    if (f.commits[0]?.kind === 'save') {
      eq(f.commits[0].plaintext.anchor?.kind, 'source', 'source anchor');
      eq(
        f.commits[0].plaintext.suggestion?.replacement,
        'clear',
        'replacement'
      );
    }
    cleanup(f);
    await turn();
  });

  await check('escape cancels without committing', () => {
    const f = fixture('one two');
    f.adapter.setSuggesting(true);
    const text = textNode(f.root, 0);
    select(text, 0, text, 3);
    input(f.root, 'insertText', 'ONE');
    f.root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    );
    eq(f.adapter.draft, null, 'cancelled');
    eq(f.commits.length, 0, 'no commit');
    eq(f.root.textContent, 'one two', 'source restored');
    cleanup(f);
  });

  await check('selection across formatting and paragraphs is refused', () => {
    const f = fixture('one **bold** end\n\nsecond');
    f.adapter.setSuggesting(true);
    const first = textNode(f.root, 0),
      bold = textNode(f.root, 1);
    select(first, 1, bold, 2);
    input(f.root, 'insertText', 'x');
    eq(
      f.refusals.at(-1),
      'A suggestion can’t cross formatting or a link. Select inside it, or around it.',
      'format refusal'
    );
    const second = textNode(f.root, f.map.segments.length - 1);
    select(first, 1, second, 2);
    input(f.root, 'insertText', 'x');
    eq(
      f.refusals.at(-1),
      'A suggestion stays inside one paragraph. Select within a single block.',
      'block refusal'
    );
    eq(f.commits.length, 0, 'no post');
    cleanup(f);
  });

  await check(
    'UTF-8 strike and replacement limits refuse without committing',
    () => {
      const f = fixture('é'.repeat(257));
      f.adapter.setSuggesting(true);
      const node = textNode(f.root, 0);
      select(node, 0, node, 257);
      input(f.root, 'insertText', 'x');
      eq(
        f.refusals.at(-1),
        'That strikes 514 bytes. A suggestion can strike up to 512.',
        'strike bytes'
      );
      select(node, 0);
      input(f.root, 'insertText', 'é'.repeat(1025));
      eq(
        f.refusals.at(-1),
        'That would insert 2,050 bytes. A suggestion can insert up to 2,048.',
        'insert bytes'
      );
      eq(f.commits.length, 0, 'no post');
      cleanup(f);
    }
  );

  await check('block-specific newline and pipe refusals', () => {
    const examples = [
      ['# heading', 'a heading'],
      ['- item', 'a list item'],
      ['> quote', 'a quote'],
      ['| cell | other |\n| --- | --- |', 'a table cell'],
    ] as const;
    for (const [source, place] of examples) {
      const f = fixture(source);
      f.adapter.setSuggesting(true);
      const text = textNode(f.root, 0);
      select(text, 1);
      input(f.root, 'insertParagraph');
      eq(
        f.refusals.at(-1),
        `A line break can’t go inside ${place}. Suggest the words, and reply if the layout should change.`,
        place
      );
      if (place === 'a table cell') {
        input(f.root, 'insertText', '|');
        eq(
          f.refusals.at(-1),
          'A | would split this table cell. Use another character, or reply describing the change.',
          'pipe'
        );
      }
      input(f.root, 'insertText', '\t');
      eq(f.refusals.at(-1), 'Tab works only in code.', 'tab');
      eq(f.commits.length, 0, 'no post');
      cleanup(f);
    }
  });

  await check('ambiguous anchors retain the draft', () => {
    const passage = `${'x'.repeat(128)}word${'y'.repeat(128)}`;
    const f = fixture(`${passage}\n\n${passage}`);
    f.adapter.setSuggesting(true);
    const node = textNode(f.root, 0);
    select(node, 128, node, 132);
    input(f.root, 'insertText', 'term');
    eq(f.adapter.commit(), false, 'refused commit');
    eq(
      f.refusals.at(-1),
      'This passage repeats in the source. Select a longer passage.',
      'repeats'
    );
    eq(f.adapter.draft?.inserted, 'term', 'draft retained');
    eq(f.commits.length, 0, 'no post');
    cleanup(f);
  });

  await check(
    'HTML paste is plain text and hostile drop and formatting are refused',
    () => {
      const f = fixture('alpha beta');
      f.adapter.setSuggesting(true);
      const node = textNode(f.root, 0);
      select(node, 5);
      input(
        f.root,
        'insertFromPaste',
        null,
        transfer('<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>')
      );
      eq(
        f.adapter.draft?.inserted,
        '<img src=x onerror=alert(1)>',
        'plain clipboard'
      );
      eq(f.root.querySelector('img'), null, 'no HTML element');
      const before = f.adapter.draft?.inserted;
      input(
        f.root,
        'insertFromDrop',
        null,
        transfer('hostile', '<b>hostile</b>')
      );
      eq(
        f.refusals.at(-1),
        'Formatting isn’t part of a suggestion. Type the words; reply if the styling matters.',
        'HTML drop refused'
      );
      input(f.root, 'formatBold');
      eq(
        f.refusals.at(-1),
        'Formatting isn’t part of a suggestion. Type the words; reply if the styling matters.',
        'format refused'
      );
      eq(f.adapter.draft?.inserted, before, 'draft unchanged');
      eq(f.commits.length, 0, 'no post');
      cleanup(f);
    }
  );

  await check('other and own pending insertions use their author', () => {
    function painted(author: string) {
      const pending: PendingSuggestion = {
        id: 'id',
        author,
        displayName: 'Priya',
        version: 1,
        start: 0,
        end: 5,
        inserted: 'shift',
      };
      const f = fixture('alpha beta', [pending], (root) => {
        const segment = root.querySelector('[data-seg]')!;
        const wrapper = document.createElement('span');
        wrapper.setAttribute('data-sg-id', 'id');
        wrapper.setAttribute('data-sg-paint', '');
        const del = document.createElement('del');
        del.setAttribute('data-sg', 'id');
        del.textContent = 'alpha';
        const ins = document.createElement('ins');
        ins.setAttribute('data-sg', 'id');
        ins.textContent = 'shift';
        wrapper.append(del, ins);
        segment.replaceChildren(wrapper, document.createTextNode(' beta'));
      });
      f.adapter.setSuggesting(true);
      const ins = f.root.querySelector('ins[data-sg]')!;
      select(ins.firstChild!, 2);
      input(f.root, 'insertText', 'x');
      return f;
    }
    const other = painted('other@example.com');
    eq(
      other.refusals.at(-1),
      'That text is Priya’s suggestion. Reply to it instead.',
      'other author'
    );
    eq(other.commits.length, 0, 'no post');
    cleanup(other);
    const own = painted('reader@example.com');
    eq(own.adapter.draft?.existingId, 'id', 'own pending');
    truth(
      own.chrome.textContent?.includes('Editing your suggestion'),
      'editing label'
    );
    own.adapter.commit();
    eq(
      own.commits[0]?.kind === 'save' ? own.commits[0].existingId : null,
      'id',
      'patch existing'
    );
    cleanup(own);
  });

  await check('injected nodes are reverted by the observer', async () => {
    const f = fixture('original');
    f.adapter.setSuggesting(true);
    const bad = document.createElement('b');
    bad.textContent = 'injected';
    f.root.append(bad);
    await turn();
    eq(f.root.textContent, 'original', 'restored');
    truth(f.adapter.suggesting, 'remains on');
    eq(f.root.querySelector('b'), null, 'element removed');
    cleanup(f);
  });

  await check('layout mismatch is fail closed', () => {
    const f = fixture('original', [], (root) => {
      root.querySelector('[data-seg]')!.textContent = 'changed';
    });
    eq(
      f.adapter.unavailable,
      'This document’s layout could not be matched to its source.',
      'layout reason'
    );
    eq(f.adapter.setSuggesting(true), false, 'cannot enable');
    eq(f.root.hasAttribute('contenteditable'), false, 'not editable');
    cleanup(f);
  });

  await check(
    'IME stays inside the insertion and stray mutations are reverted',
    async () => {
      const f = fixture('one two');
      f.adapter.setSuggesting(true);
      const source = textNode(f.root, 0);
      select(source, 4);
      f.root.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true, data: '' })
      );
      const ins = f.root.querySelector('ins[data-sg-draft]');
      truth(ins?.firstChild, 'composition insertion');
      ins!.firstChild!.nodeValue = '漢';
      await turn();
      eq(f.adapter.draft?.inserted, '漢', 'composed text');
      const injected = document.createElement('span');
      injected.textContent = 'stray';
      f.root.append(injected);
      await turn();
      eq(f.root.contains(injected), false, 'stray reverted');
      eq(f.adapter.draft?.inserted, '漢', 'composition preserved');
      f.root.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '漢' })
      );
      eq(f.commits.length, 0, 'no post');
      cleanup(f);
    }
  );

  await check(
    'typing coalesces and deletion at insertion edges extends the strike',
    () => {
      const f = fixture('alpha beta!');
      f.adapter.setSuggesting(true);
      const node = textNode(f.root, 0);
      select(node, 6, node, 10);
      input(f.root, 'insertText', 'B');
      input(f.root, 'insertText', 'eta');
      eq(f.adapter.draft?.inserted, 'Beta', 'one draft');
      let ins = f.root.querySelector('ins[data-sg-draft]')!;
      select(ins.firstChild!, 0);
      input(f.root, 'deleteContentBackward');
      eq(f.adapter.draft?.struck, ' beta', 'backward strike');
      ins = f.root.querySelector('ins[data-sg-draft]')!;
      select(ins.firstChild!, 4);
      input(f.root, 'deleteContentForward');
      eq(f.adapter.draft?.struck, ' beta!', 'forward strike');
      eq(f.commits.length, 0, 'no post while typing');
      f.adapter.setSuggesting(false);
      eq(f.commits.length, 1, 'toggle posts once');
      eq(
        f.root.hasAttribute('contenteditable'),
        false,
        'toggle disables editing'
      );
      cleanup(f);
    }
  );

  await check('code Enter and Tab stay in one draft', () => {
    const source = 'hello world';
    const chrome = document.createElement('div');
    const root = document.createElement('pre');
    root.className = 'code-body';
    root.textContent = source;
    document.body.append(chrome, root);
    const commits: SuggestCommit[] = [];
    const adapter = editorModule.mountSuggestEditor({
      root,
      chrome,
      source,
      segments: markdown.codeSegments(source),
      delimiters: [],
      version: 1,
      reader: 'reader@example.com',
      onCommit: (value) => commits.push(value),
      onRefusal: () => {},
      onDraftChange: () => {},
    });
    adapter.setSuggesting(true);
    select(root.firstChild!, 5);
    input(root, 'insertParagraph');
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      })
    );
    eq(adapter.draft?.inserted, '\n\t', 'code line and tab');
    adapter.commit();
    eq(commits.length, 1, 'one code post');
    adapter.destroy();
    root.remove();
    chrome.remove();
  });

  await check('cancelable IME updates replace the previous composition', () => {
    const f = fixture('alpha');
    f.adapter.setSuggesting(true);
    select(textNode(f.root, 0), 2);
    f.root.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true })
    );
    input(f.root, 'insertCompositionText', 'h');
    input(f.root, 'insertCompositionText', '漢');
    eq(f.adapter.draft?.inserted, '漢', 'latest composition');
    f.root.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true })
    );
    cleanup(f);
  });

  await check('receipt is literal and does not steal focus', () => {
    const f = fixture('original');
    f.adapter.setSuggesting(true);
    f.root.focus();
    let undone = false;
    f.adapter.showReceipt({
      struck: '<del>old</del>',
      inserted: '<img src=x>',
      undo: () => {
        undone = true;
      },
    });
    eq(document.activeElement, f.root, 'focus stays in document');
    truth(f.chrome.textContent?.includes('Suggestion posted'), 'receipt label');
    truth(f.chrome.textContent?.includes('<img src=x>'), 'literal text');
    eq(f.chrome.querySelector('img'), null, 'not HTML');
    const button = Array.from(f.chrome.querySelectorAll('button')).find(
      (item) => item.textContent === 'Undo'
    );
    button?.click();
    truth(undone, 'undo');
    cleanup(f);
  });

  await check('unavailability reasons', () => {
    eq(
      editorModule.suggestingUnavailable('older'),
      'Suggestions can only be made on the current version.',
      'older'
    );
    eq(
      editorModule.suggestingUnavailable(
        'too_large',
        Math.round(1.4 * 1_048_576)
      ),
      'Suggesting is off: this file is 1.4 MiB, and suggestions work on files up to 1 MiB.',
      'size'
    );
    eq(
      editorModule.suggestingUnavailable('has_nul'),
      'Suggesting is off: this file contains carriage returns (CR) or NUL characters, which a suggestion can’t point at.',
      'NUL'
    );
    eq(
      editorModule.suggestingUnavailable('not_utf8'),
      'Suggesting is off: this file is not valid UTF-8.',
      'UTF-8'
    );
  });

  return passed;
}

const shell = findHeadlessShell();
describe('suggestion editor in the browser', () => {
  test.skipIf(!shell)(
    'controls edits, rejects unsafe input and preserves the source DOM',
    async () => {
      const build = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, '../src/suggest-editor.ts'),
          resolve(import.meta.dir, '../src/markdown-source.ts'),
        ],
        target: 'browser',
        format: 'esm',
        splitting: false,
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const modules = new Map<string, string>();
      for (const output of build.outputs)
        modules.set(`/${output.path.split('/').at(-1)}`, await output.text());
      const { promise, resolve: report } = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const page = `<!doctype html><meta charset="utf-8"><script type="module">
      import * as editor from '/suggest-editor.js';
      import * as markdown from '/markdown-source.js';
      try { const passed = await (${browserCases.toString()})(editor, markdown); await fetch('/result', {method: 'POST', body: JSON.stringify({passed})}); }
      catch (error) { await fetch('/result', {method: 'POST', body: JSON.stringify({error: error && (error.stack || error.message) || String(error)})}); }
    </script>`;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
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
      const profile = join(
        import.meta.dir,
        `.suggest-editor-${crypto.randomUUID()}`
      );
      const browser = spawn(
        shell!,
        [
          '--headless',
          '--disable-gpu',
          '--no-sandbox',
          `--user-data-dir=${profile}`,
          `http://127.0.0.1:${server.port}/`,
        ],
        { stdio: 'ignore' }
      );
      try {
        const exited = Promise.withResolvers<never>();
        browser.once('error', exited.reject);
        browser.once('exit', (code) =>
          exited.reject(
            new Error(`headless browser exited before reporting: ${code}`)
          )
        );
        const result = await Promise.race([promise, exited.promise]);
        if (result.error) throw new Error(result.error);
        expect(result.passed).toHaveLength(16);
      } finally {
        browser.kill();
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    30000
  );
});
