/**
 * Controlled parent-history probe for the real built Node MCP bundle.
 *
 * The target producer deliberately follows otio-path.ts callMcp: Bun spawns
 * Node, constructs one line-delimited tools/call packet, writes it as a string,
 * then ends stdin immediately. Context arms only alter parent process history
 * before that untouched producer runs.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { decodeKey, deriveCommentKey, encryptComment } from '@relic/format';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { loadPublishState } from '../src/state.ts';

const MAX_TRIALS = 16;
const TARGET_DEADLINE_MS = 45_000;
const NON_TARGET_PHASE_TIMEOUT_MS = 30_000;
const NODE_COMMAND = 'node';
const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

type ContextName =
  | 'none'
  | 'helper'
  | 'browser-retired'
  | 'browser-retired-then-helper';

type TrialStatus = 'running' | 'pass' | 'fixture_failure' | 'discrepancy';

interface Options {
  readonly context: ContextName;
  readonly count: number;
  readonly seed: string;
  readonly corruptNonce: boolean;
  readonly out?: string | undefined;
}

interface ErrorReceipt {
  name: string;
  message: string;
  code?: string | number | undefined;
  errno?: string | number | undefined;
  syscall?: string | undefined;
  stack?: string | undefined;
}
type NonTargetPhaseScope = 'bootstrap' | 'fixture' | 'context' | 'finalization';

type NonTargetPhaseOutcome = 'entered' | 'fulfilled' | 'rejected' | 'timed_out';

interface ContextProcessReceipt {
  pid: number | null;
  exit_code: number | null;
  signal_code: string | number | null;
  killed: boolean | null;
  kill_attempted: boolean;
  kill_result: boolean | null;
  kill_error?: ErrorReceipt | undefined;
}

interface KillableContextProcess {
  readonly pid: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | number | null;
  readonly killed?: boolean;
  kill(signal?: string | number): unknown;
}

interface ContextProcessOwnership {
  readonly receipt: ContextProcessReceipt;
  readonly child: WeakRef<KillableContextProcess>;
}

interface NonTargetPhaseReceipt {
  readonly name: string;
  readonly scope: NonTargetPhaseScope;
  readonly trial_ordinal: number | null;
  readonly started_at: number;
  elapsed_ms: number | null;
  outcome: NonTargetPhaseOutcome;
  process?: ContextProcessReceipt | undefined;
  classification?: 'probe_fixture' | 'probe_fixture_unclassified' | undefined;
  error?: ErrorReceipt | undefined;
}

class NonTargetPhaseTimeoutError extends Error {
  readonly phase: string;

  constructor(phase: string, timeoutMs: number) {
    super(`${phase} did not settle within ${timeoutMs}ms`);
    this.name = 'NonTargetPhaseTimeoutError';
    this.phase = phase;
  }
}

interface BytesReceipt {
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}

interface TextReceipt extends BytesReceipt {
  readonly text: string;
}

interface InputOutcomeReceipt {
  readonly operation: 'stdin.write' | 'stdin.end';
  readonly settlement: 'fulfilled' | 'rejected';
  readonly value_type?: string | undefined;
  readonly numeric_value?: number | undefined;
  readonly value?: string | number | boolean | null | undefined;
  readonly error?: ErrorReceipt | undefined;
  readonly error_like?: ErrorReceipt | undefined;
  readonly clean_numeric: boolean;
}

interface PendingMcpLoopbackReceipt {
  readonly callOrdinal: number;
  readonly tool: string;
  readonly relicId: string | null;
  readonly pid: number;
  readonly method: string;
  readonly pathname: string;
  readonly event: 'entry' | 'response';
  readonly status: number | null;
}

interface McpLoopbackReceipt extends PendingMcpLoopbackReceipt {
  readonly requestHash: string;
}

interface ActiveMcpCall {
  readonly callOrdinal: number;
  readonly tool: string;
  readonly relicId: string | null;
  readonly pid: number;
  readonly pendingReceipts: PendingMcpLoopbackReceipt[];
}

interface CapturedMail {
  readonly kind: 'link' | 'mail';
  readonly to: string;
  readonly mail?: OutboundMail | undefined;
  readonly link?: string | undefined;
}

interface FixtureRuntime {
  readonly store: MemoryStore;
  readonly storage: MemoryStorage;
  readonly app: RelicApp;
  readonly mails: CapturedMail[];
}

interface FixtureReceipt {
  readonly trial: number;
  readonly directory: string;
  readonly state_path: string;
  readonly fixture_path: string;
  readonly expected_nonce: string;
  readonly stored_nonce: string;
  readonly corrupt_nonce: boolean;
  relic_id: string | null;
  publish_version: number | null;
  local_state_present: boolean;
  seed_status: number | null;
  ciphertext: BytesReceipt | null;
  stored_comment_count: number | null;
  mails_after_seed: number | null;
}

interface Fixture extends FixtureRuntime {
  readonly receipt: FixtureReceipt;
  readonly directory: string;
  readonly statePath: string;
  readonly relicId: string;
  readonly expectedNonce: string;
}

interface HelperReceipt {
  readonly nonce: string;
  readonly input: BytesReceipt;
  readonly process: ContextProcessReceipt;
  stdout?: TextReceipt | undefined;
  stderr?: TextReceipt | undefined;
  exit?: number | undefined;
  validated: boolean;
}

interface BrowserCloseReceipt {
  observed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  observed_at: number | null;
}

interface BrowserReceipt {
  readonly requested_path: string | null;
  executable: string | null;
  readonly process: ContextProcessReceipt;
  product: string | null;
  browser_close_request: 'fulfilled' | 'rejected' | 'not_attempted';
  browser_close_error?: ErrorReceipt | undefined;
  sigkill_sent: boolean | null;
  cdp_disposed: boolean;
  profile_removed: boolean;
  reap_sigkill_sent: boolean | null;
  reap_error?: ErrorReceipt | undefined;
  readonly close: BrowserCloseReceipt;
}

interface ContextReceipt {
  readonly name: ContextName;
  status: 'ready' | 'fixture_failure';
  helper?: HelperReceipt | undefined;
  browser?: BrowserReceipt | undefined;
  failure?: ErrorReceipt | undefined;
}

interface ContextArm {
  readonly receipt: ContextReceipt;
  reap(): void;
}

interface ProtocolReceipt {
  readonly line_count: number;
  readonly last_line?: string | undefined;
  readonly response?: Record<string, unknown> | undefined;
  readonly parse_error?: ErrorReceipt | undefined;
}

interface TargetReceipt {
  readonly command: readonly string[];
  readonly cwd: string;
  pid: number | null;
  readonly deadline_ms: number;
  packet?: BytesReceipt | undefined;
  input_outcomes?: readonly InputOutcomeReceipt[] | undefined;
  stdout?: TextReceipt | undefined;
  stderr?: TextReceipt | undefined;
  exit?: number | undefined;
  signal_code?: unknown;
  protocol?: ProtocolReceipt | undefined;
  loopback_receipts: readonly McpLoopbackReceipt[];
  collection_error?: ErrorReceipt | undefined;
  ledger_error?: ErrorReceipt | undefined;
  mail_count_after_target?: number | undefined;
}

interface TrialReceipt {
  readonly ordinal: number;
  readonly started_at: number;
  finished_at?: number | undefined;
  status: TrialStatus;
  fixture?: FixtureReceipt | undefined;
  context?: ContextReceipt | undefined;
  target?: TargetReceipt | undefined;
  discrepancy?: ErrorReceipt | undefined;
}

interface NodeMetadata {
  readonly command: string;
  readonly resolved_path: string;
  readonly version: string | null;
  readonly version_exit: number | null;
  readonly version_stderr: string | null;
}

function usage(message?: string): never {
  const prefix = message === undefined ? '' : `${message}\n`;
  throw new Error(
    `${prefix}usage: mise exec -- bun packages/relic-mcp/test/stdio-mcp-boundary-path.ts ` +
      '--context=none|helper|browser-retired|browser-retired-then-helper ' +
      '--count=1..16 --seed=otio-mcp-boundary-v1 [--corrupt-nonce] [--out=<directory>]'
  );
}

function parseOptions(argv: readonly string[]): Options {
  let context: ContextName | undefined;
  let count: number | undefined;
  let seed = 'otio-mcp-boundary-v1';
  let corruptNonce = false;
  let out: string | undefined;

  for (const arg of argv) {
    if (arg === '--corrupt-nonce') {
      corruptNonce = true;
      continue;
    }
    if (arg.startsWith('--context=')) {
      const value = arg.slice('--context='.length);
      if (
        value === 'none' ||
        value === 'helper' ||
        value === 'browser-retired' ||
        value === 'browser-retired-then-helper'
      ) {
        context = value;
        continue;
      }
      usage(`unsupported context ${JSON.stringify(value)}`);
    }
    if (arg.startsWith('--count=')) {
      const value = Number(arg.slice('--count='.length));
      if (Number.isInteger(value) && value >= 1 && value <= MAX_TRIALS) {
        count = value;
        continue;
      }
      usage(`count must be an integer from 1 through ${MAX_TRIALS}`);
    }
    if (arg.startsWith('--seed=')) {
      const value = arg.slice('--seed='.length);
      if (value.length > 0) {
        seed = value;
        continue;
      }
      usage('seed must not be empty');
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (value.length > 0) {
        out = value;
        continue;
      }
      usage('out must name a directory');
    }
    usage(`unknown argument ${JSON.stringify(arg)}`);
  }

  if (context === undefined) usage('context is required');
  if (count === undefined) usage('count is required');
  if (corruptNonce && (context !== 'none' || count !== 1)) {
    usage('--corrupt-nonce requires --context=none --count=1');
  }
  return {
    context,
    count,
    seed,
    corruptNonce,
    ...(out === undefined ? {} : { out }),
  };
}

function errorReceipt(error: unknown): ErrorReceipt {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const receipt: ErrorReceipt = {
    name,
    message,
    ...(error instanceof Error && error.stack !== undefined
      ? { stack: error.stack }
      : {}),
  };

  if (error !== null && typeof error === 'object') {
    const details = error as {
      readonly code?: unknown;
      readonly errno?: unknown;
      readonly syscall?: unknown;
    };
    if (typeof details.code === 'string' || typeof details.code === 'number') {
      receipt.code = details.code;
    }
    if (
      typeof details.errno === 'string' ||
      typeof details.errno === 'number'
    ) {
      receipt.errno = details.errno;
    }
    if (typeof details.syscall === 'string') {
      receipt.syscall = details.syscall;
    }
  }
  return receipt;
}

function errorLikeReceipt(value: unknown): ErrorReceipt | undefined {
  if (value instanceof Error) return errorReceipt(value);
  if (value === null || typeof value !== 'object') return undefined;

  const candidate = value as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly code?: unknown;
    readonly errno?: unknown;
    readonly syscall?: unknown;
  };
  const hasMessage = typeof candidate.message === 'string';
  const hasErrorField =
    typeof candidate.name === 'string' ||
    typeof candidate.code === 'string' ||
    typeof candidate.code === 'number' ||
    typeof candidate.errno === 'string' ||
    typeof candidate.errno === 'number' ||
    typeof candidate.syscall === 'string';
  return hasMessage && hasErrorField ? errorReceipt(value) : undefined;
}

function bytesReceipt(value: Uint8Array): BytesReceipt {
  const bytes = Buffer.from(value);
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
}

function textReceipt(value: string): TextReceipt {
  return { text: value, ...bytesReceipt(Buffer.from(value, 'utf8')) };
}

function nonceFor(seed: string, ordinal: number, kind: string): string {
  return createHash('sha256')
    .update(`${seed}\u0000${ordinal}\u0000${kind}`)
    .digest('hex');
}

function describeInputOutcome(
  operation: InputOutcomeReceipt['operation'],
  outcome: PromiseSettledResult<unknown>
): InputOutcomeReceipt {
  if (outcome.status === 'rejected') {
    return {
      operation,
      settlement: 'rejected',
      error: errorReceipt(outcome.reason),
      clean_numeric: false,
    };
  }

  const errorLike = errorLikeReceipt(outcome.value);
  const numeric =
    typeof outcome.value === 'number' && Number.isFinite(outcome.value);
  const primitive =
    outcome.value === null ||
    typeof outcome.value === 'string' ||
    typeof outcome.value === 'number' ||
    typeof outcome.value === 'boolean'
      ? outcome.value
      : undefined;
  return {
    operation,
    settlement: 'fulfilled',
    value_type: typeof outcome.value,
    ...(numeric ? { numeric_value: outcome.value as number } : {}),
    ...(primitive !== undefined || outcome.value === null
      ? { value: primitive ?? null }
      : {}),
    ...(errorLike === undefined ? {} : { error_like: errorLike }),
    clean_numeric: numeric && errorLike === undefined,
  };
}

function parseProtocol(stdout: string): ProtocolReceipt {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) return { line_count: 0 };

  try {
    const parsed = JSON.parse(lastLine) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('last JSON-RPC line is not an object');
    }
    return {
      line_count: lines.length,
      last_line: lastLine,
      response: parsed as Record<string, unknown>,
    };
  } catch (error) {
    return {
      line_count: lines.length,
      last_line: lastLine,
      parse_error: errorReceipt(error),
    };
  }
}

function recordMcpLoopbackReceipt(
  method: string,
  pathname: string,
  event: PendingMcpLoopbackReceipt['event'],
  status: number | null
): void {
  const call = activeMcpCall;
  if (call === undefined) return;
  call.pendingReceipts.push({
    callOrdinal: call.callOrdinal,
    tool: call.tool,
    relicId: call.relicId,
    pid: call.pid,
    method,
    pathname,
    event,
    status,
  });
}

function persistMcpLoopbackReceipts(
  call: ActiveMcpCall,
  packet: string
): readonly McpLoopbackReceipt[] {
  const requestHash = bytesReceipt(Buffer.from(packet, 'utf8')).sha256;
  const receipts = call.pendingReceipts.map((receipt) => ({
    ...receipt,
    requestHash,
  }));
  mcpLoopbackReceipts.push(...receipts);
  return receipts;
}

const options = parseOptions(process.argv.slice(2));
const runId = `${Date.now()}-${randomUUID()}`;
const scratch =
  options.out === undefined
    ? mkdtempSync(join(tmpdir(), 'relic-stdio-mcp-boundary-'))
    : resolve(options.out);
if (options.out !== undefined) mkdirSync(scratch, { recursive: true });
const witnessPath = join(scratch, `stdio-mcp-boundary-witness-${runId}.json`);
const checkpointStem = join(scratch, `stdio-mcp-boundary-checkpoint-${runId}`);
const previousPublishState = process.env['RELIC_PUBLISH_STATE'];
const helperChildren = new Set<ChildProcess>();
const mcpLoopbackReceipts: McpLoopbackReceipt[] = [];
const trials: TrialReceipt[] = [];
const phaseHistory: NonTargetPhaseReceipt[] = [];
const checkpointPaths: string[] = [];
const finalizationFailures: NonTargetPhaseReceipt[] = [];
const startedAt = Date.now();
let activeFixture: FixtureRuntime | undefined;
let activeMcpCall: ActiveMcpCall | undefined;
let nextMcpCallOrdinal = 0;
let nextCheckpointOrdinal = 0;
let inProgressTrial: TrialReceipt | undefined;
let lastKnownPhase: NonTargetPhaseReceipt | undefined;
let bundle: BytesReceipt | null = null;
let fatal: ErrorReceipt | undefined;
let runtimeNode: NodeMetadata = {
  command: NODE_COMMAND,
  resolved_path: Bun.which(NODE_COMMAND) ?? NODE_COMMAND,
  version: null,
  version_exit: null,
  version_stderr: null,
};

const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return handleLoopback(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
function emptyContextProcessReceipt(): ContextProcessReceipt {
  return {
    pid: null,
    exit_code: null,
    signal_code: null,
    killed: null,
    kill_attempted: false,
    kill_result: null,
  };
}

function refreshContextProcess(owner: ContextProcessOwnership): void {
  const child = owner.child.deref();
  if (child === undefined) return;

  owner.receipt.pid = child.pid;
  owner.receipt.exit_code =
    typeof child.exitCode === 'number' ? child.exitCode : null;
  owner.receipt.signal_code =
    typeof child.signalCode === 'string' || typeof child.signalCode === 'number'
      ? child.signalCode
      : null;
  owner.receipt.killed =
    typeof child.killed === 'boolean' ? child.killed : null;
}

function snapshotContextProcess(
  owner: ContextProcessOwnership | undefined
): ContextProcessReceipt | undefined {
  if (owner === undefined) return undefined;
  refreshContextProcess(owner);
  return {
    ...owner.receipt,
    ...(owner.receipt.kill_error === undefined
      ? {}
      : { kill_error: owner.receipt.kill_error }),
  };
}

function ownContextProcess(
  child: unknown,
  receipt: ContextProcessReceipt
): ContextProcessOwnership {
  const process = child as KillableContextProcess;
  const owner: ContextProcessOwnership = {
    receipt,
    child: new WeakRef(process),
  };
  refreshContextProcess(owner);
  return owner;
}

function killOwnedContextProcess(
  owner: ContextProcessOwnership | undefined
): void {
  if (owner === undefined) return;
  const child = owner.child.deref();
  refreshContextProcess(owner);
  owner.receipt.kill_attempted = true;
  if (child === undefined) return;

  try {
    const result = child.kill('SIGKILL');
    owner.receipt.kill_result = typeof result === 'boolean' ? result : null;
  } catch (error) {
    owner.receipt.kill_error = errorReceipt(error);
  }
  refreshContextProcess(owner);
}

function phaseClassification(
  scope: NonTargetPhaseScope
): NonTargetPhaseReceipt['classification'] {
  return scope === 'context' || scope === 'fixture'
    ? 'probe_fixture'
    : 'probe_fixture_unclassified';
}

function witnessStatus(): 'RUNNING' | 'PASS' | 'FAIL' {
  if (
    fatal !== undefined ||
    finalizationFailures.length > 0 ||
    phaseHistory.some((phase) => phase.outcome === 'timed_out') ||
    trials.some((trial) => trial.status !== 'pass') ||
    (inProgressTrial !== undefined &&
      inProgressTrial.status !== 'running' &&
      inProgressTrial.status !== 'pass')
  ) {
    return 'FAIL';
  }
  if (lastKnownPhase?.outcome === 'entered') return 'RUNNING';
  if (
    inProgressTrial === undefined &&
    trials.length === options.count &&
    trials.every((trial) => trial.status === 'pass')
  ) {
    return 'PASS';
  }
  return 'RUNNING';
}

function witnessPayload(
  recordKind: 'checkpoint' | 'final',
  reason: string,
  recordPath: string,
  sequence: number | null
): Record<string, unknown> {
  return {
    kind: 'stdio-mcp-boundary-path-v2',
    record_kind: recordKind,
    status: witnessStatus(),
    options,
    started_at: startedAt,
    recorded_at: Date.now(),
    scratch,
    witness_path: witnessPath,
    record_path: recordPath,
    ...(sequence === null ? {} : { checkpoint_sequence: sequence }),
    checkpoint_reason: reason,
    diagnostic_regime: {
      checkpoint_io_enabled: true,
      checkpoint_io_changes_parent_fd_history: true,
      all_green_is_nondiscriminating: true,
      note: 'Checkpoint I/O occurs before non-target phases and changes the parent FD history. Results from this SHA are a changed diagnostic regime; all-green results are nondiscriminating.',
    },
    bundle: {
      path: bundlePath,
      sha256: bundle?.sha256 ?? null,
      bytes: bundle?.bytes ?? null,
    },
    runtimes: {
      process_versions: process.versions,
      bun_version: Bun.version,
      node: runtimeNode,
    },
    metadata: {
      optional: true,
      node_status:
        runtimeNode.version === null
          ? recordKind === 'final'
            ? 'unavailable'
            : 'pending'
          : 'captured',
    },
    origin,
    phase_history: phaseHistory,
    last_known_phase: lastKnownPhase ?? null,
    trials,
    in_progress_trial: inProgressTrial ?? null,
    all_loopback_receipts: mcpLoopbackReceipts,
    checkpoint_files: [
      ...checkpointPaths,
      ...(recordKind === 'checkpoint' ? [recordPath] : []),
    ],
    finalization_failures: finalizationFailures,
    ...(fatal === undefined ? {} : { fatal }),
  };
}

function writeImmutableWitness(
  path: string,
  payload: Record<string, unknown>
): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  renameSync(temporaryPath, path);
}

function persistCheckpoint(reason: string): string {
  const sequence = ++nextCheckpointOrdinal;
  const path = `${checkpointStem}-${String(sequence).padStart(4, '0')}.json`;
  writeImmutableWitness(
    path,
    witnessPayload('checkpoint', reason, path, sequence)
  );
  checkpointPaths.push(path);
  return path;
}

function persistFinalWitness(reason: string): void {
  writeImmutableWitness(
    witnessPath,
    witnessPayload('final', reason, witnessPath, null)
  );
}

function isNonTargetPhaseTimeout(
  error: unknown
): error is NonTargetPhaseTimeoutError {
  return error instanceof NonTargetPhaseTimeoutError;
}

function runNonTargetPhase<T>(
  scope: NonTargetPhaseScope,
  name: string,
  operation: () => T | Promise<T>,
  owner?: ContextProcessOwnership
): Promise<T> {
  const phase: NonTargetPhaseReceipt = {
    name,
    scope,
    trial_ordinal: inProgressTrial?.ordinal ?? null,
    started_at: Date.now(),
    elapsed_ms: null,
    outcome: 'entered',
    ...(owner === undefined ? {} : { process: snapshotContextProcess(owner) }),
  };
  phaseHistory.push(phase);
  lastKnownPhase = phase;
  persistCheckpoint(`${scope}:${name}:entered`);

  const {
    promise,
    resolve: resolvePhase,
    reject: rejectPhase,
  } = Promise.withResolvers<T>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function complete(value: T): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    phase.elapsed_ms = Date.now() - phase.started_at;
    phase.outcome = 'fulfilled';
    phase.process = snapshotContextProcess(owner);
    resolvePhase(value);
  }

  function fail(
    error: unknown,
    outcome: Extract<NonTargetPhaseOutcome, 'rejected' | 'timed_out'>
  ): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    phase.elapsed_ms = Date.now() - phase.started_at;
    phase.outcome = outcome;
    phase.error = errorReceipt(error);
    phase.classification = phaseClassification(scope);
    phase.process = snapshotContextProcess(owner);
    if (scope === 'finalization') finalizationFailures.push(phase);
    persistCheckpoint(`${scope}:${name}:${outcome}:before_cleanup`);
    if (outcome === 'timed_out') {
      killOwnedContextProcess(owner);
      phase.process = snapshotContextProcess(owner);
      persistCheckpoint(`${scope}:${name}:${outcome}:after_sigkill`);
    }
    rejectPhase(error);
  }

  timer = setTimeout(() => {
    fail(
      new NonTargetPhaseTimeoutError(name, NON_TARGET_PHASE_TIMEOUT_MS),
      'timed_out'
    );
  }, NON_TARGET_PHASE_TIMEOUT_MS);

  try {
    const result = operation();
    Promise.resolve(result).then(
      (value) => complete(value as T),
      (error) => fail(error, 'rejected')
    );
  } catch (error) {
    fail(error, 'rejected');
  }
  return promise;
}
function persistDirectPhaseFailure(
  scope: NonTargetPhaseScope,
  name: string,
  error: unknown,
  owner?: ContextProcessOwnership
): void {
  const phase: NonTargetPhaseReceipt = {
    name,
    scope,
    trial_ordinal: inProgressTrial?.ordinal ?? null,
    started_at: Date.now(),
    elapsed_ms: 0,
    outcome: 'rejected',
    classification: phaseClassification(scope),
    ...(owner === undefined ? {} : { process: snapshotContextProcess(owner) }),
    error: errorReceipt(error),
  };
  phaseHistory.push(phase);
  lastKnownPhase = phase;
  if (scope === 'finalization') finalizationFailures.push(phase);
  persistCheckpoint(`${scope}:${name}:rejected:before_cleanup`);
}

async function handleLoopback(request: Request): Promise<Response> {
  const fixture = activeFixture;
  if (fixture === undefined) return new Response('Not ready', { status: 503 });

  const url = new URL(request.url);
  assert.equal(
    url.hostname,
    '127.0.0.1',
    `non-loopback request reached the probe service: ${url.hostname}`
  );
  recordMcpLoopbackReceipt(request.method, url.pathname, 'entry', null);

  let response: Response;
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    fixture.storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
    response = new Response(null, { status: 200 });
  } else if (
    url.pathname.startsWith('/__storage/o/') &&
    request.method === 'GET'
  ) {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await fixture.storage.read(relicId);
    response =
      bytes === undefined
        ? new Response('Not found', { status: 404 })
        : new Response(Buffer.from(bytes), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
  } else {
    if (url.pathname.endsWith('/mint')) {
      throw new Error('version:"*" must not issue a current-version mint');
    }
    response = await fixture.app.fetch(request);
  }

  recordMcpLoopbackReceipt(
    request.method,
    url.pathname,
    'response',
    response.status
  );
  return response;
}

async function createFixture(ordinal: number): Promise<Fixture> {
  const directory = join(scratch, `trial-${String(ordinal).padStart(2, '0')}`);
  const statePath = join(directory, 'publish-state.json');
  const fixturePath = join(directory, 'comment-source.md');
  const expectedNonce = nonceFor(options.seed, ordinal, 'expected');
  const storedNonce = options.corruptNonce
    ? nonceFor(options.seed, ordinal, 'wrong')
    : expectedNonce;
  const receipt: FixtureReceipt = {
    trial: ordinal,
    directory,
    state_path: statePath,
    fixture_path: fixturePath,
    expected_nonce: expectedNonce,
    stored_nonce: storedNonce,
    corrupt_nonce: options.corruptNonce,
    relic_id: null,
    publish_version: null,
    local_state_present: false,
    seed_status: null,
    ciphertext: null,
    stored_comment_count: null,
    mails_after_seed: null,
  };
  if (inProgressTrial !== undefined) inProgressTrial.fixture = receipt;

  await runNonTargetPhase('fixture', 'fixture.mkdir', () =>
    mkdir(directory, { recursive: true })
  );
  await runNonTargetPhase('fixture', 'fixture.write_source', () =>
    writeFile(fixturePath, `# stdio MCP boundary trial ${ordinal}\n`)
  );

  const store = new MemoryStore();
  const mails: CapturedMail[] = [];
  const storage = new MemoryStorage(`${origin}/__storage`);
  const app = createApp({
    config: { serviceOrigin: origin },
    store,
    storage,
    mailer: {
      send: async (to, link) => {
        mails.push({ kind: 'link', to, link });
      },
      sendMail: async (to, mail) => {
        mails.push({ kind: 'mail', to, mail });
      },
    },
  });
  activeFixture = { store, storage, app, mails };
  process.env['RELIC_PUBLISH_STATE'] = statePath;

  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    fetch: globalThis.fetch,
    clientName: 'relic-mcp/stdio-mcp-boundary-path',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'stdio MCP boundary probe',
    }),
  };
  const published = await runNonTargetPhase('fixture', 'fixture.publish', () =>
    publish({ path: fixturePath, cover: false }, deps)
  );
  receipt.relic_id = published.relic_id;
  receipt.publish_version = published.version;

  const localState = await runNonTargetPhase(
    'fixture',
    'fixture.load_publish_state',
    () => loadPublishState(published.relic_id)
  );
  receipt.local_state_present = localState !== undefined;
  assert.ok(
    localState,
    'publish did not leave local state for the fresh child'
  );

  const commentKey = await runNonTargetPhase(
    'fixture',
    'fixture.derive_comment_key',
    () => deriveCommentKey(decodeKey(localState.key))
  );
  const ciphertext = await runNonTargetPhase(
    'fixture',
    'fixture.encrypt_comment',
    () =>
      encryptComment(commentKey, {
        body: storedNonce,
        display_name: 'stdio MCP boundary probe',
        anchor: null,
      })
  );
  receipt.ciphertext = bytesReceipt(Buffer.from(ciphertext, 'utf8'));

  const commentResponse = await runNonTargetPhase(
    'fixture',
    'fixture.seed_comment',
    () =>
      fetch(`${origin}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: localState.publish_token,
          ciphertext,
        }),
      })
  );
  receipt.seed_status = commentResponse.status;
  assert.equal(commentResponse.status, 201, 'encrypted comment seed failed');

  const storedRows = await runNonTargetPhase(
    'fixture',
    'fixture.list_comments',
    () => store.listComments(published.relic_id)
  );
  receipt.stored_comment_count = storedRows.length;
  assert.equal(storedRows.length, 1, 'comment seed did not create one row');
  assert.equal(storedRows[0]?.ciphertext, ciphertext);
  assert.notEqual(storedRows[0]?.ciphertext, storedNonce);
  assert.ok(!storedRows[0]?.ciphertext.includes(storedNonce));
  receipt.mails_after_seed = mails.length;
  assert.equal(mails.length, 0, 'fixture seed must not send captured mail');

  return {
    store,
    storage,
    app,
    mails,
    receipt,
    directory,
    statePath,
    relicId: published.relic_id,
    expectedNonce,
  };
}

async function runChild(
  cmd: string[],
  runOptions: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: Uint8Array;
  },
  processReceipt: ContextProcessReceipt
): Promise<{ stdout: Buffer; stderr: string; exit: number }> {
  const child = spawn(cmd[0] ?? '', cmd.slice(1), {
    cwd: runOptions.cwd,
    env: runOptions.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const owner = ownContextProcess(child, processReceipt);
  helperChildren.add(child);
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk));
  if (runOptions.input && child.stdin) {
    child.stdin.end(runOptions.input);
  } else {
    child.stdin?.end();
  }
  const {
    promise: close,
    resolve: resolveExit,
    reject: rejectExit,
  } = Promise.withResolvers<number>();
  child.once('error', (error) => {
    refreshContextProcess(owner);
    rejectExit(error);
  });
  child.once('close', (code, signal) => {
    processReceipt.exit_code = code;
    processReceipt.signal_code = signal;
    refreshContextProcess(owner);
    resolveExit(code ?? 1);
  });
  const exit = await runNonTargetPhase(
    'context',
    'helper.close',
    () =>
      close.finally(() => {
        helperChildren.delete(child);
      }),
    owner
  );
  return {
    stdout: Buffer.concat(chunks),
    stderr: Buffer.concat(errors).toString('utf8'),
    exit,
  };
}

const HELPER_SOURCE = String.raw`
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.once('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed.nonce !== 'string') {
    throw new Error('helper input omitted nonce');
  }
  process.stdout.write(JSON.stringify({ nonce: parsed.nonce }) + '\n');
});
process.stdin.resume();
`;

async function runHelper(
  ordinal: number,
  onReceipt?: (receipt: HelperReceipt) => void
): Promise<HelperReceipt> {
  const nonce = nonceFor(options.seed, ordinal, 'helper');
  const input = Buffer.from(`${JSON.stringify({ nonce })}\n`, 'utf8');
  const receipt: HelperReceipt = {
    nonce,
    input: bytesReceipt(input),
    process: emptyContextProcessReceipt(),
    validated: false,
  };
  onReceipt?.(receipt);
  const result = await runChild(
    [NODE_COMMAND, '-e', HELPER_SOURCE],
    {
      cwd: scratch,
      env: process.env,
      input,
    },
    receipt.process
  );
  receipt.stdout = textReceipt(result.stdout.toString('utf8'));
  receipt.stderr = textReceipt(result.stderr);
  receipt.exit = result.exit;

  assert.equal(
    result.exit,
    0,
    `helper exited ${result.exit}: ${result.stderr}`
  );
  assert.equal(result.stderr, '', 'helper wrote stderr');
  const parsed = JSON.parse(result.stdout.toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(parsed['nonce'], nonce, 'helper returned the wrong nonce');
  receipt.validated = true;
  return receipt;
}

async function cleanupBrowserAfterFailure(
  receipt: BrowserReceipt,
  profile: string | undefined,
  owner: ContextProcessOwnership | undefined,
  cdp: CdpConnection | undefined
): Promise<void> {
  if (owner !== undefined) {
    try {
      const killed = await runNonTargetPhase(
        'context',
        'browser.cleanup.sigkill',
        () => {
          killOwnedContextProcess(owner);
          return owner.receipt.kill_result;
        },
        owner
      );
      receipt.sigkill_sent = killed;
    } catch {
      // The phase checkpoint already records this cleanup failure.
    }
  }
  if (cdp !== undefined) {
    try {
      await runNonTargetPhase(
        'context',
        'browser.cleanup.cdp_dispose',
        () => cdp.dispose(),
        owner
      );
      receipt.cdp_disposed = true;
    } catch {
      // The phase checkpoint already records this cleanup failure.
    }
  }
  if (profile !== undefined) {
    try {
      await runNonTargetPhase(
        'context',
        'browser.cleanup.profile_remove',
        () => rm(profile, { recursive: true, force: true }),
        owner
      );
      receipt.profile_removed = true;
    } catch {
      // The phase checkpoint already records this cleanup failure.
    }
  }
}

async function retireBrowser(receipt: BrowserReceipt): Promise<() => void> {
  const requested = process.env['RELIC_OTIO_CHROME_PATH'];
  assert.ok(
    requested && requested !== 'none' && requested !== 'disabled',
    'RELIC_OTIO_CHROME_PATH must name the owned headless Chrome executable'
  );
  const found = await runNonTargetPhase('context', 'browser.discover', () =>
    discoverChrome(requested)
  );
  assert.equal(
    found.kind,
    'found',
    `no headless Chrome: ${found.kind === 'not_found' ? found.detail : found.kind}`
  );
  if (found.kind !== 'found') throw new Error('unreachable');

  receipt.executable = found.path;
  let profile: string | undefined;
  let owner: ContextProcessOwnership | undefined;
  let cdp: CdpConnection | undefined;

  try {
    const createdProfile = await runNonTargetPhase(
      'context',
      'browser.profile_create',
      () => mkdtemp(join(tmpdir(), 'relic-stdio-mcp-chrome-'))
    );
    profile = createdProfile;
    const child = await runNonTargetPhase('context', 'browser.spawn', () =>
      spawn(found.path, chromeArgs(found.path, createdProfile), {
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      })
    );
    const browserOwner = ownContextProcess(child, receipt.process);
    owner = browserOwner;
    child.once('close', (code, signal) => {
      receipt.close.observed = true;
      receipt.close.code = code;
      receipt.close.signal = signal;
      receipt.close.observed_at = Date.now();
      receipt.process.exit_code = code;
      receipt.process.signal_code = signal;
      refreshContextProcess(browserOwner);
    });

    const toChrome = child.stdio[3];
    const fromChrome = child.stdio[4];
    const connection = await runNonTargetPhase(
      'context',
      'browser.connect_pipe',
      () => {
        assert.ok(
          toChrome instanceof Writable,
          'Chrome fd 3 did not expose a writable debug pipe'
        );
        assert.ok(
          fromChrome instanceof Readable,
          'Chrome fd 4 did not expose a readable debug pipe'
        );
        return connectPipe(toChrome, fromChrome);
      },
      browserOwner
    );
    cdp = connection;
    const version = await runNonTargetPhase(
      'context',
      'browser.get_version',
      () => connection.send('Browser.getVersion'),
      browserOwner
    );
    const product = String(version['product'] ?? '');
    receipt.product = product;
    assert.ok(
      /headless/i.test(product) || found.path.includes('headless'),
      `browser is not headless: ${product}`
    );

    try {
      await runNonTargetPhase(
        'context',
        'browser.close_send',
        () => connection.send('Browser.close'),
        browserOwner
      );
      receipt.browser_close_request = 'fulfilled';
    } catch (error) {
      receipt.browser_close_request = 'rejected';
      receipt.browser_close_error = errorReceipt(error);
      if (isNonTargetPhaseTimeout(error)) throw error;
    }

    const killed = await runNonTargetPhase(
      'context',
      'browser.sigkill',
      () => {
        killOwnedContextProcess(browserOwner);
        return browserOwner.receipt.kill_result;
      },
      browserOwner
    );
    receipt.sigkill_sent = killed;
    await runNonTargetPhase(
      'context',
      'browser.cdp_dispose',
      () => connection.dispose(),
      browserOwner
    );
    receipt.cdp_disposed = true;
    await runNonTargetPhase(
      'context',
      'browser.profile_remove',
      () => rm(createdProfile, { recursive: true, force: true }),
      browserOwner
    );
    receipt.profile_removed = true;

    return () => {
      killOwnedContextProcess(browserOwner);
      receipt.reap_sigkill_sent = browserOwner.receipt.kill_result;
      if (browserOwner.receipt.kill_error !== undefined) {
        receipt.reap_error = browserOwner.receipt.kill_error;
      }
    };
  } catch (error) {
    persistDirectPhaseFailure('context', 'browser.retire', error, owner);
    await cleanupBrowserAfterFailure(receipt, profile, owner, cdp);
    throw error;
  }
}

async function establishContext(ordinal: number): Promise<ContextArm> {
  const receipt: ContextReceipt = { name: options.context, status: 'ready' };
  if (inProgressTrial !== undefined) inProgressTrial.context = receipt;
  let reap = (): void => {};

  try {
    switch (options.context) {
      case 'none':
        break;
      case 'helper':
        receipt.helper = await runHelper(ordinal, (helper) => {
          receipt.helper = helper;
        });
        break;
      case 'browser-retired': {
        const browser: BrowserReceipt = {
          requested_path: process.env['RELIC_OTIO_CHROME_PATH'] ?? null,
          executable: null,
          process: emptyContextProcessReceipt(),
          product: null,
          browser_close_request: 'not_attempted',
          sigkill_sent: null,
          cdp_disposed: false,
          profile_removed: false,
          reap_sigkill_sent: null,
          close: {
            observed: false,
            code: null,
            signal: null,
            observed_at: null,
          },
        };
        receipt.browser = browser;
        reap = await retireBrowser(browser);
        break;
      }
      case 'browser-retired-then-helper': {
        const browser: BrowserReceipt = {
          requested_path: process.env['RELIC_OTIO_CHROME_PATH'] ?? null,
          executable: null,
          process: emptyContextProcessReceipt(),
          product: null,
          browser_close_request: 'not_attempted',
          sigkill_sent: null,
          cdp_disposed: false,
          profile_removed: false,
          reap_sigkill_sent: null,
          close: {
            observed: false,
            code: null,
            signal: null,
            observed_at: null,
          },
        };
        receipt.browser = browser;
        reap = await retireBrowser(browser);
        receipt.helper = await runHelper(ordinal, (helper) => {
          receipt.helper = helper;
        });
        break;
      }
    }
  } catch (error) {
    receipt.status = 'fixture_failure';
    receipt.failure = errorReceipt(error);
    persistDirectPhaseFailure('context', 'context.establish', error);
  }

  return { receipt, reap };
}

async function callMcp(fixture: Fixture): Promise<TargetReceipt> {
  let call: ActiveMcpCall | undefined;
  let packetForReceipt: string | undefined;
  let receiptsPersisted = false;
  let childSettled = false;
  const receipt: TargetReceipt = {
    command: [NODE_COMMAND, bundlePath],
    cwd: fixture.directory,
    pid: null,
    deadline_ms: TARGET_DEADLINE_MS,
    loopback_receipts: [],
  };
  const child = Bun.spawn([NODE_COMMAND, bundlePath], {
    cwd: fixture.directory,
    env: {
      ...process.env,
      RELIC_MCP_HTTP: '0',
      RELIC_ORIGIN: origin,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: fixture.statePath,
      RELIC_CHROME_PATH: 'none',
      RELIC_CLIENT_NAME: 'relic-mcp/stdio-mcp-boundary-path',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    child.kill();
  }, TARGET_DEADLINE_MS);

  try {
    const packet = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'relic_read_comments',
        arguments: {
          relic_id: fixture.relicId,
          version: '*',
          resolve_anchors: true,
        },
      },
    })}\n`;
    packetForReceipt = packet;
    call = {
      callOrdinal: ++nextMcpCallOrdinal,
      tool: 'relic_read_comments',
      relicId: fixture.relicId,
      pid: child.pid,
      pendingReceipts: [],
    };
    activeMcpCall = call;
    const writeResult = child.stdin.write(packet);
    const endResult = child.stdin.end();
    const [stdout, stderr, exit, inputSettlements] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
      Promise.allSettled([writeResult, endResult]),
    ]);
    childSettled = true;
    if (activeMcpCall === call) activeMcpCall = undefined;

    const persistedReceipts = persistMcpLoopbackReceipts(call, packet);
    receiptsPersisted = true;
    receipt.packet = bytesReceipt(Buffer.from(packet, 'utf8'));
    receipt.input_outcomes = [
      describeInputOutcome(
        'stdin.write',
        inputSettlements[0] as PromiseSettledResult<unknown>
      ),
      describeInputOutcome(
        'stdin.end',
        inputSettlements[1] as PromiseSettledResult<unknown>
      ),
    ];
    receipt.stdout = textReceipt(stdout);
    receipt.stderr = textReceipt(stderr);
    receipt.exit = exit;
    receipt.signal_code = child.signalCode;
    receipt.protocol = parseProtocol(stdout);
    receipt.loopback_receipts = persistedReceipts;
  } catch (error) {
    receipt.collection_error = errorReceipt(error);
  } finally {
    clearTimeout(timer);
    child.kill();
    if (!childSettled) {
      try {
        await child.exited;
      } catch (error) {
        if (receipt.collection_error === undefined) {
          receipt.collection_error = errorReceipt(error);
        }
      }
    }
    receipt.pid = child.pid;
    if (activeMcpCall === call) activeMcpCall = undefined;
    if (
      !receiptsPersisted &&
      call !== undefined &&
      packetForReceipt !== undefined
    ) {
      try {
        const persistedReceipts = persistMcpLoopbackReceipts(
          call,
          packetForReceipt
        );
        receipt.loopback_receipts = persistedReceipts;
        receiptsPersisted = true;
        if (receipt.packet === undefined) {
          receipt.packet = bytesReceipt(Buffer.from(packetForReceipt, 'utf8'));
        }
      } catch (error) {
        receipt.ledger_error = errorReceipt(error);
      }
    }
  }

  return receipt;
}

function assertTarget(fixture: Fixture, target: TargetReceipt): void {
  target.mail_count_after_target = fixture.mails.length;
  assert.equal(
    target.collection_error,
    undefined,
    `MCP collection failed: ${JSON.stringify(target.collection_error)}`
  );
  assert.equal(
    target.ledger_error,
    undefined,
    `MCP ledger persistence failed: ${JSON.stringify(target.ledger_error)}`
  );
  assert.ok(target.packet, 'MCP producer never constructed a request packet');
  assert.equal(target.exit, 0, `relic-mcp exited ${target.exit}`);
  assert.equal(target.stderr?.text, '', 'relic-mcp wrote stderr');
  assert.ok(
    target.input_outcomes?.every((outcome) => outcome.clean_numeric),
    `stdin outcomes were not clean numeric values: ${JSON.stringify(target.input_outcomes)}`
  );

  const protocol = target.protocol;
  assert.ok(protocol, 'MCP producer did not collect stdout');
  assert.ok(protocol.line_count > 0, 'MCP producer returned no JSON-RPC line');
  assert.equal(
    protocol.parse_error,
    undefined,
    `MCP producer returned invalid JSON-RPC: ${JSON.stringify(protocol.parse_error)}`
  );
  const response = protocol.response;
  assert.ok(response, 'MCP producer omitted a JSON-RPC response object');
  assert.equal(response['id'], 1, 'JSON-RPC response id did not match 1');
  assert.equal(
    response['error'],
    undefined,
    `JSON-RPC error: ${JSON.stringify(response['error'])}`
  );

  const result = response['result'];
  assert.ok(
    result && typeof result === 'object',
    'JSON-RPC response omitted result'
  );
  const resultRecord = result as Record<string, unknown>;
  assert.equal(
    resultRecord['isError'],
    false,
    `tool error: ${JSON.stringify(resultRecord['content'])}`
  );
  const structured = resultRecord['structuredContent'];
  assert.ok(
    structured && typeof structured === 'object',
    'response omitted structured comment content'
  );
  const structuredRecord = structured as Record<string, unknown>;
  assert.equal(structuredRecord['count'], 1, 'structured count was not one');
  assert.equal(
    structuredRecord['version_scope'],
    'all',
    'comment read did not use all-version scope'
  );
  const comments = structuredRecord['comments'];
  assert.ok(Array.isArray(comments), 'response omitted decrypted comments');
  assert.equal(
    comments.length,
    1,
    'response did not contain exactly one comment'
  );
  const comment = comments[0] as Record<string, unknown> | undefined;
  assert.equal(comment?.['readable'], true, 'comment was not readable');
  assert.equal(
    comment?.['body'],
    fixture.expectedNonce,
    'decrypted comment nonce did not match the expected nonce'
  );

  assert.equal(fixture.mails.length, 0, 'comment read sent captured mail');
}

async function runTrial(ordinal: number): Promise<TrialReceipt> {
  const trial: TrialReceipt = {
    ordinal,
    started_at: Date.now(),
    status: 'running',
  };
  inProgressTrial = trial;
  let fixture: Fixture | undefined;
  let arm: ContextArm | undefined;

  try {
    fixture = await createFixture(ordinal);
    trial.fixture = fixture.receipt;
  } catch (error) {
    trial.status = 'fixture_failure';
    trial.discrepancy = errorReceipt(error);
    persistDirectPhaseFailure('fixture', 'fixture.complete', error);
    trial.finished_at = Date.now();
    persistCheckpoint('trial:fixture_failure:before_cleanup');
    activeFixture = undefined;
    inProgressTrial = undefined;
    return trial;
  }

  try {
    arm = await establishContext(ordinal);
    trial.context = arm.receipt;
    if (arm.receipt.status === 'fixture_failure') {
      trial.status = 'fixture_failure';
      trial.discrepancy = arm.receipt.failure;
    } else {
      persistCheckpoint('trial:before_target');
      const target = await callMcp(fixture);
      trial.target = target;
      assertTarget(fixture, target);
      trial.status = 'pass';
    }
  } catch (error) {
    trial.status = 'discrepancy';
    trial.discrepancy = errorReceipt(error);
  } finally {
    if (trial.status !== 'pass') {
      persistCheckpoint('trial:failure:before_cleanup');
    }
    arm?.reap();
    activeFixture = undefined;
    trial.finished_at = Date.now();
  }

  inProgressTrial = undefined;
  return trial;
}

async function nodeMetadata(): Promise<NodeMetadata> {
  const resolvedPath = Bun.which(NODE_COMMAND) ?? NODE_COMMAND;
  let owner: ContextProcessOwnership | undefined;
  try {
    const child = await runNonTargetPhase(
      'finalization',
      'node_metadata.spawn',
      () =>
        Bun.spawn([resolvedPath, '--version'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
    );
    owner = ownContextProcess(child, emptyContextProcessReceipt());
    const [stdout, stderr, exit] = await runNonTargetPhase(
      'finalization',
      'node_metadata.collect',
      () =>
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
      owner
    );
    return {
      command: NODE_COMMAND,
      resolved_path: resolvedPath,
      version: stdout.trim().length === 0 ? null : stdout.trim(),
      version_exit: exit,
      version_stderr: stderr.length === 0 ? null : stderr,
    };
  } catch {
    return {
      command: NODE_COMMAND,
      resolved_path: resolvedPath,
      version: null,
      version_exit: null,
      version_stderr: null,
    };
  } finally {
    killOwnedContextProcess(owner);
  }
}

persistCheckpoint('invocation:started');
try {
  const bundleExists = await runNonTargetPhase(
    'bootstrap',
    'bundle.exists',
    () => Bun.file(bundlePath).exists()
  );
  assert.ok(
    bundleExists,
    `built Node bundle is missing at ${bundlePath}; run bun run --cwd packages/relic-mcp build first`
  );
  bundle = bytesReceipt(
    await runNonTargetPhase('bootstrap', 'bundle.read', () =>
      readFile(bundlePath)
    )
  );

  for (let ordinal = 1; ordinal <= options.count; ordinal += 1) {
    const trial = await runTrial(ordinal);
    trials.push(trial);
    persistCheckpoint('trial:completed');
    if (trial.status !== 'pass') break;
  }
} catch (error) {
  fatal = errorReceipt(error);
  persistCheckpoint('invocation:fatal');
} finally {
  for (const child of helperChildren) child.kill('SIGKILL');
  activeFixture = undefined;
  try {
    await runNonTargetPhase('finalization', 'service.stop', () =>
      service.stop(true)
    );
  } catch {
    // The phase checkpoint is the durable finalization failure record.
  }
  if (previousPublishState === undefined) {
    delete process.env['RELIC_PUBLISH_STATE'];
  } else {
    process.env['RELIC_PUBLISH_STATE'] = previousPublishState;
  }
}

runtimeNode = await nodeMetadata();
const passed =
  fatal === undefined &&
  finalizationFailures.length === 0 &&
  trials.length === options.count &&
  trials.every((trial) => trial.status === 'pass');
persistFinalWitness('invocation:final');

console.log(
  `STDIO_MCP_BOUNDARY_${passed ? 'PASS' : 'FAIL'} context=${options.context} trials=${trials.length}/${options.count} witness=${witnessPath}`
);
if (!passed) process.exitCode = 1;
