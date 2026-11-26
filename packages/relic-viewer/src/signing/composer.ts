import { normalizeEmail } from '@relic/format';
import {
  encodeBase64url,
  formatFingerprint,
  SIGN_CONSENT_ID,
  wrapVersionKey,
  type WrapJSON,
} from '@relic/format/private';
import {
  contentMac,
  layoutCiphertextSha256,
  sealSigningLayout,
  type SigningBox,
} from '@relic/format/signing';
import type { RelicContent } from '../content.ts';
import {
  nowMs,
  signStatements,
  statementBytesOf,
  type StatementDraft,
} from '../private/keys.ts';
import {
  fingerprintGroups,
  h,
  setChildren,
} from '../private/fingerprint-input.ts';
import { privateKeysOf } from '../private/ops.ts';
import { type GrantTarget, lookupShares } from '../private/direct-share.ts';
import { verifiedPartyKeys } from '../private/rekey.ts';
import type { ViewerDeps } from '../viewer.ts';
import { signingApi, signingContent } from './api.ts';
import { mountSigningBoxes } from './boxes.ts';

/** The scope a send resolves signers within: who may already open the relik, and the owner. */
export interface SignerScope {
  readonly deps: ViewerDeps;
  readonly relicId: string;
  readonly grants: readonly {
    readonly email: string;
    readonly identityId: string;
  }[];
  readonly owner?: { readonly identityId: string; readonly email: string };
}

/** The signers a send resolved: granted people carry their verified party. */
export interface Resolved {
  readonly signers: { email: string; identity_id: string | null }[];
  readonly grants: readonly GrantTarget[];
}

export type Resolution =
  | ({ readonly kind: 'ready' } & Resolved)
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Resolves each typed address to a signer. A signer with access keeps it; a
 * registered or invited address is granted in the same tap; anything else is
 * refused, so no request names a signer who could never open the relik.
 */
export async function resolveSigners(
  scope: SignerScope,
  names: readonly string[]
): Promise<Resolution> {
  const known = new Map<string, string>(
    scope.grants.map((grant) => [normalizeEmail(grant.email), grant.identityId])
  );
  if (scope.owner !== undefined) {
    known.set(normalizeEmail(scope.owner.email), scope.owner.identityId);
  }
  const unknown = names.filter((email) => !known.has(email));
  const looked =
    unknown.length === 0
      ? []
      : await lookupShares(
          scope.deps,
          scope.relicId,
          unknown,
          new Set(scope.grants.map((grant) => grant.identityId)),
          scope.owner?.identityId
        );
  const signers: { email: string; identity_id: string | null }[] = [];
  const grants: GrantTarget[] = [];
  for (const email of names) {
    const identityId = known.get(email);
    if (identityId !== undefined) {
      signers.push({ email, identity_id: identityId });
      continue;
    }
    const row = looked.find((entry) => normalizeEmail(entry.email) === email);
    if (row?.kind === 'registered' || row?.kind === 'invited') {
      grants.push({ party: row.party, fingerprint: row.fingerprint });
      signers.push({ email, identity_id: row.party.identity.identity_id });
      continue;
    }
    // Plan 3.8: an address holding only an invitation is told why, not sent to invite again.
    return {
      kind: 'refused',
      message:
        row?.kind === 'unregistered' && row.invites.length > 0
          ? `${email} has an invitation but hasn't set up a private-share key, so they can't sign yet.`
          : `${email} can't open this relik yet, so they can't be asked to sign. Invite them in Access first.`,
    };
  }
  return { kind: 'ready', signers, grants };
}

/** The notice that names each person a send will grant. Each fingerprint is listed under its address. */
export function grantNotice(grants: readonly GrantTarget[]): string {
  if (grants.length === 0) return '';
  return `Relik will grant ${grants.map((grant) => grant.party.email).join(', ')} access when you send. Check each fingerprint first.`;
}

