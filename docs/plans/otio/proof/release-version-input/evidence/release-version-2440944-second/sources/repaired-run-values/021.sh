set -euo pipefail
command -v docker
docker version --format '{{.Server.Version}}'
{
  echo "### Linux runtime: ${{ matrix.target }}, Node ${{ matrix.node }}"
  echo '```text'
  printf 'host_kernel=%s\nhost_arch=%s\nimage=%s\n' "$(uname -r)" "$(uname -m)" "$RUNTIME_IMAGE"
  docker run --rm \
    --platform "$CONTAINER_PLATFORM" \
    --network none \
    --cap-drop ALL \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777,size=512m \
    --entrypoint /bin/sh \
    --env EXPECTED_ARCH="$EXPECTED_ARCH" \
    "$RUNTIME_IMAGE" \
    -ec '
      actual_arch="$(uname -m)"
      actual_glibc="$(getconf GNU_LIBC_VERSION)"
      test "$actual_arch" = "$EXPECTED_ARCH"
      test "$actual_glibc" = "glibc 2.28"
      printf "container_kernel=%s\ncontainer_arch=%s\ncontainer_glibc=%s\n" "$(uname -r)" "$actual_arch" "$actual_glibc"
    '
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
