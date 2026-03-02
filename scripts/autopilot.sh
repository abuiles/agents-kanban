#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:5173}"
REPO_ID="${REPO_ID:-repo_abuiles_minions}"
POLL_SECONDS="${POLL_SECONDS:-12}"
STUCK_SECONDS="${STUCK_SECONDS:-600}"
STUCK_BOOTSTRAP_SECONDS="${STUCK_BOOTSTRAP_SECONDS:-240}"
WORKDIR="${WORKDIR:-/Users/abuiles/code/my-sandbox}"
LOG_PREFIX="${LOG_PREFIX:-[autopilot]}"
DEV_LOG="${DEV_LOG:-$WORKDIR/logs/devserver.log}"

mkdir -p "$WORKDIR/logs"

log() {
  printf "%s %s %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$LOG_PREFIX" "$*"
}

api_get() {
  local path="$1"
  curl -fsS "$API_BASE$path"
}

api_patch() {
  local path="$1"
  local payload="$2"
  curl -fsS -X PATCH "$API_BASE$path" -H 'content-type: application/json' --data "$payload"
}

api_post() {
  local path="$1"
  local payload="${2:-}"
  if [[ -n "$payload" ]]; then
    curl -fsS -X POST "$API_BASE$path" -H 'content-type: application/json' --data "$payload"
  else
    curl -fsS -X POST "$API_BASE$path" -H 'content-type: application/json' --data '{}'
  fi
}

api_post_json() {
  local path="$1"
  local payload="$2"
  curl -fsS -X POST "$API_BASE$path" -H 'content-type: application/json' --data "$payload"
}

ensure_api_up() {
  if curl -fsS "$API_BASE/api/tasks?repoId=$REPO_ID" >/dev/null 2>&1; then
    return 0
  fi
  log "API unreachable at $API_BASE. Attempting to start local dev server."
  (
    cd "$WORKDIR"
    nohup yarn dev >>"$DEV_LOG" 2>&1 &
  )
  sleep 5
}

merge_pr_if_ready() {
  local pr_url="$1"
  if [[ -z "$pr_url" || "$pr_url" == "null" ]]; then
    return 1
  fi

  local repo
  local number
  repo="$(printf '%s\n' "$pr_url" | sed -E 's#https://github.com/([^/]+/[^/]+)/pull/[0-9]+#\1#')"
  number="$(printf '%s\n' "$pr_url" | sed -E 's#.*/pull/([0-9]+).*#\1#')"
  if [[ -z "$repo" || -z "$number" ]]; then
    return 1
  fi

  local state merge_state
  state="$(gh pr view "$number" -R "$repo" --json state -q .state 2>/dev/null || true)"
  merge_state="$(gh pr view "$number" -R "$repo" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null || true)"
  if [[ "$state" == "MERGED" ]]; then
    return 0
  fi
  if [[ "$state" == "OPEN" && ("$merge_state" == "CLEAN" || "$merge_state" == "HAS_HOOKS") ]]; then
    if gh pr merge "$number" -R "$repo" --squash --delete-branch --admin >/dev/null 2>&1; then
      log "Merged PR #$number ($repo)."
      sync_local_main || true
      return 0
    fi
  fi
  return 1
}

sync_local_main() {
  if [[ ! -d "$WORKDIR/.git" ]]; then
    return 0
  fi
  (
    cd "$WORKDIR"
    git checkout main >/dev/null 2>&1 || return 0
    git pull --ff-only origin main >/dev/null 2>&1 || return 0
  )
  log "Synced local main to origin/main."
}

dependencies_ready() {
  local task_json="$1"
  local tasks_json="$2"
  local deps
  deps="$(printf '%s' "$task_json" | jq -r '.dependsOn // [] | @json')"
  if [[ "$deps" == "[]" ]]; then
    return 0
  fi
  printf '%s' "$deps" | jq -e --argjson tasks "$tasks_json" '
    all(.[]; ($tasks[] | select(.taskId == .) | .status) == "DONE")
  ' >/dev/null 2>&1
}

pick_next_inbox_task() {
  local tasks_json="$1"
  printf '%s' "$tasks_json" | jq -c '
    sort_by(.createdAt)[] | select(.status == "INBOX")
  ' | while IFS= read -r task; do
    if dependencies_ready "$task" "$tasks_json"; then
      printf '%s\n' "$task"
      return 0
    fi
  done
  return 1
}

