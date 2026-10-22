# OTIO review path

A publisher supplies an `.otiod` directory, Relik packages and encrypts a standard `.otioz`, a reviewer plays its tracks and leaves track-specific point or range feedback, and a fresh publisher agent reads the original revision and source-media coordinates before publishing a revision.

## Acceptance command

The implementation must provide this loopback-only proof:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
mise exec -- bun packages/relic-mcp/test/otio-path.ts
```

Success requires `OTIO_PATH_OK`, decoded playback observations, encrypted comment persistence, and agent readback after a revision. Unsupported codecs, effects, schemas, and ambiguous revision mappings must be explicit. All proof writes target local in-memory services.

The complete source path passed locally at `5a4bd6d` with Node 24.15.0, Bun 1.4.3, and the owned Chromium headless shell 1228. It exercised the original archive/playback/encrypted-feedback/revision stages, both exact-identity sidebar reveals after 40 coincident UI comments, and the zero-mail assertion, ending `OTIO_PATH_OK`. The matched old renderer failed the exact marker-center reveal assertion after the same 40 UI posts. Release qualification, CI, deployment, and the published npm client remain separate gates.
