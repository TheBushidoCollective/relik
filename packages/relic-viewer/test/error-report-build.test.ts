import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClientReport } from '@relic/format/error-report';
import * as ts from 'typescript';
import { reporterPageStateReferences } from './error-report-guard.ts';

const pkgDir = new URL('..', import.meta.url).pathname;
const revision = 'a'.repeat(40);

function build(outdir: string, maps: boolean): void {
  const env = { ...process.env };
  if (maps) env['RELIC_VIEWER_SOURCEMAP'] = '1';
  else delete env['RELIC_VIEWER_SOURCEMAP'];
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { buildViewer } from './build.ts'; await buildViewer({ outdir: ${JSON.stringify(outdir)} });`,
    ],
    { cwd: pkgDir, env, stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
}

function frameAllowed(file: string): boolean {
  return (
    parseClientReport({
      v: 1,
      source: 'viewer',
      errorClass: 'Error',
      route: 'public-open',
      revision,
      frames: [{ file: `assets/${file}`, line: 1, column: 0 }],
      count: 1,
    }) !== null
  );
}

function builtReporterRegions(name: string, code: string): ts.Node[] {
  const source = ts.createSourceFile(
    name,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const regions: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text === '/api/error-reports') {
      let parent: ts.Node | undefined = node.parent;
      while (parent && parent !== source) {
        if (
          ts.isFunctionLike(parent) &&
          parent.getText(source).includes('unhandledrejection')
        ) {
          regions.push(parent);
          break;
        }
        parent = parent.parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return regions;
}

/** Resolve a local constant used as import(constant), or refuse the build. */
function importArgument(node: ts.CallExpression): string {
  const argument = node.arguments[0];
  if (argument && ts.isStringLiteralLike(argument)) return argument.text;
  // PDF.js imports its configured worker in the window if Worker setup fails.
  if (
    argument &&
    ts.isPropertyAccessExpression(argument) &&
    argument.expression.kind === ts.SyntaxKind.ThisKeyword &&
    argument.name.text === 'workerSrc' &&
    node.getSourceFile().text.includes('GlobalWorkerOptions') &&
    node.getSourceFile().text.includes('WorkerMessageHandler')
  )
    return '/assets/pdf.worker.js';
  if (!argument || !ts.isIdentifier(argument))
    throw new Error(
      `viewer has an unbounded dynamic import in ${node.getSourceFile().fileName}: ${node.getText()}`
    );
  const name = argument.text;
  let scope: ts.Node | undefined = node.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
    scope = scope.parent;
  if (!scope) throw new Error('dynamic import has no scope');
  const candidates: string[] = [];
  const visit = (child: ts.Node): void => {
    if (child !== scope && ts.isFunctionLike(child)) return;
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.name.text === name &&
      child.initializer &&
      ts.isStringLiteralLike(child.initializer)
    )
      candidates.push(child.initializer.text);
    ts.forEachChild(child, visit);
  };
  visit(scope);
  if (candidates.length !== 1)
    throw new Error(`viewer dynamic import ${name} has no fixed asset`);
  return candidates[0]!;
}

async function windowScriptGraph(
  out: string,
  initial: string[]
): Promise<Set<string>> {
  const pending = [...initial];
  const visited = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    expect(frameAllowed(name)).toBe(true);
    visited.add(name);
    // The server supplies this fixed script directly rather than emitting it.
    if (name === 'register-sw.js') continue;
    // The readable PDF.js worker is copied verbatim. Its only import targets
    // an unshipped OpenJPEG fallback; the viewer leaves wasmUrl unset.
    if (name === 'pdf.worker.js') {
      const worker = await Bun.file(`${out}${name}`).text();
      expect([...worker.matchAll(/\bimport\s*\(/g)]).toHaveLength(1);
      expect(worker).toContain('openjpeg_nowasm_fallback.js');
      expect(
        (await readdir(out)).some((file) =>
          file.endsWith('openjpeg_nowasm_fallback.js')
        )
      ).toBe(false);
      continue;
    }
    const code = await Bun.file(`${out}${name}`).text();
    const source = ts.createSourceFile(
      name,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        imports.push(importArgument(node));
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of imports) {
      const name = specifier.startsWith('./')
        ? specifier.slice(2)
        : specifier.startsWith('/assets/')
          ? specifier.slice('/assets/'.length)
          : '';
      if (!name)
        throw new Error(`viewer imports a non-asset script: ${specifier}`);
      expect(frameAllowed(name)).toBe(true);
      pending.push(name);
    }
  }
  return visited;
}

test('viewer-window scripts are reportable and optional maps reproduce shipped locations', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'relik-viewer-report-'));
  const out = `${scratch}/mapped/`;
  const normal = `${scratch}/normal/`;
  try {
    const fixed = [
      'viewer.js',
      'register-sw.js',
      'model-view.js',
      'pdf.worker.js',
    ];
    for (const name of [...fixed, 'chunk-a1b2c3d4.js'])
      expect(frameAllowed(name)).toBe(true);
    for (const name of [
      'landing.js',
      'sw.js',
      'sandbox.js',
      'model-parse-worker.js',
      'spreadsheet-parse-worker.js',
      'otio-video-timing-worker.js',
      'otio-audio-pcm-worker.js',
      'otio-transport-gate-worklet.js',
      'chunk-ABC12345.js',
      'chunk-123456789.js',
    ])
      expect(frameAllowed(name)).toBe(false);

    const app = await Bun.file(`${pkgDir}../relic-server/src/app.ts`).text();
    const shellStart = app.indexOf('<div id="relic-root"');
    expect(shellStart).toBeGreaterThan(-1);
    const shellEnd = app.indexOf('\n`;', shellStart);
    expect(shellEnd).toBeGreaterThan(shellStart);
    const shellScripts = [
      ...app
        .slice(shellStart, shellEnd)
        .matchAll(/<script\b[^>]*\bsrc="\/assets\/([^"?]+)(?:\?[^"]*)?"/g),
    ].map((match) => match[1]!);
    expect(shellScripts.sort()).toEqual(['register-sw.js', 'viewer.js']);
    for (const name of ['pdf.ts', 'publish-cover-pdf.ts']) {
      const source = await Bun.file(`${pkgDir}src/${name}`).text();
      expect(source).toContain(
        "pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.js'"
      );
      expect(source).not.toContain('wasmUrl');
    }

    build(out, true);
    const mappedNames = await readdir(out);
    const chunks = mappedNames.filter((name) => /^chunk-.*\.js$/.test(name));
    expect(chunks.length).toBeGreaterThan(0);
    for (const name of chunks) expect(frameAllowed(name)).toBe(true);
    const graph = await windowScriptGraph(out, shellScripts);
    expect(graph.has('model-view.js')).toBe(true);
    expect(graph.has('pdf.worker.js')).toBe(true);
    const mappedFiles = ['viewer.js', 'model-view.js', ...chunks];
    const sourceContents = new Map<string, string>();
    const reporterRegions: ts.Node[] = [];
    for (const name of mappedFiles) {
      const code = await Bun.file(`${out}${name}`).text();
      sourceContents.set(name, code);
      if (code.includes('/api/error-reports'))
        reporterRegions.push(...builtReporterRegions(name, code));
      const map = JSON.parse(await Bun.file(`${out}${name}.map`).text());
      expect(map.version).toBe(3);
      if (name === 'viewer.js' || name === 'model-view.js')
        expect(map.sources.length).toBeGreaterThan(0);
      // Bun emits helper-only chunks with no corresponding source file.
      if (map.sources.length > 0)
        expect(map.mappings.length).toBeGreaterThan(0);
    }
    expect(reporterRegions).toHaveLength(1);
    expect(reporterPageStateReferences(reporterRegions[0]!)).toEqual([]);

    build(normal, false);
    const normalNames = await readdir(normal);
    expect(normalNames.filter((name) => name.endsWith('.js.map'))).toEqual([]);
    expect(
      normalNames.filter((name) => /^chunk-.*\.js$/.test(name)).sort()
    ).toEqual(chunks.sort());
    for (const [name, mappedCode] of sourceContents) {
      // Bun adds this trailing debug identifier only when source maps are on.
      // Removing the final comment cannot change a mapped line or column.
      const withoutDebugId = mappedCode.replace(
        /\n\/\/# debugId=[0-9a-f]+\n?$/i,
        ''
      );
      expect(await Bun.file(`${normal}${name}`).text()).toBe(withoutDebugId);
    }
    build(out, false);
    expect(
      (await readdir(out)).filter((name) => name.endsWith('.js.map'))
    ).toEqual([]);
    const dockerignore = await Bun.file(`${pkgDir}../../.dockerignore`).text();
    expect(dockerignore.split(/\r?\n/)).toContain('**/dist');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);
