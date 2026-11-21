import { afterEach, expect, jest, test } from 'bun:test';
import { documentWatchdog } from '../src/document-route.ts';
import type { DocumentStateMessage } from '../src/frame-document-protocol.ts';

afterEach(() => jest.useRealTimers());

test('watchdog fails once at its deadline and ignores late states', () => {
  jest.useFakeTimers();
  const states: DocumentStateMessage[] = [];
  const finish = documentWatchdog((state) => states.push(state));
  jest.advanceTimersByTime(29999);
  expect(states).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(states).toEqual([
    { type: 'relic:document-state', state: 'failed', reason: 'corrupt' },
  ]);
  finish({ type: 'relic:document-state', state: 'ready' });
  expect(states).toHaveLength(1);
});

test('a first state cancels the watchdog and later states', () => {
  jest.useFakeTimers();
  const states: DocumentStateMessage[] = [];
  const finish = documentWatchdog((state) => states.push(state));
  const ready = { type: 'relic:document-state', state: 'ready' } as const;
  finish(ready);
  finish({ type: 'relic:document-state', state: 'failed', reason: 'corrupt' });
  jest.advanceTimersByTime(30000);
  expect(states).toEqual([ready]);
});
