/**
 * The owner-side pieces every private-share surface shares: the element
 * builder, the JSON request helper, the icons and the typed fingerprint
 * component.
 *
 * The component never compares a display string. What the person typed is
 * folded to the 32-character canonical form (section 4.2) and compared in
 * constant time with the fingerprint this browser computed from public keys.
 */

import {
  fingerprintsEqual,
  parseTypedFingerprint,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';

export type Attrs = Readonly<
  Record<string, string | boolean | null | undefined | ((event: Event) => void)>
>;
export type Child = Node | string | null | undefined | false;

/** Build an element. Booleans set or omit an attribute; a function named `onX` listens to `x`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === 'function') {
      element.addEventListener(name.slice(2), value);
    } else if (value === true) {
      element.setAttribute(name, '');
    } else {
      element.setAttribute(name, value);
    }
  }
  setChildren(element, ...children);
  return element;
}

/** Replace an element's children with the given nodes or text. */
export function setChildren(
  element: Element,
  ...children: readonly Child[]
): void {
  element.replaceChildren(
    ...children.flatMap((child) => {
      if (child === null || child === undefined || child === false) return [];
      return [
        typeof child === 'string' ? document.createTextNode(child) : child,
      ];
    })
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS: Readonly<
  Record<'check' | 'warn' | 'cross', readonly string[]>
> = {
  check: ['M3.5 8.5l3 3 6-6.5'],
  warn: ['M8 2.5l6 11H2z', 'M8 6.5v3', 'M8 11.6v.4'],
  cross: ['M4 4l8 8', 'M12 4l-8 8'],
};

/** A small inline icon. The paths are fixed here, never taken from input. */
export function icon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Disable a button while a passkey or a request is pending, and restore it
 * afterwards. Returns the restore function.
 */
export function waiting(
  button: HTMLButtonElement,
  label = 'Waiting for your passkey'
): () => void {
  const original = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('data-waiting', '');
  setChildren(button, label);
  return () => {
    button.disabled = false;
    button.removeAttribute('data-waiting');
    button.replaceChildren(...original);
  };
}

/** A non-2xx answer from the service. `code` is the problem code, never a key or a secret. */
export class PrivateApiError extends Error {
  override readonly name = 'PrivateApiError';

  constructor(
    readonly status: number,
    readonly code: string | undefined
  ) {
    super(code ?? `HTTP ${status}`);
  }
}

/** Call a private-share route on the service with the session cookie. */
export async function privateApi<T>(
  deps: ViewerDeps,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await deps.fetch(`${deps.serviceOrigin}${path}`, init);
  if (!response.ok) {
    let code: string | undefined;
    try {
      const problem = (await response.json()) as { code?: unknown };
      if (typeof problem.code === 'string') code = problem.code;
    } catch {
      code = undefined;
    }
    throw new PrivateApiError(response.status, code);
  }
  return (await response.json()) as T;
}

/** The sentence a refusal shows, by problem code. Unknown codes get a generic line. */
export function problemMessage(error: unknown): string {
  if (error instanceof PrivateApiError) {
    switch (error.code) {
      case 'fingerprint_mismatch':
        return 'The fingerprint does not match. Nothing was granted.';
      case 'grant_stale_version':
        return 'A newer version exists. Reload the panel and grant again.';
      case 'recipients_changed':
        return 'Who can read this relic changed while this ran. Try again.';
      case 'version_conflict':
        return 'The relic changed while this was in progress. Reload and try again.';
      case 'cannot_delete_current_version':
        return 'Delete the whole relic to remove its current version.';
      case 'identity_required':
        return 'Set up a private-share key first.';
      case 'owner_required':
        return 'Only the relic\u2019s owner can do that.';
      case 'request_limit_reached':
        return 'This relic has too many pending requests.';
      case 'private_rate_limited':
        return 'Too many private-share requests. Wait a few minutes and try again.';
      default:
        return `Relic could not finish that (${error.code ?? `HTTP ${error.status}`}).`;
    }
  }
  if (error instanceof Error && error.name === 'PrfUnavailableError') {
    return 'This passkey can\u2019t hold a private-share key.';
  }
  return 'Relic could not finish that.';
}

export type FingerprintState = 'empty' | 'mismatch' | 'match';

export interface TypedFingerprint {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  state(): FingerprintState;
  /** The folded 32-character value once it matches, otherwise undefined. */
  matched(): string | undefined;
  onChange(listener: (state: FingerprintState) => void): void;
  set(value: string): void;
}

export interface TypedFingerprintOptions {
  readonly id: string;
  readonly label: string;
  /** The `data-*` hook name on the input, for example `data-fingerprint-input`. */
  readonly inputHook: string;
  readonly placeholder: string;
  /** The locally computed fingerprint in canonical form (32 characters). */
  readonly expected: string;
  /** Who the fingerprint belongs to, for the status copy. */
  readonly who: string;
}

const NOT_IN_ALPHABET = /[^0-9a-z]/i;

/** The typed fingerprint component (mock `.fp-field`), wired to the local comparison. */
export function typedFingerprint(
  options: TypedFingerprintOptions
): TypedFingerprint {
  const input = h('input', {
    class: 'fp-input',
    id: options.id,
    [options.inputHook]: true,
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: options.placeholder,
    'aria-describedby': `${options.id}-status`,
  });
  const status = h('p', {
    class: 'fp-status',
    id: `${options.id}-status`,
    'aria-live': 'polite',
  });
  const echo = h('p', {
    class: 'fp-echo',
    'aria-hidden': 'true',
    hidden: true,
  });
  const element = h(
    'div',
    { class: 'fp-field', 'data-fingerprint-state': 'empty' },
    h('label', { class: 'field-label', for: options.id }, options.label),
    input,
    echo,
    status
  );
  let current: FingerprintState = 'empty';
  let folded: string | undefined;
  const listeners: Array<(state: FingerprintState) => void> = [];

  function update(): void {
    const raw = input.value;
    const cleaned = raw.replace(/[\s-]/g, '');
    const upper = cleaned
      .toUpperCase()
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0');
    const groups = upper.match(/.{1,4}/g) ?? [];
    setChildren(
      echo,
      ...groups.flatMap((group, index) => [
        index > 0 ? ' ' : null,
        h('span', { class: group.length < 4 ? 'is-short' : undefined }, group),
      ])
    );
    echo.hidden = cleaned.length === 0;
    element.removeAttribute('data-complete');
    folded = parseTypedFingerprint(raw);

    let state: FingerprintState;
    if (cleaned.length === 0) {
      state = 'empty';
      setChildren(
        status,
        '32 characters. Spaces and dashes don\u2019t matter.'
      );
    } else if (
      folded !== undefined &&
      fingerprintsEqual(folded, options.expected)
    ) {
      state = 'match';
      setChildren(
        status,
        icon('check'),
        h('span', {}, `Matches the fingerprint for ${options.who}.`)
      );
    } else {
      state = 'mismatch';
      const bad = NOT_IN_ALPHABET.test(cleaned) || /u/i.test(cleaned);
      if (cleaned.length >= 32 || bad) {
        element.setAttribute('data-complete', '');
        setChildren(
          status,
          icon('warn'),
          h(
            'span',
            {},
            bad
              ? 'That has a character fingerprints don\u2019t use. Check what you heard.'
              : `This isn\u2019t the fingerprint Relic computed for ${options.who}. Don\u2019t go on: check you\u2019re talking to the right person and have them read it again.`
          )
        );
      } else {
        setChildren(status, `${cleaned.length} of 32 characters.`);
      }
    }
    element.setAttribute('data-fingerprint-state', state);
    current = state;
    for (const listener of listeners) listener(state);
  }

  input.addEventListener('input', update);
  update();

  return {
    element,
    input,
    state: () => current,
    matched: () => (current === 'match' ? folded : undefined),
    onChange: (listener) => {
      listeners.push(listener);
    },
    set(value: string) {
      input.value = value;
      update();
    },
  };
}

/** A display fingerprint as one span per group, so the `.fingerprint` grid lays out its cells. */
export function fingerprintGroups(display: string): HTMLSpanElement[] {
  return display.split(' ').map((group) => h('span', {}, group));
}
