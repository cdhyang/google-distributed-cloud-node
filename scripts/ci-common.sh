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

# Shared security, authorization, Check Run reporting, and secret-masking
# helpers for GDC Air-gapped Staging CI workflows.

is_authorized_maintainer() {
  local actor="$1"
  local assoc="${2:-}"

  if [[ -z "${actor}" ]]; then
    return 1
  fi

  local actor_lc
  actor_lc=$(printf '%s' "${actor}" | tr '[:upper:]' '[:lower:]')

  # Automated dependency bots must never self-authorize staging secret access.
  if [[ "${actor_lc}" == *"[bot]" || "${actor_lc}" == *"-robot" || "${actor_lc}" == "renovate-bot" || "${actor_lc}" == "dependabot" ]]; then
    return 1
  fi

  local owners_ref="HEAD"
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    owners_ref="origin/main"
  fi

  local codeowners_content=""
  if git cat-file -e "${owners_ref}:CODEOWNERS" 2>/dev/null; then
    codeowners_content=$(git show "${owners_ref}:CODEOWNERS" 2>/dev/null || true)
  elif git cat-file -e "${owners_ref}:.github/CODEOWNERS" 2>/dev/null; then
    codeowners_content=$(git show "${owners_ref}:.github/CODEOWNERS" 2>/dev/null || true)
  elif [[ -f "CODEOWNERS" ]]; then
    codeowners_content=$(cat "CODEOWNERS")
  elif [[ -f ".github/CODEOWNERS" ]]; then
    codeowners_content=$(cat ".github/CODEOWNERS")
  fi

  if [[ -n "${codeowners_content}" ]]; then
    local owners_list
    owners_list=$(printf '%s\n' "${codeowners_content}" | grep -v '^[[:space:]]*#' | grep -oE '@[A-Za-z0-9_-]+' | tr -d '@' | tr '[:upper:]' '[:lower:]' || true)
    if [[ -n "${owners_list}" ]] && printf '%s\n' "${owners_list}" | grep -Fxq "${actor_lc}"; then
      return 0
    fi
  fi

  case "${assoc}" in
    OWNER|MEMBER|COLLABORATOR)
      return 0
      ;;
  esac

  return 1
}

