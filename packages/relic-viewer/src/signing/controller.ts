import {
  formatFingerprint,
  identityFingerprint,
  rosterAdmits,
  type GrantJSON,
} from '@relic/format/private';
import {
  deriveSigningKey,
  verifySignatureRecord,
  type SigningLayout,
} from '@relic/format/signing';
import { readSession } from '../comments.ts';
import { decisionShareProof } from '../decisions.ts';
import { privateApi } from '../private/fingerprint-input.ts';
import { pinnedOwnerFor } from '../private/open.ts';
import { rosterGrants } from '../private/rekey.ts';
import { observeRosterFloor } from '../private/roster-floor.ts';
import { keyForView, type ReadyView, type ViewerDeps } from '../viewer.ts';
import { signingApi, verifyViewerSigningRequest } from './api.ts';
import { mountSigningBoxes, signingPagesFit } from './boxes.ts';
import { openSigningCertificate } from './certificate.ts';
import { openSigningComposer } from './composer.ts';
import { openSignerPanel } from './panel.ts';
import { openSigningStatus } from './status.ts';
export function showPausedSigning(
  signingEnabled: boolean,
  status: string | undefined,
  listedSigner: boolean,
  trusted: boolean
): boolean {
  return !signingEnabled && status === 'open' && listedSigner && trusted;
}


