import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(nativeDirectory);
const artifactName = 'secure_open.node';
const nodeApiVersion = 8;
const sourceFiles = [
  'native/build.mjs',
  'native/platform-darwin.c',
  'native/platform-linux.c',
  'native/platform.h',
  'native/secure-open.c',
];

const targets = {
  'darwin-arm64': {
    architecture: 'arm64',
    id: 'darwin-arm64',
    minimumMacOS: '15.0',
    platform: 'darwin',
    source: 'platform-darwin.c',
  },
  'darwin-x64': {
    architecture: 'x86_64',
    id: 'darwin-x64',
    minimumMacOS: '15.0',
    platform: 'darwin',
    source: 'platform-darwin.c',
  },
  'linux-arm64-gnu': {
    architecture: 'AArch64',
    id: 'linux-arm64-gnu',
    minimumGlibc: '2.28',
    platform: 'linux',
    source: 'platform-linux.c',
  },
  'linux-x64-gnu': {
    architecture: 'Advanced Micro Devices X86-64',
    id: 'linux-x64-gnu',
    minimumGlibc: '2.28',
    platform: 'linux',
    source: 'platform-linux.c',
  },
};

function fail(message) {
  throw new Error(`native secure-open: ${message}`);
}

function usage() {
  return [
    'usage:',
    '  node native/build.mjs --target <tuple> --node-include <node-header-directory> [--cc <compiler>]',
    '  node native/build.mjs --check [--target <tuple>]',
    `tuples: ${Object.keys(targets).join(', ')}`,
  ].join('\n');
}

