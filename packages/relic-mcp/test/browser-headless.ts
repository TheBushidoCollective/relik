import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { CdpConnection } from '../src/cover/cdp.ts';

export const BROWSER_HEADLESS_HANDSHAKE_TIMEOUT_MS = 10_000;

type ApprovedHeadlessSwitch = '--headless' | '--headless=new';

export type BrowserHeadlessGuardCode =
  | 'missing-headless'
  | 'profile-mismatch'
  | 'invalid-command-line'
  | 'handshake-timeout';

export class BrowserHeadlessGuardError extends Error {
  readonly code: BrowserHeadlessGuardCode;

  constructor(code: BrowserHeadlessGuardCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'BrowserHeadlessGuardError';
    this.code = code;
  }
}

export interface BrowserHeadlessLaunch {
  readonly args: readonly string[];
  readonly profile: string;
  readonly headlessSwitch: ApprovedHeadlessSwitch;
}

export interface BrowserHeadlessAttestation {
  readonly version: Readonly<Record<string, unknown>>;
  readonly arguments: readonly string[];
}

export type OwnedBrowserChild = Pick<
  ChildProcess,
  'exitCode' | 'kill' | 'once' | 'signalCode'
>;

export interface BrowserStartupCleanup {
  readonly child: OwnedBrowserChild;
  readonly connection: Pick<CdpConnection, 'dispose'> | undefined;
  readonly forgetChild: (() => void) | undefined;
  readonly profile: string;
  readonly removeProfile: ((profile: string) => Promise<void>) | undefined;
}

interface ParsedBrowserArguments {
  readonly arguments: readonly string[];
  readonly enableAutomation: boolean;
  readonly headless: readonly string[];
  readonly remoteDebuggingPipe: boolean;
  readonly remoteDebuggingPort: boolean;
  readonly userDataDirs: readonly string[];
  readonly malformedUserDataDir: boolean;
}

interface ValidatedBrowserArguments {
  readonly headlessSwitch: ApprovedHeadlessSwitch;
  readonly profile: string;
}

function guardFailure(
  code: BrowserHeadlessGuardCode,
  message: string
): never {
  throw new BrowserHeadlessGuardError(code, message);
}

function isApprovedHeadlessSwitch(
  argument: string
): argument is ApprovedHeadlessSwitch {
  return argument === '--headless' || argument === '--headless=new';
}

function commandLineArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return guardFailure(
      'invalid-command-line',
      'Browser.getBrowserCommandLine did not return an arguments array'
    );
  }

  if (!value.every((argument) => typeof argument === 'string')) {
    return guardFailure(
      'invalid-command-line',
      'Browser.getBrowserCommandLine returned a non-string argument'
    );
  }

  return [...value];
}

function parseBrowserArguments(value: unknown): ParsedBrowserArguments {
  const argumentsBeforeTerminator: string[] = [];
  for (const argument of commandLineArguments(value)) {
    if (argument === '--') break;
    argumentsBeforeTerminator.push(argument);
  }

  const headless: string[] = [];
  const userDataDirs: string[] = [];
  let malformedUserDataDir = false;
  let enableAutomation = false;
  let remoteDebuggingPipe = false;
  let remoteDebuggingPort = false;

  for (const argument of argumentsBeforeTerminator) {
    if (argument === '--headless' || argument.startsWith('--headless=')) {
      headless.push(argument);
      continue;
    }
    if (argument === '--enable-automation') {
      enableAutomation = true;
      continue;
    }
    if (argument === '--remote-debugging-pipe') {
      remoteDebuggingPipe = true;
      continue;
    }
    if (
      argument === '--remote-debugging-port' ||
      argument.startsWith('--remote-debugging-port=')
    ) {
      remoteDebuggingPort = true;
      continue;
    }
    if (argument === '--user-data-dir') {
      malformedUserDataDir = true;
      continue;
    }
    if (argument.startsWith('--user-data-dir=')) {
      const profile = argument.slice('--user-data-dir='.length);
      if (profile.length === 0) malformedUserDataDir = true;
      else userDataDirs.push(profile);
    }
  }

  return {
    arguments: argumentsBeforeTerminator,
    enableAutomation,
    headless,
    remoteDebuggingPipe,
    remoteDebuggingPort,
    userDataDirs,
    malformedUserDataDir,
  };
}

function validateParsedBrowserArguments(
  parsed: ParsedBrowserArguments
): ValidatedBrowserArguments {
  if (parsed.headless.length === 0) {
    return guardFailure(
      'missing-headless',
      'browser command line did not include an approved headless switch'
    );
  }

  const headlessSwitch = parsed.headless[0];
  if (
    parsed.headless.length !== 1 ||
    headlessSwitch === undefined ||
    !isApprovedHeadlessSwitch(headlessSwitch)
  ) {
    return guardFailure(
      'invalid-command-line',
      'browser command line included contradictory or unsupported headless switches'
    );
  }

  if (parsed.malformedUserDataDir || parsed.userDataDirs.length !== 1) {
    return guardFailure(
      'invalid-command-line',
      'browser command line did not include exactly one user-data-dir switch'
    );
  }

  const profile = parsed.userDataDirs[0];
  if (profile === undefined) {
    return guardFailure(
      'invalid-command-line',
      'browser command line omitted the user-data-dir value'
    );
  }

  if (
    !parsed.remoteDebuggingPipe ||
    !parsed.enableAutomation ||
    parsed.remoteDebuggingPort
  ) {
    return guardFailure(
      'invalid-command-line',
      'browser command line did not preserve the required pipe attestation switches'
    );
  }

  return { headlessSwitch, profile };
}

