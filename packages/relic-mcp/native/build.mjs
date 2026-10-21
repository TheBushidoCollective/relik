import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(nativeDirectory);
const artifactName = 'secure_open.node';
const buildMetadataSchemaVersion = 3;
const nodeApiVersion = 8;
const darwinReleaseToolchainPath = join(
  nativeDirectory,
  'darwin-release-toolchain.json'
);
const linuxToolchainPath = join(nativeDirectory, 'linux-toolchain.json');
const sourceFiles = [
  'native/build.mjs',
  'native/darwin-confinement-probe.c',
  'native/darwin-release-toolchain.json',
  'native/linux-toolchain.json',
  'native/local-build.mjs',
  'native/platform-darwin.c',
  'native/platform-linux.c',
  'native/platform.h',
  'native/secure-open.c',
  '../../bun.lock',
];

const targets = {
  'darwin-arm64': {
    architecture: 'arm64',
    id: 'darwin-arm64',
    minimumMacOS: '15.0',
    nodeArchitecture: 'arm64',
    platform: 'darwin',
    source: 'platform-darwin.c',
  },
  'darwin-x64': {
    architecture: 'x86_64',
    id: 'darwin-x64',
    minimumMacOS: '15.0',
    nodeArchitecture: 'x64',
    platform: 'darwin',
    source: 'platform-darwin.c',
  },
  'linux-arm64-gnu': {
    architecture: 'AArch64',
    containerPlatform: 'linux/arm64',
    id: 'linux-arm64-gnu',
    minimumGlibc: '2.28',
    nodeArchitecture: 'arm64',
    platform: 'linux',
    source: 'platform-linux.c',
  },
  'linux-x64-gnu': {
    architecture: 'Advanced Micro Devices X86-64',
    containerPlatform: 'linux/amd64',
    id: 'linux-x64-gnu',
    minimumGlibc: '2.28',
    nodeArchitecture: 'x64',
    platform: 'linux',
    source: 'platform-linux.c',
  },
};

function fail(message) {
  throw new Error(`native secure-open: ${message}`);
}

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

async function loadLinuxToolchain() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(linuxToolchainPath, 'utf8'));
  } catch (cause) {
    fail(`could not read ${linuxToolchainPath}: ${String(cause)}`);
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.compilerPath !== 'string' ||
    !isAbsolute(parsed.compilerPath) ||
    /\s/.test(parsed.compilerPath) ||
    parsed.targets === null ||
    typeof parsed.targets !== 'object'
  ) {
    fail(`${linuxToolchainPath} is not a valid pinned Linux toolchain manifest`);
  }
  return parsed;
}

async function loadDarwinReleaseToolchain() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(darwinReleaseToolchainPath, 'utf8'));
  } catch (cause) {
    fail(`could not read ${darwinReleaseToolchainPath}: ${String(cause)}`);
  }

  if (
    !hasExactKeys(parsed, [
      'schemaVersion',
      'xcodeVersion',
      'developerDir',
      'sdkVersion',
    ]) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.xcodeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(parsed.xcodeVersion) ||
    typeof parsed.developerDir !== 'string' ||
    !isAbsolute(parsed.developerDir) ||
    /\s/.test(parsed.developerDir) ||
    parsed.developerDir.endsWith('/') ||
    typeof parsed.sdkVersion !== 'string' ||
    !/^\d+\.\d+$/.test(parsed.sdkVersion)
  ) {
    fail(
      `${darwinReleaseToolchainPath} is not a valid pinned Darwin release toolchain manifest`
    );
  }
  return parsed;
}

const darwinReleaseToolchain = await loadDarwinReleaseToolchain();

const linuxToolchain = await loadLinuxToolchain();

function usage() {
  return [
    'usage:',
    '  node native/build.mjs --target <tuple> --node-include <node-header-directory> [--output-dir <private-directory>] [--cc <compiler>] [--release]',
    '  node native/build.mjs --probe --target <darwin-tuple> --cc <compiler> --output-dir <private-directory>',
    '  node native/build.mjs --check [--target <tuple>] [--metadata-only] [--release]',
    `tuples: ${Object.keys(targets).join(', ')}`,
    'Linux compilation always runs inside the pinned manylinux container; --cc and CC are Darwin-only.',
  ].join('\n');
}

