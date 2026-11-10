import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ObjectUploader = (
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array
) => Promise<{ readonly status: number }>;

export const UPLOAD_IDLE_TIMEOUT_MS = 120_000;
const UPLOAD_CHUNK_BYTES = 1024 * 1024;
// Node's setTimeout clamps larger delays to 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Send a signed object PUT without a whole-transfer deadline. At most one
 * 1 MiB view is queued at a time; drain and socket activity govern progress.
 */
export function createNodeUploader(
  idleTimeoutMs = UPLOAD_IDLE_TIMEOUT_MS
): ObjectUploader {
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs <= 0 ||
    idleTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `upload idle timeout must be an integer between 1 and ${MAX_TIMER_DELAY_MS} ms`
    );
  }

  return (url, headers, body) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (
        (target.protocol !== 'http:' && target.protocol !== 'https:') ||
        target.username.length > 0 ||
        target.password.length > 0
      ) {
        throw new Error('invalid object upload URL');
      }
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      let settled = false;
      let offset = 0;
      const req = request(target, { method: 'PUT', headers }, (response) => {
        const status = response.statusCode;
        response.on('error', fail);
        response.on('aborted', () =>
          fail(new Error('upload response aborted'))
        );
        response.resume();
        if (status === undefined) {
          fail(new Error('upload response has no status'));
          req.destroy();
          return;
        }
        if (status < 200 || status >= 300) {
          finish({ status });
          req.destroy();
          return;
        }
        if (!req.writableFinished) {
          fail(
            new Error(
              'upload server responded before the complete body was sent'
            )
          );
          req.destroy();
          return;
        }
        response.once('end', () => finish({ status }));
      });

      // Socket inactivity handles slow but progressing uploads. A separate
      // connection timer also covers DNS/TCP setup before a socket is active.
      const connectionTimer = setTimeout(() => {
        req.destroy(
          new Error(`upload connection idle for ${idleTimeoutMs} ms`)
        );
      }, idleTimeoutMs);
      const clearConnectionTimer = () => clearTimeout(connectionTimer);
      req.once('socket', (socket) => {
        if (socket.connecting) socket.once('connect', clearConnectionTimer);
        else clearConnectionTimer();
      });
      req.setTimeout(idleTimeoutMs, () => {
        req.destroy(new Error(`upload idle for ${idleTimeoutMs} ms`));
      });
      req.on('error', fail);

      function fail(error: Error): void {
        if (settled) return;
        settled = true;
        clearConnectionTimer();
        reject(error);
      }
      function finish(result: { readonly status: number }): void {
        if (settled) return;
        settled = true;
        clearConnectionTimer();
        resolve(result);
      }
      function send(): void {
        if (settled || req.destroyed) return;
        try {
          while (offset < body.length) {
            const end = Math.min(offset + UPLOAD_CHUNK_BYTES, body.length);
            const ready = req.write(body.subarray(offset, end));
            offset = end;
            if (!ready) {
              req.once('drain', send);
              return;
            }
          }
          req.end();
        } catch (error) {
          req.destroy(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      send();
    });
}

export const nodeUploader: ObjectUploader = createNodeUploader();

/** In-process tests only: fetch inherits Node's default 300-second header timeout. */
export function fetchUploader(
  fetchImpl: typeof globalThis.fetch
): ObjectUploader {
  return async (url, headers, body) => {
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers,
      body: body as unknown as BodyInit,
    });
    return { status: response.status };
  };
}
