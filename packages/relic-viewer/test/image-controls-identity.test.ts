import { describe, expect, test } from 'bun:test';
import { docxImageSourceDigest } from '@relic/format/image-identity';
import { createHash } from 'node:crypto';
import {
  createImageIdentitySource,
  setupFrameInteraction,
  type ImageIdentitySource,
} from '../src/sandbox.ts';

class ElementStub {
  readonly nodeType: number;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = { setProperty() {} };
  readonly childNodes: ElementStub[] = [];
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) =>
      names.forEach((name) => {
        this.classes.add(name);
      }),
    remove: (...names: string[]) =>
      names.forEach((name) => {
        this.classes.delete(name);
      }),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const present = force ?? !this.classes.has(name);
      if (present) this.classes.add(name);
      else this.classes.delete(name);
      return present;
    },
  };
  parentNode: ElementStub | null = null;
  hidden = false;
  complete = true;
  naturalWidth = 100;
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  clientHeight = 0;
  clientLeft = 0;
  clientTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  type = '';
  id = '';
  textContent = '';

  constructor(tag: string, nodeType = 1) {
    this.tagName = tag.toUpperCase();
    this.nodeType = nodeType;
  }

  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/)) if (name) this.classes.add(name);
  }
  get parentElement(): ElementStub | null {
    return this.parentNode;
  }
  get children(): ElementStub[] {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
  get isConnected(): boolean {
    return this.tagName === 'HTML' || this.parentNode !== null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  appendChild(child: ElementStub): ElementStub {
    child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: ElementStub, before: ElementStub | null): ElementStub {
    child.remove();
    const index = before ? this.childNodes.indexOf(before) : -1;
    child.parentNode = this;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }
  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }
  querySelectorAll(selector: string): ElementStub[] {
    const result: ElementStub[] = [];
    const visit = (node: ElementStub): void => {
      for (const child of node.children) {
        if (
          (selector === 'img' && child.tagName === 'IMG') ||
          (selector.startsWith('.') && child.classes.has(selector.slice(1)))
        )
          result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  } {
    const number = (value: unknown, fallback = 0): number =>
      Number.parseFloat(String(value ?? '')) || fallback;
    const parent = this.parentNode;
    const parentBox = parent?.getBoundingClientRect();
    const button = this.tagName === 'BUTTON' && parent !== null;
    const left = button
      ? (parentBox?.left ?? 0) + 6 + 38 * parent.children.indexOf(this)
      : number(this.style.left);
    const top = button ? (parentBox?.top ?? 0) + 6 : number(this.style.top);
    const width = button ? 28 : number(this.style.width);
    const height = button ? 28 : number(this.style.height, 40);
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
  getClientRects(): ReturnType<ElementStub['getBoundingClientRect']>[] {
    return [this.getBoundingClientRect()];
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  scrollIntoView(): void {}
}

function fixture(identity?: ImageIdentitySource) {
  const root = new ElementStub('html');
  const head = root.appendChild(new ElementStub('head'));
  const body = root.appendChild(new ElementStub('body'));
  const frames: Array<() => void> = [];
  const messages: Array<Record<string, unknown>> = [];
  const inputs: string[] = [];
  const doc = {
    nodeType: 0,
    documentElement: root,
    head,
    body,
    defaultView: { parent: { postMessage() {} } },
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
    createComment: () => new ElementStub('#comment', 8),
    getElementById: (id: string) =>
      head.children.find((child) => child.id === id) ?? null,
    addEventListener() {},
    removeEventListener() {},
  };
  const win = {
    crypto: {
      subtle: {
        digest(_algorithm: string, bytes: Uint8Array) {
          inputs.push(new TextDecoder().decode(bytes));
          return Promise.resolve(
            Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer
          );
        },
      },
    },
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      overflowX: 'visible',
      overflowY: 'visible',
    }),
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const interaction = setupFrameInteraction(
    doc as unknown as Document,
    win as unknown as Window,
    (message) => messages.push(message as Record<string, unknown>),
    true,
    identity
  );
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      for (const callback of frames.splice(0)) callback();
      await Promise.resolve();
    }
  };
  const addImage = (src: string, parent = body): ElementStub => {
    const img = parent.appendChild(new ElementStub('img'));
    img.setAttribute('src', src);
    Object.assign(img.style, {
      left: '20',
      top: '30',
      width: '100',
      height: '80',
    });
    return img;
  };
  return { root, body, interaction, messages, inputs, flush, addImage };
}

const imageMark = (digest: string, path = [{ tag: 'img', index: 0 }]) => ({
  id: 'comment',
  kind: 'image' as const,
  path,
  source_sha256: digest,
  requestId: 1,
});

describe('document image controls', () => {
  test('wait for seal and hashing before placing a saved image mark', async () => {
    const content = new TextEncoder().encode('image bytes');
    const savedDigest = await docxImageSourceDigest(
      'word/media/a.png',
      content
    );
    const previous = createImageIdentitySource();
    previous.hooks.registerImageIdentities(
      new Map([['blob:null/frame-one', Promise.resolve(savedDigest)]])
    );
    previous.seal();
    const previousImage = new ElementStub('img');
    previousImage.setAttribute('src', 'blob:null/frame-one');
    const saved = await previous.source.digest(
      previousImage as unknown as HTMLImageElement
    );
    const identity = createImageIdentitySource();
    const pending = Promise.withResolvers<string>();
    const f = fixture(identity.source);
    const url = 'blob:null/frame-two';
    f.addImage(url);
    f.interaction.onPaintMark(imageMark(saved));
    await f.flush();
    expect(f.root.querySelectorAll('.relic-image-control')).toHaveLength(0);
    expect(f.messages).toEqual([]);
    identity.hooks.registerImageIdentities(new Map([[url, pending.promise]]));
    identity.seal();
    await f.flush();
    expect(f.root.querySelectorAll('.relic-image-control')).toHaveLength(0);
    expect(f.messages).toEqual([]);
    pending.resolve(await docxImageSourceDigest('word/media/a.png', content));
    await f.flush();
    expect(f.root.querySelectorAll('.relic-image-control')).toHaveLength(1);
    expect(f.messages.some((message) => message.status === 'placed')).toBe(
      true
    );
    f.interaction.dispose();
  });

  test('a different image digest is unavailable and a broken image has no control', async () => {
    const identity = createImageIdentitySource();
    const f = fixture(identity.source);
    const img = f.addImage('blob:null/changed');
    identity.hooks.registerImageIdentities(
      new Map([['blob:null/changed', Promise.resolve('b'.repeat(64))]])
    );
    identity.seal();
    f.interaction.onPaintMark(imageMark('a'.repeat(64)));
    await f.flush();
    expect(f.messages.some((message) => message.status === 'unavailable')).toBe(
      true
    );
    expect(f.messages.some((message) => message.status === 'placed')).toBe(
      false
    );
    img.naturalWidth = 0;
    f.interaction.onFrameVisibility?.(true);
    await f.flush();
    expect(f.root.querySelectorAll('.relic-image-control')).toHaveLength(0);
    f.interaction.dispose();
  });

  test('a changed source cannot reuse a digest still being computed', async () => {
    const identity = createImageIdentitySource();
    const pending = Promise.withResolvers<string>();
    const f = fixture(identity.source);
    const img = f.addImage('blob:null/first');
    identity.hooks.registerImageIdentities(
      new Map([['blob:null/first', pending.promise]])
    );
    identity.seal();
    f.interaction.onPaintMark(imageMark('a'.repeat(64)));
    await f.flush();
    img.setAttribute('src', 'blob:null/second');
    f.interaction.onFrameVisibility?.(true);
    pending.resolve('a'.repeat(64));
    await f.flush();
    expect(f.root.querySelectorAll('.relic-image-control')).toHaveLength(0);
    expect(f.messages.some((message) => message.status === 'placed')).toBe(
      false
    );
    expect(f.messages.some((message) => message.status === 'unavailable')).toBe(
      true
    );
    f.interaction.dispose();
  });

  test('does not place or create controls after disposal while hashing', async () => {
    const identity = createImageIdentitySource();
    const pending = Promise.withResolvers<string>();
    const f = fixture(identity.source);
    f.addImage('blob:null/image');
    identity.hooks.registerImageIdentities(
      new Map([['blob:null/image', pending.promise]])
    );
    identity.seal();
    f.interaction.onPaintMark(imageMark('a'.repeat(64)));
    await f.flush();
    f.interaction.dispose();
    pending.resolve('a'.repeat(64));
    await f.flush();
    expect(f.root.querySelectorAll('.relic-image-control')).toHaveLength(0);
    expect(f.messages).toEqual([]);
  });

  test('HTML retains its source-declaration fingerprint including picture sources', async () => {
    const f = fixture();
    const picture = f.body.appendChild(new ElementStub('picture'));
    const alternate = picture.appendChild(new ElementStub('source'));
    alternate.setAttribute('srcset', 'wide.png 2x');
    alternate.setAttribute('media', '(min-width: 600px)');
    alternate.setAttribute('type', 'image/png');
    const img = f.addImage('photo.png', picture);
    img.setAttribute('srcset', 'photo-large.png 2x');
    img.setAttribute('sizes', '100vw');
    const declaration = JSON.stringify([
      'photo.png',
      'photo-large.png 2x',
      '100vw',
      [['wide.png 2x', null, '(min-width: 600px)', 'image/png']],
    ]);
    const digest = createHash('sha256').update(declaration).digest('hex');
    f.interaction.onPaintMark(
      imageMark(digest, [
        { tag: 'picture', index: 0 },
        { tag: 'img', index: 0 },
      ])
    );
    await f.flush();
    expect(f.inputs).toContain(declaration);
    expect(f.messages.some((message) => message.status === 'placed')).toBe(
      true
    );
    f.interaction.dispose();
  });
});
