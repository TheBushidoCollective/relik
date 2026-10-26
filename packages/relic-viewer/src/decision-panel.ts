/**
 * The Decisions sheet, loaded on the first press of the band control.
 *
 * A decision is a stamp on one exact version, confirmed with a passkey. The
 * sheet walks it in two presses on purpose. Choosing a verdict fetches the
 * passkey options; confirming calls `navigator.credentials.get` synchronously
 * inside that second click, with the options already in hand. Safari only
 * lets a page start a WebAuthn ceremony from inside a user activation, and an
 * `await` between the click and the call would spend it.
 *
 * Every runtime value from the app shell arrives through the options, and
 * the WebAuthn helpers and ceremony controller live in passkey-common.ts so
 * the shell never carries them. That chunk is imported only by lazy loaders
 * (decisions and passkey sign-in), keeping WebAuthn conversion out of viewer.js.
 *
 * The sheet is not modal. The comment sidebar stays open and live beside it,
 * because the two are separate places: one for talking about a version, one
 * for signing it. Nothing written in a comment counts as a decision.
 */

import type {
  AuthenticationResponseJSON,
  CreationOptionsJSON,
  DecisionRecord,
  DecisionVerdict,
  RegistrationResponseJSON,
  RequestOptionsJSON,
} from '@relic/format';
import type { SessionState } from './comments.ts';
import type { DecisionListOutcome, DecisionTally } from './decisions.ts';
import type { ReadyView, ViewerDeps } from './viewer.ts';
import {
  authenticationResponseToJSON,
  ceremonyCode,
  ceremonySignal,
  COPY_LINK_FAILED,
  COPY_LINK_FINE,
  COPY_LINK_REQUIRED_LEAD,
  COPY_LINK_SEND,
  type CredentialsLike,
  creationOptionsFromJSON,
  el,
  glyph,
  ICON_KEY,
  type LinkRequestOutcome,
  parseCreationOptions,
  parseRequestOptions,
  plain,
  pressable,
  registrationResponseToJSON,
  requestOptionsFromJSON,
} from './passkey-common.ts';

/* ---------- copy ---------- */

export const DECISION_LEAD =
  'A decision is a stamp on one exact version, made with a passkey. It is ' +
  'separate from comments: nothing written in a comment counts as one.';
export const DECISION_TOFU =
  'The first passkey set up for an address becomes the only way to record ' +
  'decisions as that address. Adding another later needs this one.';
export const DECISION_LINK_REQUIRED = `${COPY_LINK_REQUIRED_LEAD} Email a new code, type it here, and setting up the passkey carries on. Nothing was recorded.`;
export const DECISION_CANCELLED = 'Cancelled. Nothing was recorded.';
export const DECISION_UNAVAILABLE =
  'Decisions open on this relic once its publisher republishes it.';

export function staleCopy(shown: number, newest: number): string {
  return (
    `You are viewing version ${shown}. Version ${newest} is the newest. ` +
    `A decision here applies to version ${shown} only.`
  );
}

export function mismatchCopy(version: number): string {
  return (
    `The file stored for version ${version} is not the file this page ` +
    'shows. Nothing was recorded.'
  );
}

const ICON_CLOSE =
  'M4.2 3.5 8 7.3l3.8-3.8.7.7L8.7 8l3.8 3.8-.7.7L8 8.7l-3.8 3.8-.7-.7L7.3 8 3.5 4.2z';
const ICON_VERDICT: Record<DecisionVerdict, string> = {
  approve: 'M6.2 11.6 2.6 8l1-1 2.6 2.6 6.2-6.2 1 1z',
  reject: 'M4 3 8 7l4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z',
};

const pastTense = (v: DecisionVerdict): string =>
  v === 'approve' ? 'Approved' : 'Rejected';
const verb = (v: DecisionVerdict): string =>
  v === 'approve' ? 'Approve' : 'Reject';

/* ---------- the panel ---------- */

export interface DecisionPanelOptions {
  readonly view: ReadyView;
  readonly relicId: string;
  readonly deps: ViewerDeps;
  /** The band control, which gets focus back when the sheet closes. */
  readonly opener: HTMLElement;
  readonly shareProof: () => Promise<string>;
  /** Lists the records on `view.version`. */
  readonly listDecisions: () => Promise<DecisionListOutcome>;
  readonly readSession: () => Promise<SessionState>;
  /** Mounts the comment composer's own sign-in form into `host`. */
  readonly signIn: (host: HTMLElement) => void;
  /** Hands the band its counts: numbers, closed (`null`), or not known. */
  readonly onTally: (tally: DecisionTally | null | undefined) => void;
  /** Takes the reader to another version of this relic. */
  readonly onOpenVersion: (version: number) => void;
  /** Called once, after the sheet has left the page. */
  readonly onClose: () => void;
  /** Requests a fresh sign-in link be emailed to the given address. */
  readonly requestLink: (email: string) => Promise<LinkRequestOutcome>;
  /** Defaults to `navigator.credentials`. */
  readonly credentials?: CredentialsLike | undefined;
}

export interface DecisionPanelHandle {
  readonly element: HTMLElement;
  /** Settles when the list and the session have been read and painted. */
  readonly ready: Promise<void>;
  /** Settles when the request in flight, if any, has painted its answer. */
  readonly idle: () => Promise<void>;
  readonly close: () => void;
  /** The band is rebuilt when a count changes; this points at the new control. */
  readonly setOpener: (opener: HTMLElement) => void;
}

interface DecisionOptions {
  readonly version: number;
  readonly versionDigest: string;
  readonly publicKey: RequestOptionsJSON;
}

type PasskeyStep =
  | { readonly phase: 'loading' }
  | { readonly phase: 'create'; readonly options: CreationOptionsJSON }
  | { readonly phase: 'add'; readonly options: RequestOptionsJSON }
  /** The existing passkey answered; creating the new one is a second press. */
  | { readonly phase: 'asserted'; readonly options: CreationOptionsJSON }
  | { readonly phase: 'working'; readonly mode: 'create' | 'add' }
  | {
      readonly phase: 'link';
      readonly state: 'required' | 'sending' | 'sent' | 'failed';
      readonly outcome?: LinkRequestOutcome | undefined;
      readonly codeEl?: HTMLElement | undefined;
    };

