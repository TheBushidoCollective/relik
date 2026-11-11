#!/usr/bin/env python3
"""Create, inspect and retire run-scoped GCS proof resources."""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LEASE_SECONDS = 7200
PROJECT_RE = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]\Z")
RUN_RE = re.compile(r"[1-9][0-9]{0,18}\Z")
ATTEMPT_RE = re.compile(r"[1-9][0-9]{0,2}\Z")
NUMBER_RE = re.compile(r"[1-9][0-9]{0,19}\Z")
UID_RE = re.compile(r"[1-9][0-9]{0,62}\Z")
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
TOKEN_RE = re.compile(r"[A-Za-z0-9._~+/-]+={0,2}\Z")
BUCKET_RE = re.compile(r"relic-gcs-proof-([1-9][0-9]{0,18})-([1-9][0-9]{0,2})\Z")
DESC_RE = re.compile(r"relic-gcs-proof v1 repo=([1-9][0-9]{0,19}) run=([1-9][0-9]{0,18}) attempt=([1-9][0-9]{0,2}) candidate=([0-9a-f]{40}) expires=([1-9][0-9]{0,19})\Z")
STORAGE = "https://storage.googleapis.com/storage/v1/b"
IAM = "https://iam.googleapis.com/v1/projects"
CREDENTIALS = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts"
CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
OBJECT_PERMISSIONS = ["storage.objects.create", "storage.objects.delete", "storage.objects.get", "storage.objects.update"]
BUCKET_PROBES = OBJECT_PERMISSIONS + ["storage.buckets.get", "storage.buckets.update",
                                     "storage.buckets.setIamPolicy", "storage.buckets.delete"]
SELF_ACCOUNT_PERMISSIONS = ["iam.serviceAccounts.signBlob", "iam.serviceAccounts.signJwt",
                            "iam.serviceAccounts.getAccessToken", "iam.serviceAccounts.getOpenIdToken",
                            "iam.serviceAccounts.implicitDelegation", "iam.serviceAccounts.get"]
ACCOUNT_PROBES = SELF_ACCOUNT_PERMISSIONS + ["iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy",
                    "iam.serviceAccounts.update", "iam.serviceAccounts.enable", "iam.serviceAccounts.delete",
                    "iam.serviceAccounts.actAs", "iam.serviceAccountKeys.create"]
PROJECT_PROBES = ["storage.buckets.create", "storage.buckets.update", "storage.buckets.delete",
                  "storage.buckets.setIamPolicy", "iam.serviceAccounts.create", "iam.serviceAccounts.update",
                  "iam.serviceAccounts.delete", "iam.serviceAccounts.enable", "iam.serviceAccounts.setIamPolicy",
                  "iam.serviceAccountKeys.create"]
PROVISIONED_KEYS = {"version", "project", "project_number", "run", "attempt", "bucket", "account", "account_uid", "candidate", "expires"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def now():
    return time.time()


def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=True)


def http(method, url, token, body=None, headers=None):
    request_headers = {"Authorization": "Bearer " + token}
    request_headers.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read(16 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65537)
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, b""


def decode(raw):
    require(isinstance(raw, bytes) and len(raw) <= 16 * 1024 * 1024, "invalid response size")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("invalid JSON response") from None
    require(isinstance(value, dict), "invalid JSON object response")
    return value


def call(method, url, token, body=None, *, statuses=(200,), deadline=0, retry=()):
    end = now() + deadline
    while True:
        status, raw = http(method, url, token, body)
        if status in statuses:
            return status, raw
        missing = status in (400, 403) and b"does not exist" in raw.lower() and deadline > 0
        if (status not in retry and not missing) or now() >= end:
            raise ValueError(f"request returned HTTP {status}")
        time.sleep(min(3, max(0, end - now())))


def q(value):
    return urllib.parse.quote(str(value), safe="")


def with_query(url, params):
    return url + "?" + urllib.parse.urlencode(params, doseq=True)


def bucket_url(bucket):
    return STORAGE + "/" + q(bucket)


def account_url(project, account):
    return f"{IAM}/{q(project)}/serviceAccounts/{q(account)}"


def credentials_url(account, method):
    return CREDENTIALS + "/" + q(account) + ":" + method


