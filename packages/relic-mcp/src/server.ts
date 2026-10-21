/**
 * The MCP server: a local binary, never a remote surface.
 *
 * It holds the key and encrypts in process. It returns no script. That is
 * locked in `docs/frame.md` and it is the single most load-bearing structural
 * decision in the publish path.
 *
 * **Why this cannot be a hosted MCP server**, stated once because it is the
 * question everybody asks: a remote server would have to receive the file to
 * encrypt it, which destroys the product. Zero-knowledge is not a feature
 * layered on top; it is a consequence of the encryption happening on the
 * machine that already has the plaintext. The transport can be stdio or HTTP,
 * but the process runs next to the file either way.
 *
 * Protocol revision `2026-07-28`, which is stateless: no handshake, no
 * session, no `Mcp-Session-Id`. Nothing is retained between calls, so the
 * server can be restarted or run one-shot without a client noticing. The
 * legacy `initialize` handshake is answered too, which the spec calls a
 * dual-era server, because a client that only speaks the newest revision is
 * unusable in most of the agents this product exists to serve.
 */

import type { CoverKind, CoverReport } from '@relic/format/cover';
import { MNEMONIC_WORDS } from '@relic/format/mnemonic';
import {
  type CommentAnchorInput,
  type CommentRecord,
  type CommentsSummary,
  describeAnchor,
  editComment,
  formatTimecode,
  postComment,
  readComments,
  resolveComment,
} from './comments.ts';
import {
  type ListResult,
  listRelics,
  MAX_INLINE_CONTENT_BYTES,
  type RelicRow,
  type ShowResult,
  showRelic,
} from './inventory.ts';
import {
  ERROR_CODES,
  errorResponse,
  isSupportedVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  requestedProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  unsupportedVersionError,
} from './protocol.ts';
import {
  lookupPublishedSource,
  type PublishDeps,
  PublishError,
  publish,
  republishToolCall,
  ServerRefusal,
} from './publish.ts';
import { type RepublishAddressEntry, republish } from './republish.ts';
import { shareRelic } from './share.ts';

export type { JsonRpcRequest, JsonRpcResponse };
export {
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
};

/**
 * `relic_publish`, prefixed with the product name.
 *
 * The MCP spec names the hazard and its own remedy: clients aggregating tools
 * from multiple servers may hit collisions and should prefix tool names with a
 * server identifier. A bare `publish` collides with incumbent publishing
 * servers, and the consequence is a security outcome produced by a naming
 * decision: the model asks for `publish`, the client disambiguates to whichever
 * server it prefers, and the file lands somewhere with different encryption or
 * none.
 */
export const TOOL_NAME = 'relic_publish';

/**
 * The inspection tool.
 *
 * A local client is opaque to the agent driving it, and "trust the binary" is
 * a real hand-wave. This closes that gap without reopening the one the frame
 * locked: the agent can read exactly what the encryption path does, on
 * demand, without any of it being code that arrives ready to execute.
 *
 * Inspection decoupled from execution beats inspect-then-run, because the
 * reviewer is not under time pressure and the reviewed text cannot also be
 * the attack.
 */
export const DESCRIBE_TOOL_NAME = 'relic_describe_client';

/**
 * The republish tool: a new version of a relic this machine published.
 *
 * A separate tool rather than an argument on publish, because the two calls
 * hold different secrets and different failure modes. Publish mints an id
 * and a key; republish consumes ones recorded locally, and refusing when
 * they are absent is the machine boundary made visible. Folding it into
 * publish would turn "published from another machine" into a retry loop
 * that can never succeed.
 */
export const REPUBLISH_TOOL_NAME = 'relic_republish';

/**
 * The share tool: send a relic this machine published to named people.
 */
export const SHARE_TOOL_NAME = 'relic_share';

/**
 * Source lookup is a separate read-only tool.
 *
 * An agent needs the id before it chooses publish or republish, and a lookup
 * hidden inside either write tool would only be observable after choosing the
 * wrong one. This call reads local state and never contacts the service.
 */
export const LOOKUP_TOOL_NAME = 'relic_lookup_source';

/**
 * The inventory tools, and why enumeration had to be its own surface.
 *
 * `relic_lookup_source` answers "did I publish this file", which is only
 * askable by somebody holding the file. Every other question a publisher has
 * later starts from nothing: what have I published, what does that link hold
 * now, is it still alive. On the file that prompted these, the source index
 * named four of forty one relics, so thirty seven had a key and a publish
 * token on disk and no tool that could say their names.
 *
 * Two tools rather than one because they cost differently. The list walks
 * every relic and prefers the unmetered check; the show reaches into one
 * relic and decrypts it, which is what turns a blind republish into an edit.
 * Folding them together would make a listing pay a read's price per row.
 */
export const LIST_TOOL_NAME = 'relic_list';

export const SHOW_TOOL_NAME = 'relic_show';

/**
 * Said on both inventory tools, because a row is not a description of a
 * relic: it is a working key to it.
 */
const SHARE_URL_DISCLOSURE =
  'Every row carries the relic\u2019s share URL including its fragment, and ' +
  'the fragment is the decryption key, so each row is a credential that ' +
  'opens the file for anyone who reads it, this transcript included.';

/**
 * Disclosure for the key phrase / mnemonic wherever it is returned.
 * The phrase is the key in spoken word form.
 */
export const KEY_PHRASE_DISCLOSURE =
  'The key phrase is the decryption key: it opens the relic for anyone who hears or reads it, this transcript included.';

/**
 * The cost of asking the service, stated on the tools that spend it.
 *
 * A publisher who does not know a listing spends opens cannot choose not to,
 * and the cap is not refillable.
 */
const OPEN_COST_DISCLOSURE =
  'Reaching the service for a relic spends one of its finite opens, which ' +
  'never come back. Names recovered by decrypting are cached locally, so a ' +
  'repeat listing spends none.';

/**
 * The comment tools, and why they are two rather than one.
 *
 * Reading is the half that makes comments worth having for an agent: a person
 * leaves a comment, the agent reads it back, and it acts on it. Writing is
 * the half that lets the agent answer. They are separated for the same reason
 * lookup is separate from republish: the read needs no credential and the
 * write spends the publish token, so folding them together would make an
 * agent that only wants to read present a write credential to find out.
 *
 * Both take a relic id, never the share URL. The fragment is the key.
 */
export const READ_COMMENTS_TOOL_NAME = 'relic_read_comments';

export const COMMENT_TOOL_NAME = 'relic_comment';

export const EDIT_COMMENT_TOOL_NAME = 'relic_edit_comment';

export const RESOLVE_COMMENT_TOOL_NAME = 'relic_resolve_comment';

/**
 * The one sentence about comments an agent has to have before it reads any,
 * carried on both comment tools and in the handshake instructions the way the
 * version-history disclosure is.
 */
const COMMENT_MACHINE_BOUNDARY =
  'Only works for a relic this machine published: the comment key is derived ' +
  "from that relic's key, which lives in local publish state and nowhere the " +
  'service can reach.';

/**
 * The ceiling on a publisher-supplied lifetime, matching the grant
 * contract's `maxTtlDays`. Refusing here keeps a typo like 36500 from
 * encrypting the file and round-tripping a grant only to be turned down
 * after the work is done.
 */
const MAX_TTL_DAYS = 3650;

const VERSION_HISTORY_DISCLOSURE =
  "Anyone holding a relic's link can fetch every version it has ever held, " +
  'so republishing does not withdraw earlier content.';
export const REPUBLISH_DISCIPLINE_DISCLOSURE =
  ' A version whose content, name and title are identical to the one already ' +
  'live is refused locally, before any request: it would tell recipients to ' +
  'look again at what they are already reading. Change the file rather than ' +
  'retrying.' +
  " Before publishing, it reads the relic's comments, on every version, and " +
  'refuses if any are unanswered. Clear open comments either by replying with ' +
  '`relic_comment`, by resolving them with `relic_resolve_comment`, or by ' +
  'passing `addresses: [{ comment_id, note }]` here to acknowledge them ' +
  'in the new version. A resolved comment counts as handled. Unreadable ' +
  'comments block republishing. This is workflow ' +
  'discipline in the client, not a boundary: the machine holding the publish ' +
  'token can call the HTTP API directly, and the service cannot enforce this ' +
  'because it cannot read comments.';

export const COVER_PHRASE: Readonly<Record<CoverKind, string>> = {
  markdown: 'the top of the rendered document',
  code: 'the first lines of the file',
  html: 'the top of the rendered page',
  jsx: 'the top of the rendered component',
  image: 'the image, cropped to fit',
  pdf: 'the top of the first page',
  video: 'a frame from the opening seconds of this video',
  'audio-artwork': 'the artwork embedded in this audio file',
  'audio-waveform': 'the waveform of the audio',
  archive: 'the list of files inside',
};

export function formatCoverText(cover: CoverReport): string {
  if (cover.status === 'uploaded') {
    return (
      `Cover image: uploaded. Link previews now show ${COVER_PHRASE[cover.kind]}. ` +
      'It is NOT encrypted: the service and anyone holding the link, even without the key, can see it. ' +
      'Republish with cover: false to remove it.'
    );
  }
  if (cover.status === 'declined') {
    return 'Cover image: none, as asked. Link previews show the generic Relic card.';
  }
  return `Cover image: none. ${cover.detail} Link previews show the generic Relic card.`;
}

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: 'Publish a relic',
  description:
    'Encrypt a file on this machine and publish it as a new relic, returning ' +
    'a shareable URL. Publishing an update this way costs a second URL that ' +
    'nobody holding the first one will ever see; use relic_republish instead ' +
    'so the existing URL keeps working. ' +
    VERSION_HISTORY_DISCLOSURE +
    ' The encryption key is generated locally and never sent to the service. ' +
    'The relic carries a plaintext title, which defaults to the filename and ' +
    'is NOT encrypted: the service stores it and every link preview shows ' +
    'it. Pass an empty string to publish without one. ' +
    'By default a picture of the first screen is rendered locally and ' +
    'uploaded unencrypted for link previews; pass cover: false to withhold ' +
    'it. An .otiod directory is packaged into a standard .otioz archive ' +
    '(content.otio, version.txt 1.0.0, and only referenced media under media/) ' +
    'on packaged targets: macOS arm64 or x64 with a 15.0 binary deployment ' +
    'floor, or Linux glibc 2.28+ arm64 or x64. Before it reads a bundle on ' +
    'either platform, the helper verifies on the running kernel that ' +
    'beneath-root resolution refuses parent and absolute escapes from a held ' +
    'directory and that the no-symlink flag is accepted. Symlink refusal, ' +
    'held-descriptor behavior, and replacement behavior are verified by the CI ' +
    'probe on the listed versions. A target or kernel that cannot satisfy that ' +
    'requirement refuses it rather than using a pathname fallback. A raw .otio ' +
    'file or an existing .otioz archive is published ' +
    'as given. OTIO covers use only the public title and format label; media ' +
    'frames stay out of the unencrypted preview. Takes a filesystem path, never ' +
    'inline content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Filesystem path to a file or, on a supported packaged native target, an .otiod bundle directory.',
      },
      filename: {
        type: 'string',
        description:
          'Optional. Overrides the name written into the encrypted envelope ' +
          'header. Defaults to the basename of `path`.',
      },
      title: {
        type: 'string',
        description:
          'Optional. A plaintext title for the relic, shown in link previews ' +
          'and in the browser tab. Defaults to the filename. NOT encrypted: ' +
          'the service stores it and anyone who fetches the link sees it, ' +
          'with or without the key. Pass "" to publish without a title.',
      },
      ttl_days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TTL_DAYS,
        description:
          'Optional. Gives the relic a lifetime in days. Omit it and the ' +
          'relic is kept until it is deleted. Shorter is better for ' +
          'sensitive content.',
      },
      force_new: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Publish a deliberately separate relic even when this ' +
          'machine already published the same source. Defaults to false. Use ' +
          'only when you want two independent URLs for one file.',
      },
      cover: {
        type: 'boolean',
        default: true,
        description:
          'Optional. Render a picture of the first screen of the file on this machine and upload it for link previews. Defaults to true. NOT encrypted: the service stores it and anyone who fetches the link sees it, with or without the key. Pass false for anything you would not show in a chat preview.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      relic_id: { type: 'string' },
      version: {
        type: 'integer',
        minimum: 1,
        description: 'Always 1 from this tool; republish counts upward.',
      },
      relic_expires_at: { type: ['string', 'null'] },
      renderer_class: { type: 'string' },
      filename: { type: 'string' },
      title: { type: ['string', 'null'] },
      resolved_path: { type: 'string' },
      key_phrase: {
        type: 'string',
        description: `A ${MNEMONIC_WORDS}-word spoken phrase for the key. ${KEY_PHRASE_DISCLOSURE}`,
      },
      cover: {
        type: 'object',
        properties: {
          status: { enum: ['uploaded', 'declined', 'skipped'] },
          kind: { type: 'string' },
          type: { type: 'string' },
          url: { type: 'string' },
          bytes: { type: 'integer' },
          reason: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
    },
    required: [
      'url',
      'relic_id',
      'version',
      'relic_expires_at',
      'renderer_class',
      'filename',
      'title',
      'resolved_path',
      'report_url',
      'disclosure_url',
      'key_phrase',
      'cover',
    ],
    additionalProperties: false,
  },
} as const;

