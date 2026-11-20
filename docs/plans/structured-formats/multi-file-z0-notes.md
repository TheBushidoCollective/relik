# Z0 ZIP producer spike

Base: origin/main `500ddba267c2d9fe73a645e94916c494ceef8de6`.

## Shared API decision

`indexZip` returns `Promise<{ ok: true; index: ZipIndex } | { ok: false; reason: ZipRefusalReason; message: string }>`. `ZipIndex.read(name)` returns `Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: ZipRefusalReason; message: string }>`. `entries` is a `ReadonlyMap<string, ZipEntryInfo>`.

`ZipRefusalReason` is the closed union `encrypted | zip64 | multi-disk | duplicate | unsafe-name | bad-name-encoding | too-many-entries | directory-too-large | entry-too-large | total-too-large | crc-mismatch | size-mismatch | unsupported-method | not-a-file | corrupt`. Throws are reserved for programmer misuse. OTIO retains its existing throwing API by translating these results. This is the settled owner decision; it supersedes the throwing return types in PlanBandC section 5.2.

## Extraction plan

1. Move the EOCD search, ZIP signatures, range validation and central-directory census into the general index.
2. Move ZIP64, multi-disk, encryption, compression-method and UTF-8 checks into that index.
3. Move canonical ZIP path checks, duplicate detection and extent overlap checks into that index.
4. Classify file, directory and symlink entries there; refuse other special types.
5. Enforce per-call archive, directory, entry-count, entry-size and total-size bounds before reading payloads.
6. Move bounded inflation, CRC32 and exact-length checks into the general index's file reader.
7. Return named refusal values from the general index and preserve the existing range-reader interface.
8. Keep OTIO detection, reserved names, version validation, document size and symlink refusal in `otio-zip.ts`.
9. Keep OTIO media path rules, streaming stored-entry hashing, digest caching and legacy error translation there.
10. Exercise the general index with adversarial fixtures, then retain unchanged OTIO tests and path proof.

Twenty locally generated archives were examined by reading their central directory records: seven from macOS `zip -r -y`, seven from `ditto -c -k --sequesterRsrc --keepParent`, and six from Python `shutil.make_archive`. Each contained a nested directory, ASCII and UTF-8 filenames, and short text files. Five source directories also contained a symlink. These are small synthetic samples, not representative evidence of all producer defaults.

| Measure | Count |
| --- | ---: |
| Archives | 20 |
| Central directory entries | 116 |
| Archives with ZIP64 records or extra fields | 0 |
| Entry names that fail UTF-8 decoding | 0 |
| Symlink entries | 4 |
| Entries with data descriptor flag | 37 |
| Entries under `__MACOSX/` | 44 |

`ditto` emitted the data descriptor flags and `__MACOSX` entries. The Python archives did not preserve the one symlink presented to that producer as a symlink entry. The other four symlinks were preserved by `zip` or `ditto`.

Finder, Windows Explorer, 7-Zip, GitHub Download ZIP, and Google Drive archives were not produced or sampled. This local set cannot establish the spec's cross-producer refusal rate. The counts above came from central-directory inspection. The new indexer accepted all 20 archives with the same entry counts, and read and CRC-verified all 64 regular entries.

## OTIO path observation

The unchanged OTIO and ZIP unit suites passed 54 tests with 239 assertions. The owned headless `otio-path` failed twice on this branch at `scheduled-pcm-48000`, with four interrupted attempts per run. Reported failures included `audio output clock not ready before ring sizing (cancel underflow)` and `no causal audio epoch inside the certified video phase intersection`.

A fresh, separately built origin/main `c1a2ae62` using the identical command, owned shell and environment also failed at `scheduled-pcm-48000` on all four attempts with the same audio-clock and causal-epoch errors. The baseline worktree was removed. The OTIO path is not proven locally; the `otio-headless-smoke-macos` CI job must prove it on the integration PR. That CI job has not run for this branch.

## Baseline OTIO ZIP error inventory

Source: `origin/main:packages/relic-format/src/otio-zip.ts`, lines shown below. Templates preserve interpolation names from the source. `C`, `U`, and `D` mean `OtioZipError` codes `corrupt-archive`, `unsupported-zip`, and `decompression-limit`; `L` means `ContentTooLargeError` with no OTIO code. Repeated sites with the same template are grouped.

