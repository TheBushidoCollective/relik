import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { otioDocumentMediaPaths } from '../src/otio-identity.ts';
import type { OtioDocumentV1, OtioZipIndex } from '../src/otio-types.ts';
import {
  MAX_OTIO_PROGRAM_MANIFEST_BYTES,
  OTIO_PROGRAM_MANIFEST_ENTRY,
  OTIO_PROGRAM_MAX_BYTES,
  OtioProgramError,
  otioProgramEntryName,
  parseOtioProgramManifest,
  parseOtioProgramRenderer,
  parseOtioProgramTimelineRecord,
  readOtioProgramArchive,
  stringifyOtioProgramManifest,
} from '../src/otio-program.ts';
import {
  crc32,
  indexOtioZip,
  OTIO_DOCUMENT_MAX_BYTES,
  type ZipSource,
} from '../src/otio-zip.ts';

const STORED = 0;
const DEFLATE = 8;
const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

const CONTENT = encoder.encode('{"OTIO_SCHEMA":"Timeline.1"}');
const PROGRAM = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) & 0xff);
const MEDIA = encoder.encode('source media bytes');
const CONTENT_SHA = await sha256Hex(CONTENT);
const PROGRAM_SHA = await sha256Hex(PROGRAM);
const MEDIA_SHA = await sha256Hex(MEDIA);
const TIMELINE_IDS = ['timeline-a', 'timeline-b'];
const DOCUMENT = {
  document_sha256: CONTENT_SHA,
  timeline_ids: TIMELINE_IDS,
  media_paths: ['media/clip.mp4'],
};

/** A valid descriptor for 2 s at 24 fps, with 48000 Hz stereo audio. */
function descriptor(
  index: number,
  bytes: Uint8Array,
  sha256: string,
  patch: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    entry: otioProgramEntryName(index),
    sha256,
    bytes: bytes.length,
    range: {
      start_time: { value: 0, rate: 24 },
      duration: { value: 48, rate: 24 },
    },
    frame_rate: { num: 24, den: 1 },
    frames: 48,
    width: 320,
    height: 240,
    video_codec: 'avc1.42001f',
    video_bitrate: 1_000_000,
    audio_codec: 'mp4a.40.2',
    audio_rate: 48000,
    channels: 2,
    audio_samples: 96000,
    ...patch,
  };
}

function rendered(
  index = 0,
  programPatch: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    timeline_id: TIMELINE_IDS[index],
    index,
    status: 'rendered',
    reasons: [],
    program: descriptor(index, PROGRAM, PROGRAM_SHA, programPatch),
  };
}

function unavailable(index = 1): Record<string, unknown> {
  return {
    timeline_id: TIMELINE_IDS[index],
    index,
    status: 'unavailable',
    reasons: [
      {
        code: 'unsupported-effect',
        message: 'Blur has no faithful render.',
        node_id: 'clip-7',
      },
    ],
  };
}

function manifestObject(
  patch: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: 'relic.otio.program/1',
    document_sha256: CONTENT_SHA,
    renderer: { client: 'relic-mcp/1.0', protocol: 1, browser: 'Chrome 130' },
    media: { 'media/clip.mp4': MEDIA_SHA },
    timelines: [rendered(), unavailable()],
    ...patch,
  };
}

function manifestBytes(patch: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(JSON.stringify(manifestObject(patch)));
}

function parseFailure(bytes: Uint8Array): OtioProgramError {
  try {
    parseOtioProgramManifest(bytes);
  } catch (err) {
    if (err instanceof OtioProgramError) return err;
    throw err;
  }
  throw new Error('expected the manifest to be refused');
}

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method?: number;
}

/** Writes a ZIP with the same layout the indexer reads in otio-zip.test.ts. */
function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const headers: {
    name: Uint8Array;
    method: number;
    crc: number;
    stored: Uint8Array;
    size: number;
    offset: number;
  }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? STORED;
    const name = encoder.encode(entry.name);
    const stored =
      method === DEFLATE
        ? new Uint8Array(deflateRawSync(entry.data))
        : entry.data;
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + stored.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, method, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, stored.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(stored, 30 + name.length);
    headers.push({
      name,
      method,
      crc,
      stored,
      size: entry.data.length,
      offset,
    });
    parts.push(local);
    offset += local.length;
  }
  const centralStart = offset;
  for (const header of headers) {
    const central = new Uint8Array(46 + header.name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(10, header.method, true);
    view.setUint32(16, header.crc, true);
    view.setUint32(20, header.stored.length, true);
    view.setUint32(24, header.size, true);
    view.setUint16(28, header.name.length, true);
    view.setUint32(42, header.offset, true);
    central.set(header.name, 46);
    parts.push(central);
    offset += central.length;
  }
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, headers.length, true);
  view.setUint16(10, headers.length, true);
  view.setUint32(12, offset - centralStart, true);
  view.setUint32(16, centralStart, true);
  parts.push(eocd);

  const out = new Uint8Array(offset + eocd.length);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

