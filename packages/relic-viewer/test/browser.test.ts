import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildBar,
  markerLabelFor,
  openFrameExternalLink,
  renderSandboxedHtml,
  renderSandboxedJsx,
  safeDownloadName,
  sniffImageType,
} from '../src/main.ts';
import type { Mark } from '../src/rendered-tree.ts';
import {
  createSandboxHandler,
  isRenderJsxMessage,
  isRenderMessage,
} from '../src/sandbox.ts';
import { isCacheable } from '../src/sw-cache.ts';
import type { ReadyView, RenderRoute } from '../src/viewer.ts';

describe('safeDownloadName', () => {
  // The filename is untrusted display text used here as a lookup key, which
  // is the same defect class as archive entry names.
  const traversals: ReadonlyArray<readonly [string, string]> = [
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32', 'system32'],
    ['/etc/shadow', 'shadow'],
    ['....//evil.sh', 'evil.sh'],
    ['.bashrc', 'bashrc'],
    ['', 'relic'],
    ['   ', 'relic'],
    ['/', 'relic'],
  ];

  for (const [input, expected] of traversals) {
    test(`${JSON.stringify(input)} becomes ${expected}`, () => {
      expect(safeDownloadName(input)).toBe(expected);
    });
  }

  test('keeps an ordinary name intact', () => {
    expect(safeDownloadName('Q3 report.md')).toBe('Q3 report.md');
  });

  test('bounds the length', () => {
    expect(safeDownloadName('a'.repeat(500))).toHaveLength(200);
  });
});

describe('sniffImageType', () => {
  // Derived from magic bytes, never from the declared type. A declared
  // image/svg+xml would otherwise be a route into script execution.
  test('recognizes real image formats', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(
      'image/png'
    );
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      'image/jpeg'
    );
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(
      'image/gif'
    );
  });

  test('never returns an SVG or HTML type, whatever the bytes', () => {
    const svg = new TextEncoder().encode('<svg onload=alert(1)>');
    const type = sniffImageType(svg);
    expect(type).not.toContain('svg');
    expect(type).not.toContain('html');
    expect(type).toBe('application/octet-stream');
  });
});

describe('the sandbox handler', () => {
  const makeHandler = () => {
    const html: string[] = [];
    const jsx: string[] = [];
    const marks: Mark[][] = [];
    return {
      html,
      jsx,
      marks,
      handle: createSandboxHandler(
        (markup) => html.push(markup),
        (code) => jsx.push(code),
        (applied) => marks.push([...applied])
      ),
    };
  };

  test('renders a well-formed html message once', () => {
    const { html, jsx, handle } = makeHandler();

    expect(handle({ type: 'relic:render', html: '<p>hi</p>' })).toBe(true);
    expect(html).toEqual(['<p>hi</p>']);
    expect(jsx).toEqual([]);
  });

  test('renders a well-formed jsx message once', () => {
    const { html, jsx, handle } = makeHandler();

    expect(
      handle({ type: 'relic:render-jsx', code: 'export default App;' })
    ).toBe(true);
    expect(jsx).toEqual(['export default App;']);
    expect(html).toEqual([]);
  });

  test('refuses a second render, so content cannot be swapped after trust', () => {
    const { html, handle } = makeHandler();

    handle({ type: 'relic:render', html: 'first' });
    expect(handle({ type: 'relic:render', html: 'second' })).toBe(false);
    expect(html).toEqual(['first']);
  });

  test('the one render covers both types: jsx cannot follow html', () => {
    const { jsx, handle } = makeHandler();

    handle({ type: 'relic:render', html: 'first' });
    expect(handle({ type: 'relic:render-jsx', code: 'second' })).toBe(false);
    expect(jsx).toEqual([]);
  });

  test('the one render covers both types: html cannot follow jsx', () => {
    const { html, handle } = makeHandler();

    handle({ type: 'relic:render-jsx', code: 'first' });
    expect(handle({ type: 'relic:render', html: 'second' })).toBe(false);
    expect(handle({ type: 'relic:render-jsx', code: 'third' })).toBe(false);
    expect(html).toEqual([]);
  });

  const junk = [
    null,
    undefined,
    'a string',
    42,
    {},
    { type: 'relic:render' },
    { type: 'other', html: 'x' },
    { type: 'relic:render', html: 123 },
    { type: 'relic:render-jsx' },
    { type: 'relic:render-jsx', code: 123 },
    { type: 'relic:render-jsx', html: 'wrong field' },
    { type: 'relic:diff', before: 'old', current: 'new' },
  ];

  for (const data of junk) {
    test(`ignores ${JSON.stringify(data) ?? 'undefined'}`, () => {
      const { html, jsx, handle } = makeHandler();
      expect(handle(data)).toBe(false);
      expect(html).toEqual([]);
      expect(jsx).toEqual([]);
    });
  }

  test('junk does not consume the single render', () => {
    const { html, handle } = makeHandler();
    handle({ type: 'nope' });
    handle({ type: 'relic:render-jsx', code: 42 });
    expect(handle({ type: 'relic:render', html: 'real' })).toBe(true);
    expect(html).toEqual(['real']);
  });

  test('isRenderMessage is strict about both fields', () => {
    expect(isRenderMessage({ type: 'relic:render', html: '' })).toBe(true);
    expect(isRenderMessage({ type: 'relic:render' })).toBe(false);
    expect(isRenderMessage({ type: 'relic:render-jsx', code: 'x' })).toBe(
      false
    );
  });

  test('isRenderJsxMessage is strict about both fields', () => {
    expect(isRenderJsxMessage({ type: 'relic:render-jsx', code: '' })).toBe(
      true
    );
    expect(isRenderJsxMessage({ type: 'relic:render-jsx' })).toBe(false);
    expect(isRenderJsxMessage({ type: 'relic:render', html: 'x' })).toBe(false);
  });
});

