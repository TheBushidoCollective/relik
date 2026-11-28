locals {
  # TheBushidoCollective uses immutable OIDC subjects: a token's `sub` is
  # repo:Owner@<owner id>/name@<repo id>:..., not repo:Owner/name:.... Read the
  # prefix with: gh api repos/<owner>/<name>/actions/oidc/customization/sub
  # --jq .sub_claim_prefix. It survives renames; changing the owner or the
  # repository requires a new prefix and a Terraform apply.
  error_report_oidc_subject_prefix = "repo:TheBushidoCollective@233175215/relik@1316636189"
}
