import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { observeEvent } from './full-suite-observation.ts';

const OUTER_CEILING_MS = 240_000;
const POLL_MS = 25;
const SNAPSHOT_COMMAND_TIMEOUT_MS = 8_000;
const OBSERVER_ORIGIN = 'full-suite-observer';
const ROOT = new URL('../', import.meta.url).pathname;

type ObservationEvent = 'begin' | 'complete' | 'error';

interface TraceRecord {
  readonly origin: string;
  readonly pid: number;
  readonly ppid: number;
  readonly sequence: number;
  readonly wall_clock_ms: number;
  readonly monotonic_ms: number;
  readonly operation_id: string;
  readonly stage: string;
  readonly event: ObservationEvent;
  readonly duration_ms: number;
  readonly [key: string]: unknown;
}

interface RunPaths {
  readonly out: string;
  readonly events: string;
  readonly eofTraces: string;
  readonly snapshots: string;
  readonly xdgConfig: string;
}

interface SnapshotReceipt {
  readonly operationId: string;
  readonly stage: string;
  readonly deadlineMs: number;
  readonly observedAfterMs: number;
  readonly pids: number[];
  readonly directory: string;
}

interface RetainedTrace {
  readonly destination: string;
  readonly size: number;
}

interface MonitorState {
  nextHeartbeatMs: number;
  readonly copiedTracePaths: Map<string, RetainedTrace>;
  readonly snapshots: SnapshotReceipt[];
  readonly capturedOperations: Set<string>;
  readonly capturedSelfTestOperations: Set<string>;
}

interface CommandResult {
  readonly exitCode: number | undefined;
  readonly stoppedAtCeiling: boolean;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve: resolveSleep } = Promise.withResolvers<void>();
  setTimeout(resolveSleep, ms);
  return promise;
}

function numberField(record: TraceRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringField(record: TraceRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function parseArguments(): {
  readonly out?: string;
  readonly selfTest: boolean;
} {
  const args = process.argv.slice(2);
  let out: string | undefined;
  let selfTest = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--out requires a directory');
      }
      out = value;
      index += 1;
      continue;
    }
    if (arg === '--self-test') {
      selfTest = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!selfTest && out === undefined) {
    throw new Error('Run mode requires --out <directory>');
  }
  return { out, selfTest };
}

async function prepareRunPaths(
  requestedOut: string | undefined,
  label: string
): Promise<RunPaths> {
  const out =
    requestedOut === undefined
      ? await mkdtemp(join(tmpdir(), `${label}-`))
      : resolve(requestedOut);

  if (requestedOut !== undefined) {
    await mkdir(dirname(out), { recursive: true });
    await mkdir(out);
  }

  const events = join(out, 'events');
  const eofTraces = join(out, 'eof-traces');
  const snapshots = join(out, 'snapshots');
  const xdgConfig = await mkdtemp(
    join(tmpdir(), 'relic-suite-observation-xdg-')
  );
  await Promise.all([mkdir(events), mkdir(eofTraces), mkdir(snapshots)]);

  return { out, events, eofTraces, snapshots, xdgConfig };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isTraceRecord(value: unknown): value is TraceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['origin'] === 'string' &&
    typeof candidate['pid'] === 'number' &&
    typeof candidate['ppid'] === 'number' &&
    typeof candidate['sequence'] === 'number' &&
    typeof candidate['wall_clock_ms'] === 'number' &&
    typeof candidate['monotonic_ms'] === 'number' &&
    typeof candidate['operation_id'] === 'string' &&
    typeof candidate['stage'] === 'string' &&
    (candidate['event'] === 'begin' ||
      candidate['event'] === 'complete' ||
      candidate['event'] === 'error') &&
    typeof candidate['duration_ms'] === 'number'
  );
}

