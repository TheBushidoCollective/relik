# relic-mcp releases

1. Merge the package version bump to `main`. The version must be higher than the latest on npm (`npm view relic-mcp version`); the dry run does not check it, and npm refuses to publish over an existing version.
2. Push `relic-mcp-v<version>` at the merged commit. For a dry run, push `relic-mcp-v<version>-dryrun` instead.
3. The tag workflow checks that the tagged commit is on `main` and its package version matches the tag, then dispatches `publish-mcp.yml` on `main`. The publish workflow checks the dispatch event, bot login and numeric ID, triggering actor, main branch, package version, and corresponding tag before its existing build and package proofs run. Both workflows require the checked-out commit to match the tag. A dry run runs the proofs without publishing.

If main moves between tagging and the publish run, admission fails closed. Delete and re-push the tag at the new main commit after checking its package version. Configure a tag ruleset restricting who can push `relic-mcp-v*` tags.

Never dispatch `publish-mcp.yml` by hand. To roll back a consumer, pin it to the previous published version.

The npm trusted publisher must authorize this repository and `.github/workflows/publish-mcp.yml`, the workflow that actually publishes using OIDC. Earlier releases (0.14.4 to 0.16.0) were published by GitHub Actions with provenance from that workflow, so the authorization exists; the npm setting itself was not read. The dispatcher and admission job were exercised on 2026-11-20 with a dry-run tag (run 44745585313): the dispatcher started the publish workflow, `admit` accepted it, and the packaging proofs passed with the npm publish step skipped.
