import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type CommentAnchor, deriveCommentKey, encodeKey } from '@relic/format';
import { type CommentCipher, commentCipher } from '../src/comments.ts';
import {
  buildStageWrap,
  buildThread,
  MARK_PIN_HINT,
  markTargetLabel,
  PENDING_MARK_ID,
} from '../src/main.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';

/** What every element in the stub tree measures, in CSS pixels. */
const STUB_LAID_OUT_HEIGHT = 28;
const STUB_STAGE_WIDTH = 800;
const STUB_STAGE_HEIGHT = 600;

/**
 * Bun tests run without a DOM, and the thread's existing tests get by with a
 * stub that records structure. Aiming a mark is not structure: it is a
 * mouseup, a click, a keystroke and the order they arrive in. So this file
 * carries a small tree that dispatches events and answers `closest`,
 * `contains` and `querySelector`.
 *
 * It is not a browser and does not pretend to be one. Nothing here proves
 * where the bubble lands on a screen. What it proves is which target a
 * sequence of events leaves behind, which is exactly where the reported bug
 * lived: a selection nobody could see had already chosen it.
 */
export class Node {
  readonly tagName: string;
  className = '';
  textContent = '';
  id = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  value = '';
  rows = 0;
  required = false;
  disabled = false;
  maxLength = 0;
  placeholder = '';
  autocomplete = '';
  href = '';
  rel = '';
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 0;
  scrollHeight = 0;
  focused = false;
  /**
   * Bun performs no layout, so every element here measures the same. It has
   * to be a real number rather than zero: the offer's placement reads its own
   * height, and a harness that measured nothing would make the clamp that
   * keeps it inside the clipped stage untestable.
   */
  offsetHeight = STUB_LAID_OUT_HEIGHT;
  offsetWidth = 0;
  /**
   * The visible box the panel is clamped inside.
   *
   * Zero would model a stage nobody can see, and every placement would clamp
   * to the left margin, which would make the coordinate-space assertions
   * below pass for the wrong reason.
   */
  clientWidth = STUB_STAGE_WIDTH;
  clientHeight = STUB_STAGE_HEIGHT;
  parent: Node | undefined;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  readonly children: Node[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = {
    setProperty: (): void => {},
  };
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  readonly classList = {
    add: (name: string): void => {
      if (this.classes().includes(name)) return;
      this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.classes()
        .filter((candidate) => candidate !== name)
        .join(' ');
    },
    contains: (name: string): boolean => this.classes().includes(name),
    toggle: (name: string, on?: boolean): void => {
      if (on ?? !this.classes().includes(name)) this.classList.add(name);
      else this.classList.remove(name);
    },
  };

  classes(): string[] {
    return this.className.split(' ').filter((name) => name.length > 0);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: Node): Node {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: Node[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: Node[]): void {
    for (const held of [...this.children]) held.parent = undefined;
    this.children.length = 0;
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    const holder = this.parent;
    if (holder === undefined) return;
    const at = holder.children.indexOf(this);
    if (at >= 0) holder.children.splice(at, 1);
    this.parent = undefined;
  }

  contains(node: unknown): boolean {
    let walk = node instanceof Node ? node : undefined;
    while (walk !== undefined) {
      if (walk === this) return true;
      walk = walk.parent;
    }
    return false;
  }

  closest(selector: string): Node | null {
    const wanted = selector.split(',').map((part) => part.trim());
    let walk: Node | undefined = this;
    while (walk !== undefined) {
      for (const part of wanted) if (matches(walk, part)) return walk;
      walk = walk.parent;
    }
    return null;
  }

  querySelectorAll(selector: string): Node[] {
    const parts = selector.split(',').map((part) => part.trim());
    return descendants(this)
      .slice(1)
      .filter((candidate) => parts.some((part) => matches(candidate, part)));
  }

  querySelector(selector: string): Node | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }

  focus(): void {
    this.focused = true;
  }

  scrollIntoView(): void {}

  replaceWith(): void {}

  setPointerCapture(): void {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const held = this.listeners.get(type) ?? [];
    held.push(handler);
    this.listeners.set(type, held);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const held = this.listeners.get(type) ?? [];
    const at = held.indexOf(handler);
    if (at >= 0) held.splice(at, 1);
  }

  /**
   * Fires up the tree, because the stage listens for events on its content
   * and the whole question is what a click on a paragraph does.
   */
  dispatch(type: string, detail: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: this,
      preventDefault: (): void => {},
      stopPropagation: (): void => {},
      ...detail,
    };
    let walk: Node | undefined = this;
    while (walk !== undefined) {
      for (const handler of walk.listeners.get(type) ?? []) handler(event);
      walk = walk.parent;
    }
  }
}

