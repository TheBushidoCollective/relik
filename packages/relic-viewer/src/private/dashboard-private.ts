/**
 * The private-share part of the dashboard (section 4.15, mock
 * `[data-private-dashboard]`): device approval, the identity card and its
 * passkeys, devices, recovery, the owned and shared lists with coverage
 * repair, the access log, and the disclosure.
 */

import {
  formatFingerprint,
  type IdentityStateJSON,
  identityFingerprint,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { accessLogSection, formatUtcDay } from './access-log.ts';
import { deviceApprovalSection, devicesSection } from './devices.ts';
import {
  h,
  privateApi,
  problemMessage,
  setChildren,
  waiting,
  fingerprintGroups,
} from './fingerprint-input.ts';
import { bindPasskey } from './identity.ts';
import { privateKeysOf } from './ops.ts';
import { recoverySection, repairCoverage } from './recovery.ts';

export interface PrivateDashboardContext {
  readonly deps: ViewerDeps;
  /** The device enrollment named by `/dashboard?approve-device=<enrollmentId>`. */
  readonly approveDeviceEnrollmentId?: string;
}

const DISCLOSURE_LEAD = 'Private relics.';
const DISCLOSURE_BODY =
  ' A private relic\u2019s link carries no key. Each reader who is let in has their own copy of each version\u2019s key, encrypted to a key only their passkey can unlock; the service stores those encrypted copies and never the keys. To let someone in, the service records who asked and who granted, the email addresses involved, the public keys, and a signed record of each grant and revocation. It keeps an access log of requests, grants, revocations, key fetches and deletions for the owner, for the retention the owner sets. It also stores each person\u2019s private-share key encrypted under a secret held by their passkey. Private relics carry no title or cover, always expire, and their notification emails say only that there is activity on a relic. The JavaScript that decrypts them comes from this service, the same as for every relic.';

interface OwnedRelic {
  readonly relic_id: string;
  readonly current_version: number;
  readonly sealed_version: number | null;
  readonly expires_at: string;
  readonly pending_requests: number;
  readonly coverage_gaps?: readonly number[];
}

interface SharedRelic {
  readonly relic_id: string;
  readonly readable_versions: readonly number[];
  readonly expires_at: string;
  readonly owner: { readonly email: string };
}

/** Render the private-share dashboard into `host`. Every action re-renders it from the service. */
export function renderPrivateDashboard(
  host: HTMLElement,
  ctx: PrivateDashboardContext
): void {
  setChildren(
    host,
    h(
      'p',
      { class: 'dashboard-section-note' },
      'Loading your private-share key\u2026'
    )
  );
  void render(host, ctx);
}

async function render(
  host: HTMLElement,
  ctx: PrivateDashboardContext
): Promise<void> {
  try {
    const state = await privateKeysOf(ctx.deps).loadIdentityState(ctx.deps);
    const again = (): void => {
      void render(host, ctx);
    };
    const sections: HTMLElement[] = [];
    if (ctx.approveDeviceEnrollmentId) {
      sections.push(
        deviceApprovalSection(ctx.approveDeviceEnrollmentId, {
          deps: ctx.deps,
          state,
          onChanged: again,
        })
      );
    }
    if (!state.identity) {
      sections.push(
        h(
          'section',
          { class: 'dashboard-section', 'aria-labelledby': 'identity-title' },
          h(
            'h2',
            { class: 'dashboard-section-title', id: 'identity-title' },
            'Private-share key'
          ),
          h(
            'p',
            { class: 'dashboard-section-note' },
            'You have no private-share key yet. Open a private relic shared with you to set one up.'
          )
        )
      );
    } else {
      sections.push(identitySection(ctx, state, again));
      sections.push(
        devicesSection({ deps: ctx.deps, state, onChanged: again })
      );
      sections.push(
        recoverySection({ deps: ctx.deps, state, onChanged: again })
      );
      sections.push(...(await relicSections(ctx, state, again)));
      sections.push(
        accessLogSection({ deps: ctx.deps, state, onChanged: again })
      );
      sections.push(disclosure());
    }
    setChildren(
      host,
      h('div', { 'data-private-dashboard': true }, ...sections)
    );
  } catch (error) {
    setChildren(
      host,
      h('p', { class: 'dashboard-section-note' }, problemMessage(error))
    );
  }
}

function disclosure(): HTMLElement {
  return h(
    'details',
    { class: 'disclosure' },
    h('summary', {}, 'What Relic records about private relics'),
    h('blockquote', {}, h('strong', {}, DISCLOSURE_LEAD), DISCLOSURE_BODY)
  );
}

function identitySection(
  ctx: PrivateDashboardContext,
  state: IdentityStateJSON,
  again: () => void
): HTMLElement {
  const identity = state.identity;
  if (!identity) throw new Error('identity section needs a private-share key');
  const fingerprint = h('p', {
    class: 'fingerprint',
    'data-fingerprint': 'identity',
    'aria-labelledby': 'fp-identity-caption',
  });
  const outcome = h('p', {
    class: 'dash-outcome',
    id: 'bind-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const reveal = h(
    'button',
    { type: 'button', class: 'btn', 'data-reveal-fingerprint': 'identity' },
    'Unlock with passkey to show it'
  );
  reveal.addEventListener('click', () => {
    void revealFingerprint(ctx.deps, state, reveal, fingerprint, outcome);
  });
  const passkeys = h(
    'ul',
    { class: 'row-list', id: 'passkeys' },
    ...state.passkeys.map((passkey) => {
      const tail = passkey.credential_id.slice(-6);
      const button = h(
        'button',
        {
          type: 'button',
          class: 'btn is-small',
          'aria-label': `Bind passkey ending ${tail}`,
        },
        'Bind'
      );
      button.addEventListener('click', () => {
        void bind(ctx, state, button, outcome, again);
      });
      return h(
        'li',
        {},
        h(
          'span',
          { class: 'row-main' },
          h('strong', {}, `Passkey ending ${tail}`),
          h(
            'span',
            { class: 'row-meta' },
            passkey.bound
              ? 'Holds your key.'
              : 'Signs you in, but doesn\u2019t hold your key yet.'
          )
        ),
        passkey.bound ? h('span', { class: 'row-kind' }, 'Bound') : button
      );
    })
  );
  return h(
    'section',
    { class: 'dashboard-section', 'aria-labelledby': 'identity-title' },
    h(
      'h2',
      { class: 'dashboard-section-title', id: 'identity-title' },
      'Private-share key'
    ),
    h(
      'p',
      { class: 'dashboard-session-info' },
      `Signed in as ${identity.email}`
    ),
    h(
      'p',
      { class: 'fp-caption', id: 'fp-identity-caption' },
      'Your fingerprint'
    ),
    reveal,
    fingerprint,
    h(
      'p',
      { class: 'dashboard-section-note', style: 'margin-top:0.75rem' },
      'People you share with and agents you approve compare this with what their screen shows. Read it to them; don\u2019t send it by email or chat.'
    ),
    h('h3', { class: 'dash-sub' }, 'Passkeys'),
    passkeys,
    outcome
  );
}

/**
 * Unlocks the key in this page, then shows the fingerprint computed from that
 * unlocked identity. The service's identity ID is never shown unverified.
 */
async function revealFingerprint(
  deps: ViewerDeps,
  state: IdentityStateJSON,
  button: HTMLButtonElement,
  fingerprint: HTMLElement,
  outcome: HTMLElement
): Promise<void> {
  const restore = waiting(button, 'First tap');
  try {
    const identity = await privateKeysOf(deps).unlock(deps, state);
    const value = await identityFingerprint(
      identity.identityId,
      identity.email
    );
    restore();
    setChildren(fingerprint, ...fingerprintGroups(formatFingerprint(value)));
    button.hidden = true;
  } catch (error) {
    restore();
    outcome.className = 'dash-outcome is-bad';
    setChildren(outcome, problemMessage(error));
  }
}

async function bind(
  ctx: PrivateDashboardContext,
  state: IdentityStateJSON,
  button: HTMLButtonElement,
  outcome: HTMLElement,
  again: () => void
): Promise<void> {
  const restore = waiting(button, 'First tap');
  try {
    const identity = await privateKeysOf(ctx.deps).unlock(ctx.deps, state);
    restore();
    const bound = await bindPasskey(ctx.deps, identity);
    outcome.className = 'dash-outcome is-ok';
    setChildren(
      outcome,
      `Passkey ending ${bound.credentialId.slice(-6)} now holds your key.`
    );
    again();
  } catch (error) {
    restore();
    outcome.className = 'dash-outcome is-bad';
    setChildren(outcome, problemMessage(error));
  }
}

async function relicSections(
  ctx: PrivateDashboardContext,
  state: IdentityStateJSON,
  again: () => void
): Promise<HTMLElement[]> {
  const answer = await privateApi<{
    owned: OwnedRelic[];
    shared_with_me: SharedRelic[];
  }>(ctx.deps, 'GET', '/api/identity/relics?coverage=1');
  const gaps = answer.owned.filter(
    (relic) => (relic.coverage_gaps ?? []).length > 0
  );
  const missing = gaps.reduce(
    (total, relic) => total + (relic.coverage_gaps ?? []).length,
    0
  );
  const holder = state.identity?.recovery ?? null;
  const repairOutcome = h('p', {
    class: 'dash-outcome',
    id: 'coverage-repair-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const repair = h(
    'button',
    { type: 'button', class: 'btn is-small', 'data-action': 'repair-coverage' },
    'Repair'
  );
  if (holder) {
    repair.addEventListener('click', () => {
      const restore = waiting(repair, 'Repairing');
      void repairCoverage(ctx.deps, state, holder)
        .then((result) => {
          restore();
          repairOutcome.className = 'dash-outcome is-ok';
          setChildren(
            repairOutcome,
            `Repaired ${result.stored} wrap${result.stored === 1 ? '' : 's'} for ${holder.email}.${result.refused.length === 0 ? '' : ` Skipped ${result.refused.length} relic${result.refused.length === 1 ? '' : 's'} whose versions belong to another owner.`}`
          );
          again();
        })
        .catch((error: unknown) => {
          restore();
          repairOutcome.className = 'dash-outcome is-bad';
          setChildren(repairOutcome, problemMessage(error));
        });
    });
  }
  const holderName = holder?.email ?? 'your recovery key holder';
  const gapText =
    missing === 1
      ? `1 version of 1 relic can\u2019t be read by ${holderName} yet.`
      : `${missing} versions of ${gaps.length} relic${gaps.length === 1 ? '' : 's'} can\u2019t be read by ${holderName} yet.`;
  return [
    h(
      'section',
      { class: 'dashboard-section', 'aria-labelledby': 'owned-title' },
      h(
        'h2',
        { class: 'dashboard-section-title', id: 'owned-title' },
        'Private relics you own'
      ),
      h(
        'p',
        { class: 'dashboard-section-note' },
        'Private relics have no title, so they\u2019re listed by catalog number. Open one to see what it is.'
      ),
      gaps.length > 0 && holder
        ? h(
            'div',
            { class: 'gap-banner', id: 'coverage-gap' },
            h('span', { id: 'coverage-text' }, gapText),
            repair
          )
        : null,
      repairOutcome,
      h(
        'ul',
        { class: 'row-list', id: 'owned' },
        ...answer.owned.map((relic) => ownedRow(relic))
      )
    ),
    h(
      'section',
      { class: 'dashboard-section', 'aria-labelledby': 'shared-title' },
      h(
        'h2',
        { class: 'dashboard-section-title', id: 'shared-title' },
        'Private relics shared with you'
      ),
      h(
        'ul',
        { class: 'row-list', id: 'shared' },
        ...answer.shared_with_me.map((relic) => sharedRow(relic))
      )
    ),
  ];
}

function ownedRow(relic: OwnedRelic): HTMLElement {
  const waiting =
    relic.pending_requests > 0
      ? ` \u00b7 ${relic.pending_requests} waiting`
      : '';
  return h(
    'li',
    {},
    h(
      'span',
      { class: 'row-main' },
      h(
        'a',
        {
          class: 'is-mono',
          href: `/${relic.relic_id}`,
          style: 'font-size:0.82rem;word-break:break-all',
        },
        relic.relic_id
      ),
      h(
        'span',
        { class: 'row-meta' },
        `v${relic.current_version}${waiting} \u00b7 expires ${formatUtcDay(relic.expires_at)}`
      )
    )
  );
}

function sharedRow(relic: SharedRelic): HTMLElement {
  return h(
    'li',
    {},
    h(
      'span',
      { class: 'row-main' },
      h(
        'a',
        {
          class: 'is-mono',
          href: `/${relic.relic_id}`,
          style: 'font-size:0.82rem;word-break:break-all',
        },
        relic.relic_id
      ),
      h(
        'span',
        { class: 'row-meta' },
        `From ${relic.owner.email} \u00b7 versions ${relic.readable_versions.join(', ')} \u00b7 expires ${formatUtcDay(relic.expires_at)}`
      )
    )
  );
}
