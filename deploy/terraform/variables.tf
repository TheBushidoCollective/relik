variable "project_id" {
  description = "GCP project that hosts Relic."
  type        = string
  nullable    = false
}

variable "region" {
  description = "Cloud Run region for both origins."
  type        = string
  default     = "us-central1"
}

variable "service_domain" {
  description = "Registrable domain for the Relik service. Never hosts the untrusted usercontent origin."
  type        = string
  default     = "relik.link"
  nullable    = false

  validation {
    condition = (
      can(regex("^[a-z]([a-z0-9-]*[a-z0-9])?(\\.[a-z]([a-z0-9-]*[a-z0-9])?)+$", var.service_domain)) &&
      length(replace(var.service_domain, ".", "-")) <= 63
    )
    error_message = "service_domain must be a lowercase DNS name whose hyphenated form starts with a letter and is at most 63 characters."
  }
}

variable "run_url_infix" {
  description = <<-EOT
    The project-and-region infix in this project's Cloud Run hostnames.

    thebushido-co predates Cloud Run's deterministic
    `{service}-{project_number}` URLs and still issues the legacy
    `{service}-{infix}.a.run.app` form. Both origins have to be known before
    either service is created, because each needs the other's URL and the
    bucket needs the service's for CORS, so the value is supplied rather than
    read back.

    Find it with:
      gcloud run services list --project <id> --format='value(status.url)'

    A `check` block asserts the computed URLs match what Cloud Run actually
    issued, so a wrong value fails the apply instead of deploying a broken
    origin pair.
  EOT
  type        = string
  nullable    = false
}

variable "image" {
  description = <<-EOT
    Fully qualified container image, digest-pinned by CI.

    A tag would let the running revision drift from the commit that produced
    it, which makes "what is deployed" unanswerable during an incident.
  EOT
  type        = string
  nullable    = false
}

variable "soft_delete_retention_days" {
  description = <<-EOT
    How long deleted objects remain recoverable.

    Deleted does not mean erased, and the published disclosure says so. Set
    explicitly because a change reaches only objects deleted after it takes
    effect, leaving a tail nobody can retroactively clear.
  EOT
  type        = number
  default     = 7
}

variable "kill_switch_engaged" {
  description = <<-EOT
    Refuses every mint and every publish when true.

    Stops new signed URLs being minted. It does nothing to URLs already
    minted: rotating the signing key is the only second-stage stop, and it is
    indiscriminate.
  EOT
  type        = bool
  default     = false
}

variable "operator_tokens" {
  description = "name:secret pairs for the operator delete surface."
  type        = string
  sensitive   = true
  default     = ""
}

variable "mail_from" {
  description = <<-EOT
    Envelope sender for outbound mail: the Resend-verified address on the
    service domain.

    Empty means mail is off, and that is also what gates the API key mount.
    Set it only once the secret holds a version.
  EOT
  type        = string
  default     = ""
}