/**
 * `tag`, `.class`, `tag.class`, and `[data-*]` with or without a value.
 *
 * The attribute half is what pairing needs: a comment, its mark and its pin
 * are joined by `data-comment-id` and nothing else. It was absent before, so
 * the pin's existing scroll-to-comment lookup was equally unprovable here.
 */
function matches(node: Node, selector: string): boolean {
  const attribute = /\[([a-z-]+)(?:="([^"]*)")?\]/.exec(selector);
  if (attribute !== null) {
    const [whole, name, value] = attribute;
    const key = (name as string)
      .replace(/^data-/, '')
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const held = (name as string).startsWith('data-')
      ? node.dataset[key]
      : node.attributes.get(name as string);
    if (held === undefined) return false;
    if (value !== undefined && held !== value) return false;
    return matches(node, selector.replace(whole, ''));
  }
  const [tag, ...classes] = selector.split('.');
  if (
    tag !== undefined &&
    tag.length > 0 &&
    node.tagName !== tag.toUpperCase()
  ) {
    return false;
  }
  return classes.every((name) => node.classes().includes(name));
}

function descendants(node: Node): Node[] {
  return [node, ...node.children.flatMap(descendants)];
}

export function withClass(node: Node, name: string): Node[] {
  return descendants(node).filter((candidate) =>
    candidate.classes().includes(name)
  );
}

/** Asserts the control exists exactly once before the test acts on it. */
export function only(node: Node, name: string): Node {
  const found = withClass(node, name);
  expect(found).toHaveLength(1);
  return found[0] as Node;
}

export function textOf(node: Node): string {
  return [node.textContent, ...node.children.map(textOf)].join(' ').trim();
}

/** The selection a test scripts, in place of one a browser would produce. */
interface Scripted {
  collapsed: boolean;
  ranges: number;
  text: string;
  within: Node | undefined;
  prefix?: string;
  suffix?: string;
  /** Where the selection sits in the viewport, so the clamp can be reached. */
  top: number;
}

let scripted: Scripted;
export let documentNode: Node;

export function installDom(): void {
  documentNode = new Node('#document');
  scripted = {
    collapsed: true,
    ranges: 0,
    text: '',
    within: undefined,
    top: 240,
  };
  const root = new Node('html');
  (globalThis as { Element?: unknown }).Element = Node;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = Node;
  // The argument the walker is asked for. Its value is the platform's, not
  // ours, so it is spelled out rather than invented.
  (globalThis as { NodeFilter?: unknown }).NodeFilter = { SHOW_TEXT: 0x4 };
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new Node(tag),
    createElementNS: (_namespace: string, tag: string) => new Node(tag),
    createTextNode: (text: string) => {
      const node = new Node('#text');
      node.textContent = text;
      return node;
    },
    documentElement: root,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      documentNode.addEventListener(type, handler);
    },
    visibilityState: 'visible',
    /**
     * Truthfully empty rather than convincingly fake.
     *
     * Painting a text mark splits a real `Text` node, and this tree carries
     * `textContent` strings instead. A walker faked over those strings would
     * report a mark this harness cannot actually produce, so it walks nothing
     * and the mark is simply not painted here. What that costs is stated where
     * it matters: the pin half of a provisional target is asserted below, and
     * the text half is proven in a browser rather than pretended to here.
     */
    createTreeWalker: () => ({
      nextNode: (): unknown => null,
    }),
  };
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1440,
    addEventListener: () => {},
    removeEventListener: () => {},
    // Synchronous, so a settled selection is readable in the same turn. The
    // deferral exists for the browser's ordering; the ordering under test is
    // the handler's own.
    setTimeout: (run: () => void) => {
      run();
      return 0;
    },
    getSelection: () => ({
      isCollapsed: scripted.collapsed,
      rangeCount: scripted.ranges,
      // A real selection can be dropped, and the page drops one after
      // posting and on cancel. A stub without it turns a reader-visible
      // behaviour into a harness error.
      removeAllRanges: () => {
        scripted.collapsed = true;
      },
      toString: () => scripted.text,
      getRangeAt: () => ({
        commonAncestorContainer: scripted.within,
        prefix: scripted.prefix,
        suffix: scripted.suffix,
        getBoundingClientRect: () => ({
          left: 120,
          top: scripted.top,
          right: 200,
          bottom: scripted.top + 18,
          width: 80,
          height: 18,
        }),
      }),
    }),
  };
}

