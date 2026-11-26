/**
 * The Share section of the owner's access panel (mock `shareSection`, the
 * links panel `linksSection`). The owner types addresses, sees each one's
 * state, picks versions and taps the passkey once. Registered people are
 * granted at once; addresses with no key are invited. The invitation links
 * appear after the tap, once, and are dropped when the owner is done with them.
 */

import { composeInviteEmail, shareMailtoUrl } from '@relic/format';
import {
  formatFingerprint,
  type PrivateAccessJSON,
} from '@relic/format/private';
import { copyText } from '../popover.ts';
import type { ViewerDeps } from '../viewer.ts';
import { describeVersions, formatUtcDay } from './access-log.ts';
import {
  fingerprintGroups,
  h,
  problemMessage,
  setChildren,
  waiting,
} from './fingerprint-input.ts';
import {
  type GrantTarget,
  INVITE_DAYS_DEFAULT,
  INVITE_DAYS_MAX,
  INVITE_DAYS_MIN,
  type InviteLink,
  lookupShares,
  type ShareRow,
  shareBatch,
} from './direct-share.ts';
import { VerificationRefusedError } from './refusal.ts';

/** A row in the section: a typed address, its state, and what the owner chose for it. */
interface ShareDraft {
  readonly row: ShareRow;
  on: boolean;
  days: number;
}

/** A link that has been shown and is no longer held: only its address and dates remain. */
interface SentLink {
  readonly inviteId: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly versions: readonly number[];
}

export interface ShareSectionData {
  readonly access: PrivateAccessJSON;
  readonly admitted: ReadonlySet<string>;
}

export interface ShareSectionOptions {
  readonly relicId: string;
  readonly deps: ViewerDeps;
  /** Called after a grant or an invitation was made, with the notice to show. */
  readonly onChanged: (message: string) => void;
  /** Addresses from `?access=share#to=`: filled in for the owner to add, never looked up on their own. */
  readonly prefill?: readonly string[];
}

export interface ShareSection {
  /** The Share section, as a panel section. */
  readonly element: HTMLElement;
  /** The links panel: shown once after a tap, empty otherwise. */
  readonly links: HTMLElement;
  update(data: ShareSectionData): void;
  /** Puts addresses in the add field, for the owner to look up. */
  fill(emails: readonly string[]): void;
}

const isRegistered = (
  row: ShareRow
): row is Extract<ShareRow, { party: unknown }> =>
  row.kind === 'registered' || row.kind === 'invited';

/** Matches a typed address against the rows already listed, without case. */
function listed(drafts: readonly ShareDraft[], email: string): boolean {
  const wanted = email.toLowerCase();
  return drafts.some((draft) => draft.row.email.toLowerCase() === wanted);
}

/** The lifetime field's value, or the reason it is refused. */
function parseLifetime(text: string): { days: number } | { error: string } {
  const value = text.trim();
  const days = Number(value);
  if (
    !/^\d+$/.test(value) ||
    days < INVITE_DAYS_MIN ||
    days > INVITE_DAYS_MAX
  ) {
    return {
      error: `Enter a whole number of days from ${INVITE_DAYS_MIN} to ${INVITE_DAYS_MAX}.`,
    };
  }
  return { days };
}

function dayOption(days: number, selected: number): HTMLOptionElement {
  return h(
    'option',
    { value: String(days), selected: days === selected },
    days === 1 ? '1 day' : `${days} days`
  );
}

