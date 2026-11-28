import { appendFile, readFile } from 'node:fs/promises';
import { GitAuthority, validateEntries } from '../src/entries.ts';
import { filerAuthorFromEnv, GitHubRest, MemoryGitHub } from '../src/github.ts';
import {
  CloudLoggingTransport,
  LOG_ENTRY_LIMIT_PER_SOURCE,
  readLogEntries,
} from '../src/logging.ts';
import { applyPlan, planReports } from '../src/plan.ts';

const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (
    key === undefined ||
    value === undefined ||
    ![
      '--entries',
      '--mode',
      '--live-since',
      '--autofix',
      '--github-output',
      '--github-fixture',
    ].includes(key) ||
    options.has(key)
  )
    throw new Error('Invalid filer arguments');
  options.set(key, value);
}
const mode = options.get('--mode');
const autofix = options.get('--autofix');
const input = options.get('--entries');
if (mode !== 'dry-run' && mode !== 'live')
  throw new Error('Mode must be dry-run or live');
if (autofix !== 'off' && autofix !== 'on')
  throw new Error('Autofix must be off or on');
if (!input) throw new Error('--entries is required');
const fixture = options.get('--github-fixture');
if (
  fixture !== undefined &&
  (fixture !== 'empty' || mode !== 'dry-run' || input === 'cloud')
)
  throw new Error('GitHub fixture requires local entries and dry-run mode');
const now = Date.now();
let since = now - 7 * 86_400_000;
const liveSince = options.get('--live-since');
if (
  mode === 'live' &&
  (!liveSince ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      liveSince
    ) ||
    !Number.isFinite(Date.parse(liveSince)))
)
  throw new Error('Live mode requires RFC 3339 --live-since');
if (liveSince) {
  if (!Number.isFinite(Date.parse(liveSince)))
    throw new Error('Invalid --live-since');
  since = Math.max(since, Date.parse(liveSince));
}
const entries: unknown =
  input === 'cloud'
    ? await readLogEntries(
        new CloudLoggingTransport(process.env.GOOGLE_ACCESS_TOKEN ?? ''),
        new Date(since).toISOString(),
        {
          onClientTruncated: (retained) =>
            console.warn(
              JSON.stringify({ clientEntriesTruncatedAt: retained })
            ),
        }
      )
    : JSON.parse(await readFile(input, 'utf8'));
const maxEntries =
  input === 'cloud'
    ? LOG_ENTRY_LIMIT_PER_SOURCE * 2
    : LOG_ENTRY_LIMIT_PER_SOURCE;
if (!Array.isArray(entries) || entries.length > maxEntries)
  throw new Error(`Entries must be an array of at most ${maxEntries} records`);
const authority = new GitAuthority();
const known = authority.knownSets();
const checked = validateEntries(entries, authority, {
  now,
  since,
  known,
});
const filerAuthor = filerAuthorFromEnv(process.env);
const github =
  fixture === 'empty'
    ? new MemoryGitHub([], undefined, filerAuthor)
    : new GitHubRest(process.env.GITHUB_TOKEN ?? '', fetch, filerAuthor);
const plan = await planReports(checked.entries, github, {
  now,
  autofix,
  authority,
  known,
  filerAuthor,
});
const candidates = await applyPlan(
  plan,
  github,
  mode,
  process.env.GITHUB_RUN_ID
    ? { runId: process.env.GITHUB_RUN_ID, now, filerAuthor }
    : undefined
);
const summary = JSON.stringify(
  {
    mode,
    accepted: checked.entries.length,
    dropped: checked.dropped,
    truncated: plan.truncated,
    isolated: plan.isolated,
    actions: plan.actions.map((action) => ({
      kind: action.kind,
      fingerprint: action.fingerprint,
      ...('issue' in action ? { issue: action.issue } : {}),
    })),
    candidates: mode === 'dry-run' ? plan.candidates : candidates,
  },
  null,
  2
);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### Error reports (${mode})\n\n\`\`\`json\n${summary}\n\`\`\`\n`
  );
const output = options.get('--github-output');
if (output) await appendFile(output, `autofix=${JSON.stringify(candidates)}\n`);