export function clearDom(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { NodeFilter?: unknown }).NodeFilter;
}

const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_BYTES = new Uint8Array([
  9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10,
]);
const FRAGMENT = `#r1${encodeKey(KEY_BYTES)}`;
const USERCONTENT = 'https://relik-usercontent.example';

/**
 * The same comment key the viewer will derive, so a seeded row opens the way
 * a real one does instead of being handed over already readable.
 */
async function seedCipher(): Promise<CommentCipher> {
  return commentCipher(await deriveCommentKey(KEY_BYTES));
}

function view(overrides: Partial<ReadyView> = {}): ReadyView {
  return {
    filename: 'notes.md',
    declaredMimetype: 'text/markdown',
    content: new TextEncoder().encode('# notes\n\nthe second paragraph\n'),
    route: 'markdown',
    downgradeNotice: undefined,
    shareUrl: `https://relik.example/${RELIC_ID}${FRAGMENT}`,
    version: 1,
    currentVersion: 1,
    versionDigest: '0'.repeat(64),
    ...overrides,
  };
}

/** One request the page made, for a test that cares which. */
export interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

/** A mounted relic, with the handles a test needs to act on it. */
export interface Mounted {
  /** Every request, in order, so a write can be asserted rather than assumed. */
  readonly calls: readonly Call[];
  readonly thread: Node;
  readonly stage: Node;
  /** A rendered element inside the stage, to select in or click on. */
  readonly content: Node;
  /** What the composer currently says the next comment is about. */
  chip(): string;
  /** The plaintext of the posted comment, anchor included. */
  post(body: string): Promise<{ anchor?: unknown }>;
  /** The same, written in the panel that opens over the words. */
  postInPanel(body: string): Promise<{ anchor?: unknown }>;
  /** Repaints the stage to simulate repaints between user actions. */
  readonly repaint: () => void;
  /** Waits for the thread to finish its next load. */
  settle(): Promise<void>;
  /** Opens a ciphertext the page wrote, so a write can be read back. */
  openSealed(ciphertext: string): Promise<{ body: string; anchor?: unknown }>;
}

/**
 * The thread and a stage, wired the way `renderReady` wires them.
 *
 * Through `buildThread` rather than through the mark controls alone, so the
 * wiring is under test too: a chip the composer never carries would satisfy
 * every assertion about the chip and still leave the reader with nothing.
 */
/**
 * A comment already on the relic when the reader arrives.
 *
 * Sealed with the same comment key the viewer derives, so it travels the real
 * decrypt path rather than arriving pre-opened. Pairing a comment with the
 * thing it points at needs a comment that exists, and until now every mounted
 * thread was empty.
 */
