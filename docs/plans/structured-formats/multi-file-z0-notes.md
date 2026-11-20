# Z0 ZIP producer spike

Base: origin/main `500ddba267c2d9fe73a645e94916c494ceef8de6`.

## Shared API decision

`indexZip` returns `Promise<{ ok: true; index: ZipIndex } | { ok: false; reason: ZipRefusalReason; message: string }>`. `ZipIndex.read(name)` returns `Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: ZipRefusalReason; message: string }>`. `entries` is a `ReadonlyMap<string, ZipEntryInfo>`.

`ZipRefusalReason` is the closed union `encrypted | zip64 | multi-disk | duplicate | unsafe-name | bad-name-encoding | too-many-entries | directory-too-large | entry-too-large | total-too-large | crc-mismatch | size-mismatch | unsupported-method | not-a-file | corrupt`. Throws are reserved for programmer misuse. OTIO retains its existing throwing API by translating these results. This is the settled owner decision; it supersedes the throwing return types in PlanBandC section 5.2.

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

Finder, Windows Explorer, 7-Zip, GitHub Download ZIP, and Google Drive archives were not produced or sampled. This local set cannot establish the spec's cross-producer refusal rate. The counts above are a central-directory inspection, not a result from the new indexer.
