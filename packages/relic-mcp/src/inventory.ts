/**
 * The inventory: what this machine has published, and what one relic holds.
 *
 * The gap this closes, measured on the file that prompted it: 41 relics
 * recorded, 4 findable. `relic_lookup_source` searches the source index, the
 * index names four entries, and nothing else enumerates. The key and the
 * publish token for the other 37 were on disk the whole time; no tool could
 * name them. A publisher who lost the source path lost the relic, while
 * holding everything needed to update it.
 *
 * Two structural facts shape everything here.
 *
 * **The envelope holds the name.** A relic's filename and mimetype live
 * inside the encrypted container, so a missing local record is recoverable
 * rather than lost: mint, fetch the first record, decrypt it with the key in
 * local state. That is why a row's filename is `null` only when recovery was
 * actually attempted and actually failed, with the reason attached.
 *
 * **Reaching the service costs one of the relic's opens.** A mint spends a
 * unit of a per-relic download cap that exists to bound egress, and waiting
 * never refills it. So the metered probe runs when it buys something that
 * cannot be had otherwise, and the free one runs when it will do: the comment
 * list is unauthenticated and unmetered, and it distinguishes removed from
 * unknown from unreachable without touching the cap. Recovered names are
 * cached beside the state file so the second listing costs nothing.
 *
 * Nothing here writes the publish state file. It holds the only copy of 41
 * relics' republish rights, it is read-modify-written whole, and two client
 * processes have no lock between them. A read tool that wrote to it could
 * lose an entry, and a lost entry is a relic that can never be updated again.
 */

import {
  decodeHeader,
  decodeKey,
  deriveRendererClass,
  envelopePrefixLength,
  HEADER_BYTES,
  isValidRelicId,
  openEnvelope,
  openRelic,
  plaintextSizeUpperBound,
  type RendererClass,
  relicUrl,
} from '@relic/format';
import { keyToMnemonic } from '@relic/format/mnemonic';
import {
  loadCachedMetadata,
  type RecoveredMetadata,
  saveCachedMetadata,
} from './metadata-cache.ts';
import {
  getJson,
  type PublishDeps,
  PublishError,
  ServerRefusal,
} from './publish.ts';
import {
  loadPublishInventory,
  loadPublishState,
  type PublishRecord,
  type PublishState,
} from './state.ts';

/**
 * What the service says about a relic right now.
 *
 * Every value except `reachable` is a reason a link is not currently
 * openable, and they are kept apart because they are not the same news. A
 * removal is permanent and republishing cannot undo it; an expiry ended a
 * lifetime the publisher chose; a cap exhaustion means the content is intact
 * and nobody else can open it; unreachable means this client learned nothing
 * at all, which is the one case where the row's silence is about the network
 * and not about the relic.
 */
export type RelicStatus =
  | 'reachable'
  | 'expired'
  | 'removed'
  | 'not_found'
  | 'never_published'
  | 'not_yet_published'
  | 'cap_exhausted'
  | 'rate_limited'
  | 'service_paused'
  | 'unreachable';

/** Which probe produced the status, because they answer different questions. */
export type StatusBasis = 'mint' | 'record' | 'local';

export type FilenameBasis = 'recorded' | 'envelope' | 'cache';

export interface RelicRow {
  readonly relic_id: string;
  /**
   * Versions this machine has published, from local state. `relic_show`
   * reports what the service holds, which is the same number unless a
   * republish reached the service and failed to record.
   */
  readonly version: number;
  /** Null only when recovery was attempted and failed. */
  readonly filename: string | null;
  readonly filename_basis: FilenameBasis | null;
  /** Null exactly when `filename` is not null. */
  readonly filename_unrecovered_reason: string | null;
  /** The declared mimetype from the envelope, when one was read. */
  readonly mimetype: string | null;
  /** Null when this machine never recorded it, which is most older entries. */
  readonly published_at: string | null;
  /**
   * Null means either no lifetime or nothing recorded. `expires_at_known`
   * says which, so a null is never read as a promise the relic is permanent.
   */
  readonly expires_at: string | null;
  readonly expires_at_known: boolean;
  /** The source description, when this machine recorded where it came from. */
  readonly source: string | null;
  /** Whether `relic_lookup_source` can find this relic. */
  readonly source_indexed: boolean;
  /**
   * The full share URL, fragment included. The fragment is the key, so this
   * row is a credential: anyone who reads it can open the relic.
   */
  readonly share_url: string;
  readonly status: RelicStatus;
  readonly status_basis: StatusBasis;
  readonly status_detail: string;
}

