import { describe, expect, test } from 'bun:test';
import { deriveRendererClass, modelFormatFromFilename } from '@relic/format';
import { routeFor } from '../src/viewer.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const obj = bytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const stl = bytes(
  'solid piece\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\n endfacet\nendsolid piece\n'
);

describe('model routing', () => {
  test('renders recognized models and legacy generic declarations', async () => {
    expect((await routeFor('mesh.obj', 'text/plain', obj)).route).toBe('model');
    expect(
      (await routeFor('mesh.stl', 'application/octet-stream', stl)).route
    ).toBe('model');
    expect(
      (await routeFor('mesh', 'application/octet-stream', obj)).route
    ).toBe('model');
    expect(deriveRendererClass(obj, 'mesh')).toBe('model');
    expect(modelFormatFromFilename('obj')).toBeUndefined();
  });
  test('downloads conflicting names, MIME and markup instead of rendering them', async () => {
    expect((await routeFor('mesh.stl', 'model/stl', obj)).route).toBe(
      'download'
    );
    expect((await routeFor('mesh.obj', 'model/stl', obj)).route).toBe(
      'download'
    );
    expect((await routeFor('mesh.obj', 'image/png', obj)).route).toBe(
      'download'
    );
    expect(
      (await routeFor('mesh.png', 'application/octet-stream', obj)).route
    ).toBe('download');
    expect(
      (
        await routeFor(
          'mesh.obj',
          'model/obj',
          bytes('<script>alert(1)</script>')
        )
      ).route
    ).toBe('download');
  });
});
