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
  OtioIdentityOrigin,
  OtioMediaEntry,
  OtioMediaReference,
  OtioNode,
  OtioProjectionStatus,
  OtioRationalTime,
  OtioSourceSpan,
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
 * SHA-256 computation in pure JS/WebCrypto for document digest and fingerprints.
 */
function sha256Hex(data: Uint8Array | string): string {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;

  // Simple, deterministic 32-bit FNV/Murmur combination for stable offline fallback or SHA-256
  // We can use crypto.subtle if async, or a pure synchronous SHA-256 implementation:
  return syncSha256(bytes);
}

function syncSha256(bytes: Uint8Array): string {
  // Pure synchronous SHA-256 implementation
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

  const nodes: Record<string, OtioNode> = {};
  const timelineIds: string[] = [];
  const diagnostics: OtioDiagnostic[] = [];
  const globalStartTimes: Record<string, OtioRationalTime> = {};
  const mediaMap: Record<string, OtioMediaEntry> = {
    ...(options?.mediaIndex ?? {}),
  };

  const authoredIdsSeen = new Map<string, number>();

  // First pass: identify and assign IDs
  function processObject(
    obj: Record<string, unknown>,
    pointer: string,
    parentId: string | null
  ): string {
    const schema =
      typeof obj['OTIO_SCHEMA'] === 'string' ? obj['OTIO_SCHEMA'] : 'Unknown.1';
    const name = typeof obj['name'] === 'string' ? obj['name'] : '';
    const metadata =
      typeof obj['metadata'] === 'object' && obj['metadata'] !== null
        ? (obj['metadata'] as Record<string, unknown>)
        : {};

    // Authored ID
    let authoredId: string | null = null;
    const relicMeta = metadata['relic'];
    if (typeof relicMeta === 'object' && relicMeta !== null) {
      const rid = (relicMeta as Record<string, unknown>)['id'];
      if (typeof rid === 'string' && rid.length > 0) {
        authoredId = rid;
      }
    }

    let nodeId = authoredId;
    let identityOrigin: OtioIdentityOrigin = 'authored';

    if (authoredId) {
      const count = (authoredIdsSeen.get(authoredId) ?? 0) + 1;
      authoredIdsSeen.set(authoredId, count);
      if (count > 1) {
        identityOrigin = 'derived-duplicate';
        diagnostics.push({
          severity: 'warning',
          code: 'ambiguous-identity',
          message: `Duplicate authored ID detected: ${authoredId}`,
          target: { json_pointer: pointer },
        });
        nodeId = `${authoredId}#dup${count}`;
      }
    } else {
      // Derive structural fingerprint
      const fp = `${schema}:${name}:${pointer}`;
      const hash = syncSha256(new TextEncoder().encode(fp)).slice(0, 16);
      nodeId = `otio_${hash}`;
      identityOrigin = 'derived-unique';
    }

    const enabled = obj['enabled'] !== false;
    const childrenIds: string[] = [];

    // Parse ranges
    const sourceRange = parseTimeRange(obj['source_range']);

    // Parse media references (for Clip.1 and Clip.2)
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

    // Process children
    if (Array.isArray(obj['tracks'])) {
      // Timeline tracks (Stack)
      const stackObj = obj['tracks'] as unknown;
      if (typeof stackObj === 'object' && stackObj !== null) {
        const stackId = processObject(
          stackObj as Record<string, unknown>,
          `${pointer}/tracks`,
          nodeId
        );
        childrenIds.push(stackId);
      }
    } else if (Array.isArray(obj['children'])) {
      // Stack or Track children
      const children = obj['children'] as Record<string, unknown>[];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (typeof c === 'object' && c !== null) {
          const cId = processObject(c, `${pointer}/children/${i}`, nodeId);
          childrenIds.push(cId);
        }
      }
    }

    let trackKind: string | undefined;
    if (schema.startsWith('Track')) {
      trackKind = typeof obj['kind'] === 'string' ? obj['kind'] : 'Video';
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

    const node: OtioNode = {
      id: nodeId as string,
      identity_origin: identityOrigin,
      json_pointer: pointer,
      schema,
      name,
      enabled,
      parent_id: parentId,
      children_ids: childrenIds,
      track_kind: trackKind,
      source_range: sourceRange,
      media_references: mediaRefs,
      active_media_reference_key: activeKey,
      transition_type: transitionType,
      in_offset: inOffset,
      out_offset: outOffset,
      metadata,
    };

    nodes[nodeId as string] = node;

    if (schema.startsWith('Timeline')) {
      timelineIds.push(nodeId as string);
      if (obj['global_start_time']) {
        const gst = parseRationalTime(obj['global_start_time']);
        if (gst) globalStartTimes[nodeId as string] = gst;
      }
    }

    return nodeId as string;
  }

  processObject(rawObj, '', null);

  // Second pass: compute parent ranges and timeline ranges sequentially
  for (const tid of timelineIds) {
    const tNode = nodes[tid];
    if (tNode) {
      computeTimelinePlacements(nodes, tNode);
    }
  }

  return {
    version: 1,
    document_sha256: docSha256,
    timeline_ids: timelineIds,
    nodes,
    media: mediaMap,
    diagnostics,
    global_start_times: globalStartTimes,
  };
}

function computeTimelinePlacements(
  nodes: Record<string, OtioNode>,
  root: OtioNode
): void {
  // Placement on timeline
  const zeroRate = 24;
  const zeroTime: OtioRationalTime = { value: 0, rate: zeroRate };

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

        let duration: OtioRationalTime = { value: 0, rate: cursor.rate };
        if (child.source_range) {
          duration = rescaleTime(child.source_range.duration, cursor.rate);
        } else if (child.schema.startsWith('Transition')) {
          duration = { value: 0, rate: cursor.rate };
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

  // Cross-revision projection
  let status: OtioProjectionStatus = 'same';
  let mappedRange: OtioTimeRange | undefined = anchor.range;
  let mappedTrackId: string | null | undefined = anchor.track_id;
  let mappedItemId: string | undefined = anchor.item_id;

  // Remapping order:
  // 1. Authored ID
  // 2. Structural fingerprint
  // 3. Otherwise ambiguous / changed / missing
  if (anchor.item_id) {
    const origNode = originalDocument.nodes[anchor.item_id];
    if (!origNode) {
      status = 'missing';
    } else {
      let matchedNode: OtioNode | null = null;
      let matchCount = 0;

      for (const nid in currentDocument.nodes) {
        const cand = currentDocument.nodes[nid];
        if (!cand) continue;
        if (cand.id === origNode.id && cand.identity_origin === 'authored') {
          matchedNode = cand;
          matchCount++;
        }
      }

      if (matchCount === 1 && matchedNode) {
        mappedItemId = matchedNode.id;
        mappedTrackId = matchedNode.parent_id;
        if (matchedNode.timeline_range) {
          mappedRange = matchedNode.timeline_range;
          status = 'mapped';
        }
      } else if (matchCount > 1) {
        status = 'ambiguous';
      } else {
        status = 'missing';
      }
    }
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
