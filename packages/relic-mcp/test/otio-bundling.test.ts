import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { indexOtioZip } from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import {
  buildZipArchive,
  bundleOtiod,
  MAX_ZIP_ENTRY_COUNT,
} from '../src/otio-bundle.ts';
import {
  type ConfinedBundleFile,
  type PublishDeps,
  PublishError,
  publish,
} from '../src/publish.ts';
import { republish } from '../src/republish.ts';

const SERVICE = 'https://relic.example';
const runFile = promisify(execFile);


let scratch: string;
let deps: PublishDeps;

beforeEach(async () => {
  scratch = await mkdtemp(
    join(await realpath(tmpdir()), 'relic-otio-bundling-')
  );
  process.env['RELIC_PUBLISH_STATE'] = join(
    scratch,
    'state',
    'publish-state.json'
  );
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: grantFetch(),
    clientName: 'relic-mcp/otio-bundling-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
});

function grantFetch(calls?: string[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    calls?.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'test-challenge',
        size_limit_bytes: 10_000_000,
        size_basis: 'plaintext',
      });
    }
    if (url.pathname === '/api/grant') return Response.json(grant('first'));
    if (url.pathname.endsWith('/republish')) {
      return Response.json(grant('next'));
    }
    if (url.pathname.endsWith('/complete')) return Response.json({});
    if (url.pathname.endsWith('/comments')) return Response.json([]);
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

function grant(version: string): Record<string, unknown> {
  return {
    publish_token: 'publish-token-held-only-in-local-state',
    upload_url: `https://storage.invalid/upload/${version}`,
    relic_expires_at: null,
    report_url: `${SERVICE}/abuse`,
    disclosure_url: `${SERVICE}/disclosure`,
  };
}

