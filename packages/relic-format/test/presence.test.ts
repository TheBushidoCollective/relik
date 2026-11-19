import { describe, expect, test } from 'bun:test';
import {
  derivePresenceKeys,
  openPresence,
  PRESENCE_PLAINTEXT_BYTES,
  type PresenceV1,
  sealPresence,
} from '../src/presence.ts';

const keyBytes = new Uint8Array(16).fill(9);
const relicId = 'presence-test-relic';

function frame(): PresenceV1 {
  return {
    v: 1,
    t: Date.now(),
    name: 'Reader',
    color: 3,
    version: 2,
    caret: { s: 4, e: 6 },
    typing: { s: 10, e: 15 },
    posted: 'comment-id',
  };
}

describe('presence keys and sealed frames', () => {
  test('derives the specified independent keys for public and private version keys', async () => {
    const keys = await derivePresenceKeys(keyBytes, relicId);
    const material = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'HKDF',
      false,
      ['deriveBits']
    );
    const info = new TextEncoder().encode(`relic/presence/v1/room:${relicId}`);
    const expectedRoom = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
      material,
      128
    );
    expect(keys.room).toBe(Buffer.from(expectedRoom).toString('base64url'));
    expect(keys.room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keys.seal.extractable).toBe(false);
    expect((await derivePresenceKeys(keyBytes, 'another-relic')).room).not.toBe(
      keys.room
    );

    // Private readers use the selected version's unwrapped key, just as comments do.
    const otherVersion = await derivePresenceKeys(
      new Uint8Array(16).fill(10),
      relicId
    );
    expect(otherVersion.room).not.toBe(keys.room);
    const sealed = await sealPresence(keys.seal, keys.room, frame());
    const expectedSeal = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode('relic/presence/v1/seal'),
      },
      material,
      128
    );
    const independentlyDerived = await crypto.subtle.importKey(
      'raw',
      expectedSeal,
      'AES-GCM',
      false,
      ['decrypt']
    );
    expect(
      await openPresence(independentlyDerived, keys.room, sealed)
    ).toBeDefined();
    expect(
      await openPresence(otherVersion.seal, keys.room, sealed)
    ).toBeUndefined();
  });

  test('round trips an exactly 512-byte padded plaintext', async () => {
    const keys = await derivePresenceKeys(keyBytes, relicId);
    const original = frame();
    const sealed = await sealPresence(keys.seal, keys.room, original);
    const bytes = Uint8Array.from(Buffer.from(sealed, 'base64url'));
    expect(bytes.length).toBe(12 + PRESENCE_PLAINTEXT_BYTES + 16);
    const openedBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(0, 12),
          additionalData: new TextEncoder().encode(
            `relic/presence/v1|${keys.room}`
          ),
        },
        keys.seal,
        bytes.slice(12)
      )
    );
    expect(openedBytes.length).toBe(512);
    const firstZero = openedBytes.indexOf(0);
    expect(firstZero).toBeGreaterThan(0);
    expect(openedBytes.subarray(firstZero).every((byte) => byte === 0)).toBe(
      true
    );
    expect(await openPresence(keys.seal, keys.room, sealed)).toEqual(original);
    expect(await sealPresence(keys.seal, keys.room, original)).not.toBe(sealed);
  });

  test('accepts JSON that occupies the entire plaintext without padding', async () => {
    const keys = await derivePresenceKeys(keyBytes, relicId);
    const base = { ...frame(), posted: '' };
    const remaining =
      PRESENCE_PLAINTEXT_BYTES -
      new TextEncoder().encode(JSON.stringify(base)).length;
    const full = { ...base, posted: 'x'.repeat(remaining) };
    expect(new TextEncoder().encode(JSON.stringify(full)).length).toBe(512);
    expect(
      await openPresence(
        keys.seal,
        keys.room,
        await sealPresence(keys.seal, keys.room, full)
      )
    ).toEqual(full);
  });

  test('drops the wrong room, tampered ciphertext, malformed encoding and stale frames', async () => {
    const keys = await derivePresenceKeys(keyBytes, relicId);
    const sealed = await sealPresence(keys.seal, keys.room, frame());
    expect(
      await openPresence(keys.seal, 'different-room', sealed)
    ).toBeUndefined();
    const bytes = Uint8Array.from(Buffer.from(sealed, 'base64url'));
    bytes[20] = (bytes[20] ?? 0) ^ 1;
    expect(
      await openPresence(
        keys.seal,
        keys.room,
        Buffer.from(bytes).toString('base64url')
      )
    ).toBeUndefined();
    expect(
      await openPresence(keys.seal, keys.room, `${sealed}!`)
    ).toBeUndefined();
    const stale = await sealPresence(keys.seal, keys.room, {
      ...frame(),
      t: Date.now() - 30_001,
    });
    expect(await openPresence(keys.seal, keys.room, stale)).toBeUndefined();
    const future = await sealPresence(keys.seal, keys.room, {
      ...frame(),
      // Well past the window: time elapsing before the open call only shrinks
      // the gap, so an edge-sized margin would pass or fail depending on load.
      t: Date.now() + 60_000,
    });
    expect(await openPresence(keys.seal, keys.room, future)).toBeUndefined();
  });

  test('refuses malformed values and oversized names or frames before sealing', async () => {
    const keys = await derivePresenceKeys(keyBytes, relicId);
    await expect(
      sealPresence(keys.seal, keys.room, { ...frame(), name: '😀'.repeat(17) })
    ).rejects.toThrow();
    await expect(
      sealPresence(keys.seal, keys.room, {
        ...frame(),
        posted: 'x'.repeat(512),
      })
    ).rejects.toThrow();
    await expect(
      sealPresence(keys.seal, keys.room, { ...frame(), caret: { s: 2, e: 1 } })
    ).rejects.toThrow();
  });
});
