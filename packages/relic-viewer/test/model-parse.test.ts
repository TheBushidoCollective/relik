import { describe, expect, test } from 'bun:test';
import {
  MODEL_LIMITS,
  ModelParseError,
  parseModel,
  type ModelErrorCode,
  type ModelFormat,
  type ModelParseResponse,
} from '../src/model-parse.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const OBJ_TRIANGLE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const STL_TRIANGLE = `solid one
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid one
`;

function expectCode(run: () => unknown, code: ModelErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelParseError);
    expect((error as ModelParseError).code).toBe(code);
    expect((error as ModelParseError).message).toBe(code);
    return;
  }
  throw new Error(`Expected parser refusal: ${code}`);
}

function binaryStl(header = 'model', attribute = 0): Uint8Array {
  const bytes = new Uint8Array(134);
  bytes.set(encode(header).subarray(0, 80));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  view.setFloat32(92, 1, true); // Normal z.
  view.setFloat32(108, 1, true); // Vertex 2 x.
  view.setFloat32(124, 1, true); // Vertex 3 y.
  view.setUint16(132, attribute, true);
  return bytes;
}

function triangleAreaXY(positions: Float32Array): number {
  let total = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]!,
      ay = positions[i + 1]!;
    const bx = positions[i + 3]!,
      by = positions[i + 4]!;
    const cx = positions[i + 6]!,
      cy = positions[i + 7]!;
    total += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return total;
}

describe('bounded STL parsing', () => {
  test('parses a binary STL even when its header starts with solid', () => {
    const model = parseModel('stl', binaryStl('solid not ASCII'));
    expect(Array.from(model.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(model.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    expect(model.warnings).toEqual([]);
  });

  test('omits binary color extensions with a fixed warning', () => {
    expect(parseModel('stl', binaryStl('model', 0x8001)).warnings).toEqual([
      'color-ignored',
    ]);
    expect(parseModel('stl', binaryStl('COLOR=rgba')).warnings).toEqual([
      'color-ignored',
    ]);
  });

  test('accepts BOM, whitespace, exponent notation and multiple ASCII solids', () => {
    const second = `solid two\n facet\tnormal +0 0 1e0\n outer loop\n vertex -2e0 0 0\n vertex 0 0 0\n vertex 0 .5 0\n endloop\n endfacet\nendsolid two\n`;
    const model = parseModel(
      'stl',
      encode(`\uFEFF${STL_TRIANGLE}\r\n${second}`)
    );
    expect(model.positions.length).toBe(18);
    expect(model.bounds).toEqual({ min: [-2, 0, 0], max: [1, 1, 0] });
    expect(triangleAreaXY(model.positions)).toBe(1);
  });

  test('rejects truncated, trailing and enormous binary records before using their counts', () => {
    const valid = binaryStl('solid binary');
    expectCode(
      () => parseModel('stl', valid.subarray(0, valid.length - 1)),
      'invalid-data'
    );
    const extra = new Uint8Array(valid.length + 1);
    extra.set(valid);
    expectCode(() => parseModel('stl', extra), 'invalid-data');
    const huge = new Uint8Array(84);
    new DataView(huge.buffer).setUint32(80, 0xffffffff, true);
    expectCode(() => parseModel('stl', huge), 'limit-exceeded');
    new DataView(huge.buffer).setUint32(
      80,
      Math.floor(MODEL_LIMITS.maxSourceVertices / 3) + 1,
      true
    );
    expectCode(() => parseModel('stl', huge), 'limit-exceeded');
  });

  test('rejects non-finite normals and coordinates in binary records', () => {
    for (const offset of [84, 96]) {
      const bytes = binaryStl();
      new DataView(bytes.buffer).setFloat32(offset, NaN, true);
      expectCode(() => parseModel('stl', bytes), 'invalid-data');
    }
  });

  test('rejects malformed ASCII records, non-finite numbers and a missing solid', () => {
    for (const text of [
      STL_TRIANGLE.replace('vertex 0 1 0\n', ''),
      STL_TRIANGLE.replace('endloop', 'vertex 2 2 2\nendloop'),
      STL_TRIANGLE.replace('endfacet', ''),
      STL_TRIANGLE.replace('endsolid one', ''),
      STL_TRIANGLE.replace('vertex 1 0 0', 'vertex NaN 0 0'),
      STL_TRIANGLE.replace('vertex 1 0 0', 'vertex 1e309 0 0'),
      STL_TRIANGLE.replace('vertex 1 0 0', 'vertex 1e39 0 0'),
      STL_TRIANGLE.replace('solid one', 'object one'),
    ])
      expectCode(() => parseModel('stl', encode(text)), 'invalid-data');
  });

  test('rejects all-degenerate STL while preserving degenerate facets in a mixed mesh', () => {
    const degenerate = STL_TRIANGLE.replace('vertex 0 1 0', 'vertex 2 0 0');
    expectCode(() => parseModel('stl', encode(degenerate)), 'invalid-data');
    const mixed = parseModel('stl', encode(`${degenerate}${STL_TRIANGLE}`));
    expect(mixed.positions.length).toBe(18);
    expect(triangleAreaXY(mixed.positions)).toBe(0.5);
  });
});

describe('bounded OBJ parsing', () => {
  test('accepts all face index forms, negative indices and ignored appearance without resolving paths', () => {
    const text = `\uFEFF# private model\r\nmtllib https://example.invalid/private.mtl\r\nusemtl ../secret\r\no name\ng group\ns 1\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0.5 0.5\nvn 0 0 1\nf 1 2 3\nf 1/1 2/1 3/1\nf -3//-1 -2//-1 -1//-1\nf 1/1/1 2/1/1 3/1/1 # ignored\n`;
    const model = parseModel('obj', encode(text));
    expect(model.positions.length).toBe(36);
    expect(Array.from(model.positions.subarray(0, 9))).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect(model.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    expect(model.warnings).toEqual(['geometry-only']);
    expect(
      JSON.stringify({ bounds: model.bounds, warnings: model.warnings })
    ).not.toContain('private');
  });

  test('resolves positive forward references and checks negative indices at the face', () => {
    const forward =
      'f 1/1/1 2/1/1 3/1/1\nvt 0 0\nvn 0 0 1\nv 0 0 0\nv 1 0 0\nv 0 1 0\n';
    expect(Array.from(parseModel('obj', encode(forward)).positions)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expectCode(
      () => parseModel('obj', encode(`f -3 -2 -1\n${OBJ_TRIANGLE}`)),
      'invalid-data'
    );
  });

  test('applies homogeneous coordinates and ignores vertex colors', () => {
    const text = 'v 2 0 0 2\nv 0 2 0 2\nv 0 0 0 1 0 0\nf 1 2 3\n';
    const model = parseModel('obj', encode(text));
    expect(Array.from(model.positions)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(model.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    const rgba = parseModel(
      'obj',
      encode(
        'v 0 0 0 .2 .3 .4 .5\nv 1 0 0 .2 .3 .4 .5\nv 0 1 0 .2 .3 .4 .5\nf 1 2 3\n'
      )
    );
    expect(Array.from(rgba.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const ignoredMaps = parseModel(
      'obj',
      encode(
        `maplib https://example.invalid/map\nusemap data:image/png;base64,AAA\n${OBJ_TRIANGLE}`
      )
    );
    expect(ignoredMaps.warnings).toEqual(['geometry-only']);
    expectCode(
      () => parseModel('obj', encode('v 1 2 3 0\nv 0 0 0\nv 0 1 0\nf 1 2 3')),
      'invalid-data'
    );
  });

  test('triangulates concave planar polygons in either winding without covering the notch', () => {
    const vertices = 'v 0 0 0\nv 2 0 0\nv 2 2 0\nv 1 1 0\nv 0 2 0\n';
    for (const face of ['f 1 2 3 4 5\n', 'f 5 4 3 2 1\n']) {
      const model = parseModel('obj', encode(vertices + face));
      expect(model.positions.length).toBe(27);
      expect(triangleAreaXY(model.positions)).toBeCloseTo(3, 6);
      expect(model.bounds).toEqual({ min: [0, 0, 0], max: [2, 2, 0] });
    }
  });

  test('supports a simple polygon with a collinear boundary vertex', () => {
    const model = parseModel(
      'obj',
      encode('v 0 0 0\nv 1 0 0\nv 2 0 0\nv 2 1 0\nv 0 1 0\nf 1 2 3 4 5\n')
    );
    expect(model.positions.length).toBe(27);
    expect(triangleAreaXY(model.positions)).toBeCloseTo(2, 6);
  });

  test('projects polygons on their dominant plane instead of assuming XY', () => {
    const model = parseModel(
      'obj',
      encode('v 0 0 0\nv 0 1 0\nv 0 1 1\nv 0 0 1\nf 1 2 3 4\n')
    );
    expect(model.positions.length).toBe(18);
    expect(model.bounds).toEqual({ min: [0, 0, 0], max: [0, 1, 1] });
  });

  test('refuses self-intersection, repeated corners and non-planarity', () => {
    const bowTie = 'v 0 0 0\nv 2 2 0\nv 0 2 0\nv 2 0 0\nf 1 2 3 4\n';
    expectCode(
      () => parseModel('obj', encode(bowTie)),
      'self-intersecting-face'
    );
    const nonplanar = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0.0000001\nf 1 2 3 4\n';
    expectCode(() => parseModel('obj', encode(nonplanar)), 'non-planar-face');
    expectCode(
      () => parseModel('obj', encode('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 2 3')),
      'invalid-data'
    );
  });

  test('refuses invalid references, malformed numbers and Float32 collapse', () => {
    for (const face of [
      'f 0 2 3',
      'f 1 2 4',
      'f -4 -2 -1',
      'f 1/1 2/1 3/1',
      'f 1//1 2//1 3//1',
      'f 1/ 2/ 3/',
      'f 1/1/ 2/1/ 3/1/',
      'f 1.0 2 3',
      'f 1 2',
    ]) {
      expectCode(
        () => parseModel('obj', encode(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${face}\n`)),
        'invalid-data'
      );
    }
    for (const value of ['NaN', 'Infinity', '0x1', '1e309', '1e39']) {
      expectCode(
        () =>
          parseModel(
            'obj',
            encode(`v ${value} 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`)
          ),
        'invalid-data'
      );
    }
    const collapsed =
      'v 100000000 0 0\nv 100000001 0 0\nv 100000000 1 0\nf 1 2 3\n';
    expectCode(() => parseModel('obj', encode(collapsed)), 'invalid-data');
    expectCode(
      () => parseModel('obj', encode(`${OBJ_TRIANGLE}vt NaN\n`)),
      'invalid-data'
    );
    expectCode(
      () => parseModel('obj', encode(`${OBJ_TRIANGLE}vn 0 0 Infinity\n`)),
      'invalid-data'
    );
    expectCode(
      () =>
        parseModel(
          'obj',
          encode(`${OBJ_TRIANGLE}vt 0\nvn 0 0 1\nf 1/-2/-1 2/-1/-1 3/-1/-1\n`)
        ),
      'invalid-data'
    );
  });

  test('refuses unsupported geometry instead of silently dropping it', () => {
    for (const record of [
      'l 1 2',
      'p 1',
      'vp 0 0',
      'curv 0 1 1 2',
      'surf 0 1 0 1 1 2 3',
      'csh https://example.invalid/run',
    ]) {
      expectCode(
        () => parseModel('obj', encode(`${OBJ_TRIANGLE}${record}\n`)),
        'unsupported-geometry'
      );
    }
  });
});

describe('shared security and resource boundaries', () => {
  test('rejects unsupported formats and invalid UTF-8 without exposing source', () => {
    expectCode(
      () => parseModel('gltf' as ModelFormat, encode(OBJ_TRIANGLE)),
      'invalid-format'
    );
    const bytes = new Uint8Array([...encode(OBJ_TRIANGLE), 0xc0, 0xaf]);
    expectCode(() => parseModel('obj', bytes), 'invalid-data');
    const ascii = new Uint8Array([...encode(STL_TRIANGLE), 0xc0, 0xaf]);
    expectCode(() => parseModel('stl', ascii), 'invalid-data');
    expectCode(
      () => parseModel('obj', encode('v PRIVATE_CONTENT 0 0\n')),
      'invalid-data'
    );
  });

  test('accepts the maximum text line and refuses a longer line in source bytes', () => {
    const atLimit = `#${'x'.repeat(MODEL_LIMITS.maxLineBytes - 1)}\n${OBJ_TRIANGLE}`;
    expect(parseModel('obj', encode(atLimit)).positions.length).toBe(9);
    const stlAtLimit = STL_TRIANGLE.replace(
      'solid one',
      `solid ${'x'.repeat(MODEL_LIMITS.maxLineBytes - 6)}`
    );
    expect(parseModel('stl', encode(stlAtLimit)).positions.length).toBe(9);
    const tooLong = `#${'x'.repeat(MODEL_LIMITS.maxLineBytes)}\n${OBJ_TRIANGLE}`;
    expectCode(() => parseModel('obj', encode(tooLong)), 'limit-exceeded');
    const longSolidName = `solid ${'x'.repeat(MODEL_LIMITS.maxLineBytes)}\n${STL_TRIANGLE}`;
    expectCode(
      () => parseModel('stl', encode(longSolidName)),
      'limit-exceeded'
    );
    const multiByte = `#${'é'.repeat(MODEL_LIMITS.maxLineBytes / 2)}\n${OBJ_TRIANGLE}`;
    expectCode(() => parseModel('obj', encode(multiByte)), 'limit-exceeded');
  });

  test('enforces input bytes, OBJ source vertices, face size and triangle count', () => {
    for (const format of ['stl', 'obj'] as const) {
      expectCode(
        () => parseModel(format, new Uint8Array(MODEL_LIMITS.maxBytes + 1)),
        'limit-exceeded'
      );
    }
    const excessVertices = `${'v 0 0 0\n'.repeat(MODEL_LIMITS.maxSourceVertices + 1)}f 1 2 3\n`;
    expectCode(
      () => parseModel('obj', encode(excessVertices)),
      'limit-exceeded'
    );
    const excessFace = `${OBJ_TRIANGLE}f ${'1 '.repeat(MODEL_LIMITS.maxFaceVertices + 1)}\n`;
    expectCode(() => parseModel('obj', encode(excessFace)), 'limit-exceeded');
    const excessTriangles = `${OBJ_TRIANGLE}${'f 1 2 3\n'.repeat(MODEL_LIMITS.maxTriangles)}\n`;
    expectCode(
      () => parseModel('obj', encode(excessTriangles)),
      'limit-exceeded'
    );
  });

  test('triangulates a face at the vertex limit', () => {
    let vertices = '';
    let indices = '';
    for (let i = 0; i < MODEL_LIMITS.maxFaceVertices; i++) {
      const angle = (2 * Math.PI * i) / MODEL_LIMITS.maxFaceVertices;
      vertices += `v ${Math.cos(angle)} ${Math.sin(angle)} 0\n`;
      indices += `${i + 1} `;
    }
    const model = parseModel('obj', encode(`${vertices}f ${indices}\n`));
    expect(model.positions.length).toBe((MODEL_LIMITS.maxFaceVertices - 2) * 9);
    expect(triangleAreaXY(model.positions)).toBeCloseTo(Math.PI, 3);
  });

  test('the other numeric buffers fit inside their independent budgets at all count limits', () => {
    const retained =
      MODEL_LIMITS.maxTriangles * 9 * Float32Array.BYTES_PER_ELEMENT;
    const source =
      MODEL_LIMITS.maxSourceVertices * 3 * Float64Array.BYTES_PER_ELEMENT;
    const scratch =
      MODEL_LIMITS.maxFaceVertices *
      (3 * Int32Array.BYTES_PER_ELEMENT + 2 * Float64Array.BYTES_PER_ELEMENT);
    expect(retained).toBeLessThan(MODEL_LIMITS.maxGeometryBytes);
    expect(MODEL_LIMITS.maxBytes + retained + source + scratch).toBeLessThan(
      MODEL_LIMITS.maxNumericBytes
    );
  });
});

async function workerReply(
  format: ModelFormat,
  bytes: Uint8Array
): Promise<ModelParseResponse> {
  const worker = new Worker(
    new URL('../src/model-parse-worker.ts', import.meta.url),
    { type: 'module' }
  );
  const input = new Uint8Array(bytes).buffer;
  const { promise, resolve, reject } =
    Promise.withResolvers<ModelParseResponse>();
  worker.onmessage = (event: MessageEvent<ModelParseResponse>) =>
    resolve(event.data);
  worker.onerror = (event) => reject(new Error(event.message));
  try {
    worker.postMessage({ type: 'parse', id: 73, format, bytes: input }, [
      input,
    ]);
    expect(input.byteLength).toBe(0);
    return await promise;
  } finally {
    worker.terminate();
  }
}

describe('parser worker protocol', () => {
  test('transfers validated geometry while preserving the original input', async () => {
    const original = encode(OBJ_TRIANGLE);
    const response = await workerReply('obj', original);
    expect(response.type).toBe('result');
    expect(response.id).toBe(73);
    if (!response.ok) throw new Error(`Unexpected refusal: ${response.error}`);
    expect(response.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(response.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(response.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    expect(response.warnings).toEqual(['geometry-only']);
    expect(new TextDecoder().decode(original)).toBe(OBJ_TRIANGLE);
  });

  test('returns only fixed errors instead of source content', async () => {
    const response = await workerReply(
      'obj',
      encode('v SECRET_MODEL_DATA 0 0\n')
    );
    expect(response).toEqual({
      type: 'result',
      id: 73,
      ok: false,
      error: 'invalid-data',
    });
  });
});
