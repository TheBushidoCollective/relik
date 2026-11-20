# Multi-file relics: dispatch spec

Written against origin/main 5cbd626c (checkout used: /Users/jwaldrip/checkouts/multifile-plan-main). Line numbers are from that commit unless a branch is named. Read-only planning: nothing was edited, built or run.

Contents: 0 risks and calls for Jason; 1 envelope v2; 2 contracts for every single-file assumption; 3 relic-mcp inputs; 4 viewer; 5 shared contracts, spikes, slices, proof, release order; 6 fit with PlanBandC; 7 what would prove this wrong.

---

## Settled by Jason (2026-11-20)

These are decisions, not proposals. Every section below that offers an alternative is superseded by the choice here.

- **Folder relics and the link marker (J1): B.** Every public link keeps `#r1`. The version byte inside the encrypted content says whether a relic is one file or a folder, so any relic can change between the two on republish under the same link. Slice S0 (the page requests its scripts by build number, so a stale service worker cannot serve an old viewer) deploys before anything else. Section 1.8's option-A changes do not apply.
- **Publishing a `.zip` (J2): expand by default.** `relic_publish` expands a zip into a folder relic; `expand: false` keeps today's one-opaque-file behaviour. `relic_republish` keeps the shape the relic already has.
- **The browser `/publish` page (J3): stays single-file this round.** It refuses folders and publishes a `.zip` as one download.
- **Earlier decisions, unchanged:** a true multi-entry envelope (not a zip as the container); a file tree plus the normal viewer for each file; Markdown links and images that point at other files in the same relic resolve; HTML, JSX and SVG entries open one at a time in the sandbox with no sibling loading; a folder publish follows `.gitignore`, always skips `.git`, `node_modules`, symlinks and anything outside the folder, reports what was left out, and refuses if everything would be excluded.
- **Homepage:** the reader slice adds the `folder` registry row in the same PR (the guard test requires it).

## 0. Read first

### 0.1 The flaw in "format version 2" as the format spec defines versions (Jason's call, J1)

**What the spec says today.**

- A public link is `#r1<key>`: a fixed marker plus the key (`format.md` 2.1; `fragment.ts:16-19`, `FORMAT_VERSION = 1`, `VERSION_MARKER = 'r1'`).
- "One version number governs the whole envelope, fragment and container together. There's no second, independent container version." (`format.md` 2.2).
- The viewer refuses an object whose envelope version differs from the marker (`format.md` 3.7; `envelope.ts:151-153` throws `VersionMismatchError`). The reader sees "This relic does not match its link. The format version inside the file disagrees with the one in the link. The link may have been altered." (`viewer.ts:835-843`).
- A public republish reuses the relic key and the link; the link never changes (`format.md` 3.10, 3.12).

**Consequence.** If multi-file relics are "format version 2" in that sense, they need a new marker (`r2`). A link already handed out carries `r1` forever, so:

- no existing public relic can ever become multi-file under its link;
- a republish can never change a relic's format in either direction (a v2 object behind an `r1` link is refused as "the link may have been altered");
- an old relic-mcp republishing a single file into an `r2` relic writes a v1 object behind an `r2` link, which every viewer then refuses.

Two ways to build Jason's choice:

| | A. New marker, format fixed per relic | B. Marker names the framing; envelope version lives inside the AEAD |
|---|---|---|
| Link of a folder relic | `#r2<key>` | `#r1<key>`, as today |
| Existing relic becomes a folder by republish | Refused; a new link is needed | Allowed; same link |
| Folder relic republished as one file | One-entry v2 | v1 object; same link |
| Spec change | 2.1 adds `r2` | 2.2 and 3.7 amended: `r1` admits envelope versions 1 and 2 |
| A viewer older than the deploy | Refuses before fetching: "This relic uses a newer format" (`viewer.ts:515-521`) | Fetches, then refuses: "This relic does not match its link... may have been altered" |
| Old relic-mcp reading a v2 object | Fails closed (version mismatch) | Same |
| Old relic-mcp republishing into a folder relic | Writes v1 behind `r2`: broken link | Writes v1: valid; the relic becomes one file |
| Local state | Records each relic's format and refuses switches | Records shape only to pick the `.zip` default (3.6) |

**Recommendation: B**, shipped after slice S0, which stops a stale service worker serving the old viewer to a new page.

- `docs/design/container.md` section 8 separates "an envelope-only v2" ("a parser branch... dual support is close to free") from "a framing v2", and says the fragment marker exists to make the framing kind survivable. Multi-file is the envelope-only kind: framing, key derivation, record structure, range arithmetic and size derivation are untouched.
- B's one real cost is the misleading post-fetch message in a viewer older than the deploy. Today an old `viewer.js` survives a deploy because the HTML names `/assets/viewer.js` without a version (`app.ts:6406`), `sw.ts:98-114` answers shell paths with `caches.match(request)`, and `sw-cache.ts:32-40` `isCacheable` checks only the pathname. S0 makes the HTML name its unhashed assets with the build id; the old worker's `caches.match` then misses (it matches the query) and the network serves the current viewer. After S0, old viewer code survives only in tabs opened before the deploy.
- B is the only option in which an outdated relic-mcp cannot break a link (last row but one).

If Jason picks A, 1.8 lists exactly what changes. Everything else in this spec is the same under both.

### 0.2 Permanent choices made here (decided, with the reason)

1. **The entry table (the manifest) sits at the start of the content stream; record 0 carries a small fixed header.** Record 0 cannot hold 10,000 names: its capacity is 65,519 bytes (`RECORD_SIZE` 65,536, `rfc8188.ts:42`, less 17 bytes of overhead). The server pins every object to `encryptedSize(declared)` (`app.ts:1541-1575`), which assumes record 0 is exactly one record, so a multi-record header would need a new plaintext grant field telling the operator roughly how many files a relic holds. A manifest in the content stream needs no server change and leaks nothing beyond the size the operator already sees (`format.md` 3.8). Cost: the manifest counts against the 500 MiB cap, so the user-visible rule becomes "the files and their list fit in 500 MiB", and the result reports both numbers (3.4).
2. **No per-entry digest and no per-entry class in the format.** `format.md` 3.6 keeps the class out of the container because two copies of one fact can disagree with no correct resolution. A stored digest is the same: the AEAD already authenticates every byte, and a publisher-asserted digest could tell a reviewer "unchanged" about a changed file. Compare reads bytes (2.3). A digest later would be a v3.
3. **Path rules are strict from the first release.** A rule can be loosened later without breaking a relic; it can never be tightened without refusing relics already published.
4. **Counts are u32 and lengths u64.** The limits (10,000 entries, 4 MiB manifest) are policy constants that can rise without a format change, provided the viewer is deployed before clients publish past an old limit.
5. **A new renderer class, `folder`.** It is the only server-visible trace of a v2 version, it is declared by the publisher like every class, and it tells the operator "a folder" and nothing about the files. The disclosure lists in the privacy page (`app.ts:7187-7188`) and `service.md` (line 497) gain it; both lists already omit `notebook` and are fixed in the same slice.
6. **Comments name their file with a new top-level sealed field, `entry`,** never with a field inside an anchor kind. A field inside a known kind is refused by every reader that knows the kind (`comments.ts:1200-1211`, `format.md` 3.13), which would show real comments as altered; an unknown top-level field is reported and the comment keeps its body (`comments.ts:522-533`).

### 0.3 Other calls for Jason

- **J2: what a `.zip` does by default.** Recommendation: `relic_publish` expands a `.zip` into a folder relic; `expand: false` publishes it as one file exactly as today; `relic_republish` keeps the relic's current shape unless `expand` says otherwise. This changes what a first `.zip` publish produces today (a download-only `archive`). Alternative: zips stay one file unless `expand: true`.
- **J3: the browser `/publish` page stays single-file this round.** It refuses folders and publishes a `.zip` as one file (`relic-viewer/src/publish-view.ts:252-288`, `relic-viewer/src/publish.ts:51,184-202`). Folder drop there needs its own walk and ignore handling in the browser. Recommendation: confirm it is out of this round.

### 0.4 Corrections to the brief

