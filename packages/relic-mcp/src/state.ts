/**
 * Durable publish state: what a later republish needs.
 *
 * A republish has to encrypt under the SAME key as version 1, or the share
 * URL stops decrypting anything, and it has to present the publish token the
 * first grant handed out, or the service refuses it. Neither exists anywhere
 * but this machine: the service holds a hash of the token and nothing of the
 * key. So losing this file means those relics can never be updated from
 * here, which makes it state a human cannot repair by hand elsewhere. It is
 * written before a publish reports success and read at the point of use,
 * never cached in a process global.
 *
 * The file holds secrets. It is created 0600 inside a 0700 directory under
 * the user's config directory, and nothing in this module ever puts the key
 * or the token into a message, a log line, or an error.
 */

import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export type SourceIdentityKind = 'git_remote' | 'git_common_dir' | 'realpath';

/**
 * A stable name for one source file, plus the facts used to explain a match.
 *
 * The identity is an on-disk index key. The description is safe to return to
 * the publisher: it contains paths and repository locations, never a content
 * key or publish token.
 */
export interface SourceIdentity {
  readonly identity: string;
  readonly kind: SourceIdentityKind;
  readonly path: string;
  readonly repository?: string | undefined;
  readonly description: string;
}

/** What this machine remembers about one published relic. */
export interface PublishState {
  /** The version-1 content key, base64url, exactly as it rides the URL fragment. */
  readonly key: string;
  /**
   * The bearer secret authorizing a republish. The service stores only its
   * SHA-256, so this copy is the only usable one in existence.
   */
  readonly publish_token: string;
  /** How many versions this machine has published; 1 after the first. */
  readonly version: number;
  /**
   * Absent on state written before source lookup shipped. Absence is valid
   * legacy state and means this entry cannot take part in prior-publish
   * detection.
   */
  readonly source?: SourceIdentity | undefined;
  /**
   * The name written into the encrypted envelope of the newest version this
   * machine published.
   *
   * Recorded from this client on, and absent on every entry written before
   * it, which is most of them. Absence is legacy state, never an error: the
   * name also lives inside the relic's own envelope, so an inventory
   * recovers it by decrypting rather than guessing. It is stored anyway
   * because recovering it costs one of the relic's finite opens and this
   * costs nothing.
   */
  readonly filename?: string | undefined;
  /**
   * When this machine first published the relic, ISO 8601.
   *
   * The service knows a publish timestamp and will not tell a client, so
   * absence here cannot be repaired later from anywhere. It is written once,
   * at first publish, and a republish never touches it: it answers "when did
   * I make this", not "when did I last change it".
   */
  readonly published_at?: string | undefined;
  /** When this machine last published a new version, ISO 8601. */
  readonly updated_at?: string | undefined;
  /**
   * SHA-256, hex, of the plaintext of the newest version this machine
   * published: its bytes, its name and its title together.
   *
   * It exists to refuse a republish that would put identical content behind
   * the link a second time. A version is a thing recipients are told to look
   * at again, so one that changes nothing is a false alarm they cannot tell
   * from a real one until they have read it.
   *
   * Absent on every entry written before this client, and absence is legacy
   * state rather than an error. It cannot be repaired from anywhere: the
   * service holds ciphertext and would not hand a client the plaintext to
   * hash even if it were asked. So an entry without it cannot take part in
   * the check, its next republish is allowed on that ground, and the digest
   * is recorded as that republish lands.
   */
  readonly content_sha256?: string | undefined;
  /**
   * The lifetime the first grant fixed, ISO 8601, or null for a relic kept
   * until it is deleted.
   *
   * Null and absent are different answers. Null is the service saying this
   * relic has no end; absent is this machine never having written it down,
   * which is every entry older than this client. A lifetime is fixed at the
   * first grant and never moves, so a recorded value stays true.
   */
  readonly expires_at?: string | null | undefined;
  /**
   * Whether a cover image was successfully uploaded for this version.
   *
   * Absent on every entry written before per-relic covers shipped. Absence
   * is legacy state and means this entry has no cover recorded. A republish
   * that changes content or removes the cover writes it as false; a successful
   * cover upload writes it as true.
   */
  readonly cover_uploaded?: boolean | undefined;
}

