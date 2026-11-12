/**
 * Revoke and republish (section 4.12). One passkey tap signs the revocation
 * and the republish. The browser then decrypts the current version with the
 * owner's own key, encrypts it under a fresh key, uploads it to the signed
 * URL, and seals it with the owner identity over the recipients the service
 * reports. Every recipient key is checked against the owner's signatures
 * before a wrap is made, so the revoked identity never receives a wrap and no
 * version is encrypted under the old key.
 */

import {
  type DevicePublicJSON,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  fingerprintsEqual,
  type GrantJSON,
  identityFingerprint,
  identityIdOf,
  kemKeyIdOf,
  keyCommitment,
  parseStatement,
  type PartyJSON,
  type PrivateAccessJSON,
  type RecoveryJSON,
  type SealJSON,
  type StatementKind,
  type StatementMap,
  signStatement,
  statementBytes,
  verifyStatement,
  type WrapJSON,
  wrapVersionKey,
} from '@relic/format/private';
import {
  deriveRendererClass,
  encryptRelic,
  generateKey,
  normalizeEmail,
  sha256Hex,
} from '@relic/format';
import type { ViewerDeps } from '../viewer.ts';
import type { UnlockedIdentity } from './keys.ts';
import { privateKeysOf } from './ops.ts';
import { VerificationRefusedError } from './refusal.ts';
import {
  h,
  icon,
  privateApi,
  problemMessage,
  setChildren,
} from './fingerprint-input.ts';

const PHASES = ['decrypting', 'encrypting', 'uploading', 'sealing'] as const;
type Phase = (typeof PHASES)[number];

export interface RevokeTarget {
  readonly identityId: string;
  readonly email: string;
}

export interface RevokeContext {
  readonly relicId: string;
  readonly deps: ViewerDeps;
  /** Called once a republish has finished, so the panel reloads from the service. */
  onSettled(): void;
}

export interface RevokeDialog {
  readonly element: HTMLDialogElement;
  /** Open the warning for a reader. The caller has checked the version is sealed. */
  open(target: RevokeTarget, access: PrivateAccessJSON): void;
}

/** A party's public keys, after checking they hash to the identity ID the service names. */
export async function verifiedPartyKeys(party: PartyJSON): Promise<{
  readonly kemPublicKey: Uint8Array;
  readonly sigPublicKey: Uint8Array;
}> {
  const kemPublicKey = decodeBase64url(party.identity.kem_public_key);
  const sigPublicKey = decodeBase64url(party.identity.sig_public_key);
  if (
    (await identityIdOf(kemPublicKey, sigPublicKey)) !==
    party.identity.identity_id
  ) {
    throw new VerificationRefusedError(
      'an identity\u2019s keys do not match its identity ID. Nothing was sent.'
    );
  }
  return { kemPublicKey, sigPublicKey };
}

export interface Recipient {
  readonly kemPublicKey: Uint8Array;
  readonly role: 'owner' | 'device' | 'reader' | 'recovery';
}

/** Parses a statement, or refuses it with the given reason. */
function parsedOrRefused<K extends StatementKind>(
  kind: K,
  value: unknown,
  reason: string
): StatementMap[K] {
  try {
    return parseStatement(kind, value);
  } catch {
    throw new VerificationRefusedError(reason);
  }
}

/**
 * The recovery holder, checked the way relic-mcp's `verifyRecovery` checks it.
 * The designation must parse, be signed by this owner's signature key, name
 * this owner, name the holder's identity and email, and carry the fingerprint
 * of exactly that identity. The service's coverage hints are never used here.
 * A holder with no designation cannot be checked, and is refused with the
 * reason.
 */