export interface ListInput {
  readonly limit?: number | undefined;
  readonly include_expired?: boolean | undefined;
  readonly verify?: boolean | undefined;
  readonly refresh?: boolean | undefined;
}

export interface ListResult {
  /** Rows returned. */
  readonly count: number;
  /** Relics in local state, before any limit or filter. */
  readonly total: number;
  readonly truncated: boolean;
  /** Rows left out because the service reports them expired. */
  readonly excluded_expired: number;
  /** Entries whose stored shape could not be read at all. */
  readonly unreadable_entries: readonly string[];
  /** How many relics `relic_lookup_source` can currently find. */
  readonly findable_by_source: number;
  readonly recovered_filenames: number;
  /**
   * Opens spent against per-relic download caps by this call. Recovery is
   * cached, so a repeat listing spends none.
   */
  readonly opens_spent: number;
  readonly order: 'first_publish_first_recorded_last';
  readonly relics: readonly RelicRow[];
}

export interface ShowInput {
  readonly relic_id: string;
  readonly include_content?: boolean | undefined;
}

export interface ShowResult extends RelicRow {
  /** Versions the service holds, or null when it could not be asked. */
  readonly versions: number | null;
  /** Plaintext length from the envelope, when one was read. */
  readonly content_bytes: number | null;
  readonly renderer_class: RendererClass | null;
  /** The current content, when asked for and readable as text. */
  readonly content: string | null;
  /** Null exactly when `content` is not null. */
  readonly content_omitted_reason: string | null;
  /** The call that replaces this content, when a source path is recorded. */
  readonly republish_call: {
    readonly name: 'relic_republish';
    readonly arguments: { readonly relic_id: string; readonly path: string };
  } | null;
  readonly key_phrase: string;
}

/**
 * The ceiling on content returned inline.
 *
 * An agent's context is the constraint, not the format's file size cap. Above
 * this the relic is reported with its size and its type and no body, which is
 * still enough to decide what to do; a truncated body would read as the whole
 * file and get republished as one.
 */
export const MAX_INLINE_CONTENT_BYTES = 1024 * 1024;

/** Requests in flight while walking the inventory. */
const PROBE_CONCURRENCY = 6;

export async function listRelics(
  input: ListInput,
  deps: PublishDeps
): Promise<ListResult> {
  const { records, malformed } = await loadPublishInventory();

  // Newest first. The file records relics in publish order, so reversing it
  // is the order Jason published them in. It is not sorted on `published_at`:
  // most entries predate that field, and sorting on a key two thirds of the
  // rows lack would silently reorder them against each other.
  const ordered = [...records].reverse();
  const limit = input.limit;
  const selected =
    limit === undefined || limit >= ordered.length
      ? ordered
      : ordered.slice(0, limit);

  const cache = await loadCachedMetadata();
  const spend = { opens: 0, recovered: 0 };
  const fresh: Record<string, RecoveredMetadata> = {};

  const rows = await mapLimited(selected, PROBE_CONCURRENCY, (record) =>
    buildRow(record, { deps, cache, spend, fresh, input })
  );

  // Written after every row, so one interrupted listing still saves what it
  // recovered instead of spending those opens again next time.
  if (Object.keys(fresh).length > 0) await saveCachedMetadata(fresh);

  const kept =
    input.include_expired === false
      ? rows.filter((row) => row.status !== 'expired')
      : rows;

  return {
    count: kept.length,
    total: records.length,
    truncated: selected.length < ordered.length,
    excluded_expired: rows.length - kept.length,
    unreadable_entries: malformed,
    findable_by_source: records.filter((record) => record.source_indexed)
      .length,
    recovered_filenames: spend.recovered,
    opens_spent: spend.opens,
    order: 'first_publish_first_recorded_last',
    relics: kept,
  };
}

