/** Entry point. Cloud Run supplies PORT. */

import { createApp, type RelicApp } from './app.ts';
import { diskAssets } from './assets.ts';
import { assertConfig, DEFAULT_CONFIG, type RelicConfig } from './config.ts';
import {
  createErrorReporter,
  type ErrorReporter,
  serverErrorResponse,
} from './error-report.ts';
import {
  gcsStorage,
  metadataAccessToken,
  metadataSigner,
  privateKeySigner,
} from './gcs.ts';
import { gcsStore } from './gcsstore.ts';
import { mailerFromEnv } from './mail.ts';
import { createPresenceRelay, type PresenceSocketData } from './presence.ts';
import { MemoryStorage, type ObjectStorage } from './storage.ts';
import { MemoryStore, type RelicStore } from './store.ts';

/**
 * Real storage when credentials are present, memory otherwise.
 *
 * The fallback is loud, and in production it is refused outright. A service
 * that silently serves from memory looks healthy, accepts publishes, and
 * loses every relic on restart, which is a failure the recipient discovers
 * rather than the operator.
 */
async function resolveStorage(): Promise<ObjectStorage> {
  const bucket = process.env['RELIC_GCS_BUCKET'];
  const prefix = process.env['RELIC_GCS_PREFIX'];

  if (bucket) {
    // A downloaded key is the development path only. On Cloud Run the
    // signature comes from the IAM Credentials API using the attached
    // identity, so no key material exists in the deployment at all.
    const clientEmail = process.env['RELIC_GCS_CLIENT_EMAIL'];
    // Secret managers commonly hand back the PEM with escaped newlines.
    const privateKey = process.env['RELIC_GCS_PRIVATE_KEY']?.replace(
      /\\n/g,
      '\n'
    );

    const signer =
      clientEmail && privateKey
        ? privateKeySigner(clientEmail, privateKey)
        : await metadataSigner();

    return gcsStorage({ bucket, signer, ...(prefix ? { prefix } : {}) });
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'RELIC_GCS_BUCKET is required in production. Refusing to start on ' +
        'memory storage.'
    );
  }

  console.warn(
    'relic: no GCS credentials, using in-memory storage. Every relik is lost ' +
      'on restart.'
  );
  return new MemoryStorage();
}

/**
 * The relic rows, which are as load-bearing as the ciphertext.
 *
 * `resolveStorage` above already refuses to serve the bytes from memory in
 * production, for a reason it states plainly: a service that does looks
 * healthy, accepts publishes, and loses everything on restart. That reasoning
 * was never applied here, so production ran on `MemoryStore` and a relic
 * existed only inside the instance that minted it. Deploys, scale to zero, and
 * a request landing on a sibling instance all produced `relic_not_found`
 * against ciphertext that was sitting in the bucket the whole time.
 *
 * Same rule as storage now: real store when the bucket is configured, memory
 * only outside production, and a refusal rather than a quiet downgrade.
 */
async function resolveStore(): Promise<RelicStore> {
  const bucket = process.env['RELIC_GCS_BUCKET'];

  // The metadata server is what supplies the bearer token, so this path is
  // available exactly where the deployment runs. A downloaded key would need a
  // JWT exchange to become a token, and development does not need one.
  const onCloudRun = !process.env['RELIC_GCS_CLIENT_EMAIL'];

  if (bucket && onCloudRun) {
    return gcsStore({
      bucket,
      getAccessToken: () => metadataAccessToken(),
      ...(process.env['RELIC_GCS_PREFIX']
        ? { ciphertextPrefix: process.env['RELIC_GCS_PREFIX'] }
        : {}),
      ...(process.env['RELIC_STORE_PREFIX']
        ? { prefix: process.env['RELIC_STORE_PREFIX'] }
        : {}),
    });
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'A durable relik store is required in production. Refusing to start on ' +
        'an in-memory store: every relik would be lost on the next revision, ' +
        'and invisible to every other instance before then.'
    );
  }

  console.warn(
    'relic: no durable store, using memory. Reliks do not survive a restart ' +
      'and are invisible across instances.'
  );
  return new MemoryStore();
}

