#!/usr/bin/env node
/**
 * Exercise the npm tarball under plain Node after the source checkout is hidden
 * or absent. This stays independent of Bun, a compiler, Python, and workspace
 * paths.
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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [, , givenTarball] = process.argv;
if (givenTarball === undefined) {
  throw new Error('usage: prove-packed-native.mjs <relic-mcp.tgz>');
}

const tarball = resolve(givenTarball);
const nodeBin = dirname(process.execPath);
const nodePrefix = dirname(nodeBin);
const npmCli = join(nodePrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const nodeOnlyPath = nodeBin;
const packagedTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-x64-gnu',
];

const packagedFloors = {
  'darwin-arm64': { macOS: '15.0' },
  'darwin-x64': { macOS: '15.0' },
  'linux-arm64-gnu': { glibc: '2.28' },
  'linux-x64-gnu': { glibc: '2.28' },
};

const clearedRuntimeEnvironment = new Set([
  'ALL_PROXY',
  'AR',
  'AS',
  'BUN_INSTALL',
  'BUN_RUNTIME',
  'CC',
  'CFLAGS',
  'CMAKE',
  'CONDA_DEFAULT_ENV',
  'CONDA_PREFIX',
  'CPP',
  'CPPFLAGS',
  'CXX',
  'CXXFLAGS',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'GYP',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'INIT_CWD',
  'LD',
  'LDFLAGS',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'MAKE',
  'MAKEFLAGS',
  'MESON',
  'NINJA',
  'NODE_EXTRA_CA_CERTS',
  'NODE_GYP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_HISTORY',
  'NO_PROXY',
  'OLDPWD',
  'PWD',
  'PYTHON',
  'PYTHONHOME',
  'PYTHONPATH',
  'RANLIB',
  'RELIC_MCP_PROVE_HIDE_SOURCE',
  'RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER',
  'RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER_PATH',
  'RELIC_MCP_PROVE_INSTALLED_NATIVE_RUNTIME',
  'RELIC_MCP_PROVE_SOURCE_ROOT',
  'RUSTC',
  'STRIP',
  'VIRTUAL_ENV',
]);

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

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function errorField(error, field) {
  return typeof error === 'object' && error !== null && field in error
    ? error[field]
    : undefined;
}

function nativeRefusalDetails(error) {
  const describe = (value) =>
    typeof value === 'string' ? JSON.stringify(value) : String(value);
  return `code=${describe(errorField(error, 'code'))}, errno=${describe(errorField(error, 'errno'))}, syscall=${describe(errorField(error, 'syscall'))}, message=${describe(errorField(error, 'message'))}`;
}

function nodeOnlyEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase();
    if (
      clearedRuntimeEnvironment.has(upper) ||
      upper.startsWith('NPM_CONFIG_') ||
      upper.startsWith('NPM_LIFECYCLE_') ||
      upper.startsWith('NPM_PACKAGE_')
    ) {
      delete environment[name];
    }
  }
  return { ...environment, ...overrides, PATH: nodeOnlyPath };
}

async function assertAbsent(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
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

async function assertPackagedNativeFiles(packageRoot) {
  const packageMetadata = recordAt(
    JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
    'installed package.json'
  );
  const nativeContract = recordAt(
    packageMetadata.relicNativeSecureOpen,
    'installed package.json.relicNativeSecureOpen'
  );
  if (
    nativeContract.abiVersion !== 1 ||
    nativeContract.napiVersion !== 8
  ) {
    throw new Error('installed package has the wrong native ABI or Node-API version');
  }

  for (const required of [
    join(packageRoot, 'dist', 'relic-mcp.js'),
    join(packageRoot, 'dist', 'native-secure-open.js'),
    join(packageRoot, 'dist', 'native-secure-open.d.ts'),
    join(packageRoot, 'native'),
    join(packageRoot, 'native', 'build.mjs'),
    join(packageRoot, 'native', 'local-build.mjs'),
    join(packageRoot, 'native', 'platform-darwin.c'),
    join(packageRoot, 'native', 'platform-linux.c'),
    join(packageRoot, 'native', 'platform.h'),
    join(packageRoot, 'native', 'secure-open.c'),
    join(packageRoot, 'native', 'secure-open.d.ts'),
    join(packageRoot, 'scripts', 'prove-packed-native.mjs'),
  ]) {
    await access(required);
  }

  const declaredPrebuilds = recordAt(
    nativeContract.prebuilds,
    'installed package.json.relicNativeSecureOpen.prebuilds'
  );
  for (const target of packagedTargets) {
    const declaredFloor = recordAt(
      declaredPrebuilds[target],
      `installed package.json.relicNativeSecureOpen.prebuilds.${target}`
    );
    const expectedFloor = packagedFloors[target];
    const expectedPackageFloor =
      'macOS' in expectedFloor
        ? { macOSBinaryDeploymentFloor: expectedFloor.macOS }
        : { minimumGlibc: expectedFloor.glibc };
    if (JSON.stringify(declaredFloor) !== JSON.stringify(expectedPackageFloor)) {
      throw new Error(`${target} package metadata has the wrong platform floor`);
    }
    const targetDirectory = join(packageRoot, 'prebuilds', target);
    const binary = join(targetDirectory, 'secure_open.node');
    const metadataPath = join(targetDirectory, 'build-info.json');
    await access(binary);
    const metadata = recordAt(
      JSON.parse(await readFile(metadataPath, 'utf8')),
      `${target} build-info.json`
    );
    if (
      metadata.target !== target ||
      metadata.artifact !== 'secure_open.node' ||
      metadata.nodeApiVersion !== 8 ||
      JSON.stringify(metadata.minimumPlatform) !== JSON.stringify(expectedFloor)
    ) {
      throw new Error(`${target} build-info.json has the wrong native identity`);
    }
  }

  const target = packagedTarget();
  return {
    nativeBinary: join(packageRoot, 'prebuilds', target, 'secure_open.node'),
    nativeLoader: join(packageRoot, 'dist', 'native-secure-open.js'),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      env: nodeOnlyEnvironment({ ...options.env, PWD: options.cwd ?? process.cwd() }),
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
  if (!server.listening) return;
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
    env: nodeOnlyEnvironment({
      PWD: cwd,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_ORIGIN: origin,
      RELIC_CHROME_PATH: 'none',
      RELIC_PUBLISH_STATE: join(cwd, 'state.json'),
    }),
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
  let response;
  try {
    response = lines
      .map((line) => JSON.parse(line))
      .find((candidate) => candidate.id === 1);
  } catch (error) {
    throw new Error(
      `packed client wrote non-JSON output (exit ${code}): ${(error instanceof Error ? error.message : String(error))}`
    );
  }
  if (response === undefined) {
    throw new Error(
      `packed client did not return a publish response (exit ${code})\n${Buffer.concat(stderr).toString('utf8')}`
    );
  }
  return response;
}

function assertPublished(response, label) {
  if (
    response === null ||
    typeof response !== 'object' ||
    response.error !== undefined ||
    response.result === undefined ||
    response.result?.isError === true
  ) {
    throw new Error(`${label} did not publish: ${JSON.stringify(response)}`);
  }
}

function assertRefused(response, label, expected) {
  if (
    response === null ||
    typeof response !== 'object' ||
    response.error !== undefined ||
    response.result === null ||
    typeof response.result !== 'object' ||
    response.result.isError !== true
  ) {
    throw new Error(`${label} was not refused by the MCP tool: ${JSON.stringify(response)}`);
  }

  const structuredContent = response.result.structuredContent;
  const content = response.result.content;
  const code =
    structuredContent !== null && typeof structuredContent === 'object'
      ? structuredContent.code
      : undefined;
  const firstContent = Array.isArray(content) ? content[0] : undefined;
  const text =
    firstContent !== null &&
    typeof firstContent === 'object' &&
    typeof firstContent.text === 'string'
      ? firstContent.text
      : undefined;

  const expectedTexts = Array.isArray(expected.text) ? expected.text : [expected.text];
  if (
    code !== expected.code ||
    text === undefined ||
    expectedTexts.some((expectedText) => !text.includes(expectedText))
  ) {
    throw new Error(
      `${label} had the wrong MCP refusal: expected structuredContent.code=${JSON.stringify(expected.code)} and content[0].text including ${JSON.stringify(expectedTexts)}; got code=${JSON.stringify(code)}, text=${JSON.stringify(text)}`
    );
  }
  if (expected.requests.length !== expected.requestCount) {
    throw new Error(
      `${label} reached the loopback service: expected ${expected.requestCount} requests, found ${expected.requests.length}`
    );
  }
}

async function withHiddenPath(path, label, action) {
  const hidden = `${path}.hidden-packed-native-proof`;
  await assertAbsent(hidden, `${label} hidden path`);
  await rename(path, hidden);

  let result;
  let actionError;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }

  let restoreError;
  try {
    await rename(hidden, path);
  } catch (error) {
    restoreError = error;
  }

  if (actionError !== undefined && restoreError !== undefined) {
    throw new AggregateError(
      [actionError, restoreError],
      `${label} failed and its hidden path could not be restored`
    );
  }
  if (actionError !== undefined) throw actionError;
  if (restoreError !== undefined) throw restoreError;
  return result;
}

async function withNativeRoot(openNativeBundleRoot, path, action) {
  const root = await openNativeBundleRoot(path);
  let result;
  let actionError;
  try {
    result = await action(root);
  } catch (error) {
    actionError = error;
  }

  let closeError;
  try {
    await root.close();
  } catch (error) {
    closeError = error;
  }

  if (actionError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [actionError, closeError],
      'native root operation failed and its descriptor could not be closed'
    );
  }
  if (actionError !== undefined) throw actionError;
  if (closeError !== undefined) throw closeError;
  return result;
}

async function withNativeFile(file, action) {
  let result;
  let actionError;
  try {
    result = await action(file);
  } catch (error) {
    actionError = error;
  }

  let closeError;
  try {
    await file.close();
  } catch (error) {
    closeError = error;
  }

  if (actionError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [actionError, closeError],
      'native file operation failed and its descriptor could not be closed'
    );
  }
  if (actionError !== undefined) throw actionError;
  if (closeError !== undefined) throw closeError;
  return result;
}

async function readNative(root, relativePath) {
  const file = await root.openRegular(relativePath);
  return withNativeFile(file, async (opened) => {
    if (!Number.isSafeInteger(opened.size) || opened.size < 0) {
      throw new Error(`native file ${relativePath} reported an invalid size`);
    }
    const bytes = await opened.read(opened.size);
    if (bytes.length !== opened.size) {
      throw new Error(`native file ${relativePath} returned the wrong byte count`);
    }
    return bytes;
  });
}

function assertBytes(actual, expected, label) {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) {
    throw new Error(`${label} did not return the expected bytes`);
  }
}

async function expectNativeRefusal(label, expected, action) {
  try {
    await action();
  } catch (error) {
    const code = errorField(error, 'code');
    const errno = errorField(error, 'errno');
    if (
      code !== expected.code ||
      (expected.errno !== undefined && errno !== expected.errno)
    ) {
      const expectedErrno =
        expected.errno === undefined ? '' : `, errno=${expected.errno}`;
      throw new Error(
        `${label} had an unexpected native refusal: expected code=${expected.code}${expectedErrno}; got ${nativeRefusalDetails(error)}`
      );
    }
    return;
  }
  throw new Error(`${label} was accepted by the installed native loader`);
}

async function proveInstalledNativeLoader(loaderPath, runtime) {
  const nativeLoader = await import(pathToFileURL(loaderPath).href);
  if (typeof nativeLoader.openNativeBundleRoot !== 'function') {
    throw new Error('installed native loader does not export openNativeBundleRoot');
  }
  const openNativeBundleRoot = nativeLoader.openNativeBundleRoot;
  const outside = join(runtime, 'native-outside');
  const directRoot = join(runtime, 'native-direct.otiod');
  const insideBytes = Buffer.from('inside native bytes');
  const outsideBytes = Buffer.from('outside native bytes');
  const lexicalPathRefusal = { code: 'ERR_RELIC_NATIVE_INVALID_PATH' };
  const symlinkRefusal = {
    code: 'ELOOP',
    errno: os.constants.errno.ELOOP,
  };
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), outsideBytes);
  await mkdir(join(directRoot, 'replaceable'), { recursive: true });
  await writeFile(join(directRoot, 'inside.txt'), insideBytes);
  await writeFile(join(directRoot, 'replaceable', 'inside.txt'), insideBytes);
  await symlink(join(outside, 'secret.txt'), join(directRoot, 'leaf.txt'), 'file');
  await symlink(outside, join(directRoot, 'intermediate'), 'dir');

  await withNativeRoot(openNativeBundleRoot, directRoot, async (root) => {
    assertBytes(await readNative(root, 'inside.txt'), insideBytes, 'native inside read');
    await expectNativeRefusal(
      'native lexical traversal path',
      lexicalPathRefusal,
      async () => {
        await readNative(root, '../native-outside/secret.txt');
      }
    );
    await expectNativeRefusal(
      'native lexical absolute path',
      lexicalPathRefusal,
      async () => {
        await readNative(root, join(outside, 'secret.txt'));
      }
    );
    await expectNativeRefusal('native leaf symlink', symlinkRefusal, async () => {
      await readNative(root, 'leaf.txt');
    });
    await expectNativeRefusal(
      'native intermediate symlink',
      symlinkRefusal,
      async () => {
        await readNative(root, 'intermediate/secret.txt');
      }
    );

    const replaced = join(directRoot, 'replaceable');
    await rename(replaced, `${replaced}.original`);
    await symlink(outside, replaced, 'dir');
    await expectNativeRefusal(
      'native replaced descendant directory',
      symlinkRefusal,
      async () => {
        await readNative(root, 'replaceable/secret.txt');
      }
    );
  });

  const rootSymlink = join(runtime, 'native-root-symlink.otiod');
  await symlink(directRoot, rootSymlink, 'dir');
  await expectNativeRefusal('native root symlink', symlinkRefusal, async () => {
    await withNativeRoot(openNativeBundleRoot, rootSymlink, async () => undefined);
  });

  const heldRootPath = join(runtime, 'native-held.otiod');
  const movedHeldRoot = `${heldRootPath}.original`;
  const heldBytes = Buffer.from('held native bytes');
  await mkdir(heldRootPath);
  await writeFile(join(heldRootPath, 'inside.txt'), heldBytes);
  await withNativeRoot(openNativeBundleRoot, heldRootPath, async (root) => {
    const heldFile = await root.openRegular('inside.txt');
    await withNativeFile(heldFile, async (file) => {
      await rename(heldRootPath, movedHeldRoot);
      await mkdir(heldRootPath);
      await writeFile(join(heldRootPath, 'inside.txt'), 'replacement bytes');
      assertBytes(
        await file.read(file.size),
        heldBytes,
        'held native file descriptor after root replacement'
      );
      assertBytes(
        await readNative(root, 'inside.txt'),
        heldBytes,
        'held native root descriptor after root replacement'
      );
    });
  });
}

async function createMcpFixtures(runtime) {
  const valid = join(runtime, 'valid.otiod');
  const traversal = join(runtime, 'traversal.otiod');
  const symlinked = join(runtime, 'symlink.otiod');
  const outside = join(runtime, 'mcp-outside');
  const ordinary = join(runtime, 'ordinary.txt');

  await mkdir(valid);
  await writeFile(
    join(valid, 'content.otio'),
    JSON.stringify({
      OTIO_SCHEMA: 'Clip.1',
      media_reference: { OTIO_SCHEMA: 'MissingReference.1' },
    })
  );

  await mkdir(traversal);
  await writeFile(
    join(traversal, 'content.otio'),
    JSON.stringify({
      OTIO_SCHEMA: 'Clip.1',
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: '../mcp-outside/secret.mp4',
      },
    })
  );

  await mkdir(join(symlinked, 'media'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.mp4'), 'outside bytes');
  await writeFile(
    join(symlinked, 'content.otio'),
    JSON.stringify({
      OTIO_SCHEMA: 'Clip.1',
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: 'media/link/secret.mp4',
      },
    })
  );
  await symlink(outside, join(symlinked, 'media', 'link'), 'dir');
  await writeFile(ordinary, 'ordinary file without native prebuild');

  return { ordinary, symlinked, traversal, valid };
}

function sourceIsolationRequest() {
  const hideSource = process.env['RELIC_MCP_PROVE_HIDE_SOURCE'];
  if (hideSource === undefined) return undefined;
  if (hideSource !== '1') {
    throw new Error('RELIC_MCP_PROVE_HIDE_SOURCE must be exactly 1 when set');
  }
  if (process.platform !== 'darwin') {
    throw new Error('source checkout renaming is a Darwin-only proof mode');
  }

  const configured = process.env['RELIC_MCP_PROVE_SOURCE_ROOT'];
  if (configured === undefined || !isAbsolute(configured)) {
    throw new Error(
      'RELIC_MCP_PROVE_SOURCE_ROOT must be an absolute checkout path when hiding source'
    );
  }
  const sourceRoot = configured.replace(/\/+$/, '');
  if (sourceRoot.length === 0 || sourceRoot === '/') {
    throw new Error('RELIC_MCP_PROVE_SOURCE_ROOT must name a checkout, not the filesystem root');
  }
  return sourceRoot;
}

async function main() {
  await access(tarball);
  await access(npmCli);

  let temporary;
  let sourceRoot;
  let hiddenSource;
  let server;
  let primaryError;
  try {
    // This is the only realpath in the proof. Bundle paths remain lexical so a
    // source checkout can never become a fallback through canonicalization.
    temporary = await mkdtemp(
      join(await realpath(os.tmpdir()), 'relic-mcp-packed-native-')
    );
    const install = join(temporary, 'install');
    const runtime = join(temporary, 'runtime');
    const copiedTarball = join(temporary, 'relic-mcp.tgz');
    const npmCache = join(temporary, 'npm-cache');
    const npmUserConfig = join(temporary, 'npmrc');
    await mkdir(install, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await copyFile(tarball, copiedTarball);
    await writeFile(join(install, 'package.json'), '{"private":true}\n');
    await writeFile(npmUserConfig, '');

    // The script was already loaded from the checkout. Move to the temporary
    // runtime before hiding the explicitly handed Darwin checkout, then do all
    // installation and proof work from the packed artifact only.
    process.chdir(runtime);
    sourceRoot = sourceIsolationRequest();
    if (sourceRoot !== undefined) {
      const hidden = `${sourceRoot}.hidden-packed-native-proof`;
      await assertAbsent(hidden, 'hidden source checkout');
      await rename(sourceRoot, hidden);
      hiddenSource = hidden;
    }

    await run(
      process.execPath,
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-workspaces',
        '--offline',
        '--cache',
        npmCache,
        '--userconfig',
        npmUserConfig,
        copiedTarball,
      ],
      { cwd: install }
    );

    const packageRoot = join(install, 'node_modules', 'relic-mcp');
    await assertPackagedLaunchContract(packageRoot);
    const { nativeBinary, nativeLoader } = await assertPackagedNativeFiles(packageRoot);
    await run(
      process.execPath,
      [join(packageRoot, 'scripts', 'prove-packed-native.mjs'), copiedTarball],
      {
        cwd: runtime,
        env: {
          RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER: '1',
          RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER_PATH: nativeLoader,
          RELIC_MCP_PROVE_INSTALLED_NATIVE_RUNTIME: runtime,
        },
      }
    );

    const fixtures = await createMcpFixtures(runtime);
    const uploaded = [];
    const requests = [];
    let origin;
    server = createServer((request, response) => {
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
            upload_url: `${origin}/upload`,
            relic_expires_at: null,
            report_url: `${origin}/report`,
            disclosure_url: `${origin}/disclosure`,
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
    origin = await listen(server);

    const bin = join(packageRoot, 'dist', 'relic-mcp.js');
    const successful = await callPublish(bin, runtime, origin, fixtures.valid);
    assertPublished(successful, 'valid packed .otiod publish');
    if (uploaded.length !== 1 || uploaded[0].length === 0) {
      throw new Error('valid packed .otiod publish did not upload one nonempty ciphertext object');
    }

    for (const [label, path, expected] of [
      [
        'traversal .otiod bundle',
        fixtures.traversal,
        {
          code: 'otio_bundle_invalid',
          text: 'Path traversal',
        },
      ],
      [
        'symlinked .otiod bundle',
        fixtures.symlinked,
        {
          code: 'source_unreadable',
          text: ['media/link/secret.mp4', 'confined descendant failed'],
        },
      ],
    ]) {
      const requestCount = requests.length;
      const refused = await callPublish(bin, runtime, origin, path);
      assertRefused(refused, label, { ...expected, requests, requestCount });
    }

    await withHiddenPath(nativeBinary, 'selected native prebuild', async () => {
      const requestCount = requests.length;
      const uploadCount = uploaded.length;
      const missingPrebuild = await callPublish(bin, runtime, origin, fixtures.valid);
      assertRefused(missingPrebuild, 'valid .otiod without native prebuild', {
        code: 'source_not_regular_file',
        text: `native secure-open prebuild is missing for ${packagedTarget()}`,
        requests,
        requestCount,
      });
      if (uploaded.length !== uploadCount) {
        throw new Error('valid .otiod without native prebuild uploaded ciphertext');
      }

      const ordinary = await callPublish(bin, runtime, origin, fixtures.ordinary);
      assertPublished(ordinary, 'ordinary file publish without native prebuild');
      if (
        uploaded.length !== uploadCount + 1 ||
        uploaded[uploadCount]?.length === 0
      ) {
        throw new Error('ordinary file publish without native prebuild did not upload one ciphertext object');
      }
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (server !== undefined) {
      try {
        await stop(server);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (hiddenSource !== undefined && sourceRoot !== undefined) {
      try {
        await rename(hiddenSource, sourceRoot);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (temporary !== undefined) {
      try {
        await rm(temporary, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        primaryError === undefined
          ? cleanupErrors
          : [primaryError, ...cleanupErrors],
        'packed native proof cleanup failed'
      );
    }
  }
}

const installedNativeLoaderMode =
  process.env['RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER'];
if (installedNativeLoaderMode === undefined) {
  await main();
  console.log('packed native Node proof passed');
} else {
  if (installedNativeLoaderMode !== '1') {
    throw new Error('RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER must be exactly 1 when set');
  }
  const loaderPath = process.env['RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER_PATH'];
  const runtime = process.env['RELIC_MCP_PROVE_INSTALLED_NATIVE_RUNTIME'];
  if (loaderPath === undefined || runtime === undefined) {
    throw new Error(
      'installed native loader proof requires RELIC_MCP_PROVE_INSTALLED_NATIVE_LOADER_PATH and RELIC_MCP_PROVE_INSTALLED_NATIVE_RUNTIME'
    );
  }
  await proveInstalledNativeLoader(loaderPath, runtime);
  console.log('packed installed native loader proof passed');
}
