#!/usr/bin/env python3
"""Create independently hashed, generation-pinned GCS proof fixtures."""
import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BUCKET_RE = re.compile(r"^relic-gcs-proof-[1-9][0-9]{0,18}-[1-9][0-9]{0,2}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
UID_RE = re.compile(r"^[1-9][0-9]{0,62}$")
LARGE_BYTES = 500 * 1024 * 1024
PREFIX = "r"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def token_from_gcloud():
    result = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, check=True)
    token = result.stdout.strip()
    require(bool(token) and "\n" not in token and "\r" not in token, "missing deployer token")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print("::add-mask::" + token, flush=True)
    return token


def request(method, url, token, data=None, headers=None):
    request_headers = {"Authorization": "Bearer " + token}
    request_headers.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return response.status, response.read(), dict(response.headers.items())
    except urllib.error.HTTPError as error:
        return error.code, error.read(), dict(error.headers.items())


def metadata_url(bucket, object_key):
    return ("https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(bucket, safe="") +
            "/o/" + urllib.parse.quote(object_key, safe=""))


def object_url(bucket, object_key):
    return "https://storage.googleapis.com/" + bucket + "/" + urllib.parse.quote(object_key, safe="/")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def md5_b64(data):
    return base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode()


def relevant_headers(headers):
    lower = {key.lower(): value for key, value in headers.items()}
    return {key: lower.get(key) for key in ("content-encoding", "content-length", "content-range")}


def read_metadata(bucket, key, token):
    status, raw, _ = request("GET", metadata_url(bucket, key), token)
    require(status == 200, f"metadata read for {key} returned HTTP {status}")
    value = json.loads(raw)
    require(isinstance(value, dict) and value.get("name") == key, "metadata object identity differs")
    return value


def upload(bucket, label, key, body, content_type, encoding, cache_control, token):
    headers = {"Content-Type": content_type, "x-goog-if-generation-match": "0"}
    if encoding is not None:
        headers["Content-Encoding"] = encoding
    if cache_control is not None:
        headers["Cache-Control"] = cache_control
    status, _, _ = request("PUT", object_url(bucket, key), token, body, headers)
    require(status == 200, f"fixture upload {label} returned HTTP {status}")
    meta = read_metadata(bucket, key, token)
    require(meta.get("size") == str(len(body)), f"fixture {label} size differs")
    require(meta.get("md5Hash") == md5_b64(body), f"fixture {label} md5 differs")
    require(isinstance(meta.get("crc32c"), str) and bool(meta["crc32c"]), f"fixture {label} CRC32C missing")
    require(isinstance(meta.get("generation"), str) and re.fullmatch(r"[1-9][0-9]*", meta["generation"]),
            f"fixture {label} generation missing")
    require(meta.get("metageneration") == "1", f"fixture {label} metageneration differs")
    require(meta.get("contentType") == content_type, f"fixture {label} content type differs")
    require(meta.get("contentEncoding") == encoding, f"fixture {label} content encoding differs")
    require(meta.get("cacheControl") == cache_control, f"fixture {label} cache control differs")
    return {name: meta.get(name) for name in ("generation", "metageneration", "md5Hash", "crc32c", "size",
                                              "contentType", "contentEncoding", "cacheControl")}


def control_read(bucket, key, token, headers=None):
    status, body, response_headers = request("GET", object_url(bucket, key), token, headers=headers)
    return {"status": status, "bytes": len(body), "sha256": sha(body), "headers": relevant_headers(response_headers)}


