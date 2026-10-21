# relic-mcp

Publish a file as an encrypted relic and get back a shareable link. The
encryption key is generated on your machine and is never sent to the service.

```bash
claude mcp add relic -- npx -y relic-mcp@latest
```

Then: *"publish ./report.md as a relic."*

For any client that takes a JSON config:

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

## What it does with your file

1. Reads it from disk, in this process. It is never sent anywhere in plaintext.
   A standard OpenTimelineIO directory (`.otiod`) is automatically packaged into
   a deterministic standard `.otioz` archive; arbitrary directories are refused.
2. Draws a 128-bit key and a 26-character relic id independently from your
   machine's CSPRNG. Neither derives from the other.
3. Encrypts locally with AES-128-GCM under RFC 8188 `aes128gcm` framing.
4. Uploads **only ciphertext**, straight to object storage under a signed URL.
   It does not pass through the Relic service.
5. Tells the service four things: a coarse renderer class from a ten-value
   list (`markdown`, `code`, `html`, `jsx`, `image`, `pdf`, `media`, `archive`,
   `binary`, `otio`), this client's name, the ciphertext's byte length, and the
   title, which defaults to the filename and is stored in the clear. By default,
   it also renders a 1200x630 cover image of the file's first screen in local
   headless Chrome and uploads it unencrypted via `POST /api/relics/{id}/cover`
   for link preview cards (pass `cover: false` to decline). OpenTimelineIO
   timeline relics (`otio`) skip unencrypted first-screen media rendering by
   default, using a generic card carrying the title and format label to protect
   private timeline cuts and media from leaking into unencrypted link previews.
   Not the mimetype, not the contents.
