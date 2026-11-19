import assert from 'node:assert/strict';
import type { RunningProofBrowser } from './decision-proof-steps.ts';

export async function clickPrivateControl(
  browser: RunningProofBrowser,
  selector: string
): Promise<void> {
  await browser.waitForSelector(selector, 25000);
  const point = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollIntoView({block:'center',inline:'center'});
    const r = node.getBoundingClientRect();
    return {x:r.left + r.width / 2,y:r.top + r.height / 2};
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await browser.cdp.send(
      'Input.dispatchMouseEvent',
      { type, ...point, button: 'left', clickCount: 1 },
      browser.sessionId
    );
  }
}

export async function assertPrivateConfirmation(
  browser: RunningProofBrowser,
  selector: string,
  explanation: string
): Promise<void> {
  await browser.waitForSelector(`${selector}[open]`, 25000);
  const actual = await browser.evaluate<{
    text: string;
    remember: boolean;
  }>(`(() => {
    const dialog = document.querySelector(${JSON.stringify(selector)});
    return {text:dialog.querySelector('.sheet-always')?.textContent || '', remember:!!dialog.querySelector('.confirm-remember') || Array.from(dialog.querySelectorAll('label')).some(label => /don.t ask again/i.test(label.textContent))};
  })()`);
  assert.equal(actual.text, explanation);
  assert.equal(
    actual.remember,
    false,
    `${selector} must never offer to skip this confirmation`
  );
  console.log(`CONFIRM_PRIVATE_PATH_OK ${selector}`);
}
