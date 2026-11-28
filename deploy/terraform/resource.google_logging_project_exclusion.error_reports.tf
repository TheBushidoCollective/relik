resource "google_logging_project_exclusion" "error_reports" {
  project     = var.project_id
  name        = "relik-error-reports"
  description = "Keep dedicated error reports out of the default log bucket."
  filter      = google_logging_project_sink.error_reports.filter
}