async function readTraceRecords(
  eventsDirectory: string
): Promise<TraceRecord[]> {
  const names = await readdir(eventsDirectory);
  const records: TraceRecord[] = [];

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const text = await readFile(join(eventsDirectory, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isTraceRecord(parsed)) records.push(parsed);
      } catch {
        // A synchronous append can be observed between bytes. The next poll
        // sees the completed line without changing the test process.
      }
    }
  }

  records.sort((left, right) => {
    if (left.wall_clock_ms !== right.wall_clock_ms) {
      return left.wall_clock_ms - right.wall_clock_ms;
    }
    if (left.pid !== right.pid) return left.pid - right.pid;
    return left.sequence - right.sequence;
  });
  return records;
}

function outstandingOperations(records: readonly TraceRecord[]): TraceRecord[] {
  const begun = new Map<string, TraceRecord>();
  const terminal = new Set<string>();

  for (const record of records) {
    if (record.event === 'begin') begun.set(record.operation_id, record);
    if (record.event === 'complete' || record.event === 'error') {
      terminal.add(record.operation_id);
    }
  }

  return [...begun.entries()]
    .filter(([operationId]) => !terminal.has(operationId))
    .map(([, record]) => record);
}

function ownedPids(
  operation: TraceRecord,
  records: readonly TraceRecord[]
): number[] {
  const pids = new Set<number>([operation.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!pids.has(record.pid)) continue;
      const childPid = numberField(record, 'owned_child_pid');
      if (childPid !== undefined && childPid > 0 && !pids.has(childPid)) {
        pids.add(childPid);
        changed = true;
      }
    }
  }
  return [...pids].sort((left, right) => left - right);
}

async function retainEofTraces(
  paths: RunPaths,
  state: MonitorState,
  records: readonly TraceRecord[]
): Promise<void> {
  const traceSources = new Map<string, TraceRecord>();
  for (const record of records) {
    const tracePath = stringField(record, 'tap_trace_path');
    if (
      tracePath !== undefined &&
      isAbsolute(tracePath) &&
      basename(tracePath) === 'stdio-eof-trace.jsonl'
    ) {
      traceSources.set(tracePath, record);
    }
  }

  for (const [tracePath, record] of traceSources) {
    const destination = join(paths.eofTraces, `tap-${record.pid}.jsonl`);
    const operationId = `retain-tap-${record.pid}`;
    const retained = state.copiedTracePaths.get(tracePath);
    let sourceSize: number;
    try {
      sourceSize = (await stat(tracePath)).size;
    } catch (error) {
      if (retained !== undefined) continue;
      observeEvent(
        OBSERVER_ORIGIN,
        operationId,
        'retain_eof_tap_trace',
        'error',
        {
          source_pid: record.pid,
          error_type: error instanceof Error ? error.name : typeof error,
        }
      );
      continue;
    }
    if (retained?.size === sourceSize) continue;

    try {
      await copyFile(tracePath, destination);
      state.copiedTracePaths.set(tracePath, {
        destination,
        size: sourceSize,
      });
      observeEvent(
        OBSERVER_ORIGIN,
        operationId,
        'retain_eof_tap_trace',
        'complete',
        { source_pid: record.pid, trace_bytes: sourceSize }
      );
    } catch (error) {
      observeEvent(
        OBSERVER_ORIGIN,
        operationId,
        'retain_eof_tap_trace',
        'error',
        {
          source_pid: record.pid,
          error_type: error instanceof Error ? error.name : typeof error,
        }
      );
    }
  }
}

async function runReadOnlyCommand(
  program: string,
  args: readonly string[],
  directory: string,
  label: string
): Promise<{
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
}> {
  const stdoutPath = join(directory, `${label}.stdout.txt`);
  const stderrPath = join(directory, `${label}.stderr.txt`);
  const spawned = (() => {
    try {
      return {
        child: Bun.spawn([program, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        }),
        error: undefined,
      };
    } catch (error) {
      return { child: undefined, error };
    }
  })();
  if (spawned.child === undefined) {
    await writeJson(join(directory, `${label}.error.json`), {
      error_type:
        spawned.error instanceof Error
          ? spawned.error.name
          : typeof spawned.error,
    });
    return { exitCode: undefined, timedOut: false };
  }
  const child = spawned.child;

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || typeof stdout === 'number') {
    throw new Error(`${program} did not expose a piped stdout stream`);
  }
  if (stderr === null || typeof stderr === 'number') {
    throw new Error(`${program} did not expose a piped stderr stream`);
  }

  const drainStdout = Bun.write(stdoutPath, stdout);
  const drainStderr = Bun.write(stderrPath, stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, SNAPSHOT_COMMAND_TIMEOUT_MS);
  const exitCode = await child.exited;
  clearTimeout(timer);
  await Promise.all([drainStdout, drainStderr]);
  return { exitCode, timedOut };
}

