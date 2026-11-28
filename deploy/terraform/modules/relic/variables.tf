variable "project_id" {
  description = "GCP project."
  type        = string
  nullable    = false
}

variable "region" {
  description = "Cloud Run region for both origins."
  type        = string
  nullable    = false
}

variable "image" {
  description = "Digest-pinned container image."
  type        = string
  nullable    = false
}

variable "bucket_name" {
  description = <<-EOT
    Bucket name, passed in rather than derived from the bucket resource.

    The services must not depend on the bucket, because the bucket depends on
    the services for its CORS origin. Passing the name breaks that cycle.
  EOT
  type        = string
  nullable    = false
}

variable "service_name" {
  description = "Cloud Run service name for the service origin."
  type        = string
  nullable    = false
}

variable "usercontent_name" {
  description = "Cloud Run service name for the usercontent origin."
  type        = string
  nullable    = false
}

variable "service_url" {
  description = "The service origin, computed by the caller and asserted there."
  type        = string
  nullable    = false
}

variable "usercontent_url" {
  description = "The usercontent origin, a distinct registrable domain."
  type        = string
  nullable    = false
}

variable "usercontent_trusted_proxy_hops" {
  description = "Trusted proxy hops for the usercontent service."
  type        = number
  default     = 2

  validation {
    condition     = var.usercontent_trusted_proxy_hops >= 0 && floor(var.usercontent_trusted_proxy_hops) == var.usercontent_trusted_proxy_hops
    error_message = "The trusted proxy hop count must be a non-negative integer."
  }
}

variable "soft_delete_retention_days" {
  description = "How long deleted objects stay recoverable."
  type        = number
  nullable    = false
}

variable "kill_switch_engaged" {
  description = "Refuses every mint and every publish when true."
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
    Cloud Run fails a revision that mounts a secret with no version, so this
    stays empty until a human has added the version to the secret terraform
    created. One knob rather than two: a from address with no key and a key
    with no from address are both broken, and the mailer refuses to start on
    either half alone.
  EOT
  type        = string
  default     = ""
}
