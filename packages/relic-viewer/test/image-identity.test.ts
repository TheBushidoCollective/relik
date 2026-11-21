import { describe, expect, test } from 'bun:test';
import { docxImageSourceDigest } from '@relic/format/image-identity';
import {
  createImageIdentitySource,
  mountDocument,
  type FrameInteraction,
  type ImageIdentitySource,
} from '../src/sandbox.ts';

function image(
  attributes: Record<string, string>,
  parentElement: object | null = null
): HTMLImageElement {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => Object.hasOwn(attributes, name),
    parentElement,
  } as unknown as HTMLImageElement;
}

describe('document image identity source', () => {
  test('settles on seal once and does not wait for image hashing', async () => {
    const identity = createImageIdentitySource();
    const pending = Promise.withResolvers<string>();
    const url = 'blob:null/first';
    identity.hooks.registerImageIdentities(new Map([[url, pending.promise]]));
    let seals = 0;
    let resolved = false;
    void identity.source.settled.then(() => seals++);
    const digest = identity.source.digest(image({ src: url })).then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(seals).toBe(0);
    expect(resolved).toBe(false);

    identity.seal();
    identity.seal();
    await identity.source.settled;
    await Promise.resolve();
    expect(seals).toBe(1);
    expect(resolved).toBe(false);
    pending.resolve('a'.repeat(64));
    expect(await digest).toBe('a'.repeat(64));
  });

  test('copies the first registration and ignores later registrations', async () => {
    const identity = createImageIdentitySource();
    const original = new Map([
      ['blob:null/first', Promise.resolve('a'.repeat(64))],
    ]);
    identity.hooks.registerImageIdentities(original);
    original.clear();
    identity.hooks.registerImageIdentities(
      new Map([['blob:null/first', Promise.resolve('b'.repeat(64))]])
    );
    identity.seal();
    identity.hooks.registerImageIdentities(
      new Map([['blob:null/second', Promise.resolve('c'.repeat(64))]])
    );
    expect(
      await identity.source.digest(image({ src: 'blob:null/first' }))
    ).toBe('a'.repeat(64));
    await expect(
      identity.source.digest(image({ src: 'blob:null/second' }))
    ).rejects.toThrow();
  });

  test('the same part and bytes match across different frame URLs', async () => {
    const bytes = new TextEncoder().encode('image bytes');
    const first = createImageIdentitySource();
    const next = createImageIdentitySource();
    first.hooks.registerImageIdentities(
      new Map([
        [
          'blob:null/frame-one',
          docxImageSourceDigest('word/media/a.png', bytes),
        ],
      ])
    );
    next.hooks.registerImageIdentities(
      new Map([
        [
          'blob:null/frame-two',
          docxImageSourceDigest('word/media/a.png', bytes),
        ],
        [
          'blob:null/other-part',
          docxImageSourceDigest('word/media/b.png', bytes),
        ],
        [
          'blob:null/other-image',
          docxImageSourceDigest('word/media/a.png', new Uint8Array([1, 2, 3])),
        ],
      ])
    );
    first.seal();
    next.seal();
    const saved = await first.source.digest(
      image({ src: 'blob:null/frame-one' })
    );
    expect(
      await next.source.digest(image({ src: 'blob:null/frame-two' }))
    ).toBe(saved);
    expect(
      await next.source.digest(image({ src: 'blob:null/other-part' }))
    ).not.toBe(saved);
    expect(
      await next.source.digest(image({ src: 'blob:null/other-image' }))
    ).not.toBe(saved);
  });

  test('requires a registered blob, a valid digest and a single image source', async () => {
    const identity = createImageIdentitySource();
    identity.hooks.registerImageIdentities(
      new Map([
        ['blob:null/image', Promise.resolve('a'.repeat(64))],
        ['blob:null/bad-digest', Promise.resolve('invalid')],
      ])
    );
    identity.seal();
    for (const img of [
      image({ src: 'blob:null/missing' }),
      image({ src: 'data:image/png;base64,AA==' }),
      image({ src: 'blob:null/bad-digest' }),
      image({ src: 'blob:null/image', srcset: 'blob:null/another 2x' }),
      image({ src: 'blob:null/image', sizes: '100vw' }),
      image(
        { src: 'blob:null/image' },
        {
          tagName: 'PICTURE',
          children: [{ tagName: 'SOURCE' }],
        }
      ),
    ]) {
      await expect(identity.source.digest(img)).rejects.toThrow();
    }
  });
});