def large_hashes(seed):
    """Independently compute AES-256-CTR bytes using OpenSSL, without a large file."""
    zeros = subprocess.Popen(["dd", "if=/dev/zero", "bs=1048576", "count=500"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        cipher = subprocess.Popen(["openssl", "enc", "-aes-256-ctr", "-nosalt", "-K", seed,
                                   "-iv", "0" * 32], stdin=zeros.stdout, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE)
        zeros.stdout.close()
        digest = hashlib.sha256()
        md5 = hashlib.md5(usedforsecurity=False)
        first = bytearray()
        total = 0
        while True:
            chunk = cipher.stdout.read(1024 * 1024)
            if not chunk:
                break
            if len(first) < 1024:
                first.extend(chunk[:1024 - len(first)])
            digest.update(chunk)
            md5.update(chunk)
            total += len(chunk)
        stderr = cipher.stderr.read()
        cipher_status = cipher.wait()
        zeros_status = zeros.wait()
        require(cipher_status == 0 and zeros_status == 0, "OpenSSL seed stream failed")
        require(total == LARGE_BYTES, "OpenSSL seed stream size differs")
        return {"sha256": digest.hexdigest(), "md5Hash": base64.b64encode(md5.digest()).decode(),
                "first_1024_sha256": sha(first), "size": total}
    finally:
        if zeros.poll() is None:
            zeros.terminate()
            zeros.wait()


def validate_bucket(bucket, name, run, attempt, candidate, expires, account_uid):
    require(isinstance(bucket, dict) and bucket.get("name") == name and
            bucket.get("labels") == {"purpose": "relic-gcs-proof", "run": run, "attempt": attempt,
                                     "candidate": candidate, "expires": expires, "account_uid": account_uid},
            "proof bucket labels differ")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--expires", required=True)
    parser.add_argument("--account-uid", required=True)
    parser.add_argument("--large-object", required=True, choices=("true", "false"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    require(BUCKET_RE.fullmatch(args.bucket) is not None, "invalid proof bucket")
    require(SHA_RE.fullmatch(args.candidate) is not None, "invalid candidate SHA")
    require(re.fullmatch(r"[1-9][0-9]{0,18}", args.expires) is not None, "invalid lease expiry")
    require(UID_RE.fullmatch(args.account_uid) is not None, "invalid proof account UID")
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[1-9][0-9]{0,18}", run) is not None and
            re.fullmatch(r"[1-9][0-9]{0,2}", attempt) is not None and
            args.bucket == f"relic-gcs-proof-{run}-{attempt}", "bucket is not this workflow run's bucket")
    token = token_from_gcloud()
    bucket_url = "https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(args.bucket, safe="")
    status, raw, _ = request("GET", bucket_url, token)
    require(status == 200, f"proof bucket read returned HTTP {status}")
    validate_bucket(json.loads(raw), args.bucket, run, attempt, args.candidate, args.expires, args.account_uid)

    labels = ("plain", "gzip-single", "gzip-double", "already-nt", "quoted-cc", "mislabeled",
              "control-single", "control-double", "control-mislabeled", "large", "vector", "absent")
    manifest = {}
    used = set()
    for label in labels:
        while True:
            identifier = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(26))
            if identifier not in used:
                used.add(identifier)
                break
        manifest[label] = identifier
    manifest["gzip-double/v2"] = manifest["gzip-double"] + "/v2"

    plain = os.urandom(1024 * 1024)
    single_plain = os.urandom(1024 * 1024)
    single = gzip.compress(single_plain, mtime=0)
    double_plain = os.urandom(1024 * 1024)
    inner = gzip.compress(double_plain, mtime=0)
    double = gzip.compress(inner, mtime=0)
    already = gzip.compress(os.urandom(1024 * 1024), mtime=0)
    quoted = gzip.compress(os.urandom(1024 * 1024), mtime=0)
    mislabeled = os.urandom(1024 * 1024)
    while mislabeled.startswith(b"\x1f\x8b"):
        mislabeled = os.urandom(1024 * 1024)
    specifications = {
        "plain": (plain, "application/octet-stream", None, None, None, 1, None),
        "gzip-single": (single, "application/octet-stream", "gzip", "private, max-age=60",
                        single_plain, 2, "no-transform, private, max-age=60"),
        "gzip-double": (double, "application/gzip", "gzip", None, inner, 2, "no-transform"),
        "gzip-double/v2": (double, "application/gzip", "gzip", None, inner, 2, "no-transform"),
        "already-nt": (already, "application/octet-stream", "gzip", "public, NO-TRANSFORM", None, 1,
                       "public, NO-TRANSFORM"),
        "quoted-cc": (quoted, "application/gzip", "gzip", 'private, custom="one,no-transform,two"',
                      None, 2, 'no-transform, private, custom="one,no-transform,two"'),
        "mislabeled": (mislabeled, "application/octet-stream", "gzip", None, None, 2, "no-transform"),
        "control-single": (single, "application/octet-stream", "gzip", "private, max-age=60", single_plain, 1,
                           "private, max-age=60"),
        "control-double": (double, "application/gzip", "gzip", None, inner, 1, None),
        "control-mislabeled": (mislabeled, "application/octet-stream", "gzip", None, None, 1, None),
    }
    fixtures = {}
    for label, (body, content_type, encoding, cache_control, inner_body, after_mg, after_cc) in specifications.items():
        key = PREFIX + "/" + manifest[label]
        meta = upload(args.bucket, label, key, body, content_type, encoding, cache_control, token)
        fixtures[label] = {"key": key, "sha256": sha(body), "first_1024_sha256": sha(body[:1024]),
                           "inner_sha256": sha(inner_body) if inner_body is not None else None,
                           "inner_bytes": len(inner_body) if inner_body is not None else None,
                           "metadata": meta, "after_metageneration": str(after_mg), "after_cache_control": after_cc}

    controls = {
        "single_no_accept": control_read(args.bucket, fixtures["control-single"]["key"], token),
        "single_gzip": control_read(args.bucket, fixtures["control-single"]["key"], token,
                                    {"Accept-Encoding": "gzip"}),
        "double_gzip": control_read(args.bucket, fixtures["control-double"]["key"], token,
                                    {"Accept-Encoding": "gzip"}),
        "double_range": control_read(args.bucket, fixtures["control-double"]["key"], token,
                                     {"Range": "bytes=0-1023"}),
        "mislabeled": control_read(args.bucket, fixtures["control-mislabeled"]["key"], token),
    }
    single_no_accept = controls["single_no_accept"]
    single_gzip = controls["single_gzip"]
    double_gzip = controls["double_gzip"]
    double_range = controls["double_range"]
    require(single_no_accept["status"] == 200 and single_no_accept["sha256"] == sha(single_plain),
            "control-single did not transcode without gzip acceptance")
    require(single_gzip["status"] == 200 and single_gzip["sha256"] == sha(single) and
            single_gzip["headers"]["content-encoding"] == "gzip", "control-single gzip response differs")
    require(double_gzip["status"] == 200 and double_gzip["sha256"] == sha(inner) and
            double_gzip["sha256"] != sha(double) and double_gzip["headers"]["content-encoding"] is None,
            "control-double did not transcode as expected")
    require(double_range["status"] == 200 and double_range["sha256"] == sha(inner) and
            double_range["bytes"] == len(inner), "control-double range was not ignored")

    seed = secrets.token_hex(32)
    large_bytes = LARGE_BYTES if args.large_object == "true" else 0
    large = large_hashes(seed) if large_bytes else None
    result = {"version": 1, "candidate": args.candidate, "bucket": args.bucket, "prefix": PREFIX,
              "manifest": manifest, "large_seed": seed, "large_bytes": large_bytes,
              "fixtures": fixtures, "controls": controls, "large": large}
    with open(args.output, "w", encoding="utf-8") as file:
        json.dump(result, file, separators=(",", ":"), sort_keys=True)
        file.write("\n")
    print("GCS_PROOF_FIXTURES_CREATED " + args.bucket)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"GCS_PROOF_ERROR fixtures: {error}", file=sys.stderr)
        sys.exit(1)