export const REPUBLISH_TOOL_DEFINITION = {
  name: REPUBLISH_TOOL_NAME,
  title: 'Republish a relic',
  description:
    'Publish a new version of a relic this machine originally published, ' +
    'encrypting under the same key so the existing share URL keeps working. ' +
    VERSION_HISTORY_DISCLOSURE +
    " Only possible from the machine that holds the relic's key and publish " +
    'token; a relic that was taken down can never be revived. ' +
    'By default a picture of the first screen is rendered locally and ' +
    'uploaded unencrypted for link previews; pass cover: false to withhold ' +
    'it. An .otiod directory is packaged into a standard .otioz archive ' +
    '(content.otio, version.txt 1.0.0, and only referenced media under media/) ' +
    'on packaged targets: macOS arm64 or x64 with a 15.0 binary deployment ' +
    'floor, or Linux glibc 2.28+ arm64 or x64. Before it reads a bundle on ' +
    'either platform, the helper verifies on the running kernel that ' +
    'beneath-root resolution refuses parent and absolute escapes from a held ' +
    'directory and that the no-symlink flag is accepted. Symlink refusal, ' +
    'held-descriptor behavior, and replacement behavior are verified by the CI ' +
    'probe on the listed versions. A target or kernel that cannot satisfy that ' +
    'requirement refuses it rather than using a pathname fallback. A raw .otio ' +
    'file or an existing .otioz archive is republished ' +
    'as given. OTIO covers use only the public title and format label; media ' +
    'frames stay out of the unencrypted preview.' +
    REPUBLISH_DISCIPLINE_DISCLOSURE +
    ' Each new version emails a change notice, naming the title and version and never the key, to each verified commenter and each address added with relic_share, minus any that stopped emails; pass notify: false to skip it. At most one email per person per relic per 10 minutes, and one stop link stops every email about that relic.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      path: {
        type: 'string',
        description:
          'Filesystem path to a file or, on a supported packaged native target, an .otiod bundle directory that becomes the new version.',
      },
      filename: {
        type: 'string',
        description:
          'Optional. Overrides the name written into the encrypted envelope ' +
          'header of the new version. Defaults to the basename of `path`.',
      },
      title: {
        type: 'string',
        description:
          "Optional. Replaces the relic's plaintext title. Defaults to " +
          'the new version\'s filename. Pass "" to remove the title.',
      },
      ttl_days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TTL_DAYS,
        description:
          'Optional. A lifetime in days, forwarded on the republish ' +
          "request. The service fixes a relic's lifetime at its first " +
          'publish, so treat this as reserved.',
      },
      addresses: {
        type: 'array',
        description:
          'Optional. Acknowledgement notes for open comments being addressed by this update. ' +
          'Each entry posts an acknowledgement comment stamped with the new version after it lands. ' +
          'Every open comment on the relic must be addressed either by an entry here or by a prior reply.',
        items: {
          type: 'object',
          properties: {
            comment_id: {
              type: 'string',
              description: 'The id of the open comment being addressed.',
            },
            note: {
              type: 'string',
              description:
                'Required explanation of what changed in this version to address the comment. ' +
                'Cannot be empty or whitespace-only.',
            },
          },
          required: ['comment_id', 'note'],
          additionalProperties: false,
        },
      },
      cover: {
        type: 'boolean',
        default: true,
        description:
          'Optional. Render a picture of the first screen of the file on this machine and upload it for link previews. Defaults to true. NOT encrypted: the service stores it and anyone who fetches the link sees it, with or without the key. Pass false for anything you would not show in a chat preview.',
      },
      notify: {
        type: 'boolean',
        default: true,
        description:
          'Optional. Email a change notice for this version to each verified address that commented on the relic and each address added with relic_share, except any that stopped those emails. Defaults to true. The notice names the title and version and never carries the key. At most one email per person per relic per 10 minutes, and one stop link stops every email about that relic. Pass false for a change not worth an email, such as a typo fix.',
      },
    },
    required: ['relic_id', 'path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      version: {
        type: 'integer',
        minimum: 2,
        description: 'The version just published.',
      },
      relic_expires_at: { type: ['string', 'null'] },
      renderer_class: { type: 'string' },
      filename: { type: 'string' },
      title: { type: ['string', 'null'] },
      resolved_path: { type: 'string' },
      key_phrase: {
        type: 'string',
        description: `A ${MNEMONIC_WORDS}-word spoken phrase for the key. ${KEY_PHRASE_DISCLOSURE}`,
      },
      cover: {
        type: 'object',
        properties: {
          status: { enum: ['uploaded', 'declined', 'skipped'] },
          kind: { type: 'string' },
          type: { type: 'string' },
          url: { type: 'string' },
          bytes: { type: 'integer' },
          reason: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      notify: {
        type: 'boolean',
        description: 'Whether a change notice was sent for this version.',
      },
    },
    required: [
      'relic_id',
      'version',
      'relic_expires_at',
      'renderer_class',
      'filename',
      'title',
      'resolved_path',
      'report_url',
      'disclosure_url',
      'key_phrase',
      'cover',
      'notify',
    ],
    additionalProperties: false,
  },
} as const;

export const SHARE_TOOL_DEFINITION = {
  name: SHARE_TOOL_NAME,
  title: 'Share a relic with people',
  description:
    'Send a relic this machine published to named people. Registers their email addresses with the service so each gets an email notice when someone comments and when you republish, and returns a ready share email carrying the full link, plus a mailto link that opens it as a draft. Relic never sends the share email, because it carries the key: draft it in the sharer\u2019s own mailbox, from their own address, and let them send it. The service stores the addresses in the clear, linked to the relic. A change notice names the title and version, never the key. A new comment emails everyone on the list except the author, naming the commenter\u2019s address (or "The publisher"). At most one email per person per relic per 10 minutes, and one stop link stops every email about that relic. Only works on the machine that published the relic: the link needs its key and registering needs its publish token. Takes the relic id, never the share URL. Up to 20 addresses per call and 50 per relic.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      emails: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 20,
        description:
          'Up to 20 email addresses to register for comment and change notices.',
      },
    },
    required: ['relic_id', 'emails'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      registered: {
        type: 'array',
        items: { type: 'string' },
        description: 'Normalized email addresses registered by the service.',
      },
      added: {
        type: 'integer',
        minimum: 0,
        description: 'Number of new email addresses added to the share list.',
      },
      shared_count: {
        type: 'integer',
        minimum: 0,
        description: 'Total number of shared addresses on this relic.',
      },
      share_limit: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum shared addresses allowed per relic.',
      },
      email: {
        type: 'object',
        properties: {
          to: {
            type: 'array',
            items: { type: 'string' },
          },
          subject: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['to', 'subject', 'text'],
        additionalProperties: false,
      },
      mailto_url: { type: 'string' },
    },
    required: [
      'relic_id',
      'registered',
      'added',
      'shared_count',
      'share_limit',
      'email',
      'mailto_url',
    ],
    additionalProperties: false,
  },
} as const;

