/**
 * OTIO document reading, placement, identity, and conservative projection.
 *
 * One bottom-up measure and one top-down projection. The sampler in
 * otio-timing.ts is the only affine map consumer.
 */

import {
  isOtioRawNumber,
  parseOtioJson,
  stringifyOtioJson,
} from './otio-json.ts';
import {
  otioSequenceFrameEntries,
  readOtioImageSequence,
} from './otio-sequence.ts';
import {
  addRationalTimes,
  bindOtioSamplingMap,
  compareRationalTimes,
  effectScalarOf,
  intersectRanges,
  invertOtioIntervalEdge,
  invertOtioSample,
  type OtioBoundMap,
  otioIntervalEdge,
  otioSamplingMap,
  rangeEndTime,
  sampleOtioMedia,
  sourceSpansForOtioRange,
  subtractRationalTimes,
} from './otio-timing.ts';
import type {
  OtioAnchorResolution,
  OtioAnchorV1,
  OtioDiagnostic,
  OtioDocumentV1,
  OtioEffect,
  OtioIdentityOrigin,
  OtioMarker,
  OtioMediaEntry,
  OtioMediaReference,
  OtioNode,
  OtioProjectionStatus,
  OtioRationalTime,
  OtioSourceSpan,
  OtioTimeRange,
} from './otio-types.ts';
import {
  MAX_OTIO_BUNDLE_MEDIA_ENTRIES,
  otioBundleEntryFor,
} from './otio-zip.ts';

const KNOWN_SCHEMAS: Record<string, true> = {
  'Timeline.1': true,
  'Stack.1': true,
  'Track.1': true,
  'Clip.1': true,
  'Clip.2': true,
  'Gap.1': true,
  'Transition.1': true,
  'Marker.1': true,
  'Marker.2': true,
  'ExternalReference.1': true,
  'MissingReference.1': true,
  'ImageSequenceReference.1': true,
  'GeneratorReference.1': true,
  'FreezeFrame.1': true,
  'LinearTimeWarp.1': true,
  'Effect.1': true,
  'SerializableCollection.1': true,
  'RationalTime.1': true,
  'TimeRange.1': true,
};

interface MutableNode {
  id: string;
  identity_origin: OtioIdentityOrigin;
  authored_id?: string;
  json_pointer: string;
  schema: string;
  schema_version?: number;
  name: string;
  enabled: boolean;
  parent_id: string | null;
  children_ids: string[];
  track_kind?: string;
  source_range?: OtioTimeRange | null;
  available_range?: OtioTimeRange | null;
  parent_range?: OtioTimeRange | null;
  timeline_range?: OtioTimeRange | null;
  visible_timeline_range?: OtioTimeRange | null;
  media_references?: Record<string, OtioMediaReference>;
  active_media_reference_key?: string | null;
  effects?: OtioEffect[];
  markers?: OtioMarker[];
  transition_type?: string;
  in_offset?: OtioRationalTime;
  out_offset?: OtioRationalTime;
  metadata?: Record<string, unknown>;
  diagnostics: OtioDiagnostic[];
  raw?: unknown;
  fingerprint?: string;
  timing_invalid: boolean;
}

interface Placement {
  trimmed: OtioTimeRange | null;
  known: boolean;
  parentRange: OtioTimeRange | null;
  visibleParent: OtioTimeRange | null;
  rate: number;
}

function syncSha256(bytes: Uint8Array): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const bitLen = BigInt(bytes.length) * 8n;
  const withOne = bytes.length + 1;
  const padLen =
    withOne % 64 <= 56 ? 56 - (withOne % 64) : 120 - (withOne % 64);
  const buf = new Uint8Array(withOne + padLen + 8);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  new DataView(buf.buffer).setBigUint64(buf.length - 8, bitLen, false);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number =>
    ((x >>> n) | (x << (32 - n))) >>> 0;
  for (let i = 0; i < buf.length; i += 64) {
    const view = new DataView(buf.buffer, i, 64);
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 =
        (rotr(w[t - 15] as number, 7) ^
          rotr(w[t - 15] as number, 18) ^
          ((w[t - 15] as number) >>> 3)) >>>
        0;
      const s1 =
        (rotr(w[t - 2] as number, 17) ^
          rotr(w[t - 2] as number, 19) ^
          ((w[t - 2] as number) >>> 10)) >>>
        0;
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + (k[t] as number) + (w[t] as number)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + ((s0 + maj) >>> 0)) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isOtioRawNumber(value) && Number.isFinite(value.numericValue)) {
    if (
      !value.raw.includes('.') &&
      !value.raw.includes('e') &&
      !value.raw.includes('E')
    ) {
      if (!Number.isSafeInteger(value.numericValue)) return undefined;
    }
    return value.numericValue;
  }
  return undefined;
}

function parseRational(value: unknown): OtioRationalTime | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const amount = finiteNumber(record['value']);
  const rate = finiteNumber(record['rate']);
  if (amount === undefined || rate === undefined || rate <= 0) return undefined;
  return { value: amount, rate };
}

function parseRange(value: unknown): OtioTimeRange | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const start = parseRational(record['start_time']);
  const duration = parseRational(record['duration']);
  if (!start || !duration || duration.value < 0) return null;
  return { start_time: start, duration };
}

function readOptionalRange(
  raw: Record<string, unknown>,
  key: string
): { range: OtioTimeRange | null; invalid: boolean } {
  if (!hasOwn(raw, key) || raw[key] == null)
    return { range: null, invalid: false };
  const range = parseRange(raw[key]);
  return range ? { range, invalid: false } : { range: null, invalid: true };
}

function schemaVersion(schema: string): number | undefined {
  const dot = schema.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const parsed = Number(schema.slice(dot + 1));
  return Number.isInteger(parsed) ? parsed : undefined;
}

function blank(): Record<string, never> {
  return Object.create(null) as Record<string, never>;
}

function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function childList(
  raw: Record<string, unknown>
): { key: string; items: Record<string, unknown>[] } | null {
  if (hasOwn(raw, 'tracks') && raw['tracks'] != null) {
    const tracks = raw['tracks'];
    if (Array.isArray(tracks)) {
      return {
        key: 'tracks',
        items: tracks.filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null
        ),
      };
    }
    if (typeof tracks === 'object') {
      return { key: 'tracks', items: [tracks as Record<string, unknown>] };
    }
  }
  if (Array.isArray(raw['children'])) {
    return {
      key: 'children',
      items: raw['children'].filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null
      ),
    };
  }
  return null;
}

function stripIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripIdentity(item));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out = blank() as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    if (key === 'metadata') {
      put(out, key, stripRelicId(source[key]));
    } else {
      put(out, key, stripIdentity(source[key]));
    }
  }
  return out;
}

function stripRelicId(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return stripIdentity(value);
  const source = value as Record<string, unknown>;
  const out = blank() as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    if (
      key === 'relic' &&
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      const relic = blank() as Record<string, unknown>;
      for (const relicKey of Object.keys(
        source[key] as Record<string, unknown>
      ).sort()) {
        if (relicKey === 'id') continue;
        put(
          relic,
          relicKey,
          stripIdentity((source[key] as Record<string, unknown>)[relicKey])
        );
      }
      if (Object.keys(relic).length > 0) put(out, key, relic);
      continue;
    }
    put(out, key, stripIdentity(source[key]));
  }
  return out;
}