describe('OTIO bundling', () => {
  test('bundles .otiod directory into deterministic official .otioz archive', async () => {
    const dir = join(scratch, 'film.otiod');
    await mkdir(join(dir, 'media'), { recursive: true });

    const contentOtio = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Test Timeline',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Video',
            children: [
              {
                OTIO_SCHEMA: 'Clip.2',
                name: 'Clip A',
                media_references: {
                  DEFAULT_MEDIA: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/video1.mp4',
                  },
                  INACTIVE: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/video2.mp4',
                  },
                },
                active_media_reference_key: 'DEFAULT_MEDIA',
              },
              {
                OTIO_SCHEMA: 'Clip.1',
                name: 'Sequence',
                media_reference: {
                  OTIO_SCHEMA: 'ImageSequenceReference.1',
                  target_url_base: 'media/seq/',
                  name_prefix: 'frame.',
                  name_suffix: '.png',
                  start_frame: 1,
                  frame_step: 1,
                  rate: 24,
                  frame_zero_padding: 4,
                  available_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    duration: {
                      OTIO_SCHEMA: 'RationalTime.1',
                      value: 2,
                      rate: 24,
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify(contentOtio, null, 2)
    );
    await writeFile(join(dir, 'media', 'video1.mp4'), 'video1-bytes');
    await writeFile(join(dir, 'media', 'video2.mp4'), 'video2-bytes');
    await mkdir(join(dir, 'media', 'seq'), { recursive: true });
    await writeFile(join(dir, 'media', 'seq', 'frame.0001.png'), 'frame1');
    await writeFile(join(dir, 'media', 'seq', 'frame.0002.png'), 'frame2');
    // Unreferenced file must be ignored
    await writeFile(join(dir, 'media', 'unreferenced.txt'), 'ignore me');

    const first = await bundleOtiod(dir, nodeFiles);
    const second = await bundleOtiod(dir, nodeFiles);

    // Deterministic archive bytes
    expect(first.bytes).toEqual(second.bytes);
    expect(first.defaultFilename).toBe('film.otioz');
    expect(first.resolvedPath).toBe(dir);

    // Validate with official indexer
    const indexed = await indexOtioZip(first.bytes, {
      inflater: async (compressed) => {
        return new Uint8Array(inflateRawSync(compressed));
      },
    });

    expect(indexed.versionText).toBe('1.0.0');
    expect(indexed.entries.has('content.otio')).toBe(true);
    expect(indexed.entries.has('version.txt')).toBe(true);
    expect(indexed.entries.has('media/video1.mp4')).toBe(true);
    expect(indexed.entries.has('media/video2.mp4')).toBe(true);
    expect(indexed.entries.has('media/seq/frame.0001.png')).toBe(true);
    expect(indexed.entries.has('media/seq/frame.0002.png')).toBe(true);
    expect(indexed.entries.has('media/unreferenced.txt')).toBe(false);

    // Verify content.otio bytes are unchanged
    const contentBytes = await indexed.readEntry('content.otio');
    expect(new TextDecoder().decode(contentBytes)).toBe(
      JSON.stringify(contentOtio, null, 2)
    );
  });

  test('marks Unicode media paths as UTF-8 for standard ZIP readers', async () => {
    const entryName = 'media/café-日本語.mov';
    const data = new TextEncoder().encode('unicode media bytes');
    const archive = buildZipArchive([{ name: entryName, data, method: 0 }]);
    const archivePath = join(scratch, 'unicode-names.otioz');
    await writeFile(archivePath, archive);

    // Check the wire flags and Python's independent Unicode-aware ZIP reader.
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength
    );
    const nameBytes = new TextEncoder().encode(entryName);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(archive.slice(30, 30 + nameBytes.length)).toEqual(nameBytes);

    const centralOffset = 30 + nameBytes.length + data.length;
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint16(centralOffset + 8, true) & 0x0800).toBe(0x0800);
    expect(
      archive.slice(
        centralOffset + 46,
        centralOffset + 46 + nameBytes.length
      )
    ).toEqual(nameBytes);

    const decoded = await runFile('python3', [
      '-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"names":z.namelist(),"content":z.read(sys.argv[2]).decode("utf-8")}))',
      archivePath,
      entryName,
    ]);
    const result = JSON.parse(String(decoded.stdout));
    expect(result.names).toContain(entryName);
    expect(result.content).toBe('unicode media bytes');
  });

  test('rejects path traversal and out-of-root reads', async () => {
    const dir = join(scratch, 'evil.otiod');
    await mkdir(dir, { recursive: true });

    const contentOtio = {
      OTIO_SCHEMA: 'Timeline.1',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: '../secret.txt',
                },
              },
            ],
          },
        ],
      },
    };

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify(contentOtio, null, 2)
    );
    await writeFile(join(scratch, 'secret.txt'), 'secret');

    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);
    try {
      await bundleOtiod(dir, nodeFiles);
    } catch (err) {
      expect((err as PublishError).code).toBe('otio_bundle_invalid');
      expect((err as Error).message).toContain('Path traversal');
    }
  });

  test('rejects symlinks', async () => {
    const dir = join(scratch, 'symlink.otiod');
    await mkdir(join(dir, 'media'), { recursive: true });

    const contentOtio = {
      OTIO_SCHEMA: 'Timeline.1',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: 'media/link.mp4',
                },
              },
            ],
          },
        ],
      },
    };

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify(contentOtio, null, 2)
    );
    await writeFile(join(scratch, 'real.mp4'), 'real-bytes');
    await symlink(join(scratch, 'real.mp4'), join(dir, 'media', 'link.mp4'));

    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);
  });

  test('rejects remote URL schemes', async () => {
    const dir = join(scratch, 'remote.otiod');
    await mkdir(dir, { recursive: true });

    const contentOtio = {
      OTIO_SCHEMA: 'Timeline.1',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: 'https://evil.com/video.mp4',
                },
              },
            ],
          },
        ],
      },
    };

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify(contentOtio, null, 2)
    );

    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);
    try {
      await bundleOtiod(dir, nodeFiles);
    } catch (err) {
      expect((err as PublishError).code).toBe('otio_bundle_invalid');
      expect((err as Error).message).toContain('Prohibited URL scheme');
    }
  });

  test('publish and republish .otiod directory', async () => {
    const dir = join(scratch, 'publish.otiod');
    await mkdir(join(dir, 'media'), { recursive: true });

    const contentOtio = {
      OTIO_SCHEMA: 'Timeline.1',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: 'media/video.mp4',
                },
              },
            ],
          },
        ],
      },
    };

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify(contentOtio, null, 2)
    );
    await writeFile(join(dir, 'media', 'video.mp4'), 'video-bytes');

    const published = await publish({ path: dir }, deps);
    expect(published.filename).toBe('publish.otioz');
    expect(published.renderer_class).toBe('otio');
    expect(published.resolved_path).toBe(dir);

    // Unchanged republish refuses
    await expect(
      republish({ relic_id: published.relic_id, path: dir }, deps)
    ).rejects.toThrow(PublishError);
    try {
      await republish({ relic_id: published.relic_id, path: dir }, deps);
    } catch (err) {
      expect((err as PublishError).code).toBe('duplicate_version');
    }

    // Changed media republishes successfully
    await writeFile(join(dir, 'media', 'video.mp4'), 'video-bytes-changed');
    const updated = await republish(
      { relic_id: published.relic_id, path: dir },
      deps
    );
    expect(updated.version).toBe(2);
    expect(updated.filename).toBe('publish.otioz');
  });
  test('walks only structural edges and preserves active, inactive, nested, and signed stepped media', async () => {
    const dir = join(scratch, 'structural.otiod');
    await mkdir(join(dir, 'media', 'sequence'), { recursive: true });
    const contentOtio = {
      OTIO_SCHEMA: 'Timeline.1',
      metadata: {
        fake_asset: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: 'media/never-opened.mp4',
        },
      },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'SerializableCollection.1',
            children: [
              {
                OTIO_SCHEMA: 'Track.1',
                children: [
                  {
                    OTIO_SCHEMA: 'Clip.1',
                    media_reference: {
                      OTIO_SCHEMA: 'ExternalReference.1',
                      target_url: 'media/clip-1.mp4',
                    },
                  },
                  {
                    OTIO_SCHEMA: 'Clip.2',
                    media_references: {
                      DEFAULT_MEDIA: {
                        OTIO_SCHEMA: 'ExternalReference.1',
                        target_url: 'media/active.mp4',
                      },
                      original: {
                        OTIO_SCHEMA: 'ExternalReference.1',
                        target_url: 'media/inactive.mp4',
                      },
                    },
                  },
                  {
                    OTIO_SCHEMA: 'Stack.1',
                    children: [
                      {
                        OTIO_SCHEMA: 'Track.1',
                        children: [
                          {
                            OTIO_SCHEMA: 'Clip.1',
                            media_reference: {
                              OTIO_SCHEMA: 'ImageSequenceReference.1',
                              target_url_base: 'media/sequence',
                              name_prefix: 'frame_',
                              name_suffix: '.png',
                              start_frame: -3,
                              frame_step: 2,
                              rate: 24,
                              frame_zero_padding: 3,
                              available_range: {
                                OTIO_SCHEMA: 'TimeRange.1',
                                duration: {
                                  OTIO_SCHEMA: 'RationalTime.1',
                                  value: 6,
                                  rate: 24,
                                },
                              },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await writeFile(join(dir, 'content.otio'), JSON.stringify(contentOtio));
    await Promise.all([
      writeFile(join(dir, 'media', 'clip-1.mp4'), 'clip-1'),
      writeFile(join(dir, 'media', 'active.mp4'), 'active'),
      writeFile(join(dir, 'media', 'inactive.mp4'), 'inactive'),
      writeFile(join(dir, 'media', 'sequence', 'frame_-003.png'), 'frame-3'),
      writeFile(join(dir, 'media', 'sequence', 'frame_-001.png'), 'frame-1'),
      writeFile(join(dir, 'media', 'sequence', 'frame_001.png'), 'frame1'),
    ]);

    const bundled = await bundleOtiod(dir, nodeFiles);
    const indexed = await indexOtioZip(bundled.bytes, {
      inflater: async (compressed, _uncompressedSize, maxBytes) =>
        new Uint8Array(
          inflateRawSync(compressed, { maxOutputLength: maxBytes })
        ),
    });
    for (const name of [
      'media/clip-1.mp4',
      'media/active.mp4',
      'media/inactive.mp4',
      'media/sequence/frame_-003.png',
      'media/sequence/frame_-001.png',
      'media/sequence/frame_001.png',
    ]) {
      expect(indexed.entries.has(name)).toBe(true);
    }
    expect(indexed.entries.has('media/never-opened.mp4')).toBe(false);
  });

  test('refuses symlink roots, content, and a linked media directory before a grant or upload', async () => {
    const outside = join(scratch, 'outside');
    const minimalBundle = JSON.stringify({
      OTIO_SCHEMA: 'Clip.1',
      media_reference: { OTIO_SCHEMA: 'MissingReference.1' },
    });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'content.otio'), minimalBundle);

    const root = join(scratch, 'root.otiod');
    await mkdir(root);
    await writeFile(join(root, 'content.otio'), minimalBundle);
    const linkedRoot = join(scratch, 'linked-root.otiod');
    await symlink(root, linkedRoot, 'dir');
    await expect(bundleOtiod(linkedRoot, nodeFiles)).rejects.toThrow(
      PublishError
    );

    const realParent = join(scratch, 'real-parent');
    const bundleInsideParent = join(realParent, 'nested.otiod');
    await mkdir(bundleInsideParent, { recursive: true });
    await writeFile(join(bundleInsideParent, 'content.otio'), minimalBundle);
    const linkedParent = join(scratch, 'linked-parent');
    await symlink(realParent, linkedParent, 'dir');
    await expect(
      bundleOtiod(join(linkedParent, 'nested.otiod'), nodeFiles)
    ).rejects.toThrow(PublishError);

    const contentLink = join(scratch, 'content-link.otiod');
    await mkdir(contentLink);
    await symlink(
      join(outside, 'content.otio'),
      join(contentLink, 'content.otio')
    );
    await expect(bundleOtiod(contentLink, nodeFiles)).rejects.toThrow(
      PublishError
    );

    const linkedMedia = join(scratch, 'linked-media.otiod');
    await mkdir(join(linkedMedia, 'media'), { recursive: true });
    await writeFile(
      join(linkedMedia, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Clip.1',
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: 'media/linked-dir/secret.mp4',
        },
      })
    );
    await writeFile(join(outside, 'secret.mp4'), 'outside bytes');
    await symlink(outside, join(linkedMedia, 'media', 'linked-dir'), 'dir');

    const calls: string[] = [];
    await expect(
      publish({ path: linkedMedia }, { ...deps, fetch: grantFetch(calls) })
    ).rejects.toThrow(PublishError);
    expect(calls).toEqual([]);
  });

  test('keeps a held leaf descriptor bound when its pathname is replaced', async () => {
    const dir = join(scratch, 'held-leaf.otiod');
    const media = join(dir, 'media');
    const heldPath = join(media, 'held.mp4');
    const outsidePath = join(scratch, 'outside.mp4');
    await mkdir(media, { recursive: true });
    await writeFile(heldPath, 'held bytes');
    await writeFile(outsidePath, 'outside bytes');

    const root = await nodeFiles.openBundleRoot(dir);
    let held: ConfinedBundleFile | undefined;
    try {
      const heldFile = await root.openRegular('media/held.mp4');
      held = heldFile;
      await rename(heldPath, join(media, 'held-original.mp4'));
      await symlink(outsidePath, heldPath);
      try {
        const bytes = await heldFile.readBounded(1024);
        expect(new TextDecoder().decode(bytes)).toBe('held bytes');
      } catch {
        // A platform may refuse the descriptor after a concurrent rename. It
        // must never read the replacement path.
      }
    } finally {
      await held?.close();
      await root.close();
    }
  });

  test('does not follow an intermediate directory replaced after opening the root', async () => {
    const dir = join(scratch, 'held-root.otiod');
    const media = join(dir, 'media');
    const outside = join(scratch, 'outside-media');
    await mkdir(media, { recursive: true });
    await mkdir(outside);
    await writeFile(join(media, 'inside.mp4'), 'inside bytes');
    await writeFile(join(outside, 'inside.mp4'), 'outside bytes');

    const root = await nodeFiles.openBundleRoot(dir);
    try {
      await rename(media, join(dir, 'media-original'));
      await symlink(outside, media, 'dir');
      await expect(root.openRegular('media/inside.mp4')).rejects.toThrow();
    } finally {
      await root.close();
    }
  });

  test('refuses sequence expansion and archive-count sentinels before media reads', async () => {
    const dir = join(scratch, 'unbounded.otiod');
    await mkdir(dir);
    const sequence = (duration: number, padding = 0) => ({
      OTIO_SCHEMA: 'ImageSequenceReference.1',
      target_url_base: 'media/frames',
      name_prefix: 'frame_',
      name_suffix: '.png',
      start_frame: 1,
      frame_step: 1,
      rate: 1,
      frame_zero_padding: padding,
      available_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        duration: {
          OTIO_SCHEMA: 'RationalTime.1',
          value: duration,
          rate: 1,
        },
      },
    });
    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Clip.1',
        media_reference: sequence(1_000_000_000),
      })
    );
    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Clip.1',
        media_reference: sequence(1, 1_000_000_000),
      })
    );
    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);

    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Clip.1',
        media_reference: sequence(65_536),
      })
    );
    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);

    const tooManyEntries = Array.from(
      { length: MAX_ZIP_ENTRY_COUNT },
      (_, index) => ({
        name: `media/${index}`,
        data: new Uint8Array(),
        method: 0 as const,
      })
    );
    expect(() => buildZipArchive(tooManyEntries)).toThrow(PublishError);
  });

  test('refuses distinct bundle paths that would collapse onto one archive entry', async () => {
    const dir = join(scratch, 'aliases.otiod');
    await mkdir(join(dir, 'media'), { recursive: true });
    await writeFile(
      join(dir, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Track.1',
        children: [
          {
            OTIO_SCHEMA: 'Clip.1',
            media_reference: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: 'x.mp4',
            },
          },
          {
            OTIO_SCHEMA: 'Clip.1',
            media_reference: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: 'media/x.mp4',
            },
          },
        ],
      })
    );
    await writeFile(join(dir, 'x.mp4'), 'root x');
    await writeFile(join(dir, 'media', 'x.mp4'), 'media x');
    await expect(bundleOtiod(dir, nodeFiles)).rejects.toThrow(PublishError);
  });
});
