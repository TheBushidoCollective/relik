import { describe, expect, test } from 'bun:test';
import {
  CdpClosedError,
  type CdpConnection,
  CdpError,
} from '../src/cover/cdp.ts';
import {
  attestBrowserHeadless,
  type BrowserHeadlessGuardCode,
  BrowserHeadlessGuardError,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
  type OwnedBrowserChild,
  validateBrowserHeadlessCommandLine,
} from './browser-headless.ts';

type FakeResponse =
  | Error
  | Readonly<Record<string, unknown>>
  | (() => Promise<Readonly<Record<string, unknown>>>);

function launchArgs(
  headless: '--headless' | '--headless=new',
  profile = '/tmp/relic-browser-profile'
): readonly string[] {
  return [
    headless,
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
}

function fakeConnection(
  responses: Readonly<Record<string, FakeResponse>>
): CdpConnection {
  return {
    async send(method): Promise<Record<string, unknown>> {
      const response = responses[method];
      if (response === undefined)
        throw new Error(`unexpected method ${method}`);
      if (response instanceof Error) throw response;
      const resolved =
        typeof response === 'function' ? await response() : response;
      return { ...resolved };
    },
    onEvent(): () => void {
      return () => {};
    },
    async waitForEvent(): Promise<never> {
      throw new Error('waitForEvent was not expected');
    },
    closed: Promise.resolve(),
    dispose(): void {},
  };
}

function expectGuardCode(
  operation: () => unknown,
  code: BrowserHeadlessGuardCode
): void {
  try {
    operation();
    throw new Error('expected browser attestation to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserHeadlessGuardError);
    expect((error as BrowserHeadlessGuardError).code).toBe(code);
  }
}

async function expectAsyncGuardCode(
  operation: () => Promise<unknown>,
  code: BrowserHeadlessGuardCode
): Promise<void> {
  try {
    await operation();
    throw new Error('expected browser attestation to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserHeadlessGuardError);
    expect((error as BrowserHeadlessGuardError).code).toBe(code);
  }
}

function controlledChild(
  name: string,
  events: string[]
): {
  readonly child: OwnedBrowserChild;
  readonly kills: readonly NodeJS.Signals[];
} {
  const kills: NodeJS.Signals[] = [];
  let exited = false;
  const child = {
    get exitCode(): number | null {
      return exited ? 0 : null;
    },
    get signalCode(): NodeJS.Signals | null {
      return null;
    },
    kill(signal?: NodeJS.Signals): boolean {
      if (signal !== undefined) kills.push(signal);
      events.push(`kill:${name}`);
      exited = true;
      return true;
    },
    once(): unknown {
      return child;
    },
  };
  return { child: child as unknown as OwnedBrowserChild, kills };
}

describe('browser headless attestation', () => {
  test('accepts each supported headless form when actual CDP arguments match', () => {
    for (const headless of ['--headless', '--headless=new'] as const) {
      const profile = `/tmp/relic-${headless.slice(2)}-profile`;
      const launch = createBrowserHeadlessLaunch(
        launchArgs(headless, profile),
        profile
      );
      expect(
        validateBrowserHeadlessCommandLine({ arguments: launch.args }, launch)
      ).toEqual(launch.args);
    }
  });

  test('rejects deceptive product and pathname text without a real headless switch', async () => {
    const profile = '/tmp/relic-headless-pathname';
    const launch = createBrowserHeadlessLaunch(
      launchArgs('--headless=new', profile),
      profile
    );
    const connection = fakeConnection({
      'Browser.getVersion': { product: 'HeadlessChrome/155.0' },
      'Browser.getBrowserCommandLine': {
        arguments: [
          '--remote-debugging-pipe',
          '--enable-automation',
          `--user-data-dir=${profile}`,
          '--',
          '--headless=new',
        ],
      },
    });

    await expectAsyncGuardCode(
      () => attestBrowserHeadless(connection, launch),
      'missing-headless'
    );
  });

  test('fails closed for malformed command-line responses and pipe violations', () => {
    const profile = '/tmp/relic-malformed-profile';
    const launch = createBrowserHeadlessLaunch(
      launchArgs('--headless=new', profile),
      profile
    );

    expectGuardCode(
      () =>
        validateBrowserHeadlessCommandLine(
          { arguments: 'not-an-array' },
          launch
        ),
      'invalid-command-line'
    );
    expectGuardCode(
      () =>
        validateBrowserHeadlessCommandLine(
          {
            arguments: [
              '--headless=new',
              `--user-data-dir=${profile}`,
              '--enable-automation',
              '--remote-debugging-pipe',
              '--remote-debugging-port=0',
            ],
          },
          launch
        ),
      'invalid-command-line'
    );
  });

  test('rejects unsupported command-line introspection and a closed transport', async () => {
    const profile = '/tmp/relic-transport-profile';
    const launch = createBrowserHeadlessLaunch(
      launchArgs('--headless=new', profile),
      profile
    );

    await expectAsyncGuardCode(
      () =>
        attestBrowserHeadless(
          fakeConnection({
            'Browser.getVersion': {},
            'Browser.getBrowserCommandLine': new CdpError(
              'Browser.getBrowserCommandLine',
              -32601,
              'Method not found'
            ),
          }),
          launch
        ),
      'invalid-command-line'
    );
    await expectAsyncGuardCode(
      () =>
        attestBrowserHeadless(
          fakeConnection({
            'Browser.getVersion': new CdpClosedError(),
          }),
          launch
        ),
      'invalid-command-line'
    );
  });

  test('rejects a substituted profile and contradictory headless switches', () => {
    const profile = '/tmp/relic-expected-profile';
    const launch = createBrowserHeadlessLaunch(
      launchArgs('--headless=new', profile),
      profile
    );

    expectGuardCode(
      () =>
        validateBrowserHeadlessCommandLine(
          {
            arguments: [
              '--headless=new',
              '--remote-debugging-pipe',
              '--enable-automation',
              '--user-data-dir=/tmp/relic-substituted-profile',
            ],
          },
          launch
        ),
      'profile-mismatch'
    );
    expectGuardCode(
      () =>
        validateBrowserHeadlessCommandLine(
          {
            arguments: [
              '--headless',
              '--headless=new',
              '--remote-debugging-pipe',
              '--enable-automation',
              `--user-data-dir=${profile}`,
            ],
          },
          launch
        ),
      'invalid-command-line'
    );
  });

  test('times out when the owned browser never answers command-line introspection', async () => {
    const profile = '/tmp/relic-unresponsive-profile';
    const launch = createBrowserHeadlessLaunch(
      launchArgs('--headless=new', profile),
      profile
    );
    const { promise: neverResponds } =
      Promise.withResolvers<Readonly<Record<string, unknown>>>();
    const connection = fakeConnection({
      'Browser.getVersion': {},
      'Browser.getBrowserCommandLine': () => neverResponds,
    });

    await expectAsyncGuardCode(
      () => attestBrowserHeadless(connection, launch, 5),
      'handshake-timeout'
    );
  });

  test('cleans only the failed owned browser and its profile', async () => {
    const events: string[] = [];
    const failed = controlledChild('failed', events);
    const other = controlledChild('other', events);

    await cleanupOwnedBrowserStartup({
      connection: { dispose: () => events.push('dispose') },
      child: failed.child,
      forgetChild: () => events.push('forget'),
      profile: '/tmp/relic-failed-profile',
      removeProfile: async () => {
        events.push('remove-profile');
      },
    });

    expect(events).toEqual([
      'dispose',
      'kill:failed',
      'forget',
      'remove-profile',
    ]);
    expect(failed.kills).toEqual(['SIGKILL']);
    expect(other.kills).toEqual([]);
  });
});
