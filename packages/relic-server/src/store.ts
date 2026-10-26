/**
 * The server's record of a relic's life.
 *
 * The server holds only ciphertext and metadata, plus optional unencrypted
 * cover images stored in object storage for link previews. Nothing here is
 * finer than the ten-value renderer class and the publishing client name,
 * which is the whole of what the frame conceded (`spec/format.md` 3.2).
 * A filename or a declared mimetype appearing in this file is drift.
 */

import type { DecisionVerdict, RendererClass } from '@relic/format';
import type { CoverKind, CoverType } from '@relic/format/cover';
import { sha256Hex } from './gcs.ts';
import { ProblemError } from './problems.ts';

export type { DecisionVerdict };

export function normalizeEmail(value: string): string {
  return value.trim().replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

export function looksLikeEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}
/** Why a relic was removed. Private; the public code is always the same. */
export type ReasonClass =
  | 'abuse'
  | 'legal'
  | 'blocklist_match'
  | 'operator_error';

export interface RelicCover {
  readonly version: number;
  readonly sha256: string /* lowercase hex of stored bytes */;
  readonly type: CoverType;
  readonly kind: CoverKind;
  readonly bytes: number;
  readonly uploadedAt: number;
}

export interface RelicRow {
  readonly id: string;
  readonly publishIp: string;
  /** The app server's own clock. The publishing client's is never trusted. */
  readonly grantedAt: number;
  /**
   * When the publisher asked for a lifetime. Undefined means the relic never
   * expires on its own; only deletion ends it.
   */
  readonly expiresAt: number | undefined;
  readonly rendererClass: RendererClass;
  readonly publishingClient: string;
  readonly declaredSizeBytes: number;
  /**
   * Which version of the ciphertext the row serves, 1-based. Version 1 is
   * the original grant's upload; every republish increments. The number
   * never resets, and the cap counts across all of it, so a republished
   * relic cannot buy fresh egress.
   */
  readonly version: number;
  /**
   * SHA-256 of the publish token, hex. The token itself leaves the server
   * exactly once, in the first grant response, and possession of it is the
   * only way to republish. The store is a bucket of JSON documents, so what
   * lands here must not be replayable as that credential.
   */
  readonly publishTokenHash: string;
  /** Set when the object actually lands. Absent means granted, never filled. */
  publishedAt?: number | undefined;
  objectLength?: number | undefined;
  objectCrc32c?: string | undefined;
  /** Mints consumed against the per-relic cap, across all versions. */
  mintsUsed: number;
  /**
   * A plaintext field about a relic the service holds. Publisher-declared,
   * stored in the clear so previews show a human-chosen name rather than a
   * blank card. A removal must take it with the row.
   */
  title?: string | undefined;
  /**
   * Verified email address of the relic's creator, if provided at publish/republish.
   * Used to notify the creator when comments arrive.
   */
  ownerEmail?: string | undefined;
  cover?: RelicCover | undefined;
  /**
   * True from a republish that asked for change notices (the default) until
   * claimVersionNotice consumes it. Absent on version 1, legacy rows, and after notify: false.
   */
  readonly noticePending?: boolean | undefined;
  readonly shareVerifier?: string | undefined;
  /**
   * Number of enrolled share addresses reserved against the per-relic cap.
   * Advanced atomically via compare-and-swap when reserving share capacity.
   */
  sharesCount?: number | undefined;
  versionDigests?: Readonly<Record<string, string>> | undefined;
}

export interface DecisionRow {
  readonly id: string;
  readonly relicId: string;
  readonly version: number;
  readonly verdict: DecisionVerdict;
  readonly author: string;
  readonly createdAt: number;
  readonly versionDigest: string;
  readonly credentialId: string;
}

export interface PasskeyCredential {
  readonly credentialId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly alg: -7 | -257;
  readonly signCount: number;
  readonly transports?: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly registeredWith?: string;
}

export interface PasskeyRecord {
  readonly email: string;
  readonly address?: string;
  readonly userHandle: string;
  readonly credentials: readonly PasskeyCredential[];
}

export interface WebauthnChallengeRow {
  readonly challengeHash: string;
  /**
   * The normalized address; absent only on a usernameless `sign_in` challenge.
   */
  readonly email?: string;
  readonly purpose: 'register' | 'enroll' | 'decide' | 'sign_in';
  readonly expiresAt: number;
  readonly userHandle?: string;
  readonly assertedBy?: string;
  readonly relicId?: string;
  readonly version?: number;
  readonly verdict?: DecisionVerdict;
}