async function takeSnapshot(
  paths: RunPaths,
  operation: TraceRecord,
  records: readonly TraceRecord[],
  deadlineMs: number
): Promise<SnapshotReceipt> {
  const observedAfterMs = Math.max(0, Date.now() - operation.wall_clock_ms);
  const directory = join(
    paths.snapshots,
    `${operation.stage.replaceAll(/[^a-z0-9]+/gi, '-')}-${operation.pid}-${operation.sequence}`
  );
  await mkdir(directory);
  const pids = ownedPids(operation, records);

  await Promise.all(
    pids.map(async (pid) => {
      const pidDirectory = join(directory, String(pid));
      await mkdir(pidDirectory);
      const ps = runReadOnlyCommand(
        'ps',
        [
          '-o',
          'pid=,ppid=,state=,etime=,time=,pcpu=,pmem=,command=',
          '-p',
          String(pid),
        ],
        pidDirectory,
        'ps'
      );
      const lsof = runReadOnlyCommand(
        'lsof',
        ['-nP', '-p', String(pid)],
        pidDirectory,
        'lsof'
      );
      const sample =
        process.platform === 'darwin'
          ? runReadOnlyCommand(
              'sample',
              [String(pid), '1', '-file', join(pidDirectory, 'sample.txt')],
              pidDirectory,
              'sample'
            )
          : Promise.resolve(undefined);
      const [psResult, lsofResult, sampleResult] = await Promise.all([
        ps,
        lsof,
        sample,
      ]);
      const commands: Record<string, unknown> = {
        ps: psResult,
        lsof: lsofResult,
      };
      if (sampleResult !== undefined) commands['sample'] = sampleResult;
      await writeJson(join(pidDirectory, 'commands.json'), commands);
    })
  );

  const receipt: SnapshotReceipt = {
    operationId: operation.operation_id,
    stage: operation.stage,
    deadlineMs,
    observedAfterMs,
    pids,
    directory,
  };
  await writeJson(join(directory, 'snapshot.json'), receipt);
  observeEvent(
    OBSERVER_ORIGIN,
    `snapshot-${operation.operation_id}`,
    'deadline_snapshot',
    'complete',
    {
      deadline_ms: deadlineMs,
      observed_after_ms: observedAfterMs,
      source_pid: operation.pid,
    }
  );
  return receipt;
}

function snapshotDeadline(operation: TraceRecord): number | undefined {
  if (
    operation.origin === 'protocol-test' &&
    operation.stage === 'stamp_bundle_test'
  ) {
    return 4_000;
  }
  if (
    operation.origin === 'inventory-test' &&
    (operation.stage === 'before_each_hook' ||
      operation.stage === 'after_each_hook')
  ) {
    return 8_000;
  }
  return undefined;
}

