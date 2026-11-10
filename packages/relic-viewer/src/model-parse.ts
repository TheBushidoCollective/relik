export type ModelFormat = 'stl' | 'obj';
export type ModelWarning = 'geometry-only' | 'color-ignored';
export type ModelErrorCode =
  | 'invalid-format'
  | 'invalid-data'
  | 'unsupported-geometry'
  | 'non-planar-face'
  | 'self-intersecting-face'
  | 'limit-exceeded'
  | 'internal-error';

export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ParsedModel {
  positions: Float32Array;
  bounds: ModelBounds;
  warnings: ModelWarning[];
}

export interface ModelParseRequest {
  type: 'parse';
  id: number;
  format: ModelFormat;
  bytes: ArrayBuffer;
}

export type ModelParseResponse =
  | ({ type: 'result'; id: number; ok: true } & ParsedModel)
  | { type: 'result'; id: number; ok: false; error: ModelErrorCode };

export const MODEL_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxTriangles: 250_000,
  maxSourceVertices: 500_000,
  maxFaceVertices: 1_024,
  maxLineBytes: 64 * 1024,
  maxGeometryBytes: 32 * 1024 * 1024,
  maxNumericBytes: 64 * 1024 * 1024,
} as const;

/** Only these fixed codes may leave the parser; source text is never an error. */
export class ModelParseError extends Error {
  constructor(readonly code: ModelErrorCode) {
    super(code);
    this.name = 'ModelParseError';
  }
}

function fail(code: ModelErrorCode): never {
  throw new ModelParseError(code);
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

function number(token: string | null): number {
  if (token === null || !NUMBER.test(token)) return fail('invalid-data');
  const value = Number(token);
  if (!Number.isFinite(value)) return fail('invalid-data');
  return value;
}

function position(value: number): number {
  const stored = Math.fround(value);
  if (!Number.isFinite(stored)) return fail('invalid-data');
  return stored;
}

function objCoordinate(value: number): number {
  // Keep double precision until after polygon validation, but reject values
  // that cannot be represented in the transferred Float32 geometry.
  position(value);
  return value;
}

function checkedBuffers(
  inputBytes: number,
  retainedBytes: number,
  temporaryBytes: number
): void {
  if (
    retainedBytes > MODEL_LIMITS.maxGeometryBytes ||
    inputBytes + retainedBytes + temporaryBytes > MODEL_LIMITS.maxNumericBytes
  )
    fail('limit-exceeded');
}

function checkCounts(triangles: number, vertices: number): void {
  if (
    triangles > MODEL_LIMITS.maxTriangles ||
    vertices > MODEL_LIMITS.maxSourceVertices
  ) {
    fail('limit-exceeded');
  }
}

function decodeText(bytes: Uint8Array): string {
  // Enforce the line budget in source bytes, not UTF-16 code units. CRLF and
  // bare CR are both line endings; the decoder rejects malformed UTF-8.
  let lineBytes = 0;
  for (const byte of bytes) {
    if (byte === 10 || byte === 13) lineBytes = 0;
    else if (++lineBytes > MODEL_LIMITS.maxLineBytes) fail('limit-exceeded');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('invalid-data');
  }
}

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** A bounded scanner: neither a model nor a face is split into an unbounded array. */
class Tokens {
  private offset = 0;

  constructor(private readonly text: string) {}

  next(): string | null {
    while (
      this.offset < this.text.length &&
      isSpace(this.text.charCodeAt(this.offset))
    ) {
      this.offset++;
    }
    if (this.offset >= this.text.length) return null;
    const start = this.offset;
    while (
      this.offset < this.text.length &&
      !isSpace(this.text.charCodeAt(this.offset))
    ) {
      this.offset++;
    }
    return this.text.slice(start, this.offset);
  }

  skipLine(): void {
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset++);
      if (code === 10 || code === 13) break;
    }
  }
}

function* lines(text: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 10 && code !== 13) continue;
    yield text.slice(start, i);
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  if (start < text.length) yield text.slice(start);
}

function lineTokens(line: string): Tokens {
  const comment = line.indexOf('#');
  return new Tokens(comment < 0 ? line : line.slice(0, comment));
}

function requireToken(tokens: Tokens, expected: string): void {
  if (tokens.next() !== expected) fail('invalid-data');
}

