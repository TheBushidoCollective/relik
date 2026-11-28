import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checker = new URL('../bin/autofix-verify-bundle.py', import.meta.url)
  .pathname;
const list = new URL(
  '../../../.github/omp-context-members.txt',
  import.meta.url
).pathname;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-bundle-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function run(kind: string, wrongPin = false) {
  const archive = join(dir, `${kind}.tar.gz`);
  const target = join(dir, `${kind}-out`);
  const pin = join(dir, `${kind}.pin`);
  execFileSync('python3', [
    '-c',
    `import io,sys,tarfile\na=tarfile.open(sys.argv[1], 'w:gz')\nnames=open(sys.argv[2]).read().splitlines()\nkind=sys.argv[3]\nif kind=='extra': names.append('extra.txt')\nif kind=='missing': names.pop()\nif kind=='traversal': names[0]='../escape'\nif kind=='absolute': names[0]='/absolute'\nif kind=='duplicate': names.append(names[0])\nfor name in names:\n i=tarfile.TarInfo(name); i.size=1\n if kind=='symlink' and name==names[0]: i.type=tarfile.SYMTYPE; i.linkname='/tmp/target'; i.size=0\n if kind=='hardlink' and name==names[0]: i.type=tarfile.LNKTYPE; i.linkname='other'; i.size=0\n if kind=='device' and name==names[0]: i.type=tarfile.CHRTYPE; i.size=0\n a.addfile(i, io.BytesIO(b'x') if i.size else None)\na.close()`,
    archive,
    list,
    kind,
  ]);
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(pin, wrongPin ? `${'0'.repeat(64)}\n` : `${hash}\n`);
  return {
    result: spawnSync('python3', [checker, archive, pin, list, target], {
      encoding: 'utf8',
    }),
    target,
  };
}
describe('pinned bundle boundary', () => {
  test('pins the reviewed bundle and its unchanged eight-member allowlist', async () => {
    const pin = await readFile(
      new URL('../../../.github/omp-context.pin', import.meta.url),
      'utf8'
    );
    expect(pin.trim()).toBe(
      '9fa8832a5b1c8eb134d68b397bc07262c9719f20467eafb8c3dcffd57d1b4e92'
    );
    expect((await readFile(list, 'utf8')).trim().split('\n')).toEqual([
      'bin/install-omp',
      'bin/prepare-relik.sh',
      'memory/relik/snapshot.db',
      'projects/relik/RULES.md',
      'projects/relik/bundle-files.txt',
      'projects/relik/empty-agent.db',
      'projects/relik/runtime.py',
      'projects/relik/settings.json',
    ]);
  });
  test('extracts the exact allowlist only after hash verification', async () => {
    const { result, target } = await run('valid');
    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'projects/relik/runtime.py'))).toBe(true);
  });
  for (const kind of [
    'extra',
    'missing',
    'traversal',
    'absolute',
    'duplicate',
    'symlink',
    'hardlink',
    'device',
  ]) {
    test(`rejects ${kind} archive members without extracting`, async () => {
      const { result, target } = await run(kind);
      expect(result.status).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    });
  }
  test('rejects a pin mismatch before creating the extraction directory', async () => {
    const { result, target } = await run('wrong-pin', true);
    expect(result.status).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });
});
