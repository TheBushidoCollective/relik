import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const SOURCE_CONTROL_TIMEOUT_MS = 120_000;
const MAX_SOURCE_OUTPUT_BYTES = 32 * 1024;
const otioPath = fileURLToPath(new URL('./otio-path.ts', import.meta.url));

type ControlMode = '--negative-source' | '--smoke';
type WrapperMode = 'strip-headless' | 'substitute-profile';

interface SourceControlResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

function controlMode(argv: readonly string[]): ControlMode {
  if (argv.length !== 1) {
    throw new Error(
      'usage: bun packages/relic-mcp/test/otio-browser-controls.ts --smoke|--negative-source'
    );
  }
  const mode = argv[0];
  if (mode !== '--smoke' && mode !== '--negative-source') {
    throw new Error(
      'usage: bun packages/relic-mcp/test/otio-browser-controls.ts --smoke|--negative-source'
    );
  }
  return mode;
}

async function configuredChrome(): Promise<string> {
  const requested = process.env['RELIC_OTIO_CHROME_PATH'];
  if (!requested || requested === 'none' || requested === 'disabled') {
    throw new Error(
      'RELIC_OTIO_CHROME_PATH must name the owned Chrome executable'
    );
  }
  const found = await discoverChrome(requested);
  if (found.kind !== 'found') {
    throw new Error('RELIC_OTIO_CHROME_PATH did not resolve to an executable');
  }
  return found.path;
}

async function smoke(): Promise<void> {
  const executable = await configuredChrome();
  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-browser-smoke-'));
  let child: ChildProcess | undefined;
  let connection: CdpConnection | undefined;

  try {
    const launch = createBrowserHeadlessLaunch(
      chromeArgs(executable, profile),
      profile
    );
    child = spawn(executable, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    const toChrome = child.stdio[3];
    const fromChrome = child.stdio[4];
    assert.ok(
      toChrome instanceof Writable,
      'Chrome fd 3 did not expose a writable debug pipe'
    );
    assert.ok(
      fromChrome instanceof Readable,
      'Chrome fd 4 did not expose a readable debug pipe'
    );
    connection = connectPipe(toChrome, fromChrome);
    await attestBrowserHeadless(connection, launch);
    console.log('OTIO_HEADLESS_SMOKE_OK');
  } finally {
    if (child !== undefined) {
      await cleanupOwnedBrowserStartup({
        child,
        connection,
        forgetChild: undefined,
        profile,
        removeProfile: undefined,
      });
    } else {
      await rm(profile, { recursive: true, force: true });
    }
  }
}

function wrapperSource(): string {
  return `#!/usr/bin/env bash
set -eu

executable="\${RELIC_OTIO_CONTROL_REAL_CHROME:-}"
mode="\${RELIC_OTIO_CONTROL_WRAPPER_MODE:-}"
profile="\${RELIC_OTIO_CONTROL_WRAPPER_PROFILE:-}"
if [[ -z "$executable" ]]; then
  exit 127
fi
case "$mode" in
  strip-headless|substitute-profile) ;;
  *) exit 127 ;;
esac

args=()
substituted=0
for arg in "$@"; do
  if [[ "$mode" == "strip-headless" ]]; then
    case "$arg" in
      --headless|--headless=new) continue ;;
    esac
  elif [[ "$arg" == --user-data-dir=* ]]; then
    if [[ -z "$profile" ]]; then
      exit 127
    fi
    arg="--user-data-dir=$profile"
    substituted=1
  fi
  args+=("$arg")
done
if [[ "$mode" == "substitute-profile" && "$substituted" -ne 1 ]]; then
  exit 126
fi
exec "$executable" "\${args[@]}"
`;
}

async function writeWrapper(
  scratch: string,
  mode: WrapperMode
): Promise<string> {
  const name =
    mode === 'strip-headless'
      ? 'relic-headless-lookalike.sh'
      : 'relic-profile-substitution.sh';
  const path = join(scratch, name);
  await writeFile(path, wrapperSource(), { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function captureSourceOutput(child: ChildProcess): () => string {
  const chunks: Buffer[] = [];
  let length = 0;
  const append = (chunk: Buffer): void => {
    if (length >= MAX_SOURCE_OUTPUT_BYTES) return;
    const remaining = MAX_SOURCE_OUTPUT_BYTES - length;
    const captured =
      chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    chunks.push(captured);
    length += captured.length;
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => Buffer.concat(chunks).toString('utf8');
}

async function runSourceControl(
  executable: string,
  wrapper: string,
  mode: WrapperMode,
  replacementProfile: string | undefined,
  scratch: string
): Promise<SourceControlResult> {
  const workingDirectory = await mkdtemp(join(scratch, `${mode}-source-`));
  const child = spawn(process.execPath, [otioPath], {
    cwd: workingDirectory,
    env: {
      ...process.env,
      RELIC_OTIO_CHROME_PATH: wrapper,
      RELIC_OTIO_CONTROL_REAL_CHROME: executable,
      RELIC_OTIO_CONTROL_WRAPPER_MODE: mode,
      ...(replacementProfile === undefined
        ? {}
        : { RELIC_OTIO_CONTROL_WRAPPER_PROFILE: replacementProfile }),
      RELIC_OTIO_PATH_CLIENT: 'source',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureSourceOutput(child);
  const { promise, resolve } = Promise.withResolvers<SourceControlResult>();
  let timedOut = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ exitCode, output: output(), signal, timedOut });
  };

  child.once('error', () => finish(null, null));
  child.once('close', (code, signal) => finish(code, signal));
  timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, SOURCE_CONTROL_TIMEOUT_MS);

  return promise;
}

function assertRejectedAtAttestation(
  result: SourceControlResult,
  expectedCode: 'missing-headless' | 'profile-mismatch'
): void {
  assert.equal(
    result.timedOut,
    false,
    `source control timed out before ${expectedCode} was observed`
  );
  assert.notEqual(
    result.exitCode,
    0,
    `source control completed instead of rejecting ${expectedCode}`
  );
  assert.ok(
    result.output.includes(expectedCode),
    `source control did not report ${expectedCode} from browser attestation`
  );
}

async function negativeSource(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('--negative-source is Linux CI only');
  }
  if (!process.env['DISPLAY'] || !process.env['XAUTHORITY']) {
    throw new Error('--negative-source requires a private xvfb-run display');
  }

  const executable = await configuredChrome();
  const scratch = await mkdtemp(join(tmpdir(), 'relic-otio-browser-controls-'));
  try {
    const headedWrapper = await writeWrapper(scratch, 'strip-headless');
    const headed = await runSourceControl(
      executable,
      headedWrapper,
      'strip-headless',
      undefined,
      scratch
    );
    assertRejectedAtAttestation(headed, 'missing-headless');
    console.log('OTIO_HEADED_REJECTED');

    const mismatchedProfile = await mkdtemp(
      join(scratch, 'substituted-profile-')
    );
    const profileWrapper = await writeWrapper(scratch, 'substitute-profile');
    const profile = await runSourceControl(
      executable,
      profileWrapper,
      'substitute-profile',
      mismatchedProfile,
      scratch
    );
    assertRejectedAtAttestation(profile, 'profile-mismatch');
    console.log('OTIO_PROFILE_MISMATCH_REJECTED');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

switch (controlMode(process.argv.slice(2))) {
  case '--smoke':
    await smoke();
    break;
  case '--negative-source':
    await negativeSource();
    break;
}
