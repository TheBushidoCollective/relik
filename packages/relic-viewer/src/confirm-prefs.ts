/**
 * Reader confirmations the reader has chosen not to see again.
 *
 * Exactly three kinds exist: a link request from a rendered frame ('link'), the
 * large-open confirmation ('large-open') and the delete-comment confirmation
 * ('delete-comment'). Private delete and private rekey are not kinds, because
 * they are irreversible or security-sensitive, so no preference can skip them.
 *
 * A choice is recorded only with a ReaderConfirmation, which readerConfirmed()
 * makes from a trusted click event on the dialog's own Confirm control. A frame
 * message never reaches this module with such an event, so a frame cannot set or
 * clear a choice.
 *
 * Choices live in the viewer origin's own localStorage under one versioned key,
 * which the rendered frame (a different origin) cannot read or write. Where
 * storage refuses a write, the choices stay in memory for this page only and are
 * never written. Stored input is parsed strictly: anything malformed is ignored,
 * and at most CONFIRM_PREFS_CAP choices are kept, the oldest evicted first.
 *
 * Limit: a browser that keeps a private session's storage writable is not
 * detected, so choices made there persist for that session. The spec says so.
 */

export const CONFIRM_KINDS = ['link', 'large-open', 'delete-comment'] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

/** Whether a kind is keyed by relic and version. A delete-comment choice spans versions. */
const VERSIONED: Record<ConfirmKind, boolean> = {
  link: true,
  'large-open': true,
  'delete-comment': false,
};

export interface ConfirmPref {
  readonly kind: ConfirmKind;
  readonly relicId: string;
  /** Present for the versioned kinds only. */
  readonly version?: number;
}

export const CONFIRM_PREFS_KEY = 'relic-confirm-prefs:v1';
export const CONFIRM_PREFS_CAP = 500;
const RELIC_ID_LIMIT = 200;

const READER: unique symbol = Symbol('reader confirmation');

/** Proof of a trusted click on a dialog's own Confirm control. Only readerConfirmed makes one. */
export interface ReaderConfirmation {
  readonly [READER]: true;
}

/** The proof for a trusted click, or undefined for any event a script made. */
export function readerConfirmed(event: Event): ReaderConfirmation | undefined {
  if (!event.isTrusted) return undefined;
  return { [READER]: true } as ReaderConfirmation;
}

function isProof(value: unknown): value is ReaderConfirmation {
  return typeof value === 'object' && value !== null && READER in value;
}

function isKind(value: unknown): value is ConfirmKind {
  return (
    typeof value === 'string' &&
    (CONFIRM_KINDS as readonly string[]).includes(value)
  );
}

function isRelicId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > RELIC_ID_LIMIT) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The choice a kind, relic and version name, or undefined when they are not valid. */
function keyOf(
  kind: unknown,
  relicId: unknown,
  version?: unknown
): ConfirmPref | undefined {
  if (!isKind(kind) || !isRelicId(relicId)) return undefined;
  if (!VERSIONED[kind]) return { kind, relicId };
  if (typeof version !== 'number') return undefined;
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  return { kind, relicId, version };
}

/** One stored entry, with no field beyond the three it may carry. */
function strictEntry(item: unknown): ConfirmPref | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (field !== 'kind' && field !== 'relicId' && field !== 'version') {
      return undefined;
    }
  }
  const kind = record['kind'];
  if (!isKind(kind)) return undefined;
  if (!VERSIONED[kind] && record['version'] !== undefined) return undefined;
  return keyOf(kind, record['relicId'], record['version']);
}

function sameChoice(a: ConfirmPref, b: ConfirmPref): boolean {
  return (
    a.kind === b.kind && a.relicId === b.relicId && a.version === b.version
  );
}

/**
 * Parses stored choices strictly. Input that is not a JSON array yields nothing,
 * malformed entries are skipped, duplicates collapse, and the newest
 * CONFIRM_PREFS_CAP entries are kept.
 */
export function parseConfirmPrefs(raw: string | null): ConfirmPref[] {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const kept: ConfirmPref[] = [];
  for (const item of data) {
    const entry = strictEntry(item);
    if (
      entry !== undefined &&
      !kept.some((other) => sameChoice(other, entry))
    ) {
      kept.push(entry);
    }
  }
  return kept.slice(-CONFIRM_PREFS_CAP);
}

export interface ConfirmPrefs {
  /** Whether choices survive a reload in this browser. False where storage refuses writes. */
  readonly persistent: boolean;
  /** Whether the reader has chosen to skip this confirmation. A version is ignored for delete-comment. */
  has(kind: ConfirmKind, relicId: string, version?: number): boolean;
  /** The choices recorded for one relic. */
  list(relicId: string): readonly ConfirmPref[];
  /** Records a choice. Refused without a reader confirmation, or for an unknown kind or a bad version. */
  remember(proof: ReaderConfirmation | undefined, pref: ConfirmPref): boolean;
  /** Clears one choice, which is the "ask again" control. */
  forget(pref: ConfirmPref): void;
  /** Clears every choice for one relic. */
  clearRelic(relicId: string): void;
}

function canWrite(storage: Storage): boolean {
  const probe = `${CONFIRM_PREFS_KEY}:probe`;
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function readStored(storage: Storage): ConfirmPref[] {
  try {
    return parseConfirmPrefs(storage.getItem(CONFIRM_PREFS_KEY));
  } catch {
    return [];
  }
}

/**
 * The store for one page. Pass the viewer origin's localStorage, or undefined
 * where there is none. Choices are read only when storage accepts a write.
 */
export function createConfirmPrefs(storage: Storage | undefined): ConfirmPrefs {
  const writable = storage !== undefined && canWrite(storage);
  let persistent = writable;
  let entries: ConfirmPref[] =
    storage !== undefined && writable ? readStored(storage) : [];

  const save = (): void => {
    if (!persistent || storage === undefined) return;
    try {
      storage.setItem(CONFIRM_PREFS_KEY, JSON.stringify(entries));
    } catch {
      persistent = false;
    }
  };

  return {
    get persistent(): boolean {
      return persistent;
    },
    has(kind, relicId, version) {
      const key = keyOf(kind, relicId, version);
      return (
        key !== undefined && entries.some((entry) => sameChoice(entry, key))
      );
    },
    list(relicId) {
      return entries.filter((entry) => entry.relicId === relicId);
    },
    remember(proof, pref) {
      if (!isProof(proof)) return false;
      const key = keyOf(pref.kind, pref.relicId, pref.version);
      if (key === undefined) return false;
      if (!entries.some((entry) => sameChoice(entry, key))) entries.push(key);
      if (entries.length > CONFIRM_PREFS_CAP) {
        entries = entries.slice(-CONFIRM_PREFS_CAP);
      }
      save();
      return true;
    },
    forget(pref) {
      const key = keyOf(pref.kind, pref.relicId, pref.version);
      if (key === undefined) return;
      entries = entries.filter((entry) => !sameChoice(entry, key));
      save();
    },
    clearRelic(relicId) {
      entries = entries.filter((entry) => entry.relicId !== relicId);
      save();
    },
  };
}