function requireEnd(tokens: Tokens): void {
  if (tokens.next() !== null) fail('invalid-data');
}

function makeBounds(): ModelBounds {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function putVertex(
  positions: Float32Array,
  offset: number,
  bounds: ModelBounds,
  x: number,
  y: number,
  z: number
): number {
  x = position(x);
  y = position(y);
  z = position(z);
  positions[offset++] = x;
  positions[offset++] = y;
  positions[offset++] = z;
  bounds.min[0] = Math.min(bounds.min[0], x);
  bounds.min[1] = Math.min(bounds.min[1], y);
  bounds.min[2] = Math.min(bounds.min[2], z);
  bounds.max[0] = Math.max(bounds.max[0], x);
  bounds.max[1] = Math.max(bounds.max[1], y);
  bounds.max[2] = Math.max(bounds.max[2], z);
  return offset;
}

function triangleHasArea(positions: Float32Array, i: number): boolean {
  const ax = positions[i + 3]! - positions[i]!;
  const ay = positions[i + 4]! - positions[i + 1]!;
  const az = positions[i + 5]! - positions[i + 2]!;
  const bx = positions[i + 6]! - positions[i]!;
  const by = positions[i + 7]! - positions[i + 1]!;
  const bz = positions[i + 8]! - positions[i + 2]!;
  return (
    ay * bz - az * by !== 0 ||
    az * bx - ax * bz !== 0 ||
    ax * by - ay * bx !== 0
  );
}

// STL can contain individual degenerate facets, but at least one must draw.
function requireDrawableTriangle(positions: Float32Array): void {
  for (let i = 0; i < positions.length; i += 9) {
    if (triangleHasArea(positions, i)) return;
  }
  fail('invalid-data');
}

function hasBinaryControls(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i]!;
    if ((byte < 32 && !isSpace(byte)) || byte === 127) return true;
  }
  return false;
}

function startsWithSolid(bytes: Uint8Array): boolean {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && isSpace(bytes[i]!)) i++;
  return (
    bytes[i] === 115 &&
    bytes[i + 1] === 111 &&
    bytes[i + 2] === 108 &&
    bytes[i + 3] === 105 &&
    bytes[i + 4] === 100 &&
    (i + 5 === bytes.length || isSpace(bytes[i + 5]!))
  );
}

function headerHasColor(bytes: Uint8Array): boolean {
  // Magics-style STL colors use this fixed header marker.
  const marker = [67, 79, 76, 79, 82, 61];
  for (let i = 0; i + marker.length <= 80; i++) {
    if (marker.every((byte, j) => bytes[i + j] === byte)) return true;
  }
  return false;
}

function parseBinaryStl(bytes: Uint8Array): ParsedModel {
  if (bytes.byteLength < 84) return fail('invalid-data');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const facets = view.getUint32(80, true);
  checkCounts(facets, facets * 3);
  if (bytes.byteLength !== 84 + facets * 50 || facets === 0)
    return fail('invalid-data');
  const geometryBytes = facets * 9 * Float32Array.BYTES_PER_ELEMENT;
  checkedBuffers(bytes.byteLength, geometryBytes, 0);
  const positions = new Float32Array(facets * 9);
  const bounds = makeBounds();
  let output = 0;
  let color = headerHasColor(bytes);
  for (let face = 0; face < facets; face++) {
    let offset = 84 + face * 50;
    // Normals are ignored for neutral shading, but invalid numbers are not accepted.
    for (let axis = 0; axis < 3; axis++, offset += 4) {
      if (!Number.isFinite(view.getFloat32(offset, true))) fail('invalid-data');
    }
    for (let vertex = 0; vertex < 3; vertex++) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      offset += 12;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
        fail('invalid-data');
      output = putVertex(positions, output, bounds, x, y, z);
    }
    if (view.getUint16(offset, true) !== 0) color = true;
  }
  requireDrawableTriangle(positions);
  return { positions, bounds, warnings: color ? ['color-ignored'] : [] };
}