describe('document mount image identity', () => {
  test('seals before reporting success or failure without waiting for digests', async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'document'
    );
    const windowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window'
    );
    const stateDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__imageIdentityTest'
    );
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const pending = Promise.withResolvers<string>();
    const events: string[] = [];
    const messages: unknown[] = [];
    const interactionCalls: boolean[] = [];
    const interaction = {
      requestExternalLink() {},
    } as unknown as FrameInteraction;
    let source: ImageIdentitySource | undefined;
    const registeredSources: ImageIdentitySource[] = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({}), body: { replaceChildren() {} } },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        parent: {
          postMessage(message: unknown) {
            messages.push(message);
            queueMicrotask(() => events.push('state delivered'));
          },
        },
      },
    });
    Object.defineProperty(globalThis, '__imageIdentityTest', {
      configurable: true,
      value: {
        digest: pending.promise,
        requestExternalLink: interaction.requestExternalLink,
      },
    });
    URL.revokeObjectURL = () => {};
    try {
      for (const [renderer, expected] of [
        [
          `export function render(root, input, hooks) {
            if (input.requestExternalLink !== globalThis.__imageIdentityTest.requestExternalLink)
              throw new Error("missing link callback");
            hooks.registerImageIdentities(new Map([["blob:null/image", globalThis.__imageIdentityTest.digest]]));
            return { state: "ready" };
          }`,
          { type: 'relic:document-state', state: 'ready' },
        ],
        [
          'export function render() { return { state: "failed", reason: "too-large" }; }',
          {
            type: 'relic:document-state',
            state: 'failed',
            reason: 'too-large',
          },
        ],
        [
          'export function render() { throw new Error("failed"); }',
          { type: 'relic:document-state', state: 'failed', reason: 'corrupt' },
        ],
      ] as const) {
        events.length = 0;
        interactionCalls.length = 0;
        URL.createObjectURL = () =>
          `data:text/javascript;base64,${Buffer.from(renderer).toString('base64')}`;
        await mountDocument(
          {
            type: 'relic:render-document',
            format: 'docx',
            module: renderer,
            entries: [],
          },
          (enabled, received) => {
            interactionCalls.push(enabled);
            source = received;
            if (expected.state === 'ready' && received)
              registeredSources.push(received);
            void source?.settled.then(() => events.push('sealed'));
            return interaction;
          }
        );
        expect(interactionCalls).toEqual([true]);
        expect(messages.pop()).toEqual(expected);
        expect(source).toBeDefined();
        expect(events).toEqual(['sealed', 'state delivered']);
      }
      events.length = 0;
      interactionCalls.length = 0;
      const epubRenderer = `export function render(root, input, hooks) {
        if (hooks !== undefined) throw new Error("unexpected hooks");
        if (input.requestExternalLink !== globalThis.__imageIdentityTest.requestExternalLink)
          throw new Error("missing link callback");
        return { state: "ready" };
      }`;
      URL.createObjectURL = () =>
        `data:text/javascript;base64,${Buffer.from(epubRenderer).toString('base64')}`;
      await mountDocument(
        {
          type: 'relic:render-document',
          format: 'epub',
          module: epubRenderer,
          entries: [],
        },
        (enabled, received) => {
          interactionCalls.push(enabled);
          source = received;
          return interaction;
        }
      );
      expect(interactionCalls).toEqual([true]);
      expect(source).toBeUndefined();
      expect(messages.pop()).toEqual({
        type: 'relic:document-state',
        state: 'ready',
      });
      expect(events).toEqual(['state delivered']);
      pending.resolve('a'.repeat(64));
      expect(
        await registeredSources[0]?.digest(image({ src: 'blob:null/image' }))
      ).toBe('a'.repeat(64));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      if (documentDescriptor)
        Object.defineProperty(globalThis, 'document', documentDescriptor);
      else Reflect.deleteProperty(globalThis, 'document');
      if (windowDescriptor)
        Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
      if (stateDescriptor)
        Object.defineProperty(
          globalThis,
          '__imageIdentityTest',
          stateDescriptor
        );
      else Reflect.deleteProperty(globalThis, '__imageIdentityTest');
    }
  });
});