function fingerprintOf(raw: Record<string, unknown>): string {
  return syncSha256(
    new TextEncoder().encode(stringifyOtioJson(stripIdentity(raw)))
  );
}

function parseMedia(raw: Record<string, unknown>): OtioMediaReference {
  const schema =
    typeof raw['OTIO_SCHEMA'] === 'string'
      ? raw['OTIO_SCHEMA']
      : 'MissingReference.1';
  const available = readOptionalRange(raw, 'available_range');
  const step = finiteNumber(raw['frame_step']);
  const start = finiteNumber(raw['start_frame']);
  const rate = finiteNumber(raw['rate']);
  const pad = finiteNumber(raw['frame_zero_padding']);
  const policy = raw['missing_frame_policy'];
  const metadata =
    raw['metadata'] && typeof raw['metadata'] === 'object'
      ? (raw['metadata'] as Record<string, unknown>)
      : undefined;
  return {
    schema,
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    target_url:
      typeof raw['target_url'] === 'string' ? raw['target_url'] : null,
    available_range: available.invalid ? null : available.range,
    ...(typeof raw['target_url_base'] === 'string'
      ? { target_url_base: raw['target_url_base'] }
      : {}),
    ...(typeof raw['name_prefix'] === 'string'
      ? { name_prefix: raw['name_prefix'] }
      : {}),
    ...(typeof raw['name_suffix'] === 'string'
      ? { name_suffix: raw['name_suffix'] }
      : {}),
    ...(start !== undefined && Number.isSafeInteger(start)
      ? { start_frame: start }
      : {}),
    ...(step !== undefined && step > 0 ? { frame_step: step } : {}),
    ...(rate !== undefined ? { rate } : {}),
    ...(pad !== undefined && Number.isInteger(pad) && pad >= 0 && pad <= 32
      ? { frame_zero_padding: pad }
      : {}),
    ...(policy === 'error' || policy === 'hold' || policy === 'black'
      ? { missing_frame_policy: policy }
      : {}),
    ...(metadata === undefined ? {} : { metadata }),
    raw,
  };
}

function parseEffects(
  raw: Record<string, unknown>,
  diagnostics: OtioDiagnostic[],
  pointer: string
): OtioEffect[] {
  if (!Array.isArray(raw['effects'])) return [];
  return raw['effects'].flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const effect = item as Record<string, unknown>;
    const schema =
      typeof effect['OTIO_SCHEMA'] === 'string'
        ? effect['OTIO_SCHEMA']
        : 'Effect.1';
    if (!KNOWN_SCHEMAS[schema]) {
      diagnostics.push({
        severity: 'warning',
        code: 'unsupported-schema',
        message: `Unknown effect schema ${schema}`,
        target: { json_pointer: pointer },
      });
    }
    const scalar = finiteNumber(effect['time_scalar']);
    const metadata =
      effect['metadata'] && typeof effect['metadata'] === 'object'
        ? (effect['metadata'] as Record<string, unknown>)
        : undefined;
    return [
      {
        schema,
        ...(typeof effect['name'] === 'string' ? { name: effect['name'] } : {}),
        ...(typeof effect['effect_name'] === 'string'
          ? { effect_name: effect['effect_name'] }
          : {}),
        enabled: effect['enabled'] !== false,
        ...(scalar === undefined ? {} : { time_scalar: scalar }),
        ...(metadata === undefined ? {} : { metadata }),
        raw: effect,
      },
    ];
  });
}

function parseMarkers(
  raw: Record<string, unknown>,
  diagnostics: OtioDiagnostic[],
  pointer: string
): OtioMarker[] {
  if (!Array.isArray(raw['markers'])) return [];
  return raw['markers'].flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const marker = item as Record<string, unknown>;
    const schema =
      typeof marker['OTIO_SCHEMA'] === 'string'
        ? marker['OTIO_SCHEMA']
        : 'Marker.1';
    const canonical = readOptionalRange(marker, 'marked_range');
    const canonicalSupplied =
      hasOwn(marker, 'marked_range') && marker['marked_range'] !== null;
    let markedRange = canonical.invalid ? null : canonical.range;
    let timingInvalid = canonical.invalid;
    if (!canonicalSupplied && schema === 'Marker.1' && hasOwn(marker, 'time')) {
      const time = parseRational(marker['time']);
      if (time) {
        markedRange = {
          start_time: time,
          duration: { value: 0, rate: time.rate },
        };
      } else {
        timingInvalid = true;
      }
    }
    if (timingInvalid) {
      diagnostics.push({
        severity: 'warning',
        code: 'invalid-timing',
        message: 'Marker timing is invalid and was not projected',
        target: { json_pointer: pointer },
      });
    }
    const metadata =
      marker['metadata'] && typeof marker['metadata'] === 'object'
        ? (marker['metadata'] as Record<string, unknown>)
        : undefined;
    return [
      {
        schema,
        ...(typeof marker['name'] === 'string' ? { name: marker['name'] } : {}),
        ...(typeof marker['color'] === 'string'
          ? { color: marker['color'] }
          : {}),
        marked_range: markedRange,
        ...(typeof marker['comment'] === 'string'
          ? { comment: marker['comment'] }
          : {}),
        ...(metadata === undefined ? {} : { metadata }),
        raw: marker,
      },
    ];
  });
}

interface Draft {
  pointer: string;
  parentPointer: string | null;
  childPointers: string[];
  raw: Record<string, unknown>;
  schema: string;
  name: string;
  enabled: boolean;
  authoredId: string | null;
  fingerprint: string;
  node: MutableNode;
}

function isItemSchema(schema: string): boolean {
  return (
    schema === 'Clip.1' ||
    schema === 'Clip.2' ||
    schema === 'Gap.1' ||
    schema === 'Stack.1' ||
    schema === 'Track.1'
  );
}

