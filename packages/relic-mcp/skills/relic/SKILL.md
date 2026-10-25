---
name: relic
description: Publish a local file as an encrypted, shareable link when someone outside this session needs to see it. Use when the user says "share this", "send this to X", "publish this", "give me a link for this", "make this shareable", or has just been handed a generated report, HTML page, deck, image, or export and needs it somewhere a person can open. Also covers sending a relic to named people (relic_share), republishing a new version of an existing relic, reading the comments people leave on one and answering them, reading approval decisions (relic_read_decisions), what the recipient sees, how long a link lives, and what the service can and cannot read.
---

# Relic

Turn a file on this machine into a URL you can hand to a person.

The file is encrypted here, before anything is uploaded. Only ciphertext
reaches the service for the file contents. The key lives in the URL fragment,
which browsers never send to a server, so the operator holds bytes they cannot
open. By default, a 1200x630 cover image of the first screen is rendered locally
in headless Chrome and uploaded unencrypted for link preview cards; pass
`cover: false` to decline.

## Publishing

Call `relic_publish` with a filesystem path:

```
relic_publish(path: "/Users/me/Downloads/report.html")
```

It takes a **path, not content**. That is deliberate: the plaintext never
enters the conversation, so it is never in the transcript, never in a model
context window, and never in whatever stores those. Do not read a file into
context and pass its text; pass where it lives. A standard OpenTimelineIO
directory (`.otiod`) is automatically packaged into a
standard `.otioz` archive on a packaged native target: macOS arm64 or x64 with
a 15.0 binary deployment floor, or Linux glibc 2.28+ arm64 or x64. On either
platform, before it reads a bundle, the helper verifies on the running kernel
that beneath-root resolution refuses parent and absolute escapes from a held
directory and that the no-symlink flag is accepted. Symlink refusal,
held-descriptor behavior, and replacement behavior are verified by the CI probe
on the listed versions. A failed requirement refuses conversion rather than
falling back to pathname checks. Arbitrary directories are refused.

When the task is to update the same source, call `relic_lookup_source` first:

```
relic_lookup_source(path: "/Users/me/Downloads/report.html")
```

It reads local machine state only. If the source was published before, it
returns the relic id and the exact `relic_republish` call. This works across
Git worktrees and clones of the same remote, so a fresh session does not need
to retain the id from the first publish.

Do not publish an update as a new relic. That costs a second URL that nobody
holding the first one will ever see. `relic_publish` enforces this: when local
state matches the source, it refuses and points to `relic_republish`.

Anyone holding a relic's link can fetch every version it has ever held, so
republishing does not withdraw earlier content. Republishing moves the artifact
forward without retracting what came before. Deleting the relic still removes
every version.

Optional arguments worth knowing:

- `filename` overrides the display name shown to the recipient.
- `title` sets a plaintext title shown in link previews and in the browser
  tab. It defaults to `filename`. It is NOT encrypted: the service stores it
  and anyone who fetches the link sees it, with or without the key. Pass `""`
  to publish without a title.
- `cover` controls whether to render and upload a 1200x630 cover image of the
  file's first screen for link previews. Defaults to `true`. Renders locally
  in Chrome. It is NOT encrypted: the service stores it and anyone who fetches
  the link sees it, with or without the key, including chat previews (Slack,
  iMessage, etc.) and their caches. Pass `cover: false` for anything you would
  not show in a chat preview (such as confidential documents, private drafts,
  or credentials). OpenTimelineIO timeline relics (`otio`) skip unencrypted
  first-screen media rendering by default, using a generic card carrying the
  title and format label to protect private timeline cuts and media from leaking
  into unencrypted preview cards. When declined with `cover: false`, link
  previews show the generic Relic card. Republishing with `cover: false` clears
  any stored cover.
- `ttl_days` gives the link a lifetime in days, 1 to 3650. A relic is kept
  until it is deleted unless you set one. Shorter is better for anything
  sensitive: when the content should stop being available, say when.
- `force_new` deliberately creates a separate relic from a source this machine
  already published. Use it only when two independent URLs are the goal, never
  to get past the update refusal.

The result reports the relic as version 1 and its id. The client records that
id with the source locally, so a later session can recover it with
`relic_lookup_source`.

## Finding what you published, and reading it back

`relic_lookup_source` only answers when you are holding the file. For every
other question, start with the inventory:

```
relic_list()
```

