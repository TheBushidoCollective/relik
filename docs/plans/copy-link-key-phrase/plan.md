# Spec C: Copy link opens a panel with the link and the 12-word key phrase

Base: origin/main `76269ed5`. Ships as its own PR from `feat/relik-copy-link-panel`. All line numbers are at `76269ed5`. Workstream B (loading phases and the record-0 key check) and workstream A (anchored comment popovers everywhere) are separate PRs. Names and anchors match A's §5.10 table (`agent://AnchoredPopoverEverywhereSpec`) where it already named them.

## 0. Its own PR, not riding with B

1. **No code dependency either way.** C reads `view.shareUrl` (viewer.ts:52-69) and `@relic/format/mnemonic`, both already on main, and B changes neither.
2. **B is gated on more.** B carries a format-level integrity change (truncated containers refused) and a post-deploy production proof. C is a small UI change and should not wait on either.
3. **The overlap is disjoint at the line level.** In `main.ts`, C touches `buildBar` 747-756, one new block before 6721, three string literals at 7333, 7341 and 7351, and one import line; B touches none of those. In `styles.css`, each adds its own new section at a different anchor, and only C touches 715-746 and `.toast`. In `viewer.md` §6.4, C edits the paragraphs at 373 and 377 while B inserts after 379. `PATH.md` and `verify.yml` use different anchors. The one guaranteed conflict is both appending to `docs/decisions.md`, resolved at rebase by keeping both entries.

Riding with B would make B's review larger and tie C's ship date to B's live proof, to save one trivial doc conflict.

## 1. Goal

PATH sentence, registered in `packages/relic-mcp/PATH.md`:

> A reader on any relic presses Copy link, sees the link and its 12-word key phrase, and copies either one; a person sent the link without the key and told the phrase opens the relic.