export function readOtioDocument(
  source: string | Uint8Array,
  options?: { readonly mediaIndex?: Readonly<Record<string, OtioMediaEntry>> }
): OtioDocumentV1 {
  const bytes =
    typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const documentSha = syncSha256(bytes);
  const parsed = parseOtioJson(bytes);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('OTIO document root must be an object');
  }
  const media = blank() as Record<string, OtioMediaEntry>;
  for (const key of Object.keys(options?.mediaIndex ?? {})) {
    const entry = options?.mediaIndex?.[key];
    if (entry) put(media, key, entry);
  }
  const drafts = new Map<string, Draft>();
  const authoredCounts = new Map<string, number>();
  const fingerprintCounts = new Map<string, number>();

  const visit = (
    raw: Record<string, unknown>,
    pointer: string,
    parentPointer: string | null
  ): void => {
    const schema =
      typeof raw['OTIO_SCHEMA'] === 'string' ? raw['OTIO_SCHEMA'] : 'Unknown.1';
    const diagnostics: OtioDiagnostic[] = [];
    if (!KNOWN_SCHEMAS[schema]) {
      diagnostics.push({
        severity: 'warning',
        code: 'unsupported-schema',
        message: `Unknown schema ${schema} is preserved and not treated as a known container`,
        target: { json_pointer: pointer },
      });
    }
    const metadata =
      raw['metadata'] &&
      typeof raw['metadata'] === 'object' &&
      !Array.isArray(raw['metadata'])
        ? (raw['metadata'] as Record<string, unknown>)
        : {};
    let authoredId: string | null = null;
    const relic = metadata['relic'];
    if (relic && typeof relic === 'object' && !Array.isArray(relic)) {
      const id = (relic as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id.length > 0) {
        authoredId = id;
        authoredCounts.set(id, (authoredCounts.get(id) ?? 0) + 1);
      }
    }
    const sourceRange = readOptionalRange(raw, 'source_range');
    const ownAvailable = readOptionalRange(raw, 'available_range');
    const refs = blank() as Record<string, OtioMediaReference>;
    let activeKey: string | null = null;
    if (schema === 'Clip.1' || schema === 'Clip.2') {
      if (
        raw['media_references'] &&
        typeof raw['media_references'] === 'object' &&
        !Array.isArray(raw['media_references'])
      ) {
        const table = raw['media_references'] as Record<string, unknown>;
        for (const key of Object.keys(table)) {
          const ref = table[key];
          if (ref && typeof ref === 'object')
            put(refs, key, parseMedia(ref as Record<string, unknown>));
        }
        activeKey =
          typeof raw['active_media_reference_key'] === 'string'
            ? raw['active_media_reference_key']
            : null;
      } else if (
        raw['media_reference'] &&
        typeof raw['media_reference'] === 'object'
      ) {
        put(
          refs,
          'DEFAULT_MEDIA',
          parseMedia(raw['media_reference'] as Record<string, unknown>)
        );
        activeKey = 'DEFAULT_MEDIA';
      }
    }
    const active =
      activeKey && hasOwn(refs, activeKey) ? refs[activeKey] : undefined;
    const available = ownAvailable.range ?? active?.available_range ?? null;
    const inOffset =
      schema === 'Transition.1' ? parseRational(raw['in_offset']) : undefined;
    const outOffset =
      schema === 'Transition.1' ? parseRational(raw['out_offset']) : undefined;
    const timingInvalid =
      sourceRange.invalid ||
      ownAvailable.invalid ||
      (schema === 'Transition.1' && raw['in_offset'] != null && !inOffset) ||
      (schema === 'Transition.1' && raw['out_offset'] != null && !outOffset);
    if (timingInvalid) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-timing',
        message:
          'Supplied timing is invalid and was not replaced with another range',
        target: { json_pointer: pointer },
      });
    }
    const childPointers: string[] = [];
    const children = childList(raw);
    if (children) {
      children.items.forEach((child, index) => {
        const childPointer =
          children.key === 'tracks' && !Array.isArray(raw['tracks'])
            ? `${pointer}/tracks`
            : `${pointer}/${children.key}/${index}`;
        childPointers.push(childPointer);
        visit(child, childPointer, pointer);
      });
    }
    const hash = fingerprintOf(raw);
    fingerprintCounts.set(hash, (fingerprintCounts.get(hash) ?? 0) + 1);
    const parsedSchemaVersion = schemaVersion(schema);
    const trackKind =
      schema === 'Track.1' && typeof raw['kind'] === 'string'
        ? raw['kind']
        : undefined;
    const transitionType =
      schema === 'Transition.1' && typeof raw['transition_type'] === 'string'
        ? raw['transition_type']
        : undefined;
    const node: MutableNode = {
      id: '',
      identity_origin: 'derived-unique',
      json_pointer: pointer,
      schema,
      ...(parsedSchemaVersion === undefined
        ? {}
        : { schema_version: parsedSchemaVersion }),
      name: typeof raw['name'] === 'string' ? raw['name'] : '',
      enabled: raw['enabled'] !== false,
      parent_id: null,
      children_ids: [],
      ...(trackKind === undefined ? {} : { track_kind: trackKind }),
      source_range: sourceRange.invalid ? null : sourceRange.range,
      available_range: schema === 'Gap.1' ? null : available,
      media_references: refs,
      active_media_reference_key: activeKey,
      effects: parseEffects(raw, diagnostics, pointer),
      markers: parseMarkers(raw, diagnostics, pointer),
      ...(transitionType === undefined
        ? {}
        : { transition_type: transitionType }),
      ...(inOffset === undefined ? {} : { in_offset: inOffset }),
      ...(outOffset === undefined ? {} : { out_offset: outOffset }),
      metadata,
      diagnostics,
      raw,
      fingerprint: hash,
      timing_invalid: timingInvalid,
    };
    drafts.set(pointer, {
      pointer,
      parentPointer,
      childPointers,
      raw,
      schema,
      name: node.name,
      enabled: node.enabled,
      authoredId,
      fingerprint: hash,
      node,
    });
  };

  visit(parsed as Record<string, unknown>, '', null);

  const used = new Set<string>();
  const pointerToId = new Map<string, string>();
  const authoredSeen = new Map<string, number>();
  const fingerprintSeen = new Map<string, number>();
  const claim = (id: string): string => {
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let n = 2;
    while (used.has(`${id}#collide_${n}`)) n += 1;
    const next = `${id}#collide_${n}`;
    used.add(next);
    return next;
  };
  for (const draft of drafts.values()) {
    let id: string;
    let origin: OtioIdentityOrigin;
    if (draft.authoredId) {
      const total = authoredCounts.get(draft.authoredId) ?? 1;
      const occ = (authoredSeen.get(draft.authoredId) ?? 0) + 1;
      authoredSeen.set(draft.authoredId, occ);
      if (total === 1) {
        id = claim(draft.authoredId);
        origin = 'authored';
      } else {
        id = claim(`${draft.authoredId}#occ_${occ}`);
        origin = 'derived-duplicate';
        draft.node.diagnostics.push({
          severity: 'warning',
          code: 'ambiguous-identity',
          message: `Duplicate authored ID ${draft.authoredId}`,
          target: { json_pointer: draft.pointer },
        });
      }
    } else {
      const total = fingerprintCounts.get(draft.fingerprint) ?? 1;
      const occ = (fingerprintSeen.get(draft.fingerprint) ?? 0) + 1;
      fingerprintSeen.set(draft.fingerprint, occ);
      origin = total === 1 ? 'derived-unique' : 'derived-duplicate';
      id = claim(
        total === 1
          ? `otio_${draft.fingerprint}`
          : `otio_${draft.fingerprint}#occ_${occ}`
      );
    }
    draft.node.id = id;
    draft.node.identity_origin = origin;
    if (draft.authoredId) draft.node.authored_id = draft.authoredId;
    pointerToId.set(draft.pointer, id);
  }

  const nodes = blank() as Record<string, MutableNode>;
  const timelineIds: string[] = [];
  const globalStarts = blank() as Record<string, OtioRationalTime>;
  for (const draft of drafts.values()) {
    draft.node.parent_id =
      draft.parentPointer === null
        ? null
        : (pointerToId.get(draft.parentPointer) ?? null);
    draft.node.children_ids = draft.childPointers.map(
      (pointer) => pointerToId.get(pointer) as string
    );
    put(nodes, draft.node.id, draft.node);
    if (draft.schema === 'Timeline.1') {
      timelineIds.push(draft.node.id);
      const start = parseRational(draft.raw['global_start_time']);
      if (start) put(globalStarts, draft.node.id, start);
    }
  }

  const root = drafts.get('');
  if (root?.schema === 'SerializableCollection.1') {
    // Selectable timelines, never concatenation.
  } else if (
    root &&
    root.schema !== 'Timeline.1' &&
    isItemSchema(root.schema)
  ) {
    const wrapperId = claim('otio_synthetic_timeline');
    const wrapper: MutableNode = {
      id: wrapperId,
      identity_origin: 'derived-unique',
      json_pointer: '',
      schema: 'Timeline.1',
      name: root.name || 'Preview',
      enabled: true,
      parent_id: null,
      children_ids: [root.node.id],
      diagnostics: [],
      timing_invalid: false,
      fingerprint: `synthetic:${root.fingerprint}`,
    };
    root.node.parent_id = wrapperId;
    put(nodes, wrapperId, wrapper);
    timelineIds.unshift(wrapperId);
  }

  const placements = new Map<string, Placement>();
  for (const id of timelineIds) {
    const timeline = nodes[id];
    if (timeline) measureNode(nodes, timeline, placements);
  }
  for (const id of timelineIds) {
    const timeline = nodes[id];
    if (!timeline) continue;
    const placement = placements.get(id);
    const rate = placement?.rate ?? 24;
    const duration = placement?.trimmed?.duration ?? { value: 0, rate };
    const timelineRange: OtioTimeRange = {
      start_time: { value: 0, rate: duration.rate },
      duration,
    };
    timeline.timeline_range = timelineRange;
    timeline.visible_timeline_range = timelineRange;
    const localOrigin = timeline.source_range?.start_time ?? {
      value: 0,
      rate: duration.rate,
    };
    const rootMap: OtioBoundMap = {
      timeline_origin: { value: 0, rate: duration.rate },
      local_origin: localOrigin,
      sample_origin: localOrigin,
      scalar: 1,
      available_start: null,
    };
    bindMap(
      timeline,
      rootMap.timeline_origin,
      localOrigin,
      placement?.trimmed ?? timelineRange
    );
    for (const childId of timeline.children_ids) {
      const child = nodes[childId];
      if (child) {
        projectNode(
          nodes,
          child,
          placements,
          rootMap,
          timelineRange,
          timelineRange
        );
      }
    }
  }

  return {
    version: 1,
    document_sha256: documentSha,
    timeline_ids: timelineIds,
    nodes,
    media,
    diagnostics: [],
    global_start_times: globalStarts,
  };
}

