set -euo pipefail
test "$(uname -m)" = "${{ matrix.architecture }}"
{
  echo "### Packed proof: ${{ matrix.target }}, Node ${{ matrix.node }}"
  echo '```text'
  node --version
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
