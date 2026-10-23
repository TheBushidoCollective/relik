set -euo pipefail
{
  printf '### relic-mcp %s\n' "$RELEASE_VERSION"
  npm pack --dry-run --json --no-workspaces | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const parsed = JSON.parse(raw);
      const meta = Array.isArray(parsed) ? parsed[0] : parsed;
      console.log(`files: ${meta.entryCount}, unpacked: ${meta.unpackedSize} bytes`);
    });
  '
} >> "$GITHUB_STEP_SUMMARY"
