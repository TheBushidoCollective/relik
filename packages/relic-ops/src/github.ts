import { BEGIN } from './render.ts';

export const FILER_AUTHOR_LOGIN = 'github-actions[bot]';
export const FILER_AUTHOR_ID = 41898282;
export const FILER_AUTHOR_TYPE = 'Bot';

export interface IssueAuthor {
  login: string;
  id: number;
  type: string;
}

export const DEFAULT_FILER_AUTHOR: IssueAuthor = Object.freeze({
  login: FILER_AUTHOR_LOGIN,
  id: FILER_AUTHOR_ID,
  type: FILER_AUTHOR_TYPE,
});

export function filerAuthorFromEnv(
  env: Record<string, string | undefined>
): IssueAuthor {
  const login = env.ERROR_REPORT_FILER_LOGIN ?? FILER_AUTHOR_LOGIN;
  const id = env.ERROR_REPORT_FILER_ID ?? String(FILER_AUTHOR_ID);
  const type = env.ERROR_REPORT_FILER_TYPE ?? FILER_AUTHOR_TYPE;
  if (
    !login ||
    !type ||
    !/^[1-9]\d*$/.test(id) ||
    !Number.isSafeInteger(Number(id))
  )
    throw new Error('Invalid error report filer identity');
  return { login, id: Number(id), type };
}

function decodeAuthor(value: unknown): IssueAuthor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const author = value as Record<string, unknown>;
  if (
    typeof author.login !== 'string' ||
    !Number.isSafeInteger(author.id) ||
    (author.id as number) < 1 ||
    typeof author.type !== 'string'
  )
    return null;
  return { login: author.login, id: author.id as number, type: author.type };
}

export function isFilerAuthor(
  author: IssueAuthor | null | undefined,
  expected: IssueAuthor = DEFAULT_FILER_AUTHOR
): boolean {
  return (
    author?.login === expected.login &&
    author.id === expected.id &&
    author.type === expected.type
  );
}

export interface Issue {
  number: number;
  author: IssueAuthor | null;
  title: string;
  body: string;
  state: 'open' | 'closed';
  createdAt: string;
  closedAt: string | null;
  labels: string[];
  locked: boolean;
}

export interface GitHub {
  listIssues(): Promise<Issue[]>;
  autofixLabelTimes(issue: number): Promise<string[]>;
  ensureLabels(labels: readonly string[]): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<Issue>;
  updateIssue(number: number, body: string): Promise<void>;
  addLabels(number: number, labels: string[]): Promise<void>;
  lockIssue(number: number): Promise<void>;
}

function decodeIssue(value: unknown): Issue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Malformed GitHub issue');
  const data = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(data.number) ||
    (data.number as number) < 1 ||
    typeof data.title !== 'string' ||
    (data.body !== null && typeof data.body !== 'string') ||
    (data.state !== 'open' && data.state !== 'closed') ||
    typeof data.created_at !== 'string' ||
    !Number.isFinite(Date.parse(data.created_at)) ||
    (data.closed_at !== null &&
      (typeof data.closed_at !== 'string' ||
        !Number.isFinite(Date.parse(data.closed_at)))) ||
    !Array.isArray(data.labels) ||
    typeof data.locked !== 'boolean'
  )
    throw new Error('Malformed GitHub issue');
  const labels = data.labels.map((label: unknown) => {
    if (
      typeof label !== 'object' ||
      label === null ||
      !('name' in label) ||
      typeof label.name !== 'string'
    )
      throw new Error('Malformed GitHub label');
    return label.name;
  });
  return {
    number: data.number as number,
    author: decodeAuthor(data.user),
    title: data.title,
    body: data.body ?? '',
    state: data.state,
    createdAt: data.created_at,
    closedAt: data.closed_at as string | null,
    labels,
    locked: data.locked,
  };
}

export class GitHubRest implements GitHub {
  private readonly root =
    'https://api.github.com/repos/TheBushidoCollective/relik';

