import {
  formatFingerprint,
  type InviteJSON,
  type PrivateAccessJSON,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { formatUtcDay, versionsSentence } from './access-log.ts';
import {
  grantTargetFor,
  shareBatch,
  type GrantTarget,
} from './direct-share.ts';
import { listInvites, revokeInvite } from './invite-wire.ts';
import {
  fingerprintGroups,
  h,
  icon,
  problemMessage,
  setChildren,
  waiting,
} from './fingerprint-input.ts';
import { verifiedPartyKeys } from './rekey.ts';

interface StateLook {
  readonly mark: 'clock' | 'check' | 'cross' | undefined;
  readonly kind: string;
  readonly tone: string;
}

/** What each invitation state shows at the row's start and end (mock IV1). */
const STATE_LOOK: Readonly<Record<InviteJSON['status'], StateLook>> = {
  open: { mark: 'clock', kind: 'Open', tone: ' is-oxide' },
  claimed: { mark: undefined, kind: 'Accepted', tone: ' is-patina' },
  confirmed: { mark: 'check', kind: 'Reader', tone: ' is-patina' },
  expired: { mark: 'cross', kind: 'Expired', tone: '' },
  revoked: { mark: 'cross', kind: 'Cancelled', tone: '' },
};

/** The row's line under the address, by state. */
function stateCopy(invite: InviteJSON): string {
  switch (invite.status) {
    case 'open':
      return `Invited ${formatUtcDay(invite.created_at)}, open until ${formatUtcDay(invite.expires_at)}. ${versionsSentence(invite.versions)}.`;
    case 'claimed':
      return 'Accepted your invitation. Sharing lets them open later versions.';
    case 'confirmed':
      return 'Confirmed. They can open every version, now and later.';
    case 'expired':
      return `Expired ${formatUtcDay(invite.expires_at)}, unused.`;
    case 'revoked':
      return 'Cancelled. The link no longer opens.';
  }
}

/** Addresses in a sentence, each in bold: "a", "a and b", "a, b and c". */
function addressList(emails: readonly string[]): (Node | string)[] {
  return emails.flatMap((email, index) => [
    ...(index === 0 ? [] : [index === emails.length - 1 ? ' and ' : ', ']),
    h('strong', {}, email),
  ]);
}

export function createInvitationsSection(options: {
  readonly relicId: string;
  readonly deps: ViewerDeps;
  readonly onChanged: () => void;
  readonly inviteAgain: (email: string) => void;
}): { element: HTMLElement; update(access: PrivateAccessJSON): Promise<void> } {
  const section = h('section', {
    class: 'panel-section',
    'data-invites-section': true,
  });
  let access: PrivateAccessJSON;
  const selected = new Map<string, GrantTarget>();
  const openCount = h('span', {});
  const notice = h('div', {
    class: 'panel-notice',
    role: 'status',
    hidden: true,
  });
  const error = h('p', {
    role: 'alert',
    class: 'panel-notice is-oxide',
    hidden: true,
  });
  const list = h('ul', { class: 'row-list' });
  const confirm = h(
    'button',
    {
      type: 'button',
      class: 'action primary',
      'data-action': 'invite-confirm',
      disabled: true,
    },
    'Confirm with passkey'
  );
  const foot = h(
    'div',
    { class: 'share-foot', hidden: true },
    h(
      'p',
      { class: 'share-sum' },
      'Confirming shares every sealed version with the people you checked, and later versions as you seal them.'
    ),
    h('div', {}, confirm)
  );
  function showNotice(...children: (Node | string)[]): void {
    error.hidden = true;
    notice.hidden = children.length === 0;
    setChildren(
      notice,
      ...(children.length === 0 ? [] : [h('p', {}, ...children)])
    );
  }
  function showError(err: unknown): void {
    notice.hidden = true;
    error.hidden = false;
    error.textContent = problemMessage(err);
  }
  async function update(next: PrivateAccessJSON): Promise<void> {
    access = next;
    const invites = await listInvites(options.deps, options.relicId);
    selected.clear();
    const nodes: HTMLElement[] = [];
    for (const invite of invites) {
      const look = STATE_LOOK[invite.status];
      const main = h(
        'div',
        { class: 'row-main' },
        h('strong', {}, invite.invited_email),
        h('span', { class: 'row-meta' }, stateCopy(invite))
      );
      const end = h(
        'div',
        { class: 'row-end' },
        h('span', { class: `row-kind${look.tone}` }, look.kind)
      );
      const action = (
        name: string,
        title: string,
        tone: string,
        handler: (button: HTMLButtonElement) => void
      ) => {
        const button = h(
          'button',
          { type: 'button', class: `btn is-small${tone}`, 'data-action': name },
          title
        );
        button.addEventListener('click', () => handler(button));
        end.append(button);
      };
      let lead: HTMLElement = h(
        'span',
        { class: 'row-dot' },
        look.mark === undefined ? null : icon(look.mark)
      );
      let extra: HTMLElement | null = null;
      if (invite.status === 'claimed' && invite.claimed_by !== null) {
        try {
          await verifiedPartyKeys(invite.claimed_by);
          const target = await grantTargetFor(invite.claimed_by);
          const check = h('input', {
            type: 'checkbox',
            class: 'row-check',
            checked: true,
            'data-confirm-pick': true,
            'aria-label': `Confirm ${invite.invited_email}`,
          });
          selected.set(invite.invite_id, target);
          check.addEventListener('change', () => {
            if (check.checked) selected.set(invite.invite_id, target);
            else selected.delete(invite.invite_id);
            confirm.disabled = selected.size === 0;
          });
          lead = check;
          extra = h(
            'div',
            { class: 'row-extra' },
            h('span', { class: 'fp-caption' }, 'Their fingerprint'),
            h(
              'p',
              {
                class: 'fingerprint is-small',
                'data-fingerprint': 'claimant',
              },
              ...fingerprintGroups(formatFingerprint(target.fingerprint))
            )
          );
        } catch {
          lead = h('span', { class: 'row-dot' }, icon('warn'));
          main.append(
            h('span', { class: 'row-meta is-oxide' }, 'Reload and try again.')
          );
        }
      }
      if (invite.status === 'open' || invite.status === 'claimed') {
        const open = invite.status === 'open';
        action(
          open ? 'invite-cancel' : 'invite-remove',
          open ? 'Cancel' : 'Remove',
          ' is-oxide',
          (button) => {
            button.disabled = true;
            void revokeInvite(options.deps, options.relicId, invite.invite_id)
              .then(() => {
                if (open) {
                  showNotice(
                    'Invitation to ',
                    h('strong', {}, invite.invited_email),
                    ' cancelled. Its link no longer opens.'
                  );
                } else showNotice();
                options.onChanged();
              })
              .catch((err: unknown) => {
                button.disabled = false;
                showError(err);
              });
          }
        );
      } else if (invite.status === 'expired') {
        action('invite-again', 'Invite again', '', () =>
          options.inviteAgain(invite.invited_email)
        );
      }
      const entry = h(
        'li',
        {
          'data-invite': invite.invite_id,
          'data-invite-state': invite.status,
        },
        lead,
        main,
        end,
        extra
      );
      nodes.push(entry);
    }
    setChildren(
      list,
      ...(nodes.length
        ? nodes
        : [h('li', { class: 'panel-empty' }, 'No invitations yet.')])
    );
    const open = invites.filter((invite) => invite.status === 'open').length;
    setChildren(openCount, open === 0 ? '' : `${open} open`);
    foot.hidden = !invites.some((invite) => invite.status === 'claimed');
    confirm.disabled = selected.size === 0;
  }
  confirm.addEventListener('click', () => {
    const restore = waiting(confirm);
    const confirmed = [...selected.values()].map(
      (target) => target.party.email
    );
    const versions = Array.from(
      { length: access.sealed_version ?? 0 },
      (_, i) => i + 1
    ).filter((version) => !access.me.deleted_versions.includes(version));
    void shareBatch(options.deps, {
      relicId: options.relicId,
      versions,
      relicExpiresAt: Date.parse(access.expires_at),
      grants: [...selected.values()],
      invites: [],
      origin: new URL(options.deps.locationHref).origin,
    })
      .then(() => {
        showNotice(
          'Shared directly with ',
          ...addressList(confirmed),
          '. Relik emails them now.'
        );
        options.onChanged();
      })
      .catch(showError)
      .finally(() => {
        restore();
        confirm.disabled = selected.size === 0;
      });
  });
  section.append(
    h('h3', {}, 'Invitations', openCount),
    notice,
    error,
    list,
    foot
  );
  return { element: section, update };
}