function rateOf(
  time: OtioRationalTime | null | undefined,
  fallback: number
): number {
  if (time && Number.isFinite(time.rate) && time.rate > 0) return time.rate;
  return fallback;
}

function measureNode(
  nodes: Record<string, MutableNode>,
  node: MutableNode,
  placements: Map<string, Placement>
): Placement {
  const existing = placements.get(node.id);
  if (existing) return existing;
  for (const childId of node.children_ids) {
    const child = nodes[childId];
    if (child) measureNode(nodes, child, placements);
  }
  if (node.timing_invalid) {
    const placement = {
      trimmed: null,
      known: false,
      parentRange: null,
      visibleParent: null,
      rate: 24,
    };
    placements.set(node.id, placement);
    return placement;
  }
  if (node.schema === 'Track.1') return measureTrack(nodes, node, placements);
  if (node.schema === 'Stack.1' || node.schema === 'Timeline.1')
    return measureStack(nodes, node, placements);
  if (node.schema === 'Transition.1') {
    const rate = rateOf(node.in_offset, rateOf(node.out_offset, 24));
    const placement = {
      trimmed: null,
      known: Boolean(node.in_offset && node.out_offset),
      parentRange: null,
      visibleParent: null,
      rate,
    };
    placements.set(node.id, placement);
    return placement;
  }
  const trimmed =
    node.source_range ??
    (node.schema === 'Gap.1'
      ? null
      : node.available_range
        ? {
            start_time: node.available_range.start_time,
            duration: node.available_range.duration,
          }
        : null);
  const known = Boolean(trimmed);
  if (!known && isItemSchema(node.schema)) {
    node.diagnostics.push({
      severity: 'warning',
      code: 'unplaced-item',
      message: `Duration of ${node.name || node.id} is unknown`,
      target: { node_id: node.id, json_pointer: node.json_pointer },
    });
  }
  const placement = {
    trimmed,
    known,
    parentRange: null,
    visibleParent: null,
    rate: rateOf(trimmed?.duration, 24),
  };
  placements.set(node.id, placement);
  return placement;
}

function measureStack(
  nodes: Record<string, MutableNode>,
  node: MutableNode,
  placements: Map<string, Placement>
): Placement {
  let rate = rateOf(node.source_range?.duration, 0);
  let maxEnd: OtioRationalTime | null = null;
  for (const childId of node.children_ids) {
    const child = nodes[childId];
    const childPlacement = child ? placements.get(child.id) : undefined;
    if (!child || !childPlacement) continue;
    if (rate === 0) rate = childPlacement.rate;
    if (!childPlacement.trimmed) {
      child.parent_range = null;
      childPlacement.parentRange = null;
      childPlacement.visibleParent = null;
      continue;
    }
    const start = { value: 0, rate: childPlacement.trimmed.duration.rate };
    const parentRange = {
      start_time: start,
      duration: childPlacement.trimmed.duration,
    };
    child.parent_range = parentRange;
    childPlacement.parentRange = parentRange;
    childPlacement.visibleParent = parentRange;
    const end = rangeEndTime(parentRange);
    if (!maxEnd || compareRationalTimes(end, maxEnd) > 0) maxEnd = end;
  }
  if (rate === 0) rate = 24;
  const natural = maxEnd
    ? { start_time: { value: 0, rate: maxEnd.rate }, duration: maxEnd }
    : null;
  const trimmed = node.source_range ?? natural;
  const placement = {
    trimmed,
    known: Boolean(trimmed),
    parentRange: null,
    visibleParent: null,
    rate: rateOf(trimmed?.duration, rate),
  };
  placements.set(node.id, placement);
  node.available_range = node.available_range ?? natural;
  return placement;
}

