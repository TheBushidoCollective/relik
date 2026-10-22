import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const cwd = process.argv[2];
if (!cwd) throw new Error('Expected dedicated integration worktree');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
if (head.status !== 0) throw new Error(head.stderr);
const sourceHead = head.stdout.trim();
const evidenceRoot = process.argv[3];
if (!evidenceRoot) throw new Error('Expected external evidence root');
const dir = join(evidenceRoot, `qualification-${sourceHead.slice(0, 7)}`);
mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(dir);
if (statSync(cwd).dev !== statSync(dir).dev) throw new Error('Evidence root must share the integration filesystem');
const chrome = '/Users/jwaldrip/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const summary = {
  sourceHead,
  host: spawnSync('uname', ['-a'], { encoding: 'utf8' }).stdout.trim(),
  bun: spawnSync('mise', ['exec', '--', 'bun', '--version'], { cwd, encoding: 'utf8' }).stdout.trim(),
  command: 'Each round: mise exec node@<version> -- bun run verify; bun run --cwd packages/relic-mcp build; bun run --cwd packages/relic-viewer build; loopback-only SOURCE otio-path.ts with owned headless shell 1228',
  policy: 'Five fail-fast rounds per Node runtime, no retries. Complete raw output and per-round screenshots retained. External writes remain isolated in loopback in-memory services.',
  rounds: [],
};
function save() { writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`); }
for (const version of ['24.15.0', '18.20.8']) {
  for (let round = 1; round <= 5; round++) {
    const name = `node${version}-r${round}`;
    if (existsSync(join(cwd, 'otio-path-shots'))) throw new Error('Preserve existing SOURCE captures before qualification');
    const logPath = join(dir, `${name}.log`);
    if (existsSync(logPath)) throw new Error(`Refusing to overwrite ${logPath}`);
    writeFileSync(logPath, `SOURCE_HEAD ${sourceHead}\nNODE ${version}\nROUND ${round}\n`);
    console.log(`QUALIFICATION_START ${name}`);
    const stages = [
      ['bun', 'run', 'verify'],
      ['bun', 'run', '--cwd', 'packages/relic-mcp', 'build'],
      ['bun', 'run', '--cwd', 'packages/relic-viewer', 'build'],
      ['bun', 'packages/relic-mcp/test/otio-path.ts'],
    ];
    for (let index = 0; index < stages.length; index++) {
      const args = ['exec', `node@${version}`, '--', ...stages[index]];
      appendFileSync(logPath, `\nCOMMAND ${JSON.stringify(['mise', ...args])}\n`);
      const result = spawnSync('mise', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', RELIC_OTIO_PATH_CLIENT: 'source', RELIC_OTIO_CHROME_PATH: chrome },
      });
      appendFileSync(logPath, `STDOUT\n${result.stdout ?? ''}\nSTDERR\n${result.stderr ?? ''}\nEXIT ${result.status}\n`);
      if (index === 3) {
        const capture = join(cwd, 'otio-path-shots');
        const destination = join(dir, `${name}-shots`);
        if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
        if (existsSync(capture)) renameSync(capture, destination);
        else if (!result.error && result.status === 0) throw new Error('Successful SOURCE produced no capture directory');
      }
      if (result.error || result.status !== 0) {
        summary.rounds.push({ log: `${name}.log`, mcpNode: version, round, failedStage: index, exit: result.status, error: result.error?.message });
        save();
        console.error(`QUALIFICATION_FAILED ${name} stage=${index} log=${logPath}`);
        process.exit(1);
      }
    }
    const log = readFileSync(logPath, 'utf8');
    const counts = [...log.matchAll(/\b(\d+) pass\b/g)];
    const testsPassed = counts.length ? Number(counts.at(-1)[1]) : null;
    const stagesObserved = [...log.matchAll(/^STAGE /gm)].length;
    const pathOk = /^OTIO_PATH_OK\s*$/m.test(log);
    const zeroFailed = /\b0 fail\b/.test(log);
    const receipt = { log: `${name}.log`, mcpNode: version, round, testsPassed, testsFailed: zeroFailed ? 0 : null, sourceStages: stagesObserved, pathOk, logSha256: createHash('sha256').update(log).digest('hex') };
    summary.rounds.push(receipt);
    save();
    if (!testsPassed || !zeroFailed || !pathOk || stagesObserved < 33) throw new Error(`Missing positive qualification evidence: ${JSON.stringify(receipt)}`);
    console.log(`QUALIFICATION_PASS ${name} tests=${testsPassed} stages=${stagesObserved}`);
  }
}
save();
console.log(`OTIO_FINAL_QUALIFICATION_OK ${dir}`);
