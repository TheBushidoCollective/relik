set -euo pipefail
set -- "$RUNNER_TEMP"/tarball/*.tgz
test -f "$1"
RELIC_MCP_PROVE_HIDE_SOURCE=1 \
RELIC_MCP_PROVE_SOURCE_ROOT="$GITHUB_WORKSPACE" \
node packages/relic-mcp/scripts/prove-packed-native.mjs "$1"
