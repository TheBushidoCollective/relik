#!/usr/bin/env bash
set -euo pipefail
scratch="$(mktemp -d "${TMPDIR:-/tmp}/relik-deploy-smoke.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
# The owned domain, through the load balancer. The run.app host is no
# longer reachable from here, which is the point.

# Every body is fetched to a file and then grepped, never piped into
# `grep -q`. Under `pipefail` that pipeline fails when the assertion
# SUCCEEDS: `grep -q` exits the moment it matches, curl loses the
# pipe and returns 23, and 23 becomes the pipeline's status. It is a
# race against response size, so it passed for months and then broke
# the first deploy where a page grew: `/policy` matched, curl was
# still writing, and the step failed with exit 23 on a service that
# was serving correctly. A gate that fails because the thing it
# checks is true is worse than no gate.
echo "health"
curl -fsS --retry 10 --retry-all-errors --retry-delay 3 \
  -o "$scratch/health" "$SERVICE/health"
cat "$scratch/health"
grep -q '"ok"' "$scratch/health"

echo "the shell serves and does not leak a referrer"
curl -fsS -D "$scratch/h" -o/dev/null "$SERVICE/aaaaaaaaaaaaaaaaaaaaaaaaaa"
grep -qi '^referrer-policy: no-referrer' "$scratch/h"

echo "every asset the shell names resolves"
for P in /assets/viewer.js /assets/landing-html.png /assets/landing-markdown.png /assets/landing-code-dark.png /assets/styles.css /assets/register-sw.js /manifest.webmanifest /sw.js /assets/icon.svg; do
  curl -fsS -o/dev/null "$SERVICE$P" || { echo "MISSING $P"; exit 1; }
done

echo "the homepage links the reader's relics and, like /install, carries no script"
curl -fsS -o "$scratch/root" "$SERVICE/"
grep -q 'href="/dashboard"' "$scratch/root"
if grep -q '<script' "$scratch/root"; then
  echo "/ carries a script tag"
  exit 1
fi
curl -fsS -o "$scratch/install" "$SERVICE/install"
if grep -q '<script' "$scratch/install"; then
  echo "/install carries a script tag"
  exit 1
fi

echo "the published disclosure is readable before anybody publishes"
curl -fsS -o "$scratch/policy" "$SERVICE/policy"
grep -q 'Your browser never sends the' "$scratch/policy"
grep -q 'A cover image, unencrypted' "$scratch/policy"
echo "a browser navigating to the policy gets the markdown player, not a relic"
curl -fsS -H 'accept: text/html' -o "$scratch/policy-page" "$SERVICE/policy"
grep -q 'data-view="document" data-document="/policy"' "$scratch/policy-page"
if grep -q 'data-relic-id' "$scratch/policy-page"; then
  echo "/policy page is carrying a relic id"
  exit 1
fi
echo "the abuse intake answers, because it is a go/no-go obligation"
curl -fsS -o "$scratch/abuse" "$SERVICE/abuse"
grep -q '<form method="post"' "$scratch/abuse"

echo "a never-issued id on cover fetch returns 404"
CODE=$(curl -sS -o/dev/null -w '%{http_code}' \
  "$SERVICE/aaaaaaaaaaaaaaaaaaaaaaaaaa/cover/0000000000000000000000000000000000000000000000000000000000000000.png")
test "$CODE" = 404

echo "the shell does not carry the pdf renderer"
# The lazy split is the reason a markdown reader does not download a
# 430 KB renderer, and it is a bundler choice rather than a
# guarantee, so it is checked against what is actually served rather
# than against what was built.
curl -fsS -o "$scratch/shell" "$SERVICE/assets/viewer.js"
# 475 KiB: the same ceiling as SHELL_CEILING_BYTES in
# packages/relic-viewer/test/shell-budget.test.ts. Change both together.
test "$(wc -c < "$scratch/shell")" -lt 486400
if grep -q 'GlobalWorkerOptions' "$scratch/shell"; then
  echo "the pdf renderer is inlined in the app shell"
  exit 1
fi
