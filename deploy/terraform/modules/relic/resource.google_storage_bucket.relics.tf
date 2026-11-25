resource "google_storage_bucket" "relics" {
  project  = var.project_id
  name     = var.bucket_name
  location = var.region

  # No object ACLs, and no way to make one public by accident. The only path
  # to an object is a signed URL the app server minted.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Expiry is per relic, and the rules below act on each object's
  # `customTime`. The app sets `customTime` to a private relic's expiry on
  # every object it writes for that relic: the ciphertext, the relic row, and
  # the wraps, seals, grants, requests, comments and decisions that name it.
  # Each rule erases the object one day after its `customTime`. Public signing
  # records also carry a deadline when the relik has a finite lifetime; other
  # public objects do not. A never-expiring relik's records carry no deadline.
  # The application refuses an expired relic at mint.
  #
  # Erasure is not the end of recoverability while soft delete (below) keeps
  # deleted objects, so read that window as part of the erasure.

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

  # Private relic objects and signing records of finite-lived public reliks.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_custom_time = 1
      matches_prefix = [
        "${local.ciphertext_prefix}/",
        "${local.store_prefix}/relic/",
        "${local.store_prefix}/wrap/",
        "${local.store_prefix}/seal/",
        "${local.store_prefix}/grant/",
        "${local.store_prefix}/grant-by-grantee/",
        "${local.store_prefix}/access-request/",
        "${local.store_prefix}/owner-relic/",
        "${local.store_prefix}/comment/",
        "${local.store_prefix}/author_relic/",
        "${local.store_prefix}/commenter/",
        "${local.store_prefix}/decision/",
        "${local.store_prefix}/share/",
        "${local.store_prefix}/settings/",
        "${local.store_prefix}/signing/",
        "${local.store_prefix}/receipt/",
        "${local.store_prefix}/optout/",
      ]
    }
  }

  # The owner's access log and the spent device-request nonces. An access
  # event's `customTime` is one day before its retention ends, so it is erased
  # on the day it stops being retained. A nonce's `customTime` is the end of
  # its freshness window, so it is erased one day after it could last pass.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_custom_time = 1
      matches_prefix = [
        "${local.store_prefix}/access/",
        "${local.store_prefix}/device-nonce/",
      ]
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
  # Browser uploads use signed PUTs only from the service origin. Private
  # uploads sign their expiry in x-goog-custom-time for lifecycle deletion.
  cors {
    origin          = [var.service_url]
    method          = ["GET", "HEAD", "PUT"]
    response_header = ["Content-Type", "Content-Length", "Content-Range", "ETag", "x-goog-hash", "x-goog-custom-time", "x-goog-if-generation-match"]
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