async function monitorCycle(
  paths: RunPaths,
  state: MonitorState
): Promise<void> {
  const now = performance.now();
  if (now >= state.nextHeartbeatMs) {
    const heartbeatLatenessMs = now - state.nextHeartbeatMs;
    state.nextHeartbeatMs = now + 250;
    observeEvent(
      OBSERVER_ORIGIN,
      'observer-heartbeat',
      'observer_heartbeat',
      'complete',
      { heartbeat_lateness_ms: heartbeatLatenessMs }
    );
  }

  const records = await readTraceRecords(paths.events);
  await retainEofTraces(paths, state, records);
  for (const operation of outstandingOperations(records)) {
    if (
      operation.origin === 'full-suite-observer-self-test' &&
      operation.stage === 'self_test_pending_checkpoint' &&
      !state.capturedSelfTestOperations.has(operation.operation_id)
    ) {
      state.capturedSelfTestOperations.add(operation.operation_id);
      observeEvent(
        OBSERVER_ORIGIN,
        `self-test-pending-${operation.operation_id}`,
        'self_test_pending_capture',
        'complete',
        {
          observed_pending_operation_id: operation.operation_id,
          observed_pid: operation.pid,
        }
      );
    }

    const deadlineMs = snapshotDeadline(operation);
    if (
      deadlineMs === undefined ||
      state.capturedOperations.has(operation.operation_id) ||
      Date.now() - operation.wall_clock_ms < deadlineMs
    ) {
      continue;
    }
    state.capturedOperations.add(operation.operation_id);
    state.snapshots.push(
      await takeSnapshot(paths, operation, records, deadlineMs)
    );
  }
}

async function processTable(): Promise<Array<{ pid: number; ppid: number }>> {
  const child = Bun.spawn(['ps', '-axo', 'pid=,ppid='], {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  const stdout = child.stdout;
  if (stdout === null || typeof stdout === 'number') return [];
  const [text] = await Promise.all([new Response(stdout).text(), child.exited]);
  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

async function stopOwnedTree(rootPid: number): Promise<number[]> {
  const table = await processTable();
  const pids = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  const owned = [...pids].sort((left, right) => right - left);
  for (const pid of owned) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It can exit between the table read and this signal.
    }
  }
  await sleep(1_000);
  for (const pid of owned) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // No process remains at this pid, or it was already reaped.
    }
  }
  return owned;
}

function suiteEnvironment(paths: RunPaths): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    RELIC_SUITE_OBSERVATION_DIR: paths.events,
    XDG_CONFIG_HOME: paths.xdgConfig,
  };
  delete environment['RELIC_METADATA_CACHE'];
  return environment;
}

async function runObservedCommand(
  paths: RunPaths,
  command: readonly string[],
  environment: Record<string, string | undefined>,
  commandName: string
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd: ROOT,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  observeEvent(
    OBSERVER_ORIGIN,
    `${commandName}-spawn`,
    'outer_command_spawn',
    'complete',
    { owned_child_pid: child.pid }
  );

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || typeof stdout === 'number') {
    throw new Error('Observed command did not expose a piped stdout stream');
  }
  if (stderr === null || typeof stderr === 'number') {
    throw new Error('Observed command did not expose a piped stderr stream');
  }
  const drainStdout = Bun.write(
    join(paths.out, `${commandName}.stdout.log`),
    stdout
  );
  const drainStderr = Bun.write(
    join(paths.out, `${commandName}.stderr.log`),
    stderr
  );

  let exitCode: number | undefined;
  void child.exited.then((code) => {
    exitCode = code;
  });
  let stoppedAtCeiling = false;
  const startedMonotonicMs = performance.now();
  const state: MonitorState = {
    nextHeartbeatMs: startedMonotonicMs + 250,
    copiedTracePaths: new Map(),
    snapshots: [],
    capturedOperations: new Set(),
    capturedSelfTestOperations: new Set(),
  };

  while (exitCode === undefined) {
    await monitorCycle(paths, state);
    if (performance.now() - startedMonotonicMs >= OUTER_CEILING_MS) {
      stoppedAtCeiling = true;
      const stoppedPids = await stopOwnedTree(child.pid);
      observeEvent(
        OBSERVER_ORIGIN,
        `${commandName}-ceiling`,
        'outer_diagnostic_ceiling',
        'error',
        { ceiling_ms: OUTER_CEILING_MS, stopped_pid_count: stoppedPids.length }
      );
      break;
    }
    await sleep(POLL_MS);
  }

  if (exitCode === undefined) {
    await Promise.race([
      child.exited.then((code) => (exitCode = code)),
      sleep(10_000),
    ]);
  }
  await Promise.all([drainStdout, drainStderr]);
  await monitorCycle(paths, state);
  await writeJson(join(paths.out, `${commandName}.observer.json`), {
    command,
    exit_code: exitCode ?? null,
    stopped_at_ceiling: stoppedAtCeiling,
    snapshots: state.snapshots,
    retained_eof_traces: [...state.copiedTracePaths.entries()].map(
      ([source, retained]) => ({
        source,
        destination: retained.destination,
        bytes: retained.size,
      })
    ),
  });

  return { exitCode, stoppedAtCeiling };
}