export interface ShareRow {
  readonly relicId: string;
  /** trimmed, lowercased */
  readonly email: string;
  readonly addedAt: number;
  readonly sharedBy: 'publisher' | 'reader';
}

export interface OptOutRow {
  readonly relicId: string;
  /** sha256 hex of the normalized address */
  readonly addressHash: string;
  readonly at: number;
}

export interface Tombstone {
  readonly id: string;
  readonly publishIp: string;
  readonly publishedAt: number | undefined;
  readonly publishingClient: string;
  readonly rendererClass: RendererClass;
  readonly ciphertextHash: string;
  readonly deletedAt: number;
  readonly operator: string;
  readonly reasonClass: ReasonClass;
  readonly reportReference: string | undefined;
}

/**
 * One record per mint attempt, granted or refused.
 *
 * `spec/service.md` 1.2: cap exhaustion, expiry, and all three flavors of
 * deletion share one HTTP status, so no view that groups by status can ever
 * tell them apart. This record is where the distinction survives, which is
 * why every dashboard and alert keys on `code` rather than on the status.
 */
export interface MintLogEntry {
  readonly relicId: string;
  readonly ip: string;
  readonly at: number;
  readonly endpoint: string;
  readonly outcome: 'granted' | 'refused';
  readonly code: string | undefined;
  readonly countedAsOpen: boolean;
  /** Which rule dropped it, when it was not counted. */
  readonly dropReason:
    | 'publishing_ip_match'
    | 'post_publish_window'
    | 'dedup'
    | 'refused'
    | undefined;
  readonly consumedCap: boolean;
  readonly capRemaining: number;
  readonly occurrenceId: string;
}

export interface AbuseReport {
  readonly relicId: string;
  readonly category:
    | 'malware'
    | 'phishing'
    | 'csam'
    | 'copyright'
    | 'legal_process'
    | 'other';
  readonly description: string;
  readonly contact: string | undefined;
  readonly authority: string | undefined;
  readonly reference: string | undefined;
  readonly receivedAt: number;
}

/**
 * One comment on one relic.
 *
 * `ciphertext` is opaque. `format.md` 3.13 puts the comment key behind the
 * fragment, which never reaches the server, so this field cannot be read
 * here and must not be validated as anything but base64url. The caps on the
 * plaintext are enforced by `@relic/format` before encryption, and there is
 * no way to re-check them from this side.
 *
 * `author` is the whole of the participation record: a verified email
 * address for a human, or the literal `publisher` for a comment authorized
 * by the publish token. `frame.md`'s identity entry names holding this as a
 * real cost rather than a free one, so nothing beyond it is stored.
 */
export interface CommentRow {
  readonly id: string;
  readonly relicId: string;
  readonly author: string;
  readonly createdAt: number;
  readonly ciphertext: string;
  readonly version?: number | undefined;
  /**
   * Optional service-minted id of the comment this one answers.
   * Provided in the clear as a routing hint for notifications.
   * Never returned on public comment reads; the sealed copy in ciphertext is authoritative.
   */
  readonly addresses?: string | undefined;
  /**
   * When the sealed body was last replaced, in epoch millis like
   * `createdAt`. There is no edit history (`frame.md`): the service holds
   * one ciphertext per comment and an edit overwrites it, so the honest
   * record is that an edit happened, not what it replaced. Absent until the
   * first edit.
   */
  readonly editedAt?: number | undefined;
  /**
   * When the comment was marked resolved, and by whom. Deliberately clear
   * data: the resolution decides whether a republish is blocked, which the
   * service answers before any key exists on its side, so the operator
   * learns that a comment was settled and by which address and still
   * cannot read a word of it.
   */
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
}

/**
 * A change to a comment after the fact.
 *
 * `undefined` on a field means leave it alone; only `resolved` uses an
 * explicit null, to mean clear it. A two-way boolean cannot express "leave
 * any resolution alone" and "clear it" apart, and an edit and its stamp are
 * one fact, so the caller stamps `editedAt` alongside the new ciphertext
 * rather than the store guessing at a clock.
 */
export interface CommentPatch {
  /** Replaces the sealed body. */
  readonly ciphertext?: string;
  /** Stamped with `ciphertext` by the caller, never cleared by either. */
  readonly editedAt?: number;
  /** An object sets the resolution, null clears it, undefined leaves it. */
  readonly resolved?: { readonly at: number; readonly by: string } | null;
}

/**
 * Merge a patch into a comment row, returning a new row. Pure, and shared
 * by both stores so the merge rules (in particular: clearing a resolution
 * must not touch the edit stamp, and clearing omits the keys rather than
 * writing nulls) cannot drift between memory and GCS.
 */
