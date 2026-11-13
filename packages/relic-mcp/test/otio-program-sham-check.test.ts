import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  shamPrimerSource,
  verifySourceTransform,
} from '../../relic-viewer/test/otio-program-emit-instrument.ts';
import {
  diffBundles,
  pairChunks,
  tamperOneByte,
  verifyShamControls,
  verifyShamSites,
} from './otio-program-sham-check.ts';

const enc = (text: string) => new TextEncoder().encode(text);

function bundle(files: Record<string, string>): Map<string, Uint8Array> {
  return new Map(
    Object.entries(files).map(([name, text]) => [name, enc(text)])
  );
}

/*
 * Fixtures follow the real build's shape: main.js lists its own id and its chunks' hashes in an
 * id array, and references its chunks. Production: chunk B holds the primer mute site. The sham is
 * the same graph under different hashes, with the mute flipped in B only.
 */
const PRODUCTION = bundle({
  'main.js':
    'var m=1;Ze(import.meta.url,["MMMMMMMM","AAAAAAAA","BBBBBBBB"]);import("./chunk-AAAAAAAA.js");import("./chunk-BBBBBBBB.js");',
  'chunk-AAAAAAAA.js': 'alpha=1;',
  'chunk-BBBBBBBB.js': 'beta=2;y.muted=!1;',
});
const SHAM = bundle({
  'main.js':
    'var m=1;Ze(import.meta.url,["NNNNNNNN","CCCCCCCC","DDDDDDDD"]);import("./chunk-CCCCCCCC.js");import("./chunk-DDDDDDDD.js");',
  'chunk-CCCCCCCC.js': 'alpha=1;',
  'chunk-DDDDDDDD.js': 'beta=2;y.muted=!0;',
});