should_skip_non_code_changes() {
  if [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
    return 1
  fi

  local non_code_regex='^(\.gitignore|CODEOWNERS|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE.*|NOTICE.*|README\.md|renovate\.json|docs/.*|dashboard/.*|\.github/(ISSUE_TEMPLATE/.*|PULL_REQUEST_TEMPLATE\.md|workflows/(ci|deploy-dashboard|renovate-auto-merge)\.ya?ml|scripts/.*))$'
  local pr_head_sha="${PR_HEAD_SHA:-}"
  if [[ -z "${pr_head_sha}" && -f "${GITHUB_EVENT_PATH:-}" ]]; then
    pr_head_sha=$(jq -r '.pull_request.head.sha // empty' "${GITHUB_EVENT_PATH}")
  fi
  if [[ -z "${pr_head_sha}" ]]; then
    pr_head_sha=$(git rev-parse HEAD)
  fi

  local pr_files
  pr_files=$(git diff --name-only "origin/main...${pr_head_sha}" 2>/dev/null || true)
  if [[ -n "${pr_files}" ]]; then
    if ! printf '%s\n' "${pr_files}" | grep -qvE "${non_code_regex}"; then
      echo "All changed files (${pr_files//$'\n'/, }) are non-SDK/docs files. Skipping GDC Staging integration test."
      return 0
    fi
  fi

  return 1
}

verify_pr_head_at_comment_time() {
  if [[ "${GITHUB_EVENT_NAME:-}" != "issue_comment" || ! -f "${GITHUB_EVENT_PATH:-}" ]]; then
    return 0
  fi

  local comment_created_at comment_epoch
  comment_created_at=$(jq -r '.comment.created_at // empty' "${GITHUB_EVENT_PATH}")
  if [[ -z "${comment_created_at}" ]]; then
    echo "::error::Missing .comment.created_at in issue_comment event payload."
    exit 1
  fi
  comment_epoch=$(date -d "${comment_created_at}" +%s)

  local commit_date commit_epoch
  commit_date=$(git show -s --format=%cI "${PR_HEAD_SHA}")
  commit_epoch=$(date -d "${commit_date}" +%s)
  if [[ "${commit_epoch}" -gt "${comment_epoch}" ]]; then
    echo "::error::PR #${PR_NUMBER} head commit ${PR_HEAD_SHA:0:7} (${commit_date}) is newer than '/test-integration' comment (${comment_created_at}). Aborting to prevent TOCTOU execution of unreviewed code."
    exit 1
  fi

  if [[ -n "${GH_TOKEN:-}" && -n "${GITHUB_REPOSITORY:-}" ]]; then
    local latest_push_at
    latest_push_at=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/timeline?per_page=100" 2>/dev/null | \
      jq -rs '[ .[][] | select(.event == "committed" or .event == "head_ref_force_pushed") | (.created_at // .committer.date // empty) | select(length > 0) ] | sort | last // empty' || true)
    if [[ -n "${latest_push_at}" ]]; then
      local push_epoch
      push_epoch=$(date -d "${latest_push_at}" +%s)
      if [[ "${push_epoch}" -gt "${comment_epoch}" ]]; then
        echo "::error::PR #${PR_NUMBER} had a commit or force-push at ${latest_push_at}, after '/test-integration' at ${comment_created_at}. Aborting."
        exit 1
      fi
    fi
  fi

  echo "Verified PR #${PR_NUMBER} head commit ${PR_HEAD_SHA:0:7} predates '/test-integration' comment (${comment_created_at})."
}

start_pr_check_run() {
  local check_name="$1"
  local status_val="${2:-queued}"
  local title_val="${3:-Queued for GDC Staging execution}"
  if [[ -z "${PR_HEAD_SHA:-}" || -z "${GH_TOKEN:-}" || -z "${GITHUB_REPOSITORY:-}" ]]; then
    return 0
  fi

  local run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-}"
  if [[ -n "${PR_CHECK_RUN_ID:-}" ]]; then
    gh api --method PATCH "repos/${GITHUB_REPOSITORY}/check-runs/${PR_CHECK_RUN_ID}" \
      -f status="${status_val}" \
      -f details_url="${run_url}" \
      -f "output[title]=${title_val}" \
      -f "output[summary]=Workflow run: ${run_url} (triggered by @${GITHUB_ACTOR:-maintainer} via ${GITHUB_EVENT_NAME:-manual})." >/dev/null 2>&1 || true
    return 0
  fi

  PR_CHECK_RUN_ID=$(gh api --method POST "repos/${GITHUB_REPOSITORY}/check-runs" \
    -f name="${check_name}" \
    -f head_sha="${PR_HEAD_SHA}" \
    -f status="${status_val}" \
    -f details_url="${run_url}" \
    -f "output[title]=${title_val}" \
    -f "output[summary]=Workflow run: ${run_url}. If this run stays queued, approve the pending 'gdc-staging' deployment at ${run_url}." \
    --jq '.id' 2>/dev/null || true)
  export PR_CHECK_RUN_ID
}

complete_pr_check_run() {
  local exit_code="$1"
  if [[ -z "${PR_CHECK_RUN_ID:-}" || -z "${GH_TOKEN:-}" || -z "${GITHUB_REPOSITORY:-}" ]]; then
    return 0
  fi

  local conclusion="failure"
  local title="GDC Staging integration test failed"
  if [[ "${exit_code}" -eq 0 ]]; then
    conclusion="success"
    title="GDC Staging integration test passed"
  fi

  local run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-}"
  gh api --method PATCH "repos/${GITHUB_REPOSITORY}/check-runs/${PR_CHECK_RUN_ID}" \
    -f status="completed" \
    -f conclusion="${conclusion}" \
    -f details_url="${run_url}" \
    -f "output[title]=${title}" \
    -f "output[summary]=Integration test run completed with '${conclusion}': ${run_url}" >/dev/null 2>&1 || true
}

