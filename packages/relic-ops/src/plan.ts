import type { KnownSets } from '@relic/format/error-report';
import type { RevisionAuthority, ValidEntry } from './entries.ts';
import {
  type GitHub,
  type Issue,
  type IssueAuthor,
  isFilerAuthor,
} from './github.ts';
import {
  type IssueData,
  BEGIN,
  END,
  authorizeIssueData,
  framesForIssue,
  issueTitle,
  parseRegion,
  renderRegion,
  replaceRegion,
} from './render.ts';

const DAY = 86_400_000;
const MAX_PER_SOURCE = 5;
const MAX_AUTOFIX = 3;
export const MAX_CLIENT_AUTOFIX = 1;
export const CLIENT_AUTOFIX_MIN_COUNT = 5;
export const CLIENT_AUTOFIX_MIN_BUILDS = 2;
export const CLIENT_AUTOFIX_MIN_AGE_MS = 6 * 60 * 60 * 1000;
// Three serial matrix entries can each use the sandbox, test and proposer deadlines.
export const AUTOFIX_RESERVATION_TTL_MS = (3 * (70 + 70 + 10) + 30) * 60_000;
const RESERVATION_PREFIX = '<!-- relik-autofix-reservation:';
const RESERVATION =
  /<!-- relik-autofix-reservation:v1 run=([1-9]\d{0,19}) at=(\d{1,16}) -->/g;
const BLOCK_CLOSED_UNMERGED_AUTOFIX = true;
const MAX_FINGERPRINTS = 50;

export type Action =
  | {
      kind: 'create';
      fingerprint: string;
      title: string;
      body: string;
      labels: string[];
    }
  | { kind: 'update'; fingerprint: string; issue: number; body: string }
  | { kind: 'labels'; fingerprint: string; issue: number; labels: string[] }
  | { kind: 'lock'; fingerprint: string; issue: number };
export interface Candidate {
  fingerprint: string;
  issue: number | null;
  source: IssueData['source'];
}
export interface Plan {
  actions: Action[];
  candidates: Candidate[];
  truncated: number;
  isolated: { invalid: number; duplicate: number };
}

interface Group {
  data: IssueData;
  entries: ValidEntry[];
  last: string;
}

function reservation(
  body: string
): { runId: string; at: number; marker: string } | null | 'invalid' {
  const matches = [...body.matchAll(RESERVATION)];
  const occurrences = body.split(RESERVATION_PREFIX).length - 1;
  if (occurrences !== matches.length || matches.length > 1) return 'invalid';
  const match = matches[0];
  if (!match) return null;
  const at = Number(match[2]);
  return Number.isSafeInteger(at) && at > 0
    ? { runId: match[1]!, at, marker: match[0] }
    : 'invalid';
}

function setReservation(body: string, runId: string, now: number): string {
  const current = reservation(body);
  if (current === 'invalid') throw new Error('Invalid autofix reservation');
  const marker = `<!-- relik-autofix-reservation:v1 run=${runId} at=${now} -->`;
  return current === null
    ? `${body}\n${marker}`
    : body.replace(current.marker, marker);
}

function aggregate(entries: readonly ValidEntry[]): Group[] {
  const groups = new Map<string, ValidEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.fingerprint);
    if (group === undefined) groups.set(entry.fingerprint, [entry]);
    else group.push(entry);
  }
  return [...groups.entries()]
    .map(([fingerprint, records]) => {
      records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const newest = records[0];
      if (newest === undefined) throw new Error('Empty aggregate');
      const builds = new Map<
        string,
        { revision: string; frames: IssueData['builds'][number]['frames'] }
      >();
      let count7d = 0;
      for (const record of records) {
        count7d += record.report.count;
        if (!Number.isSafeInteger(count7d)) throw new Error('Count overflow');
        if (!builds.has(record.report.revision))
          builds.set(record.report.revision, {
            revision: record.report.revision,
            frames: framesForIssue(record.report.source, record.report.frames),
          });
      }
      const data: IssueData = {
        v: 1,
        fingerprint,
        source: newest.report.source,
        errorClass: newest.report.errorClass,
        route: newest.report.route,
        builds: [...builds.values()].slice(0, 5),
        count7d,
      };
      // This also refuses inconsistent reports sharing a fingerprint.
      renderRegion(data);
      return { data, entries: records, last: newest.timestamp };
    })
    .sort(
      (a, b) =>
        Number(b.data.source === 'server') -
          Number(a.data.source === 'server') ||
        b.last.localeCompare(a.last) ||
        a.data.fingerprint.localeCompare(b.data.fingerprint)
    );
}

