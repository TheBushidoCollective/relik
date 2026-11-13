/**
 * Legacy readers and program archives (PATH.md, "Rendered OpenTimelineIO program", Check 9).
 *
 *   RELIC_LEGACY_VIEWER_DIST=<dist of a viewer built before the program change> \
 *   RELIC_OTIO_CHROME_PATH=<owned chrome-headless-shell> \
 *   mise exec -- bun packages/relic-mcp/test/otio-program-legacy-reader-path.ts
 *
 * A reader's browser can keep serving a viewer shell from before the program change, so that
 * viewer will meet archives the new publisher wrote. This proof serves the older viewer on a
 * loopback service and opens two archives of one document with it:
 *
 *   legacy   the archive with every `relic/program` member removed, which is what the
 *            publisher wrote before the change;
 *   program  the archive exactly as the new publisher wrote it, with `relic/program.json`
 *            and the rendered MP4.
 *
 * The legacy archive must open and play. The program archive must either open the same way, with
 * the same view and playing the same composition, or refuse with a clear error. It must never
 * show a partial program: the older viewer has no program state, and the proof asserts that.
 *
 * The publish needs the publisher's confined render profile, which exists on macOS in this
 * version. Elsewhere the publish has no program to test against and the proof fails, saying so.
 * Prints OTIO_LEGACY_READER_OK only after both archives were judged.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverChrome } from '../src/cover/chrome.ts';
import { buildProgramFixture } from './otio-program-fixture.ts';
import {
  createProofHarness,
  type ProofHarness,
} from './otio-program-harness.ts';
import { openViewer } from './otio-program-viewer.ts';

const legacyDist = process.env['RELIC_LEGACY_VIEWER_DIST'] ?? '';
assert.ok(
  legacyDist !== '',
  'RELIC_LEGACY_VIEWER_DIST must name the dist of a viewer built before the program change'
);
assert.ok(
  (await stat(join(legacyDist, 'viewer.js'))).isFile(),
  `no viewer.js in ${legacyDist}`
);
// The viewer under test must be one that knows nothing about programs.
for (const name of ['viewer.js', 'main.js']) {
  const text = await readFile(join(legacyDist, name), 'utf8').catch(() => '');
  assert.ok(
    !text.includes('data-otio-program-state') &&
      !text.includes('relic/program.json'),
    `${name} in RELIC_LEGACY_VIEWER_DIST already reads programs; it is not a pre-change viewer`
  );
}

const requestedChrome = process.env['RELIC_OTIO_CHROME_PATH'];
assert.ok(
  requestedChrome,
  'RELIC_OTIO_CHROME_PATH must name the owned chrome-headless-shell'
);
const chrome = await discoverChrome(requestedChrome);
assert.equal(chrome.kind, 'found', 'no Chrome for the legacy reader proof');
if (chrome.kind !== 'found') throw new Error('unreachable');
const publisherEnv = {
  RELIC_OTIO_CHROME_PATH: chrome.path,
  RELIC_CHROME_PATH: chrome.path,
};

function run(command: string, args: readonly string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const err: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve();
    else
      reject(
        new Error(
          `${command} exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`
        )
      );
  });
  return promise;
}

// Copies an archive without its program members, keeping each entry's compression.
const STRIP_PROGRAM = String.raw`
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
    for info in zin.infolist():
        if info.filename == "relic/program.json" or info.filename.startswith("relic/program/"):
            continue
        zout.writestr(info, zin.read(info.filename), compress_type=info.compress_type)
    # zipfile gives an entry without attributes the mode 0600 and no file type, which the reader
    # refuses. The publisher writes no attributes, so the directory is written with none.
    for info in zout.filelist:
        info.external_attr = 0
`;

async function withoutProgram(
  harness: ProofHarness,
  archive: Uint8Array
): Promise<Uint8Array> {
  const script = join(harness.scratch, 'strip-program.py');
  const src = join(harness.scratch, 'with-program.otioz');
  const dst = join(harness.scratch, 'without-program.otioz');
  await writeFile(script, STRIP_PROGRAM);
  await writeFile(src, archive);
  await run('python3', [script, src, dst]);
  return new Uint8Array(await readFile(dst));
}

interface Opened {
  /** 'opened' with a timeline view, or 'refused' with the error the reader is shown. */
  readonly outcome: 'opened' | 'refused';
  readonly refusal: string;
  /** How many elements carry each `otio-` class: the shape of the view. */
  readonly shape: Record<string, number>;
  readonly programState: boolean;
  readonly firstFrame: number;
  readonly lastFrame: number;
}

