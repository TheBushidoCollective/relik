import base64
import hashlib
import hmac
import json

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def hkdf(ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=b'', info=info).derive(ikm)


RELIC = '7k2m9qxah3tb0p4dvw8cr1nezf'
VERSION = 3
content_key = bytes(range(1, 17))
signing_key = hkdf(content_key, b'relic/signing/v1', 32)
mac_key = hkdf(signing_key, b'relic/signing/content-mac/v1', 32)
content = b'Studio lease, Unit 4B. The tenant pays on the first.'
content_mac = hmac.new(mac_key, content, hashlib.sha256).hexdigest()
appearance_key = hkdf(signing_key, b'relic/signing/appearance/v1', 16)


def aad(kind: bytes) -> bytes:
    return kind + b'\x00' + RELIC.encode() + VERSION.to_bytes(4, 'big')


def canon(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


layout = {'v': 1, 'boxes': [{'signer': 0, 'page': 2, 'rect': {'x': 0.1, 'y': 0.2, 'w': 0.5, 'h': 0.25}}]}
mark = {'v': 1, 'name': 'Ana Ruiz', 'strokes': None}
layout_nonce = bytes(range(0x30, 0x3C))
mark_nonce = bytes(range(0x40, 0x4C))
layout_ct = AESGCM(appearance_key).encrypt(layout_nonce, canon(layout), aad(b'layout'))
mark_ct = AESGCM(appearance_key).encrypt(mark_nonce, canon(mark), aad(b'mark'))

print('content_key', content_key.hex())
print('signing_key', signing_key.hex())
print('mac_key', mac_key.hex())
print('content', content.decode())
print('content_mac', content_mac)
print('appearance_key', appearance_key.hex())
print('layout_plain', canon(layout).decode())
print('layout_sealed', b64u(layout_nonce + layout_ct))
print('mark_plain', canon(mark).decode())
print('mark_sealed', b64u(mark_nonce + mark_ct))