- **Markdown renders on the viewing origin, not in the sandbox frame.** `main.ts:2465-2471` says so, and `renderMarkdown` output goes into `prose.innerHTML` (`main.ts:2477`, `text-views.ts:12`); `viewer.md` 3.1 is stale. In-relic links and images are therefore resolved in the parent with the renderer's fixed element set, not through the frame protocol. Markdown links today become anchors only for `http`, `https` and `mailto`, and images never load: they render their alt text (`markdown.ts:34-75`).
- **Comments never re-anchor across versions.** The viewer shows a version-stamped comment only on that version (`main.ts:9044-9046`). "Stable across republish when a file moves" has nothing to preserve: a comment stays with its version and that version's path.
- **relic-mcp decrypts published relics** in three tools: `relic_show` with `include_content`, `relic_list` name recovery, and `relic_read_comments` with `resolve_anchors` (`inventory.ts:395-523, 841-893`; `resolve-anchor.ts:755-873`). Old clients therefore meet v2 objects. They fail closed.
- **Version compare loads whole versions under a 16 MiB bound** (`main.ts:3645-3650` passes `MAX_DIFF_BYTES` as `maxBytes`; `viewer.ts:983-1003` refuses above it before fetching). Per-file compare needs its own bound (2.3).
- **`format.md` 3.12's "there is no way to request an older one" is stale:** the mint takes a version selector (`service.md` 397), used at `viewer.ts:917-960`.
- **PlanBandC's zip-index does not exist yet** (planned slice B0a). Slice Z0 here is that extraction with two amendments (section 6).
- **The homepage registry is on `origin/homepage-formats` (0e17ec9d), not on main.** Its guard test (`relic-viewer/test/homepage-formats.test.ts`) requires every `RendererClass` in exactly one row, so the `folder` class and its row must land together, in the reader slice V1.
- **`relic_republish` never checks the source identity** of the path it is given (`republish.ts` has no identity reference; `apply-suggestions.ts:281-305` does). Unchanged here; folder republish inherits it.
- **The private reader shows "Something went wrong reaching the service" for an envelope it cannot decode** (`private/open.ts:495-501`, `private/reader.ts:899-951`). V1 fixes that copy.

---

## 1. Envelope v2

### 1.1 Version signalling (option B)

