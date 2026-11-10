/**
 * Comment create and read-back through the real service API, for the rendered-program proof.
 *
 * Two anchors name the same instant, 4.5 s on the composition:
 *  - composition: track and item null, range in composition time (135 / 30 s).
 *  - focused: track V2 and item plate_c_2x; its anchor range is still composition time 4.5 s.
 *    The item begins at 4.0 s, so this corresponds to 0.5 s within its timeline placement.
 * Both are sealed with the relic's comment key, posted with POST /api/relics/<id>/comments, read
 * back with GET, decrypted, and compared field by field with what was written. The returned ids
 * and bodies let the UI stage find the same comments in the viewer.
 */

import assert from 'node:assert/strict';
import {
  type CommentPlaintext,
  decryptComment,
  deriveCommentKey,
  encryptComment,
  readOtioDocument,
} from '@relic/format';
import { sha256Text, type ProofHarness } from './otio-program-harness.ts';
import { PROGRAM } from './otio-program-reference.ts';

export const COMMENT_INSTANT_SECONDS = 4.5;

export interface CommentRecord {
  readonly id: string;
  readonly body: string;
  readonly anchor: CommentPlaintext['anchor'];
}

export interface CommentReadback {
  readonly composition: CommentRecord;
  readonly focused: CommentRecord;
  readonly compositionSeconds: number;
  readonly focusedLocalSeconds: number;
  readonly focusedCompositionSeconds: number;
  readonly trackId: string;
  readonly itemId: string;
}

interface ListedComment {
  readonly comment_id: string;
  readonly ciphertext: string;
}

function rationalOf(seconds: number) {
  return { value: Math.round(seconds * PROGRAM.fps), rate: PROGRAM.fps };
}

