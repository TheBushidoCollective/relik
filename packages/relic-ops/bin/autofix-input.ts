import { writeFile } from 'node:fs/promises';
import { GitAuthority } from '../src/entries.ts';
import { isOwnedAutofixPull, type Issue } from '../src/github.ts';
import { issueInput } from '../src/issue-input.ts';
import { makePrompt } from '../src/prompt.ts';

const API = 'https://api.github.com/repos/TheBushidoCollective/relik';
async function get(path: string): Promise<unknown> {
  const response = await fetch(API + path, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('read');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 1_000_000) throw new Error('size');
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error('size');
  return JSON.parse(body) as unknown;
}

try {
  if (process.argv.length !== 6) throw new Error('arguments');
  const [number, fingerprint, base, promptPath] = process.argv.slice(2) as [
    string,
    string,
    string,
    string,
  ];
  if (
    !/^[1-9]\d{0,9}$/.test(number) ||
    !/^[0-9a-f]{16}$/.test(fingerprint) ||
    !/^[0-9a-f]{40}$/.test(base)
  )
    throw new Error('arguments');
  const ref = await fetch(`${API}/git/ref/heads/autofix/error-${fingerprint}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (ref.status !== 404) throw new Error('branch');
  const pulls = await get(
    `/pulls?state=all&head=TheBushidoCollective%3Aautofix%2Ferror-${fingerprint}&per_page=100`
  );
  if (
    !Array.isArray(pulls) ||
    pulls.length >= 100 ||
    pulls.some((pull: unknown) => {
      if (!isOwnedAutofixPull(pull, fingerprint)) return false;
      if (
        !pull ||
        typeof pull !== 'object' ||
        !('state' in pull) ||
        !('merged_at' in pull)
      )
        throw new Error('pull request');
      return (
        pull.state === 'open' ||
        (pull.state === 'closed' && pull.merged_at === null)
      );
    })
  )
    throw new Error('pull request');
  const value = await get(`/issues/${number}`);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('issue');
  const raw = value as Record<string, unknown>;
  if (
    'pull_request' in raw ||
    !Array.isArray(raw.labels) ||
    typeof raw.body !== 'string' ||
    typeof raw.title !== 'string'
  )
    throw new Error('issue');
  const labels = raw.labels.map((label: unknown) => {
    if (
      !label ||
      typeof label !== 'object' ||
      !('name' in label) ||
      typeof label.name !== 'string'
    )
      throw new Error('label');
    return label.name;
  });
  const author = raw.user;
  if (
    !author ||
    typeof author !== 'object' ||
    !('login' in author) ||
    !('id' in author) ||
    !('type' in author)
  )
    throw new Error('author');
  const issue: Issue = {
    number: Number(raw.number),
    author: author as Issue['author'],
    title: raw.title,
    body: raw.body,
    state: raw.state as Issue['state'],
    createdAt: String(raw.created_at),
    closedAt: raw.closed_at === null ? null : String(raw.closed_at),
    labels,
    locked: raw.locked === true,
  };
  const authority = new GitAuthority(base);
  const accepted = issueInput(
    issue,
    { issue: Number(number), fingerprint },
    authority,
    authority.knownSets()
  );
  await writeFile(promptPath, makePrompt(accepted, base), {
    mode: 0o600,
    flag: 'wx',
  });
} catch {
  process.stderr.write('Autofix input refused\n');
  process.exitCode = 1;
}
