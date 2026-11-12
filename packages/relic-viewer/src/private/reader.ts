/**
 * The private-relic reader: the states a reader moves through before a relic
 * opens, and the open itself. This is a lazy chunk. The shell never imports
 * it, and it carries the private-share copy the shell must not carry.
 *
 * Every state is one `data-for` stage inside `#relic-private`, with the copy
 * and markup from the approved mock. A decision that needs a passkey is one
 * tap, and nothing about the relic reaches a URL, a request body or storage
 * except the public identity, the signatures and the wraps the service holds.
 */

import { createContentSink } from '../content.ts';
import { readSession, requestMagicLink } from '../comments.ts';
import { keylessLink } from '../copy-link.ts';
import { privateApi } from './fingerprint-input.ts';
import { renderPrivateDashboard } from './dashboard-private.ts';
import { openAccessPanel } from './owner-panel.ts';
import { mountPasskeySignIn } from '../passkey-sign-in.ts';
import {
  normalizeSignInCode,
  SIGN_IN_CODE_FAILED,
  SIGN_IN_CODE_REJECTED,
  signInCodeRateLimitedCopy,
  submitSignInCode,
} from '../sign-in-code.ts';
import {
  deadFromProblem,
  type DeadView,
  type HistoricalVersionState,
  type ReadyView,
  routeContent,
  type ViewerDeps,
} from '../viewer.ts';
import {
  formatFingerprint,
  type IdentityStateJSON,
  type PrivateAccessJSON,
  identityFingerprint,
} from '@relic/format/private';
import { type AccessView, loadAccess, requestAccess } from './request.ts';
import {
  makeReplacementPasskey,
  retryIdentityAfterReplacement,
  setUpIdentity,
} from './identity.ts';
import {
  InvalidKeyResponseError,
  type OpenedVersion,
  OwnerChangedError,
  pinnedOwnerFor,
  type PinnedOwner,
  RecipientMissingError,
  SealMismatchError,
  TransferError,
  VersionUnavailableError,
} from './open.ts';
import {
  NoIdentityError,
  PrfUnavailableError,
  PrivateRequestError,
  type UnlockedIdentity,
} from './keys.ts';
import { privateKeysOf } from './ops.ts';
import { shellRoot } from '../shell-root.ts';

export interface PrivateReaderMount {
  readonly relicId: string;
  readonly usercontentOrigin: string;
  readonly deps: ViewerDeps;
  readonly renderReady: (
    view: ReadyView,
    relicId: string,
    usercontentOrigin: string,
    deps: ViewerDeps
  ) => void;
  readonly renderDead: (
    dead: DeadView,
    relicId: string,
    usercontentOrigin: string,
    deps: ViewerDeps,
    cachedPrefix: undefined,
    onRetry: () => void
  ) => void;
}

type ReaderStage =
  | 'signin'
  | 'setup'
  | 'setup-refused'
  | 'replace-offer'
  | 'request'
  | 'requested'
  | 'requested-locked'
  | 'declined'
  | 'unlock'
  | 'revoked'
  | 'denied'
  | 'owner-changed'
  | 'seal-mismatch';

