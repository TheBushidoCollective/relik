import assert from 'node:assert/strict';
import {
  deriveKeys,
  encodeEnvelope,
  encodeHeader,
  encryptedSize,
  encryptRecord,
  FORMAT_VERSION,
  parseFragment,
  RECORD_SIZE,
  recordCapacity,
} from '@relic/format';

interface BrowserSession {
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

type Handler = (request: Request) => Promise<Response>;

interface Fixture {
  readonly url: string;
  readonly origin: string;
  readonly original: Handler;
  install(handler: Handler): void;
  open(url: string): Promise<BrowserSession>;
}

async function click(session: BrowserSession, selector: string): Promise<void> {
  await session.waitFor(
    `!!document.querySelector(${JSON.stringify(selector)})`
  );
  const point = await session.evaluate<{ x: number; y: number }>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type,
      ...point,
      button: 'left',
      clickCount: 1,
    });
  }
}

async function waitForCount(
  count: () => number,
  minimum: number
): Promise<void> {
  const end = Date.now() + 15000;
  while (Date.now() < end && count() < minimum) await Bun.sleep(50);
  assert.ok(
    count() >= minimum,
    `expected at least ${minimum} body requests, got ${count()}`
  );
}

/** A real encrypted first record names the size; later bytes are intentionally truncated. */
export async function proveLargeConfirmations(fixture: Fixture): Promise<void> {
  const url = new URL(fixture.url);
  const relicId = url.pathname.split('/').filter(Boolean).at(-1);
  assert.ok(relicId);
  const key = parseFragment(url.hash).key;
  const length = 100 * 1024 * 1024 + 1;
  const salt = new Uint8Array(16);
  const envelope = encodeEnvelope({
    version: FORMAT_VERSION,
    entries: [
      {
        filename: 'large-proof.txt',
        mimetype: 'text/plain',
        offset: 0,
        length,
      },
    ],
  });
  const record = await encryptRecord(
    await deriveKeys(key, salt),
    0,
    envelope,
    false,
    recordCapacity(RECORD_SIZE)
  );
  const header = encodeHeader(salt, RECORD_SIZE);
  const prefix = new Uint8Array(header.length + record.length);
  prefix.set(header);
  prefix.set(record, header.length);
  let version = 1;
  let requests = 0;
  const objectPath = '/__confirmation_large_object';
  fixture.install(async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === objectPath) {
      requests++;
      return new Response(prefix as unknown as BodyInit, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    const response = await fixture.original(request);
    if (requestUrl.pathname === `/api/relics/${relicId}/mint` && response.ok) {
      const json = await response.json();
      return Response.json({
        ...json,
        url: `${fixture.origin}${objectPath}`,
        object_length: encryptedSize(length),
        version,
        current_version: version,
      });
    }
    return response;
  });
  let session: BrowserSession | undefined;
  try {
    session = await fixture.open(fixture.url);
    const dialog = 'dialog.large-open[open]';
    const remember = `${dialog} .confirm-remember`;
    const open = `${dialog} [data-large-open-accept]`;
    const stored = () =>
      session!.evaluate<
        Array<{ kind: string; relicId: string; version?: number }>
      >("JSON.parse(localStorage.getItem('relic-confirm-prefs:v1') || '[]')");
    await session.waitFor(
      `!!document.querySelector(${JSON.stringify(remember)})`
    );
    await click(session, remember);
    await session.evaluate(
      `document.querySelector(${JSON.stringify(open)}).click()`
    );
    await waitForCount(() => requests, 2);
    assert.equal(
      (await stored()).some((item) => item.kind === 'large-open'),
      false,
      'synthetic Open saved a preference'
    );

    await session.send('Page.navigate', { url: 'about:blank' });
    await session.send('Page.navigate', { url: fixture.url });
    await session.waitFor(
      `!!document.querySelector(${JSON.stringify(remember)})`
    );
    const labelBox = await session.evaluate<{ width: number; height: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(remember)}).getBoundingClientRect(); return {width:r.width,height:r.height}; })()`
    );
    assert.ok(
      labelBox.width >= 44 && labelBox.height >= 44,
      'large-open checkbox target is too small'
    );
    await click(session, remember);
    const beforeOpen = requests;
    await click(session, open);
    await waitForCount(() => requests, beforeOpen + 1);
    assert.deepEqual(
      (await stored()).filter((item) => item.kind === 'large-open'),
      [{ kind: 'large-open', relicId, version: 1 }]
    );

    const beforeReopen = requests;
    await session.send('Page.navigate', { url: 'about:blank' });
    await session.send('Page.navigate', { url: fixture.url });
    await waitForCount(() => requests, beforeReopen + 2);
    assert.equal(
      await session.evaluate<boolean>(
        `!!document.querySelector(${JSON.stringify(dialog)})`
      ),
      false,
      'same version asked again'
    );

    version = 2;
    await session.send('Page.navigate', { url: 'about:blank' });
    await session.send('Page.navigate', { url: fixture.url });
    await session.waitFor(
      `!!document.querySelector(${JSON.stringify(remember)})`
    );
    const beforeCancel = requests;
    await click(session, `${dialog} [data-large-open-decline]`);
    assert.equal(
      requests,
      beforeCancel,
      'declining a new version started a full fetch'
    );
    assert.deepEqual(
      (await stored()).filter((item) => item.kind === 'large-open'),
      [{ kind: 'large-open', relicId, version: 1 }]
    );
    console.log(
      'CONFIRM_LARGE_PATH_OK trusted=1 synthetic=refused reopened=skip version2=asks full_fetch=started'
    );
  } finally {
    if (session) await session.close();
    fixture.install(fixture.original);
  }
}