// Reads the older viewer through its own DOM. Nothing here uses the program contract, which
// that viewer does not have.
async function openWithLegacyViewer(
  harness: ProofHarness,
  shareUrl: string
): Promise<Opened> {
  const page = await openViewer({
    url: shareUrl,
    origin: harness.origin,
    sessionToken: await harness.createSession(),
  });
  try {
    const settled = await page.waitFor(
      'the older viewer to open or refuse the archive',
      async () => {
        const state = await page.evaluate<{
          view: boolean;
          play: boolean;
          dead: string;
          error: string;
        }>(`(() => {
          const stage = document.querySelector('main.stage');
          const view = document.querySelector('.otio-view');
          const dead = document.querySelector('main.stage.stage-dead');
          const errored = document.querySelector('[data-ready="error"]');
          return {
            view: view !== null,
            play: document.querySelector('button.otio-play') !== null,
            dead: dead ? (dead.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) : '',
            error: errored ? (errored.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) : '',
            stage: stage !== null,
          };
        })()`);
        if (state.view && state.play)
          return { outcome: 'opened' as const, refusal: '' };
        if (state.dead !== '')
          return { outcome: 'refused' as const, refusal: state.dead };
        if (state.error !== '')
          return { outcome: 'refused' as const, refusal: state.error };
        return undefined;
      },
      60_000
    );
    const describe = `(() => {
      const shape = {};
      for (const el of document.querySelectorAll('.otio-view, .otio-view *'))
        for (const token of el.classList)
          if (token.startsWith('otio-')) shape[token] = (shape[token] ?? 0) + 1;
      const root = document.querySelector('.otio-view');
      return {
        shape,
        programState: document.querySelector('[data-otio-program-state]') !== null,
        frame: Number(root?.dataset.frame ?? 'NaN'),
      };
    })()`;
    if (settled.outcome === 'refused') {
      const seen = await page.evaluate<{
        shape: Record<string, number>;
        programState: boolean;
      }>(describe);
      return {
        outcome: 'refused',
        refusal: settled.refusal,
        shape: seen.shape,
        programState: seen.programState,
        firstFrame: Number.NaN,
        lastFrame: Number.NaN,
      };
    }
    const before = await page.evaluate<{
      shape: Record<string, number>;
      programState: boolean;
      frame: number;
    }>(describe);
    // A trusted click, then the composition frame the view reports must move.
    await page.click('button.otio-play');
    const moved = await page.waitFor(
      'the composition to advance after Play',
      async () => {
        const frame = await page.evaluate<number>(
          `Number(document.querySelector('.otio-view')?.dataset.frame ?? 'NaN')`
        );
        return Number.isFinite(frame) && frame >= before.frame + 5
          ? frame
          : undefined;
      },
      30_000
    );
    const after = await page.evaluate<{ programState: boolean }>(describe);
    return {
      outcome: 'opened',
      refusal: '',
      shape: before.shape,
      programState: before.programState || after.programState,
      firstFrame: before.frame,
      lastFrame: moved,
    };
  } finally {
    await page.close();
  }
}