interface Outcome {
  readonly state: 'recorded' | 'cancelled' | 'error';
  readonly code: string;
  readonly record?: DecisionRecord;
  /** What the service holds, for a digest mismatch. */
  readonly stored?: string;
  readonly retryAfterSeconds?: number;
  /** Where the outcome came from, so a retry repeats the same step. */
  readonly from: 'decide' | 'passkey-create' | 'passkey-add' | 'options';
}

type Step =
  | { readonly kind: 'choose' }
  | { readonly kind: 'asking'; readonly verdict: DecisionVerdict }
  | {
      readonly kind: 'passkey';
      readonly verdict: DecisionVerdict;
      readonly passkey: PasskeyStep;
    }
  | {
      readonly kind: 'confirm';
      readonly verdict: DecisionVerdict;
      readonly options: DecisionOptions;
    }
  | {
      readonly kind: 'working';
      readonly verdict: DecisionVerdict;
      readonly options: DecisionOptions;
    }
  | {
      readonly kind: 'outcome';
      readonly verdict: DecisionVerdict;
      readonly outcome: Outcome;
    };

type ListState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'listed';
      readonly currentVersion: number;
      readonly records: readonly DecisionRecord[];
    }
  | { readonly kind: 'refused'; readonly code: string };

interface Reply {
  readonly ok: boolean;
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
}

