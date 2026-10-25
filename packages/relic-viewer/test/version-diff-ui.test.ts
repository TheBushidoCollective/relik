import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  deriveCommentKey,
  encodeFragment,
  encryptRelic,
  generateKey,
  type OtioAnchorV1,
} from '@relic/format';
import { commentCipher } from '../src/comments.ts';
import { MAX_DIFF_BYTES } from '../src/diff.ts';
import {
  buildBar,
  buildChangesSidebar,
  buildComparePicker,
  buildComparisonScaffold,
  buildCurrentStage,
  buildThread,
  commentRow,
  comparisonCopy,
  renderCodeComparison,
  renderComparison,
  renderImageComparison,
  renderLoadedVersion,
  renderReady,
  renderRenderedComparison,
  seedComparisonPair,
  uncomparableReason,
} from '../src/main.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';

/**
 * Bun tests run without a DOM. These stubs carry only what the DOM layer
 * touches while it builds: enough to assert structure, never enough to assert
 * layout or a rendered pixel. What a rendered comparison actually looks like
 * is proven in a browser, which is the only place it can be.
 */
class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  private _innerHTML = '';
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(html: string) {
    this._innerHTML = html;
    this.textContent = html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  min = '';
  max = '';
  value = '';
  readonly children: ElementStub[] = [];
  get firstElementChild(): ElementStub | null {
    return this.children[0] ?? null;
  }
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => {} };
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(' ')
        .filter((c) => c !== name)
        .join(' ');
    },
    contains: (name: string): boolean => {
      return this.className.split(' ').includes(name);
    },
    toggle: (name: string, force?: boolean): boolean => {
      const exists = this.className.split(' ').includes(name);
      const next = force !== undefined ? force : !exists;
      if (next) {
        if (!exists) this.className = `${this.className} ${name}`.trim();
      } else {
        this.className = this.className
          .split(' ')
          .filter((c) => c !== name)
          .join(' ');
      }
      return next;
    },
  };
  readonly listeners: Record<string, ((event?: unknown) => void)[]> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  append(...children: ElementStub[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  contains(): boolean {
    return false;
  }
  querySelectorAll(): ElementStub[] {
    return [];
  }

  querySelector(): ElementStub | null {
    return null;
  }

  focus(): void {}

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners[type] ?? [];
    list.push(listener);
    this.listeners[type] = list;
  }

  click(): void {
    for (const listener of this.listeners['click'] ?? []) {
      listener({ target: this, preventDefault: () => {} });
    }
  }
}

const encoder = new TextEncoder();

function view(
  route: ReadyView['route'],
  version: number,
  content: Uint8Array = encoder.encode('const current = true;\n'),
  currentVersion = version,
  shareUrl = `https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#${encodeFragment(generateKey())}`
): ReadyView {
  return {
    filename: route === 'download' ? 'archive.zip' : 'notes.ts',
    declaredMimetype:
      route === 'download' ? 'application/zip' : 'text/typescript',
    content,
    route,
    downgradeNotice: undefined,
    shareUrl,
    version,
    currentVersion,
    versionDigest: '0'.repeat(64),
  };
}

function textOf(element: ElementStub): string {
  return [element.textContent, ...element.children.map(textOf)].join(' ');
}

function descendants(element: ElementStub): ElementStub[] {
  return [element, ...element.children.flatMap(descendants)];
}

function withClass(element: ElementStub, name: string): ElementStub[] {
  return descendants(element).filter((candidate) =>
    candidate.className.split(' ').includes(name)
  );
}
function getBody(): ElementStub {
  const globalDoc = (globalThis as Record<string, unknown>).document;
  if (globalDoc && typeof globalDoc === 'object' && 'body' in globalDoc) {
    return globalDoc.body as ElementStub;
  }
  throw new Error('document.body missing');
}
function dummyDeps(fetchFn?: typeof globalThis.fetch): ViewerDeps {
  const defaultFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/mint')) {
      return Response.json({
        url: 'https://storage.example/v2',
        object_length: 0,
        version: 2,
        current_version: 3,
      });
    }
    return new Response(new Uint8Array(0) as unknown as BodyInit);
  }) as typeof globalThis.fetch;

  return {
    serviceOrigin: 'https://relik.example',
    fetch: fetchFn ?? defaultFetch,
    takeFragment: () => encodeFragment(generateKey()),
    stripFragment: () => {},
    locationHref: 'https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#key',
    keyVault: {
      remember: () => {},
      recall: () => undefined,
      forget: () => {},
    },
  };
}

