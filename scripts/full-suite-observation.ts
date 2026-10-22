import { appendFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const OBSERVATION_DIRECTORY = 'RELIC_SUITE_OBSERVATION_DIR';

export type ObservationEvent = 'begin' | 'complete' | 'error';

type ObservationField = boolean | number | string | null | undefined;
type ObservationFields = Readonly<Record<string, ObservationField>>;

export interface ObservationOperation {
  readonly enabled: boolean;
  readonly origin: string;
  readonly operationId: string;
  readonly stage: string;
  readonly startedMonotonicMs: number;
}

let sequence = 0;
let operationSequence = 0;
let lastObservationMonotonicMs: number | undefined;

function observationDirectory(): string | undefined {
  const directory = process.env[OBSERVATION_DIRECTORY];
  if (directory === undefined || directory.length === 0) return undefined;
  if (!isAbsolute(directory)) {
    throw new Error(`${OBSERVATION_DIRECTORY} must be an absolute directory`);
  }
  return directory;
}

function errorFields(error: unknown): ObservationFields {
  if (error === null || typeof error !== 'object') {
    return { error_type: typeof error };
  }

  const candidate = error as { name?: unknown; code?: unknown };
  const name =
    typeof candidate.name === 'string' && candidate.name.length > 0
      ? candidate.name
      : 'Error';
  const code =
    typeof candidate.code === 'string' && /^[A-Z0-9_-]+$/.test(candidate.code)
      ? candidate.code
      : undefined;
  return { error_name: name, error_code: code };
}

function writeObservation(
  origin: string,
  operationId: string,
  stage: string,
  event: ObservationEvent,
  durationMs: number,
  fields: ObservationFields
): void {
  const directory = observationDirectory();
  if (directory === undefined) return;

  const monotonicMs = performance.now();
  const observationHeartbeatLatenessMs =
    lastObservationMonotonicMs === undefined
      ? 0
      : Math.max(0, monotonicMs - lastObservationMonotonicMs - 250);
  lastObservationMonotonicMs = monotonicMs;
  const cpu = process.cpuUsage();
  appendFileSync(
    join(directory, `trace-${process.pid}.jsonl`),
    `${JSON.stringify({
      origin,
      pid: process.pid,
      ppid: process.ppid,
      sequence: ++sequence,
      wall_clock_ms: Date.now(),
      monotonic_ms: monotonicMs,
      operation_id: operationId,
      stage,
      event,
      duration_ms: durationMs,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      observation_heartbeat_lateness_ms: observationHeartbeatLatenessMs,
      ...fields,
    })}\n`,
    'utf8'
  );
}

export function observationEnabled(): boolean {
  return observationDirectory() !== undefined;
}

export function observeEvent(
  origin: string,
  operationId: string,
  stage: string,
  event: ObservationEvent,
  fields: ObservationFields = {}
): void {
  writeObservation(origin, operationId, stage, event, 0, fields);
}

export function observeBegin(
  origin: string,
  stage: string,
  fields: ObservationFields = {}
): ObservationOperation {
  const startedMonotonicMs = performance.now();
  const operation: ObservationOperation = {
    enabled: observationEnabled(),
    origin,
    operationId: `${process.pid}:${++operationSequence}`,
    stage,
    startedMonotonicMs,
  };
  if (operation.enabled) {
    writeObservation(
      operation.origin,
      operation.operationId,
      operation.stage,
      'begin',
      0,
      fields
    );
  }
  return operation;
}

export function observeComplete(
  operation: ObservationOperation,
  fields: ObservationFields = {}
): void {
  if (!operation.enabled) return;
  writeObservation(
    operation.origin,
    operation.operationId,
    operation.stage,
    'complete',
    performance.now() - operation.startedMonotonicMs,
    fields
  );
}

export function observeError(
  operation: ObservationOperation,
  error: unknown,
  fields: ObservationFields = {}
): void {
  if (!operation.enabled) return;
  writeObservation(
    operation.origin,
    operation.operationId,
    operation.stage,
    'error',
    performance.now() - operation.startedMonotonicMs,
    { ...fields, ...errorFields(error) }
  );
}

export async function observeAwait<T>(
  origin: string,
  stage: string,
  work: () => Promise<T> | T,
  fields: ObservationFields = {}
): Promise<T> {
  const operation = observeBegin(origin, stage, fields);
  try {
    const value = await work();
    observeComplete(operation);
    return value;
  } catch (error) {
    observeError(operation, error);
    throw error;
  }
}
