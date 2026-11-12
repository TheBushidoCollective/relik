/**
 * Shared fixtures for the private-share tests: real keys, certificates signed
 * the way the service signs them, an in-memory file reader, and a recording
 * fake of the service routes plan section 4.7 names for a private publish.
 *
 * Nothing here talks to a network or a live system. The fake answers only
 * the requests the client makes, and records every body it was sent so a
 * test can scan what left the machine.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  generateIdentityKeys,
  type IdentityKeys,
  identityIdOf,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import type { DeviceEntry, DeviceOwner } from '../src/device.ts';
import { writeDeviceEntry } from '../src/device.ts';
import type { FileReader, PublishDeps } from '../src/publish.ts';

export const ORIGIN = 'https://svc.test';
export const RELIC_ORIGIN = 'https://relic.test';
export const UPLOAD_BASE = 'https://storage.test/relics';
export const DAY_MS = 86_400_000;

export interface Person {
  readonly identityId: string;
  readonly email: string;
  readonly keys: IdentityKeys;
  readonly kem: string;
  readonly sig: string;
}

export async function makePerson(email: string): Promise<Person> {
  const keys = await generateIdentityKeys();
  return {
    identityId: await identityIdOf(keys.kemPublicKey, keys.sigPublicKey),
    email,
    keys,
    kem: encodeBase64url(keys.kemPublicKey),
    sig: encodeBase64url(keys.sigPublicKey),
  };
}

export interface TestDevice {
  readonly deviceId: string;
  readonly keys: IdentityKeys;
  readonly kem: string;
  readonly sig: string;
  readonly label: string;
}

export async function makeDevice(label: string): Promise<TestDevice> {
  const keys = await generateIdentityKeys();
  return {
    deviceId: await deviceIdOf(keys.kemPublicKey, keys.sigPublicKey),
    keys,
    kem: encodeBase64url(keys.kemPublicKey),
    sig: encodeBase64url(keys.sigPublicKey),
    label,
  };
}

/** The ECDSA P-256 signature over a statement, as the device or identity makes it. */
export function signer(
  key: CryptoKey
): (bytes: Uint8Array) => Promise<Uint8Array> {
  return async (bytes) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        new Uint8Array(bytes)
      )
    );
}

/** A `device_cert` the owner signs for a device. `signedBy` lets a test forge one. */
export async function makeCert(input: {
  readonly owner: Person;
  readonly device: {
    readonly deviceId: string;
    readonly kem: string;
    readonly sig: string;
    readonly label: string;
  };
  readonly notAfter: number;
  readonly signedBy?: Person;
}): Promise<{
  statement: Record<string, unknown>;
  identity_signature: string;
}> {
  const statement = {
    at: Date.now(),
    device_fingerprint_typed: await deviceFingerprint(input.device.deviceId),
    device_id: input.device.deviceId,
    kem_public_key: input.device.kem,
    label: input.device.label,
    not_after: input.notAfter,
    owner_identity_id: input.owner.identityId,
    sig_public_key: input.device.sig,
  };
  const bytes = statementBytes('device_cert', statement);
  const sigPerson = input.signedBy ?? input.owner;
  return {
    statement,
    identity_signature: await signStatement(
      signer(sigPerson.keys.sig.privateKey),
      bytes
    ),
  };
}

export function ownerPin(owner: Person): DeviceOwner {
  return {
    identity_id: owner.identityId,
    email: owner.email,
    kem_public_key: owner.kem,
    sig_public_key: owner.sig,
    pinned_at: new Date().toISOString(),
  };
}

/** A device this machine has already enrolled and pinned, written to the key file. */
export async function pinDevice(
  origin: string,
  owner: Person,
  device: TestDevice
): Promise<DeviceEntry> {
  const notAfter = Date.now() + 365 * DAY_MS;
  const cert = await makeCert({ owner, device, notAfter });
  const entry: DeviceEntry = {
    device_id: device.deviceId,
    backend: 'file',
    label: device.label,
    created_at: new Date().toISOString(),
    kem_public_key: device.kem,
    sig_public_key: device.sig,
    kem_private: {
      jwk: await crypto.subtle.exportKey('jwk', device.keys.kem.privateKey),
    },
    sig_private: {
      jwk: await crypto.subtle.exportKey('jwk', device.keys.sig.privateKey),
    },
    cert,
    owner: { ...ownerPin(owner), pinned_at: new Date().toISOString() },
  };
  await writeDeviceEntry(origin, entry);
  return entry;
}

