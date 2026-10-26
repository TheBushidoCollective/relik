# Relic: the build decisions

`docs/frame.md`, `docs/preconditions.md`, and everything under `docs/spec/`
are locked inputs. Each of those documents routes a short list of open picks
forward. This file makes those picks and records why, so no value in the code
is a number nobody can account for.

Nothing here reopens a locked decision. Where a pick is constrained by a
locked rule, the rule is cited rather than restated.

## From `spec/format.md` section 4

### 1. Wire format and framing

**RFC 8188 `aes128gcm`, unmodified.** It was presumptive in the spec and
nothing displaced it. It satisfies all four required properties: range
decryption, per-record AEAD, plaintext size derivable from encrypted length
before decryption, and a header readable before allocation.

**`rs` is 65536.** Record size bounds the envelope header, which must fit in
record 0 alone (`format.md` 3.1). The maximum header this build can emit is
1301 bytes, so 64 KiB leaves the caps room to grow through a version bump
without touching the framing. It is also a sane GCS byte-range unit: a range
request for one record costs one 64 KiB read.

**The envelope header field caps follow from `rs`:** filename at 1024 bytes,
declared mimetype at 255 bytes, both measured as UTF-8 bytes rather than
characters.

**Record 0 is padded to full `rs`.** RFC 8188 permits only the final record
to be short, and record 0 carries only the envelope header, so it is padded
with the framing's own delimiter-plus-zeros mechanism. This is the
"discretionary padding" case `format.md` 3.3 anticipates: the pre-decryption
size derivation is an upper bound, which is the safe direction for a
refuse-before-allocating check. The exact content length arrives in the
envelope header's per-entry `length` a moment later.

The consequence worth naming: record boundaries stay at fixed offsets, so
content plaintext byte `n` always lives in record `floor(n / (rs - 17)) + 1`.
Range decryption is arithmetic, not a search.

### 2. Key length

**128 bits.** RFC 8188 `aes128gcm` derives a 128-bit content-encryption key
through HKDF regardless, so a longer input keying material buys nothing the
framing can use. 16 bytes is 22 unpadded base64url characters.

The `fragment-terminal-charset` check `format.md` 2.3 requires holds by
arithmetic: 16 is not a multiple of three, the final character carries 2
significant bits, so its index is a multiple of 16 and can only be `A`, `Q`,
`g`, or `w`. Neither `-` (62) nor `_` (63) is reachable, and none of the four
is in GFM's trailing-punctuation set. The check is implemented both ways in
`packages/relic-format/test/fragment.test.ts`.

### 3. ID entropy

**128 bits, 26 Crockford base32 characters.** The floor is 122 bits
(`format.md` 1.2). One 16-byte CSPRNG draw encodes to 26 characters at 5 bits
each, giving 130 bits of capacity carrying 128 bits of entropy.

26 characters clears the reserved-word length guard by six: the longest
reserved word is `manifest.webmanifest` at 20 (`format.md` 1.5).

### 4. The cap, and which side it lands on

**100 MiB, enforced on plaintext.** `format.md` 3.11 requires the published
number be one a user can verify with `ls`, and enforcing on the side that is
published removes the conversion entirely. `size_basis` is therefore
`plaintext` in every `size_over_cap` problem document.

The grant signs a ciphertext constraint computed as
`encryptedSize(104857600)`, so a file exactly at the published cap always
fits, which is the failure 3.11 exists to prevent.

### 5. Bucket padding

**No.** `format.md` 3.8 frames the trade: padding is paid in egress on every
fetch by every recipient forever, against a precondition that names egress as
a kill-switch condition, and what it prevents is a size estimate the operator
gets a coarse version of regardless.

Declining it also keeps the plaintext-size derivation exact for the content
records, so the only slack in the derivation is record 0's padding, which is
a known constant rather than a variable.

The length leak appears in the published disclosure statement, as
`format.md` 3.8 requires under either branch.

### 6. Object metadata at upload

**None is set.** `format.md` 3.2 already bars anything content-descriptive
from object metadata, and section 4 item 6 asks only whether any is needed at
all. Nothing needs it: the renderer class, the client name, and the optional
publisher-declared plaintext title go to the app server in the grant request body
and live on the relic row, and the CRC32C the mint response returns is
non-editable metadata GCS computes on its own.

So the grant signs no `x-goog-meta-*` header, and the blocklist scanner reads
object bytes only.

## From `spec/service.md` section 7

### 1. Edge fidelity

The app server emits every status and problem document in `service.md`
section 1 itself. The degradation contract for load shedding is implemented
as specified: a bare `429` reads as `mint_rate_limited` or
`publish_rate_limited` by endpoint, a bare `503` as `service_paused`.
Asserting this against a deployed edge under load is a launch check, not a
unit test, and it is not claimed as done here.

### 2. Per-object download cap

**200 mints.** The binding constraint is `service.md` 2.3: a 40-person
distribution list inside a Defender tenant draws a floor of 40 legitimate
mints and a ceiling near 80 where scanners detonate with a real browser. 200
clears the ceiling by 2.5x, which leaves room for the same relic to be
forwarded once without dying.

Worst-case egress per relic is 200 x 100 MiB, which is 20 GiB, or $2.40 at
$0.12/GB. That is the number the kill-switch ceiling is set against.

The pool is per relic id across every version: republishing adds an object,
never a second pool (`format.md` 3.12), so the 20 GiB ceiling per id survives
versioning. What versions multiply is storage, up to 100 MiB per version,
kept until deleted.

### 3. Expiry

**No operator TTL. A publisher may set a lifetime, capped at 3650 days;
absent one, the relic never expires.** This reverses the original 7-day pick
and the locked rule it rode in on, and the reversal is recorded rather than
absorbed. The storage-side Delete rule is gone because a bucket-wide rule
cannot express a per-relic lifetime and would have deleted ciphertext the
publisher asked to keep, so expiry is enforced only by the application, at
mint, exact to the second (`service.md` 3.1).

The cap is `config.maxTtlDays`, the accepted ceiling for a publisher-supplied
`ttl_days` in the grant request rather than a recommendation. A relic with no
lifetime has no expiry arithmetic at all: the mint path performs no expiry
refusal and the signed URL validity runs unclamped. The cost of the reversal
is the old rule's whole value: no storage-side reaping exists, an expired
relic's bytes outlive its refusal until explicitly deleted, and the abuse
controls that remain are delete-by-ID, the download cap, and the kill switch.

### 4. Signed-URL validity

**15 minutes, with a minimum viable validity of 60 seconds.** Long enough for
a 100 MiB download on a slow connection, short enough that the residual drain
after the kill switch engages is bounded by 15 minutes of already-minted
URLs.

A mint that would clamp below 60 seconds is refused with `relic_expired`
rather than issuing a URL that dies mid-transfer (`service.md` section 3).
Clamping only exists on a relic with a publisher-set lifetime; one without
never clamps and never returns `relic_expired`.

### 5. Retention window

**30 days.** `service.md` 7.5 names the failure a shorter window causes: the
metric's publishing-IP filter silently stops firing on older relics. It also
bounds how long the tombstone and the mint log's `code` survive, which the
cap-exhaustion cost in 1.2 depends on. It was originally set longer than a
7-day TTL; with no TTL, a relic that never expires can outlive the window,
and the accepted consequence is that the relic row keeps serving after its
mint-log history has aged out.

### 6. Published SLA

**24 hours from arrival, not from triage.** Google publishes no suspension
timeline beyond "timely", so the number has to be same-day-safe across the
named human's timezone and their named backup.

The coverage limit `service.md` 4.1 states travels with the number wherever
it is published: this measures responsiveness on reports received, and it is
never coverage.

### 7. Mint dedup interval

**10 minutes.** It has to exceed the frame's 120-second post-publish window
or the two rules interact, and it has to be short enough that a recipient
returning to a relic later in the day counts as the distinct open it is.

## From the owner, on the usercontent frame's egress

### 1. No network reach for rendered content

**2026-08-18: reversed. The usercontent frame has no network reach,
enforced by the frame's response policy rather than disclosed as a
capability.** The earlier decision, recorded in `spec/viewer.md` 3.5 and 4
and in the frame's second honesty constraint, was parity: rendered content
kept the network reach HTML has always had, a component could fetch
whatever its author wrote, and the recipient was told their IP address,
user agent, and open time could be learned that way. The owner reversed
it: bundle those assets and never fetch them from a CDN, and nothing
outside Relic's own host is allowed.

The mechanism is a CSP on the frame's served response that permits no
remote source of any kind, an iframe carrying `allow-scripts` and nothing
else, and React bundled into the frame's inlined bundle. Inlining is the
only option for that last part, and the reason is structural: the frame is
sandboxed without `allow-same-origin`, so it runs in an opaque origin, and
in an opaque origin `'self'` matches nothing. The frame cannot fetch even
its own assets, so "bundled from our host" can only mean inlined into the
`sandbox.html` response Relic already serves. There is no fetchable middle
ground.

What was traded away, named: a published page that references a CDN
stylesheet, a CDN script, an external font, or a remote image renders
without it, and publishers must inline what their page needs. A component
that reads from an API at render time is no longer expressible. That is a
real reduction in what a relic can be, and it was chosen anyway.

The enforcement is measured, not argued. With the policy in place, `fetch`,
`<img>`, `sendBeacon`, `WebSocket`, and `EventSource` all produced zero
arrivals at a collector server. `sendBeacon` returned `true` while
delivering nothing, so its return value is not evidence. A form with
`target=_blank` submitted and never arrived, blocked by `form-action
'none'`. `window.open` was blocked in the probe, but no user gesture was
present, so the policy is not what stopped it; popups are removed by
dropping the `allow-popups` sandbox flag instead.
### 2. Reader-activated external links

