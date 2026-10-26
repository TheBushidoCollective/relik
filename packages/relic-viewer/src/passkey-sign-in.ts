/**
 * Lazy chunk for passkey sign-in and post-login passkey enrollment offer.
 *
 * Loaded on demand when WebAuthn is supported in a secure context.
 * Runtime dependencies come only from passkey-common.ts.
 */

import type {
  AuthenticationResponseJSON,
  CreationOptionsJSON,
  RegistrationResponseJSON,
  RequestOptionsJSON,
} from '@relic/format';
import {
  authenticationResponseToJSON,
  ceremonyCode,
  ceremonySignal,
  creationOptionsFromJSON,
  type CredentialsLike,
  COPY_LINK_FAILED,
  COPY_LINK_FINE,
  COPY_LINK_REQUIRED_LEAD,
  COPY_LINK_SEND,
  el,
  ICON_KEY,
  type LinkRequestOutcome,
  parseCreationOptions,
  parseRequestOptions,
  pressable,
  registrationResponseToJSON,
  requestOptionsFromJSON,
} from './passkey-common.ts';
import type { ViewerDeps } from './viewer.ts';

/* ---------- Copy (verbatim from spec §4.10) ---------- */

const COPY_SIGN_IN = 'Sign in with passkey';
const COPY_WORKING = 'Waiting for your passkey';
const COPY_PREPARING = 'Getting your passkey ready. Press again in a moment.';
const COPY_FAILED =
  'That passkey did not sign you in. Try again, or send yourself a link.';
const COPY_CANCELLED = 'No passkey was used.';
const COPY_FALLBACK_LEAD = 'Passkey not offered?';
const COPY_FALLBACK_BUTTON = 'Use a passkey for this address';
const COPY_EMAIL_FIRST_EMPTY =
  'Type your address above, then press this again.';
const COPY_CONFIRM = 'Confirm with your passkey';
const COPY_RATE_LIMITED =
  'Too many passkey attempts from this network. Wait a few minutes, or send yourself a link.';
const COPY_UNREACHABLE = 'Relic could not be reached. Try again.';
const COPY_SUCCESS = 'Signed in with your passkey. No email was sent.';

const COPY_OFFER_TITLE = 'Skip the email next time';
const COPY_OFFER_BODY =
  'Add a passkey and this device signs you in without a link.';
const COPY_OFFER_FINE =
  'Your first passkey also confirms decisions, and adding one on another device later asks for it.';
const COPY_OFFER_CREATE = 'Add a passkey';
const COPY_OFFER_NOT_NOW = 'Not now';
const COPY_OFFER_ASSERT_BODY =
  'You already have a passkey on another device. Confirm with it, then add one here.';
const COPY_OFFER_ASSERT_BUTTON = 'Confirm with your passkey';
const COPY_OFFER_SECOND_STEP = 'Add a passkey on this device';
const COPY_OFFER_WORKING = 'Waiting for your passkey';
const COPY_OFFER_CREATED =
  'Passkey added. Next time, choose Sign in with passkey.';
const COPY_OFFER_EXISTS =
  'This device already has your passkey. Next time, choose Sign in with passkey.';
const COPY_OFFER_CANCELLED = 'No passkey was added.';
const COPY_OFFER_ERROR =
  'Relic could not set up a passkey just now. You can add one the next time you sign in from an email.';
const COPY_OFFER_CLOSE = 'Close';

function setOutcome(
  outcome: HTMLElement,
  text: string,
  kind: 'note' | 'warning' = 'note'
): void {
  outcome.replaceChildren(
    el('p', kind === 'warning' ? 'compose-warning' : 'thread-note', text)
  );
}

/* ---------- Sign-in interfaces & mount ---------- */

export interface PasskeySignInMount {
  readonly host: HTMLElement;
  readonly email: HTMLInputElement;
  readonly outcome: HTMLElement;
  readonly deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>;
  readonly credentials?: CredentialsLike;
  readonly conditionalAvailable?: () => Promise<boolean>;
  readonly onSignedIn: (email: string) => void;
}

interface CachedOptions {
  readonly options: RequestOptionsJSON;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/** Module singleton coordinating arming, refresh, and passkey ceremonies. */
class PasskeySignInController {
  private mounts = new Set<PasskeySignInMount>();
  private cachedOptions: CachedOptions | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private paused = false;
  private armingPromise: Promise<void> | undefined;
  private authChannel: BroadcastChannel | undefined;
  private listenersAttached = false;

