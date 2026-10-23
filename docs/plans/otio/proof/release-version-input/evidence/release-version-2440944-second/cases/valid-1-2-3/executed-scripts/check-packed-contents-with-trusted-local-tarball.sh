set -euo pipefail
TARBALL="/Users/jwaldrip/.omp/otio-evidence/release-version-2440944-second/cases/valid-1-2-3/runtime/runner-temp/relic-mcp-1.2.3--.tgz"
PROBE="$RUNNER_TEMP/contents-probe"
mkdir -p "$PROBE"
cd "$PROBE"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund --offline "$TARBALL" >/dev/null
for FILE in \
  node_modules/relic-mcp/dist/relic-mcp.js \
  node_modules/relic-mcp/dist/native-secure-open.js \
  node_modules/relic-mcp/dist/native-secure-open.d.ts \
  node_modules/relic-mcp/native/secure-open.c \
  node_modules/relic-mcp/native/build.mjs \
  node_modules/relic-mcp/scripts/prove-packed-native.mjs \
  node_modules/relic-mcp/.claude-plugin/plugin.json \
  node_modules/relic-mcp/.claude-plugin/marketplace.json \
  node_modules/relic-mcp/mcp-servers.json \
  node_modules/relic-mcp/skills/relic/SKILL.md
do
  test -f "$FILE" || { echo "$FILE is missing from the tarball"; exit 1; }
done
for TARGET in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu; do
  test -f "node_modules/relic-mcp/prebuilds/$TARGET/secure_open.node"
  test -f "node_modules/relic-mcp/prebuilds/$TARGET/build-info.json"
done
node -e '
  const fs = require("node:fs");
  const root = "node_modules/relic-mcp";
  const want = process.env.RELEASE_VERSION;
  const pkg = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
  const plugin = JSON.parse(fs.readFileSync(`${root}/.claude-plugin/plugin.json`, "utf8"));
  const market = JSON.parse(fs.readFileSync(`${root}/.claude-plugin/marketplace.json`, "utf8"));
  const mcp = JSON.parse(fs.readFileSync(`${root}/mcp-servers.json`, "utf8"));
  const found = [plugin.version, market.plugins[0].version, market.metadata.version];
  if (pkg.version !== want || found.some((value) => value !== want)) {
    throw new Error(`packed plugin manifests disagree with ${want}: package=${pkg.version}, manifests=${found.join(", ")}`);
  }
  const server = mcp.relic;
  const args = server?.args;
  const expected = `${pkg.name}@${want}`;
  if (
    plugin.mcpServers !== "./mcp-servers.json" ||
    server?.type !== "stdio" ||
    server.command !== "npx" ||
    !Array.isArray(args) ||
    args.length !== 2 ||
    args[0] !== "-y" ||
    args[1] !== expected ||
    server.env?.RELIC_CLIENT_NAME !== `relic-plugin/${want}`
  ) {
    throw new Error(`packed MCP launch config does not pin ${expected}`);
  }
'
