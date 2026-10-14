#!/usr/bin/env bash

# Decide whether a push to main can change the API image/runtime. Any inability
# to prove that it cannot is a deploy (fail-closed).
set -u

ZERO_SHA=0000000000000000000000000000000000000000
API_DEPLOY_REQUIRED=true
API_DEPLOY_REASON="fail-closed default"

path_requires_api_deploy() {
  case "$1" in
    .dockerignore | package.json | package-lock.json | package-lock.json.* | turbo.json | tsconfig*.json | \
      apps/web/package.json | apps/api/* | packages/domain/* | prisma/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

detect_from_commits() {
  local event_name="$1"
  local ref="$2"
  local before="$3"
  local head="$4"
  local changed_file path

  API_DEPLOY_REQUIRED=true
  API_DEPLOY_REASON="fail-closed default"

  if [[ "$event_name" != "push" || "$ref" != "refs/heads/main" ]]; then
    API_DEPLOY_REASON="unexpected event/ref: ${event_name}:${ref}"
    return 0
  fi
  if [[ ! "$before" =~ ^[0-9a-f]{40}$ || "$before" == "$ZERO_SHA" ]]; then
    API_DEPLOY_REASON="missing, zero, or invalid before SHA"
    return 0
  fi
  if [[ ! "$head" =~ ^[0-9a-f]{40}$ ]]; then
    API_DEPLOY_REASON="missing or invalid head SHA"
    return 0
  fi
  if ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
    API_DEPLOY_REASON="before commit is unavailable"
    return 0
  fi
  if ! git cat-file -e "${head}^{commit}" 2>/dev/null; then
    API_DEPLOY_REASON="head commit is unavailable"
    return 0
  fi

  changed_file="$(mktemp)" || {
    API_DEPLOY_REASON="could not allocate diff file"
    return 0
  }
  if ! git diff --no-renames --name-only -z "$before" "$head" -- >"$changed_file"; then
    rm -f "$changed_file"
    API_DEPLOY_REASON="git diff failed"
    return 0
  fi

  API_DEPLOY_REQUIRED=false
  API_DEPLOY_REASON="no API image/runtime input changed"
  while IFS= read -r -d "" path; do
    if path_requires_api_deploy "$path"; then
      API_DEPLOY_REQUIRED=true
      API_DEPLOY_REASON="API image/runtime input changed: $path"
      break
    fi
  done <"$changed_file"
  rm -f "$changed_file"
}

emit_decision() {
  local value="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf "deploy_api=%s\n" "$value" >>"$GITHUB_OUTPUT"
  else
    printf "deploy_api=%s\n" "$value"
  fi
  printf "API deploy required: %s (%s)\n" "$value" "$API_DEPLOY_REASON"
}

assert_path() {
  local expected="$1"
  local path="$2"
  local actual=false
  if path_requires_api_deploy "$path"; then actual=true; fi
  if [[ "$actual" != "$expected" ]]; then
    printf "not ok - %s expected %s, got %s\n" "$path" "$expected" "$actual" >&2
    return 1
  fi
  printf "ok - %s => %s\n" "$path" "$actual"
}

self_test() {
  local path tmp base head

  for path in apps/web/src/app/page.tsx docs/runbook.md .github/workflows/ci.yml scripts/ci/api-deploy-required.sh; do
    assert_path false "$path" || return 1
  done
  for path in \
    apps/api/src/main.ts \
    apps/api/Dockerfile \
    apps/api/docker-entrypoint.sh \
    packages/domain/src/index.ts \
    prisma/schema.prisma \
    package.json \
    package-lock.json \
    turbo.json \
    tsconfig.json \
    .dockerignore \
    apps/web/package.json; do
    assert_path true "$path" || return 1
  done

  tmp="$(mktemp -d)" || return 1
  (
    cd "$tmp" || exit 1
    git init -q
    git config user.name "API deploy guard test"
    git config user.email "api-deploy-guard@example.invalid"
    printf "base\n" >README.md
    git add README.md
    git commit -qm base
    base="$(git rev-parse HEAD)"
    mkdir -p apps/web/src docs
    printf "web\n" >apps/web/src/page.tsx
    printf "docs\n" >docs/readme.md
    git add apps/web/src/page.tsx docs/readme.md
    git commit -qm web-docs
    head="$(git rev-parse HEAD)"

    detect_from_commits push refs/heads/main "$base" "$head"
    [[ "$API_DEPLOY_REQUIRED" == false ]] || exit 1
    printf "ok - web/docs-only diff => false\n"

    detect_from_commits push refs/heads/main "" "$head"
    [[ "$API_DEPLOY_REQUIRED" == true ]] || exit 1
    printf "ok - absent base => true\n"

    detect_from_commits push refs/heads/main 1111111111111111111111111111111111111111 "$head"
    [[ "$API_DEPLOY_REQUIRED" == true ]] || exit 1
    printf "ok - unavailable base => true\n"

    detect_from_commits push refs/heads/main "$ZERO_SHA" "$head"
    [[ "$API_DEPLOY_REQUIRED" == true ]] || exit 1
    printf "ok - zero base => true\n"

    detect_from_commits pull_request refs/pull/1/merge "$base" "$head"
    [[ "$API_DEPLOY_REQUIRED" == true ]] || exit 1
    printf "ok - unexpected event => true\n"
  )
  local status=$?
  rm -rf "$tmp"
  return "$status"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

EVENT_NAME="${GITHUB_EVENT_NAME:-}"
EVENT_REF="${GITHUB_REF:-}"
BEFORE_SHA="${EVENT_BEFORE:-}"
HEAD_SHA="${GITHUB_SHA:-}"

# checkout uses fetch-depth: 0; refresh main and explicitly fetch an event SHA
# if it is not already present. Any fetch/history failure stays fail-closed.
if [[ "$EVENT_NAME" == push && "$EVENT_REF" == refs/heads/main \
      && "$BEFORE_SHA" =~ ^[0-9a-f]{40}$ && "$BEFORE_SHA" != "$ZERO_SHA" \
      && "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  if ! git fetch --no-tags origin main; then
    API_DEPLOY_REASON="could not fetch main history"
    emit_decision true
    exit 0
  fi
  for commit in "$BEFORE_SHA" "$HEAD_SHA"; do
    if ! git cat-file -e "${commit}^{commit}" 2>/dev/null \
       && ! git fetch --no-tags origin "$commit"; then
      API_DEPLOY_REASON="could not fetch event commit $commit"
      emit_decision true
      exit 0
    fi
  done
fi

detect_from_commits "$EVENT_NAME" "$EVENT_REF" "$BEFORE_SHA" "$HEAD_SHA"
emit_decision "$API_DEPLOY_REQUIRED"
