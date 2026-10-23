set -euo pipefail
for TARGET in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu; do
  DEST="packages/relic-mcp/prebuilds/$TARGET"
  mkdir -p "$DEST"
  cp "$RUNNER_TEMP/native/$TARGET/secure_open.node" "$DEST/"
  cp "$RUNNER_TEMP/native/$TARGET/build-info.json" "$DEST/"
done
# This portable check proves the tarball carries all audited files.
# Per-target jobs above and packed-target probes below perform the
# platform-specific otool/readelf checks.
node packages/relic-mcp/native/build.mjs --check --metadata-only --release