export function applyCommentPatch(
  row: CommentRow,
  patch: CommentPatch
): CommentRow {
  let next: CommentRow = {
    ...row,
    ...(patch.ciphertext !== undefined ? { ciphertext: patch.ciphertext } : {}),
    ...(patch.editedAt !== undefined ? { editedAt: patch.editedAt } : {}),
  };
  if (patch.resolved !== undefined) {
    if (patch.resolved === null) {
      const { resolvedAt: _at, resolvedBy: _by, ...cleared } = next;
      next = cleared;
    } else {
      next = {
        ...next,
        resolvedAt: patch.resolved.at,
        resolvedBy: patch.resolved.by,
      };
    }
  }
  return next;
}

/** Summary of an author's engagement with a relic. */
export interface CommentedRelic {
  readonly relicId: string;
  readonly lastCommentAt: number;
}

/**
 * A verified email session, minted by following a magic link.
 *
 * The link's token is single use and short lived; the session that replaces
 * it is the thing a browser carries. Both are stored hashed, so this file
 * cannot hand anybody a replayable credential.
 */
export interface SessionRow {
  readonly tokenHash: string;
  readonly email: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A pending magic link, before anybody has followed it. */
export interface AuthLinkRow {
  readonly tokenHash: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly returnTo: string;
}

interface Challenge {
  readonly nonce: string;
  readonly issuedAt: number;
  readonly ip: string;
}

export interface DedupEntry {
  readonly url: string;
  readonly urlExpiresAt: number;
  readonly at: number;
  /**
   * The relic version the stored URL was signed for. A mint after a
   * republish is a first look at new content, not a reload, so an entry
   * from an older version no longer dedupes. Optional because entries
   * written before versions existed carry none, and those degrade the
   * safe way: one open counted once, then the entry is overwritten.
   */
  readonly version?: number;
}

/**
 * The store, as an interface so tests run against memory and production runs
 * against a real database without the routes knowing which.
 */
export interface RelicStore {
  getRelic(id: string): Promise<RelicRow | undefined>;
  putRelic(row: RelicRow): Promise<void>;
  markPublished(
    id: string,
    at: number,
    objectLength: number,
    crc32c: string
  ): Promise<void>;
  consumeMint(id: string): Promise<number>;
  putCover(
    id: string,
    cover: RelicCover,
    bytes: Uint8Array
  ): Promise<'stored' | 'stale_version' | 'not_found'>;
  getCoverBytes(id: string, sha256: string): Promise<Uint8Array | undefined>;
  listCovers(id: string): Promise<readonly string[]>; // sha256 of every stored object for id
  deleteCovers(id: string): Promise<number>; // deletes every object, clears row.cover by CAS, returns the count

  /**
   * Open the relic's next version: increment `version`, adopt the new
   * renderer class and declared size, and clear the publish markers so the
   * row says about the new version exactly what it says after a first
   * grant. Returns the updated row, or undefined if the relic is gone.
   */
  beginVersion(
    id: string,
    rendererClass: RendererClass,
    declaredSizeBytes: number,
    titleUpdate?: { readonly title: string | undefined },
    ownerUpdate?: { readonly ownerEmail: string | undefined },
    noticePending?: boolean,
    shareVerifierUpdate?: { readonly shareVerifier: string }
  ): Promise<RelicRow | undefined>;
  claimVersionNotice(
    id: string,
    version: number
  ): Promise<RelicRow | undefined>;
  putShare(row: ShareRow): Promise<boolean>;
  listShares(relicId: string): Promise<readonly ShareRow[]>;
  deleteSharesForRelic(relicId: string): Promise<number>;
  putOptOut(row: OptOutRow): Promise<void>;
  listOptOuts(relicId: string): Promise<readonly string[]>;
  deleteOptOutsForRelic(relicId: string): Promise<number>;
  isOptedOut(relicId: string, addressHash: string): Promise<boolean>;
  reserveShares(
    relicId: string,
    count: number,
    maxLimit: number
  ): Promise<{ allowed: boolean; currentCount: number }>;
  releaseShares(relicId: string, count: number): Promise<void>;
  unsubscribeKey(): Promise<Uint8Array>;
  getTombstone(id: string): Promise<Tombstone | undefined>;
  putTombstone(stone: Tombstone): Promise<void>;

  issueChallenge(ip: string, now: number): Promise<string>;
  consumeChallenge(nonce: string, now: number, ttl: number): Promise<boolean>;

  appendMintLog(entry: MintLogEntry): Promise<void>;
  readMintLog(): Promise<readonly MintLogEntry[]>;

