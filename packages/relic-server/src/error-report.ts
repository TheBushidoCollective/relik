import {
  classOf,
  type ErrorReport,
  fingerprintOf,
  nodeFramesFrom,
  parseClientReport,
  parseLoggedReport,
} from '@relic/format/error-report';
import { serverRouteOf } from './error-report-routes.ts';

const MAX_FINGERPRINTS = 200;
const MAX_MCP_FINGERPRINTS = 32;
const MAX_BUILDS_PER_FINGERPRINT = 8;
const EMISSION_INTERVAL_MS = 600_000;
const CLIENT_LIFETIME_MS = 86_400_000;
const MAX_COUNT = 1_000_000;
const MAX_EMISSIONS_PER_WINDOW = {
  server: 256,
  viewer: 256,
  mcp: 64,
} as const;

interface BuildEntry {
  report: ErrorReport;
  readonly firstSeen: number;
  lastEmission: number;
  pending: number;
  total: number;
}

interface Entry {
  readonly firstSeen: number;
  total: number;
  readonly builds: Map<string, BuildEntry>;
}

export interface ErrorReporter {
  server(error: unknown, method: string, pathname: string): void;
  client(report: ErrorReport): void;
}

export function createErrorReporter(options: {
  readonly revision?: string | undefined;
  readonly now?: () => number;
  readonly emit?: (line: string) => void;
}): ErrorReporter {
  const now = options.now ?? Date.now;
  const emit = options.emit ?? ((line: string) => console.log(line));
  const serverEntries = new Map<string, Entry>();
  const viewerEntries = new Map<string, Entry>();
  const mcpEntries = new Map<string, Entry>();
  // These windows are independent of the evictable aggregation maps. Each
  // emitted fingerprint/build occupies a slot until its suppression expires.
  const recentEmissions = {
    server: new Map<string, number>(),
    viewer: new Map<string, number>(),
    mcp: new Map<string, number>(),
  };

  function flush(fingerprint: string, build: BuildEntry, at: number): void {
    if (build.pending === 0) return;
    const report = { ...build.report, count: build.pending };
    // Recheck at the output boundary even when the caller supplied a typed object.
    const valid = parseLoggedReport(report);
    if (valid === null) return;
    const recent = recentEmissions[report.source];
    for (const [key, expiresAt] of recent) {
      if (at < expiresAt) break;
      recent.delete(key);
    }
    const key = `${fingerprint}:${report.revision}`;
    if (
      recent.has(key) ||
      recent.size >= MAX_EMISSIONS_PER_WINDOW[report.source]
    )
      return;
    // Reserve before writing so a throwing sink cannot bypass the bound.
    recent.set(key, at + EMISSION_INTERVAL_MS);
    emit(
      JSON.stringify({
        severity: 'ERROR',
        message: 'relik error report',
        event: 'relik.error_report.v1',
        fingerprint,
        report: valid,
      })
    );
    build.pending = 0;
    build.lastEmission = at;
  }

  function flushEntry(fingerprint: string, entry: Entry, at: number): void {
    for (const build of entry.builds.values()) {
      try {
        flush(fingerprint, build, at);
      } catch {
        // A failed sink must not replace the response to the user.
      }
    }
  }

  function flushDue(at: number): void {
    for (const entries of [serverEntries, viewerEntries, mcpEntries]) {
      for (const [fingerprint, entry] of entries) {
        for (const build of entry.builds.values()) {
          if (at - build.lastEmission >= EMISSION_INTERVAL_MS) {
            try {
              flush(fingerprint, build, at);
            } catch {
              // Keep this build's pending count for another attempt.
            }
          }
        }
      }
    }
  }

  // Prefer evicting the least frequent entry, breaking ties by oldest arrival.
  function victim<T extends { readonly firstSeen: number; total: number }>(
    entries: Map<string, T>,
    eligible?: (value: T) => boolean
  ): string | undefined {
    let key: string | undefined;
    let selected: T | undefined;
    for (const [candidate, value] of entries) {
      if (eligible !== undefined && !eligible(value)) continue;
      if (
        selected === undefined ||
        value.total < selected.total ||
        (value.total === selected.total && value.firstSeen < selected.firstSeen)
      ) {
        key = candidate;
        selected = value;
      }
    }
    return key;
  }

  function noPendingBuilds(entry: Entry): boolean {
    for (const build of entry.builds.values()) {
      if (build.pending > 0) return false;
    }
    return true;
  }

  function noPendingCount(build: BuildEntry): boolean {
    return build.pending === 0;
  }

  function record(report: ErrorReport): void {
    if (options.revision === undefined) return;
    const at = now();
    for (const entries of [viewerEntries, mcpEntries]) {
      for (const [fingerprint, entry] of entries) {
        if (at - entry.firstSeen >= CLIENT_LIFETIME_MS) {
          flushEntry(fingerprint, entry, at);
          if (noPendingBuilds(entry)) entries.delete(fingerprint);
        }
      }
    }
    const entries =
      report.source === 'server'
        ? serverEntries
        : report.source === 'viewer'
          ? viewerEntries
          : mcpEntries;
    const capacity =
      report.source === 'mcp' ? MAX_MCP_FINGERPRINTS : MAX_FINGERPRINTS;
    const fingerprint = fingerprintOf(report);
    let entry = entries.get(fingerprint);
    if (entry === undefined) {
      if (entries.size >= capacity) {
        flushDue(at);
        const oldest = victim(entries, noPendingBuilds);
        if (oldest === undefined) return;
        flushEntry(oldest, entries.get(oldest)!, at);
        entries.delete(oldest);
      }
      entry = { firstSeen: at, total: 0, builds: new Map() };
      entries.set(fingerprint, entry);
    }
    let build = entry.builds.get(report.revision);
    if (build === undefined) {
      if (entry.builds.size >= MAX_BUILDS_PER_FINGERPRINT) {
        flushDue(at);
        const oldest = victim(entry.builds, noPendingCount);
        if (oldest === undefined) return;
        try {
          flush(fingerprint, entry.builds.get(oldest)!, at);
        } catch {
          // Eviction still bounds memory if the sink has failed.
        }
        entry.builds.delete(oldest);
      }
      build = {
        report,
        firstSeen: at,
        lastEmission: at,
        pending: report.count,
        total: report.count,
      };
      entry.builds.set(report.revision, build);
      try {
        flush(fingerprint, build, at);
      } catch {
        // Keep the scrubbed pending count for a later attempt.
      }
    } else {
      build.report = report;
      build.pending = Math.min(MAX_COUNT, build.pending + report.count);
      build.total = Math.min(MAX_COUNT, build.total + report.count);
    }
    entry.total = Math.min(MAX_COUNT, entry.total + report.count);
    flushDue(at);
  }

  return {
    server(error, method, pathname) {
      try {
        if (options.revision === undefined) return;
        let stack: unknown;
        try {
          if (typeof error === 'object' && error !== null)
            stack = Reflect.get(error, 'stack');
        } catch {
          // Hostile thrown objects may throw while their properties are read.
        }
        const report = parseLoggedReport({
          v: 1,
          source: 'server',
          errorClass: classOf(error),
          route: serverRouteOf(method, pathname),
          revision: options.revision,
          frames: nodeFramesFrom(stack, 'server'),
          count: 1,
        });
        if (report !== null) record(report);
      } catch {
        // Reporting must never throw, including for hostile error objects.
      }
    },
    client(report) {
      try {
        const valid = parseClientReport(report);
        if (valid !== null) record(valid);
      } catch {
        // Reporting must never throw.
      }
    },
  };
}

export function serverErrorResponse(
  error: unknown,
  method: string,
  pathname: string,
  revision: string | undefined,
  reporter: ErrorReporter
): Response {
  try {
    if (revision === undefined) console.error(error);
    else reporter.server(error, method, pathname);
  } catch {
    // A logger must not change the response or expose an exception to Bun.
  }
  return new Response('Something went wrong!', {
    status: 500,
    headers: { 'content-type': 'text/plain' },
  });
}