Check:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
mise exec -- bun packages/relic-mcp/test/copy-link-path.ts    # prints COPY_LINK_PATH_OK
```

## 2. Jason's decision (settled)

Jason asked on 2026-10-24: "also when sharing can the mnemonic be visible along side the copied key?" Of three options he chose:

> **Copy link panel.** Copy link opens a small panel showing the link and the key phrase, each with its own Copy button, so you can send the link without the key and say the phrase separately. Share's message is unchanged.

He rejected adding the phrase to the Share email and rejected a toast-only phrase.

## 3. Corrections, and the one confirmation needed before C-I

1. **"Send the link without the key" needs a keyless copy, and the full-link copy must stay.** `viewer.md` §6.4 requires a copy-link control "backed by the in-memory key and reconstructing the full URL on demand" (line 377), and copying the full link is the common case. The link row keeps that copy as its primary button and adds **Copy without the key**, which copies the same link with the fragment removed. The phrase row has its own Copy.
2. **The keyless path depends on a key-entry field that `viewer.md` bans.** `viewer.md`:373 bans any key-entry field on the viewing origin, "not configurable, not conditional". A field shipped anyway: `renderDead` shows it for `fragment_missing`, `fragment_malformed` and `decrypt_failed` (main.ts:7326-7403; viewer.ts:832-838), and it accepts the 12 words (viewer.ts:856-915). A recipient who opens the keyless link lands on "This link is missing its key" (viewer.ts:210-224) and types the phrase into that field. Jason's chosen option relies on it.

   **Ask Jason once, before C-I starts:** "Sending the link without the key works only because the recipient types the phrase into the key-entry box on the missing-key page, and our viewer spec still bans that box even though it shipped. Amend the spec to allow the box as it ships, only after an open fails? (recommended), or keep the ban, drop Copy without the key, and remove the box separately?" The mock shows the recommended version, so he can answer while reviewing it. If he keeps the ban, see §8.
3. **The field calls the phrase a "recovery phrase"** (main.ts:7333, 7341, 7351), while relic-mcp calls it the key phrase (`KEY_PHRASE_DISCLOSURE`, relic-mcp server.ts:159-160). A recipient told "the key phrase" has to recognize the field, so C renames those three strings.
4. **Collapsed taskbar actions lose their accessible names.** Below 34rem, `.action span { display: none }` (styles.css:720-722) removes each label from the accessibility tree. Copy link, Download and Report carry neither an `aria-label` nor a `title`, so at 320 and 390 those three are announced as unnamed controls. C changes that one rule to a visually-hidden pattern, so every collapsed action keeps its name with no visual change.
5. **A modal panel would hide the copy toasts.** The share panel is a modal `<dialog>`, and copies there report inside the panel because "a toast on the page would land under its backdrop" (main.ts:7014-7016). The Copy link panel is non-modal, and `.toast` gets a z-index above it.
6. **The bar is rebuilt while the panel can be open.** A comment-count update replaces the whole bar element (main.ts:7204-7210, 7264-7270), and a version switch replaces the body's children (main.ts:7220-7223). The panel is a sibling inserted right after the bar, reads its open state from the DOM, and tears itself down when detached.
7. **The mnemonic stays out of the shell.** `keyToMnemonic` comes from `@relic/format/mnemonic`, lazily imported exactly as `resolveEnteredKey` does (viewer.ts:889-892). shell-budget.test.ts:52-75 already fails if the wordlist reaches `viewer.js`.
8. **A's §5.10 table under-allocates C.** It lists only the Copy link button, a new module and a CSS section. C also needs the panel's DOM block in `main.ts` (before 6721, a region no workstream owns), the three key-entry literals inside `renderDead` (which B's spec carves out for C), the 715-746 collapse rule, a headless proof with its CI step and PATH section, and the §6.4 doc paragraphs. None of these touches an A region.

## 4. Shared contracts

### C1. `packages/relic-viewer/src/copy-link.ts` (new; pure, no DOM)

```ts
/** The same origin and path with the fragment removed, and no trailing '#'. */
export function keylessLink(shareUrl: string): string;
/** The 12 words for the key in the share URL's fragment. Lazily imports the wordlist. */
export async function keyPhraseWords(shareUrl: string): Promise<readonly string[]>;
//   const { keyToMnemonic } = await import('@relic/format/mnemonic');
//   return keyToMnemonic(parseFragment(new URL(shareUrl).hash).key);
```

Copy constants, verbatim (no dashes anywhere):

| Export | Value |
|---|---|
| `COPY_PANEL_TITLE` | `Link and key phrase` |
| `LINK_LABEL` | `Link` |
| `LINK_NOTE` | `Everything after the # is the key.` |
| `COPY_LINK_LABEL` | `Copy link` |
| `COPY_KEYLESS_LABEL` | `Copy without the key` |
| `PHRASE_LABEL` | `Key phrase` |
| `PHRASE_NOTE` | `The same key in 12 words. Anyone who hears or reads it can open this relic.` |
| `COPY_PHRASE_LABEL` | `Copy phrase` |
| `SPLIT_NOTE` | `To keep the key out of a message, send the link without the key and say the phrase. They type it in where the page asks for the key.` |
| `PHRASE_LOADING_NOTE` | `Loading the key phrase.` |
| `PHRASE_FAILED_NOTE` | `The key phrase could not be loaded. The link above still works.` |
| `LINK_COPIED_NOTE` | `Link copied. It contains the decryption key.` (today's toast, main.ts:752) |
| `KEYLESS_COPIED_NOTE` | `Link copied without the key. Say the key phrase separately.` |
| `PHRASE_COPIED_NOTE` | `Key phrase copied. It is the decryption key.` |
| `KEY_ENTRY_PROMPT` | `If you have the key phrase or the full link for this relic, enter it here.` |
| `KEY_ENTRY_LABEL` | `Key phrase or link` |
| `KEY_ENTRY_PLACEHOLDER` | `The 12 words, or the whole link` |

A refused clipboard write uses the existing `COPY_FAILED_NOTE` (popover.ts:565-567). Today's `Could not copy. Copy the link from where you opened it.` (main.ts:753) is deleted with the direct copy.

### C2. Panel DOM and behavior (`main.ts`, a new block inserted before the share-panel banner at 6721)

```ts
export const COPY_LINK_PANEL_ID = 'copy-link-panel';
export interface CopyLinkPanelHandle {
  readonly element: HTMLElement;
  /** Settles when the phrase, or its failure note, is painted. */
  readonly ready: Promise<void>;
  readonly close: (returnFocus: boolean) => void;
}
/** Opens the panel, or closes the open one and returns undefined. */
export function toggleCopyLinkPanel(shareUrl: string, opener: HTMLElement): CopyLinkPanelHandle | undefined;
```

**Opener** (`buildBar` 747-756): the existing `button('Copy link', ICONS.copy, …)` gains `data-action="copy-link"`, `aria-haspopup="dialog"`, `aria-expanded` (`"true"` exactly when `#copy-link-panel` is in the document, so a rebuilt bar reads it correctly), and `aria-controls="copy-link-panel"` only while open. A click calls `toggleCopyLinkPanel(view.shareUrl, button)` and writes nothing to the clipboard.

**Panel**, inserted as the next sibling of the current `header.bar` (appended to `body` when there is no bar), non-modal:

```
section#copy-link-panel.copy-panel[role=dialog][aria-labelledby=copy-link-title]
  div.copy-panel-head
    h2#copy-link-title.copy-panel-title           COPY_PANEL_TITLE
    button.copy-panel-close[type=button][aria-label=Close]      close icon
  div.copy-panel-body
    div.copy-row[data-copy-row=link]
      p.copy-label                                 LINK_LABEL
      p.copy-value[data-copy-value=link]           <span>origin and path</span><span class=copy-link-key>#r1…</span>
      div.copy-actions
        button.action.primary[data-copy=link]      copy icon, COPY_LINK_LABEL
        button.action[data-copy=keyless]           COPY_KEYLESS_LABEL
      p.copy-note                                  LINK_NOTE
    div.copy-row[data-copy-row=phrase]
      p.copy-label                                 PHRASE_LABEL
      ol.copy-phrase[data-copy-value=phrase][aria-label="Key phrase, 12 words"]   12 li, numbered by CSS counters, not text
      div.copy-actions
        button.action[data-copy=phrase]            copy icon, COPY_PHRASE_LABEL
      p.copy-note                                  PHRASE_NOTE
    p.copy-note.copy-split                         SPLIT_NOTE
```

Behavior:

1. **Open.** Build the panel with the link row filled in. The phrase list shows `PHRASE_LOADING_NOTE` with `aria-busy="true"` and Copy phrase disabled until `keyPhraseWords` resolves, then 12 `li` in order. On rejection it shows `PHRASE_FAILED_NOTE` and Copy phrase stays disabled. Focus moves to `[data-copy=link]`.
2. **Position.** Set `--copy-top` to the current bar's bottom, as the share panel does with `--share-top` (main.ts:7124-7132), and `--copy-right` to the viewport width minus the opener's right edge, clamped so the panel stays at least 0.5rem inside the viewport. Recompute on `resize`, coalesced per animation frame. Below 34rem the stylesheet makes it a full-width sheet under the bar.
3. **Copy.** Each button calls `copyText` (popover.ts:556-562) inside its click handler with the share URL, `keylessLink(shareUrl)`, or the words read from the panel's `li` text joined by single spaces. Success toasts the matching `*_COPIED_NOTE` through `toast()` (main.ts:341-349). Failure selects the matching text in the panel (the link value, or the phrase list) and toasts `COPY_FAILED_NOTE`. The panel stays open after a copy.
4. **Close.** The close button, Escape, a second press on the opener, a `pointerdown` outside both the panel and the opener, and focus leaving both (`focusout` with a `relatedTarget` outside them). Escape and the close button return focus to the opener, or to the current `.bar [data-action="copy-link"]` when the original opener was replaced. An outside press and focus leaving move no focus. Escape pressed inside the panel calls `stopPropagation()`, so an open comment card behind it is left alone.
5. **Teardown** removes the panel and every listener it added: document `keydown` and `pointerdown`, window `resize`, and a `MutationObserver` on `document.body` (`childList`) that sees the panel detached by a body replacement and tears down at once. Opening while a stale `#copy-link-panel` exists removes it first, so there is never more than one.
6. **The phrase exists only in the open panel.** It is computed on open and never kept in a variable that outlives the panel; copy handlers read it from the panel's DOM. It is never written to localStorage, sessionStorage, IndexedDB, the key vault, `history`, the URL, `document.title`, an attribute (`title`, `aria-*`, `data-*`), any element outside the panel, a toast, the console, or a request. Closing removes it from the page. The clipboard holds it only after the reader presses Copy phrase.
7. **Share is untouched.** No edits to `relic-viewer/src/share.ts`, `relic-format/src/share.ts`, or `openSharePanel` (main.ts:6746-7150). The Share email still carries the full link and no phrase.

### C3. CSS (`styles.css`)

1. In 715-746, replace `.action span { display: none; }` (720-722) with a visually-hidden rule: `position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;`. Keep the `.action span.action-count` exception visible. The row must look identical at 320, 390 and 544 wide.
2. A new section, `/* ---------- the copy-link panel ---------- */`, inserted immediately after the toast block (after line 3452, before the comment-region banner at 3454). The same chrome family as the share panel (square, hairline, the patina rule on top, the version list's shadow): `position: fixed; top: var(--copy-top, var(--bar-height)); right: var(--copy-right, 0); width: min(26rem, calc(100vw - 1rem)); max-height: calc(100dvh - var(--copy-top, var(--bar-height)) - 0.5rem); overflow-y: auto; overscroll-behavior: contain; z-index: 20;`. A full-width sheet below 34rem. The link in the mono face with `overflow-wrap: anywhere` and its key part marked. The phrase in a numbered grid whose words never break. The copy buttons stack full width below 34rem. The mock settles the rest.
3. `.toast` (3429-3440) gains `z-index: 30`, above the panel.

## 5. File ownership (C vs A and B)

C edits only the regions marked C. Everything else in `main.ts`, `styles.css` and `popover.ts` belongs to A or stays untouched. This is the same table as spec B §C5, and it refines A's §5.10 for B and C: B claims fewer `main.ts` regions than A's table allows (no `buildBar`, `renderImageView`, `sandboxFrame`, `renderMediaView` or OTIO-case edits), and C's extra regions sit outside every A region.

| File | B owns | C owns | A owns |
|---|---|---|---|
| `relic-viewer/src/main.ts` | `@relic/format` import list 17-22 and `./viewer.ts` import list 182-196 (add names only); `renderPdfView` catch 1166-1176; `renderComparison` 2809-2858; `renderReady` 7218-7225 and 7227-7242; a new block between 7278 and 7280; `renderDead` 7280-7412 except 7330-7351; `makeBrowserDeps` and `boot` 7778-7827 | one new `./copy-link.ts` import statement in the first import chunk (17-52; Biome sorts it after `./annotate-time.ts`); `buildBar` 747-756; a new block before the share-panel banner at 6721; the key-entry literals at 7333, 7341, 7351 | names in the `./popover.ts`, `./annotate-frame.ts`, `./comments.ts`, `./otio-bridge.ts` and `./diff.ts` statements; a `sandboxFrame` branch near 1003-1011; `buildCurrentStage` 1275-1285; 2485-2581; 3453-6681 |
| `relic-viewer/src/styles.css` | a new section after line 1566 | 715-746; a new section after the toast block (after 3452); `.toast` 3429-3440 (z-index only) | 241-444 (popover); 4128-4162 (composer) |
| `relic-viewer/src/popover.ts` | none | none (uses the existing `copyText` and `COPY_FAILED_NOTE` exports) | sole owner |
| `relic-viewer/src/copy-link.ts` (new) | none | sole owner | none |
| `relic-viewer/src/viewer.ts`, `pdf.ts` | sole owner | none | none |
| `relic-format/src/*` | sole owner (C reads `mnemonic.ts`, unchanged) | none | none |
| `docs/spec/viewer.md` | §6.1 item 4 (274); new paragraphs after 379 | §6.4 paragraphs at 373 and 377 | §6.1 item 13 (283); §6.6 |
| `docs/decisions.md` | appends one entry | appends one entry | appends one entry |
| `packages/relic-mcp/PATH.md` | two sections before `## OpenTimelineIO end-to-end path` (296) | one section before `## Change emails on the live service` (273) | appended at the end |
| `.github/workflows/verify.yml` | a new step after `OTIO path` (136-147); any timeout change | a new step after `Install headless Chrome` (105-113) | a new step after `Notify path` (94-95) |

Contracts A keeps for C: `copyText(text): Promise<boolean>` and `COPY_FAILED_NOTE` stay exported from `popover.ts` with today's behavior, and A's document-level Escape and `pointerdown` handlers (main.ts:6245-6247, 6290-6299) stay in the bubble phase. Expected conflicts only: the import block (keep both sides, let Biome sort) and the end of `docs/decisions.md` (keep every entry in merge order). Anything else means a boundary was crossed.

## 6. Slices

Each worker runs in its own isolated worktree and branch from `76269ed5`, commits each working increment, and hands back a clean branch. The integrator (main agent) merges slices into `feat/relik-copy-link-panel` in a dedicated integration worktree and opens the PR up front as a draft. Do not set `model` on any dispatch. Designer slices use `agent: "designer"`.

**Order.** C-M first. C-I starts after C-M is committed and Jason has answered §3.2. C-P is written in parallel with C-I (the C2 selectors are fixed) and runs after C-I is integrated. C-R follows the C-P run.

### C-M. Mock (`agent: designer`)

- **Files.** New `docs/plans/copy-link-key-phrase/mockup.html`, `docs/plans/copy-link-key-phrase/plan.md` (this spec, verbatim from the local file the main agent supplies), and `docs/plans/copy-link-key-phrase/mock-shots/`.
- **Conventions** (from `docs/plans/otio/mockup.html` and `docs/plans/share/mockup.html`): one self-contained file; CSP meta `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`; tokens and chrome copied from `packages/relic-viewer/src/styles.css`; a theme select (system, light, dark) setting `data-theme`; state navigation that also reads `#state=<name>`; localStorage only; system fonts. The mock's own copy buttons fake success and failure without the clipboard.
- **Fixture.** Relic `q7m2c9x4tz8hb3ka1w6pd5rn0e` (the share mock's accession), file `field-notes.md`, version 2 of 2, link `https://relik.link/q7m2c9x4tz8hb3ka1w6pd5rn0e#r1CzBVep_E6Q4zWH2ix-wRNg`, phrase `arctic live gadget display excess mandate sniff autumn people disorder affair horn`. The phrase was computed from that fake key with `keyToMnemonic`, and the pair opens nothing.
- **States, each reachable by clicks**, with every C1 string word for word:
  1. The bar with Copy link closed: labelled at 1440, icon-only at 390 and 320.
  2. The panel open with the focus ring on Copy link, the full link with its key part marked, the 12 numbered words, and the notes.
  3. The phrase loading, and the phrase failed to load.
  4. After Copy link: the toast above the panel.
  5. After Copy without the key: its toast.
  6. After Copy phrase: its toast.
  7. Clipboard refused: the link text selected and the `COPY_FAILED_NOTE` toast.
  8. Closed again, with focus back on Copy link.
  9. The recipient's side: the keyless link opened, "This link is missing its key" with key entry using `KEY_ENTRY_PROMPT`, `KEY_ENTRY_LABEL` and `KEY_ENTRY_PLACEHOLDER`, the 12 words typed in, then the relic open.
- **Acceptance.** Loaded in isolated headless Chrome at 1440x900, 390x844 and 320x568, in light and dark: zero requests beyond the document, no horizontal overflow, every state reachable by clicks, the primary Copy link visible without scrolling the panel at 320x568, and no word broken across lines. A screenshot of each state at each size is committed to `mock-shots/`.

### C-I. Implementation and docs (task, effort hi)

- **Files.** New `src/copy-link.ts`; the C regions of `src/main.ts` (the `./copy-link.ts` import, `buildBar` 747-756, the new block before 6721, and the literals at 7333, 7341 and 7351 replaced by `KEY_ENTRY_PROMPT`, `KEY_ENTRY_LABEL` and `KEY_ENTRY_PLACEHOLDER`); the C regions of `src/styles.css`; new `test/copy-link.test.ts` with its own stub DOM (every viewer test file defines its own; the stubs support neither focus nor bubbling, so focus is proven in C-P); the docs below.
- **Change.** C1, C2 and C3.
- **Not in scope.** `share.ts`, `openSharePanel`, `popover.ts`, `viewer.ts`, any other bar control, the Share email.
- **Fail on main, pass after** (copy-link.test.ts):
  1. `keylessLink('https://relik.link/abc#r1X')` is `'https://relik.link/abc'`, and no result ever contains `#`.
  2. `keyPhraseWords(shareUrl)` returns 12 words, and `mnemonicToKey(words)` equals `parseFragment(new URL(shareUrl).hash).key`.
  3. Clicking the bar's Copy link opens `#copy-link-panel` with `role="dialog"` and the title `Link and key phrase`, inserted after the bar, and writes nothing to the clipboard.
  4. The opener has `data-action="copy-link"` and `aria-haspopup="dialog"`, `aria-expanded` is `true` while open and `false` after, and `aria-controls` is present only while open. A bar rebuilt while the panel is open reads `aria-expanded="true"`.
  5. After `ready`, the link value's text equals the share URL and the list holds the 12 words in order.
  6. Copy link writes the share URL and toasts `LINK_COPIED_NOTE`. Copy without the key writes `keylessLink` and toasts `KEYLESS_COPIED_NOTE`. Copy phrase writes the words joined by single spaces and toasts `PHRASE_COPIED_NOTE`.
  7. A rejected clipboard write toasts `COPY_FAILED_NOTE` and no success note.
  8. No toast text contains the fragment or any phrase word.
  9. Escape dispatched inside the panel removes it and sets `aria-expanded="false"`. A second opener click closes; a third opens; there is never more than one `#copy-link-panel`.
  10. While the panel is open, no phrase word occurs outside the panel more often than it did before opening. After closing, `document.body` holds no more occurrences than before opening.
  11. Opening, copying and closing call no `localStorage.setItem`, no `sessionStorage.setItem` and no `fetch`.
  12. `renderDead` for `fragment_missing` shows `KEY_ENTRY_PROMPT`, `KEY_ENTRY_LABEL` and `KEY_ENTRY_PLACEHOLDER`.
- **Must keep passing.** shell-budget.test.ts (the wordlist stays out of `viewer.js`), share.test.ts, comments.test.ts:1066-1080 (the bar still reads `Copy link`), dashboard-and-key-entry.test.ts:775 (the 12 words still open a relic through key entry).
- **Docs, verbatim.**
  - `viewer.md` §6.4, replace the "copy-link affordance" paragraph (line 377):

    > **The copy-link affordance.** `format.md` §2.5 strips the fragment via `history.replaceState`, which is honored here, and both costs land on this document. The recipient can no longer re-share from the address bar, so **the viewer carries an explicit copy-link control, present from load, backed by the in-memory key** and reconstructing the full URL on demand. Pressing it opens a small panel under the taskbar instead of copying straight away. The panel shows the full link with Copy link, a Copy without the key that copies the link with its fragment removed, and the 12-word key phrase for the same key with its own Copy, so a reader can send the link without the key and say the phrase separately; the recipient types the phrase where the keyless link's page asks for the key. The phrase is computed in the browser when the panel opens, from the key already in memory, through a lazily loaded module that keeps the wordlist out of the shell. It exists only in the open panel: it is never written to storage, the address bar, a title, a toast, a log, or a request, and closing the panel removes it from the page. Escape and the close button return focus to Copy link. Below 34rem the control is icon-only and keeps its accessible name. The reloaded page is dead and says so per §6.1 rather than showing a decrypt error. Present stripping as shrinking the window rather than closing it: the URL with its fragment existed before the replace, so browser history sync, an extension with host permissions reading `window.location.href` at load, and the application the link was clicked from all still saw it.

  - `viewer.md` §6.4, replace the key-entry paragraph (line 373), **only if Jason confirms §3.2**:

    > **Key entry appears only after an open has failed.** This paragraph banned any key-entry field on the viewing origin, not configurable and not conditional, as a purpose-built phishing surface aimed at the system's only secret. A field shipped anyway on the missing-key and could-not-be-opened screens, and on 2026-10-24 Jason Waldrip chose a Copy link panel whose keyless link works only because the recipient types the key phrase there, so the ban is amended to the field as it ships. It never appears on a page that opened. It accepts the key phrase or the full link, nothing typed into it leaves the browser, and it is never offered unprompted. The phishing concern stands, and it is the reason for each of those limits.

  - `decisions.md`, append (the second paragraph only if Jason confirms §3.2):

    > ## 2026-10-24: Copy link shows the link and the key phrase
    >
    > **Copy link opens a panel instead of copying straight away.** Jason Waldrip asked for the 12-word key phrase to be visible beside the copied key, and chose a panel on Copy link that shows the link and the phrase, each with its own Copy button, so a reader can send the link without the key and say the phrase separately. The full-link copy stays, Copy without the key is added, and the Share email is unchanged. The phrase is computed in the browser when the panel opens, from the key already in memory, and exists only in the open panel: nothing stores it, logs it, or sends it.
    >
    > **The key-entry field is part of a path now, so the spec stops banning it.** `viewer.md` §6.4 banned any key-entry field on the viewing origin, and one shipped anyway on the missing-key and could-not-be-opened screens. Sending the link without the key works only because the recipient types the phrase there, and Jason confirmed amending the ban to the field as it ships.
    >
    > **One name for the phrase.** The field called it a recovery phrase while relic-mcp calls it the key phrase. It is the key phrase everywhere now.
    >
    > **Collapsed taskbar actions keep their names.** Below 34rem the action labels were hidden with `display: none`, which removed the accessible name of every action without an `aria-label` or `title`: Copy link, Download and Report. The labels are now visually hidden, so the row looks the same and each control still has a name.

### C-P. Proof, PATH entry, CI step (task, effort hi)

- **Files.** New `packages/relic-mcp/test/copy-link-path.ts`; one section in `packages/relic-mcp/PATH.md`, "Copy link and the key phrase", inserted before `## Change emails on the live service`, carrying the §1 sentence, the commands, and the success marker; the `verify.yml` step below.
- **Harness.** The owned-browser contract from otio-path.ts:1815-1870 (`discoverChrome`, `chromeArgs`, `createBrowserHeadlessLaunch`, `attestBrowserHeadless`, `connectPipe` over `--remote-debugging-pipe`, a fresh profile per browser, `cleanupOwnedBrowserStartup`), the browser from `RELIC_PROOF_CHROME_PATH` or discovery, never headed and never a user profile. A loopback `Bun.serve` running `createApp` with `MemoryStore`, `MemoryStorage` and the built viewer assets. One markdown relic published through a fresh `node packages/relic-mcp/dist/relic-mcp.js` stdio process with `RELIC_CHROME_PATH=none`, `cover: false` and `title: ''`, then republished once to version 2. Real input through `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and `Input.insertText`, never `element.click()`. A main-world shim installed with `Page.addScriptToEvaluateOnNewDocument` records `navigator.clipboard.writeText` calls into an array and can be told to reject, so the proof reads what the page asked to copy without touching the system clipboard. `Network.enable` records every request.
- **Runs and assertions** (1440x900 light unless stated):
  1. Baseline: record localStorage, sessionStorage, `document.title`, `location.href`, and whole-word counts of each of the relic's 12 phrase words in `document.body.innerText` and `outerHTML`.
  2. Click Copy link: the panel is visible; `document.activeElement` is `[data-copy=link]`; the opener has `aria-expanded="true"`; the panel's rect is inside the viewport; `documentElement.scrollWidth <= innerWidth`; the clipboard log is empty.
  3. Press Enter: the log holds the share URL, the toast reads `LINK_COPIED_NOTE`, and `elementFromPoint` at the toast's centre returns the toast, above the panel.
  4. Copy without the key: the log holds the keyless link with no `#`, and its toast shows.
  5. Copy phrase: the log holds 12 words that `mnemonicToKey` maps back to the fragment's key, and its toast shows. No toast contains `#r1`, the key, or two consecutive phrase words.
  6. Escape: the panel is gone; focus is on `[data-action=copy-link]`; `aria-expanded="false"`; the word counts outside a fixed-note toast, storage, title and URL equal the baseline; and no request since load carried `#`, the fragment, or two consecutive phrase words in its URL or post data (one word is not evidence: `version` and `share` are wordlist words the viewer's own requests carry) (the lazily loaded mnemonic chunk, a GET under `/assets/`, carries none).
  7. Reopen and Tab past the last control: the panel closes and focus is where Tab put it. Reopen and click the stage: it closes and focus stays put. Reopen and click the opener: it closes.
  8. Clipboard refusal (the shim rejects): the `COPY_FAILED_NOTE` toast, and `getSelection().toString()` equals the link after Copy link and the 12 words after Copy phrase.
  9. Version switch with the panel open (choose version 1): the body is replaced, `#copy-link-panel` is gone, and nothing throws. Step 10 starts only after version 1 has rendered; a switch still loading replaces the body under the next step's panel.
  10. At 390x844 dark and 320x568 light: steps 2, 3 and 6; `Accessibility.queryAXTree({ accessibleName: 'Copy link', role: 'button' })` finds the opener; the panel spans the viewport width; the primary Copy link is inside the viewport without scrolling the panel; every `li` is one line (`getClientRects().length === 1`); no horizontal overflow.
  11. The recipient path, in a second browser with its own fresh profile: open the keyless link; "This link is missing its key" shows with the field labelled `Key phrase or link`; type the 12 words with `Input.insertText` and press Enter; the relic's heading renders; no request carried the key or two consecutive phrase words.
- **Output.** `COPY_LINK_PATH_OK`. Shots (the panel open at 1440 light and dark, 390 dark, 320 light; the toast over the panel at 320; the recipient's key entry) go to `RELIC_COPY_PROOF_DIR`, which the integrator commits as `docs/plans/copy-link-key-phrase/proof/<short-sha>/`.
- **Must fail first.** Against a build of `76269ed5` in a throwaway worktree, the proof fails at step 2 (no panel; the click writes the clipboard at once) and at the 320 accessible-name check. Quote both in the PR body. This run is explicitly part of this slice.
- **CI step** (insert after `Install headless Chrome`, before `OTIO conformance`):

  ```yaml
      - name: Copy link path
        run: |
          set -euo pipefail
          RELIC_PROOF_CHROME_PATH="$(command -v google-chrome)" \
          env -u DISPLAY -u WAYLAND_DISPLAY \
            bun packages/relic-mcp/test/copy-link-path.ts
  ```

### C-R. Designer rendered review (`agent: designer`, after the C-P run)

- **Inputs.** C-P's shots, the committed mock and its shots.
- **Task.** Load every shot and compare it with the mock at the same size and theme: the panel's placement under Copy link at 1440, the full-width sheet at 390 and 320, the toast above the panel, the phrase grid, the marked key part, contrast in light and dark. Return pass, or a numbered defect list naming the shot, the element and the fix. Defects go back to C-I, then C-P reruns.

## 7. End to end, merge, and deploy

1. In the integration worktree: `mise exec -- bun run verify`, `mise exec -- bun run --cwd packages/relic-mcp build`, then `mise exec -- bun packages/relic-mcp/test/copy-link-path.ts` ending `COPY_LINK_PATH_OK`. Commit the shots. C-R passes.
2. The PR body states the problem, the change, the must-fail-first quotes, the proof marker and the shots path, and says plainly that the Share email is unchanged. Merge on green with `gh pr merge --merge` (never squash), then watch the deploy.
3. Read-only live check after the deploy, with no writes: `GET https://relik.link/assets/viewer.js` contains `Link and key phrase` and `Copy without the key`. No relic is published for C.
4. A, B and C merge independently. Whichever merges later runs `git pull origin main` in its integration worktree, keeps both sides of the import block, and keeps every `docs/decisions.md` entry.

## 8. What would prove this spec wrong

- **Jason keeps the key-entry ban (§3.2).** Then remove Copy without the key, `SPLIT_NOTE`, `KEYLESS_COPIED_NOTE`, the recipient path in C-P step 11, and the key-entry rename; the panel shows the full link and the phrase only, and removing the shipped field becomes separate work he decides on.
- **At 320x568 the primary Copy link needs the panel scrolled.** The panel is too tall; the designer re-lays it (for example the phrase in three columns) before C-I styles it.
- **A screen reader reads the phrase as one run-on string or reads the numbers twice.** The list markup is wrong.
- **The clipboard write fails in real browsers after focus moved into the panel.** The write must happen synchronously inside the click handler; if it still fails, the selection fallback must carry the copy.
- **The visually-hidden labels change the row's measured widths at 320.** They must not (absolutely positioned spans take no space); if they do, the rule is wrong, not the floor accounting.