def names(project, run_id, attempt):
    require(isinstance(project, str) and PROJECT_RE.fullmatch(project), "invalid project")
    require(isinstance(run_id, str) and RUN_RE.fullmatch(run_id), "invalid run")
    require(isinstance(attempt, str) and ATTEMPT_RE.fullmatch(attempt), "invalid attempt")
    account_id = f"rgp-{run_id}-{attempt}"
    require(len(account_id) <= 30, "account ID exceeds IAM limit")
    return {"bucket": f"relic-gcs-proof-{run_id}-{attempt}",
            "account": f"{account_id}@{project}.iam.gserviceaccount.com", "account_id": account_id}


def repo_number(value):
    require(isinstance(value, str) and NUMBER_RE.fullmatch(value), "invalid repository ID")
    return value


def current_run(run_id, attempt):
    require(os.environ.get("GITHUB_RUN_ID") == run_id and os.environ.get("GITHUB_RUN_ATTEMPT") == attempt,
            "run identity differs from environment")


def labels(run_id, attempt, candidate, expires, account_uid):
    require(isinstance(account_uid, str) and UID_RE.fullmatch(account_uid), "invalid account UID label")
    return {"purpose": "relic-gcs-proof", "run": run_id, "attempt": attempt,
            "candidate": candidate, "expires": str(expires), "account_uid": account_uid}



def access_token():
    try:
        token = run(["gcloud", "auth", "print-access-token"]).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise ValueError("gcloud access token unavailable") from None
    require(20 <= len(token) <= 4096 and TOKEN_RE.fullmatch(token) is not None, "invalid access token")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print("::add-mask::" + token, flush=True)
    return token


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(data)


def parse_provisioned(raw, project, run_id, attempt):
    require(isinstance(raw, str) and len(raw) <= 8192, "invalid provisioned JSON size")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate provisioned field")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    require(isinstance(value, dict) and set(value) == PROVISIONED_KEYS and
            type(value["version"]) is int and value["version"] == 1, "invalid provisioned fields")
    expected_names = names(project, run_id, attempt)
    require(value["project"] == project and value["run"] == run_id and value["attempt"] == attempt and
            value["bucket"] == expected_names["bucket"] and value["account"] == expected_names["account"],
            "provisioned identity differs")
    require(isinstance(value["project_number"], str) and NUMBER_RE.fullmatch(value["project_number"]) and
            isinstance(value["account_uid"], str) and UID_RE.fullmatch(value["account_uid"]) and
            isinstance(value["candidate"], str) and SHA_RE.fullmatch(value["candidate"]) and
            type(value["expires"]) is int and value["expires"] > LEASE_SECONDS, "invalid provisioned values")
    return value


def verify_bucket(value, project, run_id, attempt, expected=None):
    n = names(project, run_id, attempt)
    require(isinstance(value, dict) and value.get("name") == n["bucket"], "bucket identity differs")
    number = value.get("projectNumber")
    require(isinstance(number, str) and NUMBER_RE.fullmatch(number), "invalid bucket project number")
    marker = value.get("labels")
    require(isinstance(marker, dict) and set(marker) == {"purpose", "run", "attempt", "candidate", "expires", "account_uid"} and
            marker.get("purpose") == "relic-gcs-proof" and marker.get("run") == run_id and marker.get("attempt") == attempt and
            isinstance(marker.get("candidate"), str) and SHA_RE.fullmatch(marker["candidate"]) and
            isinstance(marker.get("expires"), str) and NUMBER_RE.fullmatch(marker["expires"]) and
            isinstance(marker.get("account_uid"), str) and UID_RE.fullmatch(marker["account_uid"]), "bucket markers differ")
    if expected is not None:
        require(number == expected["project_number"] and marker == labels(run_id, attempt, expected["candidate"],
                                                                           expected["expires"], expected["account_uid"]),
                "bucket differs from provisioned identity")
    return {"candidate": marker["candidate"], "expires": int(marker["expires"]), "project_number": number,
            "account_uid": marker["account_uid"]}


