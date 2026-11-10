/**
 * Comment create and read-back through the real service API, for the rendered-program proof.
 *
 * Two anchors name the same instant, 4.5 s on the composition:
 *  - composition: track and item null, range in composition time (135 / 30 s).
 *  - focused: track V2 and item plate_c_2x, range in the item's local time (15 / 30 s). The clip
 *    starts at 4.0 s on the composition, so local 0.5 s = composition 4.5 s.
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
const CLIP_START_SECONDS = 4.0;

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
  readonly id: string;
  readonly ciphertext: string;
}

function rationalOf(seconds: number) {
  return { value: Math.round(seconds * PROGRAM.fps), rate: PROGRAM.fps };
}

export async function commentRoundTrip(
  harness: ProofHarness,
  relicId: string,
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
  const focusedLocal = COMMENT_INSTANT_SECONDS - CLIP_START_SECONDS;
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
        start_time: rationalOf(focusedLocal),
        duration: rationalOf(1 / PROGRAM.fps),
      },
      snapshot: { timeline: timelineName, track: 'V2', item: 'plate_c_2x' },
    },
  };

  for (const plaintext of [compositionPlain, focusedPlain]) {
    const ciphertext = await encryptComment(commentKey, plaintext);
    const response = await fetch(
      `${harness.origin}/api/relics/${relicId}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
      }
    );
    assert.ok(
      response.ok,
      `comment POST refused: ${response.status} ${await response.text()}`
    );
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
    const plaintext = await decryptComment(commentKey, row.ciphertext);
    readBack.push({
      id: row.id,
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
  const focusedLocalRead =
    focusedAnchor.range.start_time.value / focusedAnchor.range.start_time.rate;
  const focusedCompositionSeconds = CLIP_START_SECONDS + focusedLocalRead;
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
