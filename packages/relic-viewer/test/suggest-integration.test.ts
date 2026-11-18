import { afterEach, describe, expect, test } from 'bun:test';
import type { CommentPlaintext } from '@relic/format';
import { openEntry, type CommentCipher } from '../src/comments.ts';
import { commentRow } from '../src/main.ts';
import { selectionOffer } from '../src/popover.ts';

class ElementStub {
  className = '';
  textContent = '';
  innerHTML = '';
  type = '';
  disabled = false;
  dataset: Record<string, string> = {};
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  handlers = new Map<string, (event: { preventDefault(): void }) => void>();
  classList = {
    add: (name: string) => {
      this.className += ` ${name}`;
    },
  };
  constructor(readonly tagName: string) {}
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
  addEventListener(
    type: string,
    handler: (event: { preventDefault(): void }) => void
  ): void {
    this.handlers.set(type, handler);
  }
  click(): void {
    this.handlers.get('click')?.({ preventDefault() {} });
  }
}

function installDom(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new ElementStub(tag),
  };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

const payload: CommentPlaintext = {
  body: '<script>fallback</script>',
  display_name: 'Reader',
  anchor: { kind: 'source', exact: 'before' },
  suggestion: { v: 1, mode: 'replace', replacement: '<img src=x>' },
};

const record = {
  comment_id: 'one',
  author: 'reader@example.test',
  created_at: '2026-01-01T00:00:00Z',
  ciphertext: 'sealed',
  version: 1,
};

function cipher(value: CommentPlaintext): CommentCipher {
  return { seal: async () => 'sealed', open: async () => value };
}

describe('suggestion integration', () => {
  test('retains sealed suggestion, outcome and reply address on opened rows', async () => {
    const suggestion = await openEntry(record, cipher(payload));
    expect(suggestion.kind).toBe('open');
    if (suggestion.kind !== 'open') return;
    expect(suggestion.suggestion).toEqual(payload.suggestion);
    const outcome = await openEntry(
      { ...record, comment_id: 'two', author: 'publisher', version: 2 },
      cipher({
        body: 'Applied',
        display_name: null,
        addresses: 'one',
        suggestion_outcome: 'accepted',
      })
    );
    expect(outcome.kind).toBe('open');
    if (outcome.kind !== 'open') return;
    expect(outcome.addresses).toBe('one');
    expect(outcome.suggestion_outcome).toBe('accepted');
  });

  test('suggestion rows do not render fallback as markdown or mark a reader reply as a settlement', async () => {
    installDom();
    const entry = await openEntry(record, cipher(payload));
    const row = commentRow(entry, false, {
      kind: 'reply',
      version: 1,
    }) as unknown as ElementStub;
    const body = row.children.find(
      (child) => child.className === 'comment-body'
    );
    expect(body?.innerHTML).toBe('');
    expect(body?.textContent).toBe(
      'This passage cannot be found in this version.'
    );
    expect(
      row.children[0]?.children.some((child) =>
        child.className.includes('comment-badge-addressed')
      )
    ).toBe(false);
  });

  test('selection offers Suggest edit, while applied selections offer Reply and Copy only', () => {
    installDom();
    let suggested = 0;
    let replied = 0;
    const base = {
      text: 'words',
      canCopy: true,
      onCopy() {},
      onComment() {},
      onCancel() {},
    };
    const normal = selectionOffer({
      ...base,
      onSuggest: () => {
        suggested++;
      },
    }) as unknown as ElementStub;
    expect(normal.children.map((child) => child.textContent)).toEqual([
      'Copy text',
      'Comment',
      'Suggest edit',
      '×',
    ]);
    normal.children[2]?.click();
    expect(suggested).toBe(1);
    const applied = selectionOffer({
      ...base,
      allowComment: false,
      onReply: () => {
        replied++;
      },
      reason: 'Read-only view',
    }) as unknown as ElementStub;
    expect(applied.children.map((child) => child.textContent)).toEqual([
      'Copy text',
      'Reply',
      'Read-only view',
      '×',
    ]);
    applied.children[1]?.click();
    expect(replied).toBe(1);
  });
});
