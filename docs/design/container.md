# Relic: the container, the key material, and the reference implementation

This document decides the four items `docs/spec/format.md` section 4 routes here, fixes the exact byte layout an implementer parses from, and names the writer.

Everything else in a stored object can be migrated or redeployed inside one TTL. This cannot. A relic encrypted under the wrong framing is unreadable forever, and a writer bug ships permanently into every object written under it. The name is the other decision with a closing window, it closes at the domain purchase, and it belongs to `design-topology-and-origins`.

`docs/frame.md`, `docs/preconditions.md`, and `docs/spec/format.md` are locked inputs. Nothing here reopens any of them.

The 4,096-octet record-size choice below is historical. The current writer's
default is 65,536 octets as recorded in `docs/decisions.md`; the 2026-11-10
500 MiB cap uses that default.

## 0. What this decides, and the two items it does not

`format.md` section 4 routes six items. Four are decided here:

- **4.1 the wire format and framing** (section 1)
- **4.2 key length, restated as IKM length** (section 2)
- **4.3 the ID entropy bit count** (section 7)
- **4.5 whether the container pads to size buckets** (section 4)

**4.4, whether the cap is enforced on plaintext or ciphertext and its value, is not decided here.** It belongs to `design-storage-grant-and-cost`, which holds the binding arithmetic in `service.md` 2.3. Section 4 supplies the conversion function that turns a plaintext cap into a ciphertext bound at version 1 and picks no number.

**4.6, whether object metadata is set at upload at all, is not decided here.** It belongs to the same sibling. This document places nothing in object metadata and needs nothing from it.

## 1. The wire format (4.1)

**RFC 8188 `aes128gcm`, unchanged and unextended.** No substitute was carried forward, because a substitute has to supply four properties that this coding supplies from its own specification.

- **Range decryption.** "A consequence of this record structure is that range requests [RFC7233] and random access to encrypted payload bodies are possible at the granularity of the record size. Partial records at the ends of a range cannot be decrypted" ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.txt)). `frame.md`'s wedge boundary makes this non-negotiable even though archive browsing is out of the first release.
- **Per-record AEAD.** Every record carries its own 16-octet tag, so a corrupted or substituted record fails locally instead of poisoning the whole object.
- **Plaintext size bounded from encrypted length before decryption** (`format.md` 3.3). The authenticated envelope carries the content length.
- **A header readable before allocation** (`format.md` 3.1). It is the object's first 21 octets.

### 1.1 The exact byte layout at `idlen = 0`

The content-coding header is `salt (16) | rs (4) | idlen (1) | keyid (idlen)`, so **21 octets** with `idlen = 0`:

| Absolute octet offset in the stored object | Field | Rule |
|---|---|---|
| 0 to 15 | `salt` | Fresh from the CSPRNG per relic (section 6) |
| 16 to 19 | `rs` | Unsigned 32-bit, network byte order |
| 20 | `idlen` | MUST be 0. Any other value is refused after the fetch (`format.md` 3.4) |

**These offsets are absolute, measured from octet 0 of the stored object.** Section 3.2's envelope table uses a different origin: offsets inside record 0's decrypted plaintext. The two coordinate systems run in parallel and are exactly 21 apart, so an implementer reading either table alone parses correctly and an implementer reading them together must not add offsets across them. Every offset in this document says which of the two it is.

Records follow immediately. Record `k` occupies octets `21 + k*rs` through `21 + (k+1)*rs - 1`, except the last, which is shorter. Record count is `ceil((L - 21) / rs)` for an object of `L` octets.

Inside a record: plaintext of "any length up to rs-17 octets", then a single delimiter octet, then zero octets to `rs-16`, then encryption adds 16 octets of tag. Per-record overhead is exactly 17 octets. "The last record uses a padding delimiter octet set to the value 2, all other records have a padding delimiter octet value of 1." The RFC floors `rs` at 18: "Values smaller than 18 are invalid." Section 3 floors it higher.

### 1.2 The reader takes `rs` from the header, never from a compiled-in default

**The reader parses `rs` from octets 16 to 19 of the object it is about to
decrypt.** The current streaming path also enforces a record-size bound of
65,536 octets. A writer default change must account for that reader bound.

**The failure it prevents.** `rs` lives in each object's own plaintext header, so moving the writer's default keeps every existing relic readable. That only holds if readers read it. The reference implementation compares a caller-supplied record size against the stream's and throws `Record size declared in constructor does not match record size in encrypted stream` ([lib/ece.js](https://github.com/webtorrent/wormhole-crypto/blob/master/lib/ece.js)). A viewer compiled with today's default that meets a relic written under tomorrow's throws on its first record, and the recipient lands on `viewer.md` 6.1's decrypt-failure screen, which `format.md` 3.5 already forbids reading as a wrong key. The recipient sees a bad-key symptom for a relic whose key is fine and whose bytes are intact.

