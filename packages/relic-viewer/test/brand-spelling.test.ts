import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * The product is spelled Relik in everything a person reads: copy, emails,
 * error text and tool descriptions. `relic` stays in identifiers, package
 * names, API paths, storage keys and protocol labels, which a person never
 * reads and which other software depends on.
 *
 * This finds the word as copy: a string that is not a bare lowercase token,
 * with `relic` standing alone (not inside `relic_id`, `relic-mcp`, `relic/fp`,
 * a file name or a `relic: ` log label).
 */
const COPY_WORD =
  /(?<![\w\-/.#$@:\\])(?:RELIC|Relic|relic)S?(?![\w\-/@=]|\.[A-Za-z]|:\S)/i;

const PACKAGES = join(import.meta.dir, '..', '..');
const SOURCES = ['relic-viewer', 'relic-server', 'relic-mcp', 'relic-format'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'fixtures') {
      continue;
    }
    if (name.startsWith('.')) continue;
    // This file quotes the old spelling to prove the check finds it.
    if (name === 'brand-spelling.test.ts') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Copy strings in one file that spell the product `relic`. */
export function misspelled(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const textual =
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail;
    const module =
      node.parent !== undefined &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent) ||
        ts.isExternalModuleReference(node.parent) ||
        ts.isLiteralTypeNode(node.parent) ||
        ts.isImportTypeNode(node.parent));
    if (textual && !module) {
      const raw = node.getText(sf);
      const inner = raw.slice(1, -1);
      const logLabel = /^(['"`])relic: /.test(raw);
      // A quoted token inside a larger string is a key or a name (`meta["relic"]`,
      // the `relic` MCP server in `claude mcp add relic`), not copy.
      const body = (logLabel ? raw.slice(raw.indexOf(':') + 1) : raw)
        .replace(/(["'`])relics?\1/gi, '')
        .replace(/mcp add relic\b/g, '');
      if (!/^[a-z_-]+$/.test(inner) && COPY_WORD.test(body)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${file}:${line + 1}: ${raw.slice(0, 100)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('the product is spelled Relik wherever a person reads it', () => {
  test('flags copy that spells it relic, and leaves identifiers and labels alone', () => {
    const bad = misspelled(
      'x.ts',
      [
        "const a = 'Publish a relic';",
        'const b = `Your ${n} relics`;',
        "const c = 'relic_id';",
        "const d = 'relic-mcp is the package';",
        "const e = 'relic/fp/v1';",
        "const f = 'relic: passkey notice failed';",
        "const g = 'relic';",
        "const h = 'Relik is spelled right';",
        "const i = 'claude mcp add relic -- npx -y relic-mcp@latest';",
        `const j = 'item.metadata.get("relic")';`,
      ].join('\n')
    );
    expect(bad).toEqual(["x.ts:1: 'Publish a relic'", 'x.ts:2: } relics`']);
  });

  test('no source or test file writes copy with the old spelling', () => {
    const offenders: string[] = [];
    for (const pkg of SOURCES) {
      for (const file of sourceFiles(join(PACKAGES, pkg))) {
        offenders.push(
          ...misspelled(
            file.slice(PACKAGES.length + 1),
            readFileSync(file, 'utf8')
          )
        );
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
