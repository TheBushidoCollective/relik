#!/usr/bin/env bun
/**
 * Captures the exact Bun executable used by this process, then qualifies only
 * the matching official release/profile pair for offline symbolization of the
 * saved Linux close stack. It never runs either downloaded executable.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const EXPECTED_BUN_VERSION = '1.3.14';
const EXPECTED_BUN_REVISION = '0d9b296af33f2b851fcbf4df3e9ec89751734ba4';
const RELEASE_METADATA_URL = `https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${EXPECTED_BUN_VERSION}`;
const REPORT_SCHEMA = 'relic-stdio-linux-symbol-identity-v1';
const RUNTIME_IDENTITY_SCHEMA = 'relic-stdio-linux-bun-runtime-identity-v1';
const OUTPUT_ROOT = resolve(
  process.env.STDIO_LINUX_SYMBOL_IDENTITY_OUT ??
    '.artifacts/stdio-linux-symbol-identity'
);
const HISTORICAL_PROVENANCE_DIR =
  process.env.STDIO_LINUX_HISTORICAL_PROVENANCE_DIR;
const READELF = process.env.STDIO_READELF ?? 'readelf';
const ADDR2LINE = process.env.STDIO_ADDR2LINE ?? 'addr2line';
const UNZIP = process.env.STDIO_UNZIP ?? 'unzip';

const STANDARD_ASSET_NAMES = [
  'bun-linux-x64.zip',
  'bun-linux-x64-baseline.zip',
  'bun-linux-x64-musl.zip',
  'bun-linux-x64-musl-baseline.zip',
] as const;

const HISTORICAL_RUN = {
  url: 'https://github.com/TheBushidoCollective/relik/actions/runs/39723814228',
  id: 39723814228,
  job_id: 119643075857,
  head: 'd6c3c2712ff360b354a9c03a51aec0ce521aba30',
  raw_trace_sha256:
    'e5b22f5d00cb66bbca400d7965d69c45a2093d8cbb57f084e468794fc03d7bf1',
  raw_trace_artifact: 'stdio-linux-full-test-trace-39723814228',
  first_successful_close: {
    trace_line: 304458,
    tid: 3697,
    child_pid: 4059,
    fd: 219,
    stream: 'stdout',
  },
} as const;

// This is deliberately retained as a negative identity receipt. The former
// value identifies mise, not Bun, because it came from resolving a mise shim.
const HISTORICAL_MISE_WITNESS = {
  recorded_command_path: '/home/runner/.local/share/mise/shims/bun',
  recorded_resolved_path: '/home/runner/.local/share/mise/bin/mise',
  recorded_sha256:
    '8d48bc510b7d844fad0bc7156c0855c2a1e7230c51e498a7f6b63b021f8b57c5',
  recorded_elf_build_id: 'e10fabbdbcbca867551315a571682226eb7d7b94',
  identity_subject: 'mise executable',
  relationship_to_bun: 'wrong_bun_identity',
  wrong_bun: true,
  preserved_historical_receipt: true,
} as const;

type SavedNativeFrame = {
  id: string;
  trace_line: number;
  file_offset: bigint;
  exported_symbol?: string;
  exported_symbol_offset?: bigint;
};

// The source trace's [0x...] values are ELF file offsets, not Bun's relative
// crash addresses. These are the Bun-native frames after the first successful
// stdout close and before the next syscall. Anonymous JSJITCode frames are
// intentionally absent.
const SAVED_NATIVE_FRAMES: readonly SavedNativeFrame[] = [
  {
    id: 'close-219-01',
    trace_line: 304459,
    file_offset: 0x3197d67n,
    exported_symbol: 'napi_internal_suppress_crash_on_abort_if_desired',
    exported_symbol_offset: 0x78377n,
  },
  {
    id: 'close-219-02',
    trace_line: 304460,
    file_offset: 0x3d26a5bn,
    exported_symbol: 'napi_remove_async_cleanup_hook',
    exported_symbol_offset: 0x44636bn,
  },
  {
    id: 'close-219-03',
    trace_line: 304461,
    file_offset: 0x50961efn,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xe658afn,
  },
  {
    id: 'close-219-04',
    trace_line: 304462,
    file_offset: 0x4c6eb85n,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xa3e245n,
  },
  {
    id: 'close-219-05',
    trace_line: 304463,
    file_offset: 0x4c6d07fn,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xa3c73fn,
  },
  {
    id: 'close-219-06',
    trace_line: 304464,
    file_offset: 0x361e8cdn,
    exported_symbol: 'napi_internal_enqueue_finalizer',
    exported_symbol_offset: 0x11d0edn,
  },
  {
    id: 'close-219-07',
    trace_line: 304465,
    file_offset: 0x3d28b3bn,
    exported_symbol: 'napi_remove_async_cleanup_hook',
    exported_symbol_offset: 0x44844bn,
  },
  {
    id: 'close-219-08',
    trace_line: 304466,
    file_offset: 0x33704b4n,
    exported_symbol: 'napi_internal_suppress_crash_on_abort_if_desired',
    exported_symbol_offset: 0x250ac4n,
  },
  {
    id: 'close-219-09',
    trace_line: 304467,
    file_offset: 0x336a6ebn,
    exported_symbol: 'napi_internal_suppress_crash_on_abort_if_desired',
    exported_symbol_offset: 0x24acfbn,
  },
  { id: 'close-219-10', trace_line: 304480, file_offset: 0x21b16c4n },
  {
    id: 'close-219-11',
    trace_line: 304481,
    file_offset: 0x5130082n,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xeff742n,
  },
  {
    id: 'close-219-12',
    trace_line: 304482,
    file_offset: 0x512e5bfn,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xefdc7fn,
  },
  {
    id: 'close-219-13',
    trace_line: 304483,
    file_offset: 0x5398233n,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0x11678f3n,
  },
  {
    id: 'close-219-14',
    trace_line: 304484,
    file_offset: 0x38c83ddn,
    exported_symbol: 'napi_internal_enqueue_finalizer',
    exported_symbol_offset: 0x3c6bfdn,
  },
  { id: 'close-219-15', trace_line: 304487, file_offset: 0x21b16c4n },
  {
    id: 'close-219-16',
    trace_line: 304488,
    file_offset: 0x4cf40b9n,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xac3779n,
  },
  {
    id: 'close-219-17',
    trace_line: 304489,
    file_offset: 0x4f7cca0n,
    exported_symbol: 'uv_wtf8_to_utf16',
    exported_symbol_offset: 0xd4c360n,
  },
  {
    id: 'close-219-18',
    trace_line: 304490,
    file_offset: 0x388f503n,
    exported_symbol: 'napi_internal_enqueue_finalizer',
    exported_symbol_offset: 0x38dd23n,
  },
  { id: 'close-219-19', trace_line: 304491, file_offset: 0x2340daen },
  { id: 'close-219-20', trace_line: 304492, file_offset: 0x24521adn },
] as const;

type ReleaseAsset = {
  id: number;
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
};

type ProgramSegment = {
  file_offset: bigint;
  virtual_address: bigint;
  file_size: bigint;
  memory_size: bigint;
  flags: number;
};

type Section = {
  name: string;
  file_offset: bigint;
  virtual_address: bigint;
  size: bigint;
};

type ElfLayout = {
  bits: number;
  little_endian: boolean;
  machine: number;
  executable_load_segments: ProgramSegment[];
  text: Section;
};

type CommandResult = {
  command: string;
  args: readonly string[];
  exit_code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type ReadelfReceipt = {
  header: string;
  program_headers: string;
  section_headers: string;
  notes: string;
  build_id: string;
};

type AssetReceipt = {
  id: number;
  name: string;
  browser_download_url: string;
  metadata_digest: string | null;
  expected_sha256: string;
  observed_sha256: string;
  metadata_size: number;
  observed_size: number;
  signature_verified: boolean;
  digest_source: string;
};

type SerializedProgramSegment = {
  file_offset: string;
  virtual_address: string;
  file_size: string;
  memory_size: string;
  flags: number;
};

type SerializedSection = {
  name: string;
  file_offset: string;
  virtual_address: string;
  size: string;
};

type ReleaseMetadata = {
  tag_name?: string;
  target_commitish?: string;
  assets?: ReleaseAsset[];
};

type RuntimeIdentity = {
  schema: string;
  subject: string;
  observed_in_process: {
    bun_version: string;
    bun_revision: string;
    node_compat_version: string;
    process_exec_path: string;
    process_exec_realpath: string;
    proc_self_exe_readlink: string;
    proc_self_exe_realpath: string;
  };
  actual_elf: {
    artifact_filename: string;
    magic: string;
    sha256: string;
    bytes: number;
    elf_layout: {
      bits: number;
      little_endian: boolean;
      machine: number;
      executable_load_segments: SerializedProgramSegment[];
      text: SerializedSection;
    };
    readelf: ReadelfReceipt;
  };
};

type RuntimeCapture = {
  bytes: Uint8Array;
  layout: ElfLayout;
  identity: RuntimeIdentity;
  runtimePath: string;
  readelf: ReadelfReceipt;
};

type QualifiedPair = {
  profilePath: string;
  profileLayout: ElfLayout;
  dynsym: string;
  profileReadelf: ReadelfReceipt;
};

class QualificationError extends Error {
  constructor(
    readonly code: string,
    readonly prerequisite: string,
    message: string
  ) {
    super(message);
    this.name = 'QualificationError';
  }
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function magic(value: Uint8Array): string {
  return Array.from(value.subarray(0, 4))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function relativeArtifactPath(path: string): string {
  return relative(OUTPUT_ROOT, path);
}

function boundedNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QualificationError(
      'elf_value_out_of_range',
      `A supported ELF layout with a safe ${label} is required.`,
      `${label} cannot be represented safely: ${hex(value)}`
    );
  }
  return Number(value);
}

function range(
  bytes: Uint8Array,
  offset: bigint,
  size: bigint,
  label: string
): Uint8Array {
  const numericOffset = boundedNumber(offset, `${label} offset`);
  const numericSize = boundedNumber(size, `${label} size`);
  const end = numericOffset + numericSize;
  if (numericOffset < 0 || numericSize < 0 || end > bytes.length) {
    throw new QualificationError(
      'elf_range_invalid',
      `A complete ELF ${label} range is required.`,
      `${label} range ${numericOffset}:${numericSize} lies outside ${bytes.length} bytes`
    );
  }
  return bytes.subarray(numericOffset, end);
}

function nullTerminatedString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function inspectElf(bytes: Uint8Array, label: string): ElfLayout {
  if (magic(bytes) !== '7f454c46') {
    throw new QualificationError(
      'elf_magic_missing',
      `An ELF executable is required for ${label}.`,
      `${label} does not begin with the ELF magic number`
    );
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new QualificationError(
      'elf_layout_unsupported',
      `A little-endian ELF64 ${label} is required.`,
      `${label} has ELF class ${bytes[4]} and encoding ${bytes[5]}`
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const programHeaderOffset = view.getBigUint64(32, true);
  const sectionHeaderOffset = view.getBigUint64(40, true);
  const programHeaderSize = view.getUint16(54, true);
  const programHeaderCount = view.getUint16(56, true);
  const sectionHeaderSize = view.getUint16(58, true);
  const sectionHeaderCount = view.getUint16(60, true);
  const sectionNameIndex = view.getUint16(62, true);

  if (programHeaderSize !== 56 || sectionHeaderSize !== 64) {
    throw new QualificationError(
      'elf_header_layout_unsupported',
      'A standard ELF64 program and section header layout is required.',
      `${label} has program header size ${programHeaderSize} and section header size ${sectionHeaderSize}`
    );
  }
  if (
    programHeaderCount === 0 ||
    programHeaderCount === 0xffff ||
    sectionHeaderCount === 0 ||
    sectionNameIndex === 0xffff
  ) {
    throw new QualificationError(
      'elf_extended_indices_unsupported',
      'ELF extended section/program header indices must be handled before symbolication.',
      `${label} uses an unsupported extended ELF header index`
    );
  }

  range(
    bytes,
    programHeaderOffset,
    BigInt(programHeaderSize) * BigInt(programHeaderCount),
    `${label} program header table`
  );
  range(
    bytes,
    sectionHeaderOffset,
    BigInt(sectionHeaderSize) * BigInt(sectionHeaderCount),
    `${label} section header table`
  );

  const executableLoadSegments: ProgramSegment[] = [];
  for (let index = 0; index < programHeaderCount; index += 1) {
    const base = boundedNumber(
      programHeaderOffset + BigInt(index * programHeaderSize),
      `${label} program header ${index}`
    );
    const type = view.getUint32(base, true);
    const flags = view.getUint32(base + 4, true);
    if (type !== 1 || (flags & 0x1) === 0) continue;
    executableLoadSegments.push({
      file_offset: view.getBigUint64(base + 8, true),
      virtual_address: view.getBigUint64(base + 16, true),
      file_size: view.getBigUint64(base + 32, true),
      memory_size: view.getBigUint64(base + 40, true),
      flags,
    });
  }
  if (executableLoadSegments.length === 0) {
    throw new QualificationError(
      'elf_executable_segment_missing',
      `An executable PT_LOAD segment is required for ${label}.`,
      `${label} has no executable PT_LOAD segment`
    );
  }

  if (sectionNameIndex >= sectionHeaderCount) {
    throw new QualificationError(
      'elf_section_name_table_missing',
      'A valid ELF section-name table is required.',
      `${label} section-name index ${sectionNameIndex} is outside ${sectionHeaderCount} sections`
    );
  }
  const sectionNameHeader = boundedNumber(
    sectionHeaderOffset + BigInt(sectionNameIndex * sectionHeaderSize),
    `${label} section-name header`
  );
  const sectionNames = range(
    bytes,
    view.getBigUint64(sectionNameHeader + 24, true),
    view.getBigUint64(sectionNameHeader + 32, true),
    `${label} section-name table`
  );

  let text: Section | undefined;
  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const base = boundedNumber(
      sectionHeaderOffset + BigInt(index * sectionHeaderSize),
      `${label} section header ${index}`
    );
    const nameOffset = view.getUint32(base, true);
    const name = nullTerminatedString(sectionNames, nameOffset);
    if (name !== '.text') continue;
    text = {
      name,
      virtual_address: view.getBigUint64(base + 16, true),
      file_offset: view.getBigUint64(base + 24, true),
      size: view.getBigUint64(base + 32, true),
    };
    break;
  }
  if (!text) {
    throw new QualificationError(
      'elf_text_section_missing',
      `A named .text section is required for ${label}.`,
      `${label} has no .text section`
    );
  }

  return {
    bits: 64,
    little_endian: true,
    machine: view.getUint16(18, true),
    executable_load_segments: executableLoadSegments,
    text,
  };
}

function serializeSegment(segment: ProgramSegment) {
  return {
    file_offset: hex(segment.file_offset),
    virtual_address: hex(segment.virtual_address),
    file_size: hex(segment.file_size),
    memory_size: hex(segment.memory_size),
    flags: segment.flags,
  };
}

function serializeSection(section: Section) {
  return {
    name: section.name,
    file_offset: hex(section.file_offset),
    virtual_address: hex(section.virtual_address),
    size: hex(section.size),
  };
}

function mapFileOffset(layout: ElfLayout, fileOffset: bigint, label: string) {
  const segment = layout.executable_load_segments.find((candidate) => {
    const end = candidate.file_offset + candidate.file_size;
    return fileOffset >= candidate.file_offset && fileOffset < end;
  });
  if (!segment) {
    throw new QualificationError(
      'file_offset_outside_executable_segment',
      `An executable PT_LOAD mapping for ${label} is required.`,
      `${label} file offset ${hex(fileOffset)} is outside every executable PT_LOAD segment`
    );
  }
  return {
    file_offset: fileOffset,
    segment,
    virtual_address:
      segment.virtual_address + (fileOffset - segment.file_offset),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array> | null
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array();
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function run(
  command: string,
  args: readonly string[]
): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readProcessStream(child.stdout),
    readProcessStream(child.stderr),
  ]);
  return { command, args, exit_code: exitCode, stdout, stderr };
}

async function captureCommand(
  label: string,
  command: string,
  args: readonly string[],
  directory: string
): Promise<CommandResult> {
  const result = await run(command, args);
  const stdoutPath = join(directory, `${label}.stdout.txt`);
  const stderrPath = join(directory, `${label}.stderr.txt`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(stdoutPath, result.stdout);
  writeFileSync(stderrPath, result.stderr);
  if (result.exit_code !== 0) {
    throw new QualificationError(
      'tool_failed',
      `${command} must successfully inspect the offline ELF files.`,
      `${command} ${args.join(' ')} exited ${result.exit_code}; see ${relativeArtifactPath(stderrPath)}`
    );
  }
  return result;
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function parseBuildId(notes: string, label: string): string {
  const match = notes.match(/\bBuild ID:\s*([0-9a-fA-F]+)/);
  if (!match) {
    throw new QualificationError(
      'elf_build_id_missing',
      `A GNU Build ID is required for ${label}.`,
      `${label} readelf notes contain no GNU Build ID`
    );
  }
  return match[1].toLowerCase();
}

async function captureReadelf(
  binary: string,
  directory: string,
  prefix: string
): Promise<ReadelfReceipt> {
  const header = await captureCommand(
    `${prefix}-readelf-hW`,
    READELF,
    ['-hW', binary],
    directory
  );
  const programHeaders = await captureCommand(
    `${prefix}-readelf-lW`,
    READELF,
    ['-lW', binary],
    directory
  );
  const sectionHeaders = await captureCommand(
    `${prefix}-readelf-SW`,
    READELF,
    ['-SW', binary],
    directory
  );
  const notes = await captureCommand(
    `${prefix}-readelf-nW`,
    READELF,
    ['-nW', binary],
    directory
  );
  const notesText = decode(notes.stdout);
  return {
    header: relativeArtifactPath(
      join(directory, `${prefix}-readelf-hW.stdout.txt`)
    ),
    program_headers: relativeArtifactPath(
      join(directory, `${prefix}-readelf-lW.stdout.txt`)
    ),
    section_headers: relativeArtifactPath(
      join(directory, `${prefix}-readelf-SW.stdout.txt`)
    ),
    notes: relativeArtifactPath(
      join(directory, `${prefix}-readelf-nW.stdout.txt`)
    ),
    build_id: parseBuildId(notesText, prefix),
  };
}

function releaseDigest(asset: ReleaseAsset): string {
  const match = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i);
  if (!match) {
    throw new QualificationError(
      'official_asset_digest_missing',
      `Official SHA-256 metadata for ${asset.name} is required.`,
      `The Bun release metadata has no usable SHA-256 digest for ${asset.name}`
    );
  }
  return match[1].toLowerCase();
}

function releaseAsset(
  release: { assets?: ReleaseAsset[] },
  name: string
): ReleaseAsset {
  const asset = release.assets?.find((candidate) => candidate.name === name);
  if (!asset) {
    throw new QualificationError(
      'official_asset_missing',
      `Official Bun release asset ${name} is required.`,
      `Bun v${EXPECTED_BUN_VERSION} metadata does not list ${name}`
    );
  }
  return asset;
}

function assetReceipt(
  asset: ReleaseAsset,
  observedSha256: string,
  observedSize: number
): AssetReceipt {
  return {
    id: asset.id,
    name: asset.name,
    browser_download_url: asset.browser_download_url,
    metadata_digest: asset.digest ?? null,
    expected_sha256: releaseDigest(asset),
    observed_sha256: observedSha256,
    metadata_size: asset.size,
    observed_size: observedSize,
    signature_verified: false,
    digest_source: 'official GitHub release asset metadata',
  };
}

async function downloadVerifiedAsset(
  asset: ReleaseAsset,
  destination: string
): Promise<{ bytes: Uint8Array; receipt: AssetReceipt }> {
  const response = await fetch(asset.browser_download_url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'relic-stdio-linux-symbol-identity',
    },
  });
  if (!response.ok) {
    throw new QualificationError(
      'official_asset_download_failed',
      `Official Bun asset ${asset.name} must be downloadable.`,
      `Downloading ${asset.name} returned ${response.status} ${response.statusText}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const observedSha256 = sha256(bytes);
  const receipt = assetReceipt(asset, observedSha256, bytes.length);
  if (bytes.length !== asset.size) {
    throw new QualificationError(
      'official_asset_size_mismatch',
      `Official Bun asset ${asset.name} must match its release metadata size.`,
      `${asset.name} has ${bytes.length} bytes, expected ${asset.size}`
    );
  }
  if (observedSha256 !== receipt.expected_sha256) {
    throw new QualificationError(
      'official_asset_digest_mismatch',
      `Official Bun asset ${asset.name} must match its release SHA-256 digest.`,
      `${asset.name} SHA-256 ${observedSha256} does not match ${receipt.expected_sha256}`
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return { bytes, receipt };
}

async function listZipEntries(
  archive: string,
  destination?: string
): Promise<string[]> {
  const result = destination
    ? await captureCommand(
        'zip-listing',
        UNZIP,
        ['-Z1', archive],
        dirname(destination)
      )
    : await run(UNZIP, ['-Z1', archive]);
  if (result.exit_code !== 0) {
    throw new QualificationError(
      'zip_listing_failed',
      `The verified archive ${basename(archive)} must be readable as ZIP.`,
      `${UNZIP} -Z1 ${archive} exited ${result.exit_code}`
    );
  }
  const entries = decode(result.stdout)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (destination) {
    writeFileSync(destination, result.stdout);
  }
  return entries;
}

function zipEntryByBasename(
  entries: readonly string[],
  expectedBasename: string,
  archive: string
): string {
  const candidates = entries.filter(
    (entry) => basename(entry) === expectedBasename
  );
  if (candidates.length !== 1) {
    throw new QualificationError(
      'zip_binary_entry_ambiguous',
      `Exactly one ${expectedBasename} entry is required in ${basename(archive)}.`,
      `${basename(archive)} contains ${candidates.length} entries named ${expectedBasename}`
    );
  }
  return candidates[0];
}

async function extractZipEntry(
  archive: string,
  entry: string,
  destination: string
): Promise<Uint8Array> {
  const result = await run(UNZIP, ['-p', archive, entry]);
  if (result.exit_code !== 0) {
    throw new QualificationError(
      'zip_extract_failed',
      `The verified ${basename(archive)} archive must expose ${entry}.`,
      `${UNZIP} -p ${archive} ${entry} exited ${result.exit_code}`
    );
  }
  writeFileSync(destination, result.stdout);
  return result.stdout;
}

function pairedProfileName(standardName: string): string {
  if (!standardName.endsWith('.zip')) {
    throw new QualificationError(
      'paired_profile_name_invalid',
      'A standard Bun ZIP asset is required to derive its paired profile asset.',
      `Cannot derive a profile asset from ${standardName}`
    );
  }
  return `${standardName.slice(0, -'.zip'.length)}-profile.zip`;
}

function readDynsymValue(output: string, symbol: string): bigint {
  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/, 8))
    .filter((fields) => fields.length >= 8)
    .filter((fields) => fields[3] === 'FUNC')
    .filter((fields) => fields.slice(7).join(' ') === symbol);
  if (candidates.length !== 1) {
    throw new QualificationError(
      'dynsym_symbol_missing',
      `Exactly one dynamic symbol named ${symbol} is required for arithmetic validation.`,
      `readelf --dyn-syms found ${candidates.length} matching FUNC symbols named ${symbol}`
    );
  }
  return BigInt(`0x${candidates[0][1]}`);
}

function isUsableSourceInfo(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length >= 2 &&
    !lines.some(
      (line) => line === '??' || line === '??:0' || line.startsWith('??:')
    )
  );
}

function walkFiles(root: string): string[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const files: string[] = [];
  for (const child of readdirSync(root)) {
    const path = join(root, child);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (stat.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function copyHistoricalMetadata(sourceDir: string | undefined) {
  const base = {
    status: 'not_retained',
    old_stack_attribution: 'candidate_layout_only',
    historical_run: HISTORICAL_RUN,
    mise_witness: HISTORICAL_MISE_WITNESS,
    inspected_directory: sourceDir ?? null,
    copied_metadata: [] as string[],
    original_elf: null as null | { artifact: string; sha256: string },
    claim_boundary:
      'A newly captured runtime ELF proves only the new job. It is never treated as the historical run ELF.',
  };
  if (!sourceDir || !existsSync(sourceDir)) {
    return {
      ...base,
      reason:
        'No recoverable historical artifact directory was available to inspect for a process-self Bun ELF receipt.',
    };
  }

  const files = walkFiles(sourceDir);
  const metadataFiles = files.filter((path) =>
    /\.(?:json|txt|sha256)$/i.test(path)
  );
  for (const path of metadataFiles) {
    const destination = join(
      OUTPUT_ROOT,
      'historical-provenance',
      relative(sourceDir, path)
    );
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
    base.copied_metadata.push(relativeArtifactPath(destination));
  }

  for (const path of files.filter(
    (candidate) => basename(candidate) === 'identity.json'
  )) {
    try {
      const identity = JSON.parse(readFileSync(path, 'utf8')) as {
        schema?: string;
        subject?: string;
        actual_elf?: { artifact_filename?: string; sha256?: string };
      };
      if (
        identity.schema !== RUNTIME_IDENTITY_SCHEMA ||
        identity.subject !== 'process-self' ||
        !identity.actual_elf?.artifact_filename ||
        !identity.actual_elf.sha256
      ) {
        continue;
      }
      const candidate = join(
        dirname(path),
        identity.actual_elf.artifact_filename
      );
      if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
      const bytes = new Uint8Array(readFileSync(candidate));
      if (
        magic(bytes) !== '7f454c46' ||
        sha256(bytes) !== identity.actual_elf.sha256
      )
        continue;
      const destination = join(
        OUTPUT_ROOT,
        'historical-provenance',
        'original-bun.elf'
      );
      copyFileSync(candidate, destination);
      return {
        ...base,
        status: 'recovered_from_process_self_artifact',
        original_elf: {
          artifact: relativeArtifactPath(destination),
          sha256: identity.actual_elf.sha256,
        },
        reason:
          'The prior artifact retained a process-self runtime ELF and matching immutable identity receipt.',
      };
    } catch {
      // A malformed history receipt must not become historical proof.
    }
  }

  return {
    ...base,
    reason:
      'Historical metadata was inspected, but it contains no process-self Bun ELF with a matching immutable identity receipt.',
  };
}

async function collectRuntimeIdentity(
  receipt: Record<string, unknown>
): Promise<RuntimeCapture> {
  // These are in-process observations. Do not replace them with a spawned
  // `readlink`: that would identify the child, not this Bun process.
  const procSelfExeReadlink = readlinkSync('/proc/self/exe');
  const procSelfExeRealpath = realpathSync('/proc/self/exe');
  const processExecRealpath = realpathSync(process.execPath);

  const actualBytes = new Uint8Array(readFileSync(procSelfExeRealpath));
  if (magic(actualBytes) !== '7f454c46') {
    throw new QualificationError(
      'runtime_elf_magic_missing',
      'The current Bun process must be backed by an ELF executable.',
      `${procSelfExeRealpath} has magic ${magic(actualBytes)}`
    );
  }
  const runtimePath = join(OUTPUT_ROOT, 'runtime', 'bun.runtime.elf');
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, actualBytes);
  const layout = inspectElf(actualBytes, 'current Bun runtime');
  const readelf = await captureReadelf(
    runtimePath,
    join(OUTPUT_ROOT, 'runtime'),
    'runtime'
  );
  const identity: RuntimeIdentity = {
    schema: RUNTIME_IDENTITY_SCHEMA,
    subject: 'process-self',
    observed_in_process: {
      bun_version: Bun.version,
      bun_revision: Bun.revision,
      node_compat_version: process.version,
      process_exec_path: process.execPath,
      process_exec_realpath: processExecRealpath,
      proc_self_exe_readlink: procSelfExeReadlink,
      proc_self_exe_realpath: procSelfExeRealpath,
    },
    actual_elf: {
      artifact_filename: 'bun.runtime.elf',
      magic: magic(actualBytes),
      sha256: sha256(actualBytes),
      bytes: actualBytes.length,
      elf_layout: {
        bits: layout.bits,
        little_endian: layout.little_endian,
        machine: layout.machine,
        executable_load_segments:
          layout.executable_load_segments.map(serializeSegment),
        text: serializeSection(layout.text),
      },
      readelf,
    },
  };
  writeJson(join(OUTPUT_ROOT, 'runtime', 'identity.json'), identity);
  receipt.runtime = identity;
  if (procSelfExeRealpath !== processExecRealpath) {
    throw new QualificationError(
      'runtime_path_disagrees',
      'The process executable path and /proc/self/exe must resolve to the same ELF.',
      `/proc/self/exe resolves to ${procSelfExeRealpath}, process.execPath resolves to ${processExecRealpath}`
    );
  }
  if (Bun.version !== EXPECTED_BUN_VERSION) {
    throw new QualificationError(
      'runtime_version_mismatch',
      `Bun ${EXPECTED_BUN_VERSION} is required for this saved-stack qualification.`,
      `This process reports Bun ${Bun.version}`
    );
  }
  if (Bun.revision !== EXPECTED_BUN_REVISION) {
    throw new QualificationError(
      'runtime_revision_mismatch',
      `Bun revision ${EXPECTED_BUN_REVISION} is required for this saved-stack qualification.`,
      `This process reports Bun revision ${Bun.revision}`
    );
  }
  return { bytes: actualBytes, layout, identity, runtimePath, readelf };
}

async function fetchReleaseMetadata(
  receipt: Record<string, unknown>
): Promise<ReleaseMetadata> {
  const response = await fetch(RELEASE_METADATA_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'relic-stdio-linux-symbol-identity',
    },
  });
  if (!response.ok) {
    throw new QualificationError(
      'release_metadata_fetch_failed',
      `Official Bun v${EXPECTED_BUN_VERSION} release metadata must be reachable.`,
      `Release metadata returned ${response.status} ${response.statusText}`
    );
  }
  const raw = await response.text();
  const metadataPath = join(
    OUTPUT_ROOT,
    'release',
    'bun-v1.3.14.release-metadata.json'
  );
  writeText(metadataPath, raw);
  const release = JSON.parse(raw) as ReleaseMetadata;
  if (release.tag_name !== `bun-v${EXPECTED_BUN_VERSION}`) {
    throw new QualificationError(
      'release_tag_mismatch',
      `Official metadata for Bun v${EXPECTED_BUN_VERSION} is required.`,
      `Release metadata reports tag ${release.tag_name ?? 'missing'}`
    );
  }
  if (release.target_commitish !== EXPECTED_BUN_REVISION) {
    throw new QualificationError(
      'release_revision_mismatch',
      `Official Bun metadata must target ${EXPECTED_BUN_REVISION}.`,
      `Release metadata targets ${release.target_commitish ?? 'missing'}`
    );
  }
  receipt.release_metadata = {
    artifact: relativeArtifactPath(metadataPath),
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    signature_verified: false,
    trust_boundary:
      'ZIP SHA-256 values come from official release asset metadata. No release signature claim is made.',
  };
  return release;
}

async function qualifyOfficialPair(
  release: ReleaseMetadata,
  runtime: RuntimeCapture,
  receipt: Record<string, unknown>
): Promise<QualifiedPair> {
  const scratch = mkdtempSync(join(tmpdir(), 'stdio-linux-symbol-identity-'));
  try {
    const candidateReceipts: Array<Record<string, unknown>> = [];
    receipt.standard_variant_candidates = candidateReceipts;
    let matched:
      | {
          asset: ReleaseAsset;
          archive: string;
          binary: Uint8Array;
          receipt: AssetReceipt;
          entry: string;
        }
      | undefined;

    for (const assetName of STANDARD_ASSET_NAMES) {
      const asset = releaseAsset(release, assetName);
      const archive = join(scratch, asset.name);
      const downloaded = await downloadVerifiedAsset(asset, archive);
      const entries = await listZipEntries(archive);
      const entry = zipEntryByBasename(entries, 'bun', archive);
      const binary = await extractZipEntry(
        archive,
        entry,
        join(scratch, `${asset.name}.bun`)
      );
      const candidate = {
        ...downloaded.receipt,
        archive_entry: entry,
        inner_bun_sha256: sha256(binary),
        inner_bun_magic: magic(binary),
        matches_runtime_elf_sha256:
          sha256(binary) === runtime.identity.actual_elf.sha256,
      };
      candidateReceipts.push(candidate);
      if (candidate.matches_runtime_elf_sha256) {
        matched = {
          asset,
          archive,
          binary,
          receipt: downloaded.receipt,
          entry,
        };
        break;
      }
    }
    if (!matched) {
      throw new QualificationError(
        'runtime_not_official_standard_variant',
        'The current Bun ELF SHA-256 must exactly match one verified official linux-x64 standard release asset.',
        `No verified official standard candidate matched ${runtime.identity.actual_elf.sha256}`
      );
    }

    const profileAsset = releaseAsset(
      release,
      pairedProfileName(matched.asset.name)
    );
    const profileArchiveScratch = join(scratch, profileAsset.name);
    const downloadedProfile = await downloadVerifiedAsset(
      profileAsset,
      profileArchiveScratch
    );
    const profileDirectory = join(OUTPUT_ROOT, 'profile');
    mkdirSync(profileDirectory, { recursive: true });
    const retainedProfileArchive = join(profileDirectory, profileAsset.name);
    copyFileSync(profileArchiveScratch, retainedProfileArchive);
    const downloadedProfileReceipt = {
      asset: downloadedProfile.receipt,
      retained_archive: relativeArtifactPath(retainedProfileArchive),
      signature_verified: false,
    };
    writeJson(
      join(profileDirectory, 'archive-receipt.json'),
      downloadedProfileReceipt
    );
    receipt.profile_download = downloadedProfileReceipt;
    const profileEntries = await listZipEntries(
      profileArchiveScratch,
      join(profileDirectory, 'zip-listing.txt')
    );
    const profileEntry = zipEntryByBasename(
      profileEntries,
      'bun-profile',
      profileArchiveScratch
    );
    const profilePath = join(profileDirectory, 'bun-profile.elf');
    const profileBytes = await extractZipEntry(
      profileArchiveScratch,
      profileEntry,
      profilePath
    );
    if (magic(profileBytes) !== '7f454c46') {
      throw new QualificationError(
        'profile_elf_magic_missing',
        'The matched official profile asset must contain an ELF bun-profile executable.',
        `${profileAsset.name}:${profileEntry} has magic ${magic(profileBytes)}`
      );
    }

    const profileLayout = inspectElf(
      profileBytes,
      'matched official bun-profile'
    );
    const profileReadelf = await captureReadelf(
      profilePath,
      profileDirectory,
      'profile'
    );
    const dynsym = await captureCommand(
      'profile-readelf-dynsym',
      READELF,
      ['--dyn-syms', '--wide', profilePath],
      profileDirectory
    );
    const dynsymPath = join(
      profileDirectory,
      'profile-readelf-dynsym.stdout.txt'
    );
    const runtimeText = range(
      runtime.bytes,
      runtime.layout.text.file_offset,
      runtime.layout.text.size,
      'runtime .text'
    );
    const profileText = range(
      profileBytes,
      profileLayout.text.file_offset,
      profileLayout.text.size,
      'profile .text'
    );
    const textAgreement = {
      runtime: serializeSection(runtime.layout.text),
      profile: serializeSection(profileLayout.text),
      virtual_address_matches:
        runtime.layout.text.virtual_address ===
        profileLayout.text.virtual_address,
      size_matches: runtime.layout.text.size === profileLayout.text.size,
      bytes_match: sameBytes(runtimeText, profileText),
      runtime_sha256: sha256(runtimeText),
      profile_sha256: sha256(profileText),
    };
    const buildIdsMatch = runtime.readelf.build_id === profileReadelf.build_id;
    if (
      !buildIdsMatch ||
      !textAgreement.virtual_address_matches ||
      !textAgreement.size_matches ||
      !textAgreement.bytes_match ||
      runtime.layout.machine !== profileLayout.machine
    ) {
      throw new QualificationError(
        'profile_pair_layout_mismatch',
        'The matched profile must preserve Build ID, ELF machine, .text VMA, .text size, and .text bytes.',
        `Profile pair agreement failed: build_id=${buildIdsMatch}, machine=${runtime.layout.machine === profileLayout.machine}, text_vma=${textAgreement.virtual_address_matches}, text_size=${textAgreement.size_matches}, text_bytes=${textAgreement.bytes_match}`
      );
    }

    const profileReceipt = {
      asset: downloadedProfile.receipt,
      retained_archive: relativeArtifactPath(retainedProfileArchive),
      archive_entry: profileEntry,
      archive_inner_sha256: sha256(profileBytes),
      build_id: profileReadelf.build_id,
      runtime_build_id: runtime.readelf.build_id,
      build_id_matches_runtime: buildIdsMatch,
      text_agreement: textAgreement,
      readelf: profileReadelf,
      dynsym: relativeArtifactPath(dynsymPath),
      signature_verified: false,
    };
    writeJson(join(profileDirectory, 'provenance.json'), profileReceipt);
    receipt.official_pair = {
      standard_asset: {
        ...matched.receipt,
        archive_entry: matched.entry,
        inner_bun_sha256: sha256(matched.binary),
      },
      profile_asset: profileReceipt,
      pair_status: 'qualified_for_offline_candidate_layout_symbolization',
      scope:
        'This pairs the current job runtime to an official release profile. It does not prove the historical run used these retained runtime bytes.',
    };
    return {
      profilePath,
      profileLayout,
      dynsym: decode(dynsym.stdout),
      profileReadelf,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function symbolizeSavedFrames(
  runtime: RuntimeCapture,
  pair: QualifiedPair,
  receipt: Record<string, unknown>
) {
  const symbolsDirectory = join(OUTPUT_ROOT, 'symbols');
  mkdirSync(symbolsDirectory, { recursive: true });
  const frames: Array<Record<string, unknown>> = [];
  for (const frame of SAVED_NATIVE_FRAMES) {
    const runtimeMapping = mapFileOffset(
      runtime.layout,
      frame.file_offset,
      frame.id
    );
    const profileMapping = mapFileOffset(
      pair.profileLayout,
      frame.file_offset,
      frame.id
    );
    if (runtimeMapping.virtual_address !== profileMapping.virtual_address) {
      throw new QualificationError(
        'profile_load_mapping_mismatch',
        `The runtime and matched profile must map ${frame.id} to the same VMA.`,
        `${frame.id} maps to ${hex(runtimeMapping.virtual_address)} in runtime and ${hex(profileMapping.virtual_address)} in profile`
      );
    }

    let dynsym: Record<string, string> | null = null;
    if (frame.exported_symbol && frame.exported_symbol_offset !== undefined) {
      const symbolVma = readDynsymValue(pair.dynsym, frame.exported_symbol);
      const expectedVma = symbolVma + frame.exported_symbol_offset;
      if (expectedVma !== profileMapping.virtual_address) {
        throw new QualificationError(
          'dynsym_offset_mismatch',
          `Dynamic-symbol arithmetic must resolve ${frame.id} to its mapped VMA.`,
          `${frame.exported_symbol}+${hex(frame.exported_symbol_offset)} = ${hex(expectedVma)}, mapped VMA is ${hex(profileMapping.virtual_address)}`
        );
      }
      dynsym = {
        name: frame.exported_symbol,
        symbol_vma: hex(symbolVma),
        trace_symbol_offset: hex(frame.exported_symbol_offset),
        computed_vma: hex(expectedVma),
      };
    }

    const vma = profileMapping.virtual_address;
    const vmaMinusOne = vma - 1n;
    const vmaResult = await captureCommand(
      `${frame.id}-vma`,
      ADDR2LINE,
      ['-e', pair.profilePath, '-f', '-C', '-i', hex(vma)],
      symbolsDirectory
    );
    const vmaMinusOneResult = await captureCommand(
      `${frame.id}-vma-minus-one`,
      ADDR2LINE,
      ['-e', pair.profilePath, '-f', '-C', '-i', hex(vmaMinusOne)],
      symbolsDirectory
    );
    const vmaSource = decode(vmaResult.stdout);
    const vmaMinusOneSource = decode(vmaMinusOneResult.stdout);
    if (
      !isUsableSourceInfo(vmaSource) ||
      !isUsableSourceInfo(vmaMinusOneSource)
    ) {
      throw new QualificationError(
        'symbol_source_missing',
        `Usable function and file:line output is required for both ${frame.id} VMA interpretations.`,
        `${frame.id} has unresolved addr2line output; see ${frame.id}-vma.stdout.txt and ${frame.id}-vma-minus-one.stdout.txt`
      );
    }

    frames.push({
      id: frame.id,
      source_trace_line: frame.trace_line,
      source_trace_kind: 'Bun native frame',
      file_offset: hex(frame.file_offset),
      runtime_mapping: {
        executable_pt_load: serializeSegment(runtimeMapping.segment),
        vma: hex(runtimeMapping.virtual_address),
      },
      profile_mapping: {
        executable_pt_load: serializeSegment(profileMapping.segment),
        vma: hex(profileMapping.virtual_address),
      },
      dynsym,
      addr2line: {
        vma: {
          input: hex(vma),
          output: relativeArtifactPath(
            join(symbolsDirectory, `${frame.id}-vma.stdout.txt`)
          ),
        },
        vma_minus_one: {
          input: hex(vmaMinusOne),
          output: relativeArtifactPath(
            join(symbolsDirectory, `${frame.id}-vma-minus-one.stdout.txt`)
          ),
        },
      },
    });
  }
  receipt.symbolization = {
    trace_address_interpretation:
      'strace -k bracket addresses are preserved as ELF file offsets and mapped only through the containing executable PT_LOAD: VMA = p_vaddr + (file_offset - p_offset).',
    source_trace: HISTORICAL_RUN,
    excluded_frames: {
      kind: 'anonymous JSJITCode',
      reason:
        'No anonymous JIT frame is symbolicated by this offline ELF/profile receipt.',
    },
    frame_count: frames.length,
    frames,
    caller_attribution:
      'No historical caller is asserted. These are candidate-layout interpretations only because the original historical Bun ELF bytes were not retained.',
  };
}

async function main() {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const receipt: Record<string, unknown> = {
    schema: REPORT_SCHEMA,
    status: 'running',
    mode: 'identity-and-offline-symbolization-only',
    started_at: new Date().toISOString(),
    saved_native_frame_inputs: SAVED_NATIVE_FRAMES.map((frame) => ({
      id: frame.id,
      source_trace_line: frame.trace_line,
      file_offset: hex(frame.file_offset),
      exported_symbol: frame.exported_symbol ?? null,
      exported_symbol_offset:
        frame.exported_symbol_offset === undefined
          ? null
          : hex(frame.exported_symbol_offset),
    })),
    policy: {
      no_new_full_trace: true,
      no_profile_execution: true,
      no_runtime_replacement: true,
      no_external_private_stack_upload: true,
      no_bun_crash_address_normalization: true,
      release_signature_existence_checked: false,
      release_signature_verified: false,
    },
  };

  try {
    receipt.historical_elf_identity = copyHistoricalMetadata(
      HISTORICAL_PROVENANCE_DIR
    );
    const runtime = await collectRuntimeIdentity(receipt);
    const release = await fetchReleaseMetadata(receipt);
    const pair = await qualifyOfficialPair(release, runtime, receipt);
    await symbolizeSavedFrames(runtime, pair, receipt);
    receipt.status = 'qualified_new_job_candidate_layout_only';
    receipt.completed_at = new Date().toISOString();
    receipt.conclusion =
      'The current job runtime is paired with an official profile for offline candidate-layout symbolization. The original historical Bun ELF was not retained, so this receipt does not identify the historical caller.';
  } catch (error) {
    const failure =
      error instanceof QualificationError
        ? {
            code: error.code,
            prerequisite: error.prerequisite,
            message: error.message,
          }
        : {
            code: 'unexpected_error',
            prerequisite:
              'The identity and offline symbolization collection must complete without an unexpected error.',
            message: error instanceof Error ? error.message : String(error),
          };
    receipt.status = 'blocked';
    receipt.completed_at = new Date().toISOString();
    receipt.blocker = failure;
    console.error(`${failure.code}: ${failure.message}`);
    process.exitCode = 1;
  } finally {
    writeJson(join(OUTPUT_ROOT, 'symbolization-receipt.json'), receipt);
  }
}

void main();
