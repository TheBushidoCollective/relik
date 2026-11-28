#!/usr/bin/env python3
"""CONNECT-only gateway for the pinned task model provider, with no request logs."""
import select
import socket
import socketserver
import sys

PROVIDER = 'daily-cloudcode-pa.googleapis.com'


def exact(stream, count):
    result = bytearray()
    while len(result) < count:
        chunk = stream.recv(count - len(result))
        if not chunk:
            raise ValueError('incomplete')
        result.extend(chunk)
    return bytes(result)


def valid_sni(record):
    try:
        if len(record) < 9 or record[0] != 22 or record[5] != 1:
            return False
        if int.from_bytes(record[3:5], 'big') != len(record) - 5:
            return False
        if int.from_bytes(record[6:9], 'big') != len(record) - 9:
            return False
        pos = 9 + 2 + 32
        session_len = record[pos]
        pos += 1 + session_len
        cipher_len = int.from_bytes(record[pos:pos + 2], 'big')
        pos += 2 + cipher_len
        methods_len = record[pos]
        pos += 1 + methods_len
        extensions_len = int.from_bytes(record[pos:pos + 2], 'big')
        pos += 2
        end = pos + extensions_len
        if end != len(record):
            return False
        found = []
        while pos < end:
            kind = int.from_bytes(record[pos:pos + 2], 'big')
            length = int.from_bytes(record[pos + 2:pos + 4], 'big')
            pos += 4
            extension = record[pos:pos + length]
            if len(extension) != length:
                return False
            pos += length
            if kind == 0:
                if len(extension) < 5 or int.from_bytes(extension[:2], 'big') != len(extension) - 2:
                    return False
                at = 2
                while at < len(extension):
                    name_kind = extension[at]
                    size = int.from_bytes(extension[at + 1:at + 3], 'big')
                    name = extension[at + 3:at + 3 + size]
                    if len(name) != size or name_kind != 0:
                        return False
                    found.append(name.decode('ascii').lower())
                    at += 3 + size
                if at != len(extension):
                    return False
        return pos == end and found == [PROVIDER]
    except (IndexError, UnicodeError, ValueError):
        return False


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        client.settimeout(20)
        upstream = None
        try:
            request = bytearray()
            while not request.endswith(b'\r\n\r\n'):
                request.extend(exact(client, 1))
                if len(request) > 8192:
                    return
            first = bytes(request).split(b'\r\n', 1)[0]
            if first not in (f'CONNECT {PROVIDER}:443 HTTP/1.1'.encode(), f'CONNECT {PROVIDER}:443 HTTP/1.0'.encode()):
                return
            client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            header = exact(client, 5)
            size = int.from_bytes(header[3:5], 'big')
            if size > 18_432:
                return
            hello = header + exact(client, size)
            if not valid_sni(hello):
                return
            upstream = socket.create_connection((PROVIDER, 443), timeout=20)
            upstream.settimeout(20)
            upstream.sendall(hello)
            while True:
                ready, _, _ = select.select([client, upstream], [], [], 60)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is client else client).sendall(data)
        except (OSError, ValueError):
            return
        finally:
            if upstream is not None:
                upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True
    def handle_error(self, request, client_address):
        pass


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(1)
    with Server((sys.argv[1], int(sys.argv[2])), Handler) as server:
        server.serve_forever()
