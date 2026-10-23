set -euo pipefail
for FILE in .claude-plugin/plugin.json .claude-plugin/marketplace.json mcp-servers.json; do
  test -f "$FILE" || { echo "$FILE was not generated"; exit 1; }
done
node -e '
  const fs = require("node:fs");
  const want = process.env.RELEASE_VERSION;
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8"));
  const market = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"));
  const mcp = JSON.parse(fs.readFileSync("mcp-servers.json", "utf8"));
  const found = [plugin.version, market.plugins[0].version, market.metadata.version];
  if (pkg.version !== want || found.some((value) => value !== want)) {
    throw new Error(`plugin manifests disagree with ${want}: package=${pkg.version}, manifests=${found.join(", ")}`);
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
    throw new Error(`generated MCP launch config does not pin ${expected}`);
  }
'
