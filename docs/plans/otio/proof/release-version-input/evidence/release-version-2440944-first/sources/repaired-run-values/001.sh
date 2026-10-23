set -euo pipefail
{
  echo "### Native build: ${{ matrix.target }}"
  echo '```text'
  uname -a
  uname -r
  uname -m
  if [ "$(uname -s)" = Linux ]; then
    cat /etc/os-release
  else
    sw_vers
  fi
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
