/**
 * Negative controls for the rendered-program proof. Each control must fail safe: the source
 * archive still publishes, and the program is absent with the exact reason.
 *
 *   mise exec -- bun packages/relic-mcp/test/otio-program-controls.ts
 *
 * Prints OTIO_PROGRAM_CONTROLS_OK only when every control produced its exact reason.
 */

import assert from 'node:assert/strict';
import { readOtioProgramArchive, indexOtioZip } from '@relic/format';
import {
  createProofHarness,
  sha256Text,
  type ProgramSummary,
  PublishRefusedError,
} from './otio-program-harness.ts';
import {
  buildProgramFixture,
  type ProgramVariant,
} from './otio-program-fixture.ts';
import { openViewer, VIEWER_CONTRACT } from './otio-program-viewer.ts';

const harness = await createProofHarness('otio-program-controls');
const passed: string[] = [];
function pass(stage: string): void {
  passed.push(stage);
  console.log(`STAGE ${stage}`);
}

function reasonCodes(program: ProgramSummary): string[] {
  return (program.timelines ?? []).flatMap((t) => t.reasons.map((r) => r.code));
}

function expectUnavailable(
  program: ProgramSummary,
  code: string,
  label: string
): void {
  assert.equal(
    program.status,
    'unavailable',
    `${label}: program status ${program.status}`
  );
  assert.ok(
    reasonCodes(program).includes(code),
    `${label}: reasons ${JSON.stringify(reasonCodes(program))}, expected ${code}`
  );
  pass(`control-${label}`);
}

async function assertSourceOnly(relicId: string, label: string): Promise<void> {
  const { archive } = await harness.openStored(relicId);
  const entries = await harness.listEntries(archive);
  assert.ok(
    entries.includes('content.otio'),
    `${label}: source archive missing content.otio`
  );
  assert.ok(
    !entries.some((entry) => entry.startsWith('relic/program')),
    `${label}: a program entry was written`
  );
}

// Variants whose failure is a genuine property of the input, not a synthetic flag.
async function variantControl(
  variant: ProgramVariant,
  code: string
): Promise<void> {
  const fixture = await buildProgramFixture(harness.scratch, variant);
  const published = await harness.publish(fixture.bundleDir);
  expectUnavailable(published.program, code, variant);
  await assertSourceOnly(published.relicId, variant);
}

await variantControl('custom-wipe', 'unsupported-transition');
await variantControl('unknown-effect', 'unsupported-effect');

{
  const fixture = await buildProgramFixture(harness.scratch, 'positive');

  const overCapOutcome = await harness
    .publish(fixture.bundleDir, { RELIC_PROGRAM_MAX_BYTES: '1000' })
    .then(
      (published) => published,
      (error: unknown) => error
    );
  if (overCapOutcome instanceof PublishRefusedError) {
    const payload = JSON.stringify(overCapOutcome.payload);
    assert.ok(
      payload.includes('manifest-unfit'),
      `over-cap refusal is not manifest-unfit: ${payload}`
    );
    pass('control-over-cap');
  } else {
    expectUnavailable(overCapOutcome.program, 'size-cap-exceeded', 'over-cap');
    await assertSourceOnly(overCapOutcome.relicId, 'over-cap');
  }

  const noBrowser = await harness.publish(fixture.bundleDir, {
    RELIC_OTIO_CHROME_PATH: '/nonexistent/chrome',
    RELIC_CHROME_PATH: '/nonexistent/chrome',
  });
  expectUnavailable(
    noBrowser.program,
    'unsupported-browser',
    'browser-missing'
  );
  await assertSourceOnly(noBrowser.relicId, 'browser-missing');

  const noEncoder = await harness.publish(fixture.bundleDir, {
    RELIC_PROGRAM_ENCODER_OFF: '1',
  });
  expectUnavailable(noEncoder.program, 'encoder-unavailable', 'encoder-off');
  await assertSourceOnly(noEncoder.relicId, 'encoder-off');

  for (const value of ['0', '-5', 'abc']) {
    const outcome = await harness
      .publish(fixture.bundleDir, { RELIC_PROGRAM_MAX_BYTES: value })
      .then(
        () => 'published',
        (error: unknown) => error
      );
    assert.ok(
      outcome instanceof PublishRefusedError,
      `RELIC_PROGRAM_MAX_BYTES=${value} was not refused (${String(outcome)})`
    );
    const payload = JSON.stringify(outcome.payload);
    assert.ok(
      payload.includes('program_refused') && payload.includes('invalid-config'),
      `RELIC_PROGRAM_MAX_BYTES=${value} refusal payload ${payload}`
    );
  }
  pass('control-invalid-config');
}

