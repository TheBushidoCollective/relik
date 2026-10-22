import type { OtioVideoTimingReason } from './otio-video-timing.ts';

export const MAX_ISO_BOX_HEADERS = 4096;
export const MAX_ISO_BOX_DEPTH = 8;

export interface OtioVideoTimingByteReader {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface IsoPresentationEdit {
  /** First presentation second occupied by the effective (non-empty) edit. */
  readonly start: number;
  /** Exclusive presentation end, measured in the movie timeline. */
  readonly end: number;
  readonly movieTimescale: number;
}

export class IsoEditGateFailure extends Error {
  constructor(readonly reason: Extract<OtioVideoTimingReason, 'read-budget' | 'unsupported-edit-list'>) {
    super(reason);
    this.name = 'IsoEditGateFailure';
  }
}

interface IsoBox {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
}

interface ScanState {
  headers: number;
}

interface ParsedEdit {
  readonly segmentDuration: number;
  readonly mediaTime: number;
  readonly rateInteger: number;
  readonly rateFraction: number;
}

function fail(reason: IsoEditGateFailure['reason']): never {
  throw new IsoEditGateFailure(reason);
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function asSafeUnsigned(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail('unsupported-edit-list');
  }
  return Number(value);
}

function asSafeSigned(value: bigint): number {
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return fail('unsupported-edit-list');
  }
  return Number(value);
}

function typeAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

async function exactRead(
  reader: OtioVideoTimingByteReader,
  start: number,
  end: number
): Promise<Uint8Array> {
  if (
    !safeInteger(start) ||
    !safeInteger(end) ||
    start > end ||
    end > reader.size
  ) {
    return fail('unsupported-edit-list');
  }
  const bytes = await reader.read(start, end);
  if (bytes.byteLength !== end - start) return fail('unsupported-edit-list');
  return bytes;
}

async function readBoxHeader(
  reader: OtioVideoTimingByteReader,
  start: number,
  parentEnd: number,
  depth: number,
  state: ScanState
): Promise<IsoBox> {
  if (depth > MAX_ISO_BOX_DEPTH) return fail('read-budget');
  if (state.headers >= MAX_ISO_BOX_HEADERS) return fail('read-budget');
  state.headers += 1;

  if (!safeInteger(start) || !safeInteger(parentEnd) || start + 8 > parentEnd) {
    return fail('unsupported-edit-list');
  }

  const headerEnd = Math.min(parentEnd, start + 16);
  const bytes = await exactRead(reader, start, headerEnd);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shortSize = view.getUint32(0);
  const type = typeAt(bytes, 4);
  let headerSize = 8;
  let size: number;

  if (shortSize === 1) {
    if (bytes.byteLength < 16) return fail('unsupported-edit-list');
    headerSize = 16;
    size = asSafeUnsigned(view.getBigUint64(8));
  } else if (shortSize === 0) {
    size = parentEnd - start;
  } else {
    size = shortSize;
  }

  if (!safeInteger(size) || size < headerSize) return fail('unsupported-edit-list');
  const end = start + size;
  if (!safeInteger(end) || end > parentEnd) return fail('unsupported-edit-list');

  return { type, start, end, contentStart: start + headerSize };
}

async function childrenOf(
  reader: OtioVideoTimingByteReader,
  start: number,
  end: number,
  depth: number,
  state: ScanState
): Promise<IsoBox[]> {
  if (depth > MAX_ISO_BOX_DEPTH) return fail('read-budget');
  const children: IsoBox[] = [];
  let position = start;
  while (position < end) {
    const child = await readBoxHeader(reader, position, end, depth, state);
    children.push(child);
    position = child.end;
  }
  if (position !== end) return fail('unsupported-edit-list');
  return children;
}

async function payloadPrefix(
  reader: OtioVideoTimingByteReader,
  box: IsoBox,
  bytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || box.contentStart + bytes > box.end) {
    return fail('unsupported-edit-list');
  }
  return exactRead(reader, box.contentStart, box.contentStart + bytes);
}

async function movieTimescale(
  reader: OtioVideoTimingByteReader,
  box: IsoBox
): Promise<number> {
  const bytes = await payloadPrefix(reader, box, 24);
  const version = bytes[0];
  if (version === 0) {
    const timescale = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).getUint32(12);
    if (timescale === 0) return fail('unsupported-edit-list');
    return timescale;
  }
  if (version === 1) {
    const timescale = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).getUint32(20);
    if (timescale === 0) return fail('unsupported-edit-list');
    return timescale;
  }
  return fail('unsupported-edit-list');
}