/**
 * Annotation is the second message type the frame accepts, and it exists
 * because a rendered comparison has to outline what changed inside a frame the
 * parent cannot read. It is safe where a second render would not be, so the
 * boundary between the two gets its own tests.
 */
describe('the sandbox handler and annotation', () => {
  const makeHandler = () => {
    const html: string[] = [];
    const marks: Mark[][] = [];
    return {
      html,
      marks,
      handle: createSandboxHandler(
        (markup) => html.push(markup),
        () => {},
        (applied) => marks.push([...applied])
      ),
    };
  };

  const annotation = {
    type: 'relic:annotate',
    marks: [{ path: [1, 0], kind: 'changed' }],
  };

  test('refuses annotation before a render, because there is nothing to mark', () => {
    const { marks, handle } = makeHandler();

    expect(handle(annotation)).toBe(false);
    expect(marks).toEqual([]);
  });

  test('accepts one annotation after a render and passes its marks through', () => {
    const { marks, handle } = makeHandler();

    handle({ type: 'relic:render', html: '<p>hi</p>' });
    expect(handle(annotation)).toBe(true);
    expect(marks).toEqual([[{ path: [1, 0], kind: 'changed' }]]);
  });

  test('refuses a second annotation, for the same reason as a second render', () => {
    const { marks, handle } = makeHandler();

    handle({ type: 'relic:render', html: '<p>hi</p>' });
    handle(annotation);
    expect(handle(annotation)).toBe(false);
    expect(marks).toHaveLength(1);
  });

  test('refuses a malformed mark rather than salvaging the valid half', () => {
    const { marks, handle } = makeHandler();

    handle({ type: 'relic:render', html: '<p>hi</p>' });
    expect(
      handle({
        type: 'relic:annotate',
        marks: [
          { path: [0], kind: 'added' },
          { path: [-1], kind: 'added' },
        ],
      })
    ).toBe(false);
    expect(marks).toEqual([]);
  });

  test('annotating does not reopen the render guard', () => {
    const { html, handle } = makeHandler();

    handle({ type: 'relic:render', html: 'first' });
    handle(annotation);
    expect(handle({ type: 'relic:render', html: 'second' })).toBe(false);
    expect(html).toEqual(['first']);
  });
});

describe('the service worker caches the shell and nothing else', () => {
  const origin = (path: string) => new URL(`https://relic.example${path}`);

  test('caches the app shell', () => {
    for (const path of [
      '/assets/viewer.js',
      '/assets/styles.css',
      '/manifest.webmanifest',
    ]) {
      expect(isCacheable(origin(path), true)).toBe(true);
    }
  });

  test('never caches relic ciphertext from storage', () => {
    // A cache entry would outlive the TTL and the per-object cap, on the
    // recipient's disk, past a takedown.
    expect(
      isCacheable(new URL('https://storage.googleapis.com/o/abc'), false)
    ).toBe(false);
  });

  test('never caches the mint or anything else under /api/', () => {
    expect(isCacheable(origin('/api/relics/abc/mint'), true)).toBe(false);
    expect(isCacheable(origin('/api/grant'), true)).toBe(false);
    expect(isCacheable(origin('/api/anything-added-later'), true)).toBe(false);
  });

  test('never caches a relic shell, so a takedown is not papered over', () => {
    expect(isCacheable(origin('/aaaaaaaaaaaaaaaaaaaaaaaaaa'), true)).toBe(
      false
    );
  });
});