function scanAsciiStl(
  text: string,
  positions?: Float32Array,
  bounds?: ModelBounds
): number {
  const tokens = new Tokens(text);
  let facets = 0;
  let output = 0;
  let token = tokens.next();
  if (token !== 'solid') return fail('invalid-data');
  while (token !== null) {
    if (token !== 'solid') return fail('invalid-data');
    tokens.skipLine(); // A solid's optional name occupies the rest of its line.
    while (true) {
      token = tokens.next();
      if (token === 'endsolid') {
        tokens.skipLine();
        break;
      }
      if (token !== 'facet') return fail('invalid-data');
      facets++;
      checkCounts(facets, facets * 3);
      requireToken(tokens, 'normal');
      number(tokens.next());
      number(tokens.next());
      number(tokens.next());
      requireToken(tokens, 'outer');
      requireToken(tokens, 'loop');
      for (let vertex = 0; vertex < 3; vertex++) {
        requireToken(tokens, 'vertex');
        const x = position(number(tokens.next()));
        const y = position(number(tokens.next()));
        const z = position(number(tokens.next()));
        if (positions && bounds)
          output = putVertex(positions, output, bounds, x, y, z);
      }
      requireToken(tokens, 'endloop');
      requireToken(tokens, 'endfacet');
    }
    token = tokens.next();
  }
  if (facets === 0) return fail('invalid-data');
  return facets;
}

function parseStl(bytes: Uint8Array): ParsedModel {
  if (bytes.byteLength >= 84) {
    const facets = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).getUint32(80, true);
    // Exact size wins even if the arbitrary binary header starts with "solid".
    if (84 + facets * 50 === bytes.byteLength || hasBinaryControls(bytes)) {
      return parseBinaryStl(bytes);
    }
  }
  if (!startsWithSolid(bytes)) return fail('invalid-data');
  const text = decodeText(bytes);
  const facets = scanAsciiStl(text);
  const geometryBytes = facets * 9 * Float32Array.BYTES_PER_ELEMENT;
  checkedBuffers(bytes.byteLength, geometryBytes, 0);
  const positions = new Float32Array(facets * 9);
  const bounds = makeBounds();
  scanAsciiStl(text, positions, bounds);
  requireDrawableTriangle(positions);
  return { positions, bounds, warnings: [] };
}

interface ObjCounts {
  vertices: number;
  textures: number;
  normals: number;
  triangles: number;
}

function objVertex(tokens: Tokens): [number, number, number] {
  const x = number(tokens.next());
  const y = number(tokens.next());
  const z = number(tokens.next());
  const extra = tokens.next();
  if (extra === null)
    return [objCoordinate(x), objCoordinate(y), objCoordinate(z)];
  const first = number(extra);
  const next = tokens.next();
  if (next === null) {
    if (first === 0) return fail('invalid-data');
    return [
      objCoordinate(x / first),
      objCoordinate(y / first),
      objCoordinate(z / first),
    ];
  }
  // De facto vertex-color extensions use RGB or RGBA after xyz. Four values
  // alone are interpreted as the standard homogeneous coordinate above.
  number(next);
  number(tokens.next());
  const alpha = tokens.next();
  if (alpha !== null) number(alpha);
  requireEnd(tokens);
  return [objCoordinate(x), objCoordinate(y), objCoordinate(z)];
}

function objTexture(tokens: Tokens): void {
  number(tokens.next());
  const second = tokens.next();
  if (second === null) return;
  number(second);
  const third = tokens.next();
  if (third === null) return;
  number(third);
  requireEnd(tokens);
}

function objNormal(tokens: Tokens): void {
  number(tokens.next());
  number(tokens.next());
  number(tokens.next());
  requireEnd(tokens);
}

function index(token: string, total: number, seen: number): number {
  if (!INTEGER.test(token)) return fail('invalid-data');
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value === 0) return fail('invalid-data');
  const result = value > 0 ? value - 1 : seen + value;
  if (result < 0 || result >= (value > 0 ? total : seen))
    return fail('invalid-data');
  return result;
}

