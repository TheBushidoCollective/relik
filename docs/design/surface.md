# Relic: the surface

This document decides the art direction, the type and icon system the viewing origin's CSP forces, the taskbar's hierarchy at a phone width, the renderer stack and its two caps, the in-memory ceiling, every recipient-facing state including the five nobody had written, the report form's personal-data category, and the sentence the publishing tool puts beside the URL.

`docs/frame.md`, `docs/preconditions.md`, `docs/spec/viewer.md`, `docs/spec/service.md`, `docs/spec/publish.md`, and `docs/spec/format.md` are locked inputs. `docs/design/container.md`, `docs/design/topology.md`, and `docs/design/storage.md` are sibling inputs, consumed here and never reopened. None had landed on the station branch when this was written; section 12 records which path each was read from.

The 2026-11-10 decision in `docs/decisions.md` supersedes the original
100 MiB publication cap, prefix-only large-text design, and whole-file
memory assumptions. The current policy is 500 MiB of plaintext and 200
mints shared across versions.

Every number in recipient-facing copy below is taken from a sibling and cited to it. None is invented here and none is left abstract.

## 0. What this decides

- **`viewer.md` 7.1** browser-managed content and bounded heap reads, section 5.
- **`viewer.md` 7.3** full windowed source for large text, section 4.4.
- **`viewer.md` 7.4** historical highlighting design, section 4.3.

The plaintext publication cap is 500 MiB; `docs/design/storage.md` section
1.1 records the cap and its ciphertext conversion. PSL registration belongs
to `design-topology-and-origins`.

## 1. The art direction: continuous form

**One direction, committed. The surface is a records office's continuous-form output handled under an archivist's protocol.** A handling protocol documents an item's transit through custody: received, held under stated conditions, and released a bounded number of times. The current cap is 200 mints; a publisher may set a lifetime, but a relic has no mandatory expiry.

**Two materials, and only two.**

**The form.** Banded continuous stock, ruled fields, and a punched margin. The primitive is the rule, not the card. Every grouping is bounded by a hairline above and below, running full width to the letterbox edge. There are no rounded containers, no shadows, and no elevation. Archival forms have none of those and neither does this.

**The stamp.** Custody marks applied on top of a finished form, never designed into it. A terminal state does not replace the record, it overprints it: the field stack stays legible underneath, and the stamp sits across it at a fixed three-degree rotation with the ruled block still readable through. This carries real information rather than decoration. The record is still there, and it has been marked. It is also the single element that makes the system non-portable: a visual language whose most emphatic move is invalidating a record in place is nonsense on a marketing page or a dashboard.

**The palette, derived and named to its source.**

| Token | Light | Dark | Source |
|---|---|---|---|
| `stock` | `#EFF2EC` | `#191C18` | continuous-form paper |
| `band` | `#E0E7DC` | `#1F2420` | the printed band, four text lines tall |
| `ink` | `#15180F` | `#DCE2D4` | pre-printed form ink, a soft black carrying green under the band |
| `rule` | `#9FA898` | `#4A544A` | the pre-printed rule, one value, 1px on fields and 2px on sections |
| `stamp` | `#2F3E7E` | `#7E8FD6` | dry stamp-pad indigo |

**`stamp` appears in exactly three places and nowhere else:** the terminal-state overprint, the cap warning's rule weight, and the focus ring. It is never a button fill, never a link colour, never an accent on a heading. A colour reserved for "this record is marked" cannot be spent on ordinary chrome without destroying the one signal the system carries.

**The bands run behind content and never behind chrome.** Four text lines of `stock`, four of `band`, repeating, on long text runs only. The taskbar, the margin, and the notice stack sit on flat `stock`, because on real continuous stock the printed furniture sits in the unbanded gutter.

**Which surfaces carry imagery, stated rather than assumed.**