export async function planReports(
  entries: readonly ValidEntry[],
  github: GitHub,
  options: {
    now: number;
    autofix: 'on' | 'off';
    authority: RevisionAuthority;
    known?: KnownSets;
    filerAuthor?: IssueAuthor;
  }
): Promise<Plan> {
  const filerIssues = (await github.listIssues()).filter((issue) =>
    isFilerAuthor(issue.author, options.filerAuthor)
  );
  const issues = filerIssues.filter(
    (issue) =>
      issue.labels.includes('error-report') ||
      /^Error report: .+ \[[0-9a-f]{16}\]$/.test(issue.title) ||
      issue.body.includes(BEGIN)
  );
  const records: Array<{ issue: Issue; data: IssueData; claims: Set<string> }> =
    [];
  const claimCounts = new Map<string, number>();
  const blocked = new Set<string>();
  let invalid = 0;
  for (const issue of issues) {
    const claims = new Set<string>();
    const titleFingerprint = / \[([0-9a-f]{16})\]$/.exec(issue.title)?.[1];
    if (titleFingerprint) claims.add(titleFingerprint);
    const data = parseRegion(issue.body);
    if (data) claims.add(data.fingerprint);
    // A damaged region can still claim a fingerprint without being trusted data.
    const begin = issue.body.indexOf(BEGIN);
    const end = issue.body.lastIndexOf(END);
    const region =
      begin < 0 ? '' : issue.body.slice(begin, end < begin ? undefined : end);
    for (const match of region.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      try {
        const claim: unknown = JSON.parse(match[1] ?? '');
        if (
          typeof claim === 'object' &&
          claim !== null &&
          'fingerprint' in claim &&
          typeof claim.fingerprint === 'string' &&
          /^[0-9a-f]{16}$/.test(claim.fingerprint)
        )
          claims.add(claim.fingerprint);
      } catch {
        // An invalid JSON block can claim only the fingerprint in the title.
      }
    }
    for (const fingerprint of claims)
      claimCounts.set(fingerprint, (claimCounts.get(fingerprint) ?? 0) + 1);
    if (
      data === null ||
      issue.title !== issueTitle(data) ||
      !authorizeIssueData(data, options.authority, options.known)
    ) {
      invalid++;
      for (const fingerprint of claims) blocked.add(fingerprint);
      continue;
    }
    records.push({ issue, data, claims });
  }
  let duplicate = 0;
  for (const [fingerprint, count] of claimCounts) {
    if (count > 1) {
      blocked.add(fingerprint);
      duplicate++;
    }
  }
  const byFingerprint = new Map<string, { issue: Issue; data: IssueData }>();
  let serverCreated = 0;
  let clientCreated = 0;
  for (const { issue, data, claims } of records) {
    if ([...claims].some((fingerprint) => blocked.has(fingerprint))) continue;
    byFingerprint.set(data.fingerprint, { issue, data });
  }
  // A damaged or isolated authenticated issue has still spent its creation slot.
  for (const issue of filerIssues) {
    const created = Date.parse(issue.createdAt);
    if (created < options.now - DAY || created > options.now) continue;
    const data = parseRegion(issue.body);
    const server =
      issue.labels.includes('source:server') || data?.source === 'server';
    const client =
      issue.labels.includes('source:viewer') ||
      issue.labels.includes('source:mcp') ||
      data?.source === 'viewer' ||
      data?.source === 'mcp';
    if (server || !client) serverCreated++;
    if (client || !server) clientCreated++;
  }
  let autofixUsed = 0;
  let clientAutofixUsed = 0;
  const unavailable = new Set<string>();
  const pending = new Set<number>();
  if (options.autofix === 'on') {
    const history = await github.autofixHistory();
    const labelCounts = new Map<string, number>();
    const prCounts = new Map<string, number>();
    const sources = new Map<string, 'server' | 'client'>();
    for (const issue of filerIssues) {
      const parsed = parseRegion(issue.body);
      const fingerprint = parsed?.fingerprint ?? `issue:${issue.number}`;
      const server =
        issue.labels.includes('source:server') || parsed?.source === 'server';
      const client =
        issue.labels.includes('source:viewer') ||
        issue.labels.includes('source:mcp') ||
        parsed?.source === 'viewer' ||
        parsed?.source === 'mcp';
      if (server !== client)
        sources.set(fingerprint, server ? 'server' : 'client');
      const events = await github.autofixLabelTimes(issue.number);
      const marker = reservation(issue.body);
      const lastEvent = events.reduce(
        (latest, time) => Math.max(latest, Date.parse(time) || 0),
        0
      );
      const reservedAt =
        marker && marker !== 'invalid'
          ? marker.at
          : issue.labels.includes('autofix')
            ? lastEvent || Date.parse(issue.createdAt)
            : 0;
      if (
        marker === 'invalid' ||
        (reservedAt && options.now - reservedAt < AUTOFIX_RESERVATION_TTL_MS)
      )
        pending.add(issue.number);
      const recent = events.filter((time) => {
        const created = Date.parse(time);
        return created >= options.now - DAY && created <= options.now;
      }).length;
      if (recent)
        labelCounts.set(
          fingerprint,
          (labelCounts.get(fingerprint) ?? 0) + recent
        );
    }
    for (const branch of history.branches) unavailable.add(branch.fingerprint);
    for (const pr of history.pullRequests) {
      if (pr.state === 'open' || (BLOCK_CLOSED_UNMERGED_AUTOFIX && !pr.merged))
        unavailable.add(pr.fingerprint);
      const created = Date.parse(pr.createdAt);
      if (created >= options.now - DAY && created <= options.now)
        prCounts.set(pr.fingerprint, (prCounts.get(pr.fingerprint) ?? 0) + 1);
    }
    for (const fingerprint of new Set([
      ...labelCounts.keys(),
      ...prCounts.keys(),
    ])) {
      const used = Math.max(
        labelCounts.get(fingerprint) ?? 0,
        prCounts.get(fingerprint) ?? 0
      );
      autofixUsed += used;
      if (sources.get(fingerprint) !== 'server') clientAutofixUsed += used;
    }
  }
  const all = aggregate(entries).filter(
    (group) => !blocked.has(group.data.fingerprint)
  );
  const actions: Action[] = [];
  const candidates: Candidate[] = [];
  for (const group of all.slice(0, MAX_FINGERPRINTS)) {
    const data = group.data;
    const issue = byFingerprint.get(data.fingerprint)?.issue;
    const sourceLabel = `source:${data.source}`;
    if (issue === undefined) {
      if (
        data.source === 'server'
          ? serverCreated >= MAX_PER_SOURCE
          : clientCreated >= MAX_PER_SOURCE
      )
        continue;
      if (data.source === 'server') serverCreated++;
      else clientCreated++;
      actions.push({
        kind: 'create',
        fingerprint: data.fingerprint,
        title: issueTitle(data),
        body: renderRegion(data),
        labels: ['error-report', sourceLabel],
      });
    } else {
      const body = replaceRegion(issue.body, data);
      if (body !== issue.body)
        actions.push({
          kind: 'update',
          fingerprint: data.fingerprint,
          issue: issue.number,
          body,
        });
      const labels = ['error-report', sourceLabel].filter(
        (label) => !issue.labels.includes(label)
      );
      if (issue.state === 'closed' && issue.closedAt !== null) {
        const closedAt = Date.parse(issue.closedAt);
        if (
          group.entries.some(
            (entry) =>
              Date.parse(entry.timestamp) > closedAt &&
              Date.parse(entry.committedAt) > closedAt
          ) &&
          !issue.labels.includes('seen-after-close')
        )
          labels.push('seen-after-close');
      }
      if (labels.length)
        actions.push({
          kind: 'labels',
          fingerprint: data.fingerprint,
          issue: issue.number,
          labels,
        });
      if (!issue.locked)
        actions.push({
          kind: 'lock',
          fingerprint: data.fingerprint,
          issue: issue.number,
        });
    }
    if (
      options.autofix === 'on' &&
      autofixUsed < MAX_AUTOFIX &&
      !unavailable.has(data.fingerprint) &&
      (data.source === 'server' ||
        (clientAutofixUsed < MAX_CLIENT_AUTOFIX &&
          data.count7d >= CLIENT_AUTOFIX_MIN_COUNT &&
          (data.builds.length >= CLIENT_AUTOFIX_MIN_BUILDS ||
            group.entries.some(
              (entry) =>
                options.now - Date.parse(entry.timestamp) >=
                CLIENT_AUTOFIX_MIN_AGE_MS
            )))) &&
      (issue === undefined ||
        (issue.state === 'open' && !pending.has(issue.number)))
    ) {
      candidates.push({
        fingerprint: data.fingerprint,
        issue: issue?.number ?? null,
        source: data.source,
      });
      autofixUsed++;
      if (data.source !== 'server') clientAutofixUsed++;
    }
  }
  // A seven-day count must decay to zero when the last hit ages out.
  const active = new Set(all.map((group) => group.data.fingerprint));
  const stale: Array<{ issue: Issue; data: IssueData }> = [];
  for (const [fingerprint, { issue, data }] of byFingerprint) {
    if (active.has(fingerprint)) continue;
    if (data && data.count7d > 0) stale.push({ issue, data });
  }
  stale.sort((a, b) => a.issue.number - b.issue.number);
  const remaining = Math.max(0, MAX_FINGERPRINTS - all.length);
  for (const { issue, data } of stale.slice(0, remaining)) {
    actions.push({
      kind: 'update',
      fingerprint: data.fingerprint,
      issue: issue.number,
      body: replaceRegion(issue.body, { ...data, count7d: 0 }),
    });
    if (!issue.locked)
      actions.push({
        kind: 'lock',
        fingerprint: data.fingerprint,
        issue: issue.number,
      });
  }
  return {
    actions,
    candidates,
    isolated: { invalid, duplicate },
    truncated:
      Math.max(0, all.length - MAX_FINGERPRINTS) +
      Math.max(0, stale.length - remaining),
  };
}

