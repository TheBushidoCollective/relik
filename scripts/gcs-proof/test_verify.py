import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock


HERE = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load_module("gcs_proof_fixtures", "fixtures.py")
verify = load_module("gcs_proof_verify", "verify.py")
CANDIDATE = "a" * 40
BUCKET = "relic-gcs-proof-123-2"
TOKEN = "local_proof_token_0123456789"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def observation(status, body, encoding=None, content_range=None):
    return {
        "status": status,
        "bytes": len(body),
        "sha256": sha(body),
        "headers": {
            "content-encoding": encoding,
            "content-length": str(len(body)),
            "content-range": content_range,
        },
    }


def proof_data():
    """Construct a complete, deterministic small proof with independent raw bytes."""
    labels = [label for label in verify.DIGEST_LABELS + verify.CONTROL_LABELS
              if label != "gzip-double/v2"] + ["large", "vector", "absent"]
    manifest = {label: chr(ord("a") + index) * 26 for index, label in enumerate(labels)}
    manifest["gzip-double/v2"] = manifest["gzip-double"] + "/v2"

    single = b"single stored bytes" * 80
    single_inner = b"single transcoded bytes" * 50
    double = bytes(range(256)) * 5
    double_inner = b"double transcoded bytes" * 60
    bodies = {label: ("fixture " + label).encode() * 20
              for label in verify.DIGEST_LABELS + verify.CONTROL_LABELS}
    bodies.update({"gzip-single": single, "control-single": single,
                   "gzip-double": double, "gzip-double/v2": double, "control-double": double})
    specifications = {
        "plain": (None, None, None, None),
        "gzip-single": ("gzip", "private, max-age=60", "no-transform, private, max-age=60", single_inner),
        "gzip-double": ("gzip", None, "no-transform", double_inner),
        "gzip-double/v2": ("gzip", None, "no-transform", double_inner),
        "already-nt": ("gzip", "public, NO-TRANSFORM", "public, NO-TRANSFORM", None),
        "quoted-cc": ("gzip", 'private, custom="one,no-transform,two"',
                      'no-transform, private, custom="one,no-transform,two"', None),
        "mislabeled": ("gzip", None, "no-transform", None),
        "control-single": ("gzip", "private, max-age=60", "private, max-age=60", single_inner),
        "control-double": ("gzip", None, None, double_inner),
        "control-mislabeled": ("gzip", None, None, None),
    }
    expected_fixtures = {}
    current = {}
    for index, (label, body) in enumerate(bodies.items()):
        encoding, original_cc, final_cc, inner = specifications[label]
        content_type = "application/gzip" if label in ("gzip-double", "gzip-double/v2",
                                                       "quoted-cc", "control-double") else "application/octet-stream"
        original = {
            "generation": str(123456 + index),
            "metageneration": "1",
            "md5Hash": base64.b64encode(hashlib.md5(body, usedforsecurity=False).digest()).decode(),
            "crc32c": "AAAAAA==",
            "size": str(len(body)),
            "contentType": content_type,
            "contentEncoding": encoding,
            "cacheControl": original_cc,
        }
        changed = final_cc != original_cc
        final = dict(original, metageneration="2" if changed else "1", cacheControl=final_cc)
        key = "r/" + manifest[label]
        expected_fixtures[label] = {
            "key": key,
            "sha256": sha(body),
            "first_1024_sha256": sha(body[:1024]),
            "inner_sha256": sha(inner) if inner is not None else None,
            "inner_bytes": len(inner) if inner is not None else None,
            "metadata": original,
            "after_metageneration": final["metageneration"],
            "after_cache_control": final_cc,
        }
        current[key] = final

    controls = {name: observation(200, b"control") for name in
                ("single_no_accept", "single_gzip", "double_gzip", "double_range", "mislabeled")}
    expected = {"version": 1, "candidate": CANDIDATE, "bucket": BUCKET, "prefix": "r",
                "manifest": manifest, "large_seed": "b" * 64, "large_bytes": 0,
                "fixtures": expected_fixtures, "controls": controls, "large": None}
    single_stat = {"length": len(single), "crc32c": "AAAAAA==",
                   "generation": expected_fixtures["gzip-single"]["metadata"]["generation"]}
    single_metadata = current[expected_fixtures["gzip-single"]["key"]]
    result = {
        "version": 1,
        "candidate": CANDIDATE,
        "bucket": BUCKET,
        "runtime": {"bun": "1.4.3"},
        "reads": {
            "before_single_plain": observation(200, single_inner),
            "before_single_gzip": observation(200, single, "gzip"),
            "before_double_plain": observation(200, double_inner),
            "before_double_gzip": observation(200, double_inner),
            "after_double_plain": observation(200, double, "gzip"),
            "after_double_range": observation(206, double[:1024], "gzip", f"bytes 0-1023/{len(double)}"),
            "after_double_fetch": observation(200, double_inner),
        },
        "stats": {"single_before": single_stat, "single_after": single_stat},
        "digests": {label: {"digest": expected_fixtures[label]["sha256"],
                            "metadata": current[expected_fixtures[label]["key"]]}
                    for label in verify.DIGEST_LABELS},
        "repeat_single": {"digest": sha(single), "metadata": single_metadata},
        "preconditions": {"metageneration": 412, "generation": 412, "json_patch": 412,
                          "metadata": single_metadata},
        "absent": None,
        "large": None,
        "vector": {"status": 403, "upload_sha256": sha(b"vector"), "metadata": None,
                   "digest": None, "metadata_after_digest": None},
    }
    return expected, result, current, double_inner


