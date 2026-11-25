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

import {
  MalformedContainerError,
  UnsupportedEnvelopeVersionError,
} from '@relic/format';
import { openContentStore } from '../content.ts';
import { entryView, openFolderRelic } from '../folder-relic.ts';
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

export interface PrivateReaderMount {
  readonly relicId: string;
  readonly usercontentOrigin: string;
  readonly deps: ViewerDeps;
  readonly renderReady: (
    view: ReadyView,
    relicId: string,
    usercontentOrigin: string,
    deps: ViewerDeps,
    afterRender: (page: HTMLElement) => void
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
  | 'grant'
  | 'revoked'
  | 'denied'
  | 'owner-changed'
  | 'seal-mismatch';

/** Static copy and markup from the approved mock, one stage per state. */
const STAGES_HTML = `
<div class="stage" data-for="signin">
  <div class="card">
    <h1 class="card-title" tabindex="-1">This relik is private</h1>
    <p class="card-meta">Its link carries no key.</p>
    <div class="card-body">
      <p>Only people the owner lets in can open it. Enter your email address to ask the owner for access.</p>
    </div>
    <div class="signin" id="signin-form">
      <form class="signin-form" id="signin-email-form">
        <label class="compose-field"><span>Email address</span><input class="compose-input" type="email" id="signin-email" autocomplete="email" placeholder="you@example.com" required></label>
        <button type="submit" class="action primary">Request access</button>
        <p class="card-fine">Relik emails you a code to confirm the address. Then the owner is asked.</p>
      </form>
      <form class="signin-form" id="signin-code-form" hidden>
        <label class="compose-field"><span>Code from the email</span><input class="compose-input code-input" inputmode="numeric" autocomplete="one-time-code" id="signin-code" maxlength="6"></label>
        <button type="submit" class="action primary">Continue</button>
      </form>
      <p class="card-note" id="signin-note" hidden></p>
      <div class="passkey-sign-in" id="signin-passkey-host"></div>
    </div>
    <details class="disclosure">
      <summary>What Relik records about private reliks</summary>
      <blockquote>Relik records who asked for access and who granted it, their email addresses and public keys, and an access log the owner can read. Your key is stored only encrypted under your passkey. <a href="/policy" target="_blank" rel="noopener">Read the full statement.</a></blockquote>
    </details>
  </div>
</div>

<div class="stage" data-for="grant" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Review access request</h1>
    <p class="card-meta" data-signed-in></p>
    <div id="grant-focus"></div>
  </div>
</div>

<div class="stage" data-for="setup" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Set up your private-share key</h1>
    <p class="card-meta" data-signed-in></p>
    <div class="card-body">
      <p>Private reliks are encrypted to each reader's own key. Yours is made in this browser and stored encrypted under a secret only your passkey can produce, so Relik never sees it.</p>
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
    <p class="load-bearing">Your passkey provider can't hold a private-share key. Private reliks need a provider or security key that supports the WebAuthn PRF extension.</p>
    <p class="card-note">Nothing was registered. Public reliks still open as before.</p>
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
    <p class="card-note">Your passkey provider asks before it saves the new one. Nothing is registered with Relik until it can hold your key.</p>
  </div>
</div>

<div class="stage" data-for="request" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Ask the owner for access</h1>
    <p class="card-meta" data-signed-in></p>
    <div class="card-body">
      <p>Relik emails the owner your address and your fingerprint, with a link to let you in.</p>
      <p>You'll see the same fingerprint on the next screen. Nobody needs to call you.</p>
    </div>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-request">Request access</button>
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
    <p class="fp-instruction">The owner sees your email and this fingerprint in the email Relik sends them, and can grant you access from there. You don't need to call anyone.</p>
    <p class="card-note" data-request-note></p>
  </div>
</div>

<div class="stage" data-for="requested-locked" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">Request sent</h1>
    <p class="card-meta" data-signed-in></p>
    <div class="card-body">
      <p>Your fingerprint shows here once your passkey unlocks it in this browser. The owner sees it in the email Relik sends them.</p>
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
    <p>Relik won't open this relik for you. If you think that's a mistake, contact the person who shared it.</p>
  </div>
</div>

<div class="stage" data-for="unlock" hidden>
  <div class="card">
    <h1 class="card-title" tabindex="-1">You have access</h1>
    <p class="card-meta" data-signed-in data-expiry></p>
    <p>Your passkey unlocks your key in this browser. The relik is decrypted here; the key never leaves.</p>
    <div class="card-actions">
      <button type="button" class="action primary" data-action="private-unlock">Unlock with passkey</button>
    </div>
  </div>
</div>

<div class="stage" data-for="revoked" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">Your access was removed</h1>
    <p class="card-meta" data-signed-in></p>
    <p>The owner removed your access to this relik. Relik no longer serves it to you, and the keys it held for you are deleted.</p>
  </div>
</div>

<div class="stage" data-for="denied" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">You don't have access to this relik</h1>
    <p class="card-meta" data-signed-in></p>
    <p>Relik won't serve this relik to this address. If the owner shared it with a different one, sign in with that address instead.</p>
    <div class="card-actions">
      <button type="button" class="btn" id="denied-switch">Sign in with another address</button>
    </div>
  </div>
</div>

<div class="stage" data-for="owner-changed" hidden>
  <div class="card is-refusal">
    <h1 class="card-title" tabindex="-1">Relik won't open this relik</h1>
    <p class="card-meta" data-signed-in></p>
    <p class="load-bearing">The owner's key for this relik isn't the one you saw when you first opened it. Relik won't open it. Contact the person who shared it.</p>
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
    <h1 class="card-title" tabindex="-1">Relik won't show this version</h1>
    <p class="card-meta" data-version-meta></p>
    <p class="load-bearing">This version doesn't match the owner's signature. Relik won't show it.</p>
    <p class="card-note">Nothing from it was displayed. Tell the person who shared it, so they can check what was published.</p>
  </div>
</div>`;

const COPY_SIGNED_IN = 'Signed in as';
const COPY_GENERIC_FAILURE = 'Something went wrong reaching the service.';

/** What the reader sees when the browser refuses a passkey step, by the code the ceremony raised. */
const CEREMONY_COPY: Readonly<Record<string, string>> = {
  passkey_exists:
    'This device already has a passkey for Relik. Use it, or choose a different one.',
  passkey_security: 'Your browser blocked the passkey step on this page.',
  passkey_failed:
    'Your browser could not finish the passkey step. Try again, or use another browser or a security key.',
};
const COPY_REQUEST_SENT = 'When the owner lets you in, Relik emails';
const COPY_REQUEST_SENT_TAIL = 'Open that link and confirm with your passkey.';
const COPY_SEAL_DETAIL =
  "This version doesn't match the owner's signature. Relik won't show it.";

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
    this.host.setAttribute('aria-label', 'Private relik');
    this.host.innerHTML = STAGES_HTML;
  }