async function runSelfTest(requestedOut: string | undefined): Promise<void> {
  const paths = await prepareRunPaths(
    requestedOut,
    'relic-suite-observer-self-test'
  );
  const environment = suiteEnvironment(paths);
  const helper = new URL('./full-suite-observation.ts', import.meta.url).href;
  const checkpoint = 'self_test_pending_checkpoint';
  const source = [
    `import { observeBegin, observeComplete } from ${JSON.stringify(helper)};`,
    `const operation = observeBegin('full-suite-observer-self-test', ${JSON.stringify(checkpoint)});`,
    'const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, 500); await promise;',
    'observeComplete(operation);',
  ].join('\n');

  const result = await runObservedCommand(
    paths,
    ['bun', '--eval', source],
    environment,
    'self-test'
  );
  const records = await readTraceRecords(paths.events);
  const pending = records.find(
    (record) =>
      record.origin === 'full-suite-observer-self-test' &&
      record.stage === checkpoint &&
      record.event === 'begin' &&
      record.pid > 0
  );
  const captured = records.find(
    (record) =>
      record.origin === OBSERVER_ORIGIN &&
      record.stage === 'self_test_pending_capture' &&
      record.event === 'complete' &&
      numberField(record, 'observed_pid') === pending?.pid
  );
  const observedOperationId =
    captured === undefined
      ? null
      : (stringField(captured, 'observed_pending_operation_id') ?? null);
  const observedPid =
    captured === undefined
      ? null
      : (numberField(captured, 'observed_pid') ?? null);
  await writeJson(join(paths.out, 'self-test-receipt.json'), {
    checkpoint,
    observed_pending_operation_id: observedOperationId,
    observed_pid: observedPid,
    source_pending_operation_id: pending?.operation_id ?? null,
    source_pid: pending?.pid ?? null,
    exit_code: result.exitCode ?? null,
  });
  await rm(paths.xdgConfig, { recursive: true, force: true });

  if (
    result.exitCode !== 0 ||
    pending === undefined ||
    captured === undefined ||
    observedOperationId !== pending.operation_id ||
    observedPid !== pending.pid
  ) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`SELF_TEST_OK pid=${pending.pid} out=${paths.out}\n`);
}

async function runVerify(requestedOut: string): Promise<void> {
  const paths = await prepareRunPaths(requestedOut, 'relic-suite-observation');
  const environment = suiteEnvironment(paths);
  const command = ['bun', 'run', 'verify'];
  await writeJson(join(paths.out, 'command.json'), {
    command,
    cwd: ROOT,
    bun_version: Bun.version,
    observer_pid: process.pid,
    environment: {
      RELIC_SUITE_OBSERVATION_DIR: paths.events,
      XDG_CONFIG_HOME: paths.xdgConfig,
      RELIC_METADATA_CACHE: 'unset',
    },
  });

  const result = await runObservedCommand(
    paths,
    command,
    environment,
    'verify'
  );
  await writeJson(join(paths.out, 'receipt.json'), {
    command,
    exit_code: result.exitCode ?? null,
    observer_exit_code: result.stoppedAtCeiling
      ? 124
      : (result.exitCode ?? 124),
    stopped_at_ceiling: result.stoppedAtCeiling,
    original_suite_output: {
      stdout: join(paths.out, 'verify.stdout.log'),
      stderr: join(paths.out, 'verify.stderr.log'),
    },
  });
  await rm(paths.xdgConfig, { recursive: true, force: true });
  process.exitCode = result.stoppedAtCeiling ? 124 : (result.exitCode ?? 124);
}

const args = parseArguments();
if (args.selfTest) {
  await runSelfTest(args.out);
} else {
  await runVerify(args.out as string);
}