| Baseline line(s) | Class/code | Message template |
| --- | --- | --- |
| 296 | C | `ZIP range is outside the archive` |
| 303 | C | `ZIP source returned an incomplete range` |
| 373 | C | `ZIP entry name is not valid UTF-8 in ${where}` |
| 387, 401 | C | `Truncated extra field: ${label}` |
| 393 | U | `ZIP64 extended information is not supported: ${label}` |
| 410 | C | `NUL in ZIP entry name prohibited` |
| 420 | C | `Absolute paths in archive prohibited: ${rawName}` |
| 427 | C | `Path traversal (..) prohibited: ${rawName}` |
| 434 | C | `Invalid ZIP entry path: ${rawName}` |
| 448 | U | `ZIP64 sentinel ${field} is not supported` |
| 484 | C | `Invalid inflation bounds` |
| 487 | D | `Decompressed size ${uncompressedSize} exceeds max limit of ${maxBytes} bytes` |
| 494 | U | `No DecompressionStream available; caller must supply a custom inflater` |
| 536, 547 | D | `Streamed decompressed bytes exceeded limit of ${maxBytes}` |
| 564 | C | `Browser DecompressionStream failed: ${String(err)}` |
| 614 | C | `Invalid ZIP size or limits` |
| 617 | L | `content is ${source.size} bytes, over the ${maxArchive} cap` |
| 623, 639 | C | `End of Central Directory record not found` |
| 656 | U | `ZIP64 sentinel in the end of central directory is not supported` |
| 663 | U | `Multi-disk ZIP archives are not supported` |
| 670 | C | `Central directory points beyond end of archive` |
| 684 | U | `ZIP64 end of central directory locator is not supported` |
| 691 | C | `Central directory extent does not end at the end of central directory record` |
| 697 | U | `Central directory exceeds the size limit` |
| 719 | C | `Truncated central directory entry` |
| 727 | C | `Invalid central directory signature at ${cursor}` |
| 735 | U | `Encrypted ZIP entries are strictly prohibited` |
| 743 | U | `Unsupported compression method: ${method} (only 0 STORED and 8 DEFLATE allowed)` |
| 759 | C | `Central directory entry extends past declared extent` |
| 783 | C | `Non-regular file type in ZIP entry prohibited: ${rawName}` |
| 792 | C | `Duplicate entry name: ${normName}` |
| 800 | C | `STORED entry sizes disagree: ${rawName}` |
| 808 | D | `Aggregate uncompressed size ${aggregateUncompressed} exceeds cap of ${maxLimit} bytes` |
| 816 | D | `Aggregate DEFLATE size ${aggregateInflated} exceeds cap of ${maxInflated} bytes` |
| 823 | D | `content.otio exceeds ${OTIO_DOCUMENT_MAX_BYTES} bytes` |
| 830 | C | `Local header offset beyond archive` |
| 847 | C | `Invalid local header signature` |
| 861 | C | `Mismatched flags in local header: ${rawName}` |
| 871 | C | `Mismatched compression method in local header: ${rawName}` |
| 878 | C | `Mismatched CRC in local header: ${rawName}` |
| 884 | C | `Mismatched compressed size in local header: ${rawName}` |
| 890 | C | `Mismatched uncompressed size in local header: ${rawName}` |
| 898 | C | `Local header name extends beyond archive: ${rawName}` |
| 905 | C | `Local header extends beyond archive: ${rawName}` |
| 918 | C | `Local and central directory filenames disagree: ${rawName}` |
| 930 | C | `File data extends beyond archive: ${rawName}` |
| 940 | C | `File data overlaps central directory: ${rawName}` |
| 968 | C | `Central directory census did not consume the declared extent` |
| 981 | C | `ZIP entries overlap: ${current.name}` |
| 1004 | D | `Entry ${entry.name} is too large to materialize` |
| 1034 | C | `STORED length ${slice.length} does not match expected ${entry.uncompressedSize}` |
| 1054 | C | `Decompressed length ${decompressed.length} does not match expected ${entry.uncompressedSize}` |
| 1062, 1130 | C | `CRC32 mismatch on ${entry.name}: expected ${entry.crc32.toString(16)}, got ${computedCrc.toString(16)}` (stored scan uses `${actual.toString(16)}`) |
| 1077, 1109, 1144 | C | `Entry not found in archive: ${name}` |
| 1115 | U | `Entry is not STORED: ${name}` |
| 1180 | C | `Invalid version.txt content: ${versionText} (expected 1.0.0)` |

There are 56 grouped message rows. The differential fixtures exercise 52 reachable rows, comparing the error class, OTIO code where present, and exact message. Four rows are defensive invariants under an immutable source and the public API: line 296 receives only ranges already bounded by the parser; lines 484 and 487 cannot fire because the default inflater is called with the validated declared size as both length and cap; line 1034 cannot fire because the checked range reader has already verified its length and STORED sizes agree at indexing. Line 639 repeats line 623's message but cannot independently fire: the EOCD search already verified the same signature. These guards remain inventoried rather than claiming a fabricated fixture.
