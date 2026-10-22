import { spawn as spawnNode } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fstatSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXPECTED_BUN_VERSION = '1.3.14';
const MAX_CHILDREN = 64;
const BOOT_SCHEMA = 'relic-stdio-linux-ci-boundary-boot-v1';
const CHILD_SCHEMA = 'relic-stdio-linux-ci-boundary-child-v1';
const REPORT_SCHEMA = 'relic-stdio-linux-ci-boundary-report-v1';
const bunMetadata = Bun as unknown as { revision?: string };

type Arm =
  | 'bun-exit-before-drain'
  | 'node-child-process'
  | 'bun-concurrent-drain-control';

type CorpusEntry = {
  ordinal: number;
  nonce: string;
  byteLength: number;
  sha256: string;
  base64: string;
};

type CapturedBytes = {
  bytes: Uint8Array;
  receipt: Record<string, unknown>;
};

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorReceipt(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const errno = error as NodeJS.ErrnoException;
    return {
      name: error.name,
      message: error.message,
      ...(typeof errno.code === 'string' ? { code: errno.code } : {}),
      ...(typeof errno.errno === 'number' ? { errno: errno.errno } : {}),
      ...(typeof errno.syscall === 'string' ? { syscall: errno.syscall } : {}),
    };
  }
  return { name: 'NonError', message: String(error) };
}

function runtimeMetadata(): Record<string, unknown> {
  return {
    kind: process.versions.bun === undefined ? 'not-bun' : 'bun',
    bun_version: process.versions.bun ?? null,
    bun_revision: bunMetadata.revision ?? null,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseOptions(args: string[]): Map<string, string> {
  if (args.length % 2 !== 0)
    throw new Error('options must be flag/value pairs');
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || parsed.has(flag)) {
      throw new Error(`invalid option at argument ${index}`);
    }
    parsed.set(flag, value);
  }
  return parsed;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined || value.length === 0)
    throw new Error(`missing ${key}`);
  return value;
}

function descriptorReceipt(): Record<string, unknown> {
  try {
    const stat = fstatSync(0);
    return {
      status: 'open',
      mode: stat.mode,
      is_character_device: stat.isCharacterDevice(),
      is_fifo: stat.isFIFO(),
      is_file: stat.isFile(),
      is_socket: stat.isSocket(),
    };
  } catch (error) {
    return { status: 'error', error: errorReceipt(error) };
  }
}

