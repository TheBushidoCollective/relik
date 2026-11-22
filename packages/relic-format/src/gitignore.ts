const ANY = 256;
const STAR = 257;
const GLOBSTAR = 258;
const DIRECTORIES = 259;
const DIRECTORY_BODY = 260;

export const MAX_IGNORE_PATTERN_BYTES = 1024;
export const MAX_IGNORE_RULES = 4096;

export class IgnoreLimitError extends Error {
  override readonly name = 'IgnoreLimitError';

  constructor(
    readonly kind: 'rules' | 'pattern_bytes' | 'work',
    readonly limit: number
  ) {
    super(
      kind === 'rules'
        ? `Too many ignore rules. The limit is ${limit}.`
        : kind === 'pattern_bytes'
          ? `An ignore pattern exceeds the ${limit}-byte limit.`
          : `Ignore rules are too complex to review safely. The work limit is ${limit}.`
    );
  }
}

export interface IgnoreMatcher {
  (path: string, isDirectory: boolean): boolean;
  add(file: { readonly dir: string; readonly text: string }): void;
  readonly work: number;
}

type CharacterClass = { readonly mask: Uint32Array; readonly negate: boolean };
type Token = number | CharacterClass;
type Rule = {
  dir: string;
  depth: number;
  scoped: boolean;
  simple: { kind: 'literal' | 'suffix'; bytes: Uint8Array } | undefined;
  pattern: Token[];
  directoryOnly: boolean;
  negate: boolean;
};

const encoder = new TextEncoder();

function add(mask: Uint32Array, byte: number): void {
  mask[byte >>> 5] = mask[byte >>> 5]! | (1 << (byte & 31));
}

function addRange(mask: Uint32Array, first: number, last: number): void {
  for (let byte = first; byte <= last; byte++) add(mask, byte);
}

function posixClass(name: string): Uint32Array | undefined {
  const mask = new Uint32Array(8);
  switch (name) {
    case 'alnum':
      addRange(mask, 48, 57);
      addRange(mask, 65, 90);
      addRange(mask, 97, 122);
      break;
    case 'alpha':
      addRange(mask, 65, 90);
      addRange(mask, 97, 122);
      break;
    case 'blank':
      add(mask, 9);
      add(mask, 32);
      break;
    case 'cntrl':
      addRange(mask, 0, 31);
      add(mask, 127);
      break;
    case 'digit':
      addRange(mask, 48, 57);
      break;
    case 'graph':
      addRange(mask, 33, 126);
      break;
    case 'lower':
      addRange(mask, 97, 122);
      break;
    case 'print':
      addRange(mask, 32, 126);
      break;
    case 'punct':
      addRange(mask, 33, 47);
      addRange(mask, 58, 64);
      addRange(mask, 91, 96);
      addRange(mask, 123, 126);
      break;
    case 'space':
      addRange(mask, 9, 13);
      add(mask, 32);
      break;
    case 'upper':
      addRange(mask, 65, 90);
      break;
    case 'xdigit':
      addRange(mask, 48, 57);
      addRange(mask, 65, 70);
      addRange(mask, 97, 102);
      break;
    default:
      return undefined;
  }
  return mask;
}

function isAlphanumeric(byte: number): boolean {
  return (
    (byte >= 48 && byte <= 57) ||
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122)
  );
}

function characterClass(
  pattern: string,
  start: number
): { token: CharacterClass; end: number } | undefined {
  let end = start + 1;
  if (pattern[end] === '!' || pattern[end] === '^') end++;
  if (pattern[end] === ']') end++;
  let hasPosixClose = true;
  while (end < pattern.length && pattern[end] !== ']') {
    if (pattern[end] === '\\' && end + 1 < pattern.length) end++;
    else if (
      hasPosixClose &&
      pattern[end] === '[' &&
      pattern[end + 1] === ':'
    ) {
      const close = pattern.indexOf(':]', end + 2);
      if (close === -1) hasPosixClose = false;
      else end = close + 1;
    }
    end++;
  }
  if (end >= pattern.length) return undefined;
  let index = start + 1;
  const negate = pattern[index] === '!' || pattern[index] === '^';
  if (negate) index++;
  const atoms: { value: number | Uint32Array; escaped: boolean }[] = [];
  let hasMorePosixClose = true;
  while (index < end) {
    if (pattern[index] === '\\') {
      index++;
      if (index >= end) return undefined;
      atoms.push({ value: pattern.charCodeAt(index++), escaped: true });
    } else if (
      hasMorePosixClose &&
      pattern[index] === '[' &&
      pattern[index + 1] === ':'
    ) {
      const close = pattern.indexOf(':]', index + 2);
      if (close === -1 || close >= end) {
        hasMorePosixClose = false;
        atoms.push({ value: pattern.charCodeAt(index++), escaped: false });
        continue;
      }
      const mask = posixClass(pattern.slice(index + 2, close));
      if (!mask) return undefined;
      atoms.push({ value: mask, escaped: false });
      index = close + 2;
    } else {
      atoms.push({ value: pattern.charCodeAt(index++), escaped: false });
    }
  }
  const mask = new Uint32Array(8);
  for (let i = 0; i < atoms.length; i++) {
    const value = atoms[i]!.value;
    const dash = atoms[i + 1];
    const last = atoms[i + 2]?.value;
    if (
      typeof value === 'number' &&
      dash?.value === 45 &&
      !dash.escaped &&
      typeof last === 'number'
    ) {
      if (value <= last) addRange(mask, value, last);
      else if (isAlphanumeric(value) && isAlphanumeric(last)) add(mask, value);
      else return undefined;
      i += 2;
    } else if (typeof value === 'number') add(mask, value);
    else
      for (let word = 0; word < mask.length; word++)
        mask[word] = mask[word]! | value[word]!;
  }
  return { token: { mask, negate }, end };
}

