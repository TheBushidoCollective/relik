import { describe, expect, test } from 'bun:test';
import { sniffMediaType } from '../src/main.ts';

// The media player's Blob takes its type from the bytes (viewer.md 1.6). Each
// signature below maps to one fixed media type; anything else is octet-stream.

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): number[] =>
  [...text].map((char) => char.charCodeAt(0));

describe('sniffMediaType', () => {
  test('recognizes the common container and codec signatures', () => {
    expect(sniffMediaType(bytes(0, 0, 0, 0x18, ...ascii('ftypisom')))).toBe(
      'video/mp4'
    );
    expect(sniffMediaType(bytes(0, 0, 0, 0x18, ...ascii('ftypM4A ')))).toBe(
      'audio/mp4'
    );
    expect(sniffMediaType(bytes(0, 0, 0, 0x14, ...ascii('ftypqt  ')))).toBe(
      'video/quicktime'
    );
    expect(sniffMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01))).toBe(
      'video/webm'
    );
    expect(sniffMediaType(bytes(...ascii('OggS'), 0))).toBe('audio/ogg');
    expect(
      sniffMediaType(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')))
    ).toBe('audio/wav');
    expect(sniffMediaType(bytes(...ascii('fLaC'), 0))).toBe('audio/flac');
    expect(sniffMediaType(bytes(...ascii('ID3'), 4, 0))).toBe('audio/mpeg');
    expect(sniffMediaType(bytes(0xff, 0xfb, 0x90, 0x64))).toBe('audio/mpeg');
  });

  test('an ADTS audio frame is not mistaken for MPEG layer III', () => {
    expect(sniffMediaType(bytes(0xff, 0xf1, 0x50, 0x80))).toBe(
      'application/octet-stream'
    );
  });

  test('unrecognized bytes get octet-stream, so no declared type stands in', () => {
    expect(sniffMediaType(new Uint8Array())).toBe('application/octet-stream');
    expect(sniffMediaType(new TextEncoder().encode('<svg></svg>'))).toBe(
      'application/octet-stream'
    );
    expect(sniffMediaType(new TextEncoder().encode('<!doctype html>'))).toBe(
      'application/octet-stream'
    );
  });

  test('never returns a document or script type, whatever the bytes', () => {
    const hostile = [
      new TextEncoder().encode('<svg onload=alert(1)></svg>'),
      new TextEncoder().encode('<html><script>x()</script></html>'),
      new TextEncoder().encode('<?xml version="1.0"?><svg/>'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    ];
    for (const payload of hostile) {
      const type = sniffMediaType(payload);
      expect(type).not.toContain('svg');
      expect(type).not.toContain('html');
      expect(type).not.toContain('xml');
      expect(type).not.toContain('javascript');
    }
  });
});
