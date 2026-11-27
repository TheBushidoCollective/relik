# APIs Relic needs. Additive, and never disabled on destroy: turning an API
# off in a shared project would break whatever else in thebushido-co uses it.
resource "google_project_service" "relic" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "dns.googleapis.com",
    # The load balancer fronting the service domain: addresses, serverless
    # NEG, backend service, proxies, forwarding rules, and the managed
    # certificate all sit behind this one API.
    "compute.googleapis.com",
    # V4 signing goes through signBlob with the ambient identity, so there is
    # no downloaded key anywhere in the deployment.
    "iamcredentials.googleapis.com",
    # The Resend API key is mounted from Secret Manager.
    "secretmanager.googleapis.com",
    # The error-report sink, bucket, and log view.
    "logging.googleapis.com",
  ])

  project = var.project_id
  service = each.value

  disable_on_destroy         = false
  disable_dependent_services = false
}