class SecretScanTests(unittest.TestCase):
    def test_safe_values_and_nested_secret_shapes(self):
        verify.scan_secrets({"plain": ["1.4.3", {"safe": "abc-123"}]}, TOKEN)
        samples = ["ya29.other_access_token", "YA29.other_access_token",
                   "eyJabcdefghijk.eyJpayload.signature", "EYJabcdefghijk.EYJpayload",
                   "https://storage.googleapis.com/object", "X-Goog-Signature=secret",
                   "Authorization: secret", "Bearer secret", TOKEN]
        for sample in samples:
            with self.subTest(sample=sample):
                with self.assertRaises(ValueError):
                    verify.scan_secrets({"outer": [{"nested": sample}]}, TOKEN)
                with self.assertRaises(ValueError):
                    verify.scan_secrets({sample: "nested key"}, TOKEN)

    def test_leak_scan_runs_before_schema_rejection(self):
        _, result, _, _ = proof_data()
        for value in ("1.4.3 ya29.abc", "1.4.3 eyJabcdefghijk.eyJpayload", "1.4.3 " + TOKEN):
            with self.subTest(value=value):
                mutated = copy.deepcopy(result)
                mutated["runtime"]["bun"] = value
                with self.assertRaisesRegex(ValueError, "result contains"):
                    verify.validate_result(mutated, CANDIDATE, TOKEN)

    def test_token_file_and_bounded_json(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_bytes(TOKEN.encode())
            self.assertEqual(verify.proof_token(token_file), TOKEN)
            for data in (b"", b"x" * 19, b"x" * 4097, b"x" * 20 + b"\n", b"x" * 20 + b"\x80"):
                token_file.write_bytes(data)
                with self.subTest(data_length=len(data)), self.assertRaises(ValueError):
                    verify.proof_token(token_file)
            token_file.write_bytes(TOKEN.encode())
            link = Path(directory) / "link"
            link.symlink_to(token_file)
            with self.assertRaises(OSError):
                verify.proof_token(link)
            data_file = Path(directory) / "data.json"
            for data in (b'{"a":1,"a":2}', b'{"a":NaN}', b" " * 17):
                data_file.write_bytes(data)
                with self.subTest(json=data), self.assertRaises(ValueError):
                    verify.json_file(data_file, 16)

    def test_validate_cli_reads_file_and_never_echoes_leak(self):
        _, result, _, _ = proof_data()
        with tempfile.TemporaryDirectory() as directory:
            result_file = Path(directory) / "result.json"
            token_file = Path(directory) / "token"
            token_file.write_text(TOKEN, encoding="ascii")
            result_file.write_text(json.dumps(result), encoding="utf-8")
            command = [sys.executable, str(HERE / "verify.py"), "validate", "--result", str(result_file),
                       "--candidate", CANDIDATE, "--token-file", str(token_file)]
            completed = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout), result)
            self.assertNotIn(TOKEN, completed.stdout + completed.stderr)
            result["runtime"]["bun"] = "1.4.3 ya29.leaked_token"
            result_file.write_text(json.dumps(result), encoding="utf-8")
            completed = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("result contains credential-shaped data", completed.stderr)
            self.assertNotIn("ya29.leaked_token", completed.stdout + completed.stderr)


