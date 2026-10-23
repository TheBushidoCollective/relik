# Release Version Input Behavior Proof

## Purpose

Offline behavior proof of the release-version input repair for the MCP publish workflow (`.github/workflows/publish-mcp.yml`).

This harness sits outside the permanent test suite and provides reproducible offline verification that release version dispatch inputs are:
1. Validated strictly against full SemVer 2.0.0 syntax before any dependency installation or package metadata mutation.
2. Transported purely through environment variables (`RELEASE_VERSION`), eliminating shell interpolation and command injection risks.
3. Preserved byte-for-byte without normalization, trimming, coercion, or arbitrary length limits.

## Source Blobs and Workflows

The harness compares scripts extracted directly from the actual `run` steps of the base and repaired GitHub Actions workflows:

- **Base workflow**: git blob `7755ee6a3ceab236d304fd87f91ea8684984779d` from base commit `6a83c011fe9ef4b40204a1ca0ed46744103fba49` (`.github/workflows/publish-mcp.yml`). Exported to `local://otio-release-version-base-workflow.yml`.
- **Repaired workflow**: git blob `64d5af2a43ef05d538df4ef8be0fbd84b27c3c34` from repair commit `2440944cc4db7d5912de0bb6fb5f1e14aebe5697` (`.github/workflows/publish-mcp.yml`). Exported to `local://otio-release-version-repaired-workflow.yml`.

Note: The historical temporary branch/worktree `publish-mcp-version-input` is retired; the committed and exported workflow blobs above are authoritative.

## Invocation

Run from the repository root using the project's toolchain (Node 24.15.0 via `mise` and Bun):

```bash
BASE_GIT_SHA=6a83c011fe9ef4b40204a1ca0ed46744103fba49 \
REPAIRED_GIT_SHA=2440944cc4db7d5912de0bb6fb5f1e14aebe5697 \
mise exec node@24.15.0 -- bun docs/plans/otio/proof/release-version-input/runner.mjs \
  <path-to-base-workflow.yml> \
  <path-to-repaired-workflow.yml> \
  <path-to-new-exclusive-evidence-dir>
```

Constraints:
- The target evidence directory must not exist prior to invocation; its parent directory must exist.
- Do not execute the runner or run payloads during preparation; the parent agent runs the verification suite in a dedicated run worktree.

## The 28 Planned Test Cases

The proof exercises 28 structured test cases:

### Valid SemVer Acceptance (8 cases)
- `valid-0-13-0`: Standard target release version `0.13.0`.
- `valid-0-0-0`: Triple-zero SemVer `0.0.0`.
- `valid-1-2-3-rc-1`: Standard prerelease version `1.2.3-rc.1`.
- `valid-1-2-3-alpha-01a-001-build-7`: Complex prerelease and build identifier `1.2.3-alpha.01a+001.build-7`.
- `valid-1-2-3-001`: SemVer with build metadata `1.2.3+001`.
- `valid-1-2-3`: SemVer with dash prerelease `1.2.3--`.
- `validator-huge-core`: Valid SemVer with numeric core components exceeding JavaScript safe integers (e.g. `9007199254740992.0.0`), preventing truncation or numerical coercion.
- `validator-long-version`: Valid SemVer with identifiers exceeding 256 characters, proving no arbitrary length ceilings are enforced.

### Syntactic and Semantic Rejections (14 cases)
- `reject-missing`: Missing or undefined version input.
- `reject-empty`: Empty string version input.
- `reject-prefixed-v`: Prefixed version string `v1.2.3`.
- `reject-leading-zero`: Leading zeros in major version `01.2.3`.
- `reject-prerelease-leading-zero`: Leading zero in numeric prerelease identifier `1.2.3-01`.
- `reject-dangling-prerelease`: Trailing dash with missing prerelease identifier `1.2.3-`.
- `reject-dangling-build`: Trailing plus with missing build metadata `1.2.3+`.
- `reject-empty-prerelease-identifier`: Empty dot-separated prerelease segment `1.2.3-a..b`.
- `reject-empty-build-identifier`: Empty dot-separated build metadata segment `1.2.3+a..b`.
- `reject-leading-whitespace`: Leading whitespace ` 1.2.3`.
- `reject-trailing-whitespace`: Trailing whitespace `1.2.3 `.
- `reject-trailing-lf`: Version with trailing newline `1.2.3\n`.
- `reject-trailing-crlf`: Version with trailing carriage return and newline `1.2.3\r\n`.
- `reject-trailing-line-separator`: Version with trailing Unicode line separator `1.2.3\u2028`.

### Exploit Control and Payload Bypasses (6 cases)
- `old-github-substitution-injection`: Demonstrates unsafe command substitution execution in base workflow when expanding `0.13.0$(printf exploited > "$INJECTION_SENTINEL")`.
- `repaired-validator-rejects-injection`: Confirms the repaired validator immediately rejects the payload string as invalid SemVer without triggering command execution.
- `payload-bypass-set-release-version`: Simulates bypassing the validator and executing the repaired `Set release version` script with `RELEASE_VERSION` set to the injection payload; verifies no command substitution occurs.
- `payload-bypass-generated-manifest-check`: Executes the repaired generated manifest check step with payload environment; verifies safe data handling and no sentinel creation.
- `payload-bypass-packed-content-check`: Executes the repaired packed content check step with payload environment; verifies safe data handling and no sentinel creation.
- `payload-bypass-summary`: Executes the repaired summary step with payload environment; verifies formatted string output without code execution.

## Subprocess Isolation

Every test case runs inside an isolated subprocess environment:
- Isolated temporary directories for `HOME`, `TMPDIR`, and `RUNNER_TEMP`.
- Isolated GitHub Actions simulation files for `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT`.
- Isolated npm cache, user config, global config, and global prefix (`npm_config_cache`; `npm_config_userconfig` set to `runtime/npmrc`; `npm_config_globalconfig` set to a separate, empty `runtime/global-npmrc`; `npm_config_prefix`). The two config paths must differ: npm exits before resolving configuration when one file is loaded as both user and global config.
- Offline npm execution pointing to a dummy loopback registry `http://127.0.0.1:9/` with `--offline` enforcement.
- Per-case sentinel file path `INJECTION_SENTINEL` established inside the case temporary directory to record any command execution attempts.
- Native build artifacts/placeholders are verified or packaged as data without executing untrusted native code.

## Output Structure and Acceptance

When executed, the runner populates the evidence directory with:
- `packet-manifest.json`: Paths, SHA-256 hashes, and byte counts of the two input workflows; SHA-256 hashes of every extracted `run` script; the supplied git SHAs; the planned case IDs; and the isolation policy.
- `sources/`: Materialized workflow sources and extracted step scripts.
- `provenance/toolchain/`: Raw stdout and stderr of `node --version`, `npm --version`, and `bash --version`, each run in an isolated runtime built the same way as a case's; `receipt.json` `toolchain` also records the Bun version and path. All three commands must exit 0 before any case runs; otherwise `toolchain.failures` and `globalFailures` name the failing command, no case runs, and the runner exits 1.
- `cases/<id>/`: Per-case artifacts, including step exit codes, raw stdout/stderr logs, executed scripts, and sentinel status.
- `receipt.json`: Root receipt summarizing case verdicts, input SHAs, and missing cases.

Parent acceptance criteria:
- Runner exits with status 0.
- `receipt.json` reports `"success": true` and `"missingCases": []`.
- Zero occurrences of `${{ inputs.version }}` inside any `run` block in the repaired workflow.
- All injection test cases report `sentinelCreated: false` in the repaired workflow.
