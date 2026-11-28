export const LOG_VIEW =
  'projects/thebushido-co/locations/global/buckets/relik-error-reports/views/_AllLogs';
export const LOG_FILTER =
  'resource.type="cloud_run_revision" AND resource.labels.service_name=("relic" OR "relic-usercontent" OR "relic-presence") AND log_id("run.googleapis.com/stdout") AND jsonPayload.event="relik.error_report.v1"';
const ENDPOINT = 'https://logging.googleapis.com/v2/entries:list';
export const LOG_ENTRY_LIMIT_PER_SOURCE = 50_000;

export interface LogTransport {
  post(body: Record<string, unknown>): Promise<unknown>;
}

export class CloudLoggingTransport implements LogTransport {
  constructor(
    private readonly token: string,
    private readonly request: (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response> = fetch
  ) {
    if (!token) throw new Error('Missing Cloud Logging access token');
  }

  async post(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200)
      throw new Error(
        `Cloud Logging entries:list failed: HTTP ${response.status}`
      );
    return response.json();
  }
}

export async function readLogEntries(
  transport: LogTransport,
  since: string,
  options: {
    maxEntriesPerSource?: number;
    onClientTruncated?: (retained: number) => void;
  } = {}
): Promise<unknown[]> {
  if (!Number.isFinite(Date.parse(since)))
    throw new Error('Invalid log window');
  const limit = options.maxEntriesPerSource ?? LOG_ENTRY_LIMIT_PER_SOURCE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LOG_ENTRY_LIMIT_PER_SOURCE
  )
    throw new Error('Invalid per-source log limit');
  const from = new Date(since).toISOString();
  const result: unknown[] = [];
  for (const source of ['server', 'client'] as const) {
    const sourceFilter =
      source === 'server'
        ? 'jsonPayload.report.source="server"'
        : '(jsonPayload.report.source="viewer" OR jsonPayload.report.source="mcp")';
    const rows: unknown[] = [];
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await transport.post({
        resourceNames: [LOG_VIEW],
        filter: `${LOG_FILTER} AND ${sourceFilter} AND timestamp >= "${from}"`,
        orderBy: 'timestamp desc',
        pageSize: Math.min(1000, limit),
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      if (typeof page !== 'object' || page === null || Array.isArray(page))
        throw new Error('Malformed Cloud Logging response');
      const record = page as Record<string, unknown>;
      if (record.entries !== undefined && !Array.isArray(record.entries))
        throw new Error('Malformed Cloud Logging entries');
      const batch = (record.entries ?? []) as unknown[];
      if (
        record.nextPageToken !== undefined &&
        typeof record.nextPageToken !== 'string'
      )
        throw new Error('Malformed Cloud Logging page token');
      pageToken = (record.nextPageToken as string | undefined) || undefined;
      const remaining = limit - rows.length;
      if (batch.length > remaining) {
        if (source === 'server')
          throw new Error('Cloud Logging server entry limit exceeded');
        rows.push(...batch.slice(0, remaining));
        options.onClientTruncated?.(rows.length);
        break;
      }
      rows.push(...batch);
      if (pageToken !== undefined) {
        if (rows.length >= limit) {
          if (source === 'server')
            throw new Error('Cloud Logging server entry limit exceeded');
          options.onClientTruncated?.(rows.length);
          break;
        }
        if (tokens.has(pageToken))
          throw new Error('Cloud Logging pagination incomplete');
        tokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    result.push(...rows);
  }
  return result;
}
