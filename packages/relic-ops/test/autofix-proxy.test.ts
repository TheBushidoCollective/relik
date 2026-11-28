import { expect, test } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const proxy = fileURLToPath(
  new URL('../bin/autofix-proxy.py', import.meta.url)
);
const python = `
import importlib.util
import queue
import socket
import sys
import threading

spec = importlib.util.spec_from_file_location('proxy', sys.argv[1])
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

assert 0 < proxy.MAX_CONNECTIONS <= 32
assert 0 < proxy.MAX_CONNECTION_BYTES <= 64 * 1024 * 1024
assert 0 < proxy.HANDSHAKE_TIMEOUT <= 30
assert 0 < proxy.IDLE_TIMEOUT <= 60

started = queue.Queue()
processed = queue.Queue()
finished = queue.Queue()
release = threading.Event()

original_exact = proxy.exact
def observed_exact(stream, count, deadline):
    started.put(None)
    release.wait()
    return original_exact(stream, count, deadline)
proxy.exact = observed_exact

class ObservedServer(proxy.Server):
    def process_request(self, request, address):
        requests.append(request)
        super().process_request(request, address)
        processed.put(request.fileno() != -1)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            finished.put(None)

if len(sys.argv) > 2 and sys.argv[2] == '--accept-overflow':
    original = proxy.Server.process_request
    def accept_overflow(self, request, address):
        if self.slots._value == 0:
            return
        original(self, request, address)
    proxy.Server.process_request = accept_overflow
elif len(sys.argv) > 2 and sys.argv[2] == '--lose-release':
    import socketserver
    proxy.Server.process_request_thread = socketserver.ThreadingTCPServer.process_request_thread

server = ObservedServer(('127.0.0.1', 0), proxy.Handler)
assert server.server_address[0] == '127.0.0.1'
assert server.server_address[1] != 0
peers = []
requests = []

def connect():
    worker = threading.Thread(target=server.handle_request)
    worker.start()
    peer = socket.create_connection(server.server_address)
    peers.append(peer)
    accepted = processed.get()
    worker.join()
    return peer, accepted

try:
    for _ in range(proxy.MAX_CONNECTIONS):
        peer, accepted = connect()
        assert accepted, 'available slot was not admitted'
        started.get()

    peer, accepted = connect()
    assert not accepted, 'overflow connection was not rejected'
    assert peer.recv(1) == b'', 'rejected peer did not receive EOF'
    for client in peers:
        client.close()

    release.set()
    for _ in range(proxy.MAX_CONNECTIONS):
        finished.get()
    release.clear()

    peer, accepted = connect()
    assert accepted, 'released slot was not reusable'
    started.get()
    peer.close()
    release.set()
    finished.get()
finally:
    release.set()
    for sock in peers + requests:
        sock.close()
    server.server_close()
`;

function diagnostic(result: SpawnSyncReturns<string>): string {
  return `Python status: ${result.status}; signal: ${result.signal}; error: ${result.error?.message ?? 'none'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}
test('host proxy bounds admission, byte budgets and deadlines', () => {
  const result = spawnSync('python3', ['-c', python, proxy], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 10_000,
  });
  expect(result.status, diagnostic(result)).toBe(0);
});

test('failed subprocess assertions retain both Python output streams', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      "import sys; print('stdout-fixture'); print('stderr-fixture', file=sys.stderr); sys.exit(1)",
    ],
    { encoding: 'utf8' }
  );
  let message = '';
  try {
    expect(result.status, diagnostic(result)).toBe(0);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain('stdout-fixture');
  expect(message).toContain('stderr-fixture');
});

test('admission probe rejects broken saturation and release behavior', () => {
  for (const [mutation, message] of [
    ['--accept-overflow', 'overflow connection was not rejected'],
    ['--lose-release', 'released slot was not reusable'],
  ] as const) {
    const result = spawnSync('python3', ['-c', python, proxy, mutation], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 10_000,
    });
    expect(result.status, diagnostic(result)).not.toBe(0);
    expect(result.stderr, diagnostic(result)).toContain(message);
  }
});

test('proxy stops over-budget streams and enforces handshake and idle deadlines', () => {
  const script = `
import importlib.util,sys
s=importlib.util.spec_from_file_location('proxy',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p)
class Sock:
 def __init__(self,data=b''): self.data=data; self.sent=[]; self.timeouts=[]
 def recv(self,n): out,self.data=self.data[:n],self.data[n:]; return out
 def sendall(self,b): self.sent.append(b)
 def settimeout(self,n): self.timeouts.append(n)
 def close(self): pass
request=('CONNECT '+p.PROVIDER+':443 HTTP/1.1\\r\\n\\r\\n').encode()
hello=bytes([22,3,3,0,1,0])
client=Sock(request+hello+b'1234567890'); upstream=Sock()
p.valid_sni=lambda _:True
p.socket.create_connection=lambda *_args,**_kwargs:upstream
p.MAX_CONNECTION_BYTES=len(request)+len(hello)+5
p.select.select=lambda *_args:([client],[],[])
handler=object.__new__(p.Handler); handler.request=client; handler.handle()
assert upstream.sent==[hello]
client=Sock(request+hello); upstream=Sock(); delays=[]
p.socket.create_connection=lambda *_args,**_kwargs:upstream
p.select.select=lambda _r,_w,_e,delay:(delays.append(delay) or [],[],[])
handler=object.__new__(p.Handler); handler.request=client; handler.handle()
assert delays==[p.IDLE_TIMEOUT]
clock=[100.0]
p.time.monotonic=lambda:clock[0]
fast=Sock(b'ok')
assert p.exact(fast,2,101.0)==b'ok' and fast.timeouts==[1.0]
class SlowSock(Sock):
 def recv(self,n):
  clock[0]+=0.6
  return super().recv(1)
try: p.exact(SlowSock(b'abc'),3,101.0)
except TimeoutError: pass
else: raise AssertionError('absolute handshake deadline was not enforced')
`;
  const result = spawnSync('python3', ['-c', script, proxy], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 10_000,
  });
  expect(result.status, diagnostic(result)).toBe(0);
});