  constructor(
    private readonly token: string,
    private readonly request: (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response> = fetch,
    private readonly filerAuthor: IssueAuthor = DEFAULT_FILER_AUTHOR
  ) {
    if (!token) throw new Error('Missing GitHub token');
  }

  private async call(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<unknown> {
    const response = await this.request(`${this.root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `GitHub API ${method} ${path.split('?')[0]} failed: HTTP ${response.status}`
      );
    return response.status === 204 ? null : response.json();
  }

  private async pages(path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 1000; page++) {
      const batch = await this.call(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
      );
      if (!Array.isArray(batch)) throw new Error('Malformed GitHub list');
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error('GitHub pagination limit exceeded');
  }

  async listIssues(): Promise<Issue[]> {
    // A removed label must not make an old fingerprint eligible for a second issue.
    const values = await this.pages('/issues?state=all');
    return values
      .filter(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          !('pull_request' in value) &&
          'user' in value &&
          isFilerAuthor(decodeAuthor(value.user), this.filerAuthor)
      )
      .map(decodeIssue)
      .filter(
        (issue) =>
          issue.labels.includes('error-report') ||
          /^Error report: .+ \[[0-9a-f]{16}\]$/.test(issue.title) ||
          issue.body.includes(BEGIN)
      );
  }

  async autofixLabelTimes(issue: number): Promise<string[]> {
    const events = await this.pages(`/issues/${issue}/events`);
    const times: string[] = [];
    for (const value of events) {
      if (typeof value !== 'object' || value === null)
        throw new Error('Malformed GitHub event');
      const event = value as Record<string, unknown>;
      if (event.event !== 'labeled') continue;
      const label = event.label;
      if (
        typeof label !== 'object' ||
        label === null ||
        !('name' in label) ||
        label.name !== 'autofix'
      )
        continue;
      if (
        typeof event.created_at !== 'string' ||
        !Number.isFinite(Date.parse(event.created_at))
      )
        throw new Error('Malformed autofix event');
      times.push(event.created_at);
    }
    return times;
  }

  async ensureLabels(labels: readonly string[]): Promise<void> {
    const allowed: Record<string, true> = {
      'error-report': true,
      'source:server': true,
      'source:viewer': true,
      'source:mcp': true,
      'seen-after-close': true,
      autofix: true,
    };
    if (labels.some((label) => !Object.hasOwn(allowed, label)))
      throw new Error('Unknown error report label');
    const existing = await this.pages('/labels');
    const names = new Set<string>();
    for (const value of existing) {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('name' in value) ||
        typeof value.name !== 'string'
      )
        throw new Error('Malformed GitHub label');
      names.add(value.name);
    }
    for (const name of labels) {
      if (!names.has(name))
        await this.call('/labels', 'POST', { name, color: '6e7781' });
    }
  }

  async createIssue(
    title: string,
    body: string,
    labels: string[]
  ): Promise<Issue> {
    return decodeIssue(
      await this.call('/issues', 'POST', { title, body, labels })
    );
  }

  async updateIssue(number: number, body: string): Promise<void> {
    await this.call(`/issues/${number}`, 'PATCH', { body });
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    await this.call(`/issues/${number}/labels`, 'POST', { labels });
  }

  async lockIssue(number: number): Promise<void> {
    await this.call(`/issues/${number}/lock`, 'PUT', {});
  }
}

/** Stateful fake: tests cannot reach GitHub and can assert every write. */
export class MemoryGitHub implements GitHub {
  readonly issues: Issue[];
  readonly labelEvents = new Map<number, string[]>();
  readonly labels = new Set<string>();
  writes = 0;
  constructor(
    issues: Issue[] = [],
    private readonly now = () => new Date().toISOString(),
    private readonly filerAuthor: IssueAuthor = DEFAULT_FILER_AUTHOR
  ) {
    this.issues = structuredClone(issues);
  }
  async listIssues(): Promise<Issue[]> {
    return structuredClone(this.issues);
  }
  async autofixLabelTimes(issue: number): Promise<string[]> {
    return [...(this.labelEvents.get(issue) ?? [])];
  }
  async ensureLabels(labels: readonly string[]): Promise<void> {
    for (const label of labels) {
      if (!this.labels.has(label)) {
        this.writes++;
        this.labels.add(label);
      }
    }
  }
  async createIssue(
    title: string,
    body: string,
    labels: string[]
  ): Promise<Issue> {
    this.writes++;
    const issue: Issue = {
      number: Math.max(0, ...this.issues.map((value) => value.number)) + 1,
      author: { ...this.filerAuthor },
      title,
      body,
      labels: [...labels],
      state: 'open',
      createdAt: this.now(),
      closedAt: null,
      locked: false,
    };
    this.issues.push(issue);
    return structuredClone(issue);
  }
  async updateIssue(number: number, body: string): Promise<void> {
    this.writes++;
    this.issue(number).body = body;
  }
  async addLabels(number: number, labels: string[]): Promise<void> {
    this.writes++;
    const issue = this.issue(number);
    for (const label of labels) {
      if (!issue.labels.includes(label)) issue.labels.push(label);
      if (label === 'autofix')
        this.labelEvents.set(number, [
          ...(this.labelEvents.get(number) ?? []),
          this.now(),
        ]);
    }
  }
  async lockIssue(number: number): Promise<void> {
    this.writes++;
    this.issue(number).locked = true;
  }
  private issue(number: number): Issue {
    const issue = this.issues.find((value) => value.number === number);
    if (issue === undefined) throw new Error('Unknown issue');
    return issue;
  }
}
