import { describe, expect, test } from 'bun:test';
import { isPlainClick } from '../src/upload-button.ts';

const click = (over: Partial<Parameters<typeof isPlainClick>[0]> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('which clicks on Upload choose a file here', () => {
  test('takes a plain primary click', () => {
    expect(isPlainClick(click())).toBe(true);
  });

  test('leaves every modified click to the link, so open-in-new-tab still opens the page', () => {
    expect(isPlainClick(click({ metaKey: true }))).toBe(false);
    expect(isPlainClick(click({ ctrlKey: true }))).toBe(false);
    expect(isPlainClick(click({ shiftKey: true }))).toBe(false);
    expect(isPlainClick(click({ altKey: true }))).toBe(false);
  });

  test('leaves a middle or right click to the browser', () => {
    expect(isPlainClick(click({ button: 1 }))).toBe(false);
    expect(isPlainClick(click({ button: 2 }))).toBe(false);
  });
});
