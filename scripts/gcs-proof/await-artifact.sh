#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' 'GCS_PROOF_ERROR await-artifact: operation failed' >&2
  exit 1
}

# Bound both network operations and captured API responses by the deadline.
gh_before_deadline() {
  local remaining=$1
  shift
  node -e '
    const { spawnSync } = require("node:child_process");
    const [seconds, ...args] = process.argv.slice(1);
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: Number(seconds) * 1000,
      killSignal: "SIGKILL",
    });
    if (result.status !== 0) process.exit(1);
    process.stdout.write(result.stdout);
  ' "$remaining" "$@"
}

[[ $# == 5 ]] || fail
name=$1
file=$2
dest=$3
deadline_s=$4
max_bytes=$5
run=${GITHUB_RUN_ID:-}
attempt=${GITHUB_RUN_ATTEMPT:-}
repository=${GITHUB_REPOSITORY:-}

[[ "$run" =~ ^[1-9][0-9]{0,18}$ ]] || fail
[[ "$attempt" =~ ^[1-9][0-9]{0,2}$ ]] || fail
[[ "$repository" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$ ]] || fail
[[ "${repository#*/}" != . && "${repository#*/}" != .. ]] || fail
[[ "$name" =~ ^gcs-proof-handoff-(key|token)-[0-9]+-[0-9]+$ ]] || fail
[[ "$deadline_s" =~ ^[1-9][0-9]{0,4}$ ]] || fail
[[ "$max_bytes" =~ ^[1-9][0-9]{0,5}$ ]] || fail
(( deadline_s <= 7200 )) || fail

case "$name" in
  "gcs-proof-handoff-key-${run}-${attempt}")
    [[ "$file" == handoff-key.json ]] || fail
    (( max_bytes <= 1024 )) || fail
    ;;
  "gcs-proof-handoff-token-${run}-${attempt}")
    [[ "$file" == sealed.json ]] || fail
    (( max_bytes <= 16384 )) || fail
    ;;
  *) fail ;;
esac

[[ -n "$dest" && "$dest" != */ && ! -e "$dest" && ! -L "$dest" ]] || fail
if [[ "$dest" == */* ]]; then
  parent=${dest%/*}
  [[ -n "$parent" ]] || parent=/
else
  parent=.
fi
[[ -d "$parent" ]] || fail

# The temporary directory shares the destination filesystem so a hard link
# installs the validated file atomically without overwriting an existing path.
tmp=$(mktemp -d "${parent%/}/.gcs-proof-handoff.XXXXXXXXXX") || fail
trap 'rm -rf -- "$tmp"' EXIT
chmod 700 "$tmp" || fail

start=$(date +%s) || fail
[[ "$start" =~ ^[0-9]+$ ]] || fail
deadline=$((start + deadline_s))
while :; do
  now=$(date +%s) || fail
  [[ "$now" =~ ^[0-9]+$ ]] || fail
  (( now < deadline )) || fail
  remaining=$((deadline - now))
  # Paginate the run-specific API and count exact, unexpired names across pages.
  pages=$(gh_before_deadline "$remaining" api --paginate --slurp \
    "repos/${repository}/actions/runs/${run}/artifacts?name=${name}&per_page=100" \
    2>/dev/null) || fail
  count=$(printf '%s' "$pages" | jq -er --arg name "$name" '
    if type != "array" or any(.[]; (.artifacts | type) != "array") then
      error("invalid artifact response")
    else
      [.[].artifacts[] | select(.name == $name and .expired == false)] | length
    end
  ' 2>/dev/null) || fail
  [[ "$count" =~ ^[0-9]+$ ]] || fail
  (( count <= 1 )) || fail
  now=$(date +%s) || fail
  [[ "$now" =~ ^[0-9]+$ ]] || fail
  (( now < deadline )) || fail
  remaining=$((deadline - now))
  if (( count == 1 )); then
    break
  fi
  if (( remaining < 5 )); then
    sleep "$remaining" || fail
  else
    sleep 5 || fail
  fi
done

# Limit each file written by gh while extracting, in addition to checking the
# exact byte count after extraction. The allowance covers archive overhead.
(
  ulimit -f $(((max_bytes + 4096 + 1023) / 1024)) || exit 1
  gh_before_deadline "$remaining" run download "$run" --repo "$repository" \
    --name "$name" --dir "$tmp" >/dev/null 2>&1
) || fail

shopt -s nullglob dotglob
entries=("$tmp"/*)
(( ${#entries[@]} == 1 )) || fail
[[ "${entries[0]}" == "$tmp/$file" && -f "${entries[0]}" && ! -L "${entries[0]}" ]] || fail
size=$(wc -c < "${entries[0]}") || fail
[[ "$size" =~ ^[[:space:]]*[0-9]+[[:space:]]*$ ]] || fail
(( size <= max_bytes )) || fail
chmod 600 "${entries[0]}" || fail
ln -- "${entries[0]}" "$dest" || fail