  private ensureListeners(): void {
    if (!this.listenersAttached) {
      if (typeof BroadcastChannel === 'function') {
        this.authChannel = new BroadcastChannel('relic:auth');
        this.authChannel.addEventListener('message', () => {
          this.pause();
        });
      }

      if (
        typeof document !== 'undefined' &&
        typeof document.addEventListener === 'function'
      ) {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && !this.paused) {
            if (
              this.cachedOptions === undefined ||
              Date.now() >= this.cachedOptions.expiresAt - 30_000
            ) {
              void this.arm();
            }
          }
        });
      }
      this.listenersAttached = true;
    }
  }

  pause(): void {
    this.paused = true;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    ceremonySignal();
  }

  register(mount: PasskeySignInMount): void {
    this.ensureListeners();
    this.mounts.add(mount);
    this.setupMountDOM(mount);

    if (!this.paused) {
      void this.arm();
    }
  }

  unregister(mount: PasskeySignInMount): void {
    this.mounts.delete(mount);
  }

  reset(): void {
    this.mounts.clear();
    this.cachedOptions = undefined;
    this.paused = false;
    this.armingPromise = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.authChannel) {
      this.authChannel.close();
      this.authChannel = undefined;
    }
    this.listenersAttached = false;
  }

  private isVisible(): boolean {
    if (
      typeof document === 'undefined' ||
      document.visibilityState === undefined
    ) {
      return true;
    }
    return document.visibilityState === 'visible';
  }

  async arm(): Promise<void> {
    if (this.mounts.size === 0 || this.paused) return;
    if (!this.isVisible()) return;

    if (this.armingPromise !== undefined) {
      return this.armingPromise;
    }

    this.armingPromise = (async () => {
      try {
        const firstMount = this.mounts.values().next().value;
        if (!firstMount) return;

        for (const m of this.mounts) {
          if (this.cachedOptions === undefined) {
            m.host.setAttribute('data-state', 'preparing');
          }
        }

        const res = await firstMount.deps.fetch(
          `${firstMount.deps.serviceOrigin}/api/auth/passkeys/sign-in/options`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }
        );

        if (res.status === 429) {
          for (const m of this.mounts) {
            m.host.setAttribute('data-state', 'rate-limited');
            setOutcome(m.outcome, COPY_RATE_LIMITED, 'warning');
          }
          return;
        }

        if (!res.ok) {
          for (const m of this.mounts) {
            m.host.setAttribute('data-state', 'failed');
            setOutcome(m.outcome, COPY_UNREACHABLE, 'note');
          }
          return;
        }

        const data: unknown = await res.json();
        let pubKey: unknown;
        if (typeof data === 'object' && data !== null && 'public_key' in data) {
          pubKey = Reflect.get(data as object, 'public_key');
        }
        const parsed = parseRequestOptions(pubKey);
        if (!parsed) {
          for (const m of this.mounts) {
            m.host.setAttribute('data-state', 'failed');
            setOutcome(m.outcome, COPY_UNREACHABLE, 'note');
          }
          return;
        }

        const fetchedAt = Date.now();
        const timeout =
          typeof parsed.timeout === 'number' ? parsed.timeout : 300_000;
        this.cachedOptions = {
          options: parsed,
          fetchedAt,
          expiresAt: fetchedAt + timeout,
        };

        for (const m of this.mounts) {
          if (m.host.getAttribute('data-state') !== 'failed') {
            m.host.setAttribute('data-state', 'ready');
          }
        }

        this.scheduleRefresh(timeout);
        this.startConditionalRequest(parsed);
      } catch {
        // Network or parse error during arming
      } finally {
        this.armingPromise = undefined;
      }
    })();

    return this.armingPromise;
  }

  private scheduleRefresh(timeoutMs: number): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const delay = Math.max(1_000, timeoutMs - 30_000);
    this.refreshTimer = setTimeout(() => {
      if (this.isVisible() && !this.paused) {
        void this.arm();
      }
    }, delay);
  }

  private startConditionalRequest(options: RequestOptionsJSON): void {
    void (async () => {
      const firstMount = this.mounts.values().next().value;
      if (!firstMount) return;

      let canConditional = false;
      if (typeof firstMount.conditionalAvailable === 'function') {
        try {
          canConditional = await firstMount.conditionalAvailable();
        } catch {
          canConditional = false;
        }
      } else if (
        typeof PublicKeyCredential !== 'undefined' &&
        typeof PublicKeyCredential.isConditionalMediationAvailable ===
          'function'
      ) {
        try {
          canConditional =
            await PublicKeyCredential.isConditionalMediationAvailable();
        } catch {
          canConditional = false;
        }
      }

      if (!canConditional) return;

      const credentialsApi =
        firstMount.credentials ??
        (typeof navigator !== 'undefined' ? navigator.credentials : undefined);
      if (!credentialsApi) return;

      const signal = ceremonySignal();
      let pending: Promise<Credential | null>;
      try {
        pending = credentialsApi.get({
          mediation: 'conditional',
          publicKey: requestOptionsFromJSON(options),
          signal,
        });
      } catch {
        return;
      }

      try {
        const cred = await pending;
        if (!cred) return;
        await this.handleAssertionSuccess(cred, firstMount);
      } catch {
        // Aborted or rejected conditional request is silent
      }
    })();
  }

  private async handleAssertionSuccess(
    credential: Credential,
    mount: PasskeySignInMount
  ): Promise<void> {
    for (const m of this.mounts) {
      m.host.setAttribute('data-state', 'working');
      setOutcome(m.outcome, COPY_WORKING, 'note');
    }

    let json: AuthenticationResponseJSON;
    try {
      json = authenticationResponseToJSON(credential);
    } catch {
      for (const m of this.mounts) {
        m.host.setAttribute('data-state', 'failed');
        setOutcome(m.outcome, COPY_FAILED, 'warning');
      }
      return;
    }

    let res: Response;
    try {
      res = await mount.deps.fetch(
        `${mount.deps.serviceOrigin}/api/auth/passkeys/sign-in`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credential: json }),
        }
      );
    } catch {
      for (const m of this.mounts) {
        m.host.setAttribute('data-state', 'ready');
        setOutcome(m.outcome, COPY_UNREACHABLE, 'note');
      }
      return;
    }

    if (res.status === 200) {
      const reply: unknown = await res.json();
      const email =
        typeof reply === 'object' && reply !== null && 'email' in reply
          ? String(Reflect.get(reply as object, 'email'))
          : '';
      for (const m of this.mounts) {
        m.host.setAttribute('data-state', 'ready');
        setOutcome(m.outcome, COPY_SUCCESS, 'note');
      }
      mount.onSignedIn(email);
      return;
    }

    if (res.status === 401) {
      for (const m of this.mounts) {
        m.host.setAttribute('data-state', 'failed');
        setOutcome(m.outcome, COPY_FAILED, 'warning');
        const fallback = m.host.querySelector('[data-passkey-fallback]');
        if (fallback) {
          fallback.removeAttribute('hidden');
          (fallback as HTMLElement).hidden = false;
        }
      }
      void this.arm();
      return;
    }

    if (res.status === 429) {
      for (const m of this.mounts) {
        m.host.setAttribute('data-state', 'rate-limited');
        setOutcome(m.outcome, COPY_RATE_LIMITED, 'warning');
      }
      return;
    }

    for (const m of this.mounts) {
      m.host.setAttribute('data-state', 'failed');
      setOutcome(m.outcome, COPY_UNREACHABLE, 'note');
    }
  }

  private setupMountDOM(mount: PasskeySignInMount): void {
    mount.host.replaceChildren();
    mount.host.setAttribute('data-passkey-sign-in-host', '');

    const credsApi =
      mount.credentials ??
      (typeof navigator !== 'undefined' ? navigator.credentials : undefined);
    if (!credsApi) {
      mount.host.setAttribute('data-state', 'unavailable');
      return;
    }

    mount.host.setAttribute('data-state', 'preparing');

    const orLine = el('p', 'passkey-or', 'or');

    const signInBtn = pressable(
      'action passkey-button',
      COPY_SIGN_IN,
      () => {
        this.handleSignInPress(mount);
      },
      ICON_KEY
    );
    signInBtn.setAttribute('data-passkey-sign-in', '');

    const fallbackDiv = el('div', 'passkey-fallback');
    fallbackDiv.setAttribute('data-passkey-fallback', '');
    fallbackDiv.setAttribute('hidden', '');
    fallbackDiv.hidden = true;

    const fallbackLead = el(
      'span',
      'passkey-fallback-lead',
      COPY_FALLBACK_LEAD
    );
    const fallbackBtn = el('button', 'passkey-link', COPY_FALLBACK_BUTTON);
    fallbackBtn.setAttribute('type', 'button');
    fallbackBtn.setAttribute('data-passkey-email-first', '');

    fallbackDiv.append(fallbackLead, fallbackBtn);

    let cachedEmailOptions: RequestOptionsJSON | undefined;

    const confirmBtn = pressable(
      'action passkey-button',
      COPY_CONFIRM,
      () => {
        if (!cachedEmailOptions) return;
        const creds =
          mount.credentials ??
          (typeof navigator !== 'undefined'
            ? navigator.credentials
            : undefined);
        if (!creds) return;

        const signal = ceremonySignal();
        let pending: Promise<Credential | null>;
        try {
          pending = creds.get({
            publicKey: requestOptionsFromJSON(cachedEmailOptions),
            signal,
          });
        } catch (err) {
          pending = Promise.reject(err);
        }

        mount.host.setAttribute('data-state', 'working');
        setOutcome(mount.outcome, COPY_WORKING, 'note');

        void (async () => {
          let cred: Credential | null;
          try {
            cred = await pending;
          } catch (err) {
            if (
              signal.aborted ||
              (err instanceof Error && err.name === 'AbortError')
            ) {
              return;
            }
            const code = ceremonyCode(err);
            mount.host.setAttribute('data-state', 'ready');
            setOutcome(
              mount.outcome,
              code === 'not_allowed' ? COPY_CANCELLED : COPY_UNREACHABLE,
              'note'
            );
            return;
          }

          if (!cred) {
            mount.host.setAttribute('data-state', 'ready');
            setOutcome(mount.outcome, COPY_CANCELLED, 'note');
            return;
          }

          await this.handleAssertionSuccess(cred, mount);
        })();
      },
      ICON_KEY
    );
    confirmBtn.setAttribute('data-passkey-email-first-confirm', '');
    confirmBtn.setAttribute('hidden', '');
    confirmBtn.hidden = true;

    fallbackBtn.addEventListener('click', () => {
      const address = mount.email.value.trim();
      if (address.length === 0) {
        setOutcome(mount.outcome, COPY_EMAIL_FIRST_EMPTY, 'note');
        return;
      }

      mount.host.setAttribute('data-state', 'preparing');
      void (async () => {
        try {
          const res = await mount.deps.fetch(
            `${mount.deps.serviceOrigin}/api/auth/passkeys/sign-in/options`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email: address }),
            }
          );

          if (res.status === 429) {
            mount.host.setAttribute('data-state', 'rate-limited');
            setOutcome(mount.outcome, COPY_RATE_LIMITED, 'warning');
            return;
          }

          if (!res.ok) {
            mount.host.setAttribute('data-state', 'failed');
            setOutcome(mount.outcome, COPY_UNREACHABLE, 'note');
            return;
          }

          const data: unknown = await res.json();
          let pubKey: unknown;
          if (
            typeof data === 'object' &&
            data !== null &&
            'public_key' in data
          ) {
            pubKey = Reflect.get(data as object, 'public_key');
          }
          const parsed = parseRequestOptions(pubKey);
          if (!parsed) {
            mount.host.setAttribute('data-state', 'failed');
            setOutcome(mount.outcome, COPY_UNREACHABLE, 'note');
            return;
          }

          cachedEmailOptions = parsed;
          mount.host.setAttribute('data-state', 'email-first');
          confirmBtn.removeAttribute('hidden');
          confirmBtn.hidden = false;
        } catch {
          mount.host.setAttribute('data-state', 'failed');
          setOutcome(mount.outcome, COPY_UNREACHABLE, 'note');
        }
      })();
    });

    mount.host.append(orLine, signInBtn, fallbackDiv, confirmBtn);
  }

  private handleSignInPress(mount: PasskeySignInMount): void {
    const credsApi =
      mount.credentials ??
      (typeof navigator !== 'undefined' ? navigator.credentials : undefined);
    if (!credsApi) {
      mount.host.setAttribute('data-state', 'unavailable');
      return;
    }

    const now = Date.now();
    if (!this.cachedOptions || now >= this.cachedOptions.expiresAt) {
      mount.host.setAttribute('data-state', 'preparing');
      setOutcome(mount.outcome, COPY_PREPARING, 'note');
      void this.arm();
      return;
    }

    const signal = ceremonySignal();
    let pending: Promise<Credential | null>;
    try {
      pending = credsApi.get({
        publicKey: requestOptionsFromJSON(this.cachedOptions.options),
        signal,
      });
    } catch (err) {
      pending = Promise.reject(err);
    }

    mount.host.setAttribute('data-state', 'working');
    setOutcome(mount.outcome, COPY_WORKING, 'note');

    void (async () => {
      let cred: Credential | null;
      try {
        cred = await pending;
      } catch (err) {
        if (
          signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        const code = ceremonyCode(err);
        mount.host.setAttribute('data-state', 'ready');
        setOutcome(
          mount.outcome,
          code === 'not_allowed' ? COPY_CANCELLED : COPY_UNREACHABLE,
          'note'
        );
        return;
      }

      if (!cred) {
        mount.host.setAttribute('data-state', 'ready');
        setOutcome(mount.outcome, COPY_CANCELLED, 'note');
        return;
      }

      await this.handleAssertionSuccess(cred, mount);
    })();
  }
}