prepare_trusted_ci_files() {
  CI_TRUSTED_DIR="/tmp/ci-trusted"
  rm -rf "${CI_TRUSTED_DIR}"
  mkdir -p "${CI_TRUSTED_DIR}/scripts" "${CI_TRUSTED_DIR}/cas/integration"

  local trusted_ref="HEAD"
  if git rev-parse --verify origin/main >/dev/null 2>&1 && \
     git cat-file -e origin/main:scripts/ci-integration-test.sh 2>/dev/null; then
    trusted_ref="origin/main"
  fi

  echo "Staging trusted CI scripts and integration suite from ${trusted_ref}..."
  git show "${trusted_ref}:scripts/ci-common.sh" > "${CI_TRUSTED_DIR}/scripts/ci-common.sh"
  git show "${trusted_ref}:scripts/ci-integration-test.sh" > "${CI_TRUSTED_DIR}/scripts/ci-integration-test.sh"
  git show "${trusted_ref}:cas/integration/staging.test.js" > "${CI_TRUSTED_DIR}/cas/integration/staging.test.js"
  chmod +x "${CI_TRUSTED_DIR}/scripts/ci-common.sh" "${CI_TRUSTED_DIR}/scripts/ci-integration-test.sh"
  export CI_TRUSTED_DIR
}