function objFaceVertex(
  token: string,
  total: ObjCounts,
  seen: ObjCounts
): number {
  const firstSlash = token.indexOf('/');
  if (firstSlash < 0) return index(token, total.vertices, seen.vertices);
  const secondSlash = token.indexOf('/', firstSlash + 1);
  const vertex = index(
    token.slice(0, firstSlash),
    total.vertices,
    seen.vertices
  );
  if (secondSlash < 0) {
    index(token.slice(firstSlash + 1), total.textures, seen.textures);
    return vertex;
  }
  if (token.indexOf('/', secondSlash + 1) >= 0) return fail('invalid-data');
  const texture = token.slice(firstSlash + 1, secondSlash);
  if (texture !== '') index(texture, total.textures, seen.textures);
  index(token.slice(secondSlash + 1), total.normals, seen.normals);
  return vertex;
}

function emptyCounts(): ObjCounts {
  return { vertices: 0, textures: 0, normals: 0, triangles: 0 };
}

function countObj(text: string): ObjCounts {
  const counts = emptyCounts();
  for (const line of lines(text)) {
    const tokens = lineTokens(line);
    const record = tokens.next();
    switch (record) {
      case null:
        break;
      case 'v':
        objVertex(tokens);
        checkCounts(counts.triangles, ++counts.vertices);
        break;
      case 'vt':
        objTexture(tokens);
        counts.textures++;
        break;
      case 'vn':
        objNormal(tokens);
        counts.normals++;
        break;
      case 'f': {
        let size = 0;
        while (tokens.next() !== null) {
          if (++size > MODEL_LIMITS.maxFaceVertices) fail('limit-exceeded');
        }
        if (size < 3) fail('invalid-data');
        counts.triangles += size - 2;
        checkCounts(counts.triangles, counts.vertices);
        break;
      }
      // Names and appearance are deliberately discarded, never interpreted as paths.
      case 'o':
      case 'g':
      case 's':
      case 'mtllib':
      case 'maplib':
      case 'usemap':
      case 'usemtl':
        break;
      // In particular p, l, vp and all free-form curve/surface records fail closed.
      default:
        fail('unsupported-geometry');
    }
  }
  if (counts.vertices === 0 || counts.triangles === 0)
    return fail('invalid-data');
  return counts;
}

function objPositions(text: string, count: number): Float64Array {
  const vertices = new Float64Array(count * 3);
  let offset = 0;
  for (const line of lines(text)) {
    const tokens = lineTokens(line);
    if (tokens.next() !== 'v') continue;
    const [x, y, z] = objVertex(tokens);
    vertices[offset++] = x;
    vertices[offset++] = y;
    vertices[offset++] = z;
  }
  return vertices;
}

const GEOMETRY_EPSILON = 1e-12;
// Projection uses double precision from the source, with a small tolerance for
// arithmetic noise rather than permitting Float32 rounding to hide warping.
const PLANAR_EPSILON = 1e-10;

