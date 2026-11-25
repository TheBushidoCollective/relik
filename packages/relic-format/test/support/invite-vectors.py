import base64
import hashlib
import json

public_key = bytes.fromhex('04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0')
identity = '61acd9e678454d81e039ee5b4ea6900d69cb3a47f8e25d5c53a5634462b7b787'
relic = '7k2m9qxah3tb0p4dvw8cr1nezf'
samples = {
    'invite': dict(at=1767225600004, expires_at=1767312000004, invite_public_key=base64.urlsafe_b64encode(public_key).decode().rstrip('='), invited_email='ada@example.com', owner_identity_id=identity, relic_id=relic, versions=[1, 2, 5]),
    'invite_claim': dict(at=1767225600005, claimant_identity_id=identity, invite_id=hashlib.sha256(public_key).hexdigest(), relic_id=relic, versions=[1, 2, 5]),
}
for kind, statement in samples.items():
    encoded = ('relic-statement/v1\n' + kind + '\n' + json.dumps(statement, sort_keys=True, separators=(',', ':'))).encode()
    print(kind, encoded.hex(), hashlib.sha256(encoded).hexdigest())
