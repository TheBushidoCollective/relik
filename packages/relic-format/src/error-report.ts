/**
 * Reports contain no fields for unrestricted free text, IDs, email addresses,
 * local paths, or error messages. Their strings are limited to fixed classes
 * and routes, revisions, and constrained source or bundle file paths.
 *
 * Shape validation prevents accidental capture by honest clients, but a hostile
 * client can still choose valid-shaped values and encode information in them.
 * Ingest must check known revisions and viewer assets; the filer must verify
 * revisions and files against git, including file existence and line bounds.
 */
import { sha256Hex } from './sha256.ts';

export const ERROR_CLASSES = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'IndexSizeError',
  'HierarchyRequestError',
  'WrongDocumentError',
  'InvalidCharacterError',
  'NoModificationAllowedError',
  'NotFoundError',
  'NotSupportedError',
  'InUseAttributeError',
  'InvalidStateError',
  'InvalidModificationError',
  'NamespaceError',
  'InvalidAccessError',
  'TypeMismatchError',
  'SecurityError',
  'NetworkError',
  'AbortError',
  'URLMismatchError',
  'QuotaExceededError',
  'TimeoutError',
  'InvalidNodeTypeError',
  'DataCloneError',
  'EncodingError',
  'NotReadableError',
  'UnknownError',
  'ConstraintError',
  'DataError',
  'TransactionInactiveError',
  'ReadOnlyError',
  'VersionError',
  'OperationError',
  'NotAllowedError',
  'PackageFailure',
  'RelicFormatError',
  'UnknownVersionError',
  'MalformedFragmentError',
  'MalformedContainerError',
  'KeyIdPresentError',
  'VersionMismatchError',
  'StrictParseError',
  'TruncatedContainerError',
  'TransferIncompleteError',
  'DecryptFailedError',
  'ContentTooLargeError',
  'MalformedCommentError',
  'CommentDecryptFailedError',
  'CommentTooLargeError',
  'InvalidMnemonicError',
  'UnsupportedEnvelopeVersionError',
  'EntrySizeMismatchError',
  'IgnoreLimitError',
  'HpkeOpenError',
  'InvalidRelicIdError',
  'OtioProgramError',
  'OtioZipError',
  'InvalidStatementError',
  'InvalidFingerprintError',
  'WrapOpenError',
  'IdentityBundleError',
  'RosterStaleError',
  'SigningInputError',
  'WebauthnAssertionError',
  'ParseFailure',
  'ZipFailure',
  'ApplyError',
  'FolderContentError',
  'FolderReadError',
  'UnknownHarnessError',
  'ExistingEntryError',
  'PublishError',
  'ServerRefusal',
  'SecureEnclaveError',
  'CdpError',
  'CdpClosedError',
  'ChromeLaunchError',
  'ProgramStorageError',
  'BrowserStillRunning',
  'MailRefusedError',
  'ProblemError',
  'WebauthnError',
  'PublishSourceFailure',
  'ContentStoreError',
  'RangeCopyTooLargeError',
  'Unreadable',
  'DocxLimitError',
  'DocumentTooLarge',
  'ModelParseError',
  'OtioPcmStopExpiredError',
  'ProgramRejection',
  'CompositionPlaybackDisabled',
  'OtioGatePreconstructionError',
  'OtioGateModuleLoadError',
  'OtioGateRenderClockError',
  'OtioGateAnchorLateError',
  'IsoEditGateFailure',
  'OtioVideoTimingScanFailure',
  'PublishFailure',
  'DownloadFailure',
  'LargeOpenCancelled',
  'ChangedDuringOpen',
  'JsxCompilerUnavailableError',
  'PrivateApiError',
  'PrfUnavailableError',
  'NoIdentityError',
  'PrivateRequestError',
  'SealMismatchError',
  'OwnerChangedError',
  'RecipientMissingError',
  'InvalidKeyResponseError',
  'TransferError',
  'VersionUnavailableError',
  'VerificationRefusedError',
  'UploadExpiredError',
  'ProgramRenderFailure',
  'NonError',
  'Other',
] as const);

type ErrorClass = (typeof ERROR_CLASSES)[number];

const ANY_METHOD_ROUTES = [
  '/',
  '/:id',
  '/health',
  '/robots.txt',
  '/policy',
  '/install',
  '/assets/*',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/sw.js',
  '/sandbox.html',
  '/api/error-reports',
] as const;
const METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'OTHER',
] as const;