  async start(): Promise<void> {
    document.body.replaceChildren(this.host);
    this.wire();
    await this.route();
  }

  private stage(stage: ReaderStage): HTMLElement {
    return required<HTMLElement>(this.host, `[data-for="${stage}"]`);
  }

  private show(stage: ReaderStage): void {
    for (const note of this.host.querySelectorAll('.ceremony-note')) {
      note.remove();
    }
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
      if (
        error instanceof PrivateRequestError &&
        error.code === 'passkey_required'
      ) {
        // Signed in by email, with no passkey on this address yet. The key
        // is held by a passkey, so make one, then set up.
        await this.replacePasskey();
        return;
      }
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
      this.showDead(deadFromProblem('relic_not_yet_published'));
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
    if ('folderContent' in opened) {
      const folder = await openFolderRelic(
        opened.envelope,
        opened.folderContent
      );
      const base: ReadyView = {
        filename: opened.envelope.name,
        declaredMimetype: '',
        content: opened.folderContent,
        document: undefined,
        route: 'download',
        downgradeNotice: undefined,
        shareUrl: keylessLink(this.mount.deps.locationHref),
        version,
        currentVersion: this.access?.currentVersion ?? version,
        versionDigest: opened.digest,
        access: 'private',
        settings: this.access?.settings,
        manage: this.access?.role === 'owner',
        keyFor: (wanted: number) => this.keyFor(wanted, identity),
        openVersion: (wanted: number) => this.openVersion(wanted, identity),
        folder,
      };
      return entryView(base, folder.index);
    }
    const entry = opened.envelope.entries[0];
    if (entry === undefined) throw new InvalidKeyResponseError('envelope');
    const sink = (await openContentStore()).createSink(opened.content.length);
    sink.write(opened.content);
    const content = await sink.finish();
    const route = await routeContent(entry.filename, entry.mimetype, content);
    return {
      filename: entry.filename,
      declaredMimetype: entry.mimetype,
      content,
      document: route.document,
      route: route.route,
      documentKind: route.documentKind,
      downgradeNotice: route.notice,
      shareUrl: keylessLink(this.mount.deps.locationHref),
      version,
      currentVersion: this.access?.currentVersion ?? version,
      versionDigest: opened.digest,
      access: 'private',
      settings: this.access?.settings,
      manage: this.access?.role === 'owner',
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
      if (error instanceof UnsupportedEnvelopeVersionError) {
        return {
          kind: 'unavailable',
          code: 'unsupported_format',
          detail: 'Reload this page to get the current viewer.',
        };
      }
      if (error instanceof MalformedContainerError) {
        return {
          kind: 'unavailable',
          code: 'malformed_container',
          detail:
            'Its file list is damaged or names a file in a way Relik does not accept.',
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
      this.mount.deps,
      (page) => this.decorateReady(page)
    );
  }

  /**
   * The private chrome of a ready view: the strip under the taskbar, and for
   * the owner the Access control on it. The viewer calls this after every
   * render of the view, so a version switch or a comparison keeps both.
   */
  private decorateReady(page: HTMLElement): void {
    const bar = page.querySelector<HTMLElement>('.bar');
    const strip = this.strip(pinnedOwnerFor(this.mount.relicId));
    if (bar === null) {
      page.prepend(strip);
    } else {
      bar.after(strip);
    }
    void this.attachOwnerControls(page);
  }

  /** The strip under the taskbar: who shared it, and the owner's fingerprint. */
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
    document.body.append(host);
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
    if (wanted === 'requests') {
      const requester = new URL(this.mount.deps.locationHref).searchParams.get(
        'grant'
      );
      if (requester === null) void this.openOwnerPanel();
      else void this.openGrantCard(requester);
    }
  }

  /** The owner's Access control on the relic's taskbar, with the pending count. */
  private async attachOwnerControls(page: HTMLElement): Promise<void> {
    if (this.access?.role !== 'owner') return;
    const bar = page.querySelector<HTMLElement>('.bar');
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
      const focus = new URL(deps.locationHref).searchParams.get('grant');
      openAccessPanel(this.panelHost, {
        relicId,
        access,
        deps,
        ...(focus === null ? {} : { focusRequester: focus }),
        onChanged: () => {
          void this.refreshRequestCount();
        },
      });
    } catch {
      return;
    }
  }