describe('version comparison affordance', () => {
  beforeEach(() => {
    const body = new ElementStub('BODY');
    (globalThis as { document?: unknown }).document = {
      body,
      documentElement: {
        style: {
          setProperty: () => {},
          getPropertyValue: () => '',
        },
      },
      createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_namespace: string, tag: string) =>
        new ElementStub(tag),
      addEventListener: () => {},
    };
    (globalThis as { window?: unknown }).window = {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  test('version 1 shows no comparison affordance at all', () => {
    const bar = buildBar(view('code', 1), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    const buttons = descendants(bar).filter(
      (element) => element.tagName === 'BUTTON'
    );
    expect(buttons.map(textOf).join(' ')).not.toContain('Compare versions');
  });

  test('version 1 says nothing about versions in the taskbar either', () => {
    // A version number with no history behind it invites a question that has
    // no answer, so absence survived the move into the taskbar.
    const bar = buildBar(view('code', 1), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    expect(withClass(bar, 'version')).toHaveLength(0);
    expect(textOf(bar)).not.toContain('Version');
  });

  test('version 2 or higher offers comparison', () => {
    const bar = buildBar(view('code', 2), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    const buttons = descendants(bar).filter(
      (element) => element.tagName === 'BUTTON'
    );
    expect(buttons.map(textOf).join(' ')).toContain('Compare versions');
  });

  test('the taskbar carries the version beside the relic id', () => {
    const bar = buildBar(view('code', 4), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    const meta = withClass(bar, 'identity-meta')[0];
    if (meta === undefined) throw new Error('the bar built no metadata line');
    expect(textOf(meta)).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(textOf(meta)).toContain('Version 4 of 4');
    // The short form ships alongside it, because the long one does not fit at
    // 320 CSS pixels and the stylesheet is what chooses between them.
    expect(textOf(meta)).toContain('v4/4');
  });

  test('a freshly opened relic renders no comparison surface at all', () => {
    const current = view('code', 3);
    renderReady(
      current,
      'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://relik-usercontent.example',
      dummyDeps()
    );

    const docBody = getBody();
    expect(withClass(docBody, 'stage-diff')).toHaveLength(0);
    expect(withClass(docBody, 'compare-picker')).toHaveLength(0);
    expect(withClass(docBody, 'bar')).toHaveLength(1);
    expect(withClass(docBody, 'stage-code')).toHaveLength(1);
  });

  test('attaches the comment thread to the scrolling stage wrap, not inner stage', () => {
    const current = view('code', 3);
    renderReady(
      current,
      'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://relik-usercontent.example',
      dummyDeps()
    );

    const docBody = getBody();
    const wrap = withClass(docBody, 'stage-wrap')[0];
    const stage = withClass(docBody, 'stage-code')[0];
    if (!wrap || !stage) throw new Error('missing wrap or stage');
    expect(wrap.dataset['pairBind']).toBe('1');
    expect(stage.dataset['pairBind']).toBeUndefined();
  });

  test('the taskbar carries the version label, never a comparison dropdown', () => {
    const bar = buildBar(view('code', 4), 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;

    expect(withClass(bar, 'version-label')).toHaveLength(1);
    expect(withClass(bar, 'version-trigger')).toHaveLength(0);
    expect(withClass(bar, 'version-list')).toHaveLength(0);
    expect(textOf(bar)).toContain('Version 4 of 4');
  });

  test('entering compare mode shows a picker defaulting to previous against current', () => {
    const scaffold = buildComparisonScaffold(4, 3, 4, () => {});
    const picker = scaffold.picker.element as unknown as ElementStub;

    const sides = withClass(picker, 'compare-picker-side');
    expect(sides).toHaveLength(2);

    const triggers = withClass(picker, 'version-trigger');
    expect(triggers).toHaveLength(2);

    // Left defaults to previous version (3)
    const leftTrigger = triggers[0];
    if (leftTrigger === undefined) throw new Error('no left trigger built');
    expect(leftTrigger.dataset['side']).toBe('left');
    expect(leftTrigger.attributes.get('aria-label')).toBe(
      'Left version: Version 3'
    );
    expect(textOf(leftTrigger)).toContain('Version 3');
    expect(textOf(leftTrigger)).not.toContain('current');

    // Right defaults to current version (4)
    const rightTrigger = triggers[1];
    if (rightTrigger === undefined) throw new Error('no right trigger built');
    expect(rightTrigger.dataset['side']).toBe('right');
    expect(rightTrigger.attributes.get('aria-label')).toBe(
      'Right version: Version 4, current'
    );
    expect(textOf(rightTrigger)).toContain('Version 4, current');

    // Both sides offer owned listboxes for all versions from 1 to current
    const lists = withClass(picker, 'version-list');
    expect(lists).toHaveLength(2);
    expect(
      lists.every((list) => list.attributes.get('role') === 'listbox')
    ).toBe(true);

    const leftOptions = withClass(
      sides[0] as unknown as ElementStub,
      'version-option'
    );
    expect(leftOptions.map((opt) => opt.textContent)).toEqual([
      'Version 4, current',
      'Version 3',
      'Version 2',
      'Version 1',
    ]);
    expect(leftOptions.every((opt) => opt.tabIndex === -1)).toBe(true);

    // Never a native select
    expect(descendants(picker).some((el) => el.tagName === 'SELECT')).toBe(
      false
    );
  });

  test('buildComparePicker binds left and right handles', () => {
    const picker = buildComparePicker({
      leftVersion: 2,
      rightVersion: 3,
      currentVersion: 3,
      onSelectLeft: () => {},
      onSelectRight: () => {},
    });
    expect(picker.left.options).toHaveLength(3);
    expect(picker.right.options).toHaveLength(3);
    picker.setVersions(1, 2);
    expect(textOf(picker.left.trigger as unknown as ElementStub)).toContain(
      'Version 1'
    );
    expect(textOf(picker.right.trigger as unknown as ElementStub)).toContain(
      'Version 2'
    );
  });

  test('changing either side re-renders', () => {
    const picked: Array<{ left: number; right: number }> = [];
    const scaffold = buildComparisonScaffold(4, 3, 4, (left, right) => {
      picked.push({ left, right });
    });
    const picker = scaffold.picker.element as unknown as ElementStub;

    const leftSide = withClass(picker, 'compare-picker-left')[0];
    if (leftSide === undefined) throw new Error('no left side');
    const leftOptions = withClass(leftSide, 'version-option');
    const leftV1Option = leftOptions.find(
      (opt) => opt.dataset['version'] === '1'
    );
    if (leftV1Option === undefined) throw new Error('no v1 option on left');
    leftV1Option.click();

    expect(picked).toHaveLength(1);
    expect(picked[0]).toEqual({ left: 1, right: 4 });

    const rightSide = withClass(picker, 'compare-picker-right')[0];
    if (rightSide === undefined) throw new Error('no right side');
    const rightOptions = withClass(rightSide, 'version-option');
    const rightV2Option = rightOptions.find(
      (opt) => opt.dataset['version'] === '2'
    );
    if (rightV2Option === undefined) throw new Error('no v2 option on right');
    rightV2Option.click();

    expect(picked).toHaveLength(2);
    expect(picked[1]).toEqual({ left: 1, right: 2 });
  });

  test('the same version on both sides is refused with an explanation', () => {
    const current = view('code', 3);
    renderComparison(
      current,
      'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://relik-usercontent.example',
      dummyDeps(),
      () => {},
      2,
      2
    );

    const docBody = getBody();
    expect(withClass(docBody, 'notice')).toHaveLength(1);
    expect(textOf(docBody)).toContain(
      'Comparing a version to itself produces no diff'
    );
    expect(textOf(docBody)).toContain(
      'Choose two different versions to compare'
    );

    // Neither code nor rendered comparison stage was built
    expect(withClass(docBody, 'diff-changes')).toHaveLength(0);
    expect(withClass(docBody, 'compare-stage')).toHaveLength(0);
  });

  test('clicking compare versions in the taskbar enters compare mode and view current exits', () => {
    const current = view('code', 3);
    renderReady(
      current,
      'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://relik-usercontent.example',
      dummyDeps()
    );

    const docBody = getBody();
    expect(withClass(docBody, 'stage-diff')).toHaveLength(0);

    const compareBtn = descendants(docBody).find(
      (el) => el.tagName === 'BUTTON' && textOf(el).includes('Compare versions')
    );
    if (compareBtn === undefined) throw new Error('no compare versions button');
    compareBtn.click();

    expect(withClass(docBody, 'stage-diff')).toHaveLength(1);
    expect(withClass(docBody, 'compare-picker')).toHaveLength(1);

    const viewCurrentBtn = descendants(docBody).find(
      (el) => el.tagName === 'BUTTON' && textOf(el).includes('View current')
    );
    if (viewCurrentBtn === undefined) throw new Error('no view current button');
    viewCurrentBtn.click();

    expect(withClass(docBody, 'stage-diff')).toHaveLength(0);
    expect(withClass(docBody, 'stage-code')).toHaveLength(1);
  });

  test('picking version 2 from the version control renders version 2 on its own with no compare surface', async () => {
    const key = generateKey();
    const current = view(
      'code',
      3,
      encoder.encode('current'),
      3,
      `https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#${encodeFragment(key)}`
    );
    const v2Bytes = await encryptRelic({
      key,
      content: new TextEncoder().encode('version 2 content\n'),
      filename: 'notes.ts',
      mimetype: 'text/typescript',
    });

    renderReady(
      current,
      'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://relik-usercontent.example',
      dummyDeps((async (input) => {
        const url = String(input);
        if (url.endsWith('/mint')) {
          return Response.json({
            url: 'https://storage.example/v2',
            object_length: v2Bytes.length,
            version: 2,
            current_version: 3,
          });
        }
        return new Response(v2Bytes as unknown as BodyInit);
      }) as typeof globalThis.fetch)
    );

    const docBody = getBody();

    // Select version 2 from the taskbar version control dropdown
    const v2Option = withClass(docBody, 'version-option').find(
      (opt) => opt.dataset['version'] === '2'
    );
    if (v2Option === undefined) throw new Error('no v2 option in taskbar');

    const { promise, resolve } = Promise.withResolvers<void>();
    const origReplace = docBody.replaceChildren.bind(docBody);
    docBody.replaceChildren = (...args) => {
      origReplace(...args);
      resolve();
    };

    v2Option.click();
    await promise;
    docBody.replaceChildren = origReplace;
    // Version 2 renders on its own
    expect(withClass(docBody, 'stage-diff')).toHaveLength(0);
    expect(withClass(docBody, 'compare-picker')).toHaveLength(0);
    expect(withClass(docBody, 'diff-changes-sidebar')).toHaveLength(0);
    expect(withClass(docBody, 'stage-code')).toHaveLength(1);
    expect(textOf(docBody)).toContain('Version 2 of 3');

    // Compare toggle is present and discoverable from that state
    const compareBtn = descendants(docBody).find(
      (el) => el.tagName === 'BUTTON' && textOf(el).includes('Compare versions')
    );
    expect(compareBtn).toBeDefined();

    // Toggling compare on produces the picker plus two panes and changes sidebar
    compareBtn?.click();
    expect(withClass(docBody, 'stage-diff')).toHaveLength(1);
    expect(withClass(docBody, 'compare-picker')).toHaveLength(1);
    expect(withClass(docBody, 'diff-changes-sidebar')).toHaveLength(1);

    // Toggling compare off returns to version 2 (the single version the reader was on)
    const exitBtn = descendants(docBody).find(
      (el) => el.tagName === 'BUTTON' && textOf(el).includes('View version 2')
    );
    expect(exitBtn).toBeDefined();
    expect(exitBtn?.attributes.get('aria-label')).toBe(
      'Return to viewing version 2'
    );
    exitBtn?.click();

    expect(withClass(docBody, 'stage-diff')).toHaveLength(0);
    expect(withClass(docBody, 'compare-picker')).toHaveLength(0);
    expect(withClass(docBody, 'diff-changes-sidebar')).toHaveLength(0);
    expect(textOf(docBody)).toContain('Version 2 of 3');
  });

  test('the changes sidebar is present, collapses, reopens, and reports its count', () => {
    const sidebarHandle = buildChangesSidebar();
    const sidebar = sidebarHandle.sidebar as unknown as ElementStub;
    const tab = sidebarHandle.tab as unknown as ElementStub;

    expect(sidebar.className).toContain('is-open');
    expect(textOf(sidebar)).toContain('Changes');
    expect(textOf(tab)).toContain('Changes');

    // Reports count when changes arrive
    sidebarHandle.setChanges(5, undefined);
    expect(textOf(sidebar)).toContain('5');
    expect(textOf(tab)).toContain('5');
    expect(sidebar.className).toContain('is-open');

    // Collapses when toggle clicked
    const toggle = withClass(sidebar, 'thread-toggle')[0];
    if (toggle === undefined) throw new Error('no toggle button');
    toggle.click();
    expect(sidebar.className).not.toContain('is-open');
    expect(toggle.attributes.get('aria-expanded')).toBe('false');
    expect(tab.attributes.get('aria-expanded')).toBe('false');

    // Reopens when tab clicked
    tab.click();
    expect(sidebar.className).toContain('is-open');
    expect(toggle.attributes.get('aria-expanded')).toBe('true');
    expect(tab.attributes.get('aria-expanded')).toBe('true');
  });

  test('commentRow displays unversioned badge when version is null', () => {
    const entry = {
      kind: 'open' as const,
      id: 'c1',
      author: 'ada@example.com',
      createdAt: new Date().toISOString(),
      body: 'historical comment',
      displayName: null,
      anchor: null,
      version: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    expect(textOf(row)).toContain('Version unknown');
    expect(withClass(row, 'comment-badge-unversioned')).toHaveLength(1);
    const badge = withClass(row, 'comment-badge-unversioned')[0];
    if (badge === undefined) throw new Error('no unversioned badge');
    expect(badge.attributes.get('title')).toBe('Predates versioning');

    const versionedEntry = { ...entry, version: 2 };
    const versionedRow = commentRow(versionedEntry) as unknown as ElementStub;
    expect(textOf(versionedRow)).not.toContain('Version unknown');
  });

  test('seedComparisonPair never seeds the same version on both sides', () => {
    for (const total of [2, 3, 4, 5]) {
      for (let v = 1; v <= total; v++) {
        const pair = seedComparisonPair(v, total);
        // This assertion catches the defect where v1 paired with itself:
        expect(pair.left).not.toBe(pair.right);
      }
    }
  });

  test('viewing version 1 pairs forward to version 2 on compare entry', () => {
    // These assertions catch the defect where v1 fell back to pairing with itself:
    const fromV1 = seedComparisonPair(1, 3);
    expect(fromV1).toEqual({ left: 1, right: 2 });
    expect(fromV1.left).not.toBe(fromV1.right);

    const fromV2 = seedComparisonPair(2, 3);
    expect(fromV2).toEqual({ left: 1, right: 2 });

    const fromV3 = seedComparisonPair(3, 3);
    expect(fromV3).toEqual({ left: 2, right: 3 });
  });

  test('a version that cannot be decrypted shows the refusal notice', async () => {
    const current = view('code', 3);
    const deps = dummyDeps((async (input) => {
      const url = String(input);
      if (url.endsWith('/mint')) {
        return Response.json({
          url: 'https://storage.example/v2',
          object_length: 100,
          version: 2,
          current_version: 3,
        });
      }
      return new Response(new Uint8Array(100) as unknown as BodyInit);
    }) as typeof globalThis.fetch);

    const { promise, resolve } = Promise.withResolvers<void>();
    const originalSetAttribute = ElementStub.prototype.setAttribute;
    ElementStub.prototype.setAttribute = function (
      name: string,
      value: string
    ) {
      originalSetAttribute.call(this, name, value);
      if (name === 'aria-busy' && value === 'false') {
        resolve();
      }
    };

    try {
      renderComparison(
        current,
        'aaaaaaaaaaaaaaaaaaaaaaaaaa',
        'https://relik-usercontent.example',
        deps,
        () => {},
        2,
        3
      );
      await promise;
    } finally {
      ElementStub.prototype.setAttribute = originalSetAttribute;
    }

    const docBody = getBody();
    expect(withClass(docBody, 'notice')).toHaveLength(1);
    expect(textOf(docBody)).toContain('could not be decrypted');
  });

  test('uncomparableReason explains when left or right is download-only or different route', () => {
    const code = view('code', 3);
    const download = view('download', 2);
    const image = view('image', 1);

    expect(uncomparableReason(code, download, 2)).toContain(
      'Version 2 is download-only, so it cannot be shown beside version 3. It is open here on its own.'
    );
    expect(uncomparableReason(download, code, 3)).toContain(
      'Version 2 is download-only, so it cannot be shown beside version 3. Version 3 is open here on its own.'
    );
    expect(uncomparableReason(code, image, 1)).toContain(
      'Version 1 and version 3 display differently, so they cannot be shown side by side. Version 1 is open here on its own.'
    );
  });

  test('a side is labelled current only when it is the current version', () => {
    // Left is v2, Right is v3 (current on v3 relic):
    // Left pane is "Version 2", Right pane is "Version 3, current"
    const compareA = renderRenderedComparison(
      view('markdown', 3, encoder.encode('# Three\n')),
      view('markdown', 2, encoder.encode('# Two\n'), 3),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;
    const beforeLabelA = withClass(compareA, 'compare-label-before')[0];
    const afterLabelA = withClass(compareA, 'compare-label-current')[0];
    expect(beforeLabelA?.textContent).toBe('Version 2');
    expect(afterLabelA?.textContent).toBe('Version 3, current');

    // Left is v1, Right is v2 on a v3 relic:
    // Neither side is current!
    const compareB = renderRenderedComparison(
      view('markdown', 2, encoder.encode('# Two\n'), 3),
      view('markdown', 1, encoder.encode('# One\n'), 3),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;
    const beforeLabelB = withClass(compareB, 'compare-label-before')[0];
    const afterLabelB = withClass(compareB, 'compare-label-current')[0];
    expect(beforeLabelB?.textContent).toBe('Version 1');
    expect(afterLabelB?.textContent).toBe('Version 2');
    expect(textOf(compareB)).not.toContain('current');

    // Left is v3 (current on v3 relic), Right is v1:
    // Left pane is "Version 3, current", Right pane is "Version 1"
    const compareC = renderRenderedComparison(
      view('markdown', 1, encoder.encode('# One\n'), 3),
      view('markdown', 3, encoder.encode('# Three\n')),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;
    const beforeLabelC = withClass(compareC, 'compare-label-before')[0];
    const afterLabelC = withClass(compareC, 'compare-label-current')[0];
    expect(beforeLabelC?.textContent).toBe('Version 3, current');
    expect(afterLabelC?.textContent).toBe('Version 1');

    // Image diff follows the exact same truth in labeling
    const imgA = renderImageComparison(
      view('image', 3, encoder.encode('current-img')),
      view('image', 2, encoder.encode('older-img'), 3)
    ) as unknown as ElementStub;
    expect(withClass(imgA, 'image-diff-label-before')[0]?.textContent).toBe(
      'Version 2'
    );
    expect(withClass(imgA, 'image-diff-label-current')[0]?.textContent).toBe(
      'Version 3, current'
    );

    const imgB = renderImageComparison(
      view('image', 2, encoder.encode('v2-img'), 3),
      view('image', 1, encoder.encode('v1-img'), 3)
    ) as unknown as ElementStub;
    expect(withClass(imgB, 'image-diff-label-before')[0]?.textContent).toBe(
      'Version 1'
    );
    expect(withClass(imgB, 'image-diff-label-current')[0]?.textContent).toBe(
      'Version 2'
    );
    expect(textOf(imgB)).not.toContain('current');
  });

  test('comparison copy names the versions accurately without falsehoods', () => {
    expect(comparisonCopy(2, 3, 3)).toEqual({
      headline: 'Comparing version 2 with version 3',
      detail:
        'Version 3 is current. Version 2 is retained history and may contain content removed from the current artifact.',
    });
    expect(comparisonCopy(3, 1, 3)).toEqual({
      headline: 'Comparing version 3 with version 1',
      detail:
        'Version 3 is current. Version 1 is retained history and may contain content removed from the current artifact.',
    });
    expect(comparisonCopy(1, 2, 4)).toEqual({
      headline: 'Comparing version 1 with version 2',
      detail:
        'Version 4 is current. Versions 1 and 2 are retained history and may contain content removed from the current artifact.',
    });
    expect(comparisonCopy(2, 2, 3)).toEqual({
      headline: 'Comparing version 2 with version 2',
      detail: 'Choose two different versions to see what changed between them.',
    });
  });

  /**
   * These three assert the same guarantee on the three relics that cannot be
   * compared, and they used to assert only half of it.
   *
   * Checking that the bar does not say "Compare versions" was true and
   * insufficient: it passes just as well when the bar offers no way into the
   * history at all, which is what it did, and which is the defect. So each
   * one now also asserts the control is there under a label that describes
   * what it actually does.
   */
  test('download-only history is reachable, and says why it cannot compare', () => {
    const current = view('download', 3);
    const bar = buildBar(current, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;
    const stage = buildCurrentStage(
      current,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(bar)).not.toContain('Compare versions');
    expect(textOf(bar)).toContain('Earlier versions');
    expect(textOf(stage)).toContain('download-only');
    expect(
      descendants(stage).some(
        (element) => element.className === 'doc doc-download'
      )
    ).toBe(true);
  });

  test('oversized code history is reachable, and states the ceiling', () => {
    const current = view('code', 3, new Uint8Array(MAX_DIFF_BYTES + 1));
    const bar = buildBar(current, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;
    const stage = buildCurrentStage(
      current,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(bar)).not.toContain('Compare versions');
    expect(textOf(bar)).toContain('Earlier versions');
    expect(textOf(stage)).toContain('16 MiB');
    expect(
      descendants(stage).some((element) => element.className === 'code')
    ).toBe(true);
  });

  test('oversized rendered history is reachable, and states the same ceiling', () => {
    const current = view(
      'sandboxed-html',
      3,
      new Uint8Array(MAX_DIFF_BYTES + 1)
    );
    const bar = buildBar(current, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      onCompare: () => {},
    }) as unknown as ElementStub;
    const stage = buildCurrentStage(
      current,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(bar)).not.toContain('Compare versions');
    expect(textOf(bar)).toContain('Earlier versions');
    expect(textOf(stage)).toContain('16 MiB');
    expect(
      descendants(stage).some((element) =>
        element.className.split(' ').includes('doc-html')
      )
    ).toBe(true);
  });

  /**
   * The reported defect, asserted where it actually happened.
   *
   * The three tests above prove the reader can reach an earlier version. This
   * one proves that what they get back contains the version, which is the
   * sentence in the report: "viewing earlier versions that cannot be compared
   * should still show that version of the content."
   */
  test('an uncomparable version is rendered, not replaced by the reason', () => {
    // Prose against a picture: both open, neither can be shown beside the
    // other. This is the pair that used to produce a page with a sentence on
    // it and nothing else.
    const current = view('image', 3, new TextEncoder().encode('PNG'));
    const historical = view(
      'markdown',
      2,
      new TextEncoder().encode('# Notes\n')
    );

    const result = renderLoadedVersion(
      current,
      historical,
      2,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    // The reason is present, because a reader is owed an explanation.
    expect(textOf(result)).toContain('display differently');
    // And the version is rendered, which is the part that was missing. The
    // markdown renderer escapes and then assigns markup, so the content
    // arrives as `innerHTML` on `.prose` rather than as a text node; the
    // stub does not parse it, so it is read where it is actually written.
    const prose = withClass(result, 'prose');
    expect(prose).toHaveLength(1);
    expect(prose[0]?.innerHTML).toContain('Notes');
    // Routed through the real stage builder, not a second simpler path.
    expect(
      descendants(result).some((element) => element.className === 'doc')
    ).toBe(true);
    expect(withClass(result, 'diff-single')).toHaveLength(1);
  });

  test('a comparable pair is still compared rather than shown alone', () => {
    // The other half. A fix that rendered the single version unconditionally
    // would satisfy the test above and throw away the comparison.
    const current = view('code', 3, new TextEncoder().encode('b\n'));
    const historical = view('code', 2, new TextEncoder().encode('a\n'));

    const result = renderLoadedVersion(
      current,
      historical,
      2,
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    expect(textOf(result)).not.toContain('display differently');
    expect(
      descendants(result).some((element) =>
        element.className.split(' ').includes('diff-single')
      )
    ).toBe(false);
  });

  test('the rendered comparison renders both versions and shows neither as source', () => {
    const collector = 'https://collector.invalid/diff-probe';
    const historical = view(
      'sandboxed-html',
      2,
      encoder.encode(
        `<img src="${collector}"><script>fetch('${collector}')</script>`
      ),
      5
    );
    const current = view(
      'sandboxed-html',
      5,
      encoder.encode('<p>Current version</p>')
    );

    const comparison = renderRenderedComparison(
      current,
      historical,
      'rendered',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    // Two frames, because a rendered comparison needs two renders of
    // untrusted content and gets them from two frames rather than by
    // relaxing either frame's one-render guard.
    const frames = descendants(comparison).filter(
      (element) => element.tagName === 'IFRAME'
    );
    expect(frames).toHaveLength(2);
    expect(
      frames.every(
        (frame) => frame.attributes.get('sandbox') === 'allow-scripts'
      )
    ).toBe(true);

    // Source text is what this replaced. The markup of neither version is
    // printed on the service origin.
    expect(textOf(comparison)).not.toContain(collector);
    expect(textOf(comparison)).not.toContain('<script>');
    expect(textOf(comparison)).toContain('Rendered comparison');
  });

  test('the rendered comparison offers a swipe and a side by side layout', () => {
    const comparison = renderRenderedComparison(
      view('markdown', 5, encoder.encode('# After\n')),
      view('markdown', 2, encoder.encode('# Before\n'), 5),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    const stage = withClass(comparison, 'compare-stage')[0];
    if (stage === undefined) throw new Error('no comparison stage was built');
    // Prose is read, so markdown starts side by side; a page starts on the
    // swipe, where the question is whether the pixels moved.
    expect(stage.dataset['layout']).toBe('split');

    const layout = withClass(comparison, 'compare-layout')[0];
    if (layout === undefined) throw new Error('no layout control was built');
    expect(layout.children.map(textOf).join(' ')).toContain('Swipe');
    expect(layout.children.map(textOf).join(' ')).toContain('Side by side');

    const slider = descendants(comparison).find(
      (element) => element.type === 'range'
    );
    if (slider === undefined) throw new Error('no swipe control was built');
    expect(slider.attributes.get('aria-label')).toBe(
      'Reveal version 5 over version 2'
    );

    // Both panes name their version, so a swiped view is never ambiguous.
    expect(textOf(comparison)).toContain('Version 2');
    expect(textOf(comparison)).toContain('Version 5, current');
  });

  test('markdown compares rendered prose rather than building a frame', () => {
    const comparison = renderRenderedComparison(
      view('markdown', 5, encoder.encode('# After\n')),
      view('markdown', 2, encoder.encode('# Before\n'), 5),
      'markdown',
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;

    // Markdown renders on the service origin through the escaping renderer,
    // so both versions are ordinary DOM here and need no frame at all.
    expect(
      descendants(comparison).some((element) => element.tagName === 'IFRAME')
    ).toBe(false);
    expect(withClass(comparison, 'prose')).toHaveLength(2);
  });

  test('code keeps its line comparison, because for code the source is the view', () => {
    const comparison = renderCodeComparison(
      view('code', 5, encoder.encode('const answer = 42;\n')),
      view('code', 2, encoder.encode('const answer = 41;\n'), 5)
    ) as unknown as ElementStub;

    expect(textOf(comparison)).toContain('Code comparison');
    expect(withClass(comparison, 'diff-changes')).toHaveLength(1);
    expect(textOf(comparison)).toContain('42');
    expect(textOf(comparison)).toContain('41');
  });

  test('identical code says so rather than showing an empty comparison', () => {
    const same = encoder.encode('const answer = 42;\n');
    const comparison = renderCodeComparison(
      view('code', 5, same),
      view('code', 2, same.slice(), 5)
    ) as unknown as ElementStub;

    expect(withClass(comparison, 'diff-empty')).toHaveLength(1);
    expect(textOf(comparison)).toContain(
      'No changes. These versions have identical content.'
    );
    expect(withClass(comparison, 'diff-changes')).toHaveLength(0);
  });
});

describe('comment version scoping', () => {
  beforeEach(() => {
    const body = new ElementStub('BODY');
    (globalThis as { document?: unknown }).document = {
      body,
      documentElement: {
        style: {
          setProperty: () => {},
          getPropertyValue: () => '',
        },
      },
      createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_namespace: string, tag: string) =>
        new ElementStub(tag),
      addEventListener: () => {},
    };
    (globalThis as { window?: unknown }).window = {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

  function otioAnchor(relicVersion: number): OtioAnchorV1 {
    return {
      kind: 'otio',
      v: 1,
      relic_version: relicVersion,
      document_sha256: 'ab'.repeat(32),
      timeline_id: 'timeline',
      track_id: null,
      range: {
        start_time: { value: 12, rate: 24 },
        duration: { value: 0, rate: 24 },
      },
      snapshot: { timeline: 'Timeline', track: null, item: null },
    };
  }

  async function createCommentFixture() {
    const key = generateKey();
    const shareUrl = `https://relik.example/${RELIC_ID}#${encodeFragment(key)}`;
    const cipher = commentCipher(await deriveCommentKey(key));

    const records = [
      {
        comment_id: 'c-v1',
        author: 'alice@example.com',
        created_at: '2026-09-16T10:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'comment on version 1',
          display_name: null,
        }),
        version: 1,
      },
      {
        comment_id: 'c-v2',
        author: 'bob@example.com',
        created_at: '2026-09-16T11:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'comment on version 2',
          display_name: null,
        }),
        version: 2,
      },
      {
        comment_id: 'c-v3',
        author: 'carol@example.com',
        created_at: '2026-09-16T12:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'comment on version 3',
          display_name: null,
        }),
        version: 3,
      },
      {
        comment_id: 'c-unversioned',
        author: 'dan@example.com',
        created_at: '2026-09-16T09:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'comment without version',
          display_name: null,
        }),
        version: null,
      },
    ];

    function makeDeps(customRecords = records): ViewerDeps {
      return dummyDeps((async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/comments')) {
          return Response.json(customRecords);
        }
        if (url.includes('/api/auth/session')) {
          return Response.json({ email: null });
        }
        return new Response(new Uint8Array(0));
      }) as typeof globalThis.fetch);
    }

    return { key, shareUrl, records, makeDeps };
  }

  test('viewing v3 on a multi-version relic shows v3 comments but not v1 or unversioned comments', async () => {
    const { shareUrl, makeDeps } = await createCommentFixture();
    const readyView = view('code', 3, undefined, 3, shareUrl);
    let taskbarCount = -1;
    const thread = buildThread(readyView, RELIC_ID, makeDeps(), (count) => {
      taskbarCount = count;
    });
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;
    const renderedRows = withClass(threadElement, 'comment');
    const threadText = textOf(threadElement);

    // v3 comment shows
    expect(threadText).toContain('comment on version 3');

    // v1 comment does not show
    expect(threadText).not.toContain('comment on version 1');

    // unversioned comment does NOT show (this assertion catches the defect where unversioned showed on current version)
    expect(threadText).not.toContain('comment without version');
    expect(withClass(threadElement, 'comment-badge-unversioned')).toHaveLength(
      0
    );

    // rendered row count equals taskbar count
    expect(renderedRows.length).toBe(1);
    expect(taskbarCount).toBe(renderedRows.length);

    const bar = buildBar(readyView, RELIC_ID, {
      onComments: () => {},
      commentCount: taskbarCount,
    }) as unknown as ElementStub;
    const countSpan = withClass(bar, 'action-count')[0];
    expect(countSpan?.textContent).toBe(String(taskbarCount));
  });

  test('viewing v1 on a multi-version relic shows v1 comments and unversioned comments with badge', async () => {
    const { shareUrl, makeDeps } = await createCommentFixture();
    const readyView = view('code', 1, undefined, 3, shareUrl);
    let taskbarCount = -1;
    const thread = buildThread(readyView, RELIC_ID, makeDeps(), (count) => {
      taskbarCount = count;
    });
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;
    const renderedRows = withClass(threadElement, 'comment');
    const threadText = textOf(threadElement);

    // v1 comment shows
    expect(threadText).toContain('comment on version 1');

    // unversioned comment shows with the badge
    expect(threadText).toContain('comment without version');
    const badges = withClass(threadElement, 'comment-badge-unversioned');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe('Version unknown');
    expect(badges[0]?.attributes.get('title')).toBe('Predates versioning');

    // v2 and v3 comments do not show
    expect(threadText).not.toContain('comment on version 2');
    expect(threadText).not.toContain('comment on version 3');

    // rendered row count equals taskbar count
    expect(renderedRows.length).toBe(2);
    expect(taskbarCount).toBe(renderedRows.length);

    const bar = buildBar(readyView, RELIC_ID, {
      onComments: () => {},
      commentCount: taskbarCount,
    }) as unknown as ElementStub;
    const countSpan = withClass(bar, 'action-count')[0];
    expect(countSpan?.textContent).toBe(String(taskbarCount));
  });

  test('viewing v2 on a multi-version relic shows only v2 comments', async () => {
    const { shareUrl, makeDeps } = await createCommentFixture();
    const readyView = view('code', 2, undefined, 3, shareUrl);
    let taskbarCount = -1;
    const thread = buildThread(readyView, RELIC_ID, makeDeps(), (count) => {
      taskbarCount = count;
    });
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;
    const renderedRows = withClass(threadElement, 'comment');
    const threadText = textOf(threadElement);

    // only v2 comment shows
    expect(threadText).toContain('comment on version 2');
    expect(threadText).not.toContain('comment on version 1');
    expect(threadText).not.toContain('comment on version 3');
    expect(threadText).not.toContain('comment without version');
    expect(withClass(threadElement, 'comment-badge-unversioned')).toHaveLength(
      0
    );

    // rendered row count equals taskbar count
    expect(renderedRows.length).toBe(1);
    expect(taskbarCount).toBe(renderedRows.length);

    const bar = buildBar(readyView, RELIC_ID, {
      onComments: () => {},
      commentCount: taskbarCount,
    }) as unknown as ElementStub;
    const countSpan = withClass(bar, 'action-count')[0];
    expect(countSpan?.textContent).toBe(String(taskbarCount));
  });

  test('a relic with a single version shows unversioned comments', async () => {
    const { shareUrl, makeDeps } = await createCommentFixture();
    const readyView = view('code', 1, undefined, 1, shareUrl);
    let taskbarCount = -1;
    const thread = buildThread(readyView, RELIC_ID, makeDeps(), (count) => {
      taskbarCount = count;
    });
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;
    const renderedRows = withClass(threadElement, 'comment');
    const threadText = textOf(threadElement);

    // unversioned comment DOES show
    expect(threadText).toContain('comment without version');
    expect(withClass(threadElement, 'comment-badge-unversioned')).toHaveLength(
      1
    );

    // On a single-version relic, all comments show because no version dimension exists
    expect(threadText).toContain('comment on version 1');

    // rendered row count equals taskbar count
    expect(renderedRows.length).toBe(4);
    expect(taskbarCount).toBe(renderedRows.length);

    const bar = buildBar(readyView, RELIC_ID, {
      onComments: () => {},
      commentCount: taskbarCount,
    }) as unknown as ElementStub;
    const countSpan = withClass(bar, 'action-count')[0];
    expect(countSpan?.textContent).toBe(String(taskbarCount));
  });

  test('OTIO feedback binds sealed anchors to service-stamped revisions', async () => {
    const { key, shareUrl, makeDeps } = await createCommentFixture();
    const cipher = commentCipher(await deriveCommentKey(key));
    const records = [
      {
        comment_id: 'otio-matching',
        author: 'alice@example.com',
        created_at: '2026-09-16T10:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'matching historical OTIO feedback',
          display_name: null,
          anchor: otioAnchor(1),
        }),
        version: 1,
      },
      {
        comment_id: 'otio-mismatched',
        author: 'bob@example.com',
        created_at: '2026-09-16T11:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'mismatched OTIO feedback',
          display_name: null,
          anchor: otioAnchor(1),
        }),
        version: 2,
      },
    ];

    const v2Thread = buildThread(
      view('code', 2, undefined, 2, shareUrl),
      RELIC_ID,
      makeDeps(records),
      () => {}
    );
    await v2Thread.ready;
    const v2Element = v2Thread.element as unknown as ElementStub;
    expect(textOf(v2Element)).toContain('matching historical OTIO feedback');
    expect(textOf(v2Element)).toContain('mismatched OTIO feedback');
    expect(withClass(v2Element, 'otio-view-original')).toHaveLength(1);
    expect(
      withClass(v2Element, 'otio-feedback-projection').some(
        (context) => context.dataset['projectionStatus'] === 'unresolvable'
      )
    ).toBe(true);

    const v1Thread = buildThread(
      view('code', 1, undefined, 2, shareUrl),
      RELIC_ID,
      makeDeps(records),
      () => {}
    );
    await v1Thread.ready;
    const v1Element = v1Thread.element as unknown as ElementStub;
    expect(textOf(v1Element)).toContain('matching historical OTIO feedback');
    expect(textOf(v1Element)).not.toContain('mismatched OTIO feedback');
  });

  test('version scoping: a reply whose target is filtered out is not shown as an orphan', async () => {
    const { key, shareUrl, makeDeps } = await createCommentFixture();
    const cipher = commentCipher(await deriveCommentKey(key));

    const records = [
      {
        comment_id: 'c1',
        author: 'alice@example.com',
        created_at: '2026-09-16T10:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'comment on version 1',
          display_name: null,
          addresses: null,
        }),
        version: 1,
      },
      {
        comment_id: 'c2',
        author: 'bob@example.com',
        created_at: '2026-09-16T11:00:00.000Z',
        ciphertext: await cipher.seal({
          body: 'reply on version 2',
          display_name: null,
          addresses: 'c1',
        }),
        version: 2,
      },
    ];

    const deps = makeDeps(records);

    // 1. Viewing version 1:
    // Target comment c1 is shown. Reply c2 was written on v2, so c2 is filtered out.
    // Target comment c1 shows that it was addressed in version 2 by reply!
    const v1View = view('code', 1, undefined, 2, shareUrl);
    let v1Count = -1;
    const v1Thread = buildThread(v1View, RELIC_ID, deps, (count) => {
      v1Count = count;
    });
    await v1Thread.ready;

    const v1Element = v1Thread.element as unknown as ElementStub;
    expect(textOf(v1Element)).toContain('comment on version 1');
    expect(textOf(v1Element)).not.toContain('reply on version 2');
    expect(textOf(v1Element)).toContain('Addressed by reply in version 2');
    expect(v1Count).toBe(1);

    // 2. Viewing version 2:
    // Target comment c1 was on v1, so it is filtered out on v2.
    // Reply c2 belongs to v2, BUT its target is filtered out, so c2 must not show as an orphan!
    const v2View = view('code', 2, undefined, 2, shareUrl);
    let v2Count = -1;
    const v2Thread = buildThread(v2View, RELIC_ID, deps, (count) => {
      v2Count = count;
    });
    await v2Thread.ready;

    const v2Element = v2Thread.element as unknown as ElementStub;
    expect(textOf(v2Element)).not.toContain('comment on version 1');
    expect(textOf(v2Element)).not.toContain('reply on version 2');
    expect(v2Count).toBe(0);
    expect(textOf(v2Element)).toContain('No comments yet.');
  });
});
