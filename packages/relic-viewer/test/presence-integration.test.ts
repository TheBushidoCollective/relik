import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as Format from '@relic/format/presence';
import type * as Presence from '../src/presence-controller.ts';
import type {
  PresenceAccess,
  PresenceEnvironment,
  PresenceSocket,
} from '../src/presence.ts';
import type * as Suggestion from '../src/suggest-controller.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';

function findHeadlessShell(): string | undefined {
  const configured = process.env['RELIC_CHROME_PATH'];
  if (configured && existsSync(configured)) return configured;
  const base = join(process.env['HOME'] ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    for (const version of readdirSync(base)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()) {
      const path = join(
        base,
        version,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell'
      );
      if (existsSync(path)) return path;
    }
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
}

// Runs in an isolated headless browser with the real editor and encrypted client.
async function browserCases(
  presence: typeof Presence,
  suggestionModule: typeof Suggestion,
  format: typeof Format
): Promise<string[]> {
  const passed: string[] = [];
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };
  const equal = (actual: unknown, expected: unknown, message: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
      );
  };
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeNow = Date.now;
  const wait = (): Promise<void> => {
    const { promise, resolve: done } = Promise.withResolvers<void>();
    nativeSetTimeout(done, 5);
    return promise;
  };
  const eventually = async (
    predicate: () => boolean,
    message: string
  ): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await wait();
    }
    throw new Error(message);
  };
  const check = async (
    name: string,
    run: () => Promise<void>
  ): Promise<void> => {
    try {
      await run();
      passed.push(name);
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  class Clock {
    now = Date.now();
    next = 1;
    tasks = new Map<number, { at: number; run: () => void }>();
    operations: Promise<unknown>[] = [];
    sockets: Socket[] = [];
    later = (run: () => void, delay = 0): number => {
      const id = this.next++;
      this.tasks.set(id, { at: this.now + delay, run });
      return id;
    };
    clear = (id: unknown): void => {
      this.tasks.delete(id as number);
    };
    track<T>(operation: Promise<T>): Promise<T> {
      this.operations.push(operation);
      return operation;
    }
    async settle(): Promise<void> {
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
        if (this.operations.length)
          await Promise.all(this.operations.splice(0));
      }
    }
    async advance(delay: number): Promise<void> {
      const end = this.now + delay;
      while (true) {
        let id: number | undefined;
        let at = Infinity;
        for (const [candidate, task] of this.tasks) {
          if (task.at <= end && task.at < at) {
            id = candidate;
            at = task.at;
          }
        }
        if (id === undefined) break;
        this.now = at;
        const task = this.tasks.get(id)!;
        this.tasks.delete(id);
        task.run();
        await this.settle();
      }
      this.now = end;
      await this.settle();
    }
  }
  const clock = new Clock();
  Date.now = () => clock.now;
  window.setTimeout = ((run: TimerHandler, delay?: number) => {
    if (typeof run !== 'function') throw new Error('unexpected string timer');
    return clock.later(run as () => void, delay);
  }) as typeof window.setTimeout;
  window.clearTimeout = clock.clear as typeof window.clearTimeout;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });

  class Socket implements PresenceSocket {
    readyState = 0;
    onopen: ((event: Event) => unknown) | null = null;
    onmessage: ((event: MessageEvent) => unknown) | null = null;
    onclose: ((event: CloseEvent) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;
    readonly sent: string[] = [];
    readonly id: string;
    constructor(readonly url: string) {
      this.id = String(clock.sockets.length + 1).padStart(16, 'a');
      clock.sockets.push(this);
    }
    open(): void {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }
    send(data: string): void {
      this.sent.push(data);
      const envelope = JSON.parse(data) as { v: number; c: string };
      for (const other of clock.sockets) {
        if (
          other !== this &&
          other.readyState === 1 &&
          other.url === this.url
        ) {
          other.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ ...envelope, f: this.id }),
            })
          );
        }
      }
    }
    close(): void {
      this.readyState = 3;
    }
  }
  class Environment implements PresenceEnvironment {
    isVisible = true;
    readonly sockets: Socket[] = [];
    readonly visibility = new Set<() => void>();
    readonly activity = new Set<() => void>();
    now = (): number => clock.now;
    random = (): number => 0;
    setTimeout = clock.later;
    clearTimeout = clock.clear;
    socket = (url: string): Socket => {
      const socket = new Socket(url);
      this.sockets.push(socket);
      return socket;
    };
    visible = (): boolean => this.isVisible;
    onVisibility = (callback: () => void): (() => void) => {
      this.visibility.add(callback);
      return () => {
        this.visibility.delete(callback);
      };
    };
    onActivity = (callback: () => void): (() => void) => {
      this.activity.add(callback);
      return () => {
        this.activity.delete(callback);
      };
    };
    seal: typeof format.sealPresence = (key, room, frame) =>
      clock.track(format.sealPresence(key, room, frame));
    open: typeof format.openPresence = (key, room, ciphertext) =>
      clock.track(format.openPresence(key, room, ciphertext));
    setVisible(visible: boolean): void {
      this.isVisible = visible;
      for (const callback of this.visibility) callback();
    }
  }
  const key = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
  const access = (): PresenceAccess => ({
    signedIn: true,
    rendererClass: 'markdown',
    currentVersion: true,
  });

  try {
    await check('access gating, version changes and disposal', async () => {
      const stage = document.createElement('div');
      const chip = document.createElement('div');
      document.body.append(stage, chip);
      const env = new Environment();
      let state: PresenceAccess = { ...access(), signedIn: false };
      const controller = presence.mountPresenceController({
        serviceOrigin: location.origin,
        relicId: 'gating-relic',
        keyBytes: key,
        version: 1,
        name: null,
        color: 1,
        stage,
        chip,
        suggestion: () => undefined,
        ensureSuggestion: async () => undefined,
        refresh: async () => {},
        access: () => state,
        environment: env,
      });
      await controller.ready;
      equal(env.sockets.length, 0, 'signed-out socket count');
      state = { ...access(), rendererClass: 'html' };
      controller.sync();
      state = { ...access(), rendererClass: 'jsx' };
      controller.sync();
      state = { ...access(), currentVersion: false };
      controller.sync();
      equal(env.sockets.length, 0, 'unsupported and old version socket count');
      env.setVisible(false);
      state = { ...access(), rendererClass: 'code' };
      controller.sync();
      equal(env.sockets.length, 0, 'hidden socket count');
      env.setVisible(true);
      equal(env.sockets.length, 1, 'visible current code connects');
      env.sockets[0]!.open();
      state = { ...state, currentVersion: false };
      controller.sync();
      equal(env.sockets[0]!.readyState, 3, 'version change closes socket');
      state = { ...state, currentVersion: true };
      controller.sync();
      equal(env.sockets.length, 2, 'returning to current version reconnects');
      env.sockets[1]!.open();
      state = { ...state, signedIn: false };
      controller.sync();
      equal(env.sockets[1]!.readyState, 3, 'sign-out closes socket');
      controller.dispose();
      env.setVisible(false);
      env.setVisible(true);
      equal(env.sockets.length, 2, 'disposed controller cannot reconnect');
      equal(env.visibility.size, 0, 'visibility listener removed');
      equal(env.activity.size, 0, 'activity listener removed');
      equal(clock.tasks.size, 0, 'no timers remain');
      stage.remove();
      chip.remove();

      const pendingEnv = new Environment();
      const pending = presence.mountPresenceController({
        serviceOrigin: location.origin,
        relicId: 'disposed-before-key',
        keyBytes: key,
        version: 1,
        name: null,
        color: 1,
        stage: document.body,
        chip: document.createElement('div'),
        suggestion: () => undefined,
        ensureSuggestion: async () => undefined,
        refresh: async () => {},
        access,
        environment: pendingEnv,
      });
      pending.dispose();
      await pending.ready;
      equal(pendingEnv.sockets.length, 0, 'disposal beats key derivation');
      equal(clock.tasks.size, 0, 'early disposal leaves no timers');
    });

    await check('source mapping waits for a peer caret', async () => {
      const stage = document.createElement('div');
      const paragraph = document.createElement('p');
      const original = document.createTextNode('ordinary reading text');
      paragraph.append(original);
      stage.append(paragraph);
      const chip = document.createElement('div');
      document.body.append(stage, chip);
      const env = new Environment();
      let calls = 0;
      let mapped = false;
      const adapter = {
        presenceDocument: () => ({ root: paragraph, segments: [] }),
        presenceState: () => ({ suggesting: false }),
        refreshOnPresence() {},
      };
      const controller = presence.mountPresenceController({
        serviceOrigin: location.origin,
        relicId: 'lazy-relic',
        keyBytes: key,
        version: 1,
        name: null,
        color: 1,
        stage,
        chip,
        suggestion: () => (mapped ? adapter : undefined),
        ensureSuggestion: async () => {
          calls++;
          mapped = true;
          return adapter;
        },
        refresh: async () => {},
        access,
        environment: env,
      });
      await controller.ready;
      env.sockets[0]!.open();
      equal(calls, 0, 'startup must not load suggestions');
      assert(paragraph.firstChild === original, 'startup changed reading text');
      assert(
        !stage.querySelector('.presence-layer'),
        'startup added an overlay'
      );
      const remote = new Socket(env.sockets[0]!.url);
      remote.open();
      const keys = await format.derivePresenceKeys(key, 'lazy-relic');
      const send = async (caret?: { s: number; e: number }): Promise<void> => {
        const c = await format.sealPresence(keys.seal, keys.room, {
          v: 1,
          t: clock.now,
          name: null,
          color: 1,
          version: 1,
          ...(caret ? { caret } : {}),
        });
        remote.send(JSON.stringify({ v: 1, c }));
        await clock.settle();
      };
      await send();
      equal(calls, 0, 'peer without a range must not load suggestions');
      await send({ s: 1, e: 1 });
      await eventually(
        () => calls === 1,
        'peer caret did not load suggestions'
      );
      await send({ s: 2, e: 2 });
      equal(calls, 1, 'peer ranges load suggestions only once');
      controller.dispose();
      remote.close();
      stage.remove();
      chip.remove();
      equal(clock.tasks.size, 0, 'lazy fixture leaves no timers');
    });

    interface Write {
      readonly method: string;
      readonly keepalive: boolean;
      readonly respond: (response: Response) => void;
    }
    async function reader(label: string) {
      const host = document.createElement('div');
      const stage = document.createElement('div');
      const root = document.createElement('article');
      const bar = document.createElement('div');
      const chip = document.createElement('div');
      root.className = 'prose';
      stage.className = 'stage';
      stage.append(root);
      host.append(stage);
      document.body.append(host, bar, chip);
      const env = new Environment();
      const writes: Write[] = [];
      const announced: string[] = [];
      let reads = 0;
      let refreshes = 0;
      let notifications = 0;
      const readTimes: number[] = [];
      const notificationTimes: number[] = [];
      let live: Presence.PresenceController | undefined;
      const source = 'hello world';
      const view = {
        route: 'markdown',
        version: 1,
        currentVersion: 1,
        document: { bytes: new TextEncoder().encode(source), truncated: false },
      } as unknown as ReadyView;
      const fetcher = async (
        _input: string,
        init?: RequestInit
      ): Promise<Response> => {
        if (!init?.method || init.method === 'GET') {
          reads++;
          readTimes.push(clock.now);
          return Response.json([]);
        }
        const deferred = Promise.withResolvers<Response>();
        writes.push({
          method: init.method,
          keepalive: init.keepalive === true,
          respond: deferred.resolve,
        });
        return deferred.promise;
      };
      const deps = {
        serviceOrigin: location.origin,
        fetch: fetcher as typeof fetch,
        now: () => clock.now,
      } as unknown as ViewerDeps;
      const adapter = suggestionModule.mountSuggestionController({
        view,
        relicId: 'shared-relic',
        deps,
        host,
        bar,
        session: () => ({ kind: 'verified', email: `${label}@example.test` }),
        cipher: () => ({
          seal: async () => 'sealed',
          open: async () => ({ body: '', display_name: null, anchor: null }),
        }),
        entries: () => [],
        displayName: () => label,
        refresh: async () => {
          refreshes++;
        },
        readCurrentVersion: async () => 1,
        repaint() {},
        signIn() {},
        open() {},
        onPresenceChange: () => live?.sync(),
        onPosted: (id) => {
          announced.push(id);
          return live?.announcePosted(id);
        },
      });
      live = presence.mountPresenceController({
        serviceOrigin: location.origin,
        relicId: 'shared-relic',
        keyBytes: key,
        version: 1,
        name: label,
        color: 1,
        stage,
        chip,
        suggestion: () => ({
          presenceDocument: () => adapter.presenceDocument(),
          presenceState: () => adapter.presenceState(),
          refreshOnPresence: () => {
            notifications++;
            notificationTimes.push(clock.now);
            adapter.refreshOnPresence();
          },
        }),
        ensureSuggestion: async () => adapter,
        refresh: async () => {
          refreshes++;
        },
        access,
        environment: env,
      });
      await live.ready;
      assert(env.sockets.length === 1, 'reader connects once');
      env.sockets[0]!.open();
      return {
        host,
        root,
        stage,
        chip,
        env,
        writes,
        announced,
        adapter,
        readTimes,
        notificationTimes,
        live,
        get reads() {
          return reads;
        },
        get notifications() {
          return notifications;
        },
        get refreshes() {
          return refreshes;
        },
        dispose() {
          live?.dispose();
          adapter.destroy();
          host.remove();
          bar.remove();
          chip.remove();
        },
      };
    }
    function draft(reader: {
      adapter: Suggestion.SuggestController;
      root: HTMLElement;
    }): void {
      reader.adapter.setSuggesting(true);
      const segment = reader.root.querySelector('[data-seg="0"]');
      const text = segment?.firstChild;
      if (!text) throw new Error('missing mapped source');
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 3);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const input = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: 'X',
      });
      reader.root.dispatchEvent(input);
      assert(input.defaultPrevented, 'editor owns beforeinput');
    }

    await check(
      'confirmed mode-off post reaches peers and refresh is throttled',
      async () => {
        const sender = await reader('Sender');
        const receiver = await reader('Receiver');
        const socket = sender.env.sockets[0]!;
        draft(sender);
        equal(
          sender.adapter.presenceState(),
          {
            suggesting: true,
            caret: { s: 3, e: 3 },
            typing: { s: 1, e: 3 },
          },
          'source caret and draft range'
        );
        sender.adapter.setSuggesting(false);
        equal(sender.adapter.suggesting, false, 'editor switches to reading');
        equal(
          sender.adapter.presenceState().suggesting,
          true,
          'presence waits for pending post'
        );
        await eventually(
          () => sender.writes.length === 1,
          'post did not start'
        );
        await clock.advance(1000);
        equal(sender.announced, [], 'no announcement before confirmation');
        sender.writes[0]!.respond(Response.json({ comment_id: 'comment-1' }));
        await eventually(
          () => sender.announced.length === 1,
          'confirmed post not announced'
        );
        equal(sender.announced, ['comment-1'], 'confirmed post id');
        equal(
          sender.adapter.presenceState().suggesting,
          true,
          'the hold lasts until the announcement leaves'
        );
        await clock.advance(1000);
        const keys = await format.derivePresenceKeys(key, 'shared-relic');
        const frames = await Promise.all(
          socket.sent.map(async (value) => {
            const envelope = JSON.parse(value) as { c: string };
            return format.openPresence(keys.seal, keys.room, envelope.c);
          })
        );
        assert(
          frames.some((frame) => frame?.posted === 'comment-1'),
          'peer frame lacks confirmed id'
        );
        await eventually(() => receiver.reads === 1, 'peer did not refetch');
        equal(
          sender.adapter.presenceState().suggesting,
          false,
          'presence exits after the post tick'
        );
        const sent = socket.sent.length;
        await clock.advance(3000);
        equal(
          socket.sent.length,
          sent,
          'no frames after presence stops suggesting'
        );
        sender.adapter.setSuggesting(true);
        sender.live.announcePosted('comment-2');
        await clock.advance(5000);
        equal(receiver.reads, 1, 'activity throttle prevents a second refetch');
        equal(
          receiver.notifications,
          2,
          'second peer notification reaches the controller'
        );
        await clock.advance(1999);
        equal(receiver.reads, 1, 'second ping waits for the end of the window');
        await clock.advance(1);
        try {
          await eventually(
            () => receiver.reads === 2,
            'trailing refetch did not run'
          );
        } catch {
          throw new Error(
            `trailing refresh: now=${clock.now}, reads=${receiver.readTimes}, notifications=${receiver.notificationTimes}, tasks=${Array.from(clock.tasks.values(), (task) => task.at)}`
          );
        }
        sender.live.announcePosted('comment-3');
        await clock.advance(1000);
        await clock.advance(8999);
        equal(
          receiver.reads,
          2,
          'third ping observes the next throttle window'
        );
        await clock.advance(1);
        await eventually(
          () => receiver.reads === 3,
          'third ping did not refetch'
        );
        await eventually(
          () => receiver.refreshes >= 3,
          'normal thread renderer was not refreshed'
        );
        draft(receiver);
        sender.live.announcePosted('comment-4');
        await clock.advance(11_000);
        equal(receiver.reads, 3, 'open draft defers peer refetch');
        receiver.adapter.setSuggesting(false);
        await eventually(
          () => receiver.writes.length === 1,
          'draft commit did not start'
        );
        receiver.writes[0]!.respond(
          Response.json({ comment_id: 'receiver-1' })
        );
        await eventually(
          () => receiver.reads === 4,
          'deferred refetch did not run after commit'
        );
        sender.dispose();
        receiver.dispose();
        equal(clock.tasks.size, 0, 'disposing readers clears timers');
        assert(
          clock.sockets.every((item) => item.readyState === 3),
          'disposing readers closes sockets'
        );
      }
    );

    await check('pagehide flushes an open draft with keepalive', async () => {
      const fixture = await reader('Pagehide');
      draft(fixture);
      window.dispatchEvent(new Event('pagehide'));
      await eventually(
        () => fixture.writes.length === 1,
        'pagehide did not post'
      );
      equal(fixture.writes[0]!.method, 'POST', 'pagehide method');
      equal(fixture.writes[0]!.keepalive, true, 'pagehide request keepalive');
      fixture.writes[0]!.respond(Response.json({ comment_id: 'pagehide-1' }));
      await eventually(
        () => fixture.announced.length === 1,
        'pagehide confirmation missing'
      );
      fixture.dispose();
      equal(clock.tasks.size, 0, 'pagehide fixture leaves no timers');
    });
  } finally {
    window.setTimeout = nativeSetTimeout;
    window.clearTimeout = nativeClearTimeout;
    Date.now = nativeNow;
    Reflect.deleteProperty(document, 'visibilityState');
  }
  return passed;
}

