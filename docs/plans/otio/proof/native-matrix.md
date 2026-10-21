# Native release matrix evidence

`.otiod` directory conversion ships through a Node-API 8 helper with ABI version 1. Ordinary file publishing stays on plain Node 18 or newer.

## Platform contract

- Darwin arm64 and x64 binaries use `15.0` as their Mach-O binary deployment floor.
- Directory conversion is feature-detected on both platforms. Before the helper reads a bundle, the running kernel must show that beneath-root resolution refuses parent and absolute escapes from a held directory and accepts the no-symlink flag. Symlink refusal, held-descriptor behavior, and replacement behavior are verified by the CI probe on the listed versions. A failed or unavailable primitive refuses `.otiod` conversion.
- Linux arm64 and x64 binaries are built in the pinned manylinux 2.28 image for their native architecture. They require glibc 2.28 and the `openat2` confinement primitive.
- No directory path falls back to JavaScript checks, a runtime compiler, Python, or a downloaded helper.

The macOS binary floor permits the helper to load. It does not establish confinement support for every macOS 15 kernel.

## Recorded CI observations

All four native build jobs passed for commit
`36c02f19eb3a29179b3f188d3eb289026fa075bf` in
[dry run 39652819003](https://github.com/TheBushidoCollective/relik/actions/runs/39652819003).
This includes each artifact audit and both Darwin SDK semantic probes.
Verification stopped at lint, so packing and the eight installed-runtime cells
did not run. The final release-matrix rows remain pending.

| Target | Runner image and observed runtime | Toolchains and probe result | Packed runtime |
| --- | --- | --- | --- |
| `darwin-arm64` | `macos-15-arm64 20260907.0337.1`; macOS 15.7.9 (`24G830`), Darwin 24.6.0, `xnu-11417.140.69.711.44~1` | Xcode 26.0.1 and SDK 26.0, plus Xcode 16.4 and SDK 15.5. Parent and absolute escapes returned errno 13 (`EACCES`); root, leaf, intermediate, and replaced-descendant symlinks returned errno 62 (`ELOOP`); a held root descriptor kept the original bytes. | Pending under Node `18.20.8` and `24.22.0`. |
| `darwin-x64` | `macos-15 20260824.0482.1`; macOS 15.7.9 (`24G830`), Darwin 24.6.0, `xnu-11417.140.69.711.44~1` | Xcode 26.0.1 and SDK 26.0, plus Xcode 16.4 and SDK 15.5. Parent and absolute escapes returned errno 13 (`EACCES`); root, leaf, intermediate, and replaced-descendant symlinks returned errno 62 (`ELOOP`); a held root descriptor kept the original bytes. | Pending under Node `18.20.8` and `24.22.0`. |
| `linux-arm64-gnu` | Native arm64 runner and `quay.io/pypa/manylinux_2_28_aarch64@sha256:0333f44c4eb759ec8f47b27bc9dc27b1c929932a267cf13ce0cff1a4b758cccb` | Native build observed. Final artifact-audit identity is recorded by the release job. | Pending in the same native manylinux 2.28 container under Node `18.20.8` and `24.22.0`. |
| `linux-x64-gnu` | Native x64 runner and `quay.io/pypa/manylinux_2_28_x86_64@sha256:b74a5b6f1705ecff17be8bd792589bef9b3b039766d12205720ecd2a9e919192` | Native build observed. Final artifact-audit identity is recorded by the release job. | Pending in the same native manylinux 2.28 container under Node `18.20.8` and `24.22.0`. |

The Linux container shares the runner's kernel. A recorded result identifies the
observed host kernel and proves the live feature probe on that kernel. It does
not establish execution on another kernel release.

## Local installed-package observations

Before the native metadata repair, an unpublished `relic-mcp-0.3.0.tgz`
candidate contained all four native artifacts from dry run `39652819003`. Its
source and binary metadata checks passed after JavaScript bundling and before
packing. On Darwin arm64, the installed-package proof printed `packed native
Node proof passed` under Node `18.20.8` and `24.15.0`. It installed offline
with scripts disabled, exercised native held-descriptor and hostile-path checks,
published a valid directory to a loopback-only service, and published an
ordinary file with the selected native binary hidden. It does not cover the
rebuilt final release artifacts.

The current local runtime observed at integration commit `d2d3a6b` was macOS
`27.0.1` (`26A434`), Darwin kernel `27.0.0`
(`xnu-13432.1.9~1/RELEASE_ARM64_T6050`), arm64. `native:local` and
`--check --target darwin-arm64` passed; `--check --release` correctly rejected
the local metadata because its `buildKind` is `local`. The standalone
production-platform confinement probe ran with `--cc clang`, resolving Homebrew
clang `22.1.8`, and macOS SDK `27`: controlled outside files were accessible
without confinement; confined absolute and parent escapes returned errno `107`;
root, leaf, intermediate, and replaced-directory symlinks returned errno `62`;
a held root descriptor preserved the original bytes after rename. An earlier
historical local probe used Xcode clang `21.0.0` with SDK `27`.

At `d2d3a6b`, the Darwin `--check --metadata-only` proof rejected five
independent audit mutations: wrong dependency, architecture, deployment floor,
unexpected field, and missing dependencies. It then restored the original
ignored local prebuild metadata byte-for-byte and passed. This local negative
proof does not replace the isolated CI runtime matrix. No package was published
and no live service received test traffic.

## Developer build

`bun run --cwd packages/relic-mcp build` compiles the local native target and then runs `build:bundle`. Linux invokes the pinned architecture-matched manylinux 2.28 container through Node. Docker and `readelf` are required for that developer path. Linux rejects `--cc` and `CC`; `CC` selects the compiler only for Darwin.

## Artifact integrity record

The release job records the commit, native source and recipe hashes, compiler identity, image digest, binary hashes, metadata hashes, and tarball hash. It snapshots all four `secure_open.node` files and all four `build-info.json` files after audited staging. The hashes must match after `build:bundle` and after extraction from the packed tarball.

`build` remains the developer command: it builds the local target and then bundles JavaScript. The release job stages audited prebuilds and runs `build:bundle` only. `prepack` runs `--check --metadata-only --release` against staged metadata and does not compile native code.

## Required semantic results

Each Darwin release probe must read controlled in-root bytes, prove controlled outside access before confinement, then reject absolute and parent escapes, root, leaf, and intermediate symlinks, and a directory replacement race while preserving an original read through a held root descriptor. The release SDK accepts `EACCES` or SDK-declared `ENOTCAPABLE`; the Xcode 16.4 branch exercises the missing-`ENOTCAPABLE` header path. Each run records numeric errno and SDK/runtime identity.

Each installed proof runs with Node only. It clears compiler and helper environment variables, installs the tarball offline with scripts disabled through npm's JavaScript CLI, imports the installed loader, proves valid `.otiod` publishing to a loopback service, proves hostile paths fail before service traffic, and proves ordinary-file publishing when the native prebuild is unavailable.