export const SERVER_ROUTES: readonly string[] = Object.freeze([
  ...ANY_METHOD_ROUTES.flatMap((route) =>
    METHODS.map((method) => `${method} ${route}`)
  ),
  'GET /:id/cover/:asset',
  'HEAD /:id/cover/:asset',
  'GET /dashboard',
  'GET /dashb0ard',
  'GET /publish',
  'GET /abuse',
  'POST /abuse',
  'GET /api/presence/:roomId',
  'POST /api/challenge',
  'POST /api/grant',
  'POST /api/relics/:id/mint',
  'POST /api/relics/:id/complete',
  'POST /api/relics/:id/republish',
  'POST /api/relics/:id/cover',
  'DELETE /api/relics/:id',
  'POST /api/relics/:id/share',
  'GET /api/relics/:id/unsubscribe',
  'HEAD /api/relics/:id/unsubscribe',
  'POST /api/relics/:id/unsubscribe',
  'GET /api/relics/:id/comments',
  'POST /api/relics/:id/comments',
  'DELETE /api/relics/:id/comments/:commentId',
  'PATCH /api/relics/:id/comments/:commentId',
  'POST /api/auth/request',
  'POST /api/auth/code',
  'GET /api/auth/callback',
  'GET /api/auth/session',
  'GET /api/auth/relics',
  'GET /api/covers',
  'POST /api/relics/:id/settings',
  'POST /api/relics/:id/decisions',
  'POST /api/relics/:id/decisions/options',
  'POST /api/relics/:id/decisions/list',
  'POST /api/relics/:id/signing/requests',
  'POST /api/relics/:id/signing/cancel',
  'POST /api/relics/:id/signing/read',
  'POST /api/relics/:id/signing/options',
  'POST /api/relics/:id/signing/signatures',
  'POST /api/relics/:id/signing/certificate',
  'POST /api/relics/:id/receipts/opened',
  'POST /api/auth/passkeys',
  'POST /api/auth/passkeys/options',
  'POST /api/auth/passkeys/sign-in',
  'POST /api/auth/passkeys/sign-in/options',
  'POST /api/relics/:id/comments/list',
  'POST /api/attest/nonce',
  'GET /api/identity',
  'POST /api/identity',
  'POST /api/identity/credentials',
  'POST /api/identity/settings',
  'POST /api/identity/recovery/lookup',
  'POST /api/identity/recovery',
  'POST /api/identity/backfill',
  'GET /api/identity/relics',
  'GET /api/identity/access-log',
  'POST /api/devices/enrollments',
  'GET /api/devices/enrollments/:enrollmentId',
  'POST /api/devices/enrollments/:enrollmentId/approve',
  'GET /api/devices',
  'POST /api/devices/:deviceId/revoke',
  'POST /api/devices/:deviceId/context',
  'GET /api/relics/:id/access',
  'POST /api/relics/:id/requests',
  'GET /api/relics/:id/requests',
  'GET /api/relics/:id/invites',
  'POST /api/relics/:id/invites/:inviteId/revoke',
  'POST /api/relics/:id/invites/:inviteId/claim',
  'POST /api/relics/:id/invites/:inviteId/open',
  'POST /api/relics/:id/requests/:requestId/decline',
  'POST /api/relics/:id/grants/lookup',
  'POST /api/relics/:id/grants',
  'GET /api/relics/:id/grants',
  'POST /api/relics/:id/revocations',
  'POST /api/relics/:id/recipients',
  'POST /api/relics/:id/versions/:version/key',
  'POST /api/relics/:id/versions/:version/upload-grant',
  'POST /api/relics/:id/delete',
  'POST /api/relics/:id/owner',
  'other',
]);

export const VIEWER_ROUTES = Object.freeze([
  'public-open',
  'private-reader',
  'dashboard',
  'publish',
  'document',
] as const);

export const MCP_ROUTES = Object.freeze([
  'relic_publish',
  'relic_list',
  'relic_show',
  'relic_lookup_source',
  'relic_republish',
  'relic_share',
  'relic_read_comments',
  'relic_comment',
  'relic_edit_comment',
  'relic_resolve_comment',
  'relic_describe_client',
  'relic_read_decisions',
  'relic_settings',
  'relic_verify_certificate',
  'relic_cancel_signing',
  'relic_read_signing',
  'relic_request_signatures',
  'relic_enroll_device',
  'relic_confirm_device',
  'relic_bind_owner',
  'relic_apply_suggestions',
  'process',
] as const);

