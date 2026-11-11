import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFile,
  mkdtemp,
  realpath,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openNativeBundleRoot,
  type NativeBundleRoot,
} from '../src/native-secure-open.ts';

const CONTENT = 'native readInto bytes';
let scratch: string;
let root: NativeBundleRoot | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(await realpath(tmpdir()), 'relic-native-read-'));
});

afterEach(async () => {
  await root?.close();
  root = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function openContent(name = 'file.bin') {
  await writeFile(join(scratch, name), CONTENT);
  root = await openNativeBundleRoot(scratch);
  return root.openRegular(name);
}

describe('native readInto', () => {
  test('fills a Uint8Array of exactly the file size', async () => {
    const file = await openContent();
    try {
      const target = new Uint8Array(file.size);
      await file.readInto(target);
      expect(new TextDecoder().decode(target)).toBe(CONTENT);
    } finally {
      await file.close();
    }
  });

  test('fills a view in place and leaves the bytes around it untouched', async () => {
    const file = await openContent();
    try {
      const backing = new Uint8Array(file.size + 6).fill(0x21);
      await file.readInto(backing.subarray(3, 3 + file.size));
      expect(backing.subarray(0, 3)).toEqual(new Uint8Array(3).fill(0x21));
      expect(new TextDecoder().decode(backing.subarray(3, 3 + file.size))).toBe(
        CONTENT
      );
      expect(backing.subarray(3 + file.size)).toEqual(
        new Uint8Array(3).fill(0x21)
      );
    } finally {
      await file.close();
    }
  });

  test('refuses a target whose length differs from the file size', async () => {
    const file = await openContent();
    try {
      await expect(
        file.readInto(new Uint8Array(file.size - 1))
      ).rejects.toMatchObject({
        code: 'ERR_RELIC_NATIVE_SIZE_LIMIT',
      });
      await expect(
        file.readInto(new Uint8Array(file.size + 1))
      ).rejects.toMatchObject({
        code: 'ERR_RELIC_NATIVE_SIZE_LIMIT',
      });
    } finally {
      await file.close();
    }
  });

  test('refuses a DataView and an Int16Array', async () => {
    const file = await openContent();
    try {
      await expect(
        file.readInto(
          new DataView(new ArrayBuffer(file.size)) as unknown as Uint8Array
        )
      ).rejects.toMatchObject({ code: 'ERR_RELIC_NATIVE_INVALID_BUFFER' });
      await expect(
        file.readInto(new Int16Array(file.size) as unknown as Uint8Array)
      ).rejects.toMatchObject({ code: 'ERR_RELIC_NATIVE_INVALID_BUFFER' });
    } finally {
      await file.close();
    }
  });

  test('refuses a buffer detached by a transfer', async () => {
    const file = await openContent();
    try {
      const target = new Uint8Array(file.size);
      structuredClone(target.buffer, { transfer: [target.buffer] });
      await expect(file.readInto(target)).rejects.toMatchObject({
        code: 'ERR_RELIC_NATIVE_SIZE_LIMIT',
      });
    } finally {
      await file.close();
    }
  });

  test('refuses a file appended after it was opened', async () => {
    const file = await openContent();
    try {
      await appendFile(join(scratch, 'file.bin'), 'appended');
      await expect(
        file.readInto(new Uint8Array(file.size))
      ).rejects.toMatchObject({
        code: 'ERR_RELIC_NATIVE_FILE_CHANGED',
      });
    } finally {
      await file.close();
    }
  });

  test('refuses a file truncated after it was opened', async () => {
    const file = await openContent();
    try {
      await truncate(join(scratch, 'file.bin'), CONTENT.length - 1);
      await expect(
        file.readInto(new Uint8Array(file.size))
      ).rejects.toMatchObject({
        code: 'ERR_RELIC_NATIVE_FILE_CHANGED',
      });
    } finally {
      await file.close();
    }
  });
});
