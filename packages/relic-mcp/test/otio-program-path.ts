/**
 * Rendered-program publish-to-viewer proof.
 *
 *   mise exec -- bun packages/relic-mcp/test/otio-program-path.ts
 *
 * The positive composition has a 48 kHz chirp and a 44.1 kHz tone (the renderer resamples it).
 * It is published through a fresh relic-mcp process over MCP stdio, and then:
 *   1. the stored ciphertext is decrypted and unpacked with Python's zipfile, not Relic's reader;
 *   2. relic/program.json and content.otio are read independently: digests, sizes, fields, and
 *      timeline range start 0;
 *   3. the rendered MP4 is decoded with ffprobe and ffmpeg and checked against the analytic
 *      reference, frame by frame and sample by sample;
 *   4. the audio onset and any edit list are measured and recorded, not corrected;
 *   5. the global-start variant (global_start_time 3600 s at 24 fps) is published and must match
 *      the positive render frame for frame and sample for sample;
 *   6. the format validator must accept the archive;
 *   7. the viewer, in owned headless Chrome, is checked for cold and steady playback, time mapping,
 *      focus, comment create/read-back, the comment reveal through the real thread and timeline,
 *      and the element audio capture.
 *
 * Prints OTIO_PROGRAM_PATH_OK only after all fifteen stages pass. Nothing is skipped or softened.
 *
 * Platform: the publisher renders only with its isolated profile directory (RAM disk on macOS,
 * tmpfs on Linux, as its docs define). Without it every timeline is unsupported-browser and the
 * "published" stage fails truthfully. That is a blocker to report, not a case to bypass.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { indexOtioZip, readOtioProgramArchive } from '@relic/format';
import { discoverChrome } from '../src/cover/chrome.ts';
import {
  alignAudio,
  AUDIO_MIN_SNR_DB,
  checkFrame,
  checkTimestamps,
  findAudioFaults,
  type RgbFrame,
} from './otio-program-checks.ts';
import {
  type CommentRecord,
  commentRoundTrip,
  type CommentReadback,
} from './otio-program-comments.ts';
import { buildProgramFixture } from './otio-program-fixture.ts';
import {
  createProofHarness,
  type ProofHarness,
  programValidatorArgs,
  sha256Text,
} from './otio-program-harness.ts';
import {
  decodeAudio,
  forEachVideoFrame,
  probeStreams,
  type DecodedAudio,
  videoPresentationTimes,
} from './otio-program-media.ts';
import { trackEditLists } from './otio-program-mp4.ts';
import {
  chirp,
  expectedAudio,
  expectedFrame,
  PROGRAM,
} from './otio-program-reference.ts';
import {
  captureElementAudio,
  openViewer,
  type ViewerPage,
  VIEWER_CONTRACT,
} from './otio-program-viewer.ts';

interface RawRational {
  readonly value: number;
  readonly rate: number;
}
interface RawProgram {
  readonly entry: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly range: {
    readonly start_time: RawRational;
    readonly duration: RawRational;
  };
  readonly frame_rate: { readonly num: number; readonly den: number };
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly video_codec: string;
  readonly audio_codec: string;
  readonly audio_rate: number;
  readonly channels: number;
  readonly audio_samples: number;
}
interface RawTimeline {
  readonly timeline_id: string;
  readonly index: number;
  readonly status: 'rendered' | 'unavailable';
  readonly reasons: ReadonlyArray<{ readonly code: string }>;
  readonly program?: RawProgram;
}
interface RawManifest {
  readonly schema: string;
  readonly document_sha256: string;
  readonly media: Readonly<Record<string, string>>;
  readonly timelines: readonly RawTimeline[];
}

interface PublishedArchive {
  readonly relicId: string;
  readonly shareUrl: string;
  readonly relicKey: Uint8Array;
  readonly contentOtio: Uint8Array;
  readonly manifest: RawManifest;
  readonly archive: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly rendered: RawProgram;
  readonly mp4: Uint8Array;
}

const passed: string[] = [];
function pass(stage: string): void {
  passed.push(stage);
  console.log(`STAGE ${stage}`);
}

const chrome = await discoverChrome(process.env['RELIC_OTIO_CHROME_PATH']);
assert.equal(
  chrome.kind,
  'found',
  'RELIC_OTIO_CHROME_PATH must name a Chrome for the publisher'
);
if (chrome.kind !== 'found') throw new Error('unreachable');
const publisherEnv = {
  RELIC_OTIO_CHROME_PATH: chrome.path,
  RELIC_CHROME_PATH: chrome.path,
};

function manifestFailures(
  manifest: RawManifest,
  contentOtio: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>
): string[] {
  const failures: string[] = [];
  if (manifest.schema !== 'relic.otio.program/1')
    failures.push(`schema ${manifest.schema}`);
  if (manifest.document_sha256 !== sha256Text(contentOtio))
    failures.push('document_sha256 does not match content.otio');
  for (const [path, digest] of Object.entries(manifest.media)) {
    const bytes = files.get(path);
    if (!bytes) failures.push(`media ${path} is not in the archive`);
    else if (sha256Text(bytes) !== digest)
      failures.push(`media ${path} digest mismatch`);
  }
  for (const timeline of manifest.timelines) {
    const program = timeline.program;
    if (timeline.status !== 'rendered' || !program) {
      failures.push(`timeline ${timeline.timeline_id} is ${timeline.status}`);
      continue;
    }
    const expectedEntry = `relic/program/timeline-${timeline.index}.mp4`;
    if (program.entry !== expectedEntry)
      failures.push(`entry ${program.entry} != ${expectedEntry}`);
    const bytes = files.get(program.entry);
    if (!bytes) failures.push(`entry ${program.entry} missing`);
    else {
      if (bytes.length !== program.bytes)
        failures.push(`entry bytes ${bytes.length} != ${program.bytes}`);
      if (sha256Text(bytes) !== program.sha256)
        failures.push(`entry sha256 mismatch for ${program.entry}`);
    }
    // The renderer evaluates from timeline time 0 for every document, origin included.
    if (program.range.start_time.value !== 0)
      failures.push(
        `manifest range start ${program.range.start_time.value}/${program.range.start_time.rate} != 0`
      );
    if (program.frame_rate.num !== PROGRAM.fps || program.frame_rate.den !== 1)
      failures.push(
        `frame rate ${program.frame_rate.num}/${program.frame_rate.den}`
      );
    if (program.frames !== PROGRAM.frames)
      failures.push(`frames ${program.frames} != ${PROGRAM.frames}`);
    if (program.width !== PROGRAM.width || program.height !== PROGRAM.height)
      failures.push(`size ${program.width}x${program.height}`);
    if (!program.video_codec.startsWith('avc1.'))
      failures.push(`video codec ${program.video_codec}`);
    if (program.audio_codec !== 'mp4a.40.2')
      failures.push(`audio codec ${program.audio_codec}`);
    if (program.audio_rate !== PROGRAM.audioRate)
      failures.push(`audio rate ${program.audio_rate}`);
    if (program.channels !== PROGRAM.audioChannels)
      failures.push(`channels ${program.channels}`);
    if (program.audio_samples !== PROGRAM.audioSamples)
      failures.push(
        `audio samples ${program.audio_samples} != ${PROGRAM.audioSamples}`
      );
  }
  return failures;
}

/** Decodes the rendered MP4 with ffprobe and ffmpeg and checks it against the reference. */
async function verifyRenderedMedia(
  mp4: string,
  program: RawProgram
): Promise<string[]> {
  const failures: string[] = [];
  const streams = await probeStreams(mp4);
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video || !audio)
    failures.push('rendered MP4 lacks a video or audio stream');
  if (video) {
    if (video.width !== program.width || video.height !== program.height)
      failures.push(`probed size ${video.width}x${video.height}`);
    if (video.codec_name !== 'h264')
      failures.push(`video codec ${video.codec_name}`);
    if (Number(video.start_time ?? 0) > 1 / PROGRAM.fps)
      failures.push(`video start ${video.start_time}`);
  }
  if (audio) {
    if (Number(audio.sample_rate) !== PROGRAM.audioRate)
      failures.push(`audio sample rate ${audio.sample_rate}`);
    if (audio.codec_name !== 'aac')
      failures.push(`audio codec ${audio.codec_name}`);
    if (audio.channels !== PROGRAM.audioChannels)
      failures.push(`audio channels ${audio.channels}`);
  }

  failures.push(
    ...checkTimestamps(await videoPresentationTimes(mp4), PROGRAM.frames)
  );
  const count = await forEachVideoFrame(
    mp4,
    PROGRAM.width,
    PROGRAM.height,
    (index: number, frame: RgbFrame) => {
      failures.push(
        ...checkFrame(frame, expectedFrame(index), `frame ${index}`)
      );
    }
  );
  if (count !== PROGRAM.frames) failures.push(`decoded ${count} frames`);

  const decoded = await decodeAudio(mp4, PROGRAM.audioRate);
  const expected = expectedAudio();
  if (Math.abs(decoded.left.length - PROGRAM.audioSamples) > 1024)
    failures.push(`decoded audio ${decoded.left.length} samples`);
  const boundaries = [48000, 144000, 216000, 240000];
  for (const [name, channel] of [
    ['left', decoded.left],
    ['right', decoded.right],
  ] as const) {
    const alignment = alignAudio(channel, expected);
    if (Math.abs(alignment.lagSamples) > 96)
      failures.push(`${name} audio lag ${alignment.lagSamples}`);
    if (alignment.snrDb < AUDIO_MIN_SNR_DB)
      failures.push(`${name} audio SNR ${alignment.snrDb.toFixed(1)} dB`);
    for (const fault of findAudioFaults(
      channel,
      expected,
      PROGRAM.audioRate,
      alignment.lagSamples,
      boundaries
    ))
      failures.push(
        `${name} audio ${fault.kind} at ${fault.startSeconds.toFixed(3)} s`
      );
  }
  return failures;
}

