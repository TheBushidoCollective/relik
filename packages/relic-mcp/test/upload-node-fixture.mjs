import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ClientRequest, createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

// The Bun test harness transpiles the real uploader and sends it over stdin.
// Running it here exercises Node's HTTP, socket timeout, and teardown behavior.
let source = '';
for await (const chunk of process.stdin) source += chunk;
const { createNodeUploader } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loopbackServer(handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}/signed?token=test`;
    },
    async close() {
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

function observePausedRequest(req) {
  let received = 0;
  req.on('error', () => {});
  req.on('data', (chunk) => {
    received += chunk.length;
  });
  req.pause();
  const closed = new Promise((resolve) => {
    req.socket.once('close', () => {
      resolve({ complete: req.complete, received });
    });
  });
  return { req, closed };
}

async function slowActive() {
  const idleMs = 1_000;
  const readBytes = 32 * 1024;
  const body = Buffer.alloc(32 * 1024 * 1024);
  for (let i = 0; i < body.length; i += 4096) body[i] = i % 251;
  const expected = createHash('sha256').update(body).digest('hex');
  let received = 0;
  let actual;
  let contentLength;
  let readTimer;
  const server = loopbackServer((req, res) => {
    contentLength = req.headers['content-length'];
    const hash = createHash('sha256');
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('readable', () => {});
    req.once('end', () => {
      clearInterval(readTimer);
      actual = hash.digest('hex');
      res.writeHead(200).end();
    });
    // A fixed maximum per tick guarantees a paced transfer regardless of how
    // Node, Bun, or the host happens to coalesce socket reads.
    readTimer = setInterval(() => {
      const chunk = req.read(readBytes);
      if (chunk !== null) {
        received += chunk.length;
        hash.update(chunk);
      }
    }, 6);
  });
  const url = await server.listen();
  const writeTimes = [];
  const originalWrite = ClientRequest.prototype.write;
  ClientRequest.prototype.write = function (...args) {
    writeTimes.push(performance.now());
    return originalWrite.apply(this, args);
  };
  try {
    const started = performance.now();
    const result = await createNodeUploader(idleMs)(
      url,
      { 'content-length': String(body.length) },
      body
    );
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs > idleMs, `transfer lasted ${elapsedMs} ms`);
    assert.ok(writeTimes.length > 1);
    // The client must still be writing after the deadline, not merely waiting
    // for the server to drain a body already buffered by the kernel.
    const writeSpanMs = writeTimes[writeTimes.length - 1] - writeTimes[0];
    assert.ok(writeSpanMs > idleMs, `client writes spanned ${writeSpanMs} ms`);
    assert.deepEqual(result, { status: 200 });
    assert.equal(received, body.length);
    assert.equal(contentLength, String(body.length));
    assert.equal(actual, expected);
  } finally {
    clearInterval(readTimer);
    ClientRequest.prototype.write = originalWrite;
    await server.close();
  }
}

async function stalledUpload() {
  const accepted = deferred();
  const server = loopbackServer((req, res) => {
    res.on('error', () => {});
    accepted.resolve(observePausedRequest(req));
  });
  const url = await server.listen();
  try {
    const body = Buffer.alloc(32 * 1024 * 1024);
    const outcome = createNodeUploader(300)(
      url,
      { 'content-length': String(body.length) },
      body
    ).then(
      (result) => ({ result }),
      (error) => ({ error })
    );
    const incoming = await accepted.promise;
    const result = await outcome;
    assert.ok(result.error instanceof Error, 'stalled upload must reject');
    assert.match(result.error.message, /upload idle/);
    // Resume only after the client rejects, so the peer can observe closure
    // without giving the stalled upload a path to complete.
    incoming.req.resume();
    const closed = await incoming.closed;
    assert.equal(closed.complete, false);
    assert.ok(closed.received < body.length);
  } finally {
    await server.close();
  }
}

async function earlyRefusal() {
  const accepted = deferred();
  const server = loopbackServer((req, res) => {
    res.on('error', () => {});
    accepted.resolve(observePausedRequest(req));
    res.writeHead(403, { 'content-length': '0' }).end();
  });
  const url = await server.listen();
  try {
    const body = Buffer.alloc(32 * 1024 * 1024);
    const outcome = createNodeUploader(1_000)(
      url,
      { 'content-length': String(body.length) },
      body
    );
    const incoming = await accepted.promise;
    assert.deepEqual(await outcome, { status: 403 });
    incoming.req.resume();
    const closed = await incoming.closed;
    assert.equal(closed.complete, false);
    assert.ok(closed.received < body.length);
  } finally {
    await server.close();
  }
}

async function stalledResponse() {
  const closed = deferred();
  const server = loopbackServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    req.socket.once('close', () => closed.resolve());
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-length': '2' });
      res.write('a');
    });
  });
  const url = await server.listen();
  try {
    await assert.rejects(
      createNodeUploader(300)(url, { 'content-length': '1' }, Buffer.of(1)),
      /upload idle/
    );
    await closed.promise;
  } finally {
    await server.close();
  }
}

function timeoutValidation() {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => createNodeUploader(value), RangeError);
  }
  assert.equal(typeof createNodeUploader(1), 'function');
  assert.equal(typeof createNodeUploader(2_147_483_647), 'function');
}

const scenarios = { slowActive, stalledUpload, earlyRefusal, stalledResponse, timeoutValidation };
const scenario = scenarios[process.argv[2]];
assert.ok(scenario, `unknown upload scenario: ${process.argv[2]}`);
await scenario();
