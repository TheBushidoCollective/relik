import { describe, expect, test } from 'bun:test';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  THREE_SLOT_LANDMARK,
  THREE_SLOT_REPLACEMENT,
  WORKSPACE_PREFIX,
  applyThreeSlotTransform,
  includeInCopy,
  withOwnedWorkspace,
} from './proof-viewer-three-slot.ts';

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

// A parent directory that only this test owns, holding a fake viewer tree (src and a
// node_modules directory). Workspaces are siblings of the viewer, so they land here.
async function fixture(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'proof-three-slot-parent-'));
  const root = join(parent, 'relic-viewer');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'mediabunny'), { recursive: true });
  await writeFile(join(root, 'src', 'viewer.ts'), 'export const v = 1;\n');
  await writeFile(
    join(root, 'node_modules', 'mediabunny', 'package.json'),
    '{}'
  );
  return { parent, root };
}

describe('three-slot landmark transform', () => {
  test('replaces the single exact landmark', () => {
    const source = `header\n${THREE_SLOT_LANDMARK}\nfooter\n`;
    const result = applyThreeSlotTransform(source);
    expect(result.landmarkCount).toBe(1);
    expect(result.text).toContain(THREE_SLOT_REPLACEMENT);
    expect(result.text).not.toContain('1 + Math.ceil(reach / wMinSeconds)');
  });

  test('fails when the landmark is absent', () => {
    expect(() => applyThreeSlotTransform('export const x = 1;\n')).toThrow(
      'found 0 times'
    );
  });

  test('fails when the landmark is duplicated', () => {
    const source = `${THREE_SLOT_LANDMARK}\n${THREE_SLOT_LANDMARK}\n`;
    expect(() => applyThreeSlotTransform(source)).toThrow('found 2 times');
  });
});

describe('sibling workspace', () => {
  test('is created beside the viewer, never inside it, and links its node_modules', async () => {
    const { parent, root } = await fixture();
    try {
      await withOwnedWorkspace(root, async (work) => {
        expect(dirname(work)).toBe(parent);
        expect(work.startsWith(root + '/')).toBe(false);
        expect((await lstat(join(work, 'node_modules'))).isSymbolicLink()).toBe(
          true
        );
        expect(await readlink(join(work, 'node_modules'))).toBe(
          join(root, 'node_modules')
        );
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('copying the viewer into the sibling succeeds where an inside copy would fail', async () => {
    const { parent, root } = await fixture();
    try {
      await withOwnedWorkspace(root, async (work) => {
        await cp(root, work, {
          recursive: true,
          filter: (src) => includeInCopy(root, work, src),
        });
        expect(await readFile(join(work, 'src', 'viewer.ts'), 'utf8')).toBe(
          'export const v = 1;\n'
        );
        // node_modules is linked, never copied into the workspace as a real directory.
        expect((await lstat(join(work, 'node_modules'))).isSymbolicLink()).toBe(
          true
        );
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('a missing viewer node_modules fails before any copy and leaves nothing behind', async () => {
    const { parent, root } = await fixture();
    try {
      await rm(join(root, 'node_modules'), { recursive: true, force: true });
      await expect(
        withOwnedWorkspace(root, async () => undefined)
      ).rejects.toThrow('viewer node_modules missing');
      const leftovers = (await readdir(parent)).filter((name) =>
        name.startsWith(WORKSPACE_PREFIX)
      );
      expect(leftovers).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('concurrent invocations get distinct sibling directories and remove only their own', async () => {
    const { parent, root } = await fixture();
    try {
      const seen: string[] = [];
      // Each invocation signals that it holds its workspace, then waits until the other
      // does too, so both directories exist at once without any timer.
      const held = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ];
      await Promise.all(
        [0, 1].map((index) =>
          withOwnedWorkspace(root, async (work) => {
            seen.push(work);
            held[index]!.resolve();
            await held[1 - index]!.promise;
            expect(await exists(work)).toBe(true);
          })
        )
      );
      expect(seen.length).toBe(2);
      expect(seen[0]).not.toBe(seen[1]);
      for (const work of seen) {
        expect(dirname(work)).toBe(parent);
        expect(await exists(work)).toBe(false);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('a foreign workspace with the same prefix is never removed', async () => {
    const { parent, root } = await fixture();
    try {
      const foreign = join(parent, `${WORKSPACE_PREFIX}foreign-user-work`);
      await mkdir(foreign);
      await writeFile(join(foreign, 'MARKER'), 'unrelated user work');
      await withOwnedWorkspace(root, async () => undefined);
      expect(await readFile(join(foreign, 'MARKER'), 'utf8')).toBe(
        'unrelated user work'
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('the fixed legacy name beside the viewer is never removed', async () => {
    const { parent, root } = await fixture();
    try {
      const fixed = join(parent, '.proof-three-slot');
      await mkdir(fixed);
      await writeFile(join(fixed, 'MARKER'), 'fixed-name user work');
      await withOwnedWorkspace(root, async () => undefined);
      expect(await readFile(join(fixed, 'MARKER'), 'utf8')).toBe(
        'fixed-name user work'
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('a failing build removes only its own workspace', async () => {
    const { parent, root } = await fixture();
    try {
      const foreign = join(parent, `${WORKSPACE_PREFIX}other`);
      await mkdir(foreign);
      await writeFile(join(foreign, 'MARKER'), 'keep');
      let own = '';
      await expect(
        withOwnedWorkspace(root, async (work) => {
          own = work;
          throw new Error('build failed');
        })
      ).rejects.toThrow('build failed');
      expect(own).not.toBe('');
      expect(await exists(own)).toBe(false);
      expect(await readFile(join(foreign, 'MARKER'), 'utf8')).toBe('keep');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('copy filter', () => {
  const root = resolve('/tmp/viewer-root-example');
  const work = resolve(dirname(root), `${WORKSPACE_PREFIX}abc123`);

  test('never copies the exact own workspace or anything inside it', () => {
    expect(includeInCopy(root, work, work)).toBe(false);
    expect(includeInCopy(root, work, join(work, 'src'))).toBe(false);
  });

  test('never copies a foreign workspace, node_modules, or dist; keeps the source', () => {
    expect(
      includeInCopy(root, work, join(root, `${WORKSPACE_PREFIX}other`))
    ).toBe(false);
    expect(includeInCopy(root, work, join(root, 'node_modules'))).toBe(false);
    expect(includeInCopy(root, work, join(root, 'dist'))).toBe(false);
    expect(includeInCopy(root, work, root)).toBe(true);
    expect(includeInCopy(root, work, join(root, 'src', 'viewer.ts'))).toBe(
      true
    );
  });
});
