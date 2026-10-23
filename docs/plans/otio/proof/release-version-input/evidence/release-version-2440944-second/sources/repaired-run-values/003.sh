set -euo pipefail
PIN_FILE="packages/relic-mcp/native/darwin-release-toolchain.json"
DEVELOPER_DIR="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).developerDir' "$PIN_FILE")"
XCODE_VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).xcodeVersion' "$PIN_FILE")"
PINNED_SDK_VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sdkVersion' "$PIN_FILE")"
export DEVELOPER_DIR
test -d "$DEVELOPER_DIR"
test "$(xcodebuild -version | awk 'NR == 1 { print $2 }')" = "$XCODE_VERSION"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
test "$SDK_VERSION" = "$PINNED_SDK_VERSION"
CC="$(xcrun --sdk macosx --find clang)"
case "$SDKROOT" in "$DEVELOPER_DIR"/*) ;; *) echo "unexpected SDK: $SDKROOT" >&2; exit 1;; esac
case "$CC" in "$DEVELOPER_DIR"/*) ;; *) echo "unexpected compiler: $CC" >&2; exit 1;; esac
cat > "$RUNNER_TEMP/require-enotcapable.c" <<'EOF'
#include <errno.h>
#ifndef ENOTCAPABLE
#error ENOTCAPABLE is required by the release SDK
#endif
int main(void) { return ENOTCAPABLE == 0; }
EOF
"$CC" -isysroot "$SDKROOT" -mmacosx-version-min=15.0 -arch "${{ matrix.architecture }}" -fsyntax-only "$RUNNER_TEMP/require-enotcapable.c"
{
  echo "### Release Xcode: ${{ matrix.target }}"
  echo '```text'
  xcodebuild -version
  printf 'SDK path: %s\nSDK version: %s\nCompiler: %s\n' "$SDKROOT" "$SDK_VERSION" "$CC"
  "$CC" --version | head -n 1
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
{
  echo "DEVELOPER_DIR=$DEVELOPER_DIR"
  echo "RELIC_RELEASE_CC=$CC"
} >> "$GITHUB_ENV"