  recentMint(
    id: string,
    ip: string,
    now: number,
    windowSeconds: number
  ): Promise<DedupEntry | undefined>;
  rememberMint(id: string, ip: string, entry: DedupEntry): Promise<void>;

  isBlocklisted(hash: string): Promise<boolean>;
  blocklist(hash: string): Promise<void>;

  putAbuseReport(report: AbuseReport): Promise<void>;
  readAbuseReports(): Promise<readonly AbuseReport[]>;

  putComment(row: CommentRow): Promise<void>;
  getComment(
    relicId: string,
    commentId: string
  ): Promise<CommentRow | undefined>;
  /** Oldest first, which is the order a thread is read in. */
  listComments(relicId: string): Promise<readonly CommentRow[]>;
  deleteComment(relicId: string, commentId: string): Promise<void>;
  /**
   * Apply a patch to one comment and return the updated row, or undefined
   * if the comment is gone. Concurrent writers must lose to each other
   * loudly where the store can tell, never silently overwrite.
   */
  updateComment(
    relicId: string,
    commentId: string,
    patch: CommentPatch
  ): Promise<CommentRow | undefined>;
  /**
   * Every comment on a relic, removed together with it. A comment outliving
   * the thing it comments on is a retention defect, not a leftover.
   */
  deleteCommentsForRelic(relicId: string): Promise<number>;
  /**
   * Relics an author has commented on, ordered by most recent engagement first.
   * Scoped strictly to the author address.
   */
  listCommentedRelics(author: string): Promise<readonly CommentedRelic[]>;

  putAuthLink(row: AuthLinkRow): Promise<void>;
  listCommenters(relicId: string): Promise<readonly string[]>;
  deleteCommenter(relicId: string, author: string): Promise<void>;
  /** Single use: reading it consumes it, whether or not it had expired. */
  consumeAuthLink(tokenHash: string): Promise<AuthLinkRow | undefined>;
  putSession(row: SessionRow): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRow | undefined>;
  hasVerifiedIdentity(email: string): Promise<boolean>;
  recordVerifiedIdentity(email: string, at?: number): Promise<void>;
  appendDecision(row: DecisionRow): Promise<void>;
  listDecisions(relicId: string): Promise<readonly DecisionRow[]>;
  deleteDecisionsForRelic(relicId: string): Promise<number>;
  deleteDecision(relicId: string, decisionId: string): Promise<boolean>;
  recordVersionDigest(
    id: string,
    version: number,
    sha256: string
  ): Promise<string | undefined>;
  getPasskeys(email: string): Promise<PasskeyRecord | undefined>;
  createPasskeys(record: PasskeyRecord): Promise<boolean>;
  updatePasskeys(
    email: string,
    change: (r: PasskeyRecord) => PasskeyRecord
  ): Promise<PasskeyRecord | undefined>;
  putWebauthnChallenge(row: WebauthnChallengeRow): Promise<void>;
  consumeWebauthnChallenge(
    challengeHash: string
  ): Promise<WebauthnChallengeRow | undefined>;
  getPasskeysByUserHandle(
    userHandle: string
  ): Promise<PasskeyRecord | undefined>;
  passkeyDecoyKey(): Promise<Uint8Array>;
}

export class MemoryStore implements RelicStore {
  private readonly relics = new Map<string, RelicRow>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly mintLog: MintLogEntry[] = [];
  private readonly dedup = new Map<string, DedupEntry>();
  private readonly blocked = new Set<string>();
  private readonly reports: AbuseReport[] = [];
  private readonly comments = new Map<string, CommentRow[]>();
  private readonly authLinks = new Map<string, AuthLinkRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly verifiedEmails = new Set<string>();
  private readonly covers = new Map<
    string,
    Map<string, { bytes: Uint8Array; type: CoverType }>
  >();
  private readonly shares = new Map<string, Map<string, ShareRow>>();
  private readonly optOuts = new Map<string, Map<string, OptOutRow>>();
  private unsubscribeSecret: Uint8Array | undefined;
  private readonly commenters = new Map<string, Map<string, string>>();
  private readonly commenterMarkers = new Set<string>();
  private readonly decisions = new Map<string, Map<string, DecisionRow>>();
  private readonly passkeys = new Map<string, PasskeyRecord>();
  private readonly webauthnChallenges = new Map<string, WebauthnChallengeRow>();
  private readonly passkeyHandles = new Map<string, string>();
  private passkeyDecoySecret: Uint8Array | undefined;
  async getRelic(id: string): Promise<RelicRow | undefined> {
    return this.relics.get(id);
  }
  async beginVersion(
    id: string,
    rendererClass: RendererClass,
    declaredSizeBytes: number,
    titleUpdate?: { readonly title: string | undefined },
    ownerUpdate?: { readonly ownerEmail: string | undefined },
    noticePending?: boolean,
    shareVerifierUpdate?: { readonly shareVerifier: string }
  ): Promise<RelicRow | undefined> {
    const row = this.relics.get(id);
    if (row === undefined) return undefined;
    const nextTitle = titleUpdate !== undefined ? titleUpdate.title : row.title;
    const nextOwnerEmail =
      ownerUpdate !== undefined ? ownerUpdate.ownerEmail : row.ownerEmail;
    const nextShareVerifier =
      shareVerifierUpdate !== undefined
        ? shareVerifierUpdate.shareVerifier
        : row.shareVerifier;
    const { noticePending: _priorPending, ...restRow } = row;
    const next: RelicRow = {
      ...restRow,
      version: row.version + 1,
      rendererClass,
      declaredSizeBytes,
      publishedAt: undefined,
      objectLength: undefined,
      objectCrc32c: undefined,
      cover: undefined,
      title: nextTitle,
      ownerEmail: nextOwnerEmail,
      shareVerifier: nextShareVerifier,
      ...(noticePending === true ? { noticePending: true } : {}),
    };
    this.relics.set(id, next);
    return next;
  }

