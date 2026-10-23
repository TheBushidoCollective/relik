set -euo pipefail
NODE_INCLUDE="$(node -p "const p = require('node:path'); p.join(p.dirname(p.dirname(process.execPath)), 'include', 'node')")"
test -f "$NODE_INCLUDE/node_api.h"
OUT="$RUNNER_TEMP/native-$TARGET"
mkdir -p "$OUT"
node packages/relic-mcp/native/build.mjs \
  --target "$TARGET" \
  --node-include "$NODE_INCLUDE" \
  --cc "$RELIC_RELEASE_CC" \
  --output-dir "$OUT" \
  --release
test -f "$OUT/secure_open.node"
test -f "$OUT/build-info.json"
