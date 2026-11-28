export interface TestRun {
  exitCode: number;
  passed: number;
  failed: number;
  errors: number;
}

/** A process error is not evidence that a regression assertion failed. */
export async function proveRegression(
  tests: readonly string[],
  run: (
    phase: 'baseline' | 'fixed',
    tests: readonly string[]
  ) => Promise<TestRun>
): Promise<boolean> {
  if (
    tests.length === 0 ||
    tests.some(
      (test) =>
        !/^packages\/relic-(?:format|server|viewer|mcp)\/test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(
          test
        ) || test.includes('..')
    )
  )
    return false;
  const baseline = await run('baseline', tests);
  if (
    baseline.exitCode !== 1 ||
    !Number.isSafeInteger(baseline.failed) ||
    baseline.failed < 1 ||
    baseline.errors !== 0
  )
    return false;
  const fixed = await run('fixed', tests);
  return (
    fixed.exitCode === 0 &&
    fixed.failed === 0 &&
    fixed.errors === 0 &&
    Number.isSafeInteger(fixed.passed) &&
    fixed.passed >= 1
  );
}