export const LOOKUP_TOOL_DEFINITION = {
  name: LOOKUP_TOOL_NAME,
  title: 'Look up a published source',
  description:
    'Look up whether this machine already published a file or .otiod bundle ' +
    'directory and return the relic id needed by relic_republish. An .otiod ' +
    'directory is identified by its original path even after it was packaged ' +
    'as .otioz. Reads local publish state only and never calls the service.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Filesystem path to the file or .otiod bundle directory to look up.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      relic_id: { type: ['string', 'null'] },
      version: { type: ['integer', 'null'], minimum: 1 },
      resolved_path: { type: 'string' },
      source_identity: { type: 'string' },
      source_description: { type: 'string' },
      republish_call: {
        type: ['object', 'null'],
        properties: {
          name: { type: 'string', const: REPUBLISH_TOOL_NAME },
          arguments: {
            type: 'object',
            properties: {
              relic_id: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['relic_id', 'path'],
            additionalProperties: false,
          },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
    required: [
      'found',
      'relic_id',
      'version',
      'resolved_path',
      'source_identity',
      'source_description',
      'republish_call',
    ],
    additionalProperties: false,
  },
} as const;

export const LIST_TOOL_DEFINITION = {
  name: LIST_TOOL_NAME,
  title: 'List the relics this machine published',
  description:
    'List every relic this machine has published, newest first, with its ' +
    'name, version, lifetime, status, and share URL. This is the only tool ' +
    'that enumerates: relic_lookup_source finds a relic from the file it ' +
    'came from, so a relic whose source path is unrecorded or has moved is ' +
    'invisible to it while still being fully republishable from here. ' +
    'A relic\u2019s name lives inside its encrypted envelope, so a name this ' +
    'machine never wrote down is recovered by decrypting the relic rather ' +
    'than guessed; a name that could not be recovered comes back null with ' +
    'the reason, never invented. Nothing is dropped: a relic the service ' +
    'cannot serve is listed with what went wrong, because a short list would ' +
    'read as having published less. ' +
    SHARE_URL_DISCLOSURE +
    ' ' +
    OPEN_COST_DISCLOSURE,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional. Return at most this many of the newest relics. The ' +
          'total held locally is reported either way.',
      },
      include_expired: {
        type: 'boolean',
        default: true,
        description:
          'Optional, defaults to true. Set false to leave out relics the ' +
          'service reports expired. How many were left out is still ' +
          'reported, so they are never silently absent.',
      },
      verify: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Ask the service about every relic rather than only the ' +
          'ones needing a name recovered. Authoritative, and it spends one ' +
          'open per relic.',
      },
      refresh: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Re-read every name from the relics themselves, ignoring ' +
          'the local cache. Spends one open per relic.',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0 },
      total: {
        type: 'integer',
        minimum: 0,
        description: 'Relics in local state, before any limit or filter.',
      },
      truncated: { type: 'boolean' },
      excluded_expired: { type: 'integer', minimum: 0 },
      unreadable_entries: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Relic ids whose stored entry could not be read. Reported rather ' +
          'than skipped: each one is a relic this machine may no longer be ' +
          'able to republish.',
      },
      findable_by_source: {
        type: 'integer',
        minimum: 0,
        description:
          'How many of `total` relic_lookup_source can find. The gap is what ' +
          'this tool exists to close.',
      },
      recovered_filenames: { type: 'integer', minimum: 0 },
      opens_spent: {
        type: 'integer',
        minimum: 0,
        description:
          'Opens this call consumed against per-relic download caps. They do ' +
          'not come back.',
      },
      order: { type: 'string' },
      relics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            relic_id: { type: 'string' },
            version: {
              type: 'integer',
              minimum: 1,
              description: 'Versions this machine has published.',
            },
            filename: { type: ['string', 'null'] },
            filename_basis: {
              type: ['string', 'null'],
              enum: ['recorded', 'envelope', 'cache', null],
              description:
                'Where the name came from. `envelope` means it was recovered ' +
                'by decrypting the relic itself.',
            },
            filename_unrecovered_reason: { type: ['string', 'null'] },
            mimetype: { type: ['string', 'null'] },
            published_at: { type: ['string', 'null'] },
            expires_at: { type: ['string', 'null'] },
            expires_at_known: {
              type: 'boolean',
              description:
                'False means no lifetime was recorded or learned, so a null ' +
                'expires_at is unknown rather than "never expires".',
            },
            source: { type: ['string', 'null'] },
            source_indexed: {
              type: 'boolean',
              description: 'Whether relic_lookup_source can find this relic.',
            },
            share_url: { type: 'string' },
            status: { type: 'string' },
            status_basis: {
              type: 'string',
              enum: ['mint', 'record', 'local'],
              description:
                'Which check produced the status. `record` is the unmetered ' +
                'one: it proves the service still knows the relic, not that ' +
                'its bytes still serve.',
            },
            status_detail: { type: 'string' },
          },
          required: [
            'relic_id',
            'version',
            'filename',
            'filename_basis',
            'filename_unrecovered_reason',
            'mimetype',
            'published_at',
            'expires_at',
            'expires_at_known',
            'source',
            'source_indexed',
            'share_url',
            'status',
            'status_basis',
            'status_detail',
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      'count',
      'total',
      'truncated',
      'excluded_expired',
      'unreadable_entries',
      'findable_by_source',
      'recovered_filenames',
      'opens_spent',
      'order',
      'relics',
    ],
    additionalProperties: false,
  },
} as const;

export const SHOW_TOOL_DEFINITION = {
  name: SHOW_TOOL_NAME,
  title: 'Show one relic, including what it holds now',
  description:
    'Show one relic this machine published: its name, how many versions the ' +
    'service holds, whether it still serves, and with include_content the ' +
    'current decrypted content. Read the content before calling ' +
    'relic_republish on a relic you did not just write: republish replaces ' +
    'what the link serves outright, and without reading it first the edit is ' +
    'blind. ' +
    VERSION_HISTORY_DISCLOSURE +
    ' Takes the relic id from relic_list, never the share URL. ' +
    SHARE_URL_DISCLOSURE +
    ' Spends one of the relic\u2019s opens.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id, as relic_list reports it.',
      },
      include_content: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Fetch and decrypt the current version and return it as ' +
          'text. Content that is not valid UTF-8 comes back as its size and ' +
          'type instead, never as mangled text, and content over ' +
          `${MAX_INLINE_CONTENT_BYTES} bytes comes back as its size with no ` +
          'body, because a truncated one would read as the whole file and ' +
          'get republished as one.',
      },
    },
    required: ['relic_id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      version: {
        type: 'integer',
        minimum: 1,
        description: 'Versions this machine has published.',
      },
      versions: {
        type: ['integer', 'null'],
        minimum: 1,
        description:
          'Versions the service holds. Null when it could not be asked. A ' +
          'number above `version` means a republish reached the service and ' +
          'never made it into local state.',
      },
      filename: { type: ['string', 'null'] },
      filename_basis: {
        type: ['string', 'null'],
        enum: ['recorded', 'envelope', 'cache', null],
      },
      filename_unrecovered_reason: { type: ['string', 'null'] },
      mimetype: { type: ['string', 'null'] },
      renderer_class: { type: ['string', 'null'] },
      content_bytes: { type: ['integer', 'null'], minimum: 0 },
      content: { type: ['string', 'null'] },
      content_omitted_reason: { type: ['string', 'null'] },
      published_at: { type: ['string', 'null'] },
      expires_at: { type: ['string', 'null'] },
      expires_at_known: { type: 'boolean' },
      source: { type: ['string', 'null'] },
      key_phrase: {
        type: 'string',
        description: `A ${MNEMONIC_WORDS}-word spoken phrase for the key. ${KEY_PHRASE_DISCLOSURE}`,
      },
      status: { type: 'string' },
      status_basis: { type: 'string', enum: ['mint', 'record', 'local'] },
      status_detail: { type: 'string' },
      republish_call: {
        type: ['object', 'null'],
        description:
          'The call that replaces this content, when a source path was ' +
          'recorded. Null otherwise: any path would be a guess, and ' +
          'relic_republish takes the file to publish, not the old one.',
        properties: {
          name: { type: 'string', const: REPUBLISH_TOOL_NAME },
          arguments: {
            type: 'object',
            properties: {
              relic_id: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['relic_id', 'path'],
            additionalProperties: false,
          },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
    required: [
      'relic_id',
      'version',
      'versions',
      'filename',
      'filename_basis',
      'filename_unrecovered_reason',
      'mimetype',
      'renderer_class',
      'content_bytes',
      'content',
      'content_omitted_reason',
      'published_at',
      'expires_at',
      'expires_at_known',
      'source',
      'source_indexed',
      'share_url',
      'key_phrase',
      'status',
      'status_basis',
      'status_detail',
      'republish_call',
    ],
    additionalProperties: false,
  },
} as const;

export const READ_COMMENTS_TOOL_DEFINITION = {
  name: READ_COMMENTS_TOOL_NAME,
  title: "Read a relic's comments",
  description:
    'Read the comments people have left on a relic, oldest first, decrypted ' +
    'on this machine. Use it before changing content somebody was asked to ' +
    'review, and after sharing a link, because a comment is the only way a ' +
    'reader can answer back. ' +
    'Each comment reports which version it was made on, whether its text was ' +
    'edited after it was posted, whether it has been addressed, and whether it ' +
    'has been resolved, and a compact summary gives total, addressed, open, ' +
    'resolved, and unreadable counts. Its output is the input ' +
    'to `relic_republish`, which requires every open comment to be addressed or ' +
    'resolved before a new version can land. ' +
    'Each comment can be a remark on the relic as a whole or an exact mark: ' +
    'a text quote with surrounding context, a stage pin, an artifact region, ' +
    'a timestamp or span in audio or video, a page in a document, or an OTIO ' +
    'timeline point or range. ' +
    'Pass `version` to scope the thread: a version number returns the comments ' +
    'made on that version, `"*"` returns every comment on every version, and ' +
    'omitting it returns the comments on the relic\u2019s current version only. ' +
    'The current version is read from the service, which spends one of the ' +
    'relic\u2019s finite opens; pass `version` explicitly or `"*"` to read ' +
    'without spending it. Whatever the scope, `hidden_by_scope` counts the ' +
    'comments the scope did not return, so a scoped thread never reads as the ' +
    'whole one. ' +
    'Pass `resolve_anchors: true` to fetch and decrypt the relic content and ' +
    'resolve anchors against the actual content (source context runs for quotes, ' +
    'crops and annotated views for image regions, extracted video frames, and ' +
    'for OTIO the original revision\u2019s source intervals plus a separate ' +
    'current-revision projection). Historical OTIO comments are fetched by ' +
    'their service-stamped revision only after it matches the sealed anchor, ' +
    'and the decrypted original must match the sealed document digest. A ' +
    'mismatch is unresolvable and carries no artifact-derived context. ' +
    'This defaults to false because content resolution spends a signed download ' +
    'URL mint and download quota. ' +
    COMMENT_MACHINE_BOUNDARY +
    ' Takes the relic id, never the share URL: the URL carries the key in ' +
    'its fragment. A comment that will not decrypt is returned marked ' +
    'unreadable rather than dropped, so a shortened list never reads as ' +
    'agreement.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      version: {
        type: ['integer', 'string'],
        description:
          'Which versions to read: a version number for the comments made on ' +
          'that version, the literal "*" for every comment on every version, ' +
          'or omitted for the relic\u2019s current version only. Omitted reads ' +
          'the current version from the service, which spends one of the ' +
          'relic\u2019s finite opens.',
      },
      resolve_anchors: {
        type: 'boolean',
        description:
          'Whether to fetch and decrypt the relic to resolve anchors against the actual content ' +
          '(e.g. text quotes with surrounding source context, image region crops and annotated views, video frames). ' +
          'OTIO source context is returned only after its service-stamped comment revision and sealed document digest validate. ' +
          'Defaults to false because resolving content mints a signed download URL and fetches the ciphertext, ' +
          'which consumes download quota and bandwidth.',
      },
    },
    required: ['relic_id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      count: { type: 'integer', minimum: 0 },
      unreadable_count: {
        type: 'integer',
        minimum: 0,
        description:
          'How many of `count` did not decrypt. Above zero means part of the ' +
          'conversation is unread, not absent.',
      },
      version_scope: {
        type: ['integer', 'string'],
        description:
          'The scope this read returned: a version number, or "all" for ' +
          'every version.',
      },
      current_version: {
        type: ['integer', 'null'],
        description:
          'The relic\u2019s current version as the service reported it, read ' +
          'only when the default scope needed it. Null on an explicitly ' +
          'scoped read, because asking would spend another open for a fact ' +
          'the scope did not need.',
      },
      hidden_by_scope: {
        type: 'integer',
        minimum: 0,
        description:
          'How many comments exist that this scope did not return. Above ' +
          'zero means this thread is a scope, not the whole conversation.',
      },
      summary: {
        type: 'object',
        description: 'Compact counts of comment states on this relic.',
        properties: {
          total: { type: 'integer', minimum: 0 },
          addressed: { type: 'integer', minimum: 0 },
          open: { type: 'integer', minimum: 0 },
          resolved: { type: 'integer', minimum: 0 },
          unreadable: { type: 'integer', minimum: 0 },
        },
        required: ['total', 'addressed', 'open', 'resolved', 'unreadable'],
        additionalProperties: false,
      },
      comments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            comment_id: { type: 'string' },
            author: {
              type: 'string',
              description:
                'The commenter\u2019s verified email address, or "publisher" ' +
                'for a comment written with a publish token.',
            },
            created_at: { type: 'string' },
            display_name: { type: ['string', 'null'] },
            body: { type: ['string', 'null'] },
            version: {
              type: ['integer', 'null'],
              description:
                'The version this comment was made on, or null for a row ' +
                'that predates versioning.',
            },
            edited_at: {
              type: ['string', 'null'],
              description:
                'When the comment\u2019s text was replaced after it was ' +
                'posted, or null when it never was. There is no edit history: ' +
                'the earlier text is not on offer.',
            },
            anchor: {
              type: ['object', 'null'],
              description:
                'What the comment marks, or null for a remark about the whole relic. ' +
                'Can be a quote ({kind: "quote", exact, prefix?, suffix?}), ' +
                'legacy text ({kind: "text", quote}), ' +
                'stage pin ({kind: "pin", x, y}), ' +
                'artifact region ({kind: "region", rect: {x, y, w, h}}), ' +
                'media timestamp or span ({kind: "time", t, t_end?, rect?}), ' +
                'paged document page ({kind: "page", page, rect?, exact?}), ' +
                'OTIO point or range ({kind: "otio", v: 1, relic_version, document_sha256, timeline_id, track_id, range, snapshot}), ' +
                'or unsupported ({kind: "unsupported", declared}).',
              properties: {
                kind: {
                  type: 'string',
                  enum: [
                    'quote',
                    'text',
                    'pin',
                    'region',
                    'time',
                    'page',
                    'otio',
                    'unsupported',
                  ],
                },
                exact: { type: 'string' },
                quote: { type: 'string' },
                prefix: { type: 'string' },
                suffix: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                rect: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                  },
                  required: ['x', 'y', 'w', 'h'],
                },
                t: { type: 'number' },
                t_end: { type: 'number' },
                page: { type: 'integer' },
                declared: { type: 'string' },
              },
            },
            readable: { type: 'boolean' },
            unreadable_reason: { type: ['string', 'null'] },
            addresses: {
              type: ['string', 'null'],
              description:
                'The comment id this comment replies to or acknowledges, if any.',
            },
            addressed: {
              type: 'boolean',
              description:
                'Whether this comment has been addressed by a reply or update acknowledgement.',
            },
            addressed_by: {
              type: ['object', 'null'],
              description: 'The comment that addressed this one, if addressed.',
              properties: {
                comment_id: { type: 'string' },
                version: { type: ['integer', 'null'] },
              },
              required: ['comment_id'],
            },
            resolution: {
              type: ['object', 'null'],
              description:
                'The comment\u2019s settled state, or null while it is open. ' +
                'Not encrypted: Relic records that this comment was settled ' +
                'and which address settled it, though not a word of what it ' +
                'says. A resolved comment counts as handled and no longer ' +
                'blocks republishing.',
              properties: {
                at: { type: 'string' },
                by: {
                  type: 'string',
                  description: 'The address that settled it, or "publisher".',
                },
              },
              required: ['at', 'by'],
              additionalProperties: false,
            },
            resolved: {
              type: ['object', 'null'],
              description:
                'The resolved content and status for this anchor, when resolve_anchors is enabled. OTIO digest or revision mismatches are unresolvable and contain no artifact-derived context.',
            },
          },
          required: [
            'comment_id',
            'author',
            'created_at',
            'display_name',
            'body',
            'version',
            'edited_at',
            'anchor',
            'readable',
            'unreadable_reason',
            'addresses',
            'addressed',
            'addressed_by',
            'resolution',
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      'relic_id',
      'count',
      'unreadable_count',
      'summary',
      'comments',
      'version_scope',
      'current_version',
      'hidden_by_scope',
    ],
    additionalProperties: false,
  },
} as const;

