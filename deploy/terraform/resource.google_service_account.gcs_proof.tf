locals {
  # A pool-wide ref attribute could match identities from unrelated providers.
  wif_pool = regex("^(projects/.+/workloadIdentityPools/[^/]+)/providers/[^/]+$", var.wif_provider)[0]
}

resource "google_service_account" "gcs_proof" {
  project      = var.project_id
  account_id   = "relic-gcs-proof"
  display_name = "Relic GCS proof"
  description  = "Signs GCS proof requests with short-lived credentials. Bucket access is granted per run."
}

# The proof identity signs its own blobs for signed URL verification.
resource "google_service_account_iam_member" "gcs_proof_token_creator" {
  service_account_id = google_service_account.gcs_proof.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.gcs_proof.email}"
}

# Limit impersonation to this repository's immutable GitHub ID in the configured pool.
resource "google_service_account_iam_member" "gcs_proof_workload_identity_user" {
  service_account_id = google_service_account.gcs_proof.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool}/attribute.repository_id/${var.github_repository_id}"
}