function measureTrack(
  nodes: Record<string, MutableNode>,
  node: MutableNode,
  placements: Map<string, Placement>
): Placement {
  let rate = rateOf(node.source_range?.duration, 0);
  if (rate === 0) {
    for (const childId of node.children_ids) {
      const child = nodes[childId];
      const childPlacement = child ? placements.get(child.id) : undefined;
      if (
        child &&
        childPlacement &&
        childPlacement.rate > 0 &&
        child.schema !== 'Transition.1'
      ) {
        rate = childPlacement.rate;
        break;
      }
    }
  }
  if (rate === 0) rate = 24;
  let cursor: OtioRationalTime = { value: 0, rate };
  let poisoned = false;
  const children = node.children_ids
    .map((id) => nodes[id])
    .filter((child): child is MutableNode => Boolean(child));
  for (const child of children) {
    const childPlacement = placements.get(child.id);
    if (child.schema === 'Transition.1') {
      if (poisoned || !child.in_offset || !child.out_offset) {
        if (!poisoned && (!child.in_offset || !child.out_offset)) {
          child.diagnostics.push({
            severity: 'warning',
            code: 'unplaced-item',
            message: `Transition ${child.name || child.id} has unknown duration`,
            target: { node_id: child.id, json_pointer: child.json_pointer },
          });
        }
        poisoned = true;
        child.parent_range = null;
        if (childPlacement) {
          childPlacement.parentRange = null;
          childPlacement.visibleParent = null;
        }
        continue;
      }
      const start = subtractRationalTimes(cursor, child.in_offset);
      const duration = addRationalTimes(child.in_offset, child.out_offset);
      const range = { start_time: start, duration };
      child.parent_range = range;
      if (childPlacement) {
        childPlacement.parentRange = range;
        childPlacement.visibleParent = range;
      }
      continue;
    }
    if (poisoned || !childPlacement?.known || !childPlacement.trimmed) {
      poisoned = true;
      child.parent_range = null;
      if (childPlacement) {
        childPlacement.parentRange = null;
        childPlacement.visibleParent = null;
      }
      child.diagnostics.push({
        severity: 'warning',
        code: 'unplaced-item',
        message: `Sequential placement after an unknown duration stops at ${child.name || child.id}`,
        target: { node_id: child.id, json_pointer: child.json_pointer },
      });
      continue;
    }
    const range = {
      start_time: cursor,
      duration: childPlacement.trimmed.duration,
    };
    child.parent_range = range;
    childPlacement.parentRange = range;
    childPlacement.visibleParent = range;
    cursor = addRationalTimes(cursor, childPlacement.trimmed.duration);
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as MutableNode;
    if (child.schema === 'Transition.1' || !child.parent_range) continue;
    const previous = children[index - 1];
    const next = children[index + 1];
    const pre =
      previous?.schema === 'Transition.1' ? (previous.in_offset ?? null) : null;
    const post =
      next?.schema === 'Transition.1' ? (next.out_offset ?? null) : null;
    const visible = extendRange(child.parent_range, pre, post);
    const childPlacement = placements.get(child.id);
    if (childPlacement) childPlacement.visibleParent = visible;
  }
  const first = children[0];
  const last = children[children.length - 1];
  const leading =
    first?.schema === 'Transition.1' ? (first.in_offset ?? null) : null;
  const trailing =
    last?.schema === 'Transition.1' ? (last.out_offset ?? null) : null;
  const natural = poisoned
    ? null
    : {
        start_time: { value: 0, rate },
        duration: addRationalTimes(
          addRationalTimes(cursor, leading ?? { value: 0, rate }),
          trailing ?? { value: 0, rate }
        ),
      };
  const trimmed = natural ? (node.source_range ?? natural) : null;
  const placement = {
    trimmed,
    known: Boolean(trimmed),
    parentRange: null,
    visibleParent: null,
    rate,
  };
  placements.set(node.id, placement);
  if (natural && !node.available_range) node.available_range = natural;
  return placement;
}

function extendRange(
  range: OtioTimeRange,
  pre: OtioRationalTime | null,
  post: OtioRationalTime | null
): OtioTimeRange {
  const start = pre
    ? subtractRationalTimes(range.start_time, pre)
    : range.start_time;
  const end = post
    ? addRationalTimes(rangeEndTime(range), post)
    : rangeEndTime(range);
  return { start_time: start, duration: subtractRationalTimes(end, start) };
}

function bindMap(
  node: MutableNode,
  timelineOrigin: OtioRationalTime,
  localOrigin: OtioRationalTime,
  effectiveSelection: OtioTimeRange | null
): void {
  const scalar = effectScalarOf(node);
  const selection =
    effectiveSelection ?? node.source_range ?? node.available_range ?? null;
  const sourceStart = selection?.start_time ?? localOrigin;
  const last = selection
    ? subtractRationalTimes(rangeEndTime(selection), {
        value: 1,
        rate: selection.start_time.rate,
      })
    : sourceStart;
  bindOtioSamplingMap(node, {
    timeline_origin: timelineOrigin,
    local_origin: sourceStart,
    sample_origin: scalar < 0 ? last : sourceStart,
    scalar,
    available_start: node.available_range?.start_time ?? null,
  });
}

function clearProjectedSubtree(
  nodes: Record<string, MutableNode>,
  node: MutableNode
): void {
  node.timeline_range = null;
  node.visible_timeline_range = null;
  for (const childId of node.children_ids) {
    const child = nodes[childId];
    if (child) clearProjectedSubtree(nodes, child);
  }
}

function projectNode(
  nodes: Record<string, MutableNode>,
  node: MutableNode,
  placements: Map<string, Placement>,
  parentMap: OtioBoundMap,
  parentEditorial: OtioTimeRange | null,
  parentVisible: OtioTimeRange | null
): void {
  const placement = placements.get(node.id);
  const parentRange = node.parent_range ?? placement?.parentRange ?? null;
  if (!parentRange) {
    clearProjectedSubtree(nodes, node);
    return;
  }
  const rootStart = addRationalTimes(
    parentMap.timeline_origin,
    subtractRationalTimes(parentRange.start_time, parentMap.local_origin)
  );
  const localOrigin = placement?.trimmed?.start_time ??
    node.source_range?.start_time ?? {
      value: 0,
      rate: parentRange.start_time.rate,
    };
  bindMap(node, rootStart, localOrigin, placement?.trimmed ?? null);
  const visibleParent = placement?.visibleParent ?? parentRange;
  const mappedParent = mapThrough(parentMap, parentRange);
  const mappedVisible = mapThrough(parentMap, visibleParent);
  node.timeline_range = parentEditorial
    ? intersectRanges(mappedParent, parentEditorial)
    : null;
  node.visible_timeline_range = parentVisible
    ? intersectRanges(mappedVisible, parentVisible)
    : null;
  const childMap: OtioBoundMap = {
    timeline_origin: rootStart,
    local_origin: localOrigin,
    sample_origin: localOrigin,
    scalar: 1,
    available_start: null,
  };
  for (const childId of node.children_ids) {
    const child = nodes[childId];
    if (child) {
      projectNode(
        nodes,
        child,
        placements,
        childMap,
        node.timeline_range,
        node.visible_timeline_range
      );
    }
  }
}

function mapThrough(map: OtioBoundMap, range: OtioTimeRange): OtioTimeRange {
  const start = addRationalTimes(
    map.timeline_origin,
    subtractRationalTimes(range.start_time, map.local_origin)
  );
  const end = addRationalTimes(
    map.timeline_origin,
    subtractRationalTimes(rangeEndTime(range), map.local_origin)
  );
  return { start_time: start, duration: subtractRationalTimes(end, start) };
}

function nodeOf(document: OtioDocumentV1, id: string): OtioNode | undefined {
  return hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
}

function inTimeline(
  document: OtioDocumentV1,
  timelineId: string,
  nodeId: string | null | undefined
): boolean {
  if (!nodeId) return false;
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === timelineId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = nodeOf(document, cursor)?.parent_id ?? null;
  }
  return false;
}

