#!/usr/bin/env node
/**
 * Exercise the npm tarball under plain Node after the source checkout is hidden.
 * This must remain independent of Bun, a compiler, Python, and workspace paths.
 */

import { createServer } from 'node:http';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const [, , givenTarball] = process.argv;
if (givenTarball === undefined) {
  throw new Error('usage: prove-packed-native.mjs <relic-mcp.tgz>');
}

const tarball = resolve(givenTarball);
const nodeBin = dirname(process.execPath);
const npm = join(nodeBin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
const nodeOnlyPath = `${nodeBin}${process.platform === 'win32' ? ';' : ':'}/usr/bin:/bin`;

function packagedTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'darwin-arm64';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'darwin-x64';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'linux-arm64-gnu';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'linux-x64-gnu';
  }
  throw new Error(`no packaged native target for ${process.platform}/${process.arch}`);
}

function recordAt(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringAt(record, field, label) {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${label}.${field} must be a string`);
  return value;
}

async function assertPackagedLaunchContract(packageRoot) {
  const packageMetadata = recordAt(
    JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
    'installed package.json'
  );
  const packageName = stringAt(packageMetadata, 'name', 'installed package.json');
  const packageVersion = stringAt(
    packageMetadata,
    'version',
    'installed package.json'
  );
  const expectedPackage = `${packageName}@${packageVersion}`;

  const plugin = recordAt(
    JSON.parse(
      await readFile(
        join(packageRoot, '.claude-plugin', 'plugin.json'),
        'utf8'
      )
    ),
    'installed plugin manifest'
  );
  const marketplace = recordAt(
    JSON.parse(
      await readFile(
        join(packageRoot, '.claude-plugin', 'marketplace.json'),
        'utf8'
      )
    ),
    'installed marketplace manifest'
  );
  const mcpServers = recordAt(
    JSON.parse(await readFile(join(packageRoot, 'mcp-servers.json'), 'utf8')),
    'installed MCP launch config'
  );
  const launcher = recordAt(mcpServers.relic, 'installed MCP launch config.relic');
  const args = launcher.args;
  if (
    stringAt(launcher, 'type', 'installed MCP launch config.relic') !== 'stdio' ||
    stringAt(launcher, 'command', 'installed MCP launch config.relic') !== 'npx' ||
    !Array.isArray(args) ||
    args.length !== 2 ||
    args[0] !== '-y' ||
    args[1] !== expectedPackage
  ) {
    throw new Error(
      `installed MCP launch config does not pin ${expectedPackage}`
    );
  }
  const env = recordAt(
    launcher.env,
    'installed MCP launch config.relic.env'
  );
  if (
    stringAt(
      env,
      'RELIC_CLIENT_NAME',
      'installed MCP launch config.relic.env'
    ) !== `relic-plugin/${packageVersion}`
  ) {
    throw new Error(
      `installed MCP launch config has the wrong client version for ${packageVersion}`
    );
  }

  const plugins = marketplace.plugins;
  if (!Array.isArray(plugins) || plugins.length !== 1) {
    throw new Error('installed marketplace manifest must carry one plugin');
  }
  const marketplacePlugin = recordAt(
    plugins[0],
    'installed marketplace manifest.plugins[0]'
  );
  const manifestVersions = [
    stringAt(plugin, 'version', 'installed plugin manifest'),
    stringAt(
      marketplacePlugin,
      'version',
      'installed marketplace manifest.plugins[0]'
    ),
    stringAt(
      recordAt(marketplace.metadata, 'installed marketplace manifest.metadata'),
      'version',
      'installed marketplace manifest.metadata'
    ),
  ];
  if (manifestVersions.some((version) => version !== packageVersion)) {
    throw new Error(
      `installed plugin manifests disagree with ${packageVersion}: ${manifestVersions.join(', ')}`
    );
  }
  if (stringAt(plugin, 'mcpServers', 'installed plugin manifest') !== './mcp-servers.json') {
    throw new Error('installed plugin manifest does not reference mcp-servers.json');
  }
}


function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      env: {
        ...process.env,
        ...options.env,
        BUN_INSTALL: '',
        NODE_PATH: '',
        PATH: nodeOnlyPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', rejectRun);
    child.on('close', (code) => {
      const output = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolveRun(output);
      else {
        rejectRun(
          new Error(
            `${command} ${args.join(' ')} exited ${code}\n${output.stdout}\n${output.stderr}`
          )
        );
      }
    });
  });
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('loopback proof server has no TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function callPublish(bin, cwd, origin, path) {
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'relic_publish',
      arguments: { path, cover: false },
    },
  });
  const child = spawn(process.execPath, [bin], {
    cwd,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_ORIGIN: origin,
      RELIC_CHROME_PATH: 'none',
      RELIC_PUBLISH_STATE: join(cwd, 'state.json'),
      BUN_INSTALL: '',
      NODE_PATH: '',
      PATH: nodeOnlyPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(`${request}\n`);
  const code = await new Promise((resolveClose, rejectClose) => {
    child.on('error', rejectClose);
    child.on('close', resolveClose);
  });
  const text = Buffer.concat(stdout).toString('utf8').trim();
  const lines = text.length === 0 ? [] : text.split('\n');
  const response = lines
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === 1);
  if (response === undefined) {
    throw new Error(
      `packed client did not return a publish response (exit ${code})\n${Buffer.concat(stderr).toString('utf8')}`
    );
  }
  return response;
}

async function main() {
  await access(tarball);
  const temporary = await mkdtemp(
    join(await realpath(tmpdir()), 'relic-mcp-packed-native-')
  );
  let hiddenSource;
  try {
    const install = join(temporary, 'install');
    const runtime = join(temporary, 'runtime');
    const copiedTarball = join(temporary, 'relic-mcp.tgz');
    await mkdir(install, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await copyFile(tarball, copiedTarball);
    await writeFile(join(install, 'package.json'), '{"private":true}\n');
    await run(npm, [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--offline',
      copiedTarball,
    ], { cwd: install });

    const packageRoot = join(install, 'node_modules', 'relic-mcp');
    const bin = join(packageRoot, 'dist', 'relic-mcp.js');
    await access(bin);
    await access(join(packageRoot, 'prebuilds'));
    await access(join(packageRoot, 'native'));
    await assertPackagedLaunchContract(packageRoot);
    await run(
      process.execPath,
      [
        join(packageRoot, 'native', 'build.mjs'),
        '--check',
        '--target',
        packagedTarget(),
      ],
      { cwd: runtime }
    );

    const uploaded = [];
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === '/api/challenge') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            challenge_nonce: 'packed-native-proof',
            size_limit_bytes: 1024 * 1024,
            size_basis: 'plaintext',
          })
        );
        return;
      }
      if (request.url === '/api/grant') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            publish_token: 'packed-native-proof-token',
            upload_url: `http://127.0.0.1:${server.address().port}/upload`,
            relic_expires_at: null,
            report_url: 'http://127.0.0.1/report',
            disclosure_url: 'http://127.0.0.1/disclosure',
          })
        );
        return;
      }
      if (request.url === '/upload' && request.method === 'PUT') {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          uploaded.push(Buffer.concat(chunks));
          response.writeHead(200).end();
        });
        return;
      }
      if (request.url?.endsWith('/complete')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      response.writeHead(404).end();
    });
    const origin = await listen(server);

    const valid = join(runtime, 'valid.otiod');
    await mkdir(valid);
    await writeFile(
      join(valid, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Clip.1',
        media_reference: { OTIO_SCHEMA: 'MissingReference.1' },
      })
    );
    const invalid = join(runtime, 'symlink.otiod');
    const outside = join(runtime, 'outside');
    await mkdir(join(invalid, 'media'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'secret.mp4'), 'outside bytes');
    await writeFile(
      join(invalid, 'content.otio'),
      JSON.stringify({
        OTIO_SCHEMA: 'Clip.1',
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: 'media/link/secret.mp4',
        },
      })
    );
    await symlink(outside, join(invalid, 'media', 'link'), 'dir');

    const sourceRoot = process.env['RELIC_MCP_PROVE_SOURCE_ROOT'];
    if (process.env['RELIC_MCP_PROVE_HIDE_SOURCE'] === '1') {
      if (sourceRoot === undefined) {
        throw new Error('RELIC_MCP_PROVE_SOURCE_ROOT is required when hiding source');
      }
      process.chdir(runtime);
      hiddenSource = `${sourceRoot}.hidden-packed-native-proof`;
      await rename(sourceRoot, hiddenSource);
    }

    try {
      const successful = await callPublish(bin, runtime, origin, valid);
      if (successful.result?.isError === true) {
        throw new Error(`packed client refused valid confined bundle: ${JSON.stringify(successful)}`);
      }
      if (uploaded.length !== 1) {
        throw new Error(`valid packed publish uploaded ${uploaded.length} objects, expected one`);
      }
      const requestsBeforeRefusal = requests.length;
      const refused = await callPublish(bin, runtime, origin, invalid);
      if (refused.result?.isError !== true) {
        throw new Error(`packed client accepted symlinked bundle: ${JSON.stringify(refused)}`);
      }
      if (requests.length !== requestsBeforeRefusal) {
        throw new Error('symlinked bundle reached the service after native confinement refusal');
      }
    } finally {
      await stop(server);
      if (hiddenSource !== undefined && sourceRoot !== undefined) {
        await rename(hiddenSource, sourceRoot);
        hiddenSource = undefined;
      }
    }
  } finally {
    if (hiddenSource !== undefined && process.env['RELIC_MCP_PROVE_SOURCE_ROOT'] !== undefined) {
      await rename(hiddenSource, process.env['RELIC_MCP_PROVE_SOURCE_ROOT']);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
console.log('packed native Node proof passed');