function parseArguments(argumentsToParse) {
  const options = {
    check: false,
    cc: process.env.CC,
    nodeInclude: undefined,
    target: undefined,
  };

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    if (argument === '--target' || argument === '--node-include' || argument === '--cc') {
      const value = argumentsToParse[index + 1];
      if (value === undefined || value.startsWith('--')) fail(usage());
      index += 1;
      if (argument === '--target') options.target = value;
      if (argument === '--node-include') options.nodeInclude = value;
      if (argument === '--cc') options.cc = value;
      continue;
    }
    fail(usage());
  }

  if (options.target !== undefined && !(options.target in targets)) fail(usage());
  if (options.check && options.nodeInclude !== undefined) fail(usage());
  if (!options.check && (options.target === undefined || options.nodeInclude === undefined)) {
    fail(usage());
  }
  if (!options.check && (options.cc === undefined || /\s/.test(options.cc))) {
    fail('a direct compiler executable is required through --cc or CC');
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageDirectory,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error !== undefined) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    fail(`${command} ${args.join(' ')} failed${output === '' ? '' : `:\n${output}`}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function findAuditTool(environmentName, candidates) {
  const configured = process.env[environmentName];
  const tried = configured === undefined ? candidates : [configured];

  for (const candidate of tried) {
    const result = spawnSync(candidate, ['--version'], {
      cwd: packageDirectory,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.error === undefined) return candidate;
  }

  fail(`required audit tool ${environmentName} is unavailable (${tried.join(', ')})`);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function sourceSha256() {
  const hash = createHash('sha256');
  for (const relativePath of sourceFiles) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(join(packageDirectory, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function artifactPath(target) {
  return join(packageDirectory, 'prebuilds', target.id, artifactName);
}

function buildInfoPath(target) {
  return join(packageDirectory, 'prebuilds', target.id, 'build-info.json');
}

function parseGlibcVersions(text) {
  const versions = [];
  for (const match of text.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (Number.isSafeInteger(major) && Number.isSafeInteger(minor)) {
      versions.push([major, minor]);
    }
  }
  return versions;
}

function compareVersions(left, right) {
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

function auditLinux(target, path) {
  const readelf = findAuditTool('RELIC_READELF', ['llvm-readelf', 'readelf']);
  const header = run(readelf, ['-h', path]);
  if (!/Class:\s+ELF64\b/.test(header) || !new RegExp(`Machine:\\s+${target.architecture}`).test(header)) {
    fail(`${target.id} artifact has the wrong ELF architecture`);
  }

  const dynamic = run(readelf, ['-d', path]);
  if (/\((?:RPATH|RUNPATH)\)/.test(dynamic)) {
    fail(`${target.id} artifact contains an RPATH or RUNPATH`);
  }
  const dependencies = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(
    (match) => match[1],
  );
  if (dependencies.some((dependency) => dependency !== 'libc.so.6')) {
    fail(`${target.id} artifact links an unsupported library (${dependencies.join(', ')})`);
  }

  const versions = parseGlibcVersions(run(readelf, ['--version-info', path]));
  const maximum = versions.reduce(
    (current, version) => (compareVersions(version, current) > 0 ? version : current),
    [0, 0],
  );
  if (compareVersions(maximum, [2, 28]) > 0) {
    fail(`${target.id} artifact requires GLIBC_${maximum[0]}.${maximum[1]}, above 2.28`);
  }

  return {
    architecture: target.architecture,
    dependencies,
    glibcSymbolCeiling: `GLIBC_${maximum[0]}.${maximum[1]}`,
    rpath: false,
  };
}

function parseMacVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  if (match?.[1] === undefined) return undefined;
  return [Number(match[1]), Number(match[2] ?? '0'), Number(match[3] ?? '0')];
}

function auditDarwin(target, path) {
  const lipo = findAuditTool('RELIC_LIPO', ['lipo']);
  const otool = findAuditTool('RELIC_OTOOL', ['otool']);
  const architectures = run(lipo, ['-archs', path]).match(/\b(?:arm64|x86_64)\b/g) ?? [];
  if (architectures.length !== 1 || architectures[0] !== target.architecture) {
    fail(`${target.id} artifact has the wrong Mach-O architecture`);
  }

  const linked = run(otool, ['-L', path])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter((value) => value !== '');
  if (linked.some((dependency) => dependency !== '/usr/lib/libSystem.B.dylib')) {
    fail(`${target.id} artifact links an unsupported library (${linked.join(', ')})`);
  }

  const loadCommands = run(otool, ['-l', path]);
  const versionMatch = /cmd LC_BUILD_VERSION[\s\S]*?minos ([0-9.]+)/.exec(loadCommands);
  const deployment = versionMatch?.[1] === undefined ? undefined : parseMacVersion(versionMatch[1]);
  if (deployment === undefined || deployment[0] !== 15) {
    fail(`${target.id} artifact does not declare a macOS 15.x deployment target`);
  }

  return {
    architecture: target.architecture,
    dependencies: linked,
    macOSDeploymentTarget: versionMatch[1],
  };
}

function auditArtifact(target, path) {
  return target.platform === 'linux'
    ? auditLinux(target, path)
    : auditDarwin(target, path);
}

async function compilerIdentity(compiler) {
  const firstLine = run(compiler, ['--version'])
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim();
  return {
    id: basename(compiler),
    version: firstLine ?? 'unknown',
  };
}

async function buildTarget(target, options) {
  const nodeInclude = options.nodeInclude;
  if (!existsSync(join(nodeInclude, 'node_api.h'))) {
    fail(`--node-include must contain node_api.h (${nodeInclude})`);
  }

  const artifact = artifactPath(target);
  await mkdir(dirname(artifact), { recursive: true });
  const compiler = options.cc;
  const arguments = [
    '-std=c11',
    '-O2',
    '-fPIC',
    '-fvisibility=hidden',
    '-DNAPI_VERSION=8',
    '-D_FILE_OFFSET_BITS=64',
    '-I',
    nodeInclude,
    join(nativeDirectory, 'secure-open.c'),
    join(nativeDirectory, target.source),
  ];

  if (target.platform === 'darwin') {
    arguments.push(
      '-mmacosx-version-min=15.0',
      '-arch',
      target.architecture,
      '-bundle',
      '-undefined',
      'dynamic_lookup',
    );
  } else {
    arguments.push('-D_GNU_SOURCE', '-shared', '-Wl,-z,relro,-z,now');
  }
  arguments.push('-o', artifact);

  run(compiler, arguments);
  const audit = auditArtifact(target, artifact);
  const info = {
    artifact: artifactName,
    audit,
    binarySha256: await sha256(artifact),
    compiler: await compilerIdentity(compiler),
    minimumPlatform:
      target.platform === 'darwin'
        ? { macOS: target.minimumMacOS }
        : { glibc: target.minimumGlibc },
    nodeApiVersion,
    schemaVersion: 1,
    sourceSha256: await sourceSha256(),
    target: target.id,
  };
  await writeFile(buildInfoPath(target), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`built ${target.id}: ${artifact}`);
}

async function checkTarget(target) {
  const artifact = artifactPath(target);
  const infoPath = buildInfoPath(target);
  if (!existsSync(artifact) || !existsSync(infoPath)) {
    fail(`${target.id} is missing ${artifactName} or build-info.json`);
  }

  let info;
  try {
    info = JSON.parse(await readFile(infoPath, 'utf8'));
  } catch (cause) {
    fail(`${target.id} has unreadable build-info.json: ${String(cause)}`);
  }

  if (
    info.schemaVersion !== 1 ||
    info.target !== target.id ||
    info.artifact !== artifactName ||
    info.nodeApiVersion !== nodeApiVersion ||
    info.sourceSha256 !== (await sourceSha256()) ||
    info.binarySha256 !== (await sha256(artifact))
  ) {
    fail(`${target.id} build-info.json does not match its source or binary`);
  }

  const audit = auditArtifact(target, artifact);
  if (JSON.stringify(info.audit) !== JSON.stringify(audit)) {
    fail(`${target.id} build-info.json does not match the dependency-floor audit`);
  }

  const minimumPlatform =
    target.platform === 'darwin'
      ? { macOS: target.minimumMacOS }
      : { glibc: target.minimumGlibc };
  if (JSON.stringify(info.minimumPlatform) !== JSON.stringify(minimumPlatform)) {
    fail(`${target.id} build-info.json has the wrong platform floor`);
  }

  console.log(`checked ${target.id}: ${artifact}`);
}

const options = parseArguments(process.argv.slice(2));
if (options.check) {
  const selected = options.target === undefined ? Object.values(targets) : [targets[options.target]];
  for (const target of selected) await checkTarget(target);
} else {
  await buildTarget(targets[options.target], options);
}
