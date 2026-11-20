# Relic: the viewer

This document fixes how the viewer routes, renders, isolates, and what the recipient sees in every state. `docs/frame.md` and `docs/preconditions.md` are locked inputs. `docs/spec/format.md` owns the URL, the relic ID, and the container, and everything it settled is honored here rather than restated or reopened.

One framing runs through the whole document and decides most of the hard cases on its own:

> **The viewing origin never lets attacker bytes choose what markup gets built.** It may place them into text nodes, and it may run a renderer whose element and attribute set is fixed regardless of input. **Any path where attacker bytes select elements, attributes, or URLs runs on the usercontent origin.**

The middle clause is doing real work, and §3.3 is where it earns its keep: a syntax highlighter builds structure out of attacker bytes and stays on the viewing origin anyway, while Markdown can't.

## 1. The four key-disclosure paths

Each is a case where every component behaves correctly and an unspecified boundary lets the decryption key walk out. They're written as rules, and every subsection below closes exactly one of them.

1. **Attacker bytes become markup on the viewing origin**, and that markup reads `location.hash`. Closed by 1.1 through 1.5, by 1.9, and by §3.1 putting Markdown on the usercontent origin.
2. **A blob URL built from attacker bytes gets navigated to on the viewing origin**, inheriting it, so a document the viewer never authored runs there. Closed by 1.6.
3. **A redirect without a fragment hands the key to its target**, with no bug in any component. Closed by 1.7.
4. **The viewing origin writes the key or the ID down**, into a `Referer`, a console line, storage, or an error object. Closed by 1.8.

### 1.1 The renderer class never routes, and it never arrives

`format.md` §3.6 settled that the container carries no renderer class and that the class must never be sent to the viewer. So the viewer has no class to route on and must not ask for one.

The reasoning gets stated here because an earlier version of the recorded knowledge got it backwards and somebody will re-derive it. The class is a publisher assertion. If the viewer routes on it, a publisher declares `image` on an HTML payload and wins inline rendering on the origin holding the fragment, and that content reads `location.hash`. Fragment theft in one step.

**Publisher-attestation inside the ciphertext does not fix this.** Attestation defeats operator forgery. It does nothing about a publisher lying, and the publisher is the threat. A malicious publisher signs an honest-looking lie, and the AEAD tag proves only that the operator didn't alter it.

### 1.2 Routing comes from magic bytes, and a hint can only ever downgrade

Routing comes from magic-byte sniffing performed after decryption, in the browser, treated as a hint that can only reach a **less** privileged path.

Privilege order, least to most: **download-only, then the usercontent origin, then the viewing origin.** Within the usercontent level, HTML and JSX sit together at the top, because both execute, and in the class-level ordering the disagreement rule consumes, `jsx` ranks with `html` at the most-privileged end and loses every disagreement it takes part in, exactly as `html` does.

That ordering is the whole safety argument. A hint that can only move content down the order is a hint an attacker gains nothing by forging. Any rule below that honors a publisher assertion honors it only because the assertion moves content downward.

**The order ranks browser-side privilege, never harm.** Download-only sits at the bottom and still puts a file on the recipient's disk under a name and extension the attacker chose, outside the sandboxed frame, from a Relic-branded page. So the safety claim is scoped: **an attacker gains nothing in the browser by forging a hint downward.** What they gain outside it is bounded by 1.9's filename rules and 1.3's mismatch copy, not by this ordering. Nobody downstream reads "least privileged" as "harmless."

### 1.3 The disagreement rule

The declared type is the **filename and declared mimetype in the encrypted envelope header** (`format.md` §3.1), decrypted out of record 0 before a byte of content renders. There's no class, and the envelope header is the better input anyway: it sits inside the AEAD so it's tamper-evident against the operator, and it's finer-grained, so a declared `.png` against HTML magic bytes is a sharper disagreement than `image` against HTML would be.

The rule operates on privilege levels rather than on type names. Map each of the two types to the level it would reach, then:

1. **If the two levels differ, the content is download-only.** Not the lower of the two: download-only, every time. A disagreement proves one input is lying and the viewer can't tell which, so every level above download-only means trusting one of them and download-only is the only path that trusts neither. A file named `chart.png` that sniffs as HTML isn't an image and doesn't reach the usercontent origin either, because sending it there would be trusting the sniff over a declaration it just contradicted.
2. **If the two levels are the same, there's no privilege disagreement, and the sniffed type picks the renderer.** The sniff comes from the bytes and the declaration is a publisher assertion, so where they agree on privilege the byte-derived one wins. Concrete: a file declared `chart.md` that sniffs as HTML lands on the usercontent origin either way, so the level is settled and the HTML renderer runs. Nothing is forged upward by this, because no type pair reaches the viewing origin with a markup renderer at all (§3.1).
3. **Either way the taskbar tells the recipient the contents don't match the name.** Clause 2 renders and still says so.

Three clauses, and they close the entire polyglot class for the first release.

### 1.4 Text without magic bytes, which is half the wedge

Markdown, plain text, source code, CSV, and JSON have no magic numbers. The sniff returns nothing for `{markdown, code}`, the class can't be trusted, and this is the hardest question in the unit. The rule:

