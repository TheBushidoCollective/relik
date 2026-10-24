import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';

const tracePath = process.env.RELIC_STDIO_EOF_TRACE;
if (typeof tracePath !== 'string' || tracePath.length === 0) {
  throw new Error('RELIC_STDIO_EOF_TRACE must name the probe scratch JSONL file');
}

const suppressResponse = process.env.RELIC_STDIO_EOF_SUPPRESS_RESPONSE === '1';
const suppressionMarker = process.env.RELIC_STDIO_EOF_SUPPRESS_MARKER;
let sequence = 0;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function digest(chunks) {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

function trace(event, fields = {}) {
  appendFileSync(
    tracePath,
    `${JSON.stringify({
      origin: 'tap',
      pid: process.pid,
      sequence: ++sequence,
      at: Date.now(),
      event,
      ...fields,
    })}\n`,
    'utf8'
  );
}

function bytesFor(chunk, encoding) {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  return Buffer.from(chunk);
}

function wrapReader(reader) {
  const chunks = [];
  let totalBytes = 0;

  return {
    get closed() {
      return reader.closed;
    },
    read(...args) {
      return reader.read(...args).then(
        (result) => {
          if (result.done) {
            trace('stdin_reader_eof', {
              total_bytes: totalBytes,
              sha256: digest(chunks),
            });
            return result;
          }

          const bytes = Buffer.from(result.value);
          chunks.push(bytes);
          totalBytes += bytes.byteLength;
          trace('stdin_chunk', {
            bytes: bytes.byteLength,
            total_bytes: totalBytes,
            sha256: digest(chunks),
          });
          return result;
        },
        (error) => {
          trace('stdin_reader_error', { error: errorText(error) });
          throw error;
        }
      );
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
    releaseLock() {
      return reader.releaseLock();
    },
  };
}

function wrapReadable(stream) {
  return {
    get locked() {
      return stream.locked;
    },
    getReader(...args) {
      const reader = stream.getReader(...args);
      trace('stdin_reader_attached');
      return wrapReader(reader);
    },
  };
}

const realToWeb = Readable.toWeb;
Readable.toWeb = function tappedToWeb(readable, options) {
  const stream = realToWeb.call(Readable, readable, options);
  if (readable !== process.stdin) return stream;

  // The real adapter owns stdin consumption. The listener is intentionally
  // attached after that adapter exists and never reads or resumes stdin.
  trace('stdin_to_web_created');
  process.stdin.once('end', () => {
    trace('stdin_physical_eof');
  });
  process.stdin.once('error', (error) => {
    trace('stdin_physical_error', { error: errorText(error) });
  });
  return wrapReadable(stream);
};

const realFetch = globalThis.fetch;
globalThis.fetch = function tappedFetch(input, init) {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url
  );
  if (
    url.pathname.startsWith('/api/relics/') &&
    url.pathname.endsWith('/comments') &&
    (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'GET'
  ) {
    trace('comments_get_started', { path: url.pathname });
  }
  return realFetch.call(globalThis, input, init);
};

const realStdoutWrite = process.stdout.write;
process.stdout.write = function tappedStdoutWrite(chunk, encoding, callback) {
  let actualEncoding = encoding;
  let originalCallback = callback;
  if (typeof encoding === 'function') {
    originalCallback = encoding;
    actualEncoding = undefined;
  }

  const bytes = bytesFor(chunk, actualEncoding);
  const details = {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  trace('stdout_write_attempt', details);

  if (suppressResponse && typeof suppressionMarker === 'string' && existsSync(suppressionMarker)) {
    trace('stdout_write_suppressed', details);
    if (typeof originalCallback === 'function') {
      originalCallback();
    }
    return true;
  }

  const onWrite = (error) => {
    trace('stdout_write_callback', {
      ...details,
      error: error === undefined || error === null ? null : errorText(error),
    });
    if (typeof originalCallback === 'function') originalCallback(error);
  };

  if (typeof actualEncoding === 'string') {
    return realStdoutWrite.call(this, chunk, actualEncoding, onWrite);
  }
  return realStdoutWrite.call(this, chunk, onWrite);
};

process.stdout.once('error', (error) => {
  trace('stdout_error', { error: errorText(error) });
});
process.once('exit', (code) => {
  trace('process_exit', { code });
});
trace('tap_ready', { suppress_response: suppressResponse });