describe('the usercontent frame the render routes build', () => {
  // The frame's sandbox attribute is the popup boundary: CSP cannot govern
  // a top-level context a popup opens, so the flag must simply be absent.
  // These tests pin the attribute at both call sites so a future edit
  // cannot quietly restore allow-popups or allow-forms.
  class ElementStub {
    readonly tagName: string;
    className = '';
    textContent = '';
    readonly children: ElementStub[] = [];
    readonly attributes = new Map<string, string>();
    readonly classList = { add: (_name: string): void => {} };

    constructor(tag: string) {
      // The DOM reports tag names uppercase; match it so a tagName search
      // behaves as it would in a browser.
      this.tagName = tag.toUpperCase();
    }
    get href(): string {
      return this.attributes.get('href') ?? '';
    }
    set href(v: string) {
      this.attributes.set('href', v);
    }
    get target(): string {
      return this.attributes.get('target') ?? '';
    }
    set target(v: string) {
      this.attributes.set('target', v);
    }
    get rel(): string {
      return this.attributes.get('rel') ?? '';
    }
    set rel(v: string) {
      this.attributes.set('rel', v);
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
    appendChild(child: ElementStub): ElementStub {
      this.children.push(child);
      return child;
    }

    append(...kids: ElementStub[]): void {
      this.children.push(...kids);
    }

    addEventListener(): void {}
  }

  /** Bun tests run without a DOM; the render routes only need createElement
   * and window message listeners, so a local stub is enough. Defined here,
   * never imported from another test file: that re-runs its describes. */
  let created: ElementStub[];

  beforeEach(() => {
    created = [];
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        const element = new ElementStub(tag);
        created.push(element);
        return element;
      },
      // The bar's icons are inline SVG, which comes through the namespaced
      // constructor rather than createElement.
      createElementNS: (_ns: string, tag: string) => {
        const element = new ElementStub(tag);
        created.push(element);
        return element;
      },
    };
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  const USERCONTENT_ORIGIN = 'https://relik-usercontent.example';

  const view = (
    route: 'sandboxed-html' | 'sandboxed-jsx',
    source: string
  ): ReadyView => ({
    filename: route === 'sandboxed-jsx' ? 'Widget.tsx' : 'page.html',
    declaredMimetype: 'text/html',
    content: new TextEncoder().encode(source),
    route,
    downgradeNotice: undefined,
    shareUrl: 'https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#k',
    version: 1,
    currentVersion: 1,
    versionDigest: '0'.repeat(64),
  });

  const sandboxAttributeOf = (wrapper: HTMLElement): string => {
    const frame = created.find((element) => element.tagName === 'IFRAME');
    // A throw rather than an assertion, so the rest of this helper reads a
    // defined frame instead of threading an optional through it.
    if (frame === undefined) throw new Error('the render path built no iframe');
    // The render functions return HTMLElement but build with this file's
    // stubs, so the children read needs one unchecked cast to the stub type.
    const wrapperChildren = (wrapper as unknown as ElementStub).children;
    expect(wrapperChildren).toContain(frame);
    return frame.attributes.get('sandbox') ?? '';
  };

  test('the html route allows scripts and nothing else', () => {
    const wrapper = renderSandboxedHtml(
      view('sandboxed-html', '<p>hi</p>'),
      USERCONTENT_ORIGIN
    );
    expect(sandboxAttributeOf(wrapper)).toBe('allow-scripts');
  });

  test('the jsx route allows scripts and nothing else', () => {
    const wrapper = renderSandboxedJsx(
      view(
        'sandboxed-jsx',
        'export default function App() {\n  return <p>hi</p>;\n}'
      ),
      USERCONTENT_ORIGIN
    );
    expect(sandboxAttributeOf(wrapper)).toBe('allow-scripts');
  });

  test('opens only validated frame links without opener or referrer', () => {
    const calls: string[][] = [];
    const open = (url: string, target: string, features: string) => {
      calls.push([url, target, features]);
      return null;
    };

    expect(
      openFrameExternalLink(
        { type: 'relic:open-link', href: 'https://example.com/report' },
        open
      )
    ).toBe(true);
    expect(calls).toEqual([
      ['https://example.com/report', '_blank', 'noopener,noreferrer'],
    ]);

    expect(
      openFrameExternalLink(
        { type: 'relic:open-link', href: 'javascript:alert(1)' },
        open
      )
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });
  test('the marker states what each route actually does with author code', () => {
    // One string for every relic is how a five-second mp4 came to tell its
    // recipient it runs the author's code. Only the two sandboxed routes
    // execute anything an author wrote; the rest are decoded by the browser.
    const executes: RenderRoute[] = ['sandboxed-html', 'sandboxed-jsx'];
    const inert: RenderRoute[] = [
      'markdown',
      'code',
      'image',
      'media',
      'pdf',
      'download',
    ];

    for (const route of [...executes, ...inert]) {
      const label = markerLabelFor(route);
      expect(label.length).toBeGreaterThan(0);
      if (executes.includes(route)) {
        expect(label).toBe('Runs author code, isolated');
      } else {
        expect(label).not.toContain('Runs author code');
        expect(label).toContain('no author code');
      }
    }

    // And the claim reaches the rendered bar, not just the table: a media
    // relic's marker must not carry the sandboxed sentence.
    buildBar(
      { ...view('sandboxed-html', 'x'), route: 'media', filename: 'clip.mp4' },
      'aaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    const marker = created.find((element) =>
      element.className.split(' ').includes('marker')
    );
    if (marker === undefined) throw new Error('the bar built no marker');
    const visible = marker.children
      .map((child) => child.textContent)
      .join('')
      .trim();
    expect(visible).toBe('Plays in your browser, no author code');
    expect(marker.attributes.get('aria-label') ?? '').toContain(visible);
  });

  test('the marker says the same thing to the eye and to a screen reader', () => {
    // WCAG 2.5.3 asks the accessible name to contain the visible label, and
    // these were separate strings that drifted the moment they were written:
    // the label read "Runs author code" while the name read "the author's
    // code", which is exactly what breaks voice control, since the user says
    // what they can see.
    buildBar(view('sandboxed-html', '<p>hi</p>'), 'aaaaaaaaaaaaaaaaaaaaaaaaaa');

    const marker = created.find((element) =>
      element.className.split(' ').includes('marker')
    );
    if (marker === undefined) throw new Error('the bar built no marker');

    const name = marker.attributes.get('aria-label') ?? '';
    const visible = marker.children
      .map((child) => child.textContent)
      .join('')
      .trim();

    expect(visible.length).toBeGreaterThan(0);
    expect(name).toContain(visible);
  });

  test('the bar carries the relics link targeting a new tab with rel="noopener"', () => {
    buildBar(view('sandboxed-html', '<p>hi</p>'), 'aaaaaaaaaaaaaaaaaaaaaaaaaa');

    const relicsLink = created.find((element) =>
      element.className.split(' ').includes('action-relics')
    );
    if (relicsLink === undefined)
      throw new Error('the bar built no relics link');

    expect(relicsLink.tagName).toBe('A');
    expect(relicsLink.attributes.get('href')).toBe('/dashboard');
    expect(relicsLink.attributes.get('target')).toBe('_blank');
    expect(relicsLink.attributes.get('rel')).toBe('noopener');

    const ariaLabel = relicsLink.attributes.get('aria-label') ?? '';
    const visible = relicsLink.children
      .map((child) => child.textContent)
      .join('')
      .trim();
    expect(visible).toBe('Relics');
    expect(ariaLabel).toContain(visible);
  });

  test('stylesheet collapses relics link at narrow widths along with other actions', async () => {
    const css = await Bun.file(
      new URL('../src/styles.css', import.meta.url)
    ).text();

    // Below 34rem, actions collapse labels to icon (span hidden)
    expect(css).toContain('.action span');
    // Below 24rem, action-relics and action-comments leave the row to protect the 320px floor
    expect(css).toMatch(
      /@media\s*\(max-width:\s*24rem\)\s*\{[\s\S]*?\.action-relics[\s\S]*?display:\s*none/
    );
  });
});
