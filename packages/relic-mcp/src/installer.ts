/**
 * The `relic-mcp install` command.
 *
 * Everything that decides *what* to write lives in `install.ts` and is pure.
 * This file is the part that touches the disk and talks to the user, kept thin
 * on purpose: it is the half that can damage somebody's editor configuration,
 * and the less logic it holds the less there is to get wrong.
 */

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SERVER_SPEC,
  ExistingEntryError,
  HARNESSES,
  planFor,
  type ServerSpec,
  snippetFor,
  UnknownHarnessError,
} from './install.ts';
import { requiredOrigin } from './origin.ts';

export const USAGE = `relic-mcp - publish a file as an encrypted, shareable link

  relic-mcp                      run the MCP server on stdio
  relic-mcp install [options]    add this server to an agent harness
  relic-mcp --help               this

Install options:
  --client <id>     ${HARNESSES.map((h) => h.id).join(', ')}
                    Omit to see which of these are installed here.
  --origin <url>    The Relik service to publish to. Falls back to
                    RELIC_SERVICE_ORIGIN.
  --name <name>     Server name in the config. Default: relik.
  --print           Write nothing; print the config to paste.
  --force           Replace an existing entry of the same name.
  --dry-run         Show the file and what would change, without writing.
`;

interface Options {
  client: string | undefined;
  origin: string | undefined;
  name: string;
  print: boolean;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    client: undefined,
    origin: undefined,
    name: 'relic',
    print: false,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };

    if (arg === '--client') options.client = next();
    else if (arg === '--origin') options.origin = next();
    else if (arg === '--name') options.name = next();
    else if (arg === '--print') options.print = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option ${arg}`);
  }

  return options;
}

/** The directory of the installed package, which is also the plugin root. */
function packageRoot(): string {
  // dist/relic-mcp.js -> the package directory.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

async function exists(path: string): Promise<boolean> {
  return readFile(path)
    .then(() => true)
    .catch(() => false);
}

export async function runInstall(argv: readonly string[]): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  // The command comes from the shared default so the versioned npx spec
  // lives in exactly one place; the name stays the caller's, and the origin
  // is resolved only on paths that write or print, so a bare `install` can
  // still just list what it detected.
  const spec: ServerSpec = { ...DEFAULT_SERVER_SPEC, name: options.name };

  if (options.print && options.client === undefined) {
    process.stdout.write(snippetFor(withOrigin(spec, options)));
    return;
  }

  if (options.client === undefined) {
    await reportDetected();
    return;
  }

  const resolved = withOrigin(spec, options);

  if (options.client === 'claude-code') {
    await installClaudeCode(options);
    return;
  }

  const home = homedir();
  const harness = HARNESSES.find((h) => h.id === options.client);
  if (harness === undefined) {
    process.stderr.write(
      `Unknown client ${options.client}. Known: ` +
        `${HARNESSES.map((h) => h.id).join(', ')}\n`
    );
    process.exit(2);
  }

  const path = join(home, harness.configPath);
  const existing = await readFile(path, 'utf8').catch(() => undefined);

  let plan: ReturnType<typeof planFor>;
  try {
    plan = planFor(options.client, resolved, existing, {
      force: options.force,
    });
  } catch (error) {
    if (
      error instanceof ExistingEntryError ||
      error instanceof UnknownHarnessError
    ) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  if (options.print) {
    process.stdout.write(plan.contents);
    return;
  }

  if (options.dryRun) {
    process.stdout.write(
      `Would ${plan.replaced ? 'replace' : 'add'} "${resolved.name}" in ${path}\n`
    );
    return;
  }

  // Back up before touching a file this tool did not create. Cheap, and the
  // difference between an annoying mistake and a lost configuration.
  if (existing !== undefined) {
    await copyFile(path, `${path}.relic-backup`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.contents);

  process.stdout.write(
    `${plan.replaced ? 'Replaced' : 'Added'} "${resolved.name}" in ${path}\n` +
      (existing === undefined
        ? ''
        : `Previous config saved to ${path}.relic-backup\n`) +
      `Restart ${harness.label} to pick it up.\n`
  );
}

/**
 * Claude Code installs as a plugin rather than a bare server, because the
 * plugin also carries the skill that tells the agent when publishing is the
 * right move. The package ships the manifests, so the marketplace source is
 * this directory on disk and no clone is involved.
 */
async function installClaudeCode(options: Options): Promise<void> {
  const root = packageRoot();

  if (!(await exists(join(root, '.claude-plugin', 'marketplace.json')))) {
    process.stderr.write(
      'This copy of relic-mcp does not carry the plugin manifests, so it ' +
        'cannot be installed as a Claude Code plugin. Use --print and add ' +
        'the server manually, or install a newer version.\n'
    );
    process.exit(1);
  }

  if (options.dryRun) {
    process.stdout.write(
      `Would add marketplace ${root} and install relic@relic\n`
    );
    return;
  }

  for (const args of [
    ['plugin', 'marketplace', 'add', root],
    ['plugin', 'install', 'relic@relic'],
  ]) {
    const result = spawnSync('claude', args, { stdio: 'inherit' });
    if (result.error !== undefined || result.status !== 0) {
      process.stderr.write(
        `\nclaude ${args.join(' ')} failed. Is the Claude Code CLI on PATH?\n`
      );
      process.exit(1);
    }
  }

  process.stdout.write('\nRestart Claude Code to pick it up.\n');
}

function withOrigin(spec: ServerSpec, options: Options): ServerSpec {
  const raw = options.origin ?? process.env['RELIC_SERVICE_ORIGIN'];

  // Nothing named, so nothing is written. The client resolves the hosted
  // service on its own, and a config carrying the default would be a knob
  // that looks like a decision: the next reader cannot tell whether the
  // origin was chosen or inherited, and it goes stale if the service ever
  // moves.
  if (raw === undefined || raw.trim().length === 0) return spec;

  let origin: string;
  try {
    origin = requiredOrigin('--origin', raw);
  } catch (error) {
    process.stderr.write(
      `${(error as Error).message}\n\nPass --origin https://your-relic.example\n`
    );
    process.exit(2);
  }
  return { ...spec, env: { RELIC_SERVICE_ORIGIN: origin } };
}

/** What is actually on this machine, so the next command is obvious. */
async function reportDetected(): Promise<void> {
  const home = homedir();
  const lines: string[] = ['Harnesses detected here:', ''];

  for (const harness of HARNESSES) {
    if (harness.format === 'plugin') {
      const found = spawnSync('claude', ['--version'], { stdio: 'ignore' });
      lines.push(
        `  ${found.status === 0 ? '*' : ' '} ${harness.id.padEnd(15)}${harness.label}`
      );
      continue;
    }
    // The directory rather than the file: a harness that has never had an MCP
    // server configured has no config file yet, and is still installed.
    const dir = dirname(join(home, harness.configPath));
    const found = await stat(dir)
      .then((info) => info.isDirectory())
      .catch(() => false);
    lines.push(
      `  ${found ? '*' : ' '} ${harness.id.padEnd(15)}${harness.label}`
    );
  }

  lines.push('', 'Install with:', '  relic-mcp install --client <id>', '');
  process.stdout.write(lines.join('\n'));
}
