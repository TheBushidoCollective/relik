# The service origin: the API, the PWA shell, the abuse form, and the
# published disclosure.
module "service" {
  source = "../cloud-run-service"

  project_id            = var.project_id
  region                = var.region
  name                  = var.service_name
  image                 = var.image
  service_account_email = google_service_account.app.email

  # The run.app host stops answering the internet. Every published link, the
  # bucket's CORS list, and the usercontent origin's frame-ancestors all name
  # the owned domain, so a second reachable origin serves nobody and is one
  # more name a recipient could be handed that will not render.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  env = merge(local.origin_env, {
    NODE_ENV = "production"

    RELIC_GCS_BUCKET   = var.bucket_name
    RELIC_GCS_PREFIX   = local.ciphertext_prefix
    RELIC_STORE_PREFIX = local.store_prefix

    # No RELIC_GCS_CLIENT_EMAIL or RELIC_GCS_PRIVATE_KEY. Their absence is
    # what selects the metadata signer, so V4 signatures come from the IAM
    # Credentials API using the attached identity and no key material exists
    # in the deployment.

    RELIC_KILL_SWITCH        = tostring(var.kill_switch_engaged)
    RELIC_OPERATOR_TOKENS    = var.operator_tokens
    RELIC_TRUSTED_PROXY_HOPS = "2"

    RELIC_MAIL_FROM = var.mail_from
  })

  # Gated on the from address rather than a second flag. Cloud Run fails a
  # revision that mounts a secret with no version, and the version arrives by
  # hand after terraform has made the container and the access. One knob keeps
  # the two halves from disagreeing.
  secret_env = var.mail_from != "" ? {
    RELIC_RESEND_API_KEY = local.mail_secret_id
  } : {}
}

# Both origins run the same image. The isolation is the origin boundary, not a
# different binary: *.run.app is a Public Suffix List wildcard, so a.run.app is
# the public suffix and each service URL is its own registrable domain.
# Untrusted HTML rendered on the usercontent origin therefore cannot reach the
# service origin, which is the one holding the fragment.
module "usercontent" {
  source = "../cloud-run-service"

  project_id            = var.project_id
  region                = var.region
  name                  = var.usercontent_name
  image                 = var.image
  service_account_email = google_service_account.app.email

  # The usercontent origin serves two static files. It is given a bucket so the
  # shared image boots identically, but it never mints, never reads an object,
  # and never sees a key: nothing routes to those paths on this host.
  #
  # Same origin pair as the service, from the same local. See locals.tf for why
  # that is not an oversight.
  env = merge(local.origin_env, {
    NODE_ENV = "production"

    RELIC_GCS_BUCKET           = var.bucket_name
    RELIC_GCS_PREFIX           = local.ciphertext_prefix
    RELIC_TRUSTED_PROXY_HOPS   = tostring(var.usercontent_trusted_proxy_hops)
    RELIC_ACCEPT_ERROR_REPORTS = "false"
  })

  max_instances = 2
  memory        = "256Mi"
}
