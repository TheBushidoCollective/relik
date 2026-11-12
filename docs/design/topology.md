# Relic: the origins, the edge, and when the mint fires

This document records origin routing, explicit download delivery, the edge
and TLS, mint timing, and the naming decision. Browser-managed temporary
storage is separate from an explicit download.

`docs/frame.md`, `docs/preconditions.md`, `docs/spec/format.md`, `docs/spec/service.md`, and `docs/spec/viewer.md` are locked inputs. `docs/design/container.md` is a sibling input and its decisions are consumed here rather than restated: a 25-character Crockford base32 relic ID, a 24-character fragment, and a 71-character relic URL on a twelve-character domain. Nothing here reopens any of them.

## 0. What this decides, and the items that are not this document's

Three routed decisions are resolved here, by name and with no others implied.

- **`viewer.md` 7.5, PSL registration for the sandbox parent.** Decided in section 1: not filed, on eligibility, at this scale.
- **`service.md` 7.1, edge fidelity.** Decided in section 6.
- **`service.md` 7.7, the mint dedup interval.** Decided in section 5.2.

Four routed items look adjacent and are owned elsewhere. `viewer.md` 7.1 platform memory ceilings, 7.3 the truncated-prefix size, and 7.4 the highlighted-region cap belong to `design-product-surface`, which owns every viewer screen. `viewer.md` 7.2, the hard size cap, belongs to `design-storage-grant-and-cost`. None of them is decided here, and none of them is constrained by anything below.

Two things this document deliberately does not do. It does not pick the name, which is the operator's. It does not reverse `viewer.md` §2's per-relic decision: section 1 designs both branches and routes the question back to `specify` as drift.

**Two items route back to `specify` as drift**, each named where it arises rather than collected here: `viewer.md` §2's process-isolation rationale, in section 1.7, and `service.md` 2.2's stated reason for having a dedup interval at all, in section 5.2. Neither is a proposed edit to a locked document, and neither changes a rule those documents fix.

## 1. The Public Suffix List, the wildcard, and a locked rationale that no longer holds

### 1.1 The foreclosure, at its honest scope

**A PSL entry for the sandbox parent is not filed, and it is not on the launch path.** The list's own guidelines ([PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)) put a pre-launch project of this size inside two published decline criteria. On purpose:

> We do not accept entries that have the objective of getting around limitations that have been put in place by a vendor to protect internet users.

On scale:

> Projects that are smaller in scale or are temporary or seasonal in nature will likely be declined.

and

> It should be expected that despite whatever site or service referred a requestor to seek addition of their domain(s) to the list, projects not serving more then thousands of users are quite likely to be declined.

The same page requires candour in the rationale, so misstating the objective is not available. And even a granted entry arrives on nobody's schedule:

> There are NO SERVICE LEVEL AGREEMENTS ON TIME nor any expectation of processing speed or urgency

with

> Modifications take time to reach software that uses the PSL

and, on expediting,

> Unfortunately, there is no way to expedite.

**The scope of that foreclosure is load-bearing and it is narrower than permanent.** The blocking criterion is a size gate. The accurate statement is that a PSL entry is unavailable to a pre-launch project at this scale, not that it is unavailable forever. That difference is what makes the per-relic branch's process-isolation rationale recoverable at scale rather than dead, and it is a different thing to hand `build`.

### 1.2 A PSL entry would not break the wildcard, and getting this backwards would be expensive