describe('chunk pairing by graph topology', () => {
  test('two chunks pair by reference order, never by name', () => {
    const pairing = pairChunks(PRODUCTION, SHAM);
    expect(pairing.structural).toEqual([]);
    expect(pairing.toProduction.get('chunk-CCCCCCCC.js')).toBe(
      'chunk-AAAAAAAA.js'
    );
    expect(pairing.toProduction.get('chunk-DDDDDDDD.js')).toBe(
      'chunk-BBBBBBBB.js'
    );
  });

  test('the pairing is one-to-one in both directions', () => {
    const pairing = pairChunks(PRODUCTION, SHAM);
    expect(pairing.toProduction.size).toBe(PRODUCTION.size);
    expect(pairing.toSham.size).toBe(SHAM.size);
    for (const [sham, production] of pairing.toProduction)
      expect(pairing.toSham.get(production)).toBe(sham);
  });

  test('a graph with several chunks passes when only the mute differs', () => {
    expect(diffBundles(PRODUCTION, SHAM).structural).toEqual([]);
    expect(diffBundles(PRODUCTION, SHAM).sites.length).toBe(1);
    expect(verifyShamSites(PRODUCTION, SHAM)).toEqual([]);
    expect(verifyShamControls(PRODUCTION, SHAM)).toEqual([]);
  });

  test('the one site is in the chunk that holds the mute, named by production', () => {
    const [site] = diffBundles(PRODUCTION, SHAM).sites;
    expect(site!.file).toBe('chunk-BBBBBBBB.js');
    expect(site!.production).toBe('1');
    expect(site!.sham).toBe('0');
  });

  test('a sham whose chunks carry swapped content is rejected, not paired by name', () => {
    const swapped = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["NNNNNNNN","CCCCCCCC","DDDDDDDD"]);import("./chunk-CCCCCCCC.js");import("./chunk-DDDDDDDD.js");',
      'chunk-CCCCCCCC.js': 'beta=2;y.muted=!0;',
      'chunk-DDDDDDDD.js': 'alpha=1;',
    });
    expect(verifyShamSites(PRODUCTION, swapped).length).toBeGreaterThan(0);
  });

  test('a sham with a different reference count is a structural failure', () => {
    const fewer = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["NNNNNNNN","CCCCCCCC"]);import("./chunk-CCCCCCCC.js");',
      'chunk-CCCCCCCC.js': 'alpha=1;',
    });
    const pairing = pairChunks(PRODUCTION, fewer);
    expect(
      pairing.structural.some((f) => f.includes('references 1 file(s)'))
    ).toBe(true);
  });

  test('a production chunk the entry never reaches is a structural failure', () => {
    const orphan = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["MMMMMMMM","AAAAAAAA"]);import("./chunk-AAAAAAAA.js");',
      'chunk-AAAAAAAA.js': 'alpha=1;',
      'chunk-ZZZZZZZZ.js': 'unused=0;',
    });
    const sham = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["NNNNNNNN","CCCCCCCC"]);import("./chunk-CCCCCCCC.js");',
      'chunk-CCCCCCCC.js': 'alpha=1;',
    });
    expect(
      pairChunks(orphan, sham).structural.some((f) => f.includes('not reached'))
    ).toBe(true);
  });

  test('a rename of a hashed chunk and entry id alone is not a difference', () => {
    const renamed = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["NNNNNNNN","EEEEEEEE"]);import("./chunk-EEEEEEEE.js");',
      'chunk-EEEEEEEE.js': 'alpha=1;',
    });
    const original = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["MMMMMMMM","AAAAAAAA"]);import("./chunk-AAAAAAAA.js");',
      'chunk-AAAAAAAA.js': 'alpha=1;',
    });
    const diff = diffBundles(original, renamed);
    expect(diff.structural).toEqual([]);
    expect(diff.sites).toEqual([]);
  });

  test('an entry with no id array on one side is a structural failure', () => {
    const noIds = bundle({
      'main.js':
        'var m=1;import("./chunk-CCCCCCCC.js");import("./chunk-DDDDDDDD.js");',
      'chunk-CCCCCCCC.js': 'alpha=1;',
      'chunk-DDDDDDDD.js': 'beta=2;y.muted=!0;',
    });
    expect(
      diffBundles(PRODUCTION, noIds).structural.some((f) =>
        f.includes('no entry id array')
      )
    ).toBe(true);
  });

  test('a hash that pairs with two partners is a conflict, not silently accepted', () => {
    // The sham's entry id reuses a chunk hash for itself, so the same token would pair twice.
    const clash = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["CCCCCCCC","CCCCCCCC","DDDDDDDD"]);import("./chunk-CCCCCCCC.js");import("./chunk-DDDDDDDD.js");',
      'chunk-CCCCCCCC.js': 'alpha=1;',
      'chunk-DDDDDDDD.js': 'beta=2;y.muted=!0;',
    });
    expect(diffBundles(PRODUCTION, clash).structural.length).toBeGreaterThan(0);
  });
});

describe('sham bundle diff', () => {
  test('two flips are rejected: the sham must differ in exactly one place', () => {
    const sham = bundle({
      'main.js':
        'var m=2;Ze(import.meta.url,["NNNNNNNN","CCCCCCCC","DDDDDDDD"]);import("./chunk-CCCCCCCC.js");import("./chunk-DDDDDDDD.js");',
      'chunk-CCCCCCCC.js': 'alpha=1;',
      'chunk-DDDDDDDD.js': 'beta=2;y.muted=!0;',
    });
    const failures = verifyShamSites(PRODUCTION, sham);
    expect(failures.some((f) => f.includes('expected exactly 1'))).toBe(true);
  });

  test('a flip that is not the primer mute is rejected', () => {
    const sham = bundle({
      'main.js':
        'var m=1;Ze(import.meta.url,["NNNNNNNN","CCCCCCCC","DDDDDDDD"]);import("./chunk-CCCCCCCC.js");import("./chunk-DDDDDDDD.js");',
      'chunk-CCCCCCCC.js': 'alpha=1;',
      'chunk-DDDDDDDD.js': 'beta=3;y.muted=!1;',
    });
    expect(
      verifyShamSites(PRODUCTION, sham).some((f) =>
        f.includes('not the primer mute')
      )
    ).toBe(true);
  });
});

