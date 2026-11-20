type Rule = {
  dir: string;
  pattern: RegExp;
  directoryOnly: boolean;
  negate: boolean;
};

function literal(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function glob(pattern: string): string {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      if (++i < pattern.length) result += literal(pattern[i]);
      else result += '\\\\';
    } else if (char === '*') {
      let end = i;
      while (pattern[end + 1] === '*') end++;
      const double = end > i;
      const before = i === 0 || pattern[i - 1] === '/';
      const after = end + 1 === pattern.length || pattern[end + 1] === '/';
      if (double && before && after) {
        if (pattern[end + 1] === '/') {
          result += '(?:[^/]+/)*';
          end++;
        } else result += '.*';
      } else result += '[^/]*';
      i = end;
    } else if (char === '?') result += '[^/]';
    else if (char === '[') {
      let end = i + 1;
      if (pattern[end] === '!' || pattern[end] === '^') end++;
      if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') {
        if (pattern[end] === '\\' && end + 1 < pattern.length) end++;
        end++;
      }
      if (end === pattern.length) result += '\\[';
      else {
        let content = pattern.slice(i + 1, end);
        if (content[0] === '!') content = `^${content.slice(1)}`;
        else if (content[0] === '^') content = `\\${content}`;
        result += `(?!/)[${content}]`;
        i = end;
      }
    } else result += literal(char);
  }
  return result;
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
  files: readonly { dir: string; text: string }[]
): (path: string, isDirectory: boolean) => boolean {
  const rules: Rule[] = [];
  const ordered = [...files].sort(
    (a, b) => a.dir.split('/').length - b.dir.split('/').length
  );
  for (const file of ordered) {
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
      const scoped = anchored || line.includes('/');
      rules.push({
        dir: file.dir,
        pattern: new RegExp(`^${scoped ? '' : '(?:.*/)?'}${glob(line)}$`),
        directoryOnly,
        negate,
      });
    }
  }
  return (path, isDirectory) => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const candidate = parts.slice(0, i).join('/');
      const directory = i < parts.length || isDirectory;
      let ignored = false;
      for (const rule of rules) {
        if (rule.directoryOnly && !directory) continue;
        if (rule.dir && !candidate.startsWith(`${rule.dir}/`)) continue;
        const relative = rule.dir
          ? candidate.slice(rule.dir.length + 1)
          : candidate;
        if (rule.pattern.test(relative)) ignored = !rule.negate;
      }
      if (ignored) return true;
    }
    return false;
  };
}
