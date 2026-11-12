/**
 * Private relics, as relic-mcp publishes and maintains them.
 *
 * A private relic's link carries no key. Each version has its own content
 * key, and that key is wrapped (HPKE) to every reader who may open the
 * version: the owner, the owner's certified devices, the recovery recipient,
 * and each grantee. relic-mcp is one of those devices, so it can publish
 * and republish without a passkey tap.
 *
 * What relic-mcp will wrap to is decided here, not by the service. Every
 * recipient is verified against the owner identity this machine pinned at
 * enrollment before a single key is wrapped. A grant the owner did not sign,
 * a key that does not hash to its identity, an uncertified device, and an
 * unsigned recovery designation are each refused. Nothing in this module
 * returns a content key, a publish token, or a wrapped key to a caller.
 */

import {
  decodeKey,
  deriveRendererClass,
  encodeKey,
  encryptRelic,
  generateKey,
  generateRelicId,
  isValidRelicId,
  normalizeEmail,
  type RendererClass,
} from '@relic/format';
import {
  decodeBase64url,
  formatFingerprint,
  identityFingerprint,
  fingerprintsEqual,
  keyCommitment,
  parseStatement,
  statementBytes,
  type StatementMap,
  unwrapVersionKey,
  verifyStatement,
  wrapVersionKey,
  type WrapJSON,
  type SealJSON,
} from '@relic/format/private';
import {
  assertOwnerPin,
  type DeviceEntry,
  type DeviceOwner,
  type DeviceSigner,
  deviceSigner,
  expectEpoch,
  expectRecord,
  expectString,
  fetchDeviceContext,
  freshNonce,
  grantKey,
  loadDeviceEntry,
  observeOwnerState,
  partyIdentity,
  type SeenStatement,
  sha256Hex,
  signDeviceStatement,
  verifyDeviceCert,
  verifyDeviceList,
  verifyRecoveryField,
  type VerifiedReader,
} from './device.ts';
import {
  contentDigest,
  guessMimetype,
  lookupPublishedSource,
  postJson,
  PublishError,
  type PublishDeps,
  putContainer,
  readSource,
  ServerRefusal,
} from './publish.ts';
import {
  loadPrivateInventory,
  loadPrivatePublishState,
  loadPublishState,
  type PrivatePublishState,
  savePrivatePublishState,
} from './state.ts';

/** Attempts at a seal before a recipients change is reported rather than retried forever. */
const SEAL_ATTEMPTS = 3;

export interface PrivatePublishInput {
  readonly path: string;
  readonly filename?: string | undefined;
  readonly title?: string | undefined;
  readonly ttl_days?: number | undefined;
  readonly cover?: boolean | undefined;
  readonly force_new?: boolean | undefined;
  readonly decisions?: boolean | undefined;
}

export interface PrivateRepublishInput {
  readonly relic_id: string;
  readonly path: string;
  readonly filename?: string | undefined;
  readonly title?: string | undefined;
  readonly ttl_days?: number | undefined;
  readonly cover?: boolean | undefined;
  readonly notify?: boolean | undefined;
  readonly decisions?: boolean | undefined;
}

/** A recipient as the output shows it: public facts only. */
export interface PrivateRecipientOutput {
  readonly kind: VerifiedReader['kind'];
  readonly email?: string | undefined;
  readonly label?: string | undefined;
  readonly fingerprint: string;
}

export interface PrivatePublishResult {
  readonly access: 'private';
  /** The keyless link. It is the relic's origin and id, never a fragment. */
  readonly url: string;
  readonly relic_id: string;
  readonly version: number;
  readonly version_digest: string;
  readonly relic_expires_at: string | null;
  readonly renderer_class: RendererClass;
  readonly filename: string;
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
  readonly owner: { readonly email: string; readonly fingerprint: string };
  readonly recipients: readonly PrivateRecipientOutput[];
}

export interface PrivateRepublishResult {
  readonly access: 'private';
  readonly relic_id: string;
  readonly version: number;
  readonly version_digest: string;
  readonly relic_expires_at: string | null;
  readonly renderer_class: RendererClass;
  readonly filename: string;
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
  readonly notify: boolean;
  readonly recipients: readonly PrivateRecipientOutput[];
}

/** The device, its signer and the owner it is certified by, after the enrollment check. */
interface DeviceSession {
  readonly entry: DeviceEntry;
  readonly signer: DeviceSigner;
  readonly pin: DeviceOwner;
}

/** One verified view of who may read the relic at a version, and the epochs it was taken at. */
interface Snapshot {
  readonly version: number;
  readonly accessEpoch: number;
  readonly ownerEpoch: number;
  readonly readers: readonly VerifiedReader[];
}

