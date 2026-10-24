/**
 * Pixel inspection helpers for OTIO playback proof.
 *
 * An opaque black buffer requires every sample to have RGB <= 8 and alpha == 255.
 * An all-zero RGBA buffer (such as from a lost 2D context) has alpha == 0 and is rejected.
 */
export function isOpaqueBlack(rgba: Uint8Array): boolean {
  if (rgba.length === 0 || rgba.length % 4 !== 0) return false;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const a = rgba[i + 3] ?? 0;
    if (r > 8 || g > 8 || b > 8 || a !== 255) {
      return false;
    }
  }
  return true;
}