function cross2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x: number,
  y: number
): boolean {
  return (
    x >= Math.min(ax, bx) - GEOMETRY_EPSILON &&
    x <= Math.max(ax, bx) + GEOMETRY_EPSILON &&
    y >= Math.min(ay, by) - GEOMETRY_EPSILON &&
    y <= Math.max(ay, by) + GEOMETRY_EPSILON
  );
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): boolean {
  const abC = cross2(ax, ay, bx, by, cx, cy);
  const abD = cross2(ax, ay, bx, by, dx, dy);
  const cdA = cross2(cx, cy, dx, dy, ax, ay);
  const cdB = cross2(cx, cy, dx, dy, bx, by);
  if (
    ((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
      (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))
  )
    return true;
  return (
    (Math.abs(abC) <= GEOMETRY_EPSILON && onSegment(ax, ay, bx, by, cx, cy)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && onSegment(ax, ay, bx, by, dx, dy)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && onSegment(cx, cy, dx, dy, ax, ay)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && onSegment(cx, cy, dx, dy, bx, by))
  );
}

interface FaceScratch {
  indices: Int32Array;
  x: Float64Array;
  y: Float64Array;
  prev: Int32Array;
  next: Int32Array;
}

const SCRATCH_BYTES =
  MODEL_LIMITS.maxFaceVertices *
  (Int32Array.BYTES_PER_ELEMENT * 3 + Float64Array.BYTES_PER_ELEMENT * 2);

function faceScratch(): FaceScratch {
  const size = MODEL_LIMITS.maxFaceVertices;
  return {
    indices: new Int32Array(size),
    x: new Float64Array(size),
    y: new Float64Array(size),
    prev: new Int32Array(size),
    next: new Int32Array(size),
  };
}

function putIndexedTriangle(
  source: Float64Array,
  indices: Int32Array,
  output: Float32Array,
  bounds: ModelBounds,
  offset: number,
  a: number,
  b: number,
  c: number
): number {
  const start = offset;
  let p = indices[a]! * 3;
  offset = putVertex(
    output,
    offset,
    bounds,
    source[p]!,
    source[p + 1]!,
    source[p + 2]!
  );
  p = indices[b]! * 3;
  offset = putVertex(
    output,
    offset,
    bounds,
    source[p]!,
    source[p + 1]!,
    source[p + 2]!
  );
  p = indices[c]! * 3;
  offset = putVertex(
    output,
    offset,
    bounds,
    source[p]!,
    source[p + 1]!,
    source[p + 2]!
  );
  // A valid source polygon must not silently collapse during Float32 transfer.
  if (!triangleHasArea(output, start)) fail('invalid-data');
  return offset;
}

function triangulateFace(
  size: number,
  source: Float64Array,
  scratch: FaceScratch,
  output: Float32Array,
  bounds: ModelBounds,
  outputOffset: number
): number {
  const { indices, x, y, prev, next } = scratch;
  const first = indices[0]! * 3;
  const ox = source[first]!;
  const oy = source[first + 1]!;
  const oz = source[first + 2]!;
  let scale = 0;
  for (let i = 1; i < size; i++) {
    const p = indices[i]! * 3;
    scale = Math.max(
      scale,
      Math.abs(source[p]! - ox),
      Math.abs(source[p + 1]! - oy),
      Math.abs(source[p + 2]! - oz)
    );
  }
  if (scale === 0) return fail('invalid-data');

  // Find a stable plane even for a self-intersecting ring whose signed normal cancels.
  let nx = 0,
    ny = 0,
    nz = 0,
    largest = 0;
  for (let i = 1; i + 1 < size; i++) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const ax = (source[a]! - ox) / scale,
      ay = (source[a + 1]! - oy) / scale,
      az = (source[a + 2]! - oz) / scale;
    const bx = (source[b]! - ox) / scale,
      by = (source[b + 1]! - oy) / scale,
      bz = (source[b + 2]! - oz) / scale;
    const cx = ay * bz - az * by,
      cy = az * bx - ax * bz,
      cz = ax * by - ay * bx;
    const length = cx * cx + cy * cy + cz * cz;
    if (length > largest) {
      largest = length;
      nx = cx;
      ny = cy;
      nz = cz;
    }
  }
  if (largest <= GEOMETRY_EPSILON * GEOMETRY_EPSILON)
    return fail('invalid-data');
  const normalLength = Math.sqrt(largest);
  nx /= normalLength;
  ny /= normalLength;
  nz /= normalLength;
  const drop =
    Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)
      ? 0
      : Math.abs(ny) >= Math.abs(nz)
        ? 1
        : 2;
  for (let i = 0; i < size; i++) {
    const p = indices[i]! * 3;
    const px = (source[p]! - ox) / scale,
      py = (source[p + 1]! - oy) / scale,
      pz = (source[p + 2]! - oz) / scale;
    if (Math.abs(px * nx + py * ny + pz * nz) > PLANAR_EPSILON)
      fail('non-planar-face');
    x[i] = drop === 0 ? py : px;
    y[i] = drop === 2 ? py : pz;
    prev[i] = (i + size - 1) % size;
    next[i] = (i + 1) % size;
  }

  for (let i = 0; i < size; i++) {
    const j = (i + 1) % size;
    const dx = x[i]! - x[j]!;
    const dy = y[i]! - y[j]!;
    if (dx * dx + dy * dy <= GEOMETRY_EPSILON * GEOMETRY_EPSILON)
      fail('invalid-data');
  }
  let area = 0;
  for (let i = 0; i < size; i++) {
    const j = (i + 1) % size;
    area += x[i]! * y[j]! - x[j]! * y[i]!;
    for (let k = i + 1; k < size; k++) {
      const l = (k + 1) % size;
      if (j === k || l === i) continue;
      if (
        segmentsIntersect(
          x[i]!,
          y[i]!,
          x[j]!,
          y[j]!,
          x[k]!,
          y[k]!,
          x[l]!,
          y[l]!
        )
      ) {
        fail('self-intersecting-face');
      }
    }
  }
  if (Math.abs(area) <= GEOMETRY_EPSILON) return fail('invalid-data');
  const winding = area > 0 ? 1 : -1;
  let remaining = size;
  let current = 0;
  let unsuccessful = 0;
  while (remaining > 3) {
    const a = prev[current]!,
      b = current,
      c = next[current]!;
    let ear =
      winding * cross2(x[a]!, y[a]!, x[b]!, y[b]!, x[c]!, y[c]!) >
      GEOMETRY_EPSILON;
    if (ear) {
      for (let point = next[c]!; point !== a; point = next[point]!) {
        if (
          winding * cross2(x[a]!, y[a]!, x[b]!, y[b]!, x[point]!, y[point]!) >=
            -GEOMETRY_EPSILON &&
          winding * cross2(x[b]!, y[b]!, x[c]!, y[c]!, x[point]!, y[point]!) >=
            -GEOMETRY_EPSILON &&
          winding * cross2(x[c]!, y[c]!, x[a]!, y[a]!, x[point]!, y[point]!) >=
            -GEOMETRY_EPSILON
        ) {
          ear = false;
          break;
        }
      }
    }
    if (ear) {
      outputOffset = putIndexedTriangle(
        source,
        indices,
        output,
        bounds,
        outputOffset,
        a,
        b,
        c
      );
      next[a] = c;
      prev[c] = a;
      remaining--;
      current = c;
      unsuccessful = 0;
    } else {
      current = c;
      if (++unsuccessful >= remaining) return fail('invalid-data');
    }
  }
  const a = current,
    b = next[a]!,
    c = next[b]!;
  if (
    winding * cross2(x[a]!, y[a]!, x[b]!, y[b]!, x[c]!, y[c]!) <=
    GEOMETRY_EPSILON
  ) {
    return fail('invalid-data');
  }
  outputOffset = putIndexedTriangle(
    source,
    indices,
    output,
    bounds,
    outputOffset,
    a,
    b,
    c
  );
  return outputOffset;
}

