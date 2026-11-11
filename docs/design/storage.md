# Relic: the grant, the storage topology, and the cost controls

This document decides the hard size cap, the grant construction, the cost controls and what the kill switch cannot reach, the three items no unit had picked up, the GCP project topology, and the lifetime of a published byte.

`docs/frame.md`, `docs/preconditions.md`, `docs/spec/format.md`, `docs/spec/publish.md`, `docs/spec/service.md`, and `docs/spec/viewer.md` are locked inputs. `docs/design/container.md` and `docs/design/topology.md` are sibling inputs, consumed here and never reopened. Neither had landed on the station branch when this was written, so both were read from their unit branches; section 9 records which.

The 2026-11-10 decision in `docs/decisions.md` supersedes the original
100 MiB cap and the original viewer memory model. The original 64-mint pick
was also superseded; the current cap is 200 mints.

## 0. What this closes, by name

Twelve routed items, and no others implied.

- **`publish.md` 6.1** the grant shape, section 2.
- **`publish.md` 6.2** proof of work and its difficulty, section 5.1.
- **`publish.md` 6.3**, **`format.md` 4.4**, and **`viewer.md` 7.2** the size cap value and its referent, which are one decision routed three times, section 1.
- **`publish.md` 6.4** the retry cap and the backoff bounds, section 5.2.
- **`publish.md` 6.5** and **`format.md` 4.6** whether object metadata is set at upload, one decision routed twice, section 5.3.
- **`service.md` 7.2** the per-object download cap, section 4.4.
- **`service.md` 7.3** the TTL ceiling and its lifecycle regime, section 7.2.
- **`service.md` 7.4** the signed-URL validity window and the minimum viable validity, section 4.2.
- **`service.md` 7.5** the retention window, section 7.3.

Viewer heap reads and source-window behavior are covered in
`docs/design/surface.md`. The remaining sibling design references below
describe the original design context.

## 1. The hard size cap

### 1.1 The referent and the value

**The plaintext content cap is 500 MiB, or 524,288,000 octets.** It is the
size of the selected file, excluding the encrypted envelope.

The current record size is 65,536 octets, with 65,519 content octets per
full record. A cap-sized file uses 8,004 records including the envelope and
produces 524,489,608 ciphertext octets. The 201,608-octet difference includes
the envelope record and framing overhead.

`size_limit_bytes` is 524,288,000 and `size_basis` is `plaintext`. The
challenge and size refusal expose the plaintext limit; an upload grant binds
the exact declared ciphertext length. The ciphertext length at the cap is a
conversion of the same policy, not a second plaintext limit.

The original 100 MiB design and its 4,096-octet-record calculations are
superseded by the 2026-11-10 decision. With the unchanged 200-mint cap, the
one-complete-fetch-per-mint case is 97.69 GiB of ciphertext per relic. Signed
URLs can be reused, so actual egress is not bounded by that product.

### 1.2 Viewer consequences

The viewer decrypts records into browser-managed Blobs and reads bounded
slices for renderers, rather than holding the whole file as a JavaScript
buffer. It asks for confirmation before the full fetch when the authenticated
plaintext exceeds 100 MiB. Large text remains accessible through a windowed
source view.

Browser-managed storage may use memory or temporary disk; OS swap and
explicit downloads may also write plaintext to disk. The design does not
guarantee erasure when the page closes. Streaming plaintext through a
ServiceWorker remains unbuilt, and the former three-tier collapse and its
four-copy calculation no longer describe this architecture. Actual browser
memory behavior is platform-dependent.

### 1.3 What it fixes downstream

The cap determines the challenge response, client pre-check, maximum accepted
ciphertext size, and the egress calculation in section 4.4. Viewer behavior
follows the Blob and source-window design in section 1.2.

## 2. The grant shape

### 2.1 Every candidate is defective, and two of the defects are unrecorded

`publish.md` 3.6 routes three candidates and says exactly one has documented size enforcement. That framing is right and it understates the problem.