Range decryption makes it worse rather than louder. `decryptStreamRange` takes `rs` as an input and computes which encrypted byte ranges to fetch from it, so a stale value fetches the wrong bytes. That fails a tag or a padding check somewhere downstream of the mistake, and the error names neither the record size nor the range.

**The implementation consequence is concrete.** Both `decryptStream` and `decryptStreamRange` need `rs` before they see the header, because both slice the stream into a 21-octet header chunk followed by `rs`-octet record chunks. So the viewer issues a separate read of the object's first 21 octets, parses `rs` and `idlen` from it, refuses on a non-zero `idlen`, and only then calls either function with the parsed value. This makes `format.md` 3.4's refusal point a deliberate step rather than a library side effect.

**That header read is asked for twice on the first range operation, and the second one is the implementer's to elide.** `decryptStreamRange` returns its own range list, and its first entry is `{ offset: 0, length: 21 }`, the header again. A viewer that hands each returned range straight to a fetch issues two requests for the same 21 octets: one to learn `rs`, one because the library asked. The caller supplies streams for those ranges, so the fix is local and needs no library change: keep the 21 octets already read and serve the first range from memory, issuing a network request only for the second. On the range path this is one saved round trip per open, which matters because the range path is the one the archive reader drives repeatedly.

The record size is carried per object. A change to the writer default also
requires checking the reader's accepted record-size bound.

## 2. The key material is input-keying material, and the cipher is AES-128 either way (4.2)

`format.md` 4.2 routes "Key length. 128 or 256 bits." Read as a choice of cipher strength, that is a category error, and it has to be restated before it can be decided.

**The coding is AES-128 and only AES-128.** RFC 8188 says the `aes128gcm` "content coding uses a single fixed set of encryption primitives. Cipher agility is achieved by defining a new content-coding scheme" ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.txt)). Choosing AES-256 as a cipher means leaving the coding, which forfeits every off-the-shelf implementation and reopens the irreversible framing decision. Nobody downstream reads a 256-bit key here as AES-256, because **no value of this decision produces AES-256. It produces AES-128.**

The fragment value is not the content-encryption key. It is the input-keying material that HKDF-SHA256 turns into the CEK using the header salt: "AEAD_AES_128_GCM requires a 16-octet (128-bit) content-encryption key (CEK), so the length (L) parameter to HKDF is 16." So the decision is IKM length, and the RFC puts no constraint on it.

### 2.1 The decision: a 16-octet IKM

**A public relic's fragment carries 16 octets of input-keying material drawn from the platform CSPRNG: one key per relic.** A private relic has no fragment. Each of its versions has its own 16-octet key, drawn fresh from the same CSPRNG, carried only inside that version's wraps and never in a URL (`format.md` 3.10 and 3.17).

**What a 32-octet IKM would buy is nothing an attacker has a reason to attack.** HKDF's output length here is fixed at 16 octets, so the CEK carries at most 128 bits of entropy regardless of how wide the input is. An attacker who wants the plaintext attacks the CEK at 2^128. Raising the IKM to 256 bits raises the cost of recovering the IKM and leaves the cost of recovering the CEK exactly where it was. A 32-octet IKM buys fragment entropy above the ceiling the coding imposes on the key it derives.

Multi-target batching does not change that. The salt is 16 fresh random octets per object and it is the HKDF salt, so CEKs across objects are independent by construction and no batch attack amortizes across the corpus. A private relic is one object per version, so each version's salt and key are independent of every other version's.

**The implementation-cost argument for 16 octets exists and it is not what this decision rests on.** The recorded prior is that the reference implementation's `Keychain` rejects any key that is not 16 octets, `Invalid byteLength: must be 16 bytes` ([lib/keychain.js](https://github.com/webtorrent/wormhole-crypto/blob/master/lib/keychain.js)), so exceeding 16 means driving the lower-level module directly. Section 5 decides to drive the lower-level module anyway, for reasons that have nothing to do with key length, and `lib/ece.js` imposes no length constraint: it takes an already-imported HKDF `CryptoKey`, and WebCrypto's `importKey` accepts raw HKDF input-keying material at 16, 24, and 32 octets, verified directly on Node v26.5.0. **So the implementation cost of a 32-octet IKM is zero once section 5 is decided, and the argument above stands alone.** The cryptographic argument is the only one left standing, because the convenient one is withdrawn here rather than leaned on.

**Corroboration from the RFC's own vectors.** Both published test vectors use a 16-octet IKM: `yqdlZ-tYemfogSmv7Ws5PQ` in section 3.1 and `BO3ZVPxUlnLORbVGMpbT1Q` in section 3.2, each 22 base64url characters.