function addEnableAutomation(args: readonly string[]): readonly string[] {
  const beforeTerminator = args.indexOf('--');
  const end = beforeTerminator === -1 ? args.length : beforeTerminator;
  if (args.slice(0, end).includes('--enable-automation')) return [...args];

  const firstPositional = args.findIndex(
    (argument, index) => index < end && !argument.startsWith('--')
  );
  const insertionPoint = firstPositional === -1 ? end : firstPositional;
  return [
    ...args.slice(0, insertionPoint),
    '--enable-automation',
    ...args.slice(insertionPoint),
  ];
}

export function createBrowserHeadlessLaunch(
  args: readonly string[],
  profile: string
): BrowserHeadlessLaunch {
  if (profile.length === 0) {
    return guardFailure(
      'invalid-command-line',
      'browser launch profile must not be empty'
    );
  }

  const launchArgs = addEnableAutomation(args);
  const validated = validateParsedBrowserArguments(
    parseBrowserArguments(launchArgs)
  );
  if (validated.profile !== profile) {
    return guardFailure(
      'profile-mismatch',
      'browser launch user-data-dir did not match the fresh profile'
    );
  }

  return {
    args: launchArgs,
    profile,
    headlessSwitch: validated.headlessSwitch,
  };
}

export function validateBrowserHeadlessCommandLine(
  response: Readonly<Record<string, unknown>>,
  launch: BrowserHeadlessLaunch
): readonly string[] {
  const parsed = parseBrowserArguments(response['arguments']);
  const validated = validateParsedBrowserArguments(parsed);

  if (validated.headlessSwitch !== launch.headlessSwitch) {
    return guardFailure(
      'invalid-command-line',
      'browser command line headless switch did not match the launch switch'
    );
  }
  if (validated.profile !== launch.profile) {
    return guardFailure(
      'profile-mismatch',
      'browser command line user-data-dir did not match the fresh profile'
    );
  }

  return parsed.arguments;
}

async function removeBrowserProfile(profile: string): Promise<void> {
  await rm(profile, { recursive: true, force: true });
}

export async function attestBrowserHeadless(
  connection: CdpConnection,
  launch: BrowserHeadlessLaunch,
  timeoutMs = BROWSER_HEADLESS_HANDSHAKE_TIMEOUT_MS
): Promise<BrowserHeadlessAttestation> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const { promise: deadline, reject: rejectDeadline } =
    Promise.withResolvers<never>();
  timeout = setTimeout(() => {
    rejectDeadline(
      new BrowserHeadlessGuardError(
        'handshake-timeout',
        'browser command-line attestation did not finish before the startup deadline'
      )
    );
  }, timeoutMs);
  const beforeDeadline = <T>(operation: () => Promise<T>): Promise<T> =>
    Promise.race<T>([Promise.resolve().then(operation), deadline]);

  try {
    const version = await beforeDeadline(() =>
      connection.send('Browser.getVersion')
    );
    const commandLine = await beforeDeadline(() =>
      connection.send('Browser.getBrowserCommandLine')
    );
    const arguments = validateBrowserHeadlessCommandLine(commandLine, launch);
    return { version, arguments };
  } catch (error) {
    if (error instanceof BrowserHeadlessGuardError) throw error;
    return guardFailure(
      'invalid-command-line',
      'browser command-line attestation could not complete'
    );
  } finally {
    clearTimeout(timeout);
  }
}

function childHasExited(child: OwnedBrowserChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForOwnedBrowserExit(child: OwnedBrowserChild): Promise<void> {
  if (childHasExited(child)) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    resolve();
  };
  child.once('close', finish);
  child.once('error', finish);
  if (childHasExited(child)) finish();
  await promise;
}

export async function cleanupOwnedBrowserStartup(
  cleanup: BrowserStartupCleanup
): Promise<void> {
  try {
    cleanup.connection?.dispose();
  } catch {
    // The original startup failure remains authoritative.
  }

  try {
    cleanup.child.kill('SIGKILL');
  } catch {
    // Only this child was spawned by the caller; do not broaden cleanup.
  }

  try {
    await waitForOwnedBrowserExit(cleanup.child);
  } catch {
    // The original startup failure remains authoritative.
  }

  try {
    cleanup.forgetChild?.();
  } catch {
    // The registry is best-effort cleanup for this already-failed startup.
  }

  try {
    const removeProfile = cleanup.removeProfile ?? removeBrowserProfile;
    await removeProfile(cleanup.profile);
  } catch {
    // The original startup failure remains authoritative.
  }
}