{
  // Tamper: the stored program digest is rewritten, sealed with the same relic key, and must be
  // refused by the validator and by the viewer, which must show unavailable and refuse play().
  const fixture = await buildProgramFixture(harness.scratch, 'positive');
  const published = await harness.publish(fixture.bundleDir);
  assert.equal(
    published.program.status,
    'rendered',
    'tamper baseline must render'
  );
  const { archive, relicKey } = await harness.openStored(published.relicId);
  const manifestBytes = await harness.readEntry(archive, 'relic/program.json');
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as {
    document_sha256: string;
    timelines: Array<{ timeline_id: string; program?: { sha256: string } }>;
  };
  const rendered = manifest.timelines.find((t) => t.program);
  assert.ok(rendered?.program, 'tamper: no rendered timeline');
  rendered.program.sha256 = sha256Text(
    new TextEncoder().encode('not the program')
  );
  const tampered = await harness.rewriteEntries(archive, {
    'relic/program.json': new TextEncoder().encode(JSON.stringify(manifest)),
  });

  const contentOtio = await harness.readEntry(archive, 'content.otio');
  const refusal = await readOtioProgramArchive(indexOtioZip(tampered), {
    document_sha256: sha256Text(contentOtio),
    timeline_ids: manifest.timelines.map((t) => t.timeline_id),
  }).then(
    () => 'accepted',
    (error: unknown) =>
      error instanceof Error && 'code' in error
        ? String(error.code)
        : `unlabelled:${String(error)}`
  );
  assert.equal(
    refusal,
    'digest-mismatch',
    `validator refused the tamper as ${refusal}`
  );
  pass('control-tamper-validator');

  await harness.storeArchive(published.relicId, tampered, relicKey);
  const token = await harness.createSession();
  const page = await openViewer({
    url: published.shareUrl,
    origin: harness.origin,
    sessionToken: token,
  });
  try {
    const state = await page.waitFor(
      'viewer state for the tampered relic',
      async () => {
        const value = await page.evaluate<string | null>(
          `document.querySelector('.otio-view')?.getAttribute('${VIEWER_CONTRACT.stateAttribute}') ?? null`
        );
        return value ?? undefined;
      }
    );
    assert.equal(state, 'unavailable', `tampered viewer state ${state}`);
    const reason = await page.evaluate<string | null>(
      `document.querySelector('.otio-view')?.getAttribute('${VIEWER_CONTRACT.reasonAttribute}') ?? null`
    );
    assert.equal(reason, 'digest-mismatch', `tampered viewer reason ${reason}`);
    const refused = await page.evaluate<string>(`(async () => {
      try { await window.${VIEWER_CONTRACT.hook}.play(); return 'played'; }
      catch (error) { return String(error && error.name); }
    })()`);
    assert.notEqual(refused, 'played', 'viewer played a tampered program');
    pass('control-tamper-viewer');
  } finally {
    await page.close();
  }
}

await harness.close();
assert.equal(
  passed.length,
  8,
  `expected 8 control stages, ran ${passed.length}`
);
console.log('OTIO_PROGRAM_CONTROLS_OK');
