set -euo pipefail
set -- "$RUNNER_TEMP"/tarball/*.tgz
test -f "$1"
TARBALL_NAME="$(basename "$1")"
PROOF_DIRECTORY="$RUNNER_TEMP/packed-proof"
mkdir -p "$PROOF_DIRECTORY"
cp packages/relic-mcp/scripts/prove-packed-native.mjs "$PROOF_DIRECTORY/"
NODE_ROOT="$(node -p "const p = require('node:path'); p.dirname(p.dirname(process.execPath))")"
test -x "$NODE_ROOT/bin/node"
docker run --rm \
  --platform "$CONTAINER_PLATFORM" \
  --network none \
  --cap-drop ALL \
  --read-only \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777,size=512m \
  --tmpfs /work:rw,nosuid,nodev,exec,mode=1777,size=512m \
  --entrypoint /node/bin/node \
  --env PATH=/node/bin \
  --env HOME=/work \
  --env TMPDIR=/work \
  --env CC= \
  --env CXX= \
  --env AR= \
  --env MAKE= \
  --volume "$NODE_ROOT:/node:ro" \
  --volume "$PROOF_DIRECTORY:/proof:ro" \
  --volume "$RUNNER_TEMP/tarball:/input:ro" \
  "$RUNTIME_IMAGE" \
  /proof/prove-packed-native.mjs "/input/$TARBALL_NAME"
