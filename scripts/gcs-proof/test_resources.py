import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import types
import unittest
import urllib.parse
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("gcs_proof_resources", pathlib.Path(__file__).with_name("resources.py"))
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)

PROJECT = "relic-example"
PROJECT_NUMBER = "123456"
RUN = "12345"
ATTEMPT = "2"
REPO = "987654"
UID = "112233445566778899001"
CANDIDATE = "a" * 40
START = 1700000000
EXPIRES = START + r.LEASE_SECONDS
NAMES = r.names(PROJECT, RUN, ATTEMPT)
TOKEN = "ya29." + "x" * 32


def encoded(value):
    return json.dumps(value).encode()


def bucket(candidate=CANDIDATE, expires=EXPIRES, uid=UID):
    return {"name": NAMES["bucket"], "projectNumber": PROJECT_NUMBER,
            "labels": r.labels(RUN, ATTEMPT, candidate, expires, uid)}


def account(repo=REPO, candidate=CANDIDATE, expires=EXPIRES, uid=UID, disabled=False):
    return {"name": f"projects/{PROJECT}/serviceAccounts/{NAMES['account']}", "email": NAMES["account"],
            "projectId": PROJECT, "uniqueId": uid, "displayName": f"relic gcs proof {RUN}-{ATTEMPT}",
            "description": f"relic-gcs-proof v1 repo={repo} run={RUN} attempt={ATTEMPT} candidate={candidate} expires={expires}",
            "disabled": disabled}


def provisioned():
    return {"version": 1, "project": PROJECT, "project_number": PROJECT_NUMBER, "run": RUN,
            "attempt": ATTEMPT, "bucket": NAMES["bucket"], "account": NAMES["account"],
            "account_uid": UID, "candidate": CANDIDATE, "expires": EXPIRES}


def github_run(attempt=2, status="completed"):
    return {"id": int(RUN), "workflow_id": 42, "event": "workflow_dispatch", "head_branch": "main",
            "repository": {"id": int(REPO)}, "run_attempt": attempt, "status": status}


