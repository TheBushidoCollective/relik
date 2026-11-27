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
const EMISSION_INTERVAL_MS = 600_000;
const CLIENT_LIFETIME_MS = 86_400_000;
const MAX_COUNT = 1_000_000;

interface Entry {
  report: ErrorReport;
  readonly firstSeen: number;
  lastEmission: number;
  pending: number;
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
  const clientEntries = new Map<string, Entry>();

  function flush(fingerprint: string, entry: Entry, at: number): void {
    if (entry.pending === 0) return;
    const report = { ...entry.report, count: entry.pending };
    // Recheck at the output boundary even when the caller supplied a typed object.
    const valid = parseLoggedReport(report);
    if (valid === null) return;
    emit(
      JSON.stringify({
        severity: 'ERROR',
        message: 'relik error report',
        event: 'relik.error_report.v1',
        fingerprint,
        report: valid,
      })
    );
    entry.pending = 0;
    entry.lastEmission = at;
  }

  function flushDue(at: number): void {
    for (const entries of [serverEntries, clientEntries]) {
      for (const [fingerprint, entry] of entries) {
        if (at - entry.lastEmission >= EMISSION_INTERVAL_MS) {
          try {
            flush(fingerprint, entry, at);
          } catch {
            // A failed sink must not replace the response to the user.
          }
        }
      }
    }
  }

  function record(report: ErrorReport): void {
    if (options.revision === undefined) return;
    const at = now();
    for (const [fingerprint, entry] of clientEntries) {
      if (at - entry.firstSeen >= CLIENT_LIFETIME_MS) {
        try {
          flush(fingerprint, entry, at);
        } catch {
          // Expiry still bounds client state if the sink has failed.
        }
        clientEntries.delete(fingerprint);
      }
    }
    const entries = report.source === 'server' ? serverEntries : clientEntries;
    const fingerprint = fingerprintOf(report);
    const existing = entries.get(fingerprint);
    if (existing !== undefined) {
      existing.report = report;
      existing.pending = Math.min(MAX_COUNT, existing.pending + report.count);
    } else if (entries.size < MAX_FINGERPRINTS) {
      const entry: Entry = {
        report,
        firstSeen: at,
        lastEmission: at,
        pending: report.count,
      };
      entries.set(fingerprint, entry);
      try {
        flush(fingerprint, entry, at);
      } catch {
        // Keep the scrubbed pending count for a later attempt.
      }
    }
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