describe('sham negative controls', () => {
  test('a one-byte tamper of either side is rejected', () => {
    expect(
      verifyShamSites(PRODUCTION, tamperOneByte(PRODUCTION, 'main.js', 0))
        .length
    ).toBeGreaterThan(0);
    expect(
      verifyShamSites(PRODUCTION, tamperOneByte(SHAM, 'main.js', 0)).length
    ).toBeGreaterThan(0);
  });

  test('production compared with itself is not a sham', () => {
    expect(verifyShamSites(PRODUCTION, PRODUCTION).length).toBeGreaterThan(0);
  });

  test('tamperOneByte changes only the copy, never the original', () => {
    const before = Buffer.from(PRODUCTION.get('main.js')!).toString('latin1');
    tamperOneByte(PRODUCTION, 'main.js', 0);
    expect(Buffer.from(PRODUCTION.get('main.js')!).toString('latin1')).toBe(
      before
    );
  });
});

describe('entry alias viewer.js', () => {
  const withViewer = (
    base: Map<string, Uint8Array>
  ): Map<string, Uint8Array> => {
    const out = new Map(base);
    out.set('viewer.js', new Uint8Array(base.get('main.js')!));
    return out;
  };

  test('a viewer.js byte-identical to main.js on both sides passes with the one site', () => {
    const production = withViewer(PRODUCTION);
    const sham = withViewer(SHAM);
    expect(verifyShamSites(production, sham)).toEqual([]);
    expect(verifyShamControls(production, sham)).toEqual([]);
    expect(diffBundles(production, sham).sites.length).toBe(1);
  });

  test('a viewer.js that is not reached and differs from main.js is still a failure', () => {
    const production = new Map(PRODUCTION);
    production.set('viewer.js', enc('stale=1;'));
    const sham = withViewer(SHAM);
    expect(
      verifyShamSites(production, sham).some((f) => f.includes('viewer.js'))
    ).toBe(true);
  });

  test('a sham viewer.js that is stale production bytes is rejected, not aliased', () => {
    const production = withViewer(PRODUCTION);
    const sham = new Map(SHAM);
    sham.set('viewer.js', new Uint8Array(PRODUCTION.get('main.js')!));
    expect(
      verifyShamSites(production, sham).some((f) =>
        f.includes('byte-identical alias of main.js in only one build')
      )
    ).toBe(true);
  });
});

describe('source transform', () => {
  const sourcePath = join(
    import.meta.dir,
    '../../relic-viewer/src/otio-audio-output.ts'
  );

  test('the real module transforms to exactly one changed line, the primer mute', async () => {
    const original = await readFile(sourcePath, 'utf8');
    const transformed = shamPrimerSource(original);
    expect(() => verifySourceTransform(original, transformed)).not.toThrow();
    const before = original.split('\n');
    const after = transformed.split('\n');
    expect(after.length).toBe(before.length);
    expect(before.filter((line, i) => line !== after[i]).length).toBe(1);
  });

  test('a transform that also changes another line is rejected', async () => {
    const original = await readFile(sourcePath, 'utf8');
    const transformed = shamPrimerSource(original).replace(
      'element.volume = 1;',
      'element.volume = 0;'
    );
    expect(() => verifySourceTransform(original, transformed)).toThrow(
      'changed 2 line(s)'
    );
  });

  test('a source with no primer mute line is rejected, not passed through', () => {
    expect(() => shamPrimerSource('const x = 1;\n')).toThrow('occurs 0 times');
  });

  test('a source with two primer mute lines is rejected', () => {
    const line = '    element.muted = false;\n';
    expect(() => shamPrimerSource(line + line)).toThrow('occurs 2 times');
  });
});
