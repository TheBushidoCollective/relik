/**
 * OpenTimelineIO deterministic node identity, parsing into OtioDocumentV1,
 * and conservative anchor resolution.
 */

import { parseOtioJson } from './otio-json.ts';
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
  OtioTimeRange,
} from './otio-types.ts';
import {
  addRationalTimes,
  compareRationalTimes,
  rangeEndTime,
  rescaleTime,
  sourceSpansForOtioRange,
  subtractRationalTimes,
} from './otio-timing.ts';

/**
 * Pure synchronous SHA-256 for document digest and structural fingerprints.
 */
function syncSha256(bytes: Uint8Array): string {
  const K = [
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

  const totalLen = bytes.length;
  const bitLen = totalLen * 8;
  const withOne = totalLen + 1;
  const padLen =
    withOne % 64 <= 56 ? 56 - (withOne % 64) : 120 - (withOne % 64);
  const fullLen = withOne + padLen + 8;
  const buf = new Uint8Array(fullLen);
  buf.set(bytes);
  buf[totalLen] = 0x80;

  const view = new DataView(buf.buffer);
  view.setBigUint64(fullLen - 8, BigInt(bitLen), false);

  const w = new Uint32Array(64);
  for (let i = 0; i < fullLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
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

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
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

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

interface RawNodeIntermediate {
  readonly pointer: string;
  readonly parentPointer: string | null;
  readonly childPointers: string[];
  readonly schema: string;
  readonly schema_version?: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly authoredId: string | null;
  readonly fpHash: string;
  readonly track_kind?: string;
  readonly source_range?: OtioTimeRange | null;
  readonly available_range?: OtioTimeRange | null;
  readonly media_references?: Record<string, OtioMediaReference>;
  readonly active_media_reference_key?: string | null;
  readonly effects?: OtioEffect[];
  readonly markers?: OtioMarker[];
  readonly transition_type?: string;
  readonly in_offset?: OtioRationalTime;
  readonly out_offset?: OtioRationalTime;
  readonly metadata?: Record<string, unknown>;
  readonly diagnostics: OtioDiagnostic[];
}

/**
 * Parse an OTIO JSON document into a structured OtioDocumentV1.
 */
export function readOtioDocument(
  source: string | Uint8Array,
  options?: { readonly mediaIndex?: Readonly<Record<string, OtioMediaEntry>> }
): OtioDocumentV1 {
  const bytes =
    typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const docSha256 = syncSha256(bytes);
  const rawObj = parseOtioJson(bytes) as Record<string, unknown>;

  const intermediateNodes = new Map<string, RawNodeIntermediate>();
  const authoredIdCounts = new Map<string, number>();
  const fpHashCounts = new Map<string, number>();
  const globalStartTimes: Record<string, OtioRationalTime> = {};
  const rootTimelinePointers: string[] = [];
  const docDiagnostics: OtioDiagnostic[] = [];

  // Pass 1: traverse AST, collect structural fingerprints and authored IDs
  function traverse(
    obj: Record<string, unknown>,
    pointer: string,
    parentPointer: string | null
  ): void {
    const schema =
      typeof obj['OTIO_SCHEMA'] === 'string' ? obj['OTIO_SCHEMA'] : 'Unknown.1';
    let schemaVersion: number | undefined;
    const dotIdx = schema.lastIndexOf('.');
    if (dotIdx > 0) {
      const verNum = parseInt(schema.slice(dotIdx + 1), 10);
      if (!isNaN(verNum)) schemaVersion = verNum;
    }

    const name = typeof obj['name'] === 'string' ? obj['name'] : '';
    const enabled = obj['enabled'] !== false;
    const metadata =
      typeof obj['metadata'] === 'object' && obj['metadata'] !== null
        ? (obj['metadata'] as Record<string, unknown>)
        : {};

    const nodeDiagnostics: OtioDiagnostic[] = [];

    // Check authored ID
    let authoredId: string | null = null;
    const relicMeta = metadata['relic'];
    if (typeof relicMeta === 'object' && relicMeta !== null) {
      const rid = (relicMeta as Record<string, unknown>)['id'];
      if (typeof rid === 'string' && rid.length > 0) {
        authoredId = rid;
        authoredIdCounts.set(
          authoredId,
          (authoredIdCounts.get(authoredId) ?? 0) + 1
        );
      }
    }

    const sourceRange = parseTimeRange(obj['source_range']);
    const availableRange = parseTimeRange(obj['available_range']);

    // Parse media references
    const mediaRefs: Record<string, OtioMediaReference> = {};
    let activeKey: string | null = null;

    if (schema.startsWith('Clip')) {
      const singleRef = obj['media_reference'] as
        | Record<string, unknown>
        | undefined;
      const multiRefs = obj['media_references'] as
        | Record<string, Record<string, unknown>>
        | undefined;
      activeKey =
        typeof obj['active_media_reference_key'] === 'string'
          ? (obj['active_media_reference_key'] as string)
          : 'DEFAULT_MEDIA';

      if (multiRefs && typeof multiRefs === 'object') {
        for (const k in multiRefs) {
          const r = multiRefs[k];
          if (r) mediaRefs[k] = parseMediaRef(r);
        }
      } else if (singleRef && typeof singleRef === 'object') {
        mediaRefs['DEFAULT_MEDIA'] = parseMediaRef(singleRef);
        activeKey = 'DEFAULT_MEDIA';
      }
    }

    // Parse effects
    const effects: OtioEffect[] = [];
    if (Array.isArray(obj['effects'])) {
      for (const eff of obj['effects']) {
        if (typeof eff === 'object' && eff !== null) {
          const effSchema =
            typeof eff['OTIO_SCHEMA'] === 'string'
              ? eff['OTIO_SCHEMA']
              : 'Effect.1';
          const effName =
            typeof eff['name'] === 'string' ? eff['name'] : undefined;
          const effEffectName =
            typeof eff['effect_name'] === 'string'
              ? eff['effect_name']
              : undefined;
          const effEnabled = eff['enabled'] !== false;
          const timeScalar =
            typeof eff['time_scalar'] === 'number'
              ? eff['time_scalar']
              : undefined;
          const effMeta =
            typeof eff['metadata'] === 'object' && eff['metadata'] !== null
              ? eff['metadata']
              : {};

          effects.push({
            schema: effSchema,
            name: effName,
            effect_name: effEffectName,
            enabled: effEnabled,
            time_scalar: timeScalar,
            metadata: effMeta,
          });
        }
      }
    }

    // Parse markers
    const markers: OtioMarker[] = [];
    if (Array.isArray(obj['markers'])) {
      for (const m of obj['markers']) {
        if (typeof m === 'object' && m !== null) {
          const mSchema =
            typeof m['OTIO_SCHEMA'] === 'string'
              ? m['OTIO_SCHEMA']
              : 'Marker.1';
          const mName = typeof m['name'] === 'string' ? m['name'] : undefined;
          const color = typeof m['color'] === 'string' ? m['color'] : undefined;
          const comment =
            typeof m['comment'] === 'string' ? m['comment'] : undefined;
          const markedRange = parseTimeRange(m['marked_range']) ?? {
            start_time: { value: 0, rate: 24 },
            duration: { value: 0, rate: 24 },
          };
          const mMeta =
            typeof m['metadata'] === 'object' && m['metadata'] !== null
              ? m['metadata']
              : {};

          markers.push({
            schema: mSchema,
            name: mName,
            color,
            marked_range: markedRange,
            comment,
            metadata: mMeta,
          });
        }
      }
    }

    // Transitions
    let transitionType: string | undefined;
    let inOffset: OtioRationalTime | undefined;
    let outOffset: OtioRationalTime | undefined;
    if (schema.startsWith('Transition')) {
      transitionType =
        typeof obj['transition_type'] === 'string'
          ? obj['transition_type']
          : 'SMPTE_Dissolve';
      inOffset = parseRationalTime(obj['in_offset']);
      outOffset = parseRationalTime(obj['out_offset']);
    }

    let trackKind: string | undefined;
    if (schema.startsWith('Track')) {
      trackKind = typeof obj['kind'] === 'string' ? obj['kind'] : 'Video';
    }

    // Process children pointers
    const childPointers: string[] = [];

    // Support standard Timeline.tracks Stack object and array
    if (obj['tracks'] !== undefined && obj['tracks'] !== null) {
      if (Array.isArray(obj['tracks'])) {
        for (let i = 0; i < obj['tracks'].length; i++) {
          const c = obj['tracks'][i];
          if (typeof c === 'object' && c !== null) {
            const cp = `${pointer}/tracks/${i}`;
            childPointers.push(cp);
            traverse(c, cp, pointer);
          }
        }
      } else if (typeof obj['tracks'] === 'object') {
        const cp = `${pointer}/tracks`;
        childPointers.push(cp);
        traverse(obj['tracks'] as Record<string, unknown>, cp, pointer);
      }
    } else if (Array.isArray(obj['children'])) {
      for (let i = 0; i < obj['children'].length; i++) {
        const c = obj['children'][i];
        if (typeof c === 'object' && c !== null) {
          const cp = `${pointer}/children/${i}`;
          childPointers.push(cp);
          traverse(c, cp, pointer);
        }
      }
    }

    // Lossless structural fingerprint
    const mediaSummary =
      activeKey && mediaRefs[activeKey]
        ? `${mediaRefs[activeKey].schema}:${mediaRefs[activeKey].target_url ?? mediaRefs[activeKey].target_url_base ?? ''}`
        : '';
    const srcRangeSummary = sourceRange
      ? `${sourceRange.start_time.value}/${sourceRange.start_time.rate}:${sourceRange.duration.value}/${sourceRange.duration.rate}`
      : '';
    const effSummary = effects
      .map((e) => `${e.schema}:${e.time_scalar ?? ''}`)
      .join(',');

    const fpString = `${schema}|${name}|${trackKind ?? ''}|${srcRangeSummary}|${mediaSummary}|${effSummary}`;
    const fpHash = syncSha256(new TextEncoder().encode(fpString)).slice(0, 16);

    fpHashCounts.set(fpHash, (fpHashCounts.get(fpHash) ?? 0) + 1);

    if (schema.startsWith('Timeline')) {
      rootTimelinePointers.push(pointer);
      if (obj['global_start_time']) {
        const gst = parseRationalTime(obj['global_start_time']);
        if (gst) globalStartTimes[pointer] = gst;
      }
    }

    intermediateNodes.set(pointer, {
      pointer,
      parentPointer,
      childPointers,
      schema,
      schema_version: schemaVersion,
      name,
      enabled,
      authoredId,
      fpHash,
      track_kind: trackKind,
      source_range: sourceRange,
      available_range: availableRange,
      media_references: mediaRefs,
      active_media_reference_key: activeKey,
      effects,
      markers,
      transition_type: transitionType,
      in_offset: inOffset,
      out_offset: outOffset,
      metadata,
      diagnostics: nodeDiagnostics,
    });
  }

  traverse(rawObj, '', null);

  // Pass 2: assign unique and duplicate-derived identities
  const pointerToFinalId = new Map<string, string>();
  const authoredOccurrences = new Map<string, number>();
  const fpOccurrences = new Map<string, number>();

  for (const [ptr, raw] of intermediateNodes) {
    if (raw.authoredId) {
      const total = authoredIdCounts.get(raw.authoredId) ?? 1;
      const occ = (authoredOccurrences.get(raw.authoredId) ?? 0) + 1;
      authoredOccurrences.set(raw.authoredId, occ);

      if (total === 1) {
        pointerToFinalId.set(ptr, raw.authoredId);
      } else {
        // ALL occurrences of duplicate authored IDs are marked derived-duplicate
        pointerToFinalId.set(ptr, `${raw.authoredId}#dup_${occ}`);
      }
    } else {
      const total = fpHashCounts.get(raw.fpHash) ?? 1;
      const occ = (fpOccurrences.get(raw.fpHash) ?? 0) + 1;
      fpOccurrences.set(raw.fpHash, occ);

      if (total === 1) {
        pointerToFinalId.set(ptr, `otio_${raw.fpHash}`);
      } else {
        pointerToFinalId.set(ptr, `otio_${raw.fpHash}#dup_${occ}`);
      }
    }
  }

  // Construct OtioNode map
  const nodes: Record<string, OtioNode> = {};
  const timelineIds: string[] = [];

  for (const [ptr, raw] of intermediateNodes) {
    const finalId = pointerToFinalId.get(ptr) as string;
    const parentId = raw.parentPointer
      ? (pointerToFinalId.get(raw.parentPointer) ?? null)
      : null;
    const childrenIds = raw.childPointers.map(
      (cp) => pointerToFinalId.get(cp) as string
    );

    let origin: OtioIdentityOrigin = 'authored';
    if (raw.authoredId) {
      const count = authoredIdCounts.get(raw.authoredId) ?? 1;
      if (count > 1) {
        origin = 'derived-duplicate';
        raw.diagnostics.push({
          severity: 'warning',
          code: 'ambiguous-identity',
          message: `Duplicate authored ID detected: ${raw.authoredId}`,
          target: { node_id: finalId, json_pointer: ptr },
        });
      }
    } else {
      const count = fpHashCounts.get(raw.fpHash) ?? 1;
      if (count === 1) {
        origin = 'derived-unique';
      } else {
        origin = 'derived-duplicate';
        raw.diagnostics.push({
          severity: 'info',
          code: 'ambiguous-identity',
          message: `Multiple identical structural items detected with fingerprint ${raw.fpHash}`,
          target: { node_id: finalId, json_pointer: ptr },
        });
      }
    }

    const otioNode: OtioNode = {
      id: finalId,
      identity_origin: origin,
      json_pointer: ptr,
      schema: raw.schema,
      schema_version: raw.schema_version,
      name: raw.name,
      enabled: raw.enabled,
      parent_id: parentId,
      children_ids: childrenIds,
      track_kind: raw.track_kind,
      source_range: raw.source_range,
      available_range: raw.available_range,
      media_references: raw.media_references,
      active_media_reference_key: raw.active_media_reference_key,
      effects: raw.effects,
      markers: raw.markers,
      transition_type: raw.transition_type,
      in_offset: raw.in_offset,
      out_offset: raw.out_offset,
      metadata: raw.metadata,
      diagnostics: raw.diagnostics,
    };

    nodes[finalId] = otioNode;

    if (raw.schema.startsWith('Timeline')) {
      timelineIds.push(finalId);
      if (globalStartTimes[ptr]) {
        globalStartTimes[finalId] = globalStartTimes[ptr] as OtioRationalTime;
        delete globalStartTimes[ptr];
      }
    }
  }

  // Pass 3: recursive timeline placement calculation
  for (const tid of timelineIds) {
    const tNode = nodes[tid];
    if (tNode) {
      computeTimelinePlacements(nodes, tNode, docDiagnostics);
    }
  }

  const mediaMap: Record<string, OtioMediaEntry> = {
    ...(options?.mediaIndex ?? {}),
  };

  return {
    version: 1,
    document_sha256: docSha256,
    timeline_ids: timelineIds,
    nodes,
    media: mediaMap,
    diagnostics: docDiagnostics,
    global_start_times: globalStartTimes,
  };
}

/**
 * Compute placements recursively for Tracks, Stacks, and nested compositions.
 */
function computeTimelinePlacements(
  nodes: Record<string, OtioNode>,
  root: OtioNode,
  diagnosticsOut: OtioDiagnostic[]
): void {
  // Determine root timeline rate
  let defaultRate = 24;
  for (const childId of root.children_ids) {
    const child = nodes[childId];
    if (child?.source_range) {
      defaultRate = child.source_range.duration.rate;
      break;
    }
  }

  const zeroTime: OtioRationalTime = { value: 0, rate: defaultRate };

  function placeChildren(
    node: OtioNode,
    currentStart: OtioRationalTime
  ): OtioRationalTime {
    if (node.schema.startsWith('Track')) {
      // Sequential placement
      let cursor = currentStart;

      for (const childId of node.children_ids) {
        const child = nodes[childId];
        if (!child) continue;

        let duration: OtioRationalTime | null = null;

        if (child.source_range) {
          duration = rescaleTime(child.source_range.duration, cursor.rate);
        } else if (child.available_range) {
          duration = rescaleTime(child.available_range.duration, cursor.rate);
        } else if (child.media_references && child.active_media_reference_key) {
          const m = child.media_references[child.active_media_reference_key];
          if (m?.available_range) {
            duration = rescaleTime(m.available_range.duration, cursor.rate);
          }
        } else if (child.schema.startsWith('Transition')) {
          duration = { value: 0, rate: cursor.rate };
        } else if (
          child.schema.startsWith('Stack') ||
          child.schema.startsWith('Track')
        ) {
          // Nested composition
          const nestedEnd = placeChildren(child, {
            value: 0,
            rate: cursor.rate,
          });
          duration = rescaleTime(nestedEnd, cursor.rate);
        }

        if (duration === null) {
          diagnosticsOut.push({
            severity: 'warning',
            code: 'unplaced-item',
            message: `Cannot determine duration for item ${child.name || child.id}; marked as unplaced`,
            target: { node_id: child.id, json_pointer: child.json_pointer },
          });
          const mutable = child as unknown as {
            parent_range: OtioTimeRange | null;
            timeline_range: OtioTimeRange | null;
          };
          mutable.parent_range = null;
          mutable.timeline_range = null;
          continue;
        }

        const itemRange: OtioTimeRange = {
          start_time: cursor,
          duration,
        };

        const mutableChild = child as unknown as {
          parent_range: OtioTimeRange;
          timeline_range: OtioTimeRange;
        };
        mutableChild.parent_range = itemRange;
        mutableChild.timeline_range = itemRange;

        if (!child.schema.startsWith('Transition')) {
          cursor = addRationalTimes(cursor, duration);
        }
      }
      return cursor;
    } else {
      // Parallel placement (Stack or Timeline)
      let maxEnd = currentStart;
      for (const childId of node.children_ids) {
        const child = nodes[childId];
        if (!child) continue;
        const end = placeChildren(child, currentStart);
        if (compareRationalTimes(end, maxEnd) > 0) {
          maxEnd = end;
        }
      }
      return maxEnd;
    }
  }

  placeChildren(root, zeroTime);
}

function parseRationalTime(val: unknown): OtioRationalTime | undefined {
  if (typeof val !== 'object' || val === null) return undefined;
  const obj = val as Record<string, unknown>;
  const value =
    typeof obj['value'] === 'number' ? obj['value'] : Number(obj['value']);
  const rate =
    typeof obj['rate'] === 'number' ? obj['rate'] : Number(obj['rate']);
  if (!Number.isFinite(value) || !Number.isFinite(rate) || rate <= 0)
    return undefined;
  return { value, rate };
}

function parseTimeRange(val: unknown): OtioTimeRange | null {
  if (typeof val !== 'object' || val === null) return null;
  const obj = val as Record<string, unknown>;
  const start = parseRationalTime(obj['start_time']);
  const dur = parseRationalTime(obj['duration']);
  if (!start || !dur) return null;
  return { start_time: start, duration: dur };
}

function parseMediaRef(ref: Record<string, unknown>): OtioMediaReference {
  const schema =
    typeof ref['OTIO_SCHEMA'] === 'string'
      ? ref['OTIO_SCHEMA']
      : 'MissingReference.1';
  const name = typeof ref['name'] === 'string' ? ref['name'] : undefined;
  const targetUrl =
    typeof ref['target_url'] === 'string' ? ref['target_url'] : null;
  const availRange = parseTimeRange(ref['available_range']);

  return {
    schema,
    name,
    target_url: targetUrl,
    available_range: availRange,
    target_url_base:
      typeof ref['target_url_base'] === 'string'
        ? ref['target_url_base']
        : undefined,
    name_prefix:
      typeof ref['name_prefix'] === 'string' ? ref['name_prefix'] : undefined,
    name_suffix:
      typeof ref['name_suffix'] === 'string' ? ref['name_suffix'] : undefined,
    start_frame:
      typeof ref['start_frame'] === 'number' ? ref['start_frame'] : undefined,
    frame_step:
      typeof ref['frame_step'] === 'number' ? ref['frame_step'] : undefined,
    rate: typeof ref['rate'] === 'number' ? ref['rate'] : undefined,
    frame_zero_padding:
      typeof ref['frame_zero_padding'] === 'number'
        ? ref['frame_zero_padding']
        : undefined,
    missing_frame_policy:
      ref['missing_frame_policy'] === 'hold' ||
      ref['missing_frame_policy'] === 'black'
        ? ref['missing_frame_policy']
        : 'error',
    metadata:
      typeof ref['metadata'] === 'object' && ref['metadata'] !== null
        ? (ref['metadata'] as Record<string, unknown>)
        : {},
  };
}

/**
 * Resolve an OTIO anchor against an original document and optionally project
 * against a current document.
 */
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

  // If no currentDocument or SHA matches, status is 'same'
  if (
    !currentDocument ||
    currentDocument.document_sha256 === originalDocument.document_sha256
  ) {
    return {
      status: 'same',
      original_anchor: anchor,
      mapped_range: anchor.range,
      mapped_track_id: anchor.track_id,
      mapped_item_id: anchor.item_id,
      source_spans: sourceSpans,
      diagnostics: [],
    };
  }

  let status: OtioProjectionStatus = 'same';
  let mappedRange: OtioTimeRange | undefined = anchor.range;
  let mappedTrackId: string | null | undefined = anchor.track_id;
  let mappedItemId: string | undefined = anchor.item_id;

  if (anchor.item_id) {
    const origNode = originalDocument.nodes[anchor.item_id];
    if (!origNode) {
      status = 'missing';
      mappedRange = undefined;
    } else if (origNode.identity_origin === 'derived-duplicate') {
      // Identical duplicate occurrences must remain ambiguous
      status = 'ambiguous';
    } else {
      let matchedNode: OtioNode | null = null;
      let matchCount = 0;

      // 1. Try authored ID
      if (origNode.identity_origin === 'authored') {
        for (const nid in currentDocument.nodes) {
          const cand = currentDocument.nodes[nid];
          if (!cand) continue;
          if (cand.id === origNode.id && cand.identity_origin === 'authored') {
            matchedNode = cand;
            matchCount++;
          }
        }
      }

      // 2. Try structural fingerprint if no unique authored match
      if (matchCount === 0 && origNode.identity_origin === 'derived-unique') {
        for (const nid in currentDocument.nodes) {
          const cand = currentDocument.nodes[nid];
          if (!cand) continue;
          if (
            cand.schema === origNode.schema &&
            cand.name === origNode.name &&
            cand.track_kind === origNode.track_kind
          ) {
            const origMedia = getActiveMediaUrl(origNode);
            const candMedia = getActiveMediaUrl(cand);
            if (origMedia === candMedia) {
              matchedNode = cand;
              matchCount++;
            }
          }
        }
      }

      if (matchCount > 1) {
        status = 'ambiguous';
      } else if (matchCount === 1 && matchedNode) {
        mappedItemId = matchedNode.id;
        mappedTrackId = matchedNode.parent_id;

        // Check effects for non-invertible retiming / freeze
        let hasAmbiguousRetiming = false;
        if (matchedNode.effects) {
          for (const eff of matchedNode.effects) {
            if (eff.enabled) {
              if (
                eff.schema.startsWith('FreezeFrame') ||
                (eff.schema.startsWith('LinearTimeWarp') &&
                  eff.time_scalar !== 1)
              ) {
                hasAmbiguousRetiming = true;
                break;
              }
            }
          }
        }

        if (hasAmbiguousRetiming) {
          status = 'ambiguous';
        } else if (
          origNode.timeline_range &&
          origNode.source_range &&
          matchedNode.timeline_range &&
          matchedNode.source_range
        ) {
          // Source interval mapping
          const offset = subtractRationalTimes(
            anchor.range.start_time,
            origNode.timeline_range.start_time
          );
          const anchorSourceStart = addRationalTimes(
            origNode.source_range.start_time,
            offset
          );
          const anchorSourceEnd = addRationalTimes(
            anchorSourceStart,
            anchor.range.duration
          );

          const curSourceStart = matchedNode.source_range.start_time;
          const curSourceEnd = rangeEndTime(matchedNode.source_range);

          const cmpStart = compareRationalTimes(
            anchorSourceStart,
            curSourceEnd
          );
          const cmpEnd = compareRationalTimes(anchorSourceEnd, curSourceStart);

          if (cmpStart >= 0 || cmpEnd <= 0) {
            // Completely trimmed out
            status = 'missing';
            mappedRange = undefined;
          } else {
            const isFullyContained =
              compareRationalTimes(anchorSourceStart, curSourceStart) >= 0 &&
              compareRationalTimes(anchorSourceEnd, curSourceEnd) <= 0;

            if (isFullyContained) {
              const newOffset = subtractRationalTimes(
                anchorSourceStart,
                curSourceStart
              );
              const newTimelineStart = addRationalTimes(
                matchedNode.timeline_range.start_time,
                newOffset
              );
              mappedRange = {
                start_time: newTimelineStart,
                duration: anchor.range.duration,
              };
              status = 'mapped';
            } else {
              // Partially trimmed
              const overlapStart =
                compareRationalTimes(anchorSourceStart, curSourceStart) >= 0
                  ? anchorSourceStart
                  : curSourceStart;
              const overlapEnd =
                compareRationalTimes(anchorSourceEnd, curSourceEnd) <= 0
                  ? anchorSourceEnd
                  : curSourceEnd;
              const overlapDur = subtractRationalTimes(
                overlapEnd,
                overlapStart
              );
              const newOffset = subtractRationalTimes(
                overlapStart,
                curSourceStart
              );
              const newTimelineStart = addRationalTimes(
                matchedNode.timeline_range.start_time,
                newOffset
              );
              mappedRange = {
                start_time: newTimelineStart,
                duration: overlapDur,
              };
              status = 'partial';
            }
          }
        } else {
          status = 'changed';
        }
      } else {
        status = 'missing';
        mappedRange = undefined;
      }
    }
  } else if (anchor.track_id) {
    let trackFound = false;
    for (const nid in currentDocument.nodes) {
      const cand = currentDocument.nodes[nid];
      if (cand && cand.id === anchor.track_id) {
        trackFound = true;
        break;
      }
    }
    if (!trackFound) {
      status = 'missing';
      mappedRange = undefined;
    } else {
      // Compare source spans in range to determine if changed
      const origSpans = sourceSpans;
      const curSpans = sourceSpansForOtioRange(
        currentDocument,
        anchor.timeline_id,
        anchor.track_id,
        anchor.range
      );
      if (
        origSpans.length === curSpans.length &&
        origSpans.every((s, idx) => s.node_id === curSpans[idx]?.node_id)
      ) {
        status = 'mapped';
      } else if (curSpans.length > 0) {
        status = 'changed';
      } else {
        status = 'missing';
      }
    }
  } else {
    // Composition level
    const timelineFound = currentDocument.timeline_ids.includes(
      anchor.timeline_id
    );
    status = timelineFound ? 'mapped' : 'missing';
  }

  return {
    status,
    original_anchor: anchor,
    mapped_range: mappedRange,
    mapped_track_id: mappedTrackId,
    mapped_item_id: mappedItemId,
    source_spans: sourceSpans,
    diagnostics: [],
  };
}

function getActiveMediaUrl(node: OtioNode): string | null {
  if (!node.media_references || !node.active_media_reference_key) return null;
  const ref = node.media_references[node.active_media_reference_key];
  return ref?.target_url ?? ref?.target_url_base ?? null;
}