export const ERROR_REPORT_LOG_RETENTION_DAYS = 30;
export const ERROR_REPORT_DISCLOSED_FIELDS = Object.freeze([
  'v',
  'source',
  'errorClass',
  'route',
  'revision',
  'frames',
  'count',
] as const);

export type ReportSource = 'server' | 'viewer' | 'mcp';

export interface ErrorFrame {
  file: string;
  line: number;
  column: number;
}

export interface ErrorReport {
  v: 1;
  source: ReportSource;
  errorClass: ErrorClass;
  route: string;
  revision: string;
  frames: ErrorFrame[];
  count: number;
}

export interface KnownSets {
  revisions?: ReadonlySet<string>;
  mcpVersions?: ReadonlySet<string>;
  viewerFiles?: ReadonlySet<string>;
}

const ERROR_CLASS_SET = new Set<string>(ERROR_CLASSES);
const ROUTE_SETS: Record<ReportSource, ReadonlySet<string>> = {
  server: new Set(SERVER_ROUTES),
  viewer: new Set(VIEWER_ROUTES),
  mcp: new Set(MCP_ROUTES),
};
const FRAME_KEYS = ['file', 'line', 'column'] as const;
const REVISION = /^[0-9a-f]{40}$(?![\s\S])/;
const MCP_VERSION =
  /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$(?![\s\S])/;
const SERVER_FILE =
  /^packages\/relic-(server|format)\/src\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.ts$(?![\s\S])/;
const VIEWER_FILE =
  /^assets\/(?:viewer\.js|register-sw\.js|model-view\.js|pdf\.worker\.js|chunk-[a-z0-9]{8}\.js)$(?![\s\S])/;
const MCP_FILE = /^dist\/(?:relic-mcp|native-secure-open)\.js$(?![\s\S])/;
const MAX_POSITION = 10_000_000;

function hasExactDataKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

function positionInBounds(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= MAX_POSITION
  );
}

function fileAllowed(file: string, source: ReportSource): boolean {
  if (source === 'server') return SERVER_FILE.test(file);
  if (source === 'viewer') return VIEWER_FILE.test(file);
  return MCP_FILE.test(file);
}

function parseReport(input: unknown, known?: KnownSets): ErrorReport | null {
  if (!hasExactDataKeys(input, ERROR_REPORT_DISCLOSED_FIELDS)) return null;
  const { v, source, errorClass, route, revision, frames, count } = input;
  if (
    v !== 1 ||
    (source !== 'server' && source !== 'viewer' && source !== 'mcp')
  )
    return null;
  if (typeof errorClass !== 'string' || !ERROR_CLASS_SET.has(errorClass))
    return null;
  if (typeof route !== 'string' || !ROUTE_SETS[source].has(route)) return null;
  if (
    typeof revision !== 'string' ||
    !(source === 'mcp' ? MCP_VERSION : REVISION).test(revision)
  )
    return null;
  if (source === 'mcp') {
    if (known?.mcpVersions !== undefined && !known.mcpVersions.has(revision))
      return null;
  } else if (known?.revisions !== undefined && !known.revisions.has(revision))
    return null;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1_000_000
  )
    return null;
  if (!Array.isArray(frames) || frames.length > 8) return null;
  const parsedFrames: ErrorFrame[] = [];
  for (const frame of frames) {
    if (!hasExactDataKeys(frame, FRAME_KEYS)) return null;
    const { file, line, column } = frame;
    if (typeof file !== 'string' || !fileAllowed(file, source)) return null;
    if (
      source === 'viewer' &&
      known?.viewerFiles !== undefined &&
      !known.viewerFiles.has(file)
    )
      return null;
    if (!positionInBounds(line, 1) || !positionInBounds(column, 0)) return null;
    parsedFrames.push({ file, line, column });
  }
  return {
    v: 1,
    source,
    errorClass: errorClass as ErrorClass,
    route,
    revision,
    frames: parsedFrames,
    count,
  };
}

export function parseLoggedReport(
  input: unknown,
  known?: KnownSets
): ErrorReport | null {
  try {
    return parseReport(input, known);
  } catch {
    return null;
  }
}

export function parseClientReport(
  input: unknown,
  known?: KnownSets
): ErrorReport | null {
  const report = parseLoggedReport(input, known);
  return report !== null && report.source !== 'server' && report.count === 1
    ? report
    : null;
}

interface Location {
  location: string;
  line: number;
  column: number;
}

