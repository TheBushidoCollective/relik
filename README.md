# Relic

Zero-knowledge publishing for agent output. Your coding agent encrypts a file
on your machine, uploads only ciphertext, and hands you a link. The service
never receives the key.

```
https://relik.link/{id}#{secret}
```

The fragment is never sent to a server, so the operator holds ciphertext and
nothing that opens it. A recipient's browser fetches the ciphertext, decrypts
it locally, and renders it by type.

## What is honest about the claim

The JavaScript that performs the decryption is served by the same party the
zero-knowledge claim is made against, and that party could serve different
JavaScript tomorrow. This is a statement about operator intent, not a property
a recipient can verify. Anyone claiming otherwise for a service of this shape
is overclaiming.

The publish tool returns the full URL including the fragment, because handing
you a usable link is the product. **The key therefore enters your model's
context and your session transcript on every publish.** Zero-knowledge holds
against the Relic operator. It does not hold against your model provider or
whoever stores your transcripts, and that is structural rather than a defect
on a schedule.

Rendered content is not inert. A relic that renders as HTML or JSX runs its
author's code in a sandboxed frame whose policy permits no remote source, so
the code cannot make outbound HTTP, WebSocket, or worker requests, and a page
that expects external images, fonts, or scripts renders without them. Because
browsers do not enforce Content-Security-Policy over WebRTC ICE candidate
gathering, the frame bootstrap installs a tested deny-list inside the frame's
JavaScript realm: it neutralizes WebRTC constructors across the global prototype
chain and blocks nested browsing context creation (iframe, frame, object, embed,
portal) to prevent UDP STUN candidate gathering. This is defense in depth
alongside the opaque sandbox, not an architectural impossibility. Future browser
APIs or parser entry points could reopen egress channels before we patch them,
and the containment costs relic capabilities: nested frames and workers in HTML
and JSX relics are denied. The sandbox keeps rendered content away from the
decryption key, which never leaves the link and your browser. The isolation is
about network reach, not safety: the code runs in your browser, can use your
CPU, and can render whatever it wants. The viewer says so on the page before the
content renders, and so does `/policy`.

The viewer renders Markdown, code, HTML, JSX, still images, PDF, and provides
in-browser players for audio and video media and OpenTimelineIO timelines
(`.otiod` directories packaged as `.otioz`, or `.otioz` archives). Arbitrary
directories remain refused, while general archives and binaries remain
download-only. For OpenTimelineIO relics, unencrypted first-screen media
rendering is skipped by default to prevent private timeline cuts or frames from
leaking into unencrypted link unfurl previews.

`/policy` states the whole trade: the telemetry, the optional plaintext title,
the per-relic cover image raster stored in the clear for unfurl cards
(rendered by default and declined with `cover: false`, with generic cards for
OpenTimelineIO), and what the operator learns. The frame conditions the
telemetry on that statement being readable before anybody publishes.

## The packages

| Package | What it is |
|---|---|
| `@relic/format` | The wire format. RFC 8188 `aes128gcm` framing around an envelope that lives inside the encrypted stream. Imported by both ends so the encryptor and the decryptor cannot drift apart. |
| `@relic/server` | The app server. Grants, mints, the abuse surface, delete-by-id, and the published disclosure. Never handles relic bytes on either leg. |
| `relic-mcp` | The local MCP server, published to npm. Holds the key, encrypts in process, returns no script, and persists the key and publish token that republish needs. |
| `@relic/viewer` | The PWA. Decrypts in the browser and renders by type under a taskbar. |

## Running it

```bash
mise install          # bun, biome, node, pinned in mise.toml
bun install
bun run verify        # lint, typecheck, and the full suite
bun run --filter '@relic/server' dev
```

The server refuses to start on memory storage when `NODE_ENV=production`. In
development it warns and continues, because a service that silently serves
from memory looks healthy, accepts publishes, and loses every relic on
restart.

### Configuration

