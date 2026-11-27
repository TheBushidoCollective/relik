import { execFileSync } from 'node:child_process';
import {
  type ErrorReport,
  type KnownSets,
  fingerprintOf,
  parseLoggedReport,
} from '@relic/format/error-report';

export interface LogEntry {
  timestamp: string;
  severity?: string;
  jsonPayload: unknown;
  insertId?: string;
}

export interface ValidEntry {
  timestamp: string;
  fingerprint: string;
  report: ErrorReport;
  committedAt: string;
}

export interface RevisionAuthority {
  commitDate(source: ErrorReport['source'], revision: string): string | null;
  serverFrameExists(revision: string, file: string, line: number): boolean;
}

/** Git is the authority, not a list of strings supplied by a log entry. */
export class GitAuthority implements RevisionAuthority {
  private readonly dates = new Map<string, string | null>();
  private readonly files = new Map<string, number | null>();

  constructor(private readonly main = 'HEAD') {}

  knownSets(): KnownSets {
    // Reject unknown attacker-supplied revisions before spawning per-revision
    // git checks. The checks below remain authoritative for accepted values.
    const history = execFileSync('git', ['rev-list', this.main], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const tags = execFileSync('git', ['tag', '--list', 'relic-mcp-v*'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      revisions: new Set(history.split('\n').filter(Boolean)),
      mcpVersions: new Set(
        tags
          .split('\n')
          .filter((tag) =>
            /^relic-mcp-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(
              tag
            )
          )
          .map((tag) => tag.slice('relic-mcp-v'.length))
      ),
    };
  }

  commitDate(source: ErrorReport['source'], revision: string): string | null {
    const key = `${source}:${revision}`;
    if (this.dates.has(key)) return this.dates.get(key) ?? null;
    let date: string | null = null;
    try {
      const ref =
        source === 'mcp' ? `refs/tags/relic-mcp-v${revision}` : revision;
      execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
        stdio: 'ignore',
      });
      if (source !== 'mcp') {
        execFileSync(
          'git',
          ['merge-base', '--is-ancestor', revision, this.main],
          { stdio: 'ignore' }
        );
      }
      const value = execFileSync('git', ['show', '-s', '--format=%cI', ref], {
        encoding: 'utf8',
      }).trim();
      if (Number.isFinite(Date.parse(value)))
        date = new Date(value).toISOString();
    } catch {
      // Unknown revisions and tags are rejected rather than guessed.
    }
    this.dates.set(key, date);
    return date;
  }

  serverFrameExists(revision: string, file: string, line: number): boolean {
    const key = `${revision}:${file}`;
    if (!this.files.has(key)) {
      let length: number | null = null;
      try {
        execFileSync('git', ['cat-file', '-e', key], { stdio: 'ignore' });
        const tree = execFileSync('git', ['ls-tree', revision, '--', file], {
          encoding: 'utf8',
        });
        if (!/^(100644|100755) blob [0-9a-f]{40}\t/.test(tree))
          throw new Error('Frame is not a regular file');
        const text = execFileSync('git', ['show', key], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        length =
          text.length === 0
            ? 0
            : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch {
        // Missing or unreadable files are not accepted as frames.
      }
      this.files.set(key, length);
    }
    const length = this.files.get(key);
    return length !== null && length !== undefined && line <= length;
  }
}

export type DropReason =
  | 'shape'
  | 'timestamp'
  | 'outside-window'
  | 'fingerprint'
  | 'revision'
  | 'frame'
  | 'duplicate';
export type DropCounts = Record<DropReason, number>;

export function validateEntries(
  input: readonly unknown[],
  authority: RevisionAuthority,
  options: { now: number; since: number; known?: KnownSets }
): { entries: ValidEntry[]; dropped: DropCounts } {
  const dropped: DropCounts = {
    shape: 0,
    timestamp: 0,
    'outside-window': 0,
    fingerprint: 0,
    revision: 0,
    frame: 0,
    duplicate: 0,
  };
  const entries: ValidEntry[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      dropped.shape++;
      continue;
    }
    const entry = item as Record<string, unknown>;
    const timestamp =
      typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) {
      dropped.timestamp++;
      continue;
    }
    if (timestamp < options.since || timestamp > options.now) {
      dropped['outside-window']++;
      continue;
    }
    const payload = entry.jsonPayload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      dropped.shape++;
      continue;
    }
    const p = payload as Record<string, unknown>;
    // Logging extracts severity into the enclosing LogEntry for structured stdout.
    const keys = Object.keys(p).sort().join(',');
    const severity = p.severity ?? entry.severity;
    if (
      (keys !== 'event,fingerprint,message,report' &&
        keys !== 'event,fingerprint,message,report,severity') ||
      severity !== 'ERROR' ||
      p.message !== 'relik error report' ||
      p.event !== 'relik.error_report.v1'
    ) {
      dropped.shape++;
      continue;
    }
    const report = parseLoggedReport(p.report);
    if (
      report === null ||
      typeof p.fingerprint !== 'string' ||
      !/^[0-9a-f]{16}$/.test(p.fingerprint)
    ) {
      dropped.shape++;
      continue;
    }
    if (fingerprintOf(report) !== p.fingerprint) {
      dropped.fingerprint++;
      continue;
    }
    if (options.known && parseLoggedReport(p.report, options.known) === null) {
      dropped.revision++;
      continue;
    }
    const committedAt = authority.commitDate(report.source, report.revision);
    if (committedAt === null) {
      dropped.revision++;
      continue;
    }
    if (
      report.source === 'server' &&
      report.frames.some(
        (frame) =>
          !authority.serverFrameExists(report.revision, frame.file, frame.line)
      )
    ) {
      dropped.frame++;
      continue;
    }
    if (typeof entry.insertId === 'string') {
      const key = `${entry.timestamp}:${entry.insertId}`;
      if (seen.has(key)) {
        dropped.duplicate++;
        continue;
      }
      seen.add(key);
    }
    entries.push({
      timestamp: new Date(timestamp).toISOString(),
      fingerprint: p.fingerprint,
      report,
      committedAt,
    });
  }
  return { entries, dropped };
}