export async function applyPlan(
  plan: Plan,
  github: GitHub,
  mode: 'dry-run' | 'live',
  context?: { runId: string; now: number; filerAuthor?: IssueAuthor }
): Promise<Candidate[]> {
  if (mode === 'dry-run') return [];
  if (
    plan.candidates.length &&
    (!context ||
      !/^[1-9]\d{0,19}$/.test(context.runId) ||
      !Number.isSafeInteger(context.now) ||
      context.now <= 0)
  )
    throw new Error('Autofix reservation requires a run id and time');
  const labels = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === 'create' || action.kind === 'labels')
      for (const label of action.labels) labels.add(label);
  }
  if (plan.candidates.length) labels.add('autofix');
  if (labels.size) await github.ensureLabels([...labels]);
  const created = new Map<string, number>();
  for (const action of plan.actions) {
    if (action.kind === 'create') {
      const issue = await github.createIssue(
        action.title,
        action.body,
        action.labels
      );
      created.set(action.fingerprint, issue.number);
      await github.lockIssue(issue.number);
    } else if (action.kind === 'update')
      await github.updateIssue(action.issue, action.body);
    else if (action.kind === 'labels')
      await github.addLabels(action.issue, action.labels);
    else await github.lockIssue(action.issue);
  }
  const candidates = plan.candidates.map((candidate) => {
    const issue = candidate.issue ?? created.get(candidate.fingerprint);
    if (issue === undefined) throw new Error('Autofix candidate has no issue');
    return { ...candidate, issue };
  });
  if (candidates.length) {
    const issues = new Map(
      (await github.listIssues()).map((issue) => [issue.number, issue])
    );
    for (const candidate of candidates) {
      const issue = issues.get(candidate.issue);
      const data = issue ? parseRegion(issue.body) : null;
      if (
        !issue ||
        !isFilerAuthor(issue.author, context?.filerAuthor) ||
        issue.state !== 'open' ||
        data === null ||
        data.fingerprint !== candidate.fingerprint ||
        issue.title !== issueTitle(data)
      )
        throw new Error('Autofix reservation issue refused');
      await github.updateIssue(
        issue.number,
        setReservation(issue.body, context!.runId, context!.now)
      );
      if (issue.labels.includes('autofix'))
        await github.removeLabel(issue.number, 'autofix');
      await github.addLabels(issue.number, ['autofix']);
    }
  }
  return candidates;
}
