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

The command and browser proof have not run yet. This branch remains unverified until the complete path passes.
