import contextlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


sys.dont_write_bytecode = True

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / '.github/scripts/autofix-vault-token.py'
PROVIDER = 'projects/123456/locations/global/workloadIdentityPools/test-pool/providers/test-provider'
OIDC_URL = 'https://token.actions.example/oidc?api-version=2.0'
REQUEST_TOKEN = 'fixture-github-request-token'
SUBJECT_TOKEN = 'fixture.subject.token'
ACCESS_TOKEN = 'fixture-cloud-access-token'
FIXED_ERROR = 'Vault authentication refused\n'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        self.server.calls.append((self.command, self.path, self.headers, b''))
        if self.path.startswith('/leak'):
            self.respond(200, {'value': SUBJECT_TOKEN})
        elif self.server.mode == 'oidc-redirect':
            self.send_response(302)
            self.send_header('Location', self.server.local + '/leak')
            self.end_headers()
        elif self.server.mode == 'oidc-failure':
            self.respond(401, {'error': REQUEST_TOKEN})
        elif self.server.mode == 'oidc-malformed':
            self.respond(200, {'value': 'bad\nvalue'})
        elif self.server.mode == 'oidc-oversize':
            self.respond(200, {'value': 'x' * 65537})
        else:
            self.respond(200, {'value': SUBJECT_TOKEN})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.calls.append((self.command, self.path, self.headers, body))
        if self.server.mode == 'sts-redirect':
            self.send_response(307)
            self.send_header('Location', self.server.local + '/leak')
            self.end_headers()
        elif self.server.mode == 'sts-failure':
            self.respond(400, {'error': SUBJECT_TOKEN})
        elif self.server.mode == 'sts-malformed':
            self.respond(200, {'access_token': 'bad\nvalue'})
        elif self.server.mode == 'sts-oversize':
            self.respond(200, {'access_token': 'x' * 65537})
        else:
            self.respond(200, {'access_token': ACCESS_TOKEN})


class LocalOpener:
    def __init__(self, server, auth):
        self.server = server
        self.auth = auth
        self.original_urls = []
        self.opener = urllib.request.build_opener(auth.NoRedirect())

    def open(self, request, timeout):
        self.original_urls.append(request.full_url)
        parsed = urllib.parse.urlsplit(request.full_url)
        local = self.server.local + parsed.path
        if parsed.query:
            local += '?' + parsed.query
        forwarded = urllib.request.Request(
            local, data=request.data, headers=dict(request.header_items()), method=request.get_method()
        )
        return self.opener.open(forwarded, timeout=timeout)


class VaultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('autofix_vault_token', SCRIPT)
        cls.auth = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.auth)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.local = 'http://127.0.0.1:%d' % cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server.calls = []
        self.server.mode = 'success'
        self.opener = LocalOpener(self.server, self.auth)
        self.env = {
            'RUNNER_TEMP': self.temp.name,
            'OMP_VAULT_WIF_PROVIDER': PROVIDER,
            'ACTIONS_ID_TOKEN_REQUEST_URL': OIDC_URL,
            'ACTIONS_ID_TOKEN_REQUEST_TOKEN': REQUEST_TOKEN,
        }
        self.config = pathlib.Path(self.temp.name) / 'autofix-curl.conf'

    def run_auth(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.env, clear=True):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                result = self.auth.main(self.opener)
        self.assertTrue(out.getvalue() == '')
        self.assertTrue(err.getvalue() in ('', FIXED_ERROR))
        return result, err.getvalue()

    def test_success_uses_direct_federation_and_private_config(self):
        result, error = self.run_auth()
        self.assertTrue(result == 0 and error == '')
        self.assertTrue(len(self.server.calls) == 2)
        self.assertTrue(self.opener.original_urls[1] == 'https://sts.googleapis.com/v1/token')
        method, path, headers, _body = self.server.calls[0]
        self.assertTrue(method == 'GET')
        self.assertTrue(headers.get('Authorization') == 'Bearer ' + REQUEST_TOKEN)
        audience = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)['audience']
        self.assertTrue(audience == ['https://iam.googleapis.com/' + PROVIDER])
        method, path, headers, body = self.server.calls[1]
        self.assertTrue(method == 'POST' and path == '/v1/token')
        self.assertTrue(headers.get('Content-Type') == 'application/json')
        self.assertTrue(json.loads(body) == {
            'grantType': 'urn:ietf:params:oauth:grant-type:token-exchange',
            'audience': '//iam.googleapis.com/' + PROVIDER,
            'scope': 'https://www.googleapis.com/auth/cloud-platform',
            'requestedTokenType': 'urn:ietf:params:oauth:token-type:access_token',
            'subjectTokenType': 'urn:ietf:params:oauth:token-type:jwt',
            'subjectToken': SUBJECT_TOKEN,
        })
        self.assertTrue(stat.S_IMODE(self.config.stat().st_mode) == 0o600)
        self.assertTrue(self.config.read_text() == 'header = "Authorization: Bearer ' + ACCESS_TOKEN + '"\n')

    def test_http_and_malformed_failures_are_fixed_and_never_write_config(self):
        for mode in ('oidc-failure', 'oidc-malformed', 'oidc-oversize', 'sts-failure', 'sts-malformed', 'sts-oversize', 'oidc-redirect', 'sts-redirect'):
            with self.subTest(mode=mode):
                self.server.mode = mode
                self.server.calls = []
                result, error = self.run_auth()
                self.assertTrue(result == 1 and error == FIXED_ERROR)
                self.assertFalse(self.config.exists())
                self.assertFalse(any(call[1].startswith('/leak') for call in self.server.calls))

    def test_invalid_provider_or_github_inputs_fail_without_network(self):
        for key, value in (
            ('OMP_VAULT_WIF_PROVIDER', PROVIDER + '/extra'),
            ('OMP_VAULT_WIF_PROVIDER', PROVIDER + '\n'),
            ('OMP_VAULT_WIF_PROVIDER', '//iam.googleapis.com/' + PROVIDER),
            ('ACTIONS_ID_TOKEN_REQUEST_URL', 'http://token.actions.example/oidc?a=b'),
            ('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'bad\nheader'),
        ):
            with self.subTest(key=key):
                old = self.env[key]
                self.env[key] = value
                result, error = self.run_auth()
                self.assertTrue(result == 1 and error == FIXED_ERROR)
                self.assertFalse(self.server.calls)
                self.assertFalse(self.config.exists())
                self.env[key] = old

    def test_existing_config_is_not_overwritten(self):
        self.config.write_text('preserve')
        result, error = self.run_auth()
        self.assertTrue(result == 1 and error == FIXED_ERROR)
        self.assertTrue(self.config.read_text() == 'preserve')

    def test_existing_symlink_is_not_followed_or_removed(self):
        target = pathlib.Path(self.temp.name) / 'target'
        target.write_text('preserve')
        self.config.symlink_to(target)
        result, error = self.run_auth()
        self.assertTrue(result == 1 and error == FIXED_ERROR)
        self.assertTrue(self.config.is_symlink())
        self.assertTrue(target.read_text() == 'preserve')


if __name__ == '__main__':
    unittest.main()