interface RowContext {
  readonly deps: PublishDeps;
  readonly cache: Readonly<Record<string, RecoveredMetadata>>;
  readonly spend: { opens: number; recovered: number };
  readonly fresh: Record<string, RecoveredMetadata>;
  readonly input: ListInput;
}

/**
 * One row, and never an exception.
 *
 * A row that throws is a relic that vanishes from the listing, which is the
 * exact failure this tool exists to prevent: a shortened list reads as "you
 * published fewer things than you did". Every failure becomes a status and a
 * sentence instead.
 */
async function buildRow(
  record: PublishRecord,
  context: RowContext
): Promise<RelicRow> {
  const { state } = record;
  // The fragment is the key, so this row is the credential itself.
  const shareUrl = relicUrl(
    context.deps.relicOrigin,
    record.relic_id,
    decodeKey(state.key)
  );
  const recorded = optionalText(state.filename);
  const cached = context.cache[record.relic_id];
  const usableCache =
    context.input.refresh === true || cached === undefined
      ? undefined
      : cached.version === state.version
        ? cached
        : undefined;

  const needsRecovery = recorded === undefined && usableCache === undefined;
  const wantsMint = needsRecovery || context.input.verify === true;

  const base = {
    relic_id: record.relic_id,
    version: state.version,
    published_at: optionalText(state.published_at) ?? null,
    source: state.source?.description ?? null,
    source_indexed: record.source_indexed,
    share_url: shareUrl,
  };

  const lifetime = recordedLifetime(state);

  if (!wantsMint) {
    // Cheap path: the name is already known, so all that is missing is
    // whether the relic still answers. The comment list is unauthenticated
    // and spends no cap, and it separates removed from unknown from
    // unreachable, which is most of what a listing needs.
    const probe = await probeRecord(record.relic_id, context.deps);
    const name = recorded ?? usableCache?.filename;
    return {
      ...base,
      filename: name ?? null,
      filename_basis: recorded === undefined ? 'cache' : 'recorded',
      filename_unrecovered_reason: null,
      mimetype: usableCache?.mimetype ?? null,
      ...lifetime,
      ...resolveExpiry(probe, lifetime),
    };
  }

  const minted = await mintRelic(record.relic_id, context.deps);
  if (minted.kind === 'failed') {
    return {
      ...base,
      filename: recorded ?? usableCache?.filename ?? null,
      filename_basis:
        recorded !== undefined
          ? 'recorded'
          : usableCache !== undefined
            ? 'cache'
            : null,
      filename_unrecovered_reason:
        recorded !== undefined || usableCache !== undefined
          ? null
          : `the name lives in the relic's encrypted envelope and the ` +
            `service would not serve it: ${minted.detail}`,
      mimetype: usableCache?.mimetype ?? null,
      ...lifetime,
      ...minted.status,
    };
  }

  // A mint was issued, so a unit of this relic's cap is gone whether or not
  // the bytes are fetched. A refused mint spends nothing: every refusal in
  // the mint path returns before the counter is touched.
  context.spend.opens += 1;

  const known = recorded ?? usableCache?.filename;
  if (known !== undefined && context.input.refresh !== true) {
    return {
      ...base,
      filename: known,
      filename_basis: recorded === undefined ? 'cache' : 'recorded',
      filename_unrecovered_reason: null,
      mimetype: usableCache?.mimetype ?? null,
      ...lifetime,
      ...mintedLifetime(minted, lifetime),
      status: 'reachable',
      status_basis: 'mint',
      status_detail: `the service served version ${minted.currentVersion}.`,
    };
  }

  const envelope = await recoverEnvelope(minted.url, state.key, context.deps);
  if (envelope.kind === 'failed') {
    return {
      ...base,
      filename: null,
      filename_basis: null,
      filename_unrecovered_reason: envelope.detail,
      mimetype: null,
      ...lifetime,
      ...mintedLifetime(minted, lifetime),
      status: 'reachable',
      status_basis: 'mint',
      status_detail:
        `the service served version ${minted.currentVersion}, but its ` +
        'envelope did not open here.',
    };
  }

  context.spend.recovered += 1;
  context.fresh[record.relic_id] = {
    version: minted.currentVersion,
    filename: envelope.filename,
    mimetype: envelope.mimetype,
    content_bytes: envelope.contentBytes,
  };

  return {
    ...base,
    filename: envelope.filename,
    filename_basis: 'envelope',
    filename_unrecovered_reason: null,
    mimetype: envelope.mimetype,
    ...lifetime,
    ...mintedLifetime(minted, lifetime),
    status: 'reachable',
    status_basis: 'mint',
    status_detail: `the service served version ${minted.currentVersion}.`,
  };
}