interface Seed {
  readonly id: string;
  readonly body: string;
  readonly anchor: CommentAnchor;
  /** Defaults to the reader's own address, so a seed is editable by default. */
  readonly author?: string;
  readonly editedAt?: string;
  readonly resolvedBy?: string;
}
export async function mount(
  overrides: Partial<ReadyView> = {},
  reader: 'verified' | 'anonymous' = 'verified',
  seeds: readonly Seed[] = []
): Promise<Mounted> {
  const ready = view(overrides);
  const sealed: string[] = [];
  const calls: Call[] = [];
  const deps: ViewerDeps = {
    serviceOrigin: 'https://relik.example',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (init?.method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const wire: unknown = JSON.parse(init.body);
        if (
          typeof wire === 'object' &&
          wire !== null &&
          'ciphertext' in wire &&
          typeof wire.ciphertext === 'string'
        ) {
          sealed.push(wire.ciphertext);
        }
        return new Response(
          JSON.stringify({ comment_id: 'c1', author: 'ada@example.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      // Verified by default, because the reader who aims a mark is usually
      // the reader who posts. Anonymous is the state the chip has to survive.
      const body = url.endsWith('/api/auth/session')
        ? { email: reader === 'verified' ? 'ada@example.com' : null }
        : await Promise.all(
            seeds.map(async (seed) => ({
              comment_id: seed.id,
              author: seed.author ?? 'ada@example.com',
              created_at: '2026-08-24T00:00:00Z',
              edited_at: seed.editedAt ?? null,
              resolved_at:
                seed.resolvedBy === undefined ? null : '2026-08-25T00:00:00Z',
              resolved_by: seed.resolvedBy ?? null,
              ciphertext: await seedCipher().then((cipher) =>
                cipher.seal({
                  body: seed.body,
                  display_name: null,
                  anchor: seed.anchor,
                })
              ),
            }))
          );
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch,
    takeFragment: () => FRAGMENT,
    stripFragment: () => {},
    locationHref: `https://relik.example/${RELIC_ID}`,
    keyVault: {
      remember: () => {},
      recall: () => undefined,
      forget: () => {},
    },
  };

  // The viewer reports every thread load through this callback, which makes
  // it the signal a test can await instead of guessing at a duration. The key
  // derivation is WebCrypto, so a spin of `Promise.resolve()` outruns it and
  // this file first reported a composer that had simply not painted yet.
  let reported = 0;
  let awaited = 0;
  let announce: (() => void) | undefined;
  const handle = buildThread(ready, RELIC_ID, deps, () => {
    reported += 1;
    announce?.();
  });
  // Awaited, so the thread's first load cannot resolve after this test has
  // torn its document down. Unawaited it threw between test files in CI.
  await handle.ready;
  const loaded = async (): Promise<void> => {
    if (reported <= awaited) {
      await new Promise<void>((resolve) => {
        announce = resolve;
      });
      announce = undefined;
    }
    awaited = reported;
    // The composer paints in the continuation after the count is reported.
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
  };
  // The stub tree stands in for the DOM the viewer builds against, which is
  // the one unchecked cast in this file and the reason the class above exists.
  const thread = handle.element as unknown as Node;
  const stage = buildStageWrap(ready, USERCONTENT) as unknown as Node;
  // A stage with no measurable content cannot place a point at all, which is
  // a real refusal in `pinFraction` and not one worth tripping over here.
  stage.rect = {
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
  };
  stage.scrollWidth = 1000;
  stage.scrollHeight = 800;
  handle.attach(stage as unknown as HTMLElement);

  await loaded();

  const rendered = descendants(stage).find((node) => node.tagName === 'P');
  const content = rendered ?? stage;
  scripted.within = content;

  return {
    calls,
    thread,
    stage,
    content,
    chip: () => textOf(only(thread, 'compose-target')),
    repaint: () => handle.attach(stage as unknown as HTMLElement),
    settle: loaded,
    openSealed: async (ciphertext: string) => {
      const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
      return cipher.open(ciphertext);
    },
    post: async (body: string) => {
      const box = only(thread, 'compose-textarea');
      box.value = body;
      const form = box.closest('.compose');
      expect(form).not.toBeNull();
      form?.dispatch('submit');
      await loaded();
      expect(sealed).toHaveLength(1);
      const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
      return cipher.open(sealed[0] as string);
    },
    postInPanel: async (body: string) => {
      const field = only(stage, 'popover-field');
      field.value = body;
      only(stage, 'is-primary').dispatch('click');
      await loaded();
      expect(sealed).toHaveLength(1);
      const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
      return cipher.open(sealed[0] as string);
    },
  };
}

/** Puts a live, settled selection over the rendered content. */
export function select(mounted: Mounted, text: string): void {
  scripted.collapsed = false;
  scripted.ranges = 1;
  scripted.text = text;
  scripted.within = mounted.content;
  mounted.content.dispatch('mouseup');
}

describe('what the composer says a comment is about', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('no target reads as the whole document', () => {
    expect(markTargetLabel(null)).toBe('Commenting on the whole document');
  });

  test('a point says so, without pretending to quote anything', () => {
    expect(markTargetLabel({ kind: 'pin', x: 0.4, y: 0.6 })).toBe(
      'Commenting on a point'
    );
  });

  test('a quote is shown, and a long one is abbreviated rather than dropped', () => {
    expect(markTargetLabel({ kind: 'text', quote: 'the second' })).toBe(
      'Commenting on "the second"'
    );
    const label = markTargetLabel({ kind: 'text', quote: 'x'.repeat(200) });
    expect(label.length).toBeLessThan(100);
    expect(label).toContain('…');
  });

  test('a quote carrying bidirectional controls is stripped, like every other untrusted label', () => {
    expect(
      markTargetLabel({ kind: 'text', quote: 'ada\u202egnitirw' })
    ).toContain('adagnitirw');
  });

  test('the composer says so before anything has been marked', async () => {
    // The discoverability half of the bug. Nothing on the page said marks
    // existed, so this line is the announcement and it is unconditional.
    const mounted = await mount();
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });

  test('with no target there is nothing to clear', async () => {
    const mounted = await mount();
    expect(withClass(mounted.thread, 'compose-target-clear')).toHaveLength(0);
  });

  test('it says so to a reader who has not verified an address', async () => {
    // The chip's job is to announce that annotation exists, and a reader who
    // has not signed in yet is exactly who needs telling. The identity form
    // has no box to type in, which is the state this asserts around.
    const mounted = await mount({}, 'anonymous');
    expect(withClass(mounted.thread, 'compose-textarea')).toHaveLength(0);
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });
});

describe('aiming a comment at a quote', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('a settled selection offers a target and does not take one', async () => {
    // The data-integrity half of the bug, in the shape it shipped in: a
    // selection set the anchor outright, so a stray highlight from ten
    // minutes ago silently anchored the next comment written.
    const mounted = await mount();
    select(mounted, 'the second paragraph');

    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(1);
    expect(mounted.chip()).toContain('Commenting on the whole document');
    const posted = await mounted.post('a comment about nothing in particular');
    expect(posted.anchor).toBeNull();
  });

  test('pressing Comment writes it on the words, carrying the quote', async () => {
    const mounted = await mount({
      content: new TextEncoder().encode(
        '# notes\n\nfirst: the second paragraph\n\nsecond: the second paragraph\n'
      ),
    });
    scripted.prefix = 'second: ';
    scripted.suffix = '\n';
    select(mounted, 'the second paragraph');
    only(mounted.stage, 'popover-comment').dispatch('click');

    // Written in the panel rather than in the sidebar, which is the whole
    // point of the second step: the reader is looking at the sentence.
    const posted = await mounted.postInPanel('about that paragraph');
    expect(posted.anchor).toEqual({
      kind: 'quote',
      exact: 'the second paragraph',
      prefix: 'second: ',
      suffix: '\n',
    });
  });

  test('the cursor lands in the panel, over the words', async () => {
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    only(mounted.stage, 'popover-comment').dispatch('click');

    expect(only(mounted.stage, 'popover-field').focused).toBe(true);
  });

  test('with no identity yet it hands off to the sidebar, which has one', async () => {
    // Composing needs an address, verifying one is the magic-link flow, and
    // that flow lives in the sidebar. The hand-off is the honest answer; a
    // field nobody could post from would not be.
    const mounted = await mount({}, 'anonymous');
    select(mounted, 'the second paragraph');
    only(mounted.stage, 'popover-comment').dispatch('click');

    expect(mounted.thread.classes()).toContain('is-open');
    expect(mounted.chip()).toContain('Commenting on "the second paragraph"');
  });

  test('the bubble goes once it has been used, so it cannot be pressed twice', async () => {
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    only(mounted.stage, 'popover-comment').dispatch('click');
    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(0);
  });

  test('the offer is placed in the stage own content coordinates', async () => {
    // Not a claim about pixels on a screen, which this file cannot make. It
    // is a claim about which coordinate space the offsets are in: the
    // scripted selection sits at viewport left 120, top 240, width 80, the
    // stage starts at the viewport origin, and the panel measures 28 tall
    // with 8 of clearance. Centred is 160, above is 240 - 28 - 8.
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    const offered = only(mounted.stage, 'popover-offer');
    expect(offered.style.left).toBe('160px');
    expect(offered.style.top).toBe('204px');
  });

  test('a scrolled stage carries the offer with its content', async () => {
    // The regression this defends is the one `pinFraction` already shipped
    // twice: an offset measured against the visible box belongs to the screen
    // rather than to the document, and the stage scrolls its own children.
    const mounted = await mount();
    mounted.stage.scrollLeft = 30;
    mounted.stage.scrollTop = 500;
    select(mounted, 'the second paragraph');
    const offered = only(mounted.stage, 'popover-offer');
    expect(offered.style.left).toBe('190px');
    expect(offered.style.top).toBe('704px');
  });

  test('a selection on the first line is offered below it, inside the box', async () => {
    // The stage clips its overflow, so a panel placed above the content box
    // is a panel the reader cannot press. The first line of every relic is
    // that case, and it goes below the selection rather than being clamped
    // onto it: a panel sitting on the words it names hides them.
    const mounted = await mount();
    scripted.top = 4;
    select(mounted, 'notes');
    expect(only(mounted.stage, 'popover-offer').dataset.side).toBe('below');
    expect(only(mounted.stage, 'popover-offer').style.top).toBe('30px');
  });

  test('a selection outside the stage offers nothing', async () => {
    const mounted = await mount();
    scripted.collapsed = false;
    scripted.ranges = 1;
    scripted.text = 'text from somewhere else';
    scripted.within = new Node('p');
    mounted.content.dispatch('mouseup');
    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(0);
  });

  test('a selection of nothing but whitespace offers nothing', async () => {
    const mounted = await mount();
    select(mounted, '   \n  ');
    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(0);
  });

  test('the collapse of a selection dismisses the offer', async () => {
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    scripted.collapsed = true;
    documentNode.dispatch('selectionchange');
    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(0);
  });

  test('clearing puts it back to the whole document', async () => {
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    only(mounted.thread, 'mark-quote-action').dispatch('click');
    only(mounted.thread, 'compose-target-clear').dispatch('click');

    expect(mounted.chip()).toContain('Commenting on the whole document');
    const posted = await mounted.post('about the whole thing after all');
    expect(posted.anchor).toBeNull();
  });

  test('escape clears it too', async () => {
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    only(mounted.thread, 'mark-quote-action').dispatch('click');
    documentNode.dispatch('keydown', { key: 'Escape' });

    expect(mounted.chip()).toContain('Commenting on the whole document');
  });

  test('a posted comment spends its target rather than keeping it', async () => {
    // One comment landing on a mark is the feature. The next one landing on
    // the same mark, unasked, is the bug wearing the feature's clothes.
    const mounted = await mount();
    select(mounted, 'the second paragraph');
    only(mounted.stage, 'popover-comment').dispatch('click');
    await mounted.post('about that paragraph');
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });
});

describe('pointing at a place in the document', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('reading clicks do nothing, because the tool is not armed', async () => {
    // The `.doc` bail this replaces made every click on content a no-op and
    // every click on the surrounding gutter a pin. Both were wrong; this is
    // the half that has to stay wrong-free after the bail is gone.
    const mounted = await mount();
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });

    expect(mounted.chip()).toContain('Commenting on the whole document');
    const posted = await mounted.post('just reading');
    expect(posted.anchor).toBeNull();
  });

  test('arming says so on the stage the click has to land on', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');

    expect(mounted.stage.classes()).toContain('is-pinning');
    expect(textOf(only(mounted.stage, 'mark-hint'))).toBe(MARK_PIN_HINT);
  });

  test('a click while armed places the point and disarms', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });

    expect(withClass(mounted.stage, 'popover-composer')).toHaveLength(1);
    expect(mounted.chip()).toContain('Commenting on the whole document');
    expect(only(mounted.thread, 'mark-mode').getAttribute('aria-pressed')).toBe(
      'false'
    );
    expect(mounted.stage.classes()).not.toContain('is-pinning');
    expect(withClass(mounted.stage, 'mark-hint')).toHaveLength(0);

    const posted = await mounted.postInPanel('about this spot');
    expect(posted.anchor).toEqual({ kind: 'pin', x: 0.4, y: 0.375 });
  });

  test('a second click does not move the point, because the tool disarmed', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });
    mounted.content.dispatch('click', { clientX: 800, clientY: 600 });

    const posted = await mounted.postInPanel('about this spot');
    expect(posted.anchor).toEqual({ kind: 'pin', x: 0.4, y: 0.375 });
  });

  test('pressing the tool again disarms it without placing anything', async () => {
    const mounted = await mount();
    const mode = only(mounted.thread, 'mark-mode');
    mode.dispatch('click');
    mode.dispatch('click');

    expect(mounted.stage.classes()).not.toContain('is-pinning');
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });

  test('escape disarms as well as clearing', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    documentNode.dispatch('keydown', { key: 'Escape' });

    expect(mounted.stage.classes()).not.toContain('is-pinning');
    expect(only(mounted.thread, 'mark-mode').getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  test('an armed click on an existing pin is that pin, not a new one', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    const pin = new Node('button');
    pin.className = 'comment-pin';
    mounted.stage.appendChild(pin);
    pin.dispatch('click', { clientX: 400, clientY: 300 });

    expect(mounted.chip()).toContain('Commenting on the whole document');
  });
});

