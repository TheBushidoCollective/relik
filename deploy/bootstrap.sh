#!/usr/bin/env bash
# One-time bootstrap for Relic's deploy pipeline.
#
# CI cannot create its own identity, so this is the one thing that cannot run
# in CI. Everything after it does: no plan and no apply is ever run from a
# workstation, because state is shared and a local run races the pipeline.
#
# It creates: the Terraform state bucket, a Workload Identity Federation pool
# and provider scoped to this one GitHub repository by its numeric ID, and the
# deployer service account CI impersonates. No service account keys are
# created, ever.
#
# Idempotent. Safe to re-run.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-thebushido-co}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-TheBushidoCollective/relik}"
# GitHub's numeric repository ID survives renames and transfers; the name does
# not. The renames from artifacts to relic to relik each broke a name-pinned
# condition. Read it with: gh api repos/<owner>/<name> --jq .id
REPO_ID="${REPO_ID:-1316636189}"
# Name-based impersonation bindings from before the ID pin. Removed once the
# ID-based binding is in place.
PREVIOUS_REPOS="${PREVIOUS_REPOS:-TheBushidoCollective/artifacts TheBushidoCollective/relic TheBushidoCollective/relik}"
ACCOUNT="${ACCOUNT:-jwaldrip@thebushido.co}"

STATE_BUCKET="${PROJECT_ID}-tfstate"
POOL_ID="github"
PROVIDER_ID="artifacts"
DEPLOYER="relic-deployer"
DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"

g() { gcloud --project="${PROJECT_ID}" --account="${ACCOUNT}" "$@"; }

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

PROJECT_NUMBER="$(g projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
say "Project ${PROJECT_ID} (${PROJECT_NUMBER})"

say "Enabling the APIs bootstrap itself needs"
g services enable \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  dns.googleapis.com \
  compute.googleapis.com \
  run.googleapis.com

say "Terraform state bucket: gs://${STATE_BUCKET}"
if ! g storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  g storage buckets create "gs://${STATE_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
  # Versioning is the recovery path for a corrupted or truncated state file.
  g storage buckets update "gs://${STATE_BUCKET}" --versioning
else
  echo "already exists"
fi

# The registry has to exist before the pipeline's first image push, and that
# push happens before Terraform runs. So it is bootstrap substrate, the same
# category as the state bucket, rather than something Terraform manages.
say "Artifact Registry: ${REGION}/relic"
if ! g artifacts repositories describe relic --location="${REGION}" >/dev/null 2>&1; then
  g artifacts repositories create relic \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Relic server images."
else
  echo "already exists"
fi

# Keep the last ten digests so a rollback has something to roll back to,
# without paying to store every build ever made.
POLICY="$(mktemp)"
cat > "${POLICY}" <<'POLICY_JSON'
[
  {
    "name": "keep-recent",
    "action": {"type": "Keep"},
    "mostRecentVersions": {"keepCount": 10}
  }
]
POLICY_JSON
g artifacts repositories set-cleanup-policies relic \
  --location="${REGION}" --policy="${POLICY}" --no-dry-run >/dev/null 2>&1 \
  && echo "  cleanup policy set" || echo "  cleanup policy skipped (older gcloud)"
rm -f "${POLICY}"

say "Deployer service account: ${DEPLOYER_EMAIL}"
if ! g iam service-accounts describe "${DEPLOYER_EMAIL}" >/dev/null 2>&1; then
  g iam service-accounts create "${DEPLOYER}" \
    --display-name="Relic CI deployer" \
    --description="Impersonated by GitHub Actions through WIF. Has no keys."
else
  echo "already exists"
fi

# Service account creation is eventually consistent: the IAM policy API can
# still 404 the principal for a few seconds after `create` returns. Wait for
# it to be visible rather than failing a fresh bootstrap on a race.
say "Waiting for the deployer to be visible to IAM"
for _ in $(seq 1 30); do
  if g iam service-accounts describe "${DEPLOYER_EMAIL}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