1. **A silent sniff means untyped bytes, and untyped bytes get exactly one privileged treatment: plain text.** The gate: the bytes decode as valid UTF-8; C0 and C1 control characters outside tab, line feed, and carriage return mean binary, so download-only; a leading byte-order mark is stripped. **The bidirectional formatting characters are neutralized rather than passed through**, so `U+202A` to `U+202E`, `U+2066` to `U+2069`, `U+200E`, and `U+200F` render as visible escapes, never as controls. A UTF-8 check alone passes every one of them, and they reorder what a reader sees without changing a byte. That's Trojan Source, CVE-2021-42574, whose authors describe the attack as using "control characters embedded in comments and strings to reorder source code characters in a way that changes its logic" ([Trojan Source](https://trojansource.codes/)). Relic renders source code as its wedge, so this is the exact corpus the attack was written against.
2. **Valid text renders as plain text on the viewing origin, built as DOM text nodes.** This is safe by construction rather than by sanitization. Nothing parses the bytes, so content that's secretly HTML displays as HTML source and does nothing. That's the correct outcome, not a degraded one.
3. **The declared mimetype and filename extension may select a renderer within a level, or request a downgrade, and nothing else.** A `.py` extension picks a highlighter grammar. That is an attacker-selected parser running on the viewing origin, and calling it a decoration would be wrong. It's permitted for two specific reasons: whichever grammar runs, the highlighter's output element and attribute set come from a fixed set the viewer controls (§3.3), and an unrecognized hint falls back to plain text rather than guessing. A `.md` extension requests the Markdown path, which runs on the **usercontent origin** (§3.1), and honoring it is safe precisely because it moves content to a *less* privileged origin. A publisher who lies about `.md` gets the usercontent origin, which is where HTML already goes, so the lie buys nothing. A publisher who lies the other way gets plain text, which is a downgrade and harmless.
4. **An unrecognized hint falls back to plain text.** Never best-effort, never a guess.

### 1.5 SVG is download-only in the first release

