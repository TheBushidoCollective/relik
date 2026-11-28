#!/usr/bin/env python3
"""Exchange the runner's GitHub identity for a direct GCS credential."""

import json
import os
import re
import sys
import urllib.parse
import urllib.error
import urllib.request


PROVIDER = re.compile(r'projects/[0-9]+/locations/global/workloadIdentityPools/[A-Za-z0-9-]+/providers/[A-Za-z0-9-]+')
TOKEN = re.compile(r'[A-Za-z0-9._-]{1,16384}')
STS_URL = 'https://sts.googleapis.com/v1/token'
MAX_RESPONSE = 65536


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


def token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        raise ValueError('invalid token')
    return value


def json_response(opener, request):
    try:
        with opener.open(request, timeout=15) as response:
            body = response.read(MAX_RESPONSE + 1)
    except urllib.error.HTTPError as error:
        error.close()
        raise
    if len(body) > MAX_RESPONSE:
        raise ValueError('response too large')
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError('invalid response')
    return data


def main(opener=None):
    try:
        provider = os.environ['OMP_VAULT_WIF_PROVIDER']
        if not PROVIDER.fullmatch(provider):
            raise ValueError('invalid provider')
        oidc_url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']
        parsed = urllib.parse.urlsplit(oidc_url)
        if (parsed.scheme != 'https' or not parsed.hostname or not parsed.query
                or parsed.username is not None or parsed.password is not None or parsed.fragment):
            raise ValueError('invalid OIDC endpoint')
        request_token = token(os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'])
        runner_temp = os.environ['RUNNER_TEMP']
        if not os.path.isabs(runner_temp) or not os.path.isdir(runner_temp):
            raise ValueError('invalid runner temp')
        if opener is None:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        audience = 'https://iam.googleapis.com/' + provider
        request = urllib.request.Request(
            oidc_url + '&audience=' + urllib.parse.quote(audience, safe=''),
            headers={'Authorization': 'Bearer ' + request_token},
        )
        subject = token(json_response(opener, request)['value'])
        body = json.dumps({
            'grantType': 'urn:ietf:params:oauth:grant-type:token-exchange',
            'audience': '//iam.googleapis.com/' + provider,
            'scope': 'https://www.googleapis.com/auth/cloud-platform',
            'requestedTokenType': 'urn:ietf:params:oauth:token-type:access_token',
            'subjectTokenType': 'urn:ietf:params:oauth:token-type:jwt',
            'subjectToken': subject,
        }).encode('utf-8')
        request = urllib.request.Request(
            STS_URL, data=body, headers={'Content-Type': 'application/json'}, method='POST'
        )
        access_token = token(json_response(opener, request)['access_token'])
        path = os.path.join(runner_temp, 'autofix-curl.conf')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='ascii') as config:
                config.write('header = "Authorization: Bearer ' + access_token + '"\n')
        except Exception:
            os.unlink(path)
            raise
    except Exception:
        print('Vault authentication refused', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
