import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { crc32 } from '@relic/format';

const execFileAsync = promisify(execFile);
export const MIB = 1024 * 1024;
export const CAP = 500 * MIB;
export const TEXT_BYTES = 120 * MIB;
export const PDF_BYTES = 300 * MIB;
export const TEXT_LINE_BYTES = 1024;
export const TEXT_LINES = TEXT_BYTES / TEXT_LINE_BYTES;
export const TEXT_MIDDLE_LINE = TEXT_LINES / 2 + 1;
export const TEXT_START = 'RELIC_LARGE_TEXT_FIRST';
export const TEXT_MIDDLE = 'RELIC_LARGE_TEXT_MIDDLE';
export const TEXT_END = 'RELIC_LARGE_TEXT_LAST';

/** Small decodable VP9 MP4, with its movie index before the trailing padding. */
export async function makeBaseVideo(directory: string): Promise<string> {
  const path = join(directory, 'base.mp4');
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24',
    '-t',
    '10',
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    path,
  ]);
  return path;
}

/** A valid MP4 free box permits sparse padding without decoding a huge frame. */
export async function padVideo(
  base: string,
  target: string,
  bytes: number
): Promise<void> {
  await copyFile(base, target);
  const size = (await stat(target)).size;
  const padding = bytes - size;
  assert.ok(padding >= 8 && padding <= 0xffffffff, 'invalid MP4 padding size');
  const box = Buffer.alloc(8);
  box.writeUInt32BE(padding, 0);
  box.write('free', 4, 'ascii');
  const file = await open(target, 'r+');
  try {
    const written = await file.write(box, 0, box.length, size);
    assert.equal(written.bytesWritten, box.length);
    await file.truncate(bytes);
  } finally {
    await file.close();
  }
  assert.equal((await stat(target)).size, bytes);
}

/** Exact byte count, bounded allocations, known landmarks at three positions. */
export async function makeWindowedText(path: string): Promise<void> {
  const chunkBytes = MIB;
  const linesPerChunk = chunkBytes / TEXT_LINE_BYTES;
  const line = `${'x'.repeat(TEXT_LINE_BYTES - 1)}\n`;
  const chunk = Buffer.from(line.repeat(linesPerChunk), 'ascii');
  const file = await open(path, 'w');
  try {
    for (let offset = 0; offset < TEXT_BYTES; offset += chunkBytes) {
      for (const [position, marker] of [
        [0, TEXT_START],
        [TEXT_BYTES / 2, TEXT_MIDDLE],
        [TEXT_BYTES - TEXT_LINE_BYTES, TEXT_END],
      ] as const) {
        if (position >= offset && position < offset + chunkBytes) {
          chunk.write(marker, position - offset, 'ascii');
        }
      }
      const result = await file.write(chunk, 0, chunk.length, offset);
      assert.equal(
        result.bytesWritten,
        chunk.length,
        'short text fixture write'
      );
      chunk.fill(0x78);
      for (let n = TEXT_LINE_BYTES - 1; n < chunk.length; n += TEXT_LINE_BYTES)
        chunk[n] = 0x0a;
    }
  } finally {
    await file.close();
  }
  assert.equal((await stat(path)).size, TEXT_BYTES);
}

/** A playable referenced media member carries nearly the entire archive size. */
export async function makeLargeOtiod(
  base: string,
  directory: string,
  template: string
): Promise<string> {
  const bundle = join(directory, 'large.otiod');
  await mkdir(join(bundle, 'media'), { recursive: true });
  const doc = JSON.parse(await readFile(template, 'utf8')) as {
    tracks: {
      children: Array<{
        children: Array<{
          media_references: Record<string, { target_url: string }>;
        }>;
      }>;
    };
  };
  const track = doc.tracks.children[0];
  assert.ok(
    track && track.children[0],
    'OTIO template is missing its first clip'
  );
  const clip = track.children[0];
  const reference = clip.media_references['DEFAULT_MEDIA'];
  assert.ok(reference, 'OTIO template is missing its media reference');
  reference.target_url = 'media/large.mp4';
  track.children = [clip];
  doc.tracks.children = [track];
  await writeFile(join(bundle, 'content.otio'), JSON.stringify(doc));
  await writeFile(join(bundle, 'version.txt'), '1.0.0');
  await padVideo(base, join(bundle, 'media', 'large.mp4'), 498 * MIB);
  return bundle;
}

