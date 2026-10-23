set -euo pipefail
export DEVELOPER_DIR="/Applications/Xcode_16.4.app/Contents/Developer"
test -d "$DEVELOPER_DIR"
test "$(xcodebuild -version | awk 'NR == 1 { print $2 }')" = "16.4"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
CC="$(xcrun --sdk macosx --find clang)"
case "$SDKROOT" in "$DEVELOPER_DIR"/*) ;; *) echo "unexpected SDK: $SDKROOT" >&2; exit 1;; esac
case "$CC" in "$DEVELOPER_DIR"/*) ;; *) echo "unexpected compiler: $CC" >&2; exit 1;; esac
cat > "$RUNNER_TEMP/require-missing-enotcapable.c" <<'EOF'
#include <errno.h>
#ifdef ENOTCAPABLE
#error Xcode 16.4 must exercise the missing ENOTCAPABLE header branch
#endif
int main(void) { return 0; }
EOF
"$CC" -isysroot "$SDKROOT" -mmacosx-version-min=15.0 -arch "${{ matrix.architecture }}" -fsyntax-only "$RUNNER_TEMP/require-missing-enotcapable.c"
{
  echo "### Xcode 16.4 probe: ${{ matrix.target }}"
  echo '```text'
  xcodebuild -version
  printf 'SDK path: %s\nSDK version: %s\nCompiler: %s\n' "$SDKROOT" "$SDK_VERSION" "$CC"
  "$CC" --version | head -n 1
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
node packages/relic-mcp/native/build.mjs \
  --probe \
  --target "$TARGET" \
  --cc "$CC" \
  --output-dir "$RUNNER_TEMP/probe-xcode-16.4-$TARGET"
