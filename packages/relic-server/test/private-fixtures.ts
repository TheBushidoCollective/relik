import type { AuthenticationResponseJSON } from '@relic/format';
import type {
  AccessEvent,
  AccessRequestRow,
  DeviceEnrollmentRow,
  DeviceRecord,
  GrantRow,
  IdentityRecord,
  OwnedRelicRow,
  RelicRow,
  SealRow,
  StoredAttestation,
  WrapRow,
} from '../src/store.ts';

export const NOW = 1_800_000_000_000;
export const DAY = 86_400_000;
export const RELIC_ID = 'gdk6rpv49hftg5216ev7dejesc';
export const OWNER_ID = 'a'.repeat(64);
export const GRANTEE_ID = 'b'.repeat(64);
export const OTHER_ID = 'c'.repeat(64);
export const OWNER_EMAIL = 'owner@example.com';
export const RECIPIENT_A = '1'.repeat(64);
export const RECIPIENT_B = '2'.repeat(64);

export function attestation(): StoredAttestation {
  return {
    statements: [],
    nonce: 'nonce',
    credential: {} as AuthenticationResponseJSON,
    credentialId: 'credential',
    credentialPublicKeyJwk: { kty: 'EC' },
    credentialAlg: -7,
    rpId: 'relik.test',
    origin: 'https://relik.test',
    verifiedAt: NOW,
  };
}

export function identity(
  overrides: Partial<IdentityRecord> = {}
): IdentityRecord {
  return {
    identityId: OWNER_ID,
    email: OWNER_EMAIL,
    address: OWNER_EMAIL,
    kemPublicKey: 'kem',
    sigPublicKey: 'sig',
    kemKeyId: RECIPIENT_A,
    createdAt: NOW,
    registration: attestation(),
    credentials: [],
    accessLogRetentionDays: 2190,
    recipientsEpoch: 0,
    ...overrides,
  };
}

export function relic(overrides: Partial<RelicRow> = {}): RelicRow {
  return {
    id: RELIC_ID,
    publishIp: '203.0.113.7',
    grantedAt: NOW,
    expiresAt: undefined,
    rendererClass: 'html',
    publishingClient: 'relic-mcp',
    declaredSizeBytes: 1024,
    version: 1,
    publishTokenHash: 'f'.repeat(64),
    mintsUsed: 0,
    ...overrides,
  };
}

/** A relic as the regulated profile opens it: private, owned, expiring in 30 days. */
export function privateRelic(overrides: Partial<RelicRow> = {}): RelicRow {
  return relic({
    access: 'private',
    ownerIdentityId: OWNER_ID,
    expiresAt: NOW + 30 * DAY,
    accessEpoch: 0,
    ...overrides,
  });
}

export function wrap(
  recipientKeyId: string,
  version: number,
  relicId: string = RELIC_ID
): WrapRow {
  return {
    relicId,
    version,
    recipientKeyId,
    enc: 'enc',
    ct: 'ct',
    createdAt: NOW,
    source: 'seal',
  };
}

export function seal(version: number, relicId: string = RELIC_ID): SealRow {
  return {
    relicId,
    version,
    statement: {},
    signature: 'signature',
    signerKind: 'identity',
    signerId: OWNER_ID,
    sealedAt: NOW,
  };
}

export function grant(
  granteeIdentityId: string = GRANTEE_ID,
  relicId: string = RELIC_ID
): GrantRow {
  return {
    relicId,
    granteeIdentityId,
    ownerIdentityId: OWNER_ID,
    versions: [1],
    grantedAt: NOW,
    attestation: attestation(),
  };
}

export function accessRequest(
  requesterIdentityId: string = GRANTEE_ID,
  relicId: string = RELIC_ID
): AccessRequestRow {
  return {
    relicId,
    requesterIdentityId,
    requestedAt: NOW,
    status: 'pending',
    attestation: attestation(),
  };
}

export function device(
  deviceId: string,
  ownerIdentityId: string = OWNER_ID
): DeviceRecord {
  return {
    deviceId,
    ownerIdentityId,
    kemPublicKey: 'kem',
    sigPublicKey: 'sig',
    kemKeyId: RECIPIENT_A,
    label: 'Laptop',
    backend: 'file',
    notAfter: NOW + 365 * DAY,
    certifiedAt: NOW,
    cert: attestation(),
  };
}

export function enrollment(enrollmentId: string): DeviceEnrollmentRow {
  return {
    enrollmentId,
    deviceId: RECIPIENT_B,
    kemPublicKey: 'kem',
    sigPublicKey: 'sig',
    label: 'Laptop',
    backend: 'file',
    createdAt: NOW,
    expiresAt: NOW + 900_000,
    status: 'pending',
  };
}

export function ownedRelic(
  relicId: string = RELIC_ID,
  ownerIdentityId: string = OWNER_ID
): OwnedRelicRow {
  return { relicId, ownerIdentityId, access: 'private', at: NOW };
}

export function accessEvent(overrides: Partial<AccessEvent> = {}): AccessEvent {
  return {
    eventId: 'event-1',
    ownerIdentityId: OWNER_ID,
    relicId: RELIC_ID,
    at: NOW,
    kind: 'request',
    retainUntil: NOW + 6 * 365 * DAY,
    ...overrides,
  };
}