export async function showRelic(
  input: ShowInput,
  deps: PublishDeps
): Promise<ShowResult> {
  const state = await requireLocalState(input.relic_id);
  const { records } = await loadPublishInventory();
  const record = records.find((entry) => entry.relic_id === input.relic_id);
  const shareUrl = relicUrl(
    deps.relicOrigin,
    input.relic_id,
    decodeKey(state.key)
  );
  const lifetime = recordedLifetime(state);
  const base = {
    relic_id: input.relic_id,
    version: state.version,
    published_at: optionalText(state.published_at) ?? null,
    source: state.source?.description ?? null,
    source_indexed: record?.source_indexed ?? false,
    share_url: shareUrl,
    key_phrase: keyToMnemonic(decodeKey(state.key)).join(' '),
    republish_call:
      state.source === undefined
        ? null
        : ({
            name: 'relic_republish',
            arguments: { relic_id: input.relic_id, path: state.source.path },
          } as const),
  };

  const minted = await mintRelic(input.relic_id, deps);
  if (minted.kind === 'failed') {
    const recorded = optionalText(state.filename);
    return {
      ...base,
      filename: recorded ?? null,
      filename_basis: recorded === undefined ? null : 'recorded',
      filename_unrecovered_reason:
        recorded === undefined
          ? `the name lives in the relic's encrypted envelope and the ` +
            `service would not serve it: ${minted.detail}`
          : null,
      mimetype: null,
      ...lifetime,
      ...minted.status,
      versions: null,
      content_bytes: null,
      renderer_class: null,
      content: null,
      content_omitted_reason: `the service would not serve it: ${minted.detail}`,
    };
  }

  const row = {
    ...base,
    ...lifetime,
    ...mintedLifetime(minted, lifetime),
    status: 'reachable' as const,
    status_basis: 'mint' as const,
    status_detail: `the service served version ${minted.currentVersion}.`,
    versions: minted.currentVersion,
  };

  if (input.include_content !== true) {
    const envelope = await recoverEnvelope(minted.url, state.key, deps);
    const recorded = optionalText(state.filename);
    return {
      ...row,
      filename:
        envelope.kind === 'read' ? envelope.filename : (recorded ?? null),
      filename_basis:
        envelope.kind === 'read'
          ? 'envelope'
          : recorded === undefined
            ? null
            : 'recorded',
      filename_unrecovered_reason:
        envelope.kind === 'read' || recorded !== undefined
          ? null
          : envelope.detail,
      mimetype: envelope.kind === 'read' ? envelope.mimetype : null,
      content_bytes: envelope.kind === 'read' ? envelope.contentBytes : null,
      renderer_class: null,
      content: null,
      content_omitted_reason:
        'include_content was not set, so only the envelope was read.',
    };
  }

  // Refuse before allocating, from the object length and the record size,
  // the same bound the viewer uses. A relic too large to hand an agent is
  // still worth reporting the size of.
  const upperBound = plaintextSizeUpperBound(minted.objectLength);
  if (upperBound > MAX_INLINE_CONTENT_BYTES) {
    const envelope = await recoverEnvelope(minted.url, state.key, deps);
    const recorded = optionalText(state.filename);
    return {
      ...row,
      filename:
        envelope.kind === 'read' ? envelope.filename : (recorded ?? null),
      filename_basis:
        envelope.kind === 'read'
          ? 'envelope'
          : recorded === undefined
            ? null
            : 'recorded',
      filename_unrecovered_reason:
        envelope.kind === 'read' || recorded !== undefined
          ? null
          : envelope.detail,
      mimetype: envelope.kind === 'read' ? envelope.mimetype : null,
      content_bytes: envelope.kind === 'read' ? envelope.contentBytes : null,
      renderer_class: null,
      content: null,
      content_omitted_reason:
        `the content is up to ${upperBound} bytes, over the ` +
        `${MAX_INLINE_CONTENT_BYTES}-byte inline ceiling. Republishing it ` +
        'would need the file, not this text.',
    };
  }

  let opened: { filename: string; mimetype: string; content: Uint8Array };
  try {
    const response = await deps.fetch(minted.url);
    if (!response.ok) {
      throw new Error(`storage returned ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const relic = await openRelic(bytes, decodeKey(state.key));
    const entry = relic.envelope.entries[0];
    if (entry === undefined) throw new Error('the envelope carried no entry');
    opened = {
      filename: entry.filename,
      mimetype: entry.mimetype,
      content: relic.content,
    };
  } catch (error) {
    const recorded = optionalText(state.filename);
    return {
      ...row,
      filename: recorded ?? null,
      filename_basis: recorded === undefined ? null : 'recorded',
      filename_unrecovered_reason:
        recorded === undefined ? (error as Error).message : null,
      mimetype: null,
      content_bytes: null,
      renderer_class: null,
      content: null,
      content_omitted_reason:
        'the relic was served but did not open here: ' +
        `${(error as Error).message}`,
    };
  }

  const rendererClass = deriveRendererClass(opened.content, opened.filename);
  const text = asText(opened.content);

  return {
    ...row,
    filename: opened.filename,
    filename_basis: 'envelope',
    filename_unrecovered_reason: null,
    mimetype: opened.mimetype,
    content_bytes: opened.content.length,
    renderer_class: rendererClass,
    content: text,
    content_omitted_reason:
      text === null
        ? `the content is ${opened.content.length} bytes that are not valid ` +
          `UTF-8, so it is bytes rather than text. Its class is ` +
          `${rendererClass}.`
        : null,
  };
}

/**
 * Decode as text, or refuse.
 *
 * Fatal decoding, so a binary payload is reported as binary rather than
 * handed back peppered with replacement characters. An agent that edited
 * those and republished would corrupt every byte the decoder guessed at.
 */
function asText(content: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

interface MintOk {
  readonly kind: 'ok';
  readonly url: string;
  readonly currentVersion: number;
  readonly objectLength: number;
  readonly relicExpiresAt: string | null;
}

interface MintFailed {
  /**
   * One kind rather than one per outcome. What the caller does with a failed
   * mint is identical either way, and the difference that matters, whether
   * the service said something about the relic or said nothing at all, is
   * already carried in `status`.
   */
  readonly kind: 'failed';
  readonly detail: string;
  readonly status: {
    readonly status: RelicStatus;
    readonly status_basis: StatusBasis;
    readonly status_detail: string;
  };
}

/**
 * The metered probe: authoritative, and it spends one of the relic's opens.
 *
 * Exported because it is the one service answer that carries the current
 * version, and the comment read needs the same source `relic_show` uses when
 * it scopes a thread by default. A caller that does not need it must not pay
 * for it.
 */
export async function mintRelic(
  relicId: string,
  deps: PublishDeps
): Promise<MintOk | MintFailed> {
  let response: Response;
  try {
    response = await deps.fetch(
      `${deps.serviceOrigin}/api/relics/${relicId}/mint`,
      { method: 'POST' }
    );
  } catch (error) {
    return unreachable(
      `the service could not be reached: ${(error as Error).message}`
    );
  }

  const body = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;

  if (!response.ok) {
    const code = typeof body?.['code'] === 'string' ? body['code'] : 'unknown';
    const mapped = STATUS_BY_CODE[code];
    if (mapped === undefined) {
      return unreachable(
        `the service refused with ${response.status} ${code}, which this ` +
          'client does not recognize, so nothing is claimed about the relic.'
      );
    }
    return {
      kind: 'failed',
      detail: `${code} (${mapped.detail})`,
      status: {
        status: mapped.status,
        status_basis: 'mint',
        status_detail: `the service refused with ${code}: ${mapped.detail}`,
      },
    };
  }

  const url = body?.['url'];
  const currentVersion = body?.['current_version'];
  const objectLength = body?.['object_length'];
  if (
    typeof url !== 'string' ||
    typeof currentVersion !== 'number' ||
    typeof objectLength !== 'number'
  ) {
    return unreachable(
      'the mint response was missing the url, version, or length, so there ' +
        'is no way to tell a served relic from an unreadable answer.'
    );
  }

  const expiry = body?.['relic_expires_at'];
  return {
    kind: 'ok',
    url,
    currentVersion,
    objectLength,
    relicExpiresAt: typeof expiry === 'string' ? expiry : null,
  };
}

function unreachable(detail: string): MintFailed {
  return {
    kind: 'failed',
    detail,
    status: {
      status: 'unreachable',
      status_basis: 'mint',
      // Said outright, because an unreachable row is the one case where the
      // absence of news is about the network. Reading it as a dead relic
      // would retire something that is still live.
      status_detail: `${detail} This says nothing about whether the relic is still there.`,
    },
  };
}

/**
 * The service's refusal codes, and what each one means for the publisher.
 *
 * Taken from the mint path in `spec/service.md`: the viewer maps the same
 * codes for a recipient, and this maps them for the person who published,
 * whose next move is different for every one of them.
 */
const STATUS_BY_CODE: Readonly<
  Record<string, { status: RelicStatus; detail: string }>
> = {
  relic_removed: {
    status: 'removed',
    detail:
      'it was taken down, permanently; republishing cannot revive it whatever ' +
      'token is presented',
  },
  relic_expired: {
    status: 'expired',
    detail: 'its lifetime has passed and cannot be extended',
  },
  relic_not_found: {
    status: 'not_found',
    detail:
      'the service has no record of it, so this machine holds a key for ' +
      'something it can no longer reach',
  },
  relic_never_published: {
    status: 'never_published',
    detail: 'a grant was issued and the bytes never landed',
  },
  relic_not_yet_published: {
    status: 'not_yet_published',
    detail: 'the upload is still in flight; this is temporary',
  },
  download_cap_exhausted: {
    status: 'cap_exhausted',
    detail:
      'its opens are used up, so the content is intact and nobody can fetch ' +
      'it; waiting does not help',
  },
  mint_rate_limited: {
    status: 'rate_limited',
    detail: 'this client is being rate limited, not the relic being gone',
  },
  service_paused: {
    status: 'service_paused',
    detail: 'the service is not serving relics at all right now',
  },
  invalid_relic_id: {
    status: 'not_found',
    detail: 'the service rejected the id as malformed',
  },
};

interface RecordProbe {
  readonly status: RelicStatus;
  readonly status_basis: StatusBasis;
  readonly status_detail: string;
}

/**
 * The free probe: does the service still have a record of this relic.
 *
 * The comment list is unauthenticated by design and spends no download cap,
 * which makes it the only way to ask about a relic without costing it an
 * open. It answers less than a mint: a record exists, or the relic was
 * removed, or the service has never heard of it. It cannot see an expiry,
 * which is why a recorded lifetime is checked against the clock separately
 * and an unrecorded one is reported as unknown rather than assumed absent.
 */
async function probeRecord(
  relicId: string,
  deps: PublishDeps
): Promise<RecordProbe> {
  try {
    await getJson(deps, `${deps.serviceOrigin}/api/relics/${relicId}/comments`);
    return {
      status: 'reachable',
      status_basis: 'record',
      status_detail:
        'the service holds a record of it and has not removed it. Checked ' +
        'without spending one of its opens, so this does not prove the ' +
        'bytes still serve.',
    };
  } catch (error) {
    if (error instanceof PublishError) {
      return {
        status: 'unreachable',
        status_basis: 'record',
        status_detail: `${error.message}. This says nothing about whether the relic is still there.`,
      };
    }
    if (error instanceof ServerRefusal) {
      const mapped = STATUS_BY_CODE[error.code];
      if (mapped !== undefined) {
        return {
          status: mapped.status,
          status_basis: 'record',
          status_detail: `the service refused with ${error.code}: ${mapped.detail}`,
        };
      }
      return {
        status: 'unreachable',
        status_basis: 'record',
        status_detail:
          `the service refused with ${error.status} ${error.code}, which ` +
          'this client does not recognize. This says nothing about whether ' +
          'the relic is still there.',
      };
    }
    return {
      status: 'unreachable',
      status_basis: 'record',
      status_detail:
        `the check failed: ${(error as Error).message}. This says nothing ` +
        'about whether the relic is still there.',
    };
  }
}

interface RecoveredEnvelope {
  readonly kind: 'read';
  readonly filename: string;
  readonly mimetype: string;
  readonly contentBytes: number;
}

interface FailedEnvelope {
  readonly kind: 'failed';
  readonly detail: string;
}

/**
 * Recover the name from the relic itself.
 *
 * One range request for the plaintext header plus record 0, which is where
 * the envelope lives and why record 0 is padded to a full record. It is 64 KB
 * rather than the whole object, so recovering a name from a 40 MB relic costs
 * 64 KB.
 *
 * The record size is read from the header rather than assumed, and a header
 * declaring a larger record than this build's default is refetched at the
 * declared size. Assuming it would report a perfectly good relic as
 * unrecoverable the day the default changes.
 */
async function recoverEnvelope(
  url: string,
  encodedKey: string,
  deps: PublishDeps
): Promise<RecoveredEnvelope | FailedEnvelope> {
  try {
    const key = decodeKey(encodedKey);
    const requested = envelopePrefixLength();
    let prefix = await fetchRange(url, requested, deps);
    // The record size comes from the header the container carries, never from
    // this build's default: a relic written with a larger record would
    // otherwise arrive truncated and read as unrecoverable, which is a lie
    // about a perfectly good relic. A body shorter than the range asked for
    // is the whole object, so there is nothing more to ask for.
    const wanted = HEADER_BYTES + decodeHeader(prefix).rs;
    if (wanted > requested && prefix.length === requested) {
      prefix = await fetchRange(url, wanted, deps);
    }

    const envelope = await openEnvelope(prefix, key);
    const entry = envelope.entries[0];
    if (entry === undefined) {
      return { kind: 'failed', detail: 'the envelope carried no entry.' };
    }
    return {
      kind: 'read',
      filename: entry.filename,
      mimetype: entry.mimetype,
      contentBytes: entry.length,
    };
  } catch (error) {
    return {
      kind: 'failed',
      detail:
        "the relic's envelope did not open under the key this machine " +
        `holds: ${(error as Error).message}`,
    };
  }
}

async function fetchRange(
  url: string,
  length: number,
  deps: PublishDeps
): Promise<Uint8Array> {
  const response = await deps.fetch(url, {
    headers: { range: `bytes=0-${length - 1}` },
  });
  if (!response.ok) {
    throw new Error(`storage returned ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The lifetime this machine recorded, and whether it recorded one at all. */
function recordedLifetime(state: PublishState): {
  expires_at: string | null;
  expires_at_known: boolean;
} {
  const recorded = state.expires_at;
  if (recorded === undefined) {
    return { expires_at: null, expires_at_known: false };
  }
  return {
    expires_at: typeof recorded === 'string' ? recorded : null,
    expires_at_known: true,
  };
}

/** The service's own answer wins over the recorded one, which cannot change. */
function mintedLifetime(
  minted: MintOk,
  recorded: { expires_at: string | null; expires_at_known: boolean }
): { expires_at: string | null; expires_at_known: boolean } {
  if (minted.relicExpiresAt !== null) {
    return { expires_at: minted.relicExpiresAt, expires_at_known: true };
  }
  // A served relic answering null has no lifetime, which is knowledge the
  // recorded value cannot contradict: a lifetime is fixed at first grant.
  return recorded.expires_at === null
    ? { expires_at: null, expires_at_known: true }
    : recorded;
}

/**
 * A recorded lifetime that has passed, when the cheap probe cannot see one.
 *
 * The comment list answers for a relic whose lifetime ran out, because the
 * record outlives the content. Checking the recorded expiry against the clock
 * is what stops a listing calling an expired relic reachable.
 */
function resolveExpiry(
  probe: RecordProbe,
  lifetime: { expires_at: string | null; expires_at_known: boolean }
): RecordProbe {
  if (probe.status !== 'reachable' || lifetime.expires_at === null) {
    return probe;
  }
  const deadline = Date.parse(lifetime.expires_at);
  if (Number.isNaN(deadline) || deadline > Date.now()) return probe;
  return {
    status: 'expired',
    status_basis: 'local',
    status_detail:
      `the lifetime this machine recorded ran out at ${lifetime.expires_at}. ` +
      'The service still holds a record, which outlives the content.',
  };
}

/**
 * A recorded string, or nothing.
 *
 * An empty filename is legal in the envelope and means the viewer names the
 * download from the relic id, so an empty recorded name is no name at all
 * and recovery should run rather than reporting a blank.
 */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The machine boundary, checked before anything touches the network.
 *
 * Identical in kind to the one comments and republish draw, and it has to be:
 * the key that opens a relic lives here or nowhere this client can reach.
 */
async function requireLocalState(relicId: string): Promise<PublishState> {
  if (!isValidRelicId(relicId)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${relicId}" is not a relic id. This tool takes the 26-character id a ` +
        'publish returned, never the share URL: the URL carries the key in ' +
        'its fragment, and passing it would put the key in this transcript ' +
        'for nothing. Call relic_list to see the ids this machine holds.'
    );
  }
  try {
    const loaded = await loadPublishState(relicId);
    if (loaded === undefined) {
      throw new PublishError(
        'no_local_publish_state',
        `relic ${relicId} was published from another machine, so it cannot ` +
          'be read back here. The key that decrypts it lives only on the ' +
          'machine that published it, and it cannot be reconstructed from ' +
          "the link or from the service. Open the relic's own page instead."
      );
    }
    return loaded;
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }
}

/**
 * Map with a bounded number of requests in flight.
 *
 * Forty one relics one at a time is a listing nobody waits for, and forty one
 * at once is a burst against a rate limit the service applies per IP. The
 * result order matches the input, because the listing order is the answer.
 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        out[index] = await run(item);
      }
    })()
  );
  await Promise.all(workers);
  return out;
}
