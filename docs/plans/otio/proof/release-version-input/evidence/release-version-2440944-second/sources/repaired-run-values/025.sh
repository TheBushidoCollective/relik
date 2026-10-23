set -euo pipefail
set -- "$RUNNER_TEMP"/tarball/*.tgz
test -f "$1"
npm publish "$1" --access public