class NamingAndPolicies(unittest.TestCase):
    def test_names_and_noncanonical_inputs(self):
        self.assertEqual(NAMES, {"bucket": "relic-gcs-proof-12345-2",
                                 "account": "rgp-12345-2@relic-example.iam.gserviceaccount.com",
                                 "account_id": "rgp-12345-2"})
        for project, run_id, attempt in [(PROJECT, "0", "1"), (PROJECT, "01", "1"),
                                          (PROJECT, "1", "00"), (PROJECT, "1", "1000"),
                                          (PROJECT, "1" * 20, "1"), ("Bad_Project", "1", "1")]:
            with self.subTest(project=project, run=run_id, attempt=attempt):
                with self.assertRaises(ValueError):
                    r.names(project, run_id, attempt)
        longest = r.names(PROJECT, "9" * 19, "999")
        self.assertLessEqual(len(longest["account_id"]), 30)

    def test_provisioned_exact_fields_and_identity(self):
        self.assertEqual(r.parse_provisioned(json.dumps(provisioned()), PROJECT, RUN, ATTEMPT), provisioned())
        for key, value in [("bucket", "another"), ("account_uid", "0"), ("project_number", "01"),
                           ("expires", str(EXPIRES)), ("candidate", "A" * 40), ("attempt", "1")]:
            bad = provisioned()
            bad[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                r.parse_provisioned(json.dumps(bad), PROJECT, RUN, ATTEMPT)
        bad = provisioned()
        bad["extra"] = True
        with self.assertRaises(ValueError):
            r.parse_provisioned(json.dumps(bad), PROJECT, RUN, ATTEMPT)
        duplicate = json.dumps(provisioned())[:-1] + ', "version":1}'
        with self.assertRaisesRegex(ValueError, "duplicate"):
            r.parse_provisioned(duplicate, PROJECT, RUN, ATTEMPT)

    def test_markers_are_exact_and_uid_is_bound(self):
        r.verify_account(account(), PROJECT, RUN, ATTEMPT, REPO, provisioned())
        r.verify_bucket(bucket(), PROJECT, RUN, ATTEMPT, provisioned())
        with self.assertRaises(ValueError):
            r.verify_account(account(repo="999"), PROJECT, RUN, ATTEMPT, REPO)
        with self.assertRaises(ValueError):
            r.verify_account(account(uid="777"), PROJECT, RUN, ATTEMPT, REPO, provisioned())
        altered = bucket()
        altered["labels"]["extra"] = "other"
        with self.assertRaises(ValueError):
            r.verify_bucket(altered, PROJECT, RUN, ATTEMPT)

    def test_propagation_errors_retry_but_conflicts_do_not(self):
        responses = [(404, b""), (412, b""), (403, b"principal does not exist"), (200, b"{}")]
        with patch.object(r, "http", side_effect=responses) as request, patch.object(r, "now", return_value=START), \
                patch.object(r.time, "sleep"):
            self.assertEqual(r.call("POST", "unused", TOKEN, deadline=180, retry=(404, 412)), (200, b"{}"))
            self.assertEqual(request.call_count, 4)
        with patch.object(r, "http", return_value=(409, b"")) as request:
            with self.assertRaisesRegex(ValueError, "409"):
                r.call("POST", "unused", TOKEN, deadline=180, retry=(404, 412))
            self.assertEqual(request.call_count, 1)

    def test_repeated_page_token_is_error(self):
        response = encoded({"items": [], "nextPageToken": "repeat"})
        with patch.object(r, "http", return_value=(200, response)):
            with self.assertRaisesRegex(ValueError, "repeated"):
                list(r.paged("unused", TOKEN))


class FakeCleanup:
    """Only the in-memory GCP API and fake subprocess receive mutations."""
    def __init__(self):
        self.bucket = bucket()
        self.account = account()
        self.calls = []
        self.deny_account = False
        self.deny_bucket = False
        self.project_contains_bucket = True

    def http(self, method, url, token, body=None, headers=None):
        parsed = urllib.parse.urlsplit(url)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        self.calls.append((method, path))
        bucket_path = "/storage/v1/b/" + NAMES["bucket"]
        account_prefix = f"/v1/projects/{PROJECT}/serviceAccounts/"
        if path == "/storage/v1/b" and method == "GET":
            if query.get("softDeleted") == ["true"]:
                return 200, encoded({"items": []})
            return 200, encoded({"items": [self.bucket] if self.bucket and self.project_contains_bucket else []})
        if path == bucket_path and method == "GET":
            if self.deny_bucket:
                return 403, b""
            return (200, encoded(self.bucket)) if self.bucket else (404, b"")
        if path.startswith(account_prefix):
            identity = path[len(account_prefix):]
            if self.deny_account and method == "GET":
                return 403, b""
            if identity in (NAMES["account"], UID) and method == "GET":
                return (200, encoded(self.account)) if self.account else (404, b"")
            if identity == UID + ":disable" and method == "POST":
                self.calls.append(("stage", "disable"))
                self.account["disabled"] = True
                return 200, b"{}"
            if identity == UID and method == "DELETE":
                self.calls.append(("stage", "account"))
                self.account = None
                return 200, b"{}"
        raise AssertionError("unexpected fake API call: " + method + " " + path)

    def run(self, command):
        raise AssertionError("cleanup must not run a name-based deletion")


class Cleanup(unittest.TestCase):
    def exercise(self, fake, expected=None):
        with patch.object(r, "http", side_effect=fake.http), patch.object(r, "run", side_effect=fake.run), contextlib.redirect_stdout(io.StringIO()):
            r.cleanup_group(PROJECT, RUN, ATTEMPT, REPO, expected=expected, token=TOKEN)

    def test_existing_bucket_stays_intact_and_account_is_disabled(self):
        fake = FakeCleanup()
        with self.assertRaisesRegex(ValueError, "immutable identity"):
            self.exercise(fake, provisioned())
        stages = [detail for method, detail in fake.calls if method == "stage"]
        self.assertEqual(stages, ["disable"])
        self.assertTrue(fake.account["disabled"])
        self.assertIsNotNone(fake.bucket)
        self.assertFalse(any(method in ("PATCH", "DELETE") for method, _ in fake.calls))

    def test_403_is_never_absence_and_only_verified_uid_may_be_disabled(self):
        for field in ("deny_account", "deny_bucket"):
            fake = FakeCleanup()
            setattr(fake, field, True)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.exercise(fake, provisioned())
            stages = [detail for method, detail in fake.calls if method == "stage"]
            self.assertEqual(stages, ["disable"] if field == "deny_bucket" else [])
            self.assertIsNotNone(fake.bucket)
            self.assertIsNotNone(fake.account)

    def test_bucket_must_be_in_target_project(self):
        fake = FakeCleanup()
        fake.project_contains_bucket = False
        with self.assertRaisesRegex(ValueError, "target project"):
            self.exercise(fake, provisioned())
        self.assertEqual([detail for method, detail in fake.calls if method == "stage"], ["disable"])
        self.assertIsNotNone(fake.bucket)

    def test_labels_alone_never_authorize_unproven_resource_deletion(self):
        for missing in (None, "account", "bucket"):
            fake = FakeCleanup()
            if missing:
                setattr(fake, missing, None)
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "creation provenance"):
                self.exercise(fake)
            self.assertFalse(any(method == "stage" for method, _ in fake.calls))

    def test_uid_and_marker_conflicts_never_delete(self):
        cases = [
            (lambda f: f.account.update(uniqueId="999"), []),
            (lambda f: f.account.update(description=f"relic-gcs-proof v1 repo=999 run={RUN} attempt={ATTEMPT} candidate={CANDIDATE} expires={EXPIRES}"), []),
            (lambda f: f.bucket["labels"].update(candidate="b" * 40), ["disable"]),
            (lambda f: f.bucket["labels"].update(account_uid="999"), ["disable"]),
        ]
        for change, expected_stages in cases:
            fake = FakeCleanup()
            change(fake)
            with self.assertRaises(ValueError):
                self.exercise(fake, provisioned())
            self.assertEqual([detail for method, detail in fake.calls if method == "stage"], expected_stages)
            self.assertIsNotNone(fake.account)
            self.assertIsNotNone(fake.bucket)

    def test_bucket_absent_and_account_absent_are_safe_partial_states(self):
        fake = FakeCleanup()
        fake.account = None
        with self.assertRaisesRegex(ValueError, "immutable identity"):
            self.exercise(fake, provisioned())
        self.assertFalse(any(method == "stage" for method, _ in fake.calls))
        fake = FakeCleanup()
        fake.bucket = None
        self.exercise(fake, provisioned())
        stages = [detail for method, detail in fake.calls if method == "stage"]
        self.assertEqual(stages, ["disable", "account"])

    def test_failure_in_one_cleanup_step_does_not_skip_later_steps(self):
        fake = FakeCleanup()
        def failed_disable(method, url, token, body=None, headers=None):
            if url.endswith(UID + ":disable"):
                fake.calls.append(("stage", "disable"))
                return 403, b""
            return fake.http(method, url, token, body, headers)
        with patch.object(r, "http", side_effect=failed_disable), patch.object(r, "run", side_effect=fake.run), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "disable"):
                r.cleanup_group(PROJECT, RUN, ATTEMPT, REPO, expected=provisioned(), token=TOKEN)
        self.assertEqual([detail for method, detail in fake.calls if method == "stage"], ["disable"])
        self.assertIsNotNone(fake.account)

    def test_soft_deleted_bucket_is_not_absent(self):
        def fake(method, url, token, body=None, headers=None):
            return 200, encoded({"items": [{"name": NAMES["bucket"]}]})
        with patch.object(r, "http", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "soft-deleted"):
                r.assert_no_soft_deleted(NAMES["bucket"], PROJECT, TOKEN)



