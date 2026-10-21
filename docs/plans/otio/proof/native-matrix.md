# Native release matrix evidence

`.otiod` directory conversion ships through a Node-API 8 helper with ABI version 1. Ordinary file publishing stays on plain Node 18 or newer.

## Platform contract

- Darwin arm64 and x64 binaries use `15.0` as their Mach-O binary deployment floor.
- macOS directory conversion is feature-detected. The helper runs the strict confinement self-test on the running kernel before it reads a bundle. A failed or unavailable primitive refuses `.otiod` conversion.
- Linux arm64 and x64 binaries are built in the pinned manylinux 2.28 image for their native architecture. They require glibc 2.28 and the `openat2` confinement primitive.
- No directory path falls back to JavaScript checks, a runtime compiler, Python, or a downloaded helper.

The macOS binary floor permits the helper to load. It does not establish confinement support for every macOS 15 kernel.

## Required CI observations

All four native build jobs passed for commit `36c02f19eb3a29179b3f188d3eb289026fa075bf` in [dry run 39652819003](https://github.com/TheBushidoCollective/relik/actions/runs/39652819003). This includes each artifact audit and both Darwin SDK semantic probes. Verification failed at lint, so CI packing and the eight installed-runtime cells did not run. The complete release-matrix rows remain pending.

| Target | Native build and probe evidence | Packed runtime evidence | Status |
| --- | --- | --- | --- |
| `darwin-arm64` | Native arm64 runner, Xcode 26.0.1 selected, deployment target `15.0`, release semantic probe, and an Xcode 16.4 semantic probe in a separate private output directory. Record `sw_vers`, `uname -r`, `uname -m`, Xcode path and version, SDK path and version, compiler path and version, and numeric probe errno. | Installed tarball on the native macOS runner under Node `18.20.8` and Node `24.22.0`. Record the same OS, kernel, and architecture values for each cell. | Pending |
| `darwin-x64` | Native x64 runner, Xcode 26.0.1 selected, deployment target `15.0`, release semantic probe, and an Xcode 16.4 semantic probe in a separate private output directory. Record `sw_vers`, `uname -r`, `uname -m`, Xcode path and version, SDK path and version, compiler path and version, and numeric probe errno. | Installed tarball on the native macOS runner under Node `18.20.8` and Node `24.22.0`. Record the same OS, kernel, and architecture values for each cell. | Pending |
| `linux-arm64-gnu` | Native arm64 runner and `quay.io/pypa/manylinux_2_28_aarch64@sha256:0333f44c4eb759ec8f47b27bc9dc27b1c929932a267cf13ce0cff1a4b758cccb`. Record host `uname -r` and `uname -m`, container `uname -m`, `getconf GNU_LIBC_VERSION`, compiler identity, image digest, and the `readelf` audit. | Installed tarball in the same native manylinux 2.28 architecture container under Node `18.20.8` and Node `24.22.0`. The container mounts only the selected Node installation, proof script, and tarball. Record host kernel, container architecture, and glibc output. | Pending |
| `linux-x64-gnu` | Native x64 runner and `quay.io/pypa/manylinux_2_28_x86_64@sha256:b74a5b6f1705ecff17be8bd792589bef9b3b039766d12205720ecd2a9e919192`. Record host `uname -r` and `uname -m`, container `uname -m`, `getconf GNU_LIBC_VERSION`, compiler identity, image digest, and the `readelf` audit. | Installed tarball in the same native manylinux 2.28 architecture container under Node `18.20.8` and Node `24.22.0`. The container mounts only the selected Node installation, proof script, and tarball. Record host kernel, container architecture, and glibc output. | Pending |

The Linux container shares the runner's kernel. A recorded result therefore identifies the observed host kernel and proves the live feature probe on that kernel. It does not establish execution on another kernel release.

## Local installed-package observations

The unpublished `relic-mcp-0.3.0.tgz` candidate contains all four native artifacts from dry run 39652819003. Their source and binary metadata checks passed after JavaScript bundling and before packing. On Darwin arm64, the installed-package proof printed `packed native Node proof passed` under Node `18.20.8` and `24.15.0`. It installed offline with scripts disabled, exercised native held-descriptor and hostile-path checks, published a valid directory to a loopback-only service, and published an ordinary file with the selected native binary hidden.

The observed local runtime was macOS `27.0.1`, Darwin kernel `27.0.0` (`xnu-13432.1.9~1/RELEASE_ARM64_T6050`), arm64. The standalone production-platform confinement probe also passed with Apple clang `21.0.0` and macOS SDK `27.0`: controlled outside files were accessible without confinement; confined absolute and parent escapes returned errno `107`; root, leaf, intermediate and replaced-directory symlinks returned errno `62`; a held root descriptor preserved the original bytes after rename.

The local proof did not hide the source checkout and does not replace the isolated CI runtime matrix. No package was published and no live service received test traffic.

## Developer build

`bun run --cwd packages/relic-mcp build` compiles the local native target and then runs `build:bundle`. Linux invokes the pinned architecture-matched manylinux 2.28 container through Node. Docker and `readelf` are required for that developer path. Linux rejects `--cc` and `CC`; `CC` selects the compiler only for Darwin.

## Artifact integrity record

The release job records the commit, native source and recipe hashes, compiler identity, image digest, binary hashes, metadata hashes, and tarball hash. It snapshots all four `secure_open.node` files and all four `build-info.json` files after audited staging. The hashes must match after `build:bundle` and after extraction from the packed tarball.

`build` remains the developer command: it builds the local target and then bundles JavaScript. The release job stages audited prebuilds and runs `build:bundle` only. `prepack` checks staged metadata and does not compile native code.

## Required semantic results

Each Darwin release probe must read controlled in-root bytes, prove controlled outside access before confinement, then reject absolute and parent escapes, root, leaf, and intermediate symlinks, and a directory replacement race while preserving an original read through a held root descriptor. The release SDK accepts `EACCES` or SDK-declared `ENOTCAPABLE`; the Xcode 16.4 branch exercises the missing-`ENOTCAPABLE` header path. Each run records numeric errno and SDK/runtime identity.

Each installed proof runs with Node only. It clears compiler and helper environment variables, installs the tarball offline with scripts disabled through npm's JavaScript CLI, imports the installed loader, proves valid `.otiod` publishing to a loopback service, proves hostile paths fail before service traffic, and proves ordinary-file publishing when the native prebuild is unavailable.