interface MediaWitness {
  readonly facts: readonly string[];
  readonly complete: boolean;
  readonly allDigestsPresent: boolean;
}

const mediaWitnessCache = new WeakMap<
  OtioDocumentV1,
  WeakMap<OtioNode, MediaWitness>
>();

function mediaWitness(document: OtioDocumentV1, node: OtioNode): MediaWitness {
  const facts = new Set<string>();
  const seen = new WeakSet<object>();
  let sequenceImages = 0;
  let complete = true;
  let allDigestsPresent = true;

  const appendEntry = (
    entries: Array<readonly [string, string | null]>,
    name: string
  ): void => {
    const entry = hasOwn(document.media, name)
      ? document.media[name]
      : undefined;
    const digest = entry?.sha256 || null;
    if (digest === null) allDigestsPresent = false;
    entries.push([name, digest]);
  };

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    const entries: Array<readonly [string, string | null]> = [];
    if (record['OTIO_SCHEMA'] === 'ImageSequenceReference.1') {
      const read = readOtioImageSequence(record);
      if (read.ok) {
        if (
          sequenceImages >
          MAX_OTIO_BUNDLE_MEDIA_ENTRIES - read.sequence.count
        ) {
          complete = false;
        } else {
          sequenceImages += read.sequence.count;
          for (const name of otioSequenceFrameEntries(record, document.media)) {
            appendEntry(entries, name);
          }
        }
      } else if (read.reason.startsWith('image sequence count exceeds')) {
        complete = false;
      }
      facts.add(
        JSON.stringify([stringifyOtioJson(stripIdentity(record)), entries])
      );
    } else if (typeof record['target_url'] === 'string') {
      const entry = otioBundleEntryFor(record['target_url'], (name) =>
        hasOwn(document.media, name)
      );
      if (entry !== null) appendEntry(entries, entry);
      facts.add(
        JSON.stringify([stringifyOtioJson(stripIdentity(record)), entries])
      );
    }

    for (const key of Object.keys(record)) visit(record[key]);
  };

  visit(node.raw);
  return {
    facts: [...facts].sort(),
    complete,
    allDigestsPresent,
  };
}

function mediaWitnessFor(
  document: OtioDocumentV1,
  node: OtioNode
): MediaWitness {
  let byNode = mediaWitnessCache.get(document);
  if (!byNode) {
    byNode = new WeakMap<OtioNode, MediaWitness>();
    mediaWitnessCache.set(document, byNode);
  }
  const cached = byNode.get(node);
  if (cached) return cached;
  const witness = mediaWitness(document, node);
  byNode.set(node, witness);
  return witness;
}

function mediaContinuous(
  left: OtioDocumentV1,
  right: OtioDocumentV1,
  leftNode: OtioNode,
  rightNode: OtioNode
): boolean {
  if (left === right) return true;
  const leftWitness = mediaWitnessFor(left, leftNode);
  const rightWitness = mediaWitnessFor(right, rightNode);
  if (
    !leftWitness.complete ||
    !rightWitness.complete ||
    !leftWitness.allDigestsPresent ||
    !rightWitness.allDigestsPresent ||
    leftWitness.facts.length !== rightWitness.facts.length
  ) {
    return false;
  }
  return leftWitness.facts.every(
    (fact, index) => fact === rightWitness.facts[index]
  );
}

type CurrentNodeMatch =
  | {
      readonly status: 'unique';
      readonly source: OtioNode;
      readonly node: OtioNode;
    }
  | { readonly status: 'ambiguous' | 'missing' };

type NodeMatch = CurrentNodeMatch | { readonly status: 'changed' };

function findCurrentNode(
  original: OtioDocumentV1,
  current: OtioDocumentV1,
  nodeId: string
): CurrentNodeMatch {
  const source = nodeOf(original, nodeId);
  if (!source) return { status: 'missing' };
  if (source.identity_origin === 'derived-duplicate') {
    return { status: 'ambiguous' };
  }
  if (source.identity_origin === 'authored') {
    const matches = Object.keys(current.nodes)
      .map((id) => nodeOf(current, id))
      .filter((node): node is OtioNode =>
        Boolean(node && node.authored_id === (source.authored_id ?? source.id))
      );
    if (matches.length > 1) return { status: 'ambiguous' };
    const match = matches[0];
    if (!match) return { status: 'missing' };
    return { status: 'unique', source, node: match };
  }
  const matches = Object.keys(current.nodes)
    .map((id) => nodeOf(current, id))
    .filter((node): node is OtioNode =>
      Boolean(
        node && node.fingerprint && node.fingerprint === source.fingerprint
      )
    );
  if (matches.length > 1) return { status: 'ambiguous' };
  const match = matches[0];
  if (!match) return { status: 'missing' };
  return { status: 'unique', source, node: match };
}

function matchNode(
  original: OtioDocumentV1,
  current: OtioDocumentV1,
  nodeId: string
): NodeMatch {
  const match = findCurrentNode(original, current, nodeId);
  if (match.status !== 'unique') return match;
  if (!mediaContinuous(original, current, match.source, match.node)) {
    return { status: 'changed' };
  }
  return match;
}

interface OriginalAnchorSelection {
  readonly spans: readonly OtioSourceSpan[];
  readonly partial: boolean;
  readonly containerId: string | null;
}

function isLeafAnchorTarget(node: OtioNode): boolean {
  return (
    node.schema === 'Clip.1' ||
    node.schema === 'Clip.2' ||
    node.schema === 'Gap.1' ||
    node.schema === 'Transition.1'
  );
}

function prepareOriginalAnchorSelection(
  anchor: OtioAnchorV1,
  document: OtioDocumentV1,
  sourceSpans: readonly OtioSourceSpan[]
): OriginalAnchorSelection | null {
  if (anchor.item_id === undefined) {
    return { spans: sourceSpans, partial: false, containerId: null };
  }
  const item = nodeOf(document, anchor.item_id);
  const exposed = item?.visible_timeline_range ?? item?.timeline_range ?? null;
  const intersection = exposed ? intersectRanges(exposed, anchor.range) : null;
  if (!item || !intersection) return null;
  const partial =
    compareRationalTimes(intersection.duration, anchor.range.duration) !== 0;
  if (isLeafAnchorTarget(item)) {
    const spans = sourceSpans.filter((span) => span.node_id === item.id);
    return spans.length === 0 ? null : { spans, partial, containerId: null };
  }
  return {
    spans: sourceSpans.filter((span) =>
      inTimeline(document, item.id, span.node_id)
    ),
    partial,
    containerId: item.id,
  };
}

function sameTargets(
  original: OtioDocumentV1,
  current: OtioDocumentV1,
  targets: readonly string[]
): boolean {
  return targets.every((id) => {
    const originalNode = nodeOf(original, id);
    const currentNode = nodeOf(current, id);
    return Boolean(
      originalNode &&
        currentNode &&
        mediaContinuous(original, current, originalNode, currentNode)
    );
  });
}