It is the only tool that enumerates. Every relic this machine published comes
back newest first, with its name, version, lifetime, status, and share URL,
whether or not its source path was ever recorded. On the machine this was
built for, the source index named 4 of 41 relics; the other 37 had a key and a
publish token on disk and no tool that could say their names.

Four things about a row:

- **A name that was never recorded is recovered, not guessed.** It lives
  inside the relic's encrypted envelope, so the client mints, reads the first
  record, and decrypts it here. When that fails the name is `null` with the
  reason attached. Nothing is inferred from a relic id.
- **Nothing is dropped.** A relic the service will not serve is listed with
  what happened: removed, expired, its opens exhausted, or the service
  unreachable. A short list would read as having published less.
- **Each row is a credential.** The share URL includes the fragment, which is
  the key, so a listing puts every one of those keys in the transcript. That
  is the point of the row and worth saying when you paste one.
- **Reaching the service spends one of a relic's finite opens.** Recovered
  names are cached locally, so a repeat listing spends none. `verify: true`
  asks about every relic and costs an open each; `refresh: true` re-reads
  every name.

Then read one back before you change it:

```
relic_show(relic_id: "0a2c...", include_content: true)
```

That returns what the link currently serves, decrypted here, plus how many
versions the service holds. Do this before `relic_republish` on anything you
did not just write. Republishing replaces what the link serves outright, so
without reading it first the edit is blind: you would be rewriting from memory
for everyone already holding the URL.

## Republishing

Call `relic_republish` with the relic id and a new file:

```
relic_republish(relic_id: "0a2c...", path: "/Users/me/Downloads/report-v2.html")
```

The new file becomes version 2, then 3, and so on, encrypted under the same
key as version 1. **The share URL does not change**: everyone holding the
existing link now sees the new content, and there is no new link to hand out.
`relic_id` is the 26-character id the original publish returned, not the URL.
Optional `filename` overrides the display name in the new version; optional
`title` replaces the plaintext title (pass `""` to remove it).

Two things to know before promising an update:

- **Republishing works only on the machine that published.** The key and the
  publish token are recorded locally when the first publish happens, in a
  0600 file under the user's config directory. On any other machine the tool
  refuses: the relic was published from another machine and cannot be
  republished here. Neither secret is ever printed or logged.
- **A takedown is terminal.** If the relic was removed, republishing cannot
  revive it, ever, whatever token is presented. The tool says so plainly;
  publish the content as a new relic instead.

A relic's lifetime is set at its first publish and carries across versions
unchanged.
## Sending a relic to people

Call `relic_share` with the relic id and up to 20 email addresses:

```
relic_share(relic_id: "0a2c...", emails: ["ada@example.com", "grace@example.com"])
```

`relic_share` registers the addresses with the service so each recipient receives an email notice whenever someone comments or a new version is republished. It composes a ready-to-send share email containing the full URL and key, and returns both the email text and a `mailto:` link.

Draft the email in the user's own mailbox (or hand over the `mailto:` link if there is no mail tool available) and let them send it. Relic never sends the share email, because the share link carries the key in its fragment, and the service must never receive the key.

Addresses are stored by the service in the clear, linked to the relic id. When you republish, the service automatically sends a change notice to each commenter and shared address, unless you pass `notify: false`. When a new comment is posted, the service emails everyone on the relic's list (commenters, shared addresses, and the owner address) except the comment's author, naming the commenter's address (or "The publisher"). Relic sends at most one email per person per relic per 10 minutes, and one stop link stops every email about that relic.

Readers holding the link can also share from the viewer once a relic was published or republished by this client version.

## Comments

People can comment on a relic, and that is the only way a reader can answer
back. A new comment on a relic emails everyone on its list (verified commenters,
shared addresses, and the owner address) except the author, naming the
commenter's address (or "The publisher"). At most one email per person per
relic per 10 minutes is sent, and one stop link stops every email about that
relic. You have no mailbox, so none of those emails reach you: read them.

```
relic_read_comments(relic_id: "0a2c...")
```

Read them **before** you change content somebody was asked to review, and read
them again after you hand a link over and come back to the task. A comment
that nobody read is the same as a comment nobody left, except somebody spent
the effort.

Answer with:

```
relic_comment(relic_id: "0a2c...", body: "Fixed the chart, republished as version 3.")
```

Posting a comment with `relic_comment` emails everyone following the relic,
naming "The publisher".

Four things to know:

- **Both work only on the machine that published the relic.** The comment key
  is derived from that relic's key, which lives in the same local 0600 file as
  the publish token. On any other machine they refuse, for the same reason
  `relic_republish` does, and no retry changes it.