export function createShareSection(options: ShareSectionOptions): ShareSection {
  const { relicId, deps } = options;
  const rows: ShareDraft[] = [];
  let versions = new Set<number>();
  let seeded = false;
  let grantable: number[] = [];
  let expiresAt = 0;
  let admitted: ReadonlySet<string> = new Set();
  let ownerId: string | undefined;
  let lifetimeText = String(INVITE_DAYS_DEFAULT);
  let busy = false;
  let links: InviteLink[] = [];
  let sent: SentLink[] = [];
  let linksGone = false;

  const versionsHost = h('div', { class: 'version-picks' });
  const lifetimeInput = h('input', {
    class: 'input',
    id: 'lt-days',
    'data-lifetime-days': true,
    inputmode: 'numeric',
    value: lifetimeText,
    'aria-describedby': 'lt-err',
  });
  const lifetimeError = h('p', { class: 'err', id: 'lt-err', role: 'alert' });
  const lifetimeBlock = h(
    'div',
    { class: 'lifetime', 'data-lifetime': true },
    h(
      'div',
      { class: 'lifetime-row' },
      h('label', { for: 'lt-days' }, 'New invitations stay open for'),
      lifetimeInput,
      h('span', {}, 'days')
    ),
    lifetimeError,
    h(
      'p',
      { class: 'hint' },
      `${INVITE_DAYS_DEFAULT} days unless you change it, from ${INVITE_DAYS_MIN} to ${INVITE_DAYS_MAX}. Never past the relik's own expiry.`
    )
  );
  const addInput = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'email',
    autocomplete: 'email',
    spellcheck: 'false',
    placeholder: 'name@example.com',
    'aria-label': 'Email address to share with',
    'data-share-input': true,
  });
  const addButton = h(
    'button',
    { type: 'button', class: 'btn', 'data-add-address': true },
    'Add'
  );
  const addError = h('p', {
    class: 'err',
    role: 'alert',
    'data-share-err': true,
  });
  const rowsHost = h('ul', { class: 'row-list', 'data-share-rows': true });
  const summary = h('p', { class: 'share-sum', 'data-share-summary': true });
  const shareButton = h(
    'button',
    {
      type: 'button',
      class: 'action primary',
      'data-action': 'share-passkey',
      disabled: true,
    },
    'Share with passkey'
  );
  const noticeHost = h('div', { hidden: true });
  const linksHost = h('section', {
    class: 'panel-section',
    'data-invite-links': true,
    hidden: true,
  });

  const element = h(
    'section',
    { class: 'panel-section', 'data-share-section': true },
    h('h3', {}, 'Share'),
    noticeHost,
    h(
      'p',
      { class: 'panel-lead' },
      "Type each person's email. People with a key are shared with at once. People without one are invited."
    ),
    h(
      'fieldset',
      { class: 'versions' },
      h('legend', {}, 'Versions they can open'),
      versionsHost
    ),
    h('div', { class: 'add-row' }, addInput, addButton),
    addError,
    rowsHost,
    lifetimeBlock,
    h(
      'div',
      { class: 'share-foot' },
      summary,
      h('div', {}, shareButton),
      h(
        'p',
        { class: 'passkey-note' },
        'Your passkey signs each grant and invitation. Relik never sees a key.'
      )
    )
  );

  function selectedGrants(): GrantTarget[] {
    return rows.flatMap((draft) =>
      draft.on && isRegistered(draft.row)
        ? [{ party: draft.row.party, fingerprint: draft.row.fingerprint }]
        : []
    );
  }

  function selectedInvites(): { email: string; days: number }[] {
    return rows.flatMap((draft) =>
      draft.on && draft.row.kind === 'unregistered'
        ? [{ email: draft.row.email, days: draft.days }]
        : []
    );
  }

  function paintSummary(): void {
    const grants = selectedGrants().length;
    const invites = selectedInvites().length;
    const lifetime = parseLifetime(lifetimeText);
    lifetimeInput.setAttribute(
      'aria-invalid',
      'error' in lifetime ? 'true' : 'false'
    );
    setChildren(lifetimeError, 'error' in lifetime ? lifetime.error : '');
    lifetimeBlock.hidden = !rows.some(
      (draft) => draft.row.kind === 'unregistered'
    );
    if (grants === 0 && invites === 0) {
      setChildren(summary, 'Add an address, or check a row, to share.');
    } else {
      const parts: string[] = [];
      if (grants > 0) {
        parts.push(
          `shares with ${grants} ${grants === 1 ? 'person' : 'people'}`
        );
      }
      if (invites > 0) parts.push(`invites ${invites}`);
      setChildren(summary, `One passkey tap ${parts.join(' and ')}.`);
    }
    shareButton.disabled =
      busy ||
      grants + invites === 0 ||
      'error' in lifetime ||
      versions.size === 0;
  }

  function rowFor(draft: ShareDraft, index: number): HTMLElement {
    const { row } = draft;
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'btn is-small',
        'data-remove-row': true,
        'aria-label': `Remove ${row.email}`,
        onclick: () => {
          rows.splice(index, 1);
          paintRows();
        },
      },
      'Remove'
    );
    if (row.kind === 'reader') {
      return h(
        'li',
        { 'data-share-row': true, 'data-share-state': 'reader' },
        h('span', { class: 'row-dot' }),
        h(
          'div',
          { class: 'row-main' },
          h('strong', {}, row.email),
          h('span', { class: 'row-meta' }, 'Already a reader. Nothing to do.')
        ),
        h(
          'div',
          { class: 'row-end' },
          h('span', { class: 'row-kind' }, 'Reader'),
          remove
        )
      );
    }
    if (row.kind === 'self') {
      return h(
        'li',
        { 'data-share-row': true, 'data-share-state': 'self' },
        h('span', { class: 'row-dot' }),
        h(
          'div',
          { class: 'row-main' },
          h('strong', {}, row.email),
          h('span', { class: 'row-meta' }, "That's you")
        ),
        h('div', { class: 'row-end' }, remove)
      );
    }
    if (row.kind === 'unverified') {
      return h(
        'li',
        { 'data-share-row': true, 'data-share-state': 'unverified' },
        h('span', { class: 'row-dot' }),
        h(
          'div',
          { class: 'row-main' },
          h('strong', {}, row.email),
          h('span', { class: 'row-meta is-oxide' }, 'Reload and try again.')
        ),
        h('div', { class: 'row-end' }, remove)
      );
    }
    if (isRegistered(row)) {
      const invited = row.kind === 'invited';
      const check = h('input', {
        type: 'checkbox',
        class: 'row-check',
        'data-share-grant': true,
        checked: draft.on,
        'aria-label': `Share with ${row.email}`,
        onchange: (event: Event) => {
          draft.on = (event.target as HTMLInputElement).checked;
          paintSummary();
        },
      });
      return h(
        'li',
        { 'data-share-row': true, 'data-share-state': row.kind },
        check,
        h(
          'div',
          { class: 'row-main' },
          h('strong', {}, row.email),
          h(
            'span',
            { class: 'row-meta' },
            invited
              ? 'Accepted your invitation. Sharing lets them open later versions.'
              : 'Has a private-share key. Check this fingerprint with them if you can.'
          )
        ),
        h(
          'div',
          { class: 'row-end' },
          h(
            'span',
            { class: invited ? 'row-kind is-patina' : 'row-kind is-patina' },
            invited ? 'Accepted' : 'Key'
          ),
          remove
        ),
        h(
          'div',
          { class: 'row-extra', 'data-fingerprint': 'recipient' },
          ...fingerprintGroups(formatFingerprint(row.fingerprint))
        )
      );
    }
    // unregistered: an address with no key yet
    const open = row.invites.reduce<number | undefined>((latest, invite) => {
      const at = Date.parse(invite.expires_at);
      return latest === undefined || at > latest ? at : latest;
    }, undefined);
    const check = h('input', {
      type: 'checkbox',
      class: 'row-check',
      'data-share-invite': true,
      checked: draft.on,
      'aria-label': `Invite ${row.email}`,
      onchange: (event: Event) => {
        draft.on = (event.target as HTMLInputElement).checked;
        paintSummary();
      },
    });
    const days = h(
      'select',
      {
        'data-invite-days': true,
        'aria-label': `Days the invitation stays open for ${row.email}`,
        onchange: (event: Event) => {
          draft.days = Number((event.target as HTMLSelectElement).value);
          paintSummary();
        },
      },
      ...Array.from({ length: INVITE_DAYS_MAX }, (_, i) =>
        dayOption(i + 1, draft.days)
      )
    );
    const copy =
      open === undefined
        ? `${row.email} hasn't set up a private-share key. Invite them: they confirm this address, then set up a passkey to keep access.`
        : `Invitation open until ${formatUtcDay(open)}.`;
    return h(
      'li',
      { 'data-share-row': true, 'data-share-state': 'unregistered' },
      check,
      h(
        'div',
        { class: 'row-main' },
        h('strong', {}, row.email),
        h('span', { class: 'row-meta' }, copy)
      ),
      h(
        'div',
        { class: 'row-end' },
        h('span', { class: 'row-kind is-oxide' }, 'Invite'),
        remove
      ),
      h(
        'div',
        { class: 'row-extra' },
        h('label', { class: 'days' }, 'Open for ', days)
      )
    );
  }

  function paintRows(): void {
    if (rows.length === 0) {
      setChildren(
        rowsHost,
        h('li', { class: 'panel-empty' }, 'No addresses yet.')
      );
    } else {
      setChildren(
        rowsHost,
        ...rows.map((draft, index) => rowFor(draft, index))
      );
    }
    paintSummary();
  }

  function paintVersions(): void {
    setChildren(
      versionsHost,
      ...grantable.map((version) => {
        const current = version === currentVersion;
        return h(
          'label',
          { class: 'pick' },
          h('input', {
            type: 'checkbox',
            'data-share-version': String(version),
            checked: versions.has(version) || current,
            disabled: current,
            onchange: (event: Event) => {
              const on = (event.target as HTMLInputElement).checked;
              if (on) versions.add(version);
              else versions.delete(version);
              paintSummary();
            },
          }),
          `v${version}`,
          current
            ? h('span', { class: 'lock-note' }, ' current, always included')
            : null
        );
      })
    );
    paintSummary();
  }

  let currentVersion = 0;

  function paintLinks(): void {
    if (links.length === 0 && sent.length === 0) {
      linksHost.hidden = true;
      setChildren(linksHost);
      return;
    }
    linksHost.hidden = false;
    const cards = [
      ...links.map((link) =>
        h(
          'div',
          { class: 'link-card', 'data-invite-link': link.inviteId },
          h('strong', {}, link.email),
          h(
            'span',
            { class: 'row-meta' },
            `Open until ${formatUtcDay(link.expiresAt)}. Versions ${describeVersions(link.versions)}.`
          ),
          h('p', { class: 'link-text', 'data-link-text': true }, link.url),
          h(
            'div',
            { class: 'link-actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                'data-action': 'invite-copy',
                onclick: (event: Event) => {
                  const feedback = (event.target as HTMLElement)
                    .closest('.link-card')
                    ?.querySelector('.feedback');
                  void copyText(link.url).then((copied) => {
                    if (feedback) {
                      setChildren(
                        feedback as HTMLElement,
                        copied
                          ? 'Copied.'
                          : 'Copy failed. Select the link and copy it.'
                      );
                    }
                  });
                },
              },
              'Copy link'
            ),
            h(
              'a',
              {
                class: 'btn',
                'data-action': 'invite-draft',
                href: shareMailtoUrl(
                  composeInviteEmail({
                    url: link.url,
                    to: [link.email],
                    expiresAt: formatUtcDay(link.expiresAt),
                  })
                ),
              },
              'Draft email'
            ),
            h('span', { class: 'feedback', 'aria-live': 'polite' })
          )
        )
      ),
      ...sent.map((item) =>
        h(
          'div',
          { class: 'link-card', 'data-invite-link': item.inviteId },
          h('strong', {}, item.email),
          h(
            'span',
            { class: 'row-meta' },
            `Open until ${formatUtcDay(item.expiresAt)}. Versions ${describeVersions(item.versions)}.`
          ),
          h('p', { class: 'link-gone' }, 'This link is no longer shown.')
        )
      ),
    ];
    const done = h(
      'button',
      {
        type: 'button',
        class: 'btn',
        'data-action': 'links-done',
        onclick: () => {
          if (linksGone) {
            sent = [];
            linksGone = false;
          } else {
            sent = links.map((link) => ({
              inviteId: link.inviteId,
              email: link.email,
              expiresAt: link.expiresAt,
              versions: link.versions,
            }));
            links = [];
            linksGone = true;
          }
          paintLinks();
        },
      },
      linksGone ? 'Back to Share' : "Done, I've sent them"
    );
    setChildren(
      linksHost,
      h('h3', {}, 'Send these yourself'),
      h(
        'div',
        { class: 'panel-notice is-oxide' },
        h(
          'p',
          {},
          "Send each invitation yourself. Each link holds a key, so Relik can't send it. Relik emails each person that you invited them, without the link. Each link is shown once."
        ),
        h(
          'p',
          {},
          "Anyone with a link and that person's mailbox can open it until it expires or is used."
        )
      ),
      ...cards,
      h(
        'p',
        { class: 'panel-foot' },
        linksGone
          ? 'Lost a link? Cancel that invitation under Invitations and invite again.'
          : "Relik doesn't keep these links. If you lose one, cancel that invitation and invite again."
      ),
      h('div', {}, done)
    );
  }

  async function addAddresses(): Promise<void> {
    const typed = addInput.value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const unique: string[] = [];
    for (const email of typed) {
      if (
        !listed(rows, email) &&
        !unique.some((seen) => seen.toLowerCase() === email.toLowerCase())
      ) {
        unique.push(email);
      }
    }
    if (unique.length === 0) return;
    if (unique.length + rows.length > 20) {
      setChildren(addError, 'Add up to 20 addresses per share.');
      return;
    }
    addButton.disabled = true;
    setChildren(addError, '');
    try {
      const found = await lookupShares(deps, relicId, unique, admitted, ownerId);
      for (const row of found) {
        rows.push({
          row,
          on:
            row.kind === 'registered' || row.kind === 'invited'
              ? true
              : row.kind === 'unregistered'
                ? !row.invites.length
                : false,
          days: Number(lifetimeText) || INVITE_DAYS_DEFAULT,
        });
      }
      addInput.value = '';
      paintRows();
    } catch (error) {
      setChildren(addError, problemMessage(error));
    } finally {
      addButton.disabled = false;
    }
  }

  async function share(): Promise<void> {
    const lifetime = parseLifetime(lifetimeText);
    if ('error' in lifetime) return;
    const picked = [...versions].sort((a, b) => a - b);
    if (picked.length === 0) {
      setChildren(addError, 'Choose at least one version.');
      return;
    }
    const grants = selectedGrants();
    const invites = selectedInvites();
    const restore = waiting(shareButton);
    busy = true;
    try {
      const origin = new URL(deps.locationHref).origin;
      const made = await shareBatch(deps, {
        relicId,
        versions: picked,
        relicExpiresAt: expiresAt,
        grants,
        invites: invites.map((invite) => ({
          email: invite.email,
          days: invite.days,
        })),
        origin,
      });
      links = made;
      sent = [];
      linksGone = false;
      const parts: string[] = [];
      if (grants.length > 0) {
        parts.push(
          `Shared directly with ${grants.length} ${grants.length === 1 ? 'person' : 'people'}. Relik emailed them.`
        );
      }
      if (made.length > 0) {
        parts.push(`Invited ${made.length}. Send each link yourself.`);
      }
      rows.length = 0;
      setChildren(addError, '');
      paintRows();
      paintLinks();
      options.onChanged(parts.join(' '));
    } catch (error) {
      if (error instanceof VerificationRefusedError) {
        setChildren(addError, error.message);
      } else {
        setChildren(addError, problemMessage(error));
      }
    } finally {
      busy = false;
      restore();
      paintSummary();
    }
  }

  addInput.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void addAddresses();
  });
  addButton.addEventListener('click', () => {
    void addAddresses();
  });
  lifetimeInput.addEventListener('input', () => {
    lifetimeText = (lifetimeInput as HTMLInputElement).value;
    const lifetime = parseLifetime(lifetimeText);
    if ('days' in lifetime) {
      for (const draft of rows)
        if (draft.row.kind === 'unregistered') draft.days = lifetime.days;
      paintRows();
    } else paintSummary();
  });
  shareButton.addEventListener('click', () => {
    void share();
  });

  if (options.prefill !== undefined && options.prefill.length > 0) {
    addInput.value = options.prefill.join(', ');
  }
  paintRows();

  return {
    element,
    links: linksHost,
    update(data) {
      admitted = data.admitted;
      ownerId = data.access.owner?.identity.identity_id;
      expiresAt = Date.parse(data.access.expires_at);
      currentVersion = data.access.sealed_version ?? 0;
      grantable = [];
      const deleted = new Set(data.access.me.deleted_versions);
      for (let version = 1; version <= currentVersion; version++) {
        if (!deleted.has(version)) grantable.push(version);
      }
      if (!seeded) {
        versions = new Set(grantable);
        seeded = true;
      } else {
        versions = new Set(
          [...versions].filter((version) => grantable.includes(version))
        );
      }
      if (grantable.includes(currentVersion)) versions.add(currentVersion);
      paintVersions();
      paintRows();
      paintLinks();
    },
    fill(emails) {
      addInput.value = emails.join(', ');
    },
  };
}
