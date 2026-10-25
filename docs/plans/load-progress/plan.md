# Spec B: loading phases, the record-0 key check, and the damaged-file card

Finalizes `agent://RelicKeyCheckAndLoading` section 3 with Jason's answers of 2026-10-24. Base: origin/main `76269ed5`. Ships as its own PR from `feat/relik-load-progress`. Workstream C (Copy link panel) is a separate PR; workstream A (anchored comment popovers everywhere) is a third. All line numbers are at `76269ed5`.

## 1. Goal

PATH sentence, registered in `packages/relic-mcp/PATH.md`:

> A reader opening any relic link on a slow connection sees the Relik bar and a named phase, with bytes against the total, from the first painted frame until the content appears. A link whose key does not open the relic stops downloading after the first block and says the relic could not be opened. A relic whose start decrypts but whose later blocks fail says the link is fine and the stored file is damaged.

Checks:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
mise exec -- bun packages/relic-mcp/test/load-progress-path.ts    # prints LOAD_PROGRESS_PATH_OK
# after deploy, once, by the main agent:
RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic mise exec -- bun packages/relic-mcp/test/load-live-probe.ts   # prints LOAD_LIVE_OK
```

## 2. Jason's answers (settled, do not reopen)

1. Check the key in the browser against record 0 and cancel the download on failure. No server-side check.
2. When record 0 opens but a later part fails: drop key entry, say the link is fine and the stored file was changed or damaged, offer retry and report.
3. Add one sentence to the policy page saying storage can tell when an open stops after the first block.
4. After deploy, publish one 1-day relic on relik.link and open it only from an isolated headless browser on a throttled network.

## 3. Corrections to the brief and to the earlier draft

1. **Retry loses the key today.** Every `retry` card calls `window.location.reload()` (main.ts:7311-7316). The fragment was stripped on load and the vault is written only after a successful decrypt (viewer.ts:320-330), so a first open whose download is cut short reloads into "This link is missing its key". This PR makes Try again rerun the open in place with the key still in memory, for every retry card.
2. **PDF has no usable ready signal.** `relic:page-changed` is dispatched before page 1 paints (pdf.ts:102-114), and `mountPdf` swallows render errors into its own card (pdf.ts:155-168). pdf.ts gets an explicit `relic:render-state` event.
3. **The Rendering indication does not go in the taskbar.** A token in `.identity-meta` adds an element to the 320px floor accounting (viewer.md 6.5, lines 383-407), and refreshing it would mean rebuilding the bar, which drops focus from any bar control. It is a status pill outside the bar instead, and B does not touch `buildBar` at all.
4. **Proof paths are registered in `packages/relic-mcp/PATH.md`**, not the root PATH.md (which holds only the OTIO review path). The live probe follows the existing `cover-live-probe.ts` precedent (relic-mcp PATH.md:211-230; cover-live-probe.ts:1-13, 104-115): 1-day TTL, empty title, never prints the share URL. relic-mcp registers no delete tool and the operator `DELETE /api/relics/:id` needs the operator token (app.ts:2430-2438), so the proof relic simply expires after a day.
5. **Nothing in the repo uses `Network.emulateNetworkConditions`, `Network.loadingFailed`, or `encodedDataLength`** (only historical notes in docs/plans/og-cover/plan.json:36). The proofs add them.
6. **Version switching fails silently today.** `showVersion` acts only on `res.kind === 'ready'` (main.ts:7237-7241).
7. **No `--smoke` mode.** The local proof runs in full in the Linux verify job; the `--smoke` convention belongs to `otio-browser-controls.ts`.
8. **The key-entry field's wording belongs to workstream C.** B keeps main.ts lines 7330-7351 byte-identical so the two PRs merge cleanly.
9. **The unused `{ kind: 'loading' }` variant** (viewer.ts:44) is deleted, and `cachedCiphertext` is replaced by `cachedPrefix` everywhere it is produced or consumed (viewer.ts:49, 379, 931, 943-945; main.ts:7285, 7369, 7379, 7820).
10. **B needs fewer `main.ts` regions than A's §5.10 table allots it.** B reads every class's ready signal from outside the renderers, so it never edits `buildBar`, `renderImageView`, `sandboxFrame`, `renderMediaView`, or the OTIO case in `buildCurrentStage`. C5 lists exactly what B touches.

## 4. Shared contracts (settled here; workers implement exactly this)

### C1. `@relic/format` stream opener (new `packages/relic-format/src/stream.ts`, exported from `src/index.ts`)

```ts
export interface StreamOpenProgress {
  readonly receivedBytes: number;            // ciphertext bytes read so far, header included
  readonly objectLength: number;
  readonly openedContentBytes: number;       // content plaintext bytes decrypted so far (record 0 excluded)
  readonly contentLength: number | undefined; // entry.length, once record 0 authenticates
}
export interface StreamOpenOptions {
  readonly objectLength: number;
  readonly fragmentVersion?: number;          // default FORMAT_VERSION
  readonly maxContentBytes?: number;          // refuse a larger entry.length before allocating
  readonly onPrefix?: (prefix: Uint8Array) => void;    // once: HEADER_BYTES + record-0 bytes, BEFORE record 0 is decrypted
  readonly onEnvelope?: (envelope: Envelope) => void;  // once: after record 0 authenticates
  readonly onProgress?: (progress: StreamOpenProgress) => void; // after every chunk read and every record decrypted
}
export function openRelicStream(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
  options: StreamOpenOptions
): Promise<OpenedRelic>;
```

Rules:

1. Read with `source.getReader()` and a `read()` loop only. Never `for await` (no shipping Safari supports it, viewer.md:263).
2. Before throwing any refusal, `await reader.cancel()` and ignore its rejection. On success, `releaseLock()`.
3. Transport is classified before crypto. The stream ending short of `objectLength`, or `read()` rejecting, throws `TransferIncompleteError(received, objectLength)`. Receiving more than `objectLength` cancels and throws `MalformedContainerError`.
4. The 21-byte header (`HEADER_BYTES`, rfc8188.ts:21) is parsed with the existing decoder, with today's refusals (`KeyIdPresentError` for `idlen != 0`, `MalformedContainerError` when no record fits).
5. Record 0 is `min(rs, objectLength - HEADER_BYTES)` bytes. Call `onPrefix` with exactly `HEADER_BYTES` plus those bytes, then decrypt. A tag failure is `DecryptFailedError(0)`.
6. After record 0: decode the envelope with `fragmentVersion` (today's `VersionMismatchError`), call `onEnvelope`, then refuse `entry.length > maxContentBytes` (`ContentTooLargeError(entry.length, maxContentBytes)`) and `entry.length > plaintextSizeUpperBound(objectLength, rs)` (`MalformedContainerError`) before allocating `new Uint8Array(entry.length)`.
7. Decrypt each content record as soon as its bytes are buffered. Never hold more than one record of ciphertext beyond the current read.
8. End of object: the delimiter-2 record must be the last record by position, nothing may follow it, and the content total must equal `entry.length`. A positional last record with delimiter 1, or a content total short of `entry.length`, throws `TruncatedContainerError`. A delimiter-2 record before the end, or content beyond `entry.length`, throws `MalformedContainerError`. Record 0 may carry delimiter 2 only when it ends the object and `entry.length === 0`.
9. A tag failure in record n ≥ 1 is `DecryptFailedError(n)` (the class already exposes `recordSeq`, errors.ts:79-84).
10. `openRelic(container, key, fragmentVersion)` (container.ts:114-148) becomes a wrapper over a one-chunk stream with `objectLength = container.length`, so both paths share one set of rules. `openEnvelope` (container.ts:157-167) keeps its signature and behavior. Every other caller (relic-mcp inventory.ts:523, resolve-anchor.ts:811, e2e.test.ts:267, otio-path.ts:6838) opens complete objects and is unaffected.

### C2. New errors and the copy module (`@relic/format`)

`src/errors.ts`:

```ts
export class TransferIncompleteError extends RelicFormatError {
  override readonly name = 'TransferIncompleteError';
  constructor(readonly receivedBytes: number, readonly expectedBytes: number) { super(/* message */) }
}
export class TruncatedContainerError extends MalformedContainerError {
  override readonly name = 'TruncatedContainerError';
}
```

New `src/load-copy.ts`, exported from `src/index.ts`. Strings are verbatim from `docs/design/surface.md` at the cited lines. The ellipsis is U+2026.

| Export | Value | Source |
|---|---|---|
| `LOAD_EXPLANATION` | `The file in this link is decrypted in your browser. The key is in the link and your browser never sends it to Relic's servers.` | surface.md:85 |
| `LOAD_OPENING` | `Opening…` | surface.md:212 |
| `PHASE_FETCHING` / `PHASE_DECRYPTING` / `PHASE_RENDERING` | `Fetching` / `Decrypting` / `Rendering` | viewer.md:371 |
| `TRANSFER_LABEL` / `CONTENTS_LABEL` | `TRANSFER` / `CONTENTS` | surface.md:232, 240 |
| `REPORT_LINK_LABEL` | `Report this relic` | surface.md:256 |
| `POLICY_LINK_LABEL` | `How Relic handles your data` | surface.md:256 |
| `NOSCRIPT_TITLE` | `This page needs JavaScript to open a relic.` | surface.md:252 |
| `NOSCRIPT_DETAIL` | `Relic decrypts the file in your browser, so with JavaScript off there is nothing here to decrypt it with. Nothing has been sent to Relic's servers and the key in this link has not been used, so the link still works in a browser that runs JavaScript.` | surface.md:254 |
| `INSECURE_TITLE` | `This page did not arrive over a secure connection` | surface.md:266, trailing period dropped like every card headline |
| `INSECURE_DETAIL` | `Browsers only allow the decryption Relic uses on a secure connection, and this one is not on it. Relic serves every relic over HTTPS, so something between this browser and Relic changed that. On a company, campus, or hotel network it is usually a device that inspects traffic.` | surface.md:268 |
| `INSECURE_ADVICE` | `Opening the same link on a different network is the thing most likely to work. Reloading on this one will not.` | surface.md:270 |