async function deviceSession(deps: PublishDeps): Promise<DeviceSession> {
  const entry = await loadDeviceEntry(deps.serviceOrigin);
  if (entry?.owner === undefined) {
    throw new PublishError(
      'device_not_enrolled',
      `this machine has no certified device for ${deps.serviceOrigin}. ` +
        'Call relic_enroll_device, have the owner approve it, then call relic_confirm_device.'
    );
  }
  return {
    entry,
    signer: await deviceSigner(entry, deps.secureEnclave),
    pin: entry.owner,
  };
}

/**
 * Refuse the options a private relic does not carry. Checked before the
 * source is read or anything touches the network.
 */
function refuseRegulatedOptions(
  title: string | undefined,
  cover: boolean | undefined
): void {
  if (title !== undefined && title.length > 0) {
    throw new PublishError(
      'private_policy_violation',
      'a private relic carries no title. Publish it without one.',
      { policy_check: 'title' }
    );
  }
  if (cover === true) {
    throw new PublishError(
      'private_policy_violation',
      'a private relic carries no cover image.',
      { policy_check: 'cover' }
    );
  }
}

interface PrivateCapability {
  readonly defaultTtlDays: number;
  readonly maxTtlDays: number;
}

/**
 * The server's private-share capability, read from the challenge answer.
 *
 * A server that does not declare it is older than private shares. Nothing is
 * uploaded to it, so a client release ahead of the server stays safe.
 */
export async function privateCapability(
  deps: PublishDeps
): Promise<PrivateCapability> {
  const challenge = expectRecord(
    await postJson(deps, `${deps.serviceOrigin}/api/challenge`, {}),
    'challenge'
  );
  const declared = challenge['private_shares'];
  if (
    declared === null ||
    typeof declared !== 'object' ||
    Array.isArray(declared)
  ) {
    throw new PublishError(
      'private_unsupported',
      `${deps.serviceOrigin} does not support private relics yet. Nothing was uploaded.`
    );
  }
  const record = declared as Record<string, unknown>;
  const defaultTtlDays = Number(record['default_ttl_days']);
  const maxTtlDays = Number(record['max_ttl_days']);
  if (
    !Number.isSafeInteger(defaultTtlDays) ||
    !Number.isSafeInteger(maxTtlDays)
  ) {
    throw new PublishError(
      'private_unsupported',
      `${deps.serviceOrigin} declared private relics with no usable lifetime limits. Nothing was uploaded.`
    );
  }
  return { defaultTtlDays, maxTtlDays };
}

function checkTtl(ttl: number, capability: PrivateCapability): void {
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > capability.maxTtlDays) {
    throw new PublishError(
      'private_ttl_out_of_range',
      `a private relic lasts 1 to ${capability.maxTtlDays} days, not ${ttl}`,
      { policy_check: 'ttl', max_ttl_days: capability.maxTtlDays }
    );
  }
}

async function ownerReader(pin: DeviceOwner): Promise<VerifiedReader> {
  const publicKey = decodeBase64url(pin.kem_public_key);
  return {
    kind: 'owner',
    publicKey,
    keyId: sha256Hex(publicKey),
    email: pin.email,
    fingerprint: formatFingerprint(
      await identityFingerprint(pin.identity_id, pin.email)
    ),
  };
}

async function ownerDisplay(
  pin: DeviceOwner
): Promise<{ email: string; fingerprint: string }> {
  return {
    email: pin.email,
    fingerprint: formatFingerprint(
      await identityFingerprint(pin.identity_id, pin.email)
    ),
  };
}

/** A grant the owner signed, verified: its grantee's reader, the grantee's identity, and the owner-signed `at`. */
export interface VerifiedGrant {
  readonly reader: VerifiedReader;
  readonly granteeIdentityId: string;
  readonly at: number;
}

/** Verify one grant the owner signed, and the grantee it names, before it can receive a wrap. */
export async function verifyGrant(
  grant: Record<string, unknown>,
  pin: DeviceOwner,
  relicId: string
): Promise<VerifiedGrant> {
  const forged = new PublishError(
    'recipient_forged_grant',
    'a grant is not signed by the pinned owner for this relic, so no key is wrapped for it'
  );
  const statement = parseStatement(
    'grant',
    expectRecord(grant['statement'], 'grant statement')
  );
  const signed = await verifyStatement(
    decodeBase64url(pin.sig_public_key),
    statementBytes('grant', statement),
    expectString(grant['identity_signature'], 'grant signature')
  );
  if (
    !signed ||
    statement.owner_identity_id !== pin.identity_id ||
    statement.relic_id !== relicId
  ) {
    throw forged;
  }
  const party = await partyIdentity(
    expectRecord(
      expectRecord(grant['grantee'], 'grantee')['identity'],
      'grantee identity'
    )
  );
  if (
    party.identityId !== statement.grantee_identity_id ||
    normalizeEmail(party.email) !== normalizeEmail(statement.grantee_email)
  ) {
    throw forged;
  }
  const fingerprint = await identityFingerprint(party.identityId, party.email);
  if (!fingerprintsEqual(statement.fingerprint_typed, fingerprint))
    throw forged;
  return {
    reader: {
      kind: 'grantee',
      publicKey: party.kemBytes,
      keyId: sha256Hex(party.kemBytes),
      email: normalizeEmail(statement.grantee_email),
      fingerprint: formatFingerprint(fingerprint),
    },
    granteeIdentityId: party.identityId,
    at: statement.at,
  };
}