export async function commentRoundTrip(
  harness: ProofHarness,
  relicId: string,
  sessionToken: string,
  relicKey: Uint8Array,
  contentOtio: Uint8Array,
  timelineName: string
): Promise<CommentReadback> {
  const document = readOtioDocument(contentOtio);
  const timelineId = document.timeline_ids[0];
  assert.ok(timelineId, 'document has no timeline id');
  const nodes = Object.values(document.nodes);
  const track = nodes.find(
    (n) => n.name === 'V2' && n.schema.startsWith('Track')
  );
  const item = nodes.find((n) => n.name === 'plate_c_2x');
  assert.ok(track, 'V2 track id missing from the document');
  assert.ok(item, 'plate_c_2x item id missing from the document');

  const documentSha = sha256Text(contentOtio);
  const commentKey = await deriveCommentKey(relicKey);
  const tag = `proof-${Math.random().toString(16).slice(2)}`;

  const compositionPlain: CommentPlaintext = {
    body: `${tag} composition`,
    display_name: 'Proof Reader',
    anchor: {
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: documentSha,
      timeline_id: timelineId,
      track_id: null,
      range: {
        start_time: rationalOf(COMMENT_INSTANT_SECONDS),
        duration: rationalOf(1 / PROGRAM.fps),
      },
      snapshot: { timeline: timelineName, track: null, item: null },
    },
  };
  assert.ok(item.timeline_range, 'focused item has no timeline placement');
  const itemStart =
    item.timeline_range.start_time.value / item.timeline_range.start_time.rate;
  assert.equal(itemStart, 4, 'focused fixture item timeline start changed');
  const focusedPlain: CommentPlaintext = {
    body: `${tag} focused`,
    display_name: 'Proof Reader',
    anchor: {
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: documentSha,
      timeline_id: timelineId,
      track_id: track.id,
      item_id: item.id,
      range: {
        start_time: rationalOf(COMMENT_INSTANT_SECONDS),
        duration: rationalOf(1 / PROGRAM.fps),
      },
      snapshot: { timeline: timelineName, track: 'V2', item: 'plate_c_2x' },
    },
  };

  const created = new Map<string, string>();
  for (const plaintext of [compositionPlain, focusedPlain]) {
    const ciphertext = await encryptComment(commentKey, plaintext);
    const response = await fetch(
      `${harness.origin}/api/relics/${relicId}/comments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `relic_session=${sessionToken}`,
        },
        body: JSON.stringify({ ciphertext }),
      }
    );
    const responseText = await response.text();
    assert.ok(
      response.ok,
      `comment POST refused: ${response.status} ${responseText}`
    );
    const result = JSON.parse(responseText) as {
      comment_id?: unknown;
      author?: unknown;
    };
    assert.ok(
      typeof result.comment_id === 'string',
      'comment POST omitted comment_id'
    );
    assert.match(
      result.comment_id,
      /^[A-Za-z0-9_-]{22}$/,
      'comment POST returned malformed comment_id'
    );
    assert.equal(
      result.author,
      'reader@example.test',
      'comment author is not the verified reader'
    );
    created.set(plaintext.body, result.comment_id);
  }

  const listing = await fetch(
    `${harness.origin}/api/relics/${relicId}/comments`
  );
  assert.ok(listing.ok, `comment list refused: ${listing.status}`);
  const body = (await listing.json()) as unknown;
  const rows = (
    Array.isArray(body) ? body : (body as { comments?: unknown }).comments
  ) as ListedComment[] | undefined;
  assert.ok(Array.isArray(rows), 'comment list response has no comments array');

  const readBack: CommentRecord[] = [];
  for (const row of rows) {
    assert.equal(
      typeof row.comment_id,
      'string',
      'comment listing omitted comment_id'
    );
    assert.match(
      row.comment_id,
      /^[A-Za-z0-9_-]{22}$/,
      'comment listing returned malformed comment_id'
    );
    const plaintext = await decryptComment(commentKey, row.ciphertext);
    readBack.push({
      id: row.comment_id,
      body: plaintext.body,
      anchor: plaintext.anchor,
    });
  }
  const compositionWritten = compositionPlain.body;
  const focusedWritten = focusedPlain.body;
  const composition = readBack.find((r) => r.body === compositionWritten);
  const focused = readBack.find((r) => r.body === focusedWritten);
  assert.ok(composition, `comment ${compositionWritten} not read back`);
  assert.ok(focused, `comment ${focusedWritten} not read back`);
  assert.equal(
    composition.id,
    created.get(compositionWritten),
    'composition comment id differs from POST response'
  );
  assert.equal(
    focused.id,
    created.get(focusedWritten),
    'focused comment id differs from POST response'
  );
  assert.notEqual(composition.id, focused.id, 'distinct comments share an id');
  assert.deepEqual(
    composition.anchor,
    compositionPlain.anchor,
    'composition anchor changed'
  );
  assert.deepEqual(
    focused.anchor,
    focusedPlain.anchor,
    'focused anchor changed'
  );

  const compositionAnchor = composition.anchor;
  const focusedAnchor = focused.anchor;
  assert.ok(
    compositionAnchor?.kind === 'otio' && focusedAnchor?.kind === 'otio',
    'anchor kinds'
  );
  const compositionSeconds =
    compositionAnchor.range.start_time.value /
    compositionAnchor.range.start_time.rate;
  const focusedCompositionSeconds =
    focusedAnchor.range.start_time.value / focusedAnchor.range.start_time.rate;
  const focusedLocalRead = focusedCompositionSeconds - itemStart;
  assert.equal(
    compositionSeconds,
    COMMENT_INSTANT_SECONDS,
    'composition time read back'
  );
  assert.equal(
    focusedCompositionSeconds,
    compositionSeconds,
    'focused time does not map to composition time'
  );
  assert.equal(
    focusedAnchor.track_id,
    track.id,
    'focused anchor lost its track'
  );
  assert.equal(focusedAnchor.item_id, item.id, 'focused anchor lost its item');

  return {
    composition,
    focused,
    compositionSeconds,
    focusedLocalSeconds: focusedLocalRead,
    focusedCompositionSeconds,
    trackId: track.id,
    itemId: item.id,
  };
}