function makeCorpus(seed: string, count: number): CorpusEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const nonce = sha256(`${seed}:${ordinal}`).slice(0, 32);
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({
        protocol: 'relic-stdio-linux-ci-boundary-v1',
        seed,
        ordinal,
        nonce,
      })}\n`
    );
    return {
      ordinal,
      nonce,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      base64: Buffer.from(bytes).toString('base64'),
    };
  });
}

function isReadableWebStream(
  value: unknown
): value is ReadableStream<Uint8Array> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'getReader' in value &&
    typeof value.getReader === 'function'
  );
}

async function captureWebPipe(value: unknown): Promise<CapturedBytes> {
  if (!isReadableWebStream(value)) {
    return {
      bytes: new Uint8Array(),
      receipt: {
        byte_length: 0,
        sha256: sha256(''),
        read_error: {
          name: 'MissingPipe',
          message: 'expected a readable pipe',
        },
      },
    };
  }
  try {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    return {
      bytes,
      receipt: { byte_length: bytes.byteLength, sha256: sha256(bytes) },
    };
  } catch (error) {
    return {
      bytes: new Uint8Array(),
      receipt: {
        byte_length: 0,
        sha256: sha256(''),
        read_error: errorReceipt(error),
      },
    };
  }
}

async function captureNodePipe(
  stream: Readable | null
): Promise<CapturedBytes> {
  if (stream === null) {
    return {
      bytes: new Uint8Array(),
      receipt: {
        byte_length: 0,
        sha256: sha256(''),
        read_error: {
          name: 'MissingPipe',
          message: 'expected a readable pipe',
        },
      },
    };
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    return {
      bytes,
      receipt: { byte_length: bytes.byteLength, sha256: sha256(bytes) },
    };
  } catch (error) {
    return {
      bytes: new Uint8Array(),
      receipt: {
        byte_length: 0,
        sha256: sha256(''),
        read_error: errorReceipt(error),
      },
    };
  }
}

async function readReceipt(path: string): Promise<Record<string, unknown>> {
  try {
    const bytes = await readFile(path);
    const receipt: Record<string, unknown> = {
      path,
      byte_length: bytes.byteLength,
      sha256: sha256(bytes),
    };
    try {
      receipt['value'] = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      receipt['error'] = errorReceipt(error);
    }
    return receipt;
  } catch (error) {
    return { path, error: errorReceipt(error) };
  }
}

function receiptValue(
  receipt: Record<string, unknown>,
  label: string
): Record<string, unknown> {
  if ('error' in receipt) throw new Error(`${label} was not readable`);
  return object(receipt['value'], label);
}

function validateBoot(
  receipt: Record<string, unknown>,
  expected: CorpusEntry,
  pid: number | undefined
): string[] {
  try {
    const boot = receiptValue(receipt, 'boot receipt');
    const runtime = object(boot['runtime'], 'boot runtime');
    const stdin = object(boot['stdin'], 'boot stdin');
    const errors: string[] = [];
    if (boot['schema'] !== BOOT_SCHEMA) errors.push('boot schema');
    if (boot['nonce'] !== expected.nonce) errors.push('boot nonce');
    if (boot['ordinal'] !== expected.ordinal) errors.push('boot ordinal');
    if (pid !== undefined && boot['pid'] !== pid) errors.push('boot pid');
    if (runtime['kind'] !== 'bun') errors.push('boot runtime');
    if (runtime['bun_version'] !== EXPECTED_BUN_VERSION)
      errors.push('boot Bun version');
    if (stdin['status'] !== 'open') errors.push('boot stdin descriptor');
    return errors;
  } catch (error) {
    return [`boot receipt: ${String(errorReceipt(error)['message'])}`];
  }
}

function validateChild(
  value: unknown,
  expected: CorpusEntry,
  pid?: number
): string[] {
  try {
    const child = object(value, 'child receipt');
    const runtime = object(child['runtime'], 'child runtime');
    const packet = object(child['packet'], 'child packet');
    const protocol = object(child['protocol'], 'child protocol');
    const stdin = object(child['stdin'], 'child stdin');
    const errors: string[] = [];
    if (child['schema'] !== CHILD_SCHEMA) errors.push('child schema');
    if (child['nonce'] !== expected.nonce) errors.push('child nonce');
    if (child['ordinal'] !== expected.ordinal) errors.push('child ordinal');
    if (pid !== undefined && child['pid'] !== pid) errors.push('child pid');
    if (runtime['kind'] !== 'bun') errors.push('child runtime');
    if (runtime['bun_version'] !== EXPECTED_BUN_VERSION)
      errors.push('child Bun version');
    if (packet['byte_length'] !== expected.byteLength)
      errors.push('child packet bytes');
    if (packet['sha256'] !== expected.sha256) errors.push('child packet hash');
    if (packet['nonce'] !== expected.nonce) errors.push('child packet nonce');
    if (protocol['nonce'] !== expected.nonce)
      errors.push('child protocol nonce');
    if (protocol['packet_sha256'] !== expected.sha256) {
      errors.push('child protocol hash');
    }
    if (stdin['status'] !== 'open') errors.push('child stdin descriptor');
    return errors;
  } catch (error) {
    return [`child receipt: ${String(errorReceipt(error)['message'])}`];
  }
}

function parseProtocol(stdout: CapturedBytes, expected: CorpusEntry): string[] {
  if ('read_error' in stdout.receipt) return ['stdout read'];
  try {
    const message = object(
      JSON.parse(new TextDecoder().decode(stdout.bytes).trim()),
      'stdout protocol'
    );
    const result = object(message['result'], 'stdout protocol result');
    const errors: string[] = [];
    if (message['jsonrpc'] !== '2.0') errors.push('protocol version');
    if (message['id'] !== expected.ordinal) errors.push('protocol id');
    if (result['nonce'] !== expected.nonce) errors.push('protocol nonce');
    if (result['packet_sha256'] !== expected.sha256)
      errors.push('protocol hash');
    return errors;
  } catch (error) {
    return [`protocol parse: ${String(errorReceipt(error)['message'])}`];
  }
}

function pathsFor(
  output: string,
  arm: Arm,
  entry: CorpusEntry
): {
  boot: string;
  receipt: string;
} {
  const name = `${String(entry.ordinal).padStart(2, '0')}-${entry.nonce}`;
  return {
    boot: join(output, arm, `${name}.boot.json`),
    receipt: join(output, arm, `${name}.child.json`),
  };
}

function childArgs(
  paths: { boot: string; receipt: string },
  entry: CorpusEntry
): string[] {
  return [
    SCRIPT_PATH,
    '--child',
    '--boot',
    paths.boot,
    '--receipt',
    paths.receipt,
    '--nonce',
    entry.nonce,
    '--ordinal',
    String(entry.ordinal),
    '--packet-base64',
    entry.base64,
  ];
}

async function collectRun(
  arm: Arm,
  entry: CorpusEntry,
  paths: { boot: string; receipt: string },
  pid: number | undefined,
  exited: Record<string, unknown>,
  exitCode: number | null,
  signal: string | number | null,
  stdout: CapturedBytes,
  stderr: CapturedBytes,
  error?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const [boot, child] = await Promise.all([
    readReceipt(paths.boot),
    readReceipt(paths.receipt),
  ]);
  const validationErrors: string[] = [];
  if (exited['status'] !== 'fulfilled')
    validationErrors.push('exited rejection');
  if (exited['code'] !== 0) validationErrors.push('exited code');
  if (exitCode !== 0) validationErrors.push('exit code');
  if (signal !== null) validationErrors.push('signal');
  if ('read_error' in stderr.receipt) validationErrors.push('stderr read');
  if (stderr.receipt['byte_length'] !== 0)
    validationErrors.push('stderr bytes');
  validationErrors.push(...validateBoot(boot, entry, pid));
  try {
    validationErrors.push(
      ...validateChild(receiptValue(child, 'child receipt'), entry, pid)
    );
  } catch (receiptError) {
    validationErrors.push(
      `child receipt: ${String(errorReceipt(receiptError)['message'])}`
    );
  }
  const protocolErrors = parseProtocol(stdout, entry);
  validationErrors.push(...protocolErrors);
  return {
    ordinal: entry.ordinal,
    nonce: entry.nonce,
    input: { byte_length: entry.byteLength, sha256: entry.sha256 },
    ...(pid === undefined ? {} : { pid }),
    arm,
    exited,
    exit_code: exitCode,
    signal,
    ...(error === undefined ? {} : { error }),
    stdout: stdout.receipt,
    stderr: stderr.receipt,
    boot_receipt: boot,
    child_receipt: child,
    protocol_parse: {
      status: protocolErrors.length === 0 ? 'ok' : 'error',
      errors: protocolErrors,
    },
    validation_errors: validationErrors,
  };
}

async function runBunChild(
  output: string,
  arm: Arm,
  entry: CorpusEntry,
  concurrentDrain: boolean
): Promise<Record<string, unknown>> {
  const paths = pathsFor(output, arm, entry);
  try {
    // No stdin option: this preserves the failing test's unspecified/inherited
    // stdin shape while the child receives its deterministic corpus over argv.
    const child = Bun.spawn([process.execPath, ...childArgs(paths, entry)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let exited: Record<string, unknown>;
    let stdout: CapturedBytes;
    let stderr: CapturedBytes;
    if (concurrentDrain) {
      // Timing-changing control only. A clean result cannot establish cause.
      const stdoutPromise = captureWebPipe(child.stdout);
      const stderrPromise = captureWebPipe(child.stderr);
      try {
        exited = { status: 'fulfilled', code: await child.exited };
      } catch (error) {
        exited = { status: 'rejected', error: errorReceipt(error) };
      }
      [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    } else {
      // The observed test awaits exited before touching either output pipe.
      try {
        exited = { status: 'fulfilled', code: await child.exited };
      } catch (error) {
        exited = { status: 'rejected', error: errorReceipt(error) };
      }
      stdout = await captureWebPipe(child.stdout);
      stderr = await captureWebPipe(child.stderr);
    }
    return collectRun(
      arm,
      entry,
      paths,
      child.pid,
      exited,
      typeof child.exitCode === 'number' ? child.exitCode : null,
      typeof child.signalCode === 'string' ||
        typeof child.signalCode === 'number'
        ? child.signalCode
        : null,
      stdout,
      stderr
    );
  } catch (error) {
    const empty: CapturedBytes = {
      bytes: new Uint8Array(),
      receipt: { byte_length: 0, sha256: sha256('') },
    };
    return collectRun(
      arm,
      entry,
      paths,
      undefined,
      { status: 'rejected', error: errorReceipt(error) },
      null,
      null,
      empty,
      empty,
      errorReceipt(error)
    );
  }
}

async function runNodeChild(
  output: string,
  entry: CorpusEntry
): Promise<Record<string, unknown>> {
  const arm: Arm = 'node-child-process';
  const paths = pathsFor(output, arm, entry);
  try {
    // node:child_process defaults stdin to a pipe, so inherited stdin is made
    // explicit to keep the parent boundary equivalent to the Bun arm.
    const child = spawnNode(process.execPath, childArgs(paths, entry), {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let exited: Record<string, unknown>;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let error: Record<string, unknown> | undefined;
    try {
      const closed = await once(child, 'close');
      exitCode = typeof closed[0] === 'number' ? closed[0] : null;
      signal = typeof closed[1] === 'string' ? closed[1] : null;
      exited = { status: 'fulfilled', code: exitCode };
    } catch (closeError) {
      error = errorReceipt(closeError);
      exited = { status: 'rejected', error };
    }
    // This also waits before draining, so producer selection remains the
    // intended comparison rather than output consumption order.
    const stdout = await captureNodePipe(child.stdout);
    const stderr = await captureNodePipe(child.stderr);
    return collectRun(
      arm,
      entry,
      paths,
      child.pid,
      exited,
      exitCode,
      signal,
      stdout,
      stderr,
      error
    );
  } catch (error) {
    const empty: CapturedBytes = {
      bytes: new Uint8Array(),
      receipt: { byte_length: 0, sha256: sha256('') },
    };
    return collectRun(
      arm,
      entry,
      paths,
      undefined,
      { status: 'rejected', error: errorReceipt(error) },
      null,
      null,
      empty,
      empty,
      errorReceipt(error)
    );
  }
}

async function runArm(
  output: string,
  arm: Arm,
  corpus: CorpusEntry[]
): Promise<Record<string, unknown>> {
  await mkdir(join(output, arm));
  const children: Record<string, unknown>[] = [];
  let stopReason: string | null = null;
  for (const entry of corpus) {
    const child =
      arm === 'node-child-process'
        ? await runNodeChild(output, entry)
        : await runBunChild(
            output,
            arm,
            entry,
            arm === 'bun-concurrent-drain-control'
          );
    children.push(child);
    const errors = child['validation_errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      stopReason = `ordinal ${entry.ordinal}: ${errors.join(', ')}`;
      break;
    }
  }
  return {
    id: arm,
    producer: arm === 'node-child-process' ? 'node:child_process' : 'Bun.spawn',
    stdin: 'unspecified/inherited',
    drain_order:
      arm === 'bun-concurrent-drain-control' ? 'concurrent' : 'after-exit',
    timing_changing_control: arm === 'bun-concurrent-drain-control',
    children,
    stop_reason: stopReason,
  };
}

function environmentReceipt(): Record<string, unknown> {
  return {
    runner_os: process.env['RUNNER_OS'] ?? process.platform,
    platform: process.platform,
    architecture: process.arch,
    kernel_release: os.release(),
    kernel_version: os.version(),
    bun_version: Bun.version,
    bun_revision: bunMetadata.revision ?? null,
    node_version: process.version,
    node_compat_version: process.versions.node,
  };
}

async function createOutputDirectory(output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
}

async function writeSummary(
  output: string,
  report: Record<string, unknown>
): Promise<void> {
  await writeFile(
    join(output, 'summary.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
}

async function runExperiment(options: {
  output: string;
  count: number;
  seed: string;
}): Promise<number> {
  await createOutputDirectory(options.output);
  const failures: string[] = [];
  if (process.versions.bun !== EXPECTED_BUN_VERSION) {
    failures.push(
      `parent Bun must be ${EXPECTED_BUN_VERSION}, received ${process.versions.bun ?? 'none'}`
    );
  }
  const corpus = makeCorpus(options.seed, options.count);
  const arms: Record<string, unknown>[] = [];
  if (failures.length === 0) {
    for (const arm of [
      'bun-exit-before-drain',
      'node-child-process',
      'bun-concurrent-drain-control',
    ] as const) {
      try {
        const report = await runArm(options.output, arm, corpus);
        arms.push(report);
        if (report['stop_reason'] !== null) {
          failures.push(`${arm}: ${String(report['stop_reason'])}`);
        }
      } catch (error) {
        const failure = errorReceipt(error);
        arms.push({ id: arm, fatal_error: failure });
        failures.push(`${arm}: ${String(failure['message'])}`);
      }
    }
  }
  const status = failures.length === 0 ? 'pass' : 'fail';
  await writeSummary(options.output, {
    schema: REPORT_SCHEMA,
    mode: 'experiment',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    environment: environmentReceipt(),
    seed: options.seed,
    count: options.count,
    corpus: corpus.map(({ ordinal, nonce, byteLength, sha256: hash }) => ({
      ordinal,
      nonce,
      byte_length: byteLength,
      sha256: hash,
    })),
    arms,
    unexpected_failures: failures,
    status,
  });
  console.log(JSON.stringify({ output: options.output, status }));
  return failures.length === 0 ? 0 : 1;
}

async function runFalsifier(options: {
  output: string;
  seed: string;
}): Promise<number> {
  await createOutputDirectory(options.output);
  const expected = makeCorpus(options.seed, 1)[0];
  if (!expected) throw new Error('falsifier corpus was empty');
  const valid = {
    schema: CHILD_SCHEMA,
    runtime: { kind: 'bun', bun_version: EXPECTED_BUN_VERSION },
    pid: 1,
    nonce: expected.nonce,
    ordinal: expected.ordinal,
    packet: {
      byte_length: expected.byteLength,
      sha256: expected.sha256,
      nonce: expected.nonce,
    },
    protocol: { nonce: expected.nonce, packet_sha256: expected.sha256 },
    stdin: { status: 'open' },
  };
  const corrupt = {
    ...valid,
    packet: { ...valid.packet, sha256: '0'.repeat(64) },
  };
  writeFileSync(
    join(options.output, 'valid-child-receipt.json'),
    `${JSON.stringify(valid, null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
    }
  );
  writeFileSync(
    join(options.output, 'corrupt-child-receipt.json'),
    `${JSON.stringify(corrupt, null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
    }
  );
  const errors = validateChild(corrupt, expected);
  const status = errors.length > 0 ? 'expected-failure' : 'unexpected-pass';
  await writeSummary(options.output, {
    schema: REPORT_SCHEMA,
    mode: 'falsifier',
    environment: environmentReceipt(),
    expected_failure: 'corrupted child packet hash must be rejected',
    validation_errors: errors,
    status,
  });
  console.log(JSON.stringify({ output: options.output, status }));
  // This command is expected to be red. The workflow checks that outcome in a
  // later step, so an unexpected zero means receipt corruption was accepted.
  return errors.length > 0 ? 1 : 0;
}

async function runChild(options: {
  boot: string;
  receipt: string;
  nonce: string;
  ordinal: number;
  packetBase64: string;
}): Promise<number> {
  writeFileSync(
    options.boot,
    `${JSON.stringify({
      schema: BOOT_SCHEMA,
      runtime: runtimeMetadata(),
      pid: process.pid,
      nonce: options.nonce,
      ordinal: options.ordinal,
      stdin: descriptorReceipt(),
    })}\n`,
    { encoding: 'utf8', flag: 'wx' }
  );
  try {
    const bytes = Buffer.from(options.packetBase64, 'base64');
    const packet = object(JSON.parse(bytes.toString('utf8')), 'child packet');
    if (
      packet['protocol'] !== 'relic-stdio-linux-ci-boundary-v1' ||
      packet['nonce'] !== options.nonce ||
      packet['ordinal'] !== options.ordinal
    ) {
      throw new Error('child packet did not match its nonce corpus entry');
    }
    const packetHash = sha256(bytes);
    writeFileSync(
      options.receipt,
      `${JSON.stringify({
        schema: CHILD_SCHEMA,
        runtime: runtimeMetadata(),
        pid: process.pid,
        nonce: options.nonce,
        ordinal: options.ordinal,
        packet: {
          byte_length: bytes.byteLength,
          sha256: packetHash,
          nonce: packet['nonce'],
        },
        protocol: { nonce: options.nonce, packet_sha256: packetHash },
        stdin: descriptorReceipt(),
      })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: options.ordinal,
        result: { nonce: options.nonce, packet_sha256: packetHash },
      })}\n`
    );
    return 0;
  } catch (error) {
    const failure = errorReceipt(error);
    try {
      writeFileSync(
        options.receipt,
        `${JSON.stringify({
          schema: CHILD_SCHEMA,
          status: 'error',
          pid: process.pid,
          nonce: options.nonce,
          ordinal: options.ordinal,
          error: failure,
        })}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
    } catch (receiptError) {
      process.stderr.write(
        `receipt write failed: ${String(errorReceipt(receiptError)['message'])}\n`
      );
    }
    process.stderr.write(
      `${String(failure['name'])}: ${String(failure['message'])}\n`
    );
    return 1;
  }
}

