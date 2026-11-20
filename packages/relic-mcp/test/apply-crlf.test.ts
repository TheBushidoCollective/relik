import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveCommentKey,
  encodeKey,
  encryptComment,
  generateKey,
  generateRelicId,
  type CommentPlaintext,
} from '@relic/format';
import { applySuggestions } from '../src/apply-suggestions.ts';
import { nodeFiles } from '../src/files.ts';
import type { PublishDeps } from '../src/publish.ts';
import { resolveSourceIdentity, savePublishState } from '../src/state.ts';

test('apply resolves LF-normalized anchors, preserves BOM and CRLF, and rejects newline replacements', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'relic-crlf-apply-'));
  const previous = process.env['RELIC_PUBLISH_STATE'];
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');
  try {
    const path = join(scratch, 'data.csv');
    const original = '\ufeffname,value\r\nalpha,1\r\nomega,2\r\n';
    await writeFile(path, original);
    const relicId = generateRelicId();
    const keyBytes = generateKey();
    const key = await deriveCommentKey(keyBytes);
    await savePublishState(relicId, {
      key: encodeKey(keyBytes),
      publish_token: 'fixture',
      version: 1,
      source: await resolveSourceIdentity(path),
    });
    const makeRow = async (id: string, replacement: string) => {
      const plain: CommentPlaintext = {
        body: 'suggested edit',
        display_name: null,
        anchor: {
          kind: 'source',
          exact: 'alpha',
          prefix: 'name,value\n',
          suffix: ',1\nomega,2\n',
        },
        suggestion: { v: 1, mode: 'replace', replacement },
      };
      return {
        comment_id: id,
        author: 'reader@example.test',
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        ciphertext: await encryptComment(key, plain),
      };
    };
    const rows = [
      await makeRow('unsafe', 'a\nb'),
      await makeRow('safe', 'BETA'),
    ];
    const deps = {
      serviceOrigin: 'http://127.0.0.1',
      relicOrigin: 'http://127.0.0.1',
      files: nodeFiles,
      fetch: async () => Response.json(rows),
    } as unknown as PublishDeps;
    await expect(
      applySuggestions(
        { relic_id: relicId, path, accept: ['unsafe'], write: true },
        deps
      )
    ).rejects.toMatchObject({ code: 'line-break-in-crlf-file' });
    expect(await readFile(path, 'utf8')).toBe(original);
    const result = await applySuggestions(
      { relic_id: relicId, path, accept: ['safe'], write: true },
      deps
    );
    expect(result.written).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(
      '\ufeffname,value\r\nBETA,1\r\nomega,2\r\n'
    );
  } finally {
    if (previous === undefined) delete process.env['RELIC_PUBLISH_STATE'];
    else process.env['RELIC_PUBLISH_STATE'] = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});
