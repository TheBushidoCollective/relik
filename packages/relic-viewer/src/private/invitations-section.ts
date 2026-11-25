import { formatFingerprint, type InviteJSON, type PrivateAccessJSON } from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { describeVersions, formatUtcDay } from './access-log.ts';
import { grantTargetFor, listInvites, revokeInvite, shareBatch, type GrantTarget } from './direct-share.ts';
import { fingerprintGroups, h, problemMessage, setChildren, waiting } from './fingerprint-input.ts';
import { verifiedPartyKeys } from './rekey.ts';

export function createInvitationsSection(options: {
  readonly relicId: string;
  readonly deps: ViewerDeps;
  readonly onChanged: () => void;
  readonly inviteAgain: (email: string) => void;
}): { element: HTMLElement; update(access: PrivateAccessJSON): Promise<void> } {
  const section = h('section', { class: 'panel-section', 'data-invites-section': true });
  let access: PrivateAccessJSON;
  const selected = new Map<string, GrantTarget>();
  const error = h('p', { role: 'alert', class: 'panel-notice is-oxide', hidden: true });
  const list = h('ul', { class: 'row-list' });
  const confirm = h('button', { type: 'button', class: 'action primary', 'data-action': 'invite-confirm', disabled: true }, 'Confirm with passkey');
  function showError(err: unknown): void { error.hidden = false; error.textContent = problemMessage(err); }
  async function update(next: PrivateAccessJSON): Promise<void> {
    access = next;
    const invites = await listInvites(options.deps, options.relicId);
    selected.clear();
    const nodes: HTMLElement[] = [];
    for (const invite of invites) {
      const entry = h('li', { 'data-invite': invite.invite_id, 'data-invite-state': invite.status });
      const main = h('div', { class: 'row-main' }, h('strong', {}, invite.invited_email));
      const end = h('div', { class: 'row-end' });
      const action = (name: string, title: string, handler: () => void) => {
        const button = h('button', { type: 'button', class: 'btn is-small', 'data-action': name }, title);
        button.addEventListener('click', handler);
        end.append(button);
      };
      if (invite.status === 'claimed' && invite.claimed_by !== null) {
        try {
          await verifiedPartyKeys(invite.claimed_by);
          const target = await grantTargetFor(invite.claimed_by);
          const check = h('input', { type: 'checkbox', checked: true, 'data-confirm-pick': true, 'aria-label': `Confirm ${invite.invited_email}` });
          selected.set(invite.invite_id, target);
          check.addEventListener('change', () => { if (check.checked) selected.set(invite.invite_id, target); else selected.delete(invite.invite_id); confirm.disabled = selected.size === 0; });
          entry.append(check);
          entry.append(h('div', { class: 'row-extra', 'data-fingerprint': 'claimant' }, ...fingerprintGroups(formatFingerprint(target.fingerprint))));
        } catch { main.append(h('span', { class: 'row-meta is-oxide' }, 'Reload and try again.')); }
      }
      const copy = invite.status === 'open' ? `Invited ${formatUtcDay(invite.created_at)}, open until ${formatUtcDay(invite.expires_at)}. ${describeVersions(invite.versions)}.` : invite.status === 'claimed' ? 'Accepted your invitation. Sharing lets them open later versions.' : invite.status === 'confirmed' ? 'Confirmed. They can open every version, now and later.' : invite.status === 'expired' ? `Expired ${formatUtcDay(invite.expires_at)}, unused.` : 'Cancelled. The link no longer opens.';
      main.append(h('span', { class: 'row-meta' }, copy));
      if (invite.status === 'open' || invite.status === 'claimed') {
        action(invite.status === 'open' ? 'invite-cancel' : 'invite-remove', invite.status === 'open' ? 'Cancel' : 'Remove', () => {
          void revokeInvite(options.deps, options.relicId, invite.invite_id).then(() => { options.onChanged(); return update(access); }).catch(showError);
        });
      } else if (invite.status === 'expired') action('invite-again', 'Invite again', () => options.inviteAgain(invite.invited_email));
      entry.append(main, end);
      nodes.push(entry);
    }
    setChildren(list, ...(nodes.length ? nodes : [h('li', { class: 'panel-empty' }, 'No invitations yet.')]));
    confirm.disabled = selected.size === 0;
  }
  confirm.addEventListener('click', () => {
    const restore = waiting(confirm);
    const versions = Array.from({ length: access.sealed_version ?? 0 }, (_, i) => i + 1).filter((version) => !access.me.deleted_versions.includes(version));
    void shareBatch(options.deps, { relicId: options.relicId, versions, relicExpiresAt: Date.parse(access.expires_at), grants: [...selected.values()], invites: [], origin: new URL(options.deps.locationHref).origin }).then(() => { options.onChanged(); return update(access); }).catch(showError).finally(() => { restore(); confirm.disabled = selected.size === 0; });
  });
  section.append(h('h3', {}, 'Invitations'), error, list, h('p', { class: 'share-sum' }, 'Confirming shares every sealed version with the people you checked, and later versions as you seal them.'), confirm);
  return { element: section, update };
}
