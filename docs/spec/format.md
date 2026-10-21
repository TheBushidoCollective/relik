# Relic: the URL, the relic ID, and the ciphertext container

This document fixes the format. It owns the irreversible decisions in `specify`, because a container format can't be changed after content is encrypted and three cross-document couplings resolve through the ID.

`docs/frame.md` and `docs/preconditions.md` are locked inputs. Nothing here reopens them. Where a decision belongs to `shape`, it's routed in section 4 with what `shape` must pick and what becomes specifiable once it does. Everything else is a rule.

## 0. The URL

The shape is locked: `https://<relic-domain>/{id}#{secret}`. The ID sits in the path, the secret sits in the fragment. This document doesn't reopen it. It records one consequence and one obligation.

**The consequence.** Delete-by-ID depends on the ID being in the path. An abuse reporter hands over a URL with the fragment already stripped, so an ID that lived in the fragment would arrive stripped too and the takedown primitive would have nothing to act on.

**The obligation.** The ID appears in the viewing origin's own `Referer` on any outbound request, so that origin sends `Referrer-Policy: no-referrer`. That's `spec-viewer`'s to implement, named here because this section creates the exposure and restated in section 5 so it travels with the unit that owes it.

## 1. The relic ID

### 1.1 Alphabet

**Crockford base32, lowercase canonical, case-insensitive on lookup** ([Crockford](https://www.crockford.com/base32.html)).

The trade is bits per character against transcription cost. base64url is 6 bits per character and case-sensitive in a path, so it's the shortest and the least survivable when a human retypes it ([RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648.html)). Hex is 4 bits per character, longer than base32 and no more readable. Crockford is 5 bits per character, roughly 20 percent longer than base64url at equal entropy, and it drops `i`, `l`, `o`, and `u`. Somebody reading an ID off a screenshot or over the phone can't turn it into a *different valid* ID by guessing case or confusing `1` with `l`. The ID is the part humans retype, in workflows the product actually has: abuse reports, support tickets, takedown requests, log lines, all arriving with the fragment already stripped. The key stays base64url because a 43-character key isn't worth optimizing for hand transcription, and a key short enough to retype reliably is too short.

**Lookup normalizes before comparison. It case-folds and applies Crockford's decode aliases, `i` and `l` to `1` and `o` to `0`. Hyphens are rejected.** Crockford also permits hyphens as readability separators and says they "are ignored during decoding". Implementing that half faithfully would give every ID unbounded valid spellings and break the fixed-length guard 1.5 leans on. So Relic takes the alias folding and declines the hyphen rule: a hyphen in the path segment is a 404 rather than a character to strip. Relic never emits one, so a publisher pays nothing for it.

**There's no canonicalizing redirect, and the reason is arithmetic.** Lookup already folds case and aliases, so a redirect to the canonical spelling would spend a round trip reaching an answer the first request already had. The redirect rule that does bite is cross-origin, it belongs to `spec-service-surface`, and it's in section 5.

**The ID is opaque and encodes nothing:** no timestamp, no shard, no class. The MCP spec puts it directly: "Handles that encode internal structure invite parsing or guessing; opaque identifiers do not" ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). A timestamp prefix would hand publish time to anyone holding the URL and shrink the search space at the same time.

### 1.2 Entropy

Two locked statements point opposite ways and both are true. The preconditions: "This works precisely because the relic ID is not secret. Only the key is." The MCP spec, on handles for unauthenticated servers: one "is necessarily a bearer token, it should be generated with sufficient entropy (e.g., a UUIDv4) and given a bounded lifetime." They reconcile because the ID is a bearer token for fetching *ciphertext*, and ciphertext without the key is inert.

**The ID carries full bearer-token entropy. The rule fixed here is that it is unguessable, not merely unique.** The cost is URL length and nothing else.

The alternative worth naming is a short ID with all security in the fragment. It costs enumeration: a stranger walking the ID space collects the operator-conceded metadata set (coarse class, approximate size, open timing) on relics nobody shared with them, and burns per-object download caps and egress doing it. That re-prices a locked decision without routing it, because the frame conceded a coarse content category to *the operator* rather than to the world, and making it world-readable by enumeration is drift dressed as a URL-length preference. Restoring unguessability by adding a separate fetch token to the fragment buys the same property for two secrets, two things that can be truncated, and a failure mode where one lost character yields a 404 the recipient can't tell apart from a decrypt error.

`shape` picks the bit count. The floor is the reference point the MCP spec itself names, a UUIDv4, whose randomness is 122 bits. **At Crockford's 5 bits per character, a 122-bit floor is 25 characters, and that number is what 1.5's primary guard rests on.**

**`spec-service-surface` inherits this directly.** Because the ID is unguessable, an expired relic and a relic that never existed **may be distinguished**. Only somebody already holding a valid ID can ask the question, and holding the ID means they were given the link, so the distinction discloses nothing new and turns "the link is dead" into an answerable support question. Under a short-ID design it would have been an enumeration oracle and would have had to be suppressed. It isn't.

### 1.3 Who generates it

**The publishing client generates the ID before it requests a grant.**

That eliminates the worst failure in the system, a relic that exists, is fetchable, and has no owner who can name it. Owning the ID and the key before anything leaves the machine lets the client reconstruct the full URL from state it already holds, so an upload that succeeds while its confirmation is lost still yields a link the publisher can share and can hand to the operator for deletion.

If `shape` overrides this and puts generation on the server, **the ID must come back in the grant, never in a post-upload confirmation**, for the same reason. A grant response arrives before the bytes move. A confirmation arrives after, and it's the message that gets lost.

Client generation makes the client's randomness load-bearing. The ID and the key are drawn independently from the platform CSPRNG, never `Math.random`, and **neither derives from the other**. Deriving the key from the ID would put the key in the operator's hands, since the operator has every ID.

The server validates a client-supplied ID at mint against the alphabet, the fixed length, and the reserved table, and refuses anything failing. The grant binds to the exact object path, so a client can't upload to an ID the grant doesn't cover.

### 1.4 Collisions

**The server refuses to mint a grant for an ID that already exists. It never overwrites.** An overwrite silently replaces someone else's relic and its owner has no way to notice. Republish does not relax this, because a republish writes a fresh versioned path (3.12) under its own existence refusal rather than replacing the live object, so no path is ever written twice, at any version.

Under full bearer-token entropy a collision is astronomical bad luck or a broken RNG, and both should fail loudly. The client draws a new ID and retries. Repeated collisions from one source are worth logging, because that's what a fixed seed looks like from outside. Refusal is an existence oracle in principle, harmless here only because the ID space isn't walkable.

### 1.5 Reserved path segments

IDs sit at the root, so root-level service paths are reserved words. **The reserved set is `abuse`, `policy`, `robots.txt`, `favicon.ico`, `sitemap.xml`, `manifest.webmanifest`, `sw.js`, `assets`, `api`, `health`, `.well-known`, `sandbox.html`, and `install`.**

**No reserved word is ever issuable as an ID.** Two independent guards enforce that, and they are not equally strong.

1. **Length is the primary guard, and it's exact.** IDs are exactly N characters and 1.2 floors N at 25. The longest reserved word is `manifest.webmanifest` at 20, so length excludes every word in the table by at least five characters under the weakest entropy this document permits. No `shape` decision weakens it, because the floor is the floor.
2. **The explicit table is the backstop, because the alphabet is a weaker guard than it looks.** `assets` is directly spellable in Crockford. Three more aren't directly spellable and still fold to valid Crockford strings under the normalization 1.1 requires of lookup: `policy` to `p011cy`, `api` to `ap1`, `health` to `hea1th`. Unspellability describes what the encoder emits, and lookup deliberately accepts a wider language than the encoder emits. Only `abuse` (a `u`, which Crockford excludes with no alias) and the dotted words fall to the character set alone. So the server holds the table and refuses any ID in it, independent of length and alphabet.

Two operating rules follow. The table is append-only, and **appending a word after launch requires comparing its normalized form against the normalized form of every issued ID.** Length makes that comparison vacuous for any word shorter than N, which is every word in the table today. It stops being vacuous the moment somebody reserves a word of exactly N characters, and an exact-string check would miss the one collision that matters, an issued ID that folds onto the new word rather than matching it byte for byte. If a live relic holds a path the table later claims, the reserved route wins and the relic disappears with no error anywhere. And `/abuse` is a go/no-go obligation in the preconditions, so an issued ID shadowing it is launch-blocking.

## 2. The fragment

### 2.1 Structured, minimally

The fragment is **`#<version-marker><key>`**: a fixed-width version marker followed immediately by the encoded key, no separator.

A bare key leaves no room for a version marker, so there's no migration path off the first framing choice. Content is encrypted once and never re-encrypted, so a framing choice with no migration path is permanent. A separator adds a character that can be mangled and buys nothing against a fixed-width marker.

The fragment carries **exactly two things, the marker and the key**. A third field takes a version bump.

### 2.2 The version marker lives in the fragment

The fork is fragment versus the container's plaintext header, where RFC 8188 offers a `keyid` field ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.html)).

**It goes in the fragment.** The viewer then knows the format before fetching anything, so an unknown version is refused without minting a signed URL, without consuming a per-object download cap, and without a byte of egress. The marker is visible only to people who already hold the key, so it adds nothing to the operator's metadata set, whereas `keyid` is plaintext and operator-visible by construction. The cost is two characters of URL and telling every channel the link crosses which Relic format version was used, which says nothing about the content.

One version number governs the whole envelope, fragment and container together. There's no second, independent container version. It versions the *format*, which is a different axis from the relic's own version: republish-to-same-URL now exists and a relic's version counts its publishes (3.12), while this marker counts revisions of the container. A relic at version 7 and a relic at version 1 can both carry format version 1, and bumping the format version changes nothing about relic versioning.

### 2.3 Key encoding and the terminal-character rule

The key is **unpadded base64url** ([RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648.html)).

**The rule: the terminal character set the chosen encoding can produce must not intersect GitHub Flavored Markdown's trailing-punctuation set.** The GFM autolink extension states it plainly: "Trailing punctuation (specifically, `?`, `!`, `.`, `,`, `:`, `*`, `_`, and `~`) will not be considered part of the autolink" ([GFM spec](https://github.github.com/gfm/)). `_` is in the base64url alphabet. A relic URL pasted into any GFM surface whose key ends in `_` arrives one character short, and the recipient gets a decrypt failure with nothing to diagnose it from.

Unpadded base64url of a fixed 16-byte or 32-byte key is immune by arithmetic. Neither length is a multiple of three, so the final character carries fewer than 6 significant bits: 4 bits for 32 bytes, giving an index that's a multiple of 4, and 2 bits for 16 bytes, giving a multiple of 16. Both exclude index 62 (`-`) and index 63 (`_`). **A 24-byte key breaks it**, because 24 *is* a multiple of three, the final character carries a full 6 bits, and `_` becomes reachable. **That rules out a 24-byte key, and with it AES-192, on encoding grounds alone.** The arithmetic stands on its own and needs no supporting claim about browser support, so 4.2 carries key length forward and cites this rule as the reason 192 bits isn't among the options.

Two structural consequences. The version marker is a **prefix**, never a suffix, and there's no trailing checksum, because either would put a different character class in the terminal position and reopen this. Padding is dropped: `=` adds no entropy and adds a class that non-GFM linkifiers do trim.

**The check is named `fragment-terminal-charset` and has two halves.** Statically, enumerate the characters the encoder can emit in the final position, derived from key length modulo three, and assert the intersection with GFM's trailing-punctuation set is empty. Dynamically, mint a batch of real relic URLs, run each through a GFM autolink renderer, and assert the extracted href is byte-identical to the input. The static half proves it for all keys. The dynamic half catches a renderer trimming something the spec doesn't mention.

### 2.4 Nothing else goes in the fragment

**Filename and mimetype do not live in the fragment.** It's the only placement keeping them from the operator without a decrypt round trip, and it's still the wrong trade. The fragment crosses every chat channel the link is pasted into, every link shortener a user tries, every abuse report form, and every enterprise link rewriter. Moving the filename out of the operator's view and into that set widens the audience instead of narrowing it, to a set the publisher can't enumerate. The benefit, a name in the taskbar a moment sooner, is worth nearly nothing when decrypting the first record is the very next thing that happens.

The authoritative filename and declared mimetype live in the encrypted envelope header and nowhere else (3.2).

### 2.5 The fragment is stripped from the address bar

**The viewer reads `location.hash` once into a local variable at load, then calls `history.replaceState` to replace the current entry's URL with the fragment removed** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState)).

Cheapest insurance in the product: a sanitizer bypass, a stray same-origin script, or a bundled first-party SDK finds nothing in `location.hash` to read. `spec-viewer` must honor it and must carry both visible costs:

- **The recipient can't re-share from the address bar**, so stripping obliges an explicit copy-link affordance backed by the in-memory key.
- **A reload loses the key.** The reloaded page is dead and must say so, pointing back to the original link rather than showing a decrypt error.

What it doesn't do: the URL with its fragment existed before the replace, so this retracts nothing that already read it. Browser history sync, an extension with host permissions reading `window.location.href` at load, and the application the link was clicked from all still saw it. This shrinks the window without closing it.

## 3. The ciphertext container

### 3.1 Two layers

**Layer 1, the transport framing.** RFC 8188 `aes128gcm` is presumptive: a plaintext header of `salt (16) | rs (4) | idlen (1) | keyid (idlen)`, then records of `rs` octets, each with its own 16-octet authentication tag and a padding delimiter, the last record using value 2 and all others value 1 ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.html)). Presumptive rather than fixed because the framing is `shape`'s (section 4), and the presumption because `frame.md`'s wedge-boundary section already establishes it as the off-the-shelf framing with working range decryption over GCS byte ranges ([wormhole-crypto](https://github.com/SocketDev/wormhole-crypto), [unzipit](https://github.com/greggman/unzipit)). That argument isn't re-run here. Any substitute inherits the same reversibility constraint.

**Layer 2, the Relic envelope, entirely inside the encrypted stream.** Record 0 is the envelope header: the version (mirroring the fragment marker), an entry count, and per entry a filename, a declared mimetype, and an offset and length into the content stream. Content bytes follow. Nothing else is in there.

Three rules on that structure:

- **The envelope header occupies record 0 alone and never spans records.** One record fetched, one decrypted, and the viewer holds the whole header. That's what makes the refuse-before-allocating check in 3.3 possible and range decryption useful. It also means `rs` must be at least the maximum envelope header size, which is what bounds the filename and mimetype field caps. `rs` is `shape`'s, so those caps follow from it.
- **Entry count is exactly 1 in version 1.** That's the multi-file room: a future manifest adds entries to a structure that already carries offsets, rather than needing a new container. It's the frame's reversibility argument applied to structure, and it costs a handful of bytes.
- **The parser is strict.** Unknown fields are refused rather than ignored. Extensions arrive with a version bump, which is what the fragment marker exists to make possible.

The filename is **untrusted display text**. It reaches the DOM as a label and gets used as a lookup key, the same defect class as archive entry names ([Zip Slip](https://security.snyk.io/research/zip-slip-vulnerability)). The container carries it as a bounded UTF-8 byte string and asserts nothing about it. An empty filename is legal and means the viewer names the download from the ID.

### 3.2 What's encrypted and what isn't

Four placements were available for filename, mimetype, and size: the encrypted header record, server-side metadata, the URL fragment, and GCS custom object metadata ([GCS metadata](https://docs.cloud.google.com/storage/docs/metadata)). The assignment:

| Field | Placement |
|---|---|
| Filename | Encrypted envelope header, only |
| Declared mimetype | Encrypted envelope header, only |
| Plaintext size | Nowhere. Derived (3.3) |
| Framing parameters (`salt`, `rs`) | RFC 8188 plaintext header. Operator-visible, benign |
| Version marker | Fragment |
| Renderer class | Server-side record, and viewing origin document `<head>` metadata, only (3.6) |
| Publisher-declared title | Server-side relic row, optional (3.2) |
| Cover image raster | Server-side storage `m/cover/{id}/{sha256}` and row reference, default on (3.2) |

**The envelope filename is content, not a category.** `Q3-layoffs-final.xlsx` is not a coarse class, and storing the envelope header or declared mimetype on the server would violate the frame. The authoritative filename and declared mimetype live strictly in the encrypted envelope header and nowhere else. What changed is an explicit, owner-authorized reversal for a separate, publisher-declared plaintext title (defaulting to the source filename) stored on the server-side relic row, joined on 2026-10-13 by a per-relic cover image raster (1200x630 pixels, rendered by default and declined with `cover: false`) stored server-side. That title and cover exist solely for link unfurls and the viewer document `<title>`, and their leakage is conceded by the publisher at publish time. The declared mimetype fails the same test and remains strictly encrypted inside the envelope header: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` is finer than a ten-value taxonomy by a wide margin and is never sent to the server.

**The envelope header remains uncompromised.** The original warning that putting the filename in the grant response or in object metadata is the most likely quiet frame violation in the build remains relevant: the encrypted envelope header inside container record 0 is never parsed by the server and never reflected in server metadata. The publish request body now permits the optional plaintext `title` parameter alongside the renderer class and client name, and on 2026-10-13 `POST /api/relics/{id}/cover` was added for the cover raster (1200x630 PNG or JPEG, up to 512 KB, rendered by default and declined with `cover: false`), with the assertion that neither the container nor custom object metadata carries anything content-descriptive beyond those declared values.
### 3.3 Plaintext size is derived, never declared

The framing exposes plaintext size as a function of encrypted length and `rs`, computed before any decryption, which is what `plaintextSize()` and `encryptedSize()` already do. Declaring it server-side would be redundant and leaky at once.

**The framing must expose it, and that's a requirement rather than a convenience**, because computing plaintext size from object length before allocating is what lets the viewer refuse an oversized payload instead of killing the tab on it.

One honest qualifier: the derivation is exact only when records carry minimal padding. Under discretionary padding it's an upper bound, which is still the safe direction for a refuse-before-allocating check and isn't enough to display an exact byte count before decryption. That's a live interaction with the bucket-padding question routed in section 4.

### 3.4 What RFC 8188 fixes, and what `keyid` is for

Salt and record size are necessarily operator-visible, which is benign: the salt is random and `rs` is a performance parameter.

**`keyid` is unused. `idlen` MUST be 0, and a container with `idlen != 0` MUST be refused after the fetch.** The refusal point is forced, because the header sits in the object's first bytes and nothing can be checked until they arrive. Same shape and same cost as 3.7's second refusal: the mint and the egress are already spent, and the viewer stops before decrypting anything.

It's a plaintext free-text field sitting next to ciphertext, and RFC 8188 says it "SHOULD be a UTF-8-encoded string," which is exactly the invitation somebody accepts when they need somewhere to put a filename. Every legitimate use is already placed: the version is in the fragment, and one key per relic means nothing needs identifying. The cost of the hard invariant is that using `keyid` later takes a version bump, which is the migration path 2.2 bought.

### 3.5 The header is not authenticated

Per-record AEAD tags cover record bodies. The header sits outside every one of them.

An attacker who can write the object can alter `rs` and cause mis-framing, or alter `salt` and change the derived content-encryption key. Both make every record fail its tag. **That's denial of service, not forgery.** RFC 8188 §4.7 names the same shape: where a PUT is accepted without decrypting the payload and the request is unauthenticated, "it becomes possible for a third party to deny service and/or poison the store."

Nobody may read a successfully parsed header as evidence of anything. Two consequences:

- The residual is bounded by who can write the object. Under a single-use grant bound to one object path that's the original publisher and the operator, and the operator can already delete the object, so header malleability grants the operator no capability it lacked.
- **A tag failure is indistinguishable from a wrong key** from the recipient's side. The viewer must not claim "wrong key" on a decrypt failure when tampering and truncation produce the identical symptom.

### 3.6 The renderer class is not in the container

**The container does not carry the renderer class.**

The class originally had one job, telemetry, and the record the client declares to the server at publish does that job. A copy in the container would reach exactly one consumer, the viewer, and a field whose only available use inside the container is a forbidden one shouldn't exist. Excluding it from the container also removes any chance of two copies disagreeing, which would be a bug with no correct resolution.

**The class now reaches the viewing origin's document `<head>` as link unfurl metadata, but it never routes the viewer.** Emitting the class in `/{id}`'s head for `og:description`, `twitter:description`, and fallback `<title>` puts that string in the viewing origin's DOM for the first time. The original design argued for keeping the class entirely off the viewing origin, treating total absence as a second belt against fragment theft: if the viewer routes on a publisher-asserted class, a publisher declaring `image` on an HTML payload wins inline rendering on the origin holding the fragment secret, and that content reads `location.hash`. Fragment theft in one step.

**What actually protects routing is `routeFor`'s inputs, not the class's absence from the origin.** In `packages/relic-viewer/src/viewer.ts`, `routeFor(filename, declaredMimetype, content)` takes its declared input strictly from the envelope header inside the AEAD plus a sniff of the decrypted bytes, resolving disagreement to the least privileged tier. The class is not a parameter of that function. Routing on the class would require a signature change and threading the value out of the DOM, which is a visible code change and not a silent regression. Total absence from the origin was a second and weaker belt, and this change spends it deliberately in exchange for a recipient being able to see what kind of thing a link holds before opening it.

**The replacement guard is a test on the built viewer bundles.** A test fails the build if the compiled viewer bundles ever read the card metadata from the DOM. A tested boundary is weaker than an architectural impossibility, and the spec records that trade honestly rather than pretending nothing changed.

**Excluding the class from the container doesn't disarm the declared-versus-sniffed disagreement rule, because that rule's declared input was never the class.** The rule is: when the declared type and the sniffed type disagree, route to the least privileged path either type would allow and tell the recipient you did so. It needs a declared type at render time and it has one, the declared mimetype and filename in the envelope header (3.1), decrypted out of record 0 before a byte of content renders. That copy is the better input on both axes. It sits inside the AEAD, so it's tamper-evident, where anything arriving alongside the signed URL is operator-mutable. And it's finer than a ten-value class, so a declared `.png` against HTML magic bytes is a sharper disagreement than `image` against HTML. `spec-viewer` implements the rule against the envelope header.

The residual: a publisher can declare a class that doesn't match their own content. That misleads the card preview and telemetry, but cannot elevate privilege in the viewer because the viewer does not route on it.

### 3.7 Unknown versions

**The viewer refuses. Never best-effort, never a fallback.**

Two distinct refusals, because the version appears twice. An unknown fragment marker is refused **before the fetch**, costing no mint and no egress. A container whose envelope version disagrees with the fragment marker is refused **after the fetch**. That pairing is deliberate: the outer copy enables early refusal, the inner copy sits inside the AEAD and is tamper-evident, and disagreement means a mangled fragment prefix or a substituted object.

### 3.8 Length leakage

Ciphertext length reveals plaintext length to within a record. With the class alongside it, the operator learns "an image of roughly 2.4 MB." Padding to size buckets is the only mitigation, and it's paid in egress on every fetch by every recipient forever, against a precondition that already names egress as a kill-switch condition. What it prevents is a size estimate the operator gets a coarse version of regardless.

`shape` decides (section 4). Under either branch the leak appears in the published disclosure statement, which is `spec-service-surface`'s to write.

### 3.9 Degenerate inputs

**A zero-byte file is legal.** The container emits record 0 carrying the envelope header, zero content bytes follow, and record 0 is therefore also the final record and uses padding delimiter 2. The object is never zero bytes on the wire, so "the object exists and is non-empty" stays a valid sanity check.

**A zero-byte relic carries class `binary`.** It isn't renderable, and the renderable side of the taxonomy is exactly what the metric counts, so calling an empty file `code` because its name ends in `.py` would inflate the renderable share with something that renders as nothing. The rule is unconditional: zero-byte content declares `binary` regardless of filename, extension, or sniffed type. No implementation-defined hole in the taxonomy.

### 3.10 Fresh keys, always

**Every relic gets a fresh key from the publishing machine's CSPRNG.** RFC 8188 §4.3 requires it structurally: the framing uses a fixed nonce progression, so "a new content-encryption key is needed for every application of the content coding."

**The unit of freshness is the relic, not the version.** A republished version encrypts new plaintext under the same relic key, because the shared URL carries that key and a version that needed a new fragment would be a new relic. That is safe because the RFC's requirement is a fresh *content-encryption* key per application of the coding, not a fresh input key: every object draws a fresh random salt, HKDF derives a new content-encryption key from it, and the fixed nonce progression restarts per object against a key it has never been used with.

Two consequences, and the second is a boundary:

- The nonce budget is per file rather than global, so the counter-derived per-record nonce is safe with no birthday-bound concern.
- **An honest double-publish of the same file produces entirely different ciphertext, so the ciphertext-hash blocklist can never catch it.** That's a property of the design rather than a bug to fix, and the blocklist was already budgeted as a speed bump.

**Convergent encryption is drift routing back to `frame`, not a permitted optimization.** Deriving the key from the plaintext would make the blocklist work and, in the same stroke, let the operator confirm two users published the same file and test whether any given file is on the service. That trades the zero-knowledge property for an abuse control, which is a `frame` decision. Nobody settles it in `shape` or `build`.

### 3.11 The cap's referent

`shape` picks which side the cap is enforced on and its value (section 4). This spec fixes the rule constraining that choice:

**The number shown to a user is a plaintext number, one they can verify with `ls`.** If enforcement lands on ciphertext, the enforced limit is computed as `encryptedSize(published_plaintext_cap)`, so a file exactly at the published cap always fits.

The failure that prevents is specific. Framing adds known overhead, so a plaintext file exactly at a plaintext-stated cap yields a ciphertext over a ciphertext-enforced cap, and it fails at upload for a reason the user can't see, can't reproduce, and can't fix. If the container pads to buckets, `encryptedSize` runs on the padded size or the same off-by-a-bucket failure comes straight back.

### 3.12 The versioned object layout

Republish-to-same-URL exists, so a relic id names a sequence of objects rather than one. The layout rule: **version 1's ciphertext stays at the existing path `{ciphertext_prefix}/{id}`, and versions 2 and up live at `{ciphertext_prefix}/{id}/v{n}`.**

This is a layout rule rather than a migration because production already holds objects at the un-suffixed path and they must keep resolving. Re-pointing version 1 to a suffixed path would orphan every link already shared, which is the one failure this document exists to prevent: content is encrypted once under a key the URL carries forever, so the URL is the product and cannot be broken retroactively.

Four consequences:

- **Each version path gets its own existence refusal.** A grant or a republish targeting `{id}/v{n}` is refused if that path already holds an object, which is 1.4 applied per version. No path is ever overwritten, at any version, including by the relic's own publisher.
- **Opening a relic serves the current version, and there is no way to request an older one.** The version number on the row picks the object, and no endpoint accepts a version selector. Serving history would multiply servable egress per id for nothing the recipient asked for.
- **The per-object download cap counts opens per relic id across all versions**, so the egress ceiling per id keeps its meaning under republishing. What versions multiply is stored bytes, never servable mints.
- **A delete removes every version's object**, v1 through current, and the tombstone refuses any future version (`spec-service-surface` section 4). Takedown is terminal across versions by construction: the refusal keys on the id, and no version number is an argument against it.

The version counter is 1-based and counts publishes: the initial publish is version 1, each republish increments it. It lives on the server's relic row and never enters the URL, the fragment, or the container, so it adds nothing to what a recipient or the operator can read from a link, and it cannot collide with the format's own version marker (2.2), which counts container revisions on a different axis.

### 3.13 Comment encryption

Comments are content, and a comment about content the operator cannot read, stored in the clear, hands the operator exactly what this document exists to deny. So a comment body is encrypted by whoever writes it, under a key only a holder of the relic's link can derive.

**The fragment does not change, and neither does the container.** 2.1 fixes the fragment at the marker and the key, and says a third field takes a version bump, so there is no room for a separate comment secret and none is invented. What there is room for is another HKDF label. **The comment key is `HKDF-SHA256(ikm = the 16 raw fragment key bytes, salt = zero-length, info = "relic/comments/v1", L = 16)`.**

**This derivation needs no format version bump, and that has to be stated rather than left to a reader's inference, because a new key looks like a new format.** It is not one. 3.1's two layers are untouched: no header field is added, no record layout changes, no envelope field appears, and the fragment keeps exactly the two things 2.1 allows it. Every relic written before comments existed decodes byte for byte the same way after, and a viewer that never derives a comment key is not a viewer speaking an older format. The version marker in 2.2 counts container revisions, and nothing in this section is a container revision. What a comment key is instead is a second use of key material the URL already carries, which is precisely what RFC 8188 does when it expands the same input keying material under `Content-Encoding: aes128gcm\0` for the content key and `Content-Encoding: nonce\0` for the base nonce. A third distinct label yields a third key independent of both by construction rather than by assertion, and independence by construction is what makes this safe without a bump: the comment key cannot be used to reach the content key, and vice versa, whatever either one leaks.

**The salt is zero-length, unlike the container's.** A comment is not a container and has no plaintext header to carry a salt in. RFC 5869 permits the omission, and what separates one comment from another is the per-comment nonce rather than a salt.

**The envelope is deliberately not RFC 8188 framing.** The plaintext is UTF-8 JSON with `body` (a string), `display_name` (a string or `null`), and an optional `anchor`. A missing `anchor` is a freeform comment. The sealed value is **`nonce(12) || AES-128-GCM(commentKey, nonce, plaintext)`, transported unpadded base64url.** A comment is small, read whole, and never range-decrypted, so records, padding delimiters, and a 21-byte header would all be overhead spent on properties comments do not have. The nonce is drawn fresh from the platform CSPRNG per comment and never from a counter, because comments have no ordering the format can see and nonce reuse under a reused key loses the plaintext outright.

**The caps are 4096 bytes of UTF-8 for `body` and 64 for `display_name`, enforced by this package before encryption.** Bytes rather than characters, so a body of four-byte characters cannot slip past a length check. They are enforced here rather than left to each caller for the reason 3.11 gives about the content cap: a limit that exists only as a documented number is not a limit. Over-cap is refused rather than truncated, because truncating changes what a comment says, which is worse than declining to store it.

**The anchor says where a comment points, and it is seven kinds.** `{kind: "text", quote}` re-finds the first exact occurrence of a quote. `{kind: "pin", x, y}` is a point on the stage in unit coordinates 0 to 1. `{kind: "quote", exact, prefix?, suffix?}` is a quote plus the text immediately around it, so a phrase occurring more than once resolves to the one that was selected. `{kind: "region", rect}` is a box. `{kind: "time", t, t_end?, rect?}` is a moment or a span in a media relic, with an optional box inside that frame. `{kind: "page", page, rect?, exact?}` is one page of a paged document, with an optional box or quote on it. A `rect` is `{x, y, w, h}` in unit coordinates, inside the square, with real area and no overhang; a zero-area rectangle is a point wearing a box's shape and `pin` already exists for that. Caps: 512 bytes for `quote` and `exact`, 128 per side for `prefix` and `suffix`, `page` an integer in 1 to 10000, `t` and `t_end` finite in 0 to 86400 seconds with the span running forward. The bounds exist here rather than at the renderer because every one of these values is eventually handed to something as a seek target.

**Geometry in a `rect` is measured against the annotated content's own box, and `pin` is the exception that proves it.** `pin` is stage-relative, which drifts: the same image is letterboxed differently at another viewport width, so a stage-relative point lands on a different part of the picture on the reader's screen than on the writer's. `pin` keeps that behaviour because it is already stored that way and cannot be reinterpreted after the fact. Nothing new inherits it.

**`text` and `pin` are frozen, and the freeze is what makes the other five safe to add.** A parser built before them reads exactly those two and refuses any field it has not seen. Widening either in place would turn every comment a current writer seals into a `MalformedComment` over there, and `spec/viewer.md` 6.4 state 4 shows that to a person as written under a different key or altered in storage. That is a claim about tampering produced by a version gap, which is worse than saying nothing. So precision arrived as new kinds and those two never grow a field.

**Parsing is tolerant about kinds and, since 2026-09-17, about top-level fields too. The strict half is withdrawn, and the argument that froze `text` and `pin` is what withdraws it.** An unknown `kind` parses as `{kind: "unsupported", declared}` and the comment keeps its body, because the only thing that produces an unknown kind is a reader older than the writer, and the honest report is that a mark exists which this build cannot show. An unknown top-level field was refused instead, on the reasoning that it is the tampering and typo case. That reasoning was wrong in the same way the paragraph above says widening `text` would be wrong: the AEAD tag is what detects tampering, and refusing on a field name detected age. It was not theoretical. The published client predated two anchor kinds, and Jason's real comments on a client proposal came back as unreadable, which `spec/viewer.md` 6.4 state 4 shows to a person as written under a different key or altered in storage. So an unknown top-level field is now reported rather than refused: known fields parse, unrecognised names are collected into `unsupported_fields`, and the comment keeps its body. `unsupported_fields` and `unsupported` are both parser outputs and neither is ever written: sealing one would store a comment asserting a gap in somebody else's reader.

**A field inside a known kind is still refused**, because a reader that has the kind has all of its fields, so an extra one there is not age.

**`addresses` names the comment this one answers**, by service-minted id, and it is what makes a reply and an acknowledged update legible as answers rather than as more remarks. It is optional, absent on an ordinary comment, and capped at 64 bytes, which is a sanity bound rather than a format claim since the service mints the ids. **The sealed copy is the only authoritative one.** A caller may hand the same id to the service in the clear so it can route a notification to the person being answered, and that copy is operator-visible and operator-forgeable. A surface that showed a comment as addressed on the strength of the clear copy would be repeating the operator's word for it, so nothing resolves it from anywhere but inside the AEAD.

**The writer runs the reader's predicates rather than a second copy of them.** `encryptComment` validates a candidate anchor by parsing it, so a value this package will seal is a value it can open. Two independently written validators drift, and the shape of that drift is a comment that is accepted at write time and unreadable afterwards, which is unrecoverable because the ciphertext is all that survives.

**A failed comment decrypt carries no cause**, per 3.5. A wrong key, a truncated value, and a tampered nonce are one symptom from this side, and a caller must not tell a reader which it was. A caller displaying a list of comments must nonetheless report the failure rather than drop the row: a quietly shortened list reads as the whole conversation, and agreement is the wrong thing to infer from a comment nobody could open.

**`display_name` is decoration and never identity.** The identity of a commenter is the verified address the service holds (`docs/frame.md`), and the name is untrusted display text living inside the ciphertext where the service cannot read it. It aliases the attribution and never replaces it.

### 3.14 Share proof

A reader can enroll addresses in a relic's change notices from the web viewer, and only a holder of the key may do that. The service never sees the key, so it cannot check possession directly. What it can check is a value only a key holder can compute: the publisher's client registers the SHA-256 of a key-derived proof when it publishes or republishes, and a reader presents the proof itself when sharing. The service compares hashes and learns the proof, which decrypts nothing.

**The derivation is HKDF-SHA256, zero salt, info `relic/share-proof/v1`, 32 bytes.** In code:
`deriveShareProof(keyBytes)` imports the raw 16-byte fragment key as HKDF key material, passes a zero-length salt and the info string `relic/share-proof/v1`, and expands to 256 bits (32 bytes).

**The verifier is the lowercase hex SHA-256 of the proof.** In code:
`shareVerifierFor(proof)` hashes the 32 proof bytes with SHA-256 and formats the result as a 64-character lowercase hex string.

**Verifier registration happens at publish and republish.** The publishing client computes `share_verifier = await shareVerifierFor(await deriveShareProof(key))` and sends it in the JSON request body of `POST /api/relics` and `POST /api/relics/{id}/republish`. The server stores `shareVerifier` on the relic row.

**Reader sharing presents the proof.** A reader in the web viewer holding the fragment key derives `proof = await deriveShareProof(keyBytes)` and submits `share_proof: base64url(proof)` in `POST /api/relics/{id}/share` alongside their authenticated session cookie. The server checks that the base64url-decoded proof is exactly 32 bytes and verifies `timingSafeEqual(sha256Hex(proof), row.shareVerifier)`.

**What the service learns:** the verifier at publish, the proof at share, and neither decrypts anything. The proof derivation uses a dedicated HKDF info label (`relic/share-proof/v1`), so the proof is cryptographically independent of the content-encryption key, the nonce, and the comment key (`relic/comments/v1`). Knowledge of the proof or its verifier yields no information about the relic's plaintext.

**No format version bump is required.** Like the comment key in 3.13, this derivation adds no fields to the container header or fragment. The fragment continues to carry only the 16-byte key, and the proof is a separate derivation from material the URL already holds.


### 3.15 OpenTimelineIO comments anchor

**Proposed extension for OpenTimelineIO feedback.** Subject to end-to-end surface proof in `packages/relic-mcp/test/otio-path.ts`.

Reviewers leaving feedback on an OpenTimelineIO timeline require track-specific and rational-time range references rather than seconds-only scalar time.

```ts
interface OtioAnchorV1 {
  readonly kind: 'otio';
  readonly v: 1;
  readonly relic_version: number;
  readonly document_sha256: string;
  readonly timeline_id: string;
  readonly track_id: string | null;
  readonly item_id?: string;
  readonly range: OtioTimeRange;
  readonly snapshot: {
    readonly timeline: string;
    readonly track: string | null;
    readonly item: string | null;
  };
}
```

- **Rational time coordinates:** Preserves `{value, rate}` without floating-point precision loss. Ranges are half-open. A duration of zero represents a point comment.
- **Track binding:** `track_id` binds to the specific track ID in the composition; `track_id: null` anchors to the timeline as a whole.
- **Envelope and transport limits:** Like existing anchors in 3.13, the anchor JSON is encrypted inside the comment body payload under `relic/comments/v1`. The serialized anchor payload is budgeted under 1,536 UTF-8 bytes before encryption, and the overall ciphertext must not exceed the existing 8,192 base64url character limit.
- **Historical revision integrity:** The anchor seals `relic_version` and `document_sha256` inside the AEAD ciphertext. Resolving an anchor fetches and decrypts the original revision's document under format version 1. Safe projection to the current revision (`same`, `mapped`, `partial`, `changed`, `ambiguous`, `missing`) is reported as an auxiliary mapping without altering the immutable original anchor.
- **Identity and media continuity:** Derived node IDs fingerprint canonical OTIO JSON after removing only `metadata.relic.id`; media indexes and digests never alter that fingerprint. Across distinct parsed documents, a projected reference must have the same canonical referenced-entry facts and a SHA-256 for every indexed entry. A missing or unequal digest, an unmatched indexed reference, or an image-sequence witness beyond the 65,532-frame budget is `changed`. Resolving against the same parsed document object remains `same`. A Stack or Track item anchor locates its container by identity only and projects through the matched descendants it originally covered; a descendant that is gone or fails media continuity contributes nothing, and when nothing survives the result is `missing`.
- **Bundle paths:** Every exported `bundle_path` is one canonical archive entry name, decoded exactly once, or `null`; raw authored URLs remain only in their media references. Image sequences use OpenTimelineIO URL joining: a slash is inserted only for a non-empty base without a trailing slash, the signed padded frame follows the prefix, and the raw URL remains otherwise unchanged. Their count is `trunc(rescale(duration, rate / frame_step))`; omitted fields use the official defaults, and an absent range, non-positive rate, or non-positive count is a valid zero-image sequence. Relative references trim, remove a raw query or fragment, strip only a relative `file:` prefix, percent-decode once, treat backslashes as separators, and discard empty or `.` segments. They refuse control characters, malformed escapes, absolute paths, non-`file:` schemes, drive paths, empty results, and every `..` segment. A sanitized path already under `media/` stays there; every other path becomes `media/<path>`. Present sequence fields must be representable within safe integer, padding, URL-length, and 65,532-entry limits. Missing sequence frames are omitted when packed and playback applies the reference's missing-frame policy; missing external-reference targets still refuse publication.
- **No container version bump:** Format version 1 and envelope framing remain unchanged. Standard `.otiod` directory inputs are packaged into standard single-entry `.otioz` archives before encryption, preserving the single-entry container invariant.
## 4. Routed to `shape`

Six items, and only these six. Each names what `shape` picks and what becomes specifiable once it does. Constraints established above are cited here rather than restated.

1. **The wire format and framing.** RFC 8188 `aes128gcm` is presumptive. Any substitute must provide four properties: range decryption, per-record AEAD, plaintext size derivable from encrypted length before decryption (3.3), and a header readable before allocation (3.1). Once picked: the exact byte layout, the `rs` default, and therefore the envelope header's field caps.
2. **Key length. 128 or 256 bits.** The encoding is not `shape`'s to pick. It's settled in 2.3 as unpadded base64url, and the terminal-character rule stated there is what excludes a 24-byte key, and therefore 192 bits, from the option set. Once picked: the fragment's exact length and a runnable `fragment-terminal-charset` check.
3. **ID entropy bit count.** Generation location is fixed in 1.3 as client-side, before the grant request, so what remains for `shape` is the number, floored at 122 bits (1.2). Once picked: the ID's length in characters, which is the primary reserved-word guard in 1.5.
4. **Whether the cap is on plaintext or ciphertext, and its value.** Constrained by 3.11. Once picked: the grant's signed size constraint and the worst-case egress arithmetic in the preconditions.
5. **Whether the container pads to size buckets.** Constrained by 3.3 and 3.11. Once picked: whether the viewer can show an exact size before decryption, and the egress multiplier.
6. **Whether object metadata is set at upload time at all.** Get the premises right, because this one is easy to close for the wrong reason. Two real constraints: the app server never sees the bytes on either leg, and it can't set the response headers GCS serves. Neither puts object metadata beyond its reach. It already holds bucket-mutating credentials, because delete-by-ID is a v1 control in the preconditions, and metadata is editable after the fact: "After you have created a custom metadata `key:value` pair, you can delete the key or change the value" ([GCS metadata](https://docs.cloud.google.com/storage/docs/metadata)). So it can patch or strip metadata post-upload on an object whose bytes it never handled. It can also pin what the client sets, because custom metadata rides `x-goog-meta-*` headers and Cloud Storage requires headers "prefixed with `x-goog-`" to be present in the canonical headers to be used in a signed request ([canonical requests](https://docs.cloud.google.com/storage/docs/authentication/canonical-requests)), so a grant that signs them fixes their values and a client can neither alter nor add one without invalidating the signature. Metadata here is settable, patchable, and pinnable. 3.2 already bars anything content-descriptive from living in it, so what's genuinely open is whether any is needed at all. Once picked: whether the grant must sign metadata constraints, and whether the blocklist scanner reads metadata or only object bytes.

## 5. What the sibling units inherit

- **`spec-service-surface`:** the ID is unguessable (1.2), so an expired relic **may** be distinguished from one that never existed. Reserved paths (1.5) beat IDs at the router, the table is append-only, and appends compare normalized forms. The length-leak disclosure (3.8) belongs in the published statement. Two rules about redirects. **The first splits on where the redirect lands, not on whether the origin changes.** Leaving the service, an explicit, possibly empty, fragment in `Location` is **mandatory**: a fragment-less `Location` inherits the original request's fragment, and RFC 9110 §17.11 scopes its remedy to ensuring that "redirects to other sites include a (possibly empty) fragment component in order to block that inheritance" ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)). The case that matters is the service origin redirecting to the usercontent origin, which would hand the key to the one origin the two-domain split exists to keep it from, along with any CDN or load-balancer redirect the application doesn't author that lands off the service domain, which is the one nobody audits. Staying inside the service, the fragment is **deliberately omitted** so inheritance carries the key through, and that gets said out loud because a blanket MUST reads as forbidding it. That half covers legacy or renamed paths, trailing-slash normalization, apex to `www`, and HTTP to HTTPS; the last two change origin without leaving Relic, and an empty fragment on any of them is a deleted key and a recipient on the "missing its key" screen. **The test is the destination's trust boundary, not its origin tuple.** The preferred form is that no inside-the-service redirect exists on the relic path at all, with HSTS preload on both registrable domains moving the scheme upgrade into the user agent. Second, because 1.1 issues no canonicalizing redirect, a relic is served on every accepted spelling of its ID. Cache keys, per-object download-cap accounting, and log correlation all normalize before keying, or they fragment across spellings and the cap stops being a cap.
- **`spec-service-surface`, on versions:** the mint serves the current version against the layout in 3.12, the per-object cap counts across versions, delete removes every version, and the republish endpoint's refusals (missing or wrong token, tombstone outranking a valid token) are that document's 1.7.
- **`spec-viewer`:** the fragment is stripped via `history.replaceState` (2.5), which obliges a copy-link affordance and a dead-page state after reload. The viewing origin sends `Referrer-Policy: no-referrer` (section 0). The class never routes (3.6), and the declared-versus-sniffed disagreement rule runs against the envelope header's declared mimetype and filename (3.6). Unknown versions refuse in both places (3.7), and `idlen != 0` refuses after the fetch (3.4). A decrypt failure doesn't mean "wrong key" (3.5).
- **`spec-publish-contract`:** the client generates the ID and the key independently before requesting a grant (1.3), the server validates and refuses on collision (1.4), and **nothing finer than the ten-value class, the client name, the optional publisher-declared plaintext title, and the cover raster (rendered by default and declined with `cover: false`, or generic for `otio`) crosses to the server** (3.2). The class does cross, it is telemetry item 1 in the frame, and the metric's second clause is computed from it.
- **`spec-publish-contract`, on republish:** the client re-encrypts under the persisted relic key with a fresh salt (3.10), the publish token crosses once in the first grant response while the server keeps only its hash, and the durable key-plus-token state that makes republish possible is that contract's to specify.
- **Every unit, on comments (3.13):** the comment key is derived from the fragment's key bytes under `relic/comments/v1`, the envelope is `nonce(12) || AES-128-GCM` over two-field JSON in unpadded base64url, the caps are 4096 and 64 bytes of UTF-8 enforced by `@relic/format` before encryption, and unknown fields are refused. **The fragment and the container are unchanged, so nothing here is a format version bump.** What each sibling inherits from that: the service stores an opaque base64url string it cannot read and must not validate as anything but base64url; the viewer and the publishing client both derive the key from the fragment they already hold; and any surface listing comments reports a decrypt failure rather than dropping the row, because a shortened list reads as agreement.