export const COMMENT_TOOL_DEFINITION = {
  name: COMMENT_TOOL_NAME,
  title: 'Comment on a relic',
  description:
    'Leave a comment on a relic this machine published, encrypted here so ' +
    'the service stores ciphertext it cannot read. Everyone holding the ' +
    'link sees it. Warning: posting emails everyone following the relic ' +
    '(each verified commenter, each address added with relic_share, and ' +
    'the owner address, minus any that used the stop link). ' +
    'Attribution is the publish token, so the comment is attributed to ' +
    '"publisher" rather than to an email address: an agent has no mailbox ' +
    'and cannot verify one, and the email names "The publisher". At most ' +
    'one email per person per relic per 10 minutes, and one stop link stops ' +
    'every email about that relic. That is attribution and not ' +
    'authorization. ' +
    'Comments can be anchored to an exact location: a text quote, a stage ' +
    'pin, an artifact region, a moment or span in audio or video, a page ' +
    'in a document, or an OTIO timeline point or range. Passing an anchor attaches your reply at that location, ' +
    'so the reader sees what you are answering; omitting it leaves a remark ' +
    'about the whole relic. ' +
    COMMENT_MACHINE_BOUNDARY +
    ' Takes the relic id, never the share URL.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      body: {
        type: 'string',
        description:
          'The comment text, up to 4096 bytes of UTF-8. It is encrypted ' +
          'before it leaves this machine.',
      },
      display_name: {
        type: 'string',
        description:
          'Optional. A name shown beside the comment, up to 64 bytes of ' +
          'UTF-8. It aliases the attribution for presentation and never ' +
          'replaces it.',
      },
      addresses: {
        type: 'string',
        description:
          'Optional. The service-minted id of the comment this one answers or acknowledges. ' +
          'Writing this marks that comment addressed so the relic can be republished. ' +
          'The pointer is sealed into the encrypted comment and also passed to the service in the clear for notification routing.',
      },
      anchor: {
        type: 'object',
        description:
          'Optional. Where the comment sits on the relic, so the reader sees ' +
          'exactly what the comment is about. Can be a text selection ' +
          '({kind: "quote", exact, prefix?, suffix?} or {kind: "text", quote}), ' +
          'a point on the stage ({kind: "pin", x, y}), ' +
          'a box on the artifact ({kind: "region", rect: {x, y, w, h}}), ' +
          'a moment or span in audio/video ({kind: "time", t, t_end?, rect?}, with t ' +
          'given as seconds or as a timecode like "1:23"), ' +
          'a page in a paged document ({kind: "page", page, rect?, exact?}), ' +
          'or an OTIO point or range ({kind: "otio", v: 1, relic_version, document_sha256, timeline_id, track_id, item_id?, range: {start_time, duration}, snapshot}). ' +
          'track_id null marks the whole composition. Zero duration is a point. ' +
          'Omit for a remark about the whole relic.',
        properties: {
          kind: {
            type: 'string',
            enum: ['quote', 'text', 'pin', 'region', 'time', 'page', 'otio'],
            description: 'The kind of anchor mark.',
          },
          exact: {
            type: 'string',
            description:
              'For quote anchors: the exact text selection, up to 512 bytes.',
          },
          quote: {
            type: 'string',
            description:
              'For text anchors (or quote): the quoted text, up to 512 bytes.',
          },
          prefix: {
            type: 'string',
            description:
              'For quote anchors: text immediately before the selection to disambiguate it, up to 128 bytes.',
          },
          suffix: {
            type: 'string',
            description:
              'For quote anchors: text immediately after the selection to disambiguate it, up to 128 bytes.',
          },
          x: {
            type: 'number',
            description:
              'For pin anchors: horizontal coordinate from 0 (left) to 1 (right) of the stage.',
          },
          y: {
            type: 'number',
            description:
              'For pin anchors: vertical coordinate from 0 (top) to 1 (bottom) of the stage.',
          },
          rect: {
            type: 'object',
            description:
              'A box on the artifact in unit coordinates (0 to 1), with real area and no overhang.',
            properties: {
              x: { type: 'number', description: 'Left edge from 0 to 1.' },
              y: { type: 'number', description: 'Top edge from 0 to 1.' },
              w: { type: 'number', description: 'Width greater than 0.' },
              h: { type: 'number', description: 'Height greater than 0.' },
            },
            required: ['x', 'y', 'w', 'h'],
            additionalProperties: false,
          },
          t: {
            type: ['number', 'string'],
            description:
              'For time anchors: time offset in seconds (0 to 86400) or as a timecode string like "1:23" or "1:02:03".',
          },
          t_end: {
            type: ['number', 'string'],
            description:
              'For time anchors: optional end of span in seconds or timecode string, strictly after t.',
          },
          page: {
            type: 'integer',
            minimum: 1,
            maximum: 10000,
            description: 'For page anchors: 1-based page number (1 to 10000).',
          },
          v: {
            type: 'integer',
            const: 1,
            description: 'OTIO anchor version. Only 1 can be written.',
          },
          relic_version: {
            type: 'integer',
            minimum: 1,
            description:
              'OTIO: the relic revision this mark was made on. Sealed, not the format version.',
          },
          document_sha256: {
            type: 'string',
            description:
              'OTIO: 64 hex characters of the original content.otio digest.',
          },
          timeline_id: {
            type: 'string',
            description: 'OTIO: timeline node id.',
          },
          track_id: {
            type: ['string', 'null'],
            description:
              'OTIO: track node id, or null for the whole composition.',
          },
          item_id: {
            type: 'string',
            description: 'OTIO: optional item id inside the track.',
          },
          range: {
            type: 'object',
            description:
              'OTIO: half-open timeline range. Zero duration is a point.',
            properties: {
              start_time: {
                type: 'object',
                properties: {
                  value: { type: 'number' },
                  rate: { type: 'number' },
                },
                required: ['value', 'rate'],
                additionalProperties: false,
              },
              duration: {
                type: 'object',
                properties: {
                  value: { type: 'number' },
                  rate: { type: 'number' },
                },
                required: ['value', 'rate'],
                additionalProperties: false,
              },
            },
            required: ['start_time', 'duration'],
            additionalProperties: false,
          },
          snapshot: {
            type: 'object',
            description: 'OTIO: bounded labels for timeline, track, and item.',
            properties: {
              timeline: { type: 'string' },
              track: { type: ['string', 'null'] },
              item: { type: ['string', 'null'] },
            },
            required: ['timeline', 'track', 'item'],
            additionalProperties: false,
          },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    required: ['relic_id', 'body'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      comment_id: { type: 'string' },
      author: { type: 'string' },
      created_at: { type: 'string' },
    },
    required: ['relic_id', 'comment_id', 'author', 'created_at'],
    additionalProperties: false,
  },
} as const;

