set -euo pipefail
command -v docker
docker version --format '{{.Server.Version}}'
if ! command -v readelf >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends binutils
fi
echo "RELIC_READELF=$(command -v readelf)" >> "$GITHUB_ENV"