Nobody should re-derive this in the wrong direction. The requirement that looks like it forbids a wildcard immediately left of a PSL entry is CA/Browser Forum Baseline Requirements 3.2.2.6 ([CA/Browser Forum BR](https://github.com/cabforum/servercert/blob/main/docs/BR.md)):

> CAs MUST refuse issuance unless the Applicant proves its rightful control of the entire Domain Namespace

The same section defuses it:

> If using the PSL, a CA SHOULD consult the "ICANN DOMAINS" section only, not the "PRIVATE DOMAINS" section

Private registrations land in the private section. Let's Encrypt confirmed its own behaviour on the record ([Let's Encrypt community](https://community.letsencrypt.org/t/wildcard-certificates-and-public-suffix-list/100974)): asked

> Can you confirm that you only block issuance for the ICANN section of the PSL? (And not the PRIVATE one)

jsha replied

> Yep, I confirm this.

**Two qualifiers travel with that claim and neither is optional.** The Baseline Requirement is a SHOULD rather than a MUST, so the behaviour is CA-dependent and gets verified against whichever CA is actually used before anything is committed. And the escape hatch in the quoted MUST applies here anyway, because the applicant controls the entire namespace under the sandbox parent.

So the wildcard survives a PSL entry. The PSL is foreclosed for a different reason entirely, which is eligibility.

### 1.3 What the foreclosure takes with it

`viewer.md` §2 is locked and it decides per-relic subdomains. It first concedes that the obvious objection to a fixed origin is not real, because under §4's two-layer boundary every rendered document already sits in its own opaque origin. Then it names what the subdomains actually buy:

> What per-relic subdomains actually buy is process-level isolation

and it quotes the mechanism from web.dev ([web.dev](https://web.dev/articles/securely-hosting-user-data)):

> by adding `exampleusercontent.com` to the PSL, you can ensure that `foo.exampleusercontent.com` and `bar.exampleusercontent.com` are cross-site and thus fully isolated from each other

**Process isolation keys on site, and site is computed from the Public Suffix List.** The web.dev passage quoted above carries that on its own, and no second citation is needed for it: the isolation it promises is conditioned on adding the parent to the list, in the same sentence that promises it. Without an entry, every per-relic label sits under one registrable domain, so `a.sandbox.example` and `b.sandbox.example` are same-site. The condition the quoted sentence requires does not hold, and the isolation it promises does not fire. **The stated rationale for the locked decision is gone.**

Every cost stays exactly where it was: a wildcard certificate, whatever the wildcard's challenge type demands, a standing edge cost in front of Cloud Run, and unbounded auto-generated hostnames under that wildcard, which `viewer.md` §2 itself identifies as the trigger `preconditions.md` §2 describes.

This is not discharged by repeating that the PSL is foreclosed. That sentence is true, it is worth saying, and it is exactly the sentence that hides the hole.

### 1.4 What survives, per reason, with the mechanism

Do not over-read the collapse. `viewer.md` §2 gives a second reason and says which one it rates:

> The second reason is the durable one. A per-relic hostname is defense in depth against Relic's own future bugs, so a misconfigured sandbox flag costs one relic instead of every relic the recipient has open.

**That reason rests on distinct origins, not on site, and it survives untouched.** The same-origin policy compares the scheme, host, and port triple and never consults the Public Suffix List. MDN states the comparison directly ([MDN same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)), noting that the components

> are the same for both

and naming the shape:

> You may see this referenced as the "scheme/host/port tuple", or just "tuple".

Two distinct hostnames under one registrable domain are distinct origins on the host component alone. A relic rendered at `a.sandbox.example` cannot reach the DOM of a relic at `b.sandbox.example` whether or not the parent is on the list, because nothing in the origin comparison looks at the list. The failure this reason exists to bound is Relic shipping a bug that drops a sandbox flag, and under that bug the attacker is confined by the origin boundary, which is intact.

**`document.domain` is the one origin-side mechanism a PSL entry genuinely touches, and it does not make the second reason PSL-dependent.** Checked rather than assumed, against MDN ([MDN Document.domain](https://developer.mozilla.org/en-US/docs/Web/API/Document/domain)), three ways.

- It requires both sides to opt in. MDN's own example has two pages that both run the setter, after which

  > then they have both modified their origin to have the same domain, and they can now access each other

  The victim relic's document is never attacker-controlled, so the victim never runs the setter and the attacker's setter alone changes nothing.
- It cannot be reached from where the attacker sits. MDN lists the cases where the setter throws a `SecurityError`, and the first one it names is a document inside a sandboxed iframe. Untrusted bytes render inside the sandboxed render frame at layer two of `viewer.md` §4's boundary, which is exactly that case.
- It is deprecated and inert under modern isolation. MDN states

  > The `document.domain` setter is deprecated.

  and records that it does nothing on an origin-isolated page. Its reach is bounded in any case:

  > It can only be set to the same or a parent domain.

  so it can never widen past the registrable domain, which is the boundary the PSL would have moved.

**So the split is clean.** The site-keyed reason, process isolation, depended on the entry and is gone. The origin-keyed reason, defense in depth against Relic's own bugs, does not depend on the entry and is unaffected. Writing this as a total collapse would make the per-relic branch look like pure cost and get it dropped for a false reason.

One further thing survives that is worth naming, because it is not a security property and reads like one. `viewer.md` §2 makes the label a one-way function of the relic ID so the shim origin is stable and cacheable across repeat opens, and derives `targetOrigin` per render from it. That machinery is about addressability and caching, and it works identically under either branch's origin count.

### 1.5 Branch A: per-relic subdomains retained

The justification that actually survives, stated honestly: **one bug in Relic's own sandbox configuration costs one relic instead of every relic a recipient has open.** Not process-level isolation, which is unavailable without the entry. Not protection against a renderer compromise or a speculative-execution read across frames, which is precisely what the web.dev passage says the site boundary is for and which this branch no longer buys.

Every cost is owned:

- A wildcard certificate covering one DNS label. `viewer.md` §2 already constrains the sandbox label to one DNS level for exactly this reason, since a wildcard covers one label and not two.
- Whatever the wildcard's challenge type demands. Section 3 decides this and the answer is better than expected.
- A standing edge cost in front of Cloud Run, priced in section 3. The wildcard is one reason Cloud Run's own domain mappings cannot serve this branch; their preview status is the other, and it applies to both branches. Section 3 sources both.
- Unbounded auto-generated hostnames under a wildcard, which is the Immich shape ([Immich](https://immich.app/blog/google-flags-immich-as-dangerous)). `viewer.md` §2's answer is that Relic's generated hostnames have nothing on them: the sandbox origin serves exactly one static file, the shim, which never touches ciphertext and never touches the network, so a crawler resolving every label finds the same few hundred bytes of relay code at each one.
- A looser CSP on the viewing origin. Framing a per-relic host means `frame-src` names a wildcard host pattern rather than one exact origin.
- A permanent availability dependency the day HSTS preload lands, per section 4: `includeSubDomains` on the sandbox parent means every generated hostname must always present a valid certificate, and under this branch that is the wildcard.
- **The passive-DNS residual `viewer.md` §2 concedes.** A per-relic label is a name that gets resolved, so anyone already holding the URL can confirm from a resolver log that a specific device opened that specific relic. It is a cost of this branch and it belongs in this list rather than in the other branch's advantages.

**The whole of what this branch buys, then, is the one-bug-one-relic bound.** Everything the site boundary was going to add is unavailable at this scale, and every cost listed above is paid whether or not the entry is ever granted.

### 1.6 Branch B: one fixed sandbox origin

What is lost, precisely: **a bug that drops a sandbox flag stops costing one relic and starts costing every relic the recipient has open in that browser.** That is the whole of the loss and it is a real one. Nothing else changes, because the mutual isolation of two rendered relics never came from the hostname in the first place. `viewer.md` §2 says so itself: under §4's two-layer boundary every rendered document already sits in its own opaque origin, so two relics on a single hostname are already mutually cross-origin, and the frame's sandbox flags answer that objection rather than the hostname.

What the costs stop buying:

- **The wildcard is not needed at all.** One hostname takes an ordinary single-name certificate, which changes the challenge story completely and removes wildcard-specific issuance from the design.
- **The unbounded auto-generated hostnames disappear**, and with them the `preconditions.md` §2 trigger that `viewer.md` §2 has to argue its way past.
- **`frame-src` on the viewing origin becomes one exact origin** rather than a wildcard host pattern, which is a strictly tighter policy.
- **HSTS preload gets cheaper.** With one hostname under the sandbox parent, `includeSubDomains` binds a certificate obligation to one name instead of to an unbounded generated set.
- **The standing edge cost does not disappear, and the reason is not the domain count.** Section 3's own cited page says a Cloud Run service can carry several custom domains, so a second registrable domain is not what forces something in front of Cloud Run. What forces it is that Cloud Run's own domain mappings are preview and not production-ready, which section 3 sources and which is true under both branches. Branch B pays the same standing edge cost as branch A, priced in section 3.

Two mirror-image consequences, stated so the comparison stays even rather than as upsides. The derived per-relic label was doing real work beyond isolation: it gives the shim a stable, per-relic, non-invertible pseudonym and it gives the parent an exact `targetOrigin` per render. Under branch B the shim's origin is a constant, `targetOrigin` is a constant, and the shim's self-correlation pseudonym is gone. The passive-DNS residual in branch A's cost list above is the other mirror: under branch B every relic resolves the same name, so a resolver log stops distinguishing them. Neither of these is a new benefit. Both are branch A's costs read from the other side, and they are already counted there.

**This document does not pick between A and B.** `viewer.md` §2 decided per-relic and this station does not undecide it. Branch A buys the one-bug-one-relic bound and pays the list above for it. Branch B gives up that bound, keeps the standing edge cost and an unchanged DNS authorization shape, and stops paying the rest. The choice belongs to whoever revisits `viewer.md` §2, and section 1.7 routes it there.

### 1.7 Routed to `specify` as drift

The sentence whose basis is gone is in `viewer.md` §2:

> **What per-relic subdomains actually buy is process-level isolation**

together with the requirement two sentences later:

> **PSL registration of the sandbox parent is required and routes to `shape`**

That routed item is resolved here as not filed, on eligibility, at this scale, which leaves the first sentence stating a benefit the design cannot obtain at launch. **This routes back to `specify` as drift.** Both branches above are designed so whoever revisits it has the material, and the honest scope from 1.1 travels with it: the entry is unavailable at this scale, so the process-isolation rationale is recoverable if Relic reaches the scale the list's guidelines describe, rather than permanently void.

### 1.8 The RP ID constraint on any sandbox topology

The usercontent origin cannot sit under the WebAuthn Relying Party ID. `assertConfig` refuses a usercontent hostname equal to the service hostname, which is the RP ID, or ending in `.` plus the RP ID (plan 4.9, correction 20). The reason is the one `viewer.md` section 4 states from the other side: the render frame is opaque and WebAuthn cannot run there, but a usercontent origin under the RP ID could request PRF output from a user's passkeys, which would make that origin a decryption capability for private relics. The constraint applies to every sandbox topology, branch A and branch B alike. It depends on the hostname rather than the public suffix list, so the PSL findings in 1.1 to 1.7 do not affect it.

Any per-relic subdomain topology (`viewer.md` section 2, not built) must live under the usercontent domain only, never under the service hostname. A fixed sandbox origin under branch B has the same requirement.

## 2. Which origin serves which response, and explicit downloads

**The split is backwards from how it reads.** The shared URL is on the service origin. The sandbox origin appears only in an iframe `src` and never in anything a human pastes. So the domain hosting attacker-controlled markup is the one nobody links to, and it costs one DNS change to replace. The domain hosting nothing untrusted is the one in every shared link, every abuse report, and every Safe Browsing sample. **Losing the sandbox domain breaks rich-text rendering. Losing the service domain breaks every relic ever shared.**

Google's Security Issues report describes two download categories that may
affect the service. Attribution of a browser-generated `blob:` download to
the initiating origin is unverified ([Search Console](https://support.google.com/webmasters/answer/9044101)). The first category:

> Uncommon downloads Your site is offering a download that Google Safe Browsing hasn't seen before.

with an auto-lift condition that can never fire on unique ciphertext under a unique key:

> These warnings are lifted automatically if Google Safe Browsing verifies that the files are safe.

and a detail that makes remediation worse:

> Note that example URLs are not always given for this issue.

The other one, if an abuser succeeds:

> Harmful downloads

whose remediation begins

> View some of the example pages on your site to confirm the presence of these downloads.

which a zero-knowledge operator cannot perform, because Safe Browsing canonicalization strips the fragment before anything else ([Safe Browsing URLs and hashing](https://developers.google.com/safe-browsing/reference/URLs.and.Hashing)):

> Second, if the URL ends in a fragment, remove the fragment.

so the sample URL handed to the operator is the one form of the URL that cannot open the content.

**The irreversible term is not the URL scheme and not the CSP.** Both of those are a header and a link target and both change in a deploy. The irreversible term is download-category reputation accrued on the domain that sits in every shared link and cannot be replaced. The decision is made on that basis.

**Three paths, not two.**

1. **The service origin serves the bytes.** A link, a navigation, or a redirect
   from the service origin to the object would expose that origin to download
   reputation. **Rejected.**
2. **The sandbox origin serves the bytes.** Attractive, because the sandbox domain is the disposable one and a listing there costs one DNS change. **It cannot be done, and the reason is two locked rules rather than a preference.** The sandbox origin never receives the key, so it cannot fetch ciphertext and turn it into a file: the only way it obtains plaintext is by `postMessage` from the parent. That is available for renderable classes and it is closed anyway, because `viewer.md` §4 puts Blob materialization on the main origin precisely to keep the download affordance out of the untrusted frame. For download-only classes it is worse: `viewer.md` §1.2 orders browser-side privilege as download-only, then the sandbox origin, then the viewing origin, and routing a binary the design refuses to render into a frame that runs script moves it up that order for zero rendering benefit. **Rejected.**
3. **A `blob:` save of already-decrypted content on the viewing origin.** `viewer.md` §1.6 already fixes its shape, typing every download blob as `application/octet-stream` whatever the container declared, triggering it through an `a[download]` attribute, and barring navigation to it. **Chosen.**

**Decision: an explicit plaintext download uses a `blob:` URL materialized on
the viewing origin under `a[download]`.** The viewer consumes the signed
object URL with `fetch`, rather than navigating or redirecting to it.

This delivery choice does not determine where the browser backs a Blob.
Plaintext can be held in memory or temporary disk, and the operating system
may swap memory to disk. A user's explicit download writes a file; neither
disk avoidance nor erasure on close is guaranteed.

The ciphertext transfer runs from client to storage on a signed URL. Whether
Chrome attributes a `blob:` download to the initiating page's origin for
download-reputation purposes remains unverified.

## 3. The edge and TLS

**Settle section 1 first, because a single fixed sandbox origin needs no wildcard at all.** Everything below prices the per-relic branch and states what the fixed-origin branch would cost instead.

**State the Cloud Run scope correctly, because the wide version is wrong and is expensive in the other direction.** What is foreclosed is Cloud Run's own custom domain mappings and nothing wider. Google's page ([Cloud Run domain mappings](https://cloud.google.com/run/docs/mapping-custom-domains)), verbatim:

> You cannot use wildcard certificates with this feature.

and, on maturity, mappings

> are in the preview launch stage

with

> they are not production-ready and are not supported at General Availability.

and

> At the moment, this option is not recommended for production services.

**The blocker is maturity, not domain count, and the same page says so outright:**

> You can map multiple custom domains to the same Cloud Run service.

So a second registrable domain does not by itself put anything in front of Cloud Run. The wildcard does under branch A, and the preview status does under both branches. That distinction is section 1.6's, and it is why branch B does not come out free.

**Cloud Run itself is not foreclosed.** A global external Application Load Balancer with a Certificate Manager wildcard under DNS authorization supports wildcards, and it says nothing about what sits behind it, which throughout this design is Cloud Run, unchanged.

Two live candidates, priced on cost and on what each puts in the render path.

**Candidate one, a Google global external Application Load Balancer with Certificate Manager.** The standing cost is a forwarding rule, and the number is small and checkable ([Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing)):

> Google Cloud charges for forwarding rules whether they are created for load balancing or other uses

> You can create up to 5 forwarding rules for the price of $0.025/hour.

> If you have 3 forwarding rules, you are still charged $0.025/hour.

and

> For most load balancing use cases, you need only one forwarding rule per load balancer.

The same page notes that global and regional rules are charged separately and per project, so the forwarding-rule arithmetic is narrow: two global forwarding rules in one project sit inside that bundle, and Relic's two-domain shape therefore costs one $0.025 an hour rather than two. At 730 hours that is $18.25 a month.

**That is the forwarding rule, and the forwarding rule is not the edge's cost.** Two more documented terms belong in the floor, and both were missing.

**Load-balancer data processing**, on the same page. Data processed by the load balancer is billed at $0.008 a gibibyte inbound and $0.008 a gibibyte outbound, regionally rather than globally:

> There are no global data processing charges. Data processing is charged by the region, depending on where the traffic is processed.

with

> The data processing charge is calculated by measuring the total volume of data for requests and responses processed by your load balancer during the billing cycle.

Ciphertext never transits the load balancer, because the transfer runs client to storage on a signed URL and the app server is not in that path. What does transit it is the static shell, the mint responses, and the constant preview image section 5.3 identifies as recurring egress scaling with link pastes rather than with relic opens. **That last term is the one to watch, because the kill switch cannot reach it: unfurls do not mint, so disabling minting leaves every unfurl fetch running and every gibibyte of it billed.** The rate is small, the metric behind it is uncapped, and the two facts belong in the same sentence.

**Cloud Armor**, which sections 4 and 6 both rely on and which was priced at zero. It carries its own standing charge ([Cloud Armor pricing](https://cloud.google.com/armor/pricing)). The Standard tier bills a security policy at $0.006849315 an hour and each rule in it at $0.001369863 an hour, which at 730 hours is exactly $5.00 a month per policy and $1.00 a month per rule. Rate limiting is the service origin's problem and not the static shim's, so this design forces one policy. Section 6 requires one rule per `code` it stands in for, and `service.md` fixes exactly two rate-limit codes, so two rules. That is $7.00 a month. Each rule added later costs another dollar, and requests evaluated against a globally scoped policy add $0.75 a million on top.

**The standing floor is therefore $25.25 a month, not $18.25:** $18.25 of forwarding rule, $5.00 of security policy, $2.00 of rules, before a byte moves, on a project whose cost precondition is a kill switch. **The kill switch acts on minting, so it turns none of that off**, and the two variable terms above it land partly on unfurl traffic it cannot reach either. **Restoring these terms cuts toward candidate two, which this section rejects**, so leaving them out was an omission in the direction that flatters the choice being made. The decision below survives it, because it turns on the render path rather than on the difference between $18.25 and $25.25, and that is now visible rather than assumed.

**Candidate two, a third-party edge with free universal TLS.** Cloudflare's Universal SSL ([Cloudflare](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/)) covers exactly the shape `viewer.md` §2 already constrains itself to:

> Universal SSL certificates cover your root domain (for example, `example.com`) and first-level subdomains (for example, `www.example.com`).

with

> Cloudflare handles issuance, renewal, and deployment automatically.

One DNS label is precisely the constraint `viewer.md` §2 imposes on the sandbox label. The certificate cost is zero.

**Decision: the global external Application Load Balancer with Certificate Manager, Cloud Run behind it unchanged.** The choice is made on the render path, not on a foreclosure.

**What a third party in the render path costs, stated plainly, because it belongs in the published disclosure statement rather than buried here.** `frame.md` already concedes the sharpest version of the honesty constraint, that the decrypting JavaScript is served by the same party the zero-knowledge claim is made against, so the claim is about operator intent rather than a verifiable property. A third-party edge widens that from one party to two: the entity serving the decrypting JavaScript is no longer only the operator, and `service.md` §5 item 3 would have to name the second one.

**How much worse depends on which origin the third party fronts, and the deployment has to be stated rather than assumed.** Two of them, and the second is the one candidate two exists for.

- **Fronting the service origin.** An edge terminating TLS there sees the mint response body, which carries the signed download URL, so it holds a bearer token for the ciphertext of every relic opened through it. Never the key, which is in the fragment and never in a request, so it cannot decrypt anything on its own.
- **Fronting the sandbox origin.** This is the deployment candidate two is actually for: free universal TLS covering first-level subdomains is a wildcard substitute, and the wildcard is the sandbox parent's. That origin serves the shim, and `viewer.md` §4 has the parent fetch, decrypt, and post the decrypted bytes into the shim. The shim never touches ciphertext and never touches the network, which reads as reassuring and is the wrong way round here: **it means the party serving the shim is serving the code that handles every relic's plaintext**, and a modified shim exfiltrates it directly. That is a different order of exposure from holding a signed URL.

Fronting both origins is the natural configuration and it takes both costs. `preconditions.md` §4's structural claim rests on the operator having no opportunity to observe, and either deployment is a real reduction that has to be disclosed rather than absorbed. **$25.25 a month is cheap against publishing that**, and cheaper still against walking it back later, which would be a public revision of the zero-knowledge posture.

**The certificate rate limits are not the constraint anybody expects, and the analysis below describes a path this design does not take.** That gets said first, because the decision three paragraphs down moots it and the document previously let it read as binding. One wildcard on a normal renewal cadence sits nowhere near any published limit. Let's Encrypt's numbers are

> Up to 50 certificates can be issued per registered domain

every seven days, and

> Up to 5 certificates can be issued per exact same set of identifiers every 7 days

Those bite exactly one design, which is per-relic certificate issuance, and that design is not on the table ([Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/)). The real constraint is the challenge type ([Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)). HTTP-01:

> This challenge cannot be used to issue wildcard certificates.

DNS-01:

> It also allows you to issue wildcard certificates.

and the cost Let's Encrypt names itself:

> Keeping API credentials on your web server is risky.

**Decision: issuance runs inside Certificate Manager under a DNS authorization, and no ACME client and no DNS provider API credential exists anywhere in Relic's infrastructure.** This is the reason the candidate-one choice is cheaper than it looks. Certificate Manager's DNS authorization delegates the challenge response rather than handing anything a credential ([Certificate Manager](https://cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth)):

> Before you create the certificate, create a public DNS zone. Then, create a DNS authorization and add the CNAME record to the target DNS zone.

and for the wildcard case,

> If you're creating a DNS authorization for a wildcard certificate, such as `*.myorg.example.com`, configure the DNS authorization for the parent domain

The record placed is a `_acme-challenge` CNAME pointing into `authorize.certificatemanager.goog`, written once by Relic and thereafter answered by Google. Nothing in Relic holds a DNS API key, and the risk Let's Encrypt names does not arise.

**The renewal half, sourced and with the inference marked.** Certificate Manager's overview page states the automation directly ([Certificate Manager overview](https://cloud.google.com/certificate-manager/docs/overview)):

> Using Certificate Manager, you can automatically issue and renew Google-managed certificates.

and the DNS authorization page ties that same CNAME to renewal rather than to first issuance alone, naming a conflicting record as

> preventing reliable certificate issuance or renewal

**That the challenge is re-answered against the same record on each renewal, with no further DNS write by Relic, is an inference from those two sentences rather than a statement either page makes.** It is the only reading consistent with both, and it is the load-bearing half of this decision, so it is worth one certificate stood up in `build` to confirm rather than inheriting as settled.

**Choosing Certificate Manager changes who the CA is, which moots the Let's Encrypt analysis above.** The same overview page:

> Certificate Manager only supports the Public Certificate Authority and the Let's Encrypt CA for issuing publicly trusted Google-managed certificates.

Either way the ACME account, the client, and the challenge response are Certificate Manager's, not Relic's. So the rate limits and the challenge-type comparison above are the reason not to run issuance in Relic's own infrastructure, and they are not constraints on the path chosen. **The limit that does apply to the chosen path is a different one and the document previously stated none:**

> The number of domains allowed in the Subject Alternative Names (SANs) field for Google-managed certificates is limited to a maximum of 100 when using DNS authorization and to a maximum of five when using load balancer authorization.

That binds nothing here under either branch of section 1, because a wildcard is one SAN covering the whole label and a fixed sandbox origin is one name. It binds hard on per-relic certificate issuance, which is the same design the Let's Encrypt rate limits rule out, from a second direction. Two independent limits landing on one rejected design is worth recording so nobody reopens it.

Two residuals, both stated rather than hidden. The CNAME is permanent infrastructure: pull it and renewal stops, which is what the sentence quoted above about issuance or renewal actually means. Google is equally explicit that it must be alone at that name,

> You must ensure that your `CNAME` is the only resource record for a specific DNS name.

so a stray TXT record left at `_acme-challenge` on the sandbox parent surfaces as a renewal failure months later rather than as an error at setup.

Under branch B the same mechanism applies with a single-name certificate rather than a wildcard, so the DNS authorization shape is identical and only the certificate's subject changes. The wildcard is what forces the parent-domain authorization; it is not what forces the mechanism.

## 4. The domain workstream, which carries two months-long irreversible items

`viewer.md` §7 costs the PSL and says nothing about **HSTS preload**, which both `format.md` §5 and `viewer.md` §1.7 name as the preferred way to remove inside-the-service redirects. It is the same shape as the PSL on the same domains and it is not costed anywhere ([HSTS preload](https://hstspreload.org/)).

> new entries are hardcoded into the Chrome source code and can take several months before they reach the stable version

> Be aware that inclusion in the preload list cannot easily be undone.

> Domains can be removed, but it takes months for a change to reach users with a Chrome update

and the required header is

> max-age=63072000; includeSubDomains; preload

**State it as what it is: PSL and HSTS preload are the same shape on the same domains, months in, months out, unexpeditable, and both belong at the moment of acquisition rather than behind work that looks more urgent.** They are sequenced for different reasons, and that difference matters to whoever runs the workstream. The PSL is unavailable at this scale per section 1.1, so it is not on the launch path at all. HSTS preload is available to anyone, so it is on the launch path and its clock starts the day the domains are bought.

`includeSubDomains` is the clause with teeth. It makes a valid certificate on every hostname under each registrable domain a permanent availability dependency, and HSTS makes the resulting failure non-bypassable rather than a click-through. Under branch A that binds the wildcard to an unbounded generated set. Under branch B it binds one name.

**The ordered workstream. Every step below is keyed to a domain that cannot be bought until the name is settled, which is why step 0 is a decision and not a task.**

0. **The name.** Section 7. Blocks everything below.
1. **Acquire both registrable domains**, distinct from each other and from `thebushido.co`, per `preconditions.md` §2 and `frame.md`'s locked constraint 2. `preconditions.md` §2 already records that this step **requires operator action and blocks deployment**.
2. **Verify both domains in Search Console.** `preconditions.md` §2 makes this a precondition rather than a follow-up and requires a second verified owner, so the named human is not a single point of failure. This is also what makes section 2's download-category listing visible at all.
3. **Submit both domains to HSTS preload.** Starts the months-long clock. Nothing later in this list depends on it, and everything about it gets worse the longer it waits.
4. **Create the DNS authorizations and issue the certificates**, per section 3. Under branch A that is a parent-domain authorization and a wildcard on the sandbox parent; under branch B it is a single-name certificate. The service domain takes a single-name certificate under either branch.
5. **Stand up the load balancer and Cloud Armor**, per sections 3 and 6.
6. **The PSL is not filed.** Revisit if and when Relic reaches the scale the list's guidelines describe.

## 5. When the mint fires, what it is counted over, and the shell's markup order

### 5.1 The mint trigger

`service.md` §2 rests the no-mint-on-`/{id}` rule on non-executing fetchers and concedes its own limit: **a scanner that detonates with a real browser does run it.** That scanner is verified rather than hypothetical. Mysk tested the major platforms in **October 2020** ([Mysk](https://mysk.blog/2020/10/25/link-previews/)) and found two vendor fetchers executing JavaScript, Instagram and LinkedIn, reporting

> We were able to confirm that we had at least 20 seconds of execution time on these servers.

with Instagram's fetcher unbounded on size, its

> servers will download anything no matter the size

**Carry the date with the number.** Both vendors have rebuilt preview infrastructure since that test, so twenty seconds is a measured floor from a dated experiment rather than a current figure, and it should not be re-cited in the present tense. It is used here for one purpose only, ruling out a dwell timer, and it does that at any value in its neighbourhood.

A JS-executing previewer runs the shell, mints a signed URL, and pulls ciphertext. That is a phantom open against the metric's first clause, a consumed unit of the per-object download cap, and real egress, all before a human clicks.

**Decision: the mint fires on the first trusted user input event on the page, and never on load.** Pointer, key, or touch. **`wheel` is deliberately excluded from the qualifying set** even though it is a trusted input event, because scrolling is precisely what an automated previewer that screenshots a page does, so admitting it hands the gate to the one automated behaviour most likely to occur anyway. The gate wants an act of intent and a scroll is not one.

**Why no passive signal works, measured rather than argued.** Both halves were run here against Google Chrome 150.0.7871.187, in `--headless=new` and `--headless=old`, with the probe page as the browser's startup URL and no user present.

- **Visible-and-focused is not a discriminator, and the measurement is unambiguous.** In both modes, with no input of any kind ever delivered, the page reports `visibilityState` of `visible`, `document.hidden` false, and `document.hasFocus()` true, from the first sample through three seconds, with no `visibilitychange` observed at any point. A headless previewer with nobody present reports exactly what a human staring at the tab reports.
- **The one reading that came back different is an artifact worth naming**, because it would mislead anyone who repeats the test. Driving the page into a tab opened at a blank URL and never focused yields `document.hasFocus()` false. That is a property of how the automation was driven, not of headless, so a focus check discriminates on the harness rather than on the presence of a human.
- **A dwell timer is worse than useless** against the verified case, because the measured execution budget is at least twenty seconds, so any dwell short enough to be a tolerable product is one the previewer clears, and any dwell long enough to beat it is not a product.

**The reason to prefer trusted input is behavioral, not structural, and this is the correction that matters most in this document.** A trusted user input event is **not** something a headless browser is unable to produce. Driven over the Chrome DevTools Protocol against the same build, `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` deliver `pointerdown`, `mousedown`, `mouseup`, `click`, `keydown`, `keyup`, and `wheel` **all carrying `isTrusted` true**. Those events are injected at the browser process, and `isTrusted` separates browser-originated events from ones page script synthesized. It has never separated a human from an automation driving the browser, and it does not here.

**So the gate buys one thing and not the other, and the two must not be run together.** Link-preview fetchers do not click. They fetch a URL, wait, read what the page produced, and move on, and there is nothing on the shell they would have any reason to click. **The gate therefore defeats the observed previewer population, and it is not a barrier against an adversary who sets out to burn the cap**, because that adversary drives a browser and injects trusted input at no cost. The design is entitled to the first claim only. Deliberate cap abuse is a control `design-operations-and-abuse` owns, and no mint trigger addresses it.

**The cost, stated straight.** Every recipient pays one interaction before bytes start moving, in the first five seconds, which is the most expensive place the wedge has to spend. It is bearable only because `viewer.md` §6.3 already requires the page to be a real page during that window: the branded taskbar, the service name, one line explaining what is about to happen, the abuse-report link, and the privacy-statement link all render immediately. The gate attaches to a control the recipient was going to use anyway rather than to a modal.

**The honest limit.** This removes vendor pre-delivery scans that run a browser without a user. It does not remove a time-of-click fetch that follows a real human click, and it should not: that is a human opening a link, and counting it is correct. Against `service.md` 2.3's arithmetic, the gate removes the JS-executing subset of the pre-delivery scans and leaves the time-of-click population alone. It removes nothing from anyone attacking the cap on purpose, per the paragraph above.

**What the branch not taken costs.** Auto-on-load is cheaper today and much harder to change later, because once the open counter has a baseline and the per-object cap has a published value, moving the trigger restates the metric and re-prices the cap in the same edit. The cap is `design-storage-grant-and-cost`'s to set and `service.md` 2.3 already names its binding constraint; this decision changes which population that arithmetic has to cover, and it changes it in the direction that makes the cap smaller.

### 5.2 The mint dedup interval (`service.md` 7.7)

The rules around it are fixed in `service.md` 2.2 and are not this document's. A refused mint is never an open and never consumes the cap. A repeat inside the interval is not a distinct open **and it does consume the cap**. A deduped mint returns the URL already issued for that relic and IP.

**Decision: 300 seconds.**

**The reasoning this value used to rest on does not survive, and that gets said before the value is defended.** The case made for 300 was that what remains for the interval is a hard reload, a reopen from the original link, or a second tab, and that those happen on a scale of minutes. **A hard reload cannot produce a mint at all.** `format.md` §2.5 strips the fragment and locks the consequence:

> The reloaded page is dead and must say so, pointing back to the original link rather than showing a decrypt error.

A dead page holds no key, decrypts nothing, and has no reason to mint. Strike it and two cases remain, a reopen from the original link and a second tab, **and neither of those is bounded in time.** A recipient reopens a link when they get back to it, which is minutes, or hours, or the next day. The phrase carrying the whole justification for 300 rested on the one case a locked rule removes.

**What actually constrains the value, without inventing a basis for it.** `viewer.md` §6.4 already handles the in-tab case from memory, reusing a still-valid signed URL rather than minting per page load, and a bfcache restore needs no handling at all. From behaviour, nothing follows: the two surviving cases are unbounded, so no ceiling comes out of how recipients act. The one real ceiling is mechanical. A deduped mint returns the URL already issued, so an interval longer than the signed URL's validity window hands back a URL that has expired, and `service.md` 2.2's exception path fires on the ordinary case instead of the exceptional one. Read from the other side, 300 seconds is a floor under a validity window this document does not own, and section 8 routes it as one.

**So 300 seconds is a judgment value in the minutes band, and nothing pins it.** It is not defended against 180 or 600, because no evidence available here separates them. What can be said is the shape of being wrong in each direction: too short and one recipient's repeat opens inflate the metric's first clause, too long and distinct recipients behind one egress address collapse into a single open, which is the cost stated below. It is cheap to move, nothing downstream keys on the exact number, and it should move on real repeat-open data rather than on a better argument.

**What it does to the phantom-open count under the branch chosen in 5.1: nothing, and that is the point.** Under the gesture gate the observed previewer population never mints, so there is no phantom open for the interval to collapse. The population 5.1 says the gate does **not** stop, an adversary injecting trusted input, is not collapsed by the interval either, since varying source addresses is theirs to do. Under the branch not taken it would matter and it would still not be a fix: it would collapse a delivery burst only where the scanning infrastructure shares one egress address, and `service.md` 2.3's own scenario is per-recipient wrapping inside one tenant, where that is a guess rather than a property.

**Sizing the interval to catch scanners would repeat a mistake this spec set has already recorded once.** `service.md` 2.2 says of the frame's window:

> The 120-second post-publish window is anchored to publish time and it is not a scanner filter.

and that tuning the value cannot fix a defect that lives in the anchor. The same reasoning applies here at a different anchor: the scanner filter is the mint trigger, and stretching a dedup interval to do that job trades a known metric bias for a worse one without touching the mechanism.

**Reconciled with the frame's 120-second window.** They are independent filters with different anchors and they compose without either needing to become the other. The frame's baseline filter drops opens whose requesting IP matches the publishing IP. The frame's 120-second window anchors to publish time and drops the immediate self-check from a second device. The dedup interval anchors to the first successful mint for a given relic and IP pair and collapses repeats inside five minutes. That 300 exceeds 120 is deliberate rather than incidental: the two measure different things, so there is no reason for them to agree, and the dedup interval is not raised to try to cover the publisher who opens from a phone five minutes later. That gap is real, `frame.md` names it, and the anchor that causes it is `frame.md`'s.

**One asymmetry to carry, because this document treated 120 as fixed and its owner does not.** `frame.md` says of its own number:

> Treat 120 seconds as a provisional value set by judgment. A later station moves it once there's real data.

So both numbers in this reconciliation are judgment values waiting on data, and neither is a fixed point to calibrate the other against. Reconciling them means keeping their anchors distinct, which is what the paragraph above does, and it does not mean sizing 300 around 120.

**The cost, in the direction `service.md` 2.2 already declared safe.** Dedup keys on IP, so distinct recipients behind one egress address inside five minutes collapse into a single open. That undercounts the metric's first clause in exactly the corporate-NAT distribution the cap arithmetic is built on. It fails in the safe direction, making you believe you lost when you won, and it is never a number to present as clean. The interval does not protect the cap at all, because a deduped mint still consumes it, which is what keeps `preconditions.md`'s worst-case egress arithmetic from collapsing.

**Routed to `specify` as drift, alongside section 1.7.** `service.md` 2.2 explains what dedup catches by pointing at a recipient who is

> reloading the page, because the publisher's own reload is already gone

That sits in the same tension with `format.md` §2.5 as the rationale struck above. A reload loses the key and the reloaded page is dead, so a reloading recipient is not a case dedup can catch, and the justification in 2.2 is doing no work. **This document repeated that phrase instead of catching it, which is why it is named here rather than quietly worked around.** The rules in 2.2 are unaffected: a repeat inside the interval still is not a distinct open and still consumes the cap, and both of those hold for a reopen or a second tab. What needs revisiting is the stated reason for having an interval, which is `specify`'s and not this station's to change.

### 5.3 The static shell's markup order

The most consequential unfurler range-fetches the head. Slack, in its own words ([Slack robots](https://api.slack.com/robots)):

> It fetches as little of the page as it can (using HTTP Range headers) to extract meta tags about the content.

**Decision: `/{id}`'s `<head>` opens with the character-set declaration and then the complete Open Graph and Twitter Card block, and no script, style, preload, or link tag precedes it.** Open Graph's required set is fixed by the protocol ([Open Graph](https://ogp.me/)), which states that

> The four required properties for every page are

`og:title`, `og:type`, `og:image`, and `og:url`. While `og:type` (`website`) carries a constant value, `og:title` carries a publisher-declared plaintext title (defaulting to the source filename) or a per-class fallback, `og:description` reveals the coarse renderer class, and on 2026-10-13 `og:image` became per-relic when a cover is uploaded (with `/assets/card.v1.png` retained as fallback), reversing the prior constant-image rule per `docs/decisions.md`. For relics without a cover, the fallback card remains at `/assets/card.v1.png` under an immutable cache policy.

**The failure it prevents.** If the metadata falls outside the fetched range the unfurl produces no card, and `viewer.md` §6.2 names what that looks like: **a blank card on an unfamiliar domain is the visual shape of a phishing link.** Getting the byte order wrong in a template produces exactly the phishing-shaped card the constant metadata exists to prevent, silently, on every channel that range-fetches.

**Preview imagery is real recurring egress on the service origin, with no CDN in front of it.** [Amended 2026-10-13: Per-relic covers are served directly from the service origin at `/{id}/cover/{sha256}.{png|jpg}` without a CDN, caching under `cache-control: public, max-age=86400` (1-day cache). See `docs/decisions.md` (2026-10-13).] The fallback image is served from the static path `/assets/card.v1.png` under an immutable cache policy (`public, max-age=31536000, immutable`). Per-relic covers use a 1-day cache to bound takedown visibility in honoring caches to 24 hours while allowing content-addressed cache busting on republish. Repeat unfurls within a client's cache window are served from cache rather than from the bucket.

Slack fetches preview imagery and caches the result ([Slack robots](https://api.slack.com/robots)):

> Responses to these requests are cached globally across the service for around 30 minutes.

So the preview image is fetched per unfurl rather than per open, bounded per client by that client's cache window, and it is the one asset on the service origin whose volume scales with link pastes rather than with relic opens.

## 6. Edge fidelity (`service.md` 7.1)

Read strictly as edge behaviour. No status, code, or distinction in `service.md` §1 is this document's; those are settled there and nothing here reopens the table. What is decided here is which of them the deployed edge can actually produce under load shedding, and what it does where it cannot emit a problem document.

`service.md` 1.5 states the requirement:

> The status must be correct at the deployed edge, not only in the application.

**The rate-limit deny status. Decision: `deny(429)`.** Cloud Armor's valid set is small and Google names its own preference ([Cloud Armor rate limiting](https://cloud.google.com/armor/docs/rate-limiting-overview)):

> Valid values are `403 Forbidden`, `404 Page Not Found`, `429 Too Many Requests`, and `502 Bad Gateway`.

> We recommend using the `429 Too Many Requests` status code.

Every other member of that set is excluded for a stated reason, so the choice is complete over the set rather than merely defensible.

- **`403` is the natural default and it violates a locked rule.** `service.md` 1.1 bars `401` and `403` from every public endpoint, widening `preconditions.md` §4's rate-limiting rule, because Claude Code marks a remote server as needing authentication on either status ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). Choosing it here would push publishers at an authorization server that does not exist, from a config line nobody reviews.
- **`404` collides with case 1.** A rate-limited caller would be indistinguishable from a bad relic ID.
- **`502` has no mapping.** `service.md` 1.5's degradation contract covers a bare `429` and a bare `503` and nothing else, so a `502` arrives as an uncoded failure with no client behaviour attached.

**The status the edge cannot emit is `503`.** It is not in the valid set above. **So `503 service_paused`, case 11, can only come from the application, and the egress kill switch therefore lives in the app server and nowhere else.** That is not a limitation to work around; it is the correct placement, since the kill switch trips on an application-owned signal. What it does require is that the edge is configured to pass traffic to the app rather than shed it in a way that masks a `503` the app is trying to send.

**The substitute behaviour where the edge cannot emit a problem document.** Cloud Armor's `deny(status)` returns the status with a default body, not `application/problem+json`, and it carries no `Retry-After`. So under edge shedding the client loses both the machine-readable `code` and the retry hint. `service.md` 1.5 already fixes half the contract, reading a bare `429` as `mint_rate_limited` or `publish_rate_limited` by endpoint. This document fixes the other half:

- **A bare `429` from the edge carries no `Retry-After`, and a client treats its absence as back off on your own schedule.** Anything richer requires the request to reach the app, which is exactly what the edge is refusing to let happen.
- **The `code` distinction survives in the edge's own logs through rule naming.** `service.md` 1.2 accepts a real cost, that every operator dashboard keys on `code`, and warns that a load balancer access log is often status-only. Cloud Armor logs the matched rule on every enforced request, so **every rate-limiting rule is named for the `code` it stands in for**, and a status-only edge log still resolves to a code without depending on the app's mint log retention window.

## 7. The name, which is free today and closes at the domain purchase

The domain workstream in section 4 starts at the name, so this document owns stating the decision that gates it. **The operator picks the name. This document does not, and nothing below is a recommendation.**

**The naming decision blocks the domain purchase, which blocks deployment.** `preconditions.md` §2 already records the purchase as an external dependency that **requires operator action and blocks deployment**. The name sits immediately upstream of it. It is free right now and brutal afterwards: `frame.md` locks no accounts anywhere in the product, so there is no channel through which an installed MCP client fleet can be told the domain moved. The package registry is the only path, and it reaches only clients that upgrade.

**The collision is concrete and it is in the product category, not only in the string.** npm `relic` is taken by a client-side-encrypted secrets CLI whose published description reads as nearly Relic's own positioning sentence ([npm registry](https://registry.npmjs.org/relic)):

> The Relic CLI for managing and sharing secrets. Encrypted on your device, never exposed to anyone else. Not even us.

Checked directly against the registry on 2026-07-30: latest `0.9.2`, 22 published versions, registry `modified` timestamp `2026-04-14T19:55:23.130Z`, repository `github.com/heycupola/relic`, and a `bin` entry mapping the command name `relic`, so the installed CLI command collides too.

**What is still available, with the check that was run and the gap in it named.** Domains checked 2026-07-30. **The method is not uniform across the table, and saying so is most of the value of the section.** Where a TLD has an entry in the IANA bootstrap ([IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json), publication 2026-07-23), the check is a query against that registry's own RDAP service, cross-checked against DNS delegation. **`.io` and `.sh` have no entry in that bootstrap at all**, so no registry RDAP endpoint resolves for either, and those two rows rest on DNS delegation alone. Package names checked the same day against the npm registry ([npm registry](https://registry.npmjs.org/relic)).

| Name | Result | Basis |
|---|---|---|
| `relic.com`, `getrelic.com` | Registered | Verisign RDAP 200 |
| `relic.dev`, `relic.app` | Registered | Google Registry RDAP 200 |
| `relic.host` | Registered | Radix RDAP 200 |
| `relic.io` | Registered | No `.io` entry in the bootstrap, so no registry RDAP. Delegated to a parking service's nameservers, with an A record |
| `relic.link`, `relic.build`, `relic.page`, `relic.zip` | Unregistered at check time | Registry RDAP 404, no delegation |
| `relicusercontent.com` | Unregistered at check time | Verisign RDAP 404, no delegation |
| `relic.sh` | Not established | No `.sh` entry in the bootstrap, so no registry RDAP, and no delegation either |
| npm `relic-mcp`, `mcp-relic`, `relicusercontent` | Unregistered at check time | `registry.npmjs.org` 404 |

**Two rows share one condition and land on opposite dispositions, so the rule separating them gets stated rather than left to be noticed.** `.io` and `.sh` are in identical positions: outside the bootstrap, with no authoritative RDAP answer available. What separates them is delegation. `relic.io` answers DNS through a parking service, which is positive evidence somebody holds it. `relic.sh` answers nothing, and a registered domain is free to have no nameservers, so that proves nothing in either direction. **Positive evidence promotes a name to registered; absence of evidence never promotes one to available.** Every disposition in the table runs on that asymmetry.

**The check has a failure mode worth carrying, because it was hit while running it.** The `rdap.org` aggregator returned 404 for `relic.io`, which reads as available. It is not: the name resolves and is parked. **An aggregator 404 is not evidence of availability**, and for a TLD outside the bootstrap there is no registry endpoint to overrule the aggregator, which is exactly the combination that produces a confident wrong answer. Every row above claiming a name is free rests on that registry's own RDAP 404 plus absent delegation, and the one row where neither is available is reported as not established rather than folded into the free list.

**What restarts from zero on a later rename**, which is the whole reason the workstream in section 4 cannot start ahead of the name:

- **HSTS preload.** The new domains start their months-long clock from scratch, and the old ones stay preloaded on their own months-long removal clock, so a rename runs two irreversible clocks at once.
- **Safe Browsing standing and Search Console verification.** Both are per-domain and neither transfers. The new domains are unverified, which `preconditions.md` §2 describes as flagged and blind.
- **Any download-category reputation from section 2.** Reputation is the asset section 2's decision exists to protect, and a rename discards whatever has accrued.
- **Every relic ever shared.** The links are in the wild with no channel to update them.

The package name and the product name do not have to match, and the MCP tool name is already fixed as `relic_publish` by `publish.md` 1.1, which none of this touches. `frame.md`'s non-goals also bound the shape of any answer:

> **No custom domains.** The domain strategy is a security control, not a branding surface.

## 8. What this document needs from siblings

Stated as needs, with the owner named and the behaviour that follows either way.

1. **The per-object download cap value and the signed-URL validity window (`service.md` 7.4), from `design-storage-grant-and-cost`.** Section 5.1's mint gate changes which population the cap has to cover, in the direction that makes the cap smaller, and nothing here depends on the cap's value. **The validity window is a different case, because this document does constrain it and previously said it did not.** Section 5.2's 300-second dedup interval is a floor under it: `service.md` 2.2 has a deduped mint return the URL already issued rather than a fresh one, so a validity window shorter than the dedup interval means the stored URL has routinely fallen below its minimum viable validity by the time a repeat arrives, and 2.2's exception path fires in place of the dedup on the ordinary case rather than the exceptional one. The need is that the validity window comfortably exceed 300 seconds, or that whoever sets it says so and 300 comes down. The value is theirs either way, and section 5.2 already says 300 is cheap to move.
2. **An answer to the download-attribution question in section 2, from whoever runs the pre-launch channel test `service.md` §6 already mandates.** `design-operations-and-abuse` owns that test. The need is one observation: whether a `blob:` save initiated from the viewing origin attributes download reputation to that origin. The decision in section 2 stands under either outcome; what changes is whether the service domain's download-category exposure is a residual to monitor or a closed question.
3. **The published SLA and the abuse runbook, from `design-operations-and-abuse`.** Section 2 establishes that the Safe Browsing appeal is unanswerable on a stripped sample URL, so the abuse-process documentation is the entire content of any reconsideration request.
4. **Nothing from `design-container-and-crypto`.** Its 71-character relic URL on a twelve-character domain is consumed here as the bound on link length. Only the service domain enters that number, because the sandbox origin never appears in anything a human pastes, which is section 2's own starting point. **The ceiling holds over the candidates section 7 lists, not over the naming decision itself.** Every service-domain candidate in that table runs from eight to twelve characters including its TLD, so 71 bounds the link length if the operator picks from the table, and a longer name raises it by exactly the extra characters. The number is stated with that assumption attached rather than as a property of the design. `relicusercontent.com` in the same table is twenty characters and is a sandbox-parent candidate, so it never enters this arithmetic at all.