describe('showing the target before it is posted', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('the sentinel cannot collide with a comment id the server minted', () => {
    // Ids are base64url, which has no colon in its alphabet. If that ever
    // stopped holding, the pairing handler would light the wrong comment and
    // the unwrap pass would strand a mark on the page.
    expect(PENDING_MARK_ID).toContain(':');
    expect(PENDING_MARK_ID).not.toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('an aimed point is drawn on the document, not just named in the chip', async () => {
    // The chip alone was the half-fix: it told the reader where their comment
    // was going and gave them no way to look at it.
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });

    const pending = withClass(mounted.stage, 'is-pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dataset['commentId']).toBe(PENDING_MARK_ID);
  });

  test('it is not a button, because there is no comment to go to yet', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });

    expect(withClass(mounted.stage, 'is-pending')[0]?.tagName).toBe('DIV');
  });

  test('clearing the target takes the drawing away with it', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });
    documentNode.dispatch('keydown', { key: 'Escape' });

    expect(withClass(mounted.stage, 'is-pending')).toHaveLength(0);
  });

  test('posting spends the drawing too, so it does not outlive the comment', async () => {
    const mounted = await mount();
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 400, clientY: 300 });
    await mounted.postInPanel('about this spot');

    expect(withClass(mounted.stage, 'is-pending')).toHaveLength(0);
  });
});