async function trackId(
  reader: OtioVideoTimingByteReader,
  box: IsoBox
): Promise<number> {
  const bytes = await payloadPrefix(reader, box, 24);
  const version = bytes[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (version === 0) return view.getUint32(12);
  if (version === 1) return view.getUint32(20);
  return fail('unsupported-edit-list');
}

async function parseEditList(
  reader: OtioVideoTimingByteReader,
  box: IsoBox,
  timescale: number
): Promise<IsoPresentationEdit> {
  const header = await payloadPrefix(reader, box, 8);
  const version = header[0];
  const count = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength
  ).getUint32(4);
  if ((version !== 0 && version !== 1) || (count !== 1 && count !== 2)) {
    return fail('unsupported-edit-list');
  }

  const entryBytes = version === 0 ? 12 : 20;
  const expectedLength = 8 + count * entryBytes;
  if (box.end - box.contentStart !== expectedLength) {
    return fail('unsupported-edit-list');
  }
  const bytes = await exactRead(reader, box.contentStart, box.end);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ParsedEdit[] = [];

  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * entryBytes;
    const segmentDuration =
      version === 0
        ? view.getUint32(offset)
        : asSafeUnsigned(view.getBigUint64(offset));
    const mediaTime =
      version === 0
        ? view.getInt32(offset + 4)
        : asSafeSigned(view.getBigInt64(offset + 8));
    const rateOffset = version === 0 ? offset + 8 : offset + 16;
    entries.push({
      segmentDuration,
      mediaTime,
      rateInteger: view.getInt16(rateOffset),
      rateFraction: view.getInt16(rateOffset + 2),
    });
  }

  const effective = entries[count - 1];
  if (!effective) return fail('unsupported-edit-list');
  const leading = count === 2 ? entries[0] : undefined;

  if (
    effective.segmentDuration <= 0 ||
    effective.mediaTime < 0 ||
    effective.rateInteger !== 1 ||
    effective.rateFraction !== 0
  ) {
    return fail('unsupported-edit-list');
  }
  if (
    leading &&
    (leading.mediaTime !== -1 ||
      leading.rateInteger !== 1 ||
      leading.rateFraction !== 0)
  ) {
    return fail('unsupported-edit-list');
  }

  const leadingDuration = leading?.segmentDuration ?? 0;
  const totalDuration = leadingDuration + effective.segmentDuration;
  if (!safeInteger(totalDuration) || !Number.isFinite(timescale) || timescale <= 0) {
    return fail('unsupported-edit-list');
  }

  const start = leadingDuration / timescale;
  const end = totalDuration / timescale;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) {
    return fail('unsupported-edit-list');
  }
  return { start, end, movieTimescale: timescale };
}

/**
 * Reads only the ISO movie header, track id, and edit-list shape needed to
 * classify a safe affine presentation interval. It deliberately never parses
 * timing/sample tables, media data, or EBML.
 */
export async function readSafeIsoPresentationEdit(
  reader: OtioVideoTimingByteReader,
  selectedTrackId: number
): Promise<IsoPresentationEdit | null> {
  if (!safeInteger(reader.size) || !Number.isSafeInteger(selectedTrackId)) {
    return fail('unsupported-edit-list');
  }

  const state: ScanState = { headers: 0 };
  const roots = await childrenOf(reader, 0, reader.size, 0, state);
  const moovs = roots.filter((box) => box.type === 'moov');
  if (moovs.length !== 1) return fail('unsupported-edit-list');
  const moov = moovs[0];
  if (!moov) return fail('unsupported-edit-list');

  const moovChildren = await childrenOf(
    reader,
    moov.contentStart,
    moov.end,
    1,
    state
  );
  const movieHeaders = moovChildren.filter((box) => box.type === 'mvhd');
  if (movieHeaders.length !== 1) return fail('unsupported-edit-list');
  const movieHeader = movieHeaders[0];
  if (!movieHeader) return fail('unsupported-edit-list');
  const timescale = await movieTimescale(reader, movieHeader);

  const tracks = moovChildren.filter((box) => box.type === 'trak');
  const matchingTracks: Array<{ trak: IsoBox; children: IsoBox[] }> = [];
  for (const trak of tracks) {
    const trackChildren = await childrenOf(
      reader,
      trak.contentStart,
      trak.end,
      2,
      state
    );
    const headers = trackChildren.filter((box) => box.type === 'tkhd');
    if (headers.length !== 1) return fail('unsupported-edit-list');
    const header = headers[0];
    if (!header) return fail('unsupported-edit-list');
    if ((await trackId(reader, header)) === selectedTrackId) {
      matchingTracks.push({ trak, children: trackChildren });
    }
  }

  if (matchingTracks.length !== 1) return fail('unsupported-edit-list');
  const selected = matchingTracks[0];
  if (!selected) return fail('unsupported-edit-list');
  const editContainers = selected.children.filter((box) => box.type === 'edts');
  if (editContainers.length === 0) return null;
  if (editContainers.length !== 1) return fail('unsupported-edit-list');
  const editContainer = editContainers[0];
  if (!editContainer) return fail('unsupported-edit-list');

  const editChildren = await childrenOf(
    reader,
    editContainer.contentStart,
    editContainer.end,
    3,
    state
  );
  const editLists = editChildren.filter((box) => box.type === 'elst');
  if (editLists.length !== 1) return fail('unsupported-edit-list');
  const editList = editLists[0];
  if (!editList) return fail('unsupported-edit-list');
  return parseEditList(reader, editList, timescale);
}
