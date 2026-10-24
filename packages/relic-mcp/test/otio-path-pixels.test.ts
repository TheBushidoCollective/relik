import { describe, expect, test } from 'bun:test';
import { isOpaqueBlack } from './otio-path-pixels.ts';

describe('isOpaqueBlack', () => {
  test('rejects an all-zero RGBA buffer', () => {
    // 1-pixel all-zero buffer
    expect(isOpaqueBlack(new Uint8Array([0, 0, 0, 0]))).toBe(false);
    // Typical frame-sized all-zero buffer (160x90x4)
    expect(isOpaqueBlack(new Uint8Array(160 * 90 * 4))).toBe(false);
  });

  test('accepts all-(0,0,0,255)', () => {
    // 1-pixel pure black with alpha 255
    expect(isOpaqueBlack(new Uint8Array([0, 0, 0, 255]))).toBe(true);
    // 1-pixel near-black within <= 8 threshold with alpha 255
    expect(isOpaqueBlack(new Uint8Array([8, 8, 8, 255]))).toBe(true);
    // Frame-sized pure black with alpha 255
    const frame = new Uint8Array(160 * 90 * 4);
    for (let i = 0; i < frame.length; i += 4) {
      frame[i + 3] = 255;
    }
    expect(isOpaqueBlack(frame)).toBe(true);
  });

  test('proves non-black content is not black', () => {
    // White pixel
    expect(isOpaqueBlack(new Uint8Array([255, 255, 255, 255]))).toBe(false);
    // Red, green, blue color channels above threshold
    expect(isOpaqueBlack(new Uint8Array([255, 0, 0, 255]))).toBe(false);
    expect(isOpaqueBlack(new Uint8Array([0, 255, 0, 255]))).toBe(false);
    expect(isOpaqueBlack(new Uint8Array([0, 0, 255, 255]))).toBe(false);
    // One channel just above threshold of 8
    expect(isOpaqueBlack(new Uint8Array([9, 0, 0, 255]))).toBe(false);
    expect(isOpaqueBlack(new Uint8Array([0, 9, 0, 255]))).toBe(false);
    expect(isOpaqueBlack(new Uint8Array([0, 0, 9, 255]))).toBe(false);
    // Black RGB with non-opaque alpha
    expect(isOpaqueBlack(new Uint8Array([0, 0, 0, 254]))).toBe(false);
    expect(isOpaqueBlack(new Uint8Array([0, 0, 0, 128]))).toBe(false);
    // Single non-black pixel in otherwise black frame
    const mostlyBlack = new Uint8Array(160 * 90 * 4);
    for (let i = 0; i < mostlyBlack.length; i += 4) {
      mostlyBlack[i + 3] = 255;
    }
    mostlyBlack[100] = 50; // Set red channel of one pixel to 50
    expect(isOpaqueBlack(mostlyBlack)).toBe(false);
    // Single transparent pixel in otherwise black frame
    const transparentOne = new Uint8Array(160 * 90 * 4);
    for (let i = 0; i < transparentOne.length; i += 4) {
      transparentOne[i + 3] = 255;
    }
    transparentOne[103] = 0; // Alpha of one pixel is 0
    expect(isOpaqueBlack(transparentOne)).toBe(false);
    // Empty buffer or invalid length
    expect(isOpaqueBlack(new Uint8Array(0))).toBe(false);
    expect(isOpaqueBlack(new Uint8Array([0, 0, 0]))).toBe(false);
  });
});
