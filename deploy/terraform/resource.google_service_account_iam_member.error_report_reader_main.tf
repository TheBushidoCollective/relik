resource "google_service_account_iam_member" "error_report_reader_main" {
  service_account_id = google_service_account.error_report_reader.name
  role               = "roles/iam.workloadIdentityUser"

  # The github pool has a shared provider that admits other repositories, so
  # a principalSet for the main ref would also admit their main-branch jobs.
  # The ref subject admits this repo's jobs only when no environment is set.
  member = "principal://iam.googleapis.com/projects/${data.google_project.relic.number}/locations/global/workloadIdentityPools/github/subject/repo:${local.error_report_github_repository}:ref:refs/heads/main"
}
