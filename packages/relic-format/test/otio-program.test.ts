import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import {
  MAX_OTIO_PROGRAM_MANIFEST_BYTES,
  OTIO_PROGRAM_MANIFEST_ENTRY,
  OtioProgramError,
  otioProgramEntryName,
  parseOtioProgramManifest,
  readOtioProgramArchive,
  stringifyOtioProgramManifest,
} from '../src/otio-program.ts';
import { crc32, indexOtioZip } from '../src/otio-zip.ts';

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
const DOCUMENT = { document_sha256: CONTENT_SHA, timeline_ids: TIMELINE_IDS };

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
    'media/%2e%2e/x.mp4',
    'media\\x.mp4',
    'media/clip.mp4?x',
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