class Janitor(unittest.TestCase):
    def reason(self, group=None, run_data=None, age=0, attempt=ATTEMPT):
        if group is None:
            group = {"bucket": bucket(), "account": account()}
        with patch.object(r, "now", return_value=START + 1000):
            return r.janitor_reason(PROJECT, RUN, attempt, REPO, group, age, run_data, 42)

    def test_every_skip_reason(self):
        group = {"bucket": bucket(), "account": account(repo="1")}
        self.assertEqual(self.reason(group, github_run()), "marker")
        group = {"bucket": bucket(candidate="b" * 40), "account": account()}
        self.assertEqual(self.reason(group, github_run()), "marker_conflict")
        self.assertEqual(self.reason(run_data=github_run(), age=30), "too_young")
        self.assertEqual(self.reason(run_data=None), "run_unavailable")
        invalid = github_run()
        invalid["workflow_id"] = 7
        self.assertEqual(self.reason(run_data=invalid), "run_identity")
        invalid = github_run()
        invalid["repository"]["id"] = 7
        self.assertEqual(self.reason(run_data=invalid), "run_identity")
        self.assertEqual(self.reason(run_data=github_run(status="in_progress")), "run_active")
        self.assertEqual(self.reason(run_data=github_run(attempt=1)), "run_attempt")

    def test_completed_and_older_attempt_are_eligible(self):
        self.assertIsNone(self.reason(run_data=github_run()))
        self.assertIsNone(self.reason(run_data=github_run(attempt=3, status="in_progress")))
        self.assertIsNone(self.reason({"account": account()}, github_run()))
        self.assertIsNone(self.reason({"bucket": bucket()}, github_run()))

    def test_selection_paginates_buckets_and_accounts(self):
        def fake(method, url, token, body=None, headers=None):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            if url.startswith(r.STORAGE):
                return (200, encoded({"items": [bucket()], "nextPageToken": "page2"})) if "pageToken" not in query else (200, encoded({"items": []}))
            return 200, encoded({"accounts": [account()]})
        with patch.object(r, "http", side_effect=fake):
            groups = r.candidate_groups(PROJECT, TOKEN)
        self.assertEqual(set(groups), {(RUN, ATTEMPT)})
        self.assertEqual(set(groups[(RUN, ATTEMPT)]), {"bucket", "account"})

    def test_janitor_executes_only_eligible_groups_and_respects_dry_run(self):
        env = {"GH_TOKEN": TOKEN, "GITHUB_API_URL": "https://api.github.com", "GITHUB_REPOSITORY": "owner/repo"}
        groups = {(RUN, ATTEMPT): {"bucket": bucket(), "account": account()}}
        def gh(status):
            def fake(method, url, token, body=None, headers=None):
                if url.endswith("/workflows/gcs-proof.yml"):
                    return 200, encoded({"id": 42, "path": ".github/workflows/gcs-proof.yml"})
                if url.endswith("/runs/" + RUN):
                    return 200, encoded(github_run(status=status))
                self.fail("unexpected GitHub fake request")
            return fake
        for dry_run, status, expected_count in [("true", "completed", 0), ("false", "completed", 1),
                                                 ("false", "in_progress", 0)]:
            args = types.SimpleNamespace(project=PROJECT, repo_id=REPO, dry_run=dry_run, min_age_minutes=0)
            with self.subTest(dry_run=dry_run, status=status), patch.dict(os.environ, env), \
                    patch.object(r, "now", return_value=START + 1000), patch.object(r, "http", side_effect=gh(status)), \
                    patch.object(r, "access_token", return_value=TOKEN), patch.object(r, "candidate_groups", return_value=groups), \
                    patch.object(r, "cleanup_group") as cleanup, contextlib.redirect_stdout(io.StringIO()):
                r.janitor(args)
                self.assertEqual(cleanup.call_count, expected_count)

    def test_github_403_fails_janitor_instead_of_skipping(self):
        args = types.SimpleNamespace(project=PROJECT, repo_id=REPO, dry_run="false", min_age_minutes=0)
        env = {"GH_TOKEN": TOKEN, "GITHUB_API_URL": "https://api.github.com", "GITHUB_REPOSITORY": "owner/repo"}
        with patch.dict(os.environ, env), patch.object(r, "http", return_value=(403, b"")):
            with self.assertRaisesRegex(ValueError, "403"):
                r.janitor(args)


