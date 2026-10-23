set -euo pipefail
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.env.RELEASE_VERSION;
  delete pkg.devDependencies;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'
