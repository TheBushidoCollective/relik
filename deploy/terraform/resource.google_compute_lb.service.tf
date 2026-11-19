# The public edge for the service domain.
#
# A global external Application Load Balancer in front of the Cloud Run
# service, rather than a Cloud Run domain mapping. Mapping is still Preview
# and limited to a subset of regions; Google's own guidance is the load
# balancer for anything production. It is also the only one of the two that
# leaves room for Cloud Armor later, which matters for a service whose entire
# product is an unauthenticated link a stranger opens.
#
# The usercontent origin deliberately gets none of this. It keeps its Cloud Run
# host, which is its own registrable domain under the *.run.app public suffix,
# and that separation is the boundary keeping untrusted HTML away from the
# fragment.

resource "google_compute_region_network_endpoint_group" "service" {
  project = var.project_id
  region  = var.region
  name    = "${local.service_name}-neg"

  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = local.service_name
  }

  # Everything else here reaches the API through this one, transitively.
  # Bootstrap enables it too, so an established project never races; this is
  # what makes a fresh one work.
  depends_on = [google_project_service.relic]
}

resource "google_compute_backend_service" "service" {
  project = var.project_id
  name    = "${local.service_name}-backend"

  load_balancing_scheme = "EXTERNAL_MANAGED"

  # No protocol, and no health_checks. The provider documents that a health
  # check is required "unless it utilizes an internet or serverless network
  # endpoint group", and the canonical serverless examples set neither field.
  # Both are left off rather than guessed at, since a wrong value here is an
  # API-level refusal that plan and validate cannot see.

  backend {
    group = google_compute_region_network_endpoint_group.service.id
  }
}

resource "google_compute_region_network_endpoint_group" "presence" {
  project = var.project_id
  region  = var.region
  name    = "${local.service_name}-presence-neg"

  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = module.presence.name
  }
}

resource "google_compute_backend_service" "presence" {
  project = var.project_id
  name    = "${local.service_name}-presence-backend"

  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group = google_compute_region_network_endpoint_group.presence.id
  }
}

# Reserved rather than ephemeral. The address is what the zone's A record
# publishes and what the managed certificate is validated against, so losing
# it on a rebuild would break every link and force a new certificate.
resource "google_compute_global_address" "service_ipv4" {
  project = var.project_id
  name    = "${local.service_name}-ipv4"

  depends_on = [google_project_service.relic]
}

resource "google_compute_global_address" "service_ipv6" {
  project    = var.project_id
  name       = "${local.service_name}-ipv6"
  ip_version = "IPV6"

  depends_on = [google_project_service.relic]
}

# Google-managed, so there is no certificate or key material in the
# deployment, matching how the V4 signing identity works.
#
# Provisioning is asynchronous and requires the A and AAAA records to already
# resolve to the addresses above, so the apply finishes with this PROVISIONING
# and Google completes it afterwards. depends_on makes the records exist first
# rather than leaving the first validation attempt to fail and retry.
resource "google_compute_managed_ssl_certificate" "service" {
  project = var.project_id
  name    = "${local.service_name}-cert"

  managed {
    domains = [var.service_domain]
  }

  depends_on = [
    google_dns_record_set.service_a,
    google_dns_record_set.service_aaaa,
  ]

  lifecycle {
    # The domain list forces replacement, and the proxy cannot be left
    # pointing at a certificate that no longer exists.
    create_before_destroy = true
  }
}

resource "google_compute_url_map" "service" {
  project         = var.project_id
  name            = local.service_name
  default_service = google_compute_backend_service.service.id

  host_rule {
    hosts        = [var.service_domain]
    path_matcher = "service"
  }

  path_matcher {
    name            = "service"
    default_service = google_compute_backend_service.service.id

    path_rule {
      paths   = ["/api/presence/*"]
      service = google_compute_backend_service.presence.id
    }
  }
}

resource "google_compute_target_https_proxy" "service" {
  project          = var.project_id
  name             = "${local.service_name}-https"
  url_map          = google_compute_url_map.service.id
  ssl_certificates = [google_compute_managed_ssl_certificate.service.id]
}

resource "google_compute_global_forwarding_rule" "https_ipv4" {
  project               = var.project_id
  name                  = "${local.service_name}-https-ipv4"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.service.id
  ip_address            = google_compute_global_address.service_ipv4.id
  port_range            = "443"
}

resource "google_compute_global_forwarding_rule" "https_ipv6" {
  project               = var.project_id
  name                  = "${local.service_name}-https-ipv6"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.service.id
  ip_address            = google_compute_global_address.service_ipv6.id
  port_range            = "443"
}

# Port 80 exists only to redirect.
#
# A relic URL carries the key in its fragment, and a fragment survives a
# redirect by inheritance when the Location carries none. So this redirect
# must not add one: `spec/viewer.md` treats the HTTP to HTTPS upgrade as
# staying inside the service precisely so a typed or pasted link keeps working.
resource "google_compute_url_map" "service_redirect" {
  project = var.project_id
  name    = "${local.service_name}-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "service_redirect" {
  project = var.project_id
  name    = "${local.service_name}-http"
  url_map = google_compute_url_map.service_redirect.id
}

resource "google_compute_global_forwarding_rule" "http_ipv4" {
  project               = var.project_id
  name                  = "${local.service_name}-http-ipv4"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.service_redirect.id
  ip_address            = google_compute_global_address.service_ipv4.id
  port_range            = "80"
}

resource "google_compute_global_forwarding_rule" "http_ipv6" {
  project               = var.project_id
  name                  = "${local.service_name}-http-ipv6"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.service_redirect.id
  ip_address            = google_compute_global_address.service_ipv6.id
  port_range            = "80"
}