/** Static copy and markup from the approved mock, one stage per state. */
const STAGES_HTML = `
<div class="stage" data-for="signin">
  <div class="card">
    <h1 class="card-title" tabindex="-1">This relic is private</h1>
    <p class="card-meta">Its link carries no key.</p>
    <div class="card-body">
      <p>Only people the owner lets in can open it. Sign in with the email address the owner knows you by.</p>
    </div>
    <div class="signin" id="signin-form">
      <div id="signin-passkey-host"></div>
      <div class="signin-or">or</div>
      <form class="signin-row" id="signin-email-form">
        <label class="compose-field"><span>Email address</span><input class="compose-input" type="email" id="signin-email" autocomplete="email" required></label>
        <button type="submit" class="action primary">Email me a code</button>
      </form>
      <form class="signin-row" id="signin-code-form" hidden>
        <label class="compose-field"><span>Code from the email</span><input class="compose-input code-input" inputmode="numeric" autocomplete="one-time-code" id="signin-code" maxlength="6"></label>
        <button type="submit" class="action primary">Sign in</button>
      </form>
      <p class="card-note" id="signin-note" hidden></p>
    </div>
    <details class="disclosure">
      <summary>What Relic records about private relics</summary>
      <blockquote><strong>Private relics.</strong> A private relic's link carries no key. Each reader who is let in has their own copy of each version's key, encrypted to a key only their passkey can unlock; the service stores those encrypted copies and never the keys. To let someone in, the service records who asked and who granted, the email addresses involved, the public keys, and a signed record of each grant and revocation. It keeps an access log of requests, grants, revocations, key fetches and deletions for the owner, for the retention the owner sets. It also stores each person's private-share key encrypted under a secret held by their passkey. Private relics carry no title or cover, always expire, and their notification emails say only that there is activity on a relic. The JavaScript that decrypts them comes from this service, the same as for every relic.</blockquote>
    </details>
  </div>
</div>

<div class="stage" data-for="setup" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Set up your private-share key</h1>
    <p class="card-meta" data-signed-in></p>
    <div class="card-body">
      <p>Private relics are encrypted to each reader's own key. Yours is made in this browser and stored encrypted under a secret only your passkey can produce, so Relic never sees it.</p>
      <p>Setting it up takes one tap.</p>
    </div>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-setup">Set up with passkey</button>
    </div>
  </div>
</div>

<div class="stage" data-for="setup-refused" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">This passkey can't hold a key</h1>
    <p class="card-meta" data-signed-in></p>
    <p class="load-bearing">Your passkey provider can't hold a private-share key. Private relics need a provider or security key that supports the WebAuthn PRF extension.</p>
    <p class="card-note">Nothing was registered. Public relics still open as before.</p>
  </div>
</div>

<div class="stage" data-for="replace-offer" hidden>
  <div class="card is-quiet">
    <h1 class="card-title" tabindex="-1">Make a replacement passkey</h1>
    <p class="card-meta" data-signed-in></p>
    <p class="load-bearing">This passkey was made before private shares existed and can't hold your key. Make a replacement passkey on this device?</p>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-replace-passkey">Make a replacement passkey</button>
      <button type="button" class="btn" id="replace-not-now">Not now</button>
    </div>
    <p class="card-note">Your passkey provider asks before it saves the new one. Nothing is registered with Relic until it can hold your key.</p>
  </div>
</div>

<div class="stage" data-for="request" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Ask the owner for access</h1>
    <p class="card-meta" data-signed-in></p>
    <div class="card-body">
      <p>Relic will email the owner a link to review your request. The email doesn't name you or this relic.</p>
      <p>The owner will ask you for your fingerprint before they let you in. You'll see it on the next screen.</p>
    </div>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-request">Ask for access</button>
    </div>
    <p class="card-note">Asking signs the request with your passkey: one tap.</p>
  </div>
</div>

<div class="stage" data-for="requested" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Request sent</h1>
    <p class="card-meta" data-signed-in></p>
    <p class="fp-caption" id="fp-mine-caption">Your fingerprint</p>
    <p class="fingerprint" data-fingerprint="mine" aria-labelledby="fp-mine-caption"></p>
    <p class="fp-instruction">Read this fingerprint to the person who shared the link, on a phone or video call. Don't send it by email or chat: it only protects you if it travels a different way than this site.</p>
    <p class="card-note" data-request-note></p>
  </div>
</div>

<div class="stage" data-for="requested-locked" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Request sent</h1>
    <p class="card-meta" data-signed-in></p>
    <div class="card-body">
      <p>Your fingerprint shows here once your passkey unlocks it in this browser. Read it to the person who shared the link, on a phone or video call.</p>
    </div>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-unlock-requested">Unlock with passkey</button>
    </div>
  </div>
</div>

<div class="stage" data-for="declined" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">The owner declined your request</h1>
    <p class="card-meta" data-signed-in></p>
    <p>Relic won't open this relic for you. If you think that's a mistake, contact the person who shared it.</p>
  </div>
</div>

<div class="stage" data-for="unlock" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">You have access</h1>
    <p class="card-meta" data-signed-in data-expiry></p>
    <p>Your passkey unlocks your key in this browser. The relic is decrypted here; the key never leaves.</p>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-unlock">Unlock with passkey</button>
    </div>
  </div>
</div>

<div class="stage" data-for="revoked" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">Your access was removed</h1>
    <p class="card-meta" data-signed-in></p>
    <p>The owner removed your access to this relic. Relic no longer serves it to you, and the keys it held for you are deleted.</p>
  </div>
</div>

<div class="stage" data-for="denied" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">You don't have access to this relic</h1>
    <p class="card-meta" data-signed-in></p>
    <p>Relic won't serve this relic to this address. If the owner shared it with a different one, sign in with that address instead.</p>
    <div class="card-actions">
      <button type="button" class="btn" id="denied-switch">Sign in with another address</button>
    </div>
  </div>
</div>

<div class="stage" data-for="owner-changed" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">Relic won't open this relic</h1>
    <p class="card-meta" data-signed-in></p>
    <p class="load-bearing">The owner's key for this relic isn't the one you saw when you first opened it. Relic won't open it. Contact the person who shared it.</p>
    <div class="dash-grid">
      <div>
        <p class="fp-caption" data-first-seen-caption></p>
        <p class="fingerprint is-small" data-fingerprint="first-seen"></p>
      </div>
      <div>
        <p class="fp-caption">Reported now</p>
        <p class="fingerprint is-small is-foreign" data-fingerprint="reported"></p>
      </div>
    </div>
  </div>
</div>

<div class="stage" data-for="seal-mismatch" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">Relic won't show this version</h1>
    <p class="card-meta" data-version-meta></p>
    <p class="load-bearing">This version doesn't match the owner's signature. Relic won't show it.</p>
    <p class="card-note">Nothing from it was displayed. Tell the person who shared it, so they can check what was published.</p>
  </div>
</div>`;