### 2.2 The fragment's exact length and the `fragment-terminal-charset` check

`format.md` 2.3 settles the encoding as unpadded base64url and 2.2 fixes the version marker at a two-character prefix. So:

**A public relic's fragment is 24 characters: a two-character version marker followed immediately by 22 characters of key.** A private relic's URL has no fragment, so no marker is read for it (`format.md` 3.7).

**The marker is the version number written as two base-64 digits over RFC 4648 section 5's alphabet, most significant digit first.** Version 1 is `AB`. One integer in two encodings and no lookup table, so `format.md` 3.7's disagreement check between the fragment marker and the envelope header's version field is an integer comparison. The marker uses the key's alphabet, so the whole fragment validates against one character class.

**The two carriers have different ranges, and the narrower one is the format's range.** Two base-64 digits express 0 through 4,095. Section 3.2's envelope field is an unsigned 16-bit integer, which expresses 0 through 65,535, because a 16-bit field is what the envelope's fixed layout can align cheaply and a 12-bit field is not. **The version number runs 0 through 4,095.** An envelope version above 4,095 has no fragment marker that can equal it, so it can never agree with the marker that reached the viewer, and 3.7's disagreement check refuses it on the same comparison that catches a mangled prefix. That is the whole handling: the wider field needs no separate range check, because the narrower one is already the gate.