export const EDIT_COMMENT_TOOL_DEFINITION = {
  name: EDIT_COMMENT_TOOL_NAME,
  title: 'Edit a comment on a relic',
  description:
    'Replace the text of a comment on a relic this machine published, ' +
    'authorized by its publish token, so the comment stays attributed to ' +
    '"publisher". ' +
    'An edit changes what a remark says and never where it points: the ' +
    'comment\u2019s existing anchor and the comment it answers are carried ' +
    'into the re-sealed copy, so every reply keeps answering the same thing. ' +
    'There is no edit history. The service holds one ciphertext per comment ' +
    'and this overwrites it, so the honest thing on offer is the fact that ' +
    'the text changed, carried on the row as `edited_at`, not the earlier ' +
    'text. ' +
    COMMENT_MACHINE_BOUNDARY +
    ' Takes the relic id, never the share URL: the URL carries the key in ' +
    'its fragment.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      comment_id: {
        type: 'string',
        description:
          'The service-minted id of the comment to edit. It can only come ' +
          'from having read the relic\u2019s comments.',
      },
      body: {
        type: 'string',
        description:
          'The replacement comment text, up to 4096 bytes of UTF-8. It is ' +
          'encrypted before it leaves this machine, exactly as a new comment ' +
          'would be.',
      },
    },
    required: ['relic_id', 'comment_id', 'body'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      comment_id: { type: 'string' },
      author: { type: 'string' },
      created_at: { type: 'string' },
      edited_at: {
        type: ['string', 'null'],
        description:
          'When this edit replaced the text, as the service stamped it.',
      },
      resolved_at: { type: ['string', 'null'] },
      resolved_by: { type: ['string', 'null'] },
    },
    required: [
      'relic_id',
      'comment_id',
      'author',
      'created_at',
      'edited_at',
      'resolved_at',
      'resolved_by',
    ],
    additionalProperties: false,
  },
} as const;

export const RESOLVE_COMMENT_TOOL_DEFINITION = {
  name: RESOLVE_COMMENT_TOOL_NAME,
  title: 'Resolve a comment on a relic',
  description:
    'Mark a comment on a relic settled, or reopen it, on a relic this ' +
    'machine published, authorized by its publish token. A publisher ' +
    'settling feedback on their own relic is the point of the state. ' +
    'Resolving is not encrypted: Relic records that the comment was settled ' +
    'and which address settled it, though not a word of what it says. ' +
    'A resolved comment counts as handled: it no longer blocks ' +
    '`relic_republish`, and readers see it marked settled rather than open. ' +
    COMMENT_MACHINE_BOUNDARY +
    ' Takes the relic id, never the share URL: the URL carries the key in ' +
    'its fragment.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      comment_id: {
        type: 'string',
        description:
          'The service-minted id of the comment to resolve. It can only come ' +
          'from having read the relic\u2019s comments.',
      },
      resolved: {
        type: 'boolean',
        description:
          'True to mark the comment settled, false to open it again.',
      },
    },
    required: ['relic_id', 'comment_id', 'resolved'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      comment_id: { type: 'string' },
      author: { type: 'string' },
      created_at: { type: 'string' },
      edited_at: { type: ['string', 'null'] },
      resolved_at: {
        type: ['string', 'null'],
        description: 'When the comment was settled, or null while it is open.',
      },
      resolved_by: {
        type: ['string', 'null'],
        description:
          'The address that settled it, or "publisher". Not encrypted: the ' +
          'operator can see it.',
      },
    },
    required: [
      'relic_id',
      'comment_id',
      'author',
      'created_at',
      'edited_at',
      'resolved_at',
      'resolved_by',
    ],
    additionalProperties: false,
  },
} as const;