function hasEnvironment(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

function requireDirectExecutable(value) {
  return typeof value === 'string' && value !== '' && !/\s/.test(value);
}

function parseArguments(argumentsToParse) {
  const options = {
    cc: undefined,
    check: false,
    metadataOnly: false,
    nodeInclude: undefined,
    outputDir: undefined,
    probe: false,
    release: false,
    target: undefined,
  };

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    if (argument === '--metadata-only') {
      options.metadataOnly = true;
      continue;
    }
    if (argument === '--probe') {
      options.probe = true;
      continue;
    }
    if (argument === '--release') {
      options.release = true;
      continue;
    }
    if (
      argument === '--target' ||
      argument === '--node-include' ||
      argument === '--cc' ||
      argument === '--output-dir'
    ) {
      const value = argumentsToParse[index + 1];
      if (value === undefined || value.startsWith('--')) fail(usage());
      index += 1;
      if (argument === '--target') options.target = value;
      if (argument === '--node-include') options.nodeInclude = value;
      if (argument === '--cc') options.cc = value;
      if (argument === '--output-dir') options.outputDir = value;
      continue;
    }
    fail(usage());
  }

  if (
    options.target !== undefined &&
    !(options.target in targets)
  ) {
    fail(usage());
  }
  if (options.metadataOnly && !options.check) fail(usage());
  if (options.check && options.probe) fail(usage());
  if (options.probe && options.release) fail(usage());
  if (
    options.check &&
    (options.nodeInclude !== undefined ||
      options.cc !== undefined ||
      options.outputDir !== undefined)
  ) {
    fail(usage());
  }
  if (options.check) return options;

  if (options.target === undefined) fail(usage());
  const target = targets[options.target];
  if (options.outputDir !== undefined) {
    if (!isAbsolute(options.outputDir)) {
      fail('--output-dir must be an absolute private directory');
    }
    options.outputDir = resolve(options.outputDir);
  }

  if (options.probe) {
    if (
      target.platform !== 'darwin' ||
      options.nodeInclude !== undefined ||
      options.outputDir === undefined
    ) {
      fail(usage());
    }
  } else if (options.nodeInclude === undefined) {
    fail(usage());
  }

  if (target.platform === 'linux') {
    if (options.cc !== undefined || hasEnvironment('CC')) {
      fail(
        'Linux compilation uses the pinned manylinux toolchain; --cc and CC are Darwin-only'
      );
    }
  } else {
    options.cc ??= process.env.CC;
    if (!requireDirectExecutable(options.cc)) {
      fail(
        'a direct Darwin compiler executable is required through --cc or CC'
      );
    }
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
    fail(
      `${command} ${args.join(' ')} failed${
        output === '' ? '' : `:\n${output}`
      }`
    );
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function findAuditTool(environmentName, candidates) {
  const configured = process.env[environmentName];
  const tried = configured === undefined ? candidates : [configured];

  for (const candidate of tried) {
    const result = spawnSync(candidate, [], {
      cwd: packageDirectory,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.error === undefined) return candidate;
  }

  fail(
    `required audit tool ${environmentName} is unavailable (${tried.join(', ')})`
  );
}

function assertNativeHost(target) {
  if (
    process.platform !== target.platform ||
    process.arch !== target.nodeArchitecture
  ) {
    fail(
      `${target.id} must be built and probed on a native ${target.platform}/${target.nodeArchitecture} runner; cross-compilation and emulation are not accepted`
    );
  }
}

function linuxToolchainFor(target) {
  const imageArchitecture =
    target.id === 'linux-arm64-gnu'
      ? 'aarch64'
      : target.id === 'linux-x64-gnu'
        ? 'x86_64'
        : undefined;
  const configured = linuxToolchain.targets[target.id];
  if (
    imageArchitecture === undefined ||
    configured === null ||
    typeof configured !== 'object' ||
    configured.containerPlatform !== target.containerPlatform ||
    typeof configured.image !== 'string' ||
    !new RegExp(
      `^quay\\.io/pypa/manylinux_2_28_${imageArchitecture}@sha256:[a-f0-9]{64}$`
    ).test(configured.image)
  ) {
    fail(`${linuxToolchainPath} has no valid pinned toolchain for ${target.id}`);
  }
  return {
    compilerPath: linuxToolchain.compilerPath,
    containerPlatform: configured.containerPlatform,
    image: configured.image,
    imageDigest: configured.image.slice(configured.image.lastIndexOf('@') + 1),
  };
}

function dockerSecurityArguments(toolchain) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid < 0 ||
    gid < 0
  ) {
    fail(
      'the Linux native build requires a host UID and GID for isolated container output'
    );
  }

  return [
    'run',
    '--rm',
    '--platform',
    toolchain.containerPlatform,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--user',
    `${uid}:${gid}`,
    '--workdir',
    '/tmp',
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
  ];
}

function dockerBindMount(source, target, readOnly) {
  return `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`;
}

function runLinuxCompiler(
  toolchain,
  outputDirectory,
  nodeInclude,
  compilerArgs
) {
  const argumentsToRun = dockerSecurityArguments(toolchain);
  if (outputDirectory !== undefined) {
    argumentsToRun.push(
      '--mount',
      dockerBindMount(nativeDirectory, '/source/native', true),
      '--mount',
      dockerBindMount(resolve(nodeInclude), '/source/node-include', true),
      '--mount',
      dockerBindMount(outputDirectory, '/output', false)
    );
  }
  argumentsToRun.push(toolchain.image, toolchain.compilerPath, ...compilerArgs);
  return run('docker', argumentsToRun);
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

function outputPaths(target, outputDirectory) {
  const directory = outputDirectory ?? join(packageDirectory, 'prebuilds', target.id);
  return {
    artifact: join(directory, artifactName),
    buildInfo: join(directory, 'build-info.json'),
    directory,
  };
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

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  if (match?.[1] === undefined) return undefined;
  const version = [
    Number(match[1]),
    Number(match[2] ?? '0'),
    Number(match[3] ?? '0'),
  ];
  return version.every((part) => Number.isSafeInteger(part)) ? version : undefined;
}

function parseGlibcSymbol(value) {
  const match = /^GLIBC_(\d+)\.(\d+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const version = [Number(match[1]), Number(match[2])];
  return version.every((part) => Number.isSafeInteger(part)) ? version : undefined;
}

function validateAudit(target, audit) {
  if (target.platform === 'linux') {
    const ceiling =
      typeof audit?.glibcSymbolCeiling === 'string'
        ? parseGlibcSymbol(audit.glibcSymbolCeiling)
        : undefined;
    const floor = parseVersion(target.minimumGlibc);
    if (
      !hasExactKeys(audit, [
        'architecture',
        'dependencies',
        'glibcSymbolCeiling',
        'rpath',
      ]) ||
      audit.architecture !== target.architecture ||
      JSON.stringify(audit.dependencies) !== JSON.stringify(['libc.so.6']) ||
      audit.rpath !== false ||
      ceiling === undefined ||
      floor === undefined ||
      compareVersions(ceiling, [0, 0]) <= 0 ||
      compareVersions(ceiling, floor) > 0
    ) {
      fail(`${target.id} dependency-floor audit does not match its Linux policy`);
    }
    return;
  }

  if (
    !hasExactKeys(audit, [
      'architecture',
      'dependencies',
      'macOSDeploymentTarget',
    ]) ||
    audit.architecture !== target.architecture ||
    JSON.stringify(audit.dependencies) !==
      JSON.stringify(['/usr/lib/libSystem.B.dylib']) ||
    audit.macOSDeploymentTarget !== target.minimumMacOS
  ) {
    fail(`${target.id} dependency-floor audit does not match its Darwin policy`);
  }
}

function auditLinux(target, path) {
  const readelf = findAuditTool('RELIC_READELF', ['llvm-readelf', 'readelf']);
  const header = run(readelf, ['-h', path]);
  if (!/Class:\s+ELF64\b/.test(header)) {
    fail(`${target.id} artifact is not ELF64`);
  }
  const machine = /Machine:\s*(.+?)\s*$/m.exec(header)?.[1] ?? '';

  const dynamic = run(readelf, ['-d', path]);
  const dependencies = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(
    (match) => match[1]
  );
  const versions = parseGlibcVersions(run(readelf, ['--version-info', path]));
  if (versions.length === 0) {
    fail(`${target.id} artifact has no parsed GLIBC symbol versions`);
  }
  const maximum = versions.reduce(
    (current, version) =>
      compareVersions(version, current) > 0 ? version : current,
    [0, 0]
  );
  const audit = {
    architecture: machine,
    dependencies,
    glibcSymbolCeiling: `GLIBC_${maximum[0]}.${maximum[1]}`,
    rpath: /\((?:RPATH|RUNPATH)\)/.test(dynamic),
  };
  validateAudit(target, audit);
  return audit;
}

function auditDarwin(target, path) {
  const lipo = findAuditTool('RELIC_LIPO', ['lipo']);
  const otool = findAuditTool('RELIC_OTOOL', ['otool']);
  const architectures =
    run(lipo, ['-archs', path]).match(/\b(?:arm64|x86_64)\b/g) ?? [];
  const linked = run(otool, ['-L', path])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter((value) => value !== '');
  const loadCommands = run(otool, ['-l', path]);
  const versionMatch = /cmd LC_BUILD_VERSION[\s\S]*?minos ([0-9.]+)/.exec(
    loadCommands
  );
  const audit = {
    architecture: architectures.length === 1 ? architectures[0] : '',
    dependencies: linked,
    macOSDeploymentTarget: versionMatch?.[1] ?? '',
  };
  validateAudit(target, audit);
  return audit;
}

function auditArtifact(target, path) {
  return target.platform === 'linux'
    ? auditLinux(target, path)
    : auditDarwin(target, path);
}

function firstOutputLine(output) {
  const firstLine = output
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim();
  if (firstLine === undefined) fail('compiler did not report an identity');
  return firstLine;
}

function compilerIdentity(command, output) {
  return {
    command,
    id: basename(command),
    version: firstOutputLine(output),
  };
}

function isPathUnder(path, directory) {
  return path.startsWith(`${directory}/`);
}

function darwinToolchainContext(target, compiler, release = false) {
  const sdkPath = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim();
  const sdkVersion = run('xcrun', ['--sdk', 'macosx', '--show-sdk-version']).trim();
  if (sdkPath === '' || sdkVersion === '') fail('xcrun did not identify the selected macOS SDK');

  if (release) {
    const xcodeVersion = firstOutputLine(run('xcodebuild', ['-version']));
    if (xcodeVersion !== `Xcode ${darwinReleaseToolchain.xcodeVersion}`) {
      fail(
        `release Darwin build requires Xcode ${darwinReleaseToolchain.xcodeVersion}, found ${xcodeVersion}`
      );
    }
    if (sdkVersion !== darwinReleaseToolchain.sdkVersion) {
      fail(
        `release Darwin build requires SDK ${darwinReleaseToolchain.sdkVersion}, found ${sdkVersion}`
      );
    }
    if (!isPathUnder(sdkPath, darwinReleaseToolchain.developerDir)) {
      fail(
        `release Darwin build requires an SDK under ${darwinReleaseToolchain.developerDir}, found ${sdkPath}`
      );
    }
    if (!isPathUnder(compiler, darwinReleaseToolchain.developerDir)) {
      fail(
        `release Darwin build requires a compiler under ${darwinReleaseToolchain.developerDir}, found ${compiler}`
      );
    }
  }

  const context = {
    compiler: compilerIdentity(compiler, run(compiler, ['--version'])),
    toolchain: {
      binaryDeploymentTarget: target.minimumMacOS,
      kind: 'darwin-xcode-sdk',
      sdkPath,
      sdkVersion,
    },
  };
  if (release) {
    context.toolchain.xcodeVersion = darwinReleaseToolchain.xcodeVersion;
  }
  return context;
}

function linuxToolchainContext(target) {
  const toolchain = linuxToolchainFor(target);
  return {
    compiler: compilerIdentity(
      toolchain.compilerPath,
      runLinuxCompiler(toolchain, undefined, undefined, ['--version'])
    ),
    toolchain: {
      compilerPath: toolchain.compilerPath,
      containerPlatform: toolchain.containerPlatform,
      image: toolchain.image,
      imageDigest: toolchain.imageDigest,
      kind: 'manylinux-2.28',
    },
  };
}

function commonCompilerArguments() {
  return [
    '-std=c11',
    '-O2',
    '-fPIC',
    '-fvisibility=hidden',
    '-DNAPI_VERSION=8',
    '-D_FILE_OFFSET_BITS=64',
  ];
}

function darwinCompilerArguments(target, toolchain) {
  return [
    '-isysroot',
    toolchain.sdkPath,
    `-mmacosx-version-min=${target.minimumMacOS}`,
    '-arch',
    target.architecture,
  ];
}

function nativeAddonCompilerArguments(target, nodeInclude, output, toolchain) {
  const argumentsToCompile = [
    ...commonCompilerArguments(),
    '-I',
    nodeInclude,
    join(nativeDirectory, 'secure-open.c'),
    join(nativeDirectory, target.source),
  ];
  if (target.platform === 'darwin') {
    argumentsToCompile.push(
      ...darwinCompilerArguments(target, toolchain),
      '-bundle',
      '-undefined',
      'dynamic_lookup'
    );
  } else {
    argumentsToCompile.push('-D_GNU_SOURCE', '-shared', '-Wl,-z,relro,-z,now');
  }
  argumentsToCompile.push('-o', output);
  return argumentsToCompile;
}

function nativeAddonLinuxCompilerArguments(target) {
  const argumentsToCompile = [
    ...commonCompilerArguments(),
    '-I',
    '/source/node-include',
    '/source/native/secure-open.c',
    `/source/native/${target.source}`,
    '-D_GNU_SOURCE',
    '-shared',
    '-Wl,-z,relro,-z,now',
    '-o',
    '/output/secure_open.node',
  ];
  return argumentsToCompile;
}

function isPathWithin(parent, child) {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

async function buildTarget(target, options) {
  assertNativeHost(target);
  if (!existsSync(join(options.nodeInclude, 'node_api.h'))) {
    fail(`--node-include must contain node_api.h (${options.nodeInclude})`);
  }

  const output = outputPaths(target, options.outputDir);
  await mkdir(output.directory, { recursive: true });

  let buildContext;
  if (target.platform === 'linux') {
    buildContext = linuxToolchainContext(target);
    const toolchain = linuxToolchainFor(target);
    runLinuxCompiler(
      toolchain,
      output.directory,
      options.nodeInclude,
      nativeAddonLinuxCompilerArguments(target)
    );
  } else {
    buildContext = darwinToolchainContext(target, options.cc, options.release);
    run(
      options.cc,
      nativeAddonCompilerArguments(target, options.nodeInclude, output.artifact, buildContext.toolchain)
    );
  }

  const audit = auditArtifact(target, output.artifact);
  const info = {
    artifact: artifactName,
    audit,
    binarySha256: await sha256(output.artifact),
    buildKind: options.release ? 'release' : 'local',
    compiler: buildContext.compiler,
    minimumPlatform:
      target.platform === 'darwin'
        ? { macOS: target.minimumMacOS }
        : { glibc: target.minimumGlibc },
    nodeApiVersion,
    schemaVersion: buildMetadataSchemaVersion,
    sourceSha256: await sourceSha256(),
    target: target.id,
    toolchain: buildContext.toolchain,
  };
  await writeFile(output.buildInfo, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`built ${target.id}: ${output.artifact}`);
}

function validateCompilerMetadata(target, compiler) {
  if (
    compiler === null ||
    typeof compiler !== 'object' ||
    typeof compiler.command !== 'string' ||
    compiler.command === '' ||
    typeof compiler.id !== 'string' ||
    compiler.id === '' ||
    typeof compiler.version !== 'string' ||
    compiler.version === ''
  ) {
    fail(`${target.id} build-info.json has no usable compiler identity`);
  }
}

function validateToolchainMetadata(target, toolchain) {
  if (toolchain === null || typeof toolchain !== 'object') {
    fail(`${target.id} build-info.json has no usable toolchain identity`);
  }

  if (target.platform === 'linux') {
    const expected = linuxToolchainFor(target);
    const actual = {
      compilerPath: toolchain.compilerPath,
      containerPlatform: toolchain.containerPlatform,
      image: toolchain.image,
      imageDigest: toolchain.imageDigest,
      kind: toolchain.kind,
    };
    const required = {
      compilerPath: expected.compilerPath,
      containerPlatform: expected.containerPlatform,
      image: expected.image,
      imageDigest: expected.imageDigest,
      kind: 'manylinux-2.28',
    };
    if (JSON.stringify(actual) !== JSON.stringify(required)) {
      fail(`${target.id} build-info.json does not identify the pinned manylinux toolchain`);
    }
    return;
  }

  if (
    toolchain.kind !== 'darwin-xcode-sdk' ||
    toolchain.binaryDeploymentTarget !== target.minimumMacOS ||
    typeof toolchain.sdkPath !== 'string' ||
    toolchain.sdkPath === '' ||
    typeof toolchain.sdkVersion !== 'string' ||
    toolchain.sdkVersion === ''
  ) {
    fail(`${target.id} build-info.json does not identify its exact Darwin binary deployment target and SDK`);
  }
}

function validateBuildKind(target, buildKind, release) {
  if (buildKind !== 'local' && buildKind !== 'release') {
    fail(`${target.id} build-info.json has an invalid buildKind`);
  }
  if (release && buildKind !== 'release') {
    fail(`${target.id} build-info.json buildKind must be release for --release checks`);
  }
}

function validateReleaseMetadata(target, compiler, toolchain) {
  if (target.platform !== 'darwin') return;

  if (
    toolchain.xcodeVersion !== darwinReleaseToolchain.xcodeVersion ||
    toolchain.sdkVersion !== darwinReleaseToolchain.sdkVersion ||
    !isPathUnder(toolchain.sdkPath, darwinReleaseToolchain.developerDir) ||
    !isPathUnder(compiler.command, darwinReleaseToolchain.developerDir)
  ) {
    fail(`${target.id} build-info.json does not identify the pinned Darwin release toolchain`);
  }
}

async function checkTarget(target, metadataOnly, release) {
  const output = outputPaths(target, undefined);
  if (!existsSync(output.artifact) || !existsSync(output.buildInfo)) {
    fail(`${target.id} is missing ${artifactName} or build-info.json`);
  }

  let info;
  try {
    info = JSON.parse(await readFile(output.buildInfo, 'utf8'));
  } catch (cause) {
    fail(`${target.id} has unreadable build-info.json: ${String(cause)}`);
  }

  if (
    info.schemaVersion !== buildMetadataSchemaVersion ||
    info.target !== target.id ||
    info.artifact !== artifactName ||
    info.nodeApiVersion !== nodeApiVersion ||
    info.sourceSha256 !== (await sourceSha256()) ||
    info.binarySha256 !== (await sha256(output.artifact))
  ) {
    fail(`${target.id} build-info.json does not match its source or binary`);
  }

  validateBuildKind(target, info.buildKind, release);
  validateCompilerMetadata(target, info.compiler);
  validateToolchainMetadata(target, info.toolchain);
  if (release) validateReleaseMetadata(target, info.compiler, info.toolchain);
  validateAudit(target, info.audit);
  if (!metadataOnly) {
    const audit = auditArtifact(target, output.artifact);
    if (JSON.stringify(info.audit) !== JSON.stringify(audit)) {
      fail(`${target.id} build-info.json does not match the dependency-floor audit`);
    }
  }

  const minimumPlatform =
    target.platform === 'darwin'
      ? { macOS: target.minimumMacOS }
      : { glibc: target.minimumGlibc };
  if (JSON.stringify(info.minimumPlatform) !== JSON.stringify(minimumPlatform)) {
    fail(`${target.id} build-info.json has the wrong platform floor`);
  }

  console.log(
    `checked ${target.id}: ${output.artifact}${metadataOnly ? ' (metadata only)' : ''}`
  );
}

async function buildDarwinProbe(target, options) {
  assertNativeHost(target);
  const prebuildDirectory = resolve(join(packageDirectory, 'prebuilds'));
  if (isPathWithin(prebuildDirectory, options.outputDir)) {
    fail('--probe output must be outside shipped prebuild directories');
  }

  await mkdir(options.outputDir, { recursive: true });
  const output = join(options.outputDir, 'darwin-confinement-probe');
  const buildContext = darwinToolchainContext(target, options.cc);
  const argumentsToCompile = [
    ...commonCompilerArguments(),
    ...darwinCompilerArguments(target, buildContext.toolchain),
    join(nativeDirectory, 'darwin-confinement-probe.c'),
    join(nativeDirectory, target.source),
    '-o',
    output,
  ];
  run(options.cc, argumentsToCompile);

  const runtime = {
    kernel: run('uname', ['-a']).trim(),
    macOS: run('sw_vers', ['-productVersion']).trim(),
    nodeArchitecture: process.arch,
  };
  console.log(
    JSON.stringify({
      compiler: buildContext.compiler,
      event: 'darwin-confinement-probe',
      runtime,
      sdk: {
        path: buildContext.toolchain.sdkPath,
        version: buildContext.toolchain.sdkVersion,
      },
      target: target.id,
    })
  );

  const probeOutput = run(output, []).trim();
  if (probeOutput !== '') process.stdout.write(`${probeOutput}\n`);
}

const options = parseArguments(process.argv.slice(2));
if (options.check) {
  const selected = options.target === undefined ? Object.values(targets) : [targets[options.target]];
  for (const target of selected) {
    await checkTarget(target, options.metadataOnly, options.release);
  }
} else if (options.probe) {
  await buildDarwinProbe(targets[options.target], options);
} else {
  await buildTarget(targets[options.target], options);
}
