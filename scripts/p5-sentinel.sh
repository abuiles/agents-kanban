#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:5173}"
REPO_ID="${REPO_ID:-repo_abuiles_agents_kanban}"
POLL_SECONDS="${POLL_SECONDS:-12}"
TASK_PREFIX="${TASK_PREFIX:-T}"
LOG_PREFIX="${LOG_PREFIX:-[p5-sentinel]}"
DRY_RUN="${DRY_RUN:-0}"
TOKEN="${AGENTS_KANBAN_TOKEN:-}"
AUTO_RETRY_FAILED="${AUTO_RETRY_FAILED:-1}"
MAX_FAILED_RETRIES="${MAX_FAILED_RETRIES:-2}"
ACTIVATION_LOCK_DIR="${ACTIVATION_LOCK_DIR:-/tmp/p5-sentinel-activation-${TASK_PREFIX}.lock}"
ACTIVATION_LOCK_TTL_SECONDS="${ACTIVATION_LOCK_TTL_SECONDS:-120}"
declare -A FAILED_RETRY_COUNTS=()

log() {
  printf "%s %s %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$LOG_PREFIX" "$*"
}

require_bin() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "Missing required binary: $bin"
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    log "Missing required env var: $name"
    exit 1
  fi
}

api_get() {
  local path="$1"
  curl -fsS "$API_BASE$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json'
}

api_patch() {
  local path="$1"
  local payload="$2"
  curl -fsS -X PATCH "$API_BASE$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "$payload"
}

api_post() {
  local path="$1"
  local payload="${2:-{}}"
  curl -fsS -X POST "$API_BASE$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "$payload"
}

ordered_chain_tasks() {
  api_get "/api/tasks?repoId=$REPO_ID" | jq -c --arg prefix "$TASK_PREFIX" '
    [
      .[]
      | select(.title | test("^" + $prefix + "[0-9]+\\s-\\s"))
      | . + {
          order: (
            .title
            | capture("^" + $prefix + "(?<n>[0-9]+)")
            | .n
            | tonumber
          )
        }
    ]
    | sort_by(.order)
    | map(del(.order))
  '
}

first_not_done() {
  local tasks_json="$1"
  printf '%s' "$tasks_json" | jq -c '.[] | select(.status != "DONE")' | head -n1 || true
}

count_prefix_active_tasks() {
  api_get "/api/tasks?repoId=$REPO_ID" | jq --arg prefix "$TASK_PREFIX" '
    [
      .[]
      | select(.status == "ACTIVE")
      | select(.title | test("^" + $prefix + "[0-9]+\\s-\\s"))
    ]
    | length
  '
}

acquire_activation_lock() {
  local now lock_pid lock_ts
  now="$(date +%s)"

  if mkdir "$ACTIVATION_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$ACTIVATION_LOCK_DIR/pid"
    printf '%s\n' "$now" > "$ACTIVATION_LOCK_DIR/ts"
    return 0
  fi

  lock_pid="$(cat "$ACTIVATION_LOCK_DIR/pid" 2>/dev/null || true)"
  lock_ts="$(cat "$ACTIVATION_LOCK_DIR/ts" 2>/dev/null || true)"
  if [[ -z "$lock_pid" ]] || ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -rf "$ACTIVATION_LOCK_DIR" 2>/dev/null || true
    if mkdir "$ACTIVATION_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$ACTIVATION_LOCK_DIR/pid"
      printf '%s\n' "$now" > "$ACTIVATION_LOCK_DIR/ts"
      return 0
    fi
  fi

  if [[ -n "$lock_ts" ]] && (( now - lock_ts > ACTIVATION_LOCK_TTL_SECONDS )); then
    rm -rf "$ACTIVATION_LOCK_DIR" 2>/dev/null || true
    if mkdir "$ACTIVATION_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$ACTIVATION_LOCK_DIR/pid"
      printf '%s\n' "$now" > "$ACTIVATION_LOCK_DIR/ts"
      return 0
    fi
  fi

  return 1
}