export const DESCRIBE_TOOL_DEFINITION = {
  name: DESCRIBE_TOOL_NAME,
  title: 'Describe the Relic client',
  description:
    'Return exactly what this client does with your file: the encryption ' +
    'path, what leaves the machine, and what the service can see. Reads ' +
    'nothing and sends nothing.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

/**
 * The build stamps the published version in, from package.json, which the
 * release workflow rewrites before it builds. It used to be a literal, and it
 * went stale immediately: the tarball published as 0.2.0 introduced itself to
 * every client as 0.1.0.
 *
 * An unbuilt run says so rather than guessing at a release number, because a
 * dev process claiming a version somebody could look up is worse than one
 * admitting it has none.
 */
export const SERVER_VERSION = process.env.RELIC_MCP_VERSION ?? '0.0.0-dev';

export const SERVER_INFO = {
  name: 'relic',
  title: 'Relic',
  version: SERVER_VERSION,
} as const;

export const CAPABILITIES = { tools: {} } as const;

/**
 * Server-level guidance, returned on the handshake so a client can put it in
 * the model's context before any tool is called.
 *
 * The plugin ships a skill with the same facts, but a skill only reaches
 * Claude Code, and only when somebody installs the plugin rather than wiring
 * this server directly. Every other client saw tool descriptions and nothing
 * else, which left seven things an agent cannot read off a schema.
 *
 * Item six is one of the two reasons this exists at all rather than living
 * only in a tool result. The publish result arrives after the file is
 * written, which is too late for an agent that already linked a stylesheet
 * from a CDN. Item seven is the other: an agent that never learns comments
 * exist never reads one. Both land before the work, which is the only moment
 * either can be acted on.
 *
 * It costs context on every session, so it stays short and it stays true.
 * Anything that needs a paragraph belongs in the skill or the disclosure.
 */
export const INSTRUCTIONS = `Relic encrypts a file on this machine and uploads \
only ciphertext. The key lives in the URL fragment, which browsers never send \
to a server.

Nine things that change how you should act:
1. The full link is the credential: anyone holding it can read the file. Never \
paste it into a tracker, log, or channel.
2. A relic carries a plaintext title, defaulting to the filename: the service \
stores it and every link preview shows it. Pass title: "" when it is sensitive.
3. Publishing puts the key in this transcript. Say so when handing over the link.
4. Check sources with relic_lookup_source. relic_publish costs a second URL; \
relic_republish keeps the first. ${VERSION_HISTORY_DISCLOSURE}
5. Only the publishing machine can republish: its key and publish token live there.
6. HTML and JSX render in an isolated frame with no network access. Inline \
styles, scripts, fonts, and images: a CDN reference renders as nothing.
7. Read reviewed-relic comments with relic_read_comments before changes. Answer \
with relic_comment, rewrite yours with relic_edit_comment, or settle one with \
relic_resolve_comment; settled counts as handled. New-comment mail excludes its \
author, is capped once per 10 minutes, and one stop link stops every email \
about that relic.
8. Previews are unencrypted: publish and republish upload the first screen by \
default. Pass cover: false for anything not public. OTIO previews are a generic \
card with only the public title and format, never media frames or track metadata. \
Ordinary file publishing needs Node 18+. An .otiod directory uses the \
source-included prebuilt Node-API helper on macOS arm64 or x64 with a 15.0 \
binary deployment floor, or Linux glibc 2.28+ arm64 or x64. Before it reads a \
bundle on either platform, the helper verifies on the running kernel that \
beneath-root resolution refuses parent and absolute escapes from a held directory \
and that the no-symlink flag is accepted. Symlink refusal, held-descriptor \
behavior, and replacement behavior are verified by the CI probe on the listed \
versions. It is never downloaded or compiled at runtime; targets that cannot \
satisfy those requirements refuse the directory instead of using pathname checks.
9. relic_republish emails followers a change notice naming the title and version, \
never the key; pass notify: false to skip it. relic_share returns a share email \
with the full link to draft in the sharer's mailbox but never sends it. Readers \
holding the link can also share from the viewer once this client version has \
published or republished the relic.`;

/**
 * Handle one JSON-RPC message.
 *
 * Returns undefined for notifications, which carry no id and take no
 * response. Nothing here reads or writes state that outlives the call.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  deps: PublishDeps
): Promise<JsonRpcResponse | undefined> {
  if (message.id === undefined) return undefined; // notification
  const id = message.id ?? null;

  // `server/discover` and `initialize` are the two probes a client uses to
  // find out what this server speaks, so neither may be refused for declaring
  // a version the server does not have.
  const isProbe =
    message.method === 'server/discover' || message.method === 'initialize';

  const requested = requestedProtocolVersion(message);
  if (!isProbe && requested !== undefined && !isSupportedVersion(requested)) {
    return unsupportedVersionError(id, requested);
  }

  switch (message.method) {
    case 'server/discover':
      // Mandatory in this revision: supported versions, capabilities, and
      // identity in a single request, with no handshake to precede it.
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };

    case 'initialize': {
      // The legacy era. A modern client never sends this.
      const asked =
        (message.params?.['protocolVersion'] as string | undefined) ??
        PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: isSupportedVersion(asked) ? asked : PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            TOOL_DEFINITION,
            LIST_TOOL_DEFINITION,
            SHOW_TOOL_DEFINITION,
            LOOKUP_TOOL_DEFINITION,
            REPUBLISH_TOOL_DEFINITION,
            SHARE_TOOL_DEFINITION,
            READ_COMMENTS_TOOL_DEFINITION,
            COMMENT_TOOL_DEFINITION,
            EDIT_COMMENT_TOOL_DEFINITION,
            RESOLVE_COMMENT_TOOL_DEFINITION,
            DESCRIBE_TOOL_DEFINITION,
          ],
        },
      };

    case 'tools/call':
      return callTool(id, message.params ?? {}, deps);

    default:
      return errorResponse(
        id,
        ERROR_CODES.methodNotFound,
        `unknown method: ${message.method}`
      );
  }
}

/**
 * What a publisher of executable content needs to know, and nobody else can
 * use.
 *
 * `html` and `jsx` are the two classes that render author-written code, and
 * that code now runs in a frame served a policy with no remote source, so a
 * page built against a CDN comes out bare. The recipient cannot fix that; the
 * person publishing can, by inlining what the page needs.
 *
 * Every other class is inert markup or bytes, so the note would be noise.
 */
function isolationNote(rendererClass: string): string {
  if (rendererClass !== 'html' && rendererClass !== 'jsx') return '';
  return (
    'It renders in an isolated frame with no network access, so external ' +
    'images, fonts, scripts, and fetches will not load. Inline whatever the ' +
    'page needs.\n'
  );
}

async function callTool(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  if (params['name'] === DESCRIBE_TOOL_NAME) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: describeClient(deps) }],
        structuredContent: {
          encryption: 'AES-128-GCM, RFC 8188 aes128gcm framing',
          key_origin: 'crypto.getRandomValues on this machine',
          key_transmitted_to_service: false,
          plaintext_bytes_transmitted_to_service: false,
          cover_image:
            'by default a 1200x630 picture of the first screen, rendered on this machine by a local Chrome, Chromium, or Edge with networking disabled (ffmpeg for audio and video), uploaded unencrypted and shown in link previews; cover: false withholds it',
          plaintext_title:
            'relic title, defaulting to the source filename, stored by the ' +
            'service in the clear and shown by every link preview',
          ciphertext_destination: 'object storage, via a signed URL',
          local_publish_state:
            'relic id, source identity, key, and publish token per relic, ' +
            'written 0600 under the user config directory; key and token ' +
            'are never printed or sent',
          comment_encryption:
            'AES-128-GCM under a key derived from the relic key with a ' +
            'distinct HKDF label, so comment bodies reach the service as ' +
            'ciphertext and the URL fragment is unchanged',
          comment_attribution:
            'the publish token, reported by the service as "publisher"; the ' +
            'operator learns which identity commented on which relic and when; ' +
            'posting with relic_comment emails everyone following the relic, naming "The publisher"',
          comment_notices:
            'a new comment on a relic emails everyone on its list (commenters, ' +
            'shared addresses, the owner address) except the author, naming the ' +
            'commenter\u2019s address or "The publisher"; at most one email per person ' +
            'per relic per 10 minutes, and one stop link stops every email about that relic',
          change_notices:
            'on every republish unless notify: false, the service emails every ' +
            'verified address that commented on the relic and every address ' +
            'added with relic_share, minus any that used ' +
            'the stop link; the email names the title and version and never carries the key; ' +
            'at most one email per person per relic per 10 minutes, and one stop link stops every email about that relic',
          sharing:
            'relic_share sends the service email addresses and nothing else; ' +
            'it stores them in the clear, linked to the relic id so they receive ' +
            'comment and change notices; the share email carrying the full link ' +
            'is composed here for you to send from your own mailbox, so the key ' +
            'never reaches the service; readers holding the link can also share ' +
            'from the viewer once a relic was published or republished by this client version',
          service_origin: deps.serviceOrigin,
        },
        isError: false,
      },
    };
  }

  if (params['name'] === LOOKUP_TOOL_NAME) {
    return callLookup(id, params, deps);
  }

  if (params['name'] === LIST_TOOL_NAME) {
    return callList(id, params, deps);
  }

  if (params['name'] === SHOW_TOOL_NAME) {
    return callShow(id, params, deps);
  }

  if (params['name'] === REPUBLISH_TOOL_NAME) {
    return callRepublish(id, params, deps);
  }

  if (params['name'] === SHARE_TOOL_NAME) {
    return callShare(id, params, deps);
  }

  if (params['name'] === READ_COMMENTS_TOOL_NAME) {
    return callReadComments(id, params, deps);
  }

  if (params['name'] === COMMENT_TOOL_NAME) {
    return callComment(id, params, deps);
  }

  if (params['name'] === EDIT_COMMENT_TOOL_NAME) {
    return callEditComment(id, params, deps);
  }

  if (params['name'] === RESOLVE_COMMENT_TOOL_NAME) {
    return callResolveComment(id, params, deps);
  }

  if (params['name'] !== TOOL_NAME) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `unknown tool: ${String(params['name'])}`
    );
  }

  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const path = args['path'];
  if (typeof path !== 'string' || path.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`path` is required and must be a string'
    );
  }

  const filename =
    typeof args['filename'] === 'string' ? args['filename'] : undefined;

  const rawTitle = args['title'];
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`title` must be a string or omitted'
    );
  }
  const title = typeof rawTitle === 'string' ? rawTitle : undefined;
  const ttlDays = parseTtlDays(args['ttl_days']);
  if (!ttlDays.ok) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `\`ttl_days\` must be an integer between 1 and ${MAX_TTL_DAYS}, or ` +
        'omitted to keep the relic until it is deleted'
    );
  }

  const forceNew = args['force_new'];
  if (forceNew !== undefined && typeof forceNew !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`force_new` must be a boolean or omitted'
    );
  }
  const rawCover = args['cover'];
  if (rawCover !== undefined && typeof rawCover !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`cover` must be a boolean or omitted'
    );
  }
  const cover = typeof rawCover === 'boolean' ? rawCover : undefined;

  try {
    const result = await publish(
      {
        path,
        filename,
        title,
        ttl_days: ttlDays.days,
        force_new: forceNew === true,
        cover,
      },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        // The full URL including the fragment, because relaying a usable link
        // is the product. The consequence is disclosed rather than hidden:
        // the key enters the model's context and the session transcript on
        // every publish, and the disclosure statement says so.
        content: [
          {
            type: 'text',
            text:
              `Published ${result.filename} as version 1 of a new relic.\n\n` +
              `${result.url}\n\n` +
              `${
                result.title !== null
                  ? `The title "${result.title}" is not encrypted: the service stores it and every link preview shows it. Pass an empty title to publish without one.`
                  : 'Published without a title, so a link preview shows only that it is a relic.'
              }\n\n` +
              `${formatCoverText(result.cover)}\n\n` +
              // No lifetime is the default, so the agent relaying this needs
              // a sentence that says so, not a date-shaped hole.
              (result.relic_expires_at === null
                ? 'It does not expire; it is kept until it is deleted. '
                : `Expires ${result.relic_expires_at}. `) +
              'Anyone with this link, ' +
              'including its fragment, can read the file. The key is in the ' +
              'fragment and it is now in this transcript. This machine can ' +
              'republish it later; the link will not change.\n\n' +
              `Key phrase: ${result.key_phrase}\n` +
              `${KEY_PHRASE_DISCLOSURE}\n` +
              // publish call is the only moment they are looking. The relic
              // page used to carry it to the recipient, who cannot do
              // anything about a font that will not load.
              isolationNote(result.renderer_class) +
              `What Relic knows: ${result.disclosure_url}`,
          },
          { type: 'text', text: VERSION_HISTORY_DISCLOSURE },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callLookup(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const path = args['path'];
  if (typeof path !== 'string' || path.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`path` is required and must be a string'
    );
  }

  try {
    const lookup = await lookupPublishedSource(path, deps);
    const match = lookup.match;
    const republishCall =
      match === undefined
        ? null
        : republishToolCall(match.relic_id, lookup.resolved_path);
    const structuredContent = {
      found: match !== undefined,
      relic_id: match?.relic_id ?? null,
      version: match?.version ?? null,
      resolved_path: lookup.resolved_path,
      source_identity: lookup.source.identity,
      source_description: lookup.source.description,
      republish_call: republishCall,
    };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              match === undefined
                ? `No prior relic is recorded for ${lookup.source.description}.`
                : `Found ${lookup.source.description} as version ` +
                  `${match.version} of relic ${match.relic_id}.\n` +
                  `Call relic_republish(${JSON.stringify(
                    republishCall?.arguments
                  )}).`,
          },
        ],
        structuredContent,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callList(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;

  const limit = args['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
  ) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`limit` must be an integer of 1 or more, or omitted'
    );
  }

  for (const name of ['include_expired', 'verify', 'refresh'] as const) {
    if (args[name] !== undefined && typeof args[name] !== 'boolean') {
      return errorResponse(
        id,
        ERROR_CODES.invalidParams,
        `\`${name}\` must be a boolean or omitted`
      );
    }
  }

  try {
    const result = await listRelics(
      {
        limit: typeof limit === 'number' ? limit : undefined,
        include_expired: args['include_expired'] as boolean | undefined,
        verify: args['verify'] as boolean | undefined,
        refresh: args['refresh'] as boolean | undefined,
      },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: listTranscript(result) }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callShow(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const includeContent = args['include_content'];
  if (includeContent !== undefined && typeof includeContent !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`include_content` must be a boolean or omitted'
    );
  }

  try {
    const result = await showRelic(
      { relic_id: relicId, include_content: includeContent },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: showTranscript(result) }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

/**
 * One row as a person reads it.
 *
 * The status sentence is printed for anything other than a served relic,
 * because a row that reads like every other row while meaning "this link is
 * dead" is the failure the status exists to prevent. The share URL is last on
 * its own line: it is the credential, and burying it mid-sentence makes it
 * easy to paste somewhere it should not go.
 */
function relicLine(row: RelicRow): string {
  const name =
    row.filename ?? `[name unrecovered: ${row.filename_unrecovered_reason}]`;
  const versions = row.version === 1 ? 'v1' : `v${row.version}`;
  const when = row.published_at ?? 'date not recorded';
  const life =
    row.expires_at !== null
      ? `expires ${row.expires_at}`
      : row.expires_at_known
        ? 'no expiry'
        : 'lifetime not recorded';
  const state =
    row.status === 'reachable' ? '' : `\n  ${row.status}: ${row.status_detail}`;
  const finding = row.source_indexed
    ? ''
    : '\n  not findable by relic_lookup_source';
  return (
    `${name} (${row.relic_id}, ${versions}, ${when}, ${life})${state}${finding}` +
    `\n  ${row.share_url}`
  );
}

/**
 * The listing as a person reads it, with every number that cost something.
 *
 * The findable count leads because it is the whole point: a publisher who
 * believes lookup can find their relics does not know they need this tool
 * until they need it and it is not there.
 */
function listTranscript(result: ListResult): string {
  if (result.total === 0) {
    return (
      'This machine has published no relics, or its publish state was moved ' +
      'or deleted. A relic published from another machine cannot be listed ' +
      'here: its key never left that machine.'
    );
  }

  const header = [
    `${result.count} relic(s) of ${result.total} this machine published, ` +
      'newest first.',
    `${result.findable_by_source} of ${result.total} can be found by ` +
      'relic_lookup_source; the rest are reachable only through this list.',
  ];
  if (result.truncated) {
    header.push(`Limited to the newest ${result.count}.`);
  }
  if (result.excluded_expired > 0) {
    header.push(
      `${result.excluded_expired} expired relic(s) left out at your request, ` +
        'not missing.'
    );
  }
  if (result.unreadable_entries.length > 0) {
    header.push(
      `${result.unreadable_entries.length} stored entr(ies) could not be ` +
        'read and are not listed below, which means those relics may no ' +
        `longer be republishable from here: ${result.unreadable_entries.join(
          ', '
        )}.`
    );
  }
  if (result.recovered_filenames > 0) {
    header.push(
      `${result.recovered_filenames} name(s) were recovered by decrypting ` +
        'the relics themselves, because this machine never recorded them.'
    );
  }
  if (result.opens_spent > 0) {
    header.push(
      `This call spent ${result.opens_spent} open(s), one per relic asked ` +
        'about. They do not come back; a repeat listing spends none.'
    );
  }
  header.push(
    'Each line ends with a share URL whose fragment is the decryption key. ' +
      'Every one of them is now in this transcript and opens the file for ' +
      'anyone who reads it.'
  );

  return `${header.join(' ')}\n\n${result.relics
    .map((row) => relicLine(row))
    .join('\n\n')}`;
}

/**
 * One relic in full, ending with what to do next.
 *
 * The republish sentence is here rather than in the schema because it is the
 * reason the tool exists: reading the content back is what makes replacing it
 * an edit instead of a guess.
 */
function showTranscript(result: ShowResult): string {
  const lines = [
    relicLine(result) +
      `\n  key phrase: ${result.key_phrase}\n  ${KEY_PHRASE_DISCLOSURE}`,
  ];
  if (result.versions !== null) {
    lines.push(
      result.versions === result.version
        ? `The service holds ${result.versions} version(s), which matches ` +
            'this machine\u2019s record.'
        : `The service holds ${result.versions} version(s) and this machine ` +
            `recorded ${result.version}. A republish reached the service ` +
            'without being recorded here, so the local count is behind.'
    );
  }

  if (result.mimetype !== null) {
    lines.push(
      `Declared type ${result.mimetype}` +
        (result.renderer_class === null
          ? ''
          : `, class ${result.renderer_class}`) +
        (result.content_bytes === null
          ? '.'
          : `, ${result.content_bytes} bytes.`)
    );
  }

  if (result.content !== null) {
    lines.push(
      'Current content follows. Republishing replaces what the link serves ' +
        'with whatever file you pass, so edit this and republish it rather ' +
        'than writing something new from memory.',
      '---',
      result.content,
      '---'
    );
  } else if (result.content_omitted_reason !== null) {
    lines.push(`No content returned: ${result.content_omitted_reason}`);
  }

  if (result.status === 'reachable') {
    lines.push(
      `To change it: write the new content to a file and call ` +
        `relic_republish with relic_id ${result.relic_id}. The share URL ` +
        'does not change, so everyone already holding it sees the new ' +
        `version. ${VERSION_HISTORY_DISCLOSURE}`
    );
  }

  return lines.join('\n\n');
}

async function callRepublish(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const path = args['path'];
  if (typeof path !== 'string' || path.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`path` is required and must be a string'
    );
  }

  const filename =
    typeof args['filename'] === 'string' ? args['filename'] : undefined;

  const rawTitle = args['title'];
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`title` must be a string or omitted'
    );
  }
  const title = typeof rawTitle === 'string' ? rawTitle : undefined;
  const ttlDays = parseTtlDays(args['ttl_days']);
  if (!ttlDays.ok) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `\`ttl_days\` must be an integer between 1 and ${MAX_TTL_DAYS}, or ` +
        'omitted to leave the lifetime as the first publish set it'
    );
  }
  const rawAddresses = args['addresses'];
  let addresses: readonly RepublishAddressEntry[] | undefined;
  if (rawAddresses !== undefined) {
    if (!Array.isArray(rawAddresses)) {
      return errorResponse(
        id,
        ERROR_CODES.invalidParams,
        '`addresses` must be an array of { comment_id, note } objects or omitted'
      );
    }
    addresses = rawAddresses as readonly RepublishAddressEntry[];
  }
  const rawCover = args['cover'];
  if (rawCover !== undefined && typeof rawCover !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`cover` must be a boolean or omitted'
    );
  }
  const cover = typeof rawCover === 'boolean' ? rawCover : undefined;
  const rawNotify = args['notify'];
  if (rawNotify !== undefined && typeof rawNotify !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`notify` must be a boolean or omitted'
    );
  }
  const notify = typeof rawNotify === 'boolean' ? rawNotify : undefined;
  try {
    const result = await republish(
      {
        relic_id: relicId,
        path,
        filename,
        title,
        ttl_days: ttlDays.days,
        addresses,
        cover,
        notify,
      },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        // No URL is printed here, on purpose. It has not changed, and
        // reprinting it would reprint the key for no new reader; the first
        // publish already made that disclosure once.
        content: [
          {
            type: 'text',
            text:
              `Republished ${result.filename} as version ${result.version} ` +
              `of relic ${result.relic_id}.\n\n` +
              'The share URL is unchanged: everyone holding the existing ' +
              'link, including its fragment, now sees this content. There ' +
              'is no new link to hand out.\n\n' +
              `${
                result.notify
                  ? `Relic sends a change notice for version ${result.version} to each address that commented on this relic or was added with relic_share, except any that stopped those emails. It names the title and version and never carries the key (at most one email per recipient per relic per 10 minutes; one stop link stops every email about that relic).`
                  : 'No change notice goes out for this version, as asked.'
              }\n\n` +
              `Key phrase: ${result.key_phrase}\n` +
              `${KEY_PHRASE_DISCLOSURE}\n\n` +
              `${
                result.title !== null
                  ? `The title "${result.title}" is not encrypted: the service stores it and every link preview shows it. Pass an empty title to publish without one.`
                  : 'Published without a title, so a link preview shows only that it is a relic.'
              }\n\n` +
              `${formatCoverText(result.cover)}\n\n` +
              (result.relic_expires_at === null
                ? 'The relic does not expire; it is kept until it is deleted.'
                : `Expires ${result.relic_expires_at}.`) +
              '\n' +
              `What Relic knows: ${result.disclosure_url}`,
          },
          { type: 'text', text: VERSION_HISTORY_DISCLOSURE },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callShare(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const rawEmails = args['emails'];
  if (!Array.isArray(rawEmails)) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`emails` is required and must be an array of email addresses'
    );
  }
  for (let i = 0; i < rawEmails.length; i++) {
    if (typeof rawEmails[i] !== 'string') {
      return errorResponse(
        id,
        ERROR_CODES.invalidParams,
        `\`emails[${i}]\` must be a string`
      );
    }
  }

  try {
    const result = await shareRelic(
      {
        relic_id: relicId,
        emails: rawEmails as readonly string[],
      },
      deps
    );

    const text =
      `Registered ${result.registered.length} address(es) on relic ${result.relic_id} ` +
      `for comment and change notices (${result.added} new; ${result.shared_count} of ${result.share_limit} on its list). ` +
      'Relic has emailed nobody.\n\n' +
      "Draft the email below in the sharer's own mailbox, from their own address, " +
      'and let them send it. Do not send it through Relic or any other service, and ' +
      'do not paste the link anywhere else: it carries the key, which is now in this transcript.\n\n' +
      `To: ${result.email.to.join(', ')}\n` +
      `Subject: ${result.email.subject}\n\n` +
      `${result.email.text}\n\n` +
      `Mail client link (opens a draft with all of the above): ${result.mailto_url}`;

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}
async function callReadComments(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }
  const rawResolve = args['resolve_anchors'];
  if (rawResolve !== undefined && typeof rawResolve !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`resolve_anchors` must be a boolean or omitted'
    );
  }
  const resolveAnchors = rawResolve === true;

  const rawVersion = args['version'];
  if (
    rawVersion !== undefined &&
    rawVersion !== '*' &&
    (typeof rawVersion !== 'number' ||
      !Number.isSafeInteger(rawVersion) ||
      rawVersion < 1)
  ) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`version` must be a positive version number, the literal "*", or omitted'
    );
  }

  try {
    const result = await readComments(relicId, deps, {
      resolve_anchors: resolveAnchors,
      version: rawVersion,
    });
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > = [{ type: 'text', text: commentTranscript(result) }];

    if (result.content_blocks) {
      for (const block of result.content_blocks) {
        if (block.type === 'image') {
          content.push(block);
        }
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content,
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callComment(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const body = args['body'];
  if (typeof body !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`body` is required and must be a string'
    );
  }

  const displayName = args['display_name'];
  if (displayName !== undefined && typeof displayName !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`display_name` must be a string or omitted'
    );
  }
  const rawAnchor = args['anchor'];
  if (
    rawAnchor !== undefined &&
    rawAnchor !== null &&
    (typeof rawAnchor !== 'object' || Array.isArray(rawAnchor))
  ) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`anchor` must be an object or omitted'
    );
  }

  const rawAddresses = args['addresses'];
  if (rawAddresses !== undefined && typeof rawAddresses !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`addresses` must be a string or omitted'
    );
  }
  const addresses = typeof rawAddresses === 'string' ? rawAddresses : undefined;

  try {
    const result = await postComment(
      {
        relic_id: relicId,
        body,
        display_name: displayName,
        anchor: rawAnchor as CommentAnchorInput | null | undefined,
        addresses,
      },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              `Commented on relic ${result.relic_id} as ${result.author}.\n` +
              'Everyone holding the link sees it. The service stored ' +
              'ciphertext it cannot read, and it knows that this address ' +
              'commented on this relic at this time. Relic emails everyone ' +
              'following this relic, naming "The publisher" (at most one ' +
              'email per recipient per relic per 10 minutes; one stop link ' +
              'stops every email about that relic).',
          },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callEditComment(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }
  const commentId = args['comment_id'];
  if (typeof commentId !== 'string' || commentId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`comment_id` is required and must be a string'
    );
  }
  const body = args['body'];
  if (typeof body !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`body` is required and must be a string'
    );
  }

  try {
    const result = await editComment(
      { relic_id: relicId, comment_id: commentId, body },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              `Edited comment ${result.comment_id} on relic ${result.relic_id}.\n` +
              'The earlier text is not on offer: the service holds one ' +
              `ciphertext per comment and this replaced it, stamped ${result.edited_at ?? 'now'}. ` +
              'Where the comment pointed and what it answered are unchanged.',
          },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callResolveComment(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }
  const commentId = args['comment_id'];
  if (typeof commentId !== 'string' || commentId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`comment_id` is required and must be a string'
    );
  }
  const resolved = args['resolved'];
  if (typeof resolved !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`resolved` is required and must be a boolean: true to settle the ' +
        'comment, false to open it again'
    );
  }

  try {
    const result = await resolveComment(
      { relic_id: relicId, comment_id: commentId, resolved },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              resolved === true
                ? `Resolved comment ${result.comment_id} on relic ${result.relic_id}, settled by ${result.resolved_by ?? 'publisher'}.\n` +
                  'This is not encrypted: Relic records that the comment was ' +
                  'settled and by which address, though not a word of what ' +
                  'it says. It no longer blocks republishing.'
                : `Reopened comment ${result.comment_id} on relic ${result.relic_id}.\n` +
                  'It is open again, and it blocks republishing until it is ' +
                  'answered or resolved.',
          },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

/**
 * The one line that says what a comment is attached to.
 *
 * Quotes are printed with context when present, pins describe their
 * stage-relative point, regions give plain-language positions and percentages,
 * time anchors give timecodes and spans, pages give page numbers, and
 * unsupported anchors state the declared kind. A comment without an anchor
 * is described as being about the whole relic.
 */
function markLine(anchor: CommentRecord['anchor']): string {
  return `${describeAnchor(anchor)}\n`;
}
function resolutionLine(resolved: CommentRecord['resolved']): string {
  if (!resolved) return '';

  switch (resolved.kind) {
    case 'quote':
    case 'text':
      if (resolved.status === 'resolved') {
        return (
          `Quotation:\n>>> ${resolved.exact} <<<\n\n` +
          `Source context (line ${resolved.line}):\n` +
          `...${resolved.context_before}>>> ${resolved.exact} <<<${resolved.context_after}...\n\n`
        );
      }
      return `[Resolution note: ${resolved.explanation}]\n`;

    case 'region':
      if (resolved.status === 'resolved') {
        const downscaleNotice = resolved.downscaled
          ? ` Downscaled from ${resolved.original_width}x${resolved.original_height} to bound payload size.`
          : '';
        return (
          `[Resolution: Image region crop (${resolved.crop_box_pixels.w}x${resolved.crop_box_pixels.h}px) ` +
          `and annotated context view attached below as image blocks.${downscaleNotice}]\n`
        );
      }
      return `[Resolution note: ${resolved.explanation}]\n`;

    case 'time':
      if (resolved.status === 'resolved') {
        const downscaleNotice = resolved.downscaled
          ? ' Downscaled to bound payload size.'
          : '';
        return `[Resolution: ${
          resolved.explanation ??
          `Video frame(s) at ${formatTimecode(resolved.t)} attached below as image blocks.`
        }${downscaleNotice}]\n`;
      }
      return `[Resolution note: ${resolved.explanation}]\n`;

    case 'page':
      if (resolved.exact) {
        return (
          `[Resolution note: ${resolved.explanation}]\n` +
          `Quotation on page ${resolved.page}:\n>>> ${resolved.exact} <<<\n`
        );
      }
      return `[Resolution note: ${resolved.explanation}]\n`;

    case 'pin':
      return `[Resolution note: ${resolved.explanation}]\n`;

    case 'unsupported':
      return `[Resolution note: ${resolved.explanation}]\n`;
    case 'otio':
      if (resolved.status === 'unresolvable') {
        return `[Resolution note: ${resolved.explanation} Snapshot: ${resolved.snapshot.timeline}${resolved.snapshot.track ? ` / ${resolved.snapshot.track}` : ''}]\n`;
      }
      return (
        `[OTIO revision ${resolved.relic_version} ${resolved.start_timecode}` +
        `${resolved.point ? '' : ` to ${resolved.end_timecode}`}, ` +
        `${resolved.intersections.length} intersection(s). ` +
        `Current projection: ${resolved.current_projection.status}` +
        `${resolved.current_projection.current_version === null ? '' : ` on version ${resolved.current_projection.current_version}`}. ` +
        `${resolved.current_projection.explanation}]\n`
      );
  }
}

/**
 * The comments as a person would read them, because a JSON array of rows is
 * not a conversation.
 *
 * Unreadable comments are printed in place, in order, with their reason. A
 * list that quietly closed over a gap would read as the whole conversation,
 * and an agent acting on "nobody objected" when somebody did is exactly the
 * failure the count exists to prevent.
 */
function commentTranscript(result: {
  readonly relic_id: string;
  readonly count: number;
  readonly unreadable_count: number;
  readonly summary: CommentsSummary;
  readonly comments: readonly CommentRecord[];
  readonly version_scope: number | 'all';
  readonly current_version: number | null;
  readonly hidden_by_scope: number;
}): string {
  const scopeNote =
    result.version_scope === 'all'
      ? 'every version'
      : `version ${result.version_scope}`;
  if (result.count === 0) {
    // A quiet scoped read is not a quiet relic. The hidden count rides even
    // on an empty list, because an agent that read only the current version
    // of a republished relic has not read the conversation at all.
    return result.hidden_by_scope > 0
      ? `No comments on ${scopeNote} of relic ${result.relic_id}. ` +
          `${result.hidden_by_scope} comment(s) exist outside this scope and were not returned.`
      : `No comments on relic ${result.relic_id} yet.`;
  }

  const lines = result.comments.map((comment) => {
    const who =
      comment.display_name === null
        ? comment.author
        : `${comment.display_name} (${comment.author})`;
    if (!comment.readable) {
      return `${comment.created_at} ${who}:\n[unreadable: ${comment.unreadable_reason}]`;
    }
    // The mark goes above the body, because it is what the body is about. A
    // transcript that printed the remark and withheld the line it points at
    // would be the same defect this fixed, one layer up.
    const mark = markLine(comment.anchor);
    const resolution = resolutionLine(comment.resolved);
    const versionNote =
      comment.version !== null ? `[made on version ${comment.version}]\n` : '';
    const editedNote =
      comment.edited_at !== null ? `[edited ${comment.edited_at}]\n` : '';
    // Resolution is not encrypted, so it is said plainly. A comment marked
    // settled has been handled even when nothing answered it.
    const resolvedNote =
      comment.resolution === null
        ? ''
        : `[resolved by ${comment.resolution.by} at ${comment.resolution.at}]\n`;
    const replyNote =
      comment.addresses !== null
        ? `[answers comment ${comment.addresses}]\n`
        : '';
    const addressedNote = comment.addressed
      ? `[addressed by comment ${comment.addressed_by?.comment_id ?? 'unknown'}${
          comment.addressed_by?.version != null
            ? ` in v${comment.addressed_by.version}`
            : ''
        }]\n`
      : '';
    return `${comment.created_at} ${who}:\n${mark}${resolution}${versionNote}${editedNote}${resolvedNote}${replyNote}${addressedNote}${comment.body}`;
  });

  const header =
    result.unreadable_count === 0
      ? `${result.count} comment(s) on ${scopeNote} of relic ${result.relic_id}, oldest first.`
      : `${result.count} comment(s) on ${scopeNote} of relic ${result.relic_id}, oldest ` +
        `first. ${result.unreadable_count} did not decrypt and are shown as ` +
        'unreadable rather than dropped, so treat this conversation as ' +
        'partially unread.';

  const hiddenNote =
    result.hidden_by_scope > 0
      ? ` ${result.hidden_by_scope} comment(s) exist outside this scope and were not returned.`
      : '';
  const currentNote =
    result.current_version === null
      ? ''
      : ` The relic's current version is ${result.current_version}.`;

  const summaryLine = `Summary: ${result.summary.total} total, ${result.summary.addressed} addressed, ${result.summary.open} open, ${result.summary.resolved} resolved, ${result.summary.unreadable} unreadable.`;

  return `${header}${hiddenNote}${currentNote}\n${summaryLine}\n\n${lines.join('\n\n')}`;
}

/**
 * A lifetime is opt-in: absent or null means no change from the default. A
 * value that fails the contract is refused rather than dropped, because
 * silently dropping it does the opposite of what was asked: a relic meant
 * to die in days lives forever.
 */
function parseTtlDays(
  raw: unknown
): { ok: true; days: number | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, days: undefined };
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > MAX_TTL_DAYS
  ) {
    return { ok: false };
  }
  return { ok: true, days: raw };
}