/** An in-memory file reader. Paths are used as given. */
export function memoryFiles(
  files: Readonly<Record<string, Uint8Array>>
): FileReader {
  return {
    resolve: (path) => path,
    basename: (path) => path.slice(path.lastIndexOf('/') + 1),
    stat: async (path) => {
      const bytes = files[path];
      if (bytes === undefined) {
        throw Object.assign(new Error(`no such file ${path}`), {
          code: 'ENOENT',
        });
      }
      return { kind: 'file', size: bytes.length };
    },
    read: async (path) => {
      const bytes = files[path];
      if (bytes === undefined) throw new Error(`no such file ${path}`);
      return bytes;
    },
    openBundleRoot: async () => {
      throw new Error('bundles are not part of these tests');
    },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface FakeServiceOptions {
  /** Answer the challenge with the `private_shares` capability (default true). */
  readonly capability?: boolean;
  /** The owner the context names when it is not the one pinned. */
  readonly contextOwner?: Person;
  /** Devices the context lists beyond the caller's own. */
  readonly extraDevices?: readonly {
    readonly device: TestDevice;
    readonly signedBy?: Person;
  }[];
  readonly owner: Person;
  readonly device: TestDevice;
}

/**
 * A fake of the service's private-publish routes. It records every request,
 * stores every upload, and returns the shapes plan section 4.7 defines. It
 * does not decide anything the client decides: it answers what it was asked.
 */
export class FakeService {
  readonly requests: RecordedRequest[] = [];
  readonly uploads = new Map<string, Uint8Array>();
  readonly grants: Record<string, unknown>[] = [];
  readonly completions: Record<string, unknown>[] = [];
  /** The answer to `POST /api/relics/{id}/recipients`, when a test sets one. */
  recipients: Record<string, unknown> | undefined = undefined;
  /** Edits the context answer before it is sent, to model a service that answers wrongly. */
  contextEdit:
    | ((context: Record<string, unknown>) => Record<string, unknown>)
    | undefined = undefined;
  private readonly options: FakeServiceOptions;

  constructor(options: FakeServiceOptions) {
    this.options = options;
  }

  readonly fetch = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const target = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    this.requests.push({ method, path: target.pathname, body });
    const parsed: Record<string, unknown> =
      body.length > 0 ? JSON.parse(body) : {};
    return this.route(method, target.pathname, parsed);
  };

  private async route(
    method: string,
    path: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    if (method === 'POST' && path === '/api/challenge') {
      const challenge: Record<string, unknown> = {
        challenge_nonce: encodeBase64url(randomBytes(32)),
        size_limit_bytes: 50_000_000,
        size_basis: 'plaintext',
      };
      if (this.options.capability !== false) {
        challenge['private_shares'] = {
          default_ttl_days: 30,
          max_ttl_days: 365,
        };
      }
      return jsonResponse(200, challenge);
    }
    if (
      method === 'POST' &&
      /^\/api\/devices\/[0-9a-f]{64}\/context$/.test(path)
    ) {
      return jsonResponse(200, await this.context());
    }
    if (method === 'POST' && path === '/api/grant') {
      this.grants.push(body);
      return this.grant(body);
    }
    if (
      method === 'POST' &&
      /^\/api\/relics\/[a-z0-9]{26}\/recipients$/.test(path)
    ) {
      if (this.recipients === undefined) {
        return jsonResponse(404, { code: 'not_found', detail: path });
      }
      return jsonResponse(200, this.recipients);
    }
    const complete = path.match(/^\/api\/relics\/([a-z0-9]{26})\/complete$/);
    if (method === 'POST' && complete?.[1] !== undefined) {
      this.completions.push(body);
      const stored = this.uploads.get(`${UPLOAD_BASE}/${complete[1]}`);
      const digest = stored === undefined ? '' : sha256Hex(stored);
      return jsonResponse(200, { version: 1, version_digest: digest });
    }
    return jsonResponse(404, {
      code: 'not_found',
      detail: `no route ${method} ${path}`,
    });
  }

  private async context(): Promise<Record<string, unknown>> {
    const { owner, device } = this.options;
    const contextOwner = this.options.contextOwner ?? owner;
    const notAfter = Date.now() + 365 * DAY_MS;
    const own = await makeCert({ owner, device, notAfter });
    const devices: Record<string, unknown>[] = [
      deviceRecord(owner.identityId, device, own, notAfter),
    ];
    for (const extra of this.options.extraDevices ?? []) {
      const cert = await makeCert({
        owner,
        device: extra.device,
        notAfter,
        ...(extra.signedBy === undefined ? {} : { signedBy: extra.signedBy }),
      });
      devices.push(
        deviceRecord(owner.identityId, extra.device, cert, notAfter)
      );
    }
    const answer: Record<string, unknown> = {
      device: deviceRecord(owner.identityId, device, own, notAfter),
      owner: partyJson(contextOwner),
      devices,
      recovery: null,
      recovery_statement: null,
      owner_epoch: 0,
    };
    return this.contextEdit === undefined ? answer : this.contextEdit(answer);
  }

  private grant(body: Record<string, unknown>): Response {
    const relicId = String(body['relic_id']);
    return jsonResponse(201, {
      access: body['access'] === 'private' ? 'private' : 'public',
      access_epoch: 0,
      owner_epoch: 0,
      publish_token: 'publish-token-fixture-0000000000000000',
      upload_url: `${UPLOAD_BASE}/${relicId}`,
      upload_method: 'PUT',
      upload_headers: {},
      upload_expires_at: new Date(Date.now() + 600_000).toISOString(),
      relic_expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      report_url: `${ORIGIN}/${relicId}/report`,
      disclosure_url: `${ORIGIN}/policy`,
    });
  }

  /** The uploader the client is given: it records the body under the signed URL. */
  readonly upload = async (
    url: string,
    _headers: Readonly<Record<string, string>>,
    body: Uint8Array
  ) => {
    this.uploads.set(url, body);
    return { status: 200 };
  };
}

export function partyJson(person: Person): Record<string, unknown> {
  return {
    email: person.email,
    identity: {
      identity_id: person.identityId,
      email: person.email,
      kem_public_key: person.kem,
      sig_public_key: person.sig,
      created_at: new Date().toISOString(),
      retired_at: null,
    },
  };
}

export function deviceRecord(
  ownerIdentityId: string,
  device: TestDevice,
  cert: { statement: Record<string, unknown>; identity_signature: string },
  notAfter: number
): Record<string, unknown> {
  return {
    device_id: device.deviceId,
    owner_identity_id: ownerIdentityId,
    kem_public_key: device.kem,
    sig_public_key: device.sig,
    label: device.label,
    backend: 'file',
    not_after: notAfter,
    certified_at: new Date().toISOString(),
    revoked_at: null,
    cert,
  };
}

export interface PublishFixture {
  readonly deps: PublishDeps;
  readonly service: FakeService;
  readonly renders: { count: number };
  readonly files: FileReader;
}

/** Publish deps wired to the fake service and an in-memory file. */
export function publishFixture(
  service: FakeService,
  sourceBytes: Uint8Array,
  sourcePath = '/work/report.md'
): PublishFixture {
  const renders = { count: 0 };
  const files = memoryFiles({ [sourcePath]: sourceBytes });
  const deps: PublishDeps = {
    serviceOrigin: ORIGIN,
    relicOrigin: RELIC_ORIGIN,
    files,
    fetch: service.fetch as typeof globalThis.fetch,
    upload: service.upload,
    clientName: 'relic-mcp-test',
    identifySource: async (path) => ({
      identity: `test:${path}`,
      kind: 'realpath',
      path,
      description: path,
    }),
    renderCover: async () => {
      renders.count += 1;
      return { status: 'skipped', reason: 'browser_disabled', detail: 'test' };
    },
  };
  return { deps, service, renders, files };
}