/**
 * What this machine remembers about one private relic.
 *
 * Private relics have no content key in a URL. This machine keeps one key
 * per version it has a key for (the ones it created, plus any it fetched and
 * unwrapped), the publish token, and the owner identity it pinned at
 * enrollment. Like the public entry, it is a secret file and never echoed.
 */
export interface PrivatePublishState {
  readonly access: 'private';
  /** The service origin this entry was created against. */
  readonly service_origin: string;
  readonly publish_token: string;
  /** The newest version this machine published. */
  readonly version: number;
  /** Version number to base64url 16-byte key, for the versions created here. */
  readonly version_keys: Readonly<Record<string, string>>;
  readonly owner_identity_id: string;
  /** The device that published and seals versions for this relic. */
  readonly device_id: string;
  readonly source?: SourceIdentity | undefined;
  readonly filename?: string | undefined;
  readonly published_at?: string | undefined;
  readonly updated_at?: string | undefined;
  readonly content_sha256?: string | undefined;
  readonly expires_at?: string | null | undefined;
}

interface StateFile {
  readonly relics: Record<string, PublishState>;
  readonly sources?: Record<string, string> | undefined;
  readonly [key: string]: unknown;
}

export interface PublishedSource {
  readonly relic_id: string;
  readonly access: 'public' | 'private';
  readonly version: number;
  readonly source: SourceIdentity;
}

/**
 * Where the state lives.
 *
 * Behind one helper, redirected with `RELIC_PUBLISH_STATE`, so tests point it
 * at a scratch path and a user with an unusual setup can move it. The default
 * is the user's config directory rather than the repo or the cwd, because the
 * publisher's identity here is the machine and user who ran the publish, not
 * whatever directory the server happened to start in.
 */
export function publishStatePath(): string {
  const override = process.env['RELIC_PUBLISH_STATE'];
  if (override !== undefined && override.length > 0) return override;

  const configRoot =
    process.env['XDG_CONFIG_HOME'] !== undefined &&
    process.env['XDG_CONFIG_HOME'].length > 0
      ? process.env['XDG_CONFIG_HOME']
      : join(homedir(), '.config');
  return join(configRoot, 'relic-mcp', 'publish-state.json');
}

const runFile = promisify(execFile);

/**
 * Reduce equivalent Git transport URLs to one repository name.
 *
 * Credentials and transport do not identify a repository. Host and path do,
 * and the hosts this client targets treat both without case.
 */
export function normalizeGitRemote(remote: string): string {
  const value = remote.trim().replace(/^git\+/i, '');
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      return fileURLToPath(url)
        .replaceAll('\\', '/')
        .replace(/\/+$/g, '')
        .replace(/\.git$/i, '');
    }
    if (url.hostname.length > 0) {
      const host =
        url.port.length > 0 ? `${url.hostname}:${url.port}` : url.hostname;
      const path = url.pathname
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.git$/i, '');
      return `${host}/${path}`.toLowerCase();
    }
  } catch {
    // SCP-style and local remotes are not URL syntax.
  }

  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    const path = scp[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return `${scp[1]}/${path}`.toLowerCase();
  }

  return value
    .replaceAll('\\', '/')
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '');
}