  async claimVersionNotice(
    id: string,
    version: number
  ): Promise<RelicRow | undefined> {
    const row = this.relics.get(id);
    if (row === undefined) return undefined;
    if (row.version !== version || row.noticePending !== true) return undefined;
    const { noticePending: _pending, ...restRow } = row;
    const next: RelicRow = {
      ...restRow,
    };
    this.relics.set(id, next);
    return next;
  }

  async putShare(row: ShareRow): Promise<boolean> {
    let map = this.shares.get(row.relicId);
    if (map === undefined) {
      map = new Map();
      this.shares.set(row.relicId, map);
    }
    if (map.has(row.email)) return false;
    map.set(row.email, row);
    return true;
  }

  async listShares(relicId: string): Promise<readonly ShareRow[]> {
    const map = this.shares.get(relicId);
    if (map === undefined) return [];
    return [...map.values()].sort(
      (a, b) => a.addedAt - b.addedAt || a.email.localeCompare(b.email)
    );
  }

  async deleteSharesForRelic(relicId: string): Promise<number> {
    const count = this.shares.get(relicId)?.size ?? 0;
    this.shares.delete(relicId);
    const row = this.relics.get(relicId);
    if (row !== undefined) {
      this.relics.set(relicId, {
        ...row,
        sharesCount: 0,
      });
    }
    return count;
  }

  async reserveShares(
    relicId: string,
    count: number,
    maxLimit: number
  ): Promise<{ allowed: boolean; currentCount: number }> {
    const row = this.relics.get(relicId);
    if (row === undefined) {
      return { allowed: false, currentCount: 0 };
    }
    const currentCount = row.sharesCount ?? this.shares.get(relicId)?.size ?? 0;
    if (currentCount + count > maxLimit) {
      return { allowed: false, currentCount };
    }
    const next: RelicRow = {
      ...row,
      sharesCount: currentCount + count,
    };
    this.relics.set(relicId, next);
    return { allowed: true, currentCount: currentCount + count };
  }

  async releaseShares(relicId: string, count: number): Promise<void> {
    const row = this.relics.get(relicId);
    if (row === undefined) return;
    const currentCount = row.sharesCount ?? this.shares.get(relicId)?.size ?? 0;
    const next: RelicRow = {
      ...row,
      sharesCount: Math.max(0, currentCount - count),
    };
    this.relics.set(relicId, next);
  }

  async putOptOut(row: OptOutRow): Promise<void> {
    let map = this.optOuts.get(row.relicId);
    if (map === undefined) {
      map = new Map();
      this.optOuts.set(row.relicId, map);
    }
    if (!map.has(row.addressHash)) {
      map.set(row.addressHash, row);
    }
  }

  async listOptOuts(relicId: string): Promise<readonly string[]> {
    const map = this.optOuts.get(relicId);
    if (map === undefined) return [];
    return [...map.keys()];
  }

  async deleteOptOutsForRelic(relicId: string): Promise<number> {
    const count = this.optOuts.get(relicId)?.size ?? 0;
    this.optOuts.delete(relicId);
    return count;
  }