release_activation_lock() {
  if [[ -d "$ACTIVATION_LOCK_DIR" ]]; then
    rm -rf "$ACTIVATION_LOCK_DIR" 2>/dev/null || true
  fi
}

activate_and_run_task() {
  local task_json="$1"
  local task_id
  task_id="$(printf '%s' "$task_json" | jq -r '.taskId')"
  local status
  status="$(printf '%s' "$task_json" | jq -r '.status')"

  if [[ "$status" == "INBOX" || "$status" == "READY" ]]; then
    if ! acquire_activation_lock; then
      log "Activation lock is held by another sentinel. Waiting before activating task $task_id."
      return 0
    fi

    local active_count
    active_count="$(count_prefix_active_tasks)"
    if (( active_count > 0 )); then
      log "Detected $active_count ACTIVE task(s) in prefix lane ${TASK_PREFIX}. Waiting before activating task $task_id."
      release_activation_lock
      return 0
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      log "DRY_RUN would set task $task_id to ACTIVE and start run."
      release_activation_lock
      return 0
    fi
    api_patch "/api/tasks/$task_id" '{"status":"ACTIVE"}' >/dev/null
    log "Task $task_id moved to ACTIVE."
    api_post "/api/tasks/$task_id/run" '{}' >/dev/null
    log "Run started for task $task_id."
    release_activation_lock
    return 0
  fi

  if [[ "$status" == "ACTIVE" ]]; then
    local run_id
    run_id="$(printf '%s' "$task_json" | jq -r '.runId // empty')"
    if [[ -z "$run_id" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN would start run for ACTIVE task $task_id."
        return 0
      fi
      api_post "/api/tasks/$task_id/run" '{}' >/dev/null
      log "Run started for ACTIVE task $task_id (was missing runId)."
    fi
  fi
}

merge_review_task() {
  local task_json="$1"
  local task_id run_id
  task_id="$(printf '%s' "$task_json" | jq -r '.taskId')"
  run_id="$(printf '%s' "$task_json" | jq -r '.runId // empty')"

  if [[ -z "$run_id" ]]; then
    log "Task $task_id is REVIEW but has no runId. Skipping."
    return 1
  fi

  local run_json review_url
  run_json="$(api_get "/api/runs/$run_id")"
  review_url="$(printf '%s' "$run_json" | jq -r '.reviewUrl // .prUrl // empty')"

  if [[ -z "$review_url" ]]; then
    log "Task $task_id run $run_id has no reviewUrl/prUrl. Skipping."
    return 1
  fi

  if [[ ! "$review_url" =~ ^https://github\.com/.*/pull/[0-9]+ ]]; then
    log "Task $task_id review URL is not a GitHub PR: $review_url"
    return 1
  fi

  local state
  state="$(gh pr view "$review_url" --json state -q .state 2>/dev/null || true)"

  if [[ "$state" == "MERGED" ]]; then
    log "PR already merged for task $task_id: $review_url"
  else
    if [[ "$DRY_RUN" == "1" ]]; then
      log "DRY_RUN would merge PR for task $task_id: $review_url"
    else
      gh pr merge "$review_url" --squash --delete-branch >/dev/null
      log "Merged PR for task $task_id: $review_url"
    fi
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would mark task $task_id as DONE."
    return 0
  fi

  api_patch "/api/tasks/$task_id" '{"status":"DONE"}' >/dev/null
  log "Task $task_id moved to DONE."
}

retry_failed_task() {
  local task_json="$1"
  local task_id title run_id
  task_id="$(printf '%s' "$task_json" | jq -r '.taskId')"
  title="$(printf '%s' "$task_json" | jq -r '.title')"
  run_id="$(printf '%s' "$task_json" | jq -r '.runId // empty')"

  if [[ "$AUTO_RETRY_FAILED" != "1" ]]; then
    log "Current chain task failed ($task_id $title). Auto-retry disabled."
    return 0
  fi

  local retries
  retries="${FAILED_RETRY_COUNTS[$task_id]:-0}"
  if (( retries >= MAX_FAILED_RETRIES )); then
    log "Current chain task failed ($task_id $title). Reached max auto-retries (${MAX_FAILED_RETRIES}); manual intervention required."
    return 0
  fi
  retries=$((retries + 1))
  FAILED_RETRY_COUNTS[$task_id]="$retries"
  log "Auto-retry attempt ${retries}/${MAX_FAILED_RETRIES} for failed task $task_id."

  if [[ -n "$run_id" ]]; then
    local run_json run_status execution_summary last_error
    if run_json="$(api_get "/api/runs/$run_id" 2>/dev/null)"; then
      run_status="$(printf '%s' "$run_json" | jq -r '.status // "unknown"')"
      execution_summary="$(printf '%s' "$run_json" | jq -r '
        .executionSummary as $s
        | if ($s | type) == "string" then $s
          elif ($s | type) == "object" then ($s.message // $s.summary // $s.error // empty)
          else empty
          end
      ')"
      last_error="$(printf '%s' "$run_json" | jq -r '
        (.errors // []) as $errors
        | if ($errors | length) > 0
          then ($errors[-1].message // $errors[-1].detail // $errors[-1].code // empty)
          else empty
          end
      ')"
      log "FAILED task diagnostics for $task_id: run=$run_id status=$run_status summary='${execution_summary:-n/a}' last_error='${last_error:-n/a}'."
    else
      log "FAILED task diagnostics unavailable for $task_id (run lookup failed for $run_id)."
    fi
  else
    log "FAILED task diagnostics for $task_id: no runId attached."
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would retry failed task $task_id."
    return 0
  fi

  if [[ -n "$run_id" ]]; then
    local retry_json retry_run_id
    if retry_json="$(api_post "/api/runs/$run_id/retry" '{}' 2>/dev/null)"; then
      retry_run_id="$(printf '%s' "$retry_json" | jq -r '.runId // empty')"
      log "Auto-retried failed task $task_id via run retry endpoint (new run: ${retry_run_id:-unknown})."
      return 0
    fi
    log "Run retry endpoint failed for task $task_id run $run_id. Falling back to task rerun."
  fi

  api_patch "/api/tasks/$task_id" '{"status":"ACTIVE"}' >/dev/null || true
  api_post "/api/tasks/$task_id/run" '{}' >/dev/null
  log "Auto-retried failed task $task_id via task run fallback."
}

main() {
  require_bin curl
  require_bin jq
  require_bin gh
  require_env TOKEN

  log "Starting sentinel for repoId=$REPO_ID on $API_BASE (task prefix: $TASK_PREFIX)"

  while true; do
    local tasks_json current
    if ! tasks_json="$(ordered_chain_tasks)"; then
      log "Failed to fetch chain tasks. Retrying."
      sleep "$POLL_SECONDS"
      continue
    fi

    if [[ "$(printf '%s' "$tasks_json" | jq 'length')" -eq 0 ]]; then
      log "No ${TASK_PREFIX}* chain tasks found for repo $REPO_ID."
      sleep "$POLL_SECONDS"
      continue
    fi

    current="$(first_not_done "$tasks_json")"
    if [[ -z "$current" ]]; then
      log "All chain tasks are DONE. Sentinel exiting."
      break
    fi

    local task_id title status
    task_id="$(printf '%s' "$current" | jq -r '.taskId')"
    title="$(printf '%s' "$current" | jq -r '.title')"
    status="$(printf '%s' "$current" | jq -r '.status')"

    case "$status" in
      REVIEW)
        merge_review_task "$current" || true
        ;;
      INBOX|READY|ACTIVE)
        activate_and_run_task "$current"
        ;;
      FAILED)
        retry_failed_task "$current"
        ;;
      *)
        log "Current task $task_id ($title) status=$status. Waiting."
        ;;
    esac

    sleep "$POLL_SECONDS"
  done
}

main