const harness = await createProofHarness('otio-legacy-reader', {
  viewerDist: legacyDist,
});
try {
  const fixture = await buildProgramFixture(
    join(harness.scratch, 'program'),
    'positive'
  );

  // Two relics of the same document, so each archive keeps its own link. The client refuses
  // to publish one source twice, so the second relic has its own copy of the fixture.
  const program = await harness.publish(fixture.bundleDir, publisherEnv);
  assert.ok(
    program.shareUrl.startsWith(harness.origin) &&
      program.shareUrl.includes('#'),
    'the program publish returned no link'
  );
  assert.equal(
    program.program.status,
    'rendered',
    `the new publisher wrote no program to test against: ${JSON.stringify(program.program)}`
  );
  const stored = await harness.openStored(program.relicId);
  const programEntries = await harness.listEntries(stored.archive);
  assert.ok(
    programEntries.includes('relic/program.json') &&
      programEntries.some(
        (name) => name.startsWith('relic/program/') && name.endsWith('.mp4')
      ),
    `the published archive has no program members: ${programEntries.join(', ')}`
  );

  const legacyFixture = await buildProgramFixture(
    join(harness.scratch, 'legacy'),
    'positive'
  );
  assert.deepEqual(
    await readFile(legacyFixture.contentOtioPath),
    await readFile(fixture.contentOtioPath),
    'the two fixture copies are not the same document'
  );
  const legacy = await harness.publish(legacyFixture.bundleDir, publisherEnv);
  assert.ok(
    legacy.shareUrl.startsWith(harness.origin) && legacy.shareUrl.includes('#'),
    'the legacy publish returned no link'
  );
  const legacyStored = await harness.openStored(legacy.relicId);
  const stripped = await withoutProgram(harness, legacyStored.archive);
  const legacyEntries = await harness.listEntries(stripped);
  assert.ok(
    !legacyEntries.some((name) => name.startsWith('relic/program')),
    'the legacy archive still has program members'
  );
  assert.deepEqual(
    legacyEntries,
    programEntries.filter((name) => !name.startsWith('relic/program')),
    'removing the program changed the other archive members'
  );
  await harness.storeArchive(legacy.relicId, stripped, legacyStored.relicKey);

  const legacyOpened = await openWithLegacyViewer(harness, legacy.shareUrl);
  assert.equal(
    legacyOpened.outcome,
    'opened',
    `the older viewer did not open a legacy archive: ${legacyOpened.refusal}`
  );
  assert.equal(
    legacyOpened.programState,
    false,
    'the viewer under test has a program state; it is not a pre-change viewer'
  );
  console.log(
    `OTIO_LEGACY_READER archive=legacy outcome=opened frames=${legacyOpened.firstFrame}->${legacyOpened.lastFrame} classes=${Object.keys(legacyOpened.shape).length}`
  );

  const programOpened = await openWithLegacyViewer(harness, program.shareUrl);
  assert.equal(
    programOpened.programState,
    false,
    'the older viewer showed a program state for a program archive'
  );
  if (programOpened.outcome === 'refused') {
    // A refusal is allowed, and it has to say something.
    assert.ok(
      programOpened.refusal.length > 0,
      'the older viewer refused the program archive without an error'
    );
    console.log(
      `OTIO_LEGACY_READER archive=program outcome=refused error=${JSON.stringify(programOpened.refusal)}`
    );
  } else {
    // Opened: it must be the same view of the same document, playing the composition.
    assert.deepEqual(
      programOpened.shape,
      legacyOpened.shape,
      'the older viewer built a different view for the program archive than for the legacy one'
    );
    assert.equal(
      programOpened.firstFrame,
      legacyOpened.firstFrame,
      'the program archive opened at a different frame'
    );
    console.log(
      `OTIO_LEGACY_READER archive=program outcome=opened frames=${programOpened.firstFrame}->${programOpened.lastFrame} classes=${Object.keys(programOpened.shape).length} view=same-as-legacy`
    );
  }
  console.log('OTIO_LEGACY_READER_OK');
} finally {
  await harness.close();
}