/** Both ways the service says the session is gone: either way, sign in. */
function needsSignIn(code: string): boolean {
  return code === 'sign_in_required' || code === 'invalid_session';
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return plain(iso);
  const month = date.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${date.getUTCDate()}, ${hh}:${mm}`;
}

function timeEl(iso: string): HTMLElement {
  const node = el('time', 'decision-time', when(iso));
  node.setAttribute('datetime', iso);
  return node;
}

function mark(verdict: DecisionVerdict): HTMLElement {
  const node = el('span', `decision-mark is-${verdict}`);
  node.append(
    glyph(ICON_VERDICT[verdict]),
    document.createTextNode(pastTense(verdict))
  );
  return node;
}

function digestChip(hex: string): HTMLElement {
  const chip = el('span', 'decision-digest-chip');
  chip.append(
    el('span', '', 'sha256 '),
    el('b', '', hex.slice(0, 12)),
    el('span', '', '\u2026')
  );
  chip.title = hex;
  return chip;
}

function facts(
  pairs: readonly (readonly [string, string | HTMLElement])[]
): HTMLElement {
  const list = el('dl', 'decision-facts');
  for (const [term, value] of pairs) {
    const dd = el('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.appendChild(value);
    list.append(el('dt', '', term), dd);
  }
  return list;
}

interface AuthorEntry {
  readonly current: DecisionRecord;
  /** Newest first, each with the record that replaced it. */
  readonly history: readonly {
    readonly record: DecisionRecord;
    readonly supersededBy: DecisionRecord;
  }[];
}

function chronological(a: DecisionRecord, b: DecisionRecord): number {
  const delta = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (delta !== 0 && !Number.isNaN(delta)) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The latest record per author on `version`, with the ones it replaced. */
export function decisionsByAuthor(
  records: readonly DecisionRecord[],
  version: number
): AuthorEntry[] {
  const rows = records
    .filter((record) => record.version === version)
    .sort(chronological);
  const byAuthor = new Map<
    string,
    { current: DecisionRecord; history: AuthorEntry['history'][number][] }
  >();
  for (const record of rows) {
    const entry = byAuthor.get(record.author);
    if (entry === undefined) {
      byAuthor.set(record.author, { current: record, history: [] });
      continue;
    }
    entry.history.unshift({ record: entry.current, supersededBy: record });
    entry.current = record;
  }
  return [...byAuthor.values()].sort((a, b) =>
    chronological(a.current, b.current)
  );
}

function tallyOfEntries(entries: readonly AuthorEntry[]): DecisionTally {
  let approve = 0;
  let reject = 0;
  for (const entry of entries) {
    if (entry.current.verdict === 'approve') approve += 1;
    else reject += 1;
  }
  return { approve, reject };
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseRecord(value: unknown): DecisionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.version !== 'number' ||
    (r.verdict !== 'approve' && r.verdict !== 'reject') ||
    typeof r.author !== 'string' ||
    typeof r.created_at !== 'string' ||
    !isDigest(r.version_digest)
  ) {
    return undefined;
  }
  return {
    id: r.id,
    version: r.version,
    verdict: r.verdict,
    author: r.author,
    created_at: r.created_at,
    version_digest: r.version_digest,
  };
}

export function openDecisionPanel(
  options: DecisionPanelOptions
): DecisionPanelHandle {
  const { view, relicId, deps } = options;
  let opener = options.opener;
  const credentials = (): CredentialsLike | undefined =>
    options.credentials ??
    (typeof navigator === 'object' &&
    navigator !== null &&
    typeof navigator.credentials?.get === 'function'
      ? navigator.credentials
      : undefined);

  const dialog = document.createElement('dialog');
  dialog.className = 'decision-panel';
  dialog.id = 'decision-panel';
  dialog.setAttribute('aria-labelledby', 'decision-title');
  dialog.setAttribute('data-decision-version', String(view.version));

  let list: ListState = { kind: 'loading' };
  let session: SessionState | undefined;
  let lapsed = false;
  let step: Step = { kind: 'choose' };
  let open = true;
  let inFlight: Promise<void> = Promise.resolve();
  let channel: BroadcastChannel | undefined;
  let observer: MutationObserver | undefined;

  const newest = (): number =>
    list.kind === 'listed'
      ? Math.max(list.currentVersion, view.currentVersion)
      : view.currentVersion;
  const sessionEmail = (): string | undefined =>
    session?.kind === 'verified' ? session.email : undefined;

  const track = (work: Promise<void>): void => {
    inFlight = work.catch(() => {});
  };

  const api = async (path: string, body: unknown): Promise<Reply> => {
    let response: Response;
    try {
      response = await deps.fetch(`${deps.serviceOrigin}/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0, code: 'network', body: {} };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const record =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const code = response.ok
      ? ''
      : typeof record.code === 'string' && record.code.length > 0
        ? record.code
        : `http_${response.status}`;
    return { ok: response.ok, status: response.status, code, body: record };
  };

  const decisionsPath = (suffix: string): string =>
    `relics/${encodeURIComponent(relicId)}/decisions${suffix}`;

  /* ---------- painting ---------- */

  const head = (): HTMLElement => {
    const box = el('div', 'decision-head');
    const title = el('h2', 'decision-title');
    title.id = 'decision-title';
    title.tabIndex = -1;
    title.append(
      document.createTextNode('Decisions'),
      el('span', 'accession', `version ${view.version} of ${newest()}`)
    );
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'decision-close';
    close.setAttribute('aria-label', 'Close decisions');
    close.appendChild(glyph(ICON_CLOSE));
    close.addEventListener('click', () => closePanel(true));
    box.append(title, close);
    return box;
  };

  const staleNotice = (): HTMLElement[] => {
    const latest = newest();
    if (view.version >= latest) return [];
    const box = el('div', 'decision-stale');
    box.setAttribute('data-decision-stale', '');
    box.appendChild(el('p', '', staleCopy(view.version, latest)));
    box.appendChild(
      pressable('decision-secondary', `Open version ${latest}`, () => {
        closePanel(false);
        options.onOpenVersion(latest);
      })
    );
    return [box];
  };

  const listSection = (): HTMLElement => {
    const wrap = el('section', 'decision-current');
    const title = el('h3', 'decision-section-title');
    title.append(
      el('span', '', `Current on version ${view.version}`),
      digestChip(view.versionDigest)
    );
    wrap.appendChild(title);
    if (list.kind === 'loading') {
      wrap.appendChild(el('p', 'decision-empty', 'Reading the decisions.'));
      return wrap;
    }
    if (list.kind === 'refused') {
      wrap.appendChild(
        el(
          'p',
          'decision-empty',
          `The decisions could not be read (${list.code}). Recording one ` +
            'still works.'
        )
      );
      return wrap;
    }
    const entries = decisionsByAuthor(list.records, view.version);
    if (entries.length === 0) {
      wrap.appendChild(
        el(
          'p',
          'decision-empty',
          `No decisions on version ${view.version} yet.`
        )
      );
      return wrap;
    }
    const me = sessionEmail()?.trim().toLowerCase();
    const ol = el('ol', 'decision-list');
    for (const entry of entries) {
      const record = entry.current;
      const row = el('li', 'decision-row');
      row.setAttribute('data-decision-row', '');
      row.setAttribute('data-decision-author', record.author);
      row.setAttribute('data-verdict', record.verdict);
      const who = el('span', 'decision-who', plain(record.author));
      if (me !== undefined && record.author === me) {
        who.appendChild(el('span', 'decision-you', 'you'));
      }
      row.append(mark(record.verdict), who, timeEl(record.created_at));
      if (entry.history.length > 0) {
        const details = el('details', 'decision-history');
        const n = entry.history.length;
        details.appendChild(
          el('summary', '', `${n} earlier decision${n === 1 ? '' : 's'}`)
        );
        const older = el('ol');
        for (const { record: past, supersededBy } of entry.history) {
          const item = el('li');
          item.append(
            mark(past.verdict),
            timeEl(past.created_at),
            el(
              'span',
              'decision-superseded',
              `superseded ${when(supersededBy.created_at)}`
            )
          );
          older.appendChild(item);
        }
        details.appendChild(older);
        row.appendChild(details);
      }
      ol.appendChild(row);
    }
    wrap.appendChild(ol);
    if (entries.some((entry) => entry.history.length > 0)) {
      wrap.appendChild(
        el(
          'p',
          'decision-fine',
          'Each address counts once, by its latest decision. Earlier ones ' +
            'stay on the record.'
        )
      );
    }
    return wrap;
  };

  const identity = (lead: string): HTMLElement => {
    const line = el('p', 'decision-identity');
    line.append(
      document.createTextNode(lead),
      el('strong', '', plain(sessionEmail() ?? ''))
    );
    return line;
  };

  const chooser = (asking: DecisionVerdict | undefined): HTMLElement => {
    const box = el('section', 'decision-choose');
    const title = el('h3', 'decision-section-title');
    title.appendChild(el('span', '', 'Your decision'));
    const row = el('div', 'decision-verdicts');
    for (const verdict of ['approve', 'reject'] as const) {
      const choice = pressable(
        `decision-verdict is-${verdict}`,
        `${verb(verdict)} v${view.version}`,
        () => pickVerdict(verdict),
        ICON_VERDICT[verdict]
      );
      choice.setAttribute('data-decision-verdict', verdict);
      choice.setAttribute(
        'aria-label',
        `${verb(verdict)} version ${view.version}`
      );
      choice.disabled = asking !== undefined;
      row.appendChild(choice);
    }
    box.append(title, identity('Deciding as '), row);
    box.appendChild(
      el(
        'p',
        'decision-fine',
        asking === undefined
          ? 'You choose here, then confirm with your passkey. A later ' +
              'decision replaces this one as yours; both stay on the record.'
          : 'Asking Relic for a passkey challenge.'
      )
    );
    return box;
  };

  const signInSection = (): HTMLElement => {
    const host = el('section', 'decision-signin');
    host.setAttribute('data-decision-signin', '');
    host.appendChild(el('h3', '', 'Sign in to decide'));
    if (lapsed) {
      host.appendChild(
        el(
          'p',
          'compose-warning',
          'This browser is not verified any more. Verification is a short ' +
            'session, and it lapsed. Nothing was recorded.'
        )
      );
    }
    host.appendChild(
      el(
        'p',
        'decision-fine',
        'Deciding uses the same verified address as commenting, and a ' +
          'passkey on top of it.'
      )
    );
    options.signIn(host);
    return host;
  };

  const passkeySection = (
    verdict: DecisionVerdict,
    passkey: PasskeyStep
  ): HTMLElement => {
    const box = el('section', 'decision-passkey');
    const notNow = pressable('decision-secondary', 'Not now', () => {
      step = { kind: 'choose' };
      paint();
    });
    if (passkey.phase === 'link') {
      box.setAttribute('data-passkey-link', '');
      box.setAttribute('data-state', passkey.state);
      box.append(el('h3', '', 'Set up a passkey to decide'), identity('For '));

      if (passkey.state === 'required' || passkey.state === 'sending') {
        const warning = el('p', 'compose-warning', DECISION_LINK_REQUIRED);
        const sendBtn = el(
          'button',
          'action primary',
          COPY_LINK_SEND
        ) as HTMLButtonElement;
        sendBtn.setAttribute('type', 'button');
        sendBtn.setAttribute('data-passkey-link-send', '');
        if (passkey.state === 'sending') {
          sendBtn.disabled = true;
        }
        sendBtn.addEventListener('click', () => {
          const email = sessionEmail();
          if (!email) {
            lapse();
            return;
          }
          step = {
            kind: 'passkey',
            verdict,
            passkey: { phase: 'link', state: 'sending' },
          };
          paint();
          track(
            (async () => {
              try {
                const outcome = await options.requestLink(email);
                if (!open) return;
                if (outcome.kind === 'sent') {
                  const codeEl =
                    typeof outcome.codeEntry === 'function'
                      ? outcome.codeEntry((_email) => {
                          if (open) {
                            enterPasskey(verdict);
                          }
                        })
                      : undefined;
                  step = {
                    kind: 'passkey',
                    verdict,
                    passkey: {
                      phase: 'link',
                      state: 'sent',
                      outcome,
                      ...(codeEl !== undefined ? { codeEl } : {}),
                    },
                  };
                } else {
                  step = {
                    kind: 'passkey',
                    verdict,
                    passkey: { phase: 'link', state: 'failed', outcome },
                  };
                }
              } catch {
                if (!open) return;
                step = {
                  kind: 'passkey',
                  verdict,
                  passkey: {
                    phase: 'link',
                    state: 'failed',
                    outcome: { kind: 'failed' },
                  },
                };
              }
              paint();
            })()
          );
        });
        box.append(
          warning,
          sendBtn,
          el('p', 'decision-fine', COPY_LINK_FINE),
          notNow
        );
        return box;
      }

      if (passkey.state === 'failed') {
        const errorText = el('p', 'compose-warning', COPY_LINK_FAILED);
        const sendBtn = el(
          'button',
          'action primary',
          COPY_LINK_SEND
        ) as HTMLButtonElement;
        sendBtn.setAttribute('type', 'button');
        sendBtn.setAttribute('data-passkey-link-send', '');
        sendBtn.addEventListener('click', () => {
          const email = sessionEmail();
          if (!email) {
            lapse();
            return;
          }
          step = {
            kind: 'passkey',
            verdict,
            passkey: { phase: 'link', state: 'sending' },
          };
          paint();
          track(
            (async () => {
              try {
                const outcome = await options.requestLink(email);
                if (!open) return;
                if (outcome.kind === 'sent') {
                  const codeEl =
                    typeof outcome.codeEntry === 'function'
                      ? outcome.codeEntry((_email) => {
                          if (open) {
                            enterPasskey(verdict);
                          }
                        })
                      : undefined;
                  step = {
                    kind: 'passkey',
                    verdict,
                    passkey: {
                      phase: 'link',
                      state: 'sent',
                      outcome,
                      ...(codeEl !== undefined ? { codeEl } : {}),
                    },
                  };
                } else {
                  step = {
                    kind: 'passkey',
                    verdict,
                    passkey: { phase: 'link', state: 'failed', outcome },
                  };
                }
              } catch {
                if (!open) return;
                step = {
                  kind: 'passkey',
                  verdict,
                  passkey: {
                    phase: 'link',
                    state: 'failed',
                    outcome: { kind: 'failed' },
                  },
                };
              }
              paint();
            })()
          );
        });
        box.append(
          errorText,
          sendBtn,
          el('p', 'decision-fine', COPY_LINK_FINE),
          notNow
        );
        return box;
      }

      if (passkey.state === 'sent') {
        const note = el(
          'p',
          'decision-note',
          passkey.outcome && passkey.outcome.kind === 'sent'
            ? passkey.outcome.message
            : ''
        );
        box.appendChild(note);
        if (
          passkey.outcome &&
          passkey.outcome.kind === 'sent' &&
          passkey.outcome.warning
        ) {
          box.appendChild(el('p', 'compose-warning', passkey.outcome.warning));
        }
        if (passkey.codeEl) {
          box.appendChild(passkey.codeEl);
        }
        box.appendChild(notNow);
        return box;
      }
    }
    if (passkey.phase === 'loading') {
      box.append(
        el('h3', '', 'Set up a passkey to decide'),
        el('p', 'decision-fine', 'Asking Relic.')
      );
      return box;
    }
    if (passkey.phase === 'add') {
      box.append(
        el('h3', '', 'This address already has a passkey'),
        el(
          'p',
          'decision-note',
          `${plain(sessionEmail() ?? 'This address')} has a passkey set up ` +
            'on another device. To decide from this one, add a passkey here; ' +
            'your device asks for the existing one first.'
        ),
        el('p', 'compose-warning', DECISION_TOFU)
      );
      const add = pressable(
        'action primary',
        'Add a passkey on this device',
        () => addPasskey(verdict, passkey.options),
        ICON_KEY
      );
      add.setAttribute('data-passkey-add', '');
      box.append(add, notNow);
      return box;
    }
    if (passkey.phase === 'working') {
      box.append(
        el(
          'h3',
          '',
          passkey.mode === 'add'
            ? 'This address already has a passkey'
            : 'Set up a passkey to decide'
        ),
        identity('For ')
      );
      const waiting = pressable(
        'action primary',
        'Waiting for your passkey',
        () => {},
        ICON_KEY
      );
      waiting.setAttribute(
        passkey.mode === 'add' ? 'data-passkey-add' : 'data-passkey-create',
        ''
      );
      waiting.disabled = true;
      box.append(
        waiting,
        el('div', 'decision-waiting'),
        el(
          'p',
          'decision-fine',
          'Confirm on your device. Nothing is stored until it answers.'
        )
      );
      return box;
    }
    if (passkey.phase !== 'create' && passkey.phase !== 'asserted') {
      return box;
    }
    const creation = passkey.options;
    box.append(
      el(
        'h3',
        '',
        passkey.phase === 'asserted'
          ? 'Now create a passkey on this device'
          : 'Set up a passkey to decide'
      ),
      identity('For ')
    );
    if (passkey.phase === 'asserted') {
      box.appendChild(
        el(
          'p',
          'decision-note',
          'Your existing passkey confirmed it. One more press makes the ' +
            'passkey on this device.'
        )
      );
    } else {
      box.appendChild(el('p', 'compose-warning', DECISION_TOFU));
    }
    const make = pressable(
      'action primary',
      'Create a passkey',
      () => createPasskey(verdict, creation),
      ICON_KEY
    );
    make.setAttribute('data-passkey-create', '');
    box.append(
      make,
      el(
        'p',
        'decision-fine',
        'Your device keeps the private key. Relic stores the public key, ' +
          'under a hash of your address, and never receives the private one.'
      ),
      notNow
    );
    return box;
  };

  const ticket = (
    verdict: DecisionVerdict,
    working: boolean,
    decisionOptions: DecisionOptions
  ): HTMLElement => {
    const box = el('section', 'decision-ticket');
    box.setAttribute('data-verdict', verdict);
    box.appendChild(el('h3', '', `${verb(verdict)} version ${view.version}`));
    box.appendChild(
      facts([
        ['Verdict', pastTense(verdict)],
        ['Version', `${view.version} of ${newest()}`],
        ['File', digestChip(decisionOptions.versionDigest)],
        ['As', plain(sessionEmail() ?? '')],
      ])
    );
    box.appendChild(
      el(
        'p',
        'decision-fine',
        'The decision is bound to this file. If the relic is republished, ' +
          'it stays with this version and does not carry over.'
      )
    );
    const actions = el('div', 'decision-actions');
    const go = pressable(
      'decision-confirm',
      working
        ? 'Waiting for your passkey'
        : `${verb(verdict)} version ${view.version} with your passkey`,
      () => confirmDecision(verdict, decisionOptions),
      ICON_KEY
    );
    go.setAttribute('data-verdict', verdict);
    go.setAttribute('data-decision-confirm', '');
    go.disabled = working;
    actions.appendChild(go);
    if (!working) {
      actions.appendChild(
        pressable('decision-secondary', 'Choose again', () => {
          step = { kind: 'choose' };
          paint();
        })
      );
    }
    box.appendChild(actions);
    if (working) {
      box.append(
        el('div', 'decision-waiting'),
        el(
          'p',
          'decision-fine',
          'Confirm on your device. Nothing is recorded until it answers.'
        )
      );
    }
    return box;
  };

  interface RefusalAction {
    readonly label: string;
    readonly run: () => void;
  }

  interface RefusalCopy {
    readonly title: string;
    readonly detail: string;
    readonly extra?: HTMLElement;
    readonly after?: string;
    readonly action?: RefusalAction;
  }

  const refusalCopy = (
    verdict: DecisionVerdict,
    outcome: Outcome
  ): RefusalCopy => {
    const retry = (label: string): RefusalAction => ({
      label,
      run: () => pickVerdict(verdict),
    });
    switch (outcome.code) {
      case 'decision_digest_mismatch':
        return {
          title: 'This page and the stored file differ',
          detail: mismatchCopy(view.version),
          ...(outcome.stored === undefined
            ? {}
            : {
                extra: facts([
                  ['This page', digestChip(view.versionDigest)],
                  ['Stored', digestChip(outcome.stored)],
                ]),
              }),
          after:
            'Reload the relic and look again. If they still differ, tell ' +
            'the publisher before anyone decides.',
          action: retry('Check again'),
        };
      case 'passkey_verification_failed':
        return {
          title: 'Your passkey did not verify',
          detail:
            'Relic could not confirm the answer from your passkey. Nothing ' +
            'was recorded.',
          action: retry('Try again'),
        };
      case 'decision_rate_limited':
      case 'passkey_rate_limited': {
        const seconds = outcome.retryAfterSeconds;
        const wait =
          seconds === undefined
            ? 'Try again later.'
            : `Try again in about ${Math.max(1, Math.ceil(seconds / 60))} ` +
              `minute${Math.ceil(seconds / 60) > 1 ? 's' : ''}.`;
        return {
          title: 'Too many requests from here just now',
          detail:
            'Relic limits how many decisions and passkey requests one ' +
            `network can make in an hour. Nothing was recorded. ${wait}`,
        };
      }
      case 'network':
        return {
          title: 'Relic could not be reached',
          detail:
            'The request did not complete, so it may or may not have been ' +
            'recorded. The list above is current; check it before trying ' +
            'again. A second identical decision changes nothing.',
          action: retry('Try again'),
        };
      case 'passkey_exists':
        return {
          title: 'This device already holds a passkey for this address',
          detail:
            'Use it to confirm the decision instead. Nothing was recorded.',
          action: retry('Try again'),
        };
      case 'passkeys_unsupported':
        return {
          title: 'This browser cannot use passkeys',
          detail:
            'A decision has to be confirmed with a passkey. Open this link ' +
            'in a browser that supports them. Nothing was recorded.',
        };
      case 'service_paused':
        return {
          title: 'Relic is paused',
          detail:
            'Relic is not taking decisions right now. Nothing was recorded.',
        };
      default:
        return {
          title: 'The decision was refused',
          detail: `Relic refused it with ${outcome.code}. Nothing was recorded.`,
          action: {
            label: 'Choose again',
            run: () => {
              step = { kind: 'choose' };
              paint();
            },
          },
        };
    }
  };

  const outcomeBlock = (
    verdict: DecisionVerdict,
    outcome: Outcome
  ): HTMLElement => {
    const box = el(
      'div',
      outcome.state === 'recorded' ? 'decision-outcome' : 'decision-refusal'
    );
    box.setAttribute('data-decision-outcome', '');
    box.setAttribute('data-state', outcome.state);
    box.setAttribute('data-code', outcome.code);
    box.setAttribute('role', outcome.state === 'error' ? 'alert' : 'status');
    box.tabIndex = -1;
    const record = outcome.record;
    if (outcome.state === 'recorded' && record !== undefined) {
      const stamp = el('figure', `decision-stamp is-${record.verdict}`);
      stamp.append(
        el('div', 'decision-stamp-verdict', pastTense(record.verdict)),
        el(
          'div',
          'decision-stamp-line',
          `Version ${record.version} \u00b7 sha256 ${record.version_digest.slice(0, 12)}`
        ),
        el(
          'div',
          'decision-stamp-line',
          `${plain(record.author)} \u00b7 ${when(record.created_at)} UTC`
        )
      );
      const actions = el('div', 'decision-actions');
      actions.append(
        pressable('action primary', 'Done', () => closePanel(true)),
        pressable('decision-secondary', 'Change my decision', () => {
          step = { kind: 'choose' };
          paint();
        })
      );
      box.append(
        stamp,
        el(
          'p',
          'decision-note',
          'Recorded. Anyone holding this link can read it. It cannot be ' +
            'edited or deleted; a later decision from you becomes your ' +
            'current one and this stays on the record.'
        ),
        actions
      );
      return box;
    }
    if (outcome.state === 'cancelled') {
      box.append(
        el('p', 'decision-refusal-title', DECISION_CANCELLED),
        el('p', '', 'The passkey prompt closed before it answered.')
      );
      const actions = el('div', 'decision-actions');
      const again = (): void => {
        if (outcome.from === 'decide') pickVerdict(verdict);
        else enterPasskey(verdict);
      };
      actions.append(
        pressable('action primary', 'Try again', again),
        pressable('decision-secondary', 'Choose again', () => {
          step = { kind: 'choose' };
          paint();
        })
      );
      box.appendChild(actions);
      if (outcome.from === 'decide') {
        // The usual reason a decision prompt closes with nothing: this
        // device holds no passkey for the address, which was set up on
        // another one. Adding one here asks for that one first.
        box.append(
          el(
            'p',
            'decision-fine',
            'No passkey for this address on this device? Add one here; your ' +
              'device asks for the existing one first.'
          ),
          pressable('decision-secondary', 'Add a passkey on this device', () =>
            enterPasskey(verdict)
          )
        );
      }
      return box;
    }
    const copy = refusalCopy(verdict, outcome);
    box.append(
      el('p', 'decision-refusal-title', copy.title),
      el('p', '', copy.detail)
    );
    if (copy.extra !== undefined) box.appendChild(copy.extra);
    if (copy.after !== undefined) box.appendChild(el('p', '', copy.after));
    if (copy.action !== undefined) {
      box.appendChild(
        pressable('action primary', copy.action.label, copy.action.run)
      );
    }
    box.appendChild(el('div', 'accession', outcome.code));
    return box;
  };

  const unavailableBlock = (): HTMLElement => {
    const box = el('div', 'decision-refusal');
    box.setAttribute('data-decision-outcome', '');
    box.setAttribute('data-state', 'error');
    box.setAttribute('data-code', 'decision_unavailable');
    box.setAttribute('role', 'status');
    box.append(
      el('p', 'decision-refusal-title', 'Decisions are not open here yet'),
      el('p', '', DECISION_UNAVAILABLE),
      el(
        'p',
        '',
        'Comments work as usual in the meantime, and none of them will count ' +
          'as a decision.'
      ),
      el('div', 'accession', 'decision_unavailable')
    );
    return box;
  };

  const body = (): HTMLElement => {
    const box = el('div', 'decision-body');
    box.append(...staleNotice());
    box.appendChild(el('p', 'decision-lead', DECISION_LEAD));
    if (list.kind === 'refused' && list.code === 'decision_unavailable') {
      box.appendChild(unavailableBlock());
      return box;
    }
    const recorded =
      step.kind === 'outcome' && step.outcome.state === 'recorded';
    if (step.kind === 'outcome' && recorded) {
      box.appendChild(outcomeBlock(step.verdict, step.outcome));
    }
    box.appendChild(listSection());
    if (recorded) return box;
    if (session === undefined) {
      box.appendChild(
        el('p', 'decision-fine', 'Checking whether this browser is verified.')
      );
      return box;
    }
    if (session.kind !== 'verified') {
      box.appendChild(signInSection());
      return box;
    }
    switch (step.kind) {
      case 'choose':
        box.appendChild(chooser(undefined));
        break;
      case 'asking':
        box.appendChild(chooser(step.verdict));
        break;
      case 'passkey':
        box.appendChild(passkeySection(step.verdict, step.passkey));
        break;
      case 'confirm':
        box.appendChild(ticket(step.verdict, false, step.options));
        break;
      case 'working':
        box.appendChild(ticket(step.verdict, true, step.options));
        break;
      case 'outcome': {
        const { code, state } = step.outcome;
        if (
          state === 'cancelled' ||
          code === 'network' ||
          code === 'passkey_verification_failed'
        ) {
          box.appendChild(
            identity(`${verb(step.verdict)} version ${view.version} as `)
          );
        }
        box.appendChild(outcomeBlock(step.verdict, step.outcome));
        break;
      }
    }
    return box;
  };

  const place = (): void => {
    const bar = document.querySelector?.('.bar');
    if (bar && typeof bar.getBoundingClientRect === 'function') {
      dialog.style.setProperty(
        '--decision-top',
        `${Math.round(bar.getBoundingClientRect().bottom)}px`
      );
    }
    if (typeof window.matchMedia !== 'function') return;
    // Beside the comment sidebar when it is open, and beside its edge tab
    // when it is closed, so the way into the comments is never under it.
    const wide = window.matchMedia('(min-width: 44.0625rem)').matches;
    const thread = document.getElementById('comment-thread');
    const edge = thread?.classList.contains('is-open')
      ? thread
      : document.querySelector<HTMLElement>('.relic-row > .thread-tab');
    const right =
      wide && edge !== null && edge !== undefined && edge.offsetWidth > 0
        ? Math.round(window.innerWidth - edge.getBoundingClientRect().left)
        : 0;
    dialog.style.setProperty('--decision-right', `${right}px`);
    dialog.style.width = `min(27rem, ${window.innerWidth - right}px)`;
  };

  /** Repaints the sheet, then moves focus to what the reader acts on next. */
  const paint = (focus: 'title' | 'step' = 'step'): void => {
    if (!open) return;
    const top = el('div');
    top.append(head(), body());
    dialog.replaceChildren(...Array.from(top.children));
    place();
    const target =
      focus === 'title'
        ? dialog.querySelector?.<HTMLElement>('.decision-title')
        : (dialog.querySelector?.<HTMLElement>('[data-decision-outcome]') ??
          dialog.querySelector?.<HTMLElement>(
            '[data-decision-confirm]:not([disabled]), [data-passkey-create]:not([disabled]), [data-passkey-add]:not([disabled]), [data-passkey-link-send]:not([disabled])'
          ));
    target?.focus?.({ preventScroll: true });
  };

  const showOutcome = (verdict: DecisionVerdict, outcome: Outcome): void => {
    step = { kind: 'outcome', verdict, outcome };
    paint();
  };

  const errorOutcome = (
    verdict: DecisionVerdict,
    reply: Reply,
    from: Outcome['from']
  ): void => {
    const stored = reply.body.version_digest;
    const retry = reply.body.retry_after_seconds;
    showOutcome(verdict, {
      state: 'error',
      code: reply.code,
      from,
      ...(isDigest(stored) ? { stored } : {}),
      ...(typeof retry === 'number' ? { retryAfterSeconds: retry } : {}),
    });
  };

  /** A session that lapsed mid-errand: back to the sign-in step. */
  const lapse = (): void => {
    session = { kind: 'anonymous' };
    lapsed = true;
    step = { kind: 'choose' };
    paint();
  };

  const settleList = (outcome: DecisionListOutcome): void => {
    list =
      outcome.kind === 'listed'
        ? {
            kind: 'listed',
            currentVersion: outcome.currentVersion,
            records: outcome.records,
          }
        : { kind: 'refused', code: outcome.code };
    if (list.kind === 'listed') {
      options.onTally(
        tallyOfEntries(decisionsByAuthor(list.records, view.version))
      );
    } else if (list.code === 'decision_unavailable') {
      options.onTally(null);
    }
  };

  const refreshList = async (): Promise<void> => {
    const outcome = await options.listDecisions();
    if (!open) return;
    settleList(outcome);
    paint();
  };

  /* ---------- the flow ---------- */

  /** Step 2: a verdict fetches the options for its ceremony. */
  function pickVerdict(verdict: DecisionVerdict): void {
    step = { kind: 'asking', verdict };
    paint();
    track(
      (async () => {
        const reply = await api(decisionsPath('/options'), {
          version: view.version,
          verdict,
          share_proof: await options.shareProof(),
        });
        if (!open) return;
        if (reply.ok) {
          const publicKey = parseRequestOptions(reply.body.public_key);
          const digest = reply.body.version_digest;
          if (publicKey === undefined || !isDigest(digest)) {
            showOutcome(verdict, {
              state: 'error',
              code: 'malformed_options',
              from: 'options',
            });
            return;
          }
          if (digest !== view.versionDigest) {
            // The service would bind the decision to a different file than
            // the one on this page. No ceremony runs, so nothing is signed.
            showOutcome(verdict, {
              state: 'error',
              code: 'decision_digest_mismatch',
              stored: digest,
              from: 'options',
            });
            return;
          }
          step = {
            kind: 'confirm',
            verdict,
            options: {
              version: view.version,
              versionDigest: digest,
              publicKey,
            },
          };
          paint();
          return;
        }
        if (reply.code === 'passkey_required') {
          enterPasskey(verdict);
          return;
        }
        if (needsSignIn(reply.code)) {
          lapse();
          return;
        }
        if (reply.code === 'decision_unavailable') {
          settleList({ kind: 'refused', code: reply.code });
          paint();
          return;
        }
        errorOutcome(verdict, reply, 'options');
      })()
    );
  }

  /** Step 3: no passkey on file, or none on this device. */
  function enterPasskey(verdict: DecisionVerdict): void {
    step = { kind: 'passkey', verdict, passkey: { phase: 'loading' } };
    paint();
    track(
      (async () => {
        const reply = await api('auth/passkeys/options', {});
        if (!open) return;
        if (!reply.ok) {
          if (reply.code === 'passkey_fresh_link_required') {
            step = {
              kind: 'passkey',
              verdict,
              passkey: { phase: 'link', state: 'required' },
            };
            paint();
            return;
          }
          if (needsSignIn(reply.code)) lapse();
          else errorOutcome(verdict, reply, 'passkey-create');
          return;
        }
        if (reply.body.mode === 'assert') {
          const request = parseRequestOptions(reply.body.public_key);
          if (request !== undefined) {
            step = {
              kind: 'passkey',
              verdict,
              passkey: { phase: 'add', options: request },
            };
            paint();
            return;
          }
        } else if (reply.body.mode === 'create') {
          const creation = parseCreationOptions(reply.body.public_key);
          if (creation !== undefined) {
            step = {
              kind: 'passkey',
              verdict,
              passkey: { phase: 'create', options: creation },
            };
            paint();
            return;
          }
        }
        showOutcome(verdict, {
          state: 'error',
          code: 'malformed_options',
          from: 'passkey-create',
        });
      })()
    );
  }

  function createPasskey(
    verdict: DecisionVerdict,
    creation: CreationOptionsJSON
  ): void {
    const api_ = credentials();
    if (api_ === undefined) {
      showOutcome(verdict, {
        state: 'error',
        code: 'passkeys_unsupported',
        from: 'passkey-create',
      });
      return;
    }
    // Called before anything is awaited, inside the press that asked for it.
    let pending: Promise<Credential | null>;
    try {
      pending = api_.create({
        publicKey: creationOptionsFromJSON(creation),
        signal: ceremonySignal(),
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    step = {
      kind: 'passkey',
      verdict,
      passkey: { phase: 'working', mode: 'create' },
    };
    paint();
    track(
      (async () => {
        let credential: Credential | null;
        try {
          credential = await pending;
        } catch (error) {
          if (!open) return;
          const code = ceremonyCode(error);
          showOutcome(verdict, {
            state: code === 'not_allowed' ? 'cancelled' : 'error',
            code,
            from: 'passkey-create',
          });
          return;
        }
        if (!open) return;
        if (credential === null) {
          showOutcome(verdict, {
            state: 'cancelled',
            code: 'not_allowed',
            from: 'passkey-create',
          });
          return;
        }
        let json: RegistrationResponseJSON;
        try {
          json = registrationResponseToJSON(credential);
        } catch {
          showOutcome(verdict, {
            state: 'error',
            code: 'passkey_failed',
            from: 'passkey-create',
          });
          return;
        }
        const reply = await api('auth/passkeys', { credential: json });
        if (!open) return;
        if (reply.ok) {
          pickVerdict(verdict);
          return;
        }
        if (
          reply.code === 'passkey_assertion_required' ||
          reply.code === 'passkey_required'
        ) {
          // Someone set up the first passkey in between, or the one this
          // flow asserted with is gone: ask the service which step it is.
          enterPasskey(verdict);
          return;
        }
        if (needsSignIn(reply.code)) {
          lapse();
          return;
        }
        errorOutcome(verdict, reply, 'passkey-create');
      })()
    );
  }

  function addPasskey(
    verdict: DecisionVerdict,
    request: RequestOptionsJSON
  ): void {
    const api_ = credentials();
    if (api_ === undefined) {
      showOutcome(verdict, {
        state: 'error',
        code: 'passkeys_unsupported',
        from: 'passkey-add',
      });
      return;
    }
    let pending: Promise<Credential | null>;
    try {
      pending = api_.get({
        publicKey: requestOptionsFromJSON(request),
        signal: ceremonySignal(),
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    step = {
      kind: 'passkey',
      verdict,
      passkey: { phase: 'working', mode: 'add' },
    };
    paint();
    track(
      (async () => {
        let credential: Credential | null;
        try {
          credential = await pending;
        } catch (error) {
          if (!open) return;
          const code = ceremonyCode(error);
          showOutcome(verdict, {
            state: code === 'not_allowed' ? 'cancelled' : 'error',
            code,
            from: 'passkey-add',
          });
          return;
        }
        if (!open) return;
        if (credential === null) {
          showOutcome(verdict, {
            state: 'cancelled',
            code: 'not_allowed',
            from: 'passkey-add',
          });
          return;
        }
        let json: AuthenticationResponseJSON;
        try {
          json = authenticationResponseToJSON(credential);
        } catch {
          showOutcome(verdict, {
            state: 'error',
            code: 'passkey_failed',
            from: 'passkey-add',
          });
          return;
        }
        const reply = await api('auth/passkeys/options', { credential: json });
        if (!open) return;
        if (reply.ok) {
          const creation = parseCreationOptions(reply.body.public_key);
          if (creation !== undefined) {
            step = {
              kind: 'passkey',
              verdict,
              passkey: { phase: 'asserted', options: creation },
            };
            paint();
            return;
          }
          showOutcome(verdict, {
            state: 'error',
            code: 'malformed_options',
            from: 'passkey-add',
          });
          return;
        }
        if (reply.code === 'passkey_required') {
          enterPasskey(verdict);
          return;
        }
        if (needsSignIn(reply.code)) {
          lapse();
          return;
        }
        errorOutcome(verdict, reply, 'passkey-add');
      })()
    );
  }

  /** Step 5: the ceremony, started synchronously inside the confirm press. */
  function confirmDecision(
    verdict: DecisionVerdict,
    decisionOptions: DecisionOptions
  ): void {
    const api_ = credentials();
    if (api_ === undefined) {
      showOutcome(verdict, {
        state: 'error',
        code: 'passkeys_unsupported',
        from: 'decide',
      });
      return;
    }
    let pending: Promise<Credential | null>;
    try {
      pending = api_.get({
        publicKey: requestOptionsFromJSON(decisionOptions.publicKey),
        signal: ceremonySignal(),
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    step = { kind: 'working', verdict, options: decisionOptions };
    paint();
    track(
      (async () => {
        let credential: Credential | null;
        try {
          credential = await pending;
        } catch (error) {
          if (!open) return;
          const code = ceremonyCode(error);
          showOutcome(verdict, {
            state: code === 'not_allowed' ? 'cancelled' : 'error',
            code,
            from: 'decide',
          });
          return;
        }
        if (!open) return;
        if (credential === null) {
          showOutcome(verdict, {
            state: 'cancelled',
            code: 'not_allowed',
            from: 'decide',
          });
          return;
        }
        let json: AuthenticationResponseJSON;
        try {
          json = authenticationResponseToJSON(credential);
        } catch {
          showOutcome(verdict, {
            state: 'error',
            code: 'passkey_failed',
            from: 'decide',
          });
          return;
        }
        const reply = await api(decisionsPath(''), {
          version: decisionOptions.version,
          verdict,
          share_proof: await options.shareProof(),
          // The digest of the bytes this page decrypted, never the service's
          // echo: the binding must not rest on the equality check above.
          version_digest: view.versionDigest,
          credential: json,
        });
        if (!open) return;
        if (reply.ok) {
          const record = parseRecord(reply.body);
          if (record === undefined) {
            showOutcome(verdict, {
              state: 'error',
              code: 'malformed_decision',
              from: 'decide',
            });
            return;
          }
          if (list.kind === 'listed') {
            const records = list.records.some((r) => r.id === record.id)
              ? list.records
              : [...list.records, record];
            settleList({
              kind: 'listed',
              currentVersion: list.currentVersion,
              records,
            });
          }
          showOutcome(verdict, {
            state: 'recorded',
            code: 'recorded',
            record,
            from: 'decide',
          });
          await refreshList();
          return;
        }
        if (reply.code === 'passkey_required') {
          enterPasskey(verdict);
          return;
        }
        if (needsSignIn(reply.code)) {
          lapse();
          return;
        }
        errorOutcome(verdict, reply, 'decide');
      })()
    );
  }

  /* ---------- lifetime ---------- */

  const recheck = async (): Promise<void> => {
    if (!open || session === undefined) return;
    const discovered = await options.readSession();
    if (!open) return;
    const before = session.kind === 'verified' ? session.email : session.kind;
    const after =
      discovered.kind === 'verified' ? discovered.email : discovered.kind;
    if (before === after) return;
    session = discovered;
    if (discovered.kind === 'verified') lapsed = false;
    if (step.kind === 'choose') paint();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void recheck();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePanel(true);
  };
  const onResize = (): void => place();

  const cleanUp = (refocus: boolean): void => {
    if (!open) return;
    open = false;
    channel?.close();
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener?.('resize', onResize);
    dialog.remove();
    opener.setAttribute('aria-expanded', 'false');
    if (refocus) opener.focus?.();
    options.onClose();
  };

  let refocusOnClose = true;
  function closePanel(refocus: boolean): void {
    refocusOnClose = refocus;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else cleanUp(refocus);
  }
  // However the sheet is left, teardown happens once, through `close`.
  dialog.addEventListener('close', () => cleanUp(refocusOnClose));

  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel('relic:auth');
    channel.addEventListener('message', () => {
      void recheck();
    });
  }
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('keydown', onKey);
  window.addEventListener?.('resize', onResize);
  const thread = document.getElementById?.('comment-thread');
  if (thread && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => place());
    observer.observe(thread, { attributes: true, attributeFilter: ['class'] });
  }

  document.body.appendChild(dialog);
  if (typeof dialog.show === 'function') dialog.show();
  else dialog.setAttribute('open', '');
  opener.setAttribute('aria-expanded', 'true');
  paint('title');

  const ready = Promise.all([
    options.listDecisions(),
    options.readSession(),
  ]).then(([listed, discovered]) => {
    if (!open) return;
    session = discovered;
    settleList(listed);
    paint('title');
  });

  return {
    element: dialog,
    ready,
    idle: () => inFlight,
    close: () => closePanel(true),
    setOpener: (next) => {
      opener = next;
      next.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
  };
}
