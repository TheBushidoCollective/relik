# Relik: the URL, the relik ID, and the ciphertext container

This document fixes the format. It owns the irreversible decisions in `specify`, because a container format can't be changed after content is encrypted and three cross-document couplings resolve through the ID.

`docs/frame.md` and `docs/preconditions.md` are locked inputs. Nothing here reopens them. Where a decision belongs to `shape`, it's routed in section 4 with what `shape` must pick and what becomes specifiable once it does. Everything else is a rule.

## 0. The URL

The shape is locked for public reliks: `https://<relic-domain>/{id}#{secret}`. The ID sits in the path, the secret sits in the fragment. This document doesn't reopen it. It records one consequence and one obligation.

**The consequence.** Delete-by-ID depends on the ID being in the path. An abuse reporter hands over a URL with the fragment already stripped, so an ID that lived in the fragment would arrive stripped too and the takedown primitive would have nothing to act on.

**The obligation.** The ID appears in the viewing origin's own `Referer` on any outbound request, so that origin sends `Referrer-Policy: no-referrer`. That's `spec-viewer`'s to implement, named here because this section creates the exposure and restated in section 5 so it travels with the unit that owes it.

**The private-relic URL.** A private relik's link is `https://<relic-domain>/{id}`, with no fragment. There is no key in the URL to leak, and nothing to strip from the address bar (2.5). The ID still sits in the path, so delete-by-ID and the consequence above still hold. The ID alone fetches nothing for a private relik: its mint is gated on an access check (1.2, 3.7). Each reader's copy of each version's key arrives in a wrap (3.17). The private-shares build plan (`docs/plans/private-shares/README.md`, cited here as "the plan") replaces the draft's version marker with these rules (plan correction 1 and section 4.7).

## 1. The relik ID

### 1.1 Alphabet

