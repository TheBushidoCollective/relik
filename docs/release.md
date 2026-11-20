# relic-mcp releases

1. Merge the package version bump to `main`.
2. Push `relic-mcp-v<version>` at the merged commit. For a dry run, push `relic-mcp-v<version>-dryrun` instead.
3. The tag workflow checks that the tagged commit is on `main` and its package version matches the tag, then dispatches `publish-mcp.yml` on `main`. The publish workflow checks the dispatch event, bot login and numeric ID, triggering actor, main branch, package version, and corresponding tag before its existing build and package proofs run. A dry run runs the proofs without publishing.

Never dispatch `publish-mcp.yml` by hand. To roll back a consumer, pin it to the previous published version.

The npm trusted publisher must authorize this repository and `.github/workflows/publish-mcp.yml`, the workflow that actually publishes using OIDC. Its npm configuration has not been verified. The dispatcher and admission job have not been exercised on GitHub; after merge, a dry-run tag is the proof of that path.
