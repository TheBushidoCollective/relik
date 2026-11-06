import { describe, expect, test } from 'bun:test';
import { validateMetafile } from './check-maintenance-metafile.mjs';

function fixture(imports: unknown[] = []) {
  return {
    inputs: {
      'scripts/ephemeral-operator.ts': { imports },
      'packages/relic-server/src/app.ts': { imports: [] },
      'packages/relic-server/src/gcsstore.ts': { imports: [] },
    },
    outputs: { 'operator': { imports: [] } },
  };
}

describe('maintenance bundle closure', () => {
  test('accepts the reviewed built-ins', () => {
    const meta = fixture([{ path: 'node:crypto', external: true }, { path: 'node:zlib', external: true }, { path: 'crypto', external: true }, { path: 'zlib', external: true }]);
    expect(validateMetafile(meta)).toContain('packages/relic-server/src/app.ts');
  });
  test('rejects and names unknown runtime imports from inputs and outputs', () => {
    expect(() => validateMetafile(fixture([{ path: 'node:child_process', external: true }]))).toThrow('unreviewed runtime import: node:child_process');
    expect(() => validateMetafile(fixture([{ path: 'crypto-extra', external: true }]))).toThrow('unreviewed runtime import: crypto-extra');
    expect(() => validateMetafile(fixture([{ path: 'zlib/other', external: true }]))).toThrow('unreviewed runtime import: zlib/other');
    const meta = fixture(); meta.outputs.operator.imports.push({ path: 'unreviewed-package', external: true } as never);
    expect(() => validateMetafile(meta)).toThrow('unreviewed runtime import: unreviewed-package');
  });
  test('does not expose malformed module names', () => {
    expect(() => validateMetafile(fixture([{ path: 'bad?token=private', external: true }]))).toThrow('unreviewed runtime import: <invalid-module-name>');
  });
  test('refuses entrypoint bootstrap and dependency tree inputs', () => {
    const meta = fixture(); Object.assign(meta.inputs, { 'packages/relic-server/src/index.ts': { imports: [] } });
    expect(() => validateMetafile(meta)).toThrow('unreviewed bundle input');
  });
});