async function gitOutput(
  directory: string,
  args: readonly string[]
): Promise<string | undefined> {
  try {
    const { stdout } = await runFile('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const output = String(stdout).trim();
    return output.length === 0 ? undefined : output;
  } catch {
    return undefined;
  }
}

/**
 * Name a source across sessions without binding it to one worktree.
 *
 * A repository remote is the strongest identity because it also crosses
 * clones. A repository with no remote falls back to Git's shared common
 * directory, which crosses worktrees from one clone. A file outside Git is
 * named by realpath so symlink aliases do not create duplicate relics.
 */
export async function resolveSourceIdentity(
  path: string
): Promise<SourceIdentity> {
  const absolutePath = resolve(path);
  const sourceDirectory = dirname(absolutePath);
  const repositoryRoot = await gitOutput(sourceDirectory, [
    'rev-parse',
    '--show-toplevel',
  ]);

  if (repositoryRoot !== undefined) {
    const repositoryPrefix = await gitOutput(sourceDirectory, [
      'rev-parse',
      '--show-prefix',
    ]);
    const repositoryPath =
      `${repositoryPrefix ?? ''}${basename(absolutePath)}`.replaceAll(
        '\\',
        '/'
      );
    const remoteNames = ((await gitOutput(repositoryRoot, ['remote'])) ?? '')
      .split(/\r?\n/)
      .filter((name) => name.length > 0)
      .sort();
    const remoteName = remoteNames.includes('origin')
      ? 'origin'
      : remoteNames[0];

    if (remoteName !== undefined) {
      const remote = await gitOutput(repositoryRoot, [
        'remote',
        'get-url',
        remoteName,
      ]);
      if (remote !== undefined) {
        const repository = normalizeGitRemote(remote);
        return {
          identity:
            `git-remote:${encodeURIComponent(repository)}:` +
            encodeURIComponent(repositoryPath),
          kind: 'git_remote',
          path: repositoryPath,
          repository,
          description: `${repositoryPath} in ${repository}`,
        };
      }
    }

    const commonDirectory = await gitOutput(repositoryRoot, [
      'rev-parse',
      '--git-common-dir',
    ]);
    if (commonDirectory !== undefined) {
      const repository = await realpath(
        isAbsolute(commonDirectory)
          ? commonDirectory
          : resolve(repositoryRoot, commonDirectory)
      );
      return {
        identity:
          `git-common-dir:${encodeURIComponent(repository)}:` +
          encodeURIComponent(repositoryPath),
        kind: 'git_common_dir',
        path: repositoryPath,
        repository,
        description: `${repositoryPath} in Git repository ${repository}`,
      };
    }
  }

  const canonicalPath = await realpath(absolutePath);
  return {
    identity: `realpath:${encodeURIComponent(canonicalPath)}`,
    kind: 'realpath',
    path: canonicalPath,
    description: canonicalPath,
  };
}

/**
 * Writers queue behind one chain, so two publishes finishing close together
 * cannot read-modify-write past each other and silently drop one relic's
 * entry. Losing an entry to a race would orphan that relic with no error
 * anywhere, which is the quietest possible way to lose republish rights.
 */
let writeChain: Promise<void> = Promise.resolve();

/** Load one relic's state, or undefined when this machine never published it. */
export async function loadPublishState(
  relicId: string
): Promise<PublishState | undefined> {
  const parsed = await readWholeFile(publishStatePath());
  return validatePublishStateEntry(parsed?.relics?.[relicId], relicId);
}

/** Load one private relic's entry, or undefined when this machine never published it privately. */
export async function loadPrivatePublishState(
  relicId: string
): Promise<PrivatePublishState | undefined> {
  const parsed = await readWholeFile(publishStatePath());
  return validatePrivateStateEntry(
    privateBucketEntry(parsed, relicId),
    relicId
  );
}

/** Every private relic this machine holds, read from local state with no network. */
export async function loadPrivateInventory(): Promise<
  readonly { readonly relic_id: string; readonly state: PrivatePublishState }[]
> {
  const parsed = await readWholeFile(publishStatePath());
  const bucket: unknown = parsed?.['private_relics'];
  if (bucket === undefined) return [];
  if (!isPlainObject(bucket)) {
    throw new Error(
      `publish state at ${publishStatePath()} holds malformed private relics.`
    );
  }
  const rows: { relic_id: string; state: PrivatePublishState }[] = [];
  for (const [relicId, entry] of Object.entries(bucket)) {
    const state = validatePrivateStateEntry(entry, relicId);
    if (state !== undefined) rows.push({ relic_id: relicId, state });
  }
  return rows;
}

function privateBucketEntry(
  parsed: StateFile | undefined,
  relicId: string
): unknown {
  const bucket: unknown = parsed?.['private_relics'];
  return isPlainObject(bucket) ? bucket[relicId] : undefined;
}

function validatePrivateStateEntry(
  entry: unknown,
  relicId: string
): PrivatePublishState | undefined {
  if (entry === undefined) return undefined;
  const malformed = () =>
    new Error(
      `publish state at ${publishStatePath()} holds a malformed private ` +
        `entry for relic ${relicId}.`
    );
  if (!isPlainObject(entry)) throw malformed();
  const versionKeys = entry['version_keys'];
  if (
    entry['access'] !== 'private' ||
    typeof entry['service_origin'] !== 'string' ||
    typeof entry['publish_token'] !== 'string' ||
    typeof entry['owner_identity_id'] !== 'string' ||
    typeof entry['device_id'] !== 'string' ||
    typeof entry['version'] !== 'number' ||
    !Number.isSafeInteger(entry['version']) ||
    entry['version'] < 1 ||
    !isPlainObject(versionKeys) ||
    !Object.values(versionKeys).every((key) => typeof key === 'string') ||
    (entry['source'] !== undefined && !isSourceIdentity(entry['source'])) ||
    (entry['content_sha256'] !== undefined &&
      (typeof entry['content_sha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry['content_sha256'])))
  ) {
    throw malformed();
  }
  return entry as unknown as PrivatePublishState;
}

function isSourceIdentity(value: unknown): value is SourceIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const source = value as Record<string, unknown>;
  return (
    typeof source['identity'] === 'string' &&
    (source['kind'] === 'git_remote' ||
      source['kind'] === 'git_common_dir' ||
      source['kind'] === 'realpath') &&
    typeof source['path'] === 'string' &&
    (source['repository'] === undefined ||
      typeof source['repository'] === 'string') &&
    typeof source['description'] === 'string'
  );
}

function validatePublishStateEntry(
  entry: unknown,
  relicId: string
): PublishState | undefined {
  if (entry === undefined) return undefined;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(
      `publish state at ${publishStatePath()} holds a malformed entry for ` +
        `relic ${relicId}.`
    );
  }
  const candidate = entry as Record<string, unknown>;
  if (
    typeof candidate['key'] !== 'string' ||
    typeof candidate['publish_token'] !== 'string' ||
    typeof candidate['version'] !== 'number' ||
    !Number.isSafeInteger(candidate['version']) ||
    candidate['version'] < 1 ||
    (candidate['source'] !== undefined &&
      !isSourceIdentity(candidate['source'])) ||
    // Checked rather than trusted, because the duplicate-version refusal
    // compares against it: a digest of the wrong shape would match nothing,
    // and that refusal would then fail open on every republish, with no
    // word about it anywhere.
    (candidate['content_sha256'] !== undefined &&
      (typeof candidate['content_sha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(candidate['content_sha256']))) ||
    (candidate['cover_uploaded'] !== undefined &&
      typeof candidate['cover_uploaded'] !== 'boolean')
  ) {
    throw new Error(
      `publish state at ${publishStatePath()} holds a malformed entry for ` +
        `relic ${relicId}.`
    );
  }
  return candidate as unknown as PublishState;
}

/**
 * Resolve a source through the reverse index without exposing its secrets.
 *
 * The index covers public and private entries alike, so a source already
 * published privately is refused the same way a public one is.
 */
export async function loadPublishedSource(
  source: SourceIdentity
): Promise<PublishedSource | undefined> {
  const parsed = await readWholeFile(publishStatePath());
  const sources = parsed?.sources;
  if (sources === undefined) return undefined;
  if (!isPlainObject(sources)) {
    throw new Error(
      `publish state at ${publishStatePath()} holds a malformed source index.`
    );
  }

  const relicId = sources[source.identity];
  if (relicId === undefined) return undefined;
  if (typeof relicId !== 'string' || relicId.length === 0) {
    throw new Error(
      `publish state at ${publishStatePath()} holds a malformed source match.`
    );
  }

  const published = validatePublishStateEntry(
    parsed?.relics?.[relicId],
    relicId
  );
  if (published !== undefined) {
    if (published.source?.identity !== source.identity) {
      throw new Error(
        `publish state at ${publishStatePath()} holds a source match without ` +
          'its relic entry.'
      );
    }
    return {
      relic_id: relicId,
      access: 'public',
      version: published.version,
      source: published.source,
    };
  }

  const priv = validatePrivateStateEntry(
    privateBucketEntry(parsed, relicId),
    relicId
  );
  if (priv?.source?.identity !== source.identity) {
    throw new Error(
      `publish state at ${publishStatePath()} holds a source match without ` +
        'its relic entry.'
    );
  }
  return {
    relic_id: relicId,
    access: 'private',
    version: priv.version,
    source: priv.source,
  };
}

/** One relic this machine published, as the inventory reads it. */
export interface PublishRecord {
  readonly relic_id: string;
  readonly state: PublishState;
  /**
   * Whether the top-level source index points at this relic, which is
   * exactly the question "can relic_lookup_source find it".
   *
   * Distinct from `state.source` being present. On this machine's own file
   * nine entries carry a source and the index names four of them, so an
   * entry can know where it came from and still be unreachable by the only
   * tool that searches by source.
   */
  readonly source_indexed: boolean;
}

/**
 * Every relic this machine published, in the order the file records them.
 *
 * That order is publish order: a new relic is appended and a republish
 * updates its entry in place, so it is the only evidence of sequence for the
 * entries written before timestamps were recorded. It is preserved here and
 * reversed by the caller rather than sorted on a field most entries do not
 * have.
 *
 * A single malformed entry is reported rather than thrown, because throwing
 * would take all 41 rows down over one bad one, and the whole point of an
 * inventory is that nothing goes missing quietly.
 */
export async function loadPublishInventory(): Promise<{
  readonly records: readonly PublishRecord[];
  readonly malformed: readonly string[];
}> {
  const path = publishStatePath();
  const parsed = await readWholeFile(path);
  const relics = parsed?.relics;
  if (relics === undefined) return { records: [], malformed: [] };
  if (relics === null || typeof relics !== 'object' || Array.isArray(relics)) {
    throw new Error(`publish state at ${path} holds malformed relic entries.`);
  }

  const rawSources = parsed?.sources;
  if (
    rawSources !== undefined &&
    (rawSources === null ||
      typeof rawSources !== 'object' ||
      Array.isArray(rawSources))
  ) {
    throw new Error(`publish state at ${path} holds a malformed source index.`);
  }
  const indexed = new Set(
    Object.values((rawSources ?? {}) as Record<string, unknown>).filter(
      (value): value is string => typeof value === 'string'
    )
  );

  const records: PublishRecord[] = [];
  const malformed: string[] = [];
  for (const [relicId, entry] of Object.entries(
    relics as Record<string, unknown>
  )) {
    let state: PublishState | undefined;
    try {
      state = validatePublishStateEntry(entry, relicId);
    } catch {
      malformed.push(relicId);
      continue;
    }
    if (state === undefined) continue;
    records.push({
      relic_id: relicId,
      state,
      source_indexed: indexed.has(relicId),
    });
  }
  return { records, malformed };
}

/**
 * Record or update one public relic's state, preserving every other entry.
 *
 * Called only after the service has accepted the object, so the file never
 * promises a republish the service does not know about.
 */
export async function savePublishState(
  relicId: string,
  state: PublishState
): Promise<void> {
  await queueWrite('relics', relicId, state);
}

/**
 * Record or update one private relic's entry, preserving every other entry.
 *
 * Private entries live under their own top-level key. Older clients read
 * only `relics`, so they neither see nor drop these, which is the reason the
 * key is separate rather than a field on the public entry.
 */
export async function savePrivatePublishState(
  relicId: string,
  state: PrivatePublishState
): Promise<void> {
  await queueWrite('private_relics', relicId, state);
}

type StateBucket = 'relics' | 'private_relics';

function queueWrite(
  bucket: StateBucket,
  relicId: string,
  state: object
): Promise<void> {
  const run = writeChain.then(() => writeEntry(bucket, relicId, state));
  // A failed write must not poison the chain for later ones; it is observed
  // here and rethrown for the caller, who has not yet reported success.
  writeChain = run.catch(() => undefined);
  return run;
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writeEntry(
  bucket: StateBucket,
  relicId: string,
  state: object
): Promise<void> {
  const path = publishStatePath();
  const dir = dirname(path);

  // 0700 applies to the directories this creates, not to a config root that
  // already exists: chmod-ing ~/.config itself would break other tools.
  await mkdir(dir, { mode: 0o700, recursive: true });

  const existing = await readWholeFile(path);
  const storedBucket = existing?.[bucket];
  if (storedBucket !== undefined && !isPlainObject(storedBucket)) {
    throw new Error(`publish state at ${path} holds malformed ${bucket}.`);
  }
  const oldEntry = storedBucket?.[relicId];
  const entries = {
    ...storedBucket,
    [relicId]: {
      ...(isPlainObject(oldEntry) ? oldEntry : {}),
      // Undefined members are dropped before the merge, never spread over the
      // stored entry. Every field added since the first release is optional,
      // so a caller that rebuilds a state object without one would otherwise
      // delete the recorded value: `{...state}` carries the key with an
      // undefined value, JSON.stringify drops the key, and a filename or a
      // source identity disappears from a write that was only meant to bump
      // a version number.
      ...defined(state),
    },
  };

  const source = (state as { readonly source?: SourceIdentity }).source;
  const storedSources = existing?.['sources'];
  if (storedSources !== undefined && !isPlainObject(storedSources)) {
    throw new Error(`publish state at ${path} holds a malformed source index.`);
  }
  const sources = {
    ...storedSources,
    ...(source === undefined ? {} : { [source.identity]: relicId }),
  };
  const next = {
    ...existing,
    [bucket]: entries,
    ...(storedSources === undefined && source === undefined ? {} : { sources }),
  };

  // Written to a sibling then renamed over, so a crash mid-write leaves the
  // previous intact file rather than half of the new one. A torn file would
  // take every relic's republish rights with it, not just the one in flight.
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/**
 * The state's members that carry a value, with `null` kept.
 *
 * Null is an answer here rather than an absence: an `expires_at` of null is
 * the service saying this relic has no lifetime, which is different from
 * this machine never having recorded one.
 */
function defined(state: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function readWholeFile(path: string): Promise<StateFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`could not read publish state at ${path}: ${code}`);
  }

  try {
    const parsed = JSON.parse(raw) as StateFile | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error(
      `publish state at ${path} is not valid JSON. It cannot be updated, so ` +
        'this publish cannot be recorded and this relic cannot later be ' +
        'republished from this machine until the file is fixed or removed.'
    );
  }
}

/** Exposed for tests asserting the on-disk permissions, nothing else. */
export async function publishStateModes(): Promise<{
  file: number;
  directory: number;
}> {
  const path = publishStatePath();
  const [file, directory] = await Promise.all([
    stat(path),
    stat(dirname(path)),
  ]);
  return { file: file.mode & 0o777, directory: directory.mode & 0o777 };
}
