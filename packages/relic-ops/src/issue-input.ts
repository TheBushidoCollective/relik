import type { KnownSets } from '@relic/format/error-report';
import type { RevisionAuthority } from './entries.ts';
import { DEFAULT_FILER_AUTHOR, type Issue, isFilerAuthor } from './github.ts';
import {
  authorizeIssueData,
  issueTitle,
  type IssueData,
  parseRegion,
} from './render.ts';

export interface FixerInput {
  issue: number;
  data: IssueData;
}

/** Issue bodies, labels and metadata are untrusted even after authentication. */
export function issueInput(
  issue: Issue,
  expected: { issue: number; fingerprint: string },
  authority: RevisionAuthority,
  known?: KnownSets
): FixerInput {
  if (
    !Number.isSafeInteger(expected.issue) ||
    expected.issue < 1 ||
    issue.number !== expected.issue ||
    issue.state !== 'open' ||
    !/^[0-9a-f]{16}$/.test(expected.fingerprint) ||
    !isFilerAuthor(issue.author, DEFAULT_FILER_AUTHOR) ||
    !issue.labels.includes('error-report')
  )
    throw new Error('Invalid autofix issue');
  const data = parseRegion(issue.body);
  if (
    data === null ||
    data.fingerprint !== expected.fingerprint ||
    issue.title !== issueTitle(data) ||
    !issue.labels.includes(`source:${data.source}`) ||
    issue.labels.filter((label) => label.startsWith('source:')).length !== 1 ||
    !authorizeIssueData(data, authority, known)
  )
    throw new Error('Invalid autofix report');
  return { issue: issue.number, data };
}
