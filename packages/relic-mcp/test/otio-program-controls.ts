/**
 * Negative controls for the rendered-program proof. Each control must fail safe, and each
 * refusal must come from the stated cause, not from a side effect of the rewrite.
 *
 *   OTIO_PYTHON=/path/to/python mise exec -- bun packages/relic-mcp/test/otio-program-controls.ts
 *
 * Prints OTIO_PROGRAM_CONTROLS_OK only when every control produced its exact outcome.
 */

import assert from 'node:assert/strict';
import { indexOtioZip, readOtioProgramArchive } from '@relic/format';
import {
  buildProgramFixture,
  type ProgramVariant,
} from './otio-program-fixture.ts';
import {
  createProofHarness,
  PublishRefusedError,
  programValidatorArgs,
  type ProgramSummary,
  type PublishResult,
  sha256Text,
} from './otio-program-harness.ts';
import { openViewer, VIEWER_CONTRACT } from './otio-program-viewer.ts';

const harness = await createProofHarness('otio-program-controls');
const passed: string[] = [];
function pass(stage: string): void {
  passed.push(stage);
  console.log(`STAGE ${stage}`);
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
  const codes = (program.timelines ?? []).flatMap((t) =>
    t.reasons.map((r) => r.code)
  );
  assert.ok(
    codes.includes(code),
    `${label}: reasons ${JSON.stringify(codes)}, expected ${code}`
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

/** Genuine unsupported-feature inputs: the failure is a property of the document. */
async function variantControl(
  variant: ProgramVariant,
  code: string
): Promise<void> {
  const fixture = await buildProgramFixture(harness.scratch, variant);
  const published = await harness.publish(fixture.bundleDir);
  expectUnavailable(published.program, code, variant);
  await assertSourceOnly(published.relicId, variant);
}

/** The validator's verdict on an archive: accepted, or the error code it threw. */
async function validatorRefusal(
  archive: Uint8Array,
  contentOtio: Uint8Array
): Promise<string> {
  try {
    const zip = await indexOtioZip(archive);
    const program = await readOtioProgramArchive(
      zip,
      await programValidatorArgs(zip, contentOtio)
    );
    return program ? 'accepted' : 'no-program';
  } catch (error) {
    return error instanceof Error && 'code' in error
      ? String(error.code)
      : `unlabelled:${String(error)}`;
  }
}

interface MutableProgram {
  sha256: string;
  frame_rate: { num: number; den: number };
  range: {
    start_time: { value: number; rate: number };
    duration: { value: number; rate: number };
  };
}
interface MutableManifest {
  media: Record<string, string>;
  timelines: Array<{ program?: MutableProgram }>;
}

function renderedProgram(manifest: MutableManifest): MutableProgram {
  const program = manifest.timelines[0]?.program;
  if (!program)
    throw new Error('control manifest has no rendered program to mutate');
  return program;
}

/**
 * Each case changes one field of a valid manifest. The expected code is the format's own: parse
 * refusals are malformed-manifest, and a media key that does not match the document is
 * archive-mismatch. A different code is a failure of the control, not a pass.
 */
const VALIDATOR_CASES: ReadonlyArray<{
  readonly name: string;
  readonly expect: string;
  readonly mutate: (manifest: MutableManifest) => void;
  readonly raw?: (text: string) => string;
}> = [
  {
    name: 'frame-rate-below-1fps',
    expect: 'malformed-manifest',
    mutate: (m) => {
      renderedProgram(m).frame_rate = { num: 1, den: 2 };
    },
  },
  {
    name: 'duration-under-one-frame',
    expect: 'malformed-manifest',
    mutate: (m) => {
      renderedProgram(m).range.duration = { value: 0, rate: 30 };
    },
  },
  {
    name: 'duration-unsafe-integer',
    expect: 'malformed-manifest',
    mutate: (m) => {
      renderedProgram(m).range.duration = { value: 0, rate: 30 };
    },
    // 2^53 + 1 is not a safe integer and JSON.stringify cannot write it, so the literal is spliced.
    raw: (text) => {
      const from = '"duration":{"value":0,"rate":30}';
      if (text.split(from).length !== 2)
        throw new Error(
          'unsafe-integer control: the duration literal is not unique'
        );
      return text.replace(
        from,
        '"duration":{"value":9007199254740993,"rate":30}'
      );
    },
  },
  {
    name: 'nonzero-start-time',
    expect: 'malformed-manifest',
    mutate: (m) => {
      renderedProgram(m).range.start_time = { value: 1, rate: 30 };
    },
  },
  {
    name: 'extra-media-key',
    expect: 'archive-mismatch',
    mutate: (m) => {
      m.media['media/extra.wav'] = sha256Text(
        new TextEncoder().encode('extra')
      );
    },
  },
  {
    name: 'missing-media-key',
    expect: 'archive-mismatch',
    mutate: (m) => {
      const [first] = Object.keys(m.media);
      if (!first)
        throw new Error('control manifest has no media key to remove');
      delete m.media[first];
    },
  },
];

// Variants whose failure is a genuine property of the input.
await variantControl('custom-wipe', 'unsupported-transition');
await variantControl('unknown-effect', 'unsupported-effect');

{
  const fixture = await buildProgramFixture(harness.scratch, 'positive');

  let overCapPublished: PublishResult | undefined;
  let overCapRefused: PublishRefusedError | undefined;
  try {
    overCapPublished = await harness.publish(fixture.bundleDir, {
      RELIC_PROGRAM_MAX_BYTES: '1000',
    });
  } catch (error) {
    if (!(error instanceof PublishRefusedError)) throw error;
    overCapRefused = error;
  }
  if (overCapRefused) {
    const payload = JSON.stringify(overCapRefused.payload);
    assert.ok(
      payload.includes('manifest-unfit'),
      `over-cap refusal is not manifest-unfit: ${payload}`
    );
    pass('control-over-cap');
  } else {
    assert.ok(
      overCapPublished,
      'over-cap produced neither a result nor a refusal'
    );
    expectUnavailable(
      overCapPublished.program,
      'size-cap-exceeded',
      'over-cap'
    );
    await assertSourceOnly(overCapPublished.relicId, 'over-cap');
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
    let refusal: PublishRefusedError | undefined;
    try {
      await harness.publish(fixture.bundleDir, {
        RELIC_PROGRAM_MAX_BYTES: value,
      });
    } catch (error) {
      if (error instanceof PublishRefusedError) refusal = error;
      else throw error;
    }
    assert.ok(refusal, `RELIC_PROGRAM_MAX_BYTES=${value} was not refused`);
    const payload = JSON.stringify(refusal.payload);
    assert.ok(
      payload.includes('program_refused') && payload.includes('invalid-config'),
      `RELIC_PROGRAM_MAX_BYTES=${value} refusal payload ${payload}`
    );
  }
  pass('control-invalid-config');
}

{
  // The validator must refuse each manifest mutation with the stated code. The baseline is a
  // valid positive archive, so every refusal below comes from its one mutated field.
  const fixture = await buildProgramFixture(harness.scratch, 'positive');
  const published = await harness.publish(fixture.bundleDir);
  assert.equal(
    published.program.status,
    'rendered',
    'validator baseline must render'
  );
  const { archive, relicKey } = await harness.openStored(published.relicId);
  const contentOtio = await harness.readEntry(archive, 'content.otio');
  const baseline = JSON.parse(
    Buffer.from(
      await harness.readEntry(archive, 'relic/program.json')
    ).toString('utf8')
  ) as MutableManifest;
  const baselineVerdict = await validatorRefusal(archive, contentOtio);
  assert.equal(
    baselineVerdict,
    'accepted',
    `the unmodified archive must be accepted, got ${baselineVerdict}`
  );

  for (const kase of VALIDATOR_CASES) {
    const manifest = structuredClone(baseline);
    kase.mutate(manifest);
    const text = JSON.stringify(manifest);
    const rewritten = await harness.rewriteEntries(archive, {
      'relic/program.json': new TextEncoder().encode(
        kase.raw ? kase.raw(text) : text
      ),
    });
    const verdict = await validatorRefusal(rewritten, contentOtio);
    assert.equal(
      verdict,
      kase.expect,
      `${kase.name}: refused as ${verdict}, expected ${kase.expect}`
    );
    pass(`control-validator-${kase.name}`);
  }
  // Digest tamper: the stored program digest is wrong, sealed with the same relic key. The
  // validator must refuse it, and the viewer must show unavailable and refuse play().
  const tamperedManifest = structuredClone(baseline);
  const rendered = tamperedManifest.timelines.find((t) => t.program);
  assert.ok(rendered?.program, 'tamper: no rendered timeline');
  rendered.program.sha256 = sha256Text(
    new TextEncoder().encode('not the program')
  );
  const tampered = await harness.rewriteEntries(archive, {
    'relic/program.json': new TextEncoder().encode(
      JSON.stringify(tamperedManifest)
    ),
  });
  const refusal = await validatorRefusal(tampered, contentOtio);
  assert.equal(
    refusal,
    'digest-mismatch',
    `validator refused the tamper as ${refusal}`
  );
  pass('control-tamper-validator');

  await harness.storeArchive(published.relicId, tampered, relicKey);
  const page = await openViewer({
    url: published.shareUrl,
    origin: harness.origin,
    sessionToken: await harness.createSession(),
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
    const playOutcome = await page.evaluate<string>(`(async () => {
      try { await window.${VIEWER_CONTRACT.hook}.play(); return 'played'; }
      catch (error) { return String(error && error.name); }
    })()`);
    assert.notEqual(playOutcome, 'played', 'viewer played a tampered program');
    pass('control-tamper-viewer');
  } finally {
    await page.close();
  }
}

await harness.close();
assert.equal(
  passed.length,
  14,
  `expected 14 control stages, ran ${passed.length}`
);
console.log('OTIO_PROGRAM_CONTROLS_OK');
