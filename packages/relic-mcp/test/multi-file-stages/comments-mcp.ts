import assert from 'node:assert/strict';
import { editComment, postComment, readComments } from '../../src/comments.ts';
import { withM3Fixture } from './m3-fixture.ts';

async function commentsStage(): Promise<void> {
  await withM3Fixture(async ({ relicId, deps }) => {
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
    assert.match(
      comments.get(missing.comment_id)?.resolved?.explanation ?? '',
      /file_not_in_version/
    );
    assert.match(
      comments.get(whole.comment_id)?.resolved?.explanation ?? '',
      /not_tied_to_a_file/
    );
    console.log('MULTI_FILE_STAGE comments-mcp OK');
  });
}
await commentsStage();
