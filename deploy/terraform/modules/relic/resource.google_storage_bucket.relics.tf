resource "google_storage_bucket" "relics" {
  project  = var.project_id
  name     = var.bucket_name
  location = var.region

  # No object ACLs, and no way to make one public by accident. The only path
  # to an object is a signed URL the app server minted.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Storage-side expiry is gone. A lifecycle rule acts by age across
  # everything its condition matches, so it cannot express a per-relic
  # lifetime: scoped to the ciphertext prefix or not, it would delete
  # ciphertext for relics the publisher asked to keep. Expiry is enforced
  # only by the application, at mint. A relic with no publisher-set lifetime
  # is never deleted by storage, and an expired relic's bytes stay until
  # something explicitly deletes them.

  # Challenges (including sign-in codes and address budgets) and mint dedup
  # entries. Live for minutes, expire at the coarsest granularity a lifecycle
  # rule offers, and are refused on age by the application long before this
  # runs.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 1
      matches_prefix = local.transient_store_prefixes
    }
  }

  # Abandoned multipart uploads are billable and invisible.
  lifecycle_rule {
    action {
      type = "AbortIncompleteMultipartUpload"
    }
    condition {
      age = 1
    }
  }

  # Deleted does not mean erased, and the published disclosure says so. Set
  # explicitly because a change reaches only objects deleted after it takes
  # effect, leaving a tail nobody can retroactively clear.
  soft_delete_policy {
    retention_duration_seconds = var.soft_delete_retention_days * 86400
  }

  # The viewer's download leg is a cross-origin fetch from the service origin
  # straight to GCS. Content-Range has to be exposed or the browser cannot see
  # range responses, which is what progressive decryption runs on.
  #
  # The upload leg needs nothing here: it runs from the publisher's machine,
  # not a browser, so there is no preflight.
  cors {
    origin          = [var.service_url]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "Content-Length", "Content-Range", "ETag", "x-goog-hash"]
    max_age_seconds = 3600
  }

  versioning {
    enabled = false
  }
}

# Read, write, and delete objects. Not bucket administration: the app never
# needs to change lifecycle, CORS, or IAM, and a compromised revision should
# not be able to.
resource "google_storage_bucket_iam_member" "app_objects" {
  bucket = google_storage_bucket.relics.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}