function baseEntries(
  patch: {
    manifest?: Uint8Array;
    manifestMethod?: number;
    program?: Uint8Array;
    programMethod?: number;
    media?: Uint8Array;
  } = {}
): ZipEntry[] {
  return [
    { name: 'version.txt', data: encoder.encode('1.0.0') },
    { name: 'content.otio', data: CONTENT },
    { name: 'media/clip.mp4', data: patch.media ?? MEDIA },
    {
      name: OTIO_PROGRAM_MANIFEST_ENTRY,
      data: patch.manifest ?? manifestBytes(),
      method: patch.manifestMethod ?? DEFLATE,
    },
    {
      name: otioProgramEntryName(0),
      data: patch.program ?? PROGRAM,
      method: patch.programMethod ?? STORED,
    },
  ];
}

function open(entries: readonly ZipEntry[]) {
  return indexOtioZip(buildZip(entries));
}

describe('parseOtioProgramManifest', () => {
  test('accepts a rendered and an unavailable timeline', () => {
    const manifest = parseOtioProgramManifest(manifestBytes());
    expect(manifest.schema).toBe('relic.otio.program/1');
    expect(manifest.timelines.map((t) => t.status)).toEqual([
      'rendered',
      'unavailable',
    ]);
    expect(manifest.timelines[0]?.program?.entry).toBe(
      'relic/program/timeline-0.mp4'
    );
  });

  test('refuses bytes that are not JSON', () => {
    expect(parseFailure(encoder.encode('{')).code).toBe('malformed-manifest');
  });

  test('refuses an oversized manifest before parsing it', () => {
    const oversized = new Uint8Array(MAX_OTIO_PROGRAM_MANIFEST_BYTES + 1);
    expect(parseFailure(oversized).code).toBe('size-cap-exceeded');
  });

  test('refuses an unknown schema, protocol, or key', () => {
    expect(
      parseFailure(manifestBytes({ schema: 'relic.otio.program/2' })).code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          renderer: { client: 'x', protocol: 2, browser: 'y' },
        })
      ).code
    ).toBe('malformed-manifest');
    expect(parseFailure(manifestBytes({ extra: true })).code).toBe(
      'malformed-manifest'
    );
    expect(
      parseFailure(
        manifestBytes({
          timelines: [rendered(0, { extra: 1 }), unavailable()],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('ties status to its program and reasons', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            {
              timeline_id: 'timeline-a',
              index: 0,
              status: 'rendered',
              reasons: [],
            },
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            {
              ...rendered(0),
              reasons: [{ code: 'render-failed', message: 'x' }],
            },
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0),
            { ...unavailable(), program: descriptor(1, PROGRAM, PROGRAM_SHA) },
          ],
        })
      ).code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [rendered(0), { ...unavailable(), reasons: [] }],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('accepts only the closed set of reason codes', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0),
            {
              ...unavailable(),
              reasons: [{ code: 'focus-only', message: 'x' }],
            },
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('refuses control characters in reason messages', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0),
            {
              ...unavailable(),
              reasons: [{ code: 'render-failed', message: 'line\nbreak' }],
            },
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('requires timelines in index order with unique ids', () => {
    expect(
      parseFailure(manifestBytes({ timelines: [rendered(1), unavailable(0)] }))
        .code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0),
            { ...unavailable(1), timeline_id: 'timeline-a' },
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('refuses a sha256 that is not lowercase hex', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, { sha256: PROGRAM_SHA.toUpperCase() }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('bounds rational times and rates', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, {
              range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 48, rate: 0 },
              },
            }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, {
              range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 48, rate: 2_000_000 },
              },
            }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('refuses an inconsistent frame count or audio sample count', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [rendered(0, { frames: 47 }), unavailable()],
        })
      ).code
    ).toBe('malformed-manifest');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, { audio_samples: 96000 + 4096 }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('requires the H.264 and AAC profile and even dimensions', () => {
    for (const patch of [
      { width: 321 },
      { video_codec: 'avc1' },
      { audio_rate: 44100 },
      { channels: 1 },
      { audio_codec: 'opus' },
    ]) {
      expect(
        parseFailure(
          manifestBytes({ timelines: [rendered(0, patch), unavailable()] })
        ).code
      ).toBe('malformed-manifest');
    }
  });

  test('requires the exact program entry name for its timeline', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, { entry: 'relic/program/../timeline-0.mp4' }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('unsafe-path');
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, { entry: 'relic/program/timeline-1.mp4' }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('unsafe-path');
  });

  test('round-trips through stringifyOtioProgramManifest', () => {
    const parsed = parseOtioProgramManifest(manifestBytes());
    const bytes = stringifyOtioProgramManifest(parsed);
    expect(parseOtioProgramManifest(bytes)).toEqual(parsed);
    expect(() =>
      stringifyOtioProgramManifest({ ...parsed, schema: 'x' } as never)
    ).toThrow(OtioProgramError);
  });
});