export async function verifiedRecovery(
  identity: UnlockedIdentity,
  holder: RecoveryJSON
): Promise<{ readonly kemPublicKey: Uint8Array }> {
  if (holder.designation === undefined || holder.designation === null) {
    throw new VerificationRefusedError(
      'the recovery holder has no designation, so Relic cannot check it. Nothing was sent.'
    );
  }
  const statement = parsedOrRefused(
    'recovery_designation',
    holder.designation.statement,
    'the recovery holder\u2019s designation is malformed. Nothing was sent.'
  );
  const keys = await verifiedPartyKeys(holder);
  if (
    statement.owner_identity_id !== identity.identityId ||
    statement.recovery_identity_id !== holder.identity.identity_id ||
    statement.recovery_email === null ||
    normalizeEmail(statement.recovery_email) !== normalizeEmail(holder.email) ||
    statement.fingerprint_typed === null ||
    !fingerprintsEqual(
      statement.fingerprint_typed,
      await identityFingerprint(holder.identity.identity_id, holder.email)
    ) ||
    !(await verifyStatement(
      identity.sigPublicKey,
      statementBytes('recovery_designation', statement),
      holder.designation.identity_signature
    ))
  ) {
    throw new VerificationRefusedError(
      'the recovery holder\u2019s designation did not verify. Nothing was sent.'
    );
  }
  return keys;
}

/**
 * The recipient set a republish wraps to (section 4.12): the owner, every
 * owner device that is not revoked and not expired, every active grant whose
 * grantee is not retired, and the recovery holder when designated. Each
 * device, grant and designation is checked against the owner identity's
 * signature and against the record it describes, and a grant must be for
 * this relic. Anything that does not verify is refused, not skipped.
 */
export async function verifiedRecipients(
  identity: UnlockedIdentity,
  relicId: string,
  parts: {
    readonly devices: readonly DevicePublicJSON[];
    readonly grants: readonly GrantJSON[];
    readonly recovery: RecoveryJSON | null;
  },
  revokedIdentityId: string,
  now: number
): Promise<readonly Recipient[]> {
  const recipients: Recipient[] = [
    { kemPublicKey: identity.kemPublicKey, role: 'owner' },
  ];

  for (const device of parts.devices) {
    if (device.revoked_at !== null || device.not_after <= now) continue;
    const cert = parsedOrRefused(
      'device_cert',
      device.cert.statement,
      'a device certificate is malformed. Nothing was sent.'
    );
    const kemPublicKey = decodeBase64url(device.kem_public_key);
    const sigPublicKey = decodeBase64url(device.sig_public_key);
    if (
      cert.owner_identity_id !== identity.identityId ||
      cert.device_id !== device.device_id ||
      cert.kem_public_key !== device.kem_public_key ||
      cert.sig_public_key !== device.sig_public_key ||
      cert.label !== device.label ||
      cert.not_after !== device.not_after ||
      (await deviceIdOf(kemPublicKey, sigPublicKey)) !== device.device_id ||
      !fingerprintsEqual(
        cert.device_fingerprint_typed,
        await deviceFingerprint(device.device_id)
      ) ||
      !(await verifyStatement(
        identity.sigPublicKey,
        statementBytes('device_cert', cert),
        device.cert.identity_signature
      ))
    ) {
      throw new VerificationRefusedError(
        'a device certificate did not verify. Nothing was sent.'
      );
    }
    recipients.push({ kemPublicKey, role: 'device' });
  }

  for (const grant of parts.grants) {
    if (grant.revoked_at !== null || grant.grantee.identity.retired_at !== null)
      continue;
    if (grant.grantee.identity.identity_id === revokedIdentityId) {
      throw new Error('a revoked identity is still listed as a recipient');
    }
    const statement = parsedOrRefused(
      'grant',
      grant.statement,
      'a grant is malformed. Nothing was sent.'
    );
    const grantee = grant.grantee;
    if (
      statement.relic_id !== relicId ||
      statement.grantee_identity_id !== grantee.identity.identity_id ||
      statement.owner_identity_id !== identity.identityId ||
      normalizeEmail(statement.grantee_email) !==
        normalizeEmail(grantee.email) ||
      !fingerprintsEqual(
        statement.fingerprint_typed,
        await identityFingerprint(grantee.identity.identity_id, grantee.email)
      ) ||
      !(await verifyStatement(
        identity.sigPublicKey,
        statementBytes('grant', statement),
        grant.identity_signature
      ))
    ) {
      throw new VerificationRefusedError(
        'a reader\u2019s grant did not verify for this relic. Nothing was sent.'
      );
    }
    const keys = await verifiedPartyKeys(grantee);
    recipients.push({ kemPublicKey: keys.kemPublicKey, role: 'reader' });
  }

  if (parts.recovery !== null) {
    const keys = await verifiedRecovery(identity, parts.recovery);
    recipients.push({ kemPublicKey: keys.kemPublicKey, role: 'recovery' });
  }

  return recipients;
}

