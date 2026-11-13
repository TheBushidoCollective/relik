/**
 * Minimal MP4 box reader for measuring edit lists on rendered output. Read-only and independent
 * of Relic. It finds, per track, the handler type and any elst (edit list) entries, which is how
 * AAC encoder priming would appear to a player.
 */

export interface EditEntry {
  readonly segmentDuration: number;
  readonly mediaTime: number;
}

export interface TrackEditList {
  readonly handler: string;
  readonly entries: readonly EditEntry[] | null;
}

interface Box {
  readonly type: string;
  readonly payloadStart: number;
  readonly end: number;
}

function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end)
      throw new Error(`malformed MP4 box ${type} at ${offset}`);
    boxes.push({ type, payloadStart: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string
): Box | undefined {
  return readBoxes(bytes, start, end).find((b) => b.type === type);
}

function parseEditList(bytes: Uint8Array, box: Box): EditEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(box.payloadStart);
  const count = view.getUint32(box.payloadStart + 4);
  const entries: EditEntry[] = [];
  let offset = box.payloadStart + 8;
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      entries.push({
        segmentDuration: Number(view.getBigUint64(offset)),
        mediaTime: Number(view.getBigInt64(offset + 8)),
      });
      offset += 20;
    } else {
      entries.push({
        segmentDuration: view.getUint32(offset),
        mediaTime: view.getInt32(offset + 4),
      });
      offset += 12;
    }
  }
  return entries;
}

/** Handler type and edit list, for every track in the file, in file order. */
export function trackEditLists(bytes: Uint8Array): TrackEditList[] {
  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (!moov) throw new Error('no moov box: not a readable MP4');
  const tracks: TrackEditList[] = [];
  for (const trak of readBoxes(bytes, moov.payloadStart, moov.end).filter(
    (b) => b.type === 'trak'
  )) {
    const mdia = findBox(bytes, trak.payloadStart, trak.end, 'mdia');
    const hdlr = mdia
      ? findBox(bytes, mdia.payloadStart, mdia.end, 'hdlr')
      : undefined;
    const handler = hdlr
      ? String.fromCharCode(
          ...bytes.subarray(hdlr.payloadStart + 8, hdlr.payloadStart + 12)
        )
      : '';
    const edts = findBox(bytes, trak.payloadStart, trak.end, 'edts');
    const elst = edts
      ? findBox(bytes, edts.payloadStart, edts.end, 'elst')
      : undefined;
    tracks.push({ handler, entries: elst ? parseEditList(bytes, elst) : null });
  }
  return tracks;
}
