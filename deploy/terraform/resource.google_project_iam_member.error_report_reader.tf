resource "google_project_iam_member" "error_report_reader" {
  project = var.project_id
  role    = "roles/logging.viewAccessor"
  member  = "serviceAccount:${google_service_account.error_report_reader.email}"

  # gcloud logging read requires serviceusage.services.use. The filer instead
  # calls entries:list on this view without a quota-project header; verify that
  # behavior in production. If REST returns a Service Usage 403, review a
  # separate roles/serviceusage.serviceUsageConsumer grant rather than adding
  # it implicitly here.
  condition {
    title       = "relik_error_report_view_only"
    description = "Read only the dedicated error report log view."
    expression  = "resource.name == \"${google_logging_project_bucket_config.error_reports.id}/views/_AllLogs\""
  }
}
