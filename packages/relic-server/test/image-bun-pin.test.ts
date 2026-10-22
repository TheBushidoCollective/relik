import { expect, test } from 'bun:test';

// The server image builds the viewer assets readers download, with Bun as the
// bundler. CI verifies with the Bun in mise.toml. If the two differ, the
// shipped viewer.js and sandbox.html are produced by an untested bundler,
// which has already happened once (the chunk loader's csp-nonce lookup).
test('the server image builds and runs on the Bun that CI verifies with', async () => {
  const root = new URL('../../../', import.meta.url);
  const mise = await Bun.file(new URL('mise.toml', root)).text();
  const dockerfile = await Bun.file(
    new URL('deploy/docker/server/Dockerfile', root)
  ).text();

  const pinned = mise.match(/^bun\s*=\s*"([^"]+)"/m)?.[1];
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

  const stages = [...dockerfile.matchAll(/^FROM\s+oven\/bun:(\S+)/gm)].map(
    (match) => match[1]
  );
  // Both the build stage and the runtime stage.
  expect(stages.length).toBe(2);
  for (const tag of stages) {
    expect(tag).toBe(`${pinned}-alpine`);
  }
});