### C3. Viewer pipeline (`packages/relic-viewer/src/viewer.ts`)

```ts
export interface LoadContents { readonly filename: string; readonly length: number }
export type LoadProgress =
  | { readonly phase: 'opening' }
  | { readonly phase: 'fetching'; readonly received: number; readonly total: number; readonly contents?: LoadContents }
  | { readonly phase: 'decrypting'; readonly opened: number; readonly contents: LoadContents };
export interface CachedPrefix { readonly prefix: Uint8Array; readonly mint: MintResponse }
export interface LoadResume { readonly fragment: string; readonly mint?: MintResponse }
export type ViewerState =
  | { kind: 'ready'; view: ReadyView }
  | { kind: 'dead'; dead: DeadView; cachedPrefix?: CachedPrefix; resume?: LoadResume };

// DeadView.action gains 'retry-report' (Try again plus Report this relic).
export interface ViewerDeps { /* existing fields */ readonly secureContext?: () => boolean }

export function load(relicId: string, deps: ViewerDeps,
  onProgress?: (p: LoadProgress) => void, resume?: LoadResume): Promise<ViewerState>;
export function openRelicWithKey(relicId: string, input: string, deps: ViewerDeps,
  cachedPrefix?: CachedPrefix, onProgress?: (p: LoadProgress) => void): Promise<KeyEntryAttemptResult>;
// KeyEntryAttemptResult 'wrong_key' gains `cachedPrefix?: CachedPrefix`.
export function loadHistoricalVersion(relicId: string, requestedVersion: number, current: ReadyView,
  deps: ViewerDeps, onProgress?: (p: LoadProgress) => void): Promise<HistoricalVersionState>;
export function formatBytes(bytes: number): string;               // decimal, rule 10
export function formatTransfer(received: number, total: number): string; // '41.2 of 105.3 MB'
export function progressLine(p: LoadProgress): string;            // 'Opening…' | 'Fetching 41.2 of 105.3 MB' | 'Decrypting 98.1 of 104.9 MB'
```

Rules:

1. `secureContext` defaults to `globalThis.isSecureContext !== false && globalThis.crypto?.subtle !== undefined`, so existing test deps need no change. When false, `load` returns dead `insecure_context` (C2 copy, action `none`, no key entry) before anything else. Zero requests.
2. Phases: `opening` once before the mint request; `fetching` from the first chunk while `received < total`, with `total === mint.object_length` and `contents` present only after `onEnvelope`; `decrypting` only when all bytes have arrived and content records remain. Callbacks may be coalesced, but the final `received` equals `total`.
3. The pre-fetch refusal (`plaintextSizeUpperBound(object_length) > MAX_RENDER_BYTES`, viewer.ts:270-279) stays. `maxContentBytes` is `MAX_RENDER_BYTES` (viewer.ts:41).
4. A mint `fetch` that rejects gives dead `service_unreachable` through the existing default copy (`deadFromProblem` default, viewer.ts:649-654: "This relic could not be opened" / "Something went wrong reaching the service.", action `retry`). `load` never throws.
5. Error mapping for the current version:

| Thrown during the stream | Dead code | Copy | Action | Key entry | Extras |
|---|---|---|---|---|---|
| `TransferIncompleteError` | `truncated_transfer` | existing (viewer.ts:297-303) | `retry` | no | `resume` |
| `DecryptFailedError` with `recordSeq === 0` | `decrypt_failed` | existing (viewer.ts:371-377) | `reopen-original-link` | yes | `cachedPrefix` |
| any refusal after `onEnvelope` fired (`DecryptFailedError` n≥1, `TruncatedContainerError`, `MalformedContainerError`) | `content_damaged` | `DAMAGED_TITLE` / `DAMAGED_DETAIL` below | `retry-report` | no | `resume` |
| `ContentTooLargeError` | `too_large` | existing | `none` | no | |
| `KeyIdPresentError`, `VersionMismatchError`, empty envelope, `MalformedContainerError` before record 0 | existing codes | existing | existing | existing | |

   `DAMAGED_TITLE = 'The stored file is damaged'` and `DAMAGED_DETAIL = 'The start of the file decrypted with this link, so the link is fine. A later part did not, which means the stored file was changed or damaged.'` live in viewer.ts beside the other dead copy. `isKeyEntryRecoverable('content_damaged')` is false.
6. Vault: remember only on success (unchanged). On `content_damaged` and `truncated_transfer`, keep a vault-supplied key: record 0 proved it, or nothing tested it. On `decrypt_failed` from the vault, forget it (unchanged, viewer.ts:367).
7. `resume` carries the fragment actually used and the mint. `load(id, deps, onProgress, resume)` skips `takeFragment`, `stripFragment` and the vault, and reuses `resume.mint.url` when `Date.parse(url_expires_at) - now >= 60_000` (the service minimum, relic-server config.ts:144); otherwise it mints again.
8. `openRelicWithKey`: with `cachedPrefix`, check the typed key with `openEnvelope(prefix, key, version)` first; a `DecryptFailedError` returns `wrong_key` ("That key does not open this relic.", viewer.ts:1039-1044) with zero requests. Otherwise fetch the whole object, reusing `cachedPrefix.mint.url` under rule 7, and stream it with `onProgress`. Without `cachedPrefix`, a record-0 failure returns `wrong_key` plus the new `cachedPrefix`, so the next attempt costs nothing.
9. `loadHistoricalVersion` streams the same way and keeps its existing result codes: `TransferIncompleteError` gives `version_truncated`; any decrypt or post-record-0 refusal gives `version_decrypt_failed`. The four-argument call in `buildThread` (main.ts:5274) keeps working unchanged.
10. `formatBytes` becomes decimal: below 1000 it prints `'999 B'`; otherwise one decimal place in KB, MB or GB by powers of 1000 (`1236` gives `'1.2 KB'`, `104_857_600` gives `'104.9 MB'`, `105_298_736` gives `'105.3 MB'`). `formatTransfer(r, t)` prints `r` in `t`'s unit. Existing callers (viewer.ts:274, 511, 960; main.ts:1128, 1261) need no edits, and no existing test asserts the old output.

### C4. DOM, events, and signals

**Static plate** (server shell for relic targets only, adopted by `boot`; also mounted by `boot` when absent). Direct children of `body`, like `renderDead`:

- `header.bar[data-load-bar]` containing `.mark` (`relik.link`), `.identity` (`.filename[data-load-custody]` reading `Opening…`, then `.identity-meta > .accession` with the escaped relic id), then `.actions` with `a.action[href="/policy"]` (icon plus span `How Relic handles your data`) and `a.action[href="/abuse"]` (icon plus span `Report this relic`). Each link also carries an `aria-label` equal to its label, so it keeps its name when labels collapse below 34rem.
- `main.stage.stage-loading[data-load-plate][data-load-phase="opening|fetching|decrypting"]` containing `.card.load-card`:
  - `p.load-phase[role=status][aria-live=polite]` holding only the phase name (`Opening…`, `Fetching`, `Decrypting`). It changes only at phase transitions, so screen readers are not flooded.
  - `div.load-meter[role=progressbar][aria-valuemin=0][aria-valuemax=<total>][aria-valuenow=<received>][aria-valuetext=<formatTransfer>]`; no `aria-valuenow` while opening (indeterminate).
  - `p[data-load-transfer]`: `TRANSFER 105.3 MB` once the mint returns, then `Fetching 41.2 of 105.3 MB`, then `Decrypting 98.1 of 104.9 MB`.
  - `p[data-load-contents][hidden]` until `onEnvelope`, then `CONTENTS 104.9 MB`. At the same moment the custody line swaps `Opening…` for the filename.
  - `p.card-note` with `LOAD_EXPLANATION`.
- The meter animates only under `prefers-reduced-motion: no-preference`.

**No JavaScript.** The shell head gets `<noscript><style>.stage-loading{display:none}</style></noscript>` after the Open Graph block; the body gets a `<noscript>` card with `NOSCRIPT_TITLE`, `NOSCRIPT_DETAIL` and both links. No field of any kind. The CSP stays as it is (`style-src 'self' 'unsafe-inline'`, app.ts:3556-3567).

**Dead cards** keep the plate bar (never a second `header.bar`) and replace the plate `main` with `main.stage.stage-dead > .card`: `h1.card-title`, `p.card-note`, actions `button[data-dead-action=retry]` (`Try again`) and/or `a[data-dead-action=report][href="/abuse"]` (`Report this relic`), key entry when recoverable, then `.accession` with the code. `retry-report` renders both. Try again reruns the open in place through `resume` and re-mounts the plate; it never reloads.

**Render state after `renderReady`.** `trackRenderState` runs in `showSingle` right after the stage is attached:

- `main.stage` gets `data-render-state="rendering|ready|error"`; `.stage-wrap` gets `aria-busy="true"` while rendering.
- `body > div.render-status[data-render-status][role=status]` reads `Rendering` while rendering and is removed on ready or error. It sits outside the taskbar, never covers a sandboxed frame, and causes no layout shift. The mock settles its exact placement.
- Signals, all consumed as they exist today except PDF:

| Class | Ready | Error |
|---|---|---|
| image | `img.relic-image` `load`, or already `complete && naturalWidth > 0` | `error` |
| media | `loadedmetadata` on `video.relic-media` / `audio.relic-media`, or `readyState >= 1` | `error` |
| pdf | `relic:render-state` with `detail: 'ready'` from the PDF wrapper (new, pdf.ts) | the same event with `detail: 'error'` (pdf.ts catch, and the import catch in `renderPdfView`, main.ts:1166-1176) |
| otio | first `relic:otio-ready` (otio-view.ts:1611-1613, 1669-1671, 1677-1679), or `.otio-view[data-ready]` already `true`, `diagnostic` or `structural` | `data-ready="error"` (otio-view.ts:275; main.ts:1316) |
| html, jsx, svg (frame) | first `message` whose `source` is the stage frame's `contentWindow` and `data.type === 'relic:tree'` (posted after every render, sandbox.ts:1381-1385, 1893, 1898) | none; stays rendering until the tree arrives |
| markdown, code, download, jsx source fallback | on mount | none |