| Variable | Meaning |
|---|---|
| `RELIC_SERVICE_ORIGIN` | The API and the PWA shell. |
| `RELIC_USERCONTENT_ORIGIN` | Where untrusted HTML renders. A **different registrable domain**, never a subdomain. |
| `RELIC_GCS_BUCKET`, `RELIC_GCS_CLIENT_EMAIL`, `RELIC_GCS_PRIVATE_KEY` | Service account for V4 signed URLs. |
| `RELIC_OPERATOR_TOKENS` | `name:secret` pairs. Per-operator, because every delete writes an audit record naming one. |
| `RELIC_KILL_SWITCH` | Refuses every mint and every publish. |

## Connecting the MCP server

Relic exposes `relic_publish`, which takes a filesystem path (and optional
`title` and `cover` arguments for link unfurls) and never inline content.
Standard OpenTimelineIO directories (`.otiod`) are automatically packaged into
standard `.otioz` archives for native in-browser timeline viewing while
preserving the directory path as source identity; arbitrary directories are
refused. `relic_describe_client` explains what the client does with your file
without reading it or contacting anything.

It also exposes `relic_republish`, which posts a new version of a file to an
existing relic's URL. It takes the relic id and a path (with an optional
`title` to replace or clear the card title, an optional `cover` argument to
replace or clear the cover image, and an optional `notify` flag to control change
notices, defaulting to true); the publish token is never an argument and
never printed, because the client stored it beside the relic's key at first
publish and reads it back from there. Each new version emails a change notice to
commenters and shared addresses unless `notify: false` is passed. At most one
email per person per relic per 10 minutes is sent, and one stop link stops
every email about that relic. The server issued that token once and keeps only
its hash, so the machine that published is the only machine that can
republish: lose that state and nobody, the operator
included, can authorize another version. Opening the link always serves the
current version, and the download cap is shared across all versions. A relic
taken down for abuse refuses every future version whatever token is presented,
because a takedown an abuser could out-publish would not be a takedown.

`relic_share` sends a relic this machine published to named people. It registers
up to 20 email addresses with the service for change and comment notices,
and returns a ready share email and mailto link to draft in the sharer's own
mailbox so the key never leaves the client. Addresses are stored in the clear by
the service, linked to the relic id. A new comment emails everyone on the list
except the author, naming the commenter's address (or 'The publisher'). At most
one email per person per relic per 10 minutes, and one stop link stops every
email about that relic. Readers holding the link can also share from
the viewer once the relic was published or republished by this client version.

`relic_list` and `relic_show` are how a publisher finds a relic again. Lookup
by source only answers when you are still holding the file, so a relic whose
path was never recorded, or has since moved, was addressable by nothing: on
one real state file, four of forty one relics were findable and the other
thirty seven held a key and a publish token that no tool could name. The list
enumerates every one of them and recovers a name this machine never wrote
down by decrypting the relic's own envelope rather than guessing from its id,
reporting a relic the service will not serve with which of removed, expired,
exhausted or unreachable it is rather than leaving the row out. Every row
carries the share URL including its fragment, which is the key, so a listing
is a list of credentials. `relic_show` returns what a link currently serves,
which is what makes replacing it an edit rather than an overwrite from
memory.

Two more tools cover comments. `relic_read_comments` and `relic_comment` are
how an agent takes part in the conversation on a relic rather than only
creating one. Both take the relic id rather than the share URL, because the
URL carries the key in its fragment. Comment bodies are encrypted on the
publishing machine under a key derived from that relic's key, so the service
stores comment ciphertext it cannot read, and both tools work only on that
machine for the same reason republish does. An agent has no mailbox to verify,
so its comments are authorized by the publish token and attributed as
`publisher` rather than as an email address. Posting with `relic_comment` emails
everyone following the relic, naming "The publisher". A new comment on a relic
emails everyone on its list (commenters, shared addresses, and the owner address)
except the comment's author, naming the commenter's address (or "The publisher").
At most one email per person per relic per 10 minutes is sent, and one stop link
stops every email about that relic. What the service does learn is
who commented on which relic and when; now also whether a comment was
edited, the `edited_at` stamp, and whether it was settled and by which
address. There is no edit history, because the service holds one ciphertext
per comment and an edit overwrites it. A resolution cannot be encrypted for
the same shape of reason: it decides whether a republish is blocked, which
is an answer the service gives before any key exists on its side. `relic_read_comments` reads the current
version's comments by default, takes an explicit version or `'*'` for every
version, and each comment names the version it was made on, so remarks left
on content a republish removed do not read as if they were about what is
latest now.