class IdentityTests(unittest.TestCase):
    def test_harness_accepts_only_matching_per_run_identity(self):
        cases = [
            [BUCKET, "rgp-123-2@project-123.iam.gserviceaccount.com", "project-123", True],
            [BUCKET, "relic-gcs-proof@project-123.iam.gserviceaccount.com", "project-123", False],
            [BUCKET, "rgp-124-2@project-123.iam.gserviceaccount.com", "project-123", False],
            [BUCKET, "rgp-123-3@project-123.iam.gserviceaccount.com", "project-123", False],
            [BUCKET, "rgp-123-2@other-project.iam.gserviceaccount.com", "project-123", False],
            [BUCKET, "rgp-123-2@project-123.iam.gserviceaccount.com.evil", "project-123", False],
            [BUCKET, "rgp-123-2@PROJ.iam.gserviceaccount.com", "PROJ", False],
            ["relic-gcs-proof-0123-2", "rgp-0123-2@project-123.iam.gserviceaccount.com", "project-123", False],
            ["relic-gcs-proof-123-0", "rgp-123-0@project-123.iam.gserviceaccount.com", "project-123", False],
            ["relic-gcs-proof-123-1000", "rgp-123-1000@project-123.iam.gserviceaccount.com", "project-123", False],
            ["relic-gcs-proof-12345678901234567890-1",
             "rgp-12345678901234567890-1@project-123.iam.gserviceaccount.com", "project-123", False],
        ]
        script = f"""
          const {{ validateProofIdentity }} = await import({json.dumps(str(HERE / 'harness.ts'))});
          for (const [bucket, email, project, expected] of {json.dumps(cases)}) {{
            let accepted = true;
            try {{ validateProofIdentity(bucket, email, project); }} catch {{ accepted = false; }}
            if (accepted !== expected) throw new Error(`identity case failed: ${{bucket}} ${{email}}`);
          }}
        """
        completed = subprocess.run(["bun", "--eval", script], capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_fixture_labels_include_exact_expiry(self):
        labels = {"purpose": "relic-gcs-proof", "run": "123", "attempt": "2",
                  "candidate": CANDIDATE, "expires": "1800007200"}
        bucket = {"name": BUCKET, "labels": labels}
        fixtures.validate_bucket(bucket, BUCKET, "123", "2", CANDIDATE, "1800007200")
        for wrong in ({**labels, "expires": "1800007201"},
                      {key: value for key, value in labels.items() if key != "expires"},
                      {**labels, "expires": 1800007200}, {**labels, "foreign": "extra"},
                      {**labels, "run": "124"}, {**labels, "attempt": "3"},
                      {**labels, "candidate": "b" * 40}, {**labels, "purpose": "other"}):
            with self.subTest(labels=wrong), self.assertRaises(ValueError):
                fixtures.validate_bucket({"name": BUCKET, "labels": wrong}, BUCKET,
                                         "123", "2", CANDIDATE, "1800007200")
        with self.assertRaises(ValueError):
            fixtures.validate_bucket({"name": "other-bucket", "labels": labels}, BUCKET,
                                     "123", "2", CANDIDATE, "1800007200")

    def test_fixture_rejects_bad_lease_before_upload(self):
        args = ["fixtures.py", "--bucket", BUCKET, "--candidate", CANDIDATE,
                "--expires", "1800007200", "--large-object", "false", "--output", "unused"]
        wrong = {"name": BUCKET, "labels": {"purpose": "relic-gcs-proof", "run": "123", "attempt": "2",
                                             "candidate": CANDIDATE, "expires": "1800007201"}}
        with mock.patch.object(sys, "argv", args), \
             mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}), \
             mock.patch.object(fixtures, "token_from_gcloud", return_value=TOKEN), \
             mock.patch.object(fixtures, "request", return_value=(200, json.dumps(wrong).encode(), {})) as request:
            with self.assertRaisesRegex(ValueError, "labels differ"):
                fixtures.main()
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[0], "GET")

    def test_fixture_rejects_invalid_expiry_and_run_before_credentials(self):
        for expiry, run, attempt in (("0", "123", "2"), ("01", "123", "2"),
                                     ("1800007200\n", "123", "2"), ("1800007200", "0123", "2"),
                                     ("1800007200", "123", "1000")):
            args = ["fixtures.py", "--bucket", BUCKET, "--candidate", CANDIDATE,
                    "--expires", expiry, "--large-object", "false", "--output", "unused"]
            with self.subTest(expiry=expiry, run=run, attempt=attempt), \
                 mock.patch.object(sys, "argv", args), \
                 mock.patch.dict(os.environ, {"GITHUB_RUN_ID": run, "GITHUB_RUN_ATTEMPT": attempt}), \
                 mock.patch.object(fixtures, "token_from_gcloud") as token:
                with self.assertRaises(ValueError):
                    fixtures.main()
                token.assert_not_called()