/** Per-frame and per-sample digests of a rendered MP4, for exact comparison between renders. */
async function digestRendered(
  mp4: string
): Promise<{ frames: string[]; audio: DecodedAudio; audioSha: string }> {
  const frames: string[] = [];
  await forEachVideoFrame(
    mp4,
    PROGRAM.width,
    PROGRAM.height,
    (_index: number, frame: RgbFrame) => {
      frames.push(sha256Text(frame.data));
    }
  );
  const audio = await decodeAudio(mp4, PROGRAM.audioRate);
  const interleaved = new Float32Array(audio.left.length * 2);
  for (let i = 0; i < audio.left.length; i++) {
    interleaved[2 * i] = audio.left[i] ?? 0;
    interleaved[2 * i + 1] = audio.right[i] ?? 0;
  }
  return {
    frames,
    audio,
    audioSha: sha256Text(new Uint8Array(interleaved.buffer)),
  };
}

/** Publishes a fixture, decrypts it from storage, and reads its manifest and media independently. */
async function publishAndUnpack(
  harness: ProofHarness,
  bundleDir: string
): Promise<PublishedArchive> {
  const published = await harness.publish(bundleDir, publisherEnv);
  assert.ok(published.relicId, 'publish returned no relic_id');
  assert.ok(
    published.shareUrl.startsWith(harness.origin) &&
      published.shareUrl.includes('#'),
    `publish URL: ${published.shareUrl}`
  );
  assert.equal(
    published.program.status,
    'rendered',
    `publish program status ${published.program.status}`
  );
  const { archive, relicKey } = await harness.openStored(published.relicId);
  const manifest = JSON.parse(
    Buffer.from(
      await harness.readEntry(archive, 'relic/program.json')
    ).toString('utf8')
  ) as RawManifest;
  const contentOtio = await harness.readEntry(archive, 'content.otio');
  const files = new Map<string, Uint8Array>([['content.otio', contentOtio]]);
  for (const timeline of manifest.timelines)
    if (timeline.program)
      files.set(
        timeline.program.entry,
        await harness.readEntry(archive, timeline.program.entry)
      );
  const rendered = manifest.timelines.find((t) => t.program)?.program;
  assert.ok(rendered, 'no rendered timeline in the archive');
  const mp4 = files.get(rendered.entry);
  assert.ok(mp4, 'rendered MP4 missing from the archive');
  return {
    relicId: published.relicId,
    shareUrl: published.shareUrl,
    relicKey,
    contentOtio,
    manifest,
    archive,
    files,
    rendered,
    mp4,
  };
}