const COPY_SIGNED_IN = 'Signed in as';
const COPY_GENERIC_FAILURE = 'Something went wrong reaching the service.';
const COPY_REQUEST_SENT = 'When the owner lets you in, Relic emails';
const COPY_REQUEST_SENT_TAIL = 'Open that link and confirm with your passkey.';
const COPY_SEAL_DETAIL =
  "This version doesn't match the owner's signature. Relic won't show it.";

/** The element a stage or the host must contain, or the reader fails loudly. */
function required<T extends Element>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

/** A fingerprint's display groups become spans of text, never markup. */
function setFingerprint(target: Element, display: string): void {
  const groups = display.split(' ').map((group) => {
    const span = document.createElement('span');
    span.textContent = group;
    return span;
  });
  target.replaceChildren(
    ...groups.flatMap((span, index) => (index === 0 ? [span] : [' ', span]))
  );
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function expiryLabel(iso: string): string {
  return dayLabel(Date.parse(iso));
}

/** The button shows a wait, then restores what it said. */
function waiting(button: HTMLButtonElement): () => void {
  const original = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('data-waiting', '');
  button.textContent = 'Waiting for your passkey';
  return () => {
    button.disabled = false;
    button.removeAttribute('data-waiting');
    button.replaceChildren(...original);
  };
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof PrivateRequestError && error.status === 401;
}

class PrivateReader {
  private readonly host: HTMLElement;
  private email: string | undefined;
  private identityState: IdentityStateJSON | undefined;
  private access: AccessView | undefined;
  private identity: UnlockedIdentity | undefined;
  private readonly keyPromises = new Map<number, Promise<Uint8Array>>();
  private pendingVersion = 0;
  private panelHost: HTMLElement | undefined;
  private requestCount: HTMLElement | undefined;

  constructor(private readonly mount: PrivateReaderMount) {
    this.host = document.createElement('section');
    this.host.id = 'relic-private';
    this.host.setAttribute('aria-label', 'Private relic');
    this.host.innerHTML = STAGES_HTML;
  }

  async start(): Promise<void> {
    shellRoot().replaceChildren(this.host);
    this.wire();
    await this.route();
  }

  private stage(stage: ReaderStage): HTMLElement {
    return required<HTMLElement>(this.host, `[data-for="${stage}"]`);
  }

  private show(stage: ReaderStage): void {
    this.host.setAttribute('data-private-state', stage);
    for (const element of this.host.querySelectorAll<HTMLElement>(
      ':scope > [data-for]'
    )) {
      element.hidden = element.dataset['for'] !== stage;
    }
    for (const element of this.host.querySelectorAll('[data-signed-in]')) {
      element.textContent =
        this.email === undefined ? '' : `${COPY_SIGNED_IN} ${this.email}`;
    }
    this.stage(stage).querySelector<HTMLElement>('[tabindex="-1"]')?.focus({
      preventScroll: true,
    });
  }

  private wire(): void {
    const action = (name: string, run: () => Promise<void>): void => {
      const button = required<HTMLButtonElement>(
        this.host,
        `[data-action="${name}"]`
      );
      button.addEventListener('click', () => {
        const done = waiting(button);
        void run().finally(done);
      });
    };
    action('private-setup', () => this.setup());
    action('private-replace-passkey', () => this.replacePasskey());
    action('private-request', () => this.request());
    action('private-unlock', () => this.unlockAndOpen());
    action('private-unlock-requested', () => this.unlockRequested());

    required<HTMLButtonElement>(this.host, '#replace-not-now').addEventListener(
      'click',
      () => this.show('setup-refused')
    );
    required<HTMLButtonElement>(this.host, '#denied-switch').addEventListener(
      'click',
      () => this.show('signin')
    );

    required<HTMLFormElement>(this.host, '#signin-email-form').addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        const address = required<HTMLInputElement>(this.host, '#signin-email');
        void this.emailCode(address.value);
      }
    );
    required<HTMLFormElement>(this.host, '#signin-code-form').addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        const code = required<HTMLInputElement>(this.host, '#signin-code');
        void this.signInWithCode(code.value);
      }
    );
  }

  private signInNote(text: string): void {
    const note = required<HTMLElement>(this.host, '#signin-note');
    note.textContent = text;
    note.hidden = text === '';
  }

  private async emailCode(address: string): Promise<void> {
    const result = await requestMagicLink(
      this.mount.relicId,
      address,
      this.mount.deps
    );
    if (result.kind === 'refused') {
      this.signInNote(result.refusal.detail);
      return;
    }
    required<HTMLFormElement>(this.host, '#signin-code-form').hidden = false;
    required<HTMLInputElement>(this.host, '#signin-code').focus();
  }

  private async signInWithCode(raw: string): Promise<void> {
    const result = await submitSignInCode(
      normalizeSignInCode(raw),
      this.mount.deps
    );
    if (result.kind === 'verified') {
      this.signInNote('');
      await this.route();
    } else if (result.kind === 'rate_limited') {
      this.signInNote(signInCodeRateLimitedCopy(result.retryAfterSeconds));
    } else if (result.kind === 'rejected') {
      this.signInNote(SIGN_IN_CODE_REJECTED);
    } else {
      this.signInNote(SIGN_IN_CODE_FAILED);
    }
  }

  /** Decides which stage the reader is in, from the session and the service. */
  async route(): Promise<void> {
    const session = await readSession(this.mount.deps);
    if (session.kind !== 'verified') {
      this.email = undefined;
      this.mountSignIn();
      this.show('signin');
      return;
    }
    this.email = session.email;
    try {
      this.identityState = await privateKeysOf(
        this.mount.deps
      ).loadIdentityState(this.mount.deps);
      if (this.identityState.identity === null) {
        this.show('setup');
        return;
      }
      this.access = await loadAccess(this.mount.deps, this.mount.relicId);
    } catch (error) {
      if (isUnauthenticated(error)) {
        this.mountSignIn();
        this.show('signin');
        return;
      }
      this.failure(error);
      return;
    }
    this.routeAccess(this.access);
  }

  private routeAccess(access: AccessView): void {
    switch (access.role) {
      case 'revoked':
        this.show('revoked');
        return;
      case 'declined':
        this.show('declined');
        return;
      case 'requested':
        this.show('requested-locked');
        return;
      case 'none':
        this.show('request');
        return;
      case 'owner':
      case 'grantee':
      case 'recovery':
        this.show('unlock');
        this.prepareOwner();
        required<HTMLElement>(
          this.stage('unlock'),
          '[data-expiry]'
        ).textContent =
          `${COPY_SIGNED_IN} ${this.email ?? ''} · expires ${expiryLabel(access.expiresAt)}`;
        return;
    }
  }

  private mountSignIn(): void {
    mountPasskeySignIn({
      host: required<HTMLElement>(this.host, '#signin-passkey-host'),
      email: required<HTMLInputElement>(this.host, '#signin-email'),
      outcome: required<HTMLElement>(this.host, '#signin-note'),
      deps: this.mount.deps,
      onSignedIn: () => {
        void this.route();
      },
    });
  }

  /** Shows the fingerprint the reader reads to the owner, computed locally. */
  private showRequested(identityId: string): void {
    const address = this.email ?? '';
    void identityFingerprint(identityId, address).then((display) => {
      setFingerprint(
        required<HTMLElement>(
          this.stage('requested'),
          '[data-fingerprint="mine"]'
        ),
        formatFingerprint(display)
      );
      required<HTMLElement>(
        this.stage('requested'),
        '[data-request-note]'
      ).textContent =
        `${COPY_REQUEST_SENT} ${address}. ${COPY_REQUEST_SENT_TAIL}`;
      this.show('requested');
    });
  }

  private async setup(): Promise<void> {
    if (this.email === undefined) {
      this.show('signin');
      return;
    }
    try {
      const outcome = await setUpIdentity(this.mount.deps, this.email);
      if (outcome.kind === 'ready') {
        this.identity = outcome.identity;
        await this.route();
      } else if (outcome.kind === 'replace-offer') {
        this.show('replace-offer');
      } else {
        this.show('setup-refused');
      }
    } catch (error) {
      this.failure(error);
    }
  }

  private async replacePasskey(): Promise<void> {
    if (this.email === undefined) {
      this.show('signin');
      return;
    }
    try {
      await makeReplacementPasskey(this.mount.deps);
      const outcome = await retryIdentityAfterReplacement(
        this.mount.deps,
        this.email
      );
      if (outcome.kind === 'ready') {
        this.identity = outcome.identity;
        await this.route();
      } else {
        this.show('setup-refused');
      }
    } catch (error) {
      this.failure(error);
    }
  }

  private async request(): Promise<void> {
    try {
      const identity = await requestAccess(this.mount.deps, this.mount.relicId);
      this.identity = identity;
      this.showRequested(identity.identityId);
    } catch (error) {
      this.failure(error);
    }
  }

  /** The requested stage shows its fingerprint only once this page has unlocked the key. */
  private async unlockRequested(): Promise<void> {
    if (this.identityState === undefined) {
      this.show('signin');
      return;
    }
    try {
      const identity = await privateKeysOf(this.mount.deps).unlock(
        this.mount.deps,
        this.identityState
      );
      this.identity = identity;
      this.showRequested(identity.identityId);
    } catch (error) {
      this.failure(error);
    }
  }

  private async unlockAndOpen(): Promise<void> {
    if (this.identityState === undefined) {
      this.show('signin');
      return;
    }
    try {
      const identity = await privateKeysOf(this.mount.deps).unlock(
        this.mount.deps,
        this.identityState
      );
      this.identity = identity;
      await this.openSealed(identity);
    } catch (error) {
      this.failure(error);
    }
  }

  private async openSealed(identity: UnlockedIdentity): Promise<void> {
    const access = this.access;
    if (access === undefined || access.sealedVersion === null) {
      this.mount.renderDead(
        deadFromProblem('relic_not_yet_published'),
        this.mount.relicId,
        this.mount.usercontentOrigin,
        this.mount.deps,
        undefined,
        () => void this.route()
      );
      return;
    }
    this.pendingVersion = access.sealedVersion;
    const opened = await privateKeysOf(this.mount.deps).fetchAndDecryptVersion(
      this.mount.deps,
      this.mount.relicId,
      access.sealedVersion,
      identity
    );
    this.mountReady(
      await this.readyView(opened, access.sealedVersion, identity)
    );
  }

  /** Builds the view the shell renders, with keys resolved per version. */
  private async readyView(
    opened: OpenedVersion,
    version: number,
    identity: UnlockedIdentity
  ): Promise<ReadyView> {
    const entry = opened.envelope.entries[0];
    if (entry === undefined) throw new InvalidKeyResponseError('envelope');
    const sink = createContentSink(opened.content.length);
    sink.write(opened.content);
    const content = await sink.finish();
    const route = await routeContent(entry.filename, entry.mimetype, content);
    return {
      filename: entry.filename,
      declaredMimetype: entry.mimetype,
      content,
      document: route.document,
      route: route.route,
      downgradeNotice: route.notice,
      shareUrl: keylessLink(this.mount.deps.locationHref),
      version,
      currentVersion: this.access?.currentVersion ?? version,
      versionDigest: opened.digest,
      access: 'private',
      keyFor: (wanted: number) => this.keyFor(wanted, identity),
      openVersion: (wanted: number) => this.openVersion(wanted, identity),
    };
  }

  /** One version's key, fetched once per page and never written anywhere. */
  private keyFor(
    version: number,
    identity: UnlockedIdentity
  ): Promise<Uint8Array> {
    const cached = this.keyPromises.get(version);
    if (cached !== undefined) return cached;
    const pending = privateKeysOf(this.mount.deps)
      .fetchVersionKey(this.mount.deps, this.mount.relicId, version, identity)
      .then((fetched) => fetched.key);
    this.keyPromises.set(version, pending);
    pending.catch(() => this.keyPromises.delete(version));
    return pending;
  }

  private async openVersion(
    version: number,
    identity: UnlockedIdentity
  ): Promise<HistoricalVersionState> {
    try {
      const opened = await privateKeysOf(
        this.mount.deps
      ).fetchAndDecryptVersion(
        this.mount.deps,
        this.mount.relicId,
        version,
        identity
      );
      return {
        kind: 'ready',
        view: await this.readyView(opened, version, identity),
      };
    } catch (error) {
      if (error instanceof SealMismatchError) {
        return {
          kind: 'unavailable',
          code: 'seal_mismatch',
          detail: COPY_SEAL_DETAIL,
        };
      }
      if (error instanceof VersionUnavailableError) {
        const dead = deadFromProblem(error.code);
        return { kind: 'unavailable', code: dead.code, detail: dead.detail };
      }
      return {
        kind: 'unavailable',
        code: 'version_unavailable',
        detail: COPY_GENERIC_FAILURE,
      };
    }
  }

  private mountReady(view: ReadyView): void {
    this.host.remove();
    this.mount.renderReady(
      view,
      this.mount.relicId,
      this.mount.usercontentOrigin,
      this.mount.deps
    );
    shellRoot().prepend(this.strip(pinnedOwnerFor(this.mount.relicId)));
    void this.attachOwnerControls();
  }

  /** The strip above a private relic: who shared it, and the owner's fingerprint. */
  private strip(pinned: PinnedOwner | undefined): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'private-strip';
    strip.id = 'ready-strip';

    const who = document.createElement('span');
    who.id = 'strip-who';
    const label = document.createElement('strong');
    label.textContent = 'Private.';
    const expires =
      this.access === undefined ? '' : expiryLabel(this.access.expiresAt);
    who.append(label, ` Shared by ${pinned?.email ?? ''}. Expires ${expires}.`);

    const fingerprint = document.createElement('span');
    fingerprint.className = 'strip-fp';
    const caption = document.createElement('span');
    caption.id = 'fp-owner-caption';
    caption.textContent = 'Owner fingerprint';
    const display = document.createElement('span');
    display.className = 'fingerprint is-small';
    display.setAttribute('data-fingerprint', 'owner');
    display.setAttribute('aria-labelledby', 'fp-owner-caption');
    fingerprint.append(caption, display);

    const note = document.createElement('p');
    note.className = 'strip-note';
    note.id = 'strip-note';
    if (pinned !== undefined) {
      note.textContent = `First seen in this browser on ${dayLabel(pinned.firstSeen)}. Ask the owner to read theirs to you; it should match.`;
      void identityFingerprint(pinned.identityId, pinned.email).then(
        (value) => {
          setFingerprint(display, formatFingerprint(value));
        }
      );
    }
    strip.append(who, fingerprint, note);
    return strip;
  }

  /** The owner's panel host, placed under the page root and replaced on each render. */
  private attachPanelHost(): HTMLElement {
    this.panelHost?.remove();
    const host = document.createElement('div');
    host.id = 'access-panel-host';
    shellRoot().append(host);
    this.panelHost = host;
    return host;
  }

  /**
   * The owner's unlock stage keeps the panel host ready, and the request mail's
   * `?access=requests` opens the access panel straight from there.
   */
  private prepareOwner(): void {
    if (this.access?.role !== 'owner') return;
    this.attachPanelHost();
    const wanted = new URL(this.mount.deps.locationHref).searchParams.get(
      'access'
    );
    if (wanted === 'requests') void this.openOwnerPanel();
  }

  /** The owner's Access control on the relic's bar, with the pending count. */
  private async attachOwnerControls(): Promise<void> {
    if (this.access?.role !== 'owner') return;
    const bar = shellRoot().querySelector<HTMLElement>('.bar');
    if (bar === null) return;
    this.attachPanelHost();
    const count = document.createElement('span');
    count.className = 'action-count';
    count.id = 'request-count';
    this.requestCount = count;
    const button = document.createElement('button');
    button.className = 'action';
    button.setAttribute('data-action', 'open-access-panel');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'access-panel');
    const label = document.createElement('span');
    label.textContent = 'Access';
    button.append(label, count);
    button.addEventListener('click', () => {
      void this.openOwnerPanel();
    });
    bar.append(button);
    await this.refreshRequestCount();
  }

  /** Sets the pending count the Access control shows, hidden when none wait. */
  private async refreshRequestCount(): Promise<void> {
    const count = this.requestCount;
    if (count === undefined) return;
    try {
      const listed = await privateApi<{
        readonly requests: readonly { readonly status: string }[];
      }>(
        this.mount.deps,
        'GET',
        `/api/relics/${encodeURIComponent(this.mount.relicId)}/requests`
      );
      const pending = listed.requests.filter(
        (request) => request.status === 'pending'
      ).length;
      count.textContent = String(pending);
      count.hidden = pending === 0;
      count.setAttribute(
        'aria-label',
        `${pending} ${pending === 1 ? 'request' : 'requests'} waiting`
      );
    } catch {
      count.hidden = true;
    }
  }

  /** Opens the access panel, loaded fresh from the service. A failed load leaves the page as it was. */
  private async openOwnerPanel(): Promise<void> {
    const { deps, relicId } = this.mount;
    try {
      const access = await privateApi<PrivateAccessJSON>(
        deps,
        'GET',
        `/api/relics/${encodeURIComponent(relicId)}/access`
      );
      if (this.panelHost === undefined) return;
      openAccessPanel(this.panelHost, {
        relicId,
        access,
        deps,
        onChanged: () => {
          void this.refreshRequestCount();
        },
      });
    } catch {
      return;
    }
  }

  /** Maps a failed step onto the stage the reader can act on. */
  private failure(error: unknown): void {
    if (error instanceof OwnerChangedError) {
      void this.showOwnerChanged(error.pinned, error.reported);
      return;
    }
    if (error instanceof SealMismatchError) {
      required<HTMLElement>(
        this.stage('seal-mismatch'),
        '[data-version-meta]'
      ).textContent =
        `Version ${this.pendingVersion} · ${COPY_SIGNED_IN} ${this.email ?? ''}`;
      this.show('seal-mismatch');
      return;
    }
    if (error instanceof RecipientMissingError) {
      this.show('denied');
      return;
    }
    if (error instanceof PrfUnavailableError) {
      this.show('setup-refused');
      return;
    }
    if (error instanceof NoIdentityError) {
      this.show('setup');
      return;
    }
    if (error instanceof PrivateRequestError) {
      if (error.code === 'ceremony_cancelled') return;
      if (error.code === 'private_access_denied') {
        this.show('denied');
        return;
      }
    }
    const dead =
      error instanceof VersionUnavailableError
        ? deadFromProblem(error.code)
        : error instanceof TransferError
          ? deadFromProblem('service_unreachable')
          : {
              headline: 'This relic could not be opened',
              detail: COPY_GENERIC_FAILURE,
              action: 'retry' as const,
              code: 'service_unreachable',
            };
    this.mount.renderDead(
      dead,
      this.mount.relicId,
      this.mount.usercontentOrigin,
      this.mount.deps,
      undefined,
      () => void this.route()
    );
  }

  private async showOwnerChanged(
    pinned: PinnedOwner,
    reported: { readonly identityId: string; readonly email: string }
  ): Promise<void> {
    required<HTMLElement>(
      this.stage('owner-changed'),
      '[data-first-seen-caption]'
    ).textContent = `First seen, ${dayLabel(pinned.firstSeen)}`;
    const first = await identityFingerprint(pinned.identityId, pinned.email);
    const now = await identityFingerprint(reported.identityId, reported.email);
    setFingerprint(
      required<HTMLElement>(
        this.stage('owner-changed'),
        '[data-fingerprint="first-seen"]'
      ),
      formatFingerprint(first)
    );
    setFingerprint(
      required<HTMLElement>(
        this.stage('owner-changed'),
        '[data-fingerprint="reported"]'
      ),
      formatFingerprint(now)
    );
    this.show('owner-changed');
  }
}

/** Mounts the reader into the page root. Called only for a private relic. */
export async function mountPrivateReader(
  mount: PrivateReaderMount
): Promise<void> {
  await new PrivateReader(mount).start();
}

/**
 * Mounts the private-share sections under the dashboard. A visitor who is not
 * signed in gets nothing here, and no key or identity request is made. A
 * signed-in visitor gets the sections, with the device approval for
 * `?approve-device=` when the link carries one.
 */
export async function mountPrivateDashboard(deps: ViewerDeps): Promise<void> {
  const session = await readSession(deps);
  if (session.kind !== 'verified') return;
  const host = document.createElement('section');
  host.id = 'private-dashboard';
  shellRoot().append(host);
  const approve = new URL(deps.locationHref).searchParams.get('approve-device');
  renderPrivateDashboard(host, {
    deps,
    ...(approve === null ? {} : { approveDeviceEnrollmentId: approve }),
  });
}