function parseObj(bytes: Uint8Array): ParsedModel {
  const text = decodeText(bytes);
  const counts = countObj(text);
  const geometryBytes = counts.triangles * 9 * Float32Array.BYTES_PER_ELEMENT;
  const sourceBytes = counts.vertices * 3 * Float64Array.BYTES_PER_ELEMENT;
  checkedBuffers(bytes.byteLength, geometryBytes, sourceBytes + SCRATCH_BYTES);
  const source = objPositions(text, counts.vertices);
  const positions = new Float32Array(counts.triangles * 9);
  const scratch = faceScratch();
  const bounds = makeBounds();
  const seen = emptyCounts();
  let offset = 0;
  for (const line of lines(text)) {
    const tokens = lineTokens(line);
    switch (tokens.next()) {
      case 'v':
        seen.vertices++;
        break;
      case 'vt':
        seen.textures++;
        break;
      case 'vn':
        seen.normals++;
        break;
      case 'f': {
        let size = 0;
        let token = tokens.next();
        while (token !== null) {
          // Recheck before writing, independently of the first pass.
          if (size >= MODEL_LIMITS.maxFaceVertices) fail('limit-exceeded');
          scratch.indices[size++] = objFaceVertex(token, counts, seen);
          token = tokens.next();
        }
        if (size < 3) fail('invalid-data');
        offset = triangulateFace(
          size,
          source,
          scratch,
          positions,
          bounds,
          offset
        );
        break;
      }
    }
  }
  if (offset !== positions.length) return fail('invalid-data');
  return { positions, bounds, warnings: ['geometry-only'] };
}

export function parseModel(
  format: ModelFormat,
  bytes: Uint8Array
): ParsedModel {
  try {
    if (format !== 'stl' && format !== 'obj') return fail('invalid-format');
    if (!(bytes instanceof Uint8Array)) return fail('invalid-data');
    if (bytes.byteLength > MODEL_LIMITS.maxBytes) return fail('limit-exceeded');
    return format === 'stl' ? parseStl(bytes) : parseObj(bytes);
  } catch (error) {
    if (error instanceof ModelParseError) throw error;
    return fail('internal-error');
  }
}