  async isOptedOut(relicId: string, addressHash: string): Promise<boolean> {
    const map = this.optOuts.get(relicId);
    return map?.has(addressHash) ?? false;
  }
  async unsubscribeKey(): Promise<Uint8Array> {
    if (this.unsubscribeSecret === undefined) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      this.unsubscribeSecret = bytes;
    }
    return new Uint8Array(this.unsubscribeSecret);
  }

  async putRelic(row: RelicRow): Promise<void> {
    this.relics.set(row.id, row);
  }

  async markPublished(
    id: string,
    at: number,
    objectLength: number,
    crc32c: string
  ): Promise<void> {
    const row = this.relics.get(id);
    if (row === undefined) return;
    row.publishedAt = at;
    row.objectLength = objectLength;
    row.objectCrc32c = crc32c;
  }

  async consumeMint(id: string): Promise<number> {
    const row = this.relics.get(id);
    if (row === undefined) return 0;
    row.mintsUsed += 1;
    return row.mintsUsed;
  }
  async putCover(
    id: string,
    cover: RelicCover,
    bytes: Uint8Array
  ): Promise<'stored' | 'stale_version' | 'not_found'> {
    let coversForRelic = this.covers.get(id);
    if (coversForRelic === undefined) {
      coversForRelic = new Map();
      this.covers.set(id, coversForRelic);
    }
    coversForRelic.set(cover.sha256, { bytes, type: cover.type });

    const row = this.relics.get(id);
    if (row === undefined) {
      coversForRelic.delete(cover.sha256);
      return 'not_found';
    }
    if (row.version !== cover.version) {
      coversForRelic.delete(cover.sha256);
      return 'stale_version';
    }

    row.cover = cover;
    for (const hash of [...coversForRelic.keys()]) {
      if (hash !== cover.sha256) {
        coversForRelic.delete(hash);
      }
    }
    return 'stored';
  }

  async getCoverBytes(
    id: string,
    sha256: string
  ): Promise<Uint8Array | undefined> {
    return this.covers.get(id)?.get(sha256)?.bytes;
  }

  async listCovers(id: string): Promise<readonly string[]> {
    const coversForRelic = this.covers.get(id);
    if (coversForRelic === undefined) return [];
    return [...coversForRelic.keys()];
  }

  async deleteCovers(id: string): Promise<number> {
    const coversForRelic = this.covers.get(id);
    const count = coversForRelic?.size ?? 0;
    this.covers.delete(id);
    const row = this.relics.get(id);
    if (row !== undefined) {
      row.cover = undefined;
    }
    return count;
  }

  async getTombstone(id: string): Promise<Tombstone | undefined> {
    return this.tombstones.get(id);
  }

  async putTombstone(stone: Tombstone): Promise<void> {
    this.tombstones.set(stone.id, stone);
  }