  /**
   * The request mail's link: one card for the requester, in place of the
   * relik's unlock card, so there is a single thing to do. Going on to the
   * relik is a link under it, and the primary action once nothing is waiting.
   */
  private async openGrantCard(requester: string): Promise<void> {
    const { deps, relicId } = this.mount;
    try {
      const access = await privateApi<PrivateAccessJSON>(
        deps,
        'GET',
        `/api/relics/${encodeURIComponent(relicId)}/access`
      );
      this.show('grant');
      openAccessPanel(required<HTMLElement>(this.host, '#grant-focus'), {
        relicId,
        access,
        deps,
        focusRequester: requester,
        mode: 'focused',
        onChanged: () => {
          void this.refreshRequestCount();
        },
        onDone: () => this.show('unlock'),
      });
    } catch {
      // The unlock card stays: a failed load must not strand the owner.
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
      const ceremony = CEREMONY_COPY[error.code];
      if (ceremony !== undefined) {
        this.noteCurrent(
          error.detail === undefined
            ? ceremony
            : `${ceremony} (${error.detail})`
        );
        return;
      }
      if (error.code === 'passkey_fresh_link_required') {
        // A first passkey needs a recent email sign-in.
        this.show('signin');
        const note = required<HTMLElement>(this.host, '#signin-note');
        note.textContent =
          'To add a passkey, sign in again with a new code from your email.';
        note.hidden = false;
        return;
      }
      if (error.code === 'private_access_denied') {
        this.show('denied');
        return;
      }
    }
    if (error instanceof MalformedContainerError) {
      const newer = error instanceof UnsupportedEnvelopeVersionError;
      this.showDead(
        newer
          ? {
              headline: 'This relik uses a newer format',
              detail: 'Reload this page to get the current viewer.',
              action: 'none',
              code: 'unsupported_format',
            }
          : {
              headline: 'This relik could not be read',
              detail:
                'Its file list is damaged or names a file in a way Relik does not accept.',
              action: 'none',
              code: 'malformed_container',
            }
      );
      return;
    }
    const dead =
      error instanceof VersionUnavailableError
        ? deadFromProblem(error.code)
        : error instanceof TransferError
          ? deadFromProblem('service_unreachable')
          : {
              headline: 'This relik could not be opened',
              detail: COPY_GENERIC_FAILURE,
              action: 'retry' as const,
              code: 'service_unreachable',
            };
    this.showDead(dead);
  }

  /**
   * The dead card replaces the reader's stages. Left visible they sit above
   * it, because the shell removes only its own `main.stage`. Try again brings
   * the stages back and routes afresh.
   */
  private showDead(
    dead: Parameters<PrivateReaderMount['renderDead']>[0]
  ): void {
    this.host.hidden = true;
    this.mount.renderDead(
      dead,
      this.mount.relicId,
      this.mount.usercontentOrigin,
      this.mount.deps,
      undefined,
      () => {
        for (const card of document.body.querySelectorAll('main.stage-dead')) {
          card.remove();
        }
        this.host.hidden = false;
        void this.route();
      }
    );
  }

  /** Says something on the stage the reader is looking at, without leaving it. */
  private noteCurrent(text: string): void {
    const state = this.host.getAttribute('data-private-state');
    const card =
      state === null
        ? null
        : this.stage(state as ReaderStage).querySelector<HTMLElement>('.card');
    if (card === null) return;
    let note = card.querySelector<HTMLElement>('.ceremony-note');
    if (note === null) {
      note = document.createElement('p');
      note.className = 'card-note ceremony-note';
      note.setAttribute('role', 'status');
      card.append(note);
    }
    note.textContent = text;
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
  // Inside the dashboard's own column, so it shares that column's width and
  // scroll. Appended to the body instead, it became a second flex child that
  // squeezed the stage to a sliver with a scrollbar of its own.
  (document.body.querySelector('.dashboard-container') ?? document.body).append(
    host
  );
  const approve = new URL(deps.locationHref).searchParams.get('approve-device');
  renderPrivateDashboard(host, {
    deps,
    ...(approve === null ? {} : { approveDeviceEnrollmentId: approve }),
  });
}
