node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.argv[1];
  delete pkg.devDependencies;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "${{ inputs.version }}"
