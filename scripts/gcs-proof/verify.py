#!/usr/bin/env python3
"""Validate the untrusted result, then compare it with trusted GCS observations."""
import argparse
import hashlib
import json
import os
import re
import stat as stat_module
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
BUCKET = re.compile(r"^relic-gcs-proof-[1-9][0-9]{0,18}-[1-9][0-9]{0,2}$")
DIGEST_LABELS = ("plain", "gzip-single", "gzip-double", "gzip-double/v2", "already-nt", "quoted-cc", "mislabeled")
CONTROL_LABELS = ("control-single", "control-double", "control-mislabeled")
ALL_LABELS = set(DIGEST_LABELS + CONTROL_LABELS + ("large", "vector", "absent"))
READS = ("before_single_plain", "before_single_gzip", "before_double_plain", "before_double_gzip",
         "after_double_plain", "after_double_range", "after_double_fetch")
META_KEYS = ("generation", "metageneration", "md5Hash", "crc32c", "size", "contentType",
             "contentEncoding", "cacheControl")
HEADER_KEYS = ("content-encoding", "content-length", "content-range")
LARGE_BYTES = 500 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact(value, keys, context):
    require(isinstance(value, dict) and set(value) == set(keys), f"{context} has invalid fields")


def digest(value):
    return isinstance(value, str) and HEX64.fullmatch(value) is not None


def integer(value, minimum=0, maximum=2 ** 53 - 1):
    return type(value) is int and minimum <= value <= maximum


def json_file(path, limit):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result

    with open(path, "rb") as file:
        raw = file.read(limit + 1)
    require(len(raw) <= limit, "JSON file exceeds size limit")
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid JSON constant")))


