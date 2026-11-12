import { describe, expect, test } from 'bun:test';
import { ProblemError } from '../src/problems.ts';
import {
  MemoryStore,
  type OperatorTombstone,
  type RelicStore,
} from '../src/store.ts';
import { fakeGcs, storeOn } from './fake-gcs.ts';
import {
  accessEvent,
  accessRequest,
  attestation,
  DAY,
  device,
  enrollment,
  GRANTEE_ID,
  grant,
  identity,
  NOW,
  OTHER_ID,
  OWNER_EMAIL,
  OWNER_ID,
  ownedRelic,
  privateRelic,
  RECIPIENT_A,
  RECIPIENT_B,
  RELIC_ID,
  relic,
  seal,
  wrap,
} from './private-fixtures.ts';

/**
 * The same contract runs against the memory store and the GCS store over the
 * fake bucket. Anything a store does differently is a bug in one of them, so
 * every assertion here is about behaviour a caller can observe.
 */
const backends: readonly {
  readonly name: string;
  readonly make: () => RelicStore;
}[] = [
  { name: 'MemoryStore', make: () => new MemoryStore() },
  { name: 'gcsStore over the fake bucket', make: () => storeOn(fakeGcs()) },
];

for (const backend of backends) {
  describe(`private-share store contract on ${backend.name}`, () => {
    describe('identities', () => {
      test('an address finds its current identity in whatever case it is asked', async () => {
        const store = backend.make();
        expect(
          await store.createIdentity(identity({ email: 'Owner@Example.com' }))
        ).toBe('created');

        const found = await store.getIdentityForAddress('OWNER@example.COM');
        expect(found?.identityId).toBe(OWNER_ID);
        expect(found?.email).toBe(OWNER_EMAIL);
      });

      test('a second identity for a taken address is refused and the first keeps it', async () => {
        const store = backend.make();
        await store.createIdentity(identity());

        expect(
          await store.createIdentity(identity({ identityId: OTHER_ID }))
        ).toBe('address_taken');
        expect(
          (await store.getIdentityForAddress(OWNER_EMAIL))?.identityId
        ).toBe(OWNER_ID);
        expect(await store.getIdentity(OTHER_ID)).toBeUndefined();
      });

      test('replacing an identity retires the old one and moves its address to the new', async () => {
        const store = backend.make();
        await store.createIdentity(identity());

        expect(
          await store.replaceIdentity(
            identity({ identityId: OTHER_ID }),
            OWNER_ID,
            NOW + 1
          )
        ).toBe('replaced');
        expect(
          (await store.getIdentityForAddress(OWNER_EMAIL))?.identityId
        ).toBe(OTHER_ID);
        const retired = await store.getIdentity(OWNER_ID);
        expect(retired?.retiredAt).toBe(NOW + 1);
        expect(retired?.replacedBy).toBe(OTHER_ID);
      });

      test('a replacement naming an identity that no longer holds the address conflicts and changes nothing', async () => {
        const store = backend.make();
        await store.createIdentity(identity());
        await store.replaceIdentity(
          identity({ identityId: OTHER_ID }),
          OWNER_ID,
          NOW + 1
        );

        const third = 'd'.repeat(64);
        expect(
          await store.replaceIdentity(
            identity({ identityId: third }),
            OWNER_ID,
            NOW + 2
          )
        ).toBe('conflict');
        expect(
          (await store.getIdentityForAddress(OWNER_EMAIL))?.identityId
        ).toBe(OTHER_ID);
        expect(await store.getIdentity(third)).toBeUndefined();
      });

      test('an address never resolves to a retired identity', async () => {
        const store = backend.make();
        await store.createIdentity(identity());
        // The old identity holds nothing once replaced, even though its record remains.
        await store.replaceIdentity(
          identity({ identityId: OTHER_ID }),
          OWNER_ID,
          NOW + 1
        );
        expect((await store.getIdentity(OWNER_ID))?.retiredAt).toBe(NOW + 1);
        expect(
          (await store.getIdentityForAddress(OWNER_EMAIL))?.retiredAt
        ).toBeUndefined();
      });
    });

    describe('relic rows', () => {
      test('updateRelic applies the change and returns the row it wrote', async () => {
        const store = backend.make();
        await store.putRelic(relic());

        const updated = await store.updateRelic(RELIC_ID, (row) => ({
          ...row,
          accessEpoch: 4,
        }));
        expect(updated?.accessEpoch).toBe(4);
        expect((await store.getRelic(RELIC_ID))?.accessEpoch).toBe(4);
      });

      test('a change that throws a ProblemError aborts, leaves the row alone and propagates the error', async () => {
        const store = backend.make();
        await store.putRelic(relic());
        const refusal = new ProblemError('relic_not_found', {});

        await expect(
          store.updateRelic(RELIC_ID, () => {
            throw refusal;
          })
        ).rejects.toBe(refusal);
        expect((await store.getRelic(RELIC_ID))?.accessEpoch).toBeUndefined();
      });

      test('updateRelic on a relic that is gone is undefined', async () => {
        const store = backend.make();
        expect(await store.updateRelic(RELIC_ID, (row) => row)).toBeUndefined();
      });

      test('deleteRelicRow removes the row', async () => {
        const store = backend.make();
        await store.putRelic(relic());
        await store.deleteRelicRow(RELIC_ID);
        expect(await store.getRelic(RELIC_ID)).toBeUndefined();
      });
    });

    describe('wraps', () => {
      test('a wrap is create-only per version and recipient', async () => {
        const store = backend.make();
        expect(await store.putWrap(wrap(RECIPIENT_A, 1))).toBe(true);
        expect(await store.putWrap(wrap(RECIPIENT_A, 1))).toBe(false);
        expect(await store.putWrap(wrap(RECIPIENT_A, 2))).toBe(true);

        expect((await store.getWrap(RELIC_ID, 1, RECIPIENT_A))?.version).toBe(
          1
        );
        expect(await store.getWrap(RELIC_ID, 3, RECIPIENT_A)).toBeUndefined();
      });

      test('deleteWraps by recipient removes that recipient in every version and nobody else', async () => {
        const store = backend.make();
        await store.putWrap(wrap(RECIPIENT_A, 1));
        await store.putWrap(wrap(RECIPIENT_B, 1));
        await store.putWrap(wrap(RECIPIENT_A, 2));
        await store.putWrap(wrap(RECIPIENT_B, 2));

        expect(
          await store.deleteWraps(RELIC_ID, { recipientKeyId: RECIPIENT_A })
        ).toBe(2);
        const left = await store.listWraps(RELIC_ID);
        expect(left.map((w) => [w.version, w.recipientKeyId])).toEqual([
          [1, RECIPIENT_B],
          [2, RECIPIENT_B],
        ]);
      });

      test('deleteWraps by version removes that version only', async () => {
        const store = backend.make();
        await store.putWrap(wrap(RECIPIENT_A, 1));
        await store.putWrap(wrap(RECIPIENT_B, 1));
        await store.putWrap(wrap(RECIPIENT_A, 2));

        expect(await store.deleteWraps(RELIC_ID, { version: 1 })).toBe(2);
        expect(await store.listWraps(RELIC_ID, 1)).toEqual([]);
        expect((await store.listWraps(RELIC_ID, 2)).length).toBe(1);
      });

      test('deleteWraps never reaches another relic', async () => {
        const store = backend.make();
        await store.putWrap(wrap(RECIPIENT_A, 1));
        await store.putWrap(wrap(RECIPIENT_A, 1, 'other-relic'));

        expect(await store.deleteWraps(RELIC_ID, {})).toBe(1);
        expect(
          (await store.listWraps('other-relic')).map((w) => w.relicId)
        ).toEqual(['other-relic']);
      });
    });

    describe('seals', () => {
      test('a seal is create-only and deleteSeals removes one version', async () => {
        const store = backend.make();
        expect(await store.putSeal(seal(1))).toBe(true);
        expect(await store.putSeal(seal(1))).toBe(false);
        await store.putSeal(seal(2));

        expect(await store.deleteSeals(RELIC_ID, 1)).toBe(1);
        expect(await store.getSeal(RELIC_ID, 1)).toBeUndefined();
        expect((await store.getSeal(RELIC_ID, 2))?.version).toBe(2);
      });
    });

    describe('grants', () => {
      test('a grant is create-only and vanishes from its grantee when deleted', async () => {
        const store = backend.make();
        expect(await store.putGrant(grant())).toBe(true);
        expect(await store.putGrant(grant())).toBe(false);
        expect(
          (await store.listGrantsForGrantee(GRANTEE_ID)).map((g) => g.relicId)
        ).toEqual([RELIC_ID]);
        expect((await store.listGrants(RELIC_ID)).length).toBe(1);

        await store.deleteGrant(RELIC_ID, GRANTEE_ID);
        expect(await store.listGrantsForGrantee(GRANTEE_ID)).toEqual([]);
        expect(await store.listGrants(RELIC_ID)).toEqual([]);
        expect(await store.getGrant(RELIC_ID, GRANTEE_ID)).toBeUndefined();
      });

      test('a revocation is recorded by updating the grant in place', async () => {
        const store = backend.make();
        await store.putGrant(grant());

        const revoked = await store.updateGrant(RELIC_ID, GRANTEE_ID, (g) => ({
          ...g,
          revokedAt: NOW + 5,
          revocation: attestation(),
        }));
        expect(revoked?.revokedAt).toBe(NOW + 5);
        expect((await store.getGrant(RELIC_ID, GRANTEE_ID))?.revokedAt).toBe(
          NOW + 5
        );
        expect(
          await store.updateGrant(RELIC_ID, OTHER_ID, (g) => g)
        ).toBeUndefined();
      });

      test('deleteGrantsForRelic removes every grant on that relic and counts them', async () => {
        const store = backend.make();
        await store.putGrant(grant(GRANTEE_ID));
        await store.putGrant(grant(OTHER_ID));
        await store.putGrant(grant(GRANTEE_ID, 'other-relic'));

        expect(await store.deleteGrantsForRelic(RELIC_ID)).toBe(2);
        expect(await store.listGrants(RELIC_ID)).toEqual([]);
        expect(
          (await store.listGrantsForGrantee(GRANTEE_ID)).map((g) => g.relicId)
        ).toEqual(['other-relic']);
      });
    });

    describe('access requests', () => {
      test('a request is create-only, decided in place, and cleared with its relic', async () => {
        const store = backend.make();
        expect(await store.putAccessRequest(accessRequest())).toBe(true);
        expect(await store.putAccessRequest(accessRequest())).toBe(false);

        const decided = await store.updateAccessRequest(
          RELIC_ID,
          GRANTEE_ID,
          (r) => ({ ...r, status: 'declined', decidedAt: NOW + 1 })
        );
        expect(decided?.status).toBe('declined');
        expect((await store.listAccessRequests(RELIC_ID)).length).toBe(1);

        expect(await store.deleteAccessRequestsForRelic(RELIC_ID)).toBe(1);
        expect(
          await store.getAccessRequest(RELIC_ID, GRANTEE_ID)
        ).toBeUndefined();
      });
    });

    describe('devices', () => {
      test('a device is create-only and listed only under its owner', async () => {
        const store = backend.make();
        expect(await store.putDevice(device('device-own'))).toBe(true);
        expect(await store.putDevice(device('device-own'))).toBe(false);
        await store.putDevice(device('device-other', OTHER_ID));

        expect(
          (await store.listDevicesForOwner(OWNER_ID)).map((d) => d.deviceId)
        ).toEqual(['device-own']);
        expect(
          (await store.listDevicesForOwner(OTHER_ID)).map((d) => d.deviceId)
        ).toEqual(['device-other']);
      });

      test('a revocation updates the device record its owner sees', async () => {
        const store = backend.make();
        await store.putDevice(device('device-own'));

        const revoked = await store.updateDevice('device-own', (d) => ({
          ...d,
          revokedAt: NOW + 1,
        }));
        expect(revoked?.revokedAt).toBe(NOW + 1);
        expect((await store.listDevicesForOwner(OWNER_ID))[0]?.revokedAt).toBe(
          NOW + 1
        );
      });

      test('a device enrollment is create-only and approved in place', async () => {
        const store = backend.make();
        expect(
          await store.putDeviceEnrollment(enrollment('enrollment-1'))
        ).toBe(true);
        expect(
          await store.putDeviceEnrollment(enrollment('enrollment-1'))
        ).toBe(false);

        const approved = await store.updateDeviceEnrollment(
          'enrollment-1',
          (e) => ({ ...e, status: 'approved' })
        );
        expect(approved?.status).toBe('approved');
        expect((await store.getDeviceEnrollment('enrollment-1'))?.status).toBe(
          'approved'
        );
      });
    });

    describe('owned relics and the access log', () => {
      test('owned relics are listed per owner and removed one at a time', async () => {
        const store = backend.make();
        await store.putOwnedRelic(ownedRelic(RELIC_ID, OWNER_ID));
        await store.putOwnedRelic(ownedRelic('other-relic', OWNER_ID));
        await store.putOwnedRelic(ownedRelic(RELIC_ID, OTHER_ID));

        expect(
          (await store.listOwnedRelics(OWNER_ID)).map((r) => r.relicId)
        ).toEqual([RELIC_ID, 'other-relic']);

        await store.deleteOwnedRelic(OWNER_ID, RELIC_ID);
        expect(
          (await store.listOwnedRelics(OWNER_ID)).map((r) => r.relicId)
        ).toEqual(['other-relic']);
      });

      test('an access event is listed to its owner until retainUntil and not after', async () => {
        const store = backend.make();
        await store.appendAccessEvent(
          accessEvent({ eventId: 'a', at: NOW, retainUntil: NOW + DAY })
        );
        await store.appendAccessEvent(
          accessEvent({ eventId: 'b', at: NOW + 1, retainUntil: NOW + 2 * DAY })
        );
        await store.appendAccessEvent(
          accessEvent({
            eventId: 'c',
            ownerIdentityId: OTHER_ID,
            retainUntil: NOW + 2 * DAY,
          })
        );

        const ids = async (now: number): Promise<string[]> =>
          (await store.listAccessEvents(OWNER_ID, now)).map((e) => e.eventId);
        expect(await ids(NOW)).toEqual(['a', 'b']);
        // At exactly retainUntil the event is no longer retained.
        expect(await ids(NOW + DAY)).toEqual(['b']);
        expect(await ids(NOW + 2 * DAY)).toEqual([]);
      });

      test('access events can be listed for one relic', async () => {
        const store = backend.make();
        await store.appendAccessEvent(accessEvent({ eventId: 'a' }));
        await store.appendAccessEvent(
          accessEvent({ eventId: 'b', relicId: 'other-relic' })
        );

        expect(
          (await store.listAccessEvents(OWNER_ID, NOW, 'other-relic')).map(
            (e) => e.eventId
          )
        ).toEqual(['b']);
      });
    });

    describe('tombstones', () => {
      test('a tombstone written before owner deletion existed reads as an operator tombstone', async () => {
        const store = backend.make();
        const legacy: OperatorTombstone = {
          id: RELIC_ID,
          publishIp: '203.0.113.7',
          publishedAt: NOW,
          publishingClient: 'relic-mcp',
          rendererClass: 'html',
          ciphertextHash: 'a'.repeat(64),
          deletedAt: NOW + 1,
          operator: 'jason',
          reasonClass: 'abuse',
          reportReference: undefined,
        };
        await store.putTombstone(legacy);

        const found = await store.getTombstone(RELIC_ID);
        expect(found).toMatchObject({
          id: RELIC_ID,
          operator: 'jason',
          reasonClass: 'abuse',
        });
        expect(found?.kind).not.toBe('owner');
      });

      test('an owner tombstone keeps its kind and holds the id and time only', async () => {
        const store = backend.make();
        await store.putTombstone({
          kind: 'owner',
          id: RELIC_ID,
          deletedAt: NOW + 2,
        });

        expect(await store.getTombstone(RELIC_ID)).toEqual({
          kind: 'owner',
          id: RELIC_ID,
          deletedAt: NOW + 2,
        });
      });
    });

    describe('private relic lookups', () => {
      test('a private relic row round-trips its access fields', async () => {
        const store = backend.make();
        await store.putRelic(privateRelic());

        const found = await store.getRelic(RELIC_ID);
        expect(found?.access).toBe('private');
        expect(found?.ownerIdentityId).toBe(OWNER_ID);
        expect(found?.accessEpoch).toBe(0);
      });

      test('wraps of another relic are never listed for this one', async () => {
        const store = backend.make();
        await store.putWrap(wrap(RECIPIENT_A, 1, 'other-relic'));
        expect(await store.listWraps(RELIC_ID)).toEqual([]);
      });
    });
  });
}
