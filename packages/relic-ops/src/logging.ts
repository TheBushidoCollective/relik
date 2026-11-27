export const LOG_VIEW =
  'projects/thebushido-co/locations/global/buckets/relik-error-reports/views/_AllLogs';
export const LOG_FILTER =
  'resource.type="cloud_run_revision" AND resource.labels.service_name=("relic" OR "relic-usercontent" OR "relic-presence") AND log_id("run.googleapis.com/stdout") AND jsonPayload.event="relik.error_report.v1"';
const ENDPOINT = 'https://logging.googleapis.com/v2/entries:list';
const LIMIT = 50_000;

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
  since: string
): Promise<unknown[]> {
  if (!Number.isFinite(Date.parse(since)))
    throw new Error('Invalid log window');
  const result: unknown[] = [];
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await transport.post({
      resourceNames: [LOG_VIEW],
      filter: `${LOG_FILTER} AND timestamp >= "${new Date(since).toISOString()}"`,
      orderBy: 'timestamp desc',
      pageSize: 1000,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (typeof page !== 'object' || page === null || Array.isArray(page))
      throw new Error('Malformed Cloud Logging response');
    const record = page as Record<string, unknown>;
    if (record.entries !== undefined && !Array.isArray(record.entries))
      throw new Error('Malformed Cloud Logging entries');
    result.push(...((record.entries ?? []) as unknown[]));
    if (result.length > LIMIT)
      throw new Error(
        'Cloud Logging entry limit exceeded; refusing incomplete counts'
      );
    if (
      record.nextPageToken !== undefined &&
      typeof record.nextPageToken !== 'string'
    )
      throw new Error('Malformed Cloud Logging page token');
    pageToken = record.nextPageToken as string | undefined;
    if (pageToken === '') pageToken = undefined;
    if (pageToken !== undefined) {
      if (tokens.has(pageToken) || result.length >= LIMIT)
        throw new Error('Cloud Logging pagination incomplete');
      tokens.add(pageToken);
    }
  } while (pageToken !== undefined);
  return result;
}