/**
 * `name:secret` pairs, comma separated.
 *
 * Per-operator rather than one shared token, because every delete writes an
 * audit record naming the operator and a shared token makes that record a
 * fiction.
 */
function parseOperatorTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const [name, secret] = pair.split(':');
    if (name && secret) tokens.set(name.trim(), secret.trim());
  }
  return tokens;
}

export type RelicRole = 'service' | 'presence' | 'all';

function roleFromEnv(): RelicRole {
  const role = process.env['RELIC_ROLE'] ?? 'service';
  if (role !== 'service' && role !== 'presence' && role !== 'all') {
    throw new Error(`Invalid RELIC_ROLE: ${role}`);
  }
  return role;
}

/** Shared by the entry point and loopback integration tests. */
export function startRelicServer(options: {
  readonly port: number;
  readonly config: RelicConfig;
  readonly app?: RelicApp;
  readonly role?: RelicRole;
  readonly errorReporter?: ErrorReporter | undefined;
}): Bun.Server<PresenceSocketData> {
  const role = options.role ?? roleFromEnv();
  if (role !== 'presence' && options.app === undefined) {
    throw new Error('The service role requires an app');
  }
  const app = options.app;
  if (role === 'service') {
    if (app === undefined) throw new Error('The service role requires an app');
    return Bun.serve<PresenceSocketData>({
      port: options.port,
      fetch: app.fetch,
    });
  }
  const relay = createPresenceRelay(options.config);
  const reporter =
    options.errorReporter ??
    createErrorReporter({ revision: options.config.revision });
  return Bun.serve<PresenceSocketData>({
    port: options.port,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/presence/')) {
        try {
          return relay.fetch(request, server);
        } catch (error) {
          return serverErrorResponse(
            error,
            'GET',
            '/api/presence/room',
            options.config.revision,
            reporter
          );
        }
      }
      if (role === 'all' && app !== undefined) return app.fetch(request);
      if (path === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok' });
      }
      return new Response('Not found', { status: 404 });
    },
    websocket: relay.websocket,
  });
}

if (import.meta.main) {
  const role = roleFromEnv();
  const config: RelicConfig = {
    ...DEFAULT_CONFIG,
    serviceOrigin:
      process.env['RELIC_SERVICE_ORIGIN'] ?? 'http://localhost:8080',
    usercontentOrigin:
      process.env['RELIC_USERCONTENT_ORIGIN'] ?? 'http://localhost:8081',
    revision: process.env['RELIC_REVISION'] || undefined,
    killSwitchEngaged: process.env['RELIC_KILL_SWITCH'] === 'true',
    ...(process.env['RELIC_TRUSTED_PROXY_HOPS'] !== undefined
      ? { trustedProxyHops: Number(process.env['RELIC_TRUSTED_PROXY_HOPS']) }
      : {}),
  };
  assertConfig(config);
  let app: RelicApp | undefined;
  if (role !== 'presence') {
    const mailer = mailerFromEnv(process.env);
    app = createApp({
      config,
      acceptErrorReports: process.env['RELIC_ACCEPT_ERROR_REPORTS'] !== 'false',
      storage: await resolveStorage(),
      store: await resolveStore(),
      assets: diskAssets(
        process.env['RELIC_ASSET_ROOT'] ??
          new URL('../../relic-viewer/dist/', import.meta.url).pathname
      ),
      operatorTokens: parseOperatorTokens(process.env['RELIC_OPERATOR_TOKENS']),
      ...(mailer === undefined ? {} : { mailer }),
    });
  }
  const port = Number(process.env['PORT'] ?? 8080);
  startRelicServer({
    port,
    config,
    role,
    ...(app === undefined ? {} : { app }),
  });
  console.log(`relik ${role} listening on :${port}`);
}

export { createApp };
