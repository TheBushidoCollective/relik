import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const nodeInclude = join(dirname(dirname(process.execPath)), 'include', 'node');

const target =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? 'darwin-arm64'
    : process.platform === 'darwin' && process.arch === 'x64'
      ? 'darwin-x64'
      : process.platform === 'linux' && process.arch === 'arm64'
        ? 'linux-arm64-gnu'
        : process.platform === 'linux' && process.arch === 'x64'
          ? 'linux-x64-gnu'
          : undefined;

if (target === undefined) {
  console.log(
    `native secure-open is unavailable for ${process.platform}/${process.arch}; ordinary MCP builds remain Node-only`
  );
  process.exit(0);
}

if (!existsSync(join(nodeInclude, 'node_api.h'))) {
  throw new Error(`Node headers are missing at ${nodeInclude}`);
}

if (process.platform === 'linux' && Object.prototype.hasOwnProperty.call(process.env, 'CC')) {
  throw new Error('CC is Darwin-only; Linux native builds use the pinned manylinux toolchain');
}

const argumentsToRun = [
  join(nativeDirectory, 'build.mjs'),
  '--target',
  target,
  '--node-include',
  nodeInclude,
];
if (process.platform === 'darwin') {
  argumentsToRun.push('--cc', process.env['CC'] ?? 'clang');
}

const result = spawnSync(process.execPath, argumentsToRun, { stdio: 'inherit' });
if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(`native secure-open local build failed with status ${result.status}`);
}