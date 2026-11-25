import { describe, expect, test } from 'bun:test';
import {
  encodeBase64url,
  generateInviteKeyPair,
  inviteFragment,
  inviteIdOf,
  inviteRecipient,
  parseInviteFragment,
  parseStatement,
  statementBytes,
  unwrapVersionKey,
  wrapVersionKey,
} from '../src/private.ts';

const publicKey = Uint8Array.from(
  Buffer.from(
    '04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0',
    'hex'
  )
);
const identity =
  '61acd9e678454d81e039ee5b4ea6900d69cb3a47f8e25d5c53a5634462b7b787';
const relicId = '7k2m9qxah3tb0p4dvw8cr1nezf';
const invite = {
  at: 1767225600004,
  expires_at: 1767312000004,
  invite_public_key: encodeBase64url(publicKey),
  invited_email: 'ada@example.com',
  owner_identity_id: identity,
  relic_id: relicId,
  versions: [1, 2, 5],
};
const claim = {
  at: 1767225600005,
  claimant_identity_id: identity,
  invite_id: '8710cee59cfe355aed7b658ce51b8269ee732b1f70a97c25c7e9cece1e6b14aa',
  relic_id: relicId,
  versions: [1, 2, 5],
};

describe('invitation statements', () => {
  test('matches independently generated exact bytes', () => {
    expect(Buffer.from(statementBytes('invite', invite)).toString('hex')).toBe(
      '72656c69632d73746174656d656e742f76310a696e766974650a7b226174223a313736373232353630303030342c22657870697265735f6174223a313736373331323030303030342c22696e766974655f7075626c69635f6b6579223a224250364d4763344a42526b6576436d4b6b6b56354a54487962777a73346b59474f6569384f63745f63477143616e656254506c70754b446c4f6366324c375054437461716a34446a4478305369715f5769697a6e4c7141222c22696e76697465645f656d61696c223a22616461406578616d706c652e636f6d222c226f776e65725f6964656e746974795f6964223a2236316163643965363738343534643831653033396565356234656136393030643639636233613437663865323564356335336135363334343632623762373837222c2272656c69635f6964223a22376b326d3971786168337462307034647677386372316e657a66222c2276657273696f6e73223a5b312c322c355d7d'
    );
    expect(
      Buffer.from(statementBytes('invite_claim', claim)).toString('hex')
    ).toBe(
      '72656c69632d73746174656d656e742f76310a696e766974655f636c61696d0a7b226174223a313736373232353630303030352c22636c61696d616e745f6964656e746974795f6964223a2236316163643965363738343534643831653033396565356234656136393030643639636233613437663865323564356335336135363334343632623762373837222c22696e766974655f6964223a2238373130636565353963666533353561656437623635386365353162383236396565373332623166373061393763323563376539636563653165366231346161222c2272656c69635f6964223a22376b326d3971786168337462307034647677386372316e657a66222c2276657273696f6e73223a5b312c322c355d7d'
    );
  });
  test('refuses extra and missing fields for both kinds', () => {
    for (const [kind, sample] of [
      ['invite', invite],
      ['invite_claim', claim],
    ] as const) {
      expect(() => parseStatement(kind, { ...sample, extra: 1 })).toThrow();
      const { versions: _, ...missing } = sample;
      expect(() => parseStatement(kind, missing)).toThrow();
    }
  });
  test('refuses invalid expiration, versions and key length', () => {
    for (const expires_at of [invite.at, invite.at - 1])
      expect(() =>
        parseStatement('invite', { ...invite, expires_at })
      ).toThrow();
    for (const versions of [[], [2, 1], [1, 1], [0]]) {
      expect(() => parseStatement('invite', { ...invite, versions })).toThrow();
      expect(() =>
        parseStatement('invite_claim', { ...claim, versions })
      ).toThrow();
    }
    expect(() =>
      parseStatement('invite', {
        ...invite,
        invite_public_key: encodeBase64url(publicKey.subarray(0, 64)),
      })
    ).toThrow();
  });
});

test('invitation key opens version wraps', async () => {
  const { d, publicKey: pub } = await generateInviteKeyPair();
  const key = crypto.getRandomValues(new Uint8Array(16));
  const wrap = await wrapVersionKey({
    recipientPublicKey: pub,
    relicId,
    version: 2,
    key,
  });
  expect(wrap.recipientKeyId).toBe(await inviteIdOf(pub));
  expect(
    await unwrapVersionKey({
      recipient: await inviteRecipient(d, pub),
      relicId,
      version: 2,
      enc: wrap.enc,
      ct: wrap.ct,
    })
  ).toEqual(key);
  expect(parseInviteFragment(inviteFragment(d))).toEqual(d);
});

test('only canonical invitation fragments are accepted', () => {
  for (const value of [
    '',
    `#k=${'A'.repeat(43)}`,
    `k=${'A'.repeat(42)}`,
    `k=${'A'.repeat(44)}`,
    `x=${'A'.repeat(43)}`,
    `k=${'!'.repeat(43)}`,
    `k=${'A'.repeat(42)}B`,
    `k=${'A'.repeat(43)}&x=1`,
  ])
    expect(parseInviteFragment(value)).toBeUndefined();
});
