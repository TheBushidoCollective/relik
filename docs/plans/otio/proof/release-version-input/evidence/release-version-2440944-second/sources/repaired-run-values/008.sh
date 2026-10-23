set -euo pipefail
# https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
# match[0] === version rejects trailing line terminators.
node <<'NODE'
  const version = process.env.RELEASE_VERSION;
  const syntax = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
  const match = typeof version === "string" ? syntax.exec(version) : null;
  if (!match || match[0] !== version) {
    throw new Error("RELEASE_VERSION must be an exact SemVer 2.0.0 version");
  }
NODE
