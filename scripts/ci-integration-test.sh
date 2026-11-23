#!/usr/bin/env bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "${REPO_ROOT}"

# shellcheck source=scripts/ci-common.sh
source "${SCRIPT_DIR}/ci-common.sh"

CHECK_NAME="${CHECK_NAME:-CAS Integration Test (GDC Staging)}"
ORG="${GDC_ORG:-gdc1}"
ZONE="${GDC_ZONE:-us-west6-a}"
LAB_URL="${GDC_LAB_URL:-staging.gpcdemolabs.com}"
CAS_PROJECT="${GDC_CAS_PROJECT:-gdc-node-sdk-ci}"
CAS_CA_NAME="${GDC_CAS_CA_NAME:-sdk-ci-ca}"

WORK_DIR="$(mktemp -d /tmp/gdc-cas-staging.XXXXXX)"
SA_FILE="${GDC_CAS_SA_FILE:-${WORK_DIR}/sa.json}"
CA_FILE="${GDC_CAS_CA_FILE:-${WORK_DIR}/ca.crt}"
PACK_DIR="${WORK_DIR}/pack"
CONSUMER_DIR="${WORK_DIR}/consumer"
mkdir -p "${PACK_DIR}" "${CONSUMER_DIR}"

cleanup() {
  local exit_code=$?
  rm -rf "${WORK_DIR}"
  complete_pr_check_run "${exit_code}"
}
trap cleanup EXIT INT TERM

if [[ -n "${PR_CHECK_RUN_ID:-}" ]]; then
  start_pr_check_run "${CHECK_NAME}" "in_progress" "Running CAS KRM & gRPC integration suite on GDC Staging"
fi

# When triggered via /test-integration or workflow_dispatch with pr_number, check out
# the verified PR_HEAD_SHA and merge origin/main so we test the exact merge candidate.
if [[ -n "${PR_NUMBER:-}" && -n "${PR_HEAD_SHA:-}" ]]; then
  git fetch origin main
  git fetch origin "pull/${PR_NUMBER}/head:pr-${PR_NUMBER}"
  actual_sha=$(git rev-parse "pr-${PR_NUMBER}")
  if [[ "${actual_sha}" != "${PR_HEAD_SHA}" ]]; then
    echo "::error::PR #${PR_NUMBER} head moved from ${PR_HEAD_SHA:0:7} to ${actual_sha:0:7} before execution; re-run '/test-integration' after reviewing."
    exit 1
  fi
  git checkout -f "${PR_HEAD_SHA}"
  git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    merge --no-edit origin/main
fi

echo "=== Installing gdc-cas dependencies & packing release tarball ==="
(
  cd "${REPO_ROOT}/cas/gdc-cas"
  npm ci --no-audit --no-fund
)
TARBALL_NAME=$(cd "${REPO_ROOT}/cas/gdc-cas" && npm pack --pack-destination "${PACK_DIR}" | tail -n 1)
TARBALL_PATH="${PACK_DIR}/${TARBALL_NAME}"
echo "Packed candidate tarball: ${TARBALL_PATH}"

cat > "${CONSUMER_DIR}/package.json" <<'EOF'
{
  "name": "gdc-cas-staging-e2e-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
EOF

echo "=== Installing packed gdc-cas tarball into isolated consumer project ==="
(
  cd "${CONSUMER_DIR}"
  npm install --no-audit --no-fund "${TARBALL_PATH}"
)

STAGING_TEST_SCRIPT="${CI_TRUSTED_DIR:-${REPO_ROOT}}/cas/integration/staging.test.js"
cp "${STAGING_TEST_SCRIPT}" "${CONSUMER_DIR}/staging.test.js"

if [[ "${GDC_CAS_OFFLINE_SELFTEST:-false}" == "true" ]]; then
  echo "=== Running offline CSR & harness self-test ==="
  (
    cd "${CONSUMER_DIR}"
    GDC_CAS_OFFLINE_SELFTEST=true node --test staging.test.js
  )
  exit 0
fi

setup_gdc_staging_credentials \
  "${SA_FILE}" \
  "${CA_FILE}" \
  "${ORG}" \
  "${ZONE}" \
  "${LAB_URL}" \
  "${GDC_CAS_STAGING_SA_KEY:-}"
unset GDC_CAS_STAGING_SA_KEY

echo "=== Executing GDC Staging CAS Integration Suite (KRM + Direct gRPC) ==="
(
  cd "${CONSUMER_DIR}"
  GDC_CAS_SA_FILE="${SA_FILE}" \
  GDC_CAS_CA_FILE="${CA_FILE}" \
  GDC_ZONE="${ZONE}" \
  GDC_CAS_PROJECT="${CAS_PROJECT}" \
  GDC_CAS_CA_NAME="${CAS_CA_NAME}" \
  node --test staging.test.js
)