class ProvisionAndMint(unittest.TestCase):
    def test_provision_command_fails_before_credentials_or_cloud_calls(self):
        with tempfile.TemporaryDirectory() as temp:
            output = os.path.join(temp, "provisioned.json")
            argv = ["resources.py", "provision", "--project", PROJECT, "--run", RUN, "--attempt", ATTEMPT,
                    "--region", "us-central1", "--candidate", CANDIDATE, "--repo-id", REPO,
                    "--wif-provider", f"projects/{PROJECT_NUMBER}/locations/global/workloadIdentityPools/pool/providers/provider",
                    "--output", output]
            with patch.object(r.sys, "argv", argv), patch.object(r, "http") as request, \
                    patch.object(r, "run") as command, patch.object(r, "access_token") as credentials, \
                    patch.object(r, "write_private") as write_file:
                with self.assertRaisesRegex(ValueError, "provisioning blocked"):
                    r.main()
                request.assert_not_called()
                command.assert_not_called()
                credentials.assert_not_called()
                write_file.assert_not_called()
            self.assertFalse(os.path.exists(output))

    def test_mint_writes_private_token_and_rfc3339_metadata(self):
        body = {"accessToken": TOKEN, "expireTime": "2023-11-14T23:00:00Z"}
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"GCS_PROOF_FEDERATED_TOKEN": TOKEN}), \
                patch.object(r, "http", return_value=(200, encoded(body))):
            token_file = os.path.join(temp, "token")
            meta_file = os.path.join(temp, "meta")
            args = types.SimpleNamespace(account=NAMES["account"], lifetime_seconds=2700, deadline_seconds=420,
                                         token_file=token_file, meta_file=meta_file)
            r.mint(args)
            with open(token_file, encoding="utf-8") as source:
                self.assertEqual(source.read(), TOKEN)
            self.assertEqual(os.stat(token_file).st_mode & 0o777, 0o600)
            with open(meta_file, encoding="utf-8") as source:
                self.assertEqual(json.load(source), {"expire_time": body["expireTime"]})
            with self.assertRaises(FileExistsError):
                r.mint(args)

    def test_token_shape_rejects_workflow_command_injection(self):
        for token in ("short", "x" * 20 + "\n::warning::no", "x" * 20 + "%0A", "x" * 4097):
            with self.subTest(token_length=len(token)), self.assertRaises(ValueError):
                r.parse_token(token)
        self.assertEqual(r.parse_token(TOKEN), TOKEN)


