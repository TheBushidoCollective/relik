import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function admitRelease({ eventName, triggeringActor, actorId, ref, refType, inputVersion, packageVersion, tagName, tagIsOnMain, dryRun }) {
  if (eventName !== 'workflow_dispatch') return { ok: false, code: 'not_dispatch', message: 'Release must be started by workflow_dispatch.' };
  if (triggeringActor !== 'github-actions[bot]' || String(actorId) !== '41898282') return { ok: false, code: 'actor_not_bot', message: 'Release must be started by the GitHub Actions bot.' };
  if (ref !== 'refs/heads/main' || refType !== 'branch') return { ok: false, code: 'ref_not_main', message: 'Release must run on main.' };
  if (typeof inputVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(inputVersion)) return { ok: false, code: 'version_malformed', message: 'Version must be a numeric major.minor.patch.' };
  if (inputVersion !== packageVersion) return { ok: false, code: 'version_mismatch', message: 'Version does not match the checked-out package.' };
  if (tagName !== `relic-mcp-v${inputVersion}${dryRun ? '-dryrun' : ''}` || tagIsOnMain !== true) return { ok: false, code: 'tag_mismatch', message: 'Release tag is missing or its commit is not on main.' };
  return { ok: true };
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function main() {
  const env = process.env;
  const dispatcher = process.argv[2] === '--dispatcher';
  const tagName = dispatcher ? env.GITHUB_REF_NAME : `relic-mcp-v${env.INPUT_VERSION}${env.INPUT_DRY_RUN === 'true' ? '-dryrun' : ''}`;
  const tagCommit = git('rev-parse', '--verify', `refs/tags/${tagName}^{commit}`);
  const onMain = tagCommit !== null && git('merge-base', '--is-ancestor', tagCommit, 'refs/remotes/origin/main') !== null;
  const headMatches = !dispatcher || (tagCommit !== null && tagCommit === git('rev-parse', 'HEAD'));
  const packageVersion = JSON.parse(readFileSync('packages/relic-mcp/package.json', 'utf8')).version;
  const decision = admitRelease({
    eventName: dispatcher ? 'workflow_dispatch' : env.GITHUB_EVENT_NAME,
    triggeringActor: dispatcher ? 'github-actions[bot]' : env.GITHUB_ACTOR === env.GITHUB_TRIGGERING_ACTOR ? env.GITHUB_TRIGGERING_ACTOR : '',
    actorId: dispatcher ? '41898282' : env.GITHUB_ACTOR_ID,
    ref: dispatcher ? 'refs/heads/main' : env.GITHUB_REF,
    refType: dispatcher ? 'branch' : env.GITHUB_REF_TYPE,
    inputVersion: env.INPUT_VERSION,
    packageVersion,
    tagName,
    tagIsOnMain: onMain && headMatches,
    dryRun: env.INPUT_DRY_RUN === 'true',
  });
  const actor = env.GITHUB_TRIGGERING_ACTOR || 'unknown';
  const line = `Release started by ${actor}. ${decision.ok ? 'Admission accepted.' : `Admission refused (${decision.code}): ${decision.message}`}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!decision.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
