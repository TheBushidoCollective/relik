/**
 * Local program rendering policy: the env knobs, the frame size, the deadline,
 * and where the browser's confined storage comes from on each platform.
 *
 * Every knob here can only lower a gate, never raise one.
 */

import { fileURLToPath } from 'node:url';

/** Frame size requested for every timeline. Inside the page's bounds. */
export const PROGRAM_WIDTH = 1280;
export const PROGRAM_HEIGHT = 720;

/** Whole-batch deadline for rendering every timeline of one publish. */
export const PROGRAM_DEADLINE_MS = 10 * 60_000;

/** Size of the macOS RAM volume that holds the browser profile. */
export const PRIVATE_RAM_VOLUME_MIB = 256;

export interface ProgramPolicy {
  /** Lowers the aggregate cap below the server's size limit. Never raises it. */
  readonly maxBytes?: number | undefined;
  /** Proof knob: make the page report its encoder as absent. */
  readonly forceEncoderAbsent: boolean;
  /** A configuration error. Publishing refuses with this exact reason. */
  readonly invalid?: string | undefined;
}

export function programPolicyFrom(
  env: Readonly<Record<string, string | undefined>>
): ProgramPolicy {
  const raw = env['RELIC_PROGRAM_MAX_BYTES'];
  let maxBytes: number | undefined;
  let invalid: string | undefined;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(n) || n <= 0) {
      invalid = 'RELIC_PROGRAM_MAX_BYTES must be a positive integer';
    } else {
      maxBytes = n;
    }
  }
  return {
    maxBytes,
    forceEncoderAbsent: env['RELIC_PROGRAM_ENCODER_OFF'] === '1',
    invalid,
  };
}

/**
 * The browser for program rendering: RELIC_OTIO_CHROME_PATH, then the cover's
 * RELIC_CHROME_PATH, then per-platform discovery. `none` or `disabled` turns
 * program rendering off.
 */
export function programChromePathFrom(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env['RELIC_OTIO_CHROME_PATH'] ?? env['RELIC_CHROME_PATH'];
}

/**
 * The Linux directory that must be a verified tmpfs mount. A per-publish
 * directory is created inside it and removed afterwards.
 */
export function programProfileDirFrom(
  env: Readonly<Record<string, string | undefined>>
): string {
  return env['RELIC_PROGRAM_PROFILE_DIR'] ?? env['XDG_RUNTIME_DIR'] ?? '';
}

/**
 * Where the browser's confined storage comes from. On macOS, a private RAM
 * volume this process creates and releases. On Linux, a per-publish directory
 * inside a verified tmpfs mount. Anywhere else, there is no source.
 */
export type ProgramProfileSource =
  | { readonly kind: 'directory'; readonly dir: string }
  | { readonly kind: 'private-ram-volume'; readonly sizeMiB: number };

export function programProfileSourceFrom(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): ProgramProfileSource {
  if (platform === 'darwin') {
    return { kind: 'private-ram-volume', sizeMiB: PRIVATE_RAM_VOLUME_MIB };
  }
  return { kind: 'directory', dir: programProfileDirFrom(env) };
}

/** Built page files (index.html, index.js). RELIC_MCP_PROGRAM_DIR overrides. */
export function programAssetDir(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const override = env['RELIC_MCP_PROGRAM_DIR'];
  if (override !== undefined) return override;
  return fileURLToPath(new URL('../../dist/program/', import.meta.url));
}
