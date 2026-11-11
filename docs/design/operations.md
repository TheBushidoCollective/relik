# Relic: the abuse pipeline, the monitoring surface, and the price of yes

`docs/preconditions.md` section 1 states a go/no-go: if the collective will not commit to ongoing abuse operations, the correct answer is do not build Relic. That has been true and unpriced for the whole run. This document prices it, so the answer is a decision rather than a hope.

It decides the triage policy, specifies the intake-to-resolution pipeline, specifies the reconsideration artifact, fixes the monitoring surface, closes three gaps no other document owns, decides the published SLA, and closes with an itemized list of commitments the operator can answer yes or no to.

`docs/frame.md`, `docs/preconditions.md`, `docs/spec/service.md`, `docs/spec/format.md`, `docs/spec/publish.md`, and `docs/spec/viewer.md` are locked inputs. `docs/design/container.md`, `docs/design/storage.md`, and `docs/design/topology.md` are sibling inputs, consumed and never reopened. None had landed on the station branch when this was written; section 8 records which ref each was read from. `design-product-surface` runs beside this unit and its output is not read here. Where this pipeline depends on a screen that unit owns, both branches are designed and it is named as the owner.

## 0. This is not legal advice, and holding that line is a deliverable

Nobody who wrote this is a lawyer. Everything below that describes a legal obligation is a report of what raw statutory and regulatory text says, quoted from the text and cited, with the heading or scope clause the quotation sits under stated alongside it. That last part is the discipline that matters. An article can read as general while sitting under a definitions section, a size threshold, or a conditional opener that excludes the service, and a verbatim quotation carrying none of that is worse than no quotation, because it is confident.

Two of the load-bearing questions are not answerable by more reading, and no amount of further research closes them. They are listed with the rest in section 7, by name, so the operator sees them without reading this whole document.

The favourable text is stronger than `docs/preconditions.md` claims when it calls the posture an untested theory. It is right about outcomes and it understates the text. Both regimes say in terms that there is no general duty to look.

