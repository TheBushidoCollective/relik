#!/usr/bin/env bash
set -euo pipefail
scratch="$(mktemp -d "${TMPDIR:-/tmp}/relik-origin-smoke.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT

# The retired host must actually be retired. A reachable second
# origin is a name somebody can be handed that will not render, and
# nothing else in this pipeline would notice it came back.
echo "the run.app host no longer answers the internet"
CODE="$(curl -sS -o/dev/null -m 20 -w '%{http_code}' "$RUN_HOST/health" || echo 000)"
case "$CODE" in
  200)
    echo "$RUN_HOST still serves; ingress is not restricted"
    exit 1
    ;;
  *)
    echo "  refused with $CODE"
    ;;
esac

echo "the usercontent origin serves its page"
curl -fsS --retry 10 --retry-all-errors --retry-delay 3 \
  -D "$scratch/sh" -o/dev/null "$USERCONTENT/sandbox.html"

echo "and names the service origin as the only page allowed to frame it"
grep -qi "^content-security-policy:.*frame-ancestors $ORIGIN\(;\|\$\)" "$scratch/sh" || {
  echo "usercontent frame-ancestors does not name $ORIGIN:"
  grep -i '^content-security-policy:' "$scratch/sh"
  exit 1
}

echo "and the service allows exactly that usercontent origin as a frame source"
curl -fsS -D "$scratch/vh" -o/dev/null "$SERVICE/aaaaaaaaaaaaaaaaaaaaaaaaaa"
grep -qi "^content-security-policy:.*frame-src $USERCONTENT\(;\|\$\)" "$scratch/vh" || {
  echo "service frame-src does not name $USERCONTENT:"
  grep -i '^content-security-policy:' "$scratch/vh"
  exit 1
}

echo "and the two are different registrable domains, or there is no boundary"
test "$(echo "$ORIGIN" | sed 's#https\?://##')" != "$(echo "$USERCONTENT" | sed 's#https\?://##')"

echo "and the usercontent origin does not sit under the service domain"
case "$(echo "$USERCONTENT" | sed 's#https\?://##')" in
  *".$(echo "$ORIGIN" | sed 's#https\?://##')")
    echo "usercontent shares the service registrable domain; the boundary is gone"
    exit 1
    ;;
esac

# The frame has no allow-same-origin, so its document is an opaque
# origin and every request it makes is cross-origin with Origin:
# null. A linked module script is fetched with CORS and silently
# refused, which renders as a blank frame and an empty console. The
# script has to be inline, and this is the only place that can tell.
echo "and the usercontent page carries its script inline, fetching nothing"
curl -fsS "$USERCONTENT/sandbox.html" -o "$scratch/sandbox.html"

if ! grep -q 'relic:sandbox-ready' "$scratch/sandbox.html"; then
  echo "sandbox.html does not carry its handler inline; the frame will never render"
  exit 1
fi

if grep -qE '<script[^>]+src=' "$scratch/sandbox.html"; then
  echo "sandbox.html links a script; an opaque-origin document cannot fetch it"
  exit 1
fi