main_loop() {
  log "Starting watcher for repoId=$REPO_ID against $API_BASE"
  while true; do
    ensure_api_up
    local tasks_json
    if ! tasks_json="$(api_get "/api/tasks?repoId=$REPO_ID" 2>/dev/null)"; then
      log "Failed to list tasks. Retrying."
      sleep "$POLL_SECONDS"
      continue
    fi

    local failed_task
    failed_task="$(printf '%s' "$tasks_json" | jq -c 'sort_by(.updatedAt) | .[] | select(.status=="FAILED")' | head -n1 || true)"
    if [[ -n "$failed_task" ]]; then
      local failed_task_id failed_run_id
      failed_task_id="$(printf '%s' "$failed_task" | jq -r '.taskId')"
      failed_run_id="$(printf '%s' "$failed_task" | jq -r '.runId // empty')"

      local active_task_for_gate
      active_task_for_gate="$(printf '%s' "$tasks_json" | jq -c '.[] | select(.status=="ACTIVE")' | head -n1 || true)"
      if [[ -n "$active_task_for_gate" ]]; then
        local active_task_id_for_gate
        active_task_id_for_gate="$(printf '%s' "$active_task_for_gate" | jq -r '.taskId')"
        if [[ "$active_task_id_for_gate" != "$failed_task_id" ]]; then
          log "Blocking queue: failed task $failed_task_id must be retried before continuing (currently active: $active_task_id_for_gate)."
          sleep "$POLL_SECONDS"
          continue
        fi
      fi

      if [[ -n "$failed_run_id" ]]; then
        api_post "/api/runs/$failed_run_id/retry" >/dev/null 2>&1 && log "Retried failed task $failed_task_id via run $failed_run_id."
        sleep "$POLL_SECONDS"
        continue
      fi
      api_patch "/api/tasks/$failed_task_id" '{"status":"ACTIVE"}' >/dev/null 2>&1 || true
      api_post "/api/tasks/$failed_task_id/run" >/dev/null 2>&1 && log "Retried failed task $failed_task_id with a new run."
      sleep "$POLL_SECONDS"
      continue
    fi

    local active_task
    active_task="$(printf '%s' "$tasks_json" | jq -c '.[] | select(.status=="ACTIVE")' | head -n1 || true)"
    if [[ -n "$active_task" ]]; then
      local task_id run_id
      task_id="$(printf '%s' "$active_task" | jq -r '.taskId')"
      run_id="$(printf '%s' "$active_task" | jq -r '.runId // empty')"
      if [[ -z "$run_id" ]]; then
        api_post "/api/tasks/$task_id/run" >/dev/null 2>&1 && log "Started run for ACTIVE task $task_id."
        sleep "$POLL_SECONDS"
        continue
      fi
      local run_json run_status pr_url
      run_json="$(api_get "/api/runs/$run_id" 2>/dev/null || true)"
      run_status="$(printf '%s' "$run_json" | jq -r '.status // "UNKNOWN"')"
      pr_url="$(printf '%s' "$run_json" | jq -r '.prUrl // empty')"

      if [[ "$run_status" == "BOOTSTRAPPING" ]]; then
        local bootstrap_started_iso bootstrap_stuck_seconds
        bootstrap_started_iso="$(printf '%s' "$run_json" | jq -r '.currentStepStartedAt // empty')"
        if [[ -n "$bootstrap_started_iso" ]]; then
          bootstrap_stuck_seconds="$(jq -nr --arg ts "$bootstrap_started_iso" '((now - ($ts | fromdateiso8601)) | floor)')"
          if [[ "$bootstrap_stuck_seconds" =~ ^[0-9]+$ ]] && (( bootstrap_stuck_seconds > STUCK_BOOTSTRAP_SECONDS )); then
            log "Detected stuck BOOTSTRAPPING run $run_id (${bootstrap_stuck_seconds}s). Cancelling and restarting."
            api_post_json "/api/runs/$run_id/cancel" '{"reason":"Auto-cancelled by autopilot due to bootstrapping timeout."}' >/dev/null 2>&1 || true
            api_post "/api/tasks/$task_id/run" >/dev/null 2>&1 || true
            sleep "$POLL_SECONDS"
            continue
          fi
        fi
      fi

      if [[ "$run_status" == "RUNNING_CODEX" ]]; then
        local last_log_iso stuck_seconds
        last_log_iso="$(api_get "/api/runs/$run_id/logs?tail=1" 2>/dev/null | jq -r '.[0].createdAt // empty' || true)"
        if [[ -n "$last_log_iso" ]]; then
          stuck_seconds="$(jq -nr --arg ts "$last_log_iso" '((now - ($ts | fromdateiso8601)) | floor)')"
          if [[ "$stuck_seconds" =~ ^[0-9]+$ ]] && (( stuck_seconds > STUCK_SECONDS )); then
            log "Detected stuck RUNNING_CODEX run $run_id (last log ${stuck_seconds}s ago). Cancelling and restarting."
            api_post_json "/api/runs/$run_id/cancel" '{"reason":"Auto-cancelled by autopilot due to codex inactivity timeout."}' >/dev/null 2>&1 || true
            api_post "/api/tasks/$task_id/run" >/dev/null 2>&1 || true
            sleep "$POLL_SECONDS"
            continue
          fi
        fi
      fi

      case "$run_status" in
        QUEUED|BOOTSTRAPPING|RUNNING_CODEX|OPERATOR_CONTROLLED|RUNNING_TESTS|PUSHING_BRANCH|PR_OPEN|WAITING_PREVIEW|CAPTURING_EVIDENCE)
          if [[ "$run_status" == "WAITING_PREVIEW" || "$run_status" == "PR_OPEN" ]]; then
            if merge_pr_if_ready "$pr_url"; then
              api_patch "/api/tasks/$task_id" '{"status":"DONE"}' >/dev/null 2>&1 || true
              log "Task $task_id marked DONE after merge."
            fi
          fi
          ;;
        REVIEW)
          if merge_pr_if_ready "$pr_url"; then
            api_patch "/api/tasks/$task_id" '{"status":"DONE"}' >/dev/null 2>&1 || true
            log "Task $task_id marked DONE from REVIEW after merge."
          else
            api_patch "/api/tasks/$task_id" '{"status":"REVIEW"}' >/dev/null 2>&1 || true
            log "Task $task_id moved to REVIEW."
          fi
          ;;
        COMPLETED|DONE)
          if merge_pr_if_ready "$pr_url"; then
            api_patch "/api/tasks/$task_id" '{"status":"DONE"}' >/dev/null 2>&1 || true
            log "Task $task_id finalized as DONE."
          else
            api_patch "/api/tasks/$task_id" '{"status":"REVIEW"}' >/dev/null 2>&1 || true
            log "Task $task_id moved to REVIEW (manual merge needed)."
          fi
          ;;
        FAILED|CANCELLED)
          api_post "/api/runs/$run_id/retry" >/dev/null 2>&1 && log "Retried failed run $run_id."
          ;;
      esac

      sleep "$POLL_SECONDS"
      continue
    fi

    local review_task
    review_task="$(printf '%s' "$tasks_json" | jq -c '.[] | select(.status=="REVIEW")' | head -n1 || true)"
    if [[ -n "$review_task" ]]; then
      local task_id run_id run_json pr_url
      task_id="$(printf '%s' "$review_task" | jq -r '.taskId')"
      run_id="$(printf '%s' "$review_task" | jq -r '.runId // empty')"
      if [[ -n "$run_id" ]]; then
        run_json="$(api_get "/api/runs/$run_id" 2>/dev/null || true)"
        pr_url="$(printf '%s' "$run_json" | jq -r '.prUrl // empty')"
        if merge_pr_if_ready "$pr_url"; then
          api_patch "/api/tasks/$task_id" '{"status":"DONE"}' >/dev/null 2>&1 || true
          log "Merged REVIEW task $task_id and marked DONE."
          sleep "$POLL_SECONDS"
          continue
        fi
      fi
    fi

    local next_task
    next_task="$(pick_next_inbox_task "$tasks_json" || true)"
    if [[ -n "$next_task" ]]; then
      local next_task_id
      next_task_id="$(printf '%s' "$next_task" | jq -r '.taskId')"
      api_patch "/api/tasks/$next_task_id" '{"status":"ACTIVE"}' >/dev/null 2>&1 && log "Activated next task $next_task_id."
      sleep 1
      api_post "/api/tasks/$next_task_id/run" >/dev/null 2>&1 && log "Started run for $next_task_id."
      sleep "$POLL_SECONDS"
      continue
    fi

    log "No actionable tasks right now."
    sleep "$POLL_SECONDS"
  done
}

main_loop
