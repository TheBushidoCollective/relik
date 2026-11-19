resource "google_cloud_run_v2_service" "service" {
  project  = var.project_id
  location = var.region
  name     = var.name

  # The whole product is an unauthenticated link that a stranger opens, so
  # there is no identity to check. What varies is where the request may come
  # from: a service behind the owned domain takes only load balancer traffic,
  # and the IAM binding below stays public either way.
  ingress             = var.ingress
  deletion_protection = false

  template {
    service_account                  = var.service_account_email
    timeout                          = var.timeout_seconds == null ? null : "${var.timeout_seconds}s"
    max_instance_request_concurrency = var.max_request_concurrency

    scaling {
      # Scales to zero. A relic service is idle most of the time and paying
      # for a warm instance buys nothing a recipient would notice.
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # Billed only while a request is in flight.
        cpu_idle = true
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      ports {
        container_port = 8080
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 10
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Public. Relic has no accounts by design, so there is no identity to check
# and the download cap plus the kill switch are the controls instead.
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = google_cloud_run_v2_service.service.project
  location = google_cloud_run_v2_service.service.location
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
