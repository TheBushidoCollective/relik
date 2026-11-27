import {
  classOf,
  type ErrorReport,
  viewerFramesFrom,
} from '@relic/format/error-report';

const REVISION = /^[0-9a-f]{40}$(?![\s\S])/;
const MAX_REPORTS = 5;

type Reporter = (error: unknown) => void;
let installedReporter: Reporter | undefined;

/** Report a caught rendering failure through the same boundary as global errors. */
export function reportViewerError(error: unknown): void {
  try {
    installedReporter?.(error);
  } catch {
    // Reporting must not change the viewer's failure handling.
  }
}

/** Install once per viewer page; the reporter never inspects the page URL. */
export function installErrorReporter(
  win: Window,
  root: Pick<HTMLElement, 'dataset'> | null,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  installedReporter = undefined;
  try {
    const revision = root?.dataset['revision'];
    if (revision === undefined || !REVISION.test(revision)) return;
    const view = root?.dataset['view'];
    const route =
      root?.dataset['relicAccess'] === 'private'
        ? 'private-reader'
        : view === 'dashboard' || view === 'publish' || view === 'document'
          ? view
          : 'public-open';
    const origin = win.origin;
    const seen = new Set<string>();
    let sent = 0;

    const report: Reporter = (error) => {
      try {
        if (sent >= MAX_REPORTS || typeof error !== 'object' || error === null)
          return;
        const frames = viewerFramesFrom(Reflect.get(error, 'stack'), origin);
        const first = frames[0];
        if (first === undefined) return;
        const errorClass = classOf(error);
        const key = JSON.stringify([
          errorClass,
          route,
          first.file,
          first.line,
          first.column,
        ]);
        if (seen.has(key)) return;
        seen.add(key);
        sent++;
        const body: ErrorReport = {
          v: 1,
          source: 'viewer',
          errorClass,
          route,
          revision,
          frames,
          count: 1,
        };
        void Promise.resolve(
          send('/api/error-reports', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'omit',
            keepalive: true,
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
          })
        ).catch(() => {});
      } catch {
        // Malformed errors, browser restrictions, and failed sends are ignored.
      }
    };

    win.addEventListener('error', (event) => {
      try {
        if (typeof event.error === 'object' && event.error !== null)
          report(event.error);
      } catch {
        // Event properties can themselves be inaccessible.
      }
    });
    win.addEventListener('unhandledrejection', (event) => {
      try {
        report(event.reason);
      } catch {
        // Event properties can themselves be inaccessible.
      }
    });
    installedReporter = report;
  } catch {
    // No reporter is installed when the page cannot safely configure one.
  }
}
