import type { ValidEntry } from './entries.ts';
import type { GitHub, Issue } from './github.ts';
import {
  type IssueData,
  issueTitle,
  parseRegion,
  renderRegion,
  replaceRegion,
} from './render.ts';

const DAY = 86_400_000;
const MAX_PER_SOURCE = 5;
const MAX_AUTOFIX = 3;
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
}

interface Group {
  data: IssueData;
  entries: ValidEntry[];
  last: string;
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
        { revision: string; frames: typeof newest.report.frames }
      >();
      let count7d = 0;
      for (const record of records) {
        count7d += record.report.count;
        if (!Number.isSafeInteger(count7d)) throw new Error('Count overflow');
        if (!builds.has(record.report.revision))
          builds.set(record.report.revision, {
            revision: record.report.revision,
            frames: record.report.frames,
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
  options: { now: number; autofix: 'on' | 'off' }
): Promise<Plan> {
  const issues = await github.listIssues();
  const byFingerprint = new Map<string, Issue>();
  let serverCreated = 0;
  let clientCreated = 0;
  for (const issue of issues) {
    const titleFingerprint = / \[([0-9a-f]{16})\]$/.exec(issue.title)?.[1];
    const data = parseRegion(issue.body);
    if (data && titleFingerprint && data.fingerprint !== titleFingerprint)
      throw new Error('Existing issue has conflicting fingerprints');
    const fingerprint = data?.fingerprint ?? titleFingerprint;
    if (fingerprint !== undefined) {
      if (byFingerprint.has(fingerprint))
        throw new Error('Duplicate error report fingerprint');
      byFingerprint.set(fingerprint, issue);
    }
    if (Date.parse(issue.createdAt) >= options.now - DAY) {
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
  }
  let autofixUsed = 0;
  if (options.autofix === 'on') {
    for (const issue of issues) {
      for (const time of await github.autofixLabelTimes(issue.number)) {
        if (Date.parse(time) >= options.now - DAY) autofixUsed++;
      }
    }
  }
  const all = aggregate(entries);
  const actions: Action[] = [];
  const candidates: Candidate[] = [];
  for (const group of all.slice(0, MAX_FINGERPRINTS)) {
    const data = group.data;
    const issue = byFingerprint.get(data.fingerprint);
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
      if (issue.title !== issueTitle(data))
        throw new Error('Existing issue title does not match report');
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
      (issue === undefined ||
        (issue.state === 'open' && !issue.labels.includes('autofix')))
    ) {
      candidates.push({
        fingerprint: data.fingerprint,
        issue: issue?.number ?? null,
        source: data.source,
      });
      autofixUsed++;
    }
  }
  // A seven-day count must decay to zero when the last hit ages out.
  const active = new Set(all.map((group) => group.data.fingerprint));
  const stale: Array<{ issue: Issue; data: IssueData }> = [];
  for (const [fingerprint, issue] of byFingerprint) {
    if (active.has(fingerprint)) continue;
    const data = parseRegion(issue.body);
    if (data && data.count7d > 0) stale.push({ issue, data });
  }
  stale.sort((a, b) => a.issue.number - b.issue.number);
  const remaining = Math.max(0, MAX_FINGERPRINTS - all.length);
  for (const { issue, data } of stale.slice(0, remaining)) {
    if (issue.title !== issueTitle(data))
      throw new Error('Existing issue title does not match report');
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
    truncated:
      Math.max(0, all.length - MAX_FINGERPRINTS) +
      Math.max(0, stale.length - remaining),
  };
}

export async function applyPlan(
  plan: Plan,
  github: GitHub,
  mode: 'dry-run' | 'live'
): Promise<Candidate[]> {
  if (mode === 'dry-run') return [];
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
  return plan.candidates.map((candidate) => {
    const issue = candidate.issue ?? created.get(candidate.fingerprint);
    if (issue === undefined) throw new Error('Autofix candidate has no issue');
    return { ...candidate, issue };
  });
}