/**
 * The recipients of a relic that already exists, from the publish-token read,
 * verified in full. A revoked grant is not a recipient, but it is still
 * verified: its owner-signed time is what holds the service to a revocation
 * this machine has already seen. Nothing is wrapped to an answer that goes back
 * on what the machine has accepted.
 */
async function fetchRecipients(
  deps: PublishDeps,
  relicId: string,
  publishToken: string,
  pin: DeviceOwner
): Promise<Snapshot> {
  const body = expectRecord(
    await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${relicId}/recipients`,
      {
        publish_token: publishToken,
      }
    ),
    'recipients'
  );
  const ownerParty = expectRecord(body['owner'], 'owner');
  const owner = await partyIdentity(
    expectRecord(ownerParty['identity'], 'owner identity')
  );
  assertOwnerPin(pin, {
    identityId: owner.identityId,
    email: expectString(ownerParty['email'], 'owner email'),
    kem: owner.kem,
    sig: owner.sig,
  });

  const devices = await verifyDeviceList(body['devices'], pin, Date.now());
  const recovery = await verifyRecoveryField(body['recovery'], pin);

  const grantList = body['grants'];
  if (!Array.isArray(grantList)) {
    throw new PublishError(
      'app_response_unusable',
      'the grant list is missing'
    );
  }
  const grants: VerifiedReader[] = [];
  const grantStatements: Record<string, SeenStatement> = {};
  for (const item of grantList) {
    const grant = expectRecord(item, 'grant');
    const verified = await verifyGrant(grant, pin, relicId);
    const revoked =
      grant['revoked_at'] !== null && grant['revoked_at'] !== undefined;
    grantStatements[grantKey(relicId, verified.granteeIdentityId)] = {
      at: verified.at,
      revoked,
    };
    if (!revoked) grants.push(verified.reader);
  }

  const ownerEpoch = expectEpoch(body['owner_epoch'], 'owner epoch');
  await observeOwnerState(deps.serviceOrigin, {
    ownerEpoch,
    designatedAt: recovery?.designatedAt,
    devices: devices.statements,
    grants: grantStatements,
  });

  const owned = await ownerReader(pin);
  return {
    version: Number(body['current_version']),
    accessEpoch: Number(body['access_epoch']),
    ownerEpoch,
    readers: [
      owned,
      ...devices.readers,
      ...(recovery === undefined ? [] : [recovery.reader]),
      ...grants,
    ],
  };
}

/**
 * The relic's current version, read from the service with the publish token.
 * It goes through the same verified recipients read as a republish.
 */
export async function currentPrivateVersion(
  deps: PublishDeps,
  relicId: string,
  state: PrivatePublishState
): Promise<number> {
  const session = await deviceSession(deps);
  const snapshot = await fetchRecipients(
    deps,
    relicId,
    state.publish_token,
    session.pin
  );
  return snapshot.version;
}

/** Wrap one version key to every reader, in the order given. */
async function wrapTo(
  readers: readonly VerifiedReader[],
  relicId: string,
  version: number,
  key: Uint8Array
): Promise<WrapJSON[]> {
  const wraps: WrapJSON[] = [];
  for (const reader of readers) {
    const wrapped = await wrapVersionKey({
      recipientPublicKey: reader.publicKey,
      relicId,
      version,
      key,
    });
    wraps.push({
      recipient_key_id: wrapped.recipientKeyId,
      version,
      enc: wrapped.enc,
      ct: wrapped.ct,
    });
  }
  return wraps;
}

/**
 * Seal one version: a device signature over its digest, the access and owner
 * epochs the wraps were taken at, the exact recipient set, and the key
 * commitment that binds the wraps to one key.
 */
async function sealVersion(input: {
  readonly signer: DeviceSigner;
  readonly deviceId: string;
  readonly relicId: string;
  readonly snapshot: Snapshot;
  readonly ciphertextSha256: string;
  readonly key: Uint8Array;
}): Promise<SealJSON> {
  const statement: StatementMap['seal'] = {
    access_epoch: input.snapshot.accessEpoch,
    at: Date.now(),
    ciphertext_sha256: input.ciphertextSha256,
    key_commitment: await keyCommitment({
      relicId: input.relicId,
      version: input.snapshot.version,
      key: input.key,
    }),
    owner_epoch: input.snapshot.ownerEpoch,
    recipient_key_ids: input.snapshot.readers
      .map((reader) => reader.keyId)
      .sort(),
    relic_id: input.relicId,
    signer_id: input.deviceId,
    version: input.snapshot.version,
  };
  return {
    statement: { ...statement },
    signature: await signDeviceStatement(input.signer, 'seal', statement),
    signer_kind: 'device',
  };
}

/**
 * Seal and complete one version. A recipients change between the wraps and the
 * seal is answered by taking a fresh snapshot, rewrapping the same key and
 * ciphertext, and trying again. Any other refusal is final.
 */
async function completeVersion(input: {
  readonly deps: PublishDeps;
  readonly relicId: string;
  readonly publishToken: string;
  readonly key: Uint8Array;
  readonly container: Uint8Array;
  readonly session: DeviceSession;
  readonly first: Snapshot;
  readonly refresh: () => Promise<Snapshot>;
}): Promise<Record<string, unknown>> {
  const ciphertextSha256 = sha256Hex(input.container);
  let snapshot = input.first;
  let lastRefusal: ServerRefusal | undefined;
  for (let attempt = 0; attempt < SEAL_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      snapshot = await input.refresh();
      if (snapshot.version !== input.first.version) {
        throw new PublishError(
          'version_conflict',
          `relic ${input.relicId} moved to version ${snapshot.version} while version ${input.first.version} was being sealed`,
          { relic_id: input.relicId }
        );
      }
    }
    const wraps = await wrapTo(
      snapshot.readers,
      input.relicId,
      snapshot.version,
      input.key
    );
    const seal = await sealVersion({
      signer: input.session.signer,
      deviceId: input.session.entry.device_id,
      relicId: input.relicId,
      snapshot,
      ciphertextSha256,
      key: input.key,
    });
    try {
      return expectRecord(
        await postJson(
          input.deps,
          `${input.deps.serviceOrigin}/api/relics/${input.relicId}/complete`,
          {
            seal,
            wraps,
            publish_token: input.publishToken,
          }
        ),
        'completion'
      );
    } catch (error) {
      if (
        error instanceof ServerRefusal &&
        error.code === 'recipients_changed'
      ) {
        lastRefusal = error;
        continue;
      }
      throw error;
    }
  }
  throw (
    lastRefusal ??
    new PublishError('service_unreachable', 'could not seal the version')
  );
}

function recipientOutput(
  readers: readonly VerifiedReader[]
): PrivateRecipientOutput[] {
  return readers.map((reader) => ({
    kind: reader.kind,
    email: reader.email,
    label: reader.label,
    fingerprint: reader.fingerprint,
  }));
}

/**
 * Publish a private relic. No passkey is involved: the device signs the grant
 * and the seal. The returned link has no fragment and no key.
 */
export async function publishPrivate(
  input: PrivatePublishInput,
  deps: PublishDeps
): Promise<PrivatePublishResult> {
  refuseRegulatedOptions(input.title, input.cover);
  const session = await deviceSession(deps);
  const capability = await privateCapability(deps);
  const ttl = input.ttl_days ?? capability.defaultTtlDays;
  checkTtl(ttl, capability);

  const source = await readSource(input.path, deps.files);
  const lookup = await lookupPublishedSource(source.resolvedPath, deps);
  if (lookup.match !== undefined && input.force_new !== true) {
    throw new PublishError(
      'source_already_published',
      `${lookup.match.source.description} is already version ${lookup.match.version} of ` +
        `relic ${lookup.match.relic_id}. Call relic_republish(${JSON.stringify({
          relic_id: lookup.match.relic_id,
          path: source.resolvedPath,
        })}) instead. Set force_new to true only when you intend a separate relic.`,
      { relic_id: lookup.match.relic_id, version: lookup.match.version }
    );
  }

  const challenge = expectRecord(
    await postJson(deps, `${deps.serviceOrigin}/api/challenge`, {}),
    'challenge'
  );
  const sizeLimit = Number(challenge['size_limit_bytes']);
  if (source.bytes.length > sizeLimit) {
    throw new PublishError(
      'local_size_precheck_failed',
      `${source.basename} is ${source.bytes.length} bytes, over the ${sizeLimit}-byte cap`,
      { size_limit_bytes: sizeLimit, declared_size_bytes: source.bytes.length }
    );
  }
  const challengeNonce = expectString(
    challenge['challenge_nonce'],
    'challenge nonce'
  );

  const filename = input.filename ?? source.basename;
  const rendererClass = deriveRendererClass(source.bytes, filename);
  const mimetype = guessMimetype(filename, rendererClass);
  const digest = await contentDigest({
    content: source.bytes,
    filename,
    title: '',
  });

  const first = await fetchDeviceContext(
    deps,
    session.entry,
    session.signer,
    session.pin
  );
  const owner = await ownerReader(session.pin);
  const readers = [
    owner,
    ...first.devices,
    ...(first.recovery === undefined ? [] : [first.recovery.reader]),
  ];

  let relicId = generateRelicId();
  let key = generateKey();
  let container = await encryptRelic({
    content: source.bytes,
    filename,
    mimetype,
    key,
  });
  let grant: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt <= 3 && grant === undefined; attempt++) {
    if (attempt > 0) {
      relicId = generateRelicId();
      key = generateKey();
      container = await encryptRelic({
        content: source.bytes,
        filename,
        mimetype,
        key,
      });
    }
    const at = Date.now();
    const statement: StatementMap['private_publish'] = {
      at,
      challenge_nonce: challengeNonce,
      device_id: session.entry.device_id,
      relic_id: relicId,
      ttl_days: ttl,
    };
    const signature = await signDeviceStatement(
      session.signer,
      'private_publish',
      statement
    );
    try {
      grant = expectRecord(
        await postJson(deps, `${deps.serviceOrigin}/api/grant`, {
          challenge_nonce: challengeNonce,
          relic_id: relicId,
          renderer_class: rendererClass,
          publishing_client: deps.clientName,
          declared_size_bytes: source.bytes.length,
          declared_ciphertext_bytes: container.length,
          access: 'private',
          ttl_days: ttl,
          ...(input.decisions === undefined
            ? {}
            : { decisions: input.decisions }),
          device_auth: {
            device_id: session.entry.device_id,
            nonce: challengeNonce,
            at,
            signature,
          },
        }),
        'grant'
      );
    } catch (error) {
      if (error instanceof ServerRefusal && error.code === 'relic_id_collision')
        continue;
      throw error;
    }
  }
  if (grant === undefined) {
    throw new PublishError(
      'service_unreachable',
      'could not obtain a private grant'
    );
  }
  if (grant['access'] !== 'private') {
    throw new PublishError(
      'private_unsupported',
      'the service did not grant private access, so nothing was uploaded'
    );
  }
  const publishToken = expectString(grant['publish_token'], 'publish token');
  const accessEpoch = Number(grant['access_epoch']);
  const expiresAt =
    grant['relic_expires_at'] == null
      ? null
      : String(grant['relic_expires_at']);

  // The version's key and the publish token reach this machine's state before
  // any ciphertext moves, so an upload that lands always has a recorded key.
  await writeState(relicId, {
    access: 'private',
    service_origin: deps.serviceOrigin,
    publish_token: publishToken,
    version: 1,
    version_keys: { '1': encodeKey(key) },
    owner_identity_id: session.pin.identity_id,
    device_id: session.entry.device_id,
    source: lookup.source,
    filename,
    published_at: new Date().toISOString(),
    content_sha256: digest,
    expires_at: expiresAt,
  });

  await putContainer(
    deps,
    relicId,
    expectString(grant['upload_url'], 'upload URL'),
    container
  );

  const complete = await completeVersion({
    deps,
    relicId,
    publishToken,
    key,
    container,
    session,
    first: { version: 1, accessEpoch, ownerEpoch: first.ownerEpoch, readers },
    refresh: async () => {
      const next = await fetchDeviceContext(
        deps,
        session.entry,
        session.signer,
        session.pin
      );
      return {
        version: 1,
        accessEpoch,
        ownerEpoch: next.ownerEpoch,
        readers: [
          owner,
          ...next.devices,
          ...(next.recovery === undefined ? [] : [next.recovery.reader]),
        ],
      };
    },
  });
  const containerDigest = sha256Hex(container);
  if (
    typeof complete['version_digest'] === 'string' &&
    complete['version_digest'] !== containerDigest
  ) {
    throw new PublishError(
      'version_digest_mismatch',
      'the version digest the service computed does not match the ciphertext this machine uploaded',
      { relic_id: relicId, version: 1 }
    );
  }

  return {
    access: 'private',
    url: `${deps.relicOrigin}/${relicId}`,
    relic_id: relicId,
    version: 1,
    version_digest: containerDigest,
    relic_expires_at: expiresAt,
    renderer_class: rendererClass,
    filename,
    resolved_path: source.resolvedPath,
    report_url: String(grant['report_url']),
    disclosure_url: String(grant['disclosure_url']),
    owner: await ownerDisplay(session.pin),
    recipients: recipientOutput(readers),
  };
}

/** Write one private entry, through the state module's serialized writer. */
async function writeState(
  relicId: string,
  entry: PrivatePublishState
): Promise<void> {
  try {
    await savePrivatePublishState(relicId, entry);
  } catch (error) {
    // The message names the failure and never the entry, which holds keys.
    throw new PublishError(
      'local_state_write_failed',
      'the private relic was not recorded on this machine, so it cannot be ' +
        `republished from here: ${(error as Error).message}`,
      { relic_id: relicId }
    );
  }
}

/**
 * Publish a new version of a private relic under a fresh key, to the readers
 * the owner currently has. The recipients are verified before any wrap.
 */
export async function republishPrivate(
  input: PrivateRepublishInput,
  deps: PublishDeps
): Promise<PrivateRepublishResult> {
  if (!isValidRelicId(input.relic_id)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${input.relic_id}" is not a relic id. Republish takes the 26-character id the original publish returned.`
    );
  }
  refuseRegulatedOptions(input.title, input.cover);
  const state = await loadPrivatePublishState(input.relic_id);
  if (state === undefined) {
    throw new PublishError(
      'no_local_publish_state',
      `relic ${input.relic_id} was not published privately from this machine, so it cannot be republished here.`
    );
  }
  if (state.service_origin !== deps.serviceOrigin) {
    throw new PublishError(
      'no_local_publish_state',
      `relic ${input.relic_id} was published to a different service than ${deps.serviceOrigin}.`
    );
  }
  const session = await deviceSession(deps);
  if (session.pin.identity_id !== state.owner_identity_id) {
    throw new PublishError(
      'owner_pin_mismatch',
      'this device is certified for a different owner than the one that published this relic'
    );
  }
  if (input.ttl_days !== undefined) {
    checkTtl(input.ttl_days, await privateCapability(deps));
  }

  const source = await readSource(input.path, deps.files);
  const filename = input.filename ?? source.basename;
  const rendererClass = deriveRendererClass(source.bytes, filename);
  const digest = await contentDigest({
    content: source.bytes,
    filename,
    title: '',
  });
  if (state.content_sha256 === digest) {
    throw new PublishError(
      'duplicate_version',
      `version ${state.version} of relic ${input.relic_id} already holds exactly this content under this name, so a new version would show a reader nothing new. Change the file, or leave the relic where it is.`,
      {
        relic_id: input.relic_id,
        version: state.version,
        content_sha256: digest,
      }
    );
  }

  const key = generateKey();
  const container = await encryptRelic({
    content: source.bytes,
    filename,
    mimetype: guessMimetype(filename, rendererClass),
    key,
  });
  const grant = expectRecord(
    await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${input.relic_id}/republish`,
      {
        publish_token: state.publish_token,
        renderer_class: rendererClass,
        declared_size_bytes: source.bytes.length,
        declared_ciphertext_bytes: container.length,
        ...(input.ttl_days === undefined ? {} : { ttl_days: input.ttl_days }),
        ...(input.decisions === undefined
          ? {}
          : { decisions: input.decisions }),
        ...(input.notify === false ? { notify: false } : {}),
      }
    ),
    'republish grant'
  );

  // The new version is open now. Its readers are taken from the service and
  // verified before the key is recorded, so the recorded version is the one
  // the recipients were checked against.
  const first = await fetchRecipients(
    deps,
    input.relic_id,
    state.publish_token,
    session.pin
  );
  await writeState(input.relic_id, {
    ...state,
    version: first.version,
    version_keys: {
      ...state.version_keys,
      [String(first.version)]: encodeKey(key),
    },
    filename,
    content_sha256: digest,
    updated_at: new Date().toISOString(),
  });

  await putContainer(
    deps,
    input.relic_id,
    expectString(grant['upload_url'], 'upload URL'),
    container
  );
  const complete = await completeVersion({
    deps,
    relicId: input.relic_id,
    publishToken: state.publish_token,
    key,
    container,
    session,
    first,
    refresh: () =>
      fetchRecipients(deps, input.relic_id, state.publish_token, session.pin),
  });
  const containerDigest = sha256Hex(container);
  if (
    typeof complete['version_digest'] === 'string' &&
    complete['version_digest'] !== containerDigest
  ) {
    throw new PublishError(
      'version_digest_mismatch',
      'the version digest the service computed does not match the ciphertext this machine uploaded',
      { relic_id: input.relic_id, version: first.version }
    );
  }

  return {
    access: 'private',
    relic_id: input.relic_id,
    version: first.version,
    version_digest: containerDigest,
    relic_expires_at:
      grant['relic_expires_at'] == null
        ? null
        : String(grant['relic_expires_at']),
    renderer_class: rendererClass,
    filename,
    resolved_path: source.resolvedPath,
    report_url: String(grant['report_url']),
    disclosure_url: String(grant['disclosure_url']),
    notify: input.notify !== false,
    recipients: recipientOutput(first.readers),
  };
}

/**
 * Read a private version's content key for relic-mcp, from its own wrap.
 *
 * A key relic-mcp created is held locally. Any other version (a browser
 * rekey, for instance) is fetched with the publish token and this device's
 * key id, then unwrapped with the device's key. The seal that covers the
 * wrap is verified against the pinned owner or a certified device. The
 * unwrapped key must then match the seal's key commitment before it is used.
 */
export async function privateVersionKey(
  deps: PublishDeps,
  relicId: string,
  state: PrivatePublishState,
  version: number
): Promise<Uint8Array> {
  const local = state.version_keys[String(version)];
  if (local !== undefined) return decodeKey(local);

  const session = await deviceSession(deps);
  const keyId = sha256Hex(session.signer.recipient.publicKey);
  const body = expectRecord(
    await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${relicId}/versions/${version}/key`,
      {
        publish_token: state.publish_token,
        recipient_key_id: keyId,
      }
    ),
    'version key'
  );
  return openFetchedKey(body, session, relicId, version, keyId);
}