def proof_token(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        require(stat_module.S_ISREG(os.fstat(file.fileno()).st_mode), "proof token is not a regular file")
        raw = file.read(4097)
    require(re.fullmatch(rb"[\x21-\x7e]{20,4096}", raw) is not None, "invalid proof token")
    return raw.decode("ascii")


def scan_secrets(value, token):
    if isinstance(value, dict):
        for key, field in value.items():
            scan_secrets(key, token)
            scan_secrets(field, token)
    elif isinstance(value, list):
        for field in value:
            scan_secrets(field, token)
    elif isinstance(value, str):
        require(len(value) <= 4096, "result string exceeds limit")
        require(re.search(r"https?://|x-goog-signature|authorization\s*:|bearer\s+|ya29\.|eyJ[\w-]{10,}\.eyJ",
                          value, re.I) is None, "result contains credential-shaped data")
        require(not token or token not in value, "result contains the proof token")


def metadata(value, context):
    exact(value, META_KEYS, context)
    for key in META_KEYS:
        require(value[key] is None or isinstance(value[key], str), f"{context} has invalid metadata")
    for key in ("generation", "metageneration", "size"):
        require(isinstance(value[key], str) and re.fullmatch(r"[1-9][0-9]{0,19}", value[key]) is not None,
                f"{context} has invalid {key}")
    require(isinstance(value["md5Hash"], str) and
            re.fullmatch(r"[A-Za-z0-9+/]{22}==", value["md5Hash"]) is not None and
            isinstance(value["crc32c"], str) and
            re.fullmatch(r"[A-Za-z0-9+/]{6}==", value["crc32c"]) is not None,
            f"{context} has invalid checksums")
    require(value["contentType"] in ("application/octet-stream", "application/gzip",
                                     "application/x-www-form-urlencoded") and
            value["contentEncoding"] in (None, "gzip") and
            value["cacheControl"] in (None, "private, max-age=60", "public, NO-TRANSFORM",
                                       'private, custom="one,no-transform,two"', "no-transform",
                                       "no-transform, private, max-age=60",
                                       'no-transform, private, custom="one,no-transform,two"'),
            f"{context} has unexpected object headers")


def stat(value, context):
    require(isinstance(value, dict) and set(value) in ({"length", "crc32c"},
                                                      {"length", "crc32c", "generation"}), f"{context} has invalid fields")
    require(integer(value["length"]) and isinstance(value["crc32c"], str) and
            (value["crc32c"] == "" or re.fullmatch(r"[A-Za-z0-9+/]{6}==", value["crc32c"]) is not None),
            f"{context} is invalid")
    if "generation" in value:
        require(isinstance(value["generation"], str) and
                re.fullmatch(r"[1-9][0-9]{0,19}", value["generation"]) is not None, f"{context} generation is invalid")


def observation(value, context):
    exact(value, ("status", "bytes", "sha256", "headers"), context)
    require(integer(value["status"], 100, 599) and integer(value["bytes"], 0, 3 * 1024 * 1024) and
            digest(value["sha256"]), f"{context} is invalid")
    exact(value["headers"], HEADER_KEYS, context + " headers")
    headers = value["headers"]
    require(headers["content-encoding"] in (None, "gzip") and
            (headers["content-length"] is None or
             isinstance(headers["content-length"], str) and re.fullmatch(r"[0-9]{1,20}", headers["content-length"])) and
            (headers["content-range"] is None or isinstance(headers["content-range"], str) and
             re.fullmatch(r"bytes [0-9]+-[0-9]+/[0-9]+", headers["content-range"])),
            f"{context} has invalid headers")


def validate_result(value, candidate, token):
    require(HEX40.fullmatch(candidate) is not None, "candidate SHA is invalid")
    scan_secrets(value, token)
    exact(value, ("version", "candidate", "bucket", "runtime", "reads", "stats", "digests", "repeat_single",
                  "preconditions", "absent", "large", "vector"), "result")
    require(type(value["version"]) is int and value["version"] == 1 and value["candidate"] == candidate and
            isinstance(value["bucket"], str) and BUCKET.fullmatch(value["bucket"]) is not None,
            "result identity differs")
    exact(value["runtime"], ("bun",), "runtime")
    require(isinstance(value["runtime"]["bun"], str) and
            re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value["runtime"]["bun"]) is not None, "invalid Bun version")
    exact(value["reads"], READS, "reads")
    for key in READS:
        observation(value["reads"][key], key)
    exact(value["stats"], ("single_before", "single_after"), "stats")
    for key in value["stats"]:
        stat(value["stats"][key], key)
    exact(value["digests"], DIGEST_LABELS, "digests")
    for key, entry in value["digests"].items():
        exact(entry, ("digest", "metadata"), key)
        require(digest(entry["digest"]), f"{key} digest is invalid")
        metadata(entry["metadata"], key)
    repeat = value["repeat_single"]
    exact(repeat, ("digest", "metadata"), "repeat_single")
    require(digest(repeat["digest"]), "repeat digest is invalid")
    metadata(repeat["metadata"], "repeat_single")
    conditions = value["preconditions"]
    exact(conditions, ("metageneration", "generation", "json_patch", "metadata"), "preconditions")
    require(all(type(conditions[key]) is int and conditions[key] == 412 for key in
                ("metageneration", "generation", "json_patch")), "stale preconditions did not return 412")
    metadata(conditions["metadata"], "precondition metadata")
    require(value["absent"] is None, "absent digest differs")
    large = value["large"]
    if large is not None:
        exact(large, ("upload_status", "signed_headers", "stat", "digest", "metadata", "memory_baseline",
                      "memory_peak"), "large")
        require(large["upload_status"] == 200 and large["signed_headers"] == "content-length;host" and
                digest(large["digest"]) and integer(large["memory_baseline"], 1) and
                integer(large["memory_peak"], large["memory_baseline"]), "large result is invalid")
        stat(large["stat"], "large stat")
        metadata(large["metadata"], "large metadata")
    vector = value["vector"]
    exact(vector, ("status", "upload_sha256", "metadata", "digest", "metadata_after_digest"), "vector")
    require(integer(vector["status"], 100, 599) and digest(vector["upload_sha256"]), "vector result is invalid")
    if vector["status"] == 200:
        metadata(vector["metadata"], "vector metadata")
        if vector["metadata"]["contentEncoding"] is not None:
            require(digest(vector["digest"]), "encoded vector digest is invalid")
            metadata(vector["metadata_after_digest"], "vector metadata after digest")
        else:
            require(vector["digest"] is None and vector["metadata_after_digest"] is None,
                    "unencoded vector has unexpected digest fields")
    else:
        require(vector["metadata"] is None and vector["digest"] is None and
                vector["metadata_after_digest"] is None, "failed vector upload has metadata")
    return value


