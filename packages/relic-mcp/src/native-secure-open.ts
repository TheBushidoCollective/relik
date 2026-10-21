import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface NativeOpenedRegularFile {
  readonly size: number;
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface NativeBundleRoot {
  openRegular(relativePath: string): Promise<NativeOpenedRegularFile>;
  close(): Promise<void>;
}

type NativeSecureOpenErrorCode =
  | 'ERR_RELIC_NATIVE_UNSUPPORTED_PLATFORM'
  | 'ERR_RELIC_NATIVE_UNSUPPORTED_ARCH'
  | 'ERR_RELIC_NATIVE_UNSUPPORTED_LIBC'
  | 'ERR_RELIC_NATIVE_UNSUPPORTED_NAPI'
  | 'ERR_RELIC_NATIVE_PREBUILD_MISSING'
  | 'ERR_RELIC_NATIVE_LOAD_FAILED'
  | 'ERR_RELIC_NATIVE_ABI_MISMATCH';

interface NativeBindingFile {
  readonly size: unknown;
  read(maxBytes: number): unknown;
  close(): unknown;
}

interface NativeBindingRoot {
  openRegular(relativePath: string): unknown;
  close(): unknown;
}

interface NativeSecureOpenBinding {
  readonly abiVersion: unknown;
  openBundleRoot(path: string): unknown;
}

interface ProcessReportHeader {
  readonly glibcVersionRuntime?: unknown;
}

interface ProcessReport {
  getReport(): { readonly header?: ProcessReportHeader };
}

const nativeRequire = createRequire(import.meta.url);
let loadedBinding: NativeSecureOpenBinding | undefined;

function nativeError(
  code: NativeSecureOpenErrorCode,
  message: string,
  cause?: unknown
): Error & { code: NativeSecureOpenErrorCode } {
  const error = new Error(message) as Error & {
    code: NativeSecureOpenErrorCode;
  };
  Object.defineProperty(error, 'code', {
    configurable: false,
    enumerable: true,
    value: code,
    writable: false,
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', {
      configurable: false,
      enumerable: false,
      value: cause,
      writable: false,
    });
  }
  return error;
}

function requireNodeApiVersion(): void {
  const rawVersion = process.versions.napi;
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 8) {
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_NAPI',
      `native secure-open requires Node-API 8 or newer (runtime reports ${rawVersion ?? 'none'})`
    );
  }
}

function requireGlibc228(): void {
  const report = (process as typeof process & { report?: ProcessReport })
    .report;
  let glibcVersion: unknown;

  try {
    glibcVersion = report?.getReport().header?.glibcVersionRuntime;
  } catch (cause) {
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_LIBC',
      'native secure-open requires a glibc 2.28+ runtime report',
      cause
    );
  }

  if (typeof glibcVersion !== 'string') {
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_LIBC',
      'native secure-open supports Linux only with glibc 2.28+; this runtime did not report glibc'
    );
  }

  const match = /^(\d+)\.(\d+)/.exec(glibcVersion);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_LIBC',
      `native secure-open could not parse the runtime glibc version (${glibcVersion})`
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 2 ||
    (major === 2 && minor < 28)
  ) {
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_LIBC',
      `native secure-open requires glibc 2.28+ (runtime reports ${glibcVersion})`
    );
  }
}

function selectPrebuildTarget(): string {
  requireNodeApiVersion();

  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'darwin-arm64';
    if (process.arch === 'x64') return 'darwin-x64';
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_ARCH',
      `native secure-open has no Darwin prebuild for ${process.arch}`
    );
  }

  if (process.platform === 'linux') {
    requireGlibc228();
    if (process.arch === 'arm64') return 'linux-arm64-gnu';
    if (process.arch === 'x64') return 'linux-x64-gnu';
    throw nativeError(
      'ERR_RELIC_NATIVE_UNSUPPORTED_ARCH',
      `native secure-open has no Linux prebuild for ${process.arch}`
    );
  }

  throw nativeError(
    'ERR_RELIC_NATIVE_UNSUPPORTED_PLATFORM',
    `native secure-open supports only darwin and linux (runtime reports ${process.platform})`
  );
}