- **Fragment:** unchanged, `#r1<22-character key>`. `parseFragment` keeps returning fragment version 1.
- **Envelope:** byte 0 of record 0 is the envelope version: `1` (one file, today's layout, unchanged) or `2` (folder).
- **Admitted versions:** marker `r1` admits envelope versions `[1, 2]`; a private relic (no marker) admits `[1, 2]`.
- **Reader refusals:**
  - a version greater than every admitted version: new `UnsupportedEnvelopeVersionError`, shown as headline "This relic uses a newer format", detail "Reload this page to get the current viewer.", code `unsupported_format`; the initial open runs `healForRelic` once (`main.ts:499-510`);
  - any other version outside the admitted set (0 or a gap): `VersionMismatchError`, text unchanged.
- **Server:** no format column. A v2 version is declared with class `folder`.
- **Writer:** v1 for a single file, v2 for a folder or an expanded `.zip`, chosen by the input, never by configuration, and never by falling back from one to the other (`container.md` section 8).

### 1.2 Record 0 of a v2 object

Big-endian, as v1. Record 0 is padded to `rs` exactly as v1 (`container.ts:1-15`).

| Field | Type | Rule |
|---|---|---|
| `version` | u8 | `2` |
| `name_len` | u16 | 0 to 1,024 |
| `name` | bytes | UTF-8 decoded non-fatally like the v1 filename (`envelope.ts:67`): untrusted display text naming the folder. Empty means the viewer names it from the relic ID. |
| `entry_count` | u32 | 1 to 10,000 |
| `manifest_length` | u32 | 17 to 4,194,304; the manifest is content bytes `[0, manifest_length)` |
| `content_length` | u64 | safe integer; equals `manifest_length` plus every entry length; at most `PLAINTEXT_CAP_BYTES` (524,288,000) |

Nothing follows; trailing bytes are refused as in v1 (`envelope.ts:200-205`). The largest v2 header is 1,043 bytes, under v1's `MAX_HEADER_BYTES` (1,311, `envelope.ts:45-46`), which stays the bound behind `rs` and the server's zero-byte check. A v2 object never has empty content (the manifest is at least 17 bytes), so the zero-byte branch (`app.ts:1567-1575`) never applies to it.

`content_length` lets the stream decoder size and check the content exactly as v1 uses `entries[0].length` (`stream.ts:243`; `viewer.ts:614-620`).

### 1.3 The manifest

Content bytes `[0, manifest_length)`:

| Field | Type | Rule |
|---|---|---|
| `default_index` | u32 | less than `entry_count` |
| then `entry_count` times, in strictly ascending order of the path's UTF-8 bytes: | | |
| `path_len` | u16 | 1 to 1,024 |
| `path` | bytes | UTF-8 decoded **fatally**; canonical by 1.4 |
| `mimetype_len` | u16 | 0 to 255 |
| `mimetype` | bytes | UTF-8 non-fatal; untrusted, as v1 |
| `length` | u64 | safe integer |

The manifest ends exactly at `manifest_length`. Offsets are implicit: entry 0 starts at `manifest_length`, each entry starts where the previous one ends, and `manifest_length` plus the sum of lengths must equal `content_length`. There are no stored offsets, so nothing can overlap or leave a gap.

Decode order: structure, each path (1.4 rules 1 to 6), the set (rules 7 to 9), the sums. Any failure refuses the whole relic as malformed: one bad name means the publishing client is broken or hostile, and showing the other files would hide that.

### 1.4 Canonical entry paths

The same functions validate in the writer (which normalises first) and in the reader (which never normalises).

1. Valid UTF-8, in NFC (`path === path.normalize('NFC')`).
2. Segments separated by `/`; no leading or trailing `/`; no empty segment.
3. No segment is `.` or `..`.
4. 1 to 32 segments; each segment 1 to 255 UTF-8 bytes; the whole path 1 to 1,024 bytes.
5. None of these code points anywhere: U+0000 to U+001F, U+007F to U+009F, `\` (U+005C), U+061C, U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FEFF. The bidirectional set is the one `viewer.md` 1.9 already strips from filenames.
6. The first segment does not start with a drive prefix (`/^[A-Za-z]:/`), the rule `assertSafeZipPath` already applies (`otio-zip.ts:408-440`).

Set rules:

7. Strictly ascending by UTF-8 bytes, which also excludes exact duplicates.
8. **Fold collisions.** `fold(s) = s.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')` (catches `ß`/`SS` and final sigma). For every prefix of every path (each directory and each full path), `fold(prefix)` maps to exactly one exact prefix. This refuses case-only and normalisation-only duplicates of files and of directories. It over-refuses rare pairs (Turkish dotless i); refusing is the safe direction.
9. **File or directory, not both.** No path equals a directory prefix of another path, exactly or folded.

### 1.5 Limits

Constants in new `relic-format/src/multi.ts`:

| Constant | Value | Enforced by |
|---|---|---|
| `MAX_ENTRIES` | 10,000 | writer (refusal value), reader (malformed) |
| `MAX_MANIFEST_BYTES` | 4 MiB | writer; reader before reading the manifest |
| `MAX_PATH_BYTES` | 1,024 | both |
| `MAX_SEGMENT_BYTES` | 255 | both |
| `MAX_PATH_DEPTH` | 32 | both |
| `MAX_NAME_BYTES` | 1,024 (equal to v1 `MAX_FILENAME_BYTES`) | both |
| content (manifest and files) | `PLAINTEXT_CAP_BYTES` | writer pre-check, server grant (unchanged), reader stream |

There is no per-entry cap beyond the total. Per-route limits (16 MiB reads and 100 MiB whole reads in `content.ts:1-5`, 50 MiB notebooks, PlanBandC's 64 and 100 MiB documents) apply to each entry exactly as to a single file.

### 1.6 The default entry

Stored as `default_index`; chosen at publish:

1. `open_first` (3.1), when given, must name an included entry after the same normalisation, or the publish is refused with `open_first_not_found`.
2. Otherwise the first root-level entry matching, case-insensitively and in this order: `readme.md`, `readme.markdown`, `readme.txt`, `readme`, `index.md`, `index.html`, `index.htm`.
3. Otherwise the first entry in manifest order whose `deriveRendererClass(bytes, basename)` is in `RENDERABLE_CLASSES`.
4. Otherwise entry 0.

The viewer opens it unless the tab's history state names another entry of the same version (4.3). The cover renders it (2.5).

### 1.7 Compatibility

| Reader | v1 object | v2 object |
|---|---|---|
| Current viewer and relic-mcp | Byte-identical behaviour to today | Folder |
| Viewer older than V1 | Unchanged | Post-fetch `version_mismatch` card, one mint spent; after S0 only in tabs opened before the deploy |
| relic-mcp older than M3 | Unchanged | Fails closed with its version-mismatch error; folders refused at publish (`source_is_directory`) |
| Server older than V1 | Unchanged | Grant refused (`invalid_publish_metadata`, unknown class) before any upload |

Every v1 object, every existing link, and republishing a single file as v1 behave exactly as today.

### 1.8 Republish across shapes

Under B each version's object describes itself:

- a folder or an expanded `.zip` writes v2; a single file writes v1;
- earlier versions keep their own envelopes; nothing is rewritten;
- the server row's class is redeclared per version (`store.ts:936`), so the card follows the current version;
- compare between a v1 and a v2 version treats the v1 side as a one-entry folder (2.3);
- comments stay on their own version.

**If Jason picks A,** these and only these change:

- `fragment.ts`: a marker table `{ r1: [1], r2: [2] }`; `encodeFragment(key, envelopeVersion)`; relic-mcp mints `r2` for a first publish of a folder;
- relic-mcp refuses a shape change on republish with `relic_shape_fixed` ("This relic holds one file, and its link can only ever hold one file. Publish the folder as a new relic with force_new: true."), and the reverse for folders;
- proof stage `shape-switch` becomes `shape-fixed` (refusals instead of switches);
- `format.md` 2.1 documents `r2` instead of amending 2.2 and 3.7.

---

## 2. Contracts for every single-file assumption

### 2.1 Envelope readers

Every reader of `entries[0]` moves to a discriminated `Envelope = EnvelopeV1 | FolderHeader` (5.1); the type change makes the compiler list every site. Known sites: `envelope.ts:70,154`; `stream.ts:88,243,310,422`; `viewer.ts:366,616,653,681`; `private/reader.ts:659-667`; `private/rekey.ts:716-732`; `private/open.ts:495-501`; relic-mcp `inventory.ts:524-525,861-864`, `resolve-anchor.ts:988,1493-1496`, `resolve-structured-comment.ts:24-53`. The content-length rule everywhere is `contentLengthOf(envelope)`: v1 `entries[0].length`, v2 `contentLength`.

### 2.2 Comments, anchors and suggested edits

- **New optional top-level sealed field `entry`** in the comment plaintext (`format.md` 3.13): the canonical path (1.4 rules 1 to 6) of a file in the version the comment is stamped with.
- **Writers** (viewer, `relic_comment`) set `entry` on every comment written while a folder version's file is open, anchored or freeform, and never on a v1 version. A reply copies its parent's `entry`. An edit (`relic_edit_comment`, viewer edit) carries the existing `entry` over unchanged.
- **Readers.**
  - A comment whose `entry` names a file of its version shows only with that file.
  - A comment on a folder version with no `entry`, or whose `entry` is not in that version's manifest, goes into a "Whole relic" group visible beside every file, labelled "Not tied to a file" or "This file is not in version N".
  - A comment carrying `entry` on a v1 version: body shown in the whole-relic group; its anchor is reported unplaceable.
- **Anchor kinds are unchanged.** No field is added inside any kind.
- **Keys unchanged:** public `HKDF(link key, "relic/comments/v1")`; private per version (`comments.ts:341-365`).
- **Parser:** `parseCommentFields` (`comments.ts:508-603`) and the writer's key list (`comments.ts:420-431`) gain `entry`, validated with `entryPathRule`. Readers older than this report `unsupported_fields: ['entry']` and keep the body; older writers refuse to re-seal such a comment (`comments.ts:433-437`), so an outdated client cannot strip `entry` on edit.
- **Server:** unchanged. It never sees `entry` (`app.ts:3695-3815` stores ciphertext and a clear version).
- **Suggested edits** carry `entry` the same way; `relic_apply_suggestions` writes `<folder>/<entry>` (3.7).

### 2.3 Version history and compare

- History listing: unchanged (`main.ts:775-840`).
- **New diff mode `files`.** `comparisonAvailability(view)` (`diff.ts:358-411`) returns `{kind: 'available', mode: 'files'}` for a view with `folder`, unless its content is larger than `FOLDER_COMPARE_MAX_BYTES` = 100 MiB (equal to `AUTO_PROJECTION_MAX_BYTES`, `version-store.ts:10`); then `comparison_too_large` with: "This version is larger than the 100 MiB folder comparison limit, so Relik cannot list what changed. Each version can still be opened on its own."
- **Loading:** `renderComparison` passes `FOLDER_COMPARE_MAX_BYTES` instead of `MAX_DIFF_BYTES` as `maxBytes` when the current view is a folder (`main.ts:3645-3650`); the store and loader are unchanged.
- **The file list:** paths in both versions are compared by length, then by bytes in 8 MiB chunks of the two Blob slices, stopping at the first difference. States: added, removed, changed, unchanged; manifest order; no rename detection. Identical lists show the existing "No changes" state (`viewer.md` 6.1 state 12).
- **One changed file:** each side becomes a ReadyView through `entryView` (4.5) and goes to the existing `renderLoadedVersion` (`main.ts:3372-3409`), which keeps its 16 MiB per-side check and its incompatible-route copy (`main.ts:3295-3332`).
- **A v1 version beside a v2 version** (shape switch under B): the v1 side is a one-entry folder whose path is `safeDownloadName(filename)` (`main.ts:417-421`), or `file` when the filename is empty.

### 2.4 Decisions

Unchanged: one decision per version, bound to that version's ciphertext digest (`decision.ts:26-61`). For a folder version, the panel copy (`decision-panel.ts:70`) reads "A decision here applies to every file in version N."

### 2.5 Private relics

- Wraps, seals and per-version keys: unchanged (`private.ts:35, 650-701`).
- `private/open.ts:495-501` decodes with admitted `[1, 2]`. An unsupported or malformed envelope shows the 1.1 copy or "This relic could not be read", never "Something went wrong reaching the service".
- `private/reader.ts:659-667` builds the same folder view as the public path.
- **Revocation rekey** (`private/rekey.ts:703-728`): replace the single-entry guard with a version branch. A v2 version is re-encrypted with `reencryptRelic` (5.1): the identical header and the identical content stream (manifest and files) under the fresh key, declared class `folder`. v1 is unchanged.
- Private publish and republish from relic-mcp take folders exactly like public ones; private relics still send no title and no cover.

### 2.6 Cover

- Rendered from the default entry exactly as a single-file publish of that entry would be: `planCover({bytes, filename: basename(path), mimetype, rendererClass: deriveRendererClass(bytes, basename)})` (`cover/inputs.ts:31-38`, `cover.ts:78-83`).
- A folder cover never uses the `archive` kind, because that kind lists member names in plaintext (`cover/inputs.ts:296-332`). If the plan for the default entry is `archive` or a skip, the cover status is `skipped` with reason `default_entry_has_no_preview`, and the card uses the generic image.
- Model, notebook and OTIO skips apply as today.

### 2.7 Class, card, dashboard, homepage, disclosure, telemetry

- **`RendererClass` gains `folder`** (`renderer-class.ts:27-54`): in `RENDERER_CLASSES`; in `RENDERABLE_CLASSES` (a folder relic opens in the browser); `CLASS_BEHAVIOUR.folder = 'renders'`; privilege tier 0 by the default branch; no extension, magic or sniff ever yields it, and `deriveRendererClass` never returns it. The publisher declares it for every v2 version; the server validates it through the shared `isRendererClass` (`app.ts:1423`, `1765`; `private/relic.ts:559`).
- **Viewer route mapping:** `routeForClass` returns a new `ClassRoute = RenderRoute | 'folder'` (`viewer.ts:1449-1479`), so `class-behaviour.test.ts` covers `folder` without adding a value to `RenderRoute`, which only ever describes one file.
- **Card** (`card.ts`): `CLASS_PHRASES.folder = 'A folder of files.'`, `CLASS_TITLES.folder = 'A folder relic'`; the tail comes from `renders`.
- **Dashboard** (`relic-rows.ts:39-73`): label `Folder`.
- **Homepage** (registry on `origin/homepage-formats`): row `{ id: 'folder', label: 'Folders and .zip files', description: 'A file tree. Each file opens as it would on its own.', classes: ['folder'], structuredKinds: [], extensions: [] }`, placed before `download`. If J2 or J3 changes, adjust the label.
- **Disclosure lists:** the privacy page (`app.ts:7187-7188`) renders its class list from `RENDERER_CLASSES`, with a test that every value appears; `service.md` 497 lists all thirteen values.
- **Telemetry:** no emission carries the class beyond the row, the card and the dashboard (scout grep over app.ts, store.ts and gcsstore.ts found none), so nothing else changes.

### 2.8 Content reads and the cap

- The viewer still decrypts the whole content stream into one Blob (`content.ts:119-177`), sized from `content_length`.
- Each entry is `contentFromBlob(whole.blob('application/octet-stream').slice(offset, offset + length))` (`content.ts:64-66, 190-196`): no copy, head and tail of at most 128 KiB read on open. `read` (16 MiB) and `readWhole` (100 MiB) apply per entry.
- The manifest is read once with `whole.read(0, manifest_length)`, which the 4 MiB limit keeps under `read`'s 16 MiB cap.
- `PLAINTEXT_CAP_BYTES` applies to `content_length`; every existing check (`viewer.ts:355-368, 601, 809`; `private/open.ts:501`; `app.ts:1555`) is unchanged.
- No progressive display: the tree appears when the stream finishes, as a single file does today.

### 2.9 Source identity and lookup

- A directory's identity is `resolveSourceIdentity(dirPath)`, the function `.otiod` already uses. One change (M1): for a directory, git runs from the directory itself and the repository-relative path is `--show-prefix` without its trailing `/`, or `.` for the repository root. Today `dirname` of a repository root is outside the work tree, so the root falls back to its realpath (`state.ts:262-339`). A subdirectory's identity is unchanged, so existing `.otiod` relics keep theirs.
- A `.zip` is identified as a file, as today; republishing the same zip path finds its relic in any session.
- `relic_lookup_source` already accepts directories (`publish.ts:342-377` has no directory refusal). Its match gains `shape`.

### 2.10 URL state and deep links

- **The entry path never enters the URL** (path, query or fragment). The stripped URL goes to the server on every reload, and the fragment travels through every channel a link crosses; a file name is content (`format.md` 2.4, 3.2).
- In-tab state uses `history.state` (4.4). There is no shareable link to one file this round; a comment is the shareable reference to a place in a file.
- The vault label for a folder relic is its name, and its renderer is the open entry's route (`viewer.ts:661-668`).

### 2.11 Agent tools, skill and docs

Section 3 covers the tools. `skills/relic/SKILL.md`, `publish.md` 1.2, 1.3, 1.7 and the 2.x code table, `format.md`, `viewer.md`, `service.md` and `decisions.md` are each updated by the slice that changes the behaviour they describe (section 5).

---

## 3. relic-mcp inputs

### 3.1 What `path` becomes

| `path` (after `lstat`) | Result |
|---|---|
| symlink | `source_not_regular_file`, unchanged (`publish.ts:788-793`) |
| directory named `*.otiod` | the OpenTimelineIO bundle, unchanged (`publish.ts:795-805`) |
| any other directory | **folder relic** (3.2). `source_is_directory` is retired. |
| file named `*.zip` (case-insensitive), `expand` true or defaulted true | **folder relic from the zip** (3.3) |
| any other file, or a zip with `expand: false` | one file, v1, unchanged |

New inputs on `relic_publish` and `relic_republish` (JSON Schema, `additionalProperties: false` as today, `server.ts:303-394, 480-563`):

- `expand` (boolean): read only for a `.zip`. Publish default `true`. Republish default: `true` when the relic's recorded shape is `folder`, otherwise `false` (J2).
- `open_first` (string): the file that opens first, relative to the folder or zip root (1.6).
- `filename` keeps its meaning: it overrides the name written into the envelope, which for a folder is the record-0 `name`. Default: the folder's basename, or the zip's basename without `.zip`.
- `title` default: `normalizeTitle(name)`.

A `.otiod` directory or `.otioz` file inside a folder is an ordinary entry; nothing inside a folder is packaged.

### 3.2 Publishing a folder

**Opening.** `root = resolve(path)`; `lstat(root)` must be a directory. Every file is read through the native held-root opener (`openBundleRoot`, `files.ts:65-67`; `native-secure-open.ts:287-300`), whose `openRegular(relativePath)` refuses symlinks along the path. On a platform without the prebuild (`native-secure-open.ts:132-158`), refuse `folder_publish_unsupported_platform` with the native error code, as `.otiod` does.

**Listing.**

1. **Inside a git work tree** (`git -C <root> rev-parse --is-inside-work-tree` prints `true`): included candidates from `git -C <root> ls-files -z --cached --others --exclude-standard -- .`; ignored paths, for reporting, from `git -C <root> ls-files -z --others --ignored --exclude-standard --directory -- .`. Tracked files are included even when a `.gitignore` matches them (git's own rule).
2. **Outside a work tree with any `.gitignore` under root** (found by a plain walk): `git init --bare -q <tmp>`, then the same two commands with `--git-dir=<tmp> --work-tree=<root>`; `<tmp>` is removed afterwards. `--exclude-standard` reads every `.gitignore` under root plus the user's `core.excludesFile`.
3. **Otherwise:** a plain recursive walk.

Git runs with `execFile` (no shell), `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false`, a 30 second timeout and a 64 MiB output buffer. Output is split on NUL as bytes and each path decoded with a fatal UTF-8 decoder. If git is needed (mode 1 or 2) and is missing, exits non-zero or times out, refuse `gitignore_unavailable` ("This folder has .gitignore rules and git could not read them, so Relik cannot tell what they exclude."), with the git error in `details`. `.gitignore` files themselves are published unless ignored.

**Always left out,** in every mode, reported with these reasons:

| Reason | What |
|---|---|
| `git_metadata` | `.git` at any depth, file or directory, reported once at its path |
| `node_modules` | `node_modules` at any depth, reported once |
| `os_metadata` | `.DS_Store` files |
| `symlink` | any symlink |
| `not_regular_file` | FIFO, socket, device |
| `unpublishable_name` | a name breaking 1.4 rules 1, 5 or 6 after NFC, or not UTF-8 (shown hex-escaped) |
| `path_too_long`, `path_too_deep` | 1.4 rule 4 |
| `gitignore` | ignored by git (modes 1 and 2), directory-collapsed |
| `submodule`, `nested_repository` | git modes: a gitlink, or an embedded repository listed as a directory |
| `missing` | tracked in the index but absent on disk |

**Refused** (the whole publish; a value, before any network call):

- `path_collision` with both paths and the rule (1.4 rules 8 and 9). The reader cannot pick one, so neither is guessed.
- `too_many_files` `{file_count, limit: 10000}`.
- `file_list_too_large` `{file_list_bytes, limit}`.
- `local_size_precheck_failed` with the existing three fields (`size_limit_bytes`, `declared_size_bytes`, `size_basis: 'plaintext'`) plus `files_total_bytes` and `file_list_bytes`, computed from `lstat` sizes before any file is read, against `min(PLAINTEXT_CAP_BYTES, challenge size_limit_bytes)` (`publish.ts:446-465`).
- `folder_empty` `{left_out}` when nothing is left to publish.
- `open_first_not_found` `{open_first}`.
- `source_unreadable` with "changed while being read" when a file's read size differs from its `lstat` size, the rule `publish.ts:866-871` applies to one file.

**Assembly.**

- Canonical paths, sorted (1.4 rule 7).
- Per entry: `mimetype = guessMimetype(basename, deriveRendererClass(bytes, basename))` (`mimetype.ts:76-89`).
- `default_index` by 1.6.
- `encryptFolder` (5.1); declared class `folder`; `declared_size_bytes` is `content_length`.
- Bytes are held as parts and never concatenated (`container.ts:70-113`).
- Duplicate detection: `contentDigest` (`publish.ts:755-764`) over `JSON([name, title])`, NUL, then the whole content stream.

### 3.3 Publishing a `.zip` as a folder

- The zip file must be at most `PLAINTEXT_CAP_BYTES` (`lstat`), else `local_size_precheck_failed`.
- It is read whole (as today) and indexed by `indexZip` (Z0, section 6) with limits `{maxArchiveBytes: PLAINTEXT_CAP_BYTES, maxEntries: 20000, maxEntryBytes: PLAINTEXT_CAP_BYTES, maxTotalBytes: PLAINTEXT_CAP_BYTES}` and relic-mcp's `node:zlib` inflater (`otio-bundle.ts:96-100`). The 20,000 entry ceiling counts directory entries; files are then held to `MAX_ENTRIES`.
- **Refused, each naming the fix** "Publish it as one file with expand: false.":

| Code | Case |
|---|---|
| `zip_unsupported` `{reason: 'zip64' \| 'multi_disk' \| 'method'}` | the reader's existing refusals (`otio-zip.ts:648-701, 741-747`) |
| `zip_encrypted` | any entry with the encrypted flag |
| `zip_unsafe_name` `{name}` | absolute, drive-prefixed, `..` or NUL (`assertSafeZipPath`) |
| `zip_name_not_utf8` `{name_hex}` | a name that is not valid UTF-8, whatever the general-purpose flag says (`otio-zip.ts:369-378`) |
| `zip_corrupt` | CRC, length, overlap or directory census failures |
| `zip_expands_too_large` `{expanded_bytes, limit}` | inflation passed `maxTotalBytes`, stopped by the streaming limit |
| `path_collision` | as for folders, after normalisation |

- **Left out and reported:** directory entries (implied, not reported); symlink entries (`symlink`); `__MACOSX/` and `.DS_Store` (`os_metadata`); `.git` and `node_modules` (as for folders); 1.4 rule failures (`unpublishable_name`, `path_too_long`, `path_too_deep`).
- `.gitignore` files inside a zip are not consulted; the zip's author chose its contents. The tool description says so.
- Everything else (limits, default entry, assembly) is 3.2.

### 3.4 Result shape

`PublishResult` and `RepublishResult` (`publish.ts:255-281`; `server.ts:395-451`) gain:

```ts
readonly shape: 'file' | 'folder';            // required
readonly folder?: FolderReport;               // present when shape is 'folder'
```

`filename` holds the folder's name and `renderer_class` is `folder`. `FolderReport` is in 5.1.

The text block the model reads (`server.ts:2420-2450` publish, `3197-3226` republish) gains two sentences, the second omitted when nothing was left out:

- "It holds N files from <name> and opens at <default_entry>."
- "Left out M paths: <up to five 'path (reason)'>, and K more."

Paths go through `untrusted-text.ts` before they enter the text.

### 3.5 Local state

`PublishState` (`state.ts:56-131`) gains `shape?: 'file' | 'folder'` (absent means `file`). It is written on publish and republish; republish uses it for the `.zip` default. Nothing else is stored per entry.

### 3.6 Republish

Same input handling as publish. Under B the shape may change in either direction; the result says which. The duplicate-content refusal (`republish.ts:256-323`) compares the 3.2 digest. Cover handling is per 2.6.

### 3.7 Other tools

- **`relic_show`** (`inventory.ts:395-568`; schema `server.ts:934-1057`):
  - new input `entry` (string);
  - output gains `shape`, `files` (`{path, mimetype, bytes}[]`, at most 200, then `files_omitted`) and `entry`;
  - `include_content` on a folder without `entry` returns `files`; with `entry` it returns that file's text when it is at most `MAX_INLINE_CONTENT_BYTES` (1 MiB, `inventory.ts:182-190`), otherwise `content_omitted_reason: 'entry_too_large'`;
  - when the object is over 1 MiB, the manifest and the entry are read by range (`fetchRange`, `inventory.ts:881-893`; `contentRangeToObjectRange` and `decryptContentRange`, `container.ts:246-305`) instead of the whole object.
- **`relic_list`:** `recoverEnvelope` (`inventory.ts:841-879`) returns the record-0 `name` for v2 (`filename_basis: 'envelope'`) and `content_bytes` = `content_length` less `manifest_length`.
- **`relic_read_comments`** with `resolve_anchors`:
  - each record gains `entry: string | null`;
  - for a folder version, the resolver selects the comment's entry and resolves against that entry's bytes, with `filename = basename(entry)`, its mimetype, and `deriveRendererClass(entryBytes, basename)`;
  - an anchored comment with no `entry` is unresolvable with `not_tied_to_a_file`; a missing file is `file_not_in_version`;
  - the selection point is `resolve-anchor.ts:1429-1496`; `resolve-structured-comment.ts:24-53` caches readers per version and entry;
  - full-object fetch stays as today (`resolve-anchor.ts:755-873`).
- **`relic_comment`:** new optional input `entry` (string, canonical form checked locally; not checked against the manifest). Replies copy the parent's `entry`. **`relic_edit_comment`** carries `entry` over.
- **`relic_apply_suggestions`** (`apply-suggestions.ts:236-524`):
  - for a folder relic, `path` is the folder, checked against the recorded identity as today (`281-305`); each accepted suggestion's comment `entry` selects `<folder>/<entry>`;
  - before any write, every target is checked: it exists and is a regular file, no path component is a symlink (`lstat` each component from the folder root), its realpath is inside the folder's realpath, and the class gate (`265-272`) passes for that file;
  - each file is written with the existing temp-and-rename sequence (`474-501`);
  - the output keeps its top-level fields and adds `files: [{entry, path, written, before_sha256, after_sha256, diff, applied}]`;
  - a relic whose recorded source is a `.zip` is refused with `source_is_zip`;
  - a suggestion with no `entry` on a folder version is refused with `suggestion_not_tied_to_a_file`.
- **`relic_lookup_source`:** unchanged apart from `shape` on a match.

### 3.8 Codes

New `ClientCode` values (`publish.ts:72-157`): `too_many_files`, `file_list_too_large`, `folder_empty`, `path_collision`, `open_first_not_found`, `gitignore_unavailable`, `folder_publish_unsupported_platform`, `zip_unsupported`, `zip_encrypted`, `zip_unsafe_name`, `zip_name_not_utf8`, `zip_corrupt`, `zip_expands_too_large`, `source_is_zip`, `suggestion_not_tied_to_a_file`. Retired: `source_is_directory`, removed from the union, `publish.md` 2.x and the skill.

---

## 4. Viewer

### 4.1 Opening

- **Public** (`viewer.ts:590-700`): `streamRelicContent` decodes with admitted `[1, 2]`. `onEnvelope` sizes the sink from `contentLengthOf(env)`, and the progress label uses the folder name. After `finish()`, a v2 view reads and decodes the manifest, builds the `FolderContext` (5.1), picks the entry (4.3) and returns `entryView` of it.
- **Large open** (more than 100 MiB, `viewer.ts:348-389`): the confirmation shows the folder name and "N files" from record 0.
- **Historical versions** (`viewer.ts:917-1045`) and **private open** (`private/open.ts`, `private/reader.ts`) use the same branch.
- **Refusal cards:**
  - malformed manifest: code `malformed_container`, headline "This relic could not be read", detail "Its file list is damaged or names a file in a way Relik does not accept."
  - unsupported envelope: the 1.1 copy, then one automatic reload via `healForRelic` on the initial open.

### 4.2 Per-entry views

`entryView(view, index)` (5.1):

- content is the entry slice (2.8);
- `routeContent(basename, mimetype, content)` (`viewer.ts:1212-1322`) is called unchanged, so the disagreement notices, the whole-document read and JSX compilation behave exactly as for a single file;
- the version, digest, share URL, relic id, private hooks and `folder` (with the new index) are copied over;
- `filename` is the basename, which keeps the extension parse (`viewer.md` 1.9 rule 6) and the download name; the full path comes from `folder`.

Switching files remounts the stage through the path a version switch already uses, so frames, model observers and object URLs are disposed exactly as they are today. V1 locates that remount in `main.ts` and reuses it rather than adding a second teardown.

### 4.3 Which file opens first

`history.state.relicEntry`, when its `relicId` and `version` match and the path is in the manifest; otherwise `default_index`.

### 4.4 History

- A user action that opens a file (a tree row, an in-relic link) calls `history.pushState({...history.state, relicEntry: path, relicId, version}, '', location.pathname + location.search)`. The initial open and a version switch call `replaceState`. `popstate` opens the named file.
- Switching versions keeps the open path when the target version has it; otherwise the default file opens with the notice "<path> is not in version N. Showing <default>."
- The URL itself never changes (2.10). The only existing `replaceState` (`main.ts:11912`) keeps its job.

### 4.5 The file tree

- **Placement.** Desktop: a column to the left of the stage, labelled "Files", 280 px wide. At the stylesheet's existing narrow breakpoint and at 390 px wide: a "Files" button in the taskbar opens a full-height sheet (`role="dialog"`, focus kept inside, Escape and a close button); choosing a file closes it.
- **Rows.** Folders (disclosure control, name, file count) and files (an icon by extension group, the name, the size). Names are text nodes; a long name is truncated with an ellipsis and its full path goes in `title` via `setAttribute`. The open file has `aria-current="true"`.
- **Expansion.** The open file's ancestors are expanded and every other folder is collapsed; with 50 files or fewer, everything is expanded.
- **Keyboard.** `role="tree"` and `treeitem`; Up and Down move; Left and Right collapse and expand; Enter opens.
- **Many files.** Above 200 visible rows the list is windowed: only the rows in view, plus 20 on each side, are in the DOM, at a fixed row height (28 px, 44 px on coarse pointers). Above 50 files a filter box matches a case-insensitive substring of the full path and shows the matches with their folders open.
- **Breadcrumb.** The taskbar shows `name / folder / file` (the relic id when `name` is empty), each part a text node, truncated in the middle at narrow widths.
- **Counts.** Rows show a comment count when V3 is in.
- **Files.** `file-tree.ts` and `file-tree.css`; the CSS goes into `SHELL_ASSETS` (`sw-cache.ts:10-18`) and the build's asset table (`build.ts:397-402`) like the other view stylesheets.

### 4.6 Markdown links and images inside a folder

`renderMarkdown(source, options?)` (`markdown.ts:368`) takes an optional resolver; only markdown files in a folder pass one (`main.ts:2015-2018` stage, `main.ts:2474-2478` compare pane, `text-views.ts:12`). Comment bodies (`main.ts:4135`) never do.

- **Eligible target:** no scheme (`/^[a-z][a-z0-9+.-]*:/i` does not match) and not starting with `//`. `#fragment` and `?query` are dropped. The rest is percent-decoded; a decoding failure makes it ineligible.
- **Resolution:** a target starting with `/` resolves from the folder root, anything else from the markdown file's directory. `.` and `..` are applied; going above the root makes it ineligible. The result is NFC-normalised and must equal a manifest path exactly (`resolveEntryReference`, 5.1).
- **Links** become `<a href="#" class="md-entry-link" data-relic-entry="N">text</a>`, where `N` is the entry index: a viewer-made integer, so no attacker string enters an attribute. One delegated click handler on the prose container opens entry `N` (4.4). Modifier clicks do the same; nothing opens a new tab.
- **Images** embed only when the target entry routes to `image` (raster; SVG routes to the sandboxed frame, `viewer.md` 1.5). They become `<img class="md-entry-image" data-relic-entry="N" alt="...">`. After insertion, `src` is set to `URL.createObjectURL(entrySlice.slice(0, size, sniffedType))`; the viewing origin already allows `img-src 'self' blob: data:` (`app.ts:6420`).
- **Budget per document:** at most 200 images, at most 32 MiB each and 64 MiB in total. Past the budget, or for an SVG or non-image target, the image renders as today's alt-text span followed by a link to the file. Object URLs are revoked when the stage is torn down.
- **Unchanged:** `http`, `https` and `mailto` links; links to other relics (they are `https` links); and any target that does not resolve, which stays literal text exactly as today.

### 4.7 HTML, JSX and SVG files in a folder

They open one at a time in the existing sandboxed routes with the existing frame protocol, and no sibling file is ever loaded into a frame (Jason's decision 2). Relative links in the frame stay inert, because the frame forwards only `http`, `https` and `mailto` (`sandbox.ts:1930-1947`). An HTML or JSX file in a folder shows the notice "Files this page links to are not loaded here. Each file in this folder opens on its own."

### 4.8 Downloads

- **One file:** the existing buttons (`main.ts:1133, 1206, 1813, 1977`) call `downloadContent(view)` (`main.ts:702-707`), which now names the file `safeDownloadName(basename)`.
- **Download all (.zip)**, in the tree header and in the taskbar overflow at narrow widths (`folder-zip.ts`):
  - CRC-32 of each entry, streamed over its Blob slice in 8 MiB chunks (`Crc32`, `otio-zip.ts:166-184`);
  - `planStoredZip` (5.1) for the headers;
  - `new Blob([header0, slice0, header1, slice1, ..., centralDirectory, end], {type: 'application/zip'})`, named `safeDownloadName(name || relicId) + '.zip'`;
  - shows progress and can be cancelled; no ZIP64 is ever needed (at most 10,000 entries and 500 MiB).

### 4.9 Comments (V3)

- The thread filter (`main.ts:9025-9054`) also filters by the open file when the view has `folder`, and shows the "Whole relic" group (2.2) above the file's thread.
- The composer and the post path (`relic-viewer/src/comments.ts:759-816`) add `entry`; editing keeps it.
- Anchors are painted by the open file's route exactly as for a single file.
- Tree rows show per-file counts.

### 4.10 Compare (V3)

The files mode of 2.3: a list of added, removed and changed files, with unchanged files collapsed into "N unchanged files"; choosing a changed file shows the existing per-route comparison for that pair.

---

## 5. Shared contracts, spikes, slices, proof, release

### 5.1 Shared contracts (settle before parallel dispatch)

```ts
// relic-format/src/multi.ts (new, F1)
export const ENVELOPE_VERSIONS: readonly number[] = [1, 2];  // what this build reads
export const MAX_ENTRIES = 10_000;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_DEPTH = 32;
export const MAX_NAME_BYTES = 1024;

export interface FolderHeader {
  readonly version: 2;
  readonly name: string;
  readonly entryCount: number;
  readonly manifestLength: number;
  readonly contentLength: number;
}
export interface FolderEntry {
  readonly path: string;     // canonical
  readonly mimetype: string; // untrusted
  readonly offset: number;   // into the content stream, derived
  readonly length: number;
}
export interface FolderManifest {
  readonly defaultIndex: number;
  readonly entries: readonly FolderEntry[];
}
export type PathRule =
  | 'not_utf8' | 'not_nfc' | 'empty_segment' | 'dot_segment' | 'too_deep'
  | 'segment_too_long' | 'path_too_long' | 'forbidden_character' | 'drive_prefix';
export type SetRule = 'out_of_order' | 'duplicate' | 'fold_collision' | 'file_and_directory';

export function normaliseEntryPath(raw: string):
  { ok: true; path: string } | { ok: false; rule: PathRule };   // writer: NFC, joins segments
export function entryPathRule(path: string): PathRule | undefined; // reader: undefined means canonical
export function compareEntryPaths(a: string, b: string): number;   // UTF-8 bytewise
export function foldEntryPath(path: string): string;
export function checkEntrySet(sorted: readonly string[]):
  { ok: true } | { ok: false; rule: SetRule; paths: readonly [string, string] };
export function encodeFolderHeader(header: Omit<FolderHeader, 'version'>): Uint8Array;
export function encodeManifest(
  defaultIndex: number,
  entries: readonly { path: string; mimetype: string; length: number }[]
): Uint8Array;
export function decodeManifest(bytes: Uint8Array, header: FolderHeader): FolderManifest; // throws StrictParseError
export function resolveEntryReference(manifest: FolderManifest, fromPath: string, target: string): number | undefined;
export function chooseDefaultEntry(
  entries: readonly { path: string; renderable: boolean }[],
  openFirst?: string
): { ok: true; index: number } | { ok: false };

// relic-format/src/envelope.ts (F1)
export interface EnvelopeV1 { readonly version: 1; readonly entries: readonly EnvelopeEntry[] }
export type Envelope = EnvelopeV1 | FolderHeader;
export function decodeEnvelope(bytes: Uint8Array, admitted: readonly number[]): Envelope;
  // throws StrictParseError | VersionMismatchError | UnsupportedEnvelopeVersionError (errors.ts)
export function contentLengthOf(envelope: Envelope): number;

// relic-format/src/container.ts (F1); the v1 API is unchanged
export interface EncryptFolderInput {
  readonly name: string;
  readonly defaultIndex: number;
  readonly entries: readonly { readonly path: string; readonly mimetype: string; readonly bytes: Uint8Array }[]; // canonical, sorted
  readonly key: Uint8Array;
  readonly rs?: number;
  readonly salt?: Uint8Array; // test seam, as today
}
export function folderPlaintext(input: Omit<EncryptFolderInput, 'key' | 'rs' | 'salt'>):
  { header: FolderHeader; headerBytes: Uint8Array; parts: readonly Uint8Array[] }; // validates; throws StrictParseError
export function encryptFolder(input: EncryptFolderInput): Promise<Uint8Array>;
export function reencryptRelic(input: {
  envelope: Envelope; parts: readonly Uint8Array[]; key: Uint8Array; rs?: number; salt?: Uint8Array;
}): Promise<Uint8Array>; // same plaintext, fresh key: private rekey
export interface OpenedFolder { readonly header: FolderHeader; readonly manifest: FolderManifest; entryBytes(index: number): Uint8Array }
export function openFolder(opened: OpenedRelic): OpenedFolder; // Node consumers holding the whole content
// openEnvelope, openRelic and streamRelicContent take `admitted` (default [1]) instead of fragmentVersion.
// F1 passes [1] at every existing call site; V1 and M3 switch to ENVELOPE_VERSIONS.

// relic-format/src/comments.ts (F1)
// CommentPlaintext gains: readonly entry?: string  (entryPathRule must return undefined)

// relic-format/src/zip-write.ts (new, F1); otio-bundle.ts moves onto these encoders, byte-identical
export interface StoredZipEntry { readonly name: string; readonly size: number; readonly crc32: number }
export interface StoredZipLayout {
  readonly localHeaders: readonly Uint8Array[]; readonly centralDirectory: Uint8Array;
  readonly end: Uint8Array; readonly totalBytes: number;
}
export function planStoredZip(entries: readonly StoredZipEntry[]): StoredZipLayout;
  // UTF-8 flag, DOS date 1980-01-01, method 0, no ZIP64; throws past 65,535 entries or 4 GiB

// relic-format/src/renderer-class.ts (V1): RendererClass gains 'folder' (2.7)

// relic-viewer/src/viewer.ts (V1)
export interface FolderContext {
  readonly header: FolderHeader;
  readonly manifest: FolderManifest;
  readonly index: number;          // the entry this view shows
  readonly whole: RelicContent;    // the whole content stream
}
// ReadyView gains: readonly folder?: FolderContext;
export function entryView(view: ReadyView, index: number): Promise<ReadyView>;
export type ClassRoute = RenderRoute | 'folder';
export function routeForClass(cls: RendererClass): ClassRoute;
// diff.ts (V3): DiffMode gains 'files'; FOLDER_COMPARE_MAX_BYTES = 100 * 1024 * 1024

// relic-mcp/src/publish.ts (M1)
// PublishInput gains: readonly expand?: boolean; readonly open_first?: string;
// PublishResult and RepublishResult gain: readonly shape: 'file' | 'folder'; readonly folder?: FolderReport;
export type LeftOutReason =
  | 'gitignore' | 'git_metadata' | 'node_modules' | 'os_metadata' | 'symlink' | 'not_regular_file'
  | 'unpublishable_name' | 'path_too_long' | 'path_too_deep' | 'submodule' | 'nested_repository' | 'missing';
export interface FolderReport {
  readonly source: 'directory' | 'zip';
  readonly file_count: number;
  readonly files_total_bytes: number;
  readonly file_list_bytes: number;
  readonly default_entry: string;
  readonly sample: readonly string[];  // first 20 paths in manifest order
  readonly left_out: {
    readonly count: number;
    readonly by_reason: Readonly<Partial<Record<LeftOutReason, number>>>;
    readonly sample: readonly { readonly path: string; readonly reason: LeftOutReason }[]; // first 50
  };
}
// relic-mcp/src/state.ts (M1): PublishState gains readonly shape?: 'file' | 'folder';
```

**File ownership.**

| File | Owner |
|---|---|
| `relic-format/src/multi.ts`, `envelope.ts`, `container.ts`, `stream.ts`, `fragment.ts`, `errors.ts`, `comments.ts`, `zip-write.ts` | F1 |
| `relic-format/src/zip-index.ts`, `otio-zip.ts` | Z0 (or PlanBandC B0a, section 6) |
| `relic-format/src/index.ts`, `package.json` exports | F1, then Z0, then V1 (serial; trivial conflicts) |
| `relic-format/src/renderer-class.ts`, `supported-formats.ts` | V1 |
| `relic-server/src/card.ts`; `app.ts` privacy list | V1 |
| `relic-server/src/app.ts` shell template (6350-6410), `assets.ts`, `relic-viewer/build.ts`, `sw-cache.ts`, `sw.ts` | S0, then V1 adds the stylesheet |
| `relic-viewer/src/viewer.ts` | V1; V3 the compare bound only |
| `main.ts` | V1: taskbar, downloads, stage wrapper, dead cards. V2: 2015-2018, 2474-2478. V3: 3590-3769, 9025-9054, 10453-10634. |
| `folder-view.ts`, `file-tree.ts`, `file-tree.css`, `folder-zip.ts`, `relic-rows.ts`, `private/*` | V1 |
| `markdown.ts`, `folder-links.ts`, `text-views.ts` | V2 |
| `diff.ts`, `folder-compare.ts`, `folder-comments.ts`, `relic-viewer/src/comments.ts`, `decision-panel.ts` | V3 |
| relic-mcp `folder-source.ts`, `publish.ts`, `republish.ts`, `state.ts`, `otio-bundle.ts` (F1 already moved it onto zip-write) | M1 |
| relic-mcp `zip-source.ts` | M2 |
| relic-mcp `inventory.ts`, `resolve-anchor.ts`, `resolve-structured-comment.ts`, `comments.ts`, `apply-suggestions.ts` | M3 |
| relic-mcp `server.ts` | M1 (publish, republish, lookup), M2 (descriptions), M3 (show, list, read_comments, comment, edit_comment, apply) |
| `skills/relic/SKILL.md` | M1, then M2, then M3, each its own section |
| `packages/relic-mcp/test/multi-file-path.ts`, `.github/workflows/verify.yml` step, root `PATH.md` section | F1 creates; each later slice adds one stage file under `packages/relic-mcp/test/multi-file/` and one line in the runner |

New logic goes into new modules; `main.ts`, `sandbox.ts` and `viewer.ts` get wiring only.

### 5.2 Spikes (each must run before its slice is dispatched)

| Spike | Before | What to do | What would change the design |
|---|---|---|---|
| S-M5 stale worker | S0 | In an owned headless shell, install generation N's service worker, serve generation N+1's HTML naming `viewer.js?v=N+1`, load a relic page, read a build marker the bundle sets. Control: the same without the query. | If the old worker still serves N's script, use content-hashed asset names instead of a query. |
| S-M1 manifest scale | F1 limits freeze | Build manifests of 1,000 and 10,000 entries with 60-byte and 200-byte paths; time encode in Node, then decode plus `checkEntrySet` in the headless shell on the CI runner image. | Decode and validation over 500 ms at 10,000 entries: lower `MAX_ENTRIES` to 5,000 for the first release (policy, not format). |
| S-M4 entry views | V1 | On a 400 MiB content Blob in the headless shell: open the last entry through `contentFromBlob(slice)`; bind 100 blob-URL images in markdown under the production CSP; assemble Download all for 10,000 entries and index the result with zip-index. Record time and peak memory. | Opening one entry over 1 s, or memory proportional to the whole relic: entries move to range reads, which changes 2.8. |
| S-M2 git listing | M1 | On macOS and Linux, run 3.2's commands against: nested `.gitignore` with negation, a global excludes file, a tracked-but-ignored file, a submodule, an embedded repository, a deleted tracked file, an NFD-named file, a symlink, outside-work-tree mode. | Different listings than 3.2 assumes: adjust the left-out mapping before M1. |
| S-M3 real zips | M2 | Index 20 zips from macOS Finder, Windows Explorer, `zip -r`, `ditto`, Python `shutil.make_archive`, GitHub "Download ZIP", 7-Zip, Google Drive; count ZIP64 records, non-UTF-8 names, symlink entries, data descriptors and `__MACOSX`. | More than 1 in 20 refused for ZIP64 or names: add ZIP64 reading or a CP437 fallback to zip-index before M2. |

### 5.3 Slices

**S0. Shell assets named by build** (server and viewer; depends on nothing; deploys first)

- Files: `app.ts` shell template (`6359` stylesheet link, `6406` script tag) and every other unhashed shell asset it names; `assets.ts:122` (its selector names the script); `relic-viewer/build.ts:397-402` and the `__SHELL_ASSETS__` injection; `sw-cache.ts:10-18`; tests (`assets.test.ts`, sw-cache tests).
- Change: every unhashed asset the shell names carries `?v=<build hash>`; the worker's shell list holds exactly those URLs, so the current generation still caches them; the server serves the assets whatever the query.
- Not included: anything about folders.
- Done when: S-M5's harness shows a page served by an old worker running the new bundle, and the negative control runs the old one; after deploy, `deploy-smoke` shows the live shell naming `viewer.js?v=<live build>`.

**F1. Format codec v2, comment `entry`, zip writer, proof runner** (relic-format and the runner; depends on nothing)

- Files: 5.1's relic-format files and tests; mechanical call-site updates passing `admitted: [1]` (viewer, private, relic-mcp); `otio-bundle.ts:189-419` moved onto `zip-write.ts` encoders; new `packages/relic-mcp/test/multi-file-path.ts` with stage `codec`; a `verify.yml` step "Multi-file path" after the existing path steps (`verify.yml:84-114` region); a root `PATH.md` section. Spec: `format.md` 2.2 and 3.7 (B), 3.1, 3.9 (a folder of empty files is legal: the content is its manifest), 3.13 (`entry`), new 3.18 (manifest and path rules).
- Not included: any reader or writer behaviour change; the `folder` class.
- Done when:
  - a committed golden vector (3 entries, fixed key and salt, hex) decodes to the exact header and manifest, and re-encrypting it is byte-identical;
  - round trips pass at 1 and 10,000 entries;
  - each `PathRule` and `SetRule` is refused by name in a table test, with both normalisation forms and case pairs;
  - every existing container test passes unchanged (`container.test.ts:286`);
  - the v2 golden object fed to a vendored copy of main's v1-only `decodeEnvelope` throws `VersionMismatchError` (fail closed proven);
  - comments with `entry` round trip, and an invalid `entry` is refused on write and reported on read;
  - OTIO bundling tests pass unchanged, proving the writer move is byte-identical;
  - CI prints the `codec` stage line.

**Z0. zip-index** (relic-format; depends on nothing; see section 6 for ownership)

- Files: `zip-index.ts` and tests; `otio-zip.ts` delegating.
- Change: PlanBandC 5.2's contract plus two amendments: `ZipEntryInfo.kind: 'file' | 'directory' | 'symlink'`, where `indexZip` no longer refuses symlink entries but `read()` refuses anything not a file (other special types are still refused at index time); and `indexOtioZip` keeps refusing archives that contain symlinks.
- Done when: the OTIO tests and `otio-path` are unchanged; new tests cover a symlink entry indexed and its read refused, an encrypted entry refused, ZIP64 refused, a duplicate refused, zip-slip refused, and a bomb stopped at `maxTotalBytes` with a value.

**V1. The viewer reads folder relics** (viewer, server copy, class; depends on F1 and on `homepage-formats` being merged)

- Files: per 5.1 ownership; spec `viewer.md` new section (the next free 3.x after PlanBandC's 3.8 and 3.9), 1.9 (paths are display text), 6.12 (private folder note); `service.md` class lists; `decisions.md` record "Multi-file relics" (superseding the single-entry invariant at `decisions.md:812-817` for folders).
- Change: 4.1 to 4.5 and 4.8; 2.5; 2.7; the 1.1 refusal copy; viewer callers switch to `ENVELOPE_VERSIONS`.
- Not included: markdown links (V2); per-file comments and compare (V3). No folder relic can exist until M1 is released, after V3 is deployed, so the interim is never visible.
- Done when (stages `open-tree`, `downloads`, `private`, `refusals`, in the owned headless shell against the test server):
  - an F1-built fixture opens with the tree listing every file and `README.md` rendered; clicking `data/a.json` shows the JSON tree and `img/p.png` the image route; reload stays on the same file; Back returns to the previous one;
  - at 390 by 844, `scrollWidth` is at most 390, the Files sheet opens, and choosing a file closes it and updates the breadcrumb;
  - a 2,000-file fixture keeps 120 or fewer tree rows in the DOM, and the filter finds a file 8 folders deep;
  - one-file download is byte-equal; Download all indexes with zip-index and every entry is byte-equal;
  - a private folder relic opens and reopens after a revocation rekey;
  - the homepage shows the folder row; the card for class `folder` reads "A folder of files. It opens in your browser...";
  - negative controls: a non-NFC path, a case collision, a file-and-directory pair and a short length sum each show "This relic could not be read"; envelope version 3 shows "This relic uses a newer format" and reloads once; every existing path script stays green.

**V2. Markdown links and images in a folder; HTML notice** (viewer; depends on V1)

- Files: per 5.1.
- Change: 4.6 and 4.7.
- Done when (stages `markdown-links`, `html-entry`):
  - `[a](docs/a.md)` opens `docs/a.md` and Back returns;
  - `![p](./img/p.png)` has `naturalWidth` above 0 under the production CSP;
  - `[x](../outside.md)` from the root stays literal text; `https://` links keep today's behaviour; an SVG target shows alt text and a link;
  - an image past the 64 MiB budget shows alt text;
  - `index.html` naming `style.css` and `a.png` renders, the test server records zero requests for either, and the notice shows.

**V3. Comments per file, compare per file, decision copy** (viewer; depends on V1)

- Files: per 5.1; spec `viewer.md` 6.1 (files mode substate) and 6.6 (per-file thread).
- Change: 2.2 (viewer half), 2.3, 2.4, 4.9, 4.10.
- Done when (stages `comments-viewer`, `compare`, `shape-switch`):
  - comments written on two files show only with their own file, and their counts show in the tree;
  - an entry-less comment shows in the Whole relic group;
  - after a republish with one file changed, one added and one removed, compare lists exactly those, and the changed markdown file shows the rendered diff;
  - a 120 MiB folder shows the 100 MiB copy;
  - under B, a single-file relic republished as a folder and back opens at every version, and compare across the switch lists the files.

**M1. relic-mcp folder publishing** (relic-mcp; depends on F1; released after V1 to V3 are deployed)

- Files: per 5.1; spec `publish.md` 1.2, 1.3 and the 2.x table; `SKILL.md`.
- Change: 3.1, 3.2, 3.4 to 3.6, 2.6, 2.9; `source_is_directory` retired.
- Done when (stage `folder-publish`), from a temp git repo folder with `.gitignore` (ignoring `.env` and `dist/`), `node_modules/`, `.DS_Store`, a symlink, a FIFO and a file named `Icon\r`:
  - the result has `shape: 'folder'`, the exact `file_count` and each left-out reason with its count;
  - decrypting the uploaded object shows no `.env`, `dist/` or `node_modules`, and paths equal to git's listing;
  - an outside-git copy with the same `.gitignore` gives the same file list (mode 2);
  - with git removed from `PATH` it refuses `gitignore_unavailable`;
  - `folder_empty`, `path_collision` (two names differing only in normalisation, on Linux), `too_many_files` (10,001 empty files) and `local_size_precheck_failed` each refuse before any network call (the stage's fake server records no request);
  - republishing the same folder refuses `duplicate_version`;
  - lookup finds the folder from a second process.

**M2. relic-mcp zip expansion** (relic-mcp; depends on M1 and Z0)

- Files: per 5.1; spec `publish.md` 1.2; `SKILL.md`.
- Change: 3.3; the `expand` default.
- Done when (stage `zip-publish`):
  - a stored-and-deflated zip with `__MACOSX/` and a symlink entry expands, reporting both;
  - hostile fixtures each refuse with their own code and the `expand: false` fix: zip-slip, absolute path, encrypted, ZIP64, a bomb, a case-duplicate pair, a non-UTF-8 name;
  - `expand: false` publishes class `archive`, v1, byte-equal to today's result;
  - republishing a pre-existing archive relic with no `expand` keeps it an archive.

**M3. relic-mcp readers** (relic-mcp; depends on F1, and on M1 for `shape`)

- Files: per 5.1; spec `publish.md` 1.7; `SKILL.md`.
- Change: 3.7; relic-mcp callers switch to `ENVELOPE_VERSIONS`.
- Done when (stages `comments-mcp`, `show`, `apply`):
  - `relic_read_comments` with `resolve_anchors` returns each comment's `entry`, resolves quotes in the right file, and reports `not_tied_to_a_file` and `file_not_in_version`;
  - `relic_show` lists files and returns one file's text through range reads on a 3 MiB folder relic (the fake server records range requests only);
  - `relic_apply_suggestions` writes two files in a folder, refuses when one target is a symlink with nothing written, and refuses `source_is_zip`;
  - `relic_comment` with `entry` round trips and an edit keeps it.

### 5.4 Proof wiring

- One runner, `packages/relic-mcp/test/multi-file-path.ts`, one `verify.yml` step, marker `MULTI_FILE_PATH_OK` printed only after every stage and the negative-control column pass.
- Stages: `codec` (F1); `open-tree`, `downloads`, `private`, `refusals` (V1); `markdown-links`, `html-entry` (V2); `comments-viewer`, `compare`, `shape-switch` (V3); `folder-publish` (M1); `zip-publish` (M2); `comments-mcp`, `show`, `apply` (M3).
- Browser stages use the owned `chrome-headless-shell` through `RELIC_CHROME_PATH`, never a user browser.
- No stage writes to production; every stage runs against `createApp` with the in-memory store, as the existing path scripts do.

### 5.5 Release order and rollback

1. **S0** merged and deployed; `deploy-smoke` green; the live shell names `?v=`.
2. **F1 and Z0** merged. No runtime behaviour changes (every caller still admits `[1]`).
3. **V1, V2, V3** merged and deployed as the server-and-viewer image; `deploy-smoke` green; Jason opens one existing relic of his own (no regression). Once V1 is deployed, the server accepts class `folder`.
4. **M1, M2, M3** merged; relic-mcp released through the tag-triggered OIDC publish workflow (never from a workstation).
5. **Post-production gate**, declared before step 4 merges:
   - unproven before it: the production viewer on a real folder relic, because no test relic is published to production;
   - observation: Jason publishes one real folder and one real `.zip` of his own and opens both on desktop and on his phone (tree, a markdown image, Download all);
   - containment: relic-mcp can be pinned back to the previous release, which refuses folders, while the viewer stays.

**Rollback.**

- S0: safe in either direction.
- Viewer below V1 once folder relics exist: those relics show the mismatch card until roll-forward. No data is lost, but the rule is roll forward, not back.
- Server below V1: folder publishes are refused at the grant, and existing folder relics still serve (the server never parses them).
- relic-mcp below M1: folders refused, zips published as archives, folder relics fail closed on read.

---

## 6. Fit with PlanBandC

- **Z0 is PlanBandC B0a's zip-index extraction** (its 5.2 contract, same names) plus the two amendments in 5.3: entry `kind` with symlink entries indexed rather than refused, and limits per call. Whichever of Z0 and B0a dispatches first owns `zip-index.ts`; the other rebases. B0a's `containers.ts`, `xml.ts` and recognition order are unaffected. The OTIO path keeps refusing symlink entries through `indexOtioZip`.
- **Word, Excel and ebook files inside a folder route exactly like single files.** An entry view is a ReadyView produced by `routeContent`, so when B0a's routing and B1 to B3's renderers land, `.docx`, `.xlsx` and `.epub` entries render in the tree with no folder-specific code, under the same per-file limits (64 and 100 MiB) and the same mismatch-downloads rule. Nothing inside a folder is ever expanded; only a top-level `.zip` input is, by extension, so a `.docx` input stays one file. A renamed office file published as `.zip` expands into its parts; B0a's `zipContainerKind` could later make that a refusal, which is not required here.
- **B4 (agent resolution for documents)** composes with M3: M3 owns the entry selection in `resolve-anchor.ts:1429-1496`, B4 owns the quote branch at `1564-1621`. They are separate regions; the second to land rebases.
- **C0 to C4 (suggestions):** `suggestionSourceFor(bytes, filename, mimetype)` receives the entry's basename and mimetype; suggestion comments carry `entry`. C4's structure checks run per file inside M3's folder targeting. `apply-suggestions.ts` order: C4 first, then M3 (if M3 lands first, C4 rebases onto the per-file loop). T0 is independent.
- **B0b (frame protocol)** is untouched: HTML, JSX and SVG files in a folder use the existing frame, one at a time.
- **Shared files:**
  - `main.ts`: B0a `MARKER_LABELS` (V1 adds none); B0b cases inside `buildCurrentStage` (V1 wraps the stage and does not touch the switch); C0's suggestion gate at 6292-6396 (V3 is at 9025-9054).
  - `relic-format/index.ts` and `package.json`: F1, Z0 and B0a all add exports; serialise merges.
  - `verify.yml` and `PATH.md`: separate steps and sections side by side.
  - `viewer.md`: PlanBandC claims new sections 3.8 and 3.9; V1 takes the next free number.
- **Release:** both plans need the server-and-viewer deploy before relic-mcp; one relic-mcp release can carry both.

---

## 7. What would prove this spec wrong

- S-M5 shows an old worker still serving the old bundle with any URL scheme: B's transition risk is not contained, and Jason should weigh A again.
- S-M4 shows Blob-slice entries cost memory or time proportional to the whole relic: entries move to range reads (2.8 and 4.2 change).
- S-M2 shows git cannot list ignore rules outside a work tree without side effects: mode 2 needs another matcher, and that is a new decision.
- S-M3 shows common producers write ZIP64 or non-UTF-8 names: zip-index gains those before M2.
- Any existing v1 path script changes output after F1: F1 broke the v1 branch and is reverted.