class ScopeAndRevoke(unittest.TestCase):
    def test_scope_checks_effective_project_and_other_account_boundaries(self):
        app = "relic-app@" + PROJECT + ".iam.gserviceaccount.com"
        deployer = "relic-deployer@" + PROJECT + ".iam.gserviceaccount.com"
        calls = []
        def fake(method, url, token, body=None, headers=None):
            calls.append((method, url, body))
            decoded = urllib.parse.unquote(url)
            if "/iam/testPermissions?" in decoded:
                allowed = r.OBJECT_PERMISSIONS if "/b/" + NAMES["bucket"] + "/" in decoded else []
                return 200, encoded({"permissions": allowed})
            if decoded.startswith("https://cloudresourcemanager.googleapis.com/"):
                self.assertEqual(body, {"permissions": r.PROJECT_PROBES})
                return 200, encoded({"permissions": []})
            if decoded.endswith(":testIamPermissions"):
                allowed = r.SELF_ACCOUNT_PERMISSIONS if NAMES["account"] in decoded else []
                return 200, encoded({"permissions": allowed})
            if decoded.endswith(":signBlob"):
                return ((200, encoded({"keyId": "key", "signedBlob": "signature"}))
                        if NAMES["account"] in decoded else (403, b""))
            if decoded.endswith(":generateAccessToken") or decoded.endswith(":signJwt"):
                return 200, b"{}"
            if "/storage/v1/b?project=" in decoded or decoded.endswith("/serviceAccounts"):
                return 403, b""
            self.fail("unexpected API call " + decoded)
        with tempfile.TemporaryDirectory() as temp, patch.object(r, "http", side_effect=fake), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            token_file = os.path.join(temp, "token")
            with open(token_file, "w", encoding="utf-8") as file:
                file.write(TOKEN)
            args = types.SimpleNamespace(project=PROJECT, bucket=NAMES["bucket"], account=NAMES["account"],
                                         app_account=app, deployer_account=deployer, token_file=token_file)
            r.check_scope(args)
        self.assertIn("GCS_PROOF_SCOPE_VERIFIED", output.getvalue())
        self.assertTrue(any(PROJECT + "-tfstate" in url for _, url, _ in calls))
        self.assertTrue(any(PROJECT + "-relics" in url for _, url, _ in calls))
        self.assertTrue(any(app in urllib.parse.unquote(url) and url.endswith(":signBlob") for _, url, _ in calls))
        self.assertTrue(any(deployer in urllib.parse.unquote(url) and url.endswith(":signBlob") for _, url, _ in calls))
        self.assertTrue(any("/storage/v1/b?project=" in urllib.parse.unquote(url) for _, url, _ in calls))
        self.assertTrue(any(url.endswith("/serviceAccounts") for _, url, _ in calls))
        self.assertTrue(any("cloudresourcemanager.googleapis.com" in url for _, url, _ in calls))

    def test_lapsed_control_permission_must_be_absent(self):
        for permission in set(r.BUCKET_PROBES) - set(r.OBJECT_PERMISSIONS):
            response = encoded({"permissions": r.OBJECT_PERMISSIONS + [permission]})
            with self.subTest(permission=permission), patch.object(r, "http", return_value=(200, response)):
                with self.assertRaisesRegex(ValueError, "bucket permissions differ"):
                    r.test_bucket_permissions(NAMES["bucket"], TOKEN, r.OBJECT_PERMISSIONS)

    def test_account_write_or_policy_permissions_must_be_absent(self):
        for permission in set(r.ACCOUNT_PROBES) - set(r.SELF_ACCOUNT_PERMISSIONS):
            response = encoded({"permissions": r.SELF_ACCOUNT_PERMISSIONS + [permission]})
            with self.subTest(permission=permission), patch.object(r, "http", return_value=(200, response)):
                with self.assertRaisesRegex(ValueError, "account permissions differ"):
                    r.test_account_permissions(PROJECT, NAMES["account"], TOKEN, r.SELF_ACCOUNT_PERMISSIONS)

    def test_project_probe_requires_200_and_no_write_permissions(self):
        with patch.object(r, "http", return_value=(403, b"")):
            with self.assertRaisesRegex(ValueError, "403"):
                r.test_project_permissions(PROJECT, TOKEN)
        for permission in r.PROJECT_PROBES:
            with self.subTest(permission=permission), patch.object(r, "http", return_value=(200, encoded({"permissions": [permission]}))):
                with self.assertRaisesRegex(ValueError, "project write"):
                    r.test_project_permissions(PROJECT, TOKEN)

    def test_revoke_disables_exact_uid_and_proves_token_and_remint_denied(self):
        calls = []
        state = {"disabled": False, "scope_reads": 0}
        def fake(method, url, token, body=None, headers=None):
            calls.append((method, url))
            decoded = urllib.parse.unquote(url)
            if "/iam/testPermissions?" in decoded:
                state["scope_reads"] += 1
                if state["disabled"]:
                    return 403, b""
                return 200, encoded({"permissions": r.OBJECT_PERMISSIONS})
            if decoded.endswith("/" + NAMES["account"]) and method == "GET":
                return 200, encoded(account())
            if decoded.endswith("/" + UID + ":disable") and method == "POST":
                state["disabled"] = True
                return 200, b"{}"
            if decoded.endswith("/" + UID) and method == "GET":
                return 200, encoded(account(disabled=True))
            if decoded.endswith(":generateAccessToken"):
                return 403, b""
            self.fail("unexpected API call " + decoded)
        args = types.SimpleNamespace(project=PROJECT, run=RUN, attempt=ATTEMPT, repo_id=REPO,
                                     provisioned_json=json.dumps(provisioned()))
        environment = {"GITHUB_RUN_ID": RUN, "GITHUB_RUN_ATTEMPT": ATTEMPT, "GCS_PROOF_FEDERATED_TOKEN": TOKEN}
        with patch.dict(os.environ, environment), patch.object(r, "http", side_effect=fake), \
                patch.object(r, "access_token", return_value=TOKEN), patch.object(r, "generate_token", return_value=(TOKEN, "2023-11-14T23:00:00Z")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            r.revoke(args)
        self.assertTrue(state["disabled"])
        self.assertEqual(state["scope_reads"], 2)
        self.assertIn("GCS_PROOF_REVOKED", output.getvalue())
        self.assertTrue(any(url.endswith("/" + UID + ":disable") for _, url in calls))


if __name__ == "__main__":
    unittest.main()