/** Two differently colored pages, separated by a sparse PDF whitespace gap. */
export async function makeLargePdf(path: string): Promise<void> {
  const offsets = [0];
  let prefix = '%PDF-1.4\n';
  const add = (body: string): void => {
    offsets.push(Buffer.byteLength(prefix));
    prefix += body;
  };
  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  add('2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n');
  add(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n'
  );
  const red = '1 0 0 rg 0 0 612 792 re f';
  add(
    `4 0 obj\n<< /Length ${red.length} >>\nstream\n${red}\nendstream\nendobj\n`
  );
  const page =
    '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>\nendobj\n';
  const blue = '0 0 1 rg 0 0 612 792 re f';
  const content = `6 0 obj\n<< /Length ${blue.length} >>\nstream\n${blue}\nendstream\nendobj\n`;
  const number = (value: number): string => String(value).padStart(10, '0');
  const suffix = (start: number): string => {
    const all = [...offsets, start, start + Buffer.byteLength(page)];
    const xref = start + Buffer.byteLength(page + content);
    return `${page}${content}xref\n0 7\n0000000000 65535 f \n${all
      .slice(1)
      .map((value) => `${number(value)} 00000 n \n`)
      .join(
        ''
      )}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${number(xref)}\n%%EOF\n`;
  };
  const position = PDF_BYTES - Buffer.byteLength(suffix(0));
  const ending = Buffer.from(suffix(position), 'ascii');
  assert.equal(position + ending.length, PDF_BYTES);
  assert.ok(position > Buffer.byteLength(prefix));
  const file = await open(path, 'w');
  try {
    const start = Buffer.from(prefix, 'ascii');
    assert.equal(
      (await file.write(start, 0, start.length, 0)).bytesWritten,
      start.length
    );
    assert.equal(
      (await file.write(ending, 0, ending.length, position)).bytesWritten,
      ending.length
    );
  } finally {
    await file.close();
  }
  assert.equal((await stat(path)).size, PDF_BYTES);
}

/** A valid 1px PNG with a large, ignored private ancillary chunk. */
export async function makeLargeImage(path: string): Promise<void> {
  const pngChunk = (name: string, data: Uint8Array): Buffer => {
    const chunk = Buffer.alloc(data.byteLength + 12);
    chunk.writeUInt32BE(data.byteLength, 0);
    chunk.write(name, 4, 'ascii');
    chunk.set(data, 8);
    chunk.writeUInt32BE(
      crc32(chunk.subarray(4, 8 + data.byteLength)),
      8 + data.byteLength
    );
    return chunk;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ancillary = pngChunk('raNd', Buffer.alloc(17 * MIB));
  const image = Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    ancillary,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(path, image);
  assert.ok((await stat(path)).size > 16 * MIB);
}

/** Valid OBJ prefix followed by text comments beyond the interactive limit. */
export async function makeLargeModel(path: string): Promise<void> {
  const size = 17 * MIB;
  const first = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'ascii');
  const block = Buffer.from(`# ${'x'.repeat(125)}\n`.repeat(8192), 'ascii');
  const file = await open(path, 'w');
  try {
    let offset = 0;
    const start = await file.write(first, 0, first.length, offset);
    assert.equal(start.bytesWritten, first.length);
    offset += first.length;
    while (offset < size) {
      const count = Math.min(block.length, size - offset);
      const written = await file.write(block, 0, count, offset);
      assert.equal(written.bytesWritten, count);
      offset += count;
    }
  } finally {
    await file.close();
  }
  assert.equal((await stat(path)).size, size);
}

/** Shared vertices keep the triangle-limit fixture below the byte limit. */
export async function makeTriangleLimitModel(path: string): Promise<void> {
  const source = `v 0 0 0\nv 1 0 0\nv 0 1 0\n${'f 1 2 3\n'.repeat(250_001)}`;
  await writeFile(path, source);
  assert.ok((await stat(path)).size < 16 * MIB);
}
