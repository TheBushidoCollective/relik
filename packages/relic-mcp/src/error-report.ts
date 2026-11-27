import {
  classOf,
  fingerprintOf,
  nodeFramesFrom,
  parseClientReport,
} from '@relic/format/error-report';
import { resolveOrigin } from './origin.ts';

declare const __RELIC_RELEASE_BUILD__: boolean | undefined;

const RELEASE_VERSION = process.env.RELIC_MCP_VERSION ?? '0.0.0-dev';
const sent = new Set<string>();
const MAX_REPORTS = 20;

/** Reports are opt-in and have a schema-compatible release version. */
export function mcpErrorReportsEnabled(): boolean {
  return (
    typeof __RELIC_RELEASE_BUILD__ !== 'undefined' &&
    __RELIC_RELEASE_BUILD__ === true &&
    process.env['RELIC_ERROR_REPORTS'] === '1' &&
    /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(
      RELEASE_VERSION
    )
  );
}

/**
 * Send only an allowlisted report. Reporting must never disrupt the tool or
 * print an error, including when the thrown value has hostile getters.
 */
export async function reportMcpError(
  error: unknown,
  route: string,
  options: { serviceOrigin?: string; fetch?: typeof globalThis.fetch } = {}
): Promise<void> {
  try {
    if (!mcpErrorReportsEnabled() || sent.size >= MAX_REPORTS) return;
    const stack =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'stack')
        : undefined;
    const report = parseClientReport({
      v: 1,
      source: 'mcp',
      errorClass: classOf(error),
      route,
      revision: RELEASE_VERSION,
      frames: nodeFramesFrom(stack, 'mcp'),
      count: 1,
    });
    if (report === null) return;
    const key = fingerprintOf(report);
    if (sent.has(key)) return;
    sent.add(key);
    const origin =
      options.serviceOrigin ??
      resolveOrigin(
        'RELIC_SERVICE_ORIGIN',
        process.env['RELIC_SERVICE_ORIGIN']
      );
    await (options.fetch ?? globalThis.fetch)(`${origin}/api/error-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Reporting is best-effort and must not reveal the original error.
  }
}