**2026-09-24: permitted through the parent, not through the render frame.** A
reader may activate an absolute `http`, `https`, or `mailto` link in an
HTML or JSX relic. The frame prevents its own navigation, validates the scheme,
and posts the canonical destination to the parent. The parent validates it
again and opens a new top-level tab with `noopener` and `noreferrer`.

This does not restore rendered-content egress or arbitrary popups. Author code
cannot invoke the path because the frame accepts only a trusted click event,
and the iframe still carries exactly `sandbox="allow-scripts"`. Relative,
fragment-only, `javascript`, `data`, `blob`, and `file` destinations stay
inside the boundary and do not navigate.

## What is not decided here

These are launch obligations, not build decisions, and the build does not
claim them:

- The two registrable domains, and Search Console verification on both
  (`preconditions.md` section 2). The build runs against placeholder names.
- The pre-launch Safe Links fragment test (`service.md` section 6). Until it
  runs, the disclosure statement's wording stays correct under all three
  possible outcomes.
- The named abuse-response human and their backup
  (`preconditions.md` section 1).

## 2026-08-18: Pre-render statement demoted to a compact marker

The pre-render statement in the viewer (previously a banner above the content) was demoted to a compact marker in the header chrome. Its original justification was that rendered content could reach the network, allowing the author to learn the recipient's IP, user agent, and open time. Since that egress was removed by the strict CSP applied to the frame, the risk described by the banner is gone. A banner shouting about a removed risk trains recipients to ignore real ones. The page now carries a quiet marker in the header chrome stating "Runs author code, isolated" (linked to `/policy` for the full statement) rather than a block layout banner.

## 2026-09-12: Open Graph card metadata and per-relic plaintext title

`docs/spec/viewer.md` §6.2 originally ruled that Open Graph and Twitter Card metadata was identical for every relic, asserting that "a per-relic value would either be a fabrication or a leak," and `docs/spec/format.md` §3.2 treated server-side storage of a filename as a frame violation.

**The repo owner authorised an explicit reversal of that rule.** The blank preview card produced on link unfurls on unfamiliar domains presented the visual shape of a phishing link, creating recipient distrust before the relic could ever be opened. To solve this, a per-relic plaintext title is now permitted.

**What stays constant and what becomes per-relic.**

- `og:image`, `og:description`, `og:type`, and `og:site_name` remain constant across all relics. [Amended 2026-10-13: `og:image` is no longer constant across all relics; see the 2026-10-13 decision below for per-relic cover images.] `og:type` is `website`, `og:site_name` is `Relic`, and `og:description` is the constant text: "An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
- `og:title` and the viewer document `<title>` carry the publisher-declared plaintext title (defaulting to the source filename). When titled, `<title>` renders as `{title} · Relic` (using a U+00B7 middle dot, never a dash). When untitled, the fallback title is `A relic` for `og:title` and `twitter:title`, and `Relic` for `<title>`.
- `og:url` carries `{serviceOrigin}/{id}` when the path segment is a valid relic id, or the service origin root otherwise.
- Twitter Card tags mirror their Open Graph equivalents: `twitter:card` is `summary_large_image`, with `twitter:title`, `twitter:description`, and `twitter:image`.

**Image asset path and cache policy.**
The preview card image is served from `/assets/card.v1.png` (a 1200x630 PNG, located in `packages/relic-viewer/public/card.v1.png`). [Amended 2026-10-13: `card.v1.png` remains the fallback card image when a cover is declined or unavailable; see the 2026-10-13 decision below.] Cache policy is the single exception to the server's blanket `no-store`: `cache-control: public, max-age=31536000, immutable`, alongside `referrer-policy: no-referrer` and `x-content-type-options: nosniff`. Versioning lives in the filename so future asset designs can ship as `card.v2.png` without cache collisions. The image is never gzipped.

**Disclosure obligations and security invariants.**

- Storing the title in plaintext on the relic row is an acknowledged metadata leak. [Amended 2026-10-13: Storing per-relic cover image rasters is an additional acknowledged leak; see the 2026-10-13 decision below.] The published disclosure statement (`/policy` per `docs/spec/service.md` §5) must explicitly state that the publisher-declared title is stored server-side in the clear and served on link unfurls and the viewer document `<title>`.
- Declining the title is the publisher's choice, not the operator's: a publisher can pass an empty title or clear it on republish, reverting to the constant fallback metadata.
- Tombstoned, expired, unknown, or malformed relics stop serving the stored title immediately, serving the constant fallback metadata (`A relic`).
- Serving metadata on `/{id}` continues to mint nothing, increment no open counters, and consume no download cap.
- The `X-Robots-Tag: noindex` header and `robots.txt` disallow posture remain intact on `/{id}`: unfurlers parse Open Graph tags regardless, while compliant search indexers do not index.

## 2026-09-13: Open Graph card reveals coarse renderer class

