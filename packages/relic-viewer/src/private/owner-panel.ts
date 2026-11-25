/**
 * The owner's access panel on a private relic (section 4.15, mock
 * `#access-panel`). It lists pending requests with the requester's address and
 * fingerprint and a version picker, the current readers with revoke, the
 * parties who can read regardless, and the delete entry point.
 *
 * Every owner action that changes access goes through the passkey: grant
 * picks versions, then one tap unlocks the owner identity and attests the
 * grant. The owner does not type or read out a fingerprint. Decline needs no
 * tap.
 */

import {
  type AccessRequestStatement,
  decodeBase64url,
  formatFingerprint,
  identityFingerprint,
  type IdentityStateJSON,
  parseStatement,
  type PartyJSON,
  type PrivateAccessJSON,
  rosterAdmits,
  statementBytes,
  verifyStatement,
  type GrantJSON,
  type WrapJSON,
  wrapVersionKey,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { createDeleteDialog, type DeleteDialog } from './delete.ts';
import { lookupShares, shareRegistered, type ShareRow } from './direct-share.ts';
import { describeVersions, formatUtcDay } from './access-log.ts';
import {
  fingerprintGroups,
  h,
  privateApi,
  problemMessage,
  setChildren,
  waiting,
} from './fingerprint-input.ts';
import { privateKeysOf } from './ops.ts';
import { VerificationRefusedError } from './refusal.ts';
import {
  createRevokeDialog,
  type RevokeDialog,
  rosterGrants,
  verifiedPartyKeys,
} from './rekey.ts';
import { observeRosterFloor } from './roster-floor.ts';

export interface OwnerPanelContext {
  readonly relicId: string;
  readonly access: PrivateAccessJSON;
  readonly deps: ViewerDeps;
  /** Called after an action changed the relic (a grant, a revoke, a delete), so the page reloads. */
  onChanged(): void;
  /** The requester's identity ID from the mail link (`?grant=`): their card is listed first. */
  readonly focusRequester?: string;
  /**
   * `focused` is the mail link's view: one card for the requester, in the host,
   * with no side sheet. The reader hides its own unlock card while it shows.
   */
  readonly mode?: 'panel' | 'focused';
  /** Focused mode: the owner chose to go on to the relik, or has no request left to decide. */
  onDone?(): void;
}

interface PendingRequest {
  readonly requester: PartyJSON;
  readonly requested_at: string;
  readonly status: string;
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
}

interface PanelData {
  readonly access: PrivateAccessJSON;
  readonly requests: readonly PendingRequest[];
  readonly grants: readonly GrantJSON[];
  /** The grantee identities this browser's floor admits: a grant the owner revoked is not one. */
  readonly admitted: ReadonlySet<string>;
  readonly devices: readonly {
    readonly label: string;
    readonly revoked_at: string | null;
  }[];
  readonly recovery: PartyJSON | null;
}

/**
 * The grantee identities the owner's floor admits for a relic. Each grant is
 * judged by the owner's own signed revocation, and the floor records what was
 * verified, so a grant the service lists live after a verified revocation is not
 * admitted. A panel with no identity on this browser admits nobody.
 */
async function admittedGrantees(
  identity: IdentityStateJSON['identity'],
  relicId: string,
  grants: readonly GrantJSON[]
): Promise<ReadonlySet<string>> {
  if (identity === null) return new Set();
  const roster = await rosterGrants(
    {
      identityId: identity.identity_id,
      sigPublicKey: decodeBase64url(identity.sig_public_key),
    },
    relicId,
    grants
  );
  const floor = observeRosterFloor(identity.identity_id, {
    grants: roster.marks,
  });
  return new Set(
    roster.live
      .filter((grant) => rosterAdmits(floor.grants?.[grant.key], grant.at))
      .map((grant) => grant.granteeIdentityId)
  );
}

/** The versions a grant can list: sealed, not deleted, up to the highest sealed version. */
function grantableVersions(access: PrivateAccessJSON): number[] {
  const deleted = new Set(access.me.deleted_versions);
  const versions: number[] = [];
  for (let version = 1; version <= (access.sealed_version ?? 0); version++) {
    if (!deleted.has(version)) versions.push(version);
  }
  return versions;
}

/** A pending request is shown only when its keys hash to the identity ID and its signed statement verifies. */
async function requestVerifies(
  request: PendingRequest,
  relicId: string
): Promise<boolean> {
  try {
    const keys = await verifiedPartyKeys(request.requester);
    const statement: AccessRequestStatement = parseStatement(
      'access_request',
      request.statement
    );
    return (
      statement.relic_id === relicId &&
      statement.requester_identity_id ===
        request.requester.identity.identity_id &&
      (await verifyStatement(
        keys.sigPublicKey,
        statementBytes('access_request', statement),
        request.identity_signature
      ))
    );
  } catch {
    return false;
  }
}

/**
 * Render the owner's access panel into `host`. The panel and its two dialogs
 * (revoke, delete) are built here; the caller decides where `host` sits.
 */
export function openAccessPanel(
  host: HTMLElement,
  ctx: OwnerPanelContext
): void {
  let latest: PrivateAccessJSON = ctx.access;
  const lead = h('p', { class: 'panel-lead', id: 'panel-lead' });
  const notice = h('p', {
    class: 'panel-notice',
    id: 'panel-notice',
    role: 'status',
    hidden: true,
  });
  const requestCount = h('span', { id: 'requests-count' });
  const requestsHost = h('div', { id: 'requests', class: 'dash-grid' });
  const grantList = h('ul', { class: 'row-list', id: 'grants' });
  const alsoList = h('ul', { class: 'row-list' });
  const shareRows = h('ul', { class: 'row-list', 'data-share-rows': true });
  const shareInput = h('input', {
    class: 'input', type: 'email', 'data-share-input': true,
    placeholder: 'name@example.com', 'aria-label': 'Email address to share with',
  });
  const shareError = h('p', { 'data-share-err': true, role: 'alert' });
  const shareVersions = h('div', { class: 'version-picks' });
  const shareButton = h('button', {
    type: 'button', class: 'action primary', 'data-action': 'share-passkey', disabled: true,
  }, 'Share with passkey');
  const addAddress = h('button', { type: 'button', class: 'btn', 'data-add-address': true }, 'Add');
  const shareSummary = h('p', { 'data-share-summary': true }, 'Add an address, or check a row, to share.');
  const shares: ShareRow[] = [];
  let admittedShares: ReadonlySet<string> = new Set();
  function updateShareButton(): void {
    const count = shareRows.querySelectorAll('input[data-share-grant]:checked').length;
    shareButton.disabled = count === 0;
    shareSummary.textContent = count === 0 ? 'Add an address, or check a row, to share.' : `One passkey tap shares with ${count} ${count === 1 ? 'person' : 'people'}.`;
  }
  function addShareRow(row: ShareRow): void {
    shares.push(row);
    const selectable = row.kind === 'registered' || row.kind === 'invited';
    const check = selectable ? h('input', { type: 'checkbox', 'data-share-grant': true, checked: true, 'aria-label': `Share with ${row.email}` }) : null;
    const meta = row.kind === 'reader' ? 'Already a reader. Nothing to do.' :
      row.kind === 'self' ? "That's you" :
      row.kind === 'unverified' ? 'Reload and try again.' :
      row.kind === 'unregistered' ? `${row.email} hasn't set up a private-share key.` :
      row.kind === 'invited' ? 'Accepted your invitation. Sharing lets them open later versions.' :
      'Has a private-share key. Check this fingerprint with them if you can.';
    const removeRow = h('button', { type: 'button', class: 'btn is-small', 'data-remove-row': true, 'aria-label': `Remove ${row.email}` }, 'Remove');
    const li = h('li', { 'data-share-row': true, 'data-share-state': row.kind },
      check, h('div', { class: 'row-main' }, h('strong', {}, row.email), h('span', { class: 'row-meta' }, meta)),
      h('div', { class: 'row-end' }, removeRow),
      selectable ? h('div', { class: 'row-extra', 'data-fingerprint': 'recipient' }, ...fingerprintGroups(formatFingerprint(row.fingerprint))) : null);
    check?.addEventListener('change', updateShareButton);
    removeRow.addEventListener('click', () => { const index = shares.indexOf(row); if (index >= 0) shares.splice(index, 1); li.remove(); updateShareButton(); });
    shareRows.append(li);
    updateShareButton();
  }
  addAddress.addEventListener('click', () => {
    const email = shareInput.value.trim();
    if (!email || shares.some((row) => row.email.toLowerCase() === email.toLowerCase())) return;
    addAddress.disabled = true;
    void lookupShares(ctx.deps, ctx.relicId, [email], admittedShares).then((rows) => {
      for (const row of rows) addShareRow(row);
      shareInput.value = '';
      shareError.textContent = '';
    }).catch((error: unknown) => { shareError.textContent = problemMessage(error); }).finally(() => { addAddress.disabled = false; });
  });
  shareButton.addEventListener('click', () => {
    const selected = [...shareRows.querySelectorAll<HTMLElement>('[data-share-row]')].flatMap((li, index) => {
      const row = shares[index];
      return li.querySelector<HTMLInputElement>('input[data-share-grant]')?.checked && row && (row.kind === 'registered' || row.kind === 'invited') ? [row] : [];
    });
    const versions = [...shareVersions.querySelectorAll<HTMLInputElement>('input[data-share-version]:checked')].map((input) => Number(input.dataset.shareVersion));
    const restore = waiting(shareButton);
    void shareRegistered(ctx.deps, ctx.relicId, selected, versions).then(() => {
      shares.length = 0;
      shareRows.replaceChildren();
      ctx.onChanged();
      return refresh('Shared directly. Relik emailed them.', true);
    }).catch((error: unknown) => { shareError.textContent = problemMessage(error); }).finally(() => { restore(); updateShareButton(); });
  });
  const deleteOpen = h(
    'button',
    { type: 'button', class: 'btn is-danger', 'data-action': 'delete-relic' },
    'Delete versions or the relik'
  );

  const revoke: RevokeDialog = createRevokeDialog({
    relicId: ctx.relicId,
    deps: ctx.deps,
    onSettled: () => {
      ctx.onChanged();
      void refresh('');
    },
  });
  const remove: DeleteDialog = createDeleteDialog({
    relicId: ctx.relicId,
    deps: ctx.deps,
    onSettled: (message, whole) => {
      ctx.onChanged();
      if (!whole) void refresh(message);
    },
  });
  deleteOpen.addEventListener('click', () => remove.open(latest));

  const panel = h(
    'aside',
    {
      class: 'access-panel',
      id: 'access-panel',
      role: 'dialog',
      'aria-labelledby': 'panel-title',
    },
    h(
      'div',
      { class: 'panel-head' },
      h(
        'h2',
        { class: 'panel-title', id: 'panel-title', tabindex: '-1' },
        'Access ',
        h('span', { class: 'accession' }, ctx.relicId)
      ),
      h('button', {
        type: 'button',
        class: 'panel-close',
        id: 'panel-close',
        'aria-label': 'Close access',
        onclick: () => {
          panel.hidden = true;
        },
      })
    ),
    h(
      'div',
      { class: 'panel-body' },
      lead,
      notice,
      h('section', { class: 'panel-section', 'data-share-section': true },
        h('h3', {}, 'Share'),
        h('p', { class: 'panel-lead' }, "Type each person's email. People with a key are shared with at once. People without one are invited."),
        h('fieldset', { class: 'versions' }, h('legend', {}, 'Versions they can open'), shareVersions),
        h('div', { class: 'add-row' }, shareInput, addAddress), shareError, shareRows,
        h('div', { class: 'share-foot' }, shareSummary, shareButton)),
      h(
        'section',
        { class: 'panel-section', 'aria-labelledby': 'requests-title' },
        h('h3', { id: 'requests-title' }, 'Requests ', requestCount),
        requestsHost
      ),
      h(
        'section',
        { class: 'panel-section', 'aria-labelledby': 'readers-title' },
        h('h3', { id: 'readers-title' }, 'Readers'),
        grantList
      ),
      h(
        'section',
        { class: 'panel-section', 'aria-labelledby': 'also-title' },
        h('h3', { id: 'also-title' }, 'Also able to read'),
        alsoList
      ),
      h(
        'section',
        { class: 'panel-section', 'aria-labelledby': 'delete-title' },
        h('h3', { id: 'delete-title' }, 'Delete'),
        h(
          'p',
          { class: 'panel-empty' },
          'Remove chosen versions or the whole relik, with every reader\u2019s keys for them. It can\u2019t be undone.'
        ),
        h('div', {}, deleteOpen)
      ),
      h(
        'p',
        { class: 'panel-foot' },
        'Devices, recovery and the access log are on your ',
        h('a', { href: '/dashboard', id: 'to-dashboard' }, 'dashboard'),
        '.'
      )
    ),
    revoke.element,
    remove.element
  );
  const focusedView = ctx.mode === 'focused';
  const skip = h(
    'button',
    { type: 'button', class: 'btn', 'data-action': 'grant-skip' },
    'Open the relik instead'
  );
  skip.addEventListener('click', () => ctx.onDone?.());
  host.replaceChildren(
    ...(focusedView
      ? [notice, requestsHost, h('p', { class: 'card-note' }, skip)]
      : [panel])
  );

  function showNotice(text: string, oxide = false): void {
    notice.hidden = text === '';
    setChildren(notice, text);
    notice.classList.toggle('is-oxide', oxide);
  }

  async function load(): Promise<PanelData> {
    const access = await privateApi<PrivateAccessJSON>(
      ctx.deps,
      'GET',
      `/api/relics/${ctx.relicId}/access`
    );
    const requests = await privateApi<{ requests: PendingRequest[] }>(
      ctx.deps,
      'GET',
      `/api/relics/${ctx.relicId}/requests`
    );
    const recipients = await privateApi<{
      devices: { label: string; revoked_at: string | null }[];
      grants: GrantJSON[];
      recovery: PartyJSON | null;
    }>(ctx.deps, 'POST', `/api/relics/${ctx.relicId}/recipients`);
    latest = access;
    const state = await privateKeysOf(ctx.deps).loadIdentityState(ctx.deps);
    return {
      access,
      requests: requests.requests.filter(
        (request) => request.status === 'pending'
      ),
      grants: recipients.grants,
      admitted: await admittedGrantees(
        state.identity,
        ctx.relicId,
        recipients.grants
      ),
      devices: recipients.devices,
      recovery: recipients.recovery,
    };
  }

  function requestTicket(
    request: PendingRequest,
    verified: boolean,
    access: PrivateAccessJSON,
    focused: boolean
  ): HTMLElement {
    const requester = request.requester;
    const decline = declineButton(request);
    if (!verified) {
      return h(
        'article',
        {
          class: 'request',
          'data-request-identity': requester.identity.identity_id,
          'aria-label': `Request from ${requester.email}`,
        },
        h('div', { class: 'request-who' }, h('strong', {}, requester.email)),
        h(
          'p',
          { class: 'fp-status' },
          'This request doesn\u2019t verify against the requester\u2019s key. Don\u2019t grant it.'
        ),
        h('div', { class: 'card-actions' }, decline)
      );
    }

    const fieldId = `fp-${requester.identity.identity_id.slice(0, 8)}`;
    const top = access.sealed_version ?? 0;
    const picks = h('div', { class: 'version-picks' });
    for (const version of grantableVersions(access)) {
      const current = version === top;
      picks.append(
        h(
          'label',
          { class: 'pick' },
          h('input', {
            type: 'checkbox',
            'data-grant-version': String(version),
            checked: true,
            disabled: current,
            'aria-describedby': current ? `${fieldId}-lock` : undefined,
          }),
          `v${version}`,
          current
            ? h(
                'span',
                { class: 'lock-note', id: `${fieldId}-lock` },
                'current, always included'
              )
            : null
        )
      );
    }

    const grant = h(
      'button',
      {
        type: 'button',
        class: 'action primary',
        'data-action': 'grant',
        disabled: true,
      },
      'Grant with passkey'
    );
    const fingerprint = h('div', {
      class: 'fingerprint',
      'data-fingerprint': 'requester',
    });
    const article = h(
      'article',
      {
        class: focused ? 'request is-focused' : 'request',
        'data-request-identity': requester.identity.identity_id,
        'aria-label': `Request from ${requester.email}`,
      },
      h(
        'div',
        { class: 'request-who' },
        h('strong', {}, requester.email),
        h(
          'span',
          { class: 'request-when' },
          `asked ${formatUtcDay(request.requested_at)}`
        )
      ),
      h(
        'div',
        { class: 'step-fingerprint' },
        h('p', { class: 'step-text' }, 'Their fingerprint'),
        fingerprint
      ),
      h(
        'fieldset',
        { class: 'versions' },
        h('legend', {}, 'Versions they can read'),
        picks,
        h('p', { class: 'pick-note' }, 'Later versions are always included.')
      ),
      h('div', { class: 'card-actions', style: 'margin:0' }, grant, decline)
    );

    // The fingerprint is computed here from the identity ID and address the
    // request just verified against, and it is what the grant signs.
    let expected: string | undefined;
    void identityFingerprint(
      requester.identity.identity_id,
      requester.email
    ).then((value) => {
      expected = value;
      fingerprint.replaceChildren(
        ...fingerprintGroups(formatFingerprint(value))
      );
      grant.disabled = false;
      if (focused) article.scrollIntoView?.({ block: 'center' });
    });
    grant.addEventListener('click', () => {
      if (expected === undefined) return;
      void grantAccess(request, article, expected, grant);
    });
    return article;
  }

  function declineButton(request: PendingRequest): HTMLButtonElement {
    const button = h(
      'button',
      { type: 'button', class: 'btn', 'data-action': 'decline' },
      'Decline'
    );
    button.addEventListener('click', () => {
      void decline(request, button);
    });
    return button;
  }

  async function decline(
    request: PendingRequest,
    button: HTMLButtonElement
  ): Promise<void> {
    button.disabled = true;
    try {
      await privateApi(
        ctx.deps,
        'POST',
        `/api/relics/${ctx.relicId}/requests/${request.requester.identity.identity_id}/decline`,
        {}
      );
      await refresh(
        `Declined ${request.requester.email}. They see that when they next open the link; Relik doesn\u2019t email them.`,
        true
      );
    } catch (error) {
      button.disabled = false;
      showNotice(problemMessage(error), true);
    }
  }

  async function grantAccess(
    request: PendingRequest,
    article: HTMLElement,
    fingerprint: string,
    button: HTMLButtonElement
  ): Promise<void> {
    const versions = [
      ...new Set(
        [
          ...article.querySelectorAll<HTMLInputElement>(
            'input[data-grant-version]'
          ),
        ]
          .filter((input) => input.checked)
          .map((input) => Number(input.dataset.grantVersion))
      ),
    ].sort((a, b) => a - b);
    const requester = request.requester;
    const restore = waiting(button);
    try {
      const requesterKeys = await verifiedPartyKeys(requester);
      const at = Date.now();
      const tapped = await privateKeysOf(ctx.deps).attest(ctx.deps, {
        purpose: 'grant',
        relicId: ctx.relicId,
        build: (identityId) => [
          {
            kind: 'grant',
            statement: {
              at,
              fingerprint_typed: fingerprint,
              grantee_email: requester.email,
              grantee_identity_id: requester.identity.identity_id,
              owner_identity_id: identityId,
              relic_id: ctx.relicId,
              versions,
            },
          },
        ],
      });
      const wraps: WrapJSON[] = [];
      for (const version of versions) {
        const fetched = await privateKeysOf(ctx.deps).fetchVersionKey(
          ctx.deps,
          ctx.relicId,
          version,
          tapped.identity
        );
        if (
          fetched.keyJson.owner.identity.identity_id !==
          tapped.identity.identityId
        ) {
          throw new VerificationRefusedError(
            'a version of this relik belongs to another owner, so nothing was granted. Nothing was sent.'
          );
        }
        const wrap = await wrapVersionKey({
          recipientPublicKey: requesterKeys.kemPublicKey,
          relicId: ctx.relicId,
          version,
          key: fetched.key,
        });
        wraps.push({
          recipient_key_id: wrap.recipientKeyId,
          version,
          enc: wrap.enc,
          ct: wrap.ct,
        });
      }
      await privateApi(ctx.deps, 'POST', `/api/relics/${ctx.relicId}/grants`, {
        attestation: tapped.bundle,
        wraps,
      });
      ctx.onChanged();
      await refresh(
        `${requester.email} can open ${describeVersions(versions)} and every later version. Relik emailed them.`,
        true
      );
    } catch (error) {
      restore();
      showNotice(problemMessage(error), true);
    }
  }

  function renderReaders(data: PanelData): void {
    const readers = data.grants.filter((grant) =>
      data.admitted.has(grant.grantee.identity.identity_id)
    );
    if (readers.length === 0) {
      setChildren(
        grantList,
        h(
          'li',
          {},
          h(
            'span',
            { class: 'panel-empty' },
            'Only you, your device and your recovery key holder.'
          )
        )
      );
    } else {
      setChildren(
        grantList,
        ...readers.map((grant) => {
          const versions = grant.statement.versions as number[];
          const button = h(
            'button',
            {
              type: 'button',
              class: 'btn is-small is-danger',
              'data-action': 'revoke',
              'aria-label': `Revoke ${grant.grantee.email}`,
            },
            'Revoke'
          );
          button.addEventListener('click', () => {
            void openRevoke(grant);
          });
          return h(
            'li',
            { 'data-grantee': grant.grantee.identity.identity_id },
            h(
              'span',
              { class: 'row-main' },
              h('strong', {}, grant.grantee.email),
              h(
                'span',
                { class: 'row-meta' },
                `${describeVersions(versions)} and every later version. Granted ${formatUtcDay(grant.granted_at)}.`
              )
            ),
            button
          );
        })
      );
    }
    const others = [
      h(
        'li',
        {},
        h(
          'span',
          { class: 'row-main' },
          h('strong', {}, 'You'),
          h(
            'span',
            { class: 'row-meta' },
            `${data.access.owner?.email ?? ''}, every version`
          )
        ),
        h('span', { class: 'row-kind' }, 'Owner')
      ),
      ...data.devices
        .filter((device) => device.revoked_at === null)
        .map((device) =>
          h(
            'li',
            {},
            h(
              'span',
              { class: 'row-main' },
              h('strong', {}, device.label),
              h('span', { class: 'row-meta' }, 'Your device, every version')
            ),
            h('span', { class: 'row-kind' }, 'Device')
          )
        ),
    ];
    if (data.recovery) {
      others.push(
        h(
          'li',
          {},
          h(
            'span',
            { class: 'row-main' },
            h('strong', {}, data.recovery.email),
            h(
              'span',
              { class: 'row-meta' },
              'Recovery key holder, every version'
            )
          ),
          h('span', { class: 'row-kind' }, 'Recovery')
        )
      );
    }
    setChildren(alsoList, ...others);
  }

  async function openRevoke(grant: GrantJSON): Promise<void> {
    try {
      const data = await load();
      revoke.open(
        {
          identityId: grant.grantee.identity.identity_id,
          email: grant.grantee.email,
        },
        data.access
      );
    } catch (error) {
      showNotice(problemMessage(error), true);
    }
  }

  async function refresh(message: string, keepNotice = false): Promise<void> {
    try {
      const data = await load();
      admittedShares = data.admitted;
      setChildren(shareVersions, ...grantableVersions(data.access).map((version) => {
        const current = version === data.access.sealed_version;
        return h('label', { class: 'pick' }, h('input', { type: 'checkbox', 'data-share-version': String(version), checked: true, disabled: current }), `v${version}`, current ? h('span', { class: 'lock-note' }, 'current') : null);
      }));
      const count = data.admitted.size;
      const readers =
        count === 0
          ? 'only you, your devices and your recovery key holder'
          : count === 1
            ? 'you and 1 reader'
            : `you and ${count} readers`;
      setChildren(
        lead,
        `Version ${data.access.current_version} can be read by ${readers}.`
      );
      requestCount.textContent =
        data.requests.length > 0 ? String(data.requests.length) : '';
      setChildren(requestsHost);
      const focus = ctx.focusRequester;
      // The mail link's card is for one requester; the rest wait in the Access panel.
      const listed =
        focusedView && focus !== undefined
          ? data.requests.filter(
              (request) => request.requester.identity.identity_id === focus
            )
          : data.requests;
      if (listed.length === 0) {
        requestsHost.append(
          h('p', { class: 'panel-empty' }, 'No one is waiting.')
        );
      }
      const ordered =
        focus === undefined
          ? listed
          : [
              ...listed.filter(
                (request) => request.requester.identity.identity_id === focus
              ),
              ...listed.filter(
                (request) => request.requester.identity.identity_id !== focus
              ),
            ];
      for (const request of ordered) {
        const verified = await requestVerifies(request, ctx.relicId);
        requestsHost.append(
          requestTicket(
            request,
            verified,
            data.access,
            request.requester.identity.identity_id === focus
          )
        );
      }
      if (focusedView) {
        // With the request decided, going on to the relik is the next step.
        skip.className = listed.length === 0 ? 'action primary' : 'btn';
        skip.textContent =
          listed.length === 0 ? 'Open the relik' : 'Open the relik instead';
      }
      renderReaders(data);
      if (message || !keepNotice) showNotice(message);
    } catch (error) {
      showNotice(problemMessage(error), true);
    }
  }

  void refresh('');
}
