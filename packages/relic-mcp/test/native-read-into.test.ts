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
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  openNativeBundleRoot,
  type NativeBundleRoot,
} from '../src/native-secure-open.ts';

/** The raw prebuild's file handle, before the JavaScript wrapper checks it. */
interface RawFile {
  readonly size: number;
  readInto(...args: unknown[]): void;
  close(): void;
}

interface RawBinding {
  openBundleRoot(path: string): RawRoot;
}

interface RawRoot {
  openRegular(relativePath: string): RawFile;
  close(): void;
}

const nativeRequire = createRequire(import.meta.url);

const CONTENT = 'native readInto bytes';
let scratch: string;
let root: NativeBundleRoot | undefined;
let rawRoot: RawRoot | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(await realpath(tmpdir()), 'relic-native-read-'));
  await writeFile(join(scratch, 'file.bin'), CONTENT);
});

afterEach(async () => {
  await root?.close();
  root = undefined;
  rawRoot?.close();
  rawRoot = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function openContent(name = 'file.bin') {
  await writeFile(join(scratch, name), CONTENT);
  root = await openNativeBundleRoot(scratch);
  return root.openRegular(name);
}

/** The prebuild target for this host, by the same convention as src/native-secure-open.ts. */
function prebuildTarget(): string {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'darwin-arm64';
    if (process.arch === 'x64') return 'darwin-x64';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'linux-arm64-gnu';
    if (process.arch === 'x64') return 'linux-x64-gnu';
  }
  throw new Error(
    `no native secure-open prebuild for ${process.platform}-${process.arch}`
  );
}

function openRaw(name = 'file.bin'): RawFile {
  // Load the real prebuild directly so the native gates run, not the wrapper.
  const prebuildPath = fileURLToPath(
    new URL(
      `../prebuilds/${prebuildTarget()}/secure_open.node`,
      import.meta.url
    )
  );
  const binding: RawBinding = nativeRequire(prebuildPath);
  rawRoot = binding.openBundleRoot(scratch);
  return rawRoot.openRegular(name);
}

/** The thrown error's code, or undefined when the call returns or the error has none. */
function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      return typeof error.code === 'string' ? error.code : undefined;
    }
  }
  return undefined;
}

describe('native readInto through the wrapper', () => {
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

  test('refuses a DataView and an Int16Array before the native call', async () => {
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

describe('native readInto raw gate', () => {
  test('fills a Uint8Array of the file size with one argument', () => {
    const file = openRaw();
    try {
      const target = new Uint8Array(file.size);
      expect(file.readInto(target)).toBeUndefined();
      expect(new TextDecoder().decode(target)).toBe(CONTENT);
    } finally {
      file.close();
    }
  });

  test('refuses zero, two, and three arguments', () => {
    const file = openRaw();
    try {
      const target = new Uint8Array(file.size);
      expect(thrownCode(() => file.readInto())).toBe(
        'ERR_RELIC_NATIVE_INVALID_BUFFER'
      );
      expect(thrownCode(() => file.readInto(target, target))).toBe(
        'ERR_RELIC_NATIVE_INVALID_BUFFER'
      );
      expect(thrownCode(() => file.readInto(target, 0, 0))).toBe(
        'ERR_RELIC_NATIVE_INVALID_BUFFER'
      );
      // A refused call must not have written into the target.
      expect(target).toEqual(new Uint8Array(file.size));
    } finally {
      file.close();
    }
  });

  test('refuses every non-Uint8Array typed array, DataView, ArrayBuffer, and plain array', () => {
    const file = openRaw();
    try {
      const size = file.size;
      const wrong: Array<[string, unknown]> = [
        ['DataView', new DataView(new ArrayBuffer(size))],
        ['ArrayBuffer', new ArrayBuffer(size)],
        ['Int8Array', new Int8Array(size)],
        ['Int16Array', new Int16Array(size)],
        ['Uint16Array', new Uint16Array(size)],
        ['Uint8ClampedArray', new Uint8ClampedArray(size)],
        ['Float64Array', new Float64Array(size)],
        ['plain array', new Array(size).fill(0)],
      ];
      for (const [label, target] of wrong) {
        expect(
          thrownCode(() => file.readInto(target)),
          label
        ).toBe('ERR_RELIC_NATIVE_INVALID_BUFFER');
      }
    } finally {
      file.close();
    }
  });

  test('refuses a detached transferred buffer as a length mismatch', () => {
    const file = openRaw();
    try {
      const target = new Uint8Array(file.size);
      structuredClone(target.buffer, { transfer: [target.buffer] });
      // A detached view reports length 0, so the size check refuses it first.
      expect(target.length).toBe(0);
      expect(thrownCode(() => file.readInto(target))).toBe(
        'ERR_RELIC_NATIVE_SIZE_LIMIT'
      );
    } finally {
      file.close();
    }
  });
});