function assertBinding(value: unknown): NativeSecureOpenBinding {
  if (typeof value !== 'object' || value === null) {
    throw nativeError(
      'ERR_RELIC_NATIVE_ABI_MISMATCH',
      'native secure-open prebuild does not expose ABI version 1'
    );
  }
  const binding = value as {
    abiVersion?: unknown;
    openBundleRoot?: unknown;
  };
  if (
    binding.abiVersion !== 1 ||
    typeof binding.openBundleRoot !== 'function'
  ) {
    throw nativeError(
      'ERR_RELIC_NATIVE_ABI_MISMATCH',
      'native secure-open prebuild does not expose ABI version 1'
    );
  }
  return binding as NativeSecureOpenBinding;
}

function assertRoot(value: unknown): NativeBindingRoot {
  if (typeof value !== 'object' || value === null) {
    throw nativeError(
      'ERR_RELIC_NATIVE_ABI_MISMATCH',
      'native secure-open returned an invalid root handle'
    );
  }
  const root = value as {
    close?: unknown;
    openRegular?: unknown;
  };
  if (
    typeof root.openRegular !== 'function' ||
    typeof root.close !== 'function'
  ) {
    throw nativeError(
      'ERR_RELIC_NATIVE_ABI_MISMATCH',
      'native secure-open returned an invalid root handle'
    );
  }
  return root as NativeBindingRoot;
}

function assertFile(value: unknown): NativeBindingFile {
  if (typeof value !== 'object' || value === null) {
    throw nativeError(
      'ERR_RELIC_NATIVE_ABI_MISMATCH',
      'native secure-open returned an invalid file handle'
    );
  }
  const file = value as {
    close?: unknown;
    read?: unknown;
    size?: unknown;
  };
  if (
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.read !== 'function' ||
    typeof file.close !== 'function'
  ) {
    throw nativeError(
      'ERR_RELIC_NATIVE_ABI_MISMATCH',
      'native secure-open returned an invalid file handle'
    );
  }
  return file as NativeBindingFile;
}

function loadBinding(): NativeSecureOpenBinding {
  if (loadedBinding !== undefined) return loadedBinding;

  const target = selectPrebuildTarget();
  const prebuildUrl = new URL(
    `../prebuilds/${target}/secure_open.node`,
    import.meta.url
  );
  const prebuildPath = fileURLToPath(prebuildUrl);

  if (!existsSync(prebuildPath)) {
    throw nativeError(
      'ERR_RELIC_NATIVE_PREBUILD_MISSING',
      `native secure-open prebuild is missing for ${target}`
    );
  }

  let candidate: unknown;
  try {
    candidate = nativeRequire(prebuildPath);
  } catch (cause) {
    throw nativeError(
      'ERR_RELIC_NATIVE_LOAD_FAILED',
      `native secure-open prebuild could not load for ${target}`,
      cause
    );
  }

  loadedBinding = assertBinding(candidate);
  return loadedBinding;
}

function wrapFile(file: NativeBindingFile): NativeOpenedRegularFile {
  const size = file.size as number;

  return Object.freeze({
    get size(): number {
      return size;
    },
    async read(maxBytes: number): Promise<Uint8Array> {
      const bytes = file.read(maxBytes);
      if (!(bytes instanceof Uint8Array)) {
        throw nativeError(
          'ERR_RELIC_NATIVE_ABI_MISMATCH',
          'native secure-open read did not return a Uint8Array'
        );
      }
      return bytes;
    },
    async close(): Promise<void> {
      file.close();
    },
  });
}

export async function openNativeBundleRoot(
  path: string
): Promise<NativeBundleRoot> {
  const root = assertRoot(loadBinding().openBundleRoot(path));

  return Object.freeze({
    async openRegular(relativePath: string): Promise<NativeOpenedRegularFile> {
      return wrapFile(assertFile(root.openRegular(relativePath)));
    },
    async close(): Promise<void> {
      root.close();
    },
  });
}