function anchorFitsExposure(
  anchor: OtioAnchorV1,
  exposure: OtioTimeRange
): boolean {
  const durationOrder = compareRationalTimes(anchor.range.duration, {
    value: 0,
    rate: anchor.range.duration.rate,
  });
  if (durationOrder < 0) return false;
  const start = anchor.range.start_time;
  const end = rangeEndTime(anchor.range);
  const exposureEnd = rangeEndTime(exposure);
  if (compareRationalTimes(start, exposure.start_time) < 0) return false;
  if (durationOrder === 0) return compareRationalTimes(start, exposureEnd) < 0;
  return compareRationalTimes(end, exposureEnd) <= 0;
}

function originalAnchorSelectionError(
  anchor: OtioAnchorV1,
  document: OtioDocumentV1
): string | null {
  const timeline = nodeOf(document, anchor.timeline_id);
  if (
    !timeline ||
    timeline.schema !== 'Timeline.1' ||
    !document.timeline_ids.includes(anchor.timeline_id)
  ) {
    return 'Anchor timeline, track, or item is not in the selected timeline';
  }

  const track =
    anchor.track_id === null ? null : nodeOf(document, anchor.track_id);
  if (
    anchor.track_id !== null &&
    (!track ||
      track.schema !== 'Track.1' ||
      !inTimeline(document, anchor.timeline_id, anchor.track_id))
  ) {
    return 'Anchor timeline, track, or item is not in the selected timeline';
  }

  if (
    anchor.item_id !== undefined &&
    (!inTimeline(document, anchor.timeline_id, anchor.item_id) ||
      (anchor.track_id !== null &&
        !inTimeline(document, anchor.track_id, anchor.item_id)))
  ) {
    return 'Anchor timeline, track, or item is not in the selected timeline';
  }

  const timelineExposure =
    timeline.visible_timeline_range ?? timeline.timeline_range ?? null;
  if (
    !timelineExposure ||
    compareRationalTimes(timelineExposure.duration, {
      value: 0,
      rate: timelineExposure.duration.rate,
    }) <= 0
  ) {
    return 'Anchor timeline has no positive exposed range';
  }
  if (!anchorFitsExposure(anchor, timelineExposure)) {
    return 'Anchor range is outside the selected timeline or track exposure';
  }

  if (track) {
    const trackExposure =
      track.visible_timeline_range ?? track.timeline_range ?? null;
    if (
      !trackExposure ||
      compareRationalTimes(trackExposure.duration, {
        value: 0,
        rate: trackExposure.duration.rate,
      }) <= 0
    ) {
      return 'Anchor track has no positive exposed range';
    }
    if (!anchorFitsExposure(anchor, trackExposure)) {
      return 'Anchor range is outside the selected timeline or track exposure';
    }
  }
  return null;
}

function invalidAnchorResolution(
  anchor: OtioAnchorV1,
  sourceSpans: readonly OtioSourceSpan[],
  message: string
): OtioAnchorResolution {
  return {
    status: 'changed',
    original_anchor: anchor,
    source_spans: sourceSpans,
    diagnostics: [
      {
        severity: 'error',
        code: 'invalid-timing',
        message,
        target: {
          node_id: anchor.item_id ?? anchor.track_id ?? anchor.timeline_id,
        },
      },
    ],
  };
}
function projectIntervalBoundary(
  media: OtioRationalTime,
  currentMap: OtioBoundMap,
  exposedStart: OtioRationalTime,
  exposedEnd: OtioRationalTime,
  startWitness: OtioRationalTime,
  endWitness: OtioRationalTime
): {
  time: OtioRationalTime | null;
  boundary?: 'start' | 'end';
  ambiguous?: true;
} {
  const matchesStart = compareRationalTimes(media, startWitness) === 0;
  const matchesEnd = compareRationalTimes(media, endWitness) === 0;
  if (matchesStart && matchesEnd) {
    return compareRationalTimes(exposedStart, exposedEnd) === 0
      ? { time: exposedStart }
      : { time: null, ambiguous: true };
  }
  if (matchesStart) return { time: exposedStart, boundary: 'start' };
  if (matchesEnd) return { time: exposedEnd, boundary: 'end' };
  return { time: invertOtioIntervalEdge(currentMap, media) };
}

function projectPiece(
  spanStart: OtioRationalTime,
  spanEnd: OtioRationalTime,
  originalMap: OtioBoundMap,
  currentMap: OtioBoundMap,
  exposed: OtioTimeRange | null
): { range?: OtioTimeRange; ambiguous?: boolean; partial?: boolean } {
  if (originalMap.scalar === 0 || currentMap.scalar === 0)
    return { ambiguous: true };
  const point = compareRationalTimes(spanStart, spanEnd) === 0;
  const startMedia = point
    ? sampleOtioMedia(originalMap, spanStart)
    : otioIntervalEdge(originalMap, spanStart);
  const endMedia = point ? startMedia : otioIntervalEdge(originalMap, spanEnd);
  let start: OtioRationalTime | null;
  let end: OtioRationalTime | null;
  if (point) {
    start = invertOtioSample(currentMap, startMedia);
    end = start;
  } else if (!exposed) {
    start = invertOtioIntervalEdge(currentMap, startMedia);
    end = invertOtioIntervalEdge(currentMap, endMedia);
  } else {
    const exposedStart = exposed.start_time;
    const exposedEnd = rangeEndTime(exposed);
    const startWitness = otioIntervalEdge(currentMap, exposedStart);
    const endWitness = otioIntervalEdge(currentMap, exposedEnd);
    const startProjection = projectIntervalBoundary(
      startMedia,
      currentMap,
      exposedStart,
      exposedEnd,
      startWitness,
      endWitness
    );
    const endProjection = projectIntervalBoundary(
      endMedia,
      currentMap,
      exposedStart,
      exposedEnd,
      startWitness,
      endWitness
    );
    if (startProjection.ambiguous || endProjection.ambiguous)
      return { ambiguous: true };
    if (
      startProjection.boundary &&
      endProjection.boundary &&
      startProjection.boundary !== endProjection.boundary
    ) {
      return { range: exposed, partial: false };
    }
    start = startProjection.time;
    end = endProjection.time;
  }
  if (!start || !end) return { ambiguous: true };
  const forward = compareRationalTimes(end, start) >= 0;
  const projected: OtioTimeRange = forward
    ? { start_time: start, duration: subtractRationalTimes(end, start) }
    : { start_time: end, duration: subtractRationalTimes(start, end) };
  if (!exposed) return {};
  const clipped = intersectRanges(projected, exposed);
  if (!clipped) return {};
  const partial =
    compareRationalTimes(clipped.duration, projected.duration) !== 0;
  return { range: clipped, partial };
}

function mergeRanges(ranges: OtioTimeRange[]): OtioTimeRange[] {
  const sorted = [...ranges].sort(
    (a, b) => compareRationalTimes(a.start_time, b.start_time) || 0
  );
  const merged: OtioTimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(range);
      continue;
    }
    const lastEnd = rangeEndTime(last);
    if (compareRationalTimes(range.start_time, lastEnd) > 0) {
      merged.push(range);
      continue;
    }
    const end =
      compareRationalTimes(rangeEndTime(range), lastEnd) > 0
        ? rangeEndTime(range)
        : lastEnd;
    merged[merged.length - 1] = {
      start_time: last.start_time,
      duration: subtractRationalTimes(end, last.start_time),
    };
  }
  return merged;
}