function stackLocation(raw: string): Location | null {
  const match = /^(.*):([0-9]+):([0-9]+)\)?$/.exec(raw.trim());
  if (match === null) return null;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (!positionInBounds(line, 1) || !positionInBounds(column, 0)) return null;
  let location = match[1]!;
  if (location.startsWith('at ')) {
    location = location.slice(3);
    const open = location.lastIndexOf(' (');
    if (open !== -1) location = location.slice(open + 2);
  } else if (!/^(?:https?:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/.test(location)) {
    const at = location.indexOf('@');
    if (at !== -1) location = location.slice(at + 1);
  }
  return { location, line, column };
}

export function viewerFramesFrom(stack: unknown, origin: string): ErrorFrame[] {
  if (typeof stack !== 'string') return [];
  try {
    const page = new URL(origin);
    if (
      (page.protocol !== 'http:' && page.protocol !== 'https:') ||
      page.username ||
      page.password
    )
      return [];
    const frames: ErrorFrame[] = [];
    for (const row of stack.split('\n')) {
      const item = stackLocation(row);
      if (item === null) continue;
      let url: URL;
      try {
        url = new URL(item.location);
      } catch {
        continue;
      }
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.origin !== page.origin ||
        url.username ||
        url.password
      )
        continue;
      const file = url.pathname.startsWith('/')
        ? url.pathname.slice(1)
        : url.pathname;
      if (!VIEWER_FILE.test(file)) continue;
      frames.push({ file, line: item.line, column: item.column });
      if (frames.length === 8) break;
    }
    return frames;
  } catch {
    return [];
  }
}

export function nodeFramesFrom(
  stack: unknown,
  kind: 'server' | 'mcp'
): ErrorFrame[] {
  if (typeof stack !== 'string' || (kind !== 'server' && kind !== 'mcp'))
    return [];
  const frames: ErrorFrame[] = [];
  for (const row of stack.split('\n')) {
    const item = stackLocation(row);
    if (item === null) continue;
    let path = item.location.replace(/\\/g, '/');
    if (path.startsWith('file://')) path = path.slice('file://'.length);
    else if (!/^(?:\/|\.\.?\/|packages\/|dist\/|[A-Za-z]:\/)/.test(path))
      continue;
    let file: string;
    if (kind === 'server') {
      const marker = path.lastIndexOf('/packages/');
      file = marker === -1 ? path : path.slice(marker + 1);
      if (!SERVER_FILE.test(file)) continue;
    } else {
      const marker = path.lastIndexOf('/relic-mcp/dist/');
      file = marker === -1 ? path : path.slice(marker + '/relic-mcp/'.length);
      if (!MCP_FILE.test(file)) continue;
    }
    frames.push({ file, line: item.line, column: item.column });
    if (frames.length === 8) break;
  }
  return frames;
}

export function classOf(error: unknown): ErrorClass {
  if (typeof error !== 'object' || error === null) return 'NonError';
  try {
    const errorConstructor: unknown = Reflect.get(error, 'constructor');
    if (
      (typeof errorConstructor === 'object' && errorConstructor !== null) ||
      typeof errorConstructor === 'function'
    ) {
      const name: unknown = Reflect.get(errorConstructor, 'name');
      if (typeof name === 'string' && ERROR_CLASS_SET.has(name))
        return name as ErrorClass;
    }
  } catch {
    // Try the error's own name if accessing its constructor failed.
  }
  try {
    const name: unknown = Reflect.get(error, 'name');
    if (typeof name === 'string' && ERROR_CLASS_SET.has(name))
      return name as ErrorClass;
  } catch {
    // A hostile thrown object must not make error reporting throw.
  }
  return 'Other';
}

/** Only these fields participate in fingerprinting, including file-only frames. */
export type ErrorFingerprintInput = Pick<
  ErrorReport,
  'source' | 'errorClass' | 'route'
> & {
  readonly frames: readonly Pick<ErrorFrame, 'file'>[];
};

export function fingerprintOf<T extends ErrorFingerprintInput>(
  report: T
): string {
  const files = report.frames
    .slice(0, 3)
    .map(({ file }) =>
      /^assets\/chunk-[a-z0-9]{8}\.js$/.test(file) ? 'assets/chunk.js' : file
    );
  const input = `relik-error-report/v1\n${report.source}\n${report.errorClass}\n${report.route}\n${files.join('\n')}`;
  return sha256Hex(new TextEncoder().encode(input)).slice(0, 16);
}
