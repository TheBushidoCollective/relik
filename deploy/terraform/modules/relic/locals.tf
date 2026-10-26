locals {
  # Defined once and merged into both services, so the two origins cannot
  # disagree about which is which.
  #
  # They previously did. The usercontent service was given the pair swapped, on
  # the reading that each service should describe itself, and the swap silently
  # disabled HTML rendering: the usercontent service derives `frame-ancestors`
  # from RELIC_SERVICE_ORIGIN to declare who may embed it, so naming itself
  # refused every embed from the real viewer. Nothing failed loudly. The
  # usercontent service still answered 200, Terraform still applied, and only a
  # browser ever objected.
  #
  # These are absolute names for two roles, not relative ones. Keeping the pair
  # in a single place makes "swap them for this one service" an edit that has
  # nowhere to land.
  origin_env = {
    RELIC_SERVICE_ORIGIN     = var.service_url
    RELIC_USERCONTENT_ORIGIN = var.usercontent_url
  }

  # Where each kind of object lives in the bucket. Defined here because both
  # the service environment and the bucket's lifecycle rules need them, and a
  # lifecycle rule whose prefix no longer matches what the app writes fails
  # silently: nothing errors, objects simply stop expiring.
  ciphertext_prefix = "r"
  store_prefix      = "m"

  # Metadata that must outlive the relic. A tombstone is what makes a removed
  # relic answer "removed" instead of "never existed", and an abuse report is a
  # record of a decision somebody may have to answer for later. Neither gets a
  # delete rule.
  #
  # Challenges (sign-in codes and their budget rows included) and dedup entries
  # are minutes-lived but the shortest granularity a lifecycle rule has is a
  # day, so they take the one-day rule below rather than a schedule that
  # pretends to be exact.
  transient_store_prefixes = [
    "${local.store_prefix}/challenge/",
    "${local.store_prefix}/dedup/",
  ]

  # The Resend API key's secret, provisioned outside terraform.
  #
  # Terraform created it for one deploy and the deploy failed:
  # `secretmanager.secrets.create` is denied to the CI identity, and the fix
  # for that is granting the deploy service account Secret Manager admin
  # across the project. That is a real privilege increase on a pipeline that
  # currently cannot read or write a single secret, bought to save one gcloud
  # command that runs once. Not worth it.
  #
  # So the secret, its version, and the accessor grant are all created by a
  # human, and terraform only names it. The mount is still gated on
  # `mail_from`, so a name that does not resolve yet cannot reach a revision.
  mail_secret_id = "relic-resend-api-key"
}
