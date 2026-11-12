/**
 * Recovery key holder (section 4.12 and 4.15, mock "Recovery" section). The
 * holder is an ordinary Relic identity, designated by typing its fingerprint.
 * Every reader can see who it is. Designating a holder, or repairing coverage
 * after one changes, wraps existing versions to the holder from this browser.
 */

import {
  type BackfillWrapJSON,
  identityFingerprint,
  type IdentityStateJSON,
  type PartyJSON,
  type RecoveryJSON,
  wrapVersionKey,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import {
  h,
  privateApi,
  problemMessage,
  setChildren,
  type TypedFingerprint,
  typedFingerprint,
  waiting,
} from './fingerprint-input.ts';
import {
  attest,
  fetchVersionKey,
  type UnlockedIdentity,
  unlock,
} from './keys.ts';
import { verifiedPartyKeys } from './rekey.ts';

/** Most wraps one backfill call may carry (config `privateBackfillMaxWraps`). */
const BACKFILL_MAX_WRAPS = 2000;

export interface RecoveryContext {
  readonly deps: ViewerDeps;
  readonly state: IdentityStateJSON;
  /** Called after the holder changes or coverage is repaired. */
  onChanged(message: string): void;
}

/** A relic whose versions the recovery holder cannot read yet. */
export interface CoverageGap {
  readonly relic_id: string;
  readonly coverage_gaps?: readonly number[];
}

/** Wrap every missing version of each relic to the holder. Returns counts from the service. */
export async function backfillHolder(
  deps: ViewerDeps,
  identity: UnlockedIdentity,
  holder: PartyJSON,
  gaps: readonly CoverageGap[]
): Promise<{ readonly stored: number; readonly skipped: number }> {
  const keys = await verifiedPartyKeys(holder);
  const wraps: BackfillWrapJSON[] = [];
  for (const relic of gaps) {
    for (const version of relic.coverage_gaps ?? []) {
      const { key } = await fetchVersionKey(
        deps,
        relic.relic_id,
        version,
        identity
      );
      const wrap = await wrapVersionKey({
        recipientPublicKey: keys.kemPublicKey,
        relicId: relic.relic_id,
        version,
        key,
      });
      wraps.push({
        relic_id: relic.relic_id,
        recipient_key_id: wrap.recipientKeyId,
        version,
        enc: wrap.enc,
        ct: wrap.ct,
      });
    }
  }
  let stored = 0;
  let skipped = 0;
  for (let start = 0; start < wraps.length; start += BACKFILL_MAX_WRAPS) {
    const answer = await privateApi<{ stored: number; skipped: number }>(
      deps,
      'POST',
      '/api/identity/backfill',
      { wraps: wraps.slice(start, start + BACKFILL_MAX_WRAPS) }
    );
    stored += answer.stored;
    skipped += answer.skipped;
  }
  return { stored, skipped };
}

/** The owned relics that have coverage gaps for the current holder. */
export async function coverageGaps(deps: ViewerDeps): Promise<CoverageGap[]> {
  const answer = await privateApi<{ owned: CoverageGap[] }>(
    deps,
    'GET',
    '/api/identity/relics?coverage=1'
  );
  return answer.owned.filter((relic) => (relic.coverage_gaps ?? []).length > 0);
}

/** Repair coverage for the current holder with one passkey tap. */
export async function repairCoverage(
  deps: ViewerDeps,
  state: IdentityStateJSON,
  holder: RecoveryJSON
): Promise<{ readonly stored: number; readonly skipped: number }> {
  const identity = await unlock(deps, state);
  return backfillHolder(deps, identity, holder, await coverageGaps(deps));
}

/** The recovery section: the current holder, the lookup, and designate or remove. */
export function recoverySection(ctx: RecoveryContext): HTMLElement {
  const identity = ctx.state.identity;
  if (!identity) throw new Error('recovery needs a private-share key');
  const current = h('div', { id: 'recovery-current' });
  const lookupOutcome = h('p', {
    class: 'dash-outcome',
    id: 'recovery-lookup-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const outcome = h('p', {
    class: 'dash-outcome',
    id: 'recovery-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const found = h('div', {
    class: 'found-party',
    id: 'recovery-found',
    hidden: true,
  });
  const emailInput = h('input', {
    class: 'compose-input',
    type: 'email',
    'data-recovery-email': true,
    autocomplete: 'off',
  });
  const lookup = h(
    'button',
    { type: 'submit', class: 'btn', 'data-action': 'recovery-lookup' },
    'Look up'
  );
  const form = h(
    'form',
    { class: 'inline-form', id: 'recovery-lookup-form' },
    h(
      'label',
      { class: 'compose-field' },
      h(
        'span',
        { id: 'recovery-email-label' },
        identity.recovery ? 'Change to' : 'Recovery address'
      ),
      emailInput
    ),
    lookup
  );

  let holder: PartyJSON | undefined;
  let field: TypedFingerprint | undefined;
  const designate = h(
    'button',
    {
      type: 'button',
      class: 'action primary',
      'data-action': 'designate-recovery',
      disabled: true,
    },
    'Designate with passkey'
  );

  function removeButton(): HTMLButtonElement {
    const button = h(
      'button',
      {
        type: 'button',
        class: 'btn is-small is-danger',
        'aria-label': 'Remove the recovery key holder',
      },
      'Remove'
    );
    button.addEventListener('click', () => {
      void designateWith(
        button,
        null,
        'Removed. The recovery key holder can\u2019t read your private relics any more, and its keys for them are deleted.'
      );
    });
    return button;
  }

  setChildren(
    current,
    h(
      'ul',
      { class: 'row-list', style: 'margin-bottom:1rem' },
      h(
        'li',
        {},
        h(
          'span',
          { class: 'row-main' },
          h(
            'strong',
            {},
            identity.recovery
              ? identity.recovery.email
              : 'No recovery key holder'
          ),
          h(
            'span',
            { class: 'row-meta' },
            identity.recovery
              ? 'Designated. Can read every private relic you own.'
              : 'If you lose every passkey, no one can open your private relics.'
          )
        ),
        identity.recovery ? removeButton() : null
      )
    )
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void lookupParty(emailInput.value.trim().toLowerCase());
  });

  async function lookupParty(email: string): Promise<void> {
    found.hidden = true;
    lookupOutcome.className = 'dash-outcome';
    setChildren(lookupOutcome, 'Looking up');
    try {
      const answer = await privateApi<{ party: PartyJSON | null }>(
        ctx.deps,
        'POST',
        '/api/identity/recovery/lookup',
        { email }
      );
      if (!answer.party) {
        lookupOutcome.className = 'dash-outcome is-bad';
        setChildren(
          lookupOutcome,
          `${email || 'That address'} has no private-share key. They need to open a private relic and set one up first.`
        );
        return;
      }
      if (answer.party.identity.identity_id === identity?.identity_id) {
        lookupOutcome.className = 'dash-outcome is-bad';
        setChildren(
          lookupOutcome,
          'That is your own address. Choose someone else to hold recovery.'
        );
        return;
      }
      await verifiedPartyKeys(answer.party);
      holder = answer.party;
      const expected = await identityFingerprint(
        answer.party.identity.identity_id,
        answer.party.email
      );
      field = typedFingerprint({
        id: 'recovery-fp',
        label: 'Fingerprint they read to you',
        inputHook: 'data-recovery-fingerprint-input',
        placeholder: '32 characters',
        expected,
        who: answer.party.email,
      });
      const typed = field;
      typed.onChange((state) => {
        designate.disabled = state !== 'match';
      });
      setChildren(lookupOutcome, '');
      setChildren(
        found,
        h(
          'p',
          {},
          h('strong', { id: 'recovery-found-email' }, answer.party.email),
          ' has a private-share key. Ask them to read you their fingerprint on a phone or video call, then type it.'
        ),
        typed.element,
        h('div', {}, designate)
      );
      found.hidden = false;
    } catch (error) {
      lookupOutcome.className = 'dash-outcome is-bad';
      setChildren(lookupOutcome, problemMessage(error));
    }
  }

  designate.addEventListener('click', () => {
    const typed = field?.matched();
    if (!holder || !typed) return;
    void designateWith(
      designate,
      holder,
      `${holder.email} can now read every private relic you own.`,
      typed
    );
  });

  async function designateWith(
    button: HTMLButtonElement,
    next: PartyJSON | null,
    success: string,
    typed?: string
  ): Promise<void> {
    const restore = waiting(button);
    const at = Date.now();
    try {
      const tapped = await attest(ctx.deps, {
        purpose: 'recovery_designate',
        build: (identityId) => [
          {
            kind: 'recovery_designation',
            statement: {
              at,
              fingerprint_typed: typed ?? null,
              owner_identity_id: identityId,
              recovery_email: next?.email ?? null,
              recovery_identity_id: next?.identity.identity_id ?? null,
            },
          },
        ],
      });
      await privateApi(ctx.deps, 'POST', '/api/identity/recovery', {
        attestation: tapped.bundle,
      });
      let message = success;
      if (next) {
        const result = await backfillHolder(
          ctx.deps,
          tapped.identity,
          next,
          await coverageGaps(ctx.deps)
        );
        message = `${success} Wrapped ${result.stored} existing version${result.stored === 1 ? '' : 's'} for them.`;
        found.hidden = true;
      }
      restore();
      outcome.className = 'dash-outcome is-ok';
      setChildren(outcome, message);
      ctx.onChanged(message);
    } catch (error) {
      restore();
      outcome.className = 'dash-outcome is-bad';
      setChildren(outcome, problemMessage(error));
    }
  }

  return h(
    'section',
    { class: 'dashboard-section', 'aria-labelledby': 'recovery-title' },
    h(
      'h2',
      { class: 'dashboard-section-title', id: 'recovery-title' },
      'Recovery'
    ),
    h(
      'p',
      { class: 'dashboard-section-note' },
      'A recovery key holder can read every private relic you own, so losing your passkeys doesn\u2019t lose them. Use a person you trust, or your own security key kept somewhere safe. Every reader can see who it is.'
    ),
    current,
    form,
    lookupOutcome,
    found,
    outcome
  );
}