SVG's execution is context-dependent. It's inert under `Content-Disposition: attachment` and inside `<img src>`, and it fully executes on direct navigation ([digi.ninja](https://digi.ninja/blog/svg_xss.php), which tests direct view as vulnerable and both `<img>` and attachment as not). Inline SVG is part of the host document's own DOM by definition, so it executes there too.

**A spec that says "still images render inline" without carving out SVG ships the CVE.** SVG is download-only in the first release. Usercontent-origin rendering for it is available later and isn't in scope now.

SVG has no magic number and sniffs as XML or text, so the sniff can't route it and the declaration has to. 1.4 rule 3 already permits that: **a declared `image/svg+xml` mimetype or a `.svg` extension is an explicit downgrade trigger to download-only**, legal because download-only is the least privileged path, so forging it gains nothing and declaring it honestly gets the safe outcome. Untyped bytes that happen to be SVG, carrying neither, are untyped bytes: plain text on the viewing origin under 1.4 rule 2, where nothing parses them and they display as XML source. No input reaches two different answers.

### 1.6 Blob URLs inherit the creating origin

The File API describes the inheritance in a section it labels informative: "The origin of a blob URL is always the same as that of the environment that created the URL, as long as the URL hasn't been revoked yet." The normative statement the rule below actually rests on is in the next section, on access restrictions: blob URL fetches are limited to environments whose storage key matches, and "Blob URL navigations are not subject to this restriction" ([File API](https://w3c.github.io/FileAPI/)). Navigation is exactly the dangerous path, and it's the one carrying the fewest guardrails.

- **Never navigate to, and never open in a new tab, a blob URL built from untrusted plaintext on the viewing origin.**
- **Download blobs are typed `application/octet-stream`** regardless of what the container declared, and they're triggered through an `a[download]` attribute. The container's declared mimetype never reaches `Blob`'s type argument.
- **Images render only via `<img src=blob:>`**, where parsing is inert.

### 1.7 Redirects, and the rule splits on where the redirect lands

RFC 9110 §10.2.2 makes fragment inheritance mandatory browser behavior: "If the Location value provided in a 3xx (Redirection) response does not have a fragment component, a user agent MUST process the redirection as if the value inherits the fragment component of the URI reference used to generate the target URI." The spec's own cross-origin example redirects `example.org/index.html#larry` to `example.net/index.html` and lands on `example.net/index.html#larry`, "preserving the original fragment identifier." §17.11 names the hazard: this "might have the effect of disclosing one site's fragment to another site," and a site using personal information in fragments "ought to ensure that redirects to other sites include a (possibly empty) fragment component in order to block that inheritance" ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)).

**Read the remedy's scope, because a blanket version of it destroys the key.** The RFC scopes the fix to redirects *to other sites* and documents inheritance as the desirable behavior everywhere else. The server never receives the fragment, so where the redirect stays inside Relic's own service, "explicit, possibly empty" can only mean empty, and an empty fragment is a deleted key: a recipient hitting `/{id}/#key` gets redirected to `/{id}` carrying nothing and lands on §6.1's "link is missing its key" screen holding a link that was never broken.

**So the split is on where the redirect lands, not on whether the origin changes**, and the two halves point opposite ways.

**Leaving the service, an explicit, possibly empty, fragment in `Location` is mandatory.** One fragment-less redirect to the usercontent origin hands it the key, with no bug in any component. Where it bites:

- **service origin to usercontent origin**, the dangerous one, and the whole reason the two-domain split exists
- **any CDN or load-balancer redirect the application doesn't author** that lands off the service domain, which is the one nobody audits, because it lives in infrastructure config rather than in code review

**Staying inside the service, the redirect deliberately omits the fragment so inheritance carries the key through.** This gets said out loud, because the blanket MUST reads as forbidding it and somebody implementing from a one-line summary will kill working links. It covers legacy or renamed paths, trailing-slash normalization, apex to `www` and back, and HTTP to HTTPS. The last two change origin without leaving Relic, and applying the other half to them would kill the key on every link typed or pasted without a `www` or a scheme. **The test is the destination's trust boundary, not its origin tuple:** the service origin and its host and scheme variants are all Relic, the usercontent origin is not, and that's the line the fragment must not cross.

**The preferred form is that no inside-the-service redirect exists on the relic path at all.** `format.md` §1.1 already issues none for ID case, and HSTS preload on both registrable domains moves the HTTP-to-HTTPS upgrade into the user agent, so no request and no redirect happens.

Redirects and rewrites performed by third parties, including link shorteners and enterprise link rewriters, belong to `spec-service-surface`.

### 1.8 Neither the ID nor the key gets written down

**The viewing origin sends `Referrer-Policy: no-referrer`.** The relic ID appears in that origin's own `Referer` on any outbound request (`format.md` §0), and this closes it. **That's an ID control and not a key control**, and the distinction is worth a sentence, because "the referrer policy handles it" is how somebody later concludes the fragment is covered and stops looking. Fragments are never sent in a `Referer` to begin with. `Referrer-Policy` was never protecting the key and can't.

**The key is closed by a separate rule: no code path writes the fragment or the key to the console, to storage, or into an error object.** Error objects are the leak nobody plans: a thrown error carrying the URL gets logged, serialized, or displayed, and the honest reason the viewing origin has no error reporting (a locked precondition) is that an error reporter is a same-origin script that reads whatever it's handed.

### 1.9 The filename is untrusted display text

`format.md` §3.1 states it flatly: the filename "is **untrusted display text**. It reaches the DOM as a label and gets used as a lookup key, the same defect class as archive entry names," carried as a bounded UTF-8 byte string that asserts nothing about itself. It's the one attacker-controlled stream that's guaranteed to reach user-visible text on the origin holding the fragment, because §1.3's mandated copy requires displaying it. Six rules:

1. **It enters the taskbar as a DOM text node, never as markup.** No markup interpolation, no attribute injection, no exceptions. This is 1.4 rule 2 applied to a field arriving outside the content stream, which is why it's easy to forget.
2. **It passes 1.4 rule 1's gate**, with the bidirectional characters stripped here rather than escaped. A filename has no legitimate use for them, and a right-to-left override in a label is how `report.exe` displays as `report.txt`.
3. **The taskbar bounds what it displays** and never lets a long name push the abuse-report link, the copy-link control, or the sandboxing notice off screen. Length is attacker-chosen too, and those controls are the ones a recipient needs most when something is wrong.
4. **The `a[download]` value comes from the filename, sanitized for filesystem use.** Path separators and traversal segments are removed, so the name can't escape the download directory or impersonate a system path. The extension stays attacker-chosen and the blob stays `application/octet-stream` (§1.6), so the browser won't execute it. The recipient might, which is what §1.3's mismatch copy warns about and why §1.2 scopes its claim to browser-side privilege.
5. **An empty filename is legal and means the viewer names the download from the relic ID** (`format.md` §3.1). Not a guess, and not an error.
6. **Reading the extension for §1.3 and §1.4 is a parse on the final dot only**, with no filesystem semantics. It's a lookup key derived from a hostile string, so it gets the narrowest reading available.

## 2. The usercontent origin's shape

**Decision: a per-relic subdomain, not one fixed content origin.**

**The cost a fixed origin appears to carry isn't real, and the argument has to rest on the one that is.** The obvious objection is that relic A's rendered content would share an origin with relic B's, so one malicious relic could reach another's rendered document. Under the two-layer boundary §4 mandates, every rendered document already sits in its own opaque origin, so two relics on a single hostname are already mutually cross-origin. The frame's sandbox flags answer that objection, not the hostname.

**What per-relic subdomains actually buy is process-level isolation**, and the page this section already leans on names the boundary precisely: "While not all web browsers implement process isolation for sandbox documents... If SpectreJS and renderer compromise attacks are outside of your threat model, then using CSP sandbox is likely a sufficient solution" ([web.dev](https://web.dev/articles/securely-hosting-user-data)). They aren't outside Relic's threat model: a relic's entire plaintext sits in a neighbouring frame for as long as the tab is open, which is exactly what a same-process reader wants. The same page prescribes the shape: "by adding `exampleusercontent.com` to the PSL, you can ensure that `foo.exampleusercontent.com` and `bar.exampleusercontent.com` are cross-site and thus fully isolated from each other." The second reason is the durable one. A per-relic hostname is defense in depth against Relic's own future bugs, so a misconfigured sandbox flag costs one relic instead of every relic the recipient has open.

**The cost is real and it's the Immich pattern.** Per-relic subdomains mean unbounded auto-generated hostnames under a wildcard, which is exactly what `preconditions.md` §2 names as the trigger. The answer is that Relic's generated hostnames have nothing on them. **The usercontent origin serves exactly one static file, the shim, which never touches ciphertext and whose own code makes no requests.** Untrusted bytes exist only inside a document the shim builds in memory, and that document has no URL a crawler can reach. A crawler that resolves every label Relic ever generates finds the same few hundred bytes of relay code at every one.

Four consequences:

- **The label is a one-way function of the relic ID, and it isn't the ID.** Using the raw ID would put a live bearer token for the ciphertext into every DNS query along the resolution path, broadly visible and replayable against the service. A truncated hash of a 122-bit-floor ID isn't invertible, so a passive DNS observer learns that some relic was opened and can't turn the label back into a fetchable ID. **The residual runs the other direction and gets stated.** The derivation is deterministic and public, so anyone already holding the URL can compute the label and confirm from a resolver log that a specific device opened that specific relic. Real capability, granted only to somebody who was already given the link, and the price of a stable origin.
- **Derivation is deterministic rather than random per render**, keeping the origin stable across repeat opens and the shim cacheable. Two recipients of one relic therefore share a shim origin. **What makes that safe is not that they're looking at the same content.** It's that both of their rendered documents sit in opaque origins regardless of hostname, so a shared shim origin gives neither of them anything.
- **The parent computes `targetOrigin` per render** from the derived label, and that survives §4's boundary intact: the shim sits on a real, nameable origin precisely so an exact `targetOrigin` exists. **The shim's expected parent origin stays a hardcodable constant**, because there's only ever one viewing origin.
- **The label must be a single DNS level**, since a wildcard certificate covers one label and not two.

**PSL registration of the usercontent parent is required and routes to `shape`** (§7). Repeating the preconditions' honest limit without softening it: treat PSL as origin isolation with a possible listing-scope benefit, never as a guaranteed firewall. No documentation confirms Google won't list at a PSL-registered parent anyway, and the Immich outcome was broader than the mechanism required.

## 3. Rendering each class

### 3.1 Markdown renders on the usercontent origin

Markdown is a partial HTML class, because Markdown permits raw inline HTML. Rendering it on the viewing origin puts sanitizer output next to the fragment.

The two candidates were stripping raw HTML entirely and rendering on the viewing origin, or rendering on the usercontent origin exactly like HTML. **The choice is forced rather than balanced.** A locked precondition says origin isolation is the first layer and sanitization "is never the only one." Markdown must generate markup structure from attacker bytes no matter how raw HTML is handled, and its `href` and `src` values come straight from the source, so rendering it on the viewing origin makes sanitization the only layer standing between an attacker and the trusted origin. That's the thing the precondition forbids.

Note what stripping raw HTML does not buy. It narrows the surface to the Markdown parser's own escaping of text and URL attributes, and mXSS is precisely the class that defeats that narrowing.

**Wherever sanitization runs, it's pinned past every advisory known at build time, and it's never the only layer.** The evidence for treating that as a standing rule rather than a nicety is CVE-2026-41238, which affects DOMPurify "3.0.1 through 3.3.3 (latest)" with 3.4.0 patched, CVSS 6.9. One qualification the shorthand loses, and it changes how much weight the citation carries: the advisory's prerequisite is that an "Attacker must have a prototype pollution primitive in the same execution context." So the sanitizer isn't independently bypassable here. What is true is that no special configuration is needed, and a prototype pollution gadget anywhere else in the same context converts a standard `sanitize(userInput)` call into a full bypass ([GHSA-v9jr-rg53-9pgp](https://github.com/advisories/GHSA-v9jr-rg53-9pgp)). Which sanitizer gets used is `shape`'s call, along with the rest of the stack. That it's never load-bearing on its own is this document's.

**The source toggle lives across the origin boundary.** `frame.md` locks the first release as rendering Markdown with a source toggle, and the two sides land on different origins. Raw Markdown source is plain text, so by §1.4 rule 2 the **source view renders on the viewing origin** as DOM text nodes, optionally highlighted under §3.3's rules. The **rendered view is on the usercontent origin.** So the toggle switches which origin is showing, not which mode a single frame is in. The taskbar owns the control, because the taskbar is the only surface that spans both. The parent already holds the plaintext, so the source view costs no round trip. **Switching away from rendered tears the shim frame down, and switching back re-posts the payload with a fresh render nonce**, so a relic can't keep a live frame running behind a source view the recipient thinks is the whole page.

**This changes the usercontent origin's role from "HTML only" to "all rich text."** The `postMessage` surface carries a routing type covering both, and the split of the viewer across domains is: the viewing origin owns fetch, decrypt, JSX transpiling (§3.5), the taskbar, the download blob, plain text, highlighted code, the Markdown source view, and raster images; the usercontent origin owns everything that becomes markup and everything that executes.

### 3.2 Link and image targets are attacker-controlled

Markdown link and image targets are attacker input: `javascript:`, `data:`, and remote images. A remote image is both an exfiltration channel and a beacon revealing that a specific relic was opened.

Under the locked strict CSP they fail to load. **The viewer explains why.** Silent broken-image icons read as a corrupt file, and the recipient blames the publisher while the publisher blames the product. The shim reports blocked external resources in its ack (§4), and the taskbar states that this relic asked for external resources and Relic blocked them.

### 3.3 Code and plain text, two traps

**Highlighter input.** Syntax highlighters take a language hint usually derived from the attacker-controlled extension, and some build HTML by string concatenation. **Build highlighted output as DOM text nodes**, creating elements programmatically and assigning `textContent`, so attacker bytes never reach a markup parser. **On an unrecognized hint, or a highlighter that can't work that way, the fallback is plain text.** There is no sanitize-then-parse fallback on the viewing origin. §3.1 invoked a locked precondition to forbid exactly that, and an escape hatch here would reopen it one section later on the same origin.

**Why code stays on the viewing origin while Markdown doesn't, stated precisely**, because the easy version of this distinction is wrong. A highlighter does build structure out of attacker bytes: it emits `<span>` elements whose boundaries are chosen by the input. The difference is in what the input can choose. **A highlighter's element set and attribute set come from a fixed grammar the viewer controls**, so whatever the bytes say, the output is spans carrying class names from the viewer's own theme, and nothing else. **Markdown's `href`, `src`, and raw-HTML passthrough are attacker-controlled by design.** That's the line, and it's the second clause of the framing at the top of this document.

**Pathological input.** A code file can be many megabytes on one line, which hangs the highlighter and freezes the tab. **Cap the highlighted region and render the remainder as plain text behind a stated cutoff**, with the cutoff visible to the recipient rather than silent. The cap's value goes to `shape` (§7).

### 3.4 Where security headers actually matter

The object fetch runs client-to-GCS on a signed URL, so the app server can't set headers on it, and what GCS serves is ciphertext, indistinguishable from random and unsniffable into anything executable. `nosniff` on the bucket guards almost nothing.

**The controls that matter are the viewing origin's own responses, the shim's own response, and the blob URLs the viewer creates.** Stating it here stops a later station spending its effort on bucket headers that guard nothing while skipping the viewer-side ones that guard everything.

### 3.5 JSX renders on the usercontent origin, transpiled on the service origin

`jsx` is the eighth renderer class, reached by the `.jsx` and `.tsx` extensions. It renders on the usercontent origin for the same reason HTML does: it executes. Honoring the extension is a downgrade under §1.2's rule, because untyped bytes otherwise get plain text on the viewing origin, which is the most privileged path there is, and the usercontent origin sits below it. A publisher who lies about `.jsx` gets their bytes executed in an opaque origin that cannot read the fragment, which is the outcome the ordering exists to produce.

**Transpile on the service origin, execute in the frame, and the split is the whole safety claim.** The viewer bundles a transpiler into its own service-origin code and transforms the decrypted JSX string into plain JavaScript as a text operation: bytes in, bytes out, nothing evaluated. The service origin, the one that holds the fragment until §2.5 strips it, never executes untrusted code, and that is what keeps the frame's first locked constraint intact now that a rendering path executes by design. The transpiled code is posted to the usercontent frame as `{ type: 'relic:render-jsx', code: string }`, a sibling of `relic:render`, and the one-render-only guard applies to it exactly as it does to `relic:render`: anything that can post to that frame could otherwise swap the content after the recipient has decided to trust what they are looking at.

**React is bundled into the frame's inlined bundle, and nothing is fetched from a CDN.** An earlier revision of this section had the frame importing React from a permissive CDN, because the render frame is an opaque origin, its module fetches are CORS requests carrying `Origin: null`, and Relic's own origins do not answer those while a permissive CDN does. Closing egress removed that middle ground: a policy that permits no remote source permits no CDN either, and in an opaque origin `'self'` matches nothing, so the frame cannot fetch even its own assets. Same-origin assets are the one thing this origin structurally cannot reach, which forces the only remaining answer: React is inlined into the `sandbox.html` response at build time and reaches transpiled component code as the global `globalThis.React`. The transpiler emits classic-runtime `React.createElement(...)` calls, which resolve against that global, so the mounted module needs no import statement at all.

**The frame has no network reach, and the property is measured rather than argued.** The response that builds the frame carries a policy permitting no remote source of any kind, and under it `fetch`, `<img>`, `sendBeacon`, `WebSocket`, and `EventSource` all produced zero arrivals at a collector server, so whoever authored a JSX or HTML relic has no channel to the recipient through the rendered content. Two probe results are stated with their caveats, because each can be read as proving more than it does. `sendBeacon` returned `true` while delivering nothing, so its return value is not evidence. `window.open` was blocked in the probe, but no user gesture was present, so the policy is not what stopped it; popups are removed by dropping the `allow-popups` flag from the sandbox attribute, which leaves `allow-scripts` and nothing else. A form with `target=_blank` submitted and never arrived, blocked by `form-action 'none'`. What remains true of the boundary itself: the frame is opaque, holds no credentials, cannot read the fragment on the viewing origin, and cannot reach anything of Relic's. The cost is named rather than absorbed: a page or component that references a CDN stylesheet, a CDN script, an external font, or a remote image renders without it, and publishers must inline what their page needs (§6.3).

## 4. The sandbox boundary

**Direction is forced, not chosen.** The main origin fetches, decrypts, and posts plaintext to a static shim whose own code never touches ciphertext and never makes a request. The alternative shape, where the usercontent origin fetches and the parent posts it the key, is what somebody reaches for to avoid moving large payloads across a boundary, and it requires the key to cross. That must never happen.

**The boundary is two layers, because an opaque origin has no address.** The obvious shape is one frame carrying `Content-Security-Policy: sandbox` on its own response. It doesn't work, and the reason gets stated because somebody will reach for it. MDN is exact about what that header does to the framed document: "A sandboxed resource is otherwise treated as being from an opaque origin, which ensures that it will always fail same-origin policy checks... The Origin of sandboxed resources without the `allow-same-origin` keyword is `null`" ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)). An opaque origin matches no `targetOrigin` a parent can write, and `"null"` isn't a URL `postMessage` can parse, so the only value that reaches such a frame is `'*'`. That's the one value the payload message must never use. **Sandbox the shim's own response and you've forced the exact leak the rule below exists to prevent.**

So the boundary is split, which is what the pattern §2 cites actually describes: the product frames a shim at `$RANDOM_VALUE.exampleusercontent.com/shim`, posts the untrusted content in, and "the rendered content is transformed to a Blob and rendered inside a sandboxed iframe" ([web.dev](https://web.dev/articles/securely-hosting-user-data)).

- **Layer one, the shim.** A static file on the per-relic usercontent origin, served on a real origin with no `sandbox` on its own response, so the parent can name it with an exact `targetOrigin` and it can name the parent with one. It's first-party code Relic authors. It never touches ciphertext, never touches the key, and its own code makes no requests. The documents it renders make no requests either: the response policy permits no remote source (§3.5), so no bytes leave the recipient's browser as a relic's fetch, and the origin still serves one static file whose own code makes no requests. Its own response carries `default-src 'none'` with its single inline script admitted by hash, `frame-ancestors` limited to the viewing origin, and `X-Content-Type-Options: nosniff`.
- **Layer two, the render frame.** The shim builds the untrusted document and renders it in a child iframe carrying the `sandbox` attribute. That's where the opaque origin belongs and where it costs nothing, because nothing needs to address the render frame by origin. **Never both `allow-scripts` and `allow-same-origin`**, which is locked in the preconditions. The attribute is `allow-scripts` and nothing else, and outbound requests are blocked by the frame document's response policy rather than permitted: `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <service origin>; webrtc 'block'`. No fetch directive names any host. `blob:` stays in `script-src` for the JSX mount's blob module, which is local and involves no network; `data:` and `blob:` in the image and media directives carry the viewer's own decrypted bytes; `webrtc 'block'` is named because peer connections are a network channel no fetch directive reaches. The frame's script is inlined into the response rather than fetched, because an opaque origin cannot fetch from anywhere, not even Relic (§3.5). What the opaque origin still contributes is the rest of the confinement: no credentials, no storage, no same-origin relationship with anything, and no path to the viewing origin's fragment. Nobody reads this layer as confinement of the recipient's network; it is confinement from the recipient's network.

**The attribute is sufficient at layer two, and only because the never-both rule holds.** The usual reason to prefer a header is that a framed document can otherwise strip the `sandbox` attribute off its own iframe element and reload, dropping every restriction. Doing that means reaching the embedder's DOM, which means `allow-same-origin`. Without it the render frame is opaque and can't touch the shim's document at all. The two rules are load-bearing together and neither is optional. **That's derived from the mechanism, not quoted**: no page makes the header-versus-attribute comparison, and citing one for it would be a citation that doesn't say what it's cited for.

**What crosses.** Parent to shim: the decrypted bytes, the routing type, and a render nonce. Never the key, never the fragment, and not the relic ID. The shim needs none of it. The per-relic subdomain label already gives the usercontent document a stable per-relic pseudonym, which is exactly why §2 makes that label a one-way function: the shim can correlate its own renders and can't derive the ID.

Shim to parent: a `ready` handshake, a rendered-or-failed ack that names blocked external resources, and optionally a requested height.

**The handshake.** The shim posts a data-free `ready` to `parent`. The parent replies with the payload and an **exact** `targetOrigin`, computed per render from the derived label. The shim pins `event.origin` from that reply and ignores everything else. Because §2 makes the shim's expected parent origin a hardcodable constant, **the `ready` uses that exact origin too**, and `'*'` appears nowhere in the design. MDN is direct about why: "Always specify an exact target origin, not `*`, when you use `postMessage` to dispatch data to other windows. A malicious site can change the location of the window without your knowledge, and therefore it can intercept the data sent using `postMessage`," and on the receiving side, "always verify the sender's identity" using `origin` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)).

**The payload message must never use `'*'`.** A `postMessage` with target `'*'` carrying a decrypted relic hands the whole plaintext to whatever occupies that frame, which is worse than leaking one relic's key. `'*'` is tolerable only on a message carrying no data at all, and the two-layer shape means no message needs it.

**The render frame gets a free discriminator out of this.** It's opaque, so anything it posts to the shim arrives with `event.origin` of `"null"`, which the shim's pinned parent origin can never equal. So a message from the render frame is never mistakable for a message from the parent, and the shim treats every one of them as attacker input.

**Untrusted numbers.** A requested-height channel is a message type an attacker also gets to send. The parent treats the value as untrusted input: it rejects anything non-finite, negative, or non-numeric, clamps to a range bounded by the viewport minus the taskbar, and rate-limits the message so a relic can't drive a resize loop. A relic can't make itself taller than the viewport.

**Transfer, don't copy.** Plaintext is posted as a transferable `ArrayBuffer`. Structured-cloning doubles memory on exactly the large payloads the wedge exists to carry.

**The main origin materializes the download Blob**, so the download affordance never lives inside the untrusted frame.

**Letterboxing is a product consequence, and it's stated here before somebody finds it in review.** The taskbar and the content sit on different origins by construction, so the content iframe is never full-viewport, and a relic authored to fill the screen renders letterboxed.

**Present the sandbox as deliberate.** An HTML relic can't navigate the top-level window, can't open popups, can't reach the decryption key, and can't reach the network: every remote source is blocked, so a page that references a CDN stylesheet, a CDN script, an external font, or a remote image renders without it. Left unexplained, the recipient concludes the relic is corrupt and the publisher concludes the product is broken, and a page stripped of its external assets makes both conclusions more likely rather than less. The taskbar says the content is sandboxed and says what that blocks, and the list it gives is the true one: top-level navigation, popups, everything same-origin, and the network itself. Publishers who need external assets must inline them.

## 5. Platform ceilings and degradation

**Secure context first.** `crypto.subtle` is restricted to secure contexts ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle)), so the viewer checks `window.isSecureContext` and the presence of `crypto.subtle` before anything else and shows a specific named error. This isn't only a development concern: a recipient behind a TLS-terminating proxy that serves plain HTTP hits it in production, and a generic failure there is unresolvable by the person seeing it.

**Refuse before allocating.** A single `subtle.decrypt` over a whole-file buffer blocks the main thread and freezes the tab. Plaintext size is computable from encrypted size without decrypting (`format.md` §3.3), so the viewer compares against a platform ceiling before touching memory. **The tab must never die.** A refusal is a screen; a dead tab is a bug report with nothing in it.

**Carry `format.md` §3.3's qualifier, because it changes what the viewer may display.** The derivation is exact only when records carry minimal padding. Under discretionary padding it's an upper bound. An upper bound is the safe direction for a refuse-before-allocating check, and it's the wrong direction for anything user-visible, so **the viewer never shows a plaintext byte count before decryption starts.** Whether the container pads is `shape`'s, routed by `format.md`. The fetching phase in §6.4 is unaffected: it counts encrypted bytes against the encrypted object length, and both of those are exact.

**Three tiers.** Streaming decrypt to disk through a ServiceWorker intercepting a synthetic request; in-memory decrypt then Blob download, capped at a memory ceiling; refuse with a named reason and a concrete alternative.

**The ServiceWorker is the only part of the viewer that outlives the tab, so it gets its own rules.** It's origin-wide, persistent, and first-party by construction, which makes it the most attractive place in the system to quietly add something.

- **First-party and part of the viewer's own bundle.** The locked precondition on third-party scripts, analytics, and error reporting applies in full, including the bundled-SDK trap a `script-src 'self'` check can't see.
- **Scoped to the path the streaming tier uses**, never registered at the origin root. It has no business seeing requests it doesn't serve.
- **It never sees a fragment.** Fragments aren't part of a request, so the URL on the `FetchEvent` it intercepts carries no key even though the request came from the origin that holds one. That's a property of the mechanism rather than a control, worth stating so nobody adds a "scrub the key" step implying it was ever there.
- **Plaintext crosses it and the key never does.** The parent decrypts and pipes plaintext records through the synthetic response, so the worker handles content transiently and holds no secret.
- **No telemetry of any kind.** Not counters, not timings, not error beacons.

**Which platform gets which tier is a runtime question, and a hardcoded browser list is forbidden.** The viewer detects ServiceWorker registration and fetch interception at runtime and picks the streaming tier on that result. Two claims commonly attached to this decision don't survive checking, and that's the reason for the ban rather than a footnote to it. First, iOS Safari and mobile do have the service-worker fetch support the streaming path needs: `FetchEvent` and `FetchEvent.respondWith` have been supported since Safari 11.1, with iOS mirroring it ([MDN compat data](https://github.com/mdn/browser-compat-data)). hat.sh caps Safari and mobile browsers at 1 GB and states its reason as "lack of support with server-worker fetch api" ([hat.sh](https://github.com/sh-dv/hat.sh)), so that 1 GB is an empirical project decision whose rationale no longer matches compatibility data. Second, the 500 to 800 MB band traces to one forum thread reporting an `OperationError` at 800 MB and, separately, a 2 GB `ArrayBuffer` constraint ([DFINITY forum](https://forum.dfinity.org/t/using-aes-gcm-with-large-files-800mb/21929)). Practitioner report, not a vendor limit, and Apple publishes no per-tab ceiling. A hardcoded list encodes exactly the kind of claim that just failed twice.

**One Safari-specific gap is real and it's narrower than the folklore.** `ReadableStream` async iteration lands in Safari 27, which hasn't shipped, so **no shipping Safari supports `for await` over a `ReadableStream` today** and the portable path is `getReader()` loops. That constraint has a known expiry, and the `getReader()` loop stays correct after it lapses.

**Degraded render.** The four renderable classes may render a truncated prefix behind an explicit banner stating that it's truncated and why. Download-only classes refuse instead, because a truncated binary is not a partial view of anything.

## 6. Every screen the recipient sees

### 6.1 The five states, of which two collapse

1. **Missing or malformed fragment.** Split by navigation type, which is available from `PerformanceNavigationTiming` (Safari 15+, iOS 15.1+). On `reload` or a `back_forward` that re-executes, the page says the key was stripped from this URL after it opened and points back to the original link. On a fresh `navigate`, it says the link is missing its key. Both are actionable; a single generic message isn't. **When no navigation entry is available, the viewer shows the fresh-`navigate` copy.** The default is chosen, not arbitrary: telling a first-time visitor the key was stripped after their page opened describes a session they never had, while telling a reloading recipient the link is missing its key is less specific and still points at the right remedy. The fallback is the copy that's actionable either way.
2. **Unknown container version.** Refused before minting, before consuming a download cap, and before any egress, because the version marker is in the fragment (`format.md` §2.2, §3.7). A second refusal happens after the fetch when the envelope version disagrees with the marker, or when `idlen != 0`.
3. **The server refused to mint**, with the stated reason surfaced verbatim rather than flattened into "something went wrong."
4. **Decrypt failed.** A wrong key and a corrupted download both throw `OperationError` and are genuinely indistinguishable at the API level, so they collapse into one screen. **A decrypt failure does not mean "wrong key"** (`format.md` §3.5), and the copy names both plausible causes, offers a retry because the retry is itself the discriminator, and never blames the recipient.
5. **Success**, covered by §6.3 and §6.4.

**Separating corruption from a wrong key is possible with a facility that already exists.** Cloud Storage states that "All Cloud Storage objects have a CRC32C hash" ([GCS metadata](https://docs.cloud.google.com/storage/docs/metadata)). Rightly rejected as a blocklist hash, because 32 bits is trivial to collide on purpose, it's exactly right as a transport-integrity check. If the mint response carries object length and CRC32C, a mismatch is transport corruption with a retry that will plausibly fix it, and a match followed by `OperationError` makes a wrong key the clean residual. **This is an integrity check and not an authenticity one.** It doesn't prove the object wasn't replaced, since anyone who can write the object gets a recomputed CRC32C for free. `spec-service-surface` owns whether those fields exist; §8 states the need.

**The check applies differently per tier, because tier 1 by definition never holds the whole object.**

- **Tier 2 verifies before decrypting.** It holds the complete object, so the check runs first and a mismatch means nothing gets decrypted.
- **Tier 1 computes CRC32C incrementally as bytes arrive and compares at the end**, which is after the file is on disk. That's the honest consequence of streaming and reordering can't fix it. **On a mismatch, the viewer says the download completed and failed its integrity check, names the file it wrote, and offers a retry.** It doesn't call the file corrupt: every record already passed its own AEAD tag on the way through, so a final CRC mismatch with clean tags points at a stale checksum or an object that changed under a resumed fetch. It also can't delete what it wrote, because the file went to disk through a download the browser owns.
- **Tier 3 refuses before fetching**, so the check never arises.

### 6.2 The unfurl card

The fragment never reaches a server, so no unfurler can describe the content, and **a blank card on an unfamiliar domain is the visual shape of a phishing link.**

`/{id}` serves deliberate Open Graph and Twitter Card metadata, **identical for every relic**, describing what Relic is without pretending to describe the content. Open Graph's required properties are `og:title`, `og:type`, `og:image`, and `og:url`, with `og:description` and `og:site_name` optional ([Open Graph](https://ogp.me/)). All of them carry constant values, since a per-relic value would either be a fabrication or a leak.

**Serving that metadata must not mint**, or every unfurl burns a download cap and counts as an open.

**There's no conflict with the noindex precondition, and this gets said out loud so nobody removes the tags in that rule's name.** Open Graph tags are consumed by unfurlers rather than indexers, and Slack documents that it ignores `robots.txt` outright: "We do not currently honor `robots.txt` files. After implementing and experimenting with doing so, we received too many complaints from our users because a great portion of the Internet is inaccessible to crawlers" ([Slack](https://api.slack.com/robots)). A `robots.txt` disallow was never going to stop the unfurl, so deleting the metadata would produce the blank phishing-shaped card and buy nothing.

### 6.3 Before decryption completes

Everything except the content renders immediately: the branded taskbar, the service name, one line of plain-language explanation of what Relic is and what's about to happen, the abuse-report link, and the privacy-statement link (`spec-service-surface` owns that statement's contents). The recipient is deciding whether to trust an unfamiliar domain during exactly this window, and an empty page spends it badly.

**The honesty constraint applies hardest here.** "Nobody can read this but you" is an overclaim on the one surface where it does the most damage. The decryption JavaScript is served by the same operator the claim is made against, so it's a claim about operator intent rather than a property a recipient can verify. The copy says what's true: the key stays in the link and this browser, and the recipient's browser never sends it to Relic's servers. For content that renders on the usercontent origin, the viewer carries a compact marker in the header chrome stating that the page runs the author's code, linked to `/policy` where the full isolation guarantees and limits are stated.

### 6.4 Progress, input, and errors

**Three named phases, never one indeterminate spinner.** Fetching is network-bound and retryable, and the total is known from the mint response's object length, so it shows bytes against a total. Decrypting is CPU-bound and isn't retryable, and the framing gives record boundaries, so it shows real progress rather than a guess. Rendering is the third. A single spinner turns a slow 400 MB fetch and a hung decrypt into the same screen, and they need different responses from the recipient.

**No key-entry field on the viewing origin.** Not configurable, not conditional. It's a purpose-built phishing surface aimed at the system's only secret, sitting on the domain recipients are told to trust, and the recipient has no way to tell Relic's field from a copy of it. If a later station finds a case that needs one, that's drift and it routes back here rather than getting settled quietly.

**Every error screen is a relic page**, carrying the abuse-report and policy links. An error state is where a recipient most wants to report something, and it's the state most likely to be reached by somebody who was sent something they didn't want.

**The copy-link affordance.** `format.md` §2.5 strips the fragment via `history.replaceState`, which is honored here, and both costs land on this document. The recipient can no longer re-share from the address bar, so **the viewer carries an explicit copy-link control, present from load, backed by the in-memory key** and reconstructing the full URL on demand. The reloaded page is dead and says so per §6.1 rather than showing a decrypt error. Present stripping as shrinking the window rather than closing it: the URL with its fragment existed before the replace, so browser history sync, an extension with host permissions reading `window.location.href` at load, and the application the link was clicked from all still saw it.

**Repeat opens reuse a still-valid signed URL rather than minting per page load**, keyed by relic ID, with validity judged against the expiry the mint response carries. A restored tab, a pull-to-refresh, and a back-forward navigation are each otherwise another mint and another counted open. A bfcache restore needs no handling, since the page resumes with its in-memory key intact.

**The PWA case is two cases, and only one is the root page.** A cold launch from the home screen loads the manifest's `start_url`, which holds no relic and no key, so it lands on the publish page (section 9). That page holds nothing either: it keeps no list of relics and no key, so the locked non-goals ruling out a dashboard and a "my relics" list still hold. **A warm relaunch that resumes an already-running instance doesn't navigate to `start_url` at all**, so the recipient lands back on the live relic with the key still in memory, which is the opposite of the root page and the more common case on mobile. Even the cold path is advisory: the manifest spec says the `start_url` member "is purely advisory, and a user agent MAY ignore it or provide the end-user the choice not to make use of it" ([W3C appmanifest](https://www.w3.org/TR/appmanifest/)). **So no key-hygiene rule rests on `start_url`.** The ones that hold are §1.8 and the `history.replaceState` strip, and neither depends on the manifest.

## 7. Routed to `shape`

Five items, and only these five.

1. **Platform memory ceilings, and whether they're hardcoded or feature-detected.** §5 requires feature detection for the streaming tier. What remains is the in-memory ceiling's value. State what each candidate number rests on: Apple publishes no per-tab ceiling, hat.sh's 1 GB is an empirical project decision whose stated rationale doesn't match current compatibility data, and the 500 to 800 MB band is one forum report.
2. **The hard size cap value.** This determines whether §5's tiering is required at all: a cap below the in-memory ceiling collapses three tiers into one.
3. **The truncated-prefix size**, which the viewer states in its own copy.
4. **The highlighted-region cap** from §3.3, also user-visible.
5. **PSL registration for the usercontent parent.** **Lead time: there is none published, and that's the finding rather than a gap in the research.** The list's own guidelines state "There are NO SERVICE LEVEL AGREEMENTS ON TIME nor any expectation of processing speed or urgency," and on reaching production, "Unfortunately, there is no way to expedite," because propagation rides each browser and OS vendor's release train ([PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)). Unbounded and unexpeditable makes it the first thing started in the domain workstream, ahead of work that looks more urgent.

## 8. What this document needs from `spec-service-surface`

Stated as needs. That sibling defines the mint response.

1. **The signed URL.**
2. **Its absolute expiry**, so repeat opens can tell whether reuse is valid instead of minting again (§6.4).
3. **Object length in bytes**, for the refuse-before-allocating check (§5) and for a real total on the fetching phase (§6.4).
4. **The object's CRC32C checksum**, which is what separates transport corruption from a wrong key (§6.1).
5. **A machine-readable refusal reason on a refused mint**, distinguishing enough cases that state 3 shows a real reason rather than a generic failure. The set of reasons is that sibling's to define, not this one's. `format.md` §1.2 already permits distinguishing an expired relic from one that never existed, so at least that pair is available to it. Expiry is no longer universal: the expired-relic state is reachable only when the publisher set a lifetime, and a relic without one never produces it, so the refusal-reason surface covers both a stated lifetime and its absence.

## 9. The root path publishes

`/` serves the same shell with `data-mode="publish"`, and the viewer bundle draws a drop zone instead of opening a relic. A visitor drops or chooses one file; the page encrypts it and uploads it with the three-message contract in `publish.md` section 3.

- **The key is drawn in the page and appears only in the link the page returns.** No request carries it or the filename. The page does not store the link; it is on screen until the visitor leaves or publishes another file.
- **The publish token is discarded.** The grant returns it once, and keeping it would be a per-relic credential in the browser, a "my relics" list under another name. A relic published here cannot be republished from here.
- **The cap comes from the challenge, and the file is not read until it passes.** An over-cap file is refused with the server's own number.
- **The upload is a cross-origin `PUT` from the service origin to the bucket.** The bucket's CORS rule must list `PUT`. The page sets no request headers: the grant signs `Content-Length`, which the browser derives from the body.
- **The policy is one click from the drop zone and four terms sit under it**, so what a publisher agrees to is readable before anything is dropped. The disclosure names publishing from the page and extends the JavaScript caveat to it.
- **The publishing client is reported as `relik-web`**, so the metric's client breakdown can tell this door from `relic-mcp`.