/** Compile a byte-oriented glob into a Thompson-style NFA, not a regexp. */
function glob(pattern: string): Token[] | undefined {
  const result: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === '\\') {
      if (++i >= pattern.length) return undefined;
      result.push(pattern.charCodeAt(i));
    } else if (char === '*') {
      let end = i;
      while (pattern[end + 1] === '*') end++;
      const double = end > i;
      const before = i === 0 || pattern[i - 1] === '/';
      const after = end + 1 === pattern.length || pattern[end + 1] === '/';
      if (double && before && after) {
        if (pattern[end + 1] === '/') {
          result.push(DIRECTORIES, DIRECTORY_BODY);
          end++;
        } else result.push(GLOBSTAR);
      } else result.push(STAR);
      i = end;
    } else if (char === '?') result.push(ANY);
    else if (char === '[') {
      const parsed = characterClass(pattern, i);
      if (!parsed) return undefined;
      result.push(parsed.token);
      i = parsed.end;
    } else result.push(pattern.charCodeAt(i));
  }
  return result;
}

function matchGlob(pattern: readonly Token[], path: Uint8Array): boolean {
  let current = new Uint8Array(pattern.length + 1);
  let next = new Uint8Array(pattern.length + 1);
  current[0] = 1;
  for (const byte of path) {
    next.fill(0);
    for (let i = 0; i < pattern.length; i++) {
      if (!current[i]) continue;
      const token = pattern[i]!;
      if (token === STAR || token === GLOBSTAR) {
        current[i + 1] = 1;
        if (token === GLOBSTAR || byte !== 47) next[i] = 1;
      } else if (token === DIRECTORIES) {
        current[i + 2] = 1;
        if (byte !== 47) next[i + 1] = 1;
      } else if (token === DIRECTORY_BODY) {
        next[byte === 47 ? i - 1 : i] = 1;
      } else if (token === ANY) {
        if (byte !== 47) next[i + 1] = 1;
      } else if (typeof token === 'number') {
        if (token === byte) next[i + 1] = 1;
      } else if (byte !== 47) {
        const included = (token.mask[byte >>> 5]! & (1 << (byte & 31))) !== 0;
        if (included !== token.negate) next[i + 1] = 1;
      }
    }
    [current, next] = [next, current];
  }
  for (let i = 0; i < pattern.length; i++) {
    if (!current[i]) continue;
    const token = pattern[i];
    if (token === STAR || token === GLOBSTAR) current[i + 1] = 1;
    else if (token === DIRECTORIES) current[i + 2] = 1;
  }
  return current[pattern.length] === 1;
}
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    let slash = end - 2;
    while (slash >= 0 && line[slash] === '\\') slash--;
    if ((end - 2 - slash) % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/**
 * Match repository-relative paths against per-directory .gitignore files.
 * This does not consult core.ignoreCase, global excludes, .git/info/exclude,
 * or submodule repositories. Paths use forward slashes and are case-sensitive.
 */
export function createIgnoreMatcher(
  files: readonly { dir: string; text: string }[],
  options: { readonly maxWork?: number; readonly maxMatchWork?: number } = {}
): IgnoreMatcher {
  for (const limit of [options.maxWork, options.maxMatchWork]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new RangeError(
        'Ignore work limit must be a nonnegative safe integer'
      );
  }
  const maxWork = options.maxWork ?? Number.POSITIVE_INFINITY;
  const maxMatchWork = options.maxMatchWork ?? Number.POSITIVE_INFINITY;
  const rules: Rule[] = [];
  const directoryCache = new Map<string, boolean>();
  let ruleCount = 0;
  let used = 0;
  let failure: IgnoreLimitError | undefined;
  const fail = (
    kind: 'rules' | 'pattern_bytes' | 'work',
    limit: number
  ): never => {
    failure = new IgnoreLimitError(kind, limit);
    throw failure;
  };
  const charge = (amount: number) => {
    if (amount > maxWork - used) fail('work', maxWork);
    used += amount;
  };
  const addRules = (file: { readonly dir: string; readonly text: string }) => {
    if (failure) throw failure;
    directoryCache.clear();
    const depth = file.dir ? file.dir.split('/').length : 0;
    for (const raw of file.text.split('\n')) {
      let line = trimTrailingSpaces(
        raw.endsWith('\r') ? raw.slice(0, -1) : raw
      );
      if (!line || line[0] === '#') continue;
      const negate = line[0] === '!';
      if (negate) line = line.slice(1);
      if (!line) continue;
      const directoryOnly = line.endsWith('/');
      if (directoryOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/');
      if (anchored) line = line.slice(1);
      if (!line) continue;
      if (++ruleCount > MAX_IGNORE_RULES) fail('rules', MAX_IGNORE_RULES);
      const bytes = encoder.encode(line);
      if (bytes.length > MAX_IGNORE_PATTERN_BYTES)
        fail('pattern_bytes', MAX_IGNORE_PATTERN_BYTES);
      const scoped = anchored || line.includes('/');
      let patternBytes = '';
      for (const byte of bytes) patternBytes += String.fromCharCode(byte);
      const pattern = glob(patternBytes);
      if (!pattern) continue;
      let simple: Rule['simple'];
      if (pattern.every((token) => typeof token === 'number' && token < 256))
        simple = {
          kind: 'literal',
          bytes: Uint8Array.from(pattern as number[]),
        };
      else if (
        !scoped &&
        (pattern[0] === STAR || pattern[0] === GLOBSTAR) &&
        pattern
          .slice(1)
          .every((token) => typeof token === 'number' && token < 256)
      )
        simple = {
          kind: 'suffix',
          bytes: Uint8Array.from(pattern.slice(1) as number[]),
        };
      rules.push({
        dir: file.dir,
        depth,
        scoped,
        simple,
        pattern,
        directoryOnly,
        negate,
      });
    }
    rules.sort((a, b) => a.depth - b.depth);
  };
  const match = (path: string, isDirectory: boolean): boolean => {
    if (failure) throw failure;
    if (!rules.length) return false;
    const parts = path.split('/');
    let candidate = '';
    for (let i = 0; i < parts.length; i++) {
      candidate = candidate ? `${candidate}/${parts[i]}` : parts[i]!;
      const directory = i < parts.length - 1 || isDirectory;
      if (directory) {
        const cached = directoryCache.get(candidate);
        if (cached !== undefined) {
          if (cached) return true;
          continue;
        }
      }
      let ignored = false;
      const encoded = new Map<string, Uint8Array>();
      for (const rule of rules) {
        charge(1);
        if (rule.directoryOnly && !directory) continue;
        if (rule.dir && !candidate.startsWith(`${rule.dir}/`)) continue;
        const key = rule.scoped ? rule.dir : '\0';
        let relative = encoded.get(key);
        if (!relative) {
          relative = encoder.encode(
            rule.scoped
              ? rule.dir
                ? candidate.slice(rule.dir.length + 1)
                : candidate
              : parts[i]!
          );
          encoded.set(key, relative);
        }
        let matches: boolean;
        if (rule.simple) {
          const expected = rule.simple.bytes;
          const offset = relative.length - expected.length;
          matches =
            offset >= 0 && (rule.simple.kind === 'suffix' || offset === 0);
          let work = 1;
          for (let j = expected.length - 1; matches && j >= 0; j--) {
            work++;
            if (relative[offset + j] !== expected[j]) matches = false;
          }
          charge(work);
        } else {
          const work = (rule.pattern.length + 1) * (relative.length + 1);
          if (work > maxMatchWork) fail('work', maxMatchWork);
          charge(work);
          matches = matchGlob(rule.pattern, relative);
        }
        if (matches) ignored = !rule.negate;
      }
      if (directory) directoryCache.set(candidate, ignored);
      if (ignored) return true;
    }
    return false;
  };
  const matcher = Object.assign(match, { add: addRules });
  Object.defineProperty(matcher, 'work', { get: () => used });
  for (const file of files) addRules(file);
  return matcher as IgnoreMatcher;
}
