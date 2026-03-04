# Native Sentinel Orchestration

This guide covers setup, operations, troubleshooting, and rollout for the built-in sentinel orchestration flow.

## Scope

Native sentinel replaces script-based task progression (`scripts/autopilot.sh`, `scripts/p5-sentinel.sh`) with repo-level API/UI controls and event timelines.

## Setup

1. Ensure repo sentinel config is enabled:

```http
PATCH /api/repos/:repoId/sentinel/config
Content-Type: application/json

{
  "enabled": true,
  "globalMode": false,
  "defaultGroupTag": "payments",
  "reviewGate": {
    "requireChecksGreen": true,
    "requireAutoReviewPass": true
  },
  "mergePolicy": {
    "autoMergeEnabled": true,
    "method": "squash",
    "deleteBranch": true
  },
  "conflictPolicy": {
    "rebaseBeforeMerge": true,
    "remediationEnabled": true,
    "maxAttempts": 2
  }
}
```

2. Start sentinel:

```http
POST /api/repos/:repoId/sentinel/start
Content-Type: application/json

{
  "scopeType": "group",
  "scopeValue": "payments"
}
```

3. Read status + diagnostics:

- `GET /api/repos/:repoId/sentinel`
- `GET /api/repos/:repoId/sentinel/events?limit=50`

## Operator Controls

- `POST /api/repos/:repoId/sentinel/start`
- `POST /api/repos/:repoId/sentinel/pause`
- `POST /api/repos/:repoId/sentinel/resume`
- `POST /api/repos/:repoId/sentinel/stop`

Behavior notes:

- `start` is idempotent-safe; duplicate concurrent starts reuse the existing running run.
- `resume`/`start` are blocked when `sentinelConfig.enabled = false`.
- Sentinel runs serially per scope (`concurrency = 1`).

## Observability

Status response includes:

- `run`: current sentinel run status/scope/current task/run/attempt count
- `events`: latest timeline entries
- `diagnostics`:
  - `latestEvent`
  - `latestWarningEvent`
  - `latestErrorEvent`

Timeline event types include:

- lifecycle: `sentinel.started`, `sentinel.paused`, `sentinel.resumed`, `sentinel.stopped`
- progression: `task.activated`, `run.started`
- gates/merge: `review.gate.waiting`, `merge.attempted`, `merge.succeeded`, `merge.failed`
- remediation: `remediation.started`, `remediation.succeeded`, `remediation.failed`

Actionable metadata fields appear on events (for example):

- `taskId`, `runId`, `attempt`, `attemptCount`, `reason`
- `reviewGateChecksGreen`, `reviewGateMergeable`, `reviewGateOpenFindings`, `reviewGateReasons`

## Hardening

Native sentinel includes race protections:

- Per-run lease on progression controller execution (prevents duplicate concurrent processing).
- Single running sentinel per repo enforced at persistence layer.
- Scope lock (`claimSentinelRunTask`) prevents duplicate task activation ownership.

## Troubleshooting

### Start/Resume rejected

Cause:

- `sentinelConfig.enabled` is false.

Fix:

- Enable via `PATCH /api/repos/:repoId/sentinel/config` and retry.

### Sentinel stuck in waiting

Cause:

- review gate not satisfied (`checks`, mergeability, open findings), or no eligible tasks.

Fix:

- inspect `GET /api/repos/:repoId/sentinel` diagnostics and event metadata `reason`/`reviewGate*`
- resolve checks/findings, then `POST /api/repos/:repoId/sentinel/resume`

### Repeated merge failures

Cause:

- merge conflict/remediation exhaustion.

Fix:

- inspect `merge.failed` + `remediation.*` events and `attemptCount`
- apply manual remediation if needed
- `POST /api/repos/:repoId/sentinel/resume` to retry, or `stop` and continue manually

## Script-to-native migration

1. Stop script loops:
   - `scripts/autopilot.sh`
   - `scripts/p5-sentinel.sh`
2. Enable native sentinel per pilot repo.
3. Start with group scope first.
4. Validate at least one full successful lifecycle from events timeline.
5. Expand to global scope after stability checks.

## Rollout and fallback

Recommended rollout:

1. Keep default `sentinelConfig.enabled = false`.
2. Enable one pilot repo + one group.
3. Observe timelines and remediation behavior for multiple cycles.
4. Expand to more groups/repos, then global mode.

Fallback:

1. `POST /api/repos/:repoId/sentinel/stop`
2. `PATCH /api/repos/:repoId/sentinel/config` with `{"enabled":false}`
3. Continue manual run control (`POST /api/tasks/:taskId/run`)
4. Re-enable native sentinel only after root cause is identified from event diagnostics