const controller = new PasskeySignInController();

export function mountPasskeySignIn(mount: PasskeySignInMount): void {
  controller.register(mount);
}

export function resetPasskeySignInForTesting(): void {
  controller.reset();
}

/* ---------- Passkey Offer ---------- */

export interface PasskeyOfferMount {
  readonly host: HTMLElement;
  readonly deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>;
  readonly email?: string;
  readonly credentials?: CredentialsLike;
  readonly store: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly onDone: () => void;
  readonly requestLink: () => Promise<LinkRequestOutcome>;
}
export function mountPasskeyOffer(mount: PasskeyOfferMount): void {
  const { host, deps, onDone } = mount;

  if (mount.store?.getItem('relic:passkey-offer') !== null) {
    onDone();
    return;
  }

  const credentialsApi =
    mount.credentials ??
    (typeof navigator !== 'undefined' ? navigator.credentials : undefined);

  const card =
    host.tagName === 'SECTION' ? host : el('section', 'passkey-offer');
  if (card !== host) {
    card.className = 'passkey-offer';
    host.appendChild(card);
  } else {
    card.classList.add('passkey-offer');
  }

  card.setAttribute('data-passkey-offer', '');
  card.setAttribute('data-state', 'loading');
  if (host !== card) {
    host.setAttribute('data-state', 'loading');
  }

  const initialOfferBody =
    typeof mount.email === 'string' && mount.email.length > 0
      ? `Add a passkey for ${mount.email} and this device signs you in without a link.`
      : COPY_OFFER_BODY;

  const titleEl = el('h3', 'passkey-offer-title', COPY_OFFER_TITLE);
  const bodyEl = el('p', 'passkey-offer-body', initialOfferBody);
  const fineEl = el('p', 'passkey-offer-fine', COPY_OFFER_FINE);

  const warningEl = el('p', 'compose-warning');
  warningEl.setAttribute('data-passkey-offer-warning', '');
  warningEl.hidden = true;
  warningEl.setAttribute('hidden', '');

  const createBtn = el(
    'button',
    'action primary',
    COPY_OFFER_CREATE
  ) as HTMLButtonElement;
  createBtn.setAttribute('type', 'button');
  createBtn.setAttribute('data-passkey-offer-create', '');
  // The press only acts once a challenge is cached, so until the options
  // arrive (and while a ceremony runs) the button must not take presses
  // it would drop silently. The card starts in `loading`.
  createBtn.disabled = true;

  const linkBtn = el(
    'button',
    'action primary',
    COPY_LINK_SEND
  ) as HTMLButtonElement;
  linkBtn.setAttribute('type', 'button');
  linkBtn.setAttribute('data-passkey-offer-link', '');
  linkBtn.hidden = true;
  linkBtn.setAttribute('hidden', '');

  const dismissBtn = el('button', 'passkey-link', COPY_OFFER_NOT_NOW);
  dismissBtn.setAttribute('type', 'button');
  dismissBtn.setAttribute('data-passkey-offer-dismiss', '');

  const codeEl = el('div') as HTMLDivElement;
  codeEl.setAttribute('data-passkey-offer-code', '');
  codeEl.hidden = true;
  codeEl.setAttribute('hidden', '');
  card.replaceChildren(
    titleEl,
    bodyEl,
    warningEl,
    codeEl,
    fineEl,
    createBtn,
    linkBtn,
    dismissBtn
  );

  function hideCreateButton(): void {
    createBtn.hidden = true;
    createBtn.setAttribute('hidden', '');
  }

  function showCreateButton(): void {
    createBtn.hidden = false;
    createBtn.removeAttribute('hidden');
  }

  function hideLinkButton(): void {
    linkBtn.hidden = true;
    linkBtn.setAttribute('hidden', '');
  }

  function showLinkButton(disabled: boolean): void {
    linkBtn.hidden = false;
    linkBtn.removeAttribute('hidden');
    linkBtn.disabled = disabled;
  }

  function hideWarning(): void {
    warningEl.hidden = true;
    warningEl.setAttribute('hidden', '');
    warningEl.textContent = '';
  }

  function showWarning(text: string): void {
    warningEl.textContent = text;
    warningEl.hidden = false;
    warningEl.removeAttribute('hidden');
  }

  function linkRequiredBody(): string {
    return typeof mount.email === 'string' && mount.email.length > 0
      ? `${COPY_LINK_REQUIRED_LEAD} Email a new code to ${mount.email}, type it here, then add your passkey.`
      : `${COPY_LINK_REQUIRED_LEAD} Email yourself a new code, type it here, then add your passkey.`;
  }

  async function handleSendLink(): Promise<void> {
    setState('link-sending');
    hideWarning();
    hideCreateButton();
    showLinkButton(true);
    dismissBtn.textContent = COPY_OFFER_NOT_NOW;

    try {
      const outcome = await mount.requestLink();
      if (outcome.kind === 'sent') {
        setState('link-sent');
        bodyEl.textContent = outcome.message;
        fineEl.hidden = true;
        fineEl.setAttribute('hidden', '');
        if (outcome.warning) {
          showWarning(outcome.warning);
        } else {
          hideWarning();
        }
        if (typeof outcome.codeEntry === 'function') {
          codeEl.hidden = false;
          codeEl.removeAttribute('hidden');
          codeEl.replaceChildren(
            outcome.codeEntry((_email) => {
              codeEl.replaceChildren();
              codeEl.hidden = true;
              codeEl.setAttribute('hidden', '');
              setState('loading');
              void fetchOptions();
            })
          );
        } else {
          codeEl.replaceChildren();
          codeEl.hidden = true;
          codeEl.setAttribute('hidden', '');
        }
        hideCreateButton();
        hideLinkButton();
        dismissBtn.textContent = COPY_OFFER_CLOSE;
      } else {
        setState('link-failed');
        bodyEl.textContent = COPY_LINK_FAILED;
        fineEl.hidden = false;
        fineEl.removeAttribute('hidden');
        fineEl.textContent = COPY_LINK_FINE;
        hideWarning();
        hideCreateButton();
        showLinkButton(false);
        dismissBtn.textContent = COPY_OFFER_NOT_NOW;
      }
    } catch {
      setState('link-failed');
      bodyEl.textContent = COPY_LINK_FAILED;
      fineEl.hidden = false;
      fineEl.removeAttribute('hidden');
      fineEl.textContent = COPY_LINK_FINE;
      hideWarning();
      hideCreateButton();
      showLinkButton(false);
      dismissBtn.textContent = COPY_OFFER_NOT_NOW;
    }
  }

  linkBtn.addEventListener('click', () => {
    void handleSendLink();
  });

  let currentState = 'loading';
  let cachedCreation: CreationOptionsJSON | undefined;
  let cachedAssert: RequestOptionsJSON | undefined;
  let isSecondStep = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(state: string): void {
    currentState = state;
    card.setAttribute('data-state', state);
    if (host !== card) {
      host.setAttribute('data-state', state);
    }
    createBtn.disabled = state === 'loading' || state === 'working';
    if (state !== 'link-sent') {
      codeEl.replaceChildren();
      codeEl.hidden = true;
      codeEl.setAttribute('hidden', '');
    }
  }

  async function fetchOptions(): Promise<void> {
    try {
      const res = await deps.fetch(
        `${deps.serviceOrigin}/api/auth/passkeys/options`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }
      );

      let problemCode: string | undefined;
      try {
        const cloned = res.clone();
        const bodyText = await cloned.text();
        if (bodyText) {
          const parsed = JSON.parse(bodyText);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'code' in parsed
          ) {
            problemCode = String(parsed.code);
          }
        }
      } catch {}

      if (problemCode === 'passkey_fresh_link_required') {
        setState('link-required');
        bodyEl.textContent = linkRequiredBody();
        fineEl.hidden = false;
        fineEl.removeAttribute('hidden');
        fineEl.textContent = COPY_LINK_FINE;
        hideWarning();
        hideCreateButton();
        showLinkButton(false);
        dismissBtn.textContent = COPY_OFFER_NOT_NOW;
        return;
      }

      if (res.status === 401) {
        onDone();
        return;
      }

      if (!res.ok) {
        setState('error');
        bodyEl.textContent = COPY_OFFER_ERROR;
        dismissBtn.textContent = COPY_OFFER_CLOSE;
        hideCreateButton();
        hideLinkButton();
        hideWarning();
        return;
      }

      const data: unknown = await res.json();
      if (typeof data !== 'object' || data === null) {
        setState('error');
        bodyEl.textContent = COPY_OFFER_ERROR;
        dismissBtn.textContent = COPY_OFFER_CLOSE;
        hideCreateButton();
        return;
      }
      const mode = Reflect.get(data as object, 'mode');
      const pubKey = Reflect.get(data as object, 'public_key');

      if (mode === 'create') {
        const creation = parseCreationOptions(pubKey);
        if (!creation) {
          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
          return;
        }
        cachedCreation = creation;
        setState('ready');
        bodyEl.textContent = isSecondStep
          ? COPY_OFFER_SECOND_STEP
          : initialOfferBody;
        fineEl.hidden = false;
        fineEl.removeAttribute('hidden');
        fineEl.textContent = COPY_OFFER_FINE;
        showCreateButton();
        hideLinkButton();
        hideWarning();
        dismissBtn.textContent = COPY_OFFER_NOT_NOW;
        createBtn.textContent = COPY_OFFER_CREATE;
        const timeout =
          typeof creation.timeout === 'number' ? creation.timeout : 300_000;
        scheduleRefresh(timeout);
      } else if (mode === 'assert') {
        const assertion = parseRequestOptions(pubKey);
        if (!assertion) {
          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
          return;
        }
        cachedAssert = assertion;
        setState('assert');
        bodyEl.textContent = COPY_OFFER_ASSERT_BODY;
        fineEl.hidden = false;
        fineEl.removeAttribute('hidden');
        fineEl.textContent = COPY_OFFER_FINE;
        showCreateButton();
        hideLinkButton();
        hideWarning();
        dismissBtn.textContent = COPY_OFFER_NOT_NOW;
        createBtn.textContent = COPY_OFFER_ASSERT_BUTTON;
        const timeout =
          typeof assertion.timeout === 'number' ? assertion.timeout : 300_000;
        scheduleRefresh(timeout);
      }
    } catch {
      setState('error');
      bodyEl.textContent = COPY_OFFER_ERROR;
      dismissBtn.textContent = COPY_OFFER_CLOSE;
      hideCreateButton();
    }
  }

  function scheduleRefresh(timeoutMs: number): void {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    const delay = Math.max(1_000, timeoutMs - 30_000);
    refreshTimer = setTimeout(() => {
      if (currentState === 'ready' || currentState === 'assert') {
        void fetchOptions();
      }
    }, delay);
  }

  createBtn.addEventListener('click', () => {
    if (!credentialsApi) {
      setState('error');
      bodyEl.textContent = COPY_OFFER_ERROR;
      dismissBtn.textContent = COPY_OFFER_CLOSE;
      hideCreateButton();
      return;
    }

    if (currentState === 'assert' && cachedAssert) {
      const signal = ceremonySignal();
      let pending: Promise<Credential | null>;
      try {
        pending = credentialsApi.get({
          publicKey: requestOptionsFromJSON(cachedAssert),
          signal,
        });
      } catch (err) {
        pending = Promise.reject(err);
      }

      setState('working');
      bodyEl.textContent = COPY_OFFER_WORKING;

      void (async () => {
        let cred: Credential | null;
        try {
          cred = await pending;
        } catch (err) {
          if (
            signal.aborted ||
            (err instanceof Error && err.name === 'AbortError')
          ) {
            return;
          }
          const code = ceremonyCode(err);
          if (code === 'not_allowed') {
            setState('cancelled');
            bodyEl.textContent = COPY_OFFER_CANCELLED;
          } else {
            setState('error');
            bodyEl.textContent = COPY_OFFER_ERROR;
            dismissBtn.textContent = COPY_OFFER_CLOSE;
            hideCreateButton();
          }
          return;
        }

        if (!cred) {
          setState('cancelled');
          bodyEl.textContent = COPY_OFFER_CANCELLED;
          return;
        }

        let json: AuthenticationResponseJSON;
        try {
          json = authenticationResponseToJSON(cred);
        } catch {
          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
          return;
        }

        try {
          const res = await deps.fetch(
            `${deps.serviceOrigin}/api/auth/passkeys/options`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ credential: json }),
            }
          );

          if (!res.ok) {
            setState('error');
            bodyEl.textContent = COPY_OFFER_ERROR;
            dismissBtn.textContent = COPY_OFFER_CLOSE;
            hideCreateButton();
            return;
          }

          const resData: unknown = await res.json();
          const pubKey =
            typeof resData === 'object' && resData !== null
              ? Reflect.get(resData as object, 'public_key')
              : undefined;
          const creation = parseCreationOptions(pubKey);
          if (!creation) {
            setState('error');
            bodyEl.textContent = COPY_OFFER_ERROR;
            dismissBtn.textContent = COPY_OFFER_CLOSE;
            hideCreateButton();
            return;
          }

          isSecondStep = true;
          cachedCreation = creation;
          setState('ready');
          bodyEl.textContent = COPY_OFFER_SECOND_STEP;
          createBtn.textContent = COPY_OFFER_CREATE;

          const timeout =
            typeof creation.timeout === 'number' ? creation.timeout : 300_000;
          scheduleRefresh(timeout);
        } catch {
          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
        }
      })();
      return;
    }

    if (currentState === 'ready' && cachedCreation) {
      const signal = ceremonySignal();
      let pending: Promise<Credential | null>;
      try {
        pending = credentialsApi.create({
          publicKey: creationOptionsFromJSON(cachedCreation),
          signal,
        });
      } catch (err) {
        pending = Promise.reject(err);
      }

      setState('working');
      bodyEl.textContent = COPY_OFFER_WORKING;

      void (async () => {
        let cred: Credential | null;
        try {
          cred = await pending;
        } catch (err) {
          if (
            (err instanceof Error && err.name === 'InvalidStateError') ||
            ceremonyCode(err) === 'passkey_exists'
          ) {
            setState('exists');
            bodyEl.textContent = COPY_OFFER_EXISTS;
            mount.store?.setItem('relic:passkey-offer', 'created');
            dismissBtn.textContent = COPY_OFFER_CLOSE;
            hideCreateButton();
            return;
          }
          if (
            signal.aborted ||
            (err instanceof Error && err.name === 'AbortError')
          ) {
            return;
          }
          const code = ceremonyCode(err);
          if (code === 'not_allowed') {
            setState('cancelled');
            bodyEl.textContent = COPY_OFFER_CANCELLED;
          } else {
            setState('error');
            bodyEl.textContent = COPY_OFFER_ERROR;
            dismissBtn.textContent = COPY_OFFER_CLOSE;
            hideCreateButton();
          }
          return;
        }

        if (!cred) {
          setState('cancelled');
          bodyEl.textContent = COPY_OFFER_CANCELLED;
          return;
        }

        let json: RegistrationResponseJSON;
        try {
          json = registrationResponseToJSON(cred);
        } catch {
          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
          return;
        }

        try {
          const res = await deps.fetch(
            `${deps.serviceOrigin}/api/auth/passkeys`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ credential: json }),
            }
          );

          if (res.ok) {
            setState('created');
            bodyEl.textContent = COPY_OFFER_CREATED;
            mount.store?.setItem('relic:passkey-offer', 'created');
            dismissBtn.textContent = COPY_OFFER_CLOSE;
            hideCreateButton();
            return;
          }

          const errData: unknown = await res.json().catch(() => ({}));
          const code =
            typeof errData === 'object' && errData !== null
              ? Reflect.get(errData as object, 'code')
              : undefined;
          if (
            code === 'passkey_assertion_required' ||
            code === 'passkey_required'
          ) {
            void fetchOptions();
            return;
          }
          if (
            code === 'sign_in_required' ||
            code === 'invalid_session' ||
            res.status === 401
          ) {
            onDone();
            return;
          }

          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
        } catch {
          setState('error');
          bodyEl.textContent = COPY_OFFER_ERROR;
          dismissBtn.textContent = COPY_OFFER_CLOSE;
          hideCreateButton();
        }
      })();
    }
  });

  dismissBtn.addEventListener('click', () => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (
      currentState === 'created' ||
      currentState === 'exists' ||
      currentState === 'error' ||
      currentState === 'link-sent'
    ) {
      card.remove();
      onDone();
    } else {
      mount.store?.setItem('relic:passkey-offer', 'dismissed');
      card.remove();
      onDone();
    }
  });

  void fetchOptions();
}