```bash
npx -y relic-mcp@latest   # nothing to clone, nothing to build
```

### Any harness, one command

The npm package installs itself. It knows where each harness keeps its config,
merges into what is already there, and backs the file up first.

```bash
npx -y relic-mcp@latest install                 # what is installed on this machine
npx -y relic-mcp@latest install --client cursor # add it there
```

| `--client` | Writes |
|---|---|
| `claude-code` | installs as a plugin, skill included |
| `claude-desktop` | `claude_desktop_config.json` |
| `cursor` | `.cursor/mcp.json` |
| `windsurf` | `.codeium/windsurf/mcp_config.json` |
| `gemini` | `.gemini/settings.json` |
| `vscode` | VS Code's `mcp.json` |
| `codex` | `.codex/config.toml` |

Useful flags: `--origin <url>` for your own deployment, `--dry-run` to see what
would change, `--print` to write nothing and print the config to paste (which
is also the answer for any harness not in that table), and `--force` to replace
an entry that is already there.

Nothing is overwritten silently. An existing server of the same name refuses
until you pass `--force`, an unparseable config refuses rather than replacing
it, and any file that already existed is copied to `<file>.relic-backup` before
the write.

### Claude Code, as a plugin

The plugin is the packaged version: it wires the server, points at the hosted
service, and adds a skill telling the agent when publishing is the right move
and what to disclose when it hands over a link.

`npx -y relic-mcp@latest install --client claude-code` does this for you. By hand, from
the repo:

```bash
claude plugin marketplace add TheBushidoCollective/relic
claude plugin install relic@relic
```

or from the installed package, with no clone and no network:

```bash
npm i -g relic-mcp
claude plugin marketplace add "$(npm root -g)/relic-mcp"
claude plugin install relic@relic
```

Both install the same directory. The npm package **is** the plugin: the
manifests are generated from `package.json` at build time and ship in the
tarball, so the version can never disagree with itself.

### Claude Code, server only

```bash
claude mcp add relic -- npx -y relic-mcp@latest
```

