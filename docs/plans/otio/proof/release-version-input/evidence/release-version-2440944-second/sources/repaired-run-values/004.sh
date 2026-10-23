set -euo pipefail
node packages/relic-mcp/native/build.mjs \
  --probe \
  --target "$TARGET" \
  --cc "$RELIC_RELEASE_CC" \
  --output-dir "$RUNNER_TEMP/probe-release-$TARGET"