/**
 * Refusals a publisher must understand on their own terms.
 *
 * The server's problem document carries the code; these sentences carry
 * what the publisher can still do, because "403" and "410" answer nothing
 * a human would ask. The first two must stay distinct: one means this machine
 * lost its standing, the other means nobody has any, ever again.
 */
const REFUSAL_GUIDANCE: Readonly<Record<string, string>> = {
  invalid_publish_token:
    'The publish token this machine holds for that relic was rejected. It ' +
    'is issued once, at first publish, and never changes, so a rejection ' +
    "means the local record no longer matches the service's. The relic can " +
    'still be read at its existing link, but it cannot be republished from ' +
    'here.',
  relic_removed:
    'That relic was taken down. A takedown is permanent: republishing ' +
    'cannot revive it, whatever token is presented. Publish the content as ' +
    'a new relic instead.',
  comment_rate_limited:
    'The service is rate limiting comments on that relic. The refusal ' +
    'carries retry_after_seconds; wait it out rather than retrying in a ' +
    'loop, which only extends the limit.',
  share_limit_reached:
    'That relic already has the most shared addresses the service allows; the people on it still get change notices.',
  invalid_share:
    'Every entry must be one email address, and a call takes at most share_max_per_call of them.',
  share_rate_limited:
    'The refusal carries retry_after_seconds; wait it out rather than retrying in a loop.',
};

