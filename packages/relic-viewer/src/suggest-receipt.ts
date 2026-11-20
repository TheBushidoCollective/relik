import type { SuggestReceipt } from './suggest-editor.ts';

/** A receipt owns only its DOM and undo callback, never the edited surface. */
export function suggestionReceipt(
  doc: Document,
  value: SuggestReceipt
): HTMLElement {
  const receipt = doc.createElement('section');
  receipt.className = 'sg-dock sg-receipt';
  receipt.setAttribute('role', 'status');
  receipt.setAttribute('aria-live', 'polite');
  receipt.setAttribute('aria-label', 'Suggestion receipt');
  const head = doc.createElement('div');
  head.className = 'rc-head';
  const title = doc.createElement('strong');
  title.textContent = 'Suggestion posted';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'rc-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('mousedown', (event) => event.preventDefault());
  close.addEventListener('click', () => receipt.remove());
  head.append(title, close);
  receipt.append(head);
  const body = doc.createElement('div');
  body.className = 'rc-body';
  for (const [label, textValue, tag, cls] of [
    ['Struck', value.struck, 'del', 'sg-del'],
    ['Inserted', value.inserted, 'ins', 'sg-ins'],
  ] as const) {
    if (!textValue) continue;
    const row = doc.createElement('div');
    row.className = 'card-row';
    const key = doc.createElement('span');
    key.className = 'k';
    key.textContent = label;
    const text = doc.createElement(tag);
    text.className = cls;
    text.textContent = textValue;
    row.append(key, text);
    body.append(row);
  }
  receipt.append(body);
  const tools = doc.createElement('div');
  tools.className = 'popover-tools';
  const undo = doc.createElement('button');
  undo.type = 'button';
  undo.className = 'popover-action';
  undo.textContent = 'Undo';
  undo.addEventListener('mousedown', (event) => event.preventDefault());
  undo.addEventListener('click', value.undo);
  tools.append(undo);
  receipt.append(tools);
  return receipt;
}
