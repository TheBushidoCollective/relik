resource "google_service_account" "error_report_reader" {
  project      = var.project_id
  account_id   = "relik-error-report-reader"
  display_name = "Relik error report reader"
  description  = "Reads scrubbed error reports for the issue filer."
}