/** All async results decorate the mounted page; they never redraw the document. */
export function mountSigning(input: {
  readonly view: ReadyView;
  readonly relicId: string;
  readonly deps: ViewerDeps;
  readonly stage: HTMLElement;
  readonly onAvailable: (open: (() => void) | undefined) => void;
  readonly onOpenVersion: (version: number) => void;
  readonly onSignIn: (done: () => void) => void;
}): () => void {
  let disposed = false;
  let disposeBoxes: (() => void) | undefined;
  let replacement: (() => void) | undefined;
  const additions: HTMLElement[] = [];
  const view = input.view;
  const refresh = (): void => {
    disposed = true;
    disposeBoxes?.();
    for (const addition of additions) addition.remove();
    input.onAvailable(undefined);
    replacement = mountSigning(input);
  };
  void (async () => {
    const key = await keyForView(view)(view.version);
    const signingKey = await deriveSigningKey(key);
    const shareProof =
      view.access === 'private' ? undefined : await decisionShareProof(key);
    const api = signingApi(input.deps, input.relicId, shareProof);
    const state = await api.read();
    const session = await readSession(input.deps);
    if (disposed) return;
    const request =
      state.requests.find((item) => item.status === 'open') ??
      state.requests[0];
    const content = view.folder?.whole ?? view.content;
    const pin =
      view.access === 'private' ? pinnedOwnerFor(input.relicId) : undefined;
    const owner = view.manage === true;
    let trusted = false;
    let failure = '';
    let layout: SigningLayout | undefined;
    if (request && request.version === view.version) {
      try {
        layout = await verifyViewerSigningRequest({
          request,
          relicId: input.relicId,
          version: view.version,
          digest: view.versionDigest,
          content,
          signingKey,
          access: view.access === 'private' ? 'private' : 'public',
          origin: input.deps.serviceOrigin,
          ...(pin ? { pinnedOwnerIdentityId: pin.identityId } : {}),
          pdf: view.route === 'pdf',
        });
        trusted = true;
      } catch (error) {
        failure =
          error instanceof Error ? error.message : 'signing_request_invalid';
      }
    }
    if (trusted && layout && view.route === 'pdf') {
      let canvas =
        input.stage.querySelector<HTMLCanvasElement>('canvas.relic-page');
      if (!canvas?.dataset['pageCount']) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const finish = (): void => {
          clearTimeout(timer);
          input.stage.removeEventListener('relic:page-changed', finish);
          resolve();
        };
        const timer = setTimeout(finish, 20_000);
        input.stage.addEventListener('relic:page-changed', finish, {
          once: true,
        });
        await promise;
        canvas =
          input.stage.querySelector<HTMLCanvasElement>('canvas.relic-page');
      }
      const count = Number(canvas?.dataset['pageCount']);
      if (!signingPagesFit(layout.boxes, count)) {
        trusted = false;
        failure = 'signing_page_invalid';
      }
    }
    const verifiedSignatures = new Set<number>();
    if (request && trusted) {
      for (const entry of request.signers) {
        const record = entry.signature;
        if (!record) continue;
        const checks = await verifySignatureRecord({
          request: request.request,
          record: {
            statement: record.statement,
            identity_signature: record.identity_signature ?? '',
            mark_ciphertext: record.mark_ciphertext,
            webauthn: record.webauthn,
            signer_identity: entry.identity,
            opened_receipt: record.opened_receipt,
          },
          origin: input.deps.serviceOrigin,
          rpId: new URL(input.deps.serviceOrigin).hostname,
        });
        if (checks.every((check) => check.ok))
          verifiedSignatures.add(entry.index);
      }
    }
    if (disposed) return;
    const signerIndex = state.me?.signer_index;
    const signer =
      signerIndex === undefined
        ? undefined
        : request?.signers.find((entry) => entry.index === signerIndex);
    const paused = view.settings?.signing === false;
    if (paused && !showPausedSigning(false, request?.status, signer !== undefined, trusted))
      return;
    const canSign =
      !paused && trusted && request?.status === 'open' && signer?.status === 'ready';
    if (request && trusted && signerIndex !== undefined) {
      const banner = document.createElement('div');
      banner.className = 'signing-strip';
      const fingerprint = formatFingerprint(
        await identityFingerprint(
          request.owner.identity.identity_id,
          request.owner.identity.email
        )
      );
      if (disposed) return;
      const description = document.createElement('span');
      const ownerName = document.createElement('strong');
      ownerName.textContent = `${request.owner.identity.email} (claimed)`;
      description.append(
        ownerName,
        ` asked you to sign version ${request.version}`
      );
      const fingerprintLabel = document.createElement('span');
      fingerprintLabel.className = 'signing-fingerprint';
      fingerprintLabel.textContent = `Owner ${fingerprint}`;
      banner.append(description, fingerprintLabel);
      if (paused) {
        const notice = document.createElement('span');
        notice.textContent = 'Signing is paused by the owner.';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn primary';
        button.textContent = 'Sign here';
        button.disabled = true;
        banner.append(notice, button);
      }
      const row = input.stage.closest('.relic-row');
      if (row) row.before(banner);
      else input.stage.prepend(banner);
      additions.push(banner);
    }
    const sign = () => {
      if (!canSign || !request || signerIndex === undefined) return;
      openSignerPanel({
        deps: input.deps,
        relicId: input.relicId,
        request,
        signerIndex,
        signingKey,
        ...(layout === undefined ? {} : { layout }),
        signedCount: verifiedSignatures.size,
        ...(shareProof === undefined ? {} : { shareProof }),
        ...(view.signingIdentity === undefined
          ? {}
          : { identity: view.signingIdentity }),
        onSigned: refresh,
      });
    };
    if (request && trusted && layout) {
      if (view.route === 'pdf') {
        disposeBoxes = mountSigningBoxes({
          stage: input.stage,
          boxes: () => layout!.boxes,
          signer: () => signerIndex ?? -1,
          editable: false,
          onChange: () => {},
          onSign: sign,
        });
      }
      if (
        view.route !== 'pdf' ||
        !layout.boxes.some((box) => box.signer === signerIndex)
      ) {
        const block = document.createElement('section');
        block.className = 'sig-block';
        block.setAttribute('aria-label', 'Signatures');
        const heading = document.createElement('h3');
        heading.textContent = `Signatures · version ${request.version}`;
        block.appendChild(heading);
        for (const entry of request.signers) {
          const row = document.createElement('p');
          row.textContent = `${entry.email}: ${entry.status === 'signed' ? (verifiedSignatures.has(entry.index) ? 'Signed' : 'Signature unverified') : 'Waiting'}`;
          if (entry.index === signerIndex && canSign) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn primary';
            button.textContent = 'Sign here';
            button.addEventListener('click', sign);
            row.appendChild(button);
          }
          block.appendChild(row);
        }
        input.stage.appendChild(block);
        additions.push(block);
      }
    }
    if (
      request?.status === 'complete' &&
      state.locked_versions.includes(request.version)
    ) {
      const banner = document.createElement('p');
      banner.className = 'signing-lock';
      banner.textContent =
        view.access === 'private'
          ? `Version ${request.version} was signed by everyone on ${request.completed_at}. It can't be deleted.`
          : `Version ${request.version} was signed by everyone on ${request.completed_at}. It's locked: this relik can't be republished.`;
      input.stage.prepend(banner);
      additions.push(banner);
    }
    async function compose(): Promise<void> {
      let grants: { email: string; identityId: string }[] = [];
      if (view.access === 'private') {
        const identity = view.signingIdentity;
        if (!identity) throw new Error('identity_required');
        const recipients = await privateApi<{ grants: GrantJSON[] }>(
          input.deps,
          'POST',
          `/api/relics/${encodeURIComponent(input.relicId)}/recipients`
        );
        const roster = await rosterGrants(
          {
            identityId: identity.identityId,
            sigPublicKey: identity.sigPublicKey,
          },
          input.relicId,
          recipients.grants
        );
        const floor = observeRosterFloor(identity.identityId, {
          grants: roster.marks,
        });
        const live = new Set(
          roster.live
            .filter((grant) =>
              rosterAdmits(floor.grants?.[grant.key], grant.at)
            )
            .map((grant) => grant.granteeIdentityId)
        );
        grants = recipients.grants
          .filter((grant) => live.has(grant.grantee.identity.identity_id))
          .map((grant) => ({
            email: grant.grantee.email,
            identityId: grant.grantee.identity.identity_id,
          }));
      }
      if (disposed) return;
      openSigningComposer({
        deps: input.deps,
        relicId: input.relicId,
        version: view.version,
        digest: view.versionDigest,
        content,
        signingKey,
        private: view.access === 'private',
        grants,
        pdf: view.route === 'pdf',
        stage: input.stage,
        shareUrl: view.shareUrl,
        onSent: refresh,
      });
    }
    function open(): void {
      if (!request) {
        if (owner) void compose().catch(() => alert('Could not load signing.'));
        return;
      }
      if (request.version !== view.version) {
        input.onOpenVersion(request.version);
        return;
      }
      if (!trusted) {
        const panel = document.createElement('aside');
        panel.className = 'access-panel signing-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Signing request refused');
        const body = document.createElement('div');
        body.className = 'panel-body';
        const message = document.createElement('p');
        message.className = 'panel-notice is-oxide';
        message.textContent =
          failure === 'signing_content_mismatch'
            ? `This file doesn't match the one you were asked to sign. Don't sign it. Ask ${request.owner.identity.email} (claimed) to send the request again.`
            : failure === 'signing_page_invalid'
              ? `This request places a signature box beyond the last page. Don't sign it. Ask ${request.owner.identity.email} (claimed) to send the request again.`
              : "This signing request isn't signed by this relik's owner.";
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn';
        close.textContent = 'Close';
        close.addEventListener('click', () => panel.remove());
        body.append(message, close);
        panel.appendChild(body);
        document.body.appendChild(panel);
        return;
      }
      openSigningStatus({
        deps: input.deps,
        relicId: input.relicId,
        request,
        private: view.access === 'private',
        owner,
        verifiedSignatures,
        ...(canSign ? { onSign: sign } : {}),
        ...(signerIndex === undefined ? {} : { signerIndex }),
        ...(signerIndex === undefined && session.kind !== 'verified'
          ? { onSignIn: () => input.onSignIn(refresh) }
          : {}),
        ...(owner
          ? {
              onRequest: () => {
                void compose();
              },
            }
          : {}),
        onChanged: refresh,
        onCertificate: () => {
          void openSigningCertificate({
            deps: input.deps,
            relicId: input.relicId,
            requestId: request.request_id,
            signingKey,
            content,
            ...(pin ? { trustedOwnerIdentityId: pin.identityId } : {}),
            ...(shareProof === undefined ? {} : { shareProof }),
          });
        },
      });
    }
    if (owner || request) input.onAvailable(open);
  })().catch(() => {
    // A server without signing routes leaves the existing document untouched.
  });
  return () => {
    disposed = true;
    replacement?.();
    disposeBoxes?.();
    for (const addition of additions) addition.remove();
    input.onAvailable(undefined);
  };
}
