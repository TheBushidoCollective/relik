#!/usr/bin/env bash
# Fetch only. No npm lifecycle scripts, install hooks, compilation, or execution.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/vendor-scratch"
curl --fail --silent --show-error --location \
  'https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.0.tgz' \
  --output "$ROOT/vendor-scratch/mediabunny-1.62.0.tgz"
printf '%s  %s\n' \
  '943c852c707e4bce6afe73d5dec43da894eb964dbf3713460c630368f7393d16' \
  "$ROOT/vendor-scratch/mediabunny-1.62.0.tgz" | shasum -a 256 -c -
tar -xzf "$ROOT/vendor-scratch/mediabunny-1.62.0.tgz" -C "$ROOT/vendor-scratch"