describe('pairing a comment with the thing it points at', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  const pinned: Seed = {
    id: 'c9',
    body: 'this spot is wrong',
    anchor: { kind: 'pin', x: 0.4, y: 0.375 },
  };

  test('a posted pin carries its comment id, which is what makes pairing possible', async () => {
    const mounted = await mount({}, 'verified', [pinned]);

    const pin = only(mounted.stage, 'comment-pin');
    expect(pin.dataset['commentId']).toBe('c9');
  });

  test('hovering the comment lights the pin', async () => {
    const mounted = await mount({}, 'verified', [pinned]);
    const row = only(mounted.thread, 'comment');

    row.dispatch('mouseover');
    expect(only(mounted.stage, 'comment-pin').classes()).toContain('is-active');

    row.dispatch('mouseout');
    expect(only(mounted.stage, 'comment-pin').classes()).not.toContain(
      'is-active'
    );
  });

  test('hovering the pin lights the comment, because the join runs both ways', async () => {
    const mounted = await mount({}, 'verified', [pinned]);
    const pin = only(mounted.stage, 'comment-pin');

    pin.dispatch('mouseover');
    expect(only(mounted.thread, 'comment').classes()).toContain('is-active');

    pin.dispatch('mouseout');
    expect(only(mounted.thread, 'comment').classes()).not.toContain(
      'is-active'
    );
  });

  test('focus pairs too, so a keyboard reader sees the same join', async () => {
    // A pin is a button and therefore in the tab order. Pairing only on hover
    // would leave the one reader who cannot hover without the association.
    const mounted = await mount({}, 'verified', [pinned]);

    only(mounted.stage, 'comment-pin').dispatch('focusin');
    expect(only(mounted.thread, 'comment').classes()).toContain('is-active');
  });
});