The unfurl card introduced yesterday (PR #69) revealed a relic's title but said nothing about what kind of thing it was: the description remained one constant sentence for every relic. The owner's steer: "relics should still reveal WHAT they are in the OG. Just not the content."

**The coarse renderer class on the card.** The service already holds the coarse renderer class on the relic row (`markdown`, `code`, `html`, `jsx`, `image`, `media`, `archive`, `binary`), declared at publish time and previously used only for server-side telemetry. The card now reveals this class in its description and fallback title.

**What stays constant and what becomes per-class.**

- `og:image` remains the single constant raster at `/assets/card.v1.png` (with its constant dimension and alt tags). [Amended 2026-10-13: Replaced by per-relic cover rasters with `card.v1.png` retained as fallback; see the 2026-10-13 decision below.] `og:type` (`website`), `og:site_name` (`Relic`), and `twitter:card` (`summary_large_image`) remain constant. The one-raster budget on the service origin and the immutable cache policy (`public, max-age=31536000, immutable`) stay intact for the fallback card.
- `og:description` and `twitter:description` now reveal the coarse renderer class. [Amended below: copy selects via `CLASS_BEHAVIOUR`, not `isRenderable`; media plays in browser.] The copy combines a phrase naming the kind of thing, one space, and a tail split by `CLASS_BEHAVIOUR` from `@relic/format`:
  - `markdown`: "A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `code`: "A source code file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `html`: "An HTML page. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `jsx`: "A JSX component. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `image`: "An image. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `media`: "An audio or video file. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it."
  - `archive`: "An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it."
  - `binary`: "A binary file. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it."
- `og:title`, `twitter:title`, and the viewer `<title>` use the publisher-declared plaintext title when present. When untitled, the fallback title is now per class:
  - `markdown`: `A Markdown relic`
  - `code`: `A code relic`
  - `html`: `An HTML relic`
  - `jsx`: `A JSX relic`
  - `image`: `An image relic`
  - `media`: `A media relic`
  - `archive`: `An archive relic`
  - `binary`: `A binary relic`
- For an untitled relic, the document `<title>` renders as `{Class} relic · Relic` (using a U+00B7 middle dot, never a dash).
- When a relic is unknown, tombstoned, expired, or malformed, or if a store read fails, it serves the constant fallback metadata: `A relic` for `og:title` and `twitter:title`, `Relic` for `<title>`, and `An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.` for `og:description` and `twitter:description`.

**Declining a title does not hide the class.** The title is publisher-declared and declinable: a publisher can pass an empty title or clear it on republish. The class is derived from the decrypted bytes by the publishing client and is not declinable.

**Converting the format.md 3.6 boundary from an absence into a tested guard.**
- `docs/spec/format.md` §3.6 originally argued that the renderer class must never reach the viewing origin, keeping it out of reach to prevent fragment theft if the viewer ever routed on a publisher-asserted class.
- Emitting the class in `/{id}`'s head as card metadata puts the class on the viewing origin's document for the first time.
- The container still does not carry the class. What actually protects routing is `routeFor`'s inputs in `packages/relic-viewer/src/viewer.ts` (`filename`, `declaredMimetype`, `content`), which derive strictly from the envelope header inside the AEAD plus magic-byte sniffing of the decrypted content, resolving disagreements to the least-privileged tier. The class is not a parameter of `routeFor`, so routing on it would require a signature change rather than a silent edit.
- The absence of the class from the origin was a second, weaker belt, and this change spends it deliberately so recipients can see what kind of thing a link holds before opening it.
- The replacement guard is a test on the built viewer bundles ensuring they never read the card metadata from the DOM. A tested boundary is weaker than an architectural impossibility, and the project documents that trade honestly.

## 2026-09-13: Card copy correction: media plays in the browser, selected by CLASS_BEHAVIOUR

The unfurl card shipped this morning (PR #70) selected its closing tail using `isRenderable` from `@relic/format`. Because `media` is outside `RENDERABLE_CLASSES`, the card for video and audio relics told recipients:

> An audio or video file. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.

**The claim was false.** The viewer does not download media. `routeForClass` in `packages/relic-viewer/src/viewer.ts` routes `media` to the `media` route, and `renderMediaView` in `packages/relic-viewer/src/main.ts` mounts a real `<video controls playsinline>` or `<audio controls>` player on the page. The card gave recipients a false statement about what happens when opening the link.

**The cause.** `RENDERABLE_CLASSES` is telemetry vocabulary for the operator success metric, not a description of viewer capabilities. Its test calls it the wedge boundary (the success metric's second clause), which counts only document, markup, code, and still-image opens against the file.kiwi comparison floor. It was reached for because it was the nearest existing predicate, conflating metric classification with user interface behavior.

**The replacement behaviour table.** `@relic/format` now exports `ClassBehaviour` (`'renders' | 'plays' | 'downloads'`) and `CLASS_BEHAVIOUR: Record<RendererClass, ClassBehaviour>`, reflecting what the viewer actually delivers for each class:
- `renders`: `markdown`, `code`, `html`, `jsx`, `image`
- `plays`: `media`
- `downloads`: `archive`, `binary`

The unfurl card description now selects its tail using `CLASS_BEHAVIOUR`, producing three distinct tails:
- `renders`: "It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
- `plays`: "It plays in your browser, and only someone holding the whole link, including the part after the #, can open it."
- `downloads`: "It downloads to your device, and only someone holding the whole link, including the part after the #, can open it."

A media relic's card now correctly reads: "An audio or video file. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it."

**The guard against recurrence.** `routeForClass` and `CLASS_BEHAVIOUR` must agree across all eight classes. A viewer test in `packages/relic-viewer/test/viewer.test.ts` asserts:
- `downloads` if and only if the route is `download`
- `plays` if and only if the route is `media`
- `renders` if and only if the route is one of `markdown`, `code`, `image`, `sandboxed-html`, `sandboxed-jsx`

The test is driven from `RENDERER_CLASSES`, ensuring that adding a ninth class to the taxonomy will fail the test immediately unless both viewer routing and card behavior explicitly account for it.

## 2026-09-16: The isolation marker states its route, not the riskiest route

The 2026-08-18 entry above records the pre-render statement being demoted to a compact marker reading "Runs author code, isolated". That string was one constant applied to every relic, so the marker was printed unchanged on relics where no author code runs at all. On a published five-second mp4 the header told its recipient the video runs the author's code, which the browser's media decoder does not do, and which `sandbox.html` is never reached to do.

This is the same defect the 2026-09-13 entry above corrected on the unfurl card, one surface later: a single sentence written for the riskiest class, shown for all of them. The card was fixed by selecting on `CLASS_BEHAVIOUR`. The marker is fixed by selecting on the **route**, which is the stricter key of the two, because the route is what actually executes. `format.md` §3.6 lets a declared class and a sniffed class disagree, and the viewer resolves that to the least privileged of the two before the bar is built, so the marker now states the resolved decision rather than the envelope's claim.

| route | marker |
|---|---|
| `sandboxed-html`, `sandboxed-jsx` | Runs author code, isolated |
| `markdown`, `code` | Rendered as text, no author code |
| `image` | Shown as an image, no author code |
| `media` | Plays in your browser, no author code |
| `pdf` | Rendered as a document, no author code |
| `download` | Downloads to your device, no author code |

Each line names the mechanism first and then what the reader is owed about author code, so the sentences stay parallel and the one route that does run code reads as the exception. The single string remains the label, the accessible name, and the stem of the tooltip, which is what the 2026-08-18 entry's WCAG 2.5.3 requirement asks for; only its selection changed.

**The guard against recurrence.** A test in `packages/relic-viewer/test/browser.test.ts` walks every route: the two sandboxed routes must read exactly "Runs author code, isolated", and every other route must not contain "Runs author code" and must contain "no author code". It then builds the real bar for a `media` relic and asserts the rendered marker text and its accessible name. Restoring the single constant fails it.
## 2026-09-16: Historical comments without a version belong to version 1, never the current version

**The reported defect.** When per-version comments were introduced, comments written before the server stamped version numbers carried no stored version (`null` or `undefined`). The viewer filter previously showed these unversioned rows whenever viewing the current version (`(entry.version === null || entry.version === undefined) && isCurrentVersion`). Because existing relics predating versioning only have unversioned comments, their current/latest versions displayed their entire historical comment thread, directly violating the requirement that the latest version must remain clean and comments must live with their respective versions.

**The rule.**
1. A comment stamped with an explicit version shows only when viewing that exact version.
2. A relic with no history (`currentVersion <= 1`) shows all comments regardless of stored version, ensuring single-version relics never lose rows.
3. On a relic with version history (`currentVersion > 1`), a comment carrying no version shows only on the oldest version (version 1), never on the current version or intermediate versions.
4. The unversioned comment badge displays "Version unknown" as its visible text, with "Predates versioning" preserved in the `title` attribute. It states the honest truth about placement rather than merely noting the comment's age, while retaining the `.comment-badge-unversioned` class.
5. The taskbar comment count is derived directly from the filtered entries list and strictly equals the number of comment rows rendered in the thread in every view.
6. Newly submitted comments continue to post stamped with the version currently being viewed.

**Why version 1 rather than hiding them.** An unversioned comment's true version is unknowable, so it cannot be claimed for any later version. Quietly dropping or hiding historical comments would erase real reader discussion and make threads appear shorter than they are. Version 1 is the origin of the relic and the honest home where unversioned historical comments remain discoverable and readable without polluting newer revisions.

**The guard against recurrence.** Guarded by tests in `packages/relic-viewer/test/version-diff-ui.test.ts` under `comment version scoping`. Specifically, `viewing v3 on a multi-version relic shows v3 comments but not v1 or unversioned comments` asserts that viewing version 3 of a 3-version relic excludes unversioned comments. Restoring the `isCurrentVersion` clause causes this test to fail on line 1145.

## 2026-09-20: Comments gain a write surface beyond delete, and one piece of comment state deliberately is not encrypted

Two reversals in one station.

**Comments gained a write surface beyond delete.** Until now a comment could be created and deleted by its author, and nothing else: the delete endpoint was the whole write surface after posting. A comment that could only be answered with another comment left a publisher's fix arriving as a fresh thread row nobody could attach to the complaint, and settling remarks on your own relic had no surface at all. `service.md` 1.9 and section 8 now own `PATCH /api/relics/{id}/comments/{comment_id}`, whose body carries optional `ciphertext` and optional `resolved`. The two fields have different owners, and the surface is authorized per field rather than per caller: the ciphertext edit is authorized exactly like delete, the comment's author, because replacing a body is a destructive act on somebody else's words; the resolution is authorized for the comment's author or the relic's publish token, because a publisher settling feedback on their own relic is the point the state exists for. A request carrying neither field refuses with `400 nothing_to_change` rather than performing a silent no-op. The response and the read rows state `edited_at`, `resolved_at`, and `resolved_by`, each an ISO string or `null`. This is recorded as a wire contract; no browser behaviour is claimed anywhere in this entry.

**One piece of comment state is deliberately not encrypted.** The rows hold editorial state as plaintext fields. A resolution decides whether a republish is blocked, and that is an answer the service gives before any key exists on its side, so there is nothing on its side to seal it with: an encrypted column the operator could not perform would either break the gate or gate on plaintext pretending to be sealed. The operator learns that a comment was settled and by which address, and still cannot read a word of it. The edit stamp is disclosed on the same basis but costs less, because the service holds one ciphertext per comment and an edit overwrites it: there is no edit history, and the honest disclosure is that an edit happened and when, never the text. Frame-bridge geometry rode along in the same station and is restated in `viewer.md` 6.6 rather than here.

**The guard against recurrence.** `packages/relic-viewer/test/comment-write-contract.test.ts` carries the contract's tests; the mutation discipline and the integration gate belong to the integration owner, not this entry.

## 2026-09-20: A comparison aligns on what did not change, and an identical version is refused

Four picks, all in the same session, all about a reader holding two versions
in their head.

**Side by side is the default for every rendered comparison, and the swipe is
one click away.** Swipe was the default and it is the wrong one: a wipe shows
the pixels moving but never both readings at once, so a reader comparing prose
has to remember the left to judge the right. Side by side shows both. The swipe
still earns its place where the change is positional rather than textual, which
is why it stays a click away rather than being removed, and its slider is
hidden in every other layout because a control that does nothing where it sits
is worse than an absent one. **The choice is remembered across a version
switch**, in `localStorage`, because a reader who picked a layout and then
moved between versions was silently handed the default back, and the default is
the one they had just rejected.

**The scroll sync anchors on unchanged content, not on page fraction.** Two
versions of one document have different heights, so aligning by fraction puts
the same paragraph at two different places, and the error grows with the size
of the edit: on the framed fixture, a version with two inserted paragraphs
lands 117 pixels out on a document a reader is trying to read line against
line. The diff already pairs changed nodes; it now also pairs identical ones,
mints an id for each pair in its own namespace, and the follower scrolls the
paired node rather than a proportion. Both namespaces cross the frame boundary:
the first cut only accepted the changed-pair namespace on the wire, which
silently dropped most messages and left the follower still while the leader
scrolled, and `packages/relic-viewer/test/scroll-sync.test.ts` now holds a case
that fails when either namespace is refused.

**A comparison carries a change navigator, and every change is addressable.**
Prev, next and a position that says which of how many, plus a list of changes
in the sidebar whose rows jump. Each stop scrolls the pane that actually holds
the change rather than always the newer one, because an addition exists in one
version and a removal in the other, and asking the pane without it produces a
jump to nothing. Before the diff has run the navigator says it is comparing;
it never says "No changes", which is an answer it does not have yet and which
reads as a finished comparison of two identical versions.

**A republish whose content is identical to the live version is refused,
locally, before any request.** A version is a thing recipients are told to look
at again, and one that changes nothing cannot be told from a real one until it
has been read, so it spends their attention and returns nothing. The client
keeps `content_sha256` in publish state: SHA-256 over the bytes, the envelope
filename, and the plaintext title together, so a retitle is a real version and
a re-upload of the same file is not. The service cannot answer this question
and is never asked, because it holds ciphertext and a fresh salt per object
(`format.md` 3.10) makes two encryptions of one file differ byte for byte.
It sits above the comment gate, which is the first thing in that path to touch
the network: an unchanged file is also the likeliest reason comments are still
open, so naming the duplicate first names the cause.

Two costs, accepted. **Legacy state cannot take part**, and there is no repair
for it anywhere: the digest is of plaintext, and the service would not hand a
client the plaintext to hash even if asked. Such an entry republishes once on
that ground and records a digest as it lands, so the gate is self-healing per
relic rather than retroactive. **And the gate is client-side discipline, not a
boundary**, exactly like the comment gate: the machine holding the publish
token can call the HTTP API directly, and the service cannot enforce what it
cannot read.

**The guard against recurrence.** `describe('duplicate versions')` in
`packages/relic-mcp/test/e2e.test.ts` holds five cases: an identical file is
refused with zero fetch calls, a changed byte moves the recorded digest, a
retitle is allowed and then refused on repeat, an entry with no digest
republishes once and records one, and a malformed digest refuses loudly instead
of comparing against a value nothing can equal. Removing the gate fails four of
them; trusting a malformed digest fails the fifth.

## 2026-10-06: Homepage relics list and script execution on /

`docs/spec/viewer.md` §6.7 and `docs/frame.md` originally ruled that the landing page `/` was strictly script-free under `default-src 'none'`, and that Relic offered no dashboard or relics list because there was no logged-in surface to host one.

**Jason Waldrip authorised an explicit reversal of that rule.** The homepage now displays the relics this browser has opened, giving returning readers immediate access to their files without navigating away or signing in.

**What changed on `GET /`:**
- The server template emits an empty, hidden container immediately after `<p class="lede">`: `<section id="home-relics" class="home-relics" aria-labelledby="home-relics-title" hidden></section>`.
- The server template emits `<script type="module" src="/assets/home.js"></script>` immediately after `</main>`.
- The CSP for `/` is: `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'`.
- The client bundle `/assets/home.js` reads this browser's localStorage vault. When keys exist, it unhides `#home-relics` and populates:
  - `<h2 id="home-relics-title">Your relics</h2>`
  - `<p class="home-relics-note">Relics this browser has opened. The list is read here and sent nowhere.</p>`
  - `<ul class="home-relic-list">` with rows sorted by `lastOpenedAt` descending (and relics without timestamps following in vault order). Each row contains `<span class="home-relic-kind">{previewLabel}</span>` and `<a class="home-relic-link" href="/{encodeURIComponent(relicId)}#{fragment}">{title}</a>`.
  - `<p class="home-relics-more"><a href="/dashboard">Back up keys, forget a relic, or find relics you commented on</a></p>`.
- All DOM nodes are built via `createElement` and `textContent`; `innerHTML` is forbidden because relic titles are untrusted.

**What stays true:**
- The client bundle `/assets/home.js` makes no request to assemble the list: no session check, no `/api/auth/relics`, and automated tests pin that absence.
- The CSP on `/` omits `connect-src`, falling back to `default-src 'none'`, which refuses request APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`) as a backstop.
- `/install` stays completely static and script-free, served under the original script-denying CSP (`default-src 'none'`). Both routes share one template function so install instructions cannot drift.
- When JavaScript is disabled, or when this browser holds no keys in its vault, `/` renders identically to the previous static landing page.
- Relics only commented on, email sign-in, key export/import backup, and Forget operations remain on `/dashboard`, which `/` links to.

**The disclosed cost and risk:**
Running script on `/` puts first-party code onto the origin where local storage holds decryption keys. The original objection in §6.7 remains true: a static page with nothing to execute is the easiest to keep honest. What keeps the list in the browser is the script we serve, which is the same trust a reader already extends to the viewer that holds the key. The CSP's missing `connect-src` refuses request APIs, but CSP does not govern top-level navigation, and `img-src 'self'` still permits a same-origin image request whose URL could carry data to our own server. The script makes no requests, and tests pin that behaviour; the rest is operator intent in the code we author.

## 2026-10-13: WebRTC STUN egress containment in the sandboxed frame

`packages/relic-server/src/app.ts` served `sandbox.html` with CSP `webrtc 'block'`, and documentation asserted closed egress for HTML and JSX relics.

**The finding:**
Empirical measurement against Chrome 155 with a loopback UDP collector proved that Chrome does not recognize or enforce `webrtc 'block'`. Authored HTML or JSX in a relic could instantiate `RTCPeerConnection`, configure an attacker-controlled STUN server, and transmit UDP Binding Requests, leaking the reader's IP address.

**Evaluated options:**
1. **CSP directives (`frame-src 'none'`, `child-src 'none'`):** Measured in Chrome 155. Chrome permits `about:blank`, `about:srcdoc`, and script-created frames even under `frame-src 'none'`. CSP alone does not block nested browsing contexts.
2. **Permissions-Policy:** Chrome 155 exposes no feature policy or permissions policy token for WebRTC or ICE gathering.
3. **Regex HTML sanitizing:** The previous WIP used regex to strip frame tags. Regex sanitizing is brittle and bypassable, but more importantly, it does not stop author JavaScript from calling `document.createElement('iframe')`.
4. **Synchronous prototype and constructor containment in the frame:** Neutralizing `RTCPeerConnection`, `webkitRTCPeerConnection`, and related transport constructors on `window`, `Window.prototype`, and `globalThis`, overriding `contentWindow` and `contentDocument` getters on frame prototypes to return null, and intercepting element creation (`createElement`, `createElementNS`) and insertion (`appendChild`, `insertBefore`, `replaceChild`, `append`, `prepend`, `replaceChildren`, `insertAdjacentElement`) to deny frame elements (`iframe`, `frame`, `object`, `embed`, `portal`). For markup in HTML relics, `DOMParser` parses and strips any frame tags before `document.write`.

**The decision:**
Active frame containment is adopted:
- `RTCPeerConnection`, `webkitRTCPeerConnection`, and transport constructors (`RTCIceGatherer`, `RTCIceTransport`, `RTCDtlsTransport`, `RTCSctpTransport`, `RTCSessionDescription`, `RTCIceCandidate`, `RTCDataChannel`, `RTCRtpSender`, `RTCRtpReceiver`, `RTCPeerConnectionIceEvent`) are deleted and locked to `undefined` across the entire prototype chain of `window`, `Window.prototype`, and `globalThis`. Their interface prototype methods (`createOffer`, `setLocalDescription`, `createDataChannel`, `addIceCandidate`) are neutralized defensively.
- `Worker` and `SharedWorker` constructors are locked to `undefined` in the frame realm (backed by CSP `worker-src 'none'`).
- `HTMLIFrameElement`, `HTMLFrameElement`, and `HTMLObjectElement` prototypes have `contentWindow` and `contentDocument` getters returning null. `HTMLEmbedElement.prototype.getSVGDocument` returns null.
- Programmatic creation (`createElement`, `createElementNS`) and DOM insertion (`appendChild`, `insertBefore`, `replaceChild`, `append`, `prepend`, `replaceChildren`, `insertAdjacentElement`, `adoptNode`, `importNode`) of nested frame elements (`iframe`, `frame`, `object`, `embed`, `portal`) throw a `SecurityError` `DOMException`.
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `Range.prototype.createContextualFragment`, and post-load `document.write` / `document.writeln` strip frame markup elements.
- Incoming author HTML in `sandbox.ts` strips frame markup elements before the initial `document.write`.

**The real security posture and accepted costs:**
Containment is a tested runtime deny-list inside the frame's JavaScript realm, not an architectural impossibility. CSP and the opaque sandbox remain defense in depth. Future browser platform APIs, unpatched global properties, or novel parser entry points could reopen egress channels before we patch them. The containment trades capability for confinement: nested frames and web workers in HTML and JSX relics are denied. Egress is guarded by measurement rather than guaranteed by browser boundary.

**The guard against recurrence:**
`packages/relic-viewer/test/frame-webrtc-egress.test.ts` runs headless Chrome against a real UDP collector across 14 vectors: direct, alias, saved reference, global prototype chain walking, nested script iframe, markup srcdoc iframe, createElement, createElementNS, createHTMLDocument adopt/append, innerHTML, post-load document.write, window.open, workers, and JSX relics. It asserts that the probe executed and that zero UDP packets arrive.

## 2026-10-13: Per-relic cover images on the unfurl card

The rule that `og:image` is one constant raster across all relics and that the
operator learns only title, class, and coarse metadata was reversed by Jason
Waldrip on 2026-10-13.

**What changed.**
The publisher's MCP client (`relic-mcp`) now renders a 1200x630 cover image
of the document's first screen in local headless Chrome at publish and
republish time, and uploads it via `POST /api/relics/{id}/cover`. For relics
with an active cover image, the unfurl card serves `og:image` from
`/{id}/cover/{sha256}.{png|jpg}`, displaying a full-bleed picture of the
opening of the content as a recipient sees it.

**What stays unchanged.**

- The encryption key remains in the URL fragment and never reaches the server.
- The file's ciphertext continues to upload directly from the client to Google
  Cloud Storage under signed upload grants, never transiting the application
  server.
- Client-side decryption and execution within the isolated viewer sandbox
  remain intact.
- When a relic has no cover, when `cover: false` was passed, or when the relic
  is expired, tombstoned, unknown, or a store read throws, `og:image` falls back
  to `{serviceOrigin}/assets/card.v1.png` with the constant fallback metadata
  tags and immutable caching (`max-age=31536000, immutable`).

**What it buys.**
High-fidelity, legible link previews on chat and social platforms (Slack,
Discord, iMessage, Twitter, etc.) displaying an authentic, full-bleed 1200x630
rendering of the top of the content as the recipient sees it, replacing the
generic blank-accession-card preview. Body text reaches about 14 px at a
500 px unfurl width, making text legible before clicking.

**What it costs.**
The cover is plaintext pixels of the first screen, stored server-side and
served to anyone holding the link without its fragment, including unfurl
services and their caches. This is an acknowledged plaintext leak of visual
content. `cover: false` declines; republishing with `cover: false` clears;
takedown deletes it.

**The renderer choice and why server-served render pages were rejected.**
Cover rendering happens entirely on the publisher's machine (`relic-mcp`)
using a local headless browser (system Chrome, Chromium, or Edge). Option (c)
from the architecture evaluation was chosen: `relic-viewer` builds a dedicated
cover renderer (`buildCover` in `packages/relic-viewer/build.ts`) that outputs
to `packages/relic-mcp/dist/cover/`. It is never written into
`packages/relic-viewer/dist/`, which ensures the public service origin can
never serve the cover rendering page. Plaintext reaches Chrome via CDP Fetch
interception on `https://cover.relic.invalid`, so no content leaves the machine
during rendering.

Server-served render pages were rejected because `docs/frame.md` locked
constraint 1 specifies that untrusted content must render on a separate
usercontent origin, and serving plaintext render pages from the service origin
or placing the server in the data path would violate zero-knowledge
architecture. The server cannot render content without receiving plaintext
bytes, which would destroy the core zero-knowledge property.

**The Chrome egress flags with the planner's measurements.**
Chrome is launched with strict network containment flags:
`--host-resolver-rules=MAP * ~NOTFOUND`,
`--proxy-server=http://proxy.relic.invalid:1`,
`--proxy-bypass-list=<-loopback>`,
`--webrtc-ip-handling-policy=disable_non_proxied_udp`, and `--disable-quic`.

Measurements by the planner confirmed that CDP request interception does not
observe network traffic originating from an isolated sandboxed iframe
(`<iframe sandbox="allow-scripts">`). Therefore, containment cannot rely on
CDP interception alone and requires browser-level network denial flags.
Omitting `--webrtc-ip-handling-policy` allowed UDP packets to escape even when
an invalid proxy was configured (measured). These flags ensure all TCP, UDP,
and DNS egress is blocked.

**Validation.**
Cover rasters are validated by `validateCoverRaster` in `@relic/format/cover`,
run by the client prior to upload and enforced by the server on
`POST /api/relics/{id}/cover`. Rasters must be valid PNG or JPEG images under
524,288 bytes (512 KB), with dimensions exactly 1200x630. For PNG: valid 8-byte
signature, 13-byte IHDR (8-bit RGB or RGBA, non-interlaced), contiguous IDAT
chunks, empty IEND, and zero trailing bytes after IEND (rejecting polyglots and
appended payloads). Ancillary chunks (tEXt, iTXt, zTXt) are stripped. For JPEG:
valid SOI, JFIF APP0, single SOF0/SOF2 baseline or progressive marker, and zero
trailing bytes after EOI. Non-standard application markers and comments
(APP1-APP15, COM) are stripped.

**Serving and cache policy.**
Cover images are served at `GET|HEAD /{id}/cover/{sha256}.{png|jpg}`,
content-addressed by the SHA-256 of the validated raster bytes. Response
headers:

- `content-type: <cover.type>`
- `content-length: <n>`
- `cache-control: public, max-age=86400`
- `x-content-type-options: nosniff`
- `referrer-policy: no-referrer`
- `x-robots-tag: noindex`

Caching uses a 1-day max-age (`max-age=86400`) instead of immutable, so that
takedown tails in honoring caches are bounded to 24 hours. Because the URL is
content-addressed, a new version uploaded on republish produces a distinct URL
and refreshes unfurl caches immediately. The route mints no download URLs,
touches no counters, and does not consume the relic download cap.

**Fallback.**
When a relic has no cover, when `cover: false` was selected, or when the relic
is expired, tombstoned, unknown, or a store read throws, `og:image` and
`twitter:image` point to `{serviceOrigin}/assets/card.v1.png` with the constant
fallback metadata tags and immutable caching (`max-age=31536000, immutable`).

**Release order.**

1. Server deployment (`deploy.yml`): deploys the upload route, cover route, and
   updated `/policy` disclosure statement to production. No released client
   uploads covers yet, so disclosure strictly precedes capability.
2. Post-deploy verification: test the upload and serving endpoints against
   `https://relik.link` using the local client built from source.
3. Client release (`publish-mcp.yml`): release the updated `relic-mcp` package
   to npm with a version bump, shipping tool schemas, descriptions,
   INSTRUCTIONS item 8, SKILL.md, and `dist/cover/`.
4. Post-release verification: verify end-to-end publish using
   `npx relic-mcp@<version>`.
5. Live unfurl check: Jason pastes a live link into Slack or iMessage to
   confirm real unfurl behavior in production.

**The guards that replace the lost guarantee.**
The lost guarantee was that the service origin serves exactly one constant
raster. The replacement guarantee is: The service serves exactly two kinds of
raster: `/assets/card.v1.png`, and a cover that a live row references for its
current version and that passed `validateCoverRaster`. A declined cover leaves
nothing in the row, the store, or any URL.

Guards:

- G1 (server state table): `app.test.ts` tests that missing cover, declined
  cover, stale version, tombstone, expiry, unknown ID, store failure, hash
  mismatch, or extension mismatch causes shell `og:image` to fall back to
  `card.v1.png` and cover route to return 404.
- G2 (raster validator): `cover.test.ts` rejects PNG+ZIP polyglots, tEXt chunks,
  bad dimensions, interlacing, 16-bit, bad CRC, oversized IDAT, JPEG COM/APP1
  markers, and trailing data.
- G3 (declined leaves nothing): Republish with `cover: false` clears
  `row.cover`, deletes stored cover objects in GCS (`m/cover/{id}/*`), and old
  cover URLs return 404. Client makes zero render calls and zero cover requests.
- G4 (renderer containment): Chrome launch arguments are pinned by exact-list
  tests, and egress tests assert zero packets escape.
- G5 (service separation): `relic-viewer/dist/` contains none of the cover
  files, ensuring the public web service never serves the cover renderer page.

## 2026-10-13: Timeline comments stay in fullscreen, and markers open the comment card

Jason Waldrip reported that comments on a video timeline were hard to make
and asked for a popover rather than the comment sidebar. Two earlier rules
are reversed by that decision.

**Fullscreen is kept while a comment is written.** The player used to leave
stage fullscreen before any aim that focused the composer, because the
composer lived in the sidebar, outside the fullscreen element, and could not
be seen from inside it. Every timeline gesture now opens the shared popover
composer over the scrubber, and in stage fullscreen the popover layer mounts
the panel inside the fullscreen `.media-stage` and translates its anchor
there. Nothing in the player leaves fullscreen any more. The page leaves it
in two cases only, both of which have to show the sidebar: a reader with no
verified address, whose identity flow lives there, and a press on "Open in
thread". The controls stay awake while a panel is open on the stage. iOS
native fullscreen shows the platform player and none of this chrome, so
nothing changes there. The test that pinned the old behaviour in
`media-player.test.ts` was repinned to the reverse, with a comment saying so.

**The marker tooltip is replaced by the comment card.** Hovering a timeline
marker showed a bespoke `.timeline-marker-tooltip` and, after the hover
delay, the comment card on top of it: two forms of one idea, overlapping.
A marker press also stopped propagation and scrolled the sidebar. Markers
now open the same card every other kind of mark opens, on hover, press and
keyboard focus, and the press still seeks and pauses. A cluster opens a card
listing its members, each of which opens its own card, so every comment in it
is one press away and keeps its own reply, edit and resolve.

**Found and fixed on the way.** A focus moving inside an open card rebuilt the
card, because the card carries its comment's id, so the field a Reply put up
was thrown away the moment it took focus. Measured in a real browser before
the change (`field: false` after pressing Reply on a marker card) and fixed
for every card. A hover that began before a composer opened could also replace
it when its delay ran out; the delay now checks again before it opens
anything, and a card never replaces a panel holding unposted text.

Every time comment's sidebar row also said "This comment points at part of
the document that this page cannot show" while its marker sat on the
scrubber. Observed on origin/main for a verified reader on a fresh page: five
rows of five carried the note with three markers painted, and still did a
second later. The first paint runs before the media knows its duration, so
every time mark is counted unplaceable; the time adapter paints the marks
itself once the metadata lands and dispatches `relic-repaint`, which nothing
heard, so the rows were never drawn again. The thread now repaints and
redraws its rows on `relic-repaint`, and the same page shows none of the
notes.

Timeline markers were patina on a patina played bar and a faint tint on the
unplayed rail, so a span over anything already played disappeared. Every
marker kind is now drawn in `--ink` inside a 1px `--surface` ring. Measured
in the browser: the fill against the unplayed rail is 12.73:1 on the page
and 11.13:1 in the fullscreen stage, and the ring against the played bar is
6.06:1 and 6.89:1. The fill alone against the played bar is 2.82:1 and
2.06:1, which is why the ring is there.

## 2026-10-14: Change notices on republish, and addresses a publisher shares with

Authorised by Jason Waldrip on 2026-10-14.

**The reversal.** Relic originally sent no outbound notifications beyond optional comment alerts to a verified owner, and held no third-party email addresses. That non-goal is reversed: when a relic is republished, the service sends change notices announcing the new version to everyone who commented on the relic and every address registered via deliberate sharing, unless `notify: false` was set on republish or the recipient opted out. Sharing is supported on two surfaces: the MCP `relic_share` tool (publisher authority, publish token) and a Share action in the web viewer for any reader holding the link and key (reader authority, key-derived proof and verified sign-in).

**Why the notify list is derived, not stored as a group.** There is no "team" or "subscriber group" entity. A relic's notify list is derived at send time: commenters are pulled from `listComments(relicId)`, shared addresses from `listShares(relicId)`, subtracting the normalized publisher owner address (`ownerEmail`) and addresses whose SHA-256 hash is in `listOptOuts(relicId)`. Storing a subscriber group would create group management, permissions, and team state, violating the non-goal against team features. A notify list grants no access and carries no permissions.

**The trigger and the claim.** Change notices fire on the first observation of the new version's object in storage: either upon upload completion (`POST /api/relics/{id}/complete`) or during lazy discovery at the first mint (`POST /api/relics/{id}/mint`). A compare-and-swap on `noticePending` in the store (`claimVersionNotice`) guarantees notices are announced at most once per version. Notices never fire for version 1 (initial publish), never when republish carried `notify: false`, and never for expired, tombstoned, or download-cap-exhausted relics. A crash during sending drops remaining notices rather than risking duplicate sends to recipients.

**The rate limits and their reasons:**
- `shareMaxPerCall: 20`: 20 addresses per share call represents the recipient set of a single conversation or working group.
- `shareMaxPerRelic: 50`: 50 total shares per relic sits comfortably above the 40-person list that the download cap and egress budget were priced for in `service.md` §2.3.
- `shareRateLimit: {limit: 30, windowSeconds: 3600}`: 30 shares per IP per hour matches `commentRateLimit` for abuse posture.
- `unsubscribeRateLimit: {limit: 60, windowSeconds: 3600}`: 60 unsubscribes per IP per hour accommodates provider one-click prefetch and automated header checks without blocking human clicks.
- `readerShareRateLimit: {limit: 10, windowSeconds: 3600}`: 10 reader shares per session per hour bounds sharing from the web viewer to prevent automated spam loops.
- `changeNoticeRateLimit: {limit: 300, windowSeconds: 3600}`: Resend is paid (upgraded by Jason before server deployment). This global fuse permits batch delivery while bounding spend against runaway notice storms.
- `notificationRateLimit: {limit: 5, windowSeconds: 86400}`: Reused across comment alerts, reply notifications, and change notices per (relic, address) pair.

**The stop link and rejected alternatives.** Every change notice carries an unauthenticated stop link (`/api/relics/{id}/unsubscribe?addr={64 hex}&token={base64url}`) with an HMAC-SHA256 token signed by `store.unsubscribeKey()`. Following the link allows the recipient to opt out of future change emails for this relic. Two alternatives were rejected:
1. *Sign-in to unsubscribe:* Requiring a recipient who never signed up to complete a magic-link sign-in just to stop emails is hostile and forces further interaction with the service.
2. *Global unsubscribe:* A global opt-out across all relics would mean opting out of one relic cancels notices from unrelated publishers across independent documents, which requires either an account preference system or uncoordinated cross-relic suppression.
Stopping mail works even when the egress kill switch is engaged (`503 service_paused`). The unsubscribe key is generated once and stored permanently in the key vault, and must never be deleted.

**RFC 8058 one-click unsubscribe.** Outbound change notice emails include `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, enabling mail user agents to offer native unsubscribe buttons without visiting the web page.

**The share email is composed on the sharer's machine.** Relic never sends the share email itself. The share email is composed on the publisher's machine (via client tools) or in the web viewer, and sent from the sharer's own email client (`shareMailtoUrl`). This ensures the full relic URL with the decryption key fragment never touches the server. The server only learns the recipient addresses so it can notify them on future republishes.

**Web share authority and key proof.** Authorised by Jason Waldrip on 2026-10-14. A reader holding the link and key can share from the viewer. The reader share endpoint `POST /api/relics/{id}/share` requires two gates:
1. *Key-derived proof:* HKDF-SHA256, zero-length salt, info `relic/share-proof/v1`, 32 bytes (`deriveShareProof`). The publisher registers `share_verifier = sha256Hex(proof)` (64 lowercase hex chars) on publish or republish. The reader presents `share_proof` (base64url unpadded). The server verifies `timingSafeEqual(sha256Hex(proof), row.shareVerifier)`. If the relic predates sharing, it refuses with `409 share_unavailable`. If the proof is invalid, it refuses with `403 invalid_share_proof`.
2. *Verified sign-in:* The reader must present an active `relic_session` cookie (reusing the session from comments). Missing session refuses with `401 sign_in_required`.
The sharer's address is not stored on the `ShareRow` (only `sharedBy: 'publisher' | 'reader'`). Attribution is not kept beyond the in-memory rate limiter. The change notice reason reflects the source: "the person who published this relic shared it with you" for publisher shares, or "someone with this relic's link shared it with you" for reader shares.


**Atomic share capacity reservation.** The 50-per-relic cap is enforced atomically via compare-and-swap on the relic row (`sharesCount`), counting only actual new inserts against `shareMaxPerRelic`. Concurrent share requests cannot exceed 50 total shares. Unneeded reservations (from duplicate inserts or failed writes) are released.

**Immediate opt-out re-check.** Fan-out re-checks the recipient's opt-out state immediately before each individual send via a single-key store read (`isOptedOut`). Once a stop POST answers 200, no later send to that address on that relic can begin.

**Idempotent delete sweep resumption.** Operator deletion of an already-tombstoned relic idempotently resumes every sweep (ciphertext, covers, comments, author index, shares, opt-outs) to completion and returns the counts of removed items. Late share or opt-out writes racing deletion are re-checked against the tombstone and purged so they cannot survive deletion.

**Failure log privacy.** Notice and comment-notification failure logs never record recipient email addresses in the clear. An address hash or opaque identifier is logged instead, and mail provider error text is sanitized to redact recipient addresses.
**Residuals:**
- The transactional mail quota is shared between sign-in magic links and change notices.
- Unsubscribe stops emails per relic only, not globally across the service.
- There is no "unshare" operation: once an address is registered for a relic, only an opt-out from the recipient or relic deletion stops notices.
- Comment reply notifications have no stop link because comments are individual conversations between verified participants.
- Rate limits are in-memory and per Cloud Run instance (up to 4 instances), so limits apply per instance.
- A server crash during delivery drops remaining notices rather than re-sending, avoiding duplicate emails.

## 2026-10-15: Comment notifications to all participants, shared rate limits, and a unified stop link

Authorised by Jason Waldrip on 2026-10-15.

**The expansion.** When a new comment is posted on a relic, Relic emails everyone involved in it. This builds on the list change notices use: every verified commenter (`listComments`), every shared address (`listShares`), and the relic's registered owner address (`row.ownerEmail`), minus the comment's author (case-insensitive), minus anyone with a stop record for that relic (`isOptedOut`). A publisher comment (author `'publisher'`, posted using the publish token) emails everyone except the owner address.

**Attribution and privacy in comment notices.** The email names the commenter (their verified email address, or "The publisher" for comments posted with the publish token). Because the server holds only ciphertext and never holds the decryption key, the email cannot quote the comment body and contains no decryption key fragment. It links to the unfragmented relic URL (`${serviceOrigin}/${relicId}`). Everyone on the list, including third-party shared addresses registered without prior verification, sees the commenter's verified email address.

**Wording per recipient role.**
- The relic's owner keeps owner wording: "commented on your relic" (or "left a comment on <title>"), with "Open the link you hold for this relic to read and answer the comment."
- An answered commenter (whose comment id was targeted by `addresses` on the new comment) keeps reply wording: "answered your comment on <title>", with "Open the link you hold for this relic to read the reply."
- Everyone else following the relic gets "commented on <title>" with a reason line explaining why they are receiving the email: "you commented on this relic", "the person who published this relic shared it with you", "someone with this relic's link shared it with you", or "you are its owner".

**Burst limiter and spend fuse.** Comment notices and change notices share the same rate limits:
- Per-recipient limiter: at most one email per recipient per relic per 10 minutes on the same limiter key change notices and replies use (`notify ${relicId} ${address}`). Later comments in the window are dropped, and the email tells the reader to open the thread to read new comments. A comment arriving right after a change notice is collapsed by the same limiter.
- Global fuse: comment notices count against the existing all-relics fuse `config.changeNoticeRateLimit` (key `change-notice`). The name is preserved; it bounds total outbound notification spend across both change notices and comment notifications.

**One stop link covers every email about that relic.** Every email (comment notification, reply notification, owner alert, and change notice) carries an unauthenticated stop link (`/api/relics/{id}/unsubscribe?addr={hash}&token={sig}`) and RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. Following the stop link stops all emails about that relic for that address. This supersedes the 2026-10-14 residual that reply notifications had no stop link. The stop page copy now states that it stops all emails about that relic, not only change emails.

**Lifecycle guards and exclusions.**
- Tombstoned relics send nothing.
- Expired relics send nothing.
- Download-cap-exhausted relics (`mintsUsed >= config.downloadCap`) send nothing.
- Comment edits and comment resolutions send nothing.

**Batch delivery with per-email headers.** When the mailer supports batch sending (`sendBatch`), notifications go out in batches of up to 100 via Resend's batch endpoint (`POST /emails/batch`), with each email carrying its own recipient, subject, HTML, text, and `List-Unsubscribe` headers. Opt-outs are re-checked immediately before each batch chunk or individual send so a stop that answered 200 is never followed by an email.

**One shared fan-out implementation.** A single shared helper (`fanOutNotifications`) in the server implementation handles both version announcements (`announceVersion`) and comment notifications (`dispatchCommentNotifications`), guaranteeing consistent rate limiting, opt-out enforcement, lifecycle guards, and failure log scrubbing.

**Residuals:**
- Unsubscribe stops emails per relic only, not globally across all relics.
- Comment edits and resolutions produce no emails.
- If a server crashes mid-delivery, remaining unsent emails in the batch are dropped rather than retried to prevent duplicate deliveries.

## 2026-10-20: OpenTimelineIO native playback, directory bundle exception, and the ten-value taxonomy

Authorised by Jason Waldrip on 2026-10-20.

**The reversal.** Relic originally barred first-party rendering of archives or directories (`frame.md` §Non-goals: "No first-party rendering of archives or arbitrary binaries. Download-only in the first release", `publish.md` §1.2: "A directory is refused", and `format.md` §3.1: "entry count at exactly 1"). That restriction is reversed for standard OpenTimelineIO bundles: Relic provides native in-browser timeline playback and structural inspection for OpenTimelineIO timelines (`RendererClass: otio`, `CLASS_BEHAVIOUR.otio: 'plays'`, `RenderRoute: otio`). A publisher supplying a standards-compliant `.otiod` directory bundle has it packaged automatically by `relic-mcp` into a deterministic standard `.otioz` archive (`content.otio` with DEFLATE, `version.txt` set to `1.0.0` with DEFLATE, and referenced media under `media/` STORED). Existing `.otioz` archives are published directly without recompression, and raw `.otio` files receive a structural inspector without remote media fetching.

**What stays true.**
1. *Arbitrary directories remain strictly refused:* Only a directory with the `.otiod` extension conforming to the OpenTimelineIO bundle specification is accepted for automated packaging. Any other directory refuses with `source_is_directory` before any network activity or encryption.
2. *General archives remain download-only:* ZIP, TAR, GZ, and arbitrary archive formats continue to take class `archive` and download to the recipient's device (`CLASS_BEHAVIOUR.archive: 'downloads'`).
3. *Single-entry container invariant:* Packaging `.otiod` into `.otioz` occurs before container encryption. The ciphertext container envelope continues to hold exactly one entry (the `.otioz` bundle), maintaining container version 1 invariants without a format bump.
4. *Strict local bundle containment:* Relative media references resolve strictly against the bundle root. Absolute paths, parent traversals (`..`), symlinks, device files, FIFOs, sockets, and remote network schemes (HTTP, HTTPS, FTP) are rejected.
5. *100 MiB safety ceiling:* The 100 MiB limit applies both to archive bytes and aggregate expanded bytes. Bounded decompression counts emitted bytes during inflation and rejects decompression bombs or corrupt CRCs.
6. *Original source identity preserved:* Logical source identity for `.otiod` remains the directory's Git-relative path or realpath rather than the transient `.otioz` package name, ensuring source lookup and republish detection work transparently across sessions.

**Native confined-open exception, 2026-10-21.** The earlier client-distribution
rule, that the npm client contains readable JavaScript only, is reversed for
one operation: automatic `.otiod` packaging. Jason Waldrip authorized a small,
source-included, ABI-stable Node-API helper with four prebuilt targets: macOS
arm64 and x64 with a 15.0 binary deployment floor, plus Linux glibc 2.28+
arm64 and x64. It pins the selected bundle root and opens descendants using
kernel confinement, so a pathname replacement cannot redirect a media read
outside that root. The helper is audited from source in the tarball. It is never
downloaded, built with Python, or compiled on an installed machine. Linux
requires `openat2`; macOS requires `O_RESOLVE_BENEATH` and `O_NOFOLLOW_ANY`.
On either platform, before it reads a bundle, the helper verifies on the
running kernel that beneath-root resolution refuses parent and absolute escapes
from a held directory and that the no-symlink flag is accepted. Symlink refusal,
held-descriptor behavior, and replacement behavior are verified by the CI probe
on the listed versions. The 15.0 deployment floor permits the binary to load;
each kernel still proves the primitive for itself. An unsupported platform,
architecture, libc, or primitive refuses `.otiod` packaging. It never falls
back to JavaScript path checks. Ordinary single-file publishing remains plain
Node 18 or newer.

**The ten-value taxonomy and telemetry boundary.**
The coarse renderer class expands from nine to ten values: `markdown`, `code`, `html`, `jsx`, `image`, `pdf`, `media`, `archive`, `binary`, `otio`.
`CLASS_BEHAVIOUR.otio` is `'plays'`, generating card copy: `"An OpenTimelineIO timeline. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it."`
`RENDERABLE_CLASSES` remains unchanged as `{markdown, code, html, jsx, image, pdf}`: it represents historical telemetry vocabulary bounding the document and markup success metric, and `otio` sits outside it alongside `media`.

**The generic cover exception.**
By default, `relic-mcp` generates an unencrypted 1200x630 cover image for renderable documents and media. For `otio` relics, unencrypted first-screen media rendering is skipped by default. Unfurl previews display a generic card carrying the publisher-declared title and format label. This exception protects sensitive timeline media frames, cuts, and track metadata from leaking into unencrypted link preview caches without the decryption key.

**Codec, effect, and browser boundaries.**
Browser playback operates under browser-managed SDR decoding with canvas composition and additive audio. There is no universal effect execution engine, plugin runner, transcode service, or remote asset resolver. Codec decoding is verified via actual element loading rather than speculative `canPlayType`. Unsupported effects, unrecognized schemas, and missing media trigger explicit diagnostic states (`unsupported-effect`, `unsupported-codec`, `unsupported-schema`, `missing-media`) and provide a deliberate "Preview base media without unsupported effects" control. Incomplete playback is never disguised as complete fidelity.

**Encrypted timeline feedback anchoring.**
Reviewers can anchor point comments or half-open range comments to specific tracks or the entire composition. A new anchor kind (`kind: 'otio'`, `v: 1`) carries rational time coordinates (`{value, rate}`), timeline ID, track ID, optional item ID, document SHA-256, and human snapshot labels. Anchor payloads fit within the 1,536-byte budget before encryption and the 8,192 base64url character ciphertext cap. Comment bodies and anchors remain encrypted under the relic's derived comment key. Historical comments resolve against the original revision's decrypted document, and conservative current-revision projections (`same`, `mapped`, `partial`, `changed`, `ambiguous`, `missing`) are reported separately to publisher agents without rewriting original anchors.

**Residuals:**
- Browser playback is limited to browser-supported SDR video and audio formats; professional codecs (ProRes, DNxHD) or RAW formats require pre-transcoded web-compatible proxy media inside the bundle.
- Nonlinear retiming and complex transitions without web-native equivalents fall back to base media preview or diagnostic placeholders.
- A raw `.otio` file lacking bundled media provides structural track inspection and download, not media playback.

## 2026-10-24: Copy link shows the link and the key phrase

**Copy link opens a panel instead of copying straight away.** Jason Waldrip asked for the 12-word key phrase to be visible beside the copied key, and chose a panel on Copy link that shows the link and the phrase, each with its own Copy button, so a reader can send the link without the key and say the phrase separately. The full-link copy stays, Copy without the key is added, and the Share email is unchanged. The phrase is computed in the browser when the panel opens, from the key already in memory, and exists only in the open panel: nothing stores it, logs it, or sends it.

**The key-entry field is part of a path now, so the spec stops banning it.** `viewer.md` §6.4 banned any key-entry field on the viewing origin, and one shipped anyway on the missing-key and could-not-be-opened screens. Sending the link without the key works only because the recipient types the phrase there, and Jason confirmed amending the ban to the field as it ships.

**One name for the phrase.** The field called it a recovery phrase while relic-mcp calls it the key phrase. It is the key phrase everywhere now.

**Collapsed taskbar actions keep their names.** Below 34rem the action labels were hidden with `display: none`, which removed the accessible name of every action without an `aria-label` or `title`: Copy link, Download and Report. The labels are now visually hidden, so the row looks the same and each control still has a name.
## 2026-10-24: Decisions are a deliberate stamp, bound to a passkey and a version

Authorised by Jason Waldrip on 2026-10-24: "I think we need to add decisions to the relik system ... Comments mean no approval, and a stamp/button of approval means an approval."

The passkey binding was requested by backlot and accepted 2026-10-24.

**The problem.** Backlot (Jason's video production harness) requires explicit human approval before committing paid production runs. Comments are discussion, feedback, and notes; they cannot mean approval, and inferring approval from keywords (such as "looks good" or "GREENLIGHT") or an absence of comments is unsafe. Approval must be a deliberate act in the viewer, distinct from commenting.

**The decision record.**
`{ id, relicId, version, verdict: 'approve' | 'reject', author, createdAt, versionDigest, credentialId }`.
- `verdict`: `'approve' | 'reject'`.
- `author`: the normalized verified reader email address (`normalizeEmail(session.email)`).
- `version`: the integer version number viewed (1 through `row.version`). Decisions apply strictly to the specific version rendered. Republishing increments the version counter; the new version starts with zero decisions, and earlier decisions remain attached to their respective versions.
- `versionDigest`: the lowercase hex SHA-256 of that version's stored ciphertext container object. This binds the decision to exact content bytes without decrypting server-side.
- `append-only`: decisions are never edited or deleted. Each author's latest record on a version is their current decision. When an operator deletes a relic, its decisions are swept with it (`decisions_deleted`).

**A factor beyond the mailbox: passkey binding.**
Agents operating on the approver's machine can read mailboxes. Relying solely on magic-link email verification would allow an agent to approve work autonomously. To ensure that an approval represents a human act, recording a decision requires confirmation by a WebAuthn passkey registered to the reader's verified email address, with user verification (UV) required.
- The service stores the passkey public key (ES256 or RS256), credential id, signature counter, and timestamps under `m/passkey/{sha256Hex(normalizedEmail)}.json`.
- Trust on first use (TOFU): the first passkey registered for a verified address is trusted on first use.
- Adding subsequent passkeys requires an assertion from an existing registered passkey (`assertedBy`).
- The service never receives or stores a private key.

**Cryptographic content binding via version digest.**
To ensure approval applies to exact content, the server computes the SHA-256 of the stored ciphertext object upon upload completion (`complete`) or lazily at first stat or mint. The viewer hashes the downloaded ciphertext container bytes and verifies `options.version_digest == view.versionDigest`. A mismatch refuses recording with `409 decision_digest_mismatch`. Both `relic_publish` and `relic_republish` return `version_digest` matching what decisions on that version carry.

**MCP read tool and zero-write invariant.**
No MCP tool can record a decision. Decisions are recorded only by human readers in the web viewer. A new MCP tool `relic_read_decisions` allows backlot to inspect decisions. It requires local publish state to derive the HKDF share proof, calls `POST /api/relics/{id}/decisions/list`, and spends zero download opens.

**Residuals:**
- First use is trusted (TOFU): the approver should register their passkey once in the viewer before downstream automation depends on decisions.
- Relics published before relic-mcp 0.11.0 lack a registered `shareVerifier` and return `409 decision_unavailable` until republished once.

## 2026-10-24: Comments open at their target on every class, and classes that play in the browser carry no comparison notice

**The composer is attached to its target, everywhere.** Jason Waldrip asked that comments popover the interface when he leaves them, chose a composer anchored at the selection that stays as the posted comment with the Comments sidebar left closed, and set the scope to every class: OpenTimelineIO timelines, media timelines, and every document class, pins and regions included. Before this, only a text selection and a timeline gesture reached the stage composer; a pin, a region, a framed point or box and a PDF page box opened the sidebar composer, and a post from the stage composer closed it and, for a text target, moved focus to the sidebar's field. This reverses 2ed14a3a (2026-10-22), which clamped the OTIO composer into the largest clear band of the video preview and scrolled the stage up to show it, so a comment on a lower track was written over the preview, away from the track it was about. It also reverses the rule in `viewer.md` §6.6 that selecting text or activating a pin target opens the sidebar. Documents place the panel above its target and timelines below, each flipping when its side does not fit; the panel never covers its target, follows it through inner scrolling and frame scrolling, and posting replaces it with the comment's card on its new mark. `docs/spec/viewer.md` §6.6 records the behaviour.

**Pressing a mark opens its card and nothing else.** A pin press also opened the sidebar, a region press stopped at the region and opened no card, and a framed mark answered the page's request for its geometry with `relic:frame-mark-click`, the message a reader's press sends, which the page answers by pinning the card and opening the sidebar. The geometry answer is now its own message, `relic:frame-mark-rect`, and the frame keeps reporting a tracked mark's geometry as it scrolls.

**No unprompted comparison notice on classes that play or render in the browser.** Jason reported the version 2 banner on an OTIO relic as false. `comparisonAvailability` treated every route without a comparison mode as download-only, so OTIO, media and PDF relics at version 2 or later opened under "This file is download-only", and the earlier-version view repeated the claim. All three render in the browser. Nothing on their page offers a comparison, because the taskbar control already reads "Earlier versions" and opens one version on its own, so the current page now says nothing about comparison, and an earlier version opened on its own says why in that class's words. Download-only and over-ceiling relics keep their notice on the current page. An earlier version shown on its own no longer repeats the stage notice under its own reason. This revises `viewer.md` §6.1 item 13, which grouped media with archives and binaries.
## 2026-10-24: The key is checked against the first record, every relic shows its loading phases, and a truncated relic is refused

**Record 0 is the key check, in the browser only.** Jason Waldrip approved checking the key against the first record and cancelling the download when it fails, with no check on the server. The viewer streams the signed download and decrypts record 0 as soon as its 65,557 bytes arrive. A wrong key used to download the whole object, up to 105,298,736 bytes, before saying the relic could not be opened. Server-side checks were rejected. A verifier returned to readers needs a stored value that relics published before sharing lack, and it could not be trusted anyway. Sending the share proof on every open would hand the operator per-open data on who holds a working key. The one new observable, an open that stops after its first block, is disclosed on `/policy` at Jason's direction.

**A failure after record 0 says the file is damaged.** Jason chose that a later failure drops key entry and says the link is fine and the stored file was changed or damaged, with Try again and Report this relic.

**A truncated container is refused.** `openRelic` accepted an object cut at a record boundary. In a probe it returned 196,557 of 196,567 declared bytes, because nothing checked for the final record or the envelope's length. Every relic ever written satisfies the stricter rule, since there has only ever been one encoder.

**Every relic page shows the bar and a named phase from the first frame.** The shell carries a static plate, so the page is never blank before `viewer.js` runs. The viewer then shows Opening, Fetching with bytes against the mint's object length, Decrypting, and Rendering, as `viewer.md` §6.3 and §6.4 and `surface.md` §7 already specified. Try again now reruns the open with the key in memory instead of reloading a page whose key was stripped.

## 2026-10-25: Continuous native video decode, synchronous frame callback capture, and bounded seek cadence fallback for OpenTimelineIO

**Measured seek bottleneck during full-cut playback.**
Profiling full-cut playback (such as a 491.7 s 1080p30 timeline) under the existing midpoint-seek engine revealed that steady-state per-frame seeks formed the primary playback bottleneck. Seeking decoders on every frame generated roughly 257 to 400 seeks in a 15-second window (approximately 19 to 26 seeks per second), spending roughly 77 percent of playback time waiting on decoder seeks and dropping cadence.

**Native hardware decode instead of WASM or WebCodecs.**
While WASM software decoders and WebCodecs were considered, measurement established that the browser's native HTML5 video element decodes 1080p30 continuously at native display cadence with hardware acceleration already in place.
- WASM software decoding would burn substantial CPU and memory budgets decoding video frames in software inside the sandbox frame.
- WebCodecs would require custom demuxing, container parsing, and codec-specific bitstream feeding across varying container formats, increasing complexity and bundle size without delivering better decode throughput than the platform's hardware decoders.
- Decision line 844 is retained: browser playback operates under browser-managed SDR decoding with canvas composition and additive audio, without transcode services, WASM decoders, or WebCodecs pipelines.

**No format, CSP, or privacy change.**
Continuous native decoding introduces no changes to the Relic container format, the encryption envelope, or network posture.
- The sandbox boundary and CSP remain unchanged (`default-src 'none'`, no remote fetching, isolated origin). Decrypted media Blobs are decoded locally through object URLs.
- No new privacy disclosures are created, and no keys or decrypted bytes cross origins.

**Synchronous inside-callback capture and strict packet matching.**
Rather than painting playing video elements directly (which can tear, jitter, or advance between approval and painting), frames are captured synchronously into a fixed three-slot output-sized snapshot canvas ring inside `requestVideoFrameCallback`.
- Presented frames are matched to scanner packet starts with a strict tolerance Q = 2 µs (`2e-6` s).
- The compositor paints only approved snapshots whose tag matches the rational half-open required window index `req` for the transport time T. If any drawn leaf is not ready, the composite holds.

**Certified-span tail rule and eligibility fallback.**
Media Blobs whose scanner index stops short of the file end (such as `no-duration.webm`) maintain native playback across their certified span `[starts[0], ends[last])`.
- Decoder callbacks outside the span (running ahead into uncertified tail frames or lead-in) are ignored without poisoning the media path or causing resyncs.
- When the timeline reaches an uncertified sample, an eligibility discontinuity drops that drawn set to exact seek cadence with the existing `invalid-timing` diagnostic, without approving uncertified frames. Subsequent certified clips return to native playback upon the next discontinuity.

**Bounded set-change resync tradeoff.**
Every change to the set of drawn video occurrences (cuts, unhiding a track, soloing, or entering a dissolve) triggers one exact resync (pausing, running exact `renderAt`, and re-anchoring phase).
- For continuous playback within a clip or a long cut, zero steady video seeks occur.
- For rapid cuts or montages, frequent resyncs could hitch; this is bounded by a change-rate guard (more than 3 changes in 5 s falls back to seek cadence) and a storm guard (3 failure resyncs in 10 s falls back to seek cadence). Lookahead preroll remains an uncommitted future consideration if measured multi-clip cut performance requires it.
- Unmeasured claims are excluded: the architecture provides the bounded mechanism, subject to verified benchmark replay.

**Residuals:**
- Paused inspection, transport seeks, and scrubbing remain exact midpoint seeks into certified presentation windows.
- Any media path failing native admission criteria runs on today's exact midpoint seek cadence with existing diagnostic reporting.
