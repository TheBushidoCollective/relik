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
