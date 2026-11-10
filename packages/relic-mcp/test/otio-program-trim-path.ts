/**
 * Standalone, synthetic MP4 proof for the in-memory audio edit. Run with bun; ffmpeg and
 * ffprobe must be on PATH. No network, real media, browser, or external system is used.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trimProgramAudio } from '../../relic-viewer/src/program-render/mp4-audio-trim.ts';

function run(command: string, args: string[]): Buffer {
  return execFileSync(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function probe(file: string, args: string[]): unknown {
  return JSON.parse(
    run('ffprobe', ['-v', 'error', ...args, '-of', 'json', file]).toString()
  ) as unknown;
}

function decodeAudio(file: string, rate: number): Float32Array {
  const pcm = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    String(rate),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-',
  ]);
  assert.equal(pcm.length % 4, 0);
  const samples = new Float32Array(pcm.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readFloatLE(i * 4);
  return samples;
}

function videoFrames(file: string): Buffer {
  return run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-f',
    'framemd5',
    '-',
  ]);
}

function videoTimes(file: string): unknown {
  const result = probe(file, [
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts,best_effort_timestamp,pkt_duration',
    '-show_frames',
  ]);
  assert.ok(
    result &&
      typeof result === 'object' &&
      'frames' in result &&
      Array.isArray(result.frames)
  );
  return result.frames;
}

/** Locate the known signal in decoded AAC instead of assuming an encoder priming constant. */
function measureDelay(
  decoded: Float32Array,
  signal: Float32Array,
  start: number,
  maxDelay: number,
  minDelay = 0
): number {
  let best = -Infinity;
  let bestDelay = 0;
  const length = 4096;
  assert.ok(
    start + minDelay >= 0 && decoded.length >= start + maxDelay + length
  );
  for (let delay = minDelay; delay <= maxDelay; delay++) {
    let correlation = 0;
    for (let i = 0; i < length; i++)
      correlation += signal[start + i]! * decoded[start + delay + i]!;
    if (correlation > best) {
      best = correlation;
      bestDelay = delay;
    }
  }
  assert.ok(best > 1, `no recognizable signal in AAC decode: ${best}`);
  return bestDelay;
}

function assertAudioTiming(
  file: string,
  rate: number,
  expected: Float32Array
): void {
  const result = probe(file, ['-select_streams', 'a:0', '-show_streams']);
  assert.ok(
    result &&
      typeof result === 'object' &&
      'streams' in result &&
      Array.isArray(result.streams)
  );
  assert.equal(result.streams.length, 1);
  const stream: unknown = result.streams[0];
  assert.ok(
    stream &&
      typeof stream === 'object' &&
      'time_base' in stream &&
      typeof stream.time_base === 'string'
  );
  assert.ok(
    'sample_rate' in stream && 'duration_ts' in stream && 'start_time' in stream
  );
  const timeBase = /^([1-9]\d*)\/([1-9]\d*)$/.exec(stream.time_base);
  assert.ok(
    timeBase?.[1] && timeBase[2],
    `invalid audio time base: ${stream.time_base}`
  );
  const num = Number(timeBase[1]);
  const den = Number(timeBase[2]);
  assert.ok(Number.isSafeInteger(num) && Number.isSafeInteger(den));
  assert.equal(Number(stream.sample_rate), rate);
  assert.equal(
    Number(stream.duration_ts) * num * rate,
    expected.length * den,
    'audio presentation duration is not exactly the program sample count'
  );
  assert.ok(
    Math.abs(Number(stream.start_time)) < 1 / rate,
    `audio starts at ${stream.start_time}`
  );
  const audio = decodeAudio(file, rate);
  // AAC decoders may expose the remainder of a final compressed frame beyond the edit's
  // presentation duration. The stream duration above is the presentation boundary.
  assert.ok(
    audio.length >= expected.length,
    `decoder produced ${audio.length}, expected at least ${expected.length}`
  );
  const start = Math.floor(rate / 4);
  const residual = measureDelay(audio, expected, start, 128, -128);
  assert.ok(
    Math.abs(residual) <= 2,
    `audio alignment is ${residual} samples off after the edit`
  );
}

interface Box {
  type: string;
  start: number;
  end: number;
  payload: number;
}
function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Box[] = [];
  for (let offset = start; offset + 8 <= end; ) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size === 0) size = end - offset;
    assert.ok(size >= header && offset + size <= end, `invalid ${type} box`);
    result.push({
      type,
      start: offset,
      end: offset + size,
      payload: offset + header,
    });
    offset += size;
  }
  return result;
}

