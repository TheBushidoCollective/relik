module "presence" {
  source = "./modules/cloud-run-service"

  project_id            = var.project_id
  region                = var.region
  name                  = "${local.service_name}-presence"
  image                 = var.image
  service_account_email = module.relic.app_service_account
  ingress               = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  env = {
    NODE_ENV                 = "production"
    RELIC_ROLE               = "presence"
    RELIC_SERVICE_ORIGIN     = local.service_url
    RELIC_TRUSTED_PROXY_HOPS = "2"
  }

  max_instances           = 1
  timeout_seconds         = 3600
  max_request_concurrency = 1000
  cpu                     = "1"
  memory                  = "512Mi"

  depends_on = [google_project_service.relic]
}