describe('media and entry path safety', () => {
  const unsafePaths = [
    'media/../secret.mp4',
    '/media/clip.mp4',
    'media//../x.mp4',
    'media\\x.mp4',
    'media/',
    'relic/program/timeline-0.mp4',
    '__proto__',
  ];
  for (const key of unsafePaths) {
    test(`refuses media path ${JSON.stringify(key)}`, () => {
      expect(
        parseFailure(manifestBytes({ media: { [key]: MEDIA_SHA } })).code
      ).toBe('unsafe-path');
    });
  }

  test('refuses a media digest that is not lowercase hex', () => {
    expect(
      parseFailure(manifestBytes({ media: { 'media/clip.mp4': 'abc' } })).code
    ).toBe('malformed-manifest');
  });
});

describe('readOtioProgramArchive', () => {
  test('returns null when the archive carries no program', async () => {
    const entries = baseEntries().filter((e) => !e.name.startsWith('relic/'));
    expect(
      await readOtioProgramArchive(await open(entries), DOCUMENT)
    ).toBeNull();
  });

  test('returns verified program bytes for a valid archive', async () => {
    const result = await readOtioProgramArchive(
      await open(baseEntries()),
      DOCUMENT
    );
    expect(result?.manifest.timelines.map((t) => t.status)).toEqual([
      'rendered',
      'unavailable',
    ]);
    expect(result?.programs.get(0)).toEqual(PROGRAM);
    expect(result?.programs.has(1)).toBe(false);
  });

  test('refuses a manifest that is not DEFLATE', async () => {
    await expect(
      readOtioProgramArchive(
        await open(baseEntries({ manifestMethod: STORED })),
        DOCUMENT
      )
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a program that is not STORED', async () => {
    await expect(
      readOtioProgramArchive(
        await open(baseEntries({ programMethod: DEFLATE })),
        DOCUMENT
      )
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a manifest bound to another document', async () => {
    await expect(
      readOtioProgramArchive(await open(baseEntries()), {
        ...DOCUMENT,
        document_sha256: '0'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a timeline list that differs from the document', async () => {
    await expect(
      readOtioProgramArchive(await open(baseEntries()), {
        document_sha256: CONTENT_SHA,
        timeline_ids: ['timeline-a', 'other'],
        media_paths: ['media/clip.mp4'],
      })
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a program whose bytes differ from the manifest sha256', async () => {
    const flipped = PROGRAM.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await expect(
      readOtioProgramArchive(
        await open(baseEntries({ program: flipped })),
        DOCUMENT
      )
    ).rejects.toMatchObject({ code: 'digest-mismatch' });
  });

  test('refuses a program whose size differs from the manifest', async () => {
    const manifest = manifestBytes({
      timelines: [rendered(0, { bytes: PROGRAM.length + 1 }), unavailable()],
    });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses an unreferenced program entry', async () => {
    const entries = [
      ...baseEntries(),
      { name: otioProgramEntryName(1), data: PROGRAM },
    ];
    await expect(
      readOtioProgramArchive(await open(entries), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a rendered timeline whose program is missing', async () => {
    const entries = baseEntries().filter(
      (e) => e.name !== otioProgramEntryName(0)
    );
    await expect(
      readOtioProgramArchive(await open(entries), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses program entries without a manifest', async () => {
    const entries = baseEntries().filter(
      (e) => e.name !== OTIO_PROGRAM_MANIFEST_ENTRY
    );
    await expect(
      readOtioProgramArchive(await open(entries), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a media entry whose bytes differ from the manifest', async () => {
    const manifest = manifestBytes({
      media: { 'media/clip.mp4': '0'.repeat(64) },
    });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'digest-mismatch' });
  });

  test('refuses a media reference missing from the archive', async () => {
    const manifest = manifestBytes({
      media: { 'media/gone.mp4': MEDIA_SHA },
    });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a manifest with a traversal media path', async () => {
    const manifest = manifestBytes({
      media: { 'media/../../secret.mp4': MEDIA_SHA },
    });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'unsafe-path' });
  });
});

describe('readOtioProgramArchive legacy and partial archives', () => {
  test('a program MP4 without a manifest throws, never null', async () => {
    const entries = [
      ...baseEntries().filter((e) => !e.name.startsWith('relic/')),
      { name: otioProgramEntryName(0), data: PROGRAM },
    ];
    await expect(
      readOtioProgramArchive(await open(entries), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('an all-unavailable manifest with no MP4s is a manifest, not legacy', async () => {
    const manifest = manifestBytes({
      timelines: [unavailable(0), unavailable(1)],
    });
    const entries = baseEntries({ manifest }).filter(
      (e) => e.name !== otioProgramEntryName(0)
    );
    const result = await readOtioProgramArchive(await open(entries), DOCUMENT);
    expect(result).not.toBeNull();
    expect(result?.programs.size).toBe(0);
  });
});

describe('frame rate, duration, and start-time bounds', () => {
  test('refuses a frame rate below one frame per second', () => {
    for (const frame_rate of [
      { num: 1, den: 2 },
      { num: 1, den: 1_000_000 },
    ]) {
      expect(
        parseFailure(
          manifestBytes({
            timelines: [rendered(0, { frame_rate }), unavailable()],
          })
        ).code
      ).toBe('malformed-manifest');
    }
  });

  test('accepts exactly one frame per second', () => {
    const manifest = parseOtioProgramManifest(
      manifestBytes({
        timelines: [
          rendered(0, { frame_rate: { num: 1, den: 1 }, frames: 2 }),
          unavailable(),
        ],
      })
    );
    expect(manifest.timelines[0]?.status).toBe('rendered');
  });

  test('refuses a duration shorter than one frame', () => {
    // 0.0208 s at 24 fps is half a frame: the frame count matches, the span does not.
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, {
              range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 1, rate: 48 },
              },
              frames: 1,
              audio_samples: 1000,
            }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('refuses a nonzero start_time', () => {
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, {
              range: {
                start_time: { value: 1, rate: 24 },
                duration: { value: 48, rate: 24 },
              },
            }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });
});

describe('bounded error text', () => {
  test('a JSON parse error does not echo the manifest text', () => {
    const failure = parseFailure(encoder.encode('{"secret":SECRETVALUE-xyz'));
    expect(failure.code).toBe('malformed-manifest');
    expect(failure.message).not.toContain('SECRETVALUE');
  });

  test('an oversized key is quoted in a bounded message', () => {
    const failure = parseFailure(manifestBytes({ ['k'.repeat(5000)]: true }));
    expect(failure.code).toBe('malformed-manifest');
    expect(failure.message.length).toBeLessThan(200);
  });

  test('an oversized media path is refused with a bounded message', () => {
    const failure = parseFailure(
      manifestBytes({ media: { [`media/${'a'.repeat(65536)}`]: MEDIA_SHA } })
    );
    expect(failure.code).toBe('unsafe-path');
    expect(failure.message.length).toBeLessThan(200);
  });
});

describe('manifest media must match the document references', () => {
  test('refuses an empty media map when the document references media', async () => {
    const manifest = manifestBytes({ media: {} });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses an extra media entry the document does not reference', async () => {
    const manifest = manifestBytes({
      media: { 'media/clip.mp4': MEDIA_SHA, 'media/extra.mp4': MEDIA_SHA },
    });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('refuses a referenced media entry the manifest omits', async () => {
    await expect(
      readOtioProgramArchive(await open(baseEntries()), {
        ...DOCUMENT,
        media_paths: ['media/clip.mp4', 'media/other.mp4'],
      })
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  test('accepts an empty reference set with an empty media map', async () => {
    const manifest = manifestBytes({ media: {} });
    const result = await readOtioProgramArchive(
      await open(baseEntries({ manifest })),
      { ...DOCUMENT, media_paths: [] }
    );
    expect(result?.programs.get(0)).toEqual(PROGRAM);
  });

  test('refuses an unsafe caller-supplied reference path', async () => {
    await expect(
      readOtioProgramArchive(await open(baseEntries()), {
        ...DOCUMENT,
        media_paths: ['media/../secret.mp4'],
      })
    ).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  test('refuses a reference path outside media/', async () => {
    await expect(
      readOtioProgramArchive(await open(baseEntries()), {
        ...DOCUMENT,
        media_paths: ['relic/program/timeline-0.mp4'],
      })
    ).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  test('refuses a duplicated caller-supplied reference path', async () => {
    await expect(
      readOtioProgramArchive(await open(baseEntries()), {
        ...DOCUMENT,
        media_paths: ['media/clip.mp4', 'media/clip.mp4'],
      })
    ).rejects.toMatchObject({ code: 'archive-mismatch' });
  });
});

describe('archive names are literal identities', () => {
  test('a key with reserved URL characters is its own identity', async () => {
    const name = 'media/a%3Fb c?#.mp4';
    const data = encoder.encode('literal name');
    const sha = await sha256Hex(data);
    const entries: ZipEntry[] = [
      { name: 'version.txt', data: encoder.encode('1.0.0') },
      { name: 'content.otio', data: CONTENT },
      { name, data },
      {
        name: OTIO_PROGRAM_MANIFEST_ENTRY,
        data: manifestBytes({ media: { [name]: sha } }),
        method: DEFLATE,
      },
      { name: otioProgramEntryName(0), data: PROGRAM },
    ];
    const result = await readOtioProgramArchive(await open(entries), {
      ...DOCUMENT,
      media_paths: [name],
    });
    expect(result?.programs.get(0)).toEqual(PROGRAM);
  });

  test('an encoded dot-dot segment is a literal name, not traversal', () => {
    expect(() =>
      parseOtioProgramManifest(
        manifestBytes({ media: { 'media/%2e%2e/x.mp4': MEDIA_SHA } })
      )
    ).not.toThrow();
  });

  test('control characters in a media key are refused', () => {
    expect(
      parseFailure(
        manifestBytes({ media: { 'media/a\u0001b.mp4': MEDIA_SHA } })
      ).code
    ).toBe('unsafe-path');
  });

  test('a raw traversal segment is refused even when encoded siblings exist', () => {
    expect(
      parseFailure(
        manifestBytes({ media: { 'media/x/../../secret.mp4': MEDIA_SHA } })
      ).code
    ).toBe('unsafe-path');
  });
});

describe('document media identity', () => {
  test('a URL reference decodes to the literal archive entry it names', () => {
    const doc = {
      version: 1,
      document_sha256: CONTENT_SHA,
      timeline_ids: [],
      nodes: {
        ref: {
          raw: {
            OTIO_SCHEMA: 'ExternalReference.1',
            target_url: 'media/a%3Fb%20c.mp4',
          },
        },
      },
      media: {
        'media/a?b c.mp4': {
          key: 'media/a?b c.mp4',
          bundle_path: 'media/a?b c.mp4',
          size: 1,
        },
      },
      diagnostics: [],
    } as unknown as OtioDocumentV1;
    expect(otioDocumentMediaPaths(doc)).toEqual(['media/a?b c.mp4']);
  });

  test('a URL reference that traverses resolves to nothing', () => {
    const doc = {
      version: 1,
      document_sha256: CONTENT_SHA,
      timeline_ids: [],
      nodes: {
        ref: {
          raw: {
            OTIO_SCHEMA: 'ExternalReference.1',
            target_url: 'media/%2e%2e/x.mp4',
          },
        },
      },
      media: {},
      diagnostics: [],
    } as unknown as OtioDocumentV1;
    expect(otioDocumentMediaPaths(doc)).toEqual([]);
  });
});

describe('media key length is measured in UTF-8 bytes', () => {
  test('a legitimate name past the old 1024-character bound is accepted', () => {
    const key = `media/${'a'.repeat(1024)}.png`;
    expect(() =>
      parseOtioProgramManifest(manifestBytes({ media: { [key]: MEDIA_SHA } }))
    ).not.toThrow();
  });

  test('the largest name a ZIP central directory carries is accepted', () => {
    const key = `media/${'a'.repeat(65529)}`;
    expect(new TextEncoder().encode(key).byteLength).toBe(65535);
    expect(() =>
      parseOtioProgramManifest(manifestBytes({ media: { [key]: MEDIA_SHA } }))
    ).not.toThrow();
  });

  test('a multibyte name exactly at the byte limit is accepted', () => {
    const key = `media/${'€'.repeat(21843)}`;
    expect(new TextEncoder().encode(key).byteLength).toBe(65535);
    expect(() =>
      parseOtioProgramManifest(manifestBytes({ media: { [key]: MEDIA_SHA } }))
    ).not.toThrow();
  });

  test('a multibyte name one byte over the limit is refused, not truncated', () => {
    const key = `media/${'€'.repeat(21844)}`;
    expect(new TextEncoder().encode(key).byteLength).toBe(65538);
    expect(
      parseFailure(manifestBytes({ media: { [key]: MEDIA_SHA } })).code
    ).toBe('unsafe-path');
  });

  test('an ASCII name one byte over the limit is refused', () => {
    const key = `media/${'a'.repeat(65530)}`;
    expect(
      parseFailure(manifestBytes({ media: { [key]: MEDIA_SHA } })).code
    ).toBe('unsafe-path');
  });

  test('a lone surrogate is refused because it has no UTF-8 identity', () => {
    expect(
      parseFailure(manifestBytes({ media: { 'media/\uD800x.png': MEDIA_SHA } }))
        .code
    ).toBe('unsafe-path');
  });

  test('a well-formed astral character is accepted', () => {
    expect(() =>
      parseOtioProgramManifest(
        manifestBytes({ media: { 'media/😀.png': MEDIA_SHA } })
      )
    ).not.toThrow();
  });
});

const MIB = 1024 * 1024;
const BIG_MEDIA = 'media/large.bin';
const BIG_MEDIA_SIZE = OTIO_DOCUMENT_MAX_BYTES + 1;
const BIG_DOCUMENT = {
  document_sha256: CONTENT_SHA,
  timeline_ids: TIMELINE_IDS,
  media_paths: [BIG_MEDIA],
};

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 of `length` zero bytes, computed without materializing them. */
function crc32OfZeros(length: number): number {
  let c = 0xffffffff;
  for (let i = 0; i < length; i += 1) {
    c = (CRC_TABLE[c & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** SHA-256 of `length` zero bytes, hashed in 8 MiB steps. */
function sha256OfZeros(length: number): string {
  const hash = createHash('sha256');
  const zeros = new Uint8Array(8 * MIB);
  for (let left = length; left > 0; left -= zeros.length) {
    hash.update(zeros.subarray(0, Math.min(zeros.length, left)));
  }
  return hash.digest('hex');
}

/**
 * A range-backed archive whose last member is a STORED media entry of zero
 * bytes, generated on request so the archive exists only as ranges. The media
 * is the last local and central record, so the ZIP is patched in place to
 * declare `mediaSize` bytes. `corruptAt` flips one media byte, counted from
 * the media's start.
 */
function rangeArchive(options: {
  readonly mediaSize: number;
  readonly mediaCrc: number;
  readonly manifest: Uint8Array;
  readonly corruptAt?: number;
}): ZipSource & { readonly reads: number[] } {
  const zip = buildZip([
    { name: 'version.txt', data: encoder.encode('1.0.0') },
    { name: 'content.otio', data: CONTENT },
    {
      name: OTIO_PROGRAM_MANIFEST_ENTRY,
      data: options.manifest,
      method: DEFLATE,
    },
    { name: otioProgramEntryName(0), data: PROGRAM },
    { name: BIG_MEDIA, data: new Uint8Array([0]) },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  const cdStart = view.getUint32(eocd + 16, true);
  const nameLength = encoder.encode(BIG_MEDIA).length;
  const local = cdStart - (30 + nameLength + 1);
  const central = eocd - (46 + nameLength);
  const dataStart = cdStart - 1;
  const mediaEnd = dataStart + options.mediaSize;
  view.setUint32(local + 14, options.mediaCrc, true);
  view.setUint32(local + 18, options.mediaSize, true);
  view.setUint32(local + 22, options.mediaSize, true);
  view.setUint32(central + 16, options.mediaCrc, true);
  view.setUint32(central + 20, options.mediaSize, true);
  view.setUint32(central + 24, options.mediaSize, true);
  view.setUint32(eocd + 16, mediaEnd, true);
  const prefix = zip.subarray(0, dataStart);
  const suffix = zip.subarray(dataStart + 1);
  const corrupt =
    options.corruptAt === undefined ? -1 : dataStart + options.corruptAt;
  const reads: number[] = [];
  return {
    size: mediaEnd + suffix.length,
    reads,
    async read(start: number, end: number): Promise<Uint8Array> {
      reads.push(end - start);
      const out = new Uint8Array(end - start);
      if (start < prefix.length) {
        out.set(prefix.subarray(start, Math.min(end, prefix.length)));
      }
      if (end > mediaEnd) {
        const from = Math.max(start, mediaEnd);
        out.set(suffix.subarray(from - mediaEnd, end - mediaEnd), from - start);
      }
      if (corrupt >= start && corrupt < end) out[corrupt - start] = 0xff;
      return out;
    },
  };
}

describe('program byte bound', () => {
  test('is exactly 100 MiB', () => {
    expect(OTIO_PROGRAM_MAX_BYTES).toBe(100 * MIB);
  });

  test('a program at the bound parses, and one byte over is refused', () => {
    expect(() =>
      parseOtioProgramManifest(
        manifestBytes({
          timelines: [
            rendered(0, { bytes: OTIO_PROGRAM_MAX_BYTES }),
            unavailable(),
          ],
        })
      )
    ).not.toThrow();
    expect(
      parseFailure(
        manifestBytes({
          timelines: [
            rendered(0, { bytes: OTIO_PROGRAM_MAX_BYTES + 1 }),
            unavailable(),
          ],
        })
      ).code
    ).toBe('malformed-manifest');
  });

  test('a manifest whose programs total past the bound is refused before any program is read', async () => {
    const half = OTIO_PROGRAM_MAX_BYTES / 2 + 1;
    const manifest = manifestBytes({
      timelines: [rendered(0, { bytes: half }), rendered(1, { bytes: half })],
    });
    await expect(
      readOtioProgramArchive(await open(baseEntries({ manifest })), DOCUMENT)
    ).rejects.toMatchObject({ code: 'size-cap-exceeded' });
  });

  /**
   * A manifest whose own length plus the program total is exactly
   * OTIO_PROGRAM_MAX_BYTES + delta. The manifest records the program sizes, so
   * its length is solved by iteration.
   */
  function aggregateManifest(delta: number): Uint8Array {
    let manifest = manifestBytes({
      timelines: [rendered(0, { bytes: 1 }), rendered(1, { bytes: 1 })],
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      const programs = OTIO_PROGRAM_MAX_BYTES - manifest.length + delta;
      const first = Math.floor(programs / 2);
      const next = manifestBytes({
        timelines: [
          rendered(0, { bytes: first }),
          rendered(1, { bytes: programs - first }),
        ],
      });
      if (next.length === manifest.length) return next;
      manifest = next;
    }
    throw new Error('manifest size did not converge');
  }

  /** Records every entry read through the index, to prove what was not read. */
  function countReads(zip: OtioZipIndex): {
    reads: string[];
    zip: OtioZipIndex;
  } {
    const reads: string[] = [];
    return {
      reads,
      zip: {
        ...zip,
        readEntry: (name, inflater) => {
          reads.push(name);
          return zip.readEntry(name, inflater);
        },
      },
    };
  }

  test('one byte over the aggregate bound is refused before any program is read', async () => {
    const counted = countReads(
      await open(baseEntries({ manifest: aggregateManifest(1) }))
    );
    await expect(
      readOtioProgramArchive(counted.zip, DOCUMENT)
    ).rejects.toMatchObject({ code: 'size-cap-exceeded' });
    expect(counted.reads).toEqual([OTIO_PROGRAM_MANIFEST_ENTRY]);
  });

  test('exactly the aggregate bound clears the size gate', async () => {
    const counted = countReads(
      await open(baseEntries({ manifest: aggregateManifest(0) }))
    );
    const failure = await readOtioProgramArchive(counted.zip, DOCUMENT).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(OtioProgramError);
    expect(failure).toMatchObject({ code: 'archive-mismatch' });
    expect((failure as OtioProgramError).message).toMatch(
      /size differs from the manifest/
    );
    expect(counted.reads).toEqual([OTIO_PROGRAM_MANIFEST_ENTRY]);
  });
});

describe('range-backed media one byte past the document bound', () => {
  let mediaCrc = 0;
  let mediaSha = '';
  beforeAll(() => {
    mediaCrc = crc32OfZeros(BIG_MEDIA_SIZE);
    mediaSha = sha256OfZeros(BIG_MEDIA_SIZE);
  });

  test('verifies with no read over 8 MiB and no decompression-limit', async () => {
    const source = rangeArchive({
      mediaSize: BIG_MEDIA_SIZE,
      mediaCrc,
      manifest: manifestBytes({ media: { [BIG_MEDIA]: mediaSha } }),
    });
    const result = await readOtioProgramArchive(
      await indexOtioZip(source),
      BIG_DOCUMENT
    );
    expect(result?.programs.get(0)).toEqual(PROGRAM);
    expect(Math.max(...source.reads)).toBeLessThanOrEqual(8 * MIB);
  });

  test('a flipped digest is still refused as digest-mismatch', async () => {
    const wrong = (mediaSha[0] === '0' ? '1' : '0') + mediaSha.slice(1);
    const source = rangeArchive({
      mediaSize: BIG_MEDIA_SIZE,
      mediaCrc,
      manifest: manifestBytes({ media: { [BIG_MEDIA]: wrong } }),
    });
    await expect(
      readOtioProgramArchive(await indexOtioZip(source), BIG_DOCUMENT)
    ).rejects.toMatchObject({ code: 'digest-mismatch' });
  });

  test('a corrupted media byte is refused by the stored CRC', async () => {
    const source = rangeArchive({
      mediaSize: BIG_MEDIA_SIZE,
      mediaCrc,
      manifest: manifestBytes({ media: { [BIG_MEDIA]: mediaSha } }),
      corruptAt: 3 * MIB + 17,
    });
    await expect(
      readOtioProgramArchive(await indexOtioZip(source), BIG_DOCUMENT)
    ).rejects.toMatchObject({ code: 'corrupt-archive' });
  });
});

describe('granular manifest validators', () => {
  test('parseOtioProgramTimelineRecord accepts every record of a valid manifest', () => {
    const records = manifestObject().timelines as unknown[];
    records.forEach((record, position) => {
      expect(() =>
        parseOtioProgramTimelineRecord(record, position)
      ).not.toThrow();
    });
  });

  test('parseOtioProgramTimelineRecord refuses each invalid rendered descriptor', () => {
    const cases: Record<string, unknown>[] = [
      { width: 4098 },
      { height: 241 },
      { video_bitrate: 100_000_001 },
      { frame_rate: { num: 24, den: 1.5 } },
      { video_codec: 'hev1.1.6.L93.B0' },
      { audio_rate: 44100 },
      { frames: 50 },
      {
        range: {
          start_time: { value: 1, rate: 24 },
          duration: { value: 48, rate: 24 },
        },
      },
      { bytes: 0 },
      { bytes: OTIO_PROGRAM_MAX_BYTES + 1 },
    ];
    for (const patch of cases) {
      expect(() =>
        parseOtioProgramTimelineRecord(rendered(0, patch), 0)
      ).toThrow(OtioProgramError);
    }
  });

  test('parseOtioProgramTimelineRecord refuses a record whose index is not its position', () => {
    expect(() => parseOtioProgramTimelineRecord(rendered(1), 0)).toThrow(
      OtioProgramError
    );
  });

  test('parseOtioProgramRenderer accepts a valid renderer and refuses a bad client or browser', () => {
    const renderer = {
      client: 'relic-mcp/1.0',
      protocol: 1,
      browser: 'Chrome 130',
    };
    expect(parseOtioProgramRenderer(renderer)).toEqual(renderer);
    for (const bad of [
      { ...renderer, client: '' },
      { ...renderer, client: 'c'.repeat(129) },
      { ...renderer, browser: '' },
      { ...renderer, browser: 'Chrome\u0007' },
    ]) {
      expect(() => parseOtioProgramRenderer(bad)).toThrow(OtioProgramError);
    }
  });
});