precheck_integration_trigger() {
  local check_name="${CHECK_NAME:-CAS Integration Test (GDC Staging)}"

  if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && -f "${GITHUB_EVENT_PATH:-}" ]]; then
    local head_repo author_association pr_user pr_number pr_head_sha
    head_repo=$(jq -r '.pull_request.head.repo.full_name // empty' "${GITHUB_EVENT_PATH}")
    author_association=$(jq -r '.pull_request.author_association // empty' "${GITHUB_EVENT_PATH}")
    pr_user=$(jq -r '.pull_request.user.login // empty' "${GITHUB_EVENT_PATH}")
    pr_number=$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH}")
    pr_head_sha=$(jq -r '.pull_request.head.sha // empty' "${GITHUB_EVENT_PATH}")
    PR_NUMBER="${pr_number}"
    PR_HEAD_SHA="${pr_head_sha}"
    export PR_NUMBER PR_HEAD_SHA

    if should_skip_non_code_changes; then
      [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "should_run=false" >> "${GITHUB_OUTPUT}"
      return 0
    fi

    if [[ "${head_repo}" != "${GITHUB_REPOSITORY:-}" ]]; then
      echo "Skipping automatic GDC Staging integration test for forked PR (${head_repo})."
      echo "A maintainer listed in CODEOWNERS must review the diff and comment '/test-integration' on PR #${pr_number}."
      exit 1
    fi

    if ! is_authorized_maintainer "${pr_user}" "${author_association}"; then
      echo "Skipping automatic GDC Staging integration test for untrusted author '${pr_user}'."
      echo "A maintainer must review the diff and comment '/test-integration' on PR #${pr_number}."
      exit 1
    fi
  elif [[ "${GITHUB_EVENT_NAME:-}" == "issue_comment" && -f "${GITHUB_EVENT_PATH:-}" ]]; then
    local is_pr comment_body comment_user comment_assoc comment_id cmd_line
    is_pr=$(jq -r '.issue.pull_request.url // empty' "${GITHUB_EVENT_PATH}")
    comment_body=$(jq -r '.comment.body // empty' "${GITHUB_EVENT_PATH}")
    comment_user=$(jq -r '.comment.user.login // empty' "${GITHUB_EVENT_PATH}")
    comment_assoc=$(jq -r '.comment.author_association // empty' "${GITHUB_EVENT_PATH}")
    comment_id=$(jq -r '.comment.id // empty' "${GITHUB_EVENT_PATH}")
    PR_NUMBER=$(jq -r '.issue.number // empty' "${GITHUB_EVENT_PATH}")
    export PR_NUMBER

    cmd_line=$(printf '%s\n' "${comment_body}" | tr -d '\r' | grep -E '^[[:space:]]*/test-integration([[:space:]]|$)' | head -n 1 || true)
    if [[ -z "${is_pr}" || -z "${cmd_line}" ]]; then
      echo "Comment does not invoke '/test-integration' on a pull request. Skipping."
      [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "should_run=false" >> "${GITHUB_OUTPUT}"
      return 0
    fi

    if ! is_authorized_maintainer "${comment_user}" "${comment_assoc}"; then
      echo "::error::User '${comment_user}' is not authorized to trigger '/test-integration'."
      exit 1
    fi

    git fetch origin "pull/${PR_NUMBER}/head:pr-${PR_NUMBER}"
    PR_HEAD_SHA=$(git rev-parse "pr-${PR_NUMBER}")
    export PR_HEAD_SHA
    verify_pr_head_at_comment_time

    if [[ -n "${comment_id}" && -n "${GH_TOKEN:-}" && -n "${GITHUB_REPOSITORY:-}" ]]; then
      gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}/reactions" \
        -f content='rocket' >/dev/null 2>&1 || true
    fi

    start_pr_check_run "${check_name}" "queued" "Waiting for gdc-staging environment approval or runner"
  elif [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
    if ! is_authorized_maintainer "${GITHUB_ACTOR:-}" ""; then
      echo "::error::User '${GITHUB_ACTOR:-}' is not authorized to trigger workflow_dispatch."
      exit 1
    fi
    if [[ -n "${PR_NUMBER:-}" ]]; then
      if ! [[ "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
        echo "::error::Invalid pr_number '${PR_NUMBER}'."
        exit 1
      fi
      git fetch origin "pull/${PR_NUMBER}/head:pr-${PR_NUMBER}"
      PR_HEAD_SHA=$(git rev-parse "pr-${PR_NUMBER}")
      export PR_HEAD_SHA
      start_pr_check_run "${check_name}" "queued" "Queued via workflow_dispatch"
    else
      PR_HEAD_SHA=$(git rev-parse HEAD)
      export PR_HEAD_SHA
    fi
  fi

  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "should_run=true" >> "${GITHUB_OUTPUT}"
    echo "pr_number=${PR_NUMBER:-}" >> "${GITHUB_OUTPUT}"
    echo "pr_head_sha=${PR_HEAD_SHA:-}" >> "${GITHUB_OUTPUT}"
    echo "pr_check_run_id=${PR_CHECK_RUN_ID:-}" >> "${GITHUB_OUTPUT}"
  fi
}

mask_secret_value() {
  local xtrace_was_set=false
  if [[ "$-" == *x* ]]; then
    xtrace_was_set=true
    set +x
  fi

  local secret_val="${1:-}"
  if [[ -n "${secret_val}" && "${GITHUB_ACTIONS:-}" == "true" ]]; then
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      if [[ -n "${line}" && "${line}" != "{" && "${line}" != "}" ]]; then
        echo "::add-mask::${line}"
      fi
    done <<< "${secret_val}"
  fi

  if [[ "${xtrace_was_set}" == "true" ]]; then
    set -x
  fi
}

setup_gdc_staging_credentials() {
  local xtrace_was_set=false
  if [[ "$-" == *x* ]]; then
    xtrace_was_set=true
    set +x
  fi

  local sa_file="$1"
  local ca_file="$2"
  local org="$3"
  local zone="$4"
  local lab_url="$5"
  local sa_key="${6:-}"

  if [[ -z "${sa_key}" && ! -s "${sa_file}" ]]; then
    echo "::error::GDC_CAS_STAGING_SA_KEY secret is not configured in the gdc-staging environment."
    exit 1
  fi

  if [[ -n "${sa_key}" ]]; then
    mask_secret_value "${sa_key}"
    umask 077
    printf '%s\n' "${sa_key}" > "${sa_file}"
    chmod 600 "${sa_file}"
  fi

  if [[ ! -s "${ca_file}" ]]; then
    local ca_endpoint="https://console.${org}.${zone}.${lab_url}/.well-known/certificate-authority"
    echo "Bootstrapping GDC Staging Root CA from ${ca_endpoint}..."
    # The bootstrap endpoint serves the self-signed root CA that signs the GDC
    # cluster ingress certificates; validate that the fetched payload is a valid PEM cert.
    if ! curl -ksSL --fail --retry 3 --max-time 20 "${ca_endpoint}" -o "${ca_file}"; then
      echo "::error::Failed to fetch GDC Root CA from ${ca_endpoint}"
      exit 1
    fi
    if ! grep -q "BEGIN CERTIFICATE" "${ca_file}"; then
      echo "::error::Invalid Root CA PEM returned from ${ca_endpoint}"
      exit 1
    fi
  fi

  if [[ "${xtrace_was_set}" == "true" ]]; then
    set -x
  fi
}