say "Granting the deployer what Terraform needs, and nothing more"
# Deliberately not roles/owner or roles/editor. Each of these maps to
# something in deploy/terraform; if a resource is added that needs a new role,
# add it here rather than widening to a basic role.
for ROLE in \
  roles/run.admin \
  roles/storage.admin \
  roles/artifactregistry.admin \
  roles/dns.admin \
  roles/compute.loadBalancerAdmin \
  roles/compute.networkAdmin \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/resourcemanager.projectIamAdmin \
  roles/serviceusage.serviceUsageAdmin
do
  # Retried for the same propagation reason.
  for ATTEMPT in $(seq 1 10); do
    if g projects add-iam-policy-binding "${PROJECT_ID}" \
        --member="serviceAccount:${DEPLOYER_EMAIL}" \
        --role="${ROLE}" \
        --condition=None >/dev/null 2>&1; then
      break
    fi
    if [ "${ATTEMPT}" -eq 10 ]; then
      echo "  FAILED after 10 attempts: ${ROLE}" >&2
      exit 1
    fi
    sleep 3
  done
  echo "  ${ROLE}"
done

say "Workload Identity pool: ${POOL_ID}"
if ! g iam workload-identity-pools describe "${POOL_ID}" --location=global >/dev/null 2>&1; then
  g iam workload-identity-pools create "${POOL_ID}" \
    --location=global \
    --display-name="GitHub Actions"
else
  echo "already exists"
fi

say "Workload Identity provider: ${PROVIDER_ID}"
# The attribute condition is the security boundary. Without it, any GitHub
# repository in the world could mint a token for this pool. It pins the
# numeric repository ID so a rename or transfer cannot silently break deploys.
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref"
CONDITION="assertion.repository_id == '${REPO_ID}'"
if ! g iam workload-identity-pools providers describe "${PROVIDER_ID}" \
      --location=global --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then
  g iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --location=global \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="${REPO}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="${MAPPING}" \
    --attribute-condition="${CONDITION}"
else
  g iam workload-identity-pools providers update-oidc "${PROVIDER_ID}" \
    --location=global \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="${REPO}" \
    --attribute-mapping="${MAPPING}" \
    --attribute-condition="${CONDITION}"
fi

say "Letting repository ${REPO_ID} (${REPO}) impersonate the deployer"
g iam service-accounts add-iam-policy-binding "${DEPLOYER_EMAIL}" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/${REPO_ID}" \
  >/dev/null

for PREVIOUS_REPO in ${PREVIOUS_REPOS}; do
  PREVIOUS_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${PREVIOUS_REPO}"
  EXISTING_PREVIOUS_MEMBER="$(g iam service-accounts get-iam-policy "${DEPLOYER_EMAIL}" \
    --flatten="bindings[].members" \
    --filter="bindings.role:roles/iam.workloadIdentityUser AND bindings.members:${PREVIOUS_MEMBER}" \
    --format="value(bindings.members)")"
  if [ -n "${EXISTING_PREVIOUS_MEMBER}" ]; then
    say "Removing name-based ${PREVIOUS_REPO} impersonation"
    g iam service-accounts remove-iam-policy-binding "${DEPLOYER_EMAIL}" \
      --role=roles/iam.workloadIdentityUser \
      --member="${PREVIOUS_MEMBER}" \
      >/dev/null
  fi
done

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

RUN_INFIX="$(g run services list --region="${REGION}" --format='value(status.url)' 2>/dev/null \
  | head -1 | sed -E 's#https://[^-]*-([a-z0-9]+-[a-z]{2})\.a\.run\.app#\1#')"

cat <<SUMMARY

$(printf '\033[1m==> Done. Set these as GitHub Actions variables.\033[0m')

  gh variable set GCP_PROJECT_ID   --body '${PROJECT_ID}'   --repo ${REPO}
  gh variable set GCP_REGION       --body '${REGION}'       --repo ${REPO}
  gh variable set WIF_PROVIDER     --body '${WIF_PROVIDER}' --repo ${REPO}
  gh variable set DEPLOYER_SA      --body '${DEPLOYER_EMAIL}' --repo ${REPO}
  gh variable set RUN_URL_INFIX    --body '${RUN_INFIX}'    --repo ${REPO}

No service account key was created, and none should ever be.
SUMMARY
