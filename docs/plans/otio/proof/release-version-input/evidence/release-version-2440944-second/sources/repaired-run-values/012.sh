set -euo pipefail
MANIFEST="$RUNNER_TEMP/native-prebuilds.sha256"
: > "$MANIFEST"
for TARGET in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu; do
  for FILE in secure_open.node build-info.json; do
    PATHNAME="packages/relic-mcp/prebuilds/$TARGET/$FILE"
    test -f "$PATHNAME"
    sha256sum "$PATHNAME" >> "$MANIFEST"
  done
done
{
  echo '### Staged native prebuild hashes'
  echo '```text'
  cat "$MANIFEST"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