const args = process.argv.slice(2);
if (args[0] === '--child') {
  const options = parseOptions(args.slice(1));
  for (const key of options.keys()) {
    if (
      ![
        '--boot',
        '--receipt',
        '--nonce',
        '--ordinal',
        '--packet-base64',
      ].includes(key)
    ) {
      throw new Error(`unsupported child option ${key}`);
    }
  }
  const ordinal = Number(required(options, '--ordinal'));
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error('child ordinal must be a positive integer');
  }
  process.exitCode = await runChild({
    boot: resolve(required(options, '--boot')),
    receipt: resolve(required(options, '--receipt')),
    nonce: required(options, '--nonce'),
    ordinal,
    packetBase64: required(options, '--packet-base64'),
  });
} else {
  const options = parseOptions(args);
  for (const key of options.keys()) {
    if (!['--mode', '--output', '--count', '--seed'].includes(key)) {
      throw new Error(`unsupported option ${key}`);
    }
  }
  const mode = options.get('--mode') ?? 'experiment';
  const count = Number(options.get('--count') ?? MAX_CHILDREN);
  if (mode !== 'experiment' && mode !== 'falsifier')
    throw new Error(`unsupported mode ${mode}`);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHILDREN) {
    throw new Error(`count must be an integer from 1 through ${MAX_CHILDREN}`);
  }
  const output = resolve(required(options, '--output'));
  const seed = options.get('--seed') ?? 'stdio-linux-ci-boundary-v1';
  process.exitCode =
    mode === 'falsifier'
      ? await runFalsifier({ output, seed })
      : await runExperiment({ output, count, seed });
}
