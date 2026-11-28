resource "google_logging_project_bucket_config" "error_reports" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "relik-error-reports"
  description    = "Scrubbed Relik error reports."
  retention_days = 30

  depends_on = [google_project_service.relic["logging.googleapis.com"]]
}
