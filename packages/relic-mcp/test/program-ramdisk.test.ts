import { expect, test } from 'bun:test';
import { run } from '../src/program/ramdisk.ts';

// Collects anything that escapes as an uncaught exception while `body` runs. The child's close
// event, which settles `run`, comes after its stdin has closed, so a write error has already
// been raised by then; one more turn of the loop covers a listener queued behind it.
async function uncaughtDuring(body: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error);
  };
  process.on('uncaughtException', onUncaught);
  try {
    await body();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

// A tool that exits without reading its input closes the pipe under the write. That write
// error must not escape as an uncaught exception: the exit code decides the outcome.
// Publishing crashed this way in the program proof ("UNCAUGHT EXCEPTION IN RELIC-MCP:
// Error: write EPIPE" out of createPrivateRamVolume).
test('a tool that exits before reading its input still reports its exit code', async () => {
  let code: number | undefined;
  const uncaught = await uncaughtDuring(async () => {
    // Larger than a pipe buffer, so the write is still pending when the tool exits.
    code = (await run('/usr/bin/true', [], 'x'.repeat(4 * 1024 * 1024))).code;
  });
  expect(code).toBe(0);
  expect(uncaught).toEqual([]);
});

test('a tool that cannot start rejects with the spawn error and nothing else', async () => {
  let failure: unknown;
  const uncaught = await uncaughtDuring(async () => {
    try {
      await run('/nonexistent/relic-program-tool', [], 'input');
    } catch (error) {
      failure = error;
    }
  });
  expect(failure).toBeInstanceOf(Error);
  expect((failure as NodeJS.ErrnoException).code).toBe('ENOENT');
  expect(uncaught).toEqual([]);
});
