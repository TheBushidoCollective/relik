/** Repairs AAC presentation timing without decoding or exposing the media. */
type Box = {
  type: string;
  start: number;
  content: number;
  end: number;
  wide: boolean;
};
type Replacement = { start: number; end: number; bytes: Uint8Array };

function fail(detail: string): never {
  throw new Error(`Cannot trim MP4 audio: ${detail}`);
}

/**
 * Apply an exact sample-aligned edit to the unique AAC track. Offsets and box
 * lengths are rebuilt in memory; media packets and video timing are unchanged.
 */
export function trimProgramAudio(
  mp4: Uint8Array,
  delaySamples: number,
  intendedSamples: number,
  sampleRate: number
): Uint8Array {
  for (const [name, value] of Object.entries({
    delaySamples,
    intendedSamples,
    sampleRate,
  })) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (name !== 'delaySamples' && value === 0)
    ) {
      fail(`invalid ${name}`);
    }
  }
  const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  const u32 = (p: number) => view.getUint32(p);
  const type = (p: number) => String.fromCharCode(...mp4.subarray(p, p + 4));
  let headers = 0;
  function boxes(start: number, end: number, topLevel = false): Box[] {
    const result: Box[] = [];
    for (let p = start; p < end; ) {
      if (++headers > 100_000 || end - p < 8) fail('malformed box header');
      const size = u32(p);
      if (size === 0 && !topLevel) fail('zero-sized nested box');
      let length: number;
      let header = 8;
      if (size === 1) {
        if (end - p < 16) fail('truncated extended box');
        const n = view.getBigUint64(p + 8);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('box too large');
        length = Number(n);
        header = 16;
      } else length = size === 0 ? end - p : size;
      if (length < header || length > end - p) fail('invalid box size');
      result.push({
        type: type(p + 4),
        start: p,
        content: p + header,
        end: p + length,
        wide: size === 1,
      });
      p += length;
    }
    return result;
  }
  function one(items: Box[], name: string): Box {
    const matches = items.filter((item) => item.type === name);
    if (matches.length !== 1) fail(`expected one ${name} box`);
    return matches[0]!;
  }
  function need(box: Box, length: number): void {
    if (box.end - box.content < length) fail(`truncated ${box.type}`);
  }
  function timescale(box: Box): number {
    need(box, 4);
    const version = mp4[box.content];
    const offset =
      version === 0
        ? 12
        : version === 1
          ? 20
          : fail(`unsupported ${box.type} version`);
    need(box, offset + 4);
    return u32(box.content + offset) || fail(`zero ${box.type} timescale`);
  }
  function duration(box: Box): bigint {
    need(box, 4);
    const version = mp4[box.content];
    const isTrack = box.type === 'tkhd';
    const offset =
      version === 0
        ? isTrack
          ? 20
          : 16
        : version === 1
          ? isTrack
            ? 28
            : 24
          : fail(`unsupported ${box.type} version`);
    need(box, offset + (version === 0 ? 4 : 8));
    return version === 0
      ? BigInt(u32(box.content + offset))
      : view.getBigUint64(box.content + offset);
  }
  function durationPatch(box: Box, value: bigint): Replacement {
    const version = mp4[box.content];
    const isTrack = box.type === 'tkhd';
    const offset = version === 0 ? (isTrack ? 20 : 16) : isTrack ? 28 : 24;
    const length = version === 0 ? 4 : 8;
    if (
      value < 0n ||
      value > (version === 0 ? 0xffffffffn : 0xffffffffffffffffn)
    )
      fail(`${box.type} duration overflow`);
    const bytes = new Uint8Array(length);
    const v = new DataView(bytes.buffer);
    if (length === 4) v.setUint32(0, Number(value));
    else v.setBigUint64(0, value);
    return {
      start: box.content + offset,
      end: box.content + offset + length,
      bytes,
    };
  }
  const top = boxes(0, mp4.byteLength, true);
  for (const b of top) {
    if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(b.type))
      fail(`unsupported top-level ${b.type}`);
  }
  const moov = one(top, 'moov');
  const mdats = top.filter((b) => b.type === 'mdat');
  if (!mdats.length) fail('missing mdat');
  const movie = boxes(moov.content, moov.end);
  if (movie.some((b) => b.type === 'mvex')) fail('fragmented MP4');
  if (
    movie.some(
      (b) => !['mvhd', 'trak', 'udta', 'free', 'skip'].includes(b.type)
    )
  )
    fail('unsupported movie metadata');
  // iTunes-style metadata stores values inline, not media offsets or movie
  // timestamps. Reject other metadata forms rather than moving unknown pointers.
  for (const udta of movie.filter((b) => b.type === 'udta')) {
    const children = boxes(udta.content, udta.end);
    if (children.some((b) => !['meta', 'free', 'skip'].includes(b.type)))
      fail('unsupported user metadata');
    for (const meta of children.filter((b) => b.type === 'meta')) {
      need(meta, 4);
      if (u32(meta.content) !== 0) fail('unsupported metadata version');
      const items = boxes(meta.content + 4, meta.end);
      if (items.some((b) => !['hdlr', 'ilst', 'free', 'skip'].includes(b.type)))
        fail('unsupported metadata box');
      const hdlr = one(items, 'hdlr');
      need(hdlr, 12);
      if (type(hdlr.content + 8) !== 'mdir')
        fail('unsupported metadata handler');
      const ilst = one(items, 'ilst');
      for (const item of boxes(ilst.content, ilst.end)) {
        const values = boxes(item.content, item.end);
        if (
          !values.length ||
          values.some((b) => !['data', 'mean', 'name'].includes(b.type))
        )
          fail('unsupported metadata item');
        for (const value of values) need(value, value.type === 'data' ? 8 : 4);
      }
    }
  }
  const mvhd = one(movie, 'mvhd');
  const movieScale = timescale(mvhd);
  duration(mvhd);
  const tracks = movie.filter((b) => b.type === 'trak');
  if (!tracks.length) fail('missing tracks');
  const chunks: Box[] = [];
  const otherTracks: { tkhd: Box; edits: Box[] }[] = [];
  let audio:
    | { trak: Box; tkhd: Box; mdhd: Box; stts: Box; edts: Box | undefined }
    | undefined;
  let otherDuration = 0n;
  for (const trak of tracks) {
    const tc = boxes(trak.content, trak.end);
    if (
      tc.some((b) => !['tkhd', 'edts', 'mdia', 'free', 'skip'].includes(b.type))
    )
      fail('unsupported track metadata');
    const tkhd = one(tc, 'tkhd');
    const trackDuration = duration(tkhd);
    const mdia = one(tc, 'mdia');
    const mc = boxes(mdia.content, mdia.end);
    const mdhd = one(mc, 'mdhd');
    timescale(mdhd);
    duration(mdhd);
    const hdlr = one(mc, 'hdlr');
    need(hdlr, 12);
    const handler = type(hdlr.content + 8);
    const minf = one(mc, 'minf');
    const stbl = one(boxes(minf.content, minf.end), 'stbl');
    const sc = boxes(stbl.content, stbl.end);
    if (sc.some((b) => ['saio', 'senc', 'saiz'].includes(b.type)))
      fail('unsupported auxiliary offsets');
    const offsets = sc.filter((b) => b.type === 'stco' || b.type === 'co64');
    if (offsets.length !== 1) fail('expected one chunk offset table');
    chunks.push(offsets[0]!);
    if (handler !== 'soun') {
      otherTracks.push({ tkhd, edits: tc.filter((b) => b.type === 'edts') });
      if (trackDuration > otherDuration) otherDuration = trackDuration;
      continue;
    }
    if (audio) fail('multiple audio tracks');
    if (sc.some((b) => b.type === 'ctts'))
      fail('unsupported audio composition offsets');
    const stsd = one(sc, 'stsd');
    need(stsd, 8);
    if (u32(stsd.content + 4) !== 1) fail('ambiguous audio sample description');
    const entry = one(boxes(stsd.content + 8, stsd.end), 'mp4a');
    need(entry, 28);
    if (view.getUint16(entry.content + 8) !== 0)
      fail('unsupported audio sample entry version');
    if (u32(entry.content + 24) !== sampleRate * 65536)
      fail('audio sample rate mismatch');
    const esds = one(boxes(entry.content + 28, entry.end), 'esds');
    need(esds, 4);
    // Walk the descriptor hierarchy: ES_Descriptor, then DecoderConfigDescriptor.
    function descriptor(
      p: number,
      end: number
    ): { tag: number; start: number; end: number } {
      if (p >= end) fail('truncated ES descriptor');
      const tag = mp4[p++]!;
      let n = 0;
      let complete = false;
      for (let i = 0; i < 4; i++) {
        if (p >= end) fail('truncated ES descriptor length');
        const b = mp4[p++]!;
        n = n * 128 + (b & 127);
        if (!(b & 128)) {
          complete = true;
          break;
        }
      }
      if (!complete || n > end - p) fail('invalid ES descriptor length');
      return { tag, start: p, end: p + n };
    }
    const es = descriptor(esds.content + 4, esds.end);
    if (es.tag !== 3 || es.start + 3 > es.end) fail('invalid ES descriptor');
    const flags = mp4[es.start + 2]!;
    let p = es.start + 3;
    if (flags & 0x80) p += 2;
    if (flags & 0x40) {
      if (p >= es.end) fail('invalid ES URL');
      p += 1 + mp4[p]!;
    }
    if (flags & 0x20) p += 2;
    const config = descriptor(p, es.end);
    if (
      config.tag !== 4 ||
      config.start + 13 > config.end ||
      ![0x40, 0x66, 0x67, 0x68].includes(mp4[config.start]!)
    )
      fail('audio is not AAC');
    let decoderSpecific:
      | { tag: number; start: number; end: number }
      | undefined;
    for (let cursor = config.start + 13; cursor < config.end; ) {
      const child = descriptor(cursor, config.end);
      if (child.tag === 5) {
        if (decoderSpecific) fail('multiple AAC decoder configurations');
        decoderSpecific = child;
      }
      cursor = child.end;
    }
    if (
      !decoderSpecific ||
      decoderSpecific.end - decoderSpecific.start < 2 ||
      mp4[decoderSpecific.start]! >>> 3 !== 2
    )
      fail('audio is not AAC-LC');
    const edts = tc.filter((b) => b.type === 'edts');
    if (edts.length > 1) fail('multiple audio edit boxes');
    audio = { trak, tkhd, mdhd, stts: one(sc, 'stts'), edts: edts[0] };
  }
  if (!audio) fail('missing AAC audio track');
  const audioScale = timescale(audio.mdhd);
  const rate = BigInt(sampleRate);
  const scale = BigInt(audioScale);
  const startNumerator = BigInt(delaySamples) * scale;
  const lengthNumerator = BigInt(intendedSamples) * scale;
  const movieNumerator = BigInt(intendedSamples) * BigInt(movieScale);
  if (startNumerator % rate || lengthNumerator % rate)
    fail('sample timing is not exactly representable in the media timescale');
  let a = movieNumerator,
    b = rate;
  while (b !== 0n) [a, b] = [b, a % b];
  const factor = rate / a;
  const promotedScale = BigInt(movieScale) * factor;
  if (promotedScale > 0xffffffffn) fail('movie timescale overflow');
  const mediaStart = startNumerator / rate;
  const mediaLength = lengthNumerator / rate;
  const movieLength = (movieNumerator * factor) / rate;
  if (audio.edts) {
    const edits = boxes(audio.edts.content, audio.edts.end);
    const elst = one(edits, 'elst');
    if (edits.length !== 1) fail('unsupported audio edit metadata');
    need(elst, 8);
    const version = mp4[elst.content];
    const entryLength =
      version === 0
        ? 12
        : version === 1
          ? 20
          : fail('unsupported edit version');
    if (
      u32(elst.content + 4) !== 1 ||
      elst.end - elst.content !== 8 + entryLength
    )
      fail('unsupported audio edit list');
    const ep = elst.content + 8;
    const base =
      version === 0 ? BigInt(view.getInt32(ep + 4)) : view.getBigInt64(ep + 8);
    const rateOffset = ep + (version === 0 ? 8 : 16);
    if (
      base !== 0n ||
      view.getInt16(rateOffset) !== 1 ||
      view.getInt16(rateOffset + 2) !== 0
    )
      fail('unsupported audio edit mapping');
  }
  const stts = audio.stts;
  need(stts, 8);
  const entries = u32(stts.content + 4);
  if (
    entries > Math.floor((stts.end - stts.content - 8) / 8) ||
    stts.content + 8 + entries * 8 !== stts.end
  )
    fail('invalid audio timing table');
  let available = 0n;
  for (let i = 0; i < entries; i++) {
    const p = stts.content + 8 + i * 8;
    const count = u32(p),
      delta = u32(p + 4);
    if (!count || !delta) fail('invalid audio timing entry');
    available += BigInt(count) * BigInt(delta);
  }
  if (mediaStart + mediaLength > available)
    fail('audio packets do not cover requested edit');
  if (mediaStart > 0x7fffffffffffffffn || movieLength > 0xffffffffffffffffn)
    fail('edit timestamp overflow');
  const edts = new Uint8Array(44);
  const ev = new DataView(edts.buffer);
  ev.setUint32(0, 44);
  edts.set([101, 100, 116, 115], 4);
  ev.setUint32(8, 36);
  edts.set([101, 108, 115, 116], 12);
  ev.setUint8(16, 1);
  ev.setUint32(20, 1);
  ev.setBigUint64(24, movieLength);
  ev.setBigInt64(32, mediaStart);
  ev.setInt16(40, 1);
  const oldStart = audio.edts?.start ?? audio.trak.end;
  const oldEnd = audio.edts?.end ?? oldStart;
  const delta = edts.length - (oldEnd - oldStart);
  const replacements: Replacement[] = [
    { start: oldStart, end: oldEnd, bytes: edts },
    durationPatch(audio.tkhd, movieLength),
    durationPatch(
      mvhd,
      otherDuration * factor > movieLength
        ? otherDuration * factor
        : movieLength
    ),
  ];
  if (factor !== 1n) {
    const scaleOffset = mvhd.content + (mp4[mvhd.content] === 0 ? 12 : 20);
    const scaleBytes = new Uint8Array(4);
    new DataView(scaleBytes.buffer).setUint32(0, Number(promotedScale));
    replacements.push({
      start: scaleOffset,
      end: scaleOffset + 4,
      bytes: scaleBytes,
    });
    for (const track of otherTracks) {
      replacements.push(
        durationPatch(track.tkhd, duration(track.tkhd) * factor)
      );
      if (track.edits.length > 1) fail('multiple track edit boxes');
      if (!track.edits.length) continue;
      const editBoxes = boxes(track.edits[0]!.content, track.edits[0]!.end);
      if (editBoxes.length !== 1) fail('unsupported track edit metadata');
      const elst = one(editBoxes, 'elst');
      need(elst, 8);
      const version = mp4[elst.content];
      const entrySize =
        version === 0
          ? 12
          : version === 1
            ? 20
            : fail('unsupported track edit version');
      const count = u32(elst.content + 4);
      if (
        count > Math.floor((elst.end - elst.content - 8) / entrySize) ||
        elst.content + 8 + count * entrySize !== elst.end
      )
        fail('invalid track edit list');
      for (let i = 0; i < count; i++) {
        const p = elst.content + 8 + i * entrySize;
        const n =
          (version === 0 ? BigInt(u32(p)) : view.getBigUint64(p)) * factor;
        if (n > (version === 0 ? 0xffffffffn : 0xffffffffffffffffn))
          fail('track edit duration overflow');
        const bytes = new Uint8Array(version === 0 ? 4 : 8);
        const v = new DataView(bytes.buffer);
        if (version === 0) v.setUint32(0, Number(n));
        else v.setBigUint64(0, n);
        replacements.push({ start: p, end: p + bytes.length, bytes });
      }
    }
  }
  function boxSizePatch(box: Box): Replacement {
    const size = BigInt(box.end - box.start + delta);
    if (
      size < BigInt(box.content - box.start) ||
      (!box.wide && size > 0xffffffffn)
    )
      fail('box size overflow');
    const bytes = new Uint8Array(box.wide ? 8 : 4);
    const v = new DataView(bytes.buffer);
    if (box.wide) v.setBigUint64(0, size);
    else v.setUint32(0, Number(size));
    return {
      start: box.start + (box.wide ? 8 : 0),
      end: box.start + (box.wide ? 16 : 4),
      bytes,
    };
  }
  replacements.push(boxSizePatch(moov), boxSizePatch(audio.trak));
  for (const table of chunks) {
    need(table, 8);
    const count = u32(table.content + 4);
    const width = table.type === 'stco' ? 4 : 8;
    if (
      count > Math.floor((table.end - table.content - 8) / width) ||
      table.content + 8 + count * width !== table.end
    )
      fail('invalid chunk offset table');
    for (let i = 0; i < count; i++) {
      const p = table.content + 8 + i * width;
      const offset = width === 4 ? BigInt(u32(p)) : view.getBigUint64(p);
      const mdat = mdats.find(
        (m) => offset >= BigInt(m.content) && offset < BigInt(m.end)
      );
      if (!mdat) fail('chunk offset outside mdat');
      const shifted = offset + (mdat.start > moov.start ? BigInt(delta) : 0n);
      if (
        shifted < 0n ||
        shifted > (width === 4 ? 0xffffffffn : 0xffffffffffffffffn)
      )
        fail('chunk offset overflow');
      const bytes = new Uint8Array(width);
      const v = new DataView(bytes.buffer);
      if (width === 4) v.setUint32(0, Number(shifted));
      else v.setBigUint64(0, shifted);
      replacements.push({ start: p, end: p + width, bytes });
    }
  }
  replacements.sort((a, b) => a.start - b.start);
  const result = new Uint8Array(mp4.length + delta);
  let source = 0,
    target = 0;
  for (const r of replacements) {
    if (r.start < source || r.end > mp4.length) fail('overlapping MP4 edits');
    result.set(mp4.subarray(source, r.start), target);
    target += r.start - source;
    result.set(r.bytes, target);
    target += r.bytes.length;
    source = r.end;
  }
  result.set(mp4.subarray(source), target);
  return result;
}