/** Lowercase hex of bytes. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

/** The sealed recipient set: sorted, unique, lowercase hex key IDs. */
export async function recipientKeyIds(
  recipients: readonly Recipient[]
): Promise<string[]> {
  const ids = new Set<string>();
  for (const recipient of recipients) {
    ids.add(hexOf(await kemKeyIdOf(recipient.kemPublicKey)));
  }
  return [...ids].sort();
}

class UploadExpiredError extends Error {
  override readonly name = 'UploadExpiredError';
}

/** A signed upload for the open version, as the service returns it. */
interface UploadGrantJSON {
  readonly upload_url: string;
  readonly upload_method: string;
  readonly upload_headers: Record<string, string>;
  readonly upload_expires_at: string;
}

interface RekeyState {
  identity?: UnlockedIdentity;
  bundle?: unknown;
  key?: Uint8Array;
  container?: Uint8Array;
  upload?: {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly expiresAt: number;
    readonly version: number;
  };
}

/**
 * Build the revocation dialog. The warning (section 4.15) is painted before
 * any request is sent; only the confirm button sends.
 */
export function createRevokeDialog(ctx: RevokeContext): RevokeDialog {
  const warning = h('p', { class: 'sheet-warning', id: 'revoke-warning' });
  const fine = h('p', { class: 'sheet-fine', id: 'revoke-fine' });
  const outcome = h('p', {
    class: 'rekey-outcome',
    id: 'rekey-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const stepItems = PHASES.map((phase) =>
    h(
      'li',
      { 'data-step': phase },
      h('span', { class: 'tick' }, icon('check')),
      h('span', { class: 'step-label' })
    )
  );
  const rekey = h(
    'div',
    {
      class: 'rekey',
      'data-rekey-state': 'decrypting',
      id: 'rekey',
      hidden: true,
    },
    h(
      'ol',
      { class: 'rekey-steps', 'aria-label': 'Republishing' },
      ...stepItems
    ),
    outcome
  );
  const confirmButton = h(
    'button',
    { type: 'button', class: 'action danger', 'data-action': 'confirm-revoke' },
    'Revoke and republish'
  );
  const cancelButton = h(
    'button',
    { type: 'button', class: 'btn', id: 'revoke-cancel' },
    'Cancel'
  );
  const revokeActions = h(
    'div',
    { class: 'sheet-actions', id: 'revoke-actions' },
    confirmButton,
    cancelButton
  );
  const retryButton = h(
    'button',
    {
      type: 'button',
      class: 'action primary',
      id: 'rekey-retry',
      hidden: true,
    },
    'Try again'
  );
  const closeButton = h(
    'button',
    { type: 'button', class: 'btn', id: 'rekey-close' },
    'Close'
  );
  const rekeyActions = h(
    'div',
    { class: 'sheet-actions', id: 'rekey-actions', hidden: true },
    retryButton,
    closeButton
  );
  const dialog = h(
    'dialog',
    { class: 'sheet', id: 'revoke-dialog', 'aria-labelledby': 'revoke-title' },
    h(
      'div',
      { class: 'sheet-body' },
      h('h2', { id: 'revoke-title', tabindex: '-1' }, 'Revoke access'),
      warning,
      fine,
      rekey,
      revokeActions,
      rekeyActions
    )
  );

  let target: RevokeTarget | undefined;
  let previous = 0;
  let running = false;
  let state: RekeyState = {};
  /** What a failed run needs in order to continue. Undefined when there is nothing to retry. */
  let retry: (() => Promise<void>) | undefined;

  function paint(phase: Phase | 'done' | 'failed', at?: Phase): void {
    rekey.hidden = false;
    rekey.setAttribute('data-rekey-state', phase);
    const reached =
      phase === 'done' ? PHASES.length : PHASES.indexOf(at ?? (phase as Phase));
    for (const item of stepItems) {
      const index = PHASES.indexOf(item.getAttribute('data-step') as Phase);
      let stepState = 'pending';
      if (phase === 'done' || index < reached) stepState = 'done';
      else if (index === reached)
        stepState = phase === 'failed' ? 'failed' : 'active';
      item.setAttribute('data-step-state', stepState);
    }
    const finished = phase === 'done' || phase === 'failed';
    revokeActions.hidden = true;
    rekeyActions.hidden = !finished;
    retryButton.hidden = phase !== 'failed' || retry === undefined;
    closeButton.hidden = running;
  }

  function fail(
    at: Phase,
    message: string,
    next: (() => Promise<void>) | undefined
  ): void {
    running = false;
    retry = next;
    setChildren(outcome, message);
    paint('failed', at);
  }

  const who = (): string => target?.email ?? 'them';

  /** Decrypt the current version and encrypt it under a fresh key. Nothing leaves the browser. */
  async function prepare(identity: UnlockedIdentity): Promise<{
    content: Uint8Array;
    container: Uint8Array;
    rendererClass: string;
  }> {
    paint('decrypting');
    const opened = await privateKeysOf(ctx.deps).fetchAndDecryptVersion(
      ctx.deps,
      ctx.relicId,
      previous,
      identity
    );
    const [entry] = opened.envelope.entries;
    if (!entry || opened.envelope.entries.length !== 1)
      throw new Error('unexpected envelope');
    paint('encrypting');
    const key = generateKey();
    const container = await encryptRelic({
      content: opened.content,
      filename: entry.filename,
      mimetype: entry.mimetype,
      key,
    });
    state.key = key;
    state.container = container;
    return {
      content: opened.content,
      container,
      rendererClass: deriveRendererClass(opened.content, entry.filename),
    };
  }

  /** Send the revocation and republish. Returns the signed upload, or undefined after a refusal. */
  async function revoke(
    content: Uint8Array,
    container: Uint8Array,
    rendererClass: string
  ): Promise<void> {
    paint('uploading');
    const answer = await privateApi<{
      revoked_identity_id: string;
      republish: {
        version: number;
        upload_url: string;
        upload_method: string;
        upload_headers: Record<string, string>;
        upload_expires_at: string;
      };
    }>(ctx.deps, 'POST', `/api/relics/${ctx.relicId}/revocations`, {
      attestation: state.bundle,
      renderer_class: rendererClass,
      declared_size_bytes: content.length,
      declared_ciphertext_bytes: container.length,
    });
    if (
      !target ||
      answer.revoked_identity_id !== target.identityId ||
      answer.republish.version !== previous + 1
    ) {
      throw new Error('the revocation answer does not match this request');
    }
    state.upload = {
      url: answer.republish.upload_url,
      method: answer.republish.upload_method,
      headers: answer.republish.upload_headers,
      expiresAt: Date.parse(answer.republish.upload_expires_at),
      version: answer.republish.version,
    };
  }

  /** PUT the encrypted version to the signed URL. */
  async function upload(): Promise<void> {
    const signed = state.upload;
    const container = state.container;
    if (!signed || !container) throw new Error('republish state is missing');
    paint('uploading');
    if (signed.expiresAt <= Date.now()) throw new UploadExpiredError();
    const response = await ctx.deps.fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: container as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) throw new Error(`upload returned ${response.status}`);
  }

  /** Sign the seal over the verified recipients, then send it with the wraps. */
  async function seal(): Promise<void> {
    const identity = state.identity;
    const container = state.container;
    const key = state.key;
    const signed = state.upload;
    if (!identity || !container || !key || !signed || !target) {
      throw new Error('republish state is missing');
    }
    paint('sealing');
    const body = await privateApi<{
      access_epoch: number;
      owner_epoch: number;
      devices: DevicePublicJSON[];
      grants: GrantJSON[];
      recovery: RecoveryJSON | null;
    }>(ctx.deps, 'POST', `/api/relics/${ctx.relicId}/recipients`);
    const recipients = await verifiedRecipients(
      identity,
      ctx.relicId,
      body,
      target.identityId,
      Date.now()
    );
    const wraps: WrapJSON[] = [];
    for (const recipient of recipients) {
      const wrap = await wrapVersionKey({
        recipientPublicKey: recipient.kemPublicKey,
        relicId: ctx.relicId,
        version: signed.version,
        key,
      });
      wraps.push({
        recipient_key_id: wrap.recipientKeyId,
        version: signed.version,
        enc: wrap.enc,
        ct: wrap.ct,
      });
    }
    const statement = {
      access_epoch: body.access_epoch,
      at: Date.now(),
      ciphertext_sha256: sha256Hex(container),
      key_commitment: await keyCommitment({
        relicId: ctx.relicId,
        version: signed.version,
        key,
      }),
      owner_epoch: body.owner_epoch,
      recipient_key_ids: await recipientKeyIds(recipients),
      relic_id: ctx.relicId,
      signer_id: identity.identityId,
      version: signed.version,
    };
    const checked = parseStatement('seal', statement);
    const signature = await signStatement(
      (bytes) => identity.sign(bytes),
      statementBytes('seal', checked)
    );
    const seal: SealJSON = { statement, signature, signer_kind: 'identity' };
    await privateApi(ctx.deps, 'POST', `/api/relics/${ctx.relicId}/complete`, {
      seal,
      wraps,
    });
  }

  async function finish(): Promise<void> {
    running = false;
    retry = undefined;
    state = {};
    setChildren(
      outcome,
      `Done. ${who()} can no longer open this relic. Version ${previous + 1} is sealed and readable by the remaining readers.`
    );
    paint('done');
    ctx.onSettled();
  }

  /** Seal the uploaded version. A refusal here keeps the upload and retries only the seal. */
  async function sealAndFinish(): Promise<void> {
    try {
      await seal();
    } catch (error) {
      fail(
        'sealing',
        `${problemMessage(error)} Version ${previous + 1} isn\u2019t sealed yet, so readers still open version ${previous}.`,
        sealAndFinish
      );
      return;
    }
    await finish();
  }

  /** The signed URL lapsed before use: ask the service for a fresh grant for the same open version. Never re-revokes. */
  async function reissueUpload(): Promise<void> {
    const version = previous + 1;
    try {
      const grant = await privateApi<UploadGrantJSON>(
        ctx.deps,
        'POST',
        `/api/relics/${ctx.relicId}/versions/${version}/upload-grant`
      );
      state.upload = {
        url: grant.upload_url,
        method: grant.upload_method,
        headers: grant.upload_headers,
        expiresAt: Date.parse(grant.upload_expires_at),
        version,
      };
    } catch (error) {
      fail(
        'uploading',
        `Relic has already stopped serving ${who()} and deleted their keys. Version ${version} isn\u2019t sealed yet, so readers still open version ${previous}. ${problemMessage(error)}`,
        reissueUpload
      );
      return;
    }
    await uploadAndFinish();
  }

  /** Upload, then seal. A failed upload retries the upload, not the revocation. */
  async function uploadAndFinish(): Promise<void> {
    try {
      await upload();
    } catch (error) {
      if (error instanceof UploadExpiredError) {
        await reissueUpload();
        return;
      }
      fail(
        'uploading',
        `Republishing stopped while uploading. Relic has already stopped serving ${who()} and deleted their keys. Version ${previous + 1} isn\u2019t sealed yet, so readers still open version ${previous}.`,
        uploadAndFinish
      );
      return;
    }
    await sealAndFinish();
  }

  /** After the tap: prepare, revoke, then upload and seal. Any refusal before the revocation is retried with a new tap. */
  async function republish(): Promise<void> {
    const identity = state.identity;
    if (!identity) throw new Error('no passkey tap yet');
    running = true;
    let prepared: {
      content: Uint8Array;
      container: Uint8Array;
      rendererClass: string;
    };
    try {
      prepared = await prepare(identity);
    } catch {
      fail(
        'decrypting',
        `Nothing was sent. Relic still serves ${who()} and version ${previous} is unchanged.`,
        tapAndRepublish
      );
      return;
    }
    try {
      await revoke(
        prepared.content,
        prepared.container,
        prepared.rendererClass
      );
    } catch (error) {
      fail(
        'uploading',
        `Nothing was revoked. ${problemMessage(error)} Relic still serves ${who()} and version ${previous} is unchanged.`,
        tapAndRepublish
      );
      return;
    }
    await uploadAndFinish();
  }

  /** One passkey tap signs the revocation and the republish, then the rest runs. */
  async function tapAndRepublish(): Promise<void> {
    if (!target) return;
    const reader = target;
    const at = Date.now();
    running = true;
    revokeActions.hidden = true;
    rekey.hidden = true;
    rekeyActions.hidden = true;
    let tapped: { identity: UnlockedIdentity; bundle: unknown };
    try {
      tapped = await privateKeysOf(ctx.deps).attest(ctx.deps, {
        purpose: 'revoke',
        relicId: ctx.relicId,
        build: (identityId) => [
          {
            kind: 'revocation',
            statement: {
              at,
              grantee_identity_id: reader.identityId,
              owner_identity_id: identityId,
              relic_id: ctx.relicId,
            },
          },
          {
            kind: 'republish',
            statement: {
              at,
              owner_identity_id: identityId,
              previous_version: previous,
              reason: 'rekey',
              relic_id: ctx.relicId,
            },
          },
        ],
      });
    } catch (error) {
      running = false;
      rekey.hidden = false;
      setChildren(
        outcome,
        `No passkey tap was accepted. Nothing was sent. ${problemMessage(error)}`
      );
      paint('failed', 'decrypting');
      retry = undefined;
      return;
    }
    state = { identity: tapped.identity, bundle: tapped.bundle };
    await republish();
  }

  confirmButton.addEventListener('click', () => {
    void tapAndRepublish();
  });
  cancelButton.addEventListener('click', () => dialog.close());
  closeButton.addEventListener('click', () => dialog.close());
  retryButton.addEventListener('click', () => {
    const next = retry;
    if (!next) return;
    retry = undefined;
    running = true;
    void next();
  });
  dialog.addEventListener('cancel', (event) => {
    if (running) event.preventDefault();
  });

  return {
    element: dialog,
    open(next, access) {
      if (
        access.sealed_version === null ||
        access.sealed_version !== access.current_version
      ) {
        throw new Error('the current version is not sealed');
      }
      target = next;
      previous = access.current_version;
      state = {};
      retry = undefined;
      running = false;
      const n = previous + 1;
      setChildren(
        warning,
        `Revoke ${next.email}? Relic stops serving them this relic now and deletes their keys for it. Anything they already opened may still be on their device. The current content is republished as version ${n} under a new key that only the remaining readers can open.`
      );
      setChildren(
        fine,
        `One passkey tap. This browser decrypts version ${previous}, encrypts it again and uploads it; keep this tab open until it finishes.`
      );
      const labels: Record<Phase, string> = {
        decrypting: `Decrypting version ${previous} in this browser`,
        encrypting: 'Encrypting it under a new key',
        uploading: `Uploading version ${n}`,
        sealing: `Signing and sealing version ${n}`,
      };
      for (const item of stepItems) {
        const phase = item.getAttribute('data-step') as Phase;
        const label = item.querySelector('.step-label');
        if (label) setChildren(label, labels[phase]);
        item.removeAttribute('data-step-state');
      }
      rekey.hidden = true;
      revokeActions.hidden = false;
      rekeyActions.hidden = true;
      setChildren(outcome, '');
      dialog.showModal();
    },
  };
}
