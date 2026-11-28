import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const proxy = new URL('../bin/autofix-proxy.py', import.meta.url).pathname;
const python = `import importlib.util, socket, sys, threading, time\ns=importlib.util.spec_from_file_location('proxy',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p)\nassert 0 < p.MAX_CONNECTIONS <= 32\nassert 0 < p.MAX_CONNECTION_BYTES <= 64*1024*1024\nassert 0 < p.HANDSHAKE_TIMEOUT <= 30 and 0 < p.IDLE_TIMEOUT <= 60\nserver=p.Server(('127.0.0.1',0),p.Handler); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()\nclients=[]\ntry:\n for i in range(p.MAX_CONNECTIONS):\n  c=socket.create_connection(server.server_address,timeout=1); c.sendall(b'C'); clients.append(c)\n for _ in range(100):\n  if server.slots._value == 0: break\n  time.sleep(.01)\n assert server.slots._value == 0\n extra=socket.create_connection(server.server_address,timeout=1); extra.settimeout(2); extra.sendall(b'C')\n try: closed=extra.recv(1)==b''\n except ConnectionResetError: closed=True\n assert closed\n extra.close()\nfinally:\n for c in clients: c.close()\n server.shutdown(); server.server_close(); thread.join()\n`;
test('host proxy bounds admission, byte budgets and deadlines', () => {
  const result = spawnSync('python3', ['-c', python, proxy], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
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
try: p.exact(Sock(b'x'),1,p.time.monotonic()-1)
except TimeoutError: pass
else: raise AssertionError('expired handshake accepted')
`;
  const result = spawnSync('python3', ['-c', script, proxy], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
});
