import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { RelicSettingsJSON } from '@relic/format/private';
import type { AttestRequest, StatementDraft } from '../src/private/keys.ts';
import { openSettingsPanel } from '../src/private/settings-panel.ts';

class Element {
  children: Element[] = [];
  childNodes: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  value = '';
  checked = false;
  hidden = false;
  disabled = false;
  textContent = '';
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'value') this.value = value;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(
    name: string,
    fn: (event: { preventDefault(): void }) => void
  ): void {
    this.listeners.set(name, fn);
  }
  replaceChildren(...children: Element[]): void {
    this.children = children;
    this.childNodes = children;
  }
  append(...children: Element[]): void {
    this.children.push(...children);
    this.childNodes = this.children;
  }
  remove(): void {}
  focus(): void {}
  querySelector(selector: string): Element | null {
    if (
      selector === this.tagName ||
      selector === `#${this.attributes.get('id')}`
    )
      return this;
    for (const child of this.children) {
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
  all(tag: string): Element[] {
    return [
      ...(this.tagName === tag ? [this] : []),
      ...this.children.flatMap((child) => child.all?.(tag) ?? []),
    ];
  }
  dispatch(name: string): void {
    this.listeners.get(name)?.({ preventDefault() {} });
  }
}
const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
const settings: RelicSettingsJSON = {
  suggestions: true,
  comments: false,
  decisions: false,
  signing: true,
  notifications: true,
  changed_at: null,
  changed_by: null,
  expires_at: null,
};
let body: Element;
beforeEach(() => {
  body = new Element('body');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body,
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => {
        const node = new Element('#text');
        node.textContent = text;
        return node;
      },
    },
  });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'document', original);
  else Reflect.deleteProperty(globalThis, 'document');
});

for (const lifetime of ['keep', 'never', 'days'] as const) {
  test(`settings save signs one ${lifetime} snapshot`, async () => {
    let sent:
      | { attestation: { statements: readonly StatementDraft[] } }
      | undefined;
    let drafts: readonly StatementDraft[] = [];
    let taps = 0;
    let saved = false;
    const deps = {
      serviceOrigin: 'https://example.test',
      now: () => 123,
      privateKeys: {
        attest: async (_: unknown, request: AttestRequest) => {
          taps++;
          drafts = request.build('owner');
          return { bundle: { nonce: 'n', statements: drafts, credential: {} } };
        },
      },
      fetch: async (_: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return Response.json({ settings });
      },
    };
    const panel = openSettingsPanel({
      relicId: 'id',
      private: false,
      settings,
      deps: deps as never,
      onSaved: () => {
        saved = true;
      },
    }) as unknown as Element;
    const mode = panel.all('select')[0]!;
    mode.value = lifetime;
    const days = panel
      .all('input')
      .find((node) => node.attributes.get('type') === 'number')!;
    days.value = '42';
    panel.querySelector('form')!.dispatch('submit');
    for (let i = 0; i < 20 && !saved; i++) await Promise.resolve();
    expect(taps).toBe(1);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: 'relic_settings',
      statement: {
        at: 123,
        relic_id: 'id',
        owner_identity_id: 'owner',
        suggestions: true,
        comments: false,
        decisions: false,
        signing: true,
        notifications: true,
        lifetime: lifetime === 'days' ? 42 : lifetime,
      },
    });
    expect(sent?.attestation.statements).toEqual(drafts);
    expect(saved).toBe(true);
  });
}
test('server refusal is shown in plain words', async () => {
  const deps = {
    serviceOrigin: 'https://example.test',
    privateKeys: {
      attest: async () => ({
        bundle: { nonce: 'n', statements: [], credential: {} },
      }),
    },
    fetch: async () =>
      Response.json({ code: 'owner_required' }, { status: 403 }),
  };
  const panel = openSettingsPanel({
    relicId: 'id',
    private: false,
    settings,
    deps: deps as never,
    onSaved: () => {
      throw new Error('refusal was treated as a save');
    },
  }) as unknown as Element;
  panel.querySelector('form')!.dispatch('submit');
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(
    panel.all('p').some((node) => node.textContent.includes('Only the relik'))
  ).toBe(true);
});

test('private lifetime refuses a value beyond its limit before attesting', () => {
  let taps = 0;
  const deps = {
    privateKeys: {
      attest: () => {
        taps++;
      },
    },
  };
  const panel = openSettingsPanel({
    relicId: 'id',
    private: true,
    settings,
    deps: deps as never,
    onSaved: () => {},
  }) as unknown as Element;
  expect(panel.all('option').some((node) => node.value === 'never')).toBe(
    false
  );
  panel.all('select')[0]!.value = 'days';
  const days = panel
    .all('input')
    .find((node) => node.attributes.get('type') === 'number')!;
  expect(days.attributes.get('max')).toBe('365');
  days.value = '366';
  panel.querySelector('form')!.dispatch('submit');
  expect(taps).toBe(0);
  expect(
    panel.all('p').some((node) => node.textContent.includes('1 to 365'))
  ).toBe(true);
});