def verify_account(value, project, run_id, attempt, repo_id, expected=None):
    n = names(project, run_id, attempt)
    require(isinstance(value, dict) and value.get("email") == n["account"] and value.get("projectId") == project and
            value.get("name") == f"projects/{project}/serviceAccounts/{n['account']}" and
            value.get("displayName") == f"relic gcs proof {run_id}-{attempt}", "account identity differs")
    uid = value.get("uniqueId")
    require(isinstance(uid, str) and UID_RE.fullmatch(uid), "account unique ID invalid")
    match = DESC_RE.fullmatch(value.get("description", "")) if isinstance(value.get("description"), str) else None
    require(match is not None, "account markers invalid")
    repo, run_value, attempt_value, candidate, expires = match.groups()
    require(repo == repo_id and run_value == run_id and attempt_value == attempt, "account markers differ")
    if expected is not None:
        require(uid == expected["account_uid"] and candidate == expected["candidate"] and int(expires) == expected["expires"],
                "account differs from provisioned identity")
    return {"candidate": candidate, "expires": int(expires), "account_uid": uid}


def provision(_args):
    # GCS cannot atomically bind bucket deletion to its immutable generation.
    # Do not create an account or bucket that cannot be safely cleaned up.
    raise ValueError("provisioning blocked: automatic bucket cleanup cannot enforce immutable identity")


def parse_token(token):
    require(isinstance(token, str) and 20 <= len(token) <= 4096 and TOKEN_RE.fullmatch(token), "invalid token")
    return token


