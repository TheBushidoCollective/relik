/**
 * The environment a proof harness gives a spawned relic-mcp (PS2-11). The
 * operator's own RELIC_* settings never reach the child, so a proof reads and
 * writes only the scratch directory it names: never the operator's device keys,
 * metadata cache, publish state or service origin.
 */
import { join } from 'node:path';

export interface HarnessSettings {
  readonly serviceOrigin: string;
  readonly chromePath: string;
  readonly clientName: string;
}

/**
 * The child's environment: the inherited variables that are not RELIC_*, then
 * the harness's own RELIC_* settings, with the device keys and metadata cache
 * pinned inside the scratch directory.
 */
export function harnessEnv(
  scratchDir: string,
  statePath: string,
  settings: HarnessSettings
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('RELIC_')) {
      inherited[name] = value;
    }
  }
  return {
    ...inherited,
    RELIC_SERVICE_ORIGIN: settings.serviceOrigin,
    RELIC_PUBLISH_STATE: statePath,
    RELIC_DEVICE_KEYS: join(scratchDir, 'device-keys.json'),
    RELIC_METADATA_CACHE: join(scratchDir, 'metadata-cache.json'),
    RELIC_CHROME_PATH: settings.chromePath,
    RELIC_CLIENT_NAME: settings.clientName,
  };
}

/**
 * The reason a live probe must not run, when one of the operator-state paths
 * it would inherit already names a real file. Undefined when none does.
 */
export function operatorFileClash(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean
): string | undefined {
  for (const name of ['RELIC_DEVICE_KEYS', 'RELIC_METADATA_CACHE']) {
    const path = env[name];
    if (path !== undefined && path.length > 0 && exists(path)) {
      return `${name} names an existing file (${path}); unset it or name a path that does not exist`;
    }
  }
  return undefined;
}
