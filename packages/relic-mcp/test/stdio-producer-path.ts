/**
 * Bounded producer differential probe for the OTIO stdio failure.
 *
 * This intentionally contains no MCP or vendor integration. It sends the same
 * fixed-size packet corpus through Bun's FileSink and node:child_process stdin
 * paths to a minimal Node echo child, preserving receipts when anything fails.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_CHILDREN = 64;
const PACKET_BYTES = 178;
const CHILD_DEADLINE_MS = 15_000;
const NODE_COMMAND = process.env['OTIO_STDIO_NODE_COMMAND'] ?? 'node';

const ECHO_CHILD_SOURCE = String.raw`
const { createHash } = require('node:crypto');
const fs = require('node:fs');

const receiptPath = process.env.OTIO_STDIO_RECEIPT_PATH;
if (!receiptPath) {
  throw new Error('OTIO_STDIO_RECEIPT_PATH is required');
}
const bootPath = receiptPath + '.boot.json';
const corruptReceipt = process.env.OTIO_STDIO_CORRUPT_RECEIPT === '1';

function errorRecord(error) {
  const record = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error && typeof error === 'object') {
    for (const field of ['code', 'errno', 'syscall']) {
      const value = error[field];
      if (typeof value === 'string' || typeof value === 'number') {
        record[field] = value;
      }
    }
  }
  return record;
}

function fd0Marker() {
  try {
    const stat = fs.fstatSync(0);
    return {
      ok: true,
      mode: stat.mode,
      isFIFO: stat.isFIFO(),
      isFile: stat.isFile(),
      isCharacterDevice: stat.isCharacterDevice(),
    };
  } catch (error) {
    return { ok: false, error: errorRecord(error) };
  }
}

const boot = {
  kind: 'stdio-producer-boot-v1',
  pid: process.pid,
  runtime: { node: process.version },
  fd0: fd0Marker(),
};
fs.writeFileSync(bootPath, JSON.stringify(boot) + '\n', 'utf8');

const chunks = [];
let readError = null;
let finished = false;

function finish(eofObserved, completion) {
  if (finished) return;
  finished = true;

  const input = Buffer.concat(chunks);
  let parsedNonce = null;
  let parseError = null;
  try {
    const parsed = JSON.parse(input.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.nonce !== 'string') {
      throw new Error('input packet omitted string nonce');
    }
    parsedNonce = parsed.nonce;
  } catch (error) {
    parseError = errorRecord(error);
  }

  const actualSha256 = createHash('sha256').update(input).digest('hex');
  const receipt = {
    kind: 'stdio-producer-receipt-v1',
    pid: process.pid,
    runtime: { node: process.version },
    receivedBytes: input.byteLength,
    receivedSha256: corruptReceipt ? '0'.repeat(64) : actualSha256,
    parsedNonce: corruptReceipt ? 'corrupt-receipt-nonce' : parsedNonce,
    eofObserved,
    completion,
    finalFd0: fd0Marker(),
    readError,
    parseError,
  };
  const text = JSON.stringify(receipt) + '\n';
  fs.writeFileSync(receiptPath, text, 'utf8');
  process.stdout.write(text);
}

process.stdin.on('data', (chunk) => {
  chunks.push(Buffer.from(chunk));
});
process.stdin.once('error', (error) => {
  readError = errorRecord(error);
  finish(false, 'stdin_error');
});
process.stdin.once('end', () => {
  finish(true, 'stdin_eof');
});
process.stdin.resume();
`;

type Producer = 'bun-pipe' | 'node-stream';
type GcMode = 'natural' | 'drop' | 'retain';

interface Options {
  readonly producer: Producer;
  readonly count: number;
  readonly gc: GcMode;
  readonly seed: string;
  readonly corruptReceipt: boolean;
}

interface Packet {
  readonly ordinal: number;
  readonly nonce: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface CapturedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly text: string | null;
  readonly parsed: Record<string, unknown> | null;
  readonly error: Record<string, unknown> | null;
}

interface CompletedReference {
  readonly child: unknown;
  readonly input: unknown;
}

interface ChildExecution {
  readonly record: Record<string, unknown>;
  readonly reference: CompletedReference;
}

interface Paths {
  readonly receiptPath: string;
  readonly bootPath: string;
  readonly recordPath: string;
}

interface NodeClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

let outputDirectory: string | undefined;
let activeChildren = 0;

function usage(message?: string): never {
  const prefix = message ? `${message}\n` : '';
  throw new Error(
    `${prefix}usage: mise exec -- bun packages/relic-mcp/test/stdio-producer-path.ts ` +
      '--producer=bun-pipe|node-stream --count=1..64 ' +
      '--gc=natural|drop|retain --seed=otio-stdio-v1 [--corrupt-receipt]'
  );
}

function parseOptions(argv: readonly string[]): Options {
  let producer: Producer | undefined;
  let count: number | undefined;
  let gc: GcMode = 'natural';
  let seed = 'otio-stdio-v1';
  let corruptReceipt = false;

  for (const arg of argv) {
    if (arg === '--corrupt-receipt') {
      corruptReceipt = true;
      continue;
    }
    if (arg.startsWith('--producer=')) {
      const value = arg.slice('--producer='.length);
      if (value === 'bun-pipe' || value === 'node-stream') {
        producer = value;
        continue;
      }
      usage(`unsupported producer ${JSON.stringify(value)}`);
    }
    if (arg.startsWith('--count=')) {
      const value = Number(arg.slice('--count='.length));
      if (Number.isInteger(value) && value >= 1 && value <= MAX_CHILDREN) {
        count = value;
        continue;
      }
      usage(`count must be an integer from 1 through ${MAX_CHILDREN}`);
    }
    if (arg.startsWith('--gc=')) {
      const value = arg.slice('--gc='.length);
      if (value === 'natural' || value === 'drop' || value === 'retain') {
        gc = value;
        continue;
      }
      usage(`unsupported gc mode ${JSON.stringify(value)}`);
    }
    if (arg.startsWith('--seed=')) {
      seed = arg.slice('--seed='.length);
      continue;
    }
    usage(`unknown argument ${JSON.stringify(arg)}`);
  }

  if (!producer) usage('producer is required');
  if (count === undefined) usage('count is required');
  return { producer, count, gc, seed, corruptReceipt };
}

function errorRecord(error: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error !== null && typeof error === 'object') {
    const details = error as {
      readonly code?: unknown;
      readonly errno?: unknown;
      readonly syscall?: unknown;
    };
    for (const field of ['code', 'errno', 'syscall'] as const) {
      const value = details[field];
      if (typeof value === 'string' || typeof value === 'number') {
        record[field] = value;
      }
    }
  }
  return record;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packetFor(seed: string, ordinal: number): Packet {
  const nonce = createHash('sha256')
    .update(`${seed}\u0000${ordinal}`)
    .digest('hex');
  const base = {
    protocol: 'otio-stdio-producer-v1',
    ordinal: String(ordinal).padStart(2, '0'),
    nonce,
    padding: '',
  };
  const baseText = JSON.stringify(base);
  const paddingLength = PACKET_BYTES - 1 - Buffer.byteLength(baseText, 'utf8');
  if (paddingLength < 0) {
    throw new Error(`packet base exceeds ${PACKET_BYTES} bytes`);
  }
  const text = `${JSON.stringify({ ...base, padding: 'x'.repeat(paddingLength) })}\n`;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength !== PACKET_BYTES) {
    throw new Error(
      `packet ${ordinal} is ${bytes.byteLength} bytes, expected ${PACKET_BYTES}`
    );
  }
  return { ordinal, nonce, bytes, sha256: sha256(bytes) };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function captureFile(path: string): CapturedFile {
  try {
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    try {
      const parsedValue = JSON.parse(text) as unknown;
      if (parsedValue === null || typeof parsedValue !== 'object') {
        return {
          path,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
          text,
          parsed: null,
          error: { message: 'receipt JSON was not an object' },
        };
      }
      return {
        path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        text,
        parsed: parsedValue as Record<string, unknown>,
        error: null,
      };
    } catch (error) {
      return {
        path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        text,
        parsed: null,
        error: errorRecord(error),
      };
    }
  } catch (error) {
    return {
      path,
      bytes: 0,
      sha256: sha256(Buffer.alloc(0)),
      text: null,
      parsed: null,
      error: errorRecord(error),
    };
  }
}

function captureBytes(label: string, bytes: Buffer): CapturedFile {
  const text = bytes.toString('utf8');
  try {
    const parsedValue = JSON.parse(text) as unknown;
    if (parsedValue === null || typeof parsedValue !== 'object') {
      return {
        path: label,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        text,
        parsed: null,
        error: { message: 'receipt JSON was not an object' },
      };
    }
    return {
      path: label,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      text,
      parsed: parsedValue as Record<string, unknown>,
      error: null,
    };
  } catch (error) {
    return {
      path: label,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      text,
      parsed: null,
      error: errorRecord(error),
    };
  }
}

function valueDescription(value: unknown): Record<string, unknown> {
  if (typeof value === 'number') {
    return { kind: 'number', value };
  }
  if (
    value instanceof Error ||
    (value !== null && typeof value === 'object' && 'code' in value)
  ) {
    return { kind: 'error', error: errorRecord(value) };
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    return { kind: 'thenable' };
  }
  return { kind: value === null ? 'null' : typeof value };
}

async function settlePromise<T>(
  promise: Promise<T>
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

async function settleReturn(
  called: boolean,
  threw: unknown | undefined,
  value: unknown
): Promise<Record<string, unknown>> {
  if (!called) return { status: 'not_called' };
  if (threw !== undefined)
    return { status: 'threw', error: errorRecord(threw) };
  const outcome = await settlePromise(Promise.resolve(value));
  if (outcome.status === 'rejected') {
    return { status: 'rejected', error: errorRecord(outcome.reason) };
  }
  return { status: 'fulfilled', value: valueDescription(outcome.value) };
}

function numericSettledReturn(outcome: Record<string, unknown>): boolean {
  if (outcome['status'] !== 'fulfilled') return false;
  const value = outcome['value'];
  if (value === null || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (
    result['kind'] === 'number' &&
    typeof result['value'] === 'number' &&
    Number.isFinite(result['value'])
  );
}

function killOutcome(action: () => unknown): Record<string, unknown> {
  try {
    return { called: true, result: valueDescription(action()) };
  } catch (error) {
    return { called: true, threw: errorRecord(error) };
  }
}

function fstatMarker(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function receiptErrors(
  label: string,
  receipt: CapturedFile,
  packet: Packet,
  expectedPid: number | undefined
): string[] {
  const errors: string[] = [];
  const parsed = receipt.parsed;
  if (!parsed) {
    errors.push(`${label} receipt was unavailable or invalid JSON`);
    return errors;
  }
  if (parsed['kind'] !== 'stdio-producer-receipt-v1') {
    errors.push(`${label} receipt kind was ${JSON.stringify(parsed['kind'])}`);
  }
  if (expectedPid !== undefined && parsed['pid'] !== expectedPid) {
    errors.push(`${label} receipt pid did not match spawned child`);
  }
  if (parsed['receivedBytes'] !== packet.bytes.byteLength) {
    errors.push(
      `${label} receipt byte count was ${JSON.stringify(parsed['receivedBytes'])}, expected ${packet.bytes.byteLength}`
    );
  }
  if (parsed['receivedSha256'] !== packet.sha256) {
    errors.push(`${label} receipt hash did not match packet hash`);
  }
  if (parsed['parsedNonce'] !== packet.nonce) {
    errors.push(`${label} receipt nonce did not match packet nonce`);
  }
  if (parsed['eofObserved'] !== true) {
    errors.push(`${label} receipt did not observe stdin EOF`);
  }
  if (parsed['readError'] !== null) {
    errors.push(`${label} receipt recorded stdin read error`);
  }
  if (parsed['parseError'] !== null) {
    errors.push(`${label} receipt recorded packet parse error`);
  }
  const finalFd0 = fstatMarker(parsed['finalFd0']);
  if (!finalFd0 || finalFd0['ok'] !== true) {
    errors.push(`${label} receipt final fd0 marker was not successful`);
  }
  const runtime = parsed['runtime'];
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    !('node' in runtime) ||
    typeof runtime.node !== 'string'
  ) {
    errors.push(`${label} receipt omitted the actual Node runtime`);
  }
  return errors;
}

function bootErrors(
  boot: CapturedFile,
  expectedPid: number | undefined
): string[] {
  const errors: string[] = [];
  const parsed = boot.parsed;
  if (!parsed) {
    errors.push('boot marker was unavailable or invalid JSON');
    return errors;
  }
  if (parsed['kind'] !== 'stdio-producer-boot-v1') {
    errors.push(`boot marker kind was ${JSON.stringify(parsed['kind'])}`);
  }
  if (expectedPid !== undefined && parsed['pid'] !== expectedPid) {
    errors.push('boot marker pid did not match spawned child');
  }
  const fd0 = fstatMarker(parsed['fd0']);
  if (!fd0 || fd0['ok'] !== true) {
    errors.push('boot marker fstatSync(0) was not successful');
  }
  const runtime = parsed['runtime'];
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    !('node' in runtime) ||
    typeof runtime.node !== 'string'
  ) {
    errors.push('boot marker omitted the actual Node runtime');
  }
  return errors;
}

function bunRuntime(): Record<string, unknown> {
  const runtime = Bun as unknown as {
    readonly version?: unknown;
    readonly revision?: unknown;
  };
  return {
    version:
      typeof runtime.version === 'string'
        ? runtime.version
        : (process.versions['bun'] ?? 'unknown'),
    revision: typeof runtime.revision === 'string' ? runtime.revision : null,
  };
}

function childEnvironment(
  receiptPath: string,
  corruptReceipt: boolean
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OTIO_STDIO_RECEIPT_PATH: receiptPath,
    OTIO_STDIO_CORRUPT_RECEIPT: corruptReceipt ? '1' : '0',
  };
}

function nextPaths(producer: Producer, ordinal: number, nonce: string): Paths {
  if (!outputDirectory) throw new Error('output directory was not created');
  const suffix = `${producer}-${String(ordinal).padStart(2, '0')}-${nonce.slice(0, 12)}`;
  const receiptPath = join(outputDirectory, `${suffix}.receipt.json`);
  return {
    receiptPath,
    bootPath: `${receiptPath}.boot.json`,
    recordPath: join(outputDirectory, `${suffix}.parent.json`),
  };
}

function outputBuffer(outcome: PromiseSettledResult<Buffer>): {
  readonly bytes: Buffer;
  readonly error: Record<string, unknown> | null;
} {
  if (outcome.status === 'fulfilled') {
    return { bytes: outcome.value, error: null };
  }
  return { bytes: Buffer.alloc(0), error: errorRecord(outcome.reason) };
}

async function runBunPipe(
  packet: Packet,
  paths: Paths,
  options: Options,
  beforeWrite: () => Record<string, unknown>
): Promise<ChildExecution> {
  if (activeChildren !== 0)
    throw new Error('attempted to start a second active child');
  const child = Bun.spawn(
    [NODE_COMMAND, '--input-type=commonjs', '-e', ECHO_CHILD_SOURCE],
    {
      env: childEnvironment(paths.receiptPath, options.corruptReceipt),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  activeChildren += 1;
  const reference: CompletedReference = { child, input: child.stdin };
  let deadlineExpired = false;
  let deadlineKill: Record<string, unknown> | null = null;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    deadlineKill = killOutcome(() => child.kill());
  }, CHILD_DEADLINE_MS);

  try {
    const stdoutPromise = new Response(child.stdout)
      .arrayBuffer()
      .then((value) => Buffer.from(value));
    const stderrPromise = new Response(child.stderr)
      .arrayBuffer()
      .then((value) => Buffer.from(value));
    const exitPromise = child.exited;
    const gcBeforeWrite = beforeWrite();

    let writeCalled = false;
    let endCalled = false;
    let writeThrown: unknown | undefined;
    let endThrown: unknown | undefined;
    let writeReturn: unknown;
    let endReturn: unknown;

    try {
      writeCalled = true;
      writeReturn = child.stdin.write(packet.bytes);
    } catch (error) {
      writeThrown = error;
    }
    if (writeThrown === undefined) {
      try {
        endCalled = true;
        endReturn = child.stdin.end();
      } catch (error) {
        endThrown = error;
      }
    }

    const [
      stdoutOutcome,
      stderrOutcome,
      exitOutcome,
      writeOutcome,
      endOutcome,
    ] = await Promise.all([
      settlePromise(stdoutPromise),
      settlePromise(stderrPromise),
      settlePromise(exitPromise),
      settleReturn(writeCalled, writeThrown, writeReturn),
      settleReturn(endCalled, endThrown, endReturn),
    ]);
    clearTimeout(deadline);
    const postCompletionKill = killOutcome(() => child.kill());
    const stdout = outputBuffer(stdoutOutcome);
    const stderr = outputBuffer(stderrOutcome);
    const exitCode =
      exitOutcome.status === 'fulfilled' ? exitOutcome.value : undefined;
    const exitError =
      exitOutcome.status === 'rejected'
        ? errorRecord(exitOutcome.reason)
        : null;
    const boot = captureFile(paths.bootPath);
    const fileReceipt = captureFile(paths.receiptPath);
    const stdoutReceipt = captureBytes('captured-stdout', stdout.bytes);
    const inputErrors: string[] = [];
    if (!numericSettledReturn(writeOutcome)) {
      inputErrors.push('Bun stdin.write() did not settle to a finite number');
    }
    if (!numericSettledReturn(endOutcome)) {
      inputErrors.push('Bun stdin.end() did not settle to a finite number');
    }

    const validationErrors = [
      ...inputErrors,
      ...(deadlineExpired ? ['child exceeded deadline'] : []),
      ...(exitError ? ['child.exited rejected'] : []),
      ...(exitCode !== 0 ? [`child exit was ${String(exitCode)}`] : []),
      ...(child.signalCode ? [`child signal was ${child.signalCode}`] : []),
      ...(stdout.error ? ['stdout capture rejected'] : []),
      ...(stderr.error ? ['stderr capture rejected'] : []),
      ...(stderr.bytes.byteLength > 0 ? ['child stderr was not empty'] : []),
      ...bootErrors(boot, child.pid),
      ...receiptErrors('file', fileReceipt, packet, child.pid),
      ...receiptErrors('stdout', stdoutReceipt, packet, child.pid),
      ...(fileReceipt.text !== stdoutReceipt.text
        ? ['receipt file and captured stdout differed']
        : []),
    ];
    const runtime = fileReceipt.parsed?.['runtime'];
    const nodeRuntime =
      runtime !== null && typeof runtime === 'object' && 'node' in runtime
        ? runtime.node
        : null;
    const record: Record<string, unknown> = {
      producer: 'bun-pipe',
      ordinal: packet.ordinal,
      packet: {
        bytes: packet.bytes.byteLength,
        sha256: packet.sha256,
        nonce: packet.nonce,
      },
      runtime: {
        bun: bunRuntime(),
        nodeCommand: NODE_COMMAND,
        node: nodeRuntime,
      },
      child: {
        pid: child.pid,
        exit: exitCode,
        signal: child.signalCode,
        exitError,
        deadlineExpired,
        deadlineKill,
        postCompletionKill,
      },
      input: {
        immediate: {
          write: {
            called: writeCalled,
            result:
              writeThrown === undefined && writeCalled
                ? valueDescription(writeReturn)
                : null,
          },
          end: {
            called: endCalled,
            result:
              endThrown === undefined && endCalled
                ? valueDescription(endReturn)
                : null,
          },
        },
        thrown: {
          write: writeThrown === undefined ? null : errorRecord(writeThrown),
          end: endThrown === undefined ? null : errorRecord(endThrown),
        },
        settled: { write: writeOutcome, end: endOutcome },
      },
      gcBeforeWrite,
      output: {
        stdout: {
          bytes: stdout.bytes.byteLength,
          sha256: sha256(stdout.bytes),
          error: stdout.error,
        },
        stderr: {
          bytes: stderr.bytes.byteLength,
          sha256: sha256(stderr.bytes),
          error: stderr.error,
        },
      },
      paths,
      boot,
      fileReceipt,
      stdoutReceipt,
      validationErrors,
    };
    return { record, reference };
  } finally {
    clearTimeout(deadline);
    activeChildren -= 1;
  }
}

async function runNodeStream(
  packet: Packet,
  paths: Paths,
  options: Options,
  beforeWrite: () => Record<string, unknown>
): Promise<ChildExecution> {
  if (activeChildren !== 0)
    throw new Error('attempted to start a second active child');
  const child = spawn(
    NODE_COMMAND,
    ['--input-type=commonjs', '-e', ECHO_CHILD_SOURCE],
    {
      env: childEnvironment(paths.receiptPath, options.corruptReceipt),
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  activeChildren += 1;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdinErrors: Record<string, unknown>[] = [];
  let deadlineExpired = false;
  let deadlineKill: Record<string, unknown> | null = null;

  try {
    const stdin = child.stdin;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdin || !stdoutStream || !stderrStream) {
      throw new Error('node-stream child did not expose piped stdio');
    }
    const reference: CompletedReference = { child, input: stdin };
    stdoutStream.on('data', (chunk: Buffer) =>
      stdoutChunks.push(Buffer.from(chunk))
    );
    stderrStream.on('data', (chunk: Buffer) =>
      stderrChunks.push(Buffer.from(chunk))
    );
    stdin.on('error', (error) => stdinErrors.push(errorRecord(error)));

    let closeError: Record<string, unknown> | null = null;
    const closeDeferred = Promise.withResolvers<NodeClose>();
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      deadlineKill = killOutcome(() => child.kill('SIGKILL'));
      closeDeferred.reject(new Error(`timed out after ${CHILD_DEADLINE_MS}ms`));
    }, CHILD_DEADLINE_MS);
    child.once('error', (error) => {
      closeError = errorRecord(error);
      clearTimeout(deadline);
      closeDeferred.reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      closeDeferred.resolve({ code, signal });
    });

    const gcBeforeWrite = beforeWrite();
    let inputEndThrow: Record<string, unknown> | null = null;
    try {
      stdin.end(packet.bytes);
    } catch (error) {
      inputEndThrow = errorRecord(error);
    }

    const closeOutcome = await settlePromise(closeDeferred.promise);
    const postCloseCleanup = killOutcome(() => child.kill());
    const close =
      closeOutcome.status === 'fulfilled' ? closeOutcome.value : undefined;
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks);
    const boot = captureFile(paths.bootPath);
    const fileReceipt = captureFile(paths.receiptPath);
    const stdoutReceipt = captureBytes('captured-stdout', stdout);
    const validationErrors = [
      ...(deadlineExpired ? ['child exceeded deadline'] : []),
      ...(closeOutcome.status === 'rejected'
        ? ['child close lifecycle rejected']
        : []),
      ...(closeError ? ['child process emitted error'] : []),
      ...(close?.code !== 0 ? [`child exit was ${String(close?.code)}`] : []),
      ...(close?.signal ? [`child signal was ${close.signal}`] : []),
      ...(inputEndThrow ? ['child.stdin.end(input) threw'] : []),
      ...(stdinErrors.length > 0 ? ['child.stdin emitted error'] : []),
      ...(stderr.byteLength > 0 ? ['child stderr was not empty'] : []),
      ...bootErrors(boot, child.pid),
      ...receiptErrors('file', fileReceipt, packet, child.pid),
      ...receiptErrors('stdout', stdoutReceipt, packet, child.pid),
      ...(fileReceipt.text !== stdoutReceipt.text
        ? ['receipt file and captured stdout differed']
        : []),
    ];
    const runtime = fileReceipt.parsed?.['runtime'];
    const nodeRuntime =
      runtime !== null && typeof runtime === 'object' && 'node' in runtime
        ? runtime.node
        : null;
    const record: Record<string, unknown> = {
      producer: 'node-stream',
      ordinal: packet.ordinal,
      packet: {
        bytes: packet.bytes.byteLength,
        sha256: packet.sha256,
        nonce: packet.nonce,
      },
      runtime: {
        bun: bunRuntime(),
        nodeCommand: NODE_COMMAND,
        node: nodeRuntime,
      },
      child: {
        pid: child.pid,
        exit: close?.code,
        signal: close?.signal,
        closeError,
        closeRejection:
          closeOutcome.status === 'rejected'
            ? errorRecord(closeOutcome.reason)
            : null,
        deadlineExpired,
        deadlineKill,
        postCloseCleanup,
      },
      input: {
        lifecycle:
          'node:child_process stdin.end(input), stdout/stderr data, close',
        endThrow: inputEndThrow,
        stdinErrors,
      },
      gcBeforeWrite,
      output: {
        stdout: { bytes: stdout.byteLength, sha256: sha256(stdout) },
        stderr: { bytes: stderr.byteLength, sha256: sha256(stderr) },
      },
      paths,
      boot,
      fileReceipt,
      stdoutReceipt,
      validationErrors,
    };
    return { record, reference };
  } finally {
    activeChildren -= 1;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  outputDirectory = await mkdtemp(join(tmpdir(), 'relic-stdio-producer-'));
  const retainedReferences: CompletedReference[] = [];
  let previousReference: CompletedReference | undefined;
  writeJson(join(outputDirectory, 'manifest.json'), {
    kind: 'stdio-producer-path-v1',
    options,
    outputDirectory,
    nodeCommand: NODE_COMMAND,
    bun: bunRuntime(),
    packetBytes: PACKET_BYTES,
    deadlineMs: CHILD_DEADLINE_MS,
  });
  console.log(`STDIO_PRODUCER_PATH_OUTPUT ${outputDirectory}`);

  for (let ordinal = 1; ordinal <= options.count; ordinal += 1) {
    const packet = packetFor(options.seed, ordinal);
    const paths = nextPaths(options.producer, ordinal, packet.nonce);
    writeJson(paths.recordPath, {
      status: 'started',
      producer: options.producer,
      ordinal,
      packet: {
        bytes: packet.bytes.byteLength,
        sha256: packet.sha256,
        nonce: packet.nonce,
      },
      paths,
    });

    const beforeWrite = (): Record<string, unknown> => {
      const record: Record<string, unknown> = {
        mode: options.gc,
        previousReferencePresent: previousReference !== undefined,
        retainedReferenceCount: retainedReferences.length,
        executed: false,
      };
      if (options.gc === 'natural') return record;
      if (options.gc === 'drop') {
        previousReference = undefined;
      } else if (previousReference) {
        retainedReferences.push(previousReference);
      }
      Bun.gc(true);
      record['executed'] = true;
      record['afterPreviousReferencePresent'] = previousReference !== undefined;
      record['afterRetainedReferenceCount'] = retainedReferences.length;
      return record;
    };

    let execution: ChildExecution;
    try {
      execution =
        options.producer === 'bun-pipe'
          ? await runBunPipe(packet, paths, options, beforeWrite)
          : await runNodeStream(packet, paths, options, beforeWrite);
    } catch (error) {
      writeJson(paths.recordPath, {
        status: 'runner_error',
        producer: options.producer,
        ordinal,
        packet: {
          bytes: packet.bytes.byteLength,
          sha256: packet.sha256,
          nonce: packet.nonce,
        },
        paths,
        error: errorRecord(error),
      });
      throw new Error(
        `producer runner failed at ordinal ${ordinal}; evidence: ${paths.recordPath}`
      );
    }
    writeJson(paths.recordPath, execution.record);
    const errors = execution.record['validationErrors'];
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(
        `producer discrepancy at ordinal ${ordinal}; evidence: ${paths.recordPath}`
      );
    }

    if (options.gc === 'natural') {
      previousReference = undefined;
    } else {
      previousReference = execution.reference;
    }
  }

  console.log(
    JSON.stringify({
      kind: 'stdio-producer-path-v1',
      status: 'ok',
      producer: options.producer,
      count: options.count,
      gc: options.gc,
      outputDirectory,
    })
  );
  console.log('STDIO_PRODUCER_PATH_OK');
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      kind: 'stdio-producer-path-v1',
      status: 'failed',
      outputDirectory: outputDirectory ?? null,
      error: errorRecord(error),
    })
  );
  process.exitCode = 1;
});