**Crockford base32, lowercase canonical, case-insensitive on lookup** ([Crockford](https://www.crockford.com/base32.html)).

The trade is bits per character against transcription cost. base64url is 6 bits per character and case-sensitive in a path, so it's the shortest and the least survivable when a human retypes it ([RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648.html)). Hex is 4 bits per character, longer than base32 and no more readable. Crockford is 5 bits per character, roughly 20 percent longer than base64url at equal entropy, and it drops `i`, `l`, `o`, and `u`. Somebody reading an ID off a screenshot or over the phone can't turn it into a *different valid* ID by guessing case or confusing `1` with `l`. The ID is the part humans retype, in workflows the product actually has: abuse reports, support tickets, takedown requests, log lines, all arriving with the fragment already stripped. The key stays base64url because a 43-character key isn't worth optimizing for hand transcription, and a key short enough to retype reliably is too short.

**Lookup normalizes before comparison. It case-folds and applies Crockford's decode aliases, `i` and `l` to `1` and `o` to `0`. Hyphens are rejected.** Crockford also permits hyphens as readability separators and says they "are ignored during decoding". Implementing that half faithfully would give every ID unbounded valid spellings and break the fixed-length guard 1.5 leans on. So Relik takes the alias folding and declines the hyphen rule: a hyphen in the path segment is a 404 rather than a character to strip. Relik never emits one, so a publisher pays nothing for it.

**There's no canonicalizing redirect, and the reason is arithmetic.** Lookup already folds case and aliases, so a redirect to the canonical spelling would spend a round trip reaching an answer the first request already had. The redirect rule that does bite is cross-origin, it belongs to `spec-service-surface`, and it's in section 5.

**The ID is opaque and encodes nothing:** no timestamp, no shard, no class. The MCP spec puts it directly: "Handles that encode internal structure invite parsing or guessing; opaque identifiers do not" ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). A timestamp prefix would hand publish time to anyone holding the URL and shrink the search space at the same time.

### 1.2 Entropy

Two locked statements point opposite ways and both are true. The preconditions: "This works precisely because the relik ID is not secret. Only the key is." The MCP spec, on handles for unauthenticated servers: one "is necessarily a bearer token, it should be generated with sufficient entropy (e.g., a UUIDv4) and given a bounded lifetime." They reconcile because the ID is a bearer token for fetching *ciphertext*, and ciphertext without the key is inert.

That reconciliation holds for public reliks. A private relik's ID is a locator, not a bearer token for fetching ciphertext: a private mint is refused unless the caller's identity holds a wrap for a sealed, undeleted version, or the caller presents the publish token (plan correction 11 and section 4.7). The entropy rule below still applies to a private relik's ID, but holding the ID no longer lets anyone read the relik.

**The ID carries full bearer-token entropy. The rule fixed here is that it is unguessable, not merely unique.** The cost is URL length and nothing else.

The alternative worth naming is a short ID with all security in the fragment. It costs enumeration: a stranger walking the ID space collects the operator-conceded metadata set (coarse class, approximate size, open timing) on reliks nobody shared with them, and burns per-object download caps and egress doing it. That re-prices a locked decision without routing it, because the frame conceded a coarse content category to *the operator* rather than to the world, and making it world-readable by enumeration is drift dressed as a URL-length preference. Restoring unguessability by adding a separate fetch token to the fragment buys the same property for two secrets, two things that can be truncated, and a failure mode where one lost character yields a 404 the recipient can't tell apart from a decrypt error.

`shape` picks the bit count. The floor is the reference point the MCP spec itself names, a UUIDv4, whose randomness is 122 bits. **At Crockford's 5 bits per character, a 122-bit floor is 25 characters, and that number is what 1.5's primary guard rests on.**

**`spec-service-surface` inherits this directly.** Because the ID is unguessable, an expired relik and a relik that never existed **may be distinguished**. Only somebody already holding a valid ID can ask the question, and holding the ID means they were given the link, so the distinction discloses nothing new and turns "the link is dead" into an answerable support question. Under a short-ID design it would have been an enumeration oracle and would have had to be suppressed. It isn't.

### 1.3 Who generates it

**The publishing client generates the ID before it requests a grant.**

That eliminates the worst failure in the system, a relik that exists, is fetchable, and has no owner who can name it. Owning the ID and the key before anything leaves the machine lets the client reconstruct the full URL from state it already holds (for a public relik, the URL that carries its key in the fragment), so an upload that succeeds while its confirmation is lost still yields a link the publisher can share and can hand to the operator for deletion.

If `shape` overrides this and puts generation on the server, **the ID must come back in the grant, never in a post-upload confirmation**, for the same reason. A grant response arrives before the bytes move. A confirmation arrives after, and it's the message that gets lost.

Client generation makes the client's randomness load-bearing. The ID and the key are drawn independently from the platform CSPRNG, never `Math.random`, and **neither derives from the other**. Deriving the key from the ID would put the key in the operator's hands, since the operator has every ID.

The server validates a client-supplied ID at mint against the alphabet, the fixed length, and the reserved table, and refuses anything failing. The grant binds to the exact object path, so a client can't upload to an ID the grant doesn't cover.

### 1.4 Collisions

**The server refuses to mint a grant for an ID that already exists. It never overwrites.** An overwrite silently replaces someone else's relik and its owner has no way to notice. Republish does not relax this, because a republish writes a fresh versioned path (3.12) under its own existence refusal rather than replacing the live object, so no path is ever written twice, at any version.

Under full bearer-token entropy a collision is astronomical bad luck or a broken RNG, and both should fail loudly. The client draws a new ID and retries. Repeated collisions from one source are worth logging, because that's what a fixed seed looks like from outside. Refusal is an existence oracle in principle, harmless here only because the ID space isn't walkable.

### 1.5 Reserved path segments

IDs sit at the root, so root-level service paths are reserved words. **The reserved set is `abuse`, `policy`, `robots.txt`, `favicon.ico`, `sitemap.xml`, `manifest.webmanifest`, `sw.js`, `assets`, `api`, `health`, `.well-known`, `sandbox.html`, and `install`.**

**No reserved word is ever issuable as an ID.** Two independent guards enforce that, and they are not equally strong.

1. **Length is the primary guard, and it's exact.** IDs are exactly N characters and 1.2 floors N at 25. The longest reserved word is `manifest.webmanifest` at 20, so length excludes every word in the table by at least five characters under the weakest entropy this document permits. No `shape` decision weakens it, because the floor is the floor.
2. **The explicit table is the backstop, because the alphabet is a weaker guard than it looks.** `assets` is directly spellable in Crockford. Three more aren't directly spellable and still fold to valid Crockford strings under the normalization 1.1 requires of lookup: `policy` to `p011cy`, `api` to `ap1`, `health` to `hea1th`. Unspellability describes what the encoder emits, and lookup deliberately accepts a wider language than the encoder emits. Only `abuse` (a `u`, which Crockford excludes with no alias) and the dotted words fall to the character set alone. So the server holds the table and refuses any ID in it, independent of length and alphabet.

Two operating rules follow. The table is append-only, and **appending a word after launch requires comparing its normalized form against the normalized form of every issued ID.** Length makes that comparison vacuous for any word shorter than N, which is every word in the table today. It stops being vacuous the moment somebody reserves a word of exactly N characters, and an exact-string check would miss the one collision that matters, an issued ID that folds onto the new word rather than matching it byte for byte. If a live relik holds a path the table later claims, the reserved route wins and the relik disappears with no error anywhere. And `/abuse` is a go/no-go obligation in the preconditions, so an issued ID shadowing it is launch-blocking.

## 2. The fragment

### 2.1 Structured, minimally

For a public relik, the fragment is **`#<version-marker><key>`**: a fixed-width version marker followed immediately by the encoded key, no separator.

A bare key leaves no room for a version marker, so there's no migration path off the first framing choice. For a public relik, content is encrypted once and never re-encrypted, so a framing choice with no migration path is permanent. A private relik's revocation republish encrypts the same plaintext again under a fresh key (3.10), and both kinds share one container, so the framing choice is permanent for both. A separator adds a character that can be mangled and buys nothing against a fixed-width marker.

The fragment of a public relik carries **exactly two things, the marker and the key**. A third field takes a version bump. A private relik has no fragment, so there is nothing for a marker to sit in: its key delivery is versioned by its own labels inside the wrap and the statements (3.17). That is not a format version bump, and the envelope and the container are unchanged.

### 2.2 The version marker lives in the fragment

The fork is fragment versus the container's plaintext header, where RFC 8188 offers a `keyid` field ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.html)).

**It goes in the fragment.** The viewer then knows the format before fetching anything, so an unknown version is refused without minting a signed URL, without consuming a per-object download cap, and without a byte of egress. The marker is visible only to people who already hold the key, so it adds nothing to the operator's metadata set, whereas `keyid` is plaintext and operator-visible by construction. The cost is two characters of URL and telling every channel the link crosses which Relik format version was used, which says nothing about the content.

The `r1` marker identifies the framing and key encoding. The authenticated envelope byte independently identifies its layout: version 1 holds one file and version 2 holds a folder (3.20). Both use the same marker and key, so a public republish can switch shapes without changing its link. A relik's publication version remains a separate counter.

A private relik has no fragment marker. Its reader checks the authenticated envelope version after opening the object; private key delivery remains versioned by its own labels (3.17).

### 2.3 Key encoding and the terminal-character rule

The key is **unpadded base64url** ([RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648.html)).

**The rule: the terminal character set the chosen encoding can produce must not intersect GitHub Flavored Markdown's trailing-punctuation set.** The GFM autolink extension states it plainly: "Trailing punctuation (specifically, `?`, `!`, `.`, `,`, `:`, `*`, `_`, and `~`) will not be considered part of the autolink" ([GFM spec](https://github.github.com/gfm/)). `_` is in the base64url alphabet. A relik URL pasted into any GFM surface whose key ends in `_` arrives one character short, and the recipient gets a decrypt failure with nothing to diagnose it from.

Unpadded base64url of a fixed 16-byte or 32-byte key is immune by arithmetic. Neither length is a multiple of three, so the final character carries fewer than 6 significant bits: 4 bits for 32 bytes, giving an index that's a multiple of 4, and 2 bits for 16 bytes, giving a multiple of 16. Both exclude index 62 (`-`) and index 63 (`_`). **A 24-byte key breaks it**, because 24 *is* a multiple of three, the final character carries a full 6 bits, and `_` becomes reachable. **That rules out a 24-byte key, and with it AES-192, on encoding grounds alone.** The arithmetic stands on its own and needs no supporting claim about browser support, so 4.2 carries key length forward and cites this rule as the reason 192 bits isn't among the options.

Two structural consequences. The version marker is a **prefix**, never a suffix, and there's no trailing checksum, because either would put a different character class in the terminal position and reopen this. Padding is dropped: `=` adds no entropy and adds a class that non-GFM linkifiers do trim.

**The check is named `fragment-terminal-charset` and has two halves.** Statically, enumerate the characters the encoder can emit in the final position, derived from key length modulo three, and assert the intersection with GFM's trailing-punctuation set is empty. Dynamically, mint a batch of real relik URLs, run each through a GFM autolink renderer, and assert the extracted href is byte-identical to the input. The static half proves it for all keys. The dynamic half catches a renderer trimming something the spec doesn't mention.

### 2.4 Nothing else goes in the fragment

**Filename and mimetype do not live in the fragment.** It's the only placement keeping them from the operator without a decrypt round trip, and it's still the wrong trade. The fragment crosses every chat channel the link is pasted into, every link shortener a user tries, every abuse report form, and every enterprise link rewriter. Moving the filename out of the operator's view and into that set widens the audience instead of narrowing it, to a set the publisher can't enumerate. The benefit, a name in the taskbar a moment sooner, is worth nearly nothing when decrypting the first record is the very next thing that happens.

The authoritative filename and declared mimetype live in the encrypted envelope header and nowhere else (3.2).

### 2.5 The fragment is stripped from the address bar

**The viewer reads `location.hash` once into a local variable at load, then calls `history.replaceState` to replace the current entry's URL with the fragment removed** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState)).

Cheapest insurance in the product: a sanitizer bypass, a stray same-origin script, or a bundled first-party SDK finds nothing in `location.hash` to read. `spec-viewer` must honor it and must carry both visible costs:

- **The recipient can't re-share from the address bar**, so stripping obliges an explicit copy-link affordance backed by the in-memory key.
- **A reload loses the key.** The reloaded page is dead and must say so, pointing back to the original link rather than showing a decrypt error.

What it doesn't do: the URL with its fragment existed before the replace, so this retracts nothing that already read it. Browser history sync, an extension with host permissions reading `window.location.href` at load, and the application the link was clicked from all still saw it. This shrinks the window without closing it.

For a private relik there is nothing to strip. Its URL has no fragment, and the viewer writes none. This section describes public reliks only.

## 3. The ciphertext container

### 3.1 Two layers

**Layer 1, the transport framing.** RFC 8188 `aes128gcm` is presumptive: a plaintext header of `salt (16) | rs (4) | idlen (1) | keyid (idlen)`, then records of `rs` octets, each with its own 16-octet authentication tag and a padding delimiter, the last record using value 2 and all others value 1 ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.html)). Presumptive rather than fixed because the framing is `shape`'s (section 4), and the presumption because `frame.md`'s wedge-boundary section already establishes it as the off-the-shelf framing with working range decryption over GCS byte ranges ([wormhole-crypto](https://github.com/SocketDev/wormhole-crypto), [unzipit](https://github.com/greggman/unzipit)). That argument isn't re-run here. Any substitute inherits the same reversibility constraint.

**Layer 2, the Relik envelope, entirely inside the encrypted stream.** Record 0 contains a versioned envelope header. Version 1 carries one filename, mimetype, offset and length; version 2 carries a folder name, entry count and manifest and content lengths. The version 2 manifest begins the content stream (3.20).

Three rules on that structure:

- **The envelope header occupies record 0 alone and never spans records.** One record fetched, one decrypted, and the viewer holds the whole header. That's what makes the refuse-before-allocating check in 3.3 possible and range decryption useful. It also means `rs` must be at least the maximum envelope header size, which is what bounds the filename and mimetype field caps. `rs` is `shape`'s, so those caps follow from it.
- **Entry count is exactly 1 in version 1.** Version 2 stores its entry table in the manifest at the start of the content stream.
- **The parser is strict.** Unknown fields and malformed structures are refused rather than ignored.

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
| Publisher-declared title | Server-side relik row, optional (3.2) |
| Cover image raster | Server-side storage `m/cover/{id}/{sha256}` and row reference, default on (3.2) |

**The envelope filename is content, not a category.** `Q3-layoffs-final.xlsx` is not a coarse class, and storing the envelope header or declared mimetype on the server would violate the frame. The authoritative filename and declared mimetype live strictly in the encrypted envelope header and nowhere else. What changed is an explicit, owner-authorized reversal for a separate, publisher-declared plaintext title (defaulting to the source filename) stored on the server-side relik row, joined on 2026-10-13 by a per-relic cover image raster (1200x630 pixels, rendered by default and declined with `cover: false`) stored server-side. That title and cover exist solely for link unfurls and the viewer document `<title>`, and their leakage is conceded by the publisher at publish time. The declared mimetype fails the same test and remains strictly encrypted inside the envelope header: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` is finer than a ten-value taxonomy by a wide margin and is never sent to the server.

**The envelope header remains uncompromised.** The original warning that putting the filename in the grant response or in object metadata is the most likely quiet frame violation in the build remains relevant: the encrypted envelope header inside container record 0 is never parsed by the server and never reflected in server metadata. The publish request body now permits the optional plaintext `title` parameter alongside the renderer class and client name, and on 2026-10-13 `POST /api/relics/{id}/cover` was added for the cover raster (1200x630 PNG or JPEG, up to 512 KB, rendered by default and declined with `cover: false`), with the assertion that neither the container nor custom object metadata carries anything content-descriptive beyond those declared values.
### 3.3 Plaintext size is derived, never declared

The framing exposes plaintext size as a function of encrypted length and `rs`, computed before any decryption, which is what `plaintextSize()` and `encryptedSize()` already do. Declaring it server-side would be redundant and leaky at once.

**The framing must expose it, and that's a requirement rather than a convenience**, because computing plaintext size from object length before allocating is what lets the viewer refuse an oversized payload instead of killing the tab on it.

One honest qualifier: the derivation is exact only when records carry minimal padding. Under discretionary padding it's an upper bound, which is still the safe direction for a refuse-before-allocating check and isn't enough to display an exact byte count before decryption. That's a live interaction with the bucket-padding question routed in section 4.

### 3.4 What RFC 8188 fixes, and what `keyid` is for

Salt and record size are necessarily operator-visible, which is benign: the salt is random and `rs` is a performance parameter.

**`keyid` is unused. `idlen` MUST be 0, and a container with `idlen != 0` MUST be refused after the fetch.** The refusal point is forced, because the header sits in the object's first bytes and nothing can be checked until they arrive. Same shape and same cost as 3.7's second refusal: the mint and the egress are already spent, and the viewer stops before decrypting anything.

It's a plaintext free-text field sitting next to ciphertext, and RFC 8188 says it "SHOULD be a UTF-8-encoded string," which is exactly the invitation somebody accepts when they need somewhere to put a filename. Every legitimate use is already placed: a public relik's version is in its fragment, a private relik's version is in its wrap labels (3.17), and each key is named by its relik and version, so nothing needs identifying. The cost of the hard invariant is that using `keyid` later takes a version bump, which is the migration path 2.2 bought.

### 3.5 The header is not authenticated

Per-record AEAD tags cover record bodies. The header sits outside every one of them.

An attacker who can write the object can alter `rs` and cause mis-framing, or alter `salt` and change the derived content-encryption key. Both make every record fail its tag. **That's denial of service, not forgery.** RFC 8188 §4.7 names the same shape: where a PUT is accepted without decrypting the payload and the request is unauthenticated, "it becomes possible for a third party to deny service and/or poison the store."

Nobody may read a successfully parsed header as evidence of anything. Two consequences:

- The residual is bounded by who can write the object. Under a single-use grant bound to one object path that's the original publisher and the operator, and the operator can already delete the object, so header malleability grants the operator no capability it lacked.
- **A record-0 tag failure is indistinguishable from a wrong key** from the recipient's side. The viewer must not claim "wrong key" on it, because tampering produces the identical symptom.
- **Record 0 authenticating proves the key.** A tag failure after it belongs to the stored object, not the link, and the viewer says so (`viewer.md` §6.4).
- **A container ends with its final record.** The last record carries padding delimiter 2, nothing follows it, and the content records decrypt to exactly the envelope's declared length. A container that breaks any of the three is refused rather than returned short. Records sit at fixed offsets, so an object cut at a record boundary authenticates record by record, and until 2026-10-24 it was accepted.

### 3.6 The renderer class is not in the container

**The container does not carry the renderer class.**

The class originally had one job, telemetry, and the record the client declares to the server at publish does that job. A copy in the container would reach exactly one consumer, the viewer, and a field whose only available use inside the container is a forbidden one shouldn't exist. Excluding it from the container also removes any chance of two copies disagreeing, which would be a bug with no correct resolution.

**The class now reaches the viewing origin's document `<head>` as link unfurl metadata, but it never routes the viewer.** Emitting the class in `/{id}`'s head for `og:description`, `twitter:description`, and fallback `<title>` puts that string in the viewing origin's DOM for the first time. The original design argued for keeping the class entirely off the viewing origin, treating total absence as a second belt against fragment theft: if the viewer routes on a publisher-asserted class, a publisher declaring `image` on an HTML payload wins inline rendering on the origin holding the fragment secret, and that content reads `location.hash`. Fragment theft in one step.

**What actually protects routing is `routeFor`'s inputs, not the class's absence from the origin.** In `packages/relic-viewer/src/viewer.ts`, `routeFor(filename, declaredMimetype, content)` takes its declared input strictly from the envelope header inside the AEAD plus a sniff of the decrypted bytes, resolving disagreement to the least privileged tier. The class is not a parameter of that function. Routing on the class would require a signature change and threading the value out of the DOM, which is a visible code change and not a silent regression. Total absence from the origin was a second and weaker belt, and this change spends it deliberately in exchange for a recipient being able to see what kind of thing a link holds before opening it.

**The replacement guard is a test on the built viewer bundles.** A test fails the build if the compiled viewer bundles ever read the card metadata from the DOM. A tested boundary is weaker than an architectural impossibility, and the spec records that trade honestly rather than pretending nothing changed.

**Excluding the class from the container doesn't disarm the declared-versus-sniffed disagreement rule, because that rule's declared input was never the class.** The rule is: when the declared type and the sniffed type disagree, route to the least privileged path either type would allow and tell the recipient you did so. It needs a declared type at render time and it has one, the declared mimetype and filename in the envelope header (3.1), decrypted out of record 0 before a byte of content renders. That copy is the better input on both axes. It sits inside the AEAD, so it's tamper-evident, where anything arriving alongside the signed URL is operator-mutable. And it's finer than the renderer class, so a declared `.png` against HTML magic bytes is a sharper disagreement than `image` against HTML. `spec-viewer` implements the rule against the envelope header.

The residual: a publisher can declare a class that doesn't match their own content. That misleads the card preview and telemetry, but cannot elevate privilege in the viewer because the viewer does not route on it.

### 3.7 Unknown versions

**The viewer refuses. Never best-effort, never a fallback.**

An unknown fragment marker is refused before the fetch. A reader that supports the current layouts admits envelope versions 1 and 2 for `r1`, and private readers use the same admitted versions. A version above the admitted maximum is reported as an unsupported newer envelope; another version outside the admitted set is a version mismatch.

The unchanged v1-only decoder compares the authenticated envelope byte to version 1 and throws `VersionMismatchError` for a v2 object. It never interprets a folder as a v1 file.

### 3.8 Length leakage

Ciphertext length reveals plaintext length to within a record. With the class alongside it, the operator learns "an image of roughly 2.4 MB." Padding to size buckets is the only mitigation, and it's paid in egress on every fetch by every recipient forever, against a precondition that already names egress as a kill-switch condition. What it prevents is a size estimate the operator gets a coarse version of regardless.

`shape` decides (section 4). Under either branch the leak appears in the published disclosure statement, which is `spec-service-surface`'s to write.

### 3.9 Degenerate inputs

**A zero-byte file is legal.** The container emits record 0 carrying the envelope header, zero content bytes follow, and record 0 is therefore also the final record and uses padding delimiter 2. The object is never zero bytes on the wire, so "the object exists and is non-empty" stays a valid sanity check.

An envelope v2 folder can contain only empty files. Its content is still nonempty because it includes the manifest, and record 0 is followed by content records.

**A zero-byte relik carries class `binary`.** It isn't renderable, and the renderable side of the taxonomy is exactly what the metric counts, so calling an empty file `code` because its name ends in `.py` would inflate the renderable share with something that renders as nothing. The rule is unconditional: zero-byte content declares `binary` regardless of filename, extension, or sniffed type. No implementation-defined hole in the taxonomy.

### 3.10 Fresh keys, always

**Every relik gets a fresh key from the publishing machine's CSPRNG.** RFC 8188 §4.3 requires it structurally: the framing uses a fixed nonce progression, so "a new content-encryption key is needed for every application of the content coding."

**For a public relik, the unit of freshness is the relik, not the version.** A republished version encrypts new plaintext under the same relik key, because the shared URL carries that key and a version that needed a new fragment would be a new relik. That is safe because the RFC's requirement is a fresh *content-encryption* key per application of the coding, not a fresh input key: every object draws a fresh random salt, HKDF derives a new content-encryption key from it, and the fixed nonce progression restarts per object against a key it has never been used with.

**For a private relik the unit is the version.** Each version has its own 16-octet content key, drawn fresh from the publishing machine's CSPRNG, and that version's object and wraps are written under it. A revocation republish opens the next version under a fresh key rather than reusing the old one (plan section 4.12), so only the remaining readers, who receive wraps for it, can open it. The per-object salt and the per-object nonce progression argue the same way as above. The key reaches each reader only inside a wrap (3.17), never in a URL.

Two consequences, and the second is a boundary:

- The nonce budget is per file rather than global, so the counter-derived per-record nonce is safe with no birthday-bound concern.
- **An honest double-publish of the same file produces entirely different ciphertext, so the ciphertext-hash blocklist can never catch it.** That's a property of the design rather than a bug to fix, and the blocklist was already budgeted as a speed bump.

**Convergent encryption is drift routing back to `frame`, not a permitted optimization.** Deriving the key from the plaintext would make the blocklist work and, in the same stroke, let the operator confirm two users published the same file and test whether any given file is on the service. That trades the zero-knowledge property for an abuse control, which is a `frame` decision. Nobody settles it in `shape` or `build`.

### 3.11 The cap's referent

`shape` picks which side the cap is enforced on and its value (section 4). This spec fixes the rule constraining that choice:

**The number shown to a user is a plaintext number, one they can verify with `ls`.** If enforcement lands on ciphertext, the enforced limit is computed as `encryptedSize(published_plaintext_cap)`, so a file exactly at the published cap always fits.

The failure that prevents is specific. Framing adds known overhead, so a plaintext file exactly at a plaintext-stated cap yields a ciphertext over a ciphertext-enforced cap, and it fails at upload for a reason the user can't see, can't reproduce, and can't fix. If the container pads to buckets, `encryptedSize` runs on the padded size or the same off-by-a-bucket failure comes straight back.

### 3.12 The versioned object layout

Republish-to-same-URL exists, so a relik id names a sequence of objects rather than one. The layout rule: **version 1's ciphertext stays at the existing path `{ciphertext_prefix}/{id}`, and versions 2 and up live at `{ciphertext_prefix}/{id}/v{n}`.**

This is a layout rule rather than a migration because production already holds objects at the un-suffixed path and they must keep resolving. Re-pointing version 1 to a suffixed path would orphan every link already shared, which is the one failure this document exists to prevent: for a public relik, content is encrypted once under a key the URL carries forever, so the URL is the product and cannot be broken retroactively. A private relik's link carries no key, but a mint still resolves its ID to these paths, so the rule holds for private reliks too.

Four consequences:

- **Each version path gets its own existence refusal.** A grant or a republish targeting `{id}/v{n}` is refused if that path already holds an object, which is 1.4 applied per version. No path is ever overwritten, at any version, including by the relik's own publisher.
- **Opening a relik serves the current version of a public relik, and there is no way to request an older one.** The version number on the row picks the object, and no endpoint accepts a version selector. Serving history would multiply servable egress per id for nothing the recipient asked for. A private relik is different: a reader opens a sealed version their identity holds a wrap for. The owner chooses the versions a grant covers, so that can be an older version (3.17, plan 4.7).
- **The per-object download cap counts opens per relik id across all versions**, so the egress ceiling per id keeps its meaning under republishing. What versions multiply is stored bytes, never servable mints.
- **A delete removes every version's object**, v1 through current, and the tombstone refuses any future version (`spec-service-surface` section 4). Takedown is terminal across versions by construction: the refusal keys on the id, and no version number is an argument against it.

The version counter is 1-based and counts publishes: the initial publish is version 1, each republish increments it. It lives on the server's relik row and never enters the URL, the fragment, or the container, so it adds nothing to what a recipient or the operator can read from a link, and it cannot collide with the format's own version marker (2.2), which counts container revisions on a different axis.

For a private relik, each version also has a seal and a set of wraps, stored at `m/seal/{relicId}/{version}.json` and `m/wrap/{relicId}/{version}/{recipientKeyId}.json` (plan 4.11). The seal is a signed statement over the version's ciphertext digest and recipient list, and each wrap is one recipient's copy of that version's key (3.16, 3.17). Neither changes where the ciphertext sits: version 1 stays at `{ciphertext_prefix}/{id}` and version `n` at `{ciphertext_prefix}/{id}/v{n}`.

### 3.13 Comment encryption

Comments are content, and a comment about content the operator cannot read, stored in the clear, hands the operator exactly what this document exists to deny. So a comment body is encrypted by whoever writes it, under a key only a holder of the relik's key can derive. For a public relik that key is the fragment key, so only a holder of the link can derive it. For a private relik the key is per version, as described below.

**For a public relik, the fragment does not change, and neither does the container.** 2.1 fixes the fragment at the marker and the key, and says a third field takes a version bump, so there is no room for a separate comment secret and none is invented. What there is room for is another HKDF label. **The comment key is `HKDF-SHA256(ikm = the 16 raw fragment key bytes, salt = zero-length, info = "relic/comments/v1", L = 16)`.**

The comment derivation uses a separate HKDF label and leaves the fragment, framing and envelope unchanged. It derives an independent key from the same input material, like RFC 8188's distinct content-key and nonce labels. Existing reliks remain readable without deriving a comment key.

**For a private relik the comment key comes from the version, not the link.** It is `HKDF-SHA256(ikm = that version's 16-byte content key, salt = zero-length, info = "relic/comments/v1", L = 16)`, derived per version (plan 4.1). A comment on version 3 can be read only by a reader who can unwrap version 3's key (3.17). The label, the envelope and the caps are unchanged, so this is not a format version bump.

**The salt is zero-length, unlike the container's.** A comment is not a container and has no plaintext header to carry a salt in. RFC 5869 permits the omission, and what separates one comment from another is the per-comment nonce rather than a salt.

**The envelope is deliberately not RFC 8188 framing.** The plaintext is UTF-8 JSON with `body` (a string), `display_name` (a string or `null`), and an optional `anchor`. A missing `anchor` is a freeform comment. The sealed value is **`nonce(12) || AES-128-GCM(commentKey, nonce, plaintext)`, transported unpadded base64url.** A comment is small, read whole, and never range-decrypted, so records, padding delimiters, and a 21-byte header would all be overhead spent on properties comments do not have. The nonce is drawn fresh from the platform CSPRNG per comment and never from a counter, because comments have no ordering the format can see and nonce reuse under a reused key loses the plaintext outright.

An optional top-level sealed `entry` names the canonical path of the file a comment concerns (3.20). A malformed path is refused on write and reported as malformed on read. Readers that predate this field retain the comment body and report `entry` as unsupported.

**The caps are 4096 bytes of UTF-8 for `body` and 64 for `display_name`, enforced by this package before encryption.** Bytes rather than characters, so a body of four-byte characters cannot slip past a length check. They are enforced here rather than left to each caller for the reason 3.11 gives about the content cap: a limit that exists only as a documented number is not a limit. Over-cap is refused rather than truncated, because truncating changes what a comment says, which is worse than declining to store it.

**The anchor says where a comment points.** `{kind: "text", quote}` re-finds the first exact occurrence of a quote. `{kind: "pin", x, y}` is a point on the stage in unit coordinates 0 to 1. `{kind: "quote", exact, prefix?, suffix?}` is a quote plus the text immediately around it, so a phrase occurring more than once resolves to the one that was selected. `{kind: "region", rect}` is a box. `{kind: "time", t, t_end?, rect?}` is a moment or a span in a media relik, with an optional box inside that frame. `{kind: "page", page, rect?, exact?}` is one page of a paged document, with an optional box or quote on it. An HTML image uses the `image` anchor below, and an OpenTimelineIO comment uses the anchor in 3.15. A `rect` is `{x, y, w, h}` in unit coordinates, inside the square, with real area and no overhang; a zero-area rectangle is a point wearing a box's shape and `pin` already exists for that. Caps: 512 bytes for `quote` and `exact`, 128 per side for `prefix` and `suffix`, `page` an integer in 1 to 10000, `t` and `t_end` finite in 0 to 86400 seconds with the span running forward. The bounds exist here rather than at the renderer because every one of these values is eventually handed to something as a seek target.

**A source anchor is `{kind: "source", exact, prefix?, suffix?}`.** Its strings are slices of the decoded source of the version stamped on the comment, rather than rendered text. `exact` is 1 to 512 UTF-8 bytes; each optional context is 0 to 128 bytes. None may contain U+0000 or U+000D. Unknown fields are refused. A separate kind keeps an older viewer from placing a source quote against rendered text.

**An image anchor for HTML or DOCX is `{kind: "image", path: [{tag, index}, ...], source_sha256}`.** Starting at `document.body`, each path step names a lowercase element tag and its zero-based ordinal among same-tag element siblings. Relik-owned controls and overlays are excluded by ownership. The path contains 1 to 64 steps and ends at an `img`. Each tag is nonempty, at most 64 UTF-16 code units, and excludes whitespace, ASCII control characters, `<`, `>`, and `/`. Each index is an integer from 0 through 4294967295. The JSON-encoded anchor is capped at 1536 UTF-8 bytes. Unknown fields on the anchor or a path step are refused. Resolution walks the elements directly rather than interpolating a selector.

The `source_sha256` is 64 lowercase hexadecimal characters. For HTML, it is the SHA-256 digest of the UTF-8 `JSON.stringify` encoding of `[src, srcset, sizes, sources]`. The first three entries are the image element's authored attributes, obtained with `getAttribute`, so an absent attribute is `null` and an empty attribute is `""`. If the immediate parent is `picture`, `sources` is the ordered array of its `source` children's `[srcset, sizes, media, type]` authored attributes, also using `getAttribute`. Otherwise `sources` is `[]`. The HTML digest covers declarations, not image bytes; neither data URLs nor image bytes are stored in the anchor. Responsive `currentSrc` and the image's `alt` text do not enter the digest.

For DOCX, the digest is SHA-256 of the UTF-8 `JSON.stringify` encoding of `["docx-image", entryName, imageBytesSha256]`, where `entryName` is the admitted package member and `imageBytesSha256` is the lowercase SHA-256 of its decompressed bytes. The member name, bytes and frame-local Blob URL stay in the frame; only the digest enters the encrypted anchor.

The path must resolve exactly to an `img` whose source digest matches. There is no fallback by source search or coordinates. The identity is local to the publication version already associated with the comment row. Scripted document changes can invalidate it, and an indistinguishable duplicate inserted at the same structural position cannot be distinguished. The image anchor is encrypted with the comment body using the existing envelope. Forward-tolerant readers that predate this kind retain the body and report an unsupported mark; existing anchors and the container format remain unchanged.

**Geometry in a `rect` is measured against the annotated content's own box, and `pin` is the exception that proves it.** `pin` is stage-relative, which drifts: the same image is letterboxed differently at another viewport width, so a stage-relative point lands on a different part of the picture on the reader's screen than on the writer's. `pin` keeps that behaviour because it is already stored that way and cannot be reinterpreted after the fact. Nothing new inherits it.

**`text` and `pin` are frozen, and new kinds carry additional precision.** A parser built before them reads exactly those two and refuses any field it has not seen. Widening either in place would turn every comment a current writer seals into a `MalformedComment` over there, and `spec/viewer.md` 6.4 state 4 shows that to a person as written under a different key or altered in storage. That is a claim about tampering produced by a version gap, which is worse than saying nothing. So precision arrived as new kinds and those two never grow a field.

**Parsing is tolerant about kinds and, since 2026-09-17, about top-level fields too. The strict half is withdrawn, and the argument that froze `text` and `pin` is what withdraws it.** An unknown `kind` parses as `{kind: "unsupported", declared}` and the comment keeps its body, because the only thing that produces an unknown kind is a reader older than the writer, and the honest report is that a mark exists which this build cannot show. An unknown top-level field was refused instead, on the reasoning that it is the tampering and typo case. That reasoning was wrong in the same way the paragraph above says widening `text` would be wrong: the AEAD tag is what detects tampering, and refusing on a field name detected age. It was not theoretical. The published client predated two anchor kinds, and Jason's real comments on a client proposal came back as unreadable, which `spec/viewer.md` 6.4 state 4 shows to a person as written under a different key or altered in storage. So an unknown top-level field is now reported rather than refused: known fields parse, unrecognised names are collected into `unsupported_fields`, and the comment keeps its body. `unsupported_fields` and `unsupported` are both parser outputs and neither is ever written: sealing one would store a comment asserting a gap in somebody else's reader.

**A field inside a known kind is still refused**, because a reader that has the kind has all of its fields, so an extra one there is not age.

**`addresses` names the comment this one answers**, by service-minted id, and it is what makes a reply and an acknowledged update legible as answers rather than as more remarks. It is optional, absent on an ordinary comment, and capped at 64 bytes, which is a sanity bound rather than a format claim since the service mints the ids. **The sealed copy is the only authoritative one.** A caller may hand the same id to the service in the clear so it can route a notification to the person being answered, and that copy is operator-visible and operator-forgeable. A surface that showed a comment as addressed on the strength of the clear copy would be repeating the operator's word for it, so nothing resolves it from anywhere but inside the AEAD.

**Cell and path anchors.** Two kinds were added for structured formats, with no format version bump. Both are refused on read and on write when they break a rule below. An older reader shows them as `unsupported`.

- `cell` is `{kind, row, col}` with optional `row_end`, `col_end` and `sheet`. `row` is an integer from 1 to 16,777,216 and `col` from 1 to 16,384, in A1 coordinates of the published file, so CSV record 1 is row 1 even when a reader shows it as the header. An absent end means the same as its start, and the range is inclusive. `sheet` is 1 to 128 UTF-8 bytes with no control or bidi characters. A CSV carries none.
- `path` is `{kind, pointer}`. `pointer` is an RFC 6901 JSON pointer: empty, which is the whole document, or starting with `/`, with `~` only as `~0` or `~1`. It is at most 512 bytes, with no NUL or CR. A key that appears twice is addressed by its last occurrence, which is what `JSON.parse` keeps, so a writer never points at an earlier duplicate.
- A cue comment uses the existing `time` kind, with `t` as the cue's start and `t_end` as its end. No new kind is added for it.
- Unknown fields inside either kind are refused, as they are for every known kind.

**A suggestion is an optional sealed `suggestion` object.** Version 1 is `{v: 1, mode, replacement}`, with `mode` equal to `replace`, `after`, or `before`. `replacement` is a well-formed string of at most 2048 UTF-8 bytes. It excludes U+0000 through U+0008, U+000B through U+001F, U+007F, U+202A through U+202E, and U+2066 through U+2069; LF and TAB are allowed. `replace` must change `exact`, and an empty replacement deletes it. `after` and `before` insert beside `exact`, which stays in place, and require a nonempty replacement. A suggestion requires a `source` anchor and forbids `addresses`. Version 1 refuses unknown fields.

**A suggestion acknowledgement carries `suggestion_outcome`.** Its value is `accepted`, `superseded`, `declined`, or `deferred`. The acknowledgement requires sealed `addresses` and forbids both an anchor and a suggestion. Only an acknowledgement authored by the publisher counts as an outcome.

Readers drop a suggestion with an unknown primitive `v` and report `suggestion` in `unsupported_fields`; a missing or non-primitive `v` is malformed. An unknown string outcome is dropped and reported as `suggestion_outcome`, while a non-string outcome is malformed. A known suggestion paired with an unsupported anchor retains its payload, but a null anchor or another known anchor kind is malformed. Writers refuse every field a reader would drop. Null optional fields are omitted when sealing.

The comment key, ciphertext framing, 8192-character ciphertext cap, and format version stay unchanged. JSON escaping can make a replacement that fits its own byte cap exceed the ciphertext cap; that comment is refused rather than truncated. Older forward-tolerant readers retain the comment body and report the source anchor as unsupported.

**The writer runs the reader's predicates rather than a second copy of them.** `encryptComment` parses the whole serialized plaintext before sealing it, so a value this package will seal is a value it can open. Two independently written validators drift, and the shape of that drift is a comment that is accepted at write time and unreadable afterwards, which is unrecoverable because the ciphertext is all that survives.

**A failed comment decrypt carries no cause**, per 3.5. A wrong key, a truncated value, and a tampered nonce are one symptom from this side, and a caller must not tell a reader which it was. A caller displaying a list of comments must nonetheless report the failure rather than drop the row: a quietly shortened list reads as the whole conversation, and agreement is the wrong thing to infer from a comment nobody could open.

**`display_name` is decoration and never identity.** The identity of a commenter is the verified address the service holds (`docs/frame.md`), and the name is untrusted display text living inside the ciphertext where the service cannot read it. It aliases the attribution and never replaces it.

### 3.14 Share proof

**This section describes public reliks.** A private relik's share and decision calls carry no `share_proof`: the server replaces that check with an access check (plan 4.7), and a private relik registers no `share_verifier`. The verifier and proof below do not apply to a private relik.

A reader can enroll addresses in a relik's change notices from the web viewer, and only a holder of the key may do that. The service never sees the key, so it cannot check possession directly. What it can check is a value only a key holder can compute: the publisher's client registers the SHA-256 of a key-derived proof when it publishes or republishes, and a reader presents the proof itself when sharing. The service compares hashes and learns the proof, which decrypts nothing.

**The derivation is HKDF-SHA256, zero salt, info `relic/share-proof/v1`, 32 bytes.** In code:
`deriveShareProof(keyBytes)` imports the raw 16-byte fragment key as HKDF key material, passes a zero-length salt and the info string `relic/share-proof/v1`, and expands to 256 bits (32 bytes).

**The verifier is the lowercase hex SHA-256 of the proof.** In code:
`shareVerifierFor(proof)` hashes the 32 proof bytes with SHA-256 and formats the result as a 64-character lowercase hex string.

**Verifier registration happens at publish and republish.** The publishing client computes `share_verifier = await shareVerifierFor(await deriveShareProof(key))` and sends it in the JSON request body of `POST /api/relics` and `POST /api/relics/{id}/republish`. The server stores `shareVerifier` on the relik row.

**Reader sharing presents the proof.** A reader in the web viewer holding the fragment key derives `proof = await deriveShareProof(keyBytes)` and submits `share_proof: base64url(proof)` in `POST /api/relics/{id}/share` alongside their authenticated session cookie. The server checks that the base64url-decoded proof is exactly 32 bytes and verifies `timingSafeEqual(sha256Hex(proof), row.shareVerifier)`.

**The decision gate reuses the share proof.** Recording a decision (`POST /api/relics/{id}/decisions/options` and `POST /api/relics/{id}/decisions`) and listing decisions with key proof (`POST /api/relics/{id}/decisions/list`) present the exact same 32-byte `share_proof` derived via `deriveShareProof(keyBytes)`. The server verifies `timingSafeEqual(sha256Hex(proof), row.shareVerifier)`. Reusing the share proof avoids introducing a second derivation label (`relic/decision-proof/v1` was rejected because any key holder can derive both, and a second label would add redundant storage and leave pre-existing reliks with registered share verifiers undecidable). Like sharing, decision calls learn the proof, which decrypts nothing.

**What the service learns:** the verifier at publish, the proof at share, and neither decrypts anything. The proof derivation uses a dedicated HKDF info label (`relic/share-proof/v1`), so the proof is cryptographically independent of the content-encryption key, the nonce, and the comment key (`relic/comments/v1`). Knowledge of the proof or its verifier yields no information about the relik's plaintext.

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

- **Rational time coordinates:** Preserve the decoded binary64 `{value, rate}` pair instead of converting an anchor to seconds. Same-rate values compare strictly, and mixed-rate ordering resolves ties, overflow, and underflow without a global epsilon. This preserves the represented numeric values, not an arbitrary textual rational that was already rounded before parsing. Ranges are half-open. A duration of zero represents a point comment.
- **Track and outer binding:** `track_id` must identify an actual `Track.1` inside the selected `Timeline.1`; `track_id: null` anchors to the timeline as a whole. A point must lie in the original exposed Timeline and, when selected, Track range (`start <= point < end`); a nonzero range may end exactly at the outer end. An `item_id` retains its existing ancestry plus nonempty exposed-overlap rule, rather than requiring full item containment.
- **Gaps and source-first refusal:** An explicit Gap and an empty exposed Timeline tail are valid source locations even when they have no media or no source spans. After the reader obtains the sealed original revision and validates its digest, it validates this source location before requesting or projecting a current revision. An invalid original location is unresolvable and carries no artifact-derived source context or current mapping.
- **Decoder-only compatibility:** A private decoder-local near-zero policy may preserve established packet-boundary playback behavior after conversion to the source clock. It does not change the stored anchor, source spans, source contributions, original diagnostic arrays, projections, or the strict rational ordering used for source selection. Playback status excludes only the exact diagnostic objects handled by the current contribution's qualified decoder policy; genuine, unknown-availability, packet-timing, and unrelated failures remain unresolved.
- **Envelope and transport limits:** Like existing anchors in 3.13, the anchor JSON is encrypted inside the comment body payload under `relic/comments/v1`. The serialized anchor payload is budgeted under 1,536 UTF-8 bytes before encryption, and the overall ciphertext must not exceed the existing 8,192 base64url character limit.
- **Historical revision integrity:** The anchor seals `relic_version` and `document_sha256` inside the AEAD ciphertext. The clear comment row version and sealed OTIO `relic_version` must agree: the writer preserves that equality, and the reader refuses a disagreement before minting. Resolving an anchor fetches and decrypts the original revision's document under format version 1. Safe projection to the current revision (`same`, `mapped`, `partial`, `changed`, `ambiguous`, `missing`) is reported as an auxiliary mapping without altering the immutable original anchor.
- **Interval-boundary projection:** Before inverse arithmetic, an interval endpoint may reuse a current exposed boundary only when its original source witness has a unique exact match. Matching both distinct current boundaries is ambiguous; numerical proximity is not a match. When both interval endpoints match opposite current boundaries, preserve the literal exposed range rather than reconstructing its duration by subtraction. Unmatched endpoints retain the existing inverse, clipping, and partial-result rules. Point projection is unchanged.
- **Identity and media continuity:** Derived node IDs fingerprint canonical OTIO JSON after removing only `metadata.relic.id`; media indexes and digests never alter that fingerprint. Across distinct parsed documents, a projected reference must have the same canonical referenced-entry facts and a SHA-256 for every indexed entry. A missing or unequal digest, an unmatched indexed reference, or an image-sequence witness beyond the 65,532-frame budget is `changed`. Resolving against the same parsed document object remains `same`. A Stack or Track item anchor locates its container by identity only and projects through the matched descendants it originally covered; a descendant that is gone or fails media continuity contributes nothing, and when nothing survives the result is `missing`.
  Duplicate-renamed authored IDs retain their original authored IDs for matching; if a current revision has multiple candidates with the same authored ID or fingerprint, projection is `ambiguous` and never guesses one.
- **Bundle paths:** Every exported `bundle_path` is one canonical archive entry name, decoded exactly once, or `null`; raw authored URLs remain only in their media references. Image sequences use OpenTimelineIO URL joining: a slash is inserted only for a non-empty base without a trailing slash, the signed padded frame follows the prefix, and the raw URL remains otherwise unchanged. Their count is `trunc(rescale(duration, rate / frame_step))`; omitted fields use the official defaults, and an absent range, non-positive rate, or non-positive count is a valid zero-image sequence. Relative references trim, remove a raw query or fragment, strip only a relative `file:` prefix, percent-decode once, treat backslashes as separators, and discard empty or `.` segments. They refuse control characters, malformed escapes, absolute paths, non-`file:` schemes, drive paths, empty results, and every `..` segment. A sanitized path already under `media/` stays there; every other path becomes `media/<path>`. Present sequence fields must be representable within safe integer, padding, URL-length, and 65,532-entry limits. Missing sequence frames are omitted when packed and playback applies the reference's missing-frame policy; missing external-reference targets still refuse publication.
- **No container version bump:** Format version 1 and envelope framing remain unchanged. Standard `.otiod` directory inputs are packaged into standard single-entry `.otioz` archives before encryption, preserving the single-entry container invariant.

### 3.16 The version digest

To bind an approval or rejection decision to exact content without requiring plaintext disclosure or server-side decryption, Relik defines the version digest.

**Definition:** `versionDigest` is the 64-character lowercase hex SHA-256 of the exact bytes of that version's stored ciphertext container object (`{ciphertext_prefix}/{id}` for version 1, and `{ciphertext_prefix}/{id}/v{n}` for version `n >= 2`).

**Who computes it:**
- The server computes it by streaming the stored ciphertext object upon upload completion (`POST /api/relics/{id}/complete`) or lazily at the first stat or mint if completion was skipped, caching the result on the relik row (`RelicRow.versionDigests[String(version)]`).
- The publishing client computes it over the ciphertext container bytes during `relic_publish` and `relic_republish`, returning `version_digest` in `structuredContent`.
- The viewer computes it over the downloaded ciphertext bytes immediately after fetch and length verification (`ReadyView.versionDigest`).

**Container invariant:** No format version bump is required. The digest is computed over the raw RFC 8188 container bytes as stored in Cloud Storage. It does not alter container headers, salt, or record structure. It enables cryptographic binding between the viewer's decrypted view and the server's stored version record: when a reader confirms an approval or rejection, the server verifies that the client's `version_digest` matches the recorded digest for that version, refusing with `409 decision_digest_mismatch` if they diverge.

**For a private relik, the seal signs the version digest.** The seal statement carries `ciphertext_sha256`: the same 64-character lowercase hex digest of the stored ciphertext bytes. The server checks it against its own digest of the stored object and refuses a mismatch (`seal_digest_mismatch`). The seal is signed by an owner device or by the owner identity (plan 4.3 and 4.12). The container invariant above is unchanged.

### 3.17 Private key delivery

A private relik's key never sits in its URL. Each version has its own 16-octet content key, and each reader receives that key inside a wrap made to the reader's public key. The service stores the wraps and the seals, and never a plaintext key. Everything in this section applies to private reliks only. Public reliks keep the fragment (2.1).

**The wrap.** A wrap is one HPKE message in base mode, single-shot at sequence zero ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html)). The suite is KEM `0x0010` DHKEM(P-256, HKDF-SHA256), KDF `0x0001` HKDF-SHA256, and AEAD `0x0001` AES-128-GCM, with these inputs:

- `info = UTF8("relic/wrap/v1") || 0x00 || UTF8(relicId) || u32be(version)`. The relik ID is 26 characters, and the version is an integer from 1 to 2^32 - 1.
- `aad` is the recipient's `kemKeyId`: the 32 raw bytes of SHA-256 over the recipient's 65-byte SEC1 KEM public key.
- `plaintext` is the 16-byte version key.
- `enc` is the 65-byte SEC1 encapsulated key, and `ct` is 32 bytes: the 16-byte key and its 16-byte tag. Both are base64url on the wire.

The wire record names its recipient by `recipient_key_id`, the lowercase hex of that `kemKeyId`. A wrap opens only for the relik, version and recipient it was made for. Any other combination fails with one error, and the caller learns nothing about which input was wrong. The code is `wrapVersionKey` and `unwrapVersionKey` in `packages/relic-format/src/private.ts`.

**Who receives a wrap.** A version is wrapped to its required recipient set: the owner identity, each owner device that is not revoked and not expired, the recovery identity when one is designated, and each grantee whose grant is active (plan 4.12). The client that writes the wraps checks every recipient first. Grants, device certificates and the recovery designation must be signed by the pinned owner identity (plan corrections 5 and 22), and a recipient whose keys do not hash to its identity ID is refused before any wrap is made (plan 4.16). The service cannot add a recipient of its own.

**The identity.** An identity is two P-256 key pairs: an ECDH key for HPKE and an ECDSA key for statements. Both are generated with WebCrypto `generateKey`, not derived from a passkey (plan correction 4). The private halves are kept in an **identity bundle**, encrypted under a key-encryption key (KEK) that comes from the passkey's PRF output:

- The PRF is evaluated with `eval.first = UTF8("relic/identity-prf/v1")`. WebAuthn Level 3 defines the `prf` extension, and its salt is SHA-256 over `WebAuthn PRF`, a zero byte, and the `eval.first` input ([WebAuthn Level 3, section 10.1.4](https://w3c.github.io/webauthn/)).
- `KEK = HKDF-SHA256(ikm = PRF output, 32 bytes; salt = raw credential ID bytes; info = UTF8("relic/identity-kek/v1"); 32 bytes)`, imported as a non-extractable AES-256-GCM key.
- The bundle is base64url of `nonce(12) || ciphertext`, where the plaintext is `canonicalJson({"kem":{"d","x","y"},"sig":{"d","x","y"},"v":1})` and the AAD is `UTF8("relic/identity-bundle/v1") || 0x00 || identityId (32 raw bytes) || raw credential ID bytes`.

Each bound passkey has its own bundle, and a bundle opens only under that passkey's PRF output and that credential's raw ID. Opening one rebuilds the keys as non-extractable and checks that the public halves hash to `identityId` (3.18). The PRF output never reaches the service, because the client's serializers omit extension results (plan correction 19).

**Statements.** Each owner action and each identity change is a statement: canonical JSON under a kind label. `statementBytes(kind, statement)` is `UTF8("relic-statement/v1\n" || kind || "\n" || canonicalJson(statement))`. The signature is ECDSA P-256 over SHA-256, IEEE P1363 `r || s`, 64 bytes, base64url. Who signs a statement, and whether WebAuthn attests it, depends on its kind:

| Kind | Signed by | Attested by WebAuthn |
|---|---|---|
| `identity_register`, `identity_bind`, `identity_settings` | the identity | yes |
| `access_request` | the requester's identity | yes |
| `grant`, `revocation`, `republish`, `delete`, `device_cert`, `device_revocation`, `recovery_designation` | the owner's identity | yes |
| `invite` | the owner's identity | yes, under the grant purpose |
| `invite_claim` | the claimant's identity | no |
| `relic_settings` | the owner's identity, on a private or a public relik | yes |
| `signing_request`, `signing_cancel` | An owner identity (browser, passkey attested), or an owner device (relic-mcp, not attested) | Yes for an identity, no for a device |
| `signature` | Private: the signer's identity. Public: nobody (`identity_signature` is `''`) | Always |
| `open_receipt` | The reader's identity | No |
| `seal` | an owner device or the owner's identity | no |
| `device_enroll`, `device_request`, `owner_bind`, `private_publish` | a device | no |

The field list for each kind is `StatementMap` in `private.ts`. Strict parsing refuses an extra field, a missing field, or a wrong type, and the known-answer fixtures freeze the bytes (3.18).

**Attestation.** A WebAuthn-attested action is verified against a challenge the server issues. The server issues a random 32-byte nonce that expires, and the challenge is `attestationChallenge(nonce, statements)`: the SHA-256 of `UTF8("relic-attest/v1") || 0x00 || nonce || SHA-256(statementBytes_1) || ... || SHA-256(statementBytes_n)`, with the statements in request order and n at least 1. Its base64url is the WebAuthn challenge. The server refuses any statement whose `at` is more than 300 seconds from its clock. The service stores each owner action's full assertion with its statements, so a stored grant can be re-verified from the stored bytes alone (plan decision 3).

The attestation purposes `relic_settings`, `signing_request`, `signing_cancel`, and `sign` cover the corresponding statement kinds `relic_settings`, `signing_request`, `signing_cancel`, and `signature`, respectively. The `sign` nonce is issued by the signing options route, not the general attestation nonce route.

**The seal.** A version's seal is a signed statement of `access_epoch`, `at`, `ciphertext_sha256`, `key_commitment`, `owner_epoch`, `recipient_key_ids`, `relic_id`, `signer_id` and `version`. `ciphertext_sha256` is the version digest of 3.16. `key_commitment` is the key commitment defined in 3.18. `recipient_key_ids` is the sorted list of the recipients' `kemKeyId` hex values that the sealer intended to wrap to, and `signer_id` is the signing device's or identity's ID. Before a reader decrypts a private version, the viewer checks that the wrap opens, that the seal's signature chains to the owner identity (directly or through an owner device certificate), that the unwrapped key matches `key_commitment`, that the ciphertext's SHA-256 equals the sealed digest, and that the owner identity matches the one pinned for this relik at first open (plan decision 4). The reader does not have to be in `recipient_key_ids`: a wrap addressed to the reader's own KEM key id that unwraps is enough, because HPKE binds the relik id, the version and the recipient. A grant made after a version was sealed can therefore open that version. A failed check is a refusal, not a decryption error.

**The owner pin, and its limit.** The viewer pins the owner identity per relik at first open and refuses a different owner later, with no button to accept one. At first open the reader has only the service's report of the owner, so a forged owner is caught only if the reader compares the owner fingerprint out of band (plan correction 22). This is an accepted residual (plan section 8, item 7).

**Grants and revocation.** A grant wraps exactly the versions it names. A revocation deletes the revoked identity's wraps for every version and republishes the current content as a new version under a fresh key, which only the remaining recipients receive (3.10, plan 4.12). A revoked reader keeps whatever they already opened.

**Invitation keys.** An invitation uses a fresh P-256 ECDH key pair. Its identifier is the lowercase hex SHA-256 of its 65-byte public key. The owner signs the invited address, public key, expiry and version list in an `invite` statement. Each listed version is wrapped to that key using the normal HPKE wrap. The invitation link carries `?invite=<id>#k=<d>`, where `d` is the 32-byte private scalar in unpadded base64url. The owner sends that key-bearing link, and the service never receives the fragment. The invitee imports `d` with the signed public key's `x` and `y` as a P-256 JWK. A claim signs the invitation ID and versions under the claimant's identity.

### 3.18 Parameter table

The crypto parameters, the HPKE implementation rules, and the identifiers and fingerprints built on them. These are the private-share contract.

| Use | Primitive | Parameters |
|---|---|---|
| Content | RFC 8188 `aes128gcm`, unchanged | 16-byte key: per relik (public), per version (private) |
| Comment key | HKDF-SHA256, unchanged | ikm = that version's key (for a public relik, the fragment key), salt empty, info `relic/comments/v1`, 16 bytes |
| Wrap | HPKE RFC 9180 base mode | KEM 0x0010 DHKEM(P-256, HKDF-SHA256), KDF 0x0001 HKDF-SHA256, AEAD 0x0001 AES-128-GCM; info = UTF8(`relic/wrap/v1`) ‖ 0x00 ‖ UTF8(relicId, 26 bytes) ‖ u32be(version); aad = recipient kemKeyId (32 raw bytes); pt = 16-byte version key; `enc` 65 bytes; `ct` 32 bytes |
| PRF salt | WebAuthn PRF `eval.first` | UTF8(`relic/identity-prf/v1`); the browser hashes it with the `WebAuthn PRF` prefix |
| Identity KEK | HKDF-SHA256 | ikm = PRF output (32 bytes), salt = raw credential id bytes, info = UTF8(`relic/identity-kek/v1`), 32 bytes, used as an AES-256-GCM key |
| Key commitment | HKDF-SHA256 | ikm = the 16-byte version key, salt = empty, info = UTF8(`relic/key-commit/v1`) ‖ 0x00 ‖ UTF8(relicId, 26 bytes) ‖ u32be(version), 32 bytes, lowercase hex in the seal. HPKE base mode does not authenticate the key it opens, so an opener compares this value with the signed seal before it uses the key. |
| Identity bundle | AES-256-GCM | 12-byte random nonce; aad = UTF8(`relic/identity-bundle/v1`) ‖ 0x00 ‖ identityId (32 raw bytes) ‖ raw credential id; pt = UTF8(canonicalJson(`{"kem":{"d","x","y"},"sig":{"d","x","y"},"v":1}`)); stored as base64url(nonce ‖ ciphertext) |
| Statement signature | ECDSA P-256, SHA-256 | IEEE P1363 `r ‖ s`, 64 bytes, base64url; over `statementBytes` |
| Attestation challenge | SHA-256 | UTF8(`relic-attest/v1`) ‖ 0x00 ‖ nonce (32 bytes) ‖ SHA-256(statementBytes₁) ‖ … ‖ SHA-256(statementBytesₙ), n ≥ 1, in request order; base64url is the WebAuthn challenge |

HPKE implementation notes, normative:

- `LabeledExtract(salt, label, ikm) = HMAC-SHA256(salt, "HPKE-v1" ‖ suite_id ‖ label ‖ ikm)`. WebCrypto refuses a zero-length HMAC key, so an empty salt is passed as 32 zero bytes. The result is identical, because HMAC zero-pads a short key.
- `LabeledExpand(prk, label, info, L) = the first L bytes of HMAC-SHA256(prk, I2OSP(L, 2) ‖ "HPKE-v1" ‖ suite_id ‖ label ‖ info ‖ 0x01)`, for L ≤ 32.
- `suite_id` is `"KEM" ‖ 0x0010` for the KEM and `"HPKE" ‖ 0x0010 ‖ 0x0001 ‖ 0x0001` for the HPKE context.
- `DH` is WebCrypto ECDH `deriveBits(256)`, the x-coordinate. `enc` and public keys are SEC1 uncompressed (`exportKey('raw')`, 65 bytes, prefix 0x04). Importing a peer key with `importKey('raw')` validates the point.
- Only single-shot Seal and Open at sequence 0 are implemented. Export, PSKs, the authenticated modes and sequence numbers past zero are not implemented, because a wrap never needs them.
- Open takes the recipient as `{publicKey, dh(peer)}`, so a WebCrypto key or a Secure Enclave helper can supply the DH.
- `packages/relic-format/test/hpke.test.ts` pins each step to RFC 9180 Appendix A.3.1 (base setup) and A.3.1.1 (sequence 0 encryption).

Canonical JSON. `canonicalJson(value)` accepts strings, booleans, `null`, safe integers (`Number.isSafeInteger`, with `-0` written `0`), arrays and plain objects. Object keys are sorted in default JS string order, there is no whitespace, and strings and numbers are serialized with `JSON.stringify`. Anything else throws.

Identifiers and fingerprints:

- `kemKeyId = SHA-256(kemPub65)`, 32 raw bytes. `recipient_key_id` on the wire is its lowercase hex.
- `identityId = hex(SHA-256(UTF8("relic/identity/v1") ‖ 0x00 ‖ kemPub65 ‖ sigPub65))`.
- `deviceId = hex(SHA-256(UTF8("relic/device/v1") ‖ 0x00 ‖ kemPub65 ‖ sigPub65))`.
- Identity fingerprint: the first 20 bytes of `SHA-256(UTF8("relic/fp/v1") ‖ 0x00 ‖ identityId (32 raw bytes) ‖ UTF8(normalizeEmail(email)))`. `normalizeEmail` trims the address and lowercases ASCII letters only (`packages/relic-format/src/email.ts`).
- Device fingerprint: the first 20 bytes of `SHA-256(UTF8("relic/device-fp/v1") ‖ 0x00 ‖ deviceId (32 raw bytes))`.
- Encoding: Crockford base32 over the relik ID alphabet `0123456789abcdefghjkmnpqrstvwxyz`, most significant bit first. 160 bits make exactly 32 characters, stored and compared lowercase. The display form is uppercase, in eight groups of four separated by single spaces.
- Typed input: remove all whitespace and `-`, lowercase, fold `i` and `l` to `1` and `o` to `0`, require 32 characters of the alphabet, and compare with the locally computed value in constant time.
- Every fingerprint a browser or relic-mcp shows is computed locally from public keys. No API returns a fingerprint field; the owner compares the locally computed fingerprint.

These definitions are frozen once any production private relik is sealed. Changing a label, field or encoding then needs a new versioned label and dual support. The known-answer fixtures in `private.test.ts` and the RFC 9180 vectors in `hpke.test.ts` guard them (plan section 7, item 10).

### 3.19 The OpenTimelineIO program

**Scope.** This section applies to a relik whose single entry is an OpenTimelineIO `.otioz` archive. The envelope, the fragment, the record layout, and the content identity of `content.otio` are unchanged. No format version bump is claimed on that basis, because whether an older reader tolerates the extra archive members is not established and is a launch check.

**Members.** A program archive holds `content.otio`, which is never modified, the members the 2026-10-20 decision already packages, `relic/program.json` (DEFLATE, schema `relic.otio.program/1`), and one `relic/program/timeline-<i>.mp4` per rendered timeline (STORED). Those are the only entries under `relic/program`. Every timeline record has `status` `rendered` or `unavailable`. Every archive published under this section contains `relic/program.json`, including one whose timelines are all unavailable.

**Identity.** `document_sha256`, `relic_version`, and comment anchors are computed over `content.otio` alone. The program is a derived rendering and changes no anchor's meaning.

**Three states a viewer must tell apart.** `readOtioProgramArchive` in `otio-program.ts` decides which applies. *Legacy:* it returns no program, because the archive has no `relic/program.json` and no other `relic/program` entry. The archive plays under the rules in force when it was published, and absence is not an error. *Available:* it returns a verified program. The manifest parses against `relic.otio.program/1`, its `document_sha256` matches `content.otio`, every MP4 matches its recorded sha256 and bytes, timing agrees with the timeline, and the browser supports the codec. *Unavailable or invalid:* the reader throws an `OtioProgramError`, which covers any `relic/program` entry without a manifest, a manifest that is not a DEFLATE file, an unexpected program entry, and any digest, size, or path failure. Alternatively, a timeline is `unavailable` with reason codes. Either way the viewer shows focus-only with the code or codes. A throw is never treated as legacy.

**Reason codes.** An unavailable timeline carries one or more reasons, each with a message and optionally `node_id` and `time`. The reason codes are exactly `OTIO_PROGRAM_REASON_CODES` in `packages/relic-format/src/otio-program.ts`: `unsupported-effect`, `unsupported-schema`, `unsupported-codec`, `unsupported-transition`, `missing-media`, `unsupported-browser`, `invalid-timing`, `encoder-unavailable`, `render-failed`, and `size-cap-exceeded`. A missing local Chrome has no code of its own and is `unsupported-browser`. A browser without H.264/AAC encoding is `encoder-unavailable`. Reader errors are not manifest reasons. They are the `OtioProgramErrorCode` union in the same file: `malformed-manifest`, `unsafe-path`, `archive-mismatch`, `digest-mismatch`, and `size-cap-exceeded`. The reader throws these, and no partial result is returned.

**Size.** The whole plaintext archive stays within the 500 MiB cap in section 3.11. The program bound is aggregate: the manifest and every rendered program together stay at or under 100 MiB, not per timeline. A publisher plans against the reader's limits: the archive size, the expanded and DEFLATE totals, the manifest's 16 MiB cap, the central directory's 16 MiB cap, and an entry count below the 0xFFFF sentinel. A document with more than 256 timelines is refused. The current renderer uses one 1280x720 output; the proposed resolution ladder is not implemented. A timeline that cannot fit is unavailable with reason `size-cap-exceeded`. The reader also throws `size-cap-exceeded` for an oversized manifest or program entry, using the limits in `otio-program.ts`.

**Never approximate, and never composite.** A timeline is rendered exactly or not at all. No partial, lower-fidelity, or substituted program is stored. A timeline with no valid program is focus-only: the viewer does not composite it from original media, and it offers focus on tracks and clips only.

**Privacy.** The manifest and MP4s sit inside the ciphertext. No program field enters object metadata, the grant request, or the relik row (section 3.2). The length leak in `service.md` section 5 covers the larger total, and no new field reaches the server. Rendered program output is plaintext and is held in memory only, within the program bound. It is never written to disk. This constraint is shared with `publish.md` 4.8, which is unchanged.

### 3.20 Folder envelope and manifest

Version 2 record 0 holds big-endian fields: version `u8` equal to 2, folder name length `u16`, UTF-8 name bytes, entry count `u32`, manifest length `u32`, and content length `u64`. The name is untrusted display text and may be empty. Its encoded length is at most 1,024 bytes. The entry count is 1 to 5,000, the manifest is 17 bytes to 4 MiB, and content length is a safe integer no larger than 500 MiB. It includes the manifest and all file bytes.

The manifest starts at content offset zero. It contains a `u32` default index, followed by one record per entry: `u16` path byte length and UTF-8 path, `u16` MIME byte length and UTF-8 MIME, and `u64` file length. The default index is below the entry count. Paths are 1 to 1,024 bytes and decode as UTF-8 without replacement; MIME is at most 255 bytes and is untrusted display metadata. Entry offsets are implicit: the first follows the manifest, and every later entry follows the previous one. The lengths must sum exactly to the declared content length, with no trailing manifest bytes.

Paths are NFC strings with 1 to 32 nonempty `/`-separated segments. No segment is `.` or `..`, or exceeds 255 UTF-8 bytes. A path excludes U+0000 through U+001F, U+007F through U+009F, backslash, U+061C, U+200B through U+200F, U+202A through U+202E, U+2060 through U+2064, U+2066 through U+2069, and U+FEFF. Its first segment cannot start with an ASCII drive prefix.

Entries appear in strictly ascending UTF-8 byte order. Exact duplicates, case-folded collisions across any path prefix, and a file also used as a directory are refused. Folding applies NFC, uppercase, lowercase, then NFC. The writer normalizes paths before checking; the reader refuses a noncanonical path rather than changing it.

An entry source may be an in-memory byte array or an asynchronous chunk source with its byte size known before encryption. The writer checks each source against that declared size. A source yielding too many or too few bytes aborts with `entry-size-mismatch`; a sink must discard any ciphertext already written. Record encryption holds bounded record buffers rather than the complete folder.

### 3.21 Passkey signing

A signature is a passkey assertion over one exact version. This section defines what a signature commits to, the request that asks for it, and the certificate that gathers the evidence. The code is `packages/relic-format/src/signing.ts` (`@relic/format/signing`) and `packages/relic-format/src/webauthn-verify.ts`. The service and relic-mcp verify with the same code, and the viewer runs it in the browser.

**Keys.** Every key comes from the content key, which is the 16-byte fragment key of a public relik or the version key of a private one. Each is HKDF-SHA256 with an empty salt:

- `signingKey = HKDF(ikm = content key, info = "relic/signing/v1", 32 bytes)`.
- The content MAC key is `HKDF(ikm = signingKey, info = "relic/signing/content-mac/v1", 32 bytes)`.
- The appearance key is `HKDF(ikm = signingKey, info = "relic/signing/appearance/v1", 16 bytes)`.

Holding the signing key confirms the file and reads the sealed layout and marks. It does not reveal the content key or the comment key (3.13).

**Content MAC.** `content_mac = hex(HMAC-SHA256(content MAC key, content))`, a standard HMAC computed over the streamed content. `content` is the bytes the content records decrypt to, after the envelope header. For envelope version 1 that is the file. For version 2 it is the whole stream, manifest included (3.20). A plain hash of the plaintext is not used, because it would let anyone holding a file test whether that file is stored (3.14).

**Sealed appearance.** The layout and each mark are sealed with AES-128-GCM under the appearance key. The sealed text is base64url of `nonce (12 bytes) || ciphertext || tag (16 bytes)`. The additional data is `UTF8(kind) || 0x00 || UTF8(relicId) || u32be(version)`, where `kind` is `layout` or `mark`, so a sealed layout does not open as a mark. The plaintext is canonical JSON with sorted keys and no whitespace. Numbers are finite and written in their shortest round-trip form, because rectangle coordinates are fractions and the statement serializer (3.1) takes integers only. A sealed text that is not the canonical form of what it opens to is refused. The plaintext cap is 16 KiB for a layout and 32 KiB for a mark.

**Layout.** `{v: 1, boxes: [{signer, page, rect}]}`. A box names a signer index, a page from 1 to 10,000, and a rectangle in unit coordinates under the rules of 3.1's AnchorRect. A signer has at most 20 boxes, and boxes are allowed only on a PDF. A signer with no box signs in the block after the document.

**Mark.** `{v: 1, name, strokes}`. The name is 1 to 128 UTF-8 bytes with no control or bidirectional characters. Strokes are null, or a list of at most 64 flat `[x0, y0, x1, y1, ...]` arrays holding at most 2,048 points in all. Each coordinate is in [0, 1] at three decimals.

**Statements.** Four kinds join the statement table of 3.17. Each is strictly parsed and signed over the bytes of 3.17.

- `signing_request` names the relik and version, `ciphertext_sha256`, `content_mac`, `layout_sha256`, the owner, the signers, the order (`parallel` or `sequential`), `require_opened`, and `signer_id` (the owner identity, or the owner device that signed the request). `layout_sha256` is the SHA-256 of the sealed layout's UTF-8 text. `request_id` is exactly 16 bytes. There are 1 to 20 signers, with no duplicate address after normalization. Either every signer carries an identity (a private relik) or none does (a public relik), and `require_opened` needs identities.
- `signature` answers one request. It names the request by `request_sha256` (the SHA-256 of the request's statement bytes), the signer index, the signer address, and the signer's identity, which is null on a public relik. It carries `mark_sha256`, the SHA-256 of the sealed mark's text, and `opened_receipt_sha256`, which is set only when the request requires an opened receipt. Its `consent` is `relic/sign-consent/v1`, whose text is fixed in `SIGN_CONSENT_TEXT`.
- `open_receipt` is a reader's identity statement that its browser decrypted and checked the named version.

**The passkey challenge.** A passkey answers `attestationChallenge(nonce, [statement bytes])` as defined in 3.17, the same construction used for attested owner actions. The nonce is 32 bytes and single-use, which the service enforces against its stored nonces.

**Certificate.** A completed request yields a certificate with `format` `relic/signing-certificate/v1`. It carries the service origin and relying-party id, the relik and version, the digests, the signed request with its owner or device proof, and one entry per signer. Each entry holds the signed statement, the identity signature, the sealed mark, the passkey assertion, and the service's unsigned times. `signing_key` is present only in a copy that a reader's viewer or relic-mcp built. The certificate is strictly parsed, and an unknown field is refused.

**Verifier.** `verifySigningCertificate` runs offline. A report with owner trust `unchecked` proves internal consistency only, not that an independently trusted owner made the request. `valid` is false until the caller supplies a matching independently obtained `trustedOwnerIdentityId`. Private signer identity pins may also be supplied by index; a mismatch makes `valid` false. The trust report marks each principal `matches`, `mismatch`, or `unchecked`. Public signer passkeys remain trust-on-first-use, not independently authenticated.

| Check | Passes when |
|---|---|
| `format` | The certificate parses strictly, the origin is a bare origin whose host is the relying-party id, and the origin equals `expectedOrigin` when one is given. |
| `request_statement` | The request parses and agrees with the certificate on relik, version, digests and owner, its layout digest matches, and its identities match the access class. |
| `request_signer` | An owner identity signed the request, or an owner device signed it under an owner-signed device certificate that was valid at the request time. |
| `request_attestation` | For an identity request, the owner's passkey assertion answers the request's challenge. |
| `signers_complete` | There is exactly one signature for each signer index. |
| `signature_statement` | Each signature parses. |
| `consent` | The consent is the one the signer agreed to. |
| `signature_binding` | The signature names this relik, version, digests, request and signer, and its `request_sha256` is the hash of the request. |
| `mark_hash` | The sealed mark hashes to `mark_sha256`. |
| `signature_webauthn` | The signer's passkey assertion answers the signature's challenge. |
| `signature_identity` | On a private relik the signer's identity is the one pinned for that signer and its key signed the statement. On a public relik the identity signature is empty. |
| `opened_receipt` | When one is required, the receipt parses, names the signer's identity, verifies under it, and hashes to `opened_receipt_sha256`. |
| `order` | On a sequential request, no signer's time precedes the time of the signer before. |
| `appearance` | Only when a signing key is given: the layout and every mark open under it. |
| `content` | Only when a signing key and the content are given: the content MAC matches the signed one. |

The assertion rules come from `webauthn-verify.ts`. `type` is `webauthn.get`. The challenge, the origin and the rpId hash match, and `crossOrigin` is not true. User presence and user verification are set, and the attested-credential flag is clear. Extension data, when present, is exactly one CBOR map that fills the rest of the authenticator data. Without it the data is exactly 37 bytes. The signature is ES256 over `authenticatorData || SHA-256(clientDataJSON)`, with the DER form converted to IEEE P1363, or RS256. The stored key carries no private part. The signature counter is checked by the service, against its own stored state, because it needs that state.

The portable verifier is stricter on trailing authenticator data: it rejects extra bytes when ED is clear, even if the assertion is correctly signed. The existing server assertion verifier accepts those bytes. The server also checks the stored user handle and, when supplied, the signature counter; the offline verifier has neither stored value. Every server signing attestation must pass the portable verifier as well as the server's stateful checks.

**What a certificate proves.** A certificate with matching owner trust and passing checks records that the passkeys in it approved this version. The certificate alone does not establish who held a passkey, that the signer is who the address suggests, or that the signature is legally binding. The owner's email is an unsigned `claimed` address, not authenticated by the owner identity id. The report's owner and private signer fingerprints are the authenticated 64-character identity ids derived from the public keys, not fingerprints incorporating an unsigned address. Signed statement times come from the signer's device; `recorded_at`, `completed_at`, and `served_at` are unsigned service records.

**What the verifier cannot check offline.** A receipt's `key_commitment` is checked against the seal by the service. The certificate does not carry the seal, so the verifier does not check it. The passkey's binding to an identity is checked by the service at registration, not by the certificate.


## 4. Routed to `shape`

Six items, and only these six. Each names what `shape` picks and what becomes specifiable once it does. Constraints established above are cited here rather than restated.

1. **The wire format and framing.** RFC 8188 `aes128gcm` is presumptive. Any substitute must provide four properties: range decryption, per-record AEAD, plaintext size derivable from encrypted length before decryption (3.3), and a header readable before allocation (3.1). Once picked: the exact byte layout, the `rs` default, and therefore the envelope header's field caps.
2. **Key length. 128 or 256 bits.** The encoding is not `shape`'s to pick. It's settled in 2.3 as unpadded base64url, and the terminal-character rule stated there is what excludes a 24-byte key, and therefore 192 bits, from the option set. Once picked: the fragment's exact length and a runnable `fragment-terminal-charset` check.
3. **ID entropy bit count.** Generation location is fixed in 1.3 as client-side, before the grant request, so what remains for `shape` is the number, floored at 122 bits (1.2). Once picked: the ID's length in characters, which is the primary reserved-word guard in 1.5.
4. **Whether the cap is on plaintext or ciphertext, and its value.** Constrained by 3.11. Once picked: the grant's signed size constraint and the worst-case egress arithmetic in the preconditions.
5. **Whether the container pads to size buckets.** Constrained by 3.3 and 3.11. Once picked: whether the viewer can show an exact size before decryption, and the egress multiplier.
6. **Whether object metadata is set at upload time at all.** Get the premises right, because this one is easy to close for the wrong reason. Two real constraints: the app server never sees the bytes on either leg, and it can't set the response headers GCS serves. Neither puts object metadata beyond its reach. It already holds bucket-mutating credentials, because delete-by-ID is a v1 control in the preconditions, and metadata is editable after the fact: "After you have created a custom metadata `key:value` pair, you can delete the key or change the value" ([GCS metadata](https://docs.cloud.google.com/storage/docs/metadata)). So it can patch or strip metadata post-upload on an object whose bytes it never handled. It can also pin what the client sets, because custom metadata rides `x-goog-meta-*` headers and Cloud Storage requires headers "prefixed with `x-goog-`" to be present in the canonical headers to be used in a signed request ([canonical requests](https://docs.cloud.google.com/storage/docs/authentication/canonical-requests)), so a grant that signs them fixes their values and a client can neither alter nor add one without invalidating the signature. Metadata here is settable, patchable, and pinnable. 3.2 already bars anything content-descriptive from living in it, so what's genuinely open is whether any is needed at all. Once picked: whether the grant must sign metadata constraints, and whether the blocklist scanner reads metadata or only object bytes.

## 5. What the sibling units inherit

- **`spec-service-surface`:** the ID is unguessable (1.2), so an expired relik **may** be distinguished from one that never existed. Reserved paths (1.5) beat IDs at the router, the table is append-only, and appends compare normalized forms. The length-leak disclosure (3.8) belongs in the published statement. Two rules about redirects. **The first splits on where the redirect lands, not on whether the origin changes.** Leaving the service, an explicit, possibly empty, fragment in `Location` is **mandatory**: a fragment-less `Location` inherits the original request's fragment, and RFC 9110 §17.11 scopes its remedy to ensuring that "redirects to other sites include a (possibly empty) fragment component in order to block that inheritance" ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)). The case that matters is the service origin redirecting to the usercontent origin, which would hand the key to the one origin the two-domain split exists to keep it from, along with any CDN or load-balancer redirect the application doesn't author that lands off the service domain, which is the one nobody audits. Staying inside the service, the fragment is **deliberately omitted** so inheritance carries the key through, and that gets said out loud because a blanket MUST reads as forbidding it. That half covers legacy or renamed paths, trailing-slash normalization, apex to `www`, and HTTP to HTTPS; the last two change origin without leaving Relik, and an empty fragment on any of them is a deleted key and a recipient on the "missing its key" screen. **The test is the destination's trust boundary, not its origin tuple.** The preferred form is that no inside-the-service redirect exists on the relik path at all, with HSTS preload on both registrable domains moving the scheme upgrade into the user agent. Second, because 1.1 issues no canonicalizing redirect, a relik is served on every accepted spelling of its ID. Cache keys, per-object download-cap accounting, and log correlation all normalize before keying, or they fragment across spellings and the cap stops being a cap.
- **`spec-service-surface`, on versions:** for a public relik, the mint serves the current version against the layout in 3.12, the per-object cap counts across versions, delete removes every version, and the republish endpoint's refusals (missing or wrong token, tombstone outranking a valid token) are that document's 1.7. A private mint serves a sealed version the caller holds a wrap for (3.12, 3.17).
- **`spec-viewer`:** for a public relik the fragment is stripped via `history.replaceState` (2.5), which obliges a copy-link affordance and a dead-page state after reload. The viewing origin sends `Referrer-Policy: no-referrer` (section 0). The class never routes (3.6), and the declared-versus-sniffed disagreement rule runs against the envelope header's declared mimetype and filename (3.6). Unknown versions refuse in both places for a public relik (3.7). A private relik refuses by its declared access and mint gating instead (3.7), and `idlen != 0` refuses after the fetch (3.4). A decrypt failure doesn't mean "wrong key" (3.5).
- **`spec-publish-contract`:** the client generates the ID and the key independently before requesting a grant (1.3), the server validates and refuses on collision (1.4), and **nothing finer than the eleven-value class, the client name, the optional publisher-declared plaintext title, and the cover raster (rendered by default and declined with `cover: false`, or generic for `otio` and `model`) crosses to the server** (3.2). The class does cross, it is telemetry item 1 in the frame, and the metric's second clause is computed from it.
- **`spec-publish-contract`, on republish:** public reliks keep the persisted relik key and take a fresh salt (3.10), and private reliks take a fresh content key per version (3.10, 3.17). The publish token crosses once in the first grant response while the server keeps only its hash, and the durable key-plus-token state that makes republish possible is that contract's to specify.
- **Every unit, on comments (3.13):** the comment key is derived from the relik's key bytes under `relic/comments/v1`: the fragment's for a public relik, and that version's content key for a private one. The envelope is `nonce(12) || AES-128-GCM` over two-field JSON in unpadded base64url, the caps are 4096 and 64 bytes of UTF-8 enforced by `@relic/format` before encryption, and unknown fields are refused. **The fragment and the container are unchanged, so nothing here is a format version bump.** What each sibling inherits from that: the service stores an opaque base64url string it cannot read and must not validate as anything but base64url; the viewer and the publishing client both derive the key from the key they already hold, which is the fragment for a public relik and the unwrapped version key for a private one; and any surface listing comments reports a decrypt failure rather than dropping the row, because a shortened list reads as agreement.
- **`spec-service-surface`, on private relics:** the server stores wraps, seals, grants, requests and an access log, and never a key. A private mint, key fetch, comment and decision is gated on an access check, not on possession of the ID (1.2, 3.7, 3.13, 3.14). Revocation stops serving the revoked identity at once and deletes its wraps for every version (plan 4.12). Expiry of a private relik is read-time: the server stops serving at expiry. One day after expiry the bucket removes the live objects (plan decision 7, `docs/design/storage.md` section 7.2). Deleted copies stay restorable under the bucket's soft-delete retention, whose value the repository does not set. Private ciphertext is therefore removed from live storage, not immediately and permanently erased.
- **`spec-viewer`, on private relics:** the viewer boots on the access mode the server declares, never mints a private relik without an access check, and runs the verification in 3.17 before it shows any version. It never writes a private relik's keys to the key vault and never offers a key-bearing link. It sends the service neither PRF output nor key bytes (plan 4.13, 4.15 and correction 19).
- **`spec-publish-contract`, on private relics:** a private publish and a private republish each use a fresh content key per version (3.10). A private publish carries device authorization over a `private_publish` statement. A revocation republish is authorized by the owner's identity and not by the publish token (plan correction 12 and 4.16). A private relik sends no title and no cover (plan 4.7).