describe('a relic that renders in a sandboxed frame', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  const framed = {
    route: 'sandboxed-html' as const,
    filename: 'page.html',
    declaredMimetype: 'text/html',
    content: new TextEncoder().encode('<p>hello</p>'),
  };

  test('offers controls it can honour on a framed stage', async () => {
    // The frame is a different origin with allow-same-origin withheld. Text selection
    // on the parent window over the frame cannot read into the frame, so no parent
    // mark-bubble appears. But pointing mode is wired across postMessage, so the
    // mark-mode toggle is offered and can be armed.
    const mounted = await mount(framed);
    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(0);
    expect(withClass(mounted.thread, 'mark-mode')).toHaveLength(1);

    only(mounted.thread, 'mark-mode').dispatch('click');
    expect(only(mounted.thread, 'mark-mode').getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(mounted.stage.classes()).toContain('is-pinning');
    expect(textOf(mounted.stage)).toContain(MARK_PIN_HINT);
  });

  test('accepts framed selection and region messages as comment targets', async () => {
    const mounted = await mount(framed);
    expect(mounted.chip()).toContain('Commenting on the whole document');

    // Selection inside the frame forwards to parent
    mounted.stage.dispatch('relic:frame-selection', {
      detail: { type: 'relic:frame-selection', exact: 'framed text' },
    });
    expect(mounted.chip()).toContain('Commenting on "framed text"');

    // Arming and dragging a region inside the frame forwards to parent
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.stage.dispatch('relic:frame-region', {
      detail: {
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      },
    });
    expect(mounted.chip()).toContain('Commenting on a region');
  });

  test('a click inside the frame is a point, drawn by the frame', async () => {
    const mounted = await mount(framed);
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.stage.dispatch('relic:frame-point', {
      detail: { type: 'relic:frame-point', x: 0.14, y: 0.05 },
    });
    // It was a box three hundredths of the document on each side, which on
    // a long document is a strip hundreds of pixels tall.
    expect(mounted.chip()).toContain('Commenting on a point');
    // The document scrolls inside the frame, so a pin drawn out here would
    // stay put while the passage it marks scrolled away.
    expect(withClass(mounted.stage, 'comment-pin')).toHaveLength(0);

    const posted = await mounted.post('about this spot');
    expect(posted.anchor).toEqual({ kind: 'pin', x: 0.14, y: 0.05 });
  });
  test('still announces what a comment would be about', async () => {
    const mounted = await mount(framed);
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });

  test('a selection over the frame is not a target', async () => {
    const mounted = await mount(framed);
    scripted.collapsed = false;
    scripted.ranges = 1;
    scripted.text = 'hello';
    scripted.within = mounted.stage;
    mounted.stage.dispatch('mouseup');

    expect(withClass(mounted.stage, 'popover-offer')).toHaveLength(0);
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });
});