**EU.** Regulation (EU) 2022/2065, Article 8, whose own heading is "No general monitoring or active fact-finding obligations", in full ([DSA](https://publications.europa.eu/resource/celex/32022R2065)):

> No general obligation to monitor the information which providers of intermediary services transmit or store, nor actively to seek facts or circumstances indicating illegal activity shall be imposed on those providers.

Article 7 adds that a provider is not "deemed ineligible for the exemptions from liability referred to in Articles 4, 5 and 6" for carrying out voluntary own-initiative investigations, so the blocklist scanner costs nothing under this Regulation.

**US.** 18 U.S.C. 2258A(f) ([18 USC 2258A](https://www.law.cornell.edu/uscode/text/18/2258A)), under the subsection heading "Protection of Privacy", opening with the scope clause "Nothing in this section shall be construed to require a provider to", then three numbered items. Item (1) is to

> monitor any user, subscriber, or customer of that provider

and item (3) is to

> affirmatively search, screen, or scan for facts or circumstances described in sections (a) and (b)

Read the scope clause with the items. This is a construction rule about section 2258A, not a general immunity, and it does not reach the GCP Acceptable Use Policy obligations, which are contractual and independent of every statute in this document.

**Takedown by ID satisfies both regimes, and this is the cheapest good news in the design.** DSA Article 16(2)(b), under "Notice and action mechanisms", listing what providers must enable a notice to contain, asks for

> a clear indication of the exact electronic location of that information, such as the exact URL or URLs

17 U.S.C. 512(c)(3)(A)(iii) ([17 USC 512](https://www.law.cornell.edu/uscode/text/17/512)) asks for

> Identification of the material that is claimed to be infringing or to be the subject of infringing activity and that is to be removed or access to which is to be disabled, and information reasonably sufficient to permit the service provider to locate the material.

carrying the scope clause at 512(c)(3)(A), which is that "To be effective under this subsection, a notification of claimed infringement must be a written communication provided to the designated agent of a service provider that includes substantially the following". A reporter holding a relic URL supplies exactly what both ask for, and delete-by-ID acts on it without ever touching the fragment.

**The asymmetry that costs the operator everything.** DSA Article 16(3): notices

> shall be considered to give rise to actual knowledge or awareness for the purposes of Article 6 in respect of the specific item of information concerned where they allow a diligent provider of hosting services to identify the illegality of the relevant activity or information without a detailed legal examination

Knowledge arrives from the reporter's assertion, never from the operator's inspection. An operator who cannot read the content cannot verify a claim, and cannot safely ignore one either. Section 1 is the only honest response to that sentence.

## 1. The triage policy, which has a forced answer

**Decision: delete on plausible report, with no adjudication. One rule, applied uniformly, to every report in every category, from every reporter.**

The operator cannot triage on content, so every report is acted on or refused on the reporter's say-so. There is no third option that involves looking.

**The cost asymmetry is stark and it runs one way.** Deleting a legitimate relic costs the publisher one republish. There is no versioning, no accounts, and no dashboard, so nothing is lost but a URL, and the TTL is 72 hours anyway (`docs/design/storage.md` 7.2) [Amendment: the mandatory 72-hour TTL was reversed in `docs/decisions.md`; a relic is kept until deleted, though a publisher may set a lifetime; versioning via publish tokens was added in `frame.md`; and a client-side `/dashboard` was authorised by Jason Waldrip on 2026-10-06, with the homepage linking to it as of 2026-11-05. The operational cost asymmetry still holds because deleting a relic deletes ciphertext and tombstone metadata, without destroying a publisher account or server-managed portfolio], so most wrongly deleted relics were hours from expiring. Not deleting risks a project-level suspension, and `docs/preconditions.md` names the mechanism precisely: "Read the blast radius carefully. It's project-level, not bucket-level. One unanswered notice takes down the API, the PWA, the storage, and the abuse tooling together, including the tooling you'd use to respond."

> If you do not respond to the warning in a timely manner your project may be suspended

**One republish is the cheap case and it is not the universal one.** `frame.md`'s cleanest segment is headless and CI agent runs, and a job that published a report and exited no longer holds the plaintext, so for that segment a wrongly deleted relic costs a rerun of the job or the output outright, not a second upload of a file still sitting on somebody's disk. That is a real cost and it lands hardest on the segment the frame cares most about. **It does not move the decision**, because the other side of the comparison is every relic the service is serving going dark for as long as the content project stays suspended, and no rerun cost approaches that. It is stated because the one-republish framing is the version that gets repeated, and repeating it at the segment where it is false is how a policy looks cheaper than it is.

The two outcomes are one republish against every live relic going dark, with no accounts and no channel to tell any holder of a link why, for as long as the suspension runs. Nothing about content inspection would change that ratio, which is why the answer is forced rather than chosen.

**This is written into the published terms as a policy, not discovered later as a capitulation.** The publishable language:

> **How we handle reports.** Relic cannot read what you publish. Files are encrypted on your machine with a key we never receive, so when somebody reports a relic we have no way to look at it and judge whether the report is true. We do not try. If a report identifies a relic and states a plausible reason, we delete that relic. We do not weigh the reporter's claim against the publisher's, because we have nothing to weigh it with. This is our rule for every report and every category, and we apply it the same way every time. If your relic is deleted and you believe the report was wrong, publish it again: a new relic is a new URL. We will not restore the old one and we cannot.

Two consequences, both stated out loud rather than discovered.

**It is a griefing vector, and its bound is who holds the link.** Anybody with a relic URL can delete that relic by reporting it, because the ID is in the path and the operator will act on the ID. For a relic handed to one colleague the vector is bounded by that colleague. For a relic posted publicly it is unbounded, and the remedy is the same as every other failure in this product, which is republish and get a new URL. The cost of an attack is one webform submission and the cost of the remedy is one republish, so the exchange rate is poor for the publisher and the design has nothing better to offer, because anything better requires either identity or inspection and both are locked out.

**That vector is priced per relic above, and it is a different and worse vector priced as a volumetric attack, which nothing in this document prices anywhere else.** Every other v1 write surface carries a control against being hammered: `service.md`'s status table gives publish and mint their own refusal codes, `publish_rate_limited` and `mint_rate_limited`, and `publish.md` 3.1 scopes proof of work to the publish challenge alone. `/abuse` has neither a rate limit nor a cost gate in any locked document. An attacker who harvests relic URLs, from a public post, a scraped channel, or a leaked list, submits one report per URL and triggers mass deletion at the price of one webform submission per relic, with no per-IP throttle in the way. **None of section 4's standing checks would see it while it runs.** The SLA check measures median and maximum hours, and a fast wave of deletions makes that number look better, not worse, because every one of them resolves instantly against a policy with no adjudication in it. **The need: a per-IP rate limit on `/abuse` submissions, symmetrical with the limits `service.md`'s status table already gives publish and mint.** This is not one of the four siblings' decisions; it is a gap in the locked rate-limiting scheme itself, so the owner is `build`, which adds the limiter under a refusal code `service.md` does not yet have. Section 4 below adds the standing check that watches for what a rate limit alone would still let through in slow motion, spread across enough addresses to stay under any single-IP threshold.

**It converts the DSA's processing standard from an exposure into a defensible position.** Article 16(6) requires providers to process notices and take decisions

> in a timely, diligent, non-arbitrary and objective manner

with no hour figure anywhere in the Regulation. A discretionary policy has to defend each exercise of discretion against that standard. A policy with no discretion in it has nothing to defend: one rule, applied uniformly, with no case-by-case judgement, is non-arbitrary and objective by construction. The property the operator gets for free is the one an operator with a moderation team has to work for.

**One SLA covers every category, and that follows from this section rather than being a separate choice.** Tiering the response time by category would require judging the category, which is adjudication under another name. Section 6.3 publishes one number.

## 2. The pipeline, from intake to resolution

`docs/spec/service.md` section 4 already builds most of the automatable half. This section names every step in both halves, plus the screen that gates them and every report passes through first, and says which is which, because the whole viability argument for a one-person operation is that the non-automatable half, screen included, stays short.

### 2.1 What automates

1. **Receipt acknowledgement**, sent on submission, carrying the relic ID as normalized and the occurrence identifier if the report came from an error screen. **The DSA duty this discharges is conditional, and the condition matters here.** Article 16(4) reads:

   > Where the notice contains the electronic contact information of the individual or entity that submitted it, the provider of hosting services shall, without undue delay, send a confirmation of receipt of the notice to that individual or entity.

   `service.md` 4.1 makes reporter contact optional except on `copyright` and `legal_process`, and Article 16(2)(c) itself excuses contact details for reports involving "the offences referred to in Articles 3 to 7 of Directive 2011/93/EU". So on an anonymous report there is no duty, no address to send to, and nothing owed. **This is the second place the no-accounts non-goal reduces the compliance surface**, the first being Article 17(2) on statements of reasons, and it is worth stating because the automation looks like it is discharging a universal obligation and is not. Article 16(5)'s duty to notify the reporter of the decision hangs off the same antecedent and is read here as inheriting the same condition. Whether that reading is right is a counsel question, listed in section 7.
2. **URL-to-ID extraction**, stripping the origin and everything from `#`, client-side and server-side, per `service.md` 4.1. The server-side strip is the one that counts, because it is the only one a no-JavaScript submission reaches.
3. **ID normalization before anything is keyed**, per `service.md` section 6 and `format.md` 1.1: case-fold, apply Crockford's decode aliases, reject hyphens. Skipping this fragments the lookup across spellings and a report about a live relic returns not-found.
4. **Delete-by-ID**, which tombstones the row, stops serving immediately, and needs no decryption secret.
5. **Ciphertext-hash blocklist insertion**, conditioned on the reason class fixed in `service.md` 4.1 and unconditional on category `csam`.
6. **Publishing-IP lookup**, reading the relic row or the tombstone by normalized ID and returning the upload IP and timestamp.
7. **Bulk delete by publishing IP and time window**, which is what a campaign notice actually needs.
8. **The audit record on every operator call**, naming the operator, the relic ID, the reason class, the timestamp, and the report reference.

Steps 2 through 8 are `service.md` section 4's, restated here only to show the automated path is complete end to end. A report that clears the screen described in section 2.2 travels this remaining distance, steps 2 through 8, with no further human decision. The screen, not this list, is the one human touch every report gets, and it is what section 6.3 prices as the SLA's dominant cost.

**A publisher deleting their own relic uses this same path.** `publish.md` states that self-delete is not a tool and that deletion stays operator-only through `/abuse`. Under section 1's rule that costs the publisher nothing extra, because their report is plausible on its face and gets the same treatment as any other.

### 2.2 What cannot automate

Six items. The first is the one every report gets, and the sixth is the one that used to decide whether one person could run this, before section 1 answered it.

1. **The screen.** Every report that reaches `/abuse` or the alias is read by the operator, or the named backup, before section 2.1's automated steps fire on it. The screen answers one question: does this report's own text put it in one of items 2 through 5 below, does it trip the mandatory-report question in counsel question 9 (section 7), or does it read as a data-subject report under section 2.3? That is a routing decision, not a credibility one: section 1 already forecloses judging whether the underlying claim is true, and the screen does not reopen that question, it only asks which path the report takes next. If the answer is no on every count, the report proceeds through section 2.1 with nothing further from a human. If the answer is yes on any count, section 2.1 still fires regardless, because section 1's delete-on-plausible-report policy is unconditional, and the report additionally opens the matching item below, or the path in section 2.3 for a data-subject report. **This is the step section 2.1's earlier reading omitted, and naming it corrects that section's closing claim:** the routine path was never the zero-human path it read as. A human touches every report once, briefly, a read rather than an investigation, and that touch, not the mechanical steps behind it, is what section 6.3 prices as the SLA's dominant cost.
2. **The criminal-threat branch.** DSA Article 18(1), under the heading "Notification of suspicions of criminal offences", fires where a provider

   > becomes aware of any information giving rise to a suspicion that a criminal offence involving a threat to the life or safety of a person or persons has taken place, is taking place or is likely to take place

   and then

   > it shall promptly inform the law enforcement or judicial authorities of the Member State or Member States concerned of its suspicion and provide all relevant information available

   Awareness arrives through the intake, because the operator cannot inspect. Nothing about this is automatable: it needs a human reading free text at whatever hour it lands, deciding whether the threshold is met, and finding the right authority in the right Member State. **Article 18 is not in the micro-enterprise relief.**
3. **A mandatory-report filing.** 18 U.S.C. 2258A(a)(1) attaches on actual knowledge and requires action "as soon as reasonably possible after obtaining actual knowledge". Penalties under 2258A(e) are sized for a company:

   > in the case of an initial knowing and willful failure to make a report, not more than $850,000 in the case of a provider with not less than 100,000,000 monthly active users or $600,000 in the case of a provider with less than 100,000,000 monthly active users

   so a small provider's initial exposure is $600,000 and a second is $850,000. **And filing collides with the published retention story.** 2258A(h)(1), under the heading "Preservation", makes a completed submission

   > treated as a request to preserve the contents provided in the report for 1 year after the submission to the CyberTipline

   A year exceeds the 90-day retention window and the seven-day soft-delete tail in `docs/design/storage.md` 7.1 and 7.3, and it exceeds soft delete's own 90-day maximum. So a filing obliges the operator to hold ciphertext it cannot read, outside the lifecycle regime, for a year, and the disclosure statement has to say a preservation obligation suspends the published lifetime rather than implying the lifetime is unconditional. `storage.md` 7.4 already reaches that conclusion from the lifecycle side; this is the specific obligation that triggers it.

   **Whether an unverified report is itself "actual knowledge" within 2258A(a)(1) is not answered by more reading, and it is counsel question 9 in section 7.** DSA Article 16(3)'s actual-knowledge test is answered in section 2.1 item 1 by the reporter's assertion alone, with no verification step; the same question for the US statute is criminal-adjacent, carries the $600,000 and $850,000 exposure above rather than a civil liability exemption, and may read more strictly. **The interim operational default, pending that answer:** every report landing in category `csam` is treated as triggering the filing duty and is filed on, whether or not the underlying claim is later shown false. The asymmetry in 2258A(e) makes this the safe default rather than a cautious guess, because the penalty attaches to a knowing and willful failure to report and never to a report filed on a claim that turns out mistaken, so over-filing against an unresolved standard costs the operator nothing under the statute while under-filing risks the exposure named above. **This does widen the filing duty past "rare" if `csam`-labeled reports arrive at volume**, which is exactly the scenario section 1's rate-limit fix and section 4's ninth check exist to keep from happening, and mislabeling stays free to an attacker under this default the same way it is free under the DSA reading. That is a residual risk this document names rather than closes.
4. **A law-enforcement request.** Delivered by a channel nobody controls, scoped by a document somebody has to read, answered from the tombstone's upload IP and timestamp. The operator has nothing else to give, and saying so credibly is itself the work.
5. **A reconsideration request.** Section 3.
6. **The judgement of whether a report is credible at all.** **This one is answered by section 1, and that is what makes a one-person operation viable against everything except the screen above.** Every item 2 through 5 is rare. Credibility judgement is a different and heavier thing than the screen: it does not end at a routing decision, it ends at a verdict on whether the reporter is telling the truth, and it would arrive on every single report rather than the rare ones. Removing it, not the screen, which stays and is priced into the SLA, is the difference between an operation that scales to a volume one person can absorb and one that does not.

### 2.3 The data-subject report

A person reporting their own leaked file is owed the same handling whether or not the form offers them a category to say so. So this path is specified against the report type rather than against a label.

**Whether the form shows a personal-data category, and what it is called, is `design-product-surface`'s decision. It is not in this document's inputs and this document does not add a category to the form.** The need is stated, the owner is named, and both branches are designed.

**Branch A, the form has a dedicated category.** Reports arrive pre-routed. Intake changes only in that the category maps to a reason class, and the mapping follows `service.md` 4.1's existing rule for a non-legal, non-blocklist origin, which is class `abuse`. Nothing else in the pipeline moves.

**Branch B, the form has no such category.** These reports arrive in `other`, which `service.md` 4.1 already maps to class `abuse`, so the action is identical and only the detection differs, and detection is the screen's job rather than a second mechanism built beside it. Section 2.2 item 1 already reads every report's free text end to end, for every report, before any automated step fires, and recognizing a first-person claim about the content's subject, in whatever words the reporter used to make it, is one more question asked during a read that already happens rather than a separate pass with its own failure modes to name and maintain. **The flag routes, it never decides.** A false positive costs one extra branch on a report that was going to be deleted anyway, because the action is the same under section 1; a false negative costs the response obligations below, which is the expensive direction, and a human reading the whole report for meaning is the wider net for that direction, not a narrower one built to catch a fixed phrase shape. **This is also why a separate automated matcher does not earn its place here.** A pattern tuned to possessive phrasing is a strictly narrower reader than the operator who reads the same sentence at the same moment for the criminal-threat branch, the mandatory-report question, and every other item this screen already routes on; it would carry its own adjacency limits and its own language coverage to state and maintain, for no report the screen does not already see. Nothing here reopens the credibility question section 1 already forecloses: the screen still only asks which path a report takes next.

**The obligations the path triggers, under either branch.** Regulation (EU) 2016/679 Article 17(1) ([GDPR](https://publications.europa.eu/resource/celex/32016R0679)), heading "Right to erasure ('right to be forgotten')":

> The data subject shall have the right to obtain from the controller the erasure of personal data concerning him or her without undue delay

and Article 12(3) sets the response clock, which the controller

> shall provide information on action taken on a request under Articles 15 to 22 to the data subject without undue delay and in any event within one month of receipt of the request

**Unlike Article 16(4) and (5)'s DSA duties in section 2.1, which this document reads as discharged where the notice carries no contact information, Article 12(3) carries no equivalent textual condition.** The DSA case is resolved explicitly, on the text's own terms; this document does not import that resolution here by silent analogy. Whether Article 12(3)'s one-month clock discharges vacuously against an anonymous data-subject report that supplies no return channel to receive the information the article requires, or whether it keeps running regardless and is satisfied by the public reconsideration-and-log document in section 3 standing in for a personal reply, is counsel question 10 in section 7.

**Identity is the part that does not work, and the text anticipates the shape of the problem without resolving Relic's version of it.** Article 12(6) lets a controller with "reasonable doubts concerning the identity of the natural person making the request" ask for more, in that

> the controller may request the provision of additional information necessary to confirm the identity of the data subject

and Article 12(2)'s closing clause says the controller

> shall not refuse to act on the request of the data subject for exercising his or her rights under Articles 15 to 22, unless the controller demonstrates that it is not in a position to identify the data subject

Sharper still, Article 11, whose heading is "Processing which does not require identification", conditions its whole operation on a scope clause at 11(1), which is that the purposes of processing "do not or do no longer require the identification of a data subject by the controller". Where that holds, 11(2) says the controller informs the data subject it cannot identify them, and then:

> In such cases, Articles 15 to 20 shall not apply except where the data subject, for the purpose of exercising his or her rights under those articles, provides additional information enabling his or her identification.

**Read the exception precisely, because it is the crux.** A reporter holding a relic URL supplies information that identifies the object, not information that identifies the person. Whether handing over a URL is "additional information enabling his or her identification" within Article 11(2), and whether Relic is a controller at all of personal data that sits inside ciphertext it cannot read and was published by somebody else, are both counsel questions and both are in section 7.

**The resolution, which is the same under every branch above.** The relic is deleted by ID. That is what the requester wanted, it is what section 1 does with every report, and it does not depend on identity being established, on the operator reading anything, or on the legal analysis coming out any particular way. The response owed within Article 12(3)'s month is a statement that the object was deleted, that its bytes persist in a restorable state for the soft-delete window per `storage.md` 7.1, that the operator cannot confirm what the object contained, and that the operator holds the publishing address and timestamp for the published retention window. **The one thing the operator must not do is claim erasure**, because `service.md` 3.2 already fixes that Relic never promises it.

## 3. The reconsideration artifact, which must exist before it is needed

The Safe Browsing listing appeal is not a remedy the operator controls, and the design must not lean on it as a mitigation.

**The review flow is built on looking at the content, and every step of it is a content-inspection step.** From Google's Security Issues report documentation ([Search Console](https://support.google.com/webmasters/answer/9044101)), the harmful-downloads remediation opens with

> View some of the example pages on your site to confirm the presence of these downloads.

and the request itself asks that

> A good request does three things: Explains the exact quality issue on your site. Describes the steps you've taken to fix the issue. Documents the outcome of your efforts.

with a penalty for guessing:

> Submitting a reconsideration request when the issue hasn't been fixed can cause longer turnaround time for the next request, or even get you marked as a repeat offender

**And the sample URL handed to the operator is the one form of the link that cannot open the content.** Safe Browsing canonicalization, from the URLs and Hashing reference, second step of the canonicalization procedure ([Safe Browsing URLs and hashing](https://developers.google.com/safe-browsing/reference/URLs.and.Hashing)):

> Second, if the URL ends in a fragment, remove the fragment.

For Relic the fragment is the key. The operator visits the sample and sees the missing-key state, forever, whatever the relic held. Timing makes it worse rather than better: "A review can take from a few days to a few weeks to complete." and, for reconsideration generally, "Most reconsideration reviews can take several days or weeks".

**So the only truthful request a zero-knowledge operator can file describes a process and a takedown log rather than a fix.** That document is specified now.

**It lives at the published policy URL, as a linked subdocument at a stable path under it, and it is a public page rather than a file the operator composes under a listing.** Public because the reconsideration request is not the only consumer: the same document answers a GCP abuse notice, a mail-gateway delisting request, and a reporter asking what happens to reports. Composing it under a listing means composing it at exactly the moment `preconditions.md` says the operator has to treat every notice as same-day.

**Required contents, all of which are true without inspecting anything:**

1. The structural statement: content is encrypted client-side, the operator never receives the key, and the operator therefore cannot confirm, reproduce, or characterize what any sample URL contained.
2. The triage policy from section 1, verbatim, as the standing rule.
3. The published SLA from section 6.3, with the operator's measured median and maximum over the reporting period, taken from the intake timestamps and the delete tooling's log per `preconditions.md` section 1.
4. The takedown log in aggregate: reports received, relics deleted, and the count by reason class, over the period. Never per-relic detail, because `service.md` 1.4 withholds the reason publicly and a log that names reasons per ID reverses that.
5. The controls that bound circulation regardless of any individual takedown: the 72-hour TTL, the 64-mint per-object cap, the 100 MiB size cap, and the per-IP publish quota, each as a number from `docs/design/storage.md`.
6. The statement that the sample URLs supplied are canonicalized without their fragments and are therefore not openable by the operator, with the Safe Browsing canonicalization quoted above as the reason.
7. The intake path and the named human behind it.

**It is publishable before the first listing rather than written under one.** The check is a scheduled fetch of its URL asserting 200, which section 4 already runs against the policy URL.

**One category Relic sits in permanently, and it is not a failure of operations.** From the same Security Issues page:

> Uncommon downloads Your site is offering a download that Google Safe Browsing hasn't seen before.

whose auto-lift condition is that

> These warnings are lifted automatically if Google Safe Browsing verifies that the files are safe.

and whose remediation is hobbled before it starts:

> Note that example URLs are not always given for this issue.

Every relic is unique ciphertext under a unique key, so every relic is by construction a file the reputation system has never seen, and the auto-lift condition can never fire on an encrypted object. **Whether that surfaces as a user-visible browser download warning depends on the download delivery path and is unverified.** `docs/design/topology.md` section 2 decides that bytes reach disk only through a `blob:` URL materialized on the viewing origin under `a[download]`, and states that no source it consulted says whether Chrome attributes such a download to the initiating page's origin for reputation purposes. **That observation goes into the same pre-launch empirical bundle as the mail-gateway test `service.md` section 6 already mandates**, which is the test this unit owns, and it answers `topology.md` section 8's second stated need. It costs one relic and one browser.

## 4. The monitoring surface

Nine standing checks. Each names what it catches and what its absence loses, because a check whose absence loses nothing should not be run and a check whose absence loses the company should not be optional.

1. **`/abuse` and the policy URL return 200, on a schedule, from outside.** *Catches:* a deploy that dropped the intake, a routing change, an expired certificate on the service origin. *Absence loses:* the go/no-go obligation, silently, and it fails in the shape `preconditions.md` warns about, since a month of zero reports reads identically to a clean service. **A 200 is not evidence the intake works.** It proves the page serves.
2. **A delivery probe on the published email alias, and a synthetic submission through the webform, both from an address outside the operator's own domain.** *Catches:* the webform posting into a mailbox nobody owns, and the alias silently spam-foldering. *Absence loses:* the only signal there is. `preconditions.md` is explicit that this is probe-verifiable and unverifiable in general, and that the failure mode is silence, so the probe is a floor rather than a proof.
3. **Public Safe Browsing listing status on both registrable domains.** *Catches:* the public half of a listing. *Absence loses:* the operator learns from a recipient, and by then section 3's document is being written under the clock. The mail-gateway half is not observable from outside at all and arrives as a support ticket, per `preconditions.md` section 2.
4. **Search Console verification status on every property, with a second verified owner on each.** *Catches:* a pulled DNS record or a redeploy without the token. Verification, in Google's words ([verify site ownership](https://support.google.com/webmasters/answer/9008080)), "lasts as long as Search Console can confirm the presence and validity of your verification token", and then "If the issue is not fixed, your permissions on that property will expire after a certain grace period." *Absence loses:* the property, and with it the only place a listing's triggering URLs are visible, which is the flagged-and-blind state verification exists to prevent. **The second owner is not a nicety.** Same source: "If all verified owners lose access to a property, all users will lose access to the Search Console property." One named human is one point of failure on the one instrument that makes a listing legible.
5. **Registrar expiry and auto-renew status on both registrable domains.** *Catches:* a lapsing registration. *Absence loses:* the domain, to whoever buys it next, and with it every link ever shared. `preconditions.md` puts this correctly as worse than a flag.
6. **The designated agent's renewal clock.** 37 CFR 201.38(c)(4) ([37 CFR 201.38](https://www.ecfr.gov/current/title-37/section-201.38)), under the heading "Periodic renewal": "A service provider's designation will expire and become invalid three years after it is registered with the Office, unless the service provider renews such designation". *Catches:* a designation about to lapse. *Absence loses:* the designation, and with it the condition 17 U.S.C. 512(c)(2) attaches to the subsection's protection, which is that "The limitations on liability established in this subsection apply to a service provider only if the service provider has designated an agent to receive notifications of claimed infringement described in paragraph (3)". This is the same expiry-nobody-is-watching class as items 4 and 5, and it has the longest period, which is what makes it the easiest to forget.
7. **Egress against the ceiling, from the billing export, plus the faster coarse estimate the app server owns.** *Catches:* the spend condition `frame.md` names and `preconditions.md` makes a deploy gate. *Absence loses:* the kill switch's trigger. **Two limits travel with this one and both are `docs/design/storage.md`'s findings.** Billing data lags, so the switch trips after the spend rather than during it. And per `storage.md` 3.2, Cloud Storage is not on the eligibility list for platform spend-cap budgets, so capping the app server stops minting and nothing at the platform level stops GCS egress. The signing-key rotation in `storage.md` 3.4 is the second stage, and it is the only instrument that truncates an already-minted URL, because "Anyone who knows the URL can access the resource until the expiration time for the URL is reached or the key used to sign the URL is rotated" ([signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)). Its propagation timing is unverified and routed to `build`.
8. **The SLA's own median and maximum hours, computed from the intake timestamp and the delete timestamp.** *Catches:* the operator drifting past the number they published. *Absence loses:* the meaning of section 6.3, since a published number nobody measures is a claim rather than a commitment. **It measures responsiveness on reports received and it is never coverage**, for the reason `preconditions.md` and `service.md` 4.1 both give: unreported abuse is invisible by construction and there is no denominator.
9. **Deletion rate and report rate against a rolling baseline.** *Catches:* the volumetric attack section 1 prices, where an attacker harvests relic URLs and submits one plausible report per URL. Every deletion it produces is individually indistinguishable from a routine one, so no per-report check sees it; only the rate does. *Absence loses:* the only signal that a wave of technically valid reports is a coordinated attack rather than ordinary abuse traffic, and it is the check that turns check 8 reading better during the attack into the anomaly it actually is.

## 5. Two leaks and one non-issue, none of which any other document owns

### 5.1 Cross-relic correlation, and where it is disclosed

`format.md` 3.8 concedes per-relic length leakage paired with the stored class. The aggregate is not stated anywhere. The mint log retains the requesting IP on every publish and every mint (`service.md` 1.2), and the relic row holds the renderer class, the publishing client name, the object's length, an optional publisher-declared plaintext title, and cover image metadata (uploaded by default and declined with `cover: false`). Across many relics from one publishing address that is not a set of independent disclosures. It is a cadence and a size profile, and it fingerprints a pipeline or a person.

**Decision on location: it is disclosed in the published disclosure statement that `service.md` section 5 specifies, as an addition to that section's first required content, the telemetry trade.** `frame.md` requires publishers to see all of it before publishing, and `service.md` section 5 assigns this document nothing but the length leak; the aggregate belongs in the same place for the same reason, which is that a publisher deciding whether to publish needs the whole picture in one document rather than the per-relic half. `design-product-surface` writes the sentence at the publishing moment in the MCP tool result, which is a different surface and not this document's.

**The legal content of that statement is this document's, so here is the sentence.** It goes under the telemetry trade, after the three items already listed there:

> These records add up. Every publish and every open is logged with the requesting network address, and every relic keeps its coarse type, the name of the client that published it, and its size. One relic tells the operator very little. Many relics published from one address tell the operator what kinds of files that address publishes, roughly how big they are, and how often, for as long as those records are retained. Relic does not build that profile and does not use it, and the records that would let somebody with operator access build it exist for 90 days. If you publish from a fixed address on a regular schedule, assume the operator can see the schedule and the shape of what you send. The operator still cannot see the contents of any of it.

(Note on title disclosure: storing the publisher-declared plaintext title on the relic row expands what the operator learns server-side. The obligation that any such expansion appear in the published disclosure statement is met: the server slice adds the plaintext title and its trade-off to `/policy` in `packages/relic-server/src/app.ts` under the telemetry section in the same change.)

(Note on cover image disclosure and abuse surface: On 2026-10-13, per-relic cover images were introduced, storing a 1200x630 plaintext raster (PNG or JPEG, up to 512 KB) at `m/cover/{id}/{sha256}` in Cloud Storage. Storing user-derived raster images on the server expands the abuse surface (for example, the potential upload of illicit imagery as link preview cards). This risk is bounded by five controls:

1. Strict server-side raster validation via `validateCoverRaster` in `@relic/format/cover`, rejecting polyglots, non-standard chunks, trailing bytes, and invalid dimensions before any write to storage.
2. Takedown primitive: `operatorDelete` immediately deletes all stored covers for the relic ID (`store.deleteCovers(relicId)`), clears `row.cover`, and returns `covers_deleted`.
3. Tombstone and expiry: immediately stop serving the cover (returning 404), reverting any link unfurl to `/assets/card.v1.png`.
4. Cache bounding: cover responses carry `cache-control: public, max-age=86400`, ensuring any caching in external proxies or unfurlers expires within 24 hours after takedown.
5. Plain disclosure: `/policy` explicitly discloses that cover pixels are stored server-side and visible without the key, with `cover: false` available to decline.)

### 5.2 Cap exhaustion and takedown are the same experience for a recipient

Both return `410`. `service.md` 1.2 accepts the cost that cap exhaustion, expiry, and all three flavors of deletion share one status, and pays it with a rule: the mint log records the `code`, not only the status. The distinct codes are for the operator's log rather than the recipient's screen.

**Whether the exhaustion case can arise at all turns on the mint trigger, which is in this document's inputs.** `docs/design/topology.md` section 5.1 took the gated branch: **the mint fires on the first trusted user input event on the page, and never on load**, with `wheel` deliberately excluded from the qualifying set because scrolling is what an automated previewer that screenshots a page does. Section 5.2 of the same document sets the mint dedup interval at 300 seconds. **That branch removes the observed previewer population and topology.md is explicit that it removes nothing else**, saying in terms that the gate "is not a barrier against an adversary who sets out to burn the cap", that such an adversary drives a browser and injects trusted input at no cost, and that deliberate cap abuse is this document's to own.

**So exhaustion arises two ways.** Legitimate over-distribution past 64 mints (`storage.md` 4.4), which a list larger than the 40-person scenario reaches honestly. And deliberate cap burn by somebody holding the link. **The control on the second is the per-IP download rate limit already in the v1 set, and its bound is honest rather than reassuring:** it limits mints per address, an attacker rotates addresses cheaply, and each unit of cap costs the attacker one mint request. The signature is visible in the mint log, which carries the requesting IP, the outcome, and the cap remaining after each attempt, so a relic burned from a narrow address set in a short window is detectable after the fact. **The remedy is republication and nothing else**, because there is no cap reset (`service.md` 1.2 reads permanence off its own counter) and no republish-to-same-URL. Cap burn is the same griefing vector as section 1's, bounded the same way, with the same remedy, and the design has nothing better.

**The screen is `design-product-surface`'s decision and this document does not have its answer, so both branches are designed.**

**Branch A, the viewer distinguishes the two.** The recipient of an exhausted relic sees a screen saying the link is spent; the recipient of a removed one sees a screen saying it was removed, with the report URL `service.md` 1.5 puts on `relic_removed`. *Ticket volume:* low, because an exhaustion screen is self-explaining and the recipient's next action is to ask the sender rather than the operator. *Triage path:* the ticket arrives already carrying the distinction, so the operator confirms it against the mint log `code` only when the reporter disputes it. *Cost per ticket:* near zero. **This branch creates no new disclosure**, and that is worth saying because it looks like it might: `service.md` 1.4 already decided the fact of removal is disclosed and only the reason is withheld, and `service.md` 1.1 already assigns distinct codes. Branch A shows what is already public.

**Branch B, the viewer does not distinguish.** Both render as one unavailable state. *Ticket volume:* higher, because every recipient of either state has the same unanswered question and the only place to ask is the operator. *Triage path:* every such ticket costs an operator-side lookup, so the lookup is specified rather than improvised.

**The lookup, in order, keyed on the normalized ID:**

1. Normalize the submitted ID per `service.md` section 6 before touching any store.
2. **A tombstone row exists:** the relic was deleted. Its private reason class says which of the three flavors, and `service.md` 1.4 governs what is said back, which is the fact and not the reason.
3. **No tombstone, the relic row exists, and its remaining cap is zero:** exhausted. The last refusal in the mint log carries `download_cap_exhausted` and the record shows which addresses spent it.
4. **No tombstone, the relic row exists, and `relic_expires_at` is past:** expired.
5. **No tombstone and no relic row:** the record aged out. **This is the answer nobody else states and the operator needs it before a reporter asks.** `storage.md` 7.3 sets retention at 90 days and names the consequence: after 90 days the row and the tombstone age out and `service.md` 1.3's three-way split collapses to `relic_not_found`. So beyond 90 days the operator cannot distinguish the two cases at all, and the honest answer is that no record is held. That limit belongs in the disclosure statement rather than being discovered by a publisher.

The lookup runs against the authenticated operator surface under the reserved `api` prefix, so it carries the per-operator credential and writes an audit record like every other operator call.

**Which is cheaper for a one-person operation: branch A.** Branch B moves a per-incident cost onto the operator that branch A pays once, at design time, on a screen. Every ticket in branch B costs a credentialed lookup, and the tickets arrive at the same inconvenient hours as everything else in this document. **`design-product-surface` owns the choice**, and this section is the input it needs rather than a decision taken on its behalf.

### 5.3 Enumeration is settled, and it is recorded as settled

Recorded here so a later station does not relitigate it as a reason to shorten IDs.

`docs/design/container.md` section 7 decided the relic ID's entropy at **125 bits, encoded as exactly 25 Crockford base32 characters**, above `format.md` 1.2's 122-bit floor, and it is the decided number rather than the floor that this record rests on. That document's arithmetic: the space is 2^125, roughly 4.25 times 10^37, every guess costs one mint request against a per-IP rate limiter, and an attacker given 10,000 addresses each sustaining 10 mints per second for ten years issues 3.15 times 10^13 requests for an expected 7.4 times 10^-25 hits. One expected hit takes 2^124 requests. Its conclusion, quoted so this record cannot drift from its source: "**Enumeration is settled at 125 bits by roughly 24 orders of magnitude, and it is settled at the value decided here rather than at the floor the value sits above.**"

**Two things follow and both are protection for `build`.** Walking the ID space is arithmetic rather than a threat model, so no abuse control in this document is sized against it and none needs to be. And a proposal to shorten the ID for URL aesthetics is not a cosmetic change: `format.md` 1.2 already records what a short ID costs, which is an enumeration oracle handing the operator-conceded metadata set to strangers, and `format.md` 1.5 records that the 25-character length is the primary reserved-word guard, so shortening moves a security boundary and a routing guard in one edit. Refusals are free to the operator at the storage layer and cost the attacker's bandwidth (`storage.md` 3.1), which is the one part of the picture that favours the defender and is not a reason to weaken the ID.

## 6. The price of yes

Itemized, concrete, and answerable. Every item that routes a number carries the number.

### 6.1 The named human and the designated agent

1. **A named human answers the abuse address, with a named backup.** Not a rotation, not an alias into a shared inbox nobody owns. This is `preconditions.md` section 1 obligation 1 and nothing below substitutes for it.
2. **A DMCA designated agent, as a named human at a publicly listed street address, registered with the Copyright Office and renewed every three years.** 17 U.S.C. 512(c)(2) conditions the subsection's protection on the designation, and requires it be made available "by making available through its service, including on its website in a location accessible to the public, and by providing to the Copyright Office". **The street address is the part people expect to avoid and cannot.** 37 CFR 201.38(b)(1)(ii): "A post office box may not be substituted for the street address for the service provider, except in exceptional circumstances". **The waiver is narrow and discretionary**, available only where there is "a demonstrable threat to an individual's personal safety or security, such that it may be dangerous to publicly publish a street address where such individual can be located" and only where, "upon written request by the service provider, the Register of Copyrights determines that the circumstances warrant a waiver of this requirement". A one-person collective without such a threat lists a real street address. **The renewal clock is three years** and it is monitored under section 4 item 6.
3. **A possible EU legal representative, who can be held liable.** DSA Article 13(1): "Providers of intermediary services which do not have an establishment in the Union but which offer services in the Union shall designate, in writing, a legal or natural person to act as their legal representative in one of the Member States where the provider offers its services", and Article 13(3) states that "It shall be possible for the designated legal representative to be held liable for non-compliance with obligations under this Regulation". **Whether it triggers turns on a definition, not on an article.** Article 3, whose heading is "Definitions" and whose opener is "For the purpose of this Regulation, the following definitions shall apply", defines at point (d) offering services in the Union by reference to a provider "that has a substantial connection to the Union", and at point (e) defines that connection by factual criteria including "a significant number of recipients of the service in one or more Member States in relation to its or their population". A relic link is openable from anywhere, so this is a fact question about the recipient population and it is a counsel question, not a research one. **Geoblocking is the real alternative and it is named rather than implied:** refusing the mint on requests from Member State addresses removes the exposure at the cost of the product not working for those recipients, and it is a decision available at the app server because the app server sees the requesting IP on every mint. It is cheap to implement, coarse, evadable, and it is the only lever short of appointing and paying a representative.

### 6.2 The public surface

4. **A published prohibited-content policy at a stable URL**, tracking the GCP Acceptable Use Policy's prohibition on using the services "to distribute viruses, worms, Trojan horses, corrupted files, hoaxes or other items of a destructive or deceptive nature" ([GCP AUP](https://cloud.google.com/terms/aup)), with the six reporter categories `service.md` 4.1 fixes.
5. **An intake path**: a stable `/abuse` URL and a published email alias, both reachable from every relic page including every error screen, working without JavaScript.
6. **The published disclosure statement** specified by `service.md` section 5, carrying the length leak, the cross-relic aggregate sentence in section 5.1 above, the per-sink retention windows, the byte-lifetime arithmetic from `storage.md` 7.4, the statement that a preservation obligation suspends it, and the 90-day record limit from section 5.2 above.
7. **The reconsideration artifact from section 3, published before the first listing.**
8. **Two published points of contact.** DSA Article 11 covers authorities and Article 12 covers recipients, and Article 12(1) requires the recipient channel allow a choice of means "which shall not solely rely on automated tools", which is a human again. Article 14 requires the content-moderation terms be publicly available "in an easily accessible and machine-readable format". **None of these three is in the micro-enterprise relief**, and that relief is narrower than it first reads: Article 15(2) exempts micro or small enterprises from the annual transparency report, and Article 19(1) says "This Section, with the exception of Article 24(3) thereof, shall not apply to providers of online platforms that qualify as micro or small enterprises as defined in Recommendation 2003/361/EC." **Article 19 sits inside Section 3 and is scoped to online platforms**, so it relieves Relic only if Relic is one; and if Relic is not an online platform, Section 3 never applied. Section 3 does not bite either way, and Articles 11, 12, 13, 14, 16, 17, and 18 apply regardless of size.

### 6.3 The published SLA, which is a number

**Decision: 24 hours, published as a maximum, from the report's arrival timestamp to the object's deletion timestamp, for every report in every category.**

**No regime anchors it, which is why publishing one is a commitment rather than compliance.** The DSA gives "in a timely, diligent, non-arbitrary and objective manner" with no hour figure anywhere in the Regulation. The DMCA gives 512(c)(1)(C), which requires that a provider "responds expeditiously to remove, or disable access to, the material that is claimed to be infringing or to be the subject of infringing activity", with no figure. Google gives "timely" and no published suspension timeline at all. So whatever number is published becomes the standard the operator is measured against, and it is measured against it by the same people who would otherwise have had nothing to measure.

**Priced against `service.md` 4.1's four inputs.**

*The named human's timezone and their named backup.* `preconditions.md` requires a backup and does not require it be in another timezone, so the design prices the case it actually has, which is one waking window. A report arriving at the start of that window's off-hours is not seen for its duration.

*The gap between arrival and the screen.* `service.md` 4.1 states the rule in its own words: **"The clock starts at arrival, not at triage."** The screen in section 2.2 item 1 is what that sentence names: the sleep gap between a report landing and the operator opening it to run the screen sits inside the number rather than excluded from it. That single rule is what rules out the short numbers, and it is also what fixes which architecture this document builds: the screen sits on the critical path to deletion, not after it, because a clock that refuses to start at triage is a clock measuring the wait for triage to happen.

*A response window Google's own silence forces to one rolling day.* `preconditions.md` section 5 records that Google publishes no suspension timeline beyond "timely", so the operator cannot size the response window against a stated deadline and bounds it independently instead. The bound is one day measured from the report's own arrival timestamp, not from the calendar: a report arriving at 23:00 gets until 23:00 the next day, never until the following midnight. 24 hours is the largest number that fits inside that rolling day.

*The action itself, once the screen clears a report.* Delete-by-ID is a single automated call taking seconds (section 2.1), so once the screen in section 2.2 item 1 clears a report for the routine path, essentially the whole remaining budget is latency to a human deciding to open the report, not work. The screen is what actually spends the SLA's hours; the mechanical steps behind it spend none worth pricing.

**Why not shorter.** A published 4 or 8 is unmeetable by one human with one backup and no follow-the-sun coverage, on any report arriving late in the local evening, and the clock does not pause for sleep. Publishing a number the operator misses on ordinary reports is worse than publishing a longer one it meets, because the miss is evidence in exactly the processes this document exists to survive, and because `preconditions.md` already makes the SLA a checkable number computed from the operator's own records.

**Why not longer.** Two bounds, both hard. The TTL is 259,200 seconds (`storage.md` 7.2), so a takedown SLA approaching it makes deletion indistinguishable from expiry, and "it would have expired anyway" is not an answer to a suspension notice. And Google's absent timeline forces the one-rolling-day ceiling above, which puts the number at 24.

**What the number is not.** It is responsiveness on reports received. It is never coverage, for the reason `preconditions.md` and `service.md` 4.1 both give and this document does not soften: the operator cannot inspect content, unreported abuse is invisible by construction, there is no denominator, and a month of zero reports is either a clean service or a dead intake, which look identical from the inside.

**Two clocks the SLA does not govern**, stated so nobody reads 24 hours as covering them. The 18 U.S.C. 2258A(a)(1) mandatory report runs on the statute's own standard, "as soon as reasonably possible after obtaining actual knowledge", which is not a number the operator sets. The DSA Article 18 criminal-threat notification runs on "promptly". Both are faster than 24 hours in any reading and neither is satisfied by deleting the object.

**Reported as a maximum, with the measured median beside it.** `preconditions.md` makes both checkable from the operator's own records and section 4 item 8 monitors them. The commitment is the maximum; the median is published as evidence and is not a second promise.

### 6.4 The operational commitments

9. **The second verified Search Console owner on every property**, per section 4 item 4, standing rather than one-time.
10. **Availability for the criminal-threat branch and the mandatory-report branch**, at whatever hour they arrive, with the statutory exposure named: DSA Article 18's duty to "promptly inform" law enforcement, and 2258A(e)'s $600,000 initial and $850,000 subsequent penalties for a knowing and willful failure to report, plus 2258A(h)'s one-year preservation obligation attaching to any filing.
11. **Acceptance of delete-on-report with no adjudication**, including its griefing vector, including that a wrongly deleted relic is never restored.
12. **Log monitoring**, which the GCP guidance asks for by name. Its scope clause: the requirements apply where "If your primary business is to host third-party content or services or facilitate the sale of goods and services between third parties", which is Relic exactly. Within that scope Google asks operators to maintain "a reporting intake process (for example, a webform or email alias) to receive notices of illegal or abusive content" and to "Promptly review and address any alerts, and remove content where appropriate" ([respond to abuse and misuse](https://docs.cloud.google.com/docs/security/respond-to-abuse-misuse)).
13. **The nine standing checks in section 4**, each with an owner and an alert that reaches a human.

### 6.5 The decision this list exists to make

**Deciding no now is a good outcome for this run.** Every number above is real, every obligation above is somebody's evening, and the work is unglamorous, unfunded, and never ends. Mozilla had a legal team, a brand worth defending, and more engineers than this collective will have, and shut Firefox Send down rather than staff this.

**Deciding no after launch, with relics in the wild and a suspension notice running, is the bad one.** At that point the domains are bought, the HSTS preload clock is months into an unexpeditable process (`topology.md` section 4), and the links are unrecallable because there are no accounts and no channel to reach anybody who holds one. **Under the two-project topology section 1 builds against, the tooling needed to wind it down survives a suspension of the content project**, which is the whole reason `docs/design/storage.md` section 6 recommends it; what does not survive is the service itself, dark for as long as the suspension runs, with every relic in flight and no way to tell anyone why. That is still the bad outcome this section warns against. It is a smaller bad outcome than losing the tooling too, and it is smaller only because section 1 spent the cost storage.md section 6 names for it, two billing accounts and cross-project IAM, to buy it.

The list above is answerable today, item by item, at no cost. That is the whole reason it is a list.

## 7. The counsel questions, by name

Not answerable by more reading. Each is stated as the question a lawyer would be asked.

1. **Is 17 U.S.C. 512(i)(1)(A)'s repeat-infringer condition satisfiable by a service with no subscribers and no account holders?** The condition sits under the heading "Conditions for Eligibility" and its scope clause is that "The limitations on liability established by this section shall apply to a service provider only if the service provider" has "adopted and reasonably implemented, and informs subscribers and account holders of the service provider's system or network of, a policy that provides for the termination in appropriate circumstances of subscribers and account holders of the service provider's system or network who are repeat infringers". A service with neither has nobody to terminate and nobody to inform. Whether that is satisfied vacuously or forfeits the shield is not answerable from the text, and it conditions **every** limitation in section 512.
2. **Does client-side encryption interfere with standard technical measures under 512(i)(1)(B)?** The same scope clause reaches it. The definition at 512(i)(2) requires measures "developed pursuant to a broad consensus of copyright owners and service providers in an open, fair, voluntary, multi-industry standards process" that "do not impose substantial costs on service providers or substantial burdens on their systems or networks", a bar essentially nothing has been held to clear. Flag it; do not build on it.
3. **Does Relic offer services in the Union within DSA Article 3(d) and 3(e)?** A fact question about the recipient population, and it is the trigger for Article 13's legal representative and therefore for the largest single cost on section 6's list.
4. **Is Relic an online platform, or a plain hosting service, under the DSA?** Mostly moot for the reason section 6.2 gives, and worth an hour only if Section 3 ever becomes live.
5. **Does DSA Article 16(5)'s duty to notify the reporter of the decision inherit Article 16(4)'s condition that the notice carried electronic contact information?** Section 2.1 reads it as inheriting. If it does not, the pipeline owes a notification it has no address to send.
6. **Is Relic a controller, under Regulation (EU) 2016/679, of personal data that sits inside ciphertext it cannot read and did not publish?** Everything in section 2.3 sits downstream of this.
7. **Does a reporter handing over a relic URL supply "additional information enabling his or her identification" within GDPR Article 11(2)?** The URL identifies the object, not the person. If it does not, Articles 15 to 20 do not apply and section 2.3's response is a courtesy rather than a duty. If it does, the response clock in Article 12(3) runs.
8. **Does a 2258A(h) preservation obligation, running a year, override the published byte lifetime and the soft-delete policy?** Section 2.2 assumes it does and that the disclosure statement must say so. The interaction between a federal preservation request and a published deletion commitment is a lawyer question.
9. **Is an unverified, `csam`-labeled report itself "actual knowledge" within 18 U.S.C. 2258A(a)(1), the way a compliant DSA notice creates actual knowledge from the reporter's assertion alone under Article 16(3)?** The US statute is criminal-adjacent and carries the $600,000 and $850,000 exposure named in section 2.2, rather than a civil liability exemption, and it may read more strictly than the DSA test the pipeline already applies. Section 2.2 item 3's interim default, filing on every such report pending this answer, is priced against the possibility that the answer is no and the default over-files.
10. **Does GDPR Article 12(3)'s one-month response clock discharge vacuously against an anonymous data-subject report that supplies no return channel, the way DSA Article 16(4) and (5) explicitly condition their duties on the notice carrying contact information?** Section 2.3 declines to resolve this by silent analogy to the DSA case, which the text itself resolves explicitly and Article 12(3) does not.

## 8. Sibling inputs, and what this document needs

**None of the three sibling design documents had landed on the station branch.** `docs/design/storage.md` was read from `darkrun/relic/units/shape/design-storage-grant-and-cost` at commit `a9cea77`, its resolved tip, rather than the earlier `95853da`. `docs/design/topology.md` was read from `darkrun/relic/units/shape/design-topology-and-origins`. `docs/design/container.md` was read from `darkrun/relic/units/shape/design-container-and-crypto`. Nothing any of them settles is redefined here.

Stated as needs, with the owner named and the behaviour that follows either way.

1. **Whether the abuse form carries a personal-data category, and what it is called, from `design-product-surface`.** Section 2.3 designs both branches and this document does not add a category. Under a dedicated category these reports route directly; under no category they arrive in `other` and the screen in section 2.2 item 1 detects them from free text as part of the read every report already gets. The pipeline's action is identical either way.
2. **Whether the viewer distinguishes cap exhaustion from takedown, from `design-product-surface`.** Section 5.2 designs both branches, specifies the operator-side lookup that branch B requires, and states that branch A is cheaper for a one-person operation and creates no disclosure `service.md` 1.4 has not already made. The choice is that unit's.
3. **The pre-launch empirical bundle, from `build`.** Three observations in one run: the Defender for Office 365 fragment test `service.md` section 6 mandates, the download-attribution question `topology.md` section 8 routes to this unit, and the signing-key rotation propagation delay `storage.md` 3.4 leaves unverified. This unit owns the first two and states them as one bundle because they need the same thing, which is a live relic and a real browser. The third is `storage.md`'s and needs a billed project, so it is named here for scheduling and is not claimed.
4. **Nothing from `design-container-and-crypto`.** Its 125-bit ID decision is consumed in section 5.3 and recorded as settled.

## 9. GCS digest proof and cleanup

**Blocked: do not dispatch the proof or run its provisioning script.** GCS does not offer a bucket deletion precondition tied to an immutable bucket generation. A bucket can be replaced after an identity check and before a name-based deletion. Cleanup therefore refuses to mutate an extant bucket; the proof must fail before creating a bucket while safe cleanup cannot be proven. Automatic bucket cleanup and the real-GCS proof are unproven.

The design calls for a trusted workflow on `main` against a validated candidate SHA. Each attempt would have a bucket named `relic-gcs-proof-<run_id>-<attempt>` and a service account named `rgp-<run_id>-<attempt>@<project>.iam.gserviceaccount.com`. The account description and bucket labels identify the run, attempt, candidate and lease expiration; the account description also identifies the repository. The design must fail on a name collision rather than adopt an existing resource.

The design separates provisioning from candidate execution. The `exercise` job must have neither `id-token: write` nor deployer credentials, and its first step must require both GitHub OIDC request environment variables to be empty or unset and emit `GCS_PROOF_EXERCISE_NO_OIDC`. The trusted provision and teardown jobs hold deployer credentials and must not execute candidate code. The `mint` job has GitHub OIDC permission and must not execute candidate code.

The intended policy grants the per-run account `roles/storage.objectUser` on its bucket and self `roles/iam.serviceAccountTokenCreator`. A repository-scoped workload identity principal gets `roles/iam.workloadIdentityUser` on that account. Each binding requires `request.time` to precede the expiration set at provisioning, two hours after the lease starts. Two additional bindings, self `roles/iam.serviceAccountViewer` and bucket `roles/storage.bucketViewer`, carry already-lapsed conditions and provide negative controls. The workflow must add no project-level binding or account key, and must read the account and bucket policies back, including the legacy bucket convenience bindings.

The handoff design has the exercise runner create an X25519 key pair before executing candidate code and upload only the public key. Mint uses direct workload identity federation to obtain an account token, then seals it to that key using X25519, HKDF and AES-256-GCM. The authenticated context binds the ciphertext to the run, attempt, account and expiration. The sealed artifact crosses jobs; the private key stays on the exercise runner and is deleted after unsealing. Mint and exercise need two runners available concurrently. Handoff artifact retention is one day.

Before handing over the token, the scope check requires the sampled create, delete, get and update object permissions on the proof bucket, with bucket-get absent. The production relic and Terraform state buckets must return no sampled permissions, and project-level bucket and account listing must return 403. On its own account, `signBlob` must be allowed and account-get absent. The application and deployer accounts must return no sampled permissions, and `signBlob` attempts against them must return 403. These are scoped live checks, not evidence about every other resource or future IAM policy.

The candidate receives the per-run account token and can use or disclose it, sign as the account and potentially renew it during the lease. The initial token's expiry does not bound that capability. The intended policy grants access to the run's bucket rather than granting access to production buckets or another attempt's bucket; inherited or independently added permissions remain outside that statement. The lease bounds the workflow's conditional IAM grants, not the lifetime of the resources. IAM changes can take time to propagate, so the checks must retry within deadlines and fail if the required conditions do not pass.

The existing workload identity provider authorizes by repository ID rather than restricting the deployer to a protected branch or environment. Another workflow in the repository with `id-token: write` can request deployer credentials. The proof's job separation does not change that existing boundary.

Treat logs and artifacts as public. Tokens, signed URLs and private keys must not be logged. The result validator is designed to reject the proof token and recognizable credential shapes, but a candidate with the token can still disclose it through another channel. The encrypted artifact protects the cross-job handoff, not a token intentionally disclosed by candidate code.

### Cleanup boundary

Names, labels and account markers identify a resource at the time they are read; they do not bind a later bucket deletion to that same resource. The cleanup implementation refuses to mutate or delete an extant bucket. When a trusted creation receipt is available, it can disable a matching account by immutable account UID even if bucket identity is uncertain. It retains that account while the bucket exists or its absence is unconfirmed. Without a trusted receipt, cleanup fails closed on extant resources. A 403 is a failure, not proof of absence.

The janitor design groups matching buckets and accounts by canonical positive run and attempt IDs, checks resource markers and repository identity, and compares candidate, expiration and account UID when both resources exist. It requires a matching `GCS digest proof` workflow run, manually dispatched on `main`, from the expected repository. An older attempt may be eligible when a newer attempt exists; the latest attempt may be eligible only after the run completes. The planned minimum age is 15 minutes for scheduled and manual runs and zero for the completion trigger. Missing runs, marker conflicts, active latest attempts and unconfirmed identities are skipped.

Eligibility is not deletion. A janitor sweep without a durable creation receipt cannot clean an extant resource, and the bucket deletion race remains even with a receipt. A force-cancel can also prevent teardown from running. Neither the janitor nor the two-hour IAM lease proves that resources have been removed.

The intended one-day bucket lifecycle can expire objects and abort incomplete multipart uploads, subject to GCS processing. It cannot delete the bucket or service account and does not replace safe cleanup.

### Live verification

After a safe cleanup mechanism is implemented, reviewed and available on `main`, inspect the janitor with a dry run:

```sh
gh workflow run gcs-proof-janitor.yml --ref main \
  -f dry_run=true -f min_age_minutes=0
```

Require `GCS_PROOF_JANITOR_DONE` with `eligible=0`, then run the default proof in `PATH.md` and require its policy, scope, no-OIDC, handoff, revocation, resource-absence and final verification markers. The intended proof exercises the candidate's `iamSigner`, V4 signing and `gcsStorage.digest` against a disposable bucket. It does not exercise the production `metadataSigner` metadata fetch. Its memory check measures the digest process's RSS, not the full upload or total runner memory.

Once safe cleanup is established, verify the force-cancel path with a second proof run. Set `RUN_ID` to that new run's ID. After `GCS_PROOF_PROVISIONED`, cancel it while its jobs are still waiting for the handoff:

```sh
gh api -X POST "repos/{owner}/{repo}/actions/runs/$RUN_ID/force-cancel"
```

Require the completion-triggered janitor to identify that run as eligible and confirm both resources gone, then require the next scheduled sweep to report `failed=0`. A local fake or an earlier run does not prove live WIF, artifact transfer, revocation or cleanup on the revision being delivered.
