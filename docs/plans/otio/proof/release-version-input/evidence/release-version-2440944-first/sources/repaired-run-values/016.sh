set -euo pipefail
TARBALL="$(npm pack --pack-destination "$RUNNER_TEMP" --silent --no-workspaces)"
test -f "$RUNNER_TEMP/$TARBALL"
{
  echo '### Tarball hash'
  echo '```text'
  sha256sum "$RUNNER_TEMP/$TARBALL"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
echo "tarball=$RUNNER_TEMP/$TARBALL" >> "$GITHUB_OUTPUT"
