import {
  type ErrorFrame,
  type ErrorReport,
  fingerprintOf,
  type KnownSets,
  parseLoggedReport,
} from '@relic/format/error-report';
import { authorizeReport, type RevisionAuthority } from './entries.ts';

export const BEGIN = '<!-- relik-error-report:begin -->';
export const END = '<!-- relik-error-report:end -->';
const INTRO =
  'This report contains only allowlisted diagnostic fields. Counts are lower bounds.';

export type IssueFrame = ErrorFrame | { file: string };

export function framesForIssue(
  source: ErrorReport['source'],
  frames: ErrorFrame[]
): IssueFrame[] {
  return source === 'server'
    ? frames.map((frame) => ({ ...frame }))
    : frames.map(({ file }) => ({ file }));
}

export interface IssueData {
  v: 1;
  fingerprint: string;
  source: ErrorReport['source'];
  errorClass: ErrorReport['errorClass'];
  route: string;
  builds: Array<{ revision: string; frames: IssueFrame[] }>;
  count7d: number;
}

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function parseIssueData(value: unknown): IssueData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const input = value as Record<string, unknown>;
  if (
    !exactKeys(input, [
      'v',
      'fingerprint',
      'source',
      'errorClass',
      'route',
      'builds',
      'count7d',
    ])
  )
    return null;
  if (
    input.v !== 1 ||
    typeof input.fingerprint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(input.fingerprint) ||
    !Number.isSafeInteger(input.count7d) ||
    (input.count7d as number) < 0 ||
    !Array.isArray(input.builds) ||
    input.builds.length < 1 ||
    input.builds.length > 5
  )
    return null;
  const builds: IssueData['builds'] = [];
  const revisions = new Set<string>();
  for (const build of input.builds) {
    if (
      typeof build !== 'object' ||
      build === null ||
      Array.isArray(build) ||
      !exactKeys(build, ['revision', 'frames'])
    )
      return null;
    const item = build as Record<string, unknown>;
    if (!Array.isArray(item.frames)) return null;
    const client = input.source === 'viewer' || input.source === 'mcp';
    if (
      !item.frames.every(
        (frame: unknown) =>
          typeof frame === 'object' &&
          frame !== null &&
          !Array.isArray(frame) &&
          exactKeys(frame, client ? ['file'] : ['file', 'line', 'column'])
      )
    )
      return null;
    const frames = client
      ? item.frames.map((frame: { file: unknown }) => ({
          file: frame.file,
          line: 1,
          column: 0,
        }))
      : item.frames;
    const report = parseLoggedReport({
      v: 1,
      source: input.source,
      errorClass: input.errorClass,
      route: input.route,
      revision: item.revision,
      frames,
      count: 1,
    });
    if (report === null || revisions.has(report.revision)) return null;
    const issueFrames = framesForIssue(report.source, report.frames);
    if (fingerprintOf({ ...report, frames: issueFrames }) !== input.fingerprint)
      return null;
    revisions.add(report.revision);
    builds.push({ revision: report.revision, frames: issueFrames });
  }
  const first = builds[0];
  if (first === undefined) return null;
  const report = parseLoggedReport({
    v: 1,
    source: input.source,
    errorClass: input.errorClass,
    route: input.route,
    revision: first.revision,
    frames:
      input.source === 'server'
        ? first.frames
        : first.frames.map(({ file }) => ({ file, line: 1, column: 0 })),
    count: 1,
  });
  if (report === null) return null;
  return {
    v: 1,
    fingerprint: input.fingerprint,
    source: report.source,
    errorClass: report.errorClass,
    route: report.route,
    builds,
    count7d: input.count7d as number,
  };
}

export function authorizeIssueData(
  data: IssueData,
  authority: RevisionAuthority,
  known?: KnownSets
): boolean {
  for (const build of data.builds) {
    const report = parseLoggedReport({
      v: 1,
      source: data.source,
      errorClass: data.errorClass,
      route: data.route,
      revision: build.revision,
      frames:
        data.source === 'server'
          ? build.frames
          : build.frames.map(({ file }) => ({ file, line: 1, column: 0 })),
      count: 1,
    });
    if (
      report === null ||
      'reason' in authorizeReport(report, authority, known)
    )
      return false;
  }
  return true;
}

export function renderRegion(data: IssueData): string {
  const safe = parseIssueData(data);
  if (safe === null) throw new Error('Invalid issue data');
  const frames = safe.builds[0]?.frames ?? [];
  const frameLines =
    frames.length === 0
      ? 'No frames.'
      : frames
          .map((frame) =>
            'line' in frame
              ? `- \`${frame.file}:${frame.line}:${frame.column}\``
              : `- \`${frame.file}\``
          )
          .join('\n');
  return [
    BEGIN,
    INTRO,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Source | ${safe.source} |`,
    `| Class | ${safe.errorClass} |`,
    `| Route | ${safe.route} |`,
    `| Occurrences in the last 7 days | at least ${safe.count7d} |`,
    `| Builds seen | ${safe.builds.map((build) => `\`${build.revision}\``).join(', ')} |`,
    '',
    'Frames from the newest build:',
    frameLines,
    '',
    '```json',
    JSON.stringify(safe, null, 2),
    '```',
    END,
  ].join('\n');
}

/** Recognize only the exact canonical grammar, then independently validate its data. */
export function parseRegion(body: string): IssueData | null {
  const begin = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  if (
    begin < 0 ||
    end < begin ||
    body.indexOf(BEGIN, begin + BEGIN.length) !== -1 ||
    body.indexOf(END, end + END.length) !== -1
  )
    return null;
  const region = body.slice(begin, end + END.length);
  const match =
    /\n```json\n([\s\S]*?)\n```\n<!-- relik-error-report:end -->$/.exec(region);
  if (match?.[1] === undefined) return null;
  try {
    const parsed = parseIssueData(JSON.parse(match[1]));
    return parsed !== null &&
      renderRegion(parsed) === region &&
      !region.includes('@') &&
      !/https?:\/\//i.test(region)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function replaceRegion(body: string, data: IssueData): string {
  const begin = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  if (
    begin < 0 ||
    end < begin ||
    body.indexOf(BEGIN, begin + BEGIN.length) !== -1 ||
    body.indexOf(END, end + END.length) !== -1
  )
    throw new Error('Issue has missing or ambiguous report markers');
  return (
    body.slice(0, begin) + renderRegion(data) + body.slice(end + END.length)
  );
}

export function issueTitle(data: IssueData): string {
  if (parseIssueData(data) === null) throw new Error('Invalid issue data');
  return `Error report: ${data.errorClass} in ${data.source} ${data.route} [${data.fingerprint}]`;
}