/**
 * A failed publish is a tool error, not a protocol error.
 *
 * The distinction is the spec's: a protocol error means the call could not be
 * made, and a tool error means it was made and failed. Reporting a refused
 * publish as a protocol error would hide it from the model, which then cannot
 * tell the user what went wrong or act on it.
 */
function toolError(error: unknown): Record<string, unknown> {
  if (error instanceof PublishError) {
    return {
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      structuredContent: { code: error.code, ...error.details },
      isError: true,
    };
  }
  if (error instanceof ServerRefusal) {
    const guidance = REFUSAL_GUIDANCE[error.code];
    return {
      content: [
        {
          type: 'text',
          text:
            `${error.code}: ${error.message}` +
            (guidance === undefined ? '' : `\n${guidance}`),
        },
      ],
      structuredContent: { code: error.code, ...error.problem },
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `the call failed: ${String(error)}` }],
    structuredContent: { code: 'unknown' },
    isError: true,
  };
}

/**
 * What this client does with a file, in the order it does it.
 *
 * Written out rather than pointing at a URL, because a description the agent
 * has to go fetch is a description nobody reads.
 */
export function describeClient(deps: PublishDeps): string {
  return `Relic publishing client, running locally on this machine.

What happens when you publish a file:

1. The file is read from disk by this process. It is never sent anywhere in
   plaintext.
2. A 128-bit key and a 26-character relic id are drawn independently from this
   machine's CSPRNG (crypto.getRandomValues). Neither derives from the other.
3. The file is encrypted here, in this process, with AES-128-GCM under RFC 8188
   aes128gcm framing: an HKDF-derived content key, counter-derived per-record
   nonces, and a per-record authentication tag.
4. Only ciphertext is uploaded, straight to object storage under a signed URL.
   It does not pass through ${deps.serviceOrigin}.
5. By default a 1200x630 picture of the first screen, rendered on this machine
   by a local Chrome, Chromium, or Edge with networking disabled (ffmpeg for
   audio and video), is uploaded unencrypted and shown in link previews;
   cover: false withholds it.
6. The service is told four things and nothing more: a coarse renderer class
   from an eight-value list, the name of this client, the exact byte length
   of the ciphertext, and the title, which defaults to the filename and is
   stored in the clear. Not the mimetype, not the contents.
7. You get back a URL whose fragment carries the key. Fragments are never sent
   to a server by a browser.

What the service operator can see: that a relic exists, roughly how big it is,
what coarse class it was declared as, the title, the publishing IP, and when it
was fetched. Never the contents, and never the key.

What this keeps on disk: for each relic you publish, its id, source identity,
key, and publish token, in a 0600 file under your user config directory. The
source index lets a fresh session find the id for relic_republish. The key and
token let that republish keep the same URL, and they are why republishing works
only on the machine that published. The token's SHA-256 is the only copy the
service ever holds, and neither secret is ever printed or logged. Deleting the
file changes nothing for existing links; it only ends this machine's ability
to update those relics.

What happens with comments: a comment body is encrypted here too, under a key
derived from that relic's key with a distinct HKDF label, so the service
stores comment ciphertext it cannot read and the URL fragment does not change.
Reading comments needs that key, and writing one is authorized by the publish
token, so both work only on the machine that published. A comment this client
writes is attributed to the publisher rather than an email address, because
an agent has no mailbox to verify. What the operator does learn is who
commented on which relic and when: for a person that is a verified email
address, and that association is a real cost the content's encryption does
not cover. A new comment emails everyone on the relic's list (commenters,
shared addresses, and the owner address) except the author, naming the
commenter's address or "The publisher" for comments this client posts.
At most one email per person per relic per 10 minutes, and one stop link
stops every email about that relic.

What happens with change notices and sharing: on every republish unless
notify: false, the service emails every verified address that commented on
the relic and every address added with relic_share, minus any that used the
stop link. The email names the title and version and
never carries the key. At most one email per person per relic per 10 minutes,
and one stop link stops every email about that relic. relic_share sends the
service email addresses and nothing else: it stores them in the clear, linked
to the relic id. The share email carrying the full link is composed here on
this machine for you to send from your own mailbox, so the key never reaches
the service. Readers holding the link can also share from the viewer once the
relic was published or republished by this client version.

What this does NOT protect against: the key is returned to your agent in the
URL, so it enters the model's context and your session transcript. That is
structural, not a defect. Anyone who can read this conversation can open the
relic.

The code doing all of this is on disk in this package and can be read. The only
compiled component is the source-included Node-API secure-open helper used for
automatic .otiod directory packaging. It ships for macOS arm64 and x64 with a
15.0 binary deployment floor, plus Linux glibc 2.28+ arm64 and x64. Before it
reads a bundle on either platform, the helper verifies on the running kernel
that beneath-root resolution refuses parent and absolute escapes from a held
directory and that the no-symlink flag is accepted. Symlink refusal,
held-descriptor behavior, and replacement behavior are verified by the CI probe
on the listed versions. The helper is never downloaded or compiled at runtime,
and an unsupported platform, architecture, libc, or kernel configuration
refuses .otiod packaging rather than using a pathname fallback. Nothing is
fetched from the network and executed.`;
}

/** Read newline-delimited JSON-RPC from a stream and write responses back. */
export async function serveStdio(
  deps: PublishDeps,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = input.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write(
          JSON.stringify(
            errorResponse(null, ERROR_CODES.parseError, 'parse error')
          )
        );
        continue;
      }

      const response = await handleMessage(message, deps);
      if (response !== undefined) write(JSON.stringify(response));
    }
  }
}
