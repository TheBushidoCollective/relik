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
curl -fsS -D "$scratch/h" -o "$scratch/relic-shell" "$SERVICE/aaaaaaaaaaaaaaaaaaaaaaaaaa"
grep -qi '^referrer-policy: no-referrer' "$scratch/h"
viewer_url=$(grep -Eo '/assets/viewer\.js\?v=[a-zA-Z0-9_-]+' "$scratch/relic-shell" | head -n 1)
test -n "$viewer_url"
echo "shell viewer: $viewer_url"
curl -fsS -o "$scratch/sw" "$SERVICE/sw.js"
grep -Fq "$viewer_url" "$scratch/sw"

echo "every asset the shell names resolves"
for P in /assets/viewer.js /assets/landing-html.png /assets/landing-markdown.png /assets/landing-code-dark.png /assets/styles.css /assets/cue-view.css /assets/json-tree-view.css /assets/data-table.css /assets/notebook-view.css /assets/register-sw.js /manifest.webmanifest /sw.js /assets/icon.svg; do
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
echo "the shell does not carry the jsx compiler"
# Sucrase loads only when routing needs it, from its own chunk. This reads the
# shell already fetched above, so it adds no request.
if grep -q 'enableLegacyTypeScriptModuleInterop' "$scratch/shell"; then
  echo "the jsx compiler is inlined in the app shell"
  exit 1
fi

case "${PRESENCE_DEPLOYED:-false}" in
  false)
    echo "presence smoke skipped: presence service is not enabled"
    ;;
  true)
    echo "presence relay forwards a frame through the load balancer"
    python3 - "$SERVICE" <<'PY'
import base64
import hashlib
import json
import secrets
import socket
import ssl
import struct
import os
import sys
import time
from urllib.parse import urlsplit


def token(size):
    return base64.urlsafe_b64encode(secrets.token_bytes(size)).decode().rstrip("=")


class RouteNotReady(RuntimeError):
    pass


class WebSocket:
    def __init__(self, service, room):
        origin = urlsplit(service)
        if (
            origin.scheme not in ("http", "https")
            or not origin.hostname
            or origin.path not in ("", "/")
            or origin.query
            or origin.fragment
            or origin.username
            or origin.password
        ):
            raise ValueError("SERVICE must be an HTTP(S) origin")
        port = origin.port or (443 if origin.scheme == "https" else 80)
        self.sock = socket.create_connection((origin.hostname, port), timeout=15)
        if origin.scheme == "https":
            self.sock = ssl.create_default_context().wrap_socket(
                self.sock, server_hostname=origin.hostname
            )
        self.buffer = b""
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        request = (
            f"GET /api/presence/{room} HTTP/1.1\r\n"
            f"Host: {origin.netloc}\r\n"
            f"Origin: {origin.scheme}://{origin.netloc}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        while b"\r\n\r\n" not in self.buffer:
            if len(self.buffer) >= 16384:
                raise RuntimeError("WebSocket response headers are too large")
            self._read()
        head, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if len(lines[0].split()) < 2 or lines[0].split()[1] != "101":
            if lines[0].split()[1:2] == ["404"]:
                raise RouteNotReady(lines[0])
            raise RuntimeError(f"presence WebSocket upgrade rejected: {lines[0]}")
        headers = {}
        for line in lines[1:]:
            name, value = line.split(":", 1)
            headers[name.lower()] = value.strip()
        expected = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()
        ).decode()
        if (
            headers.get("sec-websocket-accept") != expected
            or headers.get("upgrade", "").lower() != "websocket"
            or "upgrade" not in {
                value.strip() for value in headers.get("connection", "").lower().split(",")
            }
        ):
            raise RuntimeError("invalid presence WebSocket upgrade response")

    def _read(self):
        data = self.sock.recv(4096)
        if not data:
            raise RuntimeError("presence WebSocket closed before the frame arrived")
        self.buffer += data

    def _take(self, length):
        while len(self.buffer) < length:
            self._read()
        data, self.buffer = self.buffer[:length], self.buffer[length:]
        return data

    def send(self, payload, opcode=1):
        payload = payload.encode("utf-8") if isinstance(payload, str) else payload
        length = len(payload)
        if length < 126:
            header = bytes([0x80 | opcode, 0x80 | length])
        else:
            header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack("!H", length)
        mask = secrets.token_bytes(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def receive(self):
        while True:
            first, second = self._take(2)
            if first & 0xF0 != 0x80 or second & 0x80:
                raise RuntimeError("invalid presence WebSocket frame")
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._take(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._take(8))[0]
            if length > 65536:
                raise RuntimeError("presence WebSocket frame is too large")
            payload = self._take(length)
            if opcode == 0x8:
                raise RuntimeError("presence WebSocket closed before forwarding")
            if opcode == 0x9:
                self.send(payload, opcode=0xA)
                continue
            if opcode == 0x1:
                return json.loads(payload)
            raise RuntimeError(f"unexpected presence WebSocket opcode {opcode}")

    def close(self):
        self.sock.close()


def check_once():
    sockets = []
    try:
        room = token(16)
        for _ in range(2):
            sockets.append(WebSocket(sys.argv[1], room))
        sender, receiver = sockets
        sender_hello = sender.receive()
        receiver_hello = receiver.receive()
        sender_id = sender_hello.get("hello", {}).get("self")
        if (
            sender_hello.get("v") != 1
            or receiver_hello.get("v") != 1
            or not sender_id
            or not receiver_hello.get("hello", {}).get("self")
        ):
            raise RuntimeError("presence sockets did not receive hello messages")
        ciphertext = token(540)
        sender.send(json.dumps({"v": 1, "c": ciphertext}, separators=(",", ":")))
        forwarded = receiver.receive()
        if forwarded != {"v": 1, "f": sender_id, "c": ciphertext}:
            raise RuntimeError("presence relay did not forward the frame unchanged")
    finally:
        for ws in sockets:
            ws.close()


# A global load balancer takes minutes to apply a URL map change, and until it
# does /api/presence/* falls through to the main service and answers 404. The
# first deploy that added the route failed on exactly that, 11 s after the map
# changed, while the route came up about three minutes later. Wait for that
# one signal only: a 403, a bad frame or a closed socket still fail at once,
# and a route that never appears still fails when the deadline passes.
deadline = time.monotonic() + float(os.environ.get("PRESENCE_ROUTE_WAIT_SECONDS", "600"))
while True:
    try:
        check_once()
        print("PRESENCE_RELAY_OK")
        break
    except RouteNotReady as error:
        if time.monotonic() >= deadline:
            print(f"PRESENCE_RELAY_FAILED: route still not live at the deadline: {error}", file=sys.stderr)
            sys.exit(1)
        print(f"presence route not live yet ({error}); retrying", flush=True)
        time.sleep(15)
    except Exception as error:
        print(f"PRESENCE_RELAY_FAILED: {error}", file=sys.stderr)
        sys.exit(1)
PY
    ;;
  *)
    echo "PRESENCE_DEPLOYED must be true or false" >&2
    exit 1
    ;;
esac
