#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${GITHUB_REPOSITORY:?}"
[[ "$GITHUB_REPOSITORY" == 'TheBushidoCollective/relik' ]] || exit 1
[[ $# == 2 ]] || exit 1
bundle="$1"
local_source_db="$2"
staging="$GITHUB_WORKSPACE/.omp-agent-context"
[[ "$bundle" == "$RUNNER_TEMP/relik-context.tar.gz" && "$local_source_db" == "$RUNNER_TEMP/relik-agent.db" ]] || exit 1
[[ ! -e "$staging" && ! -L "$staging" ]] || exit 1
trap 'rm -rf -- "$staging"; rm -f -- "$bundle" "$local_source_db"' EXIT
python3 "$GITHUB_WORKSPACE/packages/relic-ops/bin/autofix-verify-bundle.py" \
  "$bundle" "$GITHUB_WORKSPACE/.github/omp-context.pin" \
  "$GITHUB_WORKSPACE/.github/omp-context-members.txt" "$staging"
clean_env=(env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN
  -u ACTIONS_RUNTIME_TOKEN -u OMP_VAULT_ACCESS_TOKEN -u GOOGLE_APPLICATION_CREDENTIALS
  -u CLOUDSDK_AUTH_ACCESS_TOKEN_FILE -u GITHUB_TOKEN -u GH_TOKEN
  -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_OAUTH_TOKEN)
"${clean_env[@]}" bash "$GITHUB_WORKSPACE/.omp-agent-context/bin/prepare-relik.sh" --agent-db "$local_source_db"
"${clean_env[@]}" python3 "$RUNNER_TEMP/omp-runtime/runtime.py" verify \
  --agent-dir "$RUNNER_TEMP/omp-agent" --runtime-dir "$RUNNER_TEMP/omp-runtime" --require-credential