async function openFetchedKey(
  body: Record<string, unknown>,
  session: DeviceSession,
  relicId: string,
  version: number,
  keyId: string
): Promise<Uint8Array> {
  const pin = session.pin;
  const ownerParty = expectRecord(body['owner'], 'owner');
  const owner = await partyIdentity(
    expectRecord(ownerParty['identity'], 'owner identity')
  );
  assertOwnerPin(pin, {
    identityId: owner.identityId,
    email: expectString(ownerParty['email'], 'owner email'),
    kem: owner.kem,
    sig: owner.sig,
  });

  const signerRecord = expectRecord(body['signer'], 'seal signer');
  let verifier: Uint8Array;
  let signerId: string;
  if (signerRecord['kind'] === 'identity') {
    verifier = decodeBase64url(pin.sig_public_key);
    signerId = pin.identity_id;
  } else if (signerRecord['kind'] === 'device') {
    const device = expectRecord(signerRecord['device'], 'device');
    const sigPublicKey = expectString(
      device['sig_public_key'],
      'device signing key'
    );
    await verifyDeviceCert({
      deviceId: expectString(device['device_id'], 'device id'),
      ownerIdentityId: pin.identity_id,
      ownerSigPublicKey: decodeBase64url(pin.sig_public_key),
      kemPublicKey: expectString(device['kem_public_key'], 'device KEM key'),
      sigPublicKey,
      label: expectString(device['label'], 'device label'),
      notAfter: Number(device['not_after']),
      cert: {
        statement: expectRecord(
          expectRecord(device['cert'], 'device certificate')['statement'],
          'device certificate statement'
        ),
        identity_signature: expectString(
          expectRecord(device['cert'], 'device certificate')[
            'identity_signature'
          ],
          'device certificate signature'
        ),
      },
    });
    verifier = decodeBase64url(sigPublicKey);
    signerId = expectString(device['device_id'], 'device id');
  } else {
    throw new PublishError(
      'seal_signature_invalid',
      'the seal names no known signer'
    );
  }

  const sealBody = expectRecord(body['seal'], 'seal');
  const statement = parseStatement(
    'seal',
    expectRecord(sealBody['statement'], 'seal statement')
  );
  // The seal must cover this relic and version and be signed by the signer.
  // It need not list this device: a grant made after the seal writes its
  // wrap without re-sealing, so the wrap below is what names the recipient.
  const covered =
    statement.relic_id === relicId &&
    statement.version === version &&
    statement.signer_id === signerId;
  const signed = await verifyStatement(
    verifier,
    statementBytes('seal', statement),
    expectString(sealBody['signature'], 'seal signature')
  );
  if (!covered || !signed) {
    throw new PublishError(
      'seal_signature_invalid',
      `version ${version} of relic ${relicId} does not carry a seal this machine can verify`,
      { relic_id: relicId, version }
    );
  }

  const wrap = expectRecord(body['wrap'], 'wrap');
  if (wrap['recipient_key_id'] !== keyId) {
    throw new PublishError(
      'wrap_unopenable',
      `the wrapped key for version ${version} is not addressed to this device`,
      { relic_id: relicId, version }
    );
  }
  let key: Uint8Array;
  try {
    key = await unwrapVersionKey({
      recipient: session.signer.recipient,
      relicId,
      version,
      enc: expectString(wrap['enc'], 'wrap enc'),
      ct: expectString(wrap['ct'], 'wrap ct'),
    });
  } catch {
    throw new PublishError(
      'wrap_unopenable',
      `the wrapped key for version ${version} does not open with this device`,
      { relic_id: relicId, version }
    );
  }
  // HPKE base mode opens a wrap of any key the service chose. Only the
  // commitment the owner signed into the seal tells the right key apart.
  const commitment = await keyCommitment({ relicId, version, key });
  if (commitment !== statement.key_commitment) {
    throw new PublishError(
      'seal_key_mismatch',
      `the key wrapped for version ${version} does not match the key its seal commits to`,
      { relic_id: relicId, version }
    );
  }
  return key;
}

