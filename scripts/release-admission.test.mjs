import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitRelease } from './release-admission.mjs';

const valid = {
  eventName: 'workflow_dispatch',
  triggeringActor: 'github-actions[bot]',
  actorId: '41898282',
  ref: 'refs/heads/main',
  refType: 'branch',
  inputVersion: '1.2.3',
  packageVersion: '1.2.3',
  tagName: 'relic-mcp-v1.2.3',
  tagIsOnMain: true,
  dryRun: false,
};

for (const [name, changes, code] of [
  ['push event', { eventName: 'push' }, 'not_dispatch'],
  ['person dispatch', { triggeringActor: 'jason' }, 'actor_not_bot'],
  ['wrong bot ID', { actorId: '123' }, 'actor_not_bot'],
  ['person re-run', { triggeringActor: 'jason', actorId: '41898282' }, 'actor_not_bot'],
  ['other branch', { ref: 'refs/heads/other' }, 'ref_not_main'],
  ['tag ref', { refType: 'tag' }, 'ref_not_main'],
  ['malformed version', { inputVersion: '1.2.3-beta' }, 'version_malformed'],
  ['different package version', { packageVersion: '1.2.4' }, 'version_mismatch'],
  ['missing tag', { tagIsOnMain: false }, 'tag_mismatch'],
  ['wrong tag name', { tagName: 'relic-mcp-v1.2.4' }, 'tag_mismatch'],
  ['dry run requires dry-run tag', { dryRun: true }, 'tag_mismatch'],
]) {
  test(`refuses ${name}`, () => {
    const result = admitRelease({ ...valid, ...changes });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  });
}

test('admits release and dry-run tags', () => {
  assert.deepEqual(admitRelease(valid), { ok: true });
  assert.deepEqual(admitRelease({ ...valid, dryRun: true, tagName: 'relic-mcp-v1.2.3-dryrun' }), { ok: true });
});