const shell = findHeadlessShell();
describe('viewer presence integration', () => {
  test.skipIf(!shell)(
    'wires presence to real suggestion state and confirmed transport results',
    async () => {
      const build = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, '../src/presence-controller.ts'),
          resolve(import.meta.dir, '../src/suggest-controller.ts'),
          resolve(import.meta.dir, '../../relic-format/src/presence.ts'),
        ],
        target: 'browser',
        format: 'esm',
        splitting: false,
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const modules = new Map<string, string>();
      for (const output of build.outputs)
        modules.set(`/${output.path.split('/').at(-1)}`, await output.text());
      const result = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const page = `<!doctype html><meta charset="utf-8"><script type="module">
        import * as presence from '/presence-controller.js';
        import * as suggestion from '/suggest-controller.js';
        import * as format from '/presence.js';
        try { const passed = await (${browserCases.toString()})(presence, suggestion, format); await fetch('/result', {method:'POST', body:JSON.stringify({passed})}); }
        catch (error) { await fetch('/result', {method:'POST', body:JSON.stringify({error: error && (error.stack || error.message) || String(error)})}); }
      </script>`;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/result') {
            result.resolve(
              (await request.json()) as { passed?: string[]; error?: string }
            );
            return new Response('ok');
          }
          const module = modules.get(url.pathname);
          if (module !== undefined)
            return new Response(module, {
              headers: { 'content-type': 'text/javascript' },
            });
          return new Response(page, {
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      const profile = join(tmpdir(), `relic-presence-${crypto.randomUUID()}`);
      const browser = spawn(
        shell!,
        [
          '--headless',
          '--disable-gpu',
          '--no-sandbox',
          `--user-data-dir=${profile}`,
          `http://127.0.0.1:${server.port}/`,
        ],
        { stdio: 'ignore' }
      );
      try {
        const exited = Promise.withResolvers<never>();
        browser.once('error', exited.reject);
        browser.once('exit', (code) =>
          exited.reject(new Error(`headless browser exited: ${code}`))
        );
        const outcome = await Promise.race([result.promise, exited.promise]);
        if (outcome.error) throw new Error(outcome.error);
        expect(outcome.passed).toEqual([
          'access gating, version changes and disposal',
          'source mapping waits for a peer caret',
          'confirmed mode-off post reaches peers and refresh is throttled',
          'pagehide flushes an open draft with keepalive',
        ]);
      } finally {
        browser.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null)
          await once(browser, 'exit');
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    60_000
  );
});
