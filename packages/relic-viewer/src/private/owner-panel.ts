/**
 * The owner's access panel on a private relic (section 4.15, mock
 * `#access-panel`). It lists pending requests with the typed fingerprint and
 * a version picker, the current readers with revoke, the parties who can
 * read regardless, and the delete entry point.
 *
 * Every owner action that changes access goes through the passkey: grant
 * types the fingerprint, picks versions, then one tap unlocks the owner
 * identity and attests the grant. Decline needs no tap.
 */

import {
  type AccessRequestStatement,
  decodeBase64url,
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
import { describeVersions, formatUtcDay } from './access-log.ts';
import {
  h,
  privateApi,
  problemMessage,
  setChildren,
  type TypedFingerprint,
  typedFingerprint,
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
  const deleteOpen = h(
    'button',
    { type: 'button', class: 'btn is-danger', 'data-action': 'delete-relic' },
    'Delete versions or the relic'
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
          'Remove chosen versions or the whole relic, with every reader\u2019s keys for them. It can\u2019t be undone.'
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
  host.replaceChildren(panel);

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
    access: PrivateAccessJSON
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
    const fingerprintSlot = h('div', { class: 'step-fingerprint' });
    const article = h(
      'article',
      {
        class: 'request',
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
        'ol',
        { class: 'request-steps' },
        h(
          'li',
          {},
          h(
            'p',
            { class: 'step-text' },
            `Call ${requester.email} on the phone or a video call and ask them to read you their fingerprint. Don\u2019t accept it by email or chat.`
          ),
          fingerprintSlot
        ),
        h(
          'li',
          {},
          h(
            'fieldset',
            { class: 'versions' },
            h('legend', {}, 'Versions they can read'),
            picks,
            h(
              'p',
              { class: 'pick-note' },
              'Later versions are always included.'
            )
          )
        ),
        h(
          'li',
          {},
          h('div', { class: 'card-actions', style: 'margin:0' }, grant, decline)
        )
      )
    );

    let field: TypedFingerprint | undefined;
    void identityFingerprint(
      requester.identity.identity_id,
      requester.email
    ).then((expected) => {
      field = typedFingerprint({
        id: fieldId,
        label: `Fingerprint ${requester.email} read to you`,
        inputHook: 'data-fingerprint-input',
        placeholder: 'Type what you heard',
        expected,
        who: requester.email,
      });
      field.onChange((state) => {
        grant.disabled = state !== 'match';
      });
      fingerprintSlot.replaceChildren(field.element);
    });
    grant.addEventListener('click', () => {
      if (!field?.matched()) return;
      void grantAccess(request, article, field.matched() ?? '', grant);
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
        `Declined ${request.requester.email}. They see that when they next open the link; Relic doesn\u2019t email them.`,
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
            'a version of this relic belongs to another owner, so nothing was granted. Nothing was sent.'
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
        `${requester.email} can open ${describeVersions(versions)} and every later version. Relic emailed them.`,
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
      if (data.requests.length === 0) {
        requestsHost.append(
          h('p', { class: 'panel-empty' }, 'No one is waiting.')
        );
      }
      for (const request of data.requests) {
        const verified = await requestVerifies(request, ctx.relicId);
        requestsHost.append(requestTicket(request, verified, data.access));
      }
      renderReaders(data);
      if (message || !keepNotice) showNotice(message);
    } catch (error) {
      showNotice(problemMessage(error), true);
    }
  }

  void refresh('');
}
