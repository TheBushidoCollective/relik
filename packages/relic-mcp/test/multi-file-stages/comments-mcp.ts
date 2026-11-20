import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  COMMENT_NONCE_BYTES,
  decodeKey,
  deriveCommentKey,
} from '@relic/format';
import { loadPublishState } from '../../src/state.ts';
import {
  editComment,
  postComment,
  readComments,
  resolveComment,
} from '../../src/comments.ts';
import { republish } from '../../src/republish.ts';
import { withM3Fixture } from './m3-fixture.ts';

async function commentsStage(): Promise<void> {
  await withM3Fixture(async ({ root, relicId, deps }) => {
    const first = await postComment(
      {
        relic_id: relicId,
        body: 'on first',
        entry: 'a.md',
        anchor: { kind: 'quote', exact: 'first original' },
      },
      deps
    );
    const second = await postComment(
      {
        relic_id: relicId,
        body: 'on second',
        entry: 'b.md',
        anchor: { kind: 'quote', exact: 'second original' },
      },
      deps
    );
    const missing = await postComment(
      {
        relic_id: relicId,
        body: 'missing',
        entry: 'missing.md',
        anchor: { kind: 'quote', exact: 'first original' },
      },
      deps
    );
    const whole = await postComment(
      {
        relic_id: relicId,
        body: 'whole',
        anchor: { kind: 'quote', exact: 'first original' },
      },
      deps
    );
    await editComment(
      { relic_id: relicId, comment_id: first.comment_id, body: 'edited' },
      deps
    );
    const reply = await postComment(
      { relic_id: relicId, body: 'reply', addresses: second.comment_id },
      deps
    );
    const image = {
      kind: 'image' as const,
      path: [{ tag: 'img', index: 0 }],
      source_sha256: 'a'.repeat(64),
    };
    const missingImage = await postComment(
      {
        relic_id: relicId,
        body: 'missing image',
        entry: 'missing.md',
        anchor: image,
      },
      deps
    );
    const presentImage = await postComment(
      {
        relic_id: relicId,
        body: 'present image',
        entry: 'a.md',
        anchor: image,
      },
      deps
    );
    const wholeImage = await postComment(
      { relic_id: relicId, body: 'whole image', anchor: image },
      deps
    );
    const state = await loadPublishState(relicId);
    assert.ok(state);
    const key = await deriveCommentKey(decodeKey(state.key));
    async function postFuture(entry?: string): Promise<string> {
      const nonce = crypto.getRandomValues(new Uint8Array(COMMENT_NONCE_BYTES));
      const plain = new TextEncoder().encode(
        JSON.stringify({
          body: 'future',
          display_name: null,
          ...(entry === undefined ? {} : { entry }),
          anchor: { kind: 'future-anchor' },
        })
      );
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce.slice().buffer as ArrayBuffer },
          key,
          plain.slice().buffer as ArrayBuffer
        )
      );
      const framed = new Uint8Array(nonce.length + sealed.length);
      framed.set(nonce);
      framed.set(sealed, nonce.length);
      const response = await deps.fetch(
        `${deps.serviceOrigin}/api/relics/${relicId}/comments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: state!.publish_token,
            ciphertext: Buffer.from(framed).toString('base64url'),
          }),
        }
      );
      assert.equal(response.status, 201);
      const row: unknown = await response.json();
      assert.ok(
        row &&
          typeof row === 'object' &&
          'comment_id' in row &&
          typeof row.comment_id === 'string'
      );
      return row.comment_id;
    }
    const future = await postFuture('missing.md');
    const wholeFuture = await postFuture();
    const read = await readComments(relicId, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comments = new Map(
      read.comments.map((comment) => [comment.comment_id, comment])
    );
    assert.equal(comments.get(first.comment_id)?.entry, 'a.md');
    assert.equal(comments.get(first.comment_id)?.body, 'edited');
    assert.equal(comments.get(first.comment_id)?.resolved?.status, 'resolved');
    assert.equal(comments.get(second.comment_id)?.resolved?.status, 'resolved');
    assert.equal(comments.get(reply.comment_id)?.entry, 'b.md');
    for (const [id, reason] of [
      [missingImage.comment_id, 'file_not_in_version'],
      [presentImage.comment_id, 'HTML image anchors require browser rendering'],
      [wholeImage.comment_id, 'not_tied_to_a_file'],
      [future, 'file_not_in_version'],
    ] as const) {
      const resolution = comments.get(id)?.resolved;
      assert.ok(
        resolution &&
          'explanation' in resolution &&
          typeof resolution.explanation === 'string'
      );
      assert.match(resolution.explanation, new RegExp(reason));
    }
    const missingResolution = comments.get(missing.comment_id)?.resolved;
    const wholeResolution = comments.get(whole.comment_id)?.resolved;
    assert.ok(
      missingResolution &&
        'explanation' in missingResolution &&
        typeof missingResolution.explanation === 'string'
    );
    assert.ok(
      wholeResolution &&
        'explanation' in wholeResolution &&
        typeof wholeResolution.explanation === 'string'
    );
    assert.match(missingResolution.explanation, /file_not_in_version/);
    assert.match(wholeResolution.explanation, /not_tied_to_a_file/);
    for (const comment of read.comments) {
      await resolveComment(
        { relic_id: relicId, comment_id: comment.comment_id, resolved: true },
        deps
      );
    }
    const switched = await republish(
      {
        relic_id: relicId,
        path: join(root, 'a.md'),
        cover: false,
        notify: false,
      },
      deps
    );
    assert.equal(switched.shape, 'file');
    const historical = await readComments(relicId, deps, {
      version: 1,
      resolve_anchors: true,
    });
    const historicImage = historical.comments.find(
      (comment) => comment.comment_id === wholeImage.comment_id
    )?.resolved;
    const historicFuture = historical.comments.find(
      (comment) => comment.comment_id === wholeFuture
    )?.resolved;
    assert.ok(
      historicImage &&
        'explanation' in historicImage &&
        typeof historicImage.explanation === 'string'
    );
    assert.ok(
      historicFuture &&
        'explanation' in historicFuture &&
        typeof historicFuture.explanation === 'string'
    );
    assert.match(
      historicImage.explanation,
      /HTML image anchors require browser rendering/
    );
    assert.match(historicFuture.explanation, /Unsupported anchor kind/);
    console.log('MULTI_FILE_STAGE comments-mcp OK');
  });
}
await commentsStage();
