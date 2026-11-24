import { normalizeEmail, type RequestOptionsJSON } from '@relic/format';
import { readSession } from '../comments.ts';
import { submitSignInCode, normalizeSignInCode } from '../sign-in-code.ts';
import {
  authenticationResponseToJSON,
  parseRequestOptions,
  requestOptionsFromJSON,
} from '../passkey-common.ts';
import type { ViewerDeps } from '../viewer.ts';
import {
  makeReplacementPasskey,
  retryIdentityAfterReplacement,
  setUpIdentity,
} from './identity.ts';
import {
  credentialsOf,
  loadIdentityState,
  loadReviewedIdentity,
  postJson,
  PrivateRequestError,
  readField,
  type ReviewedPrivateOwner,
} from './keys.ts';

export type PrivateSetupOutcome =
  | {
      readonly kind: 'ready';
      readonly defaultTtlDays: number;
      readonly maxTtlDays: number;
      readonly owner: ReviewedPrivateOwner;
    }
  | {
      readonly kind: 'blocked';
      readonly message: string;
      readonly retryable?: boolean;
    };

/** Mount sign-in and key setup inside the existing review form. */
export async function mountPrivatePublishSetup(
  host: HTMLElement,
  deps: ViewerDeps,
  signal: AbortSignal
): Promise<PrivateSetupOutcome> {
  if (signal.aborted)
    return { kind: 'blocked', message: 'Private setup was cancelled.' };
  if (
    (deps.secureContext !== undefined && !deps.secureContext()) ||
    (typeof window !== 'undefined' && !window.isSecureContext) ||
    (deps.credentials === undefined &&
      (typeof navigator === 'undefined' || navigator.credentials === undefined))
  ) {
    return {
      kind: 'blocked',
      message: 'Private publishing requires a secure browser and a passkey.',
    };
  }
  let capability: { defaultTtlDays: number; maxTtlDays: number };
  try {
    const reply = await postJson(deps, '/api/challenge', {}, signal);
    if (
      typeof reply !== 'object' ||
      reply === null ||
      !('private_shares' in reply) ||
      typeof reply.private_shares !== 'object' ||
      reply.private_shares === null
    ) {
      throw new Error('missing capability');
    }
    const declared = reply.private_shares as Record<string, unknown>;
    const defaultTtlDays = declared['default_ttl_days'];
    const maxTtlDays = declared['max_ttl_days'];
    if (
      declared['browser_owner_publish'] !== true ||
      typeof defaultTtlDays !== 'number' ||
      typeof maxTtlDays !== 'number' ||
      !Number.isSafeInteger(defaultTtlDays) ||
      !Number.isSafeInteger(maxTtlDays) ||
      defaultTtlDays < 1 ||
      maxTtlDays < defaultTtlDays
    ) {
      throw new Error('missing capability');
    }
    capability = { defaultTtlDays, maxTtlDays };
  } catch {
    return {
      kind: 'blocked',
      message:
        'Private publishing is unavailable on this service. Nothing was uploaded.',
    };
  }

  const { promise, resolve } = Promise.withResolvers<PrivateSetupOutcome>();
  let settled = false;
  const finish = (value: PrivateSetupOutcome): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', cancel);
    host.replaceChildren();
    resolve(value);
  };
  const cancel = (): void =>
    finish({ kind: 'blocked', message: 'Private setup was cancelled.' });
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) {
    cancel();
    return promise;
  }

  const ready = async (owner: ReviewedPrivateOwner): Promise<void> => {
    await loadReviewedIdentity(deps, owner, signal);
    if (!settled) finish({ kind: 'ready', ...capability, owner });
  };

  const button = (label: string): HTMLButtonElement => {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'action';
    control.textContent = label;
    return control;
  };
  const text = (value: string): HTMLParagraphElement => {
    const node = document.createElement('p');
    node.className = 'pub-help';
    node.textContent = value;
    return node;
  };
  const errorText = (error: unknown): string =>
    error instanceof PrivateRequestError && error.code === 'passkey_required'
      ? 'A passkey is required to set up private publishing.'
      : 'Private setup could not finish. Try again or choose public publishing.';

  const setup = (email: string, hasPasskey: boolean): void => {
    if (settled) return;
    const help = text(
      'Set up a private key with your passkey. The file and its key stay in this browser.'
    );
    const status = text('');
    status.setAttribute('role', 'status');
    const control = button(
      hasPasskey ? 'Set up private key' : 'Add a passkey and set up private key'
    );
    host.replaceChildren(help, control, status);
    control.addEventListener('click', () => {
      control.disabled = true;
      status.textContent = 'Waiting for your passkey.';
      void (async () => {
        try {
          if (!hasPasskey) await makeReplacementPasskey(deps, signal);
          const outcome = await setUpIdentity(deps, email, signal);
          if (settled) return;
          if (outcome.kind === 'ready') {
            await ready({
              identityId: outcome.identity.identityId,
              email: outcome.identity.email,
            });
            return;
          }
          if (outcome.kind === 'replace-offer') {
            replacement(email);
            return;
          }
          status.textContent =
            'This passkey cannot protect a private key. Add a compatible passkey.';
        } catch (error) {
          if (!settled) status.textContent = errorText(error);
        } finally {
          control.disabled = false;
        }
      })();
    });
  };

  const replacement = (email: string): void => {
    const help = text(
      'This passkey cannot protect a private key. Add a compatible passkey to continue.'
    );
    const status = text('');
    status.setAttribute('role', 'status');
    const control = button('Add a compatible passkey');
    host.replaceChildren(help, control, status);
    control.addEventListener('click', () => {
      control.disabled = true;
      status.textContent = 'Waiting for your passkey.';
      void (async () => {
        try {
          await makeReplacementPasskey(deps, signal);
          const outcome = await retryIdentityAfterReplacement(
            deps,
            email,
            signal
          );
          if (settled) return;
          if (outcome.kind === 'ready')
            await ready({
              identityId: outcome.identity.identityId,
              email: outcome.identity.email,
            });
          else
            status.textContent =
              'That passkey cannot protect a private key. Nothing was uploaded.';
        } catch (error) {
          if (!settled) status.textContent = errorText(error);
        } finally {
          control.disabled = false;
        }
      })();
    });
  };

  const afterSignIn = async (): Promise<void> => {
    try {
      const session = await readSession(deps);
      if (settled) return;
      if (session.kind === 'unknown') {
        finish({
          kind: 'blocked',
          message: 'Could not check your sign-in. Nothing was uploaded.',
        });
        return;
      }
      if (session.kind === 'anonymous') {
        signIn();
        return;
      }
      const state = await loadIdentityState(deps, signal);
      if (settled) return;
      if (state.identity !== null) {
        if (
          !state.identity.identity_id ||
          typeof state.identity.email !== 'string' ||
          !state.identity.email ||
          normalizeEmail(state.identity.email) !== normalizeEmail(session.email)
        ) {
          finish({
            kind: 'blocked',
            message:
              'Your signed-in account changed. Start private setup again.',
            retryable: true,
          });
          return;
        }
        if (
          !state.identity.credentials.some((credential) =>
            state.passkeys.some(
              (passkey) =>
                passkey.bound &&
                passkey.credential_id === credential.credential_id
            )
          )
        ) {
          finish({
            kind: 'blocked',
            message:
              'Your private identity has no bound passkey. Nothing was uploaded.',
          });
        } else {
          await ready({
            identityId: state.identity.identity_id,
            email: state.identity.email,
          });
        }
        return;
      }
      setup(session.email, state.passkeys.length > 0);
    } catch (error) {
      if (!settled)
        finish({ kind: 'blocked', message: errorText(error), retryable: true });
    }
  };

  const signIn = (): void => {
    const help = text(
      'Sign in to own this private relik. Use your passkey or enter an email code here to keep your selected file.'
    );
    const label = document.createElement('label');
    label.textContent = 'Email address';
    const address = document.createElement('input');
    address.type = 'email';
    address.autocomplete = 'email';
    label.appendChild(address);
    const send = button('Email me a code');
    const passkey = button('Sign in with passkey');
    passkey.disabled = true;
    const codeLabel = document.createElement('label');
    codeLabel.textContent = 'Code from the email';
    codeLabel.hidden = true;
    const code = document.createElement('input');
    code.type = 'text';
    code.inputMode = 'numeric';
    code.autocomplete = 'one-time-code';
    codeLabel.appendChild(code);
    const verify = button('Sign in');
    verify.hidden = true;
    const status = text('');
    status.setAttribute('role', 'status');
    host.replaceChildren(help, passkey, label, send, codeLabel, verify, status);
    let signInOptions: RequestOptionsJSON | undefined;
    const armPasskey = (): void => {
      passkey.disabled = true;
      void postJson(deps, '/api/auth/passkeys/sign-in/options', {}, signal)
        .then((reply) => {
          if (settled) return;
          signInOptions = parseRequestOptions(readField(reply, 'public_key'));
          passkey.disabled = signInOptions === undefined;
        })
        .catch(() => {
          if (!settled) passkey.disabled = true;
        });
    };
    passkey.addEventListener('click', () => {
      if (signInOptions === undefined || passkey.disabled) return;
      passkey.disabled = true;
      status.textContent = 'Waiting for your passkey.';
      let request: Promise<Credential | null>;
      try {
        request = credentialsOf(deps).get({
          publicKey: requestOptionsFromJSON(signInOptions),
          signal,
        });
      } catch {
        status.textContent =
          'Passkey sign-in could not start. Try again or use an email code.';
        armPasskey();
        return;
      }
      void (async () => {
        try {
          const credential = await request;
          if (credential === null) throw new Error('passkey cancelled');
          await postJson(
            deps,
            '/api/auth/passkeys/sign-in',
            {
              credential: authenticationResponseToJSON(credential),
            },
            signal
          );
          if (!settled) await afterSignIn();
        } catch {
          if (!settled) {
            status.textContent =
              'Passkey sign-in did not finish. Try again or use an email code.';
            armPasskey();
          }
        }
      })();
    });
    armPasskey();
    send.addEventListener('click', () => {
      if (!address.validity.valid || address.value.trim() === '') {
        status.textContent = 'Enter your email address.';
        return;
      }
      send.disabled = true;
      void (async () => {
        try {
          const response = await deps.fetch(
            `${deps.serviceOrigin}/api/auth/request`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: address.value.trim(),
                return_to: '/publish',
              }),
              signal,
            }
          );
          if (settled) return;
          if (response.status !== 202)
            throw new Error('sign-in request refused');
          status.textContent = 'Check your email for the code.';
          codeLabel.hidden = false;
          verify.hidden = false;
          code.focus();
        } catch {
          if (!settled)
            status.textContent = 'Could not request a sign-in code. Try again.';
        } finally {
          send.disabled = false;
        }
      })();
    });
    address.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!send.disabled) send.click();
      }
    });
    const submit = (): void => {
      if (verify.disabled) return;
      const normalized = normalizeSignInCode(code.value);
      if (normalized.length !== 6) {
        status.textContent = 'Enter the six-digit code.';
        return;
      }
      verify.disabled = true;
      void (async () => {
        try {
          const outcome = await submitSignInCode(normalized, deps);
          if (settled) return;
          if (outcome.kind === 'verified') await afterSignIn();
          else if (outcome.kind === 'rate_limited')
            status.textContent = 'Too many attempts. Try again later.';
          else if (outcome.kind === 'rejected')
            status.textContent =
              'That code did not work. Check the newest email.';
          else status.textContent = 'Could not check the code. Try again.';
        } finally {
          verify.disabled = false;
        }
      })();
    };
    verify.addEventListener('click', submit);
    code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  };

  void afterSignIn();
  return promise;
}