def generate_token(account, federated, lifetime=2700, deadline=420):
    require(lifetime == 2700 and 1 <= deadline <= 420, "invalid token lifetime or deadline")
    _, raw = call("POST", credentials_url(account, "generateAccessToken"), parse_token(federated),
                  {"scope": [CLOUD_SCOPE], "lifetime": f"{lifetime}s"}, deadline=deadline,
                  retry=(0, 403, 404, 429, 500, 502, 503, 504))
    value = decode(raw)
    token = parse_token(value.get("accessToken"))
    expires = value.get("expireTime")
    require(isinstance(expires, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z", expires), "invalid token expiry")
    try:
        datetime.datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("invalid token expiry") from None
    return token, expires


def mint(args):
    validate_account(args.account)
    token, expires = generate_token(args.account, os.environ.get("GCS_PROOF_FEDERATED_TOKEN", ""), args.lifetime_seconds, args.deadline_seconds)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print("::add-mask::" + token, flush=True)
    write_private(args.token_file, token)
    write_private(args.meta_file, json.dumps({"expire_time": expires}, separators=(",", ":")))


def validate_account(account, project=None):
    match = re.fullmatch(r"rgp-([1-9][0-9]{0,18})-([1-9][0-9]{0,2})@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com", account or "")
    require(match is not None and (project is None or match.group(3) == project), "invalid proof account")
    require(names(match.group(3), match.group(1), match.group(2))["account"] == account, "invalid proof account name")
    return match.groups()


def token_from_file(path):
    with open(path, "r", encoding="ascii") as source:
        token = source.read(4097)
    return parse_token(token)


def test_bucket_permissions(bucket, token, expected):
    status, raw = call("GET", with_query(bucket_url(bucket) + "/iam/testPermissions", {"permissions": BUCKET_PROBES}), token)
    value = decode(raw)
    actual = value.get("permissions", [])
    require(isinstance(actual, list) and all(isinstance(p, str) for p in actual) and sorted(actual) == sorted(expected),
            "bucket permissions differ")


def test_account_permissions(project, account, token, expected):
    _, raw = call("POST", account_url(project, account) + ":testIamPermissions", token, {"permissions": ACCOUNT_PROBES})
    actual = decode(raw).get("permissions", [])
    require(isinstance(actual, list) and all(isinstance(p, str) for p in actual) and sorted(actual) == sorted(expected),
            "account permissions differ")


def test_project_permissions(project, token):
    _, raw = call("POST", f"https://cloudresourcemanager.googleapis.com/v1/projects/{q(project)}:testIamPermissions",
                  token, {"permissions": PROJECT_PROBES})
    permissions = decode(raw).get("permissions", [])
    require(isinstance(permissions, list) and not permissions, "project write permissions not denied")


def sign_status(account, token):
    status, raw = http("POST", credentials_url(account, "signBlob"), token, {"payload": "cHJvb2Y="})
    if status == 200:
        result = decode(raw)
        require(isinstance(result.get("keyId"), str) and bool(result["keyId"]) and
                isinstance(result.get("signedBlob"), str) and bool(result["signedBlob"]), "invalid signature response")
    return status


def check_scope(args):
    run_id, attempt, _ = validate_account(args.account, args.project)
    require(args.bucket == names(args.project, run_id, attempt)["bucket"], "bucket and account differ")
    for account in (args.app_account, args.deployer_account):
        require(isinstance(account, str) and re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]@" + re.escape(args.project) + r"\.iam\.gserviceaccount\.com", account),
                "invalid protected account")
        require(account != args.account, "protected account is proof account")
    require(args.app_account != args.deployer_account, "protected accounts match")
    token = token_from_file(args.token_file)
    # Wait only for the expected positive grant; all negative probes remain strict.
    end = now() + 300
    while True:
        try:
            test_bucket_permissions(args.bucket, token, OBJECT_PERMISSIONS)
            test_account_permissions(args.project, args.account, token, SELF_ACCOUNT_PERMISSIONS)
            require(sign_status(args.account, token) == 200, "self signing denied")
            break
        except ValueError:
            if now() >= end:
                raise
            time.sleep(min(3, max(0, end - now())))
    for bucket in (args.project + "-relics", args.project + "-tfstate"):
        test_bucket_permissions(bucket, token, [])
    for account in (args.app_account, args.deployer_account):
        test_account_permissions(args.project, account, token, [])
        require(sign_status(account, token) == 403, "protected account signing not denied")
    status, _ = http("GET", with_query(STORAGE, {"project": args.project}), token)
    require(status == 403, "project bucket listing not denied")
    status, _ = http("GET", f"{IAM}/{q(args.project)}/serviceAccounts", token)
    require(status == 403, "project account listing not denied")
    test_project_permissions(args.project, token)
    # Informational probes: self token creation follows from tokenCreator.
    renewal, _ = http("POST", credentials_url(args.account, "generateAccessToken"), token,
                      {"scope": [CLOUD_SCOPE], "lifetime": "2700s"})
    payload = json.dumps({"iss": args.account, "sub": args.account, "aud": "https://oauth2.googleapis.com/token",
                          "iat": int(now()), "exp": int(now()) + 300}, separators=(",", ":"))
    sign_jwt, _ = http("POST", credentials_url(args.account, "signJwt"), token, {"payload": payload})
    print(f"GCS_PROOF_SELF_RENEWAL generate_access_token={renewal} sign_jwt={sign_jwt}")
    print(f"GCS_PROOF_SCOPE_VERIFIED account={args.account}")


def revoke(args):
    n = names(args.project, args.run, args.attempt)
    current_run(args.run, args.attempt)
    repo_number(args.repo_id)
    expected = parse_provisioned(args.provisioned_json, args.project, args.run, args.attempt)
    admin = access_token()
    status, raw = call("GET", account_url(args.project, n["account"]), admin)
    verify_account(decode(raw), args.project, args.run, args.attempt, args.repo_id, expected)
    federated = parse_token(os.environ.get("GCS_PROOF_FEDERATED_TOKEN", ""))
    token, _ = generate_token(n["account"], federated)
    test_bucket_permissions(n["bucket"], token, OBJECT_PERMISSIONS)
    unique_url = account_url(args.project, expected["account_uid"])
    call("POST", unique_url + ":disable", admin, {}, statuses=(200,))
    _, raw = call("GET", unique_url, admin)
    disabled = decode(raw)
    verify_account(disabled, args.project, args.run, args.attempt, args.repo_id, expected)
    require(disabled.get("disabled") is True, "account disable not observed")
    end = now() + 300
    while True:
        status, _ = http("GET", with_query(bucket_url(n["bucket"]) + "/iam/testPermissions", {"permissions": BUCKET_PROBES}), token)
        if status in (401, 403):
            break
        require(status == 200 and now() < end, "retained token revocation not observed")
        time.sleep(min(3, max(0, end - now())))
    status, _ = http("POST", credentials_url(n["account"], "generateAccessToken"), federated,
                     {"scope": [CLOUD_SCOPE], "lifetime": "2700s"})
    require(status in (401, 403), "remint after disable not denied")
    print(f"GCS_PROOF_REVOKED account={n['account']}")


def paged(url, token, field="items", params=None):
    query = dict(params or {})
    seen = set()
    while True:
        _, raw = call("GET", with_query(url, query) if query else url, token)
        page = decode(raw)
        items = page.get(field, [])
        require(isinstance(items, list) and all(isinstance(item, dict) for item in items), "invalid listing")
        yield from items
        following = page.get("nextPageToken")
        if following is None:
            return
        require(isinstance(following, str) and following and following not in seen, "repeated or invalid page token")
        seen.add(following)
        query["pageToken"] = following


def read_resource(url, token):
    status, raw = call("GET", url, token, statuses=(200, 404))
    return None if status == 404 else decode(raw)



def assert_no_soft_deleted(bucket, project, token):
    for item in paged(STORAGE, token, params={"project": project, "prefix": bucket, "softDeleted": "true"}):
        require(item.get("name") != bucket, "soft-deleted proof bucket remains")


def cleanup_group(project, run_id, attempt, repo_id, expected=None, token=None):
    n = names(project, run_id, attempt)
    repo_number(repo_id)
    token = token or access_token()
    errors = []
    bucket = account = None
    bucket_marker = account_marker = None
    bucket_error = False
    try:
        bucket = read_resource(bucket_url(n["bucket"]), token)
        if bucket is not None:
            bucket_marker = verify_bucket(bucket, project, run_id, attempt, expected)
            project_buckets = list(paged(STORAGE, token, params={"project": project, "prefix": n["bucket"]}))
            require(any(item.get("name") == n["bucket"] and item.get("projectNumber") == bucket_marker["project_number"]
                        for item in project_buckets), "bucket not listed in target project")
    except ValueError as error:
        errors.append("bucket identity: " + str(error))
        bucket_error = True
    try:
        account = read_resource(account_url(project, n["account"]), token)
        if account is not None:
            account_marker = verify_account(account, project, run_id, attempt, repo_id, expected)
    except ValueError as error:
        raise ValueError("account identity: " + str(error)) from None
    if bucket_marker and account_marker and (bucket_marker["candidate"], bucket_marker["expires"], bucket_marker["account_uid"]) != (account_marker["candidate"], account_marker["expires"], account_marker["account_uid"]):
        errors.append("bucket and account marker conflict")
        bucket_error = True
    # Names and mutable labels alone cannot prove that a create did not collide.
    # Until the janitor has durable creation evidence, fail closed rather than
    # deleting a pre-existing same-name resource.
    require(expected is not None or (not bucket_error and bucket is None and account is None),
            "durable creation provenance required for janitor cleanup")
    uid = account_marker["account_uid"] if account_marker else (expected["account_uid"] if expected else "absent")
    disabled_confirmed = account is None
    if account_marker:
        try:
            unique_url = account_url(project, uid)
            if account.get("disabled") is not True:
                call("POST", unique_url + ":disable", token, {}, statuses=(200,))
            disabled = read_resource(unique_url, token)
            require(disabled is not None and verify_account(disabled, project, run_id, attempt, repo_id, expected) and
                    disabled.get("disabled") is True, "account disable not observed")
            disabled_confirmed = True
        except ValueError as error:
            errors.append("disable: " + str(error))
    if bucket_marker:
        # GCS cannot atomically bind a bucket DELETE to its immutable generation.
        # A name-based recursive deletion could hit a substituted bucket.
        errors.append("bucket deletion blocked: immutable identity cannot be enforced")
    bucket_absent = False
    try:
        require(read_resource(bucket_url(n["bucket"]), token) is None, "bucket remains")
        assert_no_soft_deleted(n["bucket"], project, token)
        bucket_absent = True
        print(f"GCS_PROOF_BUCKET_GONE {n['bucket']}")
    except ValueError as error:
        errors.append("bucket absence: " + str(error))
    if account_marker and disabled_confirmed and bucket_absent and not bucket_error:
        try:
            # Re-read and compare the unique ID immediately before deletion.
            before = read_resource(account_url(project, uid), token)
            if before is not None:
                current = verify_account(before, project, run_id, attempt, repo_id, expected)
                require(current["account_uid"] == uid, "account unique ID changed")
                call("DELETE", account_url(project, uid), token, statuses=(200, 204, 404))
        except ValueError as error:
            errors.append("account delete: " + str(error))
    elif account_marker:
        errors.append("account kept: disable or bucket absence was not confirmed")
        print(f"GCS_PROOF_ACCOUNT_KEPT account={n['account']}")
    try:
        require(read_resource(account_url(project, n["account"]), token) is None, "account remains")
        print(f"GCS_PROOF_ACCOUNT_GONE {n['account']} uid={uid}")
    except ValueError as error:
        errors.append("account absence: " + str(error))
    require(not errors, "; ".join(errors))
    print(f"GCS_PROOF_RESOURCES_GONE bucket={n['bucket']} account_uid={uid}")


def candidate_groups(project, token):
    buckets = list(paged(STORAGE, token, params={"project": project, "prefix": "relic-gcs-proof-"}))
    accounts = list(paged(f"{IAM}/{q(project)}/serviceAccounts", token, field="accounts", params={"pageSize": 100}))
    result = {}
    for bucket in buckets:
        name = bucket.get("name")
        match = BUCKET_RE.fullmatch(name) if isinstance(name, str) else None
        if match:
            result.setdefault(match.groups(), {})["bucket"] = bucket
    expression = re.compile(r"rgp-([1-9][0-9]{0,18})-([1-9][0-9]{0,2})@" + re.escape(project) + r"\.iam\.gserviceaccount\.com\Z")
    for account in accounts:
        email = account.get("email")
        match = expression.fullmatch(email) if isinstance(email, str) else None
        if match:
            result.setdefault(match.groups(), {})["account"] = account
    return result


def janitor_reason(project, run_id, attempt, repo_id, group, minimum_age, github_run, workflow_id):
    try:
        b = verify_bucket(group["bucket"], project, run_id, attempt) if "bucket" in group else None
        a = verify_account(group["account"], project, run_id, attempt, repo_id) if "account" in group else None
        require(a is not None or b is not None, "empty group")
    except (ValueError, KeyError, TypeError):
        return "marker"
    if a and b and (a["candidate"], a["expires"], a["account_uid"]) != (b["candidate"], b["expires"], b["account_uid"]):
        return "marker_conflict"
    marker = a or b
    if now() - (marker["expires"] - LEASE_SECONDS) < minimum_age * 60:
        return "too_young"
    if github_run is None:
        return "run_unavailable"
    repository = github_run.get("repository")
    if (github_run.get("id") != int(run_id) or github_run.get("workflow_id") != workflow_id or
            github_run.get("event") != "workflow_dispatch" or github_run.get("head_branch") != "main" or
            not isinstance(repository, dict) or str(repository.get("id")) != repo_id):
        return "run_identity"
    live_attempt = github_run.get("run_attempt")
    if type(live_attempt) is not int or live_attempt < 1 or int(attempt) > live_attempt:
        return "run_attempt"
    if int(attempt) == live_attempt and github_run.get("status") != "completed":
        return "run_active"
    return None


def github_base():
    api = os.environ.get("GITHUB_API_URL", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    require(api == "https://api.github.com" and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "invalid GitHub repository API")
    return api + "/repos/" + "/".join(q(part) for part in repo.split("/")) + "/actions"


def janitor(args):
    names(args.project, "1", "1")
    repo_number(args.repo_id)
    require(args.dry_run in ("true", "false") and 0 <= args.min_age_minutes <= 525600, "invalid janitor controls")
    github = parse_token(os.environ.get("GH_TOKEN", ""))
    base = github_base()
    _, raw = call("GET", base + "/workflows/gcs-proof.yml", github)
    workflow = decode(raw)
    workflow_id = workflow.get("id")
    require(type(workflow_id) is int and workflow_id > 0 and workflow.get("path") == ".github/workflows/gcs-proof.yml", "proof workflow identity differs")
    token = access_token()
    groups = candidate_groups(args.project, token)
    eligible = failed = 0
    print(f"GCS_PROOF_JANITOR_START dry_run={args.dry_run}")
    for (run_id, attempt), group in sorted(groups.items(), key=lambda pair: (int(pair[0][0]), int(pair[0][1]))):
        # Pre-check markers and age before asking GitHub; failures must remain visible.
        reason = janitor_reason(args.project, run_id, attempt, args.repo_id, group, args.min_age_minutes, None, workflow_id)
        if reason == "run_unavailable":
            status, raw = call("GET", base + "/runs/" + q(run_id), github, statuses=(200, 404))
            run_value = decode(raw) if status == 200 else None
            reason = janitor_reason(args.project, run_id, attempt, args.repo_id, group, args.min_age_minutes, run_value, workflow_id)
        if reason:
            print(f"GCS_PROOF_JANITOR_SKIP run={run_id} attempt={attempt} reason={reason}")
            continue
        eligible += 1
        print(f"GCS_PROOF_JANITOR_ELIGIBLE run={run_id} attempt={attempt}")
        if args.dry_run == "false":
            try:
                cleanup_group(args.project, run_id, attempt, args.repo_id, token=token)
            except ValueError as error:
                failed += 1
                print(f"GCS_PROOF_ERROR resources janitor: run={run_id} attempt={attempt} {error}", file=sys.stderr)
    print(f"GCS_PROOF_JANITOR_DONE eligible={eligible} failed={failed} dry_run={args.dry_run}")
    require(failed == 0, "janitor cleanup failed")


def parser():
    top = argparse.ArgumentParser()
    commands = top.add_subparsers(dest="command", required=True)
    def run_args(p):
        p.add_argument("--project", required=True)
        p.add_argument("--run", required=True)
        p.add_argument("--attempt", required=True)
    p = commands.add_parser("names")
    run_args(p)
    p = commands.add_parser("check-provisioned")
    run_args(p)
    p.add_argument("--provisioned-json", required=True)
    p = commands.add_parser("provision")
    run_args(p)
    for field in ("region", "candidate", "repo-id", "wif-provider", "output"):
        p.add_argument("--" + field, required=True)
    p = commands.add_parser("mint")
    p.add_argument("--account", required=True)
    p.add_argument("--lifetime-seconds", type=int, required=True)
    p.add_argument("--deadline-seconds", type=int, required=True)
    p.add_argument("--token-file", required=True)
    p.add_argument("--meta-file", required=True)
    p = commands.add_parser("check-scope")
    for field in ("project", "bucket", "account", "app-account", "deployer-account", "token-file"):
        p.add_argument("--" + field, required=True)
    for command in ("revoke", "teardown"):
        p = commands.add_parser(command)
        run_args(p)
        p.add_argument("--repo-id", required=True)
        p.add_argument("--provisioned-json", required=command == "revoke")
    p = commands.add_parser("janitor")
    p.add_argument("--project", required=True)
    p.add_argument("--repo-id", required=True)
    p.add_argument("--dry-run", required=True)
    p.add_argument("--min-age-minutes", type=int, required=True)
    return top


def main():
    args = parser().parse_args()
    if args.command == "names":
        print(json.dumps(names(args.project, args.run, args.attempt), separators=(",", ":")))
    elif args.command == "check-provisioned":
        current_run(args.run, args.attempt)
        parse_provisioned(args.provisioned_json, args.project, args.run, args.attempt)
    elif args.command == "provision":
        provision(args)
    elif args.command == "mint":
        mint(args)
    elif args.command == "check-scope":
        check_scope(args)
    elif args.command == "revoke":
        revoke(args)
    elif args.command == "teardown":
        current_run(args.run, args.attempt)
        expected = parse_provisioned(args.provisioned_json, args.project, args.run, args.attempt) if args.provisioned_json else None
        require(expected is not None, "provisioned identity unavailable; janitor must handle cleanup")
        cleanup_group(args.project, args.run, args.attempt, args.repo_id, expected)
    else:
        janitor(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, OSError, OverflowError, subprocess.SubprocessError) as error:
        command = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("names", "check-provisioned", "provision", "mint", "check-scope", "revoke", "teardown", "janitor") else "unknown"
        # Never echo response bodies, URLs, command lines or environment values.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f"GCS_PROOF_ERROR resources {command}: {message}", file=sys.stderr)
        sys.exit(1)
