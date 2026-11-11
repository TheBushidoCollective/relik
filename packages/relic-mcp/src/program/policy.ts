/**
 * Local program rendering policy: the env knobs, the frame size, the deadline,
 * and where the browser's confined storage comes from on each platform.
 *
 * Every knob here can only lower a gate, never raise one.
 */

import { fileURLToPath } from 'node:url';
import { PLAINTEXT_CAP_BYTES } from '@relic/format';

// build.ts substitutes this for the single-file dist bundle.
declare const __RELIC_PROGRAM_ASSET_BASE__: string | undefined;

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
 * The browser for program rendering: RELIC_OTIO_CHROME_PATH only, which must
 * name an isolated headless shell. Unset, the owned headless shell is used.
 * Never the cover's RELIC_CHROME_PATH, which can name full Chrome. `none` or
 * `disabled` turns program rendering off.
 */
export function programChromePathFrom(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env['RELIC_OTIO_CHROME_PATH'];
}

/** Only macOS has a verified operating-system jail for program rendering. */
export type ProgramProfileSource =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'private-ram-volume'; readonly sizeMiB: number };

export function programProfileSourceFrom(
  _env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): ProgramProfileSource {
  return platform === 'darwin'
    ? { kind: 'private-ram-volume', sizeMiB: PRIVATE_RAM_VOLUME_MIB }
    : { kind: 'unsupported' };
}

/** Built page files (index.html, index.js). RELIC_MCP_PROGRAM_DIR overrides. */
export function programAssetDir(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const override = env['RELIC_MCP_PROGRAM_DIR'];
  if (override !== undefined) return override;
  const base =
    typeof __RELIC_PROGRAM_ASSET_BASE__ === 'string'
      ? __RELIC_PROGRAM_ASSET_BASE__
      : '../../dist/program/';
  return fileURLToPath(new URL(base, import.meta.url));
}

/** Largest single media entry the page is given to render from. */
export const RENDER_INPUT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Largest total media the page is given to render from, across every entry. */
export const RENDER_INPUT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * The archive budget: the server's cap, lowered by RELIC_PROGRAM_MAX_BYTES when
 * that is set below it. The knob never raises the budget.
 */
export function programArchiveBudget(
  sizeLimit: number,
  policy: Pick<ProgramPolicy, 'maxBytes'>
): number {
  return Math.min(
    sizeLimit,
    PLAINTEXT_CAP_BYTES,
    policy.maxBytes ?? PLAINTEXT_CAP_BYTES
  );
}

/**
 * True when every media entry handed to the renderer fits the render input
 * bounds. The check is platform-independent and runs before any browser starts.
 */
export function programRenderInputWithinBounds(
  media: readonly { readonly size: number }[]
): boolean {
  let total = 0;
  for (const entry of media) {
    if (entry.size > RENDER_INPUT_MAX_ENTRY_BYTES) return false;
    total += entry.size;
    if (total > RENDER_INPUT_MAX_TOTAL_BYTES) return false;
  }
  return true;
}