  async issueChallenge(ip: string, now: number): Promise<string> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = [...bytes]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    this.challenges.set(nonce, { nonce, issuedAt: now, ip });
    return nonce;
  }

  async consumeChallenge(
    nonce: string,
    now: number,
    ttl: number
  ): Promise<boolean> {
    const challenge = this.challenges.get(nonce);
    if (challenge === undefined) return false;
    this.challenges.delete(nonce);
    return now - challenge.issuedAt <= ttl * 1000;
  }

  async appendMintLog(entry: MintLogEntry): Promise<void> {
    this.mintLog.push(entry);
  }

  async readMintLog(): Promise<readonly MintLogEntry[]> {
    return this.mintLog;
  }

  async recentMint(
    id: string,
    ip: string,
    now: number,
    windowSeconds: number
  ): Promise<DedupEntry | undefined> {
    const entry = this.dedup.get(`${id}\x00${ip}`);
    if (entry === undefined) return undefined;
    if (now - entry.at > windowSeconds * 1000) return undefined;
    return entry;
  }

  async rememberMint(id: string, ip: string, entry: DedupEntry): Promise<void> {
    this.dedup.set(`${id}\x00${ip}`, entry);
  }

  async isBlocklisted(hash: string): Promise<boolean> {
    return this.blocked.has(hash);
  }

  async blocklist(hash: string): Promise<void> {
    // Idempotent, so a scanner-triggered delete does not re-add its own hash.
    this.blocked.add(hash);
  }

  async putAbuseReport(report: AbuseReport): Promise<void> {
    this.reports.push(report);
  }

  async readAbuseReports(): Promise<readonly AbuseReport[]> {
    return this.reports;
  }

  async putComment(row: CommentRow): Promise<void> {
    const thread = this.comments.get(row.relicId) ?? [];
    // Copied whole rather than field by field. Rebuilding it here meant this
    // store silently dropped every field added to the row afterwards, which
    // is how the clear routing hint went missing in development and how an
    // edit stamp and a resolution would have followed it. A store that
    // writes less than its own row type is a lie about what was stored.
    thread.push({
      ...row,
      version: typeof row.version === 'number' ? row.version : undefined,
    });
    this.comments.set(row.relicId, thread);

    if (row.author !== 'publisher' && looksLikeEmail(row.author)) {
      const normalized = row.author.trim().toLowerCase();
      const hash = await sha256Hex(normalized);
      let map = this.commenters.get(row.relicId);
      if (map === undefined) {
        map = new Map();
        this.commenters.set(row.relicId, map);
      }
      if (!map.has(hash)) {
        map.set(hash, normalized);
      }
    }
  }

  async getComment(
    relicId: string,
    commentId: string
  ): Promise<CommentRow | undefined> {
    return this.comments.get(relicId)?.find((c) => c.id === commentId);
  }
  async listComments(relicId: string): Promise<readonly CommentRow[]> {
    // Sorted rather than trusting insertion order, because a real store
    // returns rows in whatever order it likes and the thread's contract is
    // oldest first. Ties break on id so the order is total, not merely
    // mostly-sorted, which is what makes the list reproducible.
    return [...(this.comments.get(relicId) ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
    );
  }

  async deleteComment(relicId: string, commentId: string): Promise<void> {
    const thread = this.comments.get(relicId);
    if (thread === undefined) return;
    const kept = thread.filter((c) => c.id !== commentId);
    if (kept.length === 0) this.comments.delete(relicId);
    else this.comments.set(relicId, kept);
  }

  async updateComment(
    relicId: string,
    commentId: string,
    patch: CommentPatch
  ): Promise<CommentRow | undefined> {
    const thread = this.comments.get(relicId);
    const index = thread?.findIndex((c) => c.id === commentId) ?? -1;
    if (thread === undefined || index === -1) return undefined;
    // The merge rules live in one function shared with the GCS store, so a
    // clearing patch behaves identically no matter where the row lives.
    const updated = applyCommentPatch(thread[index] as CommentRow, patch);
    thread[index] = updated;
    return updated;
  }

  async deleteCommentsForRelic(relicId: string): Promise<number> {
    const removed = this.comments.get(relicId)?.length ?? 0;
    this.comments.delete(relicId);
    this.commenters.delete(relicId);
    this.commenterMarkers.delete(relicId);
    return removed;
  }

  async listCommenters(relicId: string): Promise<readonly string[]> {
    if (!this.commenterMarkers.has(relicId)) {
      const thread = this.comments.get(relicId) ?? [];
      let map = this.commenters.get(relicId);
      if (map === undefined) {
        map = new Map();
        this.commenters.set(relicId, map);
      }
      for (const comment of thread) {
        if (comment.author !== 'publisher' && looksLikeEmail(comment.author)) {
          const normalized = comment.author.trim().toLowerCase();
          const hash = await sha256Hex(normalized);
          if (!map.has(hash)) {
            map.set(hash, normalized);
          }
        }
      }
      this.commenterMarkers.add(relicId);
    }
    const map = this.commenters.get(relicId);
    if (map === undefined) return [];
    return [...map.values()].sort();
  }

  async deleteCommenter(relicId: string, author: string): Promise<void> {
    const hash = await sha256Hex(author.trim().toLowerCase());
    this.commenters.get(relicId)?.delete(hash);
  }

  async listCommentedRelics(
    author: string
  ): Promise<readonly CommentedRelic[]> {
    const results: CommentedRelic[] = [];
    for (const [relicId, thread] of this.comments) {
      let lastCommentAt: number | undefined;
      for (const comment of thread) {
        if (comment.author === author) {
          if (
            lastCommentAt === undefined ||
            comment.createdAt > lastCommentAt
          ) {
            lastCommentAt = comment.createdAt;
          }
        }
      }
      if (lastCommentAt !== undefined) {
        results.push({ relicId, lastCommentAt });
      }
    }
    return results.sort(
      (a, b) =>
        b.lastCommentAt - a.lastCommentAt || (a.relicId < b.relicId ? -1 : 1)
    );
  }

  async putAuthLink(row: AuthLinkRow): Promise<void> {
    this.authLinks.set(row.tokenHash, row);
  }

  async consumeAuthLink(tokenHash: string): Promise<AuthLinkRow | undefined> {
    const row = this.authLinks.get(tokenHash);
    // Deleted whether or not it was still valid. A link that has been
    // presented once is spent, so a replay finds nothing rather than
    // finding an expired row it might be tempted to forgive.
    this.authLinks.delete(tokenHash);
    return row;
  }

  async putSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.tokenHash, row);
    this.verifiedEmails.add(row.email.toLowerCase().trim());
  }

  async getSession(tokenHash: string): Promise<SessionRow | undefined> {
    return this.sessions.get(tokenHash);
  }

  async recordVerifiedIdentity(email: string, _at?: number): Promise<void> {
    this.verifiedEmails.add(email.toLowerCase().trim());
  }

  async hasVerifiedIdentity(email: string): Promise<boolean> {
    const normalized = email.toLowerCase().trim();
    if (this.verifiedEmails.has(normalized)) return true;
    for (const session of this.sessions.values()) {
      if (session.email.toLowerCase().trim() === normalized) return true;
    }
    return false;
  }
  async appendDecision(row: DecisionRow): Promise<void> {
    let map = this.decisions.get(row.relicId);
    if (map === undefined) {
      map = new Map();
      this.decisions.set(row.relicId, map);
    }
    if (map.has(row.id)) {
      throw new Error(`decision ${row.id} already exists`);
    }
    map.set(row.id, row);
  }

  async listDecisions(relicId: string): Promise<readonly DecisionRow[]> {
    const map = this.decisions.get(relicId);
    if (map === undefined) return [];
    return [...map.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    );
  }

  async deleteDecisionsForRelic(relicId: string): Promise<number> {
    const map = this.decisions.get(relicId);
    const count = map?.size ?? 0;
    this.decisions.delete(relicId);
    return count;
  }

  async deleteDecision(relicId: string, decisionId: string): Promise<boolean> {
    const map = this.decisions.get(relicId);
    if (map === undefined) return false;
    const deleted = map.delete(decisionId);
    if (map.size === 0) {
      this.decisions.delete(relicId);
    }
    return deleted;
  }

  async recordVersionDigest(
    id: string,
    version: number,
    sha256: string
  ): Promise<string | undefined> {
    const row = this.relics.get(id);
    if (row === undefined) return undefined;
    const vKey = String(version);
    const existing = row.versionDigests?.[vKey];
    if (existing !== undefined) {
      return existing;
    }
    const versionDigests = {
      ...(row.versionDigests ?? {}),
      [vKey]: sha256,
    };
    row.versionDigests = versionDigests;
    return sha256;
  }

  async getPasskeys(email: string): Promise<PasskeyRecord | undefined> {
    return this.passkeys.get(normalizeEmail(email));
  }

  async createPasskeys(record: PasskeyRecord): Promise<boolean> {
    const norm = normalizeEmail(record.email);
    if (this.passkeys.has(norm)) {
      return false;
    }
    this.passkeys.set(norm, record);
    this.passkeyHandles.set(record.userHandle, norm);
    return true;
  }

  async updatePasskeys(
    email: string,
    change: (r: PasskeyRecord) => PasskeyRecord
  ): Promise<PasskeyRecord | undefined> {
    const norm = normalizeEmail(email);
    const current = this.passkeys.get(norm);
    if (current === undefined) return undefined;

    const next = change(current);

    for (const nextCred of next.credentials) {
      const stored = current.credentials.find(
        (c) => c.credentialId === nextCred.credentialId
      );
      if (stored !== undefined) {
        if (nextCred.signCount < stored.signCount) {
          throw new ProblemError('passkey_verification_failed', {
            passkey_check: 'counter',
          });
        }
      }
    }

    this.passkeys.set(norm, next);
    this.passkeyHandles.set(next.userHandle, norm);
    return next;
  }

  async getPasskeysByUserHandle(
    userHandle: string
  ): Promise<PasskeyRecord | undefined> {
    const norm = this.passkeyHandles.get(userHandle);
    if (norm === undefined) return undefined;
    const record = this.passkeys.get(norm);
    if (record === undefined || record.userHandle !== userHandle) {
      return undefined;
    }
    return record;
  }

  async passkeyDecoyKey(): Promise<Uint8Array> {
    if (this.passkeyDecoySecret === undefined) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      this.passkeyDecoySecret = bytes;
    }
    return new Uint8Array(this.passkeyDecoySecret);
  }

  async putWebauthnChallenge(row: WebauthnChallengeRow): Promise<void> {
    this.webauthnChallenges.set(row.challengeHash, row);
  }

  async consumeWebauthnChallenge(
    challengeHash: string
  ): Promise<WebauthnChallengeRow | undefined> {
    const row = this.webauthnChallenges.get(challengeHash);
    if (row === undefined) return undefined;
    this.webauthnChallenges.delete(challengeHash);
    return row;
  }
}
