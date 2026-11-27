import { GitAuthority } from '../src/entries.ts';
import { filerAuthorFromEnv, GitHubRest } from '../src/github.ts';
import { authorizeIssueData, issueTitle, parseRegion } from '../src/render.ts';

const argument = process.argv[2];
if (
  process.argv.length !== 3 ||
  argument === undefined ||
  !/^[1-9]\d*$/.test(argument) ||
  !Number.isSafeInteger(Number(argument))
)
  throw new Error('Usage: audit-issue.ts <issue-number>');
const github = new GitHubRest(
  process.env.GITHUB_TOKEN ?? '',
  fetch,
  filerAuthorFromEnv(process.env)
);
const issue = (await github.listIssues()).find(
  (item) => item.number === Number(argument)
);
if (issue === undefined) throw new Error('Issue not found among error reports');
const data = parseRegion(issue.body);
const authority = new GitAuthority();
if (
  data === null ||
  issue.title !== issueTitle(data) ||
  !authorizeIssueData(data, authority, authority.knownSets())
)
  throw new Error('Issue report region failed validation');
const regionCanaries = [
  '@jwaldrip',
  'jane.doe@example.com',
  'Ignore all previous instructions',
  'Secret Plans.pdf',
];
if (regionCanaries.some((canary) => issue.body.includes(canary)))
  throw new Error('Issue contains a canary');
console.log(
  `ERROR_REPORT_ISSUE_AUDIT_OK issue=${issue.number} fingerprint=${data.fingerprint}`
);