- **Pass the relic id, never the URL.** The URL carries the key in its
  fragment. Passing it would put the key in the transcript again for nothing.
  The tools refuse a URL and say so.
- **Your comment is attributed to the publisher, not to a person.** A human
  commenter verifies an email address through a magic link and that address is
  their identity. You have no mailbox, so the publish token stands in and the
  comment reads as `publisher`. Posting emails everyone following the relic,
  naming "The publisher". Optional `display_name` puts a label beside it;
  it decorates the attribution and never replaces it.
- **A comment that will not decrypt comes back marked unreadable**, with a
  count. That is not noise to filter out: it means part of the conversation is
  unread. Say so rather than acting as though the readable ones are all of it.
  On OpenTimelineIO timelines, comments bind to specific tracks and rational
  time ranges, preserved across republishes and mapped to original source
  intervals.
Comment bodies are encrypted on this machine, so the service stores ciphertext
it cannot read. What it does learn is who commented on which relic and when,
which for a human commenter is a verified email address. Worth saying plainly
if somebody asks what commenting costs them: the content stays private and the
participation does not.
## Decisions

Readers can record approval or rejection decisions in the viewer, confirmed with a passkey. Decisions are separate from comments: comment text never creates a decision, and no MCP tool records one.

Read decisions with:

```json
{
  "name": "relic_read_decisions",
  "arguments": { "relic_id": "0a2c..." }
}
```

Optional `version` takes a version number (`1`, `2`, ...) to read decisions for that specific version, or `"*"` to read decisions across all versions. When omitted, it defaults to the relic's current version.

Four things to know:

- **Decisions are made by a person in the viewer with a passkey.** No tool can approve or reject a relic.
- **A person's latest record on a version is their current decision.** If someone approves and later rejects the same version, both records are kept and the latest reflects their current verdict.
- **Each decision binds to an exact version and ciphertext digest.** A decision on version 1 applies to version 1 only, not to later republished versions.
- **Works only on the machine that published the relic.** Reading decisions requires the share proof derived from the encryption key, which lives in the local publish state file.


## Say this when you hand over the link

**The key is in the URL, and the URL is now in the transcript.** Anyone with
this conversation can open the file. That is structural, not a bug being fixed
later: returning a usable link is the product, and a usable link contains the
key.

So the honest framing for the user is: zero-knowledge holds against whoever
runs Relic. It does not hold against their model provider, or anyone who can
read their session history. If the content should not be in a transcript at
all, it should not go through an agent.

Also worth one line, unprompted, the first time in a session:

- a relic is kept until it is deleted, unless it was published with a
  `ttl_days` lifetime, in which case the tool returns the exact date
- opens are capped, and the tool's mint response reports how many remain
- anyone with the link can read it; there are no per-recipient permissions

## What the recipient gets

A page that fetches the ciphertext, decrypts it in their browser, and renders
by type. Markdown, code, images, and plain text render inline. PDF renders
in an in-browser document viewer. Audio and video files play in an in-browser
player. OpenTimelineIO timelines (`.otiod` directories packaged as `.otioz`,
or `.otioz` archives) play in a native timeline player with multi-track
inspection, trims, dissolves, and additive audio. HTML and JSX render in a
sandboxed frame on a separate origin, so a published page cannot reach the key
or the service. General archives and binaries offer a download.
That frame has **no network access**: its policy permits no remote source at
all, so a page cannot fetch, beacon, or load an external image, font, or
script. Inline what a page needs when you generate it, because a CDN
reference renders as nothing. The upside is that a relic cannot phone home or
learn the recipient's IP address.

They need the whole URL including the `#...` part. A link truncated at the `#`
is a page that cannot decrypt anything, and that is the most common way sharing
fails: chat clients and ticket systems sometimes cut fragments.

## When not to use it

- **Something that belongs in the repo.** Commit it. A relic is a link you
  hand someone, not a place work lives; the repo is.
- **A client deliverable.** Those have a durable home, and a share link is
  not it, even one with no expiry. Publish a relic in addition if someone
  needs to look at it now, never instead.
- **Credentials, keys, or tokens.** Encrypted in transit and at rest still ends
  with a secret sitting in a URL in a transcript.

## Checking what the client does

`relic_describe_client` returns the client's own account of what it uploads and
what it withholds, plus the service it is pointed at. Use it when the user asks
what is actually being sent, rather than paraphrasing this file. The published
client source and cover rendering bundle in `dist/cover/` are unminified, so
"read it yourself" is a real answer.