function timelineOf(
  document: OtioDocumentV1,
  nodeId: string
): string | undefined {
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor) {
    if (document.timeline_ids.includes(cursor)) return cursor;
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    cursor = nodeOf(document, cursor)?.parent_id ?? null;
  }
  return undefined;
}

export function resolveOtioAnchor(
  anchor: OtioAnchorV1,
  originalDocument: OtioDocumentV1,
  currentDocument?: OtioDocumentV1
): OtioAnchorResolution {
  const sourceSpans = sourceSpansForOtioRange(
    originalDocument,
    anchor.timeline_id,
    anchor.track_id,
    anchor.range
  );
  const selectionError = originalAnchorSelectionError(anchor, originalDocument);
  if (
    anchor.document_sha256 !== originalDocument.document_sha256 ||
    selectionError
  ) {
    return invalidAnchorResolution(
      anchor,
      sourceSpans,
      selectionError ??
        'Anchor document digest does not match the original document'
    );
  }
  const selection = prepareOriginalAnchorSelection(
    anchor,
    originalDocument,
    sourceSpans
  );
  if (!selection) {
    return invalidAnchorResolution(
      anchor,
      sourceSpans,
      'Anchor item does not contribute to the selected range'
    );
  }
  const targets = [
    ...new Set(
      anchor.item_id === undefined
        ? sourceSpans.map((span) => span.node_id)
        : [anchor.item_id]
    ),
  ];
  if (!currentDocument) {
    return {
      status: 'same',
      original_anchor: anchor,
      mapped_range: anchor.range,
      mapped_ranges: [anchor.range],
      mapped_timeline_id: anchor.timeline_id,
      mapped_track_id: anchor.track_id,
      ...(anchor.item_id === undefined
        ? {}
        : { mapped_item_id: anchor.item_id }),
      source_spans: sourceSpans,
      diagnostics: [],
    };
  }
  if (
    currentDocument.document_sha256 === originalDocument.document_sha256 &&
    sameTargets(originalDocument, currentDocument, targets)
  ) {
    return {
      status: 'same',
      original_anchor: anchor,
      mapped_range: anchor.range,
      mapped_ranges: [anchor.range],
      mapped_timeline_id: anchor.timeline_id,
      mapped_track_id: anchor.track_id,
      ...(anchor.item_id === undefined
        ? {}
        : { mapped_item_id: anchor.item_id }),
      source_spans: sourceSpans,
      diagnostics: [],
    };
  }

  let ambiguous = false;
  let changed = false;
  let missing = false;
  let partial = selection.partial;
  const pieces: OtioTimeRange[] = [];
  const matchedIds = new Set<string>();
  let currentContainer: OtioNode | undefined;
  let containerUnresolved = false;
  if (selection.containerId) {
    const match = findCurrentNode(
      originalDocument,
      currentDocument,
      selection.containerId
    );
    if (match.status === 'ambiguous') ambiguous = true;
    if (match.status === 'missing') missing = true;
    if (match.status === 'unique') currentContainer = match.node;
    else containerUnresolved = true;
  }
  const projectionTargets = containerUnresolved
    ? []
    : [...new Set(selection.spans.map((span) => span.node_id))];
  if (projectionTargets.length === 0) missing = true;
  for (const targetId of projectionTargets) {
    const match = matchNode(originalDocument, currentDocument, targetId);
    if (match.status === 'ambiguous') ambiguous = true;
    if (match.status === 'changed') {
      if (selection.containerId) missing = true;
      else changed = true;
    }
    if (match.status === 'missing') missing = true;
    if (match.status !== 'unique' || !match.node) continue;
    if (
      currentContainer &&
      !inTimeline(currentDocument, currentContainer.id, match.node.id)
    ) {
      missing = true;
      continue;
    }
    matchedIds.add(match.node.id);
    const originalNode = nodeOf(originalDocument, targetId);
    const originalMap = originalNode
      ? otioSamplingMap(originalNode)
      : undefined;
    const currentMap = otioSamplingMap(match.node);
    const exposed =
      match.node.visible_timeline_range ?? match.node.timeline_range ?? null;
    if (!originalMap || !currentMap) {
      if (selection.containerId) missing = true;
      else changed = true;
      continue;
    }
    const intervals = selection.spans
      .filter((span) => span.node_id === targetId)
      .map((span) => span.intersected_timeline_range);
    for (const interval of intervals) {
      const projected = projectPiece(
        interval.start_time,
        rangeEndTime(interval),
        originalMap,
        currentMap,
        exposed
      );
      if (projected.ambiguous) ambiguous = true;
      if (projected.partial) partial = true;
      if (!projected.range) missing = true;
      if (projected.range) pieces.push(projected.range);
    }
  }
  if (ambiguous) {
    return {
      status: 'ambiguous',
      original_anchor: anchor,
      source_spans: sourceSpans,
      diagnostics: [
        {
          severity: 'warning',
          code: 'ambiguous-identity',
          message:
            'Projection is ambiguous between occurrences or a non-invertible sample',
        },
      ],
    };
  }
  if (changed && pieces.length === 0) {
    return {
      status: 'changed',
      original_anchor: anchor,
      source_spans: sourceSpans,
      diagnostics: [
        {
          severity: 'warning',
          code: 'unsupported-effect',
          message: 'Media digest or structure no longer establishes continuity',
        },
      ],
    };
  }
  const mappedRanges = mergeRanges(pieces);
  if (mappedRanges.length === 0) {
    return {
      status: 'missing',
      original_anchor: anchor,
      mapped_ranges: [],
      source_spans: sourceSpans,
      diagnostics: [],
    };
  }
  const status: OtioProjectionStatus =
    partial || missing ? 'partial' : 'mapped';
  const mappedIds = currentContainer ? [currentContainer.id] : [...matchedIds];
  const [candidateMappedItemId] = mappedIds;
  const mappedItemId =
    mappedIds.length === 1 && candidateMappedItemId !== undefined
      ? candidateMappedItemId
      : undefined;
  const mappedNode =
    mappedItemId === undefined
      ? undefined
      : nodeOf(currentDocument, mappedItemId);
  const timelines = mappedIds
    .map((id) => timelineOf(currentDocument, id))
    .filter((id): id is string => Boolean(id));
  const [candidateMappedTimelineId] = timelines;
  const uniqueTimeline =
    new Set(timelines).size === 1 && candidateMappedTimelineId !== undefined
      ? candidateMappedTimelineId
      : undefined;
  const [candidateMappedRange] = mappedRanges;
  const mappedRange =
    mappedRanges.length === 1 && candidateMappedRange !== undefined
      ? candidateMappedRange
      : undefined;
  return {
    status,
    original_anchor: anchor,
    mapped_ranges: mappedRanges,
    ...(mappedRange === undefined ? {} : { mapped_range: mappedRange }),
    ...(uniqueTimeline === undefined
      ? {}
      : { mapped_timeline_id: uniqueTimeline }),
    ...(mappedItemId === undefined
      ? {}
      : {
          mapped_item_id: mappedItemId,
          mapped_track_id: mappedNode?.parent_id ?? null,
        }),
    source_spans: sourceSpans,
    diagnostics: [],
  };
}