/** First sample index where the analytic chirp exceeds the threshold, from source time 0. */
function expectedChirpOnset(threshold: number): number {
  for (let n = 0; n < 48000; n++)
    if (Math.abs(chirp(n / PROGRAM.audioRate)) > threshold) return n;
  throw new Error('analytic chirp never exceeds the threshold');
}

/** First sample index in the decoded channel that exceeds the threshold. */
function firstAboveThreshold(samples: Float32Array, threshold: number): number {
  for (let n = 0; n < samples.length; n++)
    if (Math.abs(samples[n] ?? 0) > threshold) return n;
  return -1;
}

const harness = await createProofHarness('otio-program-path');
const measured: Record<string, number | string> = {};
try {
  // Stage 1-6: the positive render, unpacked and verified independently.
  const positiveFixture = await buildProgramFixture(
    harness.scratch,
    'positive'
  );
  pass('fixture-built');

  const positive = await publishAndUnpack(harness, positiveFixture.bundleDir);
  pass('published');
  pass('decrypted');

  assert.deepEqual(
    manifestFailures(positive.manifest, positive.contentOtio, positive.files),
    [],
    'independent manifest read failed'
  );
  pass('manifest-independent');

  const positiveZip = await indexOtioZip(positive.archive);
  const validated = await readOtioProgramArchive(
    positiveZip,
    await programValidatorArgs(positiveZip, positive.contentOtio)
  );
  assert.ok(
    validated,
    'readOtioProgramArchive returned null for a program archive'
  );
  pass('format-validator-agrees');

  const positiveMp4 = join(harness.scratch, 'positive.mp4');
  await writeFile(positiveMp4, positive.mp4);
  assert.deepEqual(
    await verifyRenderedMedia(positiveMp4, positive.rendered),
    [],
    'rendered media failed the reference'
  );
  pass('rendered-media-independent');

  // Stage 7: the audio onset and edit lists are measured on the real output, and recorded.
  const tracks = trackEditLists(positive.mp4);
  const audioTrack = tracks.find((t) => t.handler === 'soun');
  assert.ok(audioTrack, 'no audio track in the rendered MP4');
  measured['audio_elst_present'] = audioTrack.entries === null ? 'no' : 'yes';
  measured['audio_elst_entries'] = audioTrack.entries?.length ?? 0;
  const decodedPositive = await decodeAudio(positiveMp4, PROGRAM.audioRate);
  const onsetRendered = firstAboveThreshold(decodedPositive.left, 0.005);
  const onsetExpected = expectedChirpOnset(0.005);
  measured['audio_onset_rendered_samples'] = onsetRendered;
  measured['audio_onset_expected_samples'] = onsetExpected;
  measured['audio_onset_offset_samples'] = onsetRendered - onsetExpected;
  pass('audio-onset-measured');

  // Stage 8: non-zero global_start_time must render exactly like the positive composition.
  const globalFixture = await buildProgramFixture(
    harness.scratch,
    'global-start'
  );
  const globalStart = await publishAndUnpack(harness, globalFixture.bundleDir);
  assert.deepEqual(
    manifestFailures(
      globalStart.manifest,
      globalStart.contentOtio,
      globalStart.files
    ),
    [],
    'global-start manifest failed'
  );
  const globalMp4 = join(harness.scratch, 'global-start.mp4');
  await writeFile(globalMp4, globalStart.mp4);
  assert.deepEqual(
    await verifyRenderedMedia(globalMp4, globalStart.rendered),
    [],
    'global-start render failed the reference'
  );
  const positiveDigest = await digestRendered(positiveMp4);
  const globalDigest = await digestRendered(globalMp4);
  const frameMismatches = positiveDigest.frames.filter(
    (hash, i) => hash !== globalDigest.frames[i]
  ).length;
  assert.equal(
    globalDigest.frames.length,
    positiveDigest.frames.length,
    'global-start frame count differs'
  );
  assert.equal(
    frameMismatches,
    0,
    `global-start differs from positive in ${frameMismatches} frames`
  );
  assert.equal(
    globalDigest.audioSha,
    positiveDigest.audioSha,
    'global-start audio samples differ from positive'
  );
  pass('global-start-matches-positive');

  // Stage 9-12: the viewer, against the positive relic.
  const token = await harness.createSession();
  const page: ViewerPage = await openViewer({
    url: positive.shareUrl,
    origin: harness.origin,
    sessionToken: token,
  });
  let comment: CommentReadback;
  try {
    const state = await page.waitFor('program state', async () => {
      const value = await page.evaluate<string | null>(
        `document.querySelector('.otio-view')?.getAttribute('${VIEWER_CONTRACT.stateAttribute}') ?? null`
      );
      return value ?? undefined;
    });
    assert.equal(state, 'program', `viewer state ${state}, expected program`);

    const cold = await page.evaluate<number>(`(async () => {
      const video = document.querySelector('video.otio-program-video');
      if (!video) throw new Error('no native program video');
      const hook = window.${VIEWER_CONTRACT.hook};
      const start = performance.now();
      let first = null;
      video.requestVideoFrameCallback(() => { first = performance.now(); });
      await hook.play();
      while (first === null) await new Promise((r) => setTimeout(r, 2));
      return first - start;
    })()`);
    measured['startup_cold_ms'] = cold;
    assert.ok(cold <= 350, `cold startup ${cold.toFixed(1)} ms > 350 ms`);
    pass('viewer-cold-startup');

    const intervals = await page.evaluate<number[]>(`(async () => {
      const video = document.querySelector('video.otio-program-video');
      const hook = window.${VIEWER_CONTRACT.hook};
      const times = [];
      let running = true;
      const sample = (now) => { if (!running) return; times.push(now); video.requestVideoFrameCallback(sample); };
      video.requestVideoFrameCallback(sample);
      await new Promise((r) => setTimeout(r, 4000));
      running = false;
      await hook.pause();
      return times.slice(1).map((t, i) => t - times[i]);
    })()`);
    const sorted = [...intervals].sort((a, b) => a - b);
    const p95 =
      sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    const max = sorted[sorted.length - 1] ?? Number.POSITIVE_INFINITY;
    measured['steady_p95_ms'] = p95;
    measured['steady_max_ms'] = max;
    assert.ok(
      intervals.length >= 90,
      `only ${intervals.length + 1} presented frames in 4 s`
    );
    assert.ok(p95 <= 50, `steady p95 ${p95.toFixed(1)} ms > 50 ms`);
    assert.ok(max <= 100, `steady max ${max.toFixed(1)} ms > 100 ms`);
    pass('viewer-steady-playback');

    for (const seconds of [0.5, 2.0, 3.5, 5.5]) {
      await page.evaluate(`window.${VIEWER_CONTRACT.hook}.seek(${seconds})`);
      const snap = await page.snapshot();
      assert.ok(
        snap.timelineTimeSeconds !== null && snap.mediaTimeSeconds !== null,
        'program time missing'
      );
      const offset = snap.timelineTimeSeconds - snap.mediaTimeSeconds;
      assert.ok(
        Math.abs(offset) <= 1 / PROGRAM.fps,
        `timeline/media offset ${offset} at ${seconds}`
      );
    }
    pass('viewer-time-mapping');

    await page.evaluate(`window.${VIEWER_CONTRACT.hook}.focusTrack('V2')`);
    const focused = await page.waitFor('focus-track state', async () => {
      const snap = await page.snapshot();
      return snap.mode === 'focus-track' ? snap : undefined;
    });
    assert.equal(
      focused.mediaTimeSeconds,
      null,
      'focus-track must not report a program media time'
    );
    pass('viewer-focus-track');

    comment = await commentRoundTrip(
      harness,
      positive.relicId,
      positive.relicKey,
      positive.contentOtio,
      'Rendered program proof'
    );
    pass('comments-round-trip');

    // Reveal through the real UI: open the thread, click the comment row, then check its mark on
    // the timeline. A missing selector fails the click or the wait; nothing is substituted.
    const isOpen = await page.evaluate<boolean>(
      `!!document.querySelector('#comment-thread.is-open')`
    );
    if (!isOpen) await page.click('.relic-row > .thread-tab');
    const records: Array<{
      record: CommentRecord;
      trackId: string;
      itemId: string | null;
    }> = [
      { record: comment.composition, trackId: '', itemId: null },
      {
        record: comment.focused,
        trackId: comment.trackId,
        itemId: comment.itemId,
      },
    ];
    for (const { record, trackId, itemId } of records) {
      await page.waitFor(`thread row ${record.id}`, async () => {
        const text = await page.evaluate<string | null>(
          `document.querySelector('#comment-thread [data-comment-id="${record.id}"] .comment-body')?.textContent ?? null`
        );
        return text !== null && text.includes(record.body) ? text : undefined;
      });
      await page.click(
        `#comment-thread [data-comment-id="${record.id}"] .comment-body`
      );
      const mark = await page.waitFor(
        `timeline mark ${record.id}`,
        async () => {
          const raw = await page.evaluate<string | null>(`(() => {
          const m = document.querySelector('.otio-comment-mark[data-comment-id="${record.id}"]');
          if (!m) return null;
          const r = m.getBoundingClientRect();
          return JSON.stringify({
            start: m.dataset.start, rate: m.dataset.rate, duration: m.dataset.duration,
            trackId: m.dataset.trackId ?? '', itemId: m.dataset.itemId ?? null,
            hidden: m.hidden,
            inView: r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
          });
        })()`);
          return raw === null
            ? undefined
            : (JSON.parse(raw) as {
                start: string;
                rate: string;
                trackId: string;
                itemId: string | null;
                hidden: boolean;
                inView: boolean;
              });
        }
      );
      assert.equal(mark.hidden, false, `mark for ${record.id} is hidden`);
      assert.equal(
        mark.inView,
        true,
        `mark for ${record.id} is not revealed in the viewport`
      );
      assert.equal(
        Number(mark.start) / Number(mark.rate),
        comment.compositionSeconds,
        `mark ${record.id} is not at composition 4.5 s`
      );
      assert.equal(
        mark.trackId,
        trackId,
        `mark ${record.id} track ${mark.trackId}`
      );
      assert.equal(
        mark.itemId,
        itemId,
        `mark ${record.id} item ${mark.itemId}`
      );
    }
    pass('comment-reveal-ui');
  } finally {
    await page.close();
  }

  // Stage 15: element audio capture, from a fresh page, checked against the reference.
  const audioPage = await openViewer({
    url: positive.shareUrl,
    origin: harness.origin,
    sessionToken: await harness.createSession(),
  });
  try {
    await audioPage.waitFor('program state for audio', async () => {
      const value = await audioPage.evaluate<string | null>(
        `document.querySelector('.otio-view')?.getAttribute('${VIEWER_CONTRACT.stateAttribute}') ?? null`
      );
      return value === 'program' ? value : undefined;
    });
    const captured = await captureElementAudio(audioPage, 6.5);
    assert.equal(
      captured.rate,
      PROGRAM.audioRate,
      `capture context rate ${captured.rate}`
    );
    const expected = expectedAudio();
    for (const [name, channel] of [
      ['left', Float32Array.from(captured.left)],
      ['right', Float32Array.from(captured.right)],
    ] as const) {
      const alignment = alignAudio(channel, expected, 960);
      measured[`captured_${name}_lag_samples`] = alignment.lagSamples;
      measured[`captured_${name}_snr_db`] = Number(alignment.snrDb.toFixed(2));
      assert.ok(
        Math.abs(alignment.lagSamples) <= 960,
        `captured ${name} start offset ${alignment.lagSamples} samples > 20 ms`
      );
      assert.ok(
        alignment.snrDb >= AUDIO_MIN_SNR_DB,
        `captured ${name} SNR ${alignment.snrDb.toFixed(1)} dB`
      );
      assert.deepEqual(
        findAudioFaults(
          channel,
          expected,
          PROGRAM.audioRate,
          alignment.lagSamples,
          [48000, 144000, 216000, 240000]
        ),
        [],
        `captured ${name} audio faults`
      );
    }
    pass('viewer-audio-captured');
  } finally {
    await audioPage.close();
  }

  console.log(`OTIO_PROGRAM_MEASURED ${JSON.stringify(measured)}`);
  assert.equal(passed.length, 15, `expected 15 stages, ran ${passed.length}`);
  console.log('OTIO_PROGRAM_PATH_OK');
} finally {
  await harness.close();
}
