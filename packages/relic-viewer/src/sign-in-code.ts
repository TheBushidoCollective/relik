import { plainLabel } from './comments.ts';
import type { ViewerDeps } from './viewer.ts';

export const SIGN_IN_CODE_LENGTH = 6;

export type SignInCodeResult =
  | { readonly kind: 'verified'; readonly email: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds?: number }
  | { readonly kind: 'failed' };

/** ASCII digits only, first six. "123 456" and "123-456" become "123456". */
export function normalizeSignInCode(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, SIGN_IN_CODE_LENGTH);
}

/**
 * POST `${serviceOrigin}/api/auth/code`, JSON {"code"}. Sends no address, no relic id, never the fragment.
 * 200 with a non-empty email -> verified; 401 -> rejected; 429 -> rate_limited (body retry_after_seconds, else Retry-After); else or throw -> failed.
 */
export async function submitSignInCode(
  code: string,
  deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>
): Promise<SignInCodeResult> {
  try {
    const res = await deps.fetch(`${deps.serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (res.status === 200) {
      try {
        const body: unknown = await res.json();
        if (
          body !== null &&
          typeof body === 'object' &&
          'email' in body &&
          typeof body.email === 'string' &&
          body.email.length > 0
        ) {
          return { kind: 'verified', email: body.email };
        }
      } catch {
        return { kind: 'failed' };
      }
      return { kind: 'failed' };
    }

    if (res.status === 401) {
      return { kind: 'rejected' };
    }

    if (res.status === 429) {
      let retryAfterSeconds: number | undefined;
      try {
        const body: unknown = await res.json();
        if (
          body !== null &&
          typeof body === 'object' &&
          'retry_after_seconds' in body &&
          typeof body.retry_after_seconds === 'number'
        ) {
          retryAfterSeconds = body.retry_after_seconds;
        }
      } catch {
        // Fall back to header
      }
      if (retryAfterSeconds === undefined && res.headers) {
        const header =
          res.headers.get('retry-after') ?? res.headers.get('Retry-After');
        if (header) {
          const parsed = parseInt(header, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            retryAfterSeconds = parsed;
          }
        }
      }
      return {
        kind: 'rate_limited',
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    }

    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export interface SignInCodeEntryOptions {
  readonly deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>;
  /** Runs once, after the session cookie is set. */
  readonly onVerified: (email: string) => void;
  /** Focus the field in a microtask after creation (callers append synchronously). */
  readonly focus?: boolean;
}

/** Moved verbatim from main.ts:3288-3294. */
export function announceVerified(): void {
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('relic:auth');
    channel.postMessage('verified');
    channel.close();
  }
}

export const SIGN_IN_CODE_LABEL = 'Code from the email';
export const SIGN_IN_CODE_SUBMIT = 'Sign in';
export const SIGN_IN_CODE_CHECKING = 'Checking the code.';
export const SIGN_IN_CODE_REJECTED =
  'That code did not work. Check it against the newest email from Relic, and type it in the browser that asked for it.';
export const SIGN_IN_CODE_REJECTED_AGAIN =
  'That code still did not work. A code works once, only in the browser that asked for it, and stops working after a newer email or too many wrong tries. Open the link in the email instead, or send a new one.';
export const SIGN_IN_CODE_FAILED =
  'The code could not be checked, which is a network problem rather than a wrong code. Try again.';

export function signInCodeRateLimitedCopy(retryAfterSeconds?: number): string {
  if (retryAfterSeconds === undefined) {
    return 'Too many codes tried from here. Wait a few minutes, or open the link in the email.';
  }
  const m = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many codes tried from here. Wait about ${m} minute${m === 1 ? '' : 's'}, or open the link in the email.`;
}

export function signedInCopy(email: string): string {
  return `Signed in as ${plainLabel(email)}.`;
}

let counter = 0;

export function signInCodeEntry(options: SignInCodeEntryOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'sign-in-code';
  root.setAttribute('data-sign-in-code', '');
  root.setAttribute('data-state', 'idle');

  const label = document.createElement('label');
  label.className = 'compose-field sign-in-code-field';

  const labelSpan = document.createElement('span');
  labelSpan.textContent = SIGN_IN_CODE_LABEL;
  label.appendChild(labelSpan);

  const statusId = `sign-in-code-status-${++counter}`;

  const input = document.createElement('input');
  input.className = 'compose-input sign-in-code-input';
  input.setAttribute('data-sign-in-code-input', '');
  input.type = 'text';
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('autocomplete', 'one-time-code');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'go');
  input.setAttribute('aria-describedby', statusId);
  label.appendChild(input);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action primary sign-in-code-submit';
  button.setAttribute('data-sign-in-code-submit', '');
  button.disabled = true;
  button.textContent = SIGN_IN_CODE_SUBMIT;

  const statusEl = document.createElement('p');
  statusEl.className = 'sign-in-code-status';
  statusEl.setAttribute('data-sign-in-code-status', '');
  statusEl.id = statusId;
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  root.appendChild(label);
  root.appendChild(button);
  root.appendChild(statusEl);

  let isChecking = false;
  let lastSubmitted = '';
  let rejectionCount = 0;
  let verified = false;

  async function submit(codeToSubmit: string): Promise<void> {
    if (isChecking || verified) return;
    isChecking = true;
    lastSubmitted = codeToSubmit;
    root.setAttribute('data-state', 'checking');
    statusEl.textContent = SIGN_IN_CODE_CHECKING;
    input.disabled = true;
    button.disabled = true;

    const result = await submitSignInCode(codeToSubmit, options.deps);
    isChecking = false;

    if (result.kind === 'verified') {
      verified = true;
      root.setAttribute('data-state', 'verified');
      statusEl.textContent = signedInCopy(result.email);
      input.disabled = true;
      button.disabled = true;
      options.onVerified(result.email);
      return;
    }

    input.disabled = false;
    button.disabled =
      normalizeSignInCode(input.value).length !== SIGN_IN_CODE_LENGTH;

    if (result.kind === 'rejected') {
      rejectionCount++;
      root.setAttribute('data-state', 'rejected');
      statusEl.textContent =
        rejectionCount >= 3
          ? SIGN_IN_CODE_REJECTED_AGAIN
          : SIGN_IN_CODE_REJECTED;
      if (typeof input.select === 'function') {
        input.select();
      }
      return;
    }

    if (result.kind === 'rate_limited') {
      root.setAttribute('data-state', 'rate-limited');
      statusEl.textContent = signInCodeRateLimitedCopy(
        result.retryAfterSeconds
      );
      if (typeof input.select === 'function') {
        input.select();
      }
      return;
    }

    // result.kind === 'failed'. The field was disabled while checking, which
    // dropped focus, and a failed check selects nothing, so give it back.
    lastSubmitted = '';
    root.setAttribute('data-state', 'failed');
    statusEl.textContent = SIGN_IN_CODE_FAILED;
    if (typeof input.focus === 'function') {
      input.focus();
    }
  }

  input.addEventListener('input', () => {
    if (verified || isChecking) return;
    const normalized = normalizeSignInCode(input.value);
    if (input.value !== normalized) {
      input.value = normalized;
    }
    const hasSix = normalized.length === SIGN_IN_CODE_LENGTH;
    button.disabled = !hasSix;
    if (hasSix && normalized !== lastSubmitted) {
      void submit(normalized);
    }
  });

  input.addEventListener(
    'keydown',
    (event: KeyboardEvent | { key: string; preventDefault: () => void }) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (isChecking || verified) return;
        const normalized = normalizeSignInCode(input.value);
        if (normalized.length === SIGN_IN_CODE_LENGTH) {
          void submit(normalized);
        }
      }
    }
  );

  button.addEventListener(
    'click',
    (event: MouseEvent | { preventDefault: () => void }) => {
      event.preventDefault();
      if (isChecking || verified) return;
      const normalized = normalizeSignInCode(input.value);
      if (normalized.length === SIGN_IN_CODE_LENGTH) {
        void submit(normalized);
      }
    }
  );

  if (options.focus) {
    queueMicrotask(() => {
      try {
        if (typeof input.focus === 'function') {
          input.focus();
        }
      } catch {
        // Ignore environments where focus is not supported
      }
    });
  }

  return root;
}