- Once ready, the state never returns to rendering (OTIO's `data-ready` can flip back to `false` while buffering, otio-view.ts:1542, 1587).

**Version switch.** While `loadHistoricalVersion` runs from `showVersion`, the current view stays and the same pill carries `data-version-progress` with `Opening version 2`, then `Version 2: Fetching 41.2 of 105.3 MB`. On `unavailable`, the pill goes and `toast(detail)` says why (for example "Version 2 could not be downloaded. Version 3 remains open.").

**Comparison.** `renderComparison`'s existing `p.diff-loading[role=status]` (main.ts:2849-2853) appends the loading version's `progressLine`, for example `Loading comparison: version 1 and version 3. Version 1: Fetching 41.2 of 105.3 MB`.

### C5. File ownership (B vs A and C)

B edits only the regions marked B. Everything else in `main.ts`, `styles.css` and `popover.ts` belongs to A or stays untouched. The C spec carries the same table, which refines A's §5.10 (`agent://AnchoredPopoverEverywhereSpec`) for B and C: B claims fewer `main.ts` regions than that table allows, and C's extra regions sit outside every A region.

| File | B owns | C owns | A owns |
|---|---|---|---|
| `relic-viewer/src/main.ts` | `@relic/format` import list 17-22 and `./viewer.ts` import list 182-196 (add names only, no new statements); `renderPdfView` catch 1166-1176; `renderComparison` 2809-2858 (getVersion and loading line only); `renderReady` 7218-7225 (tracker call after the stage is attached) and 7227-7242 (`showVersion`); a new block inserted between 7278 and 7280; `renderDead` 7280-7412 except 7330-7351; `makeBrowserDeps` and `boot` 7778-7827 | one new `./copy-link.ts` import statement in the first import chunk (17-52; Biome sorts it after `./annotate-time.ts`); `buildBar` 747-756; a new block before the share-panel banner at 6721; the key-entry literals at 7333, 7341, 7351 | names in the `./popover.ts`, `./annotate-frame.ts`, `./comments.ts`, `./otio-bridge.ts` and `./diff.ts` statements; a `sandboxFrame` branch near 1003-1011; `buildCurrentStage` 1275-1285; 2485-2581; 3453-6681 |
| `relic-viewer/src/styles.css` | a new section inserted after line 1566 (after `.stage-dead .accession`, before the PDF banner at 1568): plate, dead and damaged cards, render pill, version progress | 715-746 (narrow collapse rule); a new section after the toast block (after 3452); `.toast` 3429-3440 (z-index only) | 241-444 (popover); 4128-4162 (composer) |
| `relic-viewer/src/popover.ts` | none | none (uses the existing `copyText` and `COPY_FAILED_NOTE` exports) | sole owner |
| `relic-viewer/src/viewer.ts`, `pdf.ts` | sole owner | none | none |
| `relic-viewer/src/copy-link.ts` (new) | none | sole owner | none |
| `relic-viewer/src/otio-view.ts`, `otio-bridge.ts`, `media-player.ts`, `media-timeline.ts`, `annotate-*.ts`, `sandbox.ts` | reads the C4 signals only | none | A |
| `relic-format/src/*` except `mnemonic.ts` | sole owner | none (reads `mnemonic.ts`) | none |
| `relic-server/src/app.ts`, `test/app.test.ts` | sole owner | none | none |
| `docs/spec/viewer.md` | §6.1 item 4 (line 274); new paragraphs after the "Repeat opens" paragraph (after 379, before "The PWA case" at 381) | §6.4 paragraphs at 373 and 377 | §6.1 item 13 (283); §6.6 |
| `docs/spec/format.md` §3.5, `docs/spec/service.md` §5 | B | none | none |
| `docs/decisions.md` | appends one entry | appends one entry | appends one entry |
| `packages/relic-mcp/PATH.md` | two sections before `## OpenTimelineIO end-to-end path` (296) | one section before `## Change emails on the live service` (273) | appended at the end |
| `.github/workflows/verify.yml` | a new step after `OTIO path` (136-147), before `Upload OTIO browser proof` (149); any job timeout change | a new step after `Install headless Chrome` (105-113) | a new step after `Notify path` (94-95) |

Contracts the other workstreams keep: A keeps `img.relic-image`, `video.relic-media`, `audio.relic-media`, `iframe.usercontent-frame`, `.otio-view[data-ready]`, `relic:otio-ready`, `relic:page-changed`, `buildStageWrap`'s output shape, the four-argument `loadHistoricalVersion` call, `buildThread`'s signature (so `renderReady` 7196-7217 and 7256-7275 stay as they are), and its document Escape and pointerdown handlers in the bubble phase. Neither A nor C edits `viewer.ts`. Expected conflicts only: the import block (keep both sides, let Biome sort) and the end of `docs/decisions.md` (keep every entry in merge order). Anything else means a boundary was crossed.

## 5. Slices

Every worker runs in its own isolated worktree and branch from `76269ed5`, commits each working increment, and hands back a clean branch. The integrator (main agent) merges slices into `feat/relik-load-progress` in a dedicated integration worktree and opens the PR up front as a draft. Do not set `model` on any dispatch. Designer slices use `agent: "designer"`. Judgement slices use `effort: "hi"`.

**Order.** Wave 0: M, F1, D. Wave 1, after F1: F2, and S once M is committed. Wave 2, after F2: V1. Wave 3, after V1 and M: V2 and V3. P is written from Wave 1 (the C4 selectors are fixed) and runs after S, V2 and V3 are integrated. R runs after the P run. L runs after merge and a verified deploy.

### M. Mock (`agent: designer`)

- **Files.** New `docs/plans/load-progress/mockup.html`, `docs/plans/load-progress/plan.md` (this spec, verbatim from the local file the main agent supplies), and `docs/plans/load-progress/mock-shots/`.
- **Conventions** (from `docs/plans/otio/mockup.html`): one self-contained file; CSP meta `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`; tokens and chrome copied from `packages/relic-viewer/src/styles.css`; a theme select (system, light, dark) setting `data-theme`; state navigation that also reads `#state=<name>`, like `docs/plans/share/mockup.html`; localStorage only; system fonts. No width switcher: the review loads the mock at real viewport sizes.
- **States, each reachable by clicks**, with every string from C2, C3 and C4 word for word:
  1. Before JavaScript runs (static plate).
  2. JavaScript off (noscript card).
  3. Opening.
  4. Fetching before record 0: custody `Opening…`, `TRANSFER 105.3 MB`, then `Fetching 0.6 of 105.3 MB`.
  5. Fetching after record 0: a long filename showing the ellipsis, `CONTENTS 104.9 MB`.
  6. Decrypting.
  7. Rendering for PDF, image, media, OTIO, and a sandboxed page (the pill visible, the frame uncovered).
  8. Ready.
  9. Could not be opened, with key entry. Use C's key-entry strings: prompt `If you have the key phrase or the full link for this relic, enter it here.`, label `Key phrase or link`, placeholder `The 12 words, or the whole link`.
  10. Key entry after a typed key passes the local check, with the fetching line under the form.
  11. Damaged file: `The stored file is damaged`, its detail, `Try again`, `Report this relic`, no key entry.
  12. Download cut short, with Try again.
  13. Service unreachable, with Try again.
  14. Insecure connection, with no retry and no field.
  15. Version switch: the current view stays, the pill reads `Version 2: Fetching 41.2 of 105.3 MB`; then the failure toast.
  16. The comparison loading line with bytes.
- **Controls.** A "simulate a throttled open" button that animates states 3 to 8 with fake byte counts. No network.
- **Not in scope.** A new visual language. This is Relik's existing chrome, extended.
- **Acceptance.** Loaded in isolated headless Chrome at 1440x900, 390x844 and 320x568, in light and dark, it makes zero requests beyond the document, has no horizontal overflow, and every state is reachable by clicks. A screenshot of each state at each size is committed to `mock-shots/`.

### F1. Format errors and copy (task)

- **Files.** `relic-format/src/errors.ts`, new `src/load-copy.ts`, `src/index.ts`, new `test/load-copy.test.ts`.
- **Change.** C2 exactly.
- **Not in scope.** `stream.ts`, the container rules.
- **Acceptance.** `load-copy.test.ts` asserts each constant equals its C2 value; `TransferIncompleteError` and `TruncatedContainerError` are exported, are `instanceof` their parents, and carry their fields. These fail on main because the module and classes do not exist.

### F2. Streaming opener and strict end of stream (task, effort hi)

- **Files.** New `relic-format/src/stream.ts`; `src/container.ts` (`openRelic` wrapper only); `src/index.ts`; `test/container.test.ts`; new `test/stream.test.ts`.
- **Change.** C1.
- **Not in scope.** The encoder, `openEnvelope`, `rfc8188.ts` record crypto.
- **Fail on main, pass after** (container.test.ts):
  1. `openRelic` refuses a container cut at a record boundary with `TruncatedContainerError`. On main it returns short content: the earlier probe returned 196,557 of 196,567 declared bytes, because the loop at container.ts:134-147 never checks for the final record or the envelope length.
  2. `openRelic` refuses bytes after the delimiter-2 record with `MalformedContainerError` (main breaks at `isLast`, container.ts:144, and ignores the rest).
  3. `openRelic` refuses records that authenticate but total fewer bytes than `entry.length` (built with the test key through `encryptRecord`) with `TruncatedContainerError`, and more bytes with `MalformedContainerError`.
- **New** (stream.test.ts):
  4. Output equals `openRelic` for content sizes 0, 1, capacity-1, capacity, capacity+1 and 3×capacity+7, at `rs=64` (the `RS` helper, container.test.ts:33-56) and the default `rs`, with source chunk sizes 1, 7, `rs`, `rs+1` and the whole object.
  5. Wrong key: a counting pull stream reports at most `HEADER_BYTES` plus record-0 bytes plus one chunk pulled, and exactly one `cancel()`. The error is `DecryptFailedError` with `recordSeq === 0`; `onPrefix` received exactly `21 + min(rs, objectLength - 21)` bytes; `onEnvelope` never fired.
  6. A stream that closes early, or whose `read()` rejects, throws `TransferIncompleteError`, never `DecryptFailedError`.
  7. Bytes beyond `objectLength` throw `MalformedContainerError` after a `cancel()`.
  8. A declared `entry.length` above `maxContentBytes` throws `ContentTooLargeError` before the second content record is pulled.
  9. `onEnvelope` fires once, after record 0 and before any content record decrypts. `onProgress` is monotonic and ends with `receivedBytes === objectLength` and `openedContentBytes === entry.length`.
  10. A byte flipped in record 2 throws `DecryptFailedError` with `recordSeq === 2`, after `onEnvelope` fired.
  11. The existing `truncation fails authentication` test (container.test.ts:375-380) still passes.

### D. Docs (task)

- **Files.** `docs/spec/viewer.md`, `docs/spec/format.md`, `docs/spec/service.md`, `docs/decisions.md`. Write the text below verbatim.
- **viewer.md §6.1, replace item 4 (line 274):**

  > 4. **Decrypt failed, split at the first record.** **A record-0 failure** is a wrong key or a damaged start of the file, which are indistinguishable at the API level, so the copy names both causes and never says "wrong key" (`format.md` §3.5), and the download stops after that record (§6.4). **A failure after record 0** cannot be the key, because record 0 authenticated under it, so the page says the link is fine and the stored file was changed or damaged (§6.4), with no key entry.

- **viewer.md §6.4, insert after the "Repeat opens reuse a still-valid signed URL" paragraph (after line 379):**

  > **The first record is the key check.** Record 0 carries the envelope and authenticates on its own, so the viewer reads the signed download as a stream, decrypts record 0 as soon as its bytes arrive, and cancels the download when its tag fails. A link whose key does not open the relic costs one block of egress instead of the whole object. The could-not-be-opened screen keeps that block, so a key typed there is checked locally before anything is fetched again. The check runs only in the browser: no key, proof, or verifier is sent for it. The one new observable, an open that stops after its first block, is disclosed (`service.md` §5 item 10).
  >
  > **After record 0, a failure is the file's, not the link's.** Once record 0 authenticates, the key is proven. A later record that fails its tag, a container without its final record, bytes after the final record, or content that disagrees with the envelope's length shows: **"The start of the file decrypted with this link, so the link is fine. A later part did not, which means the stored file was changed or damaged."** It offers Try again and Report this relic, and no key entry, because no other key would help. A transfer that ends short of the mint's object length is a network failure and says so. Try again reruns the open with the key still in memory; reloading would land on a page whose key was stripped.

- **format.md §3.5**, replace the last bullet (line 176) with:

  > - **A record-0 tag failure is indistinguishable from a wrong key** from the recipient's side. The viewer must not claim "wrong key" on it, because tampering produces the identical symptom.
  > - **Record 0 authenticating proves the key.** A tag failure after it belongs to the stored object, not the link, and the viewer says so (`viewer.md` §6.4).
  > - **A container ends with its final record.** The last record carries padding delimiter 2, nothing follows it, and the content records decrypt to exactly the envelope's declared length. A container that breaks any of the three is refused rather than returned short. Records sit at fixed offsets, so an object cut at a record boundary authenticates record by record, and until 2026-10-24 it was accepted.

- **service.md §5**, insert after item 9 (before "One more, assigned by `format.md` 3.8"):

  > 10. **The failed-open signal.** The viewer checks the key against the first record before downloading the rest and cancels the download when it fails (`viewer.md` §6.4), so the storage provider and anyone watching the connection can see an open that stopped after its first block, which usually means a wrong key. The statement says so in one sentence. The key is never sent and cannot be derived from the stop. For classes that render, the operator could already infer a failed open, because the comment-thread request follows only a successful decrypt. For archive and binary relics the signal is new.

- **decisions.md**, append:

  > ## 2026-10-24: The key is checked against the first record, every relic shows its loading phases, and a truncated relic is refused
  >
  > **Record 0 is the key check, in the browser only.** Jason Waldrip approved checking the key against the first record and cancelling the download when it fails, with no check on the server. The viewer streams the signed download and decrypts record 0 as soon as its 65,557 bytes arrive. A wrong key used to download the whole object, up to 105,298,736 bytes, before saying the relic could not be opened. Server-side checks were rejected. A verifier returned to readers needs a stored value that relics published before sharing lack, and it could not be trusted anyway. Sending the share proof on every open would hand the operator per-open data on who holds a working key. The one new observable, an open that stops after its first block, is disclosed on `/policy` at Jason's direction.
  >
  > **A failure after record 0 says the file is damaged.** Jason chose that a later failure drops key entry and says the link is fine and the stored file was changed or damaged, with Try again and Report this relic.
  >
  > **A truncated container is refused.** `openRelic` accepted an object cut at a record boundary. In a probe it returned 196,557 of 196,567 declared bytes, because nothing checked for the final record or the envelope's length. Every relic ever written satisfies the stricter rule, since there has only ever been one encoder.
  >
  > **Every relic page shows the bar and a named phase from the first frame.** The shell carries a static plate, so the page is never blank before `viewer.js` runs. The viewer then shows Opening, Fetching with bytes against the mint's object length, Decrypting, and Rendering, as `viewer.md` §6.3 and §6.4 and `surface.md` §7 already specified. Try again now reruns the open with the key in memory instead of reloading a page whose key was stripped.

  The live-proof sentence is added by the follow-up receipt PR after L, never before L runs.

### S. Server shell and disclosure (task; after F1 and M)

- **Files.** `relic-server/src/app.ts` (`shell()` 3439-3570 and `disclosureStatement` from 3953), `relic-server/test/app.test.ts`.
- **Change.**
  - Emit the C4 static plate and the head and body noscript blocks for relic targets only, importing the strings from `@relic/format`. Escape the accession with `escapeHtml`. The dashboard shell and `/` (`landingPage`) are unchanged. CSP unchanged.
  - Add this sentence to `disclosureStatement` as its own paragraph inside `## What we can never read`, directly after the paragraph ending `unqualified would be wrong.` (app.ts:3962-3965):

    > A link whose key does not open a relic stops downloading after the first block, so our storage provider and anyone watching the connection can tell the open stopped early but never see the key.
- **Fail on main, pass after:**
  1. `GET /{id}` contains `data-load-plate`, `data-load-phase="opening"`, `data-load-bar`, `LOAD_EXPLANATION`, `Report this relic`, `How Relic handles your data`, and the relic id inside `.accession`.
  2. It contains the head noscript style hiding `.stage-loading` and the body noscript card with `NOSCRIPT_TITLE` and `NOSCRIPT_DETAIL`.
  3. An angle-bracket path segment is escaped in the plate.
  4. The dashboard shell has no `data-load-plate`.
  5. `/policy` contains the disclosure sentence (one more `toContain` in the test at app.test.ts:629-647).
- **Must keep passing.** The no-mint tests (app.test.ts:200, 542, 553, 4998), head byte order (254), and the CSP tests (226-252).

### V1. Viewer pipeline (task, effort hi; after F2)

- **Files.** `relic-viewer/src/viewer.ts`; new `test/load-progress.test.ts`; updates to `test/viewer.test.ts`, `test/version-history.test.ts`, and `test/dashboard-and-key-entry.test.ts` (the `cachedCiphertext` cases at 644-760 move to `cachedPrefix`).
- **Change.** C3.
- **Not in scope.** The DOM and `main.ts`.
- **Fail on main, pass after** (load-progress.test.ts, with a counting pull-stream storage stub serving 16 KiB chunks):
  1. Phases arrive in order; every `fetching` event has `total === object_length`; a three-record object yields at least three distinct `received` values; `contents` appears only after record 0.
  2. Wrong key on a 5 MB object: dead `decrypt_failed`; the stub saw at most 65,557 bytes plus one chunk pulled, and a cancel; `cachedPrefix.prefix.length === 65_557`.
  3. The mint fetch rejecting gives dead `service_unreachable` with action `retry` and `resume.fragment` equal to the fragment used; `load` never throws.
  4. The storage body erroring mid-stream gives `truncated_transfer` with `resume`.
  5. A byte flipped in record 2 gives `content_damaged`, action `retry-report`, `resume` present, and a vault-supplied key kept.
  6. A stored object missing its final record, with the mint's `object_length` matching what is stored, gives `content_damaged`. On main it opens with short content.
  7. `secureContext: () => false` gives `insecure_context` with zero fetch calls.
  8. `openRelicWithKey` with `cachedPrefix`: a wrong key returns `wrong_key` with zero fetch calls; the right key with a URL valid for at least 60 s makes exactly one storage GET and no mint; with an expired URL it makes one mint and one GET.
  9. `openRelicWithKey` without `cachedPrefix` and a well-formed wrong key returns `wrong_key` with a `cachedPrefix`; passing it back makes zero fetch calls.
  10. `load(id, deps, onProgress, resume)` calls neither `takeFragment` nor `stripFragment` and reuses a still-valid `resume.mint.url` without minting.
  11. `formatBytes` and `formatTransfer` give the C3 rule 10 values; `progressLine` gives the three C2 forms.
  12. `loadHistoricalVersion` with `onProgress` reports against the historical mint's `object_length`, and its outcomes are unchanged: version-history.test.ts and version-diff-ui.test.ts pass untouched.

### V2. Plate, boot, dead and damaged cards, key entry (task, effort hi; after V1 and M)

- **Files.** `relic-viewer/src/main.ts` B regions from C5 (the new block between 7278 and 7280, `renderDead` except 7330-7351, `makeBrowserDeps`, `boot`, both import lists); the B section of `styles.css` after line 1566; new `test/load-plate.test.ts`; `test/dashboard-and-key-entry.test.ts`.
- **Change.**
  - `boot` adopts the shell plate (or mounts one) before calling `load`, passes `onProgress`, and paints phases into the C4 DOM, coalescing writes per animation frame.
  - Any throw in `boot`, `load`, `renderReady` or `renderDead` ends in the default dead card. Nothing leaves a stuck plate.
  - `renderDead(dead, relicId?, usercontentOrigin?, deps?, cachedPrefix?, onRetry?)` keeps the plate bar, renders the C4 card and actions, and renders the damaged and insecure cards.
  - Key entry passes `cachedPrefix` and `onProgress`, shows `progressLine` under the form while fetching, and stores a returned `cachedPrefix`.
  - Leave the key-entry prompt, label and placeholder lines (7330-7351) exactly as they are; C changes them.
- **Not in scope.** `buildBar`, `renderReady`, class renderers.
- **Fail on main, pass after:**
  1. With a shell plate present, `boot` keeps exactly one `header.bar`, and `data-load-phase` moves opening, fetching, decrypting as `load` reports.
  2. Before the mint promise resolves, the plate reads `Opening…`. Without a shell plate, the plate is in the DOM before the first fetch call.
  3. The meter's `aria-valuemax`, `aria-valuenow` and `aria-valuetext` match; there is no `aria-valuenow` while opening; `[data-load-contents]` is hidden until the envelope, then reads `CONTENTS …`.
  4. A rejected load ends in `main.stage-dead` with no `[data-load-plate]` left.
  5. `content_damaged` renders the damaged copy, Try again and Report this relic, no `.key-entry`, and one bar with the report and policy links.
  6. Try again calls `load` with `resume`, re-mounts the plate, and never calls `window.location.reload`.
  7. Key entry with a cached prefix: a wrong key shows "That key does not open this relic." with zero fetch calls; the right key shows the fetching line, then opens.
  8. `insecure_context` renders the C2 copy with no retry and no field.

### V3. Render state, version progress, comparison bytes (task, effort hi; after V1 and M)

- **Files.** `relic-viewer/src/main.ts` B regions: `renderReady` 7218-7225 and 7227-7242, `renderComparison` 2809-2858, the `renderPdfView` catch (1166-1176), and the tracker functions in the new B block (appended after V2's functions in that block). `relic-viewer/src/pdf.ts`. CSS in a subsection appended to the end of B's styles section. New `test/render-state.test.ts`.
- **Change.** C4's render state, version switch and comparison. In pdf.ts, dispatch `new CustomEvent('relic:render-state', { detail: 'ready', bubbles: true })` on the wrapper after `await renderPage(1)` resolves, and `detail: 'error'` in the catch.
- **Not in scope.** `buildBar`, `buildCurrentStage`, `sandboxFrame`, otio-view.ts, media-player.ts.
- **Fail on main, pass after:**
  1. Image: rendering, `aria-busy="true"`, and the `Rendering` pill until the image's `load`; then ready, the pill gone, `aria-busy="false"`. `error` gives `data-render-state="error"`.
  2. Media: the same with `loadedmetadata` and `error`.
  3. PDF: the same with `relic:render-state`; a renderer import failure gives error.
  4. OTIO: ready on `relic:otio-ready`; `data-ready="error"` gives error; a later `data-ready="false"` does not return to rendering.
  5. Frame: ready on a `relic:tree` message from that frame's window; the same message from another source is ignored.
  6. Markdown, code and download are ready synchronously.
  7. `showVersion`: while loading, the current stage is still in the DOM and the pill shows `Opening version 2`, then `Version 2: Fetching …`; `unavailable` removes the pill, toasts the detail, and keeps the current view.
  8. The comparison loading line includes the version's `progressLine`.

### P. Local headless proof, CI step, PATH entries, live probe script (task, effort hi)

- **Files.** New `packages/relic-mcp/test/load-progress-path.ts`; new `packages/relic-mcp/test/load-live-probe.ts`; `packages/relic-mcp/PATH.md` (two sections before `## OpenTimelineIO end-to-end path`: "Loading phases and the first-record key check" and "Loading on the live service"); `.github/workflows/verify.yml` (the step below).
- **Harness.** Reuse the owned-browser contract from otio-path.ts:1815-1870: `discoverChrome`, `chromeArgs`, `createBrowserHeadlessLaunch`, `attestBrowserHeadless`, `connectPipe` over `--remote-debugging-pipe`, a fresh `mkdtemp` profile per run, and `cleanupOwnedBrowserStartup`. The browser comes from `RELIC_PROOF_CHROME_PATH`, else discovery (the Playwright headless shell locally). Never a headed browser, never a user profile.
- **Setup.**
  - `Bun.serve` on 127.0.0.1 with `createApp`, `MemoryStore`, `MemoryStorage(`${origin}/__storage`)` and the real built viewer assets, like cover-path.ts.
  - The `/__storage/*` route serves objects as a pull `ReadableStream` of 16,384-byte chunks with a `RELIC_LOAD_PROOF_CHUNK_DELAY_MS` delay (default 15). It counts enqueued bytes, cancellations and completions per request, and can abort a chosen request after N bytes.
  - Publish one relic per class through fresh `node packages/relic-mcp/dist/relic-mcp.js` stdio processes with `RELIC_CHROME_PATH=none`, `cover: false` and `title: ''`: md, ts, png, svg, html, jsx, pdf, mp4, wav, otio (the standard sample bundle otio-path.ts uses), zip, bin. Reuse cover-path.ts's fixture builders. Add a 6 MB random `.bin` for the cancel measurement, and a md relic republished once to version 2. Share URLs stay in memory and are never printed.
  - Recorder: `Page.addScriptToEvaluateOnNewDocument({ source, worldName: 'relic-load-proof' })` samples every animation frame in an isolated world: bar visible, plate visible and its phase, meter `aria-valuenow`, custody text, render pill visible, content stage visible, dead card visible. Visible means connected, a non-zero rect, `visibility` not hidden, and opacity above 0. Read it back with `Runtime.evaluate` in that world's execution context.
  - `Network.enable` on every run, recording `requestWillBeSent`, `responseReceived`, `dataReceived`, `loadingFinished` and `loadingFailed` for the storage request.
- **Runs and assertions.**
  1. Every class at 1440x900 light. In every sample from the first one with a `body`, the bar is visible and so is a plate, the content stage, the render pill or a dead card. Phases arrive in order. Objects of three or more chunks show at least three distinct `aria-valuenow` values. The custody line reads `Opening…` until the envelope, then the filename. Rendering classes show the pill at least once before ready. Screenshots at first progress and at ready each pass a pixel check: the bar region and the stage region are not uniform.
  2. md, png, pdf, html, otio and bin at 390x844 dark and 320x568 light: the no-blank rule, and `documentElement.scrollWidth <= innerWidth` at every screenshot.
  3. Wrong key on the 6 MB bin (one key character changed, still valid base64url and still 22 characters): the could-not-be-opened card with key entry. The server saw the storage request cancelled with at most 262,144 bytes enqueued. CDP shows `Network.loadingFailed` for it with `canceled: true`, and its `dataReceived` byte sum (`encodedDataLength`, or `dataLength` when the encoded sum is 0, with the field recorded) is at most 262,144. Then type the right key: the server mint count is unchanged, there is one more storage GET, and the relic opens.
  4. A mid-stream abort after 100 KB on md: the cut-short card. Try again opens it in place, with no `Page.frameNavigated`, no new mint (the URL is reused), and the relic renders.
  5. A byte flipped in record 2 of a stored object: the damaged card, both actions, no key entry, accession `content_damaged`.
  6. A stored object with its last record removed: the damaged card.
  7. `Emulation.setScriptExecutionDisabled({ value: true })`: the noscript card is visible, `.stage-loading` is hidden, and the mint count is 0.
  8. `Fetch.enable` failing `*/assets/viewer.js` with `BlockedByClient`: the static plate with `Opening…`, the explanation and both links is visible, and the mint count is 0.
  9. Version switch on the republished md: choosing version 1 keeps the current stage visible while the pill shows `Opening version 1`, then `Version 1: Fetching …`; version 1 renders.
- **Output.** `LOAD_PROGRESS_PATH_OK classes=12 runs=<n>`. Shots and `summary.json` go to the directory in `RELIC_LOAD_PROOF_DIR`, which the integrator commits as `docs/plans/load-progress/proof/<short-sha>/`.
- **Must fail first.** Run the proof against a build of `76269ed5` in a throwaway worktree. It must fail on the no-blank check (main's shell body holds only an empty root) and on the wrong-key bytes check (main downloads the whole 6 MB). Quote both failures in the PR body. This run is explicitly part of this slice.
- **CI step** (insert after `OTIO path`, before `Upload OTIO browser proof`):

  ```yaml
      - name: Load progress path
        run: |
          set -euo pipefail
          RELIC_PROOF_CHROME_PATH="$(command -v google-chrome)" \
          env -u DISPLAY -u WAYLAND_DISPLAY \
            bun packages/relic-mcp/test/load-progress-path.ts
  ```

  If the verify job then exceeds its 25-minute timeout, raise `timeout-minutes` on that job by the measured overrun and cite the measured duration in the PR.
- **Live probe script** (`load-live-probe.ts`, modeled on cover-live-probe.ts; written now, run only in L):
  - Refuses to run unless `RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic` is set.
  - Reads `RELIC_SERVICE_ORIGIN` (default `https://relik.link`), `RELIC_LOAD_PROBE_CLIENT` (`source` or `npx:<version>`), `RELIC_PROOF_CHROME_PATH`, and `RELIC_LOAD_PROOF_DIR`.
  - Generates a noise PNG of about 8 MB, so all four phases show. Publishes it once through stdio MCP: `relic_publish { path, ttl_days: 1, title: '', cover: false }` with `RELIC_CHROME_PATH=none`, `RELIC_CLIENT_NAME=relic-mcp/load-live-probe`, and a temp `RELIC_PUBLISH_STATE`. It never prints or writes the share URL, the key, the phrase, or the signed storage URL.
  - Run 1, the correct key at 1440x900 light, after `Network.emulateNetworkConditions({ offline: false, latency: 100, downloadThroughput: 1_000_000, uploadThroughput: 375_000, connectionType: 'cellular4g' })`. If the method is rejected, fall back to `Network.emulateNetworkConditionsByRule` with a match-all rule and record which. Asserts: the no-blank rule; phases in order through ready; at least five distinct `aria-valuenow` values; the storage request (the GET to `https://storage.googleapis.com/` after the mint) receives at least five `dataReceived` events spread over at least 2 seconds; `loadingFinished.encodedDataLength >= object_length`.
  - Run 2, a wrong key (one character changed): the could-not-be-opened card within 30 seconds; the storage request ends in `Network.loadingFailed` with `canceled: true` (errorText recorded); its `dataReceived` sum is at most 1,048,576 bytes and below `object_length / 4`; no `dataReceived` arrives for it in the 5 seconds after the card appears.
  - Run 3, the correct key at 390x844 dark: the no-blank rule and no horizontal overflow.
  - Opens used: 3 of the relic's 200. Writes `receipt.json` (the deployed viewer.js SHA-256, relic id, object length, per-run measurements, throttle method, timestamps; no secrets) and the screenshots. Prints `LOAD_LIVE_OK relic_id=<id> progress_steps=<n> cancel_bytes=<n> object_length=<n>`.

### R. Designer rendered review (`agent: designer`, after the P run)

- **Inputs.** P's screenshots and summary.json, the committed mock and its shots.
- **Task.** Load every shot and compare each state with the mock at the same size and theme: copy word for word, hierarchy, the meter, the pill's placement (outside the bar, never over a frame), contrast in light and dark, no overflow at 320. Return pass, or a numbered defect list naming the shot, the element and the fix. Defects go back to V2 or V3, then P reruns.

### L. Live proof (main agent, after merge and a verified deploy)

1. Read-only first, no writes: `GET https://relik.link/<any valid-format id>` contains `data-load-plate` (shell requests never mint); `GET /policy` contains the disclosure sentence; `GET /assets/viewer.js` contains `How Relic handles your data` and `relic:render-state`.
2. Then once: `RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic RELIC_LOAD_PROOF_DIR=<tmp> mise exec -- bun packages/relic-mcp/test/load-live-probe.ts`. This is the one live write Jason approved on 2026-10-24: one 1-day relic, no title, no cover, never shared, opened only from the isolated headless browser.
3. On `LOAD_LIVE_OK`, open a follow-up PR committing `docs/plans/load-progress/proof/live-<short-sha>/` (receipt and shots) and append to the decisions entry: "Proved live on <date>: on a throttled connection the phases showed in order, and a wrong key stopped the download after <n> bytes of <object_length>."
4. Failure policy. A blank frame, a relic that fails to open, or a damaged card on a freshly published relic means revert the merge first, then diagnose. Delivery that is not progressive, or a cancel that does not stop the transfer, does not break opening (it costs what main cost), so report it as a spec-wrong finding, correct the docs, and claim early cancel nowhere.

## 6. End to end, merge, and deploy

1. In the integration worktree: `mise exec -- bun run verify`, `mise exec -- bun run --cwd packages/relic-mcp build`, then `mise exec -- bun packages/relic-mcp/test/load-progress-path.ts` ending `LOAD_PROGRESS_PATH_OK`. Commit the proof shots. R passes.
2. The PR body states the problem, the change, the must-fail-first quotes, the proof marker and the shots path. Merge on green with `gh pr merge --merge` (never squash). Watch the deploy, then run L.
3. A, B and C merge independently. Whichever merges later runs `git pull origin main` in its integration worktree, keeps both sides of the import block, and keeps every `docs/decisions.md` entry.

## 7. What would prove this spec wrong

- The GCS body does not arrive progressively in production (`received` jumps from 0 to the total), or cancelling the reader does not end the request (no `loadingFailed`, and `dataReceived` continues).
- A genuinely published relic is refused with `TruncatedContainerError`: the "one encoder" premise is false.
- An empty frame appears between first paint and the plate. That means the stylesheet arrives after first paint, and the fix is inline critical CSS in the shell.
- An OTIO or frame signal in C4 does not fire for some fixture, leaving the pill up. The signal table is then wrong for that class; fix the table, never with a timeout.
- Jason rejects the mock's placement of the Rendering pill or the plate. Stop and re-mock before V2 and V3 style anything.

Not in scope, but drifting from the spec, recorded for Jason: the mint fires on page load rather than on a user gesture (`surface.md`:206); the CRC32C transport check is unimplemented (`viewer.md`:289-295); `surface.md`:49's zero-input build check is contradicted by the comment composer, the share panel and key entry, all of which ship.