class IndependentVerificationTests(unittest.TestCase):
    def run_check(self, expected, result, current, double_inner, scope="true", absent_status=404):
        def request(url, token, headers=None):
            self.assertEqual(token, TOKEN)
            if "/storage/v1/b/" in url:
                return absent_status, b"", {}
            self.assertEqual(headers, {"Accept-Encoding": "gzip"})
            return 200, double_inner, {"Content-Type": "application/gzip"}

        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}), \
             mock.patch.object(verify, "token_from_gcloud", return_value=TOKEN), \
             mock.patch.object(verify, "current_metadata", side_effect=lambda bucket, key, token: current[key]), \
             mock.patch.object(verify, "request", side_effect=request), redirect_stdout(io.StringIO()) as stdout:
            verify.verify(expected, result, CANDIDATE, scope)
            return stdout.getvalue()

    def test_valid_proof_passes_independent_observations(self):
        expected, result, current, double_inner = proof_data()
        self.assertIn("GCS_PROOF_CHECKS_PASSED", self.run_check(expected, result, current, double_inner))

    def test_wrong_stored_hash_and_metadata_fail(self):
        expected, result, current, double_inner = proof_data()
        result = copy.deepcopy(result)
        result["digests"]["gzip-double"]["digest"] = expected["fixtures"]["gzip-double"]["inner_sha256"]
        with self.assertRaisesRegex(ValueError, "digest or metadata differs"):
            self.run_check(expected, result, current, double_inner)
        expected, result, current, double_inner = proof_data()
        key = expected["fixtures"]["gzip-single"]["key"]
        current = copy.deepcopy(current)
        current[key]["metageneration"] = "1"
        with self.assertRaisesRegex(ValueError, "metadata update differs"):
            self.run_check(expected, result, current, double_inner)

    def test_transcoding_control_scope_and_absence_fail_closed(self):
        expected, result, current, double_inner = proof_data()
        with self.assertRaisesRegex(ValueError, "control-double no longer transcodes"):
            self.run_check(expected, result, current, b"wrong bytes")
        with self.assertRaisesRegex(ValueError, "scope check did not pass"):
            self.run_check(expected, result, current, double_inner, scope="false")
        with self.assertRaisesRegex(ValueError, "absent object exists"):
            self.run_check(expected, result, current, double_inner, absent_status=403)
        with self.assertRaisesRegex(ValueError, "absent object exists"):
            self.run_check(expected, result, current, double_inner, absent_status=200)

    def test_wrong_run_and_duplicate_manifest_fail(self):
        expected, result, current, double_inner = proof_data()
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "124", "GITHUB_RUN_ATTEMPT": "2"}), \
             mock.patch.object(verify, "token_from_gcloud") as token:
            with self.assertRaisesRegex(ValueError, "bucket is not this workflow run"):
                verify.verify(expected, result, CANDIDATE, "true")
            token.assert_not_called()
        expected = copy.deepcopy(expected)
        expected["manifest"]["plain"] = expected["manifest"]["gzip-single"]
        with self.assertRaisesRegex(ValueError, "duplicate identifier"):
            verify.expected_manifest(expected, CANDIDATE)

    def test_large_proof_checks_independent_hash_metadata_and_rss(self):
        expected, result, current, double_inner = proof_data()
        size = verify.LARGE_BYTES
        stored_digest = sha(b"independent large fixture")
        md5 = base64.b64encode(hashlib.md5(b"independent large fixture", usedforsecurity=False).digest()).decode()
        metadata = {"generation": "987654", "metageneration": "1", "md5Hash": md5,
                    "crc32c": "AAAAAA==", "size": str(size), "contentType": "application/octet-stream",
                    "contentEncoding": None, "cacheControl": None}
        expected["large_bytes"] = size
        expected["large"] = {"sha256": stored_digest, "md5Hash": md5,
                             "first_1024_sha256": sha(b"first 1024"), "size": size}
        result["large"] = {"upload_status": 200, "signed_headers": "content-length;host",
                           "stat": {"length": size, "crc32c": "AAAAAA==", "generation": "987654"},
                           "digest": stored_digest, "metadata": copy.deepcopy(metadata),
                           "memory_baseline": 64 * 1024 * 1024, "memory_peak": 320 * 1024 * 1024}
        large_key = "r/" + expected["manifest"]["large"]
        current[large_key] = metadata
        self.assertIn("GCS_PROOF_CHECKS_PASSED", self.run_check(expected, result, current, double_inner))

        bad_result = copy.deepcopy(result)
        bad_result["large"]["digest"] = "c" * 64
        with self.assertRaisesRegex(ValueError, "large content or metadata differs"):
            self.run_check(expected, bad_result, current, double_inner)
        bad_current = copy.deepcopy(current)
        bad_current[large_key]["md5Hash"] = "AAAAAAAAAAAAAAAAAAAAAA=="
        with self.assertRaisesRegex(ValueError, "large content or metadata differs"):
            self.run_check(expected, result, bad_current, double_inner)
        bad_result = copy.deepcopy(result)
        bad_result["large"]["memory_peak"] += 1
        with self.assertRaisesRegex(ValueError, "large digest exceeded peak memory bound"):
            self.run_check(expected, bad_result, current, double_inner)


if __name__ == "__main__":
    unittest.main()