**The static half of `fragment-terminal-charset`.** 16 is not a multiple of three, so the final base64url character of a 16-octet value carries the low 2 bits of the final octet in a 6-bit index, giving index values 0, 16, 32, and 48. RFC 4648 Table 2 maps those to **`A`, `Q`, `g`, `w`** ([RFC 4648](https://www.rfc-editor.org/rfc/rfc4648.txt)). Verified exhaustively over all 256 values of the final octet. GFM's trailing-punctuation set is "`?`, `!`, `.`, `,`, `:`, `*`, `_`, and `~`", which "will not be considered part of the autolink" ([GFM spec](https://github.github.com/gfm/)). The intersection is empty, and the two characters GFM would eat, index 62 (`-`) and index 63 (`_`), are unreachable in the terminal position. Both RFC vector IKMs end in `Q`.

**The dynamic half stands as `format.md` 2.3 wrote it:** mint a batch of real relic URLs, run each through a GFM autolink renderer, and assert the extracted href is byte-identical to the input. The static half proves it for all keys; the dynamic half catches a renderer trimming something the spec does not mention.

## 3. The record size and envelope

### 3.1 Current record size

The current writer uses **`rs = 65,536` octets**, with 65,519 plaintext
octets available per full record. For nonempty content, record 0 holds the
envelope and is padded to a full record; content starts at record 1. For
empty content, record 0 is final and may be shorter.

The current maximum encoded envelope is 1,301 octets. The format
implementation is in `packages/relic-format/src/envelope.ts` and
`packages/relic-format/src/container.ts`.

The table below is the original design comparison. It led to the historical
4,096-octet proposal, not the current default.

| `rs` | Envelope block | A 2 KB relic on the wire | Per-record overhead | Records for 100 MiB of content |
|---|---|---|---|---|
| 1024 | 1,007 | 3,144 | 1.660% | 104,130 |
| 4096 | 4,079 | 6,182 | 0.415% | 25,708 |
| 16384 | 16,367 | 18,470 | 0.104% | 6,408 |
| **65536** | **65,519** | **67,622** | **0.026%** | **1,602** |

The original design recorded this comparison on Node v26.5.0. It describes
that measurement, not a guarantee for the current viewer:

| `rs` | Records | Decrypt, 64 MiB | Extrapolated to 100 MiB |
|---|---|---|---|
| 4096 | 16,453 | 201 ms and 214 ms | roughly 0.3 s |
| 16384 | 4,101 | 52 ms and 59 ms | roughly 0.09 s |
| 65536 | 1,025 | 26 ms and 25 ms | roughly 0.04 s |

The other arm, in octets rather than in dollars: 65536 spends 61,440 more octets on every relic than 4096 does. At 100,000 relics opened five times each that is 30.7 GB of extra egress in total, a few dollars at commodity rates.

The original decision favored 4,096 on the two grounds below. The current
writer default is 65,536.

1. A smaller envelope record reduces the fixed overhead of small objects.
2. Smaller records reduce range overfetch. At 65,536, a range can overfetch
   at most one record at either end.

RFC 8188's cited safe-encryption figure applies when the record size is a
multiple of 16. Both 4,096 and 65,536 satisfy that condition.

### 3.2 The envelope header's byte layout and field caps

The table below records the original proposed field layout. The current
encoded envelope layout and field caps are defined by
`packages/relic-format/src/envelope.ts`.

| Octet offset inside record 0's decrypted plaintext | Field |
|---|---|
| 0 to 1 | Version, unsigned 16-bit, network byte order. Carries the same integer as the fragment marker |
| 2 | Entry count. Exactly 1 in version 1 |
| 3 | Filename length, 0 to 255 |
| 4 | Declared mimetype length, 0 to 255 |
| 5 to 12 | Content offset, unsigned 64-bit, network byte order |
| 13 to 20 | Content length, unsigned 64-bit, network byte order |
| 21 onward | Filename, that many octets of UTF-8, then the declared mimetype, that many octets of US-ASCII |
| remainder | Zero fill to `rs - 17` |

**The field caps are 255 octets for the filename and 255 for the declared mimetype.** The filename cap is conservative against the filesystem the download lands on rather than equal to it, and the difference is worth stating because the mainstream per-component limits are counted in characters or in UTF-16 code units, not in octets. A 255-octet UTF-8 string is never more than 255 characters, because UTF-8 spends at least one octet per character, and never more than 255 UTF-16 code units, because the characters that cost two code units cost four octets. So a name that fits this cap fits a 255-character limit and a 255-code-unit limit both, and the cap can be under those limits but never over one. That is what `viewer.md` 1.9 rule 4 writes into `a[download]`.

The current maximum encoded envelope is 1,301 octets; fitting it in record 0
requires at least 1,318 octets including the 17-octet record overhead. The
current default of 65,536 leaves room for that maximum.

The current envelope parser rejects bytes left after the declared structure.
The record's RFC 8188 padding is removed before envelope parsing.

**Content offset is relative to the content stream, not to the plaintext stream.** Content octet 0 sits at plaintext offset `rs - 17`. A range decrypt of content octets `[a, a+n)` asks for plaintext offset `a + (rs - 17)`. Version 1 fixes the single entry's content offset at 0.

The pre-decryption length calculation is an allocation guard. The envelope's
content length is authenticated and authoritative after decryption.

**Zero-byte content.** Record 0 is final and carries delimiter 2. Its wire
length is 21 octets plus the encoded envelope length and 17 octets of record
overhead; it is not necessarily a full `rs`-sized record.

## 4. Bucket padding is refused (4.5)

**The container emits minimal padding only: a delimiter octet on every record, and the envelope block's zero fill.** No size buckets.

1. **The RFC argues against the implementable version of it.** "Even a good strategy can still cause size information to leak if processing activity of a recipient can be observed. This is especially true if the trailing records of a message contain only padding. Distributing non-padding data across records is recommended to avoid leaking size information." Appending a pad to reach a bucket produces exactly trailing pad-only records.
2. **The version that follows the RFC's advice costs the wedge.** Distributing padding across records means variable plaintext per record, and the RFC names the consequence: "random access to specific parts of encrypted data could be confounded by the presence of padding." It also destroys section 3.1's exact derivation.
3. **It is a fork, not a flag.** The reference implementation emits minimal padding only and has no bucket mode.
4. **The egress is paid by every recipient on every fetch forever.** A power-of-two bucket averages roughly a third again and worst-cases at double, on the one number wired to a kill switch that `preconditions.md` makes a deploy gate.
5. **What it buys is a small reduction in a leak the frame already conceded.** The operator holds the coarse renderer class as telemetry item 1 and reads length off the object regardless. `format.md` 3.8 puts what that buys the operator at "an image of roughly 2.4 MB", and bucketing turns it into an image of somewhere between 2 and 4 MB.

**Two consequences.**

Ciphertext length reveals an estimate of content length. The published
disclosure describes that length leak.

The current `encryptedSize(contentLength, rs)` function counts content bytes
and includes the padded envelope record. At the current 65,536-octet default,
`encryptedSize(524288000)` is 524,489,608 octets. A zero-byte file uses the
separate short-final-record case. The pre-decryption calculation remains a
bound; the encrypted envelope supplies the authenticated content length.

## 5. The reference implementation, and the second-implementation problem

The viewer is JavaScript, so a JS reader exists regardless. Any non-JS writer makes a second independent implementation of a format that can never change, and a writer bug in it is permanent.

**Decision: there is one implementation. The publishing binary and the viewer both use `webtorrent/wormhole-crypto`'s [`lib/ece.js`](https://github.com/webtorrent/wormhole-crypto/blob/master/lib/ece.js), pinned to an exact version. The writer is JavaScript.**

The module needs `crypto.subtle`, `ReadableStream`, `TransformStream`, and `TextEncoder` as globals. All four are present on the publishing binary's runtime, verified on Node v26.5.0.

**The `Keychain` facade is not used, and the reason is not preference.** All three of its stream methods call through without a record size, so all three are pinned to the library default of 65536, and `decryptStream` throws on any object written at a different one. The facade is unusable in both directions at any `rs` but its own. What it otherwise offers is Firefox Send's key-management shape: a metadata blob and an auth token Relic replaces with the envelope header and does not have. The three functions Relic needs live in `lib/ece.js` and every one of them takes `rs`.

**The named risk that comes with that.** [`package.json`](https://github.com/webtorrent/wormhole-crypto/blob/master/package.json) at 0.3.1 declares `"main": "index.js"` and no `exports` map, so `wormhole-crypto/lib/ece.js` resolves today. An upstream `exports` map would break the import. The remedy at the first upstream release that breaks it is to vendor the module, which is 13 KB of MIT-licensed code whose only imports are its own siblings.

**The pin is what turns that from a hazard into a scheduled decision.** The dependency is pinned to an exact version, not a range, so an upstream `exports` map cannot arrive through a fresh install, a lockfile refresh, or a transitive resolution. It arrives only when somebody types the new version number. The failure is therefore loud, local, and at a moment when a person is already looking at the dependency, which is the moment to vendor. That is the whole reason this risk is carried rather than pre-empted: an unpinned deep import would be a defect, and a pinned one is a decision with a known trigger.

### 5.1 The alternatives, priced

- **Rust, [`mozilla/rust-ece`](https://github.com/mozilla/rust-ece), 29 stars, the only maintained crate.** Its README carries "This crate has not been security reviewed yet, use at your own risk", its public API is web-push shaped with the `aes128gcm` module private, and "We do not implement streaming encryption or decryption, although the ECE scheme is designed to permit it." No streaming means no progressive range decryption, which is the one property `frame.md`'s wedge boundary makes non-negotiable, so that line alone costs the reason this framing was chosen. **One further line is individually disqualifying:** "We currently select the padding length at random for each encryption, but this is an implementation detail and should not be relied on", which turns the size derivation into an upper bound with unknown slop and reintroduces the qualifier section 4 just discharged. Rust means hand-rolling the coding.

  The Rust crate's documented fixed 4,096-octet encryption record size
  differs from the current 65,536-octet writer default.
- **Go, [`crow-misia/http-ece`](https://github.com/crow-misia/http-ece), 4 stars, the only one.** Actively maintained by one person. Effectively hand-rolling with a four-star dependency underneath.
- **JS, [`web-push-libs/encrypted-content-encoding`](https://github.com/web-push-libs/encrypted-content-encoding), 33 stars.** Real and maintained, and it has no progressive range decryption. Using it for the writer and `wormhole-crypto` for the reader would buy two implementations and no capability.

None of these is disqualified by its star count. They are disqualified by the capabilities and the README lines recorded above, and the star counts are recorded so nobody reads a rejection as a popularity contest.

### 5.2 The standing rule if a second implementation ever ships

**No second writer implementation ships without passing both of RFC 8188's published vectors and a round-trip against the JS implementation at the shipping record size. The two vectors are asserted differently, and the asymmetry is mandatory rather than a convenience.**

- **Section 3.1 is the round-trip vector.** Its 4,096-octet record size is
  distinct from the current 65,536-octet default, so test the current
  default separately.
- **Section 3.2 is decrypt-only.** Assert that the published body decrypts to `I am the walrus`. Never assert that a conforming Relic writer reproduces it.

**Why section 3.2 cannot be an encrypt assertion, since the obvious harness gets this wrong and fails a correct writer.** RFC 8188 padding is discretionary, and the section 3.2 vector exercises that discretion: at `rs = 25` the RFC states "The first record includes one 0x00 padding octet. This means that there are 7 octets of message in the first record and 8 in the second." A minimal-padding encryptor slices at `rs - 17`, which is 8, so it puts 8 octets in record 0 and 7 in record 1. Both objects are valid RFC 8188 and both decrypt to the same string, and they are different octets. Reproduced both ways: the RFC's 7/8 split rebuilds the published 73-octet body exactly, and the 8/7 split a minimal-padding writer emits produces 72 octets that do not match. Section 4 mandates minimal padding, so a writer that satisfies this document fails a section 3.2 encrypt assertion by construction. **A harness that asserts it is testing its own padding policy against the RFC's, not conformance.** An implementer who wants an encrypt assertion at a second record size writes it against the JS implementation's output, which is the round-trip half of the gate, rather than against a vector whose padding was chosen to demonstrate that padding is discretionary.

Three further notes an implementer needs before writing that harness.

- **Section 3.2's vector carries `keyid` `a1`, which production refuses.** `format.md` 3.4 makes `idlen != 0` a hard refusal, so the harness parses what production refuses: the vector runs against a test-only reader with the check disabled, and the production reader is separately asserted to refuse that same vector. That second assertion is the valuable half, because it turns the RFC's own vector into a negative test for 3.4.
- **Assert against the vector's published body, never its stated content length.** RFC 8188 section 3.1 states "Content-Length: 54" for a body that is 53 octets, and errata ID 5516 is held for document update against exactly that ([RFC 8188 errata](https://www.rfc-editor.org/errata/rfc8188)). A harness that asserts 54 fails against the RFC's own bytes.
- **The vectors do carry their final padding delimiter.** Errata 8620 and 8621 claimed otherwise in 2025 and were both rejected in 2026. Reproducing section 3.1 end to end from its IKM and salt yields the published CEK `_wniytB-ofscZDh4tbSjHw`, the published nonce `Bcs8gkIRKLI8GeI8`, and the published 53-octet body byte for byte, with the delimiter present.

### 5.3 Two properties the reference implementation supplies free

- **`readHeader` throws `Implementation does not support non-zero idlen` when octet 20 is non-zero.** That is `format.md` 3.4's refusal, at the only point it can happen, on the object's first 21 octets.
- **`plaintextSize` and `encryptedSize` are exact inverses under minimal padding**, which is what `format.md` 3.3 requires, and section 4 is what makes the qualifier hold.

## 6. Nonce discipline, as rules an implementer follows

`format.md` 3.10 and `publish.md` 4.4 both carry the consequence. RFC 8188 4.3: "Encrypting different plaintext with the same content-encryption key and nonce in AES-GCM is not safe [RFC5116]." The failure is total rather than degraded: reusing a nonce under AES-GCM leaks the authentication key, "allowing an attacker to perpetrate chosen ciphertext attacks including message forgeries and even potentially full plaintext recovery" ([nonce reuse](https://github.com/miscreant/meta/wiki/Nonce-Reuse-Misuse-Resistance)). Ten rules.

1. **The sequence starts at zero on record 0 and increments by one per record.** The content-coding header consumes no sequence number. `NONCE = HMAC-SHA-256(PRK, nonce_info || 0x01) XOR SEQ`, where SEQ "is a 96-bit unsigned integer in network byte order that starts at zero".
2. **The writer draws a fresh 16-octet salt per relic from the CSPRNG, at the same call site as the IKM.** The RFC's unconditional form of the rule, verbatim from 4.3:

   > An implementation SHOULD generate a random "salt" parameter for every message.

   **The RFC's two MUST-level salt rules are both conditional on input-keying material reuse, and neither fires here.** Saying that is the point rather than a caveat. 2.1 forbids reusing a salt "for two different payload bodies that have the same input-keying material", and 4.3's requirement opens with "if the same input-keying material is reused". `format.md` 3.10 already draws a fresh IKM per relic, so the CEK is fresh on the IKM alone and the salt rule Relic obeys is the SHOULD. Obeying it anyway is what keeps a later change to the IKM rule from being silently catastrophic instead of loudly wrong.
3. **The writer encrypts exactly once, to an immutable ciphertext artifact, before the first byte is offered to the network.** `publish.md` 4.5 requires this. The crypto reason is that it converts record index from a property of retry logic into a property of a finished file and a byte offset. Retry logic under network failure is the code path least exercised in testing and most edited later.
4. **Retry resumes at a byte offset into that artifact and never re-enters the encryptor.** There is no path from a failed upload back into record framing, so no path reaches a repeated sequence number.
5. **The writer exposes no function that accepts a starting sequence number for encryption.** This is enforced by API shape rather than by discipline. The reference implementation already has the asymmetry: its seek options are read only on the decrypt branch. Preserve it in anything vendored or forked, because an encrypt-side resume entry point is the one signature from which a nonce reuse is reachable at all.
6. **A publish that exhausts its retries and runs again is a new relic**: new ID, new IKM, new salt, new ciphertext, new URL. The previous IKM is never reused with any salt (`publish.md` 4.5).
7. A crash can leave a ciphertext artifact. Cleanup and the handling of its
   key depend on the client and operating system; process memory can be
   swapped to disk, so memory residency alone does not prove disk absence.
8. The original design compared limits using 4,096-octet records and a
   reference implementation's 32-bit record counter. The current default is
   65,536 octets, so those earlier record-count calculations are historical.

9. A file exactly at the current 500 MiB plaintext cap uses 8,004 records
   including record 0. The cap, rather than the historical multi-terabyte
   examples, bounds ordinary publication.

10. **The writer treats an ID collision at mint as a CSPRNG fault and stops, because it is the only remaining path to a reused CEK across relics.** Rules 3 through 7 close every path inside one publish: re-encryption, retry re-entry, encrypt-side seek, and republish. What they cannot close is the randomness itself. A CSPRNG that replays state, from a fork, a restored VM snapshot, or a fixed seed, hands out the same IKM and the same salt twice, and two relics then share a CEK and a nonce progression, which is exactly the condition the RFC calls not safe. **The detector is already in the system and costs nothing.** `format.md` 1.3 draws the ID and the key independently from that same CSPRNG in the same pass, so a replayed generator replays the ID too, and `format.md` 1.4 refuses to mint a grant for an ID that already exists. The refusal lands before the grant, so it stops the publish before a byte is encrypted or uploaded. 1.4 already names the symptom, that a collision "is astronomical bad luck or a broken RNG, and both should fail loudly", without connecting it to nonce reuse. The connection is the rule, and it sits inside what 1.4 already prescribes rather than beside it: **the writer draws a new ID and retries exactly as 1.4 says, and it treats a second collision in one process as the broken-RNG branch 1.4 names.** It stops there instead of looping, and it surfaces the generator as the fault. Two collisions from one process is not bad luck, and an unbounded redraw-and-continue loop responds to a replaying generator by publishing anyway, under a key it has already used.

## 7. The relic ID's entropy (4.3)

`format.md` 1.2 fixes 122 bits as a **floor** and 1.3 fixes generation client-side before the grant request. What remains is the number.

**Decision: 125 bits, encoded as exactly 25 Crockford base32 characters.**

**Generation.** Draw 25 octets from the platform CSPRNG, take the low 5 bits of each, and map through Crockford's 32-symbol alphabet. 256 is a multiple of 32, so masking is unbiased and no rejection sampling is needed. Never `Math.random` (`format.md` 1.3).

**Why 125 rather than 122.** Crockford: "Each symbol carries 5 bits", and "If the bit-length of the number to be encoded is not a multiple of 5 bits, then zero-extend the number to make its bit-length a multiple of 5" ([Crockford](https://www.crockford.com/base32.html)). 122 is not a multiple of 5, so a 122-bit ID zero-extends to 125 anyway and encodes to 25 characters, the same 25 characters 125 bits encodes to.

**That makes this a dominance argument and not a preference.** The two options cost the same: 25 characters in the path, the same reserved-word margin, the same URL length, the same generation code. At equal cost 125 delivers three more bits and a first character drawn uniformly from all 32 symbols, where 122 leaves the first character ranging over 4 of the 32 and a visible pattern at the head of every ID that a reader could mistake for a prefix scheme. Nothing is traded away, so nothing needs weighing. 125 makes the ID space equal to the string space.

**The enumeration arithmetic, at 125 bits rather than at the floor.** The space is 2^125, roughly 4.25 times 10^37. Every guess costs one mint request against the app server, which is rate limited per IP. Give an attacker 10,000 addresses each sustaining 10 mints per second, far past what the limiter permits, and run it for ten years: 3.15 times 10^13 requests, for an expected 7.4 times 10^-25 hits. One expected hit takes 2^124 requests. For a public relic, a hit yields ciphertext and its length, because `format.md` 3.6 keeps the renderer class server-side and the key was never on the wire. A private relic's mint is gated on an access check (`format.md` 1.2), so a hit on its ID yields no ciphertext to a caller without access. **Enumeration is settled at 125 bits by roughly 24 orders of magnitude, and it is settled at the value decided here rather than at the floor the value sits above.** `design-operations-and-abuse` can record it as settled and the record is true rather than circular.

**Why not more.** 130 bits is 26 characters and moves an already-settled margin.

**The cost in characters.** 25 in the path. A full relic URL is the scheme and separator at 8 characters, plus the domain, plus one slash, plus the 25-character ID, plus `#`, plus the 24-character fragment, so 71 characters on a twelve-character domain, against a practical URL ceiling around 2,000.

**The reserved-word guard (`format.md` 1.5).** 25 characters exceeds the longest reserved word, `manifest.webmanifest` at 20, by five. The table stays the backstop for the reasons 1.5 gives, and the append rule stops being vacuous only for a reserved word of exactly 25 characters, which no root-level service path is.

**The terminal-character check applied to the ID.** IDs sit in the path, so an ID's last character is only ever a URL's last character when a bare ID is pasted with no fragment, which is what abuse reports and support tickets carry. Crockford's alphabet is ten digits and 22 letters and contains no punctuation at all, so the intersection with GFM's trailing-punctuation set is empty at every bit count. The check passes by alphabet and needs no runtime half.

## 8. The v2 migration cost, in bounded terms

`format.md` says the format cannot change after content is encrypted. That is true of a given relic and misleading about the system.

**For a public relic, the version marker sits in the fragment, so it is pre-fetch.** A v2 viewer reads the marker before minting a signed URL, so it refuses or routes a v1 relic without spending a mint, without consuming a per-object download cap, and without a byte of egress (`format.md` 2.2 and 3.7). A private relic has no marker. The server declares its access mode before any mint, and a v2 viewer routes it by that declaration.

**The real cost is that the viewer carries both decoders for as long as any v1 relic can still be alive.** The bound is the mandatory TTL plus the signed URL's own validity window, because a URL minted a second inside the TTL ceiling stays valid for its own lifetime. **The TTL ceiling is `design-storage-grant-and-cost`'s decision, not this document's**, and no number for it exists yet. So the bound is a shape here and not a date, and this document states the need rather than asserting a value.

**Carrying both decoders is not one price, and pricing every version bump at the top of the range mis-prices the extension `format.md` deliberately paid bytes to reserve.** There are two kinds of v2 and they differ by roughly the whole cost.

- **An envelope-only v2 changes what is inside record 0 and nothing else.** Section 3.2's entry count going above 1 for the multi-file case is the worked example, and it is what `format.md` 3.1 reserved room for by carrying offsets in version 1. The framing, the key derivation, the record structure, the range arithmetic, and the size derivation are all untouched, so the viewer runs one crypto stack and branches on two envelope layouts after record 0 is already decrypted. That is a parser branch, and dual support is close to free for as long as it has to last.
- **A framing v2 changes the container.** A different content coding, a different key derivation, or a different record structure means the viewer carries two crypto stacks, two range-arithmetic implementations, and two size derivations, and every one of them is a place a bug reaches ciphertext that can never be rewritten.

Only the second kind is expensive, and it is the kind the fragment marker exists to make survivable at all. Stating one uniform cost would make adding a second file to the envelope look as expensive as replacing the container, which would price the reserved extension out of ever being used.

**What makes the cost unbounded is a writer that keeps writing v1.** Retirement is not TTL after v2 ships. It is TTL after the last v1 writer stops, and the publishing client is a distributed binary nobody can force to upgrade. Two rules follow, and they are the ones that keep the term finite:

- **The writer's version is not configurable and there is no v1 fallback path in a v2 writer.** A client either writes the version it was built for or refuses.
- **The v1 writer population is observable.** `publish.md` 3.2 already sends `client_name` and `client_version` on every grant request, so the operator can see which client versions are still publishing and knows when the last v1 writer stopped. The limit on that reading: it names the versions that published in a window and says nothing about un-upgraded clients that have not published lately, so retirement waits on a quiet window rather than on a single observation.

## 9. What this document needs from siblings

Stated as needs, with the behaviour that follows and the owner named.

1. **The hard size cap value and its referent (`format.md` 4.4), from `design-storage-grant-and-cost`.** Section 4 supplies the conversion at version 1, `encryptedSize(cap + (rs - 17), rs)`, where `cap` counts content octets and excludes the envelope block, and flags it as a refinement of the form `format.md` 3.11 writes. Until the value exists, this document's arithmetic is a function with an unbound argument, and nothing here depends on which side enforcement lands on.
2. **The mandatory TTL ceiling and the signed-URL validity window, from `design-storage-grant-and-cost`.** Together they turn section 8's bound into a date. Without them a v1 decoder's retirement is stated as a rule and not as a schedule.
3. **Whether object metadata is set at upload (`format.md` 4.6), from `design-storage-grant-and-cost`.** This document places nothing in object metadata, reads nothing from it, and every field it defines lives inside the AEAD or in the content-coding header. Whichever way that goes, nothing in this document changes.
4. **Whether the viewer displays a plaintext byte count before decryption, from `design-product-surface`.** `viewer.md` 5 withholds it because `format.md` 3.3's derivation was an upper bound. Section 4 discharges that qualifier at version 1 and section 3.2 gives the exact expression, so the number is available and honest for an intact object. The behaviour that follows either way: the derived number is an allocation guard and is not authenticated, and the envelope's content length inside the AEAD is what any post-decryption display uses.
5. **The relic domain, from `design-topology-and-origins`.** It fixes the total URL length that section 7 and section 2.2 compute against. Nothing here is blocked on it.

## 10. One drift item, routed rather than fixed

**`format.md` 3.4 quotes RFC 8188 with a citation elided from inside the quotation marks.** It reads: RFC 8188 says it "SHOULD be a UTF-8-encoded string," where the RFC's own text is "SHOULD be a UTF-8-encoded [RFC3629] string". The `[RFC3629]` reference is dropped and the comma is moved inside the marks.

Nothing about the meaning changes, and `format.md` 3.4's decision that `keyid` is unused and `idlen` MUST be 0 is unaffected. This document depends on that decision and implements it in sections 1.1, 1.2, and 5.3.

**`format.md` is locked and this document does not edit it. Routing this back to `specify` as drift, with the sentence quoted above.** It is recorded rather than dropped because it is the same defect class this document's own quotation audit caught in itself twice, once on a case-altered initial letter and once on this exact elision of `[RFC5116]` from the section 6 nonce quotation, and both were corrected here. A defect worth correcting in this document is worth naming in a sibling, and naming it is the whole of what this document does about it.
