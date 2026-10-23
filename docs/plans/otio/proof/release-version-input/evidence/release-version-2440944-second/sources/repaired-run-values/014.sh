set -euo pipefail
bun run --filter 'relic-mcp' build:bundle
sha256sum --check "$RUNNER_TEMP/native-prebuilds.sha256"