**POST policy document.** It is the only construction expressing a cap rather than an exact value. Its conditions are "An array of conditions that every upload must satisfy", and `content-length-range` "Specifies a range of acceptable values that can be used in the Content-Length field" ([signatures](https://cloud.google.com/storage/docs/authentication/signatures)). **The defect: the word generation appears zero times on the POST Object HTML forms page** ([POST object](https://cloud.google.com/storage/docs/xml-api/post-object-forms)), verified by grep over the raw page, and so does `ifGenerationMatch` and any `x-goog-if-` prefix. There is no documented way to carry the precondition `publish.md` 3.7 requires on every grant. It also fails `publish.md` 4.4 outright, being a single POST with no resume.

**Signed PUT with `Content-Length` among the signed headers.** Enforcement here is by construction, and consistent with the one demo that exists rather than demonstrated by it. A signed header whose value does not match invalidates the signature, which `publish.md` 3.6 already records, so `Content-Length` binds for the same reason `host` does and needs no experiment.

**The demo is worth reading precisely, because it proves less than it appears to.** A practitioner's runnable demo signs `content-length;content-md5;content-type;host` and produces four results, not three: a 5-octet body refused 403, the matching 10-octet body accepted 200, **a second 10-octet body carrying a different MD5 also refused 403**, and a 20-octet body refused 403 ([salrashid](https://blog.salrashid.dev/articles/2022/limit_gcs_signedurl/)). Every wrong-size body in that run also carries a wrong MD5, and the correctly sized body with the wrong hash is refused too, so no arm of it varies length alone. The author says exactly that: "only tenBytes succeeded (since the file size and hash need to match)". **What the run shows is that the signed header set is enforced as a set.** It also states the correction it exists to make: "you can actually sign a PUT url and set the Content-Length it will use". The conclusion stands on the signature argument; the demo corroborates it and does not isolate it. **The defect: a V4 signature pins a value, never a range.** So the constraint is necessarily the client's declared size, which contradicts `publish.md` 3.6's requirement that the constraint be computed against the cap rather than the declared size. The cap still holds transitively through the grant-time refusal, but that sentence is not implementable as written on this branch. It has no resume story either.

**Resumable session.** It is the only candidate satisfying `publish.md` 4.4, and it proves that outright: on a status check "the 308 response has a Range header, which specifies which bytes Cloud Storage has persisted so far", and "If Cloud Storage has not yet persisted any bytes, the 308 response does not have a Range header", and overlap is safe because "Cloud Storage ignores any bytes you send at an offset that Cloud Storage has already persisted" ([performing resumable uploads](https://cloud.google.com/storage/docs/performing-resumable-uploads)). **Its size enforcement is unverified, and the one demo that appears to prove it does not.** The same demo signs `x-upload-content-length` and reports "Could not generate resumable location for size" at 5 and at 20 with 403, and success at 10. Read the failure text precisely: the refusal is at the initiation step, so what is proven is that the V4 signature pins the declared value at initiation. The demo never sends more bytes to the session URI than it declared, so it says nothing about whether GCS compares the declaration against the persisted bytes. `X-Upload-Content-Length` sits among "Optional headers that you can add to the request" and nothing on that page binds it against what lands.

**Two further defects on the resumable branch, neither recorded anywhere in the spec set.** First, the data leg accepts client metadata: "The JSON API also supports setting custom metadata in the final request if you include headers prefixed with" `X-Goog-Meta-` ([resumable uploads](https://cloud.google.com/storage/docs/resumable-uploads)), and PUTs to a session URI use no signed URL, so the argument in `format.md` 4.6 and `publish.md` 6.5 that client metadata can be pinned by signing `x-goog-meta-*` into the grant does not hold here. It holds on the other two branches. Second, the storage-leg clock is not the grant clock: "A session URI expires after one week but can be cancelled prior to expiring", and cancellation needs possession of the session URI, which is what `publish.md` 3.4 already turns on.

**No documented candidate satisfies a signed size constraint computed against the cap, the generation precondition, and resume from a byte offset together.** That is the state of the evidence, and no closer reading of the documentation resolves it.

### 2.2 The probes, specified and not run

**These were not run.** Running them creates buckets and objects under a billing account, and the only authenticated local credential belongs to an unrelated venture. Specifying them is the deliverable; executing them is the first task of `build`, ahead of committing the branch.

Each probe gets a request, an assertion, and what the result eliminates.

**Probe A, byte enforcement with a known total.** Sign a resumable initiation with `X-Upload-Content-Length: 1048576` in `X-Goog-SignedHeaders`. Initiate honestly. PUT 2 MiB to the session URI with `Content-Range: bytes 0-2097151/2097152`. *Assertion:* the response status. *Eliminates:* a 200 or 201 means the declaration does not bind the persisted bytes, which eliminates the resumable branch as a carrier of the cap. A 400 means it binds, and Probe A becomes a launch regression test.

**Probe B, byte enforcement with an unknown total.** Repeat A sending `Content-Range: bytes 0-2097151/*`, then finalize. *Assertion:* the status on the data PUT and on the finalize. *Eliminates:* this is the shape an attacker actually uses, so a pass here and a fail in A means the enforcement is cosmetic and the branch still cannot carry the cap. A must pass and B must pass together for the branch to hold.

**Probe C, metadata injection on the unsigned leg.** On the final data request of an honest resumable upload, add `x-goog-meta-injected: 1`. Read the object's metadata back. *Assertion:* whether the key is present. *Eliminates:* presence confirms the defect above and forces the strip step in section 5.3. Absence retires it.

**Probe D, generation precondition on a POST policy.** Submit a POST policy form carrying `x-goog-if-generation-match` as a form field, then separately as a policy condition. *Assertion:* whether either is accepted, and whether the write is refused against an existing object. *Eliminates:* a rejection on both eliminates the POST branch under `publish.md` 3.7. Acceptance revives it and makes it the only branch with both documented size enforcement and the precondition.

**Probe E, when the precondition is evaluated on a resumable session.** Initiate with `ifGenerationMatch: 0` against an absent object. Create the object out of band. Finalize. *Assertion:* whether the finalize succeeds. *Eliminates:* success means the precondition is checked at initiation only, so the anti-substitution guarantee `publish.md` 3.7 rests on is weaker than that section assumes on this branch, and the leaf below that depends on it is not available.

### 2.3 The decision tree

Read the answer off the probes. **Every leaf names the requirement it sacrifices, the locked sentence that contradicts, and the drift routing that sacrifice obliges.** The four requirements are `publish.md` 3.6's signed size constraint computed against the cap, 3.7's `ifGenerationMatch: 0` on every grant, 3.4's grant expiry the storage leg actually enforces, and 4.4's resume from a byte offset.

**Leaf 1. A and B both pass, and E shows the precondition is evaluated at finalize.** Take the **server-initiated resumable session**. It carries size enforcement, the precondition, and resume. Grant expiry is enforced by the app server cancelling the session at `grant_expires_at`, which works because server-side initiation puts the session URI in its hands (`publish.md` 3.4). *Sacrifice: none of the four.* *Drift: none.* This is the only leaf that costs nothing, which is why the probes are worth running before anything is committed.

**Leaf 2. A and B both pass, and E shows the precondition is evaluated at initiation only.** Take the same branch. *Sacrifice: `publish.md` 3.7.* The grant carries the precondition and it does not close substitution, because the object can be created between initiation and finalize. *Contradicted sentence:* 3.7's statement that the precondition holds the residual in 3.5 at one successful write. *Drift routing: to `specify`, owner of `docs/spec/publish.md`,* as a request to restate 3.7's guarantee at the scope the storage layer actually provides. The residual is bounded in practice by the grant being single-use and bound to one object path, so this is a narrowing of a stated guarantee rather than a hole, and it must be recorded as a narrowing.

**Leaf 3. A or B fails, and D shows a POST policy accepts a generation precondition.** Take the **POST policy document**. It carries the only documented size enforcement, expressed as a range rather than a value, so it satisfies 3.6 in full including the computed-against-the-cap clause. *Sacrifice: `publish.md` 4.4.* Every retry restarts at zero. *Contradicted sentence:* 4.4's requirement that the grant shape support resuming an interrupted upload from the byte where it stopped. *Drift routing: to `specify`, owner of `docs/spec/publish.md`.* Section 5.2 prices what that sacrifice actually costs, and the answer is smaller than 4.4 states. *Preserved:* 3.7, which is what probe D's positive result establishes and the only condition this leaf turns on, and 3.4, because the policy document's own expiry is enforced on the storage leg, which `publish.md` 3.4 already states when it says a POST policy document can satisfy the invariant.

**Leaf 4. A or B fails, and D shows a POST policy accepts no generation precondition.** Take the **signed PUT with `Content-Length` signed**. *Sacrifice: two, `publish.md` 3.6's computed-against-the-cap clause and 4.4's resume.* *Contradicted sentences:* 3.6's sentence that the constraint is computed against the cap rather than the declared size, and 4.4 entire. *Drift routing: both to `specify`, owner of `docs/spec/publish.md`,* as one item, because a branch sacrificing two requirements is a different contract from the one 3.6 describes and should be reviewed as one change. On this leaf the cap holds through the grant-time `413 size_over_cap` refusal against `declared_size_bytes`, and the signed `Content-Length` holds the object to exactly what was declared, so an oversized object still cannot come into existence. What is lost is the property that the wire constraint is the cap; it is the declared size, and the two are equal only because the grant refused everything above the cap first.

**What this leaf preserves, stated because a leaf that names only its losses is half a decision.** *`publish.md` 3.7 survives.* A signed PUT is an XML API request, and the XML API expresses the generation precondition as a request header, `x-goog-if-generation-match`, listed against the JSON API's `ifGenerationMatch` in the same table, where "Request proceeds if the generation of the target resource matches the value used in the precondition" ([request preconditions](https://cloud.google.com/storage/docs/request-preconditions)). The same page's XML API example carries it on a `PUT Object` request. A header is signable, so the grant carries the precondition under the same signature that carries the length, and no separate mechanism is needed. *`publish.md` 3.4 survives for free.* That section already states that under a signed-URL shape the signature's own expiry enforces grant expiry on the storage leg, so this leaf inherits the enforcement rather than building it. **Two of the four requirements are preserved, two are sacrificed, and that is the full accounting for this leaf.**

**No leaf is left undecided, and no leaf is free of a named sacrifice except leaf 1.** If leaf 1 is unreachable, the station's position is that `publish.md` cannot be satisfied as written by any documented GCS construction, and the drift routing is the deliverable rather than a footnote to it.

## 3. Cost controls, corrected

### 3.1 The bucket's geometry, then the egress arithmetic from the primary source

**Decided first, and as a value rather than an assumption, because every rate below is read out of a table scoped to it: the bucket is Standard storage in a single region.** Standard because a relic is written once and read inside a 72-hour TTL (section 7.2) [Amendment: the mandatory 72-hour TTL was reversed in `docs/decisions.md`; a relic is kept until deleted, though a publisher may set a lifetime], which sits under every colder class's minimum storage duration and under the retrieval fee those classes charge on each read, so Nearline, Coldline, and Archive all cost more for this access pattern rather than less. Single region because the object is fetched from wherever the holder of the link happens to be and nothing in the product replicates, fails over, or reads from a second location, so dual-region and multi-region buy an availability property the design never exercises and bill inter-region replication on every write to get it.

**This is not bookkeeping, and stating it is the guard.** The pricing page prices several bucket geometries on one URL and the rows are not interchangeable. The operation rates below sit under `Operation charges`, in the table introduced by the line "For buckets located in a single region". The inbound row this document leans on sits under `General network usage`. A different table on the same page prices data transfer in at $0.0032 per gibibyte and data transfer out at $0.0006, and that table's own opening sentence is "Rapid Bucket is only available in zonal buckets" ([pricing](https://cloud.google.com/storage/pricing)). Relic's bucket is regional and not zonal, so those rows describe a product this design does not use. **The one-step tell, available without resolving a single heading: $0.0006 of egress is 200 times below the $0.12 the whole cost section rests on. A neighbouring row two orders of magnitude off a number already established means the wrong table, not a discovery.** Fixing the geometry as a value is what puts that check within reach of anyone reading this section later, and it is the reason this paragraph exists rather than being left implicit.

Reading the `General network usage` rows ([pricing](https://cloud.google.com/storage/pricing)): to Worldwide destinations excluding Asia and Australia, the rate is $0.12 per gibibyte from 0 to 10 tebibytes, $0.11 from 10 to 150, and $0.08 above that. Asia excluding China carries the same three rates at the same two boundaries. Australia is $0.19, $0.18, and $0.15, again at 10 and 150 tebibytes. **China excluding Hong Kong is the exception in both dimensions: $0.23 up to 1 tebibyte, $0.22 from 1 to 10, and $0.20 above that.** So the first-tier boundary is 10 TiB rather than 1 TB on every destination except China, which breaks at 1 TiB, and the rate is destination-dependent by up to 92 percent. A ceiling computed at a flat $0.12 understates badly for a non-US audience, and a relic's audience geography is not something an operator without viewer analytics can predict.

Two further facts from the same page, each read against its own heading rather than against the page. **Inbound transfer is free**: "General network usage applies for any data read from your Cloud Storage bucket", "Inbound data transfer represents data sent to Cloud Storage in HTTP requests", and "Data or metadata written to a Cloud Storage bucket are examples of inbound data transfer", with the table row for inbound reading Free. That row is under `General network usage` and not under `Rapid Bucket`, which is the distinction the paragraph above exists to hold and the reason this claim survives being challenged from the wrong table.

**And refusals are free, with a qualifier the source carries and this document carries with it.** Verbatim: "Generally, you are not charged for operations that return 307, 4xx, or 5xx responses". The page's next sentence names the exception, 404 responses returned by buckets that have Website Configuration enabled with the NotFoundPage property set to a public object in that bucket. **Relic's bucket has no website configuration and serves no public object, so the exception cannot fire**, and that is a consequence of the geometry decided above rather than an accident. So probing and enumeration cost the attacker's bandwidth at the storage layer and not the operator's. Class A operations are $0.005 per 1,000 on Standard storage in a single region, which is the only charge a refused or retried upload actually generates.

### 3.2 Cloud Storage is not covered by any platform spend cap

**Alerts-only budgets do not cap anything.** Verbatim: "Setting an alerts-only budget doesn't automatically cap Google Cloud or Google Maps Platform usage or spending", and on the same page, "there is a delay between your use of Google Cloud resources, and the usage costs reporting to Cloud Billing" ([budgets](https://cloud.google.com/billing/docs/how-to/budgets)).

**Spend cap budgets do enforce, and their eligibility list does not include Cloud Storage.** Verbatim: "In this release, the eligible services include Gemini API, Agent Platform (formerly known as Vertex AI), Cloud Run, and Cloud Run functions." Grep over the raw page returns zero occurrences of Cloud Storage. The same page states "Spend cap budgets can only be set on one project and one service at a time", and that "the enforcement of spend caps aren't instant and any cost overages are billed as normal" ([spend caps](https://cloud.google.com/billing/docs/how-to/budgets-spend-caps)).

**So capping Cloud Run stops the app server and therefore stops minting. Nothing at the platform level stops GCS egress.** The application-layer kill switch `docs/preconditions.md` makes a deploy gate is a minting switch and nothing more. That is the correct reading of what the preconditions bought, and the preconditions do not say it.

### 3.3 The residual the kill switch cannot reach

A signed URL already issued does not care that minting stopped: "Anyone who knows the URL can access the resource until the expiration time for the URL is reached or the key used to sign the URL is rotated" ([signed URLs](https://cloud.google.com/storage/docs/access-control/signed-urls)).

**The residual after the switch trips is the set of live minted URLs, each usable until its own expiry, times the object size, times however many fetches each can serve in its remaining validity.** The residual is bounded in time and not in bytes: the validity window bounds when fetches can start, and nothing rate-limits GCS-side fetches of a live signed URL, because the app server is not in that leg.

**One load-bearing assumption inside that sentence is marked rather than buried.** Whether a transfer already in flight completes after its signed URL expires is asserted here from how signature validation works, at request admission rather than continuously, and it is not verified against a source. `service.md` §3 states that a download beginning before expiry completes after it, but the reason it gives is that the app server is not in the data path, which is an argument about relic expiry and does not transfer to signed-URL expiry, where GCS itself is the enforcer.

**That is a scope reading of a locked sentence, and it is labelled as one rather than reported as a gap in the source record.** `service.md` §3 is true as written, nothing here narrows it, and its owner has nothing to revise. What this document observes is where the sentence's stated reason stops reaching, and the case beyond it is unaddressed rather than wrongly addressed. **That is the line separating it from leaf 2 in section 2.3, which does route drift:** leaf 2 narrows a guarantee `publish.md` 3.7 actually makes, so the owner has to see the guarantee shrink. This reads the edge of a guarantee `service.md` §3 never claimed, so there is nothing to route. The rule, stated once so both cases stay consistent: a claim the locked text makes and the design cannot deliver is drift; a claim the locked text does not make is a gap in this document's evidence and gets a probe.

**The direction of the error matters: if in-flight transfers are in fact cut at expiry, the residual is smaller than stated here and the window in section 4.2 is more conservative than it needs to be.** So the design is safe under either answer, and the assumption is recorded because section 4.2 cites it as a reason shortening the window is ergonomically cheap. It belongs in the same probe run as section 2.2.

**This makes the signed-URL validity window the blast time of the kill switch**, and that consideration should dominate `service.md` 7.4 ahead of the mid-transfer ergonomics currently driving it. Section 4.2 decides the window on that basis.

### 3.4 Signing-key rotation as the second-stage kill switch

Rotation is the one instrument that truncates the residual, because it is named in the sentence above as the other terminator of a live URL. It is indiscriminate: every outstanding URL dies at once, including honest in-flight downloads. **That is the correct trade in a spend emergency and it is designed as a deliberate second stage rather than improvised during one.**

**The signing identity, so rotation does not take the identity with the money.** Two key kinds exist: "This key pair is known as the Google-owned and managed key pair", used by the Service Account Credentials API to sign blobs, and separately "you can create multiple public/private RSA key pairs, known as user-managed key pairs" ([service account credentials](https://cloud.google.com/iam/docs/service-account-creds)). Only the second kind is an operator instrument, because only it can be deleted on demand. The design follows from that:

1. **A dedicated signing service account, distinct from the app server's runtime identity.** The runtime identity holds delete-by-ID, the bulk delete, and the blocklist scanner, which are the tools needed to answer an abuse notice. Collapsing signing into it means the emergency stop also disables the abuse response, which is the failure `docs/preconditions.md` describes at project level reproduced at identity level.
2. **Two user-managed keys live at all times, one active and one standby.** Rotation promotes the standby, deletes the active, and provisions a new standby. Two keys are what make rotation a promotion rather than an outage.
3. **The URL signer reads the active key by reference, never by embedded value**, so promotion is a single control-plane change and not a redeploy.

**The propagation timing is unverified and is marked as such rather than assumed immediate.** No page consulted states how long after a user-managed key is disabled or deleted GCS stops honouring V4 signatures made with it. The nearest adjacent statement runs the other way and is about a different credential type: "Deleting a service account key does not revoke short-lived credentials that were issued based on the key" ([keys](https://cloud.google.com/iam/docs/keys-create-delete)). A signed URL is not a short-lived credential in that sense, so that sentence does not transfer, and its existence is a reason to measure rather than to infer. **The runbook step is to rotate and then verify by fetching a known outstanding URL until it fails, recording the observed delay.** Until that measurement exists, the second stage is treated as bounded by the validity window in section 4.2, which is the guarantee the first stage already provides.

## 4. The download cap, the validity window, and the publish quota

### 4.1 Which branch topology chose

The original design assumed a first-gesture mint. The 2026-11-10 design asks
for confirmation after the mint and authenticated envelope read for files
larger than 100 MiB. A mint and initial transfer can therefore occur before
confirmation; the prompt does not itself prevent cap consumption.

### 4.2 The signed-URL validity window

**The download URL validity is 900 seconds; the minimum viable validity is
60 seconds.** The separate upload grant validity is 4,500 seconds.

A full-size ciphertext fetch needs at least 4.66 Mbit/s to finish within the
900-second download window. Whether an in-flight transfer completes after its
signed URL expires is unverified. The validity limits when new requests can
start after the kill switch, but does not by itself bound their total bytes.

### 4.3 The per-IP publish quota

The original design proposed 60 grants per hour and 600 per day per IP.
Those historical figures are the basis of the illustration below; they are
not evidence that both limits are enforced by the current service.

At the historical quota of 600 grants, 600 cap-sized relics with 200 mints
and one complete fetch per mint would transfer about 57.24 TiB of ciphertext.
That is an illustrative case, not a spending ceiling: signed URLs can be
reused and pricing varies with destination and volume.

### 4.4 The per-object download cap

**The cap is 200 mints per relic ID, shared across versions.** The original
64-mint decision was superseded before the 2026-11-10 size increase.

At the 500 MiB plaintext cap, 200 full ciphertext fetches of 524,489,608
octets each total **97.69 GiB**. Using the rates recorded in section 3.1, the
corresponding one-fetch-per-mint figures are about $11.72 worldwide, $18.56
to Australia, and $22.47 to China. These are illustrations at those rates,
not a claim about a current bill.

The mint cap is not a byte cap. A signed URL can serve multiple requests
before it expires, and the kill switch stops new mints rather than revoking
already-issued URLs. Billing, URL reuse, and the kill-switch residual must be
considered separately from the one-fetch-per-mint calculation.

**The cap moves up cheaply and down expensively**, and that asymmetry is worth carrying. `service.md` 1.2 gives cap exhaustion no reset window and reads permanence off its own counter, so lowering a published cap can exhaust live relics the moment it takes effect. Raising it affects nothing already issued. `download_cap` is echoed on `download_cap_exhausted` under `service.md` 1.5, so the value is published policy and a change is visible.

## 5. Three items that had no owner

### 5.1 Proof of work and its difficulty

**Difficulty is zero in the first release, and this document fixes the condition under which it goes non-zero.**

`publish.md` 3.1 already states the first-release value in a locked sentence, so the open part of `publish.md` 6.2 is the tuning, and contradicting the zero would be drift rather than a decision. It is decided on its merits here rather than left to close by omission behind the quota in section 4.3.

**The merits, and they do not point the way the anti-abuse framing suggests.** Proof of work is the primary anti-abuse control available to a service with no accounts, and its cost falls on compute rather than on identity, which is why it survives where a per-IP quota does not. But it taxes every publisher equally, and `frame.md`'s cleanest segment is headless and CI agent runs, where a publish is one step of a job on a shared runner with no human to absorb the latency and often a CPU budget that is billed. A control whose cost lands hardest on the segment the frame calls the cleanest is the wrong control to ship on day one against an abuser who has not arrived yet.

**The trigger for turning it on, as a value.** When refused grants exceed granted grants over a rolling 24-hour window while the count of distinct publishing addresses is rising, the quota has stopped working and the signature is address rotation rather than one noisy client. Both numbers come from the mint log record `service.md` 1.2 already specifies. **The difficulty when it turns on is expressed as a target median solve time of 250 milliseconds on a reference client**, rather than as a bit count, because the bit count follows from the algorithm and the client's hardware and only the target is a value this document owns.

**The consequence, stated as `publish.md` 6.2 states it.** If difficulty is non-zero, `service.md` gains one grant-time refusal code for an invalid or expired solution. **That code is `service.md`'s to define and never this document's**, so the need is stated and the owner named. The nonce refusal is unaffected, being unconditional and already carried as `409 invalid_challenge_nonce`.

### 5.2 The retry cap and the backoff bounds

**Five retries per publish, six attempts total. Backoff base one second, multiplier two, per-interval ceiling 30 seconds, full jitter, and a cumulative backoff budget of five minutes.** The counter is per publish and shared with collision redraws and re-challenges, per `publish.md` 4.6.

**The budget counts backoff wait rather than upload wall clock.** A transfer
of a cap-sized object on a slow connection can exceed the backoff budget
without exhausting its retries. This distinction keeps that budget from
acting as a total upload timeout.

This fixes when `upload_retries_exhausted` fires: on the sixth failed attempt, or if cumulative backoff wait ever exceeds five minutes, whichever comes first, carrying `attempts` and `last_code`. Six attempts is enough that a transient storage `5xx` or a dropped connection does not surface to the publisher, and few enough that a genuinely broken CSPRNG produces a loud bounded failure rather than a loop, which is what `service.md` 1.6 asks the shared counter to deliver.

**The egress a single failing publish can consume is zero, and the locked document that says otherwise is wrong.** `publish.md` 4.4 argues that restart-at-zero on a cap-sized object over a flaky link doubles or triples egress. Upload traffic is inbound to Cloud Storage, and the pricing page puts inbound transfer at Free while scoping general network usage to data read from the bucket. **So retried uploads cost the publisher's own bandwidth and the operator's Class A operations, and no egress at all.** Six attempts at the cap is 602.5 MiB of the publisher's uplink, counting the ciphertext that actually crosses the wire, and six Class A operations, which at $0.005 per 1,000 is three thousandths of a cent. What a failed publish does cost the operator is storage: bytes that persisted before the failure sit in the bucket until the TTL reaps them, and on the resumable branch a partial object is exactly that.

This materially changes what section 2.3's leaves cost. **Leaf 3 and leaf 4 sacrifice resume, and the price of that sacrifice is the publisher's uplink rather than the operator's egress bill**, which is a weaker objection than `publish.md` 4.4 makes it. The resume requirement remains worth having for publisher experience on a flaky link with a cap-sized object; it is not the cost-control argument 4.4 presents it as. That correction routes as drift in section 8.

### 5.3 Object metadata at upload

**No custom object metadata is set at upload. The grant signs no `x-goog-meta-*` header, and none is required.**

Nothing needs it. The renderer class, the optional publisher-declared plaintext title, the publishing client name and version, the publishing IP, and the timestamp all live on the relic row the app server writes at grant time, which is where `frame.md` puts the telemetry and where `service.md` 1.2 and §4 read it from. (Note: the plaintext title is stored in the clear, joined on 2026-10-13 by per-relic cover image rasters stored at `m/cover/{id}/{sha256}` in the storage bucket, per `docs/decisions.md`.) `object_length` and `object_crc32c` for the mint response come from the object's non-editable metadata rather than from anything a client sets. `format.md` 3.2 bars anything content-descriptive, which removes the only fields anyone would be tempted to add. A field with no consumer should not exist.

**The two consequences both locked documents name.**

*Whether the grant must sign metadata constraints:* no, and on two of three branches that is also enforceable, because a POST policy and a signed PUT both fix the header set the signature covers. **On the resumable branch it is not enforceable, and this is where section 2's evidence bears.** The data leg carries no signed URL and accepts `X-Goog-Meta-` prefixed headers on the final request, so an uploader can attach arbitrary custom metadata to the object and the grant cannot stop it. **If leaf 1 or leaf 2 is taken, the app server strips custom metadata at first mint**, which it can do with credentials it already holds, since after a custom metadata pair exists "you can delete the key or change the value" ([metadata](https://cloud.google.com/storage/docs/metadata)). Probe C decides whether that step is needed at all.

*Whether the blocklist scanner reads metadata or only object bytes:* **only object bytes.** No metadata is set by design, so there is nothing legitimate to read, and on the resumable branch anything present is attacker-supplied. Feeding attacker-controlled strings into the abuse pipeline to save a hash computation is a bad trade in both directions.

### 5.4 Cover image storage (`m/cover/`)

Per-relic cover image rasters (1200x630 pixels, up to 512 KB, PNG or JPEG) are stored in Google Cloud Storage at the content-addressed prefix `m/cover/{id}/{sha256}`. They are written by the app server upon receiving a validated `POST /api/relics/{id}/cover` request from the publishing client, using credentials held by the app server.

- **Content-addressing:** The object path includes the lowercase hex SHA-256 of the validated raster bytes. This allows content-addressed caching: a new version with a changed cover gets a new URL, cache-busting unfurlers automatically.
- **Content-type:** Set to `image/png` or `image/jpeg` matching the raster format.
- **Lifecycle and deletion:** Cover objects have no bucket lifecycle rule. When a new version is published or republishing with `cover: false` occurs, `deleteCovers(relicId)` deletes all existing cover objects under `m/cover/{id}/` and clears `row.cover`. When a relic is tombstoned, `operatorDelete` deletes all cover objects. Deleted cover objects sit in Cloud Storage soft delete per the bucket's 7-day retention policy, exactly like ciphertext objects.

## 6. The GCP project topology

`docs/preconditions.md` fixes the blast radius as project-level, and `frame.md` requires two registrable domains. Nobody has connected those two facts. **Two domains in one project is one failure domain, not two:** a suspension takes down the API, the viewer, both buckets, and the abuse tooling used to answer the notice, and the notice is what starts the clock. The obligation is not hypothetical: Google asks operators hosting third-party content to "Promptly review and address any alerts, and remove content where appropriate" ([respond to abuse](https://docs.cloud.google.com/docs/security/respond-to-abuse-misuse)), and "If you do not respond to the warning in a timely manner your project may be suspended" ([suspension](https://support.google.com/cloud/answer/7002354)).

This is an operator decision with a real cost, so both branches are designed.

**Branch A, one project.** One billing account, one IAM boundary, one signing identity, one kill switch. Buckets, the app server, the mint log, the relic rows, the tombstones, and the abuse tooling all sit together, and cross-project permission grants do not exist. *What it costs:* the failure domain is the whole product. One unanswered notice about one relic suspends the surface on which the answer would be composed, and the delete tooling that would remedy the violation goes down with it. There is no configuration inside this branch that separates the risk, because the risk is the project.

**Branch B, two projects with separate billing accounts.** A service project holds the app server, the mint log, the relic rows, the tombstones, and the abuse tooling. A content project holds the buckets and the signing service account from section 3.4, which is to say the untrusted bytes and the identity that grants access to them. The app server's runtime identity is granted object-level permissions in the content project. *What it buys:* a suspension of the content project stops serving and leaves the operator with a live API, live records, and live delete tooling to answer with, which is the difference between a bad day and a total loss. Separate billing also isolates a spend event, and the spend-cap product is per project and per service anyway. *What it costs:* two billing accounts, cross-project IAM that has to be right before it is needed, a kill switch that acts across a project boundary, and one more place for a permission to be misconfigured quietly.

**The recommendation is branch B**, on the single asymmetry that the abuse tooling must outlive the thing it is used against.

**The part that makes this urgent rather than deferrable.** Moving buckets and signing identities afterward is a migration, not a config change. "Bucket names reside in a single namespace that is shared by all Cloud Storage users" and "Every bucket name must be globally unique" ([buckets](https://cloud.google.com/storage/docs/buckets)), so a bucket in a new project takes a new name and every object path moves with it, which means copying live objects and reissuing the signing identity while relics are in the wild. **The sharper version: the migration is cheap when it is not needed and unavailable at the moment it is**, because the trigger for wanting it is a suspension, and a suspended project is not a place to run a migration from. This is reasoning from what suspension means rather than from a documented statement of suspended-project capabilities, and it is flagged as such.

## 7. Lifecycle, retention, and the published byte lifetime

### 7.1 Soft delete

**Soft delete stays enabled at the seven-day minimum.** It is not disabled and it is not raised.

The default is the setting you get by not deciding: "Soft delete is enabled by default on all buckets and has a retention duration of seven days unless you or your organization have chosen a different policy" ([soft delete](https://cloud.google.com/storage/docs/soft-delete)). This document chooses it deliberately and for a reason the default does not supply. `service.md` §4 ships bulk delete by publishing IP and time window, an operator instrument built for use under a suspension clock at inconvenient hours, and it is the tool most likely to over-delete. Disabling soft delete makes an over-broad bulk delete unrecoverable. Seven days is the minimum non-zero value, so it buys the recovery window at the least available cost in storage and in published byte lifetime.

**What deletion actually means, to three different readers.** *To a recipient:* immediate and total. "Soft-deleted objects cannot be read or modified", so serving stops at the delete call and the viewer shows the removed state. *To an abuse reporter:* the same, and that is the half that answers the notice, so nothing here weakens the takedown story. *To a legal-preservation request:* deletion is not erasure for seven days, and the operator must not claim otherwise. Soft delete is also not a preservation instrument, because its maximum is 90 days and a preservation obligation can run a year; ciphertext held under such an obligation is held deliberately and outside this policy. Soft-deleted objects also "incur storage charges until the soft-deleted objects are permanently deleted after the retention duration is over", so the tail is a line item and not only a disclosure.

### 7.2 The TTL ceiling and its lifecycle regime

**The TTL ceiling is 72 hours, 259,200 seconds.**

`docs/preconditions.md` makes this the single highest-leverage control, bounding how long any abuse can circulate, and `frame.md` locks expiry configuration out as a non-goal, so this is an abuse control rather than a product convenience.

**The Friday-to-Monday justification this number usually gets is conditional, and it is stated with its conditions.** The case that works is a Friday 5:00 PM publish read Monday morning: 72 hours reaches Monday 5:00 PM, so a Monday-morning reader has hours in hand. Three ordinary cases do not work. A Monday public holiday makes it Friday to Tuesday, 96 hours or more. A Friday-morning publish read Monday afternoon is about 76 hours. And it fails outright across timezones: a Friday 5:00 PM AEST publish is 07:00 UTC Friday, and a US recipient opening it Monday 9:00 AM PDT is at 16:00 UTC Monday, 81 hours later. `service.md` §3 makes the app server's clock authoritative and never the publisher's, so a local Friday afternoon is not a fixed point to begin with. **72 hours is kept anyway, and the honest claim is that it covers the common case and leaves the rest to a republish**, which the locked republish non-goal makes a new relic and a new URL rather than an extension. The recipient's remedy is to ask the publisher, and that is a real remedy for a colleague and a poor one for a broadcast, which is the direction this product wants the asymmetry to run.

**The abuse-side argument is weaker than it reads, and it is stated at its real strength.** `docs/preconditions.md` says malware campaigns need links that live for days, and 72 hours is three days, so this ceiling sits at the low end of the days band rather than outside it. It is a real reduction in circulation time and not a disqualifier for the abuse case. Holding it any other way overstates what the highest-leverage control actually buys.

**Which regime it lands in: the expressible one.** `service.md` 7.3 notes that anything under a day is inexpressible in lifecycle and is enforced only at the application layer. Seventy-two hours is a whole number of days, so it expresses as an Object Lifecycle Management rule with an age condition of 3 and does not fall into the application-only regime. Both halves still run, and they are not equivalent: the app server's refusal to mint past the ceiling is exact to the second and is the abuse-bounding control, while the lifecycle rule is storage hygiene and lags, because "Changes to a bucket's lifecycle configuration can take up to 24 hours to go into effect" and "Object Lifecycle Management might still perform actions based on the old configuration during this time" ([lifecycle](https://cloud.google.com/storage/docs/lifecycle)). Nothing is served in that gap, per `service.md` 3.1.

**This number is what bounds `design-container-and-crypto`'s v2 migration cost, and the bound is tighter than the shape that document was handed.** `docs/design/container.md` section 8 states the bound on carrying two decoders as the mandatory TTL plus the signed URL's validity window, and records that no number for the TTL existed yet. **The additive term is already discharged.** `service.md` §3 clamps signed URL validity to `min(url_validity, relic_expiry)` at mint, which section 4.2 above restates and sizes, so no signed URL can outlive relic expiry and there is no overhang to add. Tighter still: section 4.2's 300-second minimum viable validity means the last mint a relic can serve happens at TTL minus 300 seconds, and the URL it returns dies exactly at the ceiling rather than past it.

**So the bound is 259,200 seconds flat, and a v1 decoder can be retired 72 hours after the last v1 writer stops publishing.** The only residual is a transfer already in flight at that instant, which section 3.3 flags and routes to `build` and which is bounded by one object's transfer time rather than by a policy window. Reporting 72 hours and 15 minutes would be a real error in the consumer's direction, since `container.md` asked this document for the number and would have received the discharged reasoning along with it. The reasoning that produces the extra 900 seconds lives in `docs/preconditions.md` section 3 and routes as drift in section 8; it is named there, not acted on here.

### 7.3 The retention window

**The retention window is 90 days, set against the 72-hour TTL.**

`service.md` 7.5 names the failure a short window causes: a retention window shorter than the TTL silently stops the metric's publishing-IP filter firing on older relics, because the filter compares an open's requesting IP against the relic's publishing IP and the relic row has to still exist. At 90 days against 72 hours the window exceeds the TTL by a factor of 30, so the filter cannot silently stop, and it also exceeds the seven-day soft-delete tail, so the tombstone always outlives the bytes it describes. That ordering is the one that matters: `service.md` §4 makes the tombstone what any `410` rests on, so a record aging out before the object does would degrade a removed relic to `404`.

Ninety days also gives roughly thirteen weekly buckets, which is what `frame.md`'s trust condition needs to be evaluated rather than asserted, since that condition is stated in relics per week and distinct publishing IPs. And it bounds how long the tombstone and the mint log's `code` survive, which `service.md` 1.2's cap-exhaustion mitigation depends on entirely, since `code` is the only place cap exhaustion, expiry, and the three flavors of deletion stay distinguishable.

**The cost, named because nothing else names it.** After 90 days the relic row and the tombstone age out, so `service.md` 1.3's three-way split collapses and a relic that was removed or that expired returns `relic_not_found`. That is correct at 90 days and it should be stated in the disclosure statement rather than discovered by a publisher.

### 7.4 The published byte lifetime

The published number is not the TTL, and it is not one number per `service.md` §5 item 5, which requires retention stated per sink. For object bytes the arithmetic is: **72 hours of TTL, plus lifecycle execution lag at day granularity and up to 24 further hours after any configuration change, plus the seven-day soft-delete retention.** That is up to roughly twelve days from publish to permanent deletion, against a 72-hour figure a publisher would otherwise infer. Application records, edge logs, GCS access logs where enabled, and the intake mailbox each carry their own window and are listed separately, per `service.md` §5.

**One obligation the arithmetic has to count.** A legal-preservation obligation can require retaining ciphertext the operator cannot read for a year or longer, which exceeds every window above and exceeds soft delete's own maximum. Such holds are outside the lifecycle regime by construction, and the disclosure statement has to say that a preservation obligation suspends the published lifetime rather than implying the lifetime is unconditional.

## 8. Drift routed, not fixed

Five items. None is an edit to a locked document and none changes a rule those documents fix.

1. **The egress rate, to `specify`, owners of `docs/preconditions.md` and `docs/spec/service.md`.** Both cite a third-party blog for $0.12/GB for the first TB. Google's own table puts the first-tier boundary at 10 TiB and makes the rate destination-dependent, at $0.19 per gibibyte to Australia and $0.23 to China. Any worst-case ceiling computed at a flat $0.12 understates for a non-US audience. Section 3.1 carries the corrected figures.
2. **The signed-URL revocation attribution, to `specify`, owner of `docs/preconditions.md`.** Section 3 attributes the claim that signed URLs cannot be revoked individually to the access-control page. Grep over the raw page returns zero occurrences of any form of the word revoke, as does the signed-URLs page. The claim is true in effect, and the sentence that carries it is on the signed-URLs page and includes the key-rotation exception the claim omits, which section 3.3 depends on.
3. **`publish.md` 4.4's egress claim, to `specify`, owner of `docs/spec/publish.md`.** That section prices restart-at-zero retries as doubling or tripling egress. Upload traffic is inbound and free per the pricing page. Section 5.2 states what the retries actually cost and why this changes how two leaves of section 2.3 should be read.
4. **Six quotations against their own sources, to `specify`.** One is a substitution: `docs/preconditions.md` section 1 renders the suspension page as if you don't respond to the warning in a timely manner, your project might be suspended, where the page reads "If you do not respond to the warning in a timely manner your project may be suspended". Three words differ and a comma is added. **That finding rests on the direct comparison against the source page and on nothing else.** An earlier reading of it used `service.md` §4 as a control, on the belief that §4 quotes the same page correctly and that the difference is therefore a defect rather than house style. **The control is false.** `service.md` §4 carries two folds of its own, both sentence-initial in source: the abuse-response sentence and the suspension sentence, which section 6 above quotes at their source capitalization. The substitution stands on the source comparison alone, and it is worth stating that it never needed the control, because a defect resting on a false premise is one re-read away from being dropped for the wrong reason. The other five deviations are mechanical case folds of a sentence-initial capital, one in `service.md` 3.1, two in 3.2, and twice in §4. Each matches its source under a case-insensitive comparison and the meaning is unchanged in all five. They are recorded because the run's check is a string comparison and a folded initial fails it, not because any argument is affected.
5. **A discharged basis under a locked sentence, to `specify`, owner of `docs/preconditions.md`.** Section 3's mandatory-TTL entry closes with a stated gap: "a URL minted a second inside the ceiling stays valid for its own lifetime, so the real bound on circulation is the TTL plus the signed URL's validity window, not the TTL". That reasoning was sound when it was written and it is now discharged. `service.md` §3 clamps validity to `min(url_validity, relic_expiry)` at mint, so no signed URL can outlive relic expiry and the additive window does not exist. **The rule the sentence supports is untouched and stays exactly as locked:** the mandatory TTL is still the control, 259,200 seconds is still the ceiling, and the ceiling is still the real bound on circulation. What is gone is the reason for adding a term to it. This document names the discharge and does not act on it, and no downstream unit should either; the sentence holds until its owner revisits it. **It is routed rather than merely noted because it has a consumer.** `docs/design/container.md` section 8 repeats the same reasoning to bound its v2 decoder-retirement cost and states that the number is this document's to supply. Section 7.2 supplies 259,200 seconds and not 259,200 plus 900, so the consumer receives the discharged form and the discrepancy is on the record rather than looking like an arithmetic slip.

## 9. Sibling inputs, and what this document needs

Neither sibling input had landed on the station branch. `docs/design/container.md` was read from `darkrun/relic/units/shape/design-container-and-crypto` and `docs/design/topology.md` from `darkrun/relic/units/shape/design-topology-and-origins`, both at the tips of those branches. Nothing either settles is redefined here.

Stated as needs, with the owner named.

1. **Browser memory behavior.** The former whole-file memory calculation is
superseded by section 1.2. Browser-managed Blob placement and device limits
remain implementation-dependent.
2. **A grant-time refusal code for an invalid or expired proof-of-work solution, from `specify` as owner of `docs/spec/service.md`, and only if difficulty ever goes non-zero.** Section 5.1 sets the trigger and the target solve time; the code is not this document's to invent.
3. **The probes in section 2.2 run before the grant branch is committed, from `build`.** A negative result eliminates a branch rather than filing a bug, and every leaf of section 2.3 except leaf 1 obliges a drift routing that should travel with the result.
4. **The rotation propagation measurement in section 3.4, from `build`, alongside needs 3 and 5.** One observation, recorded once: the delay between deleting a user-managed signing key and an outstanding signed URL failing. **It sits with `build` for the same reason the probes do.** It needs a billed project, a live signing identity, a real object, and an outstanding URL against it, and no `shape` design unit has any of those, which is the reason section 2.2 gives for not running the probes here. It is specifically not `design-operations-and-abuse`'s: that unit's brief puts the grant construction out of scope, none of its criteria produces a signing-key measurement, and it holds exactly the GCP access this document holds, which is none. Routing it there would leave the kill switch's second stage permanently unproven while looking assigned. Until the measurement exists the second stage is bounded by the 900-second validity window rather than by rotation, per section 3.4.
5. **The in-flight expiry observation flagged in section 3.3, from `build`, alongside the probes in section 2.2.** Start a download of a cap-sized object on a signed URL with seconds of validity left and record whether the transfer completes. It costs one object and one fetch, it settles a term in the kill-switch residual, and the design in section 4.2 holds either way.
