variable "project_id" {
  description = "GCP project."
  type        = string
  nullable    = false
}

variable "region" {
  description = "Cloud Run region."
  type        = string
  nullable    = false
}

variable "name" {
  description = "Service name. Becomes the leading label of the run.app host."
  type        = string
  nullable    = false
}

variable "ingress" {
  description = <<-EOT
    Which callers Cloud Run will accept.

    `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` makes the run.app host stop
    answering the internet, so the only way in is the load balancer in front
    of the owned domain. That is what retires a temporary host: leaving it
    reachable means the service has two live origins, and only one of them is
    the one every published link, CORS rule, and CSP header names.
  EOT
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"

  validation {
    condition = contains([
      "INGRESS_TRAFFIC_ALL",
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      "INGRESS_TRAFFIC_INTERNAL_ONLY",
    ], var.ingress)
    error_message = "ingress must be one of the three Cloud Run traffic settings."
  }
}

variable "image" {
  description = "Digest-pinned container image."
  type        = string
  nullable    = false
}

variable "service_account_email" {
  description = "Identity the revision runs as."
  type        = string
  nullable    = false
}

variable "env" {
  description = "Environment variables for the container."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Environment variables sourced from Secret Manager, name to secret id."
  type        = map(string)
  default     = {}
}

variable "max_instances" {
  description = <<-EOT
    Instance ceiling.

    This is a cost control as much as a capacity one: egress is a kill-switch
    condition in the preconditions, and an unbounded fleet is an unbounded
    bill.
  EOT
  type        = number
  default     = 4
}

variable "timeout_seconds" {
  description = "Maximum request duration in seconds; null leaves the Cloud Run default unchanged."
  type        = number
  default     = null
}

variable "max_request_concurrency" {
  description = "Maximum concurrent requests per instance; null leaves the Cloud Run default unchanged."
  type        = number
  default     = null
}

variable "cpu" {
  description = "CPU per instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory per instance."
  type        = string
  default     = "512Mi"
}