def expected_manifest(value, candidate):
    exact(value, ("version", "candidate", "bucket", "prefix", "manifest", "large_seed", "large_bytes",
                  "fixtures", "controls", "large"), "expected")
    require(type(value["version"]) is int and value["version"] == 1 and value["candidate"] == candidate and value["prefix"] == "r" and
            isinstance(value["bucket"], str) and BUCKET.fullmatch(value["bucket"]) is not None,
            "expected identity differs")
    require(isinstance(value["large_seed"], str) and HEX64.fullmatch(value["large_seed"]) is not None and
            type(value["large_bytes"]) is int and value["large_bytes"] in (0, LARGE_BYTES), "invalid large setup")
    manifest = value["manifest"]
    exact(manifest, ALL_LABELS, "manifest")
    used = set()
    for label, identifier in manifest.items():
        require(isinstance(identifier, str), "invalid manifest identifier")
        if label == "gzip-double/v2":
            require(identifier == manifest["gzip-double"] + "/v2", "versioned identifier differs")
        else:
            require(re.fullmatch(r"[a-z]{26}", identifier) is not None and identifier not in used,
                    "invalid or duplicate identifier")
            used.add(identifier)
    exact(value["fixtures"], DIGEST_LABELS + CONTROL_LABELS, "fixtures")
    for label, fixture in value["fixtures"].items():
        exact(fixture, ("key", "sha256", "first_1024_sha256", "inner_sha256", "inner_bytes", "metadata",
                        "after_metageneration", "after_cache_control"), label)
        require(fixture["key"] == "r/" + manifest[label] and digest(fixture["sha256"]) and
                digest(fixture["first_1024_sha256"]), f"invalid expected fixture {label}")
        require((fixture["inner_sha256"] is None and fixture["inner_bytes"] is None) or
                (digest(fixture["inner_sha256"]) and integer(fixture["inner_bytes"], 1)),
                f"invalid expected inner data for {label}")
        metadata(fixture["metadata"], label)
        require(fixture["after_metageneration"] in ("1", "2") and
                (fixture["after_cache_control"] is None or isinstance(fixture["after_cache_control"], str)),
                f"invalid expected metadata for {label}")
    exact(value["controls"], ("single_no_accept", "single_gzip", "double_gzip", "double_range", "mislabeled"),
          "controls")
    for key, entry in value["controls"].items():
        observation(entry, "control " + key)
    if value["large_bytes"]:
        large = value["large"]
        exact(large, ("sha256", "md5Hash", "first_1024_sha256", "size"), "expected large")
        require(digest(large["sha256"]) and digest(large["first_1024_sha256"]) and
                isinstance(large["md5Hash"], str) and bool(large["md5Hash"]) and large["size"] == LARGE_BYTES,
                "invalid expected large")
    else:
        require(value["large"] is None, "disabled large fixture has expected hashes")


def token_from_gcloud():
    result = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, check=True)
    token = result.stdout.strip()
    require(bool(token) and "\n" not in token and "\r" not in token, "missing deployer token")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print("::add-mask::" + token, flush=True)
    return token


