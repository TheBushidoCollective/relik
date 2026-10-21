import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { indexOtioZip } from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import { bundleOtiod } from '../src/otio-bundle.ts';
import { type PublishDeps, PublishError, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let deps: PublishDeps;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-otio-bundling-'));
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

function grantFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
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
                  frame_zero_padding: 4,
                  number_of_frames_in_sequence: 2,
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
    try {
      await bundleOtiod(dir, nodeFiles);
    } catch (err) {
      expect((err as PublishError).code).toBe('otio_bundle_invalid');
      expect((err as Error).message).toContain('symlink');
    }
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
});