No clone and no build step. `npx` fetches on first use and caches. It
publishes to the hosted service at `https://relik.link`; to publish to your
own, see [Publishing to your own service](#publishing-to-your-own-service).

Then ask your agent to publish something: *"publish ./report.md as a relic."*

### Any client that takes a JSON config

Claude Desktop, Cursor, Windsurf, Cline, and most others read a variant of
this. The key names differ; the shape does not.

```json
{
  "mcpServers": {
    "relic": {
      "command": "npx",
      "args": ["-y", "relic-mcp@latest"]
    }
  }
}
```

### Publishing to your own service

Everything above publishes to the hosted service. Point the client at a
deployment of your own with `RELIC_SERVICE_ORIGIN`:

```bash
claude mcp add relic \
  --env RELIC_SERVICE_ORIGIN=https://relic.your-domain.example \
  -- npx -y relic-mcp@latest
```

The variable is validated, not merely read: it has to be `https`, or a
loopback host for development, because the grant that authorizes an upload
travels over it even though the plaintext never does.

**A self-hosted deployment serves this instruction itself.** Its own
`/install` page carries the variable and the hosted one does not, from a
single constant, so the two cannot drift into a page that tells a reader to
configure the host they are already on.

Leaving it unset publishes to the hosted service, which is why
`relic_publish` returns the URL it created and `relic_describe_client` names
the origin it is pointed at. If you self-host and forget the variable, the
destination is visible in the answer rather than buried in a config file.

### Over HTTP instead of stdio

```bash
RELIC_MCP_HTTP=1 npx -y relic-mcp@latest
# -> http://127.0.0.1:7333/mcp
```

Useful when several agents on one machine should share a single process, or
when it runs under a supervisor. Loopback by default: this process can read
any file its user can, so binding it to a network interface hands that reach
to the network. `RELIC_MCP_ALLOWED_ORIGINS` is a comma-separated allowlist for
browser callers, and an origin outside it is refused to defeat DNS rebinding.

### Environment

| Variable | Meaning |
|---|---|
| `RELIC_SERVICE_ORIGIN` | The Relic service to publish to. Unset means the hosted service, `https://relik.link`. |
| `RELIC_ORIGIN` | Origin used to build the shareable URL. Defaults to the service origin. |
| `RELIC_CLIENT_NAME` | Reported to the service as the publishing client. |
| `RELIC_MCP_HTTP` | `1` to serve Streamable HTTP instead of stdio. |
| `RELIC_MCP_PORT`, `RELIC_MCP_HOST` | HTTP bind. Defaults to `127.0.0.1:7333`. |
| `RELIC_MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` allowlist for HTTP. |

## Protocol

Pinned to revision **`2026-07-28`**, the revision that made the MCP core
stateless. There is no `initialize` handshake, no session, and no
`Mcp-Session-Id`: every request declares its own version in `_meta`, and the
server accepts or rejects each one independently.

Relic holds nothing between calls, so the server can be restarted,
round-robined behind a load balancer, or run one-shot without a client
noticing. `server/discover` is implemented, as the revision requires.

The handshake-based revisions (`2025-11-25` and earlier) are still answered,
which the spec calls a dual-era server. A client that only speaks the newest
revision is unusable in most of the agents this product exists to serve.

On HTTP the mirrored routing headers are enforced rather than merely accepted:
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` must agree with the body,
and a mismatch is refused with `-32020`. That check exists because a gateway
routing on the header while the server executes on the body is a split-brain
with security consequences, not a cosmetic inconsistency.

### It runs locally, and you can read it

Something has to run on your machine, because encryption has to happen where
the plaintext is. That is forced by the product, not chosen.

What is chosen is that it arrives as **readable source rather than a compiled
binary**. `dist/relic-mcp.js` is a single unminified file of about 1,100 lines,
and it is exactly what executes. The cover rendering page assets in
`dist/cover/` contain the unminified cover bundle built from `@relic/viewer`,
with vendored React, pdfjs, and sucrase for local document rendering in
headless Chrome. The TypeScript it was built from ships in the same package.
Releases carry [npm provenance][provenance], which is a cryptographic
attestation binding the published tarball to a specific commit and workflow
in this repository.

There is also a `relic_describe_client` tool. Call it and the client tells you
what it does with your file, what leaves the machine, and what the service can
see, without reading a byte or sending a request. Inspection decoupled from
execution, which is strictly better than inspecting code that is about to run.
The cover is plaintext pixels of the first screen, stored server-side and
served to anyone holding the link without its fragment, including unfurl
services and their caches; `cover: false` declines; republishing with it
clears; takedown deletes it.

[provenance]: https://docs.npmjs.com/generating-provenance-statements

### Why this is not a hosted MCP server

It is the question everybody asks, so: a remote server would have to receive
your file in order to encrypt it, which destroys the product. Zero-knowledge
is not a feature layered on top, it is a consequence of the encryption
happening on the machine that already holds the plaintext. The transport can
be stdio or HTTP; the process runs next to the file either way.

The tempting variant is a remote server that returns a script for the agent to
run, so the plaintext still never leaves. That trades a confidentiality
property for remote code execution: whoever controls the server, or one
response, runs arbitrary code on every user's machine on every publish.
CVE-2025-6514 scored 9.6 for the accidental version of that shape. The claim
would also degrade from "we never receive your bytes" to "trust the script we
sent this time", re-decided per call and unauditable in practice.

## Where the decisions live

`docs/` holds the design, and it is the source of truth rather than a summary
written afterwards.

- `docs/frame.md` and `docs/preconditions.md` are locked. Anything downstream
  contradicting them is drift and routes back rather than getting absorbed.
- `docs/spec/` fixes the format, the publish contract, the service surface,
  and the viewer.
- `docs/decisions.md` makes the thirteen picks those documents deliberately
  routed forward, each citing the rule that constrains it. No constant in the
  code is unaccounted for.

## Not done

These are launch obligations, and nothing here claims them:

- The two registrable domains, and Search Console verification on both. The
  build runs against placeholder names.
- The pre-launch empirical test of what enterprise mail security does to a URL
  fragment. Until it runs, the disclosure statement stays correct under all
  three possible outcomes rather than asserting one.
- The named abuse-response human and their named backup.
- A deploy pipeline. Deploys run in CI, never from a workstation.