/** Owner-only composer. Private signer identities come from the owner's verified grants. */
export function openSigningComposer(input: {
  readonly deps: ViewerDeps;
  readonly relicId: string;
  readonly version: number;
  readonly digest: string;
  readonly content: RelicContent;
  readonly signingKey: Uint8Array;
  readonly private: boolean;
  readonly grants: readonly { email: string; identityId: string }[];
  /** The owner's own identity, so the owner can be added as a private signer. */
  readonly owner?: { readonly identityId: string; readonly email: string };
  readonly pdf: boolean;
  readonly stage: HTMLElement;
  readonly shareUrl: string;
  readonly onSent: () => void;
}): HTMLElement {
  const panel = document.createElement('aside');
  panel.className = 'access-panel signing-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Request signatures');
  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Request signatures';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close signing');
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'panel-body';
  const lead = document.createElement('p');
  lead.className = 'panel-lead';
  lead.textContent =
    'Pick a signer, then drag on a page to place their box. A signer with no boxes signs in a block after the document.';
  const list = document.createElement('div');
  list.className = 'panel-section';
  const listTitle = document.createElement('h3');
  listTitle.textContent = 'Signers';
  const rows = document.createElement('div');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn is-small';
  add.textContent = 'Add signer';
  list.append(listTitle, rows, add);
  const orderSection = document.createElement('section');
  orderSection.className = 'panel-section';
  const orderTitle = document.createElement('h3');
  orderTitle.textContent = 'Order';
  const order = document.createElement('div');
  order.className = 'seg';
  order.setAttribute('role', 'group');
  order.setAttribute('aria-label', 'Signing order');
  const anyOrder = document.createElement('button');
  anyOrder.type = 'button';
  anyOrder.textContent = 'Any order';
  const inOrder = document.createElement('button');
  inOrder.type = 'button';
  inOrder.textContent = 'In order';
  const orderHint = document.createElement('span');
  orderHint.className = 'field-hint';
  let orderValue: 'parallel' | 'sequential' = 'parallel';
  const updateOrder = (): void => {
    anyOrder.setAttribute('aria-pressed', String(orderValue === 'parallel'));
    inOrder.setAttribute('aria-pressed', String(orderValue === 'sequential'));
    orderHint.textContent =
      orderValue === 'parallel'
        ? 'Every signer can sign as soon as the request is sent.'
        : 'Signer 2 can sign once signer 1 has signed.';
  };
  anyOrder.addEventListener('click', () => {
    orderValue = 'parallel';
    updateOrder();
  });
  inOrder.addEventListener('click', () => {
    orderValue = 'sequential';
    updateOrder();
  });
  order.append(anyOrder, inOrder);
  orderSection.append(orderTitle, order, orderHint);
  updateOrder();
  const openedLabel = document.createElement('label');
  const opened = document.createElement('input');
  opened.type = 'checkbox';
  openedLabel.append(opened, ' Require opened');
  openedLabel.hidden = !input.private;
  const placement = document.createElement('section');
  placement.className = 'panel-section';
  placement.hidden = !input.pdf;
  const placementTitle = document.createElement('h3');
  placementTitle.textContent = 'Place with the keyboard';
  const pageSelect = document.createElement('select');
  pageSelect.setAttribute('aria-label', 'Page');
  const syncPageSelect = (): void => {
    const canvas =
      input.stage.querySelector<HTMLCanvasElement>('canvas.relic-page');
    const pageCount = Number(canvas?.dataset['pageCount'] ?? 0);
    if (pageSelect.options.length !== pageCount) {
      pageSelect.replaceChildren();
      for (let page = 1; page <= pageCount; page++) {
        const option = document.createElement('option');
        option.value = String(page);
        option.textContent = `Page ${page}`;
        pageSelect.appendChild(option);
      }
    }
    if (canvas?.dataset['pageNumber'])
      pageSelect.value = canvas.dataset['pageNumber'];
  };
  syncPageSelect();
  pageSelect.addEventListener('change', () => {
    input.stage.querySelector('.doc-pdf')?.dispatchEvent(
      new CustomEvent('relic:turn-page', {
        detail: { page: Number(pageSelect.value) },
      })
    );
  });
  const pageEvents = new AbortController();
  input.stage.addEventListener('relic:page-changed', syncPageSelect, {
    signal: pageEvents.signal,
  });
  const placementControls = document.createElement('div');
  placementControls.className = 'signing-placement';
  const keyboard = document.createElement('button');
  keyboard.type = 'button';
  keyboard.className = 'btn is-small';
  keyboard.textContent = 'Add box on this page';
  const keyboardHint = document.createElement('span');
  keyboardHint.className = 'field-hint';
  keyboardHint.textContent =
    'Select a box and use the arrow keys to move it, Shift with the arrows to resize, Delete to remove.';
  placementControls.append(pageSelect, keyboard);
  placement.append(placementTitle, placementControls, keyboardHint);
  const notice = document.createElement('div');
  notice.className = 'panel-notice';
  notice.setAttribute('role', 'status');
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'btn primary';
  send.textContent = 'Review and send';
  body.append(lead, list, orderSection, openedLabel, placement, notice, send);
  panel.append(head, body);
  let boxes: readonly SigningBox[] = [];
  let current = 0;
  const emails: HTMLInputElement[] = [];
  let resolved: Resolved | undefined;
  let reviewGeneration = 0;
  const invalidateReview = (): void => {
    reviewGeneration++;
    resolved = undefined;
    delete send.dataset['confirmed'];
    send.textContent = 'Review and send';
  };
  const updateRows = (): void => {
    listTitle.textContent = `Signers ${emails.length} of 20`;
    emails.forEach((email, index) => {
      const row = email.parentElement;
      if (!row) return;
      email.setAttribute('aria-label', `Signer ${index + 1} email`);
      row.dataset['selected'] = String(index === current);
      const tag = row.querySelector<HTMLElement>('.signer-tag');
      if (tag) tag.textContent = String(index + 1);
      const count = boxes.filter((box) => box.signer === index).length;
      const meta = row.querySelector<HTMLElement>('.row-meta');
      if (meta)
        meta.textContent =
          count === 0
            ? 'No boxes: signs in the block after the document'
            : `${count} ${count === 1 ? 'box' : 'boxes'}`;
    });
  };
  const dispose = input.pdf
    ? mountSigningBoxes({
        stage: input.stage,
        boxes: () => boxes,
        signer: () => current,
        editable: true,
        onChange: (next) => {
          boxes = next;
          updateRows();
        },
      })
    : () => {};
  function appendSigner(): void {
    invalidateReview();
    if (emails.length >= 20) return;
    const row = document.createElement('div');
    row.className = 'signer-row';
    const tag = document.createElement('span');
    tag.className = 'signer-tag';
    const email = document.createElement('input');
    email.type = 'email';
    email.className = 'input';
    email.addEventListener('input', invalidateReview);
    email.addEventListener('focus', () => {
      current = emails.indexOf(email);
      updateRows();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'panel-close';
    remove.setAttribute('aria-label', 'Remove signer');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      invalidateReview();
      const removed = emails.indexOf(email);
      emails.splice(removed, 1);
      boxes = boxes
        .filter((box) => box.signer !== removed)
        .map((box) =>
          box.signer > removed ? { ...box, signer: box.signer - 1 } : box
        );
      current = Math.max(0, Math.min(current, emails.length - 1));
      row.remove();
      updateRows();
      input.stage.dispatchEvent(new Event('relic:page-changed'));
    });
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    emails.push(email);
    row.append(tag, email, remove, meta);
    rows.appendChild(row);
    updateRows();
  }
  add.addEventListener('click', appendSigner);
  keyboard.addEventListener('click', () => {
    const canvas =
      input.stage.querySelector<HTMLCanvasElement>('canvas.relic-page');
    if (!canvas || boxes.filter((box) => box.signer === current).length >= 20)
      return;
    const page = Number(canvas.dataset['pageNumber']);
    const count = boxes.filter(
      (box) => box.signer === current && box.page === page
    ).length;
    boxes = [
      ...boxes,
      {
        signer: current,
        page,
        rect: {
          x: count % 2 === 0 ? 0.1 : 0.55,
          y: Math.min(0.9, 0.65 + Math.floor(count / 2) * 0.08),
          w: 0.3,
          h: 0.06,
        },
      },
    ];
    updateRows();
    input.stage.dispatchEvent(new Event('relic:page-changed'));
  });
  close.addEventListener('click', () => {
    dispose();
    pageEvents.abort();
    panel.remove();
  });
  send.addEventListener('click', () => {
    const names = emails.map((field) => normalizeEmail(field.value));
    if (
      names.length === 0 ||
      names.some((email) => !email.includes('@')) ||
      new Set(names).size !== names.length
    ) {
      notice.textContent = 'Enter a different email address for each signer.';
      return;
    }
    if (send.dataset['confirmed'] !== 'true') {
      send.disabled = true;
      const generation = reviewGeneration;
      void (
        input.private
          ? resolveSigners(
              {
                deps: input.deps,
                relicId: input.relicId,
                grants: input.grants,
                ...(input.owner === undefined ? {} : { owner: input.owner }),
              },
              names
            )
          : Promise.resolve({
              kind: 'ready' as const,
              signers: names.map((email) => ({ email, identity_id: null })),
              grants: [],
            })
      )
        .then((next) => {
          send.disabled = false;
          if (generation !== reviewGeneration) return;
          if (next.kind === 'refused') {
            notice.textContent = next.message;
            return;
          }
          resolved = next;
          // Each fingerprint sits under its own address, so the owner checks
          // the right one with the right person.
          setChildren(
            notice,
            ...(next.grants.length === 0
              ? []
              : [
                  h('p', {}, grantNotice(next.grants)),
                  h(
                    'ul',
                    { class: 'grant-list' },
                    ...next.grants.map((grant) =>
                      h(
                        'li',
                        {},
                        h('strong', {}, grant.party.email),
                        h(
                          'p',
                          { class: 'fingerprint is-small' },
                          ...fingerprintGroups(
                            formatFingerprint(grant.fingerprint)
                          )
                        )
                      )
                    )
                  ),
                ])
          );
          send.dataset['confirmed'] = 'true';
          send.textContent = 'Send with passkey';
        })
        .catch(() => {
          send.disabled = false;
          notice.textContent =
            'Relik could not check those addresses. Try again.';
        });
      return;
    }
    if (resolved === undefined) return;
    if (
      names.length !== resolved.signers.length ||
      names.some((email, index) => email !== resolved!.signers[index]?.email)
    ) {
      invalidateReview();
      notice.textContent = 'The signer list changed. Review it again.';
      return;
    }
    const { signers, grants } = resolved;
    notice.textContent =
      "Each signer confirms with a passkey on their own device. Relik records which passkey approved which version, and when. It doesn't verify anyone's identity.";
    send.disabled = true;
    for (const email of emails) email.disabled = true;
    add.disabled = true;
    const removeButtons = [
      ...rows.querySelectorAll<HTMLButtonElement>('button'),
    ];
    for (const button of removeButtons) button.disabled = true;
    void (async () => {
      const requestId = encodeBase64url(
        crypto.getRandomValues(new Uint8Array(16))
      );
      const layout = await sealSigningLayout({
        signingKey: input.signingKey,
        relicId: input.relicId,
        version: input.version,
        layout: { v: 1, boxes },
        signerCount: signers.length,
        pdf: input.pdf,
      });
      const mac = await contentMac(
        input.signingKey,
        signingContent(input.content)
      );
      const tapped = await privateKeysOf(input.deps).attest(input.deps, {
        purpose: 'signing_request',
        relicId: input.relicId,
        build: (identityId) => [
          {
            kind: 'signing_request',
            statement: {
              at: nowMs(input.deps),
              ciphertext_sha256: input.digest,
              consent: SIGN_CONSENT_ID,
              content_mac: mac,
              layout_sha256: layoutCiphertextSha256(layout),
              order: orderValue,
              owner_identity_id: identityId,
              relic_id: input.relicId,
              request_id: requestId,
              require_opened: input.private && opened.checked,
              signer_id: identityId,
              signers,
              version: input.version,
            },
          },
        ],
      });
      const at = nowMs(input.deps);
      const grantDrafts: StatementDraft[] = grants.map((grant) => ({
        kind: 'grant',
        statement: {
          at,
          fingerprint_typed: grant.fingerprint,
          grantee_email: grant.party.email,
          grantee_identity_id: grant.party.identity.identity_id,
          owner_identity_id: tapped.identity.identityId,
          relic_id: input.relicId,
          versions: [input.version],
        },
      }));
      const signedGrants = await signStatements(
        (message) => tapped.identity.sign(message),
        grantDrafts,
        statementBytesOf(grantDrafts)
      );
      const wraps: WrapJSON[] = [];
      if (grants.length > 0) {
        const fetched = await privateKeysOf(input.deps).fetchVersionKey(
          input.deps,
          input.relicId,
          input.version,
          tapped.identity
        );
        for (const grant of grants) {
          const keys = await verifiedPartyKeys(grant.party);
          const wrap = await wrapVersionKey({
            recipientPublicKey: keys.kemPublicKey,
            relicId: input.relicId,
            version: input.version,
            key: fetched.key,
          });
          wraps.push({
            recipient_key_id: wrap.recipientKeyId,
            version: input.version,
            enc: wrap.enc,
            ct: wrap.ct,
          });
        }
      }
      await signingApi(input.deps, input.relicId).request(
        tapped.bundle,
        layout,
        grants.length === 0
          ? undefined
          : {
              grants: signedGrants.map((grant) => ({
                statement: grant.statement,
                identity_signature: grant.identity_signature,
              })),
              wraps,
            }
      );
      dispose();
      pageEvents.abort();
      body.replaceChildren();
      const result = document.createElement('p');
      result.className = 'panel-notice';
      result.textContent = input.private
        ? `Relik emailed ${signers.length === 1 ? 'the signer' : 'the signers'}.`
        : 'The link carries the key. Relik never sees it.';
      body.appendChild(result);
      if (!input.private)
        for (const signer of signers) {
          const message = `Please sign version ${input.version}. Open this link and sign in with ${signer.email}: ${input.shareUrl}`;
          const item = document.createElement('p');
          item.textContent = signer.email;
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.textContent = 'Copy';
          copy.addEventListener(
            'click',
            () => void navigator.clipboard.writeText(message)
          );
          const mail = document.createElement('a');
          mail.textContent = 'Email draft';
          mail.href = `mailto:${encodeURIComponent(signer.email)}?subject=${encodeURIComponent('Please sign')}&body=${encodeURIComponent(message)}`;
          item.append(copy, mail);
          body.appendChild(item);
        }
      input.onSent();
    })().catch((error: unknown) => {
      notice.textContent =
        error instanceof Error ? error.message : 'Could not send the request.';
      send.disabled = false;
      for (const email of emails) email.disabled = false;
      add.disabled = false;
      for (const button of removeButtons) button.disabled = false;
    });
  });
  appendSigner();
  document.body.appendChild(panel);
  return panel;
}