/** Corrupt the first video chunk location to prove the video comparison catches bad offsets. */
function corruptVideoChunk(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const children = (box: Box) => boxes(copy, box.payload, box.end);
  const moov = boxes(copy, 0, copy.length).find((b) => b.type === 'moov')!;
  for (const trak of children(moov).filter((b) => b.type === 'trak')) {
    const mdia = children(trak).find((b) => b.type === 'mdia')!;
    const hdlr = children(mdia).find((b) => b.type === 'hdlr')!;
    if (
      String.fromCharCode(
        ...copy.subarray(hdlr.payload + 8, hdlr.payload + 12)
      ) !== 'vide'
    )
      continue;
    const minf = children(mdia).find((b) => b.type === 'minf')!;
    const stbl = children(minf).find((b) => b.type === 'stbl')!;
    const chunk = children(stbl).find(
      (b) => b.type === 'stco' || b.type === 'co64'
    )!;
    assert.ok(view.getUint32(chunk.payload + 4) > 0);
    if (chunk.type === 'stco') view.setUint32(chunk.payload + 8, 0);
    else view.setBigUint64(chunk.payload + 8, 0n);
    return copy;
  }
  throw new Error('no video chunk table');
}

function verifyVideo(before: string, after: string): void {
  assert.deepEqual(
    videoTimes(after),
    videoTimes(before),
    'video presentation timestamps changed'
  );
  assert.deepEqual(
    videoFrames(after),
    videoFrames(before),
    'decoded video frames or frame timestamps changed'
  );
}

function expectFailure(action: () => void, message: string): void {
  assert.throws(action, message);
}

function runCase(dir: string, rate: number, insertedDelay: number): void {
  const input = join(dir, `input-${rate}.mp4`);
  const output = join(dir, `output-${rate}.mp4`);
  const corrupt = join(dir, `corrupt-${rate}.mp4`);
  const pcmPath = join(dir, `audio-${rate}.f32`);
  // 26 frames at 25 fps is not an integral number of 1001 Hz movie ticks.
  const program = new Float32Array((rate * 26) / 25);
  // A non-periodic, band-limited signal makes sample-level cross-correlation unambiguous.
  for (let i = Math.floor(rate / 4); i < (rate * 3) / 4; i++) {
    const t = (i - Math.floor(rate / 4)) / rate;
    program[i] =
      0.25 * Math.sin(2 * Math.PI * (320 * t + 2200 * t * t)) +
      0.17 * Math.sin(2 * Math.PI * (1370 * t + 370 * t * t));
  }
  const tail = 4096;
  const pcm = Buffer.alloc((insertedDelay + program.length + tail) * 4);
  for (let i = 0; i < program.length; i++)
    pcm.writeFloatLE(program[i]!, (insertedDelay + i) * 4);
  // A nonzero tail makes an untrimmed AAC stream observably longer than the program.
  for (let i = 0; i < tail; i++)
    pcm.writeFloatLE(
      0.2 * Math.sin((2 * Math.PI * 600 * i) / rate),
      (insertedDelay + program.length + i) * 4
    );
  writeFileSync(pcmPath, pcm);
  run('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=25:duration=1.04',
    '-f',
    'f32le',
    '-ar',
    String(rate),
    '-ac',
    '1',
    '-i',
    pcmPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'mpeg4',
    '-q:v',
    '3',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-use_editlist',
    '0',
    '-movie_timescale',
    '1001',
    '-video_track_timescale',
    '30000',
    '-y',
    input,
  ]);
  const original = readFileSync(input);
  const raw = decodeAudio(input, rate);
  const delay = measureDelay(
    raw,
    program,
    Math.floor(rate / 4),
    insertedDelay + 4096
  );
  assert.ok(delay >= insertedDelay, `encoder delay was not measured: ${delay}`);
  assert.ok(raw.length > delay + program.length, 'fixture has no encoded tail');
  const repaired = trimProgramAudio(original, delay, program.length, rate);
  writeFileSync(output, repaired);
  verifyVideo(input, output);
  assertAudioTiming(output, rate, program);
  expectFailure(
    () => assertAudioTiming(input, rate, program),
    'untrimmed file passed timing proof'
  );
  const wrong = join(dir, `wrong-${rate}.mp4`);
  writeFileSync(
    wrong,
    trimProgramAudio(original, delay + 200, program.length, rate)
  );
  expectFailure(
    () => assertAudioTiming(wrong, rate, program),
    'incorrect audio offset passed timing proof'
  );
  writeFileSync(corrupt, corruptVideoChunk(repaired));
  expectFailure(
    () => verifyVideo(input, corrupt),
    'corrupted video chunk offsets passed proof'
  );
  expectFailure(
    () =>
      trimProgramAudio(original.subarray(0, 16), delay, program.length, rate),
    'truncated MP4 accepted'
  );
  expectFailure(
    () =>
      trimProgramAudio(
        new Uint8Array([0, 0, 0, 8, 109, 111, 111, 118]),
        delay,
        program.length,
        rate
      ),
    'empty moov accepted'
  );
  expectFailure(
    () => trimProgramAudio(original, -1, program.length, rate),
    'negative delay accepted'
  );
  expectFailure(
    () => trimProgramAudio(original, delay, 0, rate),
    'zero duration accepted'
  );
  console.log(
    `rate=${rate} measuredDelay=${delay} samples=${program.length} movieTimescale=1001 video preserved`
  );
}

const scratch = mkdtempSync(join(tmpdir(), 'relic-mp4-trim-'));
try {
  runCase(scratch, 48000, 1300);
  runCase(scratch, 44100, 2371);
  console.log('MP4 trim proof passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
