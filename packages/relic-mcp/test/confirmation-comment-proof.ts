import assert from 'node:assert/strict';

interface Session {
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  setViewport(
    width: number,
    height: number,
    scheme?: 'light' | 'dark'
  ): Promise<void>;
}

interface Fixture {
  readonly session: Session;
  readonly relicId: string;
  seed(): Promise<string>;
  exists(id: string): Promise<boolean>;
}

async function click(session: Session, selector: string): Promise<void> {
  await session.waitFor(
    `!!document.querySelector(${JSON.stringify(selector)})`
  );
  const point = await session.evaluate<{ x: number; y: number }>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'center', inline: 'center' });
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

async function absent(fixture: Fixture, id: string): Promise<void> {
  const end = Date.now() + 15000;
  while (Date.now() < end && (await fixture.exists(id))) await Bun.sleep(50);
  assert.equal(
    await fixture.exists(id),
    false,
    `comment ${id} was not deleted`
  );
}

async function checkTarget(session: Session, selector: string): Promise<void> {
  const box = await session.evaluate<{
    width: number;
    height: number;
  }>(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { width: r.width, height: r.height };
  })()`);
  assert.ok(
    box.width >= 44 && box.height >= 44,
    `${selector} target ${box.width}x${box.height}`
  );
}

/** Runs only against the existing loopback app and its in-memory comment store. */
export async function proveCommentConfirmations(
  fixture: Fixture
): Promise<void> {
  const { session, relicId } = fixture;
  const ids = await Promise.all([
    fixture.seed(),
    fixture.seed(),
    fixture.seed(),
    fixture.seed(),
  ]);
  await session.setViewport(1440, 900, 'light');
  await session.send('Page.reload');
  await session.waitFor(
    `document.querySelectorAll('.comment-delete').length >= 4`
  );
  if (
    !(await session.evaluate<boolean>(
      "document.querySelector('.thread').classList.contains('is-open')"
    ))
  ) {
    await click(session, '.thread-tab');
  }
  const remove = (id: string) =>
    `.thread .comment-delete[data-delete-comment-id="${id}"]`;
  const box = 'dialog.comment-delete-dialog .confirm-remember';
  const confirm = 'dialog.comment-delete-dialog .comment-delete-confirm';
  const key = 'relic-confirm-prefs:v1';
  const stored = () =>
    session.evaluate<Array<{ kind: string; relicId: string }>>(
      `JSON.parse(localStorage.getItem(${JSON.stringify(key)}) || '[]')`
    );

  assert.equal(
    await session.evaluate<boolean>(
      "!!document.querySelector('.skipped-bar-action:not([hidden])')"
    ),
    false
  );
  await click(session, remove(ids[0]!));
  await session.waitFor(
    "!!document.querySelector('dialog.comment-delete-dialog[open]')"
  );
  await checkTarget(session, box);
  await click(session, box);
  await session.evaluate(
    `document.querySelector(${JSON.stringify(confirm)}).click()`
  );
  await absent(fixture, ids[0]!);
  assert.equal(
    (await stored()).some((item) => item.kind === 'delete-comment'),
    false,
    'synthetic confirmation remembered a preference'
  );

  await click(session, remove(ids[1]!));
  await click(session, box);
  await click(session, confirm);
  await absent(fixture, ids[1]!);
  assert.equal(
    (await stored()).filter(
      (item) => item.kind === 'delete-comment' && item.relicId === relicId
    ).length,
    1
  );
  await session.waitFor(
    "!!document.querySelector('.confirm-delete-strip:not([hidden])')"
  );
  await session.waitFor(
    "!!document.querySelector('.skipped-bar-action:not([hidden])')"
  );
  await checkTarget(session, '.skipped-bar-action');
  assert.equal(
    await session.evaluate<string>(
      "document.querySelector('.skipped-bar-action .skipped-count').textContent"
    ),
    '1'
  );
  await click(session, remove(ids[2]!));
  await absent(fixture, ids[2]!);
  assert.equal(
    await session.evaluate<boolean>(
      "!!document.querySelector('dialog.comment-delete-dialog[open]')"
    ),
    false,
    'remembered delete still asked'
  );
  await session.waitFor(
    "document.querySelector('.comment-delete-outcome').textContent.includes('Comment deleted')"
  );

  await click(session, '.skipped-bar-action');
  await session.waitFor(
    "!!document.querySelector('dialog.skipped-panel[open]')"
  );
  assert.match(
    await session.evaluate<string>(
      "document.querySelector('.skipped-row').textContent"
    ),
    /every version/i
  );
  await checkTarget(session, '.skipped-ask');
  await checkTarget(session, '.skipped-close');
  await click(session, '.skipped-ask');
  assert.equal(
    await session.evaluate<string>('document.activeElement.id'),
    'skipped-title'
  );
  assert.equal(
    await session.evaluate<boolean>(
      "!document.querySelector('.skipped-empty').hidden"
    ),
    true
  );
  assert.equal(
    await session.evaluate<boolean>(
      "!document.querySelector('.skipped-bar-action').hidden"
    ),
    true
  );
  await click(session, '.skipped-close');
  await session.waitFor("!document.querySelector('.skipped-panel')");
  assert.equal(
    await session.evaluate<boolean>(
      "document.activeElement.classList.contains('action-report')"
    ),
    true
  );
  assert.equal(
    await session.evaluate<boolean>(
      "document.querySelector('.skipped-bar-action').hidden"
    ),
    true
  );
  assert.equal(
    await session.evaluate<boolean>(
      "document.querySelector('.confirm-delete-strip').hidden"
    ),
    true
  );

  await click(session, remove(ids[3]!));
  await session.waitFor(
    "!!document.querySelector('dialog.comment-delete-dialog[open]')"
  );
  await click(session, box);
  await click(session, confirm);
  await absent(fixture, ids[3]!);
  await session.setViewport(390, 844, 'light');
  await click(session, '.action-more');
  await checkTarget(session, '.skipped-menu-action');
  assert.equal(
    await session.evaluate<string>(
      "document.querySelector('.skipped-menu-action .skipped-count').textContent"
    ),
    '1'
  );
  assert.equal(
    await session.evaluate<number>(
      'document.documentElement.scrollWidth - innerWidth'
    ),
    0,
    'mobile page overflows horizontally'
  );
  await click(session, '.skipped-menu-action');
  await checkTarget(session, '.skipped-ask');
  assert.equal(
    await session.evaluate<number>(
      'document.documentElement.scrollWidth - innerWidth'
    ),
    0,
    'mobile panel overflows horizontally'
  );
  await click(session, '.skipped-ask');
  await click(session, '.skipped-close');
  await session.waitFor("!document.querySelector('.skipped-panel')");
  assert.equal(
    await session.evaluate<boolean>(
      "document.activeElement.classList.contains('action-more')"
    ),
    true
  );
  await click(session, '.action-more');
  assert.equal(
    await session.evaluate<boolean>(
      "document.querySelector('.skipped-menu-action .skipped-count').hidden"
    ),
    true
  );
  console.log(
    'CONFIRM_COMMENT_PATH_OK trusted=1 synthetic=refused mobile=390x844'
  );
}