def request(url, token, headers=None):
    fields = {"Authorization": "Bearer " + token}
    fields.update(headers or {})
    req = urllib.request.Request(url, headers=fields, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return response.status, response.read(3 * 1024 * 1024 + 1), dict(response.headers.items())
    except urllib.error.HTTPError as error:
        return error.code, error.read(3 * 1024 * 1024 + 1), dict(error.headers.items())


def current_metadata(bucket, key, token):
    url = ("https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(bucket, safe="") +
           "/o/" + urllib.parse.quote(key, safe=""))
    status, body, _ = request(url, token)
    require(status == 200, f"metadata read returned HTTP {status}")
    obj = json.loads(body)
    require(isinstance(obj, dict) and obj.get("name") == key, "metadata object identity differs")
    result = {name: obj.get(name) for name in META_KEYS}
    metadata(result, "current metadata")
    return result


def compare_read(read, expected_hash, status, size=None, encoding=None):
    require(read["status"] == status and read["sha256"] == expected_hash, "signed read content differs")
    if size is not None:
        require(read["bytes"] == size, "signed read size differs")
    require(read["headers"]["content-encoding"] == encoding, "signed read content encoding differs")


def verify(expected, result, candidate, scope_ok):
    expected_manifest(expected, candidate)
    validate_result(result, candidate, None)
    require(scope_ok == "true", "scope check did not pass")
    require(result["bucket"] == expected["bucket"], "result bucket differs")
    bucket = expected["bucket"]
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[1-9][0-9]{0,18}", run) is not None and
            re.fullmatch(r"[1-9][0-9]{0,2}", attempt) is not None and
            bucket == f"relic-gcs-proof-{run}-{attempt}", "bucket is not this workflow run's bucket")
    token = token_from_gcloud()
    fixtures = expected["fixtures"]
    current = {}
    for label, fixture in fixtures.items():
        actual = current_metadata(bucket, fixture["key"], token)
        current[label] = actual
        original = fixture["metadata"]
        for field in ("generation", "md5Hash", "crc32c", "size", "contentType", "contentEncoding"):
            require(actual[field] == original[field], f"{label} {field} changed")
        require(actual["metageneration"] == fixture["after_metageneration"] and
                actual["cacheControl"] == fixture["after_cache_control"], f"{label} metadata update differs")
        if label in DIGEST_LABELS:
            require(result["digests"][label]["digest"] == fixture["sha256"] and
                    result["digests"][label]["metadata"] == actual, f"{label} digest or metadata differs")
    double = fixtures["gzip-double"]
    single = fixtures["gzip-single"]
    require(double["sha256"] != double["inner_sha256"] and
            result["digests"]["gzip-double"]["digest"] != double["inner_sha256"],
            "double-compressed digest equals its inner layer")
    require(result["repeat_single"]["digest"] == single["sha256"] and
            result["repeat_single"]["metadata"] == current["gzip-single"], "repeat changed single metadata")
    require(result["preconditions"]["metadata"] == current["gzip-single"] and
            current["gzip-single"]["metageneration"] == "2", "stale precondition changed metadata")
    for stat_value in result["stats"].values():
        if "generation" in stat_value:
            require(stat_value["generation"] == single["metadata"]["generation"], "single stat generation differs")

    reads = result["reads"]
    compare_read(reads["before_single_plain"], single["inner_sha256"], 200, single["inner_bytes"])
    compare_read(reads["before_single_gzip"], single["sha256"], 200, int(single["metadata"]["size"]), "gzip")
    compare_read(reads["before_double_plain"], double["inner_sha256"], 200, double["inner_bytes"])
    compare_read(reads["before_double_gzip"], double["inner_sha256"], 200, double["inner_bytes"])
    compare_read(reads["after_double_plain"], double["sha256"], 200, int(double["metadata"]["size"]), "gzip")
    require(reads["after_double_plain"]["headers"]["content-length"] == double["metadata"]["size"],
            "post-digest content length differs")
    compare_read(reads["after_double_range"], double["first_1024_sha256"], 206, 1024, "gzip")
    require(reads["after_double_range"]["headers"]["content-range"] ==
            "bytes 0-1023/" + double["metadata"]["size"], "range content-range differs")
    require(reads["after_double_fetch"]["status"] == 200 and
            reads["after_double_fetch"]["sha256"] == double["inner_sha256"] and
            reads["after_double_fetch"]["bytes"] == double["inner_bytes"], "Bun decompressed fetch differs")

    control = fixtures["control-double"]
    control_url = ("https://storage.googleapis.com/" + bucket + "/" +
                   urllib.parse.quote(control["key"], safe="/"))
    status, body, headers = request(control_url, token, {"Accept-Encoding": "gzip"})
    header_map = {key.lower(): value for key, value in headers.items()}
    require(status == 200 and len(body) == control["inner_bytes"] and
            hashlib.sha256(body).hexdigest() == control["inner_sha256"] and
            hashlib.sha256(body).hexdigest() != control["sha256"] and
            "content-encoding" not in header_map, "control-double no longer transcodes")
    absent_url = ("https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(bucket, safe="") +
                  "/o/" + urllib.parse.quote("r/" + expected["manifest"]["absent"], safe=""))
    status, _, _ = request(absent_url, token)
    require(status == 404 and result["absent"] is None, "absent object exists")

    large_expected = expected["large"]
    large = result["large"]
    if expected["large_bytes"]:
        require(large is not None, "large proof missing")
        large_meta = current_metadata(bucket, "r/" + expected["manifest"]["large"], token)
        require(large["metadata"] == large_meta and large_meta["size"] == str(LARGE_BYTES) and
                large_meta["md5Hash"] == large_expected["md5Hash"] and large_meta["metageneration"] == "1" and
                large_meta["contentEncoding"] is None and large_meta["cacheControl"] is None and
                large["digest"] == large_expected["sha256"], "large content or metadata differs")
        require(large["stat"]["length"] == LARGE_BYTES and large["stat"].get("generation") == large_meta["generation"] and
                large["stat"]["crc32c"] == large_meta["crc32c"], "large stat differs")
        require(large["memory_peak"] - large["memory_baseline"] <= 256 * 1024 * 1024,
                "large digest exceeded peak memory bound")
    else:
        require(large is None, "unexpected large result")

    vector = result["vector"]
    if vector["status"] == 200:
        current_vector = current_metadata(bucket, "r/" + expected["manifest"]["vector"], token)
        require(current_vector["size"] == "1024", "vector stored size differs")
        if vector["digest"] is not None:
            require(vector["digest"] == vector["upload_sha256"] and
                    current_vector == vector["metadata_after_digest"], "encoded vector digest differs")
        else:
            require(current_vector == vector["metadata"], "vector metadata differs")
    print("GCS_PROOF_CHECKS_PASSED candidate=" + candidate + " bucket=" + bucket)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--result", required=True)
    validate_parser.add_argument("--candidate", required=True)
    validate_parser.add_argument("--token-file", required=True)
    check_parser = sub.add_parser("check")
    check_parser.add_argument("--expected", required=True)
    check_parser.add_argument("--result", required=True)
    check_parser.add_argument("--candidate", required=True)
    check_parser.add_argument("--scope-ok", required=True)
    args = parser.parse_args()
    result = json_file(args.result, 256 * 1024)
    if args.command == "validate":
        token = proof_token(args.token_file)
        validated = validate_result(result, args.candidate, token)
        print(json.dumps(validated, sort_keys=True, separators=(",", ":")))
    else:
        expected = json_file(args.expected, 256 * 1024)
        verify(expected, result, args.candidate, args.scope_ok)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"GCS_PROOF_ERROR verify: {error}", file=sys.stderr)
        sys.exit(1)
