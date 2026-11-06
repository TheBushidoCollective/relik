import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const candidate = '95f2a3f9f060253985d0f1ee2b5c252bffc24800';
const root = process.cwd();
const source = resolve(root, 'scripts/ephemeral-operator.ts');
const fixture = resolve(root, 'scripts/ephemeral-mutation-generation.test.ts');
const fixtureSource = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineResult = spawnSync('git', ['show', candidate + ':scripts/ephemeral-operator.ts'], { cwd: root, encoding: 'utf8' });
if (baselineResult.status !== 0 || !baselineResult.stdout || existsSync(fixture)) throw Error('candidate or fixture boundary');
const original = baselineResult.stdout;
if (readFileSync(source, 'utf8') !== original) throw Error('candidate checkout differs from pinned source');
const sourceSha = sha(original); const outcomes = [];
const operatorTests = 'scripts/ephemeral-operator.test.ts';
const generationTest = 'scripts/ephemeral-mutation-generation.test.ts';
const scopeTitle = 'authorized active target cannot read or delete an existing non-target row';
const barrierTitle = 'a corrupt fifth target stops execute after all five row reads but before every write';
const streamTitle = 'share-row stream failure latches before opt-out and decision sweeps';
const bytesTitle = 'metadata read rejects same-generation bytes that differ from inventory';
const generationTitle = 'metadata boundary rejects an altered current generation';
const actorTitle = 'validates run and refuses wrong SHA, ref, repository and secret name';
const mutants = [
  { name: 'metadata_scope', test: operatorTests, title: scopeTitle, before: "if (!allowed.has(name)) fail('metadata scope');", after: "if (false) fail('metadata scope');" },
  { name: 'all_five_preflight', test: operatorTests, title: barrierTitle, before: 'for (const target of manifest.targets) {', after: 'for (const target of manifest.targets.slice(0, 4)) {' },
  { name: 'stream_failure_latch', test: operatorTests, title: streamTitle, before: 'const body = new Uint8Array(await response.arrayBuffer());', after: 'let body: Uint8Array; try { body = new Uint8Array(await response.arrayBuffer()); } catch { return response; }' },
  { name: 'metadata_bytes', test: operatorTests, title: bytesTitle, before: ' || !Buffer.from(body).equals(Buffer.from(expectedBody))', after: '' },
  { name: 'metadata_generation', test: generationTest, title: generationTitle, before: " || response.headers.get('x-goog-generation') !== expected", after: '' },
  { name: 'actor_login', test: operatorTests, title: actorTitle, before: " || env.ACTOR !== 'jwaldrip'", after: '' },
  { name: 'actor_id', test: operatorTests, title: actorTitle, before: " || env.ACTOR_ID !== '43164'", after: '' },
  { name: 'triggering_actor', test: operatorTests, title: actorTitle, before: " || env.TRIGGERING_ACTOR !== 'jwaldrip'", after: '' },
];
function fresh() {
  const result = spawnSync('git', ['show', candidate + ':scripts/ephemeral-operator.ts'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0 || result.stdout !== original || sha(result.stdout) !== sourceSha) throw Error('pinned source changed');
  return result.stdout;
}
function run(testFile, title) {
  const p = spawnSync('bun', ['test', './' + testFile, '--test-name-pattern', title], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: p.status, signal: p.signal, text: (p.stdout ?? '') + (p.stderr ?? '') };
}
try {
  writeFileSync(fixture, readFileSync(fixtureSource), { flag: 'wx' });
  const all = spawnSync('bun', ['test', './scripts/ephemeral-operator.test.ts', './scripts/check-maintenance-metafile.test.ts', './' + generationTest], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (all.status !== 0) throw Error('unmodified fake suite did not pass');
  for (const mutant of mutants) {
    const base = fresh();
    if (readFileSync(source, 'utf8') !== base) throw Error('previous restore did not match pinned source');
    const before = run(mutant.test, mutant.title);
    if (before.status !== 0 || !before.text.includes(mutant.title)) throw Error('named baseline did not pass');
    const matches = base.split(mutant.before).length - 1;
    if (matches !== 1) throw Error('mutation anchor is not unique: ' + mutant.name);
    const changed = base.replace(mutant.before, mutant.after);
    if (changed === base || changed !== base.slice(0, base.indexOf(mutant.before)) + mutant.after + base.slice(base.indexOf(mutant.before) + mutant.before.length)) throw Error('mutation did not change exact intended bytes');
    writeFileSync(source, changed);
    if (readFileSync(source, 'utf8') !== changed || sha(changed) === sourceSha) throw Error('mutation was not written');
    let result;
    try { result = run(mutant.test, mutant.title); }
    finally { writeFileSync(source, fresh()); }
    if (readFileSync(source, 'utf8') !== original) throw Error('restoration mismatch');
    const restored = run(mutant.test, mutant.title);
    if (restored.status !== 0 || !restored.text.includes(mutant.title)) throw Error('named restored baseline did not pass');
    let verdict = 'inconclusive';
    if (result.status === 0) verdict = 'masked_or_undetected';
    else if (result.status !== null && !result.signal && result.text.includes(mutant.title) && /\b1 fail\b/.test(result.text) && /expect\(/.test(result.text)) verdict = 'detected';
    const limitation = verdict === 'masked_or_undetected' ? 'The named test passed after the verified mutation; overlapping protection and missing coverage cannot be distinguished here.' : verdict === 'inconclusive' ? 'The runner did not produce the expected named assertion failure; inspect the failing test before drawing a conclusion.' : null;
    outcomes.push({ name: mutant.name, test: mutant.title, removed: mutant.before, replacement: mutant.after, anchorMatches: matches, originalSha256: sourceSha, mutantSha256: sha(changed), baseline: 'passed', restored: 'passed', exitStatus: result.status, signal: result.signal, verdict, limitation });
    console.log(mutant.name + ': ' + verdict);
  }
} finally {
  writeFileSync(source, fresh());
  if (readFileSync(source, 'utf8') !== original) throw Error('final restoration mismatch');
  if (existsSync(fixture)) rmSync(fixture);
  writeFileSync(evidence, JSON.stringify({ candidate, outcomes }, null, 2) + '\n');
}
if (outcomes.length !== mutants.length || outcomes.some(outcome => outcome.verdict !== 'detected')) process.exitCode = 1;