- **The viewing origin's chrome carries no raster imagery at all.** The locked CSP blocks external resources and the locked precondition bars third-party anything, so every mark is inline SVG from the viewer's own bundle. This is a constraint honestly met, not a style choice.
- **The service origin serves per-relic covers alongside a fallback raster:** [Amended 2026-10-13: The one-raster budget on the service origin was reversed to support per-relic cover images rendered on the publisher's machine. The service now serves content-addressed per-relic covers at `/{id}/cover/{sha256}.{png|jpg}` for relics with uploaded covers, with `/assets/card.v1.png` retained as the fallback when a cover is declined, skipped, expired, or tombstoned. See `docs/decisions.md` (2026-10-13).] The unfurl card image at `og:image` is served from `/{id}/cover/{sha256}.{png|jpg}` when an uploaded cover is active, or from the immutable static path `docs/design/topology.md` 5.3 decides as fallback. It is fetched per unfurl rather than per open, and Slack states its own caching: "Responses to these requests are cached globally across the service for around 30 minutes" ([Slack](https://api.slack.com/robots)).
- **The marketing site, the published disclosure statement, and `/abuse` carry imagery freely.** They are not under the viewing origin's CSP, and they are where the art direction is shown rather than merely applied.

**The banned defaults, named, and why this is not each of them.** No warm cream ground, no serif display, no terracotta or amber accent, and no rounded cards with an accent rail: the ground is a cold banded stock, the type is a single machine face (section 2), and the accent is a stamp ink restricted to three uses. No near-black with one acid pop: dark mode is a green-shifted charcoal carrying the same banding, and the accent is a desaturated indigo used for state rather than for emphasis. No blueprint hairlines or cyan grid: the rules are form rules at one weight, in a paper grey, and there is no grid drawn anywhere. No purple-to-blue gradient hero: there are no gradients in the system. No Inter and no Space Grotesk. No emoji as icons. Nothing is centred, nothing is glassmorphic, and no corner is rounded.

**What it must never resemble, handled directly.** A phishing page is the live risk, because the premise supplies every tell: an unfamiliar domain, arriving via a third party, holding content it will not describe until you engage. Three rules answer it. **First, nothing shaped like a credential field appears anywhere, including decoratively.** `viewer.md` 6.4 forbids a key-entry field on the viewing origin, not configurably and not conditionally, and this design carries no input, no field outline, no placeholder text, and no lozenge that could be mistaken for one. The form register makes that easy to violate by accident, because forms are made of fields, so the rule is stated as a build check: **the viewing origin's rendered DOM contains zero `input`, `textarea`, and `select` elements in every state.** Second, the page never asks the recipient to do anything before it has told them what it is. Third, the trust work is carried by specificity rather than by reassurance, which is section 3.

Not a crypto product: no wordmark gradient, no hexagon, no lock glyph, no "trustless", no key iconography anywhere. Not a file locker: the download control is one of four equal margin controls and is never the page's hero.

**The check.** Move this layout, palette, and type to a different topic and it fails immediately. The banded stock encodes a printed record; the punched margin exists to hold the three controls a recipient needs when something is wrong; the stamp exists to invalidate a record in place; the field stack exists because every value on the screen is a custody fact about one item. On a product that is not a bounded-custody document, all four are decoration and the palette reads as arbitrary.

## 2. Type and icons, and what the CSP forecloses

**No icon kit and no web font can load on the viewing origin.** The locked strict CSP blocks external resources, and `docs/preconditions.md` section 4 bars third-party scripts outright, so a hosted kit is foreclosed twice over: once as a network request the policy refuses, once as third-party code the precondition refuses. A hosted font service is foreclosed the same way. This is the constraint that gets discovered after a design is approved, so it is decided first here.

**The icon substitute: inline SVG, from a closed set of seven marks.** Single path each, 20 by 20 on a 24 grid, `stroke: currentColor` at 1.5, no fill, drawn at the same weight as the form rules so a mark and a rule read as the same ink. The set is closed at seven and named: copy, download, report, disclosure, sandbox, warning, cutoff. Closing the set is the guard against somebody reaching for a kit later to get an eighth. Decorative marks carry `aria-hidden="true"`; every mark that carries meaning on its own carries an accessible label.

**The typeface substitute: self-hosted WOFF2 under `font-src 'self'`, not a data URI.** A data URI inflates by a third under base64 and lands inside render-blocking CSS. A self-hosted file is cached across relics and does not block. Both were open; this picks the one that costs less on the second relic a recipient opens.

**The face: IBM Plex Mono, weights 400 and 600, and nothing else on the viewing origin** ([IBM Plex](https://github.com/IBM/plex)). Every value on that surface is machine-produced, so it is set in a machine face, and a continuous form is set in one face by construction.

**Measured, so the budget is real.** Both weights of the Latin subset are 10,052 and 10,120 octets of WOFF2, **20,172 octets for the pair**, measured on the subsets Google Fonts serves. The three-face pairing that adds IBM Plex Sans at two weights measures 100,652 octets for four faces and 90,532 for three, so the single-family decision saves 70,360 octets against the nearest alternative on the one origin where bytes are scarce. A purpose-built subset carrying only the glyphs the viewer emits is smaller than the figure above; that number is not stated here because it has not been measured, and section 11 routes the measurement.

**The pairing lives where the constraint does not.** Marketing, the disclosure statement, and `/abuse` set running prose in IBM Plex Sans against Plex Mono for record values. The split is honest: the receiving page is machine output and is set in a machine face, and the pages that speak in the operator's voice are set in a human one.

**The prose cost, priced rather than waved past, and reconciled against a real floor.** The viewing origin carries very little running prose: one line of explanation and error copy of two or three sentences. Mono at 15px, 1.6 leading, and a 62-character measure is comfortable at that volume on a desk-width screen, and the measure is enforced rather than incidental there.

**The design's minimum supported viewport width is 320 CSS pixels, stated once here and held everywhere else in this document.** At the 0.6em character advance every monospace face uses, including IBM Plex Mono, 62 characters at 15px is a 558px column before padding, wider than every phone this design has to run on, including the 375px iPhone SE and the 393px iPhone 15 that section 6's taskbar is built for. A measure that cannot exist on the device it is meant to fit is not enforced, it is fictional, so the viewing origin's prose measure is a fluid rule rather than one fixed number below desk width: `clamp(32ch, 90vw, 62ch)`, or its equivalent, floors at 32 characters against the 320px minimum with 16px of padding on each side, 288px of usable width at 9px per character, and grows to the full 62 characters once the viewport clears desk width. Nothing narrows silently and nothing overflows. One rule covers every width in between, including the 375px and 393px phones above.

**The initial bundle budget on the viewing origin: 60 KB gzipped** for the shell, the crypto driver, the taskbar, the plain-text renderer, the highlighter core, and the tree-to-DOM utility, with the 20,172 octets of font served separately and the grammar set at zero (section 4.2).

## 3. Trust in the first five seconds

**Do not spend the pre-decryption window explaining zero-knowledge.** The evidence is a redesign that failed at comprehension and moved behaviour anyway: "We ultimately failed at our goal of a well-understood warning" and "We attribute this success to opinionated design, which promotes safety with visual cues", with "Opinionated design is the use of visual design cues to promote a recommended course of action" and, in the field, "Our proposal dramatically improved adherence rates: from 31% to 58% in a controlled field experiment, and from 37% to 62% in the field following the release of the new warning" ([Felt et al.](https://research.google/pubs/improving-ssl-warnings-comprehension-and-adherence/), [PDF](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/43265.pdf)).

Read the consequence precisely. The gain came from design that communicates a recommended action without being read. So `viewer.md` 6.3's budget of one line of plain-language explanation is correct and holds under review pressure, and the trust work belongs to visual specificity. That is the second reason a generic look is disqualifying rather than merely dull: a templated page communicates nothing about what this particular page is, which is the exact job the research says design was doing.

**The honesty register is settled prior art and Relic matches it.** Mozilla's shipped one-liner for the closest predecessor claimed nothing about the recipient's safety: `downloadDescription = This file was shared via { -send-brand } with end-to-end encryption and a link that automatically expires.` ([Firefox Send v3](https://gitlab.com/timvisee/send/-/raw/send-v3/public/locales/en-US/send.ftl)). Their unshipped work went further and named what could not be verified: `downloadConfirmDescription` reads "Make sure you trust the person who sent you this file because we can" and then a typographic apostrophe and "t verify that it will not harm your device." ([Firefox Send v4](https://gitlab.com/timvisee/send/-/raw/send-v4/public/locales/en-US/send.ftl)). Mozilla built that abuse-and-trust layer last and killed the product before shipping it, which is the precedent `docs/preconditions.md` section 1 turns into a go/no-go.

**Relic's line, on every relic page before decryption starts:**

> The file in this link is decrypted in your browser. The key is in the link and your browser never sends it to Relic's servers.

That is `service.md` section 5 item 4's correct form of the fragment claim, in the recipient's tense. It does not say nobody can read the file, because the decrypting code is served by the party the claim is made against and `frame.md` locks that concession.

**Where the trust work actually happens.** `viewer.md` 6.3 fixes what renders before the recipient does anything, and it is five things about Relic rather than about the item: the branded taskbar, the service name, one line of plain-language explanation, the abuse-report link, and the privacy-statement link. None of the five requires the mint, which has not fired yet (`docs/design/topology.md` 5.1), so none of them is a promise the page cannot yet keep. A page that has already told you five true things about itself, and volunteered nothing about a file it has not been handed, is not the shape of a phishing page, and that is a design output rather than a copy output.

## 4. The renderer stack, the grammars, and the two caps

### 4.1 The stack

**Decision: `lowlight` for highlighting and `hast-util-to-dom` to realize it.** `viewer.md` 3.3 requires highlighted output built as DOM text nodes with elements created programmatically, and states that there is no sanitize-then-parse fallback on the viewing origin. Two libraries satisfy that natively. lowlight "outputs objects (ASTs) instead of a string of HTML" and "It can support 190+ programming languages" ([lowlight](https://github.com/wooorm/lowlight)); `hast-util-to-dom` exists to "Turn a hast tree into a DOM tree" ([hast-util-to-dom](https://github.com/syntax-tree/hast-util-to-dom)). Bytes go highlight.js, then hast, then real DOM nodes, and no markup parser ever receives attacker input.

**The foreclosure, named with the reason.** `highlight.js` used directly is foreclosed: its `highlight` returns an object whose `value` is documented as an "HTML string with highlighting markup" ([highlight.js API](https://highlightjs.readthedocs.io/en/latest/api.html)). `prismjs` used directly is foreclosed on the same ground: `Prism.highlight` "returns a string with the HTML produced" and its documented return is "The highlighted HTML." ([Prism API](https://prismjs.com/docs/Prism.html)). Both are the popular default, and the only way to put either string on screen is to hand it to a markup parser on the origin that holds the fragment. `viewer.md` 3.3 forbids that with no escape hatch, and 3.1 invokes the locked precondition that sanitization is never the only layer, so a sanitize-then-parse workaround reopens the precondition one section later on the same origin. `refractor` is the tree-emitting Prism equivalent and stays available if a Prism-only grammar is ever needed; it is not the default, because the measured entry points put it at 30,159 gzipped against lowlight's 3,811 and neither figure includes the engine.

**Markdown is not in this bundle at all.** `viewer.md` 3.1 puts rendered Markdown on the sandbox origin, so the Markdown parser and whatever sanitizer runs beside it live in the shim's bundle and never on the viewing origin. The Markdown **source** view is plain text under `viewer.md` 1.4 rule 2 and is highlighted by the same lowlight path with the `markdown` grammar. Stating the split is the point: a bundle budget that counts a Markdown parser against the viewing origin is counting the wrong origin's bytes.

### 4.2 Grammars are the lever, and they are separate from the cap

**The initial bundle carries the highlighter core and zero grammars.** One grammar loads on demand per relic, selected from a fixed allowlist keyed on the final-dot extension parse `viewer.md` 1.9 rule 6 permits, and an unrecognized hint falls back to plain text and fetches nothing, per `viewer.md` 1.4 rule 4. The grammar is first-party code from the viewing origin's own path, so `script-src 'self'` is satisfied and no third-party host is involved, and `viewer.md` 1.8's `Referrer-Policy: no-referrer` already closes the ID leak on that request.

That is the real lever, and it is a bytes decision. lowlight's `common` set is documented as a "Map of common (37) grammars", and shipping it would put the whole set in the initial bundle to serve one relic that uses one of them. Per-grammar measured costs are small and uneven: 1,569 gzipped for python and 3,195 for typescript. **Loading one costs at most a few kilobytes; shipping the set costs the set.**

**The cap below is a CPU decision and it is not this.** Conflating them produces a bundle argument that resolves a hang, or a cap argument that resolves a download. They are decided separately and both are decided.

### 4.3 The highlighted-region cap (`viewer.md` 7.4)

The original design proposed a 256 KiB highlight region and an 8,192-byte
long-line guard. Those cutoffs were not implemented in the baseline and are
not the basis for the large-file design. Large text uses bounded, plain-text
source windows as described in section 4.4.

### 4.4 Large text (`viewer.md` 7.3)

The original design proposed showing only the first 2 MiB. Jason Waldrip
superseded that choice on 2026-11-10: code and plain text larger than 100 MiB
use a windowed source view that can reach the whole file. Markdown, HTML, and
JSX larger than 100 MiB use the same source view rather than rendering or
executing the full document. Download retains the original bytes.

The source view reads bounded slices and uses a line index and scrolling
controls instead of decoding the entire file into one string and DOM tree.
Comment targets can be resolved beyond the visible window.

## 5. Browser-managed content (`viewer.md` 7.1)

The former 500,000,000-octet whole-file memory ceiling and its tier-collapse
calculation are superseded. The viewer decrypts records into a
browser-managed Blob and limits individual heap reads. A ServiceWorker that
streams decrypted content is not part of this change.

The browser may back a Blob with memory or temporary disk, and OS swap can
write memory to disk. Downloading also writes plaintext to disk. The design
does not guarantee a browser-specific memory ceiling or erasure on close.
Failure to hold or read the Blob requires a named error rather than an
assurance that every device can open every file.

## 6. The taskbar hierarchy at a phone width

Thirteen mandated elements, none optional, on a surface that is mobile-first and letterboxed by construction because the bar and the content sit on different origins (`viewer.md` 4). The work is hierarchy and progressive disclosure. Four zones.

**Zone A, the header rail. Fixed, top, 44px, present in every state.**

Two items. The **service name** is a fixed-width wordmark. The **custody line**
displays the bounded filename as a DOM text node or a state name. It is the
flexible element on the chrome, with a middle ellipsis and a two-line clamp.
The current envelope caps the UTF-8 filename at 1,024 octets; the display
clamp is a separate bound.

The filename comes from the authenticated envelope in record 0. For a file
larger than 100 MiB, the reader can see the filename and size before choosing
whether to begin the full-file fetch.

**Zone B, the notice stack. Inline, directly under the header, zero height when empty.**

The notice-stack design groups these conditional notices:

1. **The contents do not match the name.** `viewer.md` 1.3 clause 3 mandates it even on the branch that renders. Highest, because it is the only notice about the payload lying.
2. **Large source view.** Section 4.4 explains when the full document is shown as windowed source.
3. **Blocked external resources.** `viewer.md` 3.2 requires the viewer explain the blocking rather than leave broken-image icons to read as a corrupt file.
4. **Highlight cutoff.** The cutoff was proposed in section 4.3.
5. **Opens remaining.** Section 7.7's warning.

**At most two render expanded. The remainder collapse into one row reading `N more notices`, where N is however many are collapsed, at most three since five notices minus two always-expanded leaves no more, and the row never renders at zero.** It expands in place and never navigates. The priority order is fixed rather than computed, so two relics with the same notices always present them the same way.

**Zone C, the plate. The letterboxed content mount.**

The content iframe never fills the viewport, so the letterbox is presented as a mount rather than as a failure. The plate carries registration marks at its four corners in `rule`, which is what a mounted item on a form looks like, and two pieces of chrome bound to it rather than to the bar:

- **The sandbox legend**, permanently on the plate's bottom edge: one line stating the content is sandboxed and what that blocks. `viewer.md` 4 requires the sandbox be presented as deliberate. Anchoring it to the plate rather than to the header is what guarantees a long filename can never displace it.
- **The Markdown source toggle**, on the plate's top edge, a two-state segmented control, present only for Markdown. `viewer.md` 3.1 makes the toggle switch which origin is showing, so it belongs to the plate that both origins render into, and the taskbar owns it because the taskbar is the only surface spanning both.

The plate distinguishes opening, transfer, decryption, and rendering.
Record 0 authenticates the filename and content size. A file above 100 MiB
then waits for confirmation before a full-file fetch; fetch and decryption can
proceed incrementally.

**Zone D, the margin. Fixed, bottom, 48px, present in every state including every error state.**

Four fixed-width controls, evenly divided, each a 48px touch target: **copy link, download, report, disclosure.** This is the punched margin of the form, physically separate from the content field, and it is where `viewer.md` 1.9 rule 3's three protected controls actually live. Copy link is present from load and backed by the in-memory key per `viewer.md` 6.4. On every error screen the copy and download slots go inert and visibly so, and report and disclosure stay live, which satisfies `viewer.md` 6.4's rule that every error screen is a relic page carrying both links.

**At a desk width nothing about the hierarchy changes.** The margin rotates to a vertical rail on the left edge, the notice stack moves to a right column beside the plate, and the priority order, the fixed widths, and the flex rule are identical.

The notice stack covers mismatches, source-view state, blocked resources, and
remaining opens where those notices apply.

## 7. Every recipient-facing state

Copy below is Relic's, in Mozilla's register: it names what is true and what cannot be verified, and it never blames the recipient or the sender.

### 7.1 Confirmation for larger files

For plaintext larger than 100 MiB, the viewer reads and authenticates record 0,
then presents the filename, type, and size and asks the reader to confirm
before a full-file fetch. The mint and initial request precede that choice;
network buffering can transfer more than record 0. Files at or below 100 MiB
do not require this confirmation.

### 7.2 The size shown to the reader

The mint's `object_length` is a ciphertext transfer size. The content size in
the authenticated envelope is the plaintext size; a size derived before
record 0 authenticates is not an authenticated content-size claim.

At the publication cap, 524,288,000 plaintext octets are approximately
524.3 MB, and 524,489,608 ciphertext octets are approximately 524.5 MB.
These are decimal display values for an example at the cap, not evidence of a
particular screen's rendered copy.

### 7.3 No JavaScript

`viewer.md` 6.1 enumerates five states and none of them is this one, yet the static shell at `/{id}` is served to every reader behind NoScript, a hardened browser mode, an enterprise policy, or a text browser. `service.md` 4.1 already requires the abuse form work without JavaScript, so the project values this path; the viewer had no equivalent. Mozilla shipped three strings for it: `javascriptRequired = Firefox Send requires JavaScript`, `whyJavascript = Why does Firefox Send require JavaScript?`, and `enableJavascript = Please enable JavaScript and try again.`

**Decision: the shell carries a `noscript` block rendering the same document in the same inlined CSS, with the header rail and the margin's report and disclosure controls live.** It mints nothing, which is free: `service.md` section 2 makes the mint a distinct request the shell's script makes, and no script runs. It contains no field of any kind, per section 1's build check.

> **This page needs JavaScript to open a relic.**
>
> Relic decrypts the file in your browser, so with JavaScript off there is nothing here to decrypt it with. Nothing has been sent to Relic's servers and the key in this link has not been used, so the link still works in a browser that runs JavaScript.
>
> Report this relic · How Relic handles your data

The second sentence is worth keeping because it is verifiably true on this exact path and it is the one place the architecture can be demonstrated rather than asserted: no mint fired, so nothing was spent.

### 7.4 The failed secure-context check

`viewer.md` 5 requires the viewer check `window.isSecureContext` and the presence of `crypto.subtle` before anything else and show a specific named error, and notes that a recipient behind a TLS-terminating proxy serving plain HTTP hits it in production. No copy existed, and a generic failure there is unresolvable by the person seeing it.

**Named error: `insecure_context`.** The mechanism is documented: resources that are not local "must be served over https:// URLs" to be secure, and "The primary goal of secure contexts is to prevent MITM attackers from accessing powerful APIs that could further compromise the victim of an attack" ([MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)). A traffic-inspecting proxy is exactly the thing that restriction exists for, which is why the copy can be specific without accusing anyone.

> **This page did not arrive over a secure connection.**
>
> Browsers only allow the decryption Relic uses on a secure connection, and this one is not on it. Relic serves every relic over HTTPS, so something between this browser and Relic changed that. On a company, campus, or hotel network it is usually a device that inspects traffic.
>
> Opening the same link on a different network is the thing most likely to work. Reloading on this one will not.
>
> Report this relic · How Relic handles your data

**Two rules on this screen.** The primary action is not a retry, because a retry on the same network fails identically and a retry button teaches the recipient to keep pressing it. And the screen never mentions the key and never offers anywhere to put one: this is the screen a recipient is most primed to accept an unusual request on, so section 1's zero-input rule matters most here.

### 7.5 A post-mint object fetch failure

`service.md` 3.2 mandates that a fetch failing not-found after a successful mint render as "this relic is no longer available" and never as a decrypt failure, because a takedown otherwise reads to the recipient as a bad key and they blame the sender. `viewer.md` 6.1 has no branch for it, so the nearest screen is the one `service.md` forbids.

**Named error: `object_gone`.** The rule that makes it structural rather than a copy choice: **the fetch's outcome is classified before any decrypt is attempted, so no code path exists from a fetch failure into `OperationError` handling.** A 404 or a 403 on the signed URL after a 200 mint reaches this screen and cannot reach 6.1 state 4.

**What the viewer knows and does not know.** From the viewer's position, deleted for abuse, deleted under legal process, deleted on a blocklist match, and reaped by lifecycle are one condition: the object stopped being fetchable between the mint and the fetch. `docs/design/storage.md` 7.1 makes deletion immediate to a recipient, since soft-deleted objects cannot be read or modified, and 7.4 puts the object's full byte lifetime at up to roughly twelve days from publish once the 72-hour TTL, the lifecycle lag, and the seven-day soft-delete retention are counted. None of that is visible from the browser, so the copy names the causes without picking one.

> **This relic is no longer available.**
>
> The link worked a moment ago and the file is gone now. Relics go away when they are reported, when Relic is required to remove them, or when their 72 hours run out. Nothing is wrong with your link and nothing is wrong with the person who sent it.
>
> Ask them to publish it again. A new relic gets a new link.
>
> Report this relic · How Relic handles your data

The 72 hours is `docs/design/storage.md` 7.2's TTL of 259,200 seconds. "A new relic gets a new link" is `frame.md`'s locked non-goal on republish-to-same-URL, said in the recipient's terms rather than as a policy.

### 7.6 Cap exhaustion and takedown, which is one status and two screens

**Decision: the viewer distinguishes them.**

`service.md` 1.1 returns `410` for both, with codes `download_cap_exhausted` and `relic_removed`, and 1.2 accepts as a stated cost that no view grouping by status can tell them apart. But the codes do reach the viewer: 1.5 makes `code` an extension member on the problem document, and echoes `download_cap` on one and `report_url` on the other. `viewer.md` 6.1 state 3 is explicit about what the viewer owes that reason:

> with the stated reason surfaced verbatim rather than flattened into "something went wrong."

Merging the two screens is that flattening, on the one refusal where the recipient's next action differs.

**Three reasons, and the third is the one that decides it.**

First, the remedies differ. Cap exhaustion is fixed by the sender publishing again, and the file still exists. A takedown is not fixed by publishing the same file again, and the path that exists is an appeal.

Second, the fields differ. `report_url` arrives on `relic_removed` and not on `download_cap_exhausted`, so a merged screen either shows an appeal link that is wrong half the time or drops the field `service.md` 1.4 calls the thing that makes the appeal path real. **That distinction is wired to a control, not just argued for one.** On the removed screen, the margin's report control resolves to `report_url`. On the cap-exhausted screen, where the field never arrives, it resolves to the generic `/abuse` intake instead. What a report submitted through either path obliges, and how it resolves, is `design-operations-and-abuse`'s pipeline; this document decides only which URL the control points at.

Third, and this is the support-load argument running opposite to the intuition. **Merging costs more support than distinguishing.** A merged screen makes every cap exhaustion look like a removal, so publishers who were never removed arrive at `/abuse` to appeal something that did not happen, into the single intake channel `docs/preconditions.md` section 1 makes a go/no-go with a named human and a published response time behind it. It also buries genuine removals in that noise, which erodes the appeal path `service.md` 1.4 says concealing removal would delete. **Distinguishing routes cap questions away from `/abuse` and keeps `/abuse` for removals.**

**What distinguishing costs, stated in the same breath.** The cap-exhausted screen tells a recipient the file exists and they cannot have it, which reads as arbitrary, and a share of those become "why is there a cap" contacts. And it tells an abuser their campaign hit a cap rather than being caught, which `service.md` 1.4 already prices at nothing, because they learn it by clicking their own link within seconds. **The larger cost is the scanner case:** the cap can be exhausted before a human ever opens the link. `docs/design/topology.md` 5.1's gesture gate removes the observed previewer population, which do not click, and that section is explicit that it removes nothing from an adversary who drives a browser and injects trusted input. So a legitimate first recipient can land on this screen, and the copy has to make that possibility visible rather than implying they were late.

> **This link has been opened as many times as it can be.**
>
> Every relic allows 200 mints, shared across its versions. This one has used all of them.
>
> Ask the sender to publish a new relic for a fresh link and count.
>
> Automated requests may also consume the count.
>
> Report this relic · How Relic handles your data

> **This relic was removed.**
>
> Relic removed this file. We do not say why on this page, and that is the same for every removal, so the silence is not a signal about this one.
>
> If you published it and think this is wrong, the report link below reaches a person.
>
> Report this relic · How Relic handles your data

The 200-mint cap is recorded in `docs/design/storage.md` 4.4. The second
screen distinguishes removal from cap exhaustion.

**One more screen that looks like these and is not.** `docs/design/storage.md` 7.3 sets the retention window at 90 days, and states the consequence: after 90 days the relic row and the tombstone age out, so a relic that was removed or that expired returns `relic_not_found`. That means the never-existed screen is served for relics that did exist, and its copy cannot lead with a typo.

> **Relic has no record of this link.**
>
> Either this link is not a Relic link, or it is one from more than 90 days ago. Relic keeps its records for 90 days and then they are gone, so a very old link and a link that was never real look the same from here.
>
> Report this relic · How Relic handles your data

### 7.7 The `mints_remaining` consumer

The original design proposed warning at eight remaining mints against a
64-mint cap. That denominator is historical; the current cap is 200 mints
shared across versions.

**Who the warning is for.** The recipient cannot raise the cap, so the warning's job is to make them act now and tell the sender, which is what the copy does.

> 6 opens left on this link. Save the file if you need it.

At exactly one:

> This is the last time this link can be opened.

**Where it renders:** notice stack, priority 5. It arrives on the mint response, so it appears after the gesture and never on the pre-decryption plate.

**One consequence worth naming, because it is where the cap and the validity window meet.** `docs/design/storage.md` 4.2 sets the signed-URL validity window at 900 seconds with a 300-second minimum viable validity. A recipient who reads a relic and taps download twenty minutes later holds a dead URL. **The viewer re-mints silently when the stored URL's remaining validity has fallen below 300 seconds, and it does not ask**, because the alternative is a failed download the recipient cannot diagnose. That re-mint consumes a unit of the cap (`service.md` 2.2), so the cost surfaces where it is legible: as this warning, when the re-mint drops `mints_remaining` to 8 or below. Near the TTL boundary the clamp in `service.md` section 3 refuses the mint instead and the expired screen is correct, which `docs/design/storage.md` 4.2 prices at the final 0.12 percent of a relic's life.

### 7.8 The unfurl card

`viewer.md` 6.2 originally fixed the metadata as identical for every relic, reasoning that a per-relic value would be a fabrication or a leak, and named the failure mode: a blank card on an unfamiliar domain is the visual shape of a phishing link. That rule was reversed in `docs/decisions.md`: `og:type` and `og:site_name` remain constant, while `og:title` carries a publisher-declared plaintext title (or a per-class fallback when untitled), `og:description` reveals the coarse renderer class, and on 2026-10-13 `og:image` became per-relic when a cover is uploaded (with `card.v1.png` retained as fallback). The four properties Open Graph requires are fixed by the protocol, which states that "The four required properties for every page are" `og:title`, `og:type`, `og:image`, and `og:url` ([Open Graph](https://ogp.me/)).

The card is a recipient-facing surface and its copy is this document's. It has one job: make an unfamiliar domain legible before anyone clicks, without describing content it cannot see. The card renders the per-relic title (or per-class fallback when untitled) and a description revealing what kind of thing the relic is:

When titled, the card title is `{title}`. When untitled, the fallback title is `{Class} relic` (for example, `A Markdown relic` or `An archive relic`).

The description pairs a class phrase with a tail selected by what the viewer actually does with the relic (`CLASS_BEHAVIOUR` from `@relic/format`), rather than by the success metric's wedge predicate (`isRenderable`). `isRenderable` excludes `media` because the telemetry counts only the document and code wedge, which previously led to the false recipient-facing claim that media relics download to the device. The viewer gives media relics an in-browser player, so the description splits on three recipient experiences: rendering on the page, playing in the browser, or downloading to the device.

Renderable classes (`markdown`, `code`, `html`, `jsx`, `image`):

> **{title or fallback title}**
> A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.
> (or "A source code file...", "An HTML page...", "A JSX component...", "An image..." followed by the renderable tail)

Playable class (`media`):

> **{title or fallback title}**
> An audio or video file. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it.

Download-only classes (`archive`, `binary`):

> **{title or fallback title}**
> An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.
> (or "A binary file..." followed by the download-only tail)
When untitled and the class is unknown, tombstoned, expired, or malformed, the card falls back to the constant unknown text:

> **A relic**
> An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.

The fallback image is the card raster from section 1: [Amended 2026-10-13: Per-relic cover images are now rendered by the publisher's client and served as `og:image` for relics with covers. The card at `/assets/card.v1.png` remains the fallback raster when a cover is declined, skipped, expired, or tombstoned; see `docs/decisions.md` (2026-10-13).] The shipped fallback card keeps the empty field stack and the blank custody line, which is honest, because a blank record is precisely what the architecture guarantees when no cover was uploaded and the design can say so rather than hide it. Serving this fallback raster preserves the fallback presentation when a cover is absent, with an immutable cache policy (`public, max-age=31536000, immutable`), while per-relic covers use a 1-day cache (`public, max-age=86400`). Note on implementation: the fallback card is drawn in the shipped viewer's accession-label palette rather than the banded stock specified above, following `packages/relic-viewer/src/styles.css`, with image alt text "Relic's accession label with an empty field stack: a relic's record with nothing filled in." `docs/design/topology.md` 5.3 decides the markup order and the cacheable path; neither is redefined here.

## 8. The report form's personal-data category

**Decision: the form shows a personal-data category, labelled in plain words, placed first.**

`service.md` 4.1 fixes the categories as `malware`, `phishing`, `csam`, `copyright`, `legal_process`, and `other`. A data subject reporting their own leaked file lands in `other` today, and that is the report most likely to arrive from a non-technical person under stress. Mozilla's unshipped work carried the same category and named it in the register of its era: `reportReasonPii = These files contain personally identifiable information about me.`

**The label. "personally identifiable information" is jargon**, and this is the one reporter who is the harmed party rather than a third party doing triage.

> This is my personal information and I did not agree to it being shared.

**The machine value is `personal_data`**, which does not collide with the six fixed above.

**The placement: first in the list, above `malware`.** Every other category is chosen by a third party who is looking for the right bucket and will read the list. The data subject is the only reporter who is under stress about their own material and the most likely to abandon the form. Putting their option first costs every other reporter one line of reading and costs them nothing. Urgency ordering is not the argument for putting `csam` first: `service.md` 4.1 already makes `csam` blocklist unconditionally regardless of how the report arrived, so its handling does not depend on where it sits on a form.

**One field-level piece of copy that belongs to this category more than any other.** `service.md` 4.1 has the form strip the fragment client-side and server-side, and notes the server-side strip is the one that counts because it is the only one a no-JavaScript submission reaches. **A distressed data subject pasting their own leaked URL is the single most likely person to paste a full URL including the fragment.** So the relic-ID field says what happens, at the field:

> Paste the link or just the ID. Anything after the `#` is removed before this form is submitted, because that part is the key and Relic does not want it.

**The split with `design-operations-and-abuse`, stated as a need with the owner named.** This document owns the label, the machine value, the placement, and the field copy above, because they are recipient-facing. What a report in this category obliges, which reason class it maps to under `service.md` 4.1's fixed mapping, and how it resolves are the pipeline behind the form and belong to `design-operations-and-abuse`. One specific question sits on that boundary and is not answered here: `service.md` 4.1 makes reporter contact optional except on `copyright` and `legal_process`, and whether this category should join them turns on whether a report in it obliges a reply, which is a pipeline property. The need is stated; the answer is not this document's.

## 9. The publishing moment

**Decision: the unclaimed content slot is used. A successful `relic_publish` returns two content blocks, the human-readable sentence first and the serialized JSON second.**

`publish.md` 1.4 already fixes that success returns `structuredContent` plus a text content block carrying the serialized JSON, and MCP tool results carry unstructured content in an array that "can contain multiple content items of different types" ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). Today the transcript disclosure lives in the tool description, read possibly weeks earlier, and in a `disclosure_url` nobody clicks. Neither is a sentence at the moment the URL appears.

**Order is a decision, not a formatting detail.** The sentence goes first, because a model composing its reply reads the array in order and a warning buried under a JSON blob is the one that gets dropped.

**The sentence:**

> This link contains the decryption key. The key is now in this transcript, and anyone who has the link can read the file.

**Two sentences, and each is self-sufficient on purpose.** The model paraphrases and may relay one and drop the other, so neither depends on the other's antecedent. Short and hard to drop beats complete: this names the transcript property `publish.md` section 5 makes structurally unfixable, and it carries none of the reassurance that section forbids. "Nobody but the recipient can read your file" is false whenever an agent produced the link, and nothing here approaches it.

**This is not the published disclosure statement.** `service.md` section 5 owns that document's contents, including where cross-relic correlation is disclosed, and `design-operations-and-abuse` owns writing it. This is one sentence at one moment on a different surface.

**The display members: `title` is set, `icons` is not.**

`title` is "Optional human-readable name of the tool for display purposes" and costs nothing, so the tool sets `Publish a relic`, which is what a human scanning an aggregated tool list actually reads. `icons` is "Optional array of icons for display in user interfaces" and is refused on two grounds. **An HTTPS icon URI is a plausible callback to the operator, by the same convention a favicon is a callback to a site:** a client that renders the tool list has ordinary reason to fetch the icon in order to draw it, the way a browser fetches a tab's favicon on render. No spec text confirms or forecloses that any given client actually does so, at what point, or how often, and this document has verified only that the inference matches ordinary UI practice, not that it describes MCP clients' behaviour. A data URI removes the question rather than answering it, and puts branding bytes in every tool listing instead. Refusing `icons` holds regardless: the spec makes clients treat the thing as untrusted no matter when or whether it is fetched, requiring that they "Treat icon metadata and icon bytes as untrusted inputs and defend against network, privacy, and parsing risks" ([MCP base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)), which is reason enough on its own. Both members are presentation hints a client may ignore, so no control rests on either.

## 10. Drift routed, not fixed

One item. It is not an edit to a locked document and it does not change a rule any locked document fixes.

**The stated basis under `viewer.md` 5's byte-count rule is discharged, and the rule now rests on a reason `viewer.md` 5 does not state. Routed to `specify`, owner of `docs/spec/viewer.md`.**

The sentence whose basis is gone:

> Carry `format.md` §3.3's qualifier, because it changes what the viewer may display.

`docs/design/container.md` section 4 refused bucket padding and emits minimal padding only, so the derivation is exact at version 1 and that qualifier no longer exists. **The rule itself holds and this document honors it in section 7.2:** the viewer shows no plaintext byte count before decryption starts. What has changed is the reason. The surviving reason is that the pre-decryption number is unauthenticated, sitting outside every AEAD tag and operator-mutable per `docs/design/container.md` 3.2, while the envelope's content length inside the AEAD is authoritative. That is a stronger reason than the discharged one and `viewer.md` 5 does not state it.

**The request is that the owner restate the reason, not that the owner change the rule.** This document does not act on the discharge and nothing downstream should read section 7.2 as permission to. The rule holds until its owner revisits it.

## 11. Needs, stated with the owner named

1. **The reason class and handling path for the `personal_data` category, and whether reporter contact becomes required on it, from `design-operations-and-abuse`.** Section 8 fixes the label, the machine value, the placement, and the field copy. The pipeline behind them is that unit's, and this document's screens work under either answer.
2. **The published response time in hours, from `design-operations-and-abuse`.** The report confirmation screen is recipient-facing and this document's, and the number that goes on it is not. `service.md` 4.1 routes the number and `docs/preconditions.md` section 1 makes it a go/no-go obligation.
3. **A measured byte count for the purpose-built font subset, from `build`.** Section 2 states 20,172 octets measured on a general Latin subset, which is an upper bound. The 60 KB script and CSS budget is a target and is not measured, because the highlighter core's cost separated from its grammars is not in the measured table this document had. Both get measured before the budget is treated as met.
4. **Download attribution.** Whether browsers attribute a `blob:` download to
the viewing origin for reputation purposes remains an observation to make.
Browser-managed Blob storage may also use temporary disk before a download.
5. **Browser memory behavior.** The old four-copy calculation is superseded
by section 5. Device and browser memory limits remain implementation-dependent.

## 12. Sibling inputs, and the paths used

None of the three had landed on `darkrun/relic/shape` when this was written, so each was read from its unit branch:

- `docs/design/container.md` from `darkrun/relic/units/shape/design-container-and-crypto`.
- `docs/design/topology.md` from `darkrun/relic/units/shape/design-topology-and-origins`.
- `docs/design/storage.md` from `darkrun/relic/units/shape/design-storage-grant-and-cost`, at commit `a9cea77`.

**What each was read for, and what this document takes from it.**

The original `container.md` input supplied the custody-line filename bound
and the link-length rationale. The current envelope filename cap is 1,024
octets; the browser display clamp remains separate.

From `topology.md`: the original gesture-gate and download-link design.
Section 7.1 records the later large-file confirmation, and section 5 states
the browser-storage caveat.

From `storage.md`: the current cap is 524,288,000 plaintext octets, its
cap-sized ciphertext is 524,489,608 octets, and the per-relic mint cap is
200. The older 100 MiB and 64-mint figures are historical.
