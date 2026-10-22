/**
 * A controlled stdio EOF probe for the built Node MCP bundle.
 *
 * The request is deliberately written and ended with the same immediate Bun
 * FileSink sequence used by the OTIO path. The loopback comments response
 * remains held until both its GET is accepted and the preload reports physical
 * stdin EOF. Those events can arrive in either order. The probe then requires
 * the matching response and decrypted body before it accepts the child's zero
 * exit code.
 *
 * The optional RELIC_STDIO_EOF_SUPPRESS_RESPONSE=1 mode is a test-only
 * falsifier. It arms response suppression only after the loopback comments GET
 * is accepted. Once that held response is released, this script must fail with
 * a missing matching response even though the child exits zero.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKey, deriveCommentKey, encryptComment } from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  observeAwait,
  observeBegin,
  observeComplete,
  observeError,
  observeEvent,
} from '../../../scripts/full-suite-observation.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { loadPublishState } from '../src/state.ts';

const STAGE_TIMEOUT_MS = 15_000;
const TRACE_POLL_MS = 10;
const REQUEST_ID = `stdio-eof-read-${randomUUID()}`;
const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
const tapPath = fileURLToPath(
  new URL('./fixtures/stdio-eof-tap.mjs', import.meta.url)
);
const scratch = await observeAwait(
  'stdio-eof-probe',
  'bootstrap_scratch_mkdtemp',
  () => mkdtemp(join(tmpdir(), 'relic-stdio-eof-'))
);
const statePath = join(scratch, 'publish-state.json');
const tracePath = join(scratch, 'stdio-eof-trace.jsonl');
const suppressionMarker = join(scratch, 'response-suppression-armed');
const fixturePath = join(scratch, 'probe.md');
const suppressResponse =
  process.env['RELIC_STDIO_EOF_SUPPRESS_RESPONSE'] === '1';
const probeLifecycle = observeBegin('stdio-eof-probe', 'probe_lifecycle', {
  scratch_path: scratch,
  tap_trace_path: tracePath,
  suppress_response: suppressResponse,
});
observeEvent(
  'stdio-eof-probe',
  'probe-bootstrap',
  'bootstrap_paths',
  'complete',
  {
    scratch_path: scratch,
    tap_trace_path: tracePath,
    suppress_response: suppressResponse,
  }
);

interface TraceEvent {
  readonly origin: string;
  readonly event: string;
  readonly at: number;
  readonly sequence: number;
  readonly [key: string]: unknown;
}

interface CapturedResponse {
  readonly response: Record<string, unknown>;
  readonly stdout: string;
}

interface OwnedChild {
  kill(): void;
}

type CapturedMail =
  | { readonly kind: 'link'; readonly to: string; readonly link: string }
  | { readonly kind: 'mail'; readonly to: string; readonly mail: OutboundMail };

let parentSequence = 0;
const parentEvents: TraceEvent[] = [];
let activeChild: OwnedChild | undefined;
let activeExit: Promise<number> | undefined;
let activeStdoutDone: Promise<string> | undefined;
let activeStderr: Promise<string> | undefined;
let childExitCode: number | undefined;
let childStderr = '';
let commentsGetAccepted = false;
let commentsGetReleased = false;
let acceptCommentsGet: (() => void) | undefined;
let releaseCommentsGet: (() => void) | undefined;

function traceParent(
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const sequence = ++parentSequence;
  parentEvents.push({
    origin: 'parent',
    sequence,
    at: Date.now(),
    event,
    ...fields,
  });

  const observationFields: Record<string, boolean | number | string> = {
    parent_event: event,
  };
  for (const key of [
    'bytes',
    'total_bytes',
    'request_bytes',
    'write_result_type',
    'end_result_type',
    'physical_eof_already_observed',
    'suppress_response',
    'code',
    'sha256',
    'request_sha256',
  ]) {
    const value = fields[key];
    if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      observationFields[key] = value;
    }
  }
  if (typeof fields['path'] === 'string') {
    observationFields['path'] = fields['path'].split(/[?#]/, 1)[0] ?? '';
  }
  if ('error' in fields) observationFields['error_present'] = true;
  observeEvent(
    'stdio-eof-probe',
    `parent-trace-${sequence}`,
    'parent_trace',
    event.includes('error') ||
      event.includes('rejected') ||
      event.includes('threw')
      ? 'error'
      : 'complete',
    observationFields
  );
}

function textError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function traceEvents(): TraceEvent[] {
  let text: string;
  try {
    text = readFileSync(tracePath, 'utf8');
  } catch {
    return [];
  }

  const rows: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof parsed['origin'] === 'string' &&
        typeof parsed['event'] === 'string' &&
        typeof parsed['at'] === 'number' &&
        typeof parsed['sequence'] === 'number'
      ) {
        rows.push(parsed as TraceEvent);
      }
    } catch {
      // A synchronous append may be between polls. The next poll or final
      // snapshot sees the completed row.
    }
  }
  return rows;
}

function formatTrace(): string {
  const rows = [...parentEvents, ...traceEvents()].sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    if (left.origin !== right.origin)
      return left.origin.localeCompare(right.origin);
    return left.sequence - right.sequence;
  });
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

function waitForStage<T>(
  label: string,
  promise: Promise<T>,
  childExit: Promise<number>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`${label} was not observed before the probe deadline`))
      );
    }, STAGE_TIMEOUT_MS);

    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
    void childExit.then(
      (code) =>
        finish(() =>
          reject(
            new Error(`${label} was not observed before child exit=${code}`)
          )
        ),
      (error) => finish(() => reject(error))
    );
  });
}

function waitForTrace(
  label: string,
  predicate: (event: TraceEvent) => boolean,
  childExit: Promise<number>
): Promise<TraceEvent> {
  const existing = traceEvents().find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);

  return new Promise<TraceEvent>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(poll);
      action();
    };
    const inspect = (exitCode?: number): void => {
      const found = traceEvents().find(predicate);
      if (found !== undefined) {
        finish(() => resolve(found));
      } else if (exitCode !== undefined) {
        finish(() =>
          reject(
            new Error(`${label} was not observed before child exit=${exitCode}`)
          )
        );
      }
    };
    // Polled, not fs.watch: on Linux, Bun drops a change event that repeats
    // the last one emitted to a handler within 1 ms (path_watcher should_emit
    // in bun-v1.3.14 and bun-v1.4.3), so two appends that close together lose
    // the second wake-up and a row already on disk goes unseen until the next
    // unrelated write. A poll always sees a row that is already in the file.
    const schedulePoll = (): void => {
      poll = setTimeout(() => {
        inspect();
        if (!settled) schedulePoll();
      }, TRACE_POLL_MS);
    };
    timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`${label} was not observed before the probe deadline`))
      );
    }, STAGE_TIMEOUT_MS);
    void childExit.then(
      (code) => inspect(code),
      (error) => finish(() => reject(error))
    );
    inspect();
    if (!settled) schedulePoll();
  });
}

function captureStdout(
  stream: ReadableStream<Uint8Array>,
  expectedId: string
): {
  readonly matching: Promise<CapturedResponse>;
  readonly done: Promise<string>;
} {
  let resolveMatching: ((value: CapturedResponse) => void) | undefined;
  let rejectMatching: ((reason?: unknown) => void) | undefined;
  const matching = new Promise<CapturedResponse>((resolve, reject) => {
    resolveMatching = resolve;
    rejectMatching = reject;
  });
  // A timeout can intentionally stop awaiting this promise. Keep that from
  // becoming an unhandled rejection while cleanup closes the owned child.
  void matching.catch(() => {});

  let matched = false;
  let buffer = '';
  let stdout = '';
  const decoder = new TextDecoder();

  const examine = (): void => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response['id'] === expectedId && !matched) {
          matched = true;
          traceParent('matching_jsonrpc_response_received', {
            id: expectedId,
            bytes: new TextEncoder().encode(line).byteLength,
            sha256: sha256(new TextEncoder().encode(line)),
          });
          assert.ok(
            resolveMatching,
            'stdout matching-response resolver missing'
          );
          resolveMatching({ response, stdout });
        }
      } catch (error) {
        traceParent('stdout_non_json_line', { error: textError(error) });
      }
    }
  };

  const done = (async (): Promise<string> => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stdout += text;
        buffer += text;
        traceParent('stdout_chunk_received', {
          bytes: value.byteLength,
          sha256: sha256(value),
        });
        examine();
      }
      const tail = decoder.decode();
      stdout += tail;
      buffer += tail;
      examine();
      if (!matched) {
        assert.ok(rejectMatching, 'stdout matching-response rejecter missing');
        rejectMatching(
          new Error(`no matching JSON-RPC response for id=${expectedId}`)
        );
      }
      return stdout;
    } catch (error) {
      if (rejectMatching !== undefined) rejectMatching(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  void done.catch(() => {});
  return { matching, done };
}

async function settleActiveChild(): Promise<void> {
  if (activeChild !== undefined && childExitCode === undefined) {
    activeChild.kill();
  }
  if (activeExit !== undefined) {
    try {
      await activeExit;
    } catch {
      // The primary failure names the failed stage. This only closes our child.
    }
  }
  if (activeStdoutDone !== undefined) {
    try {
      await activeStdoutDone;
    } catch {
      // The primary failure names the failed stage. This only drains our child.
    }
  }
  if (activeStderr !== undefined) {
    try {
      childStderr = await activeStderr;
    } catch {
      // The primary failure names the failed stage. This only drains our child.
    }
  }
}

const mails: CapturedMail[] = [];
const store = new MemoryStore();
let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (handler === undefined)
      return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
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

let gatedRelicId: string | undefined;
let commentsAccepted!: Promise<void>;
let commentsRelease!: Promise<void>;

function resetCommentsGate(): void {
  commentsGetAccepted = false;
  commentsGetReleased = false;
  commentsAccepted = new Promise<void>((resolve) => {
    acceptCommentsGet = resolve;
  });
  commentsRelease = new Promise<void>((resolve) => {
    releaseCommentsGet = resolve;
  });
}

function releaseHeldComments(reason: string): void {
  if (commentsGetReleased) return;
  commentsGetReleased = true;
  traceParent('comments_get_released', { reason });
  releaseCommentsGet?.();
}

resetCommentsGate();

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  assert.equal(
    url.hostname,
    '127.0.0.1',
    `non-loopback request reached the probe service: ${url.hostname}`
  );

  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(relicId);
    if (bytes === undefined) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  if (url.pathname.endsWith('/mint')) {
    throw new Error('version:"*" must not issue a current-version mint');
  }
  if (
    gatedRelicId !== undefined &&
    url.pathname === `/api/relics/${gatedRelicId}/comments` &&
    request.method === 'GET'
  ) {
    commentsGetAccepted = true;
    const physicalEofAlreadyObserved = traceEvents().some(
      (event) => event.event === 'stdin_physical_eof'
    );
    traceParent('comments_get_accepted', {
      path: url.pathname,
      physical_eof_already_observed: physicalEofAlreadyObserved,
    });
    acceptCommentsGet?.();
    await commentsRelease;
  }
  return app.fetch(request);
};

try {
  const bundleExists = await observeAwait(
    'stdio-eof-probe',
    'bootstrap_bundle_exists',
    () => Bun.file(bundlePath).exists()
  );
  assert.ok(
    bundleExists,
    `built Node bundle is missing at ${bundlePath}; run bun run --cwd packages/relic-mcp build first`
  );
  await observeAwait('stdio-eof-probe', 'bootstrap_trace_write', () =>
    writeFile(tracePath, '')
  );
  await observeAwait('stdio-eof-probe', 'bootstrap_fixture_write', () =>
    writeFile(fixturePath, '# stdio EOF probe\n')
  );
  process.env['RELIC_PUBLISH_STATE'] = statePath;

  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    fetch: globalThis.fetch,
    clientName: 'relic-mcp/stdio-eof-path',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'stdio EOF probe',
    }),
  };

  const published = await publish({ path: fixturePath, cover: false }, deps);
  const relicId = published.relic_id;
  gatedRelicId = relicId;
  const localState = await loadPublishState(relicId);
  assert.ok(
    localState,
    'publish did not leave local state for the fresh child'
  );

  const bodyNonce = `stdio-eof-comment-${randomUUID()}`;
  const commentKey = await deriveCommentKey(decodeKey(localState.key));
  const ciphertext = await encryptComment(commentKey, {
    body: bodyNonce,
    display_name: 'EOF probe',
    anchor: null,
  });
  const commentResponse = await fetch(
    `${origin}/api/relics/${relicId}/comments`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publish_token: localState.publish_token,
        ciphertext,
      }),
    }
  );
  assert.equal(commentResponse.status, 201, 'encrypted comment seed failed');

  const storedRows = await store.listComments(relicId);
  assert.equal(storedRows.length, 1);
  assert.equal(storedRows[0]?.ciphertext, ciphertext);
  assert.notEqual(storedRows[0]?.ciphertext, bodyNonce);
  assert.ok(!storedRows[0]?.ciphertext.includes(bodyNonce));
  assert.equal(mails.length, 0, 'probe must not send captured mail');

  const requestLine = `${JSON.stringify({
    jsonrpc: '2.0',
    id: REQUEST_ID,
    method: 'tools/call',
    params: {
      name: 'relic_read_comments',
      arguments: { relic_id: relicId, version: '*' },
    },
  })}\n`;
  const requestBytes = new TextEncoder().encode(requestLine);
  const requestSha256 = sha256(requestBytes);

  const nodeChildSpawn = observeBegin('stdio-eof-probe', 'node_child_spawn', {
    tap_trace_path: tracePath,
    suppress_response: suppressResponse,
  });
  const child = Bun.spawn(['node', '--import', tapPath, bundlePath], {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_CHROME_PATH: 'none',
      RELIC_MCP_HTTP: '0',
      RELIC_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_STDIO_EOF_SUPPRESS_MARKER: suppressionMarker,
      RELIC_STDIO_EOF_SUPPRESS_RESPONSE: suppressResponse ? '1' : '0',
      RELIC_STDIO_EOF_TRACE: tracePath,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  observeComplete(nodeChildSpawn, {
    owned_child_pid: child.pid,
    tap_trace_path: tracePath,
    suppress_response: suppressResponse,
  });
  activeChild = child;
  const stdin = child.stdin;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  assert.ok(stdin, 'Node probe child did not expose stdin');
  assert.ok(stdoutStream, 'Node probe child did not expose stdout');
  assert.ok(stderrStream, 'Node probe child did not expose stderr');

  const stdout = captureStdout(stdoutStream, REQUEST_ID);
  activeStdoutDone = stdout.done;
  const childStderrText = new Response(stderrStream).text().then((text) => {
    childStderr = text;
    return text;
  });
  activeStderr = childStderrText;
  const childExit = child.exited.then((code) => {
    childExitCode = code;
    traceParent('child_exit_observed', { code });
    return code;
  });
  activeExit = childExit;
  try {
    const writeResult = stdin.write(requestLine);
    const endResult = stdin.end();
    traceParent('stdin_write_end_called', {
      request_bytes: requestBytes.byteLength,
      request_sha256: requestSha256,
      write_result_type: typeof writeResult,
      end_result_type: typeof endResult,
    });
    void Promise.resolve(writeResult).then(
      () => traceParent('stdin_write_completed'),
      (error) =>
        traceParent('stdin_write_rejected', { error: textError(error) })
    );
    void Promise.resolve(endResult).then(
      () => traceParent('stdin_end_completed'),
      (error) => traceParent('stdin_end_rejected', { error: textError(error) })
    );
  } catch (error) {
    traceParent('stdin_write_or_end_threw', { error: textError(error) });
    throw error;
  }

  await waitForTrace(
    'exact request delivery',
    (event) =>
      event.event === 'stdin_chunk' &&
      event['total_bytes'] === requestBytes.byteLength &&
      event['sha256'] === requestSha256,
    childExit
  );
  const physicalEof = waitForTrace(
    'physical stdin EOF',
    (event) => event.event === 'stdin_physical_eof',
    childExit
  );
  const commentsGetStarted = waitForTrace(
    'comments GET start',
    (event) =>
      event.event === 'comments_get_started' &&
      event['path'] === `/api/relics/${relicId}/comments`,
    childExit
  );
  await commentsGetStarted;
  await waitForStage('comments GET acceptance', commentsAccepted, childExit);
  await physicalEof;
  assert.equal(commentsGetAccepted, true);
  assert.equal(
    commentsGetReleased,
    false,
    'loopback comments GET was released before both EOF and GET acceptance'
  );
  traceParent('eof_and_comments_get_accepted_before_release');

  if (suppressResponse) {
    await writeFile(suppressionMarker, 'accepted-gated-request\n');
    traceParent('response_suppression_armed');
  }
  releaseHeldComments('physical_eof_and_comments_get_accepted');

  const captured = await waitForStage(
    `matching JSON-RPC response for id=${REQUEST_ID}`,
    stdout.matching,
    childExit
  );
  assert.equal(captured.response['id'], REQUEST_ID);
  assert.equal(captured.response['error'], undefined);
  const result = captured.response['result'] as Record<string, unknown>;
  assert.ok(result && typeof result === 'object', 'response omitted result');
  assert.equal(result['isError'], false, JSON.stringify(result['content']));
  const structured = result['structuredContent'] as Record<string, unknown>;
  assert.ok(
    structured && typeof structured === 'object',
    'response omitted structured comment content'
  );
  assert.equal(structured['count'], 1);
  assert.equal(structured['version_scope'], 'all');
  const comments = structured['comments'];
  assert.ok(Array.isArray(comments), 'response omitted decrypted comments');
  const returnedComment = comments[0] as Record<string, unknown> | undefined;
  assert.equal(returnedComment?.['body'], bodyNonce);
  assert.equal(returnedComment?.['readable'], true);

  await waitForTrace(
    'stdio reader EOF after response write attempt',
    (event) =>
      event.event === 'stdin_reader_eof' &&
      event['total_bytes'] === requestBytes.byteLength &&
      event['sha256'] === requestSha256,
    childExit
  );
  const [exit, stderr] = await Promise.all([childExit, childStderrText]);
  assert.equal(exit, 0, `Node MCP exited ${exit}: ${stderr}`);
  assert.equal(stderr, '');
  const stdoutText = await stdout.done;
  assert.equal(stdoutText, captured.stdout);

  const finalTrace = traceEvents();
  assert.ok(
    finalTrace.some((event) => event.event === 'stdout_write_attempt'),
    'child never attempted to write a JSON-RPC response'
  );
  assert.ok(
    finalTrace.some((event) => event.event === 'stdout_write_callback'),
    'tap did not record the child stdout write callback'
  );
  assert.equal(
    finalTrace.some(
      (event) =>
        event.event === 'stdout_write_callback' && event['error'] !== null
    ),
    false,
    'child stdout write callback reported an error'
  );
  assert.ok(
    finalTrace.some(
      (event) => event.event === 'process_exit' && event['code'] === 0
    ),
    'tap did not record child process exit 0'
  );
  assert.equal(mails.length, 0, 'read must not send captured mail');
  observeEvent(
    'stdio-eof-probe',
    'tap-trace-finalization',
    'tap_trace_finalized',
    'complete',
    { tap_trace_path: tracePath }
  );
  observeComplete(probeLifecycle);

  console.log(
    `STDIO_EOF_PROBE bytes=${requestBytes.byteLength} sha256=${requestSha256} response_id=${REQUEST_ID} nonce_decrypted=true exit=${exit}`
  );
  console.log('STDIO_EOF_PATH_OK');
} catch (error) {
  observeError(probeLifecycle, error);
  await settleActiveChild();
  throw new Error(
    `${textError(error)}\nchild_exit=${childExitCode ?? 'unobserved'} stderr=${JSON.stringify(childStderr)}\ntrace:\n${formatTrace()}`
  );
} finally {
  releaseHeldComments('cleanup');
  await settleActiveChild();
  service.stop(true);
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
}
