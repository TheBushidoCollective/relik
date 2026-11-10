output "service_url" {
  description = "The service origin a recipient sees: the API and the PWA shell, on the owned domain."
  value       = local.service_url
}

output "service_run_url" {
  description = <<-EOT
    The host Cloud Run issued for the service, behind the load balancer.

    Not an advertised origin. It is what the deploy smoke tests fetch, because
    they run before the managed certificate has finished provisioning, and the
    headers they assert name the domain above rather than this host.
  EOT
  value       = module.relic.service_run_url
}

output "service_lb_ipv4" {
  description = "Load balancer address published as the zone's A record."
  value       = google_compute_global_address.service_ipv4.address
}

output "service_lb_ipv6" {
  description = "Load balancer address published as the zone's AAAA record."
  value       = google_compute_global_address.service_ipv6.address
}

output "service_certificate" {
  description = "Managed certificate name, for reading provisioning state after the apply."
  value       = google_compute_managed_ssl_certificate.service.name
}

output "usercontent_url" {
  description = <<-EOT
    The usercontent origin, where untrusted HTML renders.

    Still a Cloud Run host, and still a distinct registrable domain from the
    service: *.run.app is on the Public Suffix List as a wildcard, so this
    host is its own eTLD+1 and is cross-site with the service domain.

    It has no owned domain of its own yet, which is the remaining launch gate
    rather than a property of this deployment. What it must never become is a
    name under the service domain; check.run_urls.tf asserts that.
  EOT
  value       = module.relic.usercontent_url
}

output "service_domain" {
  description = "Registrable domain delegated to the Relik service."
  value       = trimsuffix(google_dns_managed_zone.service.dns_name, ".")
}

output "service_name_servers" {
  description = "Authoritative nameservers to configure at the domain registrar."
  value       = google_dns_managed_zone.service.name_servers
}

output "service_ds_record" {
  description = "DNSSEC DS record to configure at the domain registrar after nameserver delegation."
  value       = data.google_dns_keys.service.key_signing_keys[0].ds_record
}

output "bucket_name" {
  description = "Bucket holding relic ciphertext."
  value       = module.relic.bucket_name
}

output "app_service_account" {
  description = "Identity both Cloud Run services run as."
  value       = module.relic.app_service_account
}
