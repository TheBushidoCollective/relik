import assert from 'node:assert/strict';
import { readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeKey, deriveCommentKey, encryptComment } from '@relic/format';
import { applySuggestions } from '../../src/apply-suggestions.ts';
import { loadPublishState, savePublishState } from '../../src/state.ts';
import { withM3Fixture } from './m3-fixture.ts';

async function applyStage(): Promise<void> {
  await withM3Fixture(async ({ root, relicId, deps }) => {
    const state = await loadPublishState(relicId);
    assert.ok(state);
    const key = await deriveCommentKey(decodeKey(state.key));
    async function add(
      entry: string | undefined,
      exact: string,
      replacement: string
    ): Promise<string> {
      const ciphertext = await encryptComment(key, {
        body: `Replace ${exact}`,
        display_name: null,
        ...(entry === undefined ? {} : { entry }),
        anchor: { kind: 'source', exact },
        suggestion: { v: 1, mode: 'replace', replacement },
      });
      const response = await deps.fetch(
        `${deps.serviceOrigin}/api/relics/${relicId}/comments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: state!.publish_token,
            ciphertext,
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
    const first = await add('a.md', 'first original', 'first changed');
    const second = await add('b.md', 'second original', 'second changed');
    const noEntry = await add(undefined, 'first original', 'changed');
    await assert.rejects(
      applySuggestions(
        { relic_id: relicId, path: root, accept: [noEntry], write: true },
        deps
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'suggestion_not_tied_to_a_file'
    );
    assert.ok(state.source);
    await savePublishState(relicId, {
      ...state,
      source: { ...state.source, path: `${root}.zip` },
    });
    await assert.rejects(
      applySuggestions(
        { relic_id: relicId, path: root, accept: [first], write: true },
        deps
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'source_is_zip'
    );
    await savePublishState(relicId, state);
    const a = join(root, 'a.md');
    const b = join(root, 'b.md');
    await unlink(b);
    await symlink(a, b);
    await assert.rejects(
      applySuggestions(
        { relic_id: relicId, path: root, accept: [first, second], write: true },
        deps
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'source_not_regular_file'
    );
    assert.equal(await readFile(a, 'utf8'), 'first original text\n');
    await unlink(b);
    await writeFile(b, 'second original text\n');
    const result = await applySuggestions(
      { relic_id: relicId, path: root, accept: [first, second], write: true },
      deps
    );
    assert.ok('files' in result);
    assert.equal(result.files.length, 2);
    assert.equal(await readFile(a, 'utf8'), 'first changed text\n');
    assert.equal(await readFile(b, 'utf8'), 'second changed text\n');
    console.log('MULTI_FILE_STAGE apply OK');
  });
}
await applyStage();
