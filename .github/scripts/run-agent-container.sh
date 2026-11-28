#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${GITHUB_REPOSITORY:?}"
[[ "$GITHUB_REPOSITORY" == 'TheBushidoCollective/relik' && $# == 4 ]] || exit 1
work="$1"
prompt="$2"
omp="$3"
bun="$4"
agent="$RUNNER_TEMP/omp-agent"
[[ "$work" == "$RUNNER_TEMP/autofix-work" && "$prompt" == "$RUNNER_TEMP/autofix-prompt" ]] || exit 1
[[ "$omp" == "$RUNNER_TEMP/omp-18.12.6/omp" && -x "$omp" && -x "$bun" ]] || exit 1
[[ -d "$work/.git" && -d "$agent" && -f "$prompt" ]] || exit 1
[[ ! -L "$work" && ! -L "$agent" && ! -L "$prompt" ]] || exit 1

network="relik-autofix-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
chain="RLK$$"
container="$network"
proxy_pid=''
subnet=''
cleanup() {
  set +e
  docker kill "$container" >/dev/null 2>&1
  if [[ -n "$subnet" ]]; then
    sudo iptables -D INPUT -s "$subnet" -j "$chain" >/dev/null 2>&1
    sudo iptables -F "$chain" >/dev/null 2>&1
    sudo iptables -X "$chain" >/dev/null 2>&1
  fi
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" >/dev/null 2>&1; wait "$proxy_pid" 2>/dev/null; fi
  docker network rm "$network" >/dev/null 2>&1
}
trap cleanup EXIT

docker network create --internal "$network" >/dev/null
network_info="$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}} {{(index .IPAM.Config 0).Subnet}}' "$network")"
read -r gateway subnet <<< "$network_info"
python3 - "$gateway" "$subnet" <<'PY'
import ipaddress, sys
ip, network = ipaddress.ip_address(sys.argv[1]), ipaddress.ip_network(sys.argv[2])
if ip.version != 4 or ip not in network:
    raise SystemExit(1)
PY
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
sudo iptables -N "$chain"
sudo iptables -A "$chain" -d "$gateway" -p tcp --dport "$port" -j ACCEPT
sudo iptables -A "$chain" -j DROP
sudo iptables -I INPUT 1 -s "$subnet" -j "$chain"
env -i PATH="$PATH" python3 "$GITHUB_WORKSPACE/packages/relic-ops/bin/autofix-proxy.py" "$gateway" "$port" >/dev/null 2>&1 &
proxy_pid=$!
python3 - "$gateway" "$port" <<'PY'
import socket, sys, time
for _ in range(50):
    try:
        with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=.1):
            break
    except OSError:
        time.sleep(.1)
else:
    raise SystemExit(1)
PY

# The inner script expands variables only inside the container.
# shellcheck disable=SC2016
if ! timeout --kill-after=5s 45m docker run --rm --name "$container" \
  --log-driver=none --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 3g --cpus 2 \
  --ulimit fsize=1048576:1048576 --network "$network" \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /home/agent:rw,nosuid,nodev,size=128m \
  --mount "type=bind,src=$work,dst=/workspace" \
  --mount "type=bind,src=$agent,dst=$agent,readonly" \
  --mount "type=bind,src=$prompt,dst=/prompt,readonly" \
  --mount "type=bind,src=$omp,dst=/usr/local/bin/omp,readonly" \
  --mount "type=bind,src=$bun,dst=/usr/local/bin/bun,readonly" \
  --workdir /workspace \
  --env HOME=/home/agent --env LANG=C.UTF-8 --env GITHUB_REPOSITORY=TheBushidoCollective/relik \
  --env "PI_CODING_AGENT_DIR=$agent" --env OMP_SKIP_SETUP=1 --env PI_NO_TITLE=1 \
  --env "HTTPS_PROXY=http://$gateway:$port" --env "HTTP_PROXY=http://$gateway:$port" \
  --env "https_proxy=http://$gateway:$port" --env "http_proxy=http://$gateway:$port" \
  relik-autofix-sandbox /bin/bash -c '
    set -euo pipefail
    [[ $$ == 1 && "$(id -u)" != 0 && ! -S /var/run/docker.sock ]]
    ! command -v sudo >/dev/null 2>&1
    ! env | cut -d= -f1 | grep -Eq "^(ACTIONS_|GITHUB_TOKEN$|GH_TOKEN$|OMP_VAULT_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUDSDK_AUTH_ACCESS_TOKEN_FILE$)"
    set +e
    timeout --kill-after=5s 45m omp -p --auto-approve --no-title --no-session --max-time 45m \
      --config "$PI_CODING_AGENT_DIR/config.yml" --model @task < /prompt > /tmp/agent-output 2>&1
    code=$?
    rm -f /tmp/agent-output
    exit "$code"
  ' >/dev/null 2>&1; then
  echo 'Autofix sandbox failed' >&2
  exit 1
fi
