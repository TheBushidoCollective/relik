import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const outputRoot = process.env.STDIO_LINUX_TEST_IDENTITY_DIR;
const expectedSha256 = process.env.STDIO_LINUX_VERIFIED_BUN_SHA256;

if (!outputRoot || !expectedSha256) {
  throw new Error(
    'STDIO_LINUX_TEST_IDENTITY_DIR and STDIO_LINUX_VERIFIED_BUN_SHA256 are required for the test identity preload'
  );
}

const procSelfExeReadlink = readlinkSync('/proc/self/exe');
const procSelfExeRealpath = realpathSync('/proc/self/exe');
const processExecRealpath = realpathSync(process.execPath);
const actualBytes = new Uint8Array(readFileSync(procSelfExeRealpath));
const actualSha256 = createHash('sha256').update(actualBytes).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error(
    `test PID ${process.pid} uses Bun SHA-256 ${actualSha256}, expected ${expectedSha256}`
  );
}
if (procSelfExeRealpath !== processExecRealpath) {
  throw new Error(
    `test PID ${process.pid} process.execPath resolves to ${processExecRealpath}, /proc/self/exe resolves to ${procSelfExeRealpath}`
  );
}
if (
  actualBytes[0] !== 0x7f ||
  actualBytes[1] !== 0x45 ||
  actualBytes[2] !== 0x4c ||
  actualBytes[3] !== 0x46
) {
  throw new Error(`test PID ${process.pid} is not backed by an ELF executable`);
}

const pidDirectory = resolve(outputRoot, `pid-${process.pid}`);
mkdirSync(pidDirectory, { recursive: true });
copyFileSync(procSelfExeRealpath, join(pidDirectory, 'bun.elf'));
writeFileSync(
  join(pidDirectory, 'identity.json'),
  `${JSON.stringify(
    {
      schema: 'relic-stdio-linux-test-process-identity-v1',
      instrumentation: 'timing-changing-startup-instrumentation',
      process_pid: process.pid,
      bun_version: Bun.version,
      bun_revision: Bun.revision,
      node_compat_version: process.version,
      process_exec_path: process.execPath,
      process_exec_realpath: processExecRealpath,
      proc_self_exe_readlink: procSelfExeReadlink,
      proc_self_exe_realpath: procSelfExeRealpath,
      actual_elf: {
        artifact_filename: 'bun.elf',
        sha256: actualSha256,
        bytes: actualBytes.length,
        magic: '7f454c46',
      },
    },
    null,
    2
  )}\n`
);
