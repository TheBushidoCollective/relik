import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  OTIO_AUDIO_PRIMER_BYTE_LENGTH,
  OTIO_AUDIO_PRIMER_MIME,
  OTIO_AUDIO_PRIMER_SHA256,
  otioAudioPrimerBlob,
  otioAudioPrimerBytes,
} from '../src/otio-audio-primer-media';

describe('otio audio primer asset', () => {
  test('decoded bytes match the recorded SHA-256 and byte length', () => {
    const bytes = otioAudioPrimerBytes();
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(digest).toBe(OTIO_AUDIO_PRIMER_SHA256);
    expect(bytes.byteLength).toBe(OTIO_AUDIO_PRIMER_BYTE_LENGTH);
  });

  test('is a small ISO base media file', () => {
    const bytes = otioAudioPrimerBytes();
    expect(bytes.byteLength).toBeLessThanOrEqual(8 * 1024);
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    expect(type).toBe('ftyp');
  });

  test('returns a fresh copy on each call', () => {
    const first = otioAudioPrimerBytes();
    const original = first[0] ?? 0;
    first[0] = original ^ 0xff;
    const second = otioAudioPrimerBytes();
    expect(second).not.toBe(first);
    expect(second[0]).toBe(original);
    expect(createHash('sha256').update(second).digest('hex')).toBe(
      OTIO_AUDIO_PRIMER_SHA256
    );
  });

  test('blob carries the MIME type and the same bytes', async () => {
    const blob = otioAudioPrimerBlob();
    expect(blob.type).toBe(OTIO_AUDIO_PRIMER_MIME);
    expect(OTIO_AUDIO_PRIMER_MIME).toBe('video/mp4');
    expect(blob.size).toBe(OTIO_AUDIO_PRIMER_BYTE_LENGTH);
    const digest = createHash('sha256')
      .update(new Uint8Array(await blob.arrayBuffer()))
      .digest('hex');
    expect(digest).toBe(OTIO_AUDIO_PRIMER_SHA256);
  });
});