6. Records the relic's id, key, and publish token locally, in a 0600 file
   under your user config directory, so the relic can be republished from
   this machine later. See [Republishing](#republishing). Preserves logical
   source identity for `.otiod` directories as the original directory path so
   republishing detects the source across sessions. The service never receives
   the key or the token plaintext; it keeps only a SHA-256 of the token.
7. Returns a shareable URL whose fragment holds the decryption key. Fragments
   are never sent to a server by a browser.
Call the `relic_describe_client` tool and it will tell you all of this itself,
without reading a file or making a request.

## What it does not protect against

The tool returns the full URL, and the key lives in that URL's fragment,
because handing you a usable link is the point. **So the key enters your
model's context and your session transcript on every publish.** Zero-knowledge
holds against the Relic operator. It does not hold against your model provider
or whoever stores your transcripts. That is structural, not a defect awaiting
a fix. The cover is plaintext pixels of the first screen, stored server-side
and served to anyone holding the link without its fragment, including unfurl
services and their caches; `cover: false` declines; republishing with it clears;
takedown deletes it.

## Republishing

`relic_republish` publishes a new version of a relic this machine originally
published: same id, same key, **same share URL**. Everyone holding the
existing link sees the new content; there is no new link to hand out.

```json
{
  "name": "relic_republish",
  "arguments": { "relic_id": "0a2c...", "path": "./report-v2.md" }
}
```

It takes `relic_id` (the 26-character id the original publish returned) and
`path`, plus optional `filename` and `title` overrides and an optional
`ttl_days` that is forwarded on the request. Versions count from 1:
`relic_publish` reports
version 1, each republish reports the next number, and the URL never changes
across them. A relic's lifetime is fixed at its first publish and carries
across versions.

Republishing needs the relic's key and its publish token, so the first
`relic_publish` records both in a local state file:
`$XDG_CONFIG_HOME/relic-mcp/publish-state.json` by default
(`~/.config/relic-mcp/publish-state.json` when `XDG_CONFIG_HOME` is unset),
created `0600` inside a `0700` directory, and redirectable with
`RELIC_PUBLISH_STATE`. Consequences worth stating plainly:

- **Only that machine can republish.** Anywhere else, the tool refuses: the
  relic was published from another machine and cannot be republished here.
  Copying the state file to another machine moves the ability with it.
- **The file holds the key and the token.** They are never printed, logged,
  or returned by any tool result. The service stores only a SHA-256 of the
  token, so it cannot reconstruct either one.
- **Losing the file changes nothing for existing links**; it only ends that
  machine's ability to update those relics.
- **A takedown is permanent.** A removed relic answers `relic_removed`
  (HTTP 410) forever, whatever token is presented, and republishing cannot
  revive it. Publish the content as a new relic instead. A rejected token is
  its own refusal (`invalid_publish_token`, HTTP 403): the local record no
  longer matches the service's, and the relic cannot be republished from
  this machine, though it can still be read.

## Comments

People can comment on a relic, and comments are the only channel back: there
is no reply-to and no dashboard. `relic_read_comments` reads them, oldest
first, decrypting on this machine.

```json
{
  "name": "relic_read_comments",
  "arguments": { "relic_id": "0a2c..." }
}
```

`relic_comment` writes one, encrypted here before it leaves:

```json
{
  "name": "relic_comment",
  "arguments": { "relic_id": "0a2c...", "body": "Fixed the chart." }
}
```

Both take the relic id and refuse a share URL, because the URL carries the key
in its fragment and passing it would put the key in your transcript again for
nothing. Both work only on the machine that published the relic: the comment
key is derived from that relic's key with a distinct HKDF label, and the key
lives in the same local state file as the publish token.

A human commenter verifies an email address through a magic link, and that
address is their identity. This client has no mailbox, so its comments are
authorized by the publish token and attributed as `publisher`; an optional
`display_name` labels them and never replaces the attribution. A comment that
does not decrypt is returned marked unreadable with a count, never dropped,
because a quietly shortened list reads as agreement.

What the service holds is comment ciphertext it cannot read. What it learns is
who commented on which relic and when, which for a human commenter is a
verified email address. The content stays private; the participation does not.

## Why it runs locally

Encryption has to happen where the plaintext is, so a hosted version of this
would have to receive your file, which defeats the point. Nothing here is
fetched from the network and executed.

The client ships its JavaScript as readable source: `dist/relic-mcp.js` is a
single unminified file and the TypeScript it was built from is in the same
package. There is one narrow exception for automatic `.otiod` directory
packaging. It uses a source-included Node-API secure-open helper, prebuilt in
the npm tarball for macOS arm64 and x64 with a 15.0 binary deployment floor,
plus glibc 2.28 or newer Linux on arm64 and x64. On either platform, before it
reads a bundle, the helper verifies on the running kernel that beneath-root
resolution refuses parent and absolute escapes from a held directory and that
the no-symlink flag is accepted. Symlink refusal, held-descriptor behavior, and
replacement behavior are verified by the CI probe on the listed versions. It
never downloads a helper, invokes Python, or compiles at install or publish
time. A missing packaged target or failed capability check refuses `.otiod`
packaging rather than using a pathname fallback. Ordinary file publishing
remains plain Node 18 or newer. The cover
rendering page assets in `dist/cover/` contain the
unminified cover bundle built from `@relic/viewer`, with vendored React, pdfjs,
and sucrase for offline document rendering in local Chrome. Releases carry npm
provenance, a cryptographic attestation binding the tarball to a specific commit
and workflow.

### Cover rendering and local Chrome requirement

By default, publishing or republishing renders a 1200x630 cover image in an
installed headless browser (Google Chrome, Chromium, or Microsoft Edge) over
Chrome DevTools Protocol (CDP) pipes. No browser is downloaded by this package.
If no browser is installed or if `RELIC_CHROME_PATH=none`, publishing still
succeeds and reports the cover as skipped with the reason, falling back to
Relic's generic preview card.

The cover renderer bundle lives in `dist/cover/`, served to Chrome over a
virtual origin (`https://cover.relic.invalid`) with strict network containment
flags (`--host-resolver-rules=MAP * ~NOTFOUND`,
`--proxy-server=http://proxy.relic.invalid:1`,
`--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--disable-quic`) so no
relic plaintext leaves the machine during rendering.

## Tools

| Tool | Input | Notes |
|---|---|---|
| `relic_publish` | `path`, optional `filename`, `title`, `cover`, `ttl_days` | A filesystem path. Inline content is deliberately not accepted, so the plaintext never joins the key in your transcript. A relic carries a plaintext title defaulting to the filename and stored by the service in the clear for link previews; pass `""` to publish without one. By default, renders a 1200x630 cover image of the first screen in local headless Chrome and uploads it unencrypted for link preview cards; pass `cover: false` to decline. A relic is kept until it is deleted; `ttl_days` (an integer, 1 to 3650) gives it a lifetime. Reports the relic as version 1. |
| `relic_lookup_source` | `path` | Reads local state to find whether this machine already published that file, and returns the exact `relic_republish` call. Calls no server. |
| `relic_list` | optional `limit`, `include_expired`, `verify`, `refresh` | Every relic this machine published, newest first. The only tool that enumerates: lookup answers only from the file a relic came from. A name this machine never recorded is recovered by decrypting the relic's own envelope in one 64 KB range request, or comes back `null` with the reason. A relic the service will not serve is listed with which of removed, expired, exhausted, or unreachable it is. Each row carries the share URL, fragment included, so each row is a credential. Reaching the service spends one of a relic's finite opens; recovered names are cached, so a repeat listing spends none. |
| `relic_show` | `relic_id`, optional `include_content` | One relic in detail, including how many versions the service holds against how many this machine recorded, and with `include_content` the current decrypted content. Read it before republishing anything you did not just write: republish replaces what the link serves, so without the read-back the edit is blind. Content that is not valid UTF-8 is reported as size and type rather than mangled text. |
| `relic_republish` | `relic_id`, `path`, optional `filename`, `title`, `cover`, `ttl_days`, `addresses`, `notify` | Publishes a new version under the same key, so the share URL is unchanged. Replaces the plaintext title (defaults to the new filename; pass `""` to remove it). Replaces the cover image with a newly rendered cover, or clears it if `cover: false` is passed. Sends a change notice email to everyone following the relic unless `notify: false` is passed. At most one email per person per relic per 10 minutes is sent, and one stop link stops every email about that relic. Works only on the machine holding that relic's key and publish token; a taken-down relic can never be revived. |
| `relic_share` | `relic_id`, `emails` | Send a relic this machine published to named people. Registers up to 20 email addresses with the service for change and comment notices, and returns a composed share email and mailto link to draft in the sharer's own mailbox. Addresses are stored in the clear by the service, linked to the relic id. A new comment emails everyone on the list except the author, naming the commenter's address (or 'The publisher'). At most one email per person per relic per 10 minutes, and one stop link stops every email about that relic. Relic never sends the share email. Readers holding the link can also share from the viewer once this client version has published or republished the relic. |
| `relic_read_comments` | `relic_id` | Returns the relic's comments oldest first, decrypted locally, with the author and a count of any that would not decrypt. Works only on the machine that published. |
| `relic_comment` | `relic_id`, `body`, optional `display_name` | Leaves a comment, encrypted on this machine, authorized by the publish token and attributed as `publisher`. Warning: posting emails everyone following the relic, naming 'The publisher'. At most one email per person per relic per 10 minutes, and one stop link stops every email about that relic. Body caps at 4096 bytes of UTF-8. |
| `relic_describe_client` | none | Explains the encryption path. Reads nothing, sends nothing. |

## Environment

| Variable | Meaning |
|---|---|
| `RELIC_SERVICE_ORIGIN` | The Relic service to publish to. Unset means the hosted service, `https://relik.link`. Set it to publish to your own. |
| `RELIC_ORIGIN` | Origin used to build the shareable URL. Defaults to the above. |
| `RELIC_CLIENT_NAME` | Reported to the service as the publishing client. |
| `RELIC_PUBLISH_STATE` | Where the publish state file lives. Defaults to `$XDG_CONFIG_HOME/relic-mcp/publish-state.json`, or `~/.config/relic-mcp/publish-state.json`. |
| `RELIC_METADATA_CACHE` | Where recovered filenames are cached. Defaults to `metadata-cache.json` beside the publish state. Holds no key and no token; deleting it costs one round of recovery. |
| `RELIC_MCP_HTTP` | `1` to serve Streamable HTTP instead of stdio. |
| `RELIC_MCP_PORT`, `RELIC_MCP_HOST` | HTTP bind. Defaults to `127.0.0.1:7333`. |
| `RELIC_MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` allowlist for HTTP. |
| `RELIC_CHROME_PATH` | Explicit path to Chrome, Chromium, or Edge binary for cover rendering. Set to `none` or `disabled` to skip covers. |
| `RELIC_FFMPEG_PATH` | Path to ffmpeg binary for generating video frame and audio waveform/artwork cover images. |

## Protocol

MCP revision `2026-07-28`, the stateless one: no handshake, no session, no
`Mcp-Session-Id`. No protocol state is retained between calls; the one thing
that does outlive a call is the per-machine publish state file described
above. The handshake-based revisions (`2025-11-25` and earlier) are still
answered.

Requires Node 18 or newer. Automatic `.otiod` packaging additionally requires
one of four packaged targets: macOS arm64 or x64 with a 15.0 binary deployment
floor, or Linux glibc 2.28+ arm64 or x64. On either platform, before it reads
a bundle, the helper verifies on the running kernel that beneath-root
resolution refuses parent and absolute escapes from a held directory and that
the no-symlink flag is accepted. Symlink refusal, held-descriptor behavior, and
replacement behavior are verified by the CI probe on the listed versions. A
target or kernel that cannot satisfy that requirement refuses directory
conversion without reducing ordinary file publishing.

Tested on macOS: CI native probes in dry run `39652819003` on macOS 15.7.9
(`24G830`), Darwin 24.6.0 (`xnu-11417.140.69.711.44~1`) on arm64 and x64, with
Xcode 26.0.1 and SDK 26.0 plus Xcode 16.4 and SDK 15.5; local macOS 27.0.1
(`26A434`), Darwin 27.0.0 arm64, Homebrew clang 22.1.8, and SDK 27. An earlier
historical local probe used Xcode clang 21.0.0 and SDK 27.

MIT licensed. Source: https://github.com/TheBushidoCollective/relic