/**
 * Bind this machine's owner to a public relic it published, so the owner can
 * manage it from the dashboard. Authorized by the device, not a passkey.
 */
export async function bindOwner(
  input: { readonly relic_id: string },
  deps: PublishDeps
): Promise<{
  readonly relic_id: string;
  readonly owner: { readonly email: string; readonly fingerprint: string };
}> {
  const state = await loadPublishState(input.relic_id);
  if (state === undefined) {
    throw new PublishError(
      'no_local_publish_state',
      `relic ${input.relic_id} was not published from this machine, so its owner cannot be bound here.`
    );
  }
  const session = await deviceSession(deps);
  const at = Date.now();
  const nonce = freshNonce();
  const statement: StatementMap['owner_bind'] = {
    at,
    device_id: session.entry.device_id,
    nonce,
    owner_identity_id: session.pin.identity_id,
    relic_id: input.relic_id,
  };
  const signature = await signDeviceStatement(
    session.signer,
    'owner_bind',
    statement
  );
  const body = expectRecord(
    await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${input.relic_id}/owner`,
      {
        publish_token: state.publish_token,
        device_auth: {
          device_id: session.entry.device_id,
          nonce,
          at,
          signature,
        },
      }
    ),
    'owner binding'
  );
  const ownerParty = expectRecord(body['owner'], 'owner');
  const owner = await partyIdentity(
    expectRecord(ownerParty['identity'], 'owner identity')
  );
  assertOwnerPin(session.pin, {
    identityId: owner.identityId,
    email: expectString(ownerParty['email'], 'owner email'),
    kem: owner.kem,
    sig: owner.sig,
  });
  return { relic_id: input.relic_id, owner: await ownerDisplay(session.pin) };
}

/** One private relic as the list shows it. It carries no key and no token. */
export interface PrivateRelicRow {
  readonly relic_id: string;
  readonly access: 'private';
  readonly version: number;
  readonly filename: string | null;
  readonly published_at: string | null;
  readonly expires_at: string | null;
}

/** The private relics this machine holds, read from local state with no network. */
export async function listPrivateRelics(): Promise<PrivateRelicRow[]> {
  const rows = await loadPrivateInventory();
  return rows.map(({ relic_id, state }) => ({
    relic_id,
    access: 'private',
    version: state.version,
    filename: state.filename ?? null,
    published_at: state.published_at ?? null,
    expires_at: state.expires_at ?? null,
  }));
}

/** One private relic as the show tool reports it: the current version and who can open it. */
export interface PrivateShowResult {
  readonly relic_id: string;
  readonly access: 'private';
  readonly version: number;
  readonly filename: string | null;
  readonly expires_at: string | null;
  readonly owner: { readonly email: string; readonly fingerprint: string };
  readonly recipients: readonly PrivateRecipientOutput[];
}

/**
 * One private relic, with its current version read from the service and the
 * readers the verified recipients read names. No key is returned.
 */
export async function showPrivateRelic(
  deps: PublishDeps,
  relicId: string
): Promise<PrivateShowResult> {
  const state = await loadPrivatePublishState(relicId);
  if (state === undefined) {
    throw new PublishError(
      'no_local_publish_state',
      `relic ${relicId} is not a private relic this machine holds.`
    );
  }
  const session = await deviceSession(deps);
  const snapshot = await fetchRecipients(
    deps,
    relicId,
    state.publish_token,
    session.pin
  );
  return {
    relic_id: relicId,
    access: 'private',
    version: snapshot.version,
    filename: state.filename ?? null,
    expires_at: state.expires_at ?? null,
    owner: await ownerDisplay(session.pin),
    recipients: recipientOutput(snapshot.readers),
  };
}
