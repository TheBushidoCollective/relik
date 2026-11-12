/**
 * The access log and its retention setting (section 4.7, 4.11, mock
 * `#access-log` and `#retention-form`). Events are the owner's record of
 * requests, grants, revocations, key fetches and deletions. Retention is an
 * identity setting, signed with the passkey, between 30 days and 10 years.
 *
 * Also holds the two text formatters the owner surfaces share, so no module
 * imports another for them.
 */

import type { AccessEventJSON, IdentityStateJSON } from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { attest } from './keys.ts';
import {
  h,
  privateApi,
  problemMessage,
  setChildren,
  waiting,
} from './fingerprint-input.ts';

export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 3650;

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const MINUTE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

/** A day in UTC, for example "11 Nov 2026". */
export function formatUtcDay(value: string | number): string {
  return DAY.format(new Date(value));
}

/** A timestamp in UTC to the minute, for example "11 Nov 2026, 14:02". */
export function formatUtcMinute(value: string | number): string {
  return MINUTE.format(new Date(value));
}

/** Plain text for a version list: "1, 3 and 4". */
export function describeVersions(versions: readonly number[]): string {
  if (versions.length <= 1) return versions.map(String).join('');
  return `${versions.slice(0, -1).join(', ')} and ${versions[versions.length - 1]}`;
}

const KIND_LABEL: Readonly<Record<AccessEventJSON['kind'], string>> = {
  request: 'Access requested',
  grant: 'Access granted',
  revoke: 'Access revoked',
  wrap_fetch: 'Key fetched',
  delete: 'Deleted',
};

function actorLabel(event: AccessEventJSON, me: string): string {
  if (event.actor.identity_id === me) return 'by you';
  if (event.actor.email) return `by ${event.actor.email}`;
  if (event.actor.device_id)
    return `by a device, ${event.actor.device_id.slice(0, 8)}`;
  return 'by the service';
}

/** One row of the log: the time, what happened, and the parties and version. */
export function accessEventItem(
  event: AccessEventJSON,
  me: string
): HTMLLIElement {
  const subject = event.subject_identity_id
    ? `, identity ${event.subject_identity_id.slice(0, 8)}`
    : '';
  const version = event.version === null ? '' : `version ${event.version} of `;
  return h(
    'li',
    { 'data-access-event': event.kind },
    h('time', { datetime: event.at }, `${formatUtcMinute(event.at)} UTC`),
    h('span', { class: 'what' }, KIND_LABEL[event.kind]),
    h(
      'span',
      { class: 'about' },
      `${version}${event.relic_id.slice(0, 8)}${subject}, ${actorLabel(event, me)}`
    )
  );
}

export interface AccessLogContext {
  readonly deps: ViewerDeps;
  readonly state: IdentityStateJSON;
  /** Called with the outcome line after retention is saved. */
  onChanged(message: string): void;
}

/** The access-log section: the log list and the retention form. */
export function accessLogSection(ctx: AccessLogContext): HTMLElement {
  const identity = ctx.state.identity;
  const me = identity?.identity_id ?? '';
  const log = h('ol', {
    class: 'log',
    'data-access-log': true,
    id: 'access-log',
  });
  const days = identity?.access_log_retention_days ?? 2190;
  const input = h('input', {
    class: 'compose-input is-mono',
    type: 'number',
    inputmode: 'numeric',
    min: String(RETENTION_MIN_DAYS),
    max: String(RETENTION_MAX_DAYS),
    step: '1',
    value: String(days),
    'data-retention-days': true,
    'aria-describedby': 'retention-help',
  });
  const save = h(
    'button',
    { type: 'submit', class: 'btn', 'data-action': 'save-retention' },
    'Save with passkey'
  );
  const outcome = h('p', {
    class: 'dash-outcome',
    id: 'retention-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const form = h(
    'form',
    { class: 'inline-form', id: 'retention-form', novalidate: true },
    h(
      'label',
      { class: 'compose-field retention-field' },
      h('span', {}, 'Keep entries for (days)'),
      input
    ),
    save
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveRetention(ctx, identity?.identity_id ?? '', input, save, outcome);
  });

  void loadLog(ctx.deps, log, me);

  return h(
    'section',
    { class: 'dashboard-section', 'aria-labelledby': 'log-title' },
    h(
      'h2',
      { class: 'dashboard-section-title', id: 'log-title' },
      'Access log'
    ),
    h(
      'p',
      { class: 'dashboard-section-note' },
      'Requests, grants, revocations, key fetches and deletions on your private relics. Kept after a relic is deleted, for the retention below.'
    ),
    log,
    h('h3', { class: 'dash-sub' }, 'Retention'),
    form,
    h(
      'p',
      {
        class: 'dashboard-section-note',
        id: 'retention-help',
        style: 'margin:0.6rem 0 0',
      },
      `Between 30 days and 10 years. ${days} days is ${Math.round(days / 365)} years. A change applies to entries written from then on.`
    ),
    outcome
  );
}

async function loadLog(
  deps: ViewerDeps,
  log: HTMLElement,
  me: string
): Promise<void> {
  try {
    const answer = await privateApi<{ events: AccessEventJSON[] }>(
      deps,
      'GET',
      '/api/identity/access-log'
    );
    setChildren(
      log,
      ...answer.events.map((event) => accessEventItem(event, me))
    );
  } catch (error) {
    setChildren(log, h('li', { class: 'what' }, problemMessage(error)));
  }
}

async function saveRetention(
  ctx: AccessLogContext,
  identityId: string,
  input: HTMLInputElement,
  save: HTMLButtonElement,
  outcome: HTMLElement
): Promise<void> {
  const days = Number(input.value);
  if (
    !Number.isInteger(days) ||
    days < RETENTION_MIN_DAYS ||
    days > RETENTION_MAX_DAYS
  ) {
    outcome.className = 'dash-outcome is-bad';
    setChildren(
      outcome,
      `Choose a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}. Nothing was changed.`
    );
    return;
  }
  const restore = waiting(save);
  const at = Date.now();
  try {
    const tapped = await attest(ctx.deps, {
      purpose: 'identity_settings',
      build: () => [
        {
          kind: 'identity_settings',
          statement: {
            access_log_retention_days: days,
            at,
            identity_id: identityId,
          },
        },
      ],
    });
    const answer = await privateApi<{ access_log_retention_days: number }>(
      ctx.deps,
      'POST',
      '/api/identity/settings',
      {
        attestation: tapped.bundle,
      }
    );
    restore();
    outcome.className = 'dash-outcome is-ok';
    setChildren(
      outcome,
      `Saved. Entries are kept for ${answer.access_log_retention_days} days from now on.`
    );
    ctx.onChanged('');
  } catch (error) {
    restore();
    outcome.className = 'dash-outcome is-bad';
    setChildren(outcome, problemMessage(error));
  }
}
