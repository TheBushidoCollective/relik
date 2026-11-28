resource "google_logging_project_sink" "error_reports" {
  project     = var.project_id
  name        = "relik-error-reports"
  description = "Route scrubbed Relik error reports to their dedicated bucket."
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.error_reports.id}"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=(\"${local.service_name}\" OR \"${local.usercontent_name}\" OR \"${module.presence.name}\") AND log_id(\"run.googleapis.com/stdout\") AND jsonPayload.event=\"relik.error_report.v1\""
}
