/* Recognition is only a provisional hint. The viewer validates every model
 * in a bounded decoder before displaying it. No names or URLs are resolved. */
export type ModelFormat = 'stl' | 'obj';

export function modelFormatFromFilename(
  filename: string
): ModelFormat | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot <= filename.lastIndexOf('/') || dot < 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return ext === 'stl' || ext === 'obj' ? ext : undefined;
}

export function modelFormatFromMime(mimetype: string): ModelFormat | undefined {
  const mime = mimetype.toLowerCase().split(';')[0]?.trim();
  if (mime === 'model/stl') return 'stl';
  if (mime === 'model/obj') return 'obj';
  return undefined;
}

export function sniffModelFormat(content: Uint8Array): ModelFormat | undefined {
  if (content.length >= 84) {
    const count = new DataView(
      content.buffer,
      content.byteOffset,
      content.byteLength
    ).getUint32(80, true);
    if (count > 0 && 84 + count * 50 === content.length) return 'stl';
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let hasSolid = false;
  let hasFacet = false;
  let hasNormal = false;
  let hasVertex = false;
  let hasFace = false;
  try {
    for (let offset = 0; offset < content.length; offset += 65536) {
      const end = Math.min(content.length, offset + 65536);
      pending += decoder.decode(content.subarray(offset, end), {
        stream: end < content.length,
      });
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? '';
      if (pending.length > 65536) pending = '';
      if (end === content.length) lines.push(pending);
      for (const line of lines) {
        if (/^\s*solid(?:\s|$)/i.test(line)) hasSolid = true;
        if (/\bfacet\b/i.test(line)) hasFacet = true;
        if (/\bnormal\b/i.test(line)) hasNormal = true;
        if (/^\s*v\s+[-+\d.]/.test(line)) hasVertex = true;
        if (/^\s*f\s+\S+\s+\S+\s+\S+/.test(line)) hasFace = true;
        if (hasSolid && hasFacet && hasNormal) return 'stl';
        if (hasVertex && hasFace) return 'obj';
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
