# Stage: Built-in Sentinel Orchestration

**Status:** Planned

## Goal

Make Sentinel a first-class AgentsKanban capability (not script-only), so operators can:

1. Define sentinel scope by group of tasks or all upcoming tasks.
2. Turn sentinel on/off from product controls.
3. Automatically progress tasks through `INBOX/READY -> ACTIVE -> REVIEW -> DONE`.
4. Merge only after review is complete and quality gates pass.
5. Use repo-level merge preferences (squash/rebase/merge, delete branch, etc).
6. Recover from merge/rebase conflicts with bounded remediation attempts.

## Product Decisions (Locked)

1. Scope modes are both supported:
   - group scope
   - global scope (all upcoming tasks)
2. Groups are defined by task tags, not title parsing.
3. Sentinel runs serially per scope (`concurrency = 1`).
4. Merge from `REVIEW` only after review completion gate passes:
   - checks green/mergeable
   - no open auto-review findings
5. Sentinel controls live in repo settings and API.
6. Merge behavior is repo-configurable and mirrors GitHub options where possible.
7. If merge fails, sentinel attempts rebase/remediation, then retries merge up to configured limits.

## Scope and Non-Goals

### In scope

1. Built-in sentinel configuration and lifecycle.
2. Group/global task selection and progression.
3. Review gate and merge policy engine.
4. Conflict remediation flow and pause-on-failure.
5. Sentinel observability/audit surfaces.

### Out of scope (for this stage)

1. Multi-repo cross-orchestration in one sentinel run.
2. Arbitrary workflow DSL for custom pipelines.
3. Full policy-as-code engine.

## Architecture Overview

Introduce a native sentinel orchestration layer in server runtime:

1. `SentinelConfigResolver`:
   - resolves repo sentinel settings and effective scope/policies.
2. `SentinelSelector`:
   - computes eligible next task for a scope.
3. `SentinelController`:
   - state machine that activates tasks, monitors runs, gates merges, and advances queue.
4. `SentinelMergeEngine`:
   - applies repo merge policy and handles merge attempts.
5. `SentinelRemediationEngine`:
   - runs rebase/remediation strategy when merge fails.
6. `SentinelEvents`:
   - immutable audit/events feed for operator visibility.

Use lease/lock semantics to prevent two sentinels from controlling the same task/scope concurrently.

## Data Model Additions

### Repo model additions

Add repo sentinel config:

```ts
type RepoSentinelConfig = {
  enabled: boolean;
  globalMode: boolean;
  defaultGroupTag?: string;
  reviewGate: {
    requireChecksGreen: boolean;
    requireAutoReviewPass: boolean;
  };
  mergePolicy: {
    autoMergeEnabled: boolean;
    method: 'merge' | 'squash' | 'rebase';
    deleteBranch: boolean;
  };
  conflictPolicy: {
    rebaseBeforeMerge: boolean;
    remediationEnabled: boolean;
    maxAttempts: number;
  };
};
```

### Task model additions

Add tags:

```ts
type Task = {
  // existing fields
  tags?: string[];
};
```

### Sentinel runtime entities

```ts
type SentinelRun = {
  id: string;
  tenantId: string;
  repoId: string;
  scopeType: 'group' | 'global';
  scopeValue?: string; // group tag for group scope
  status: 'running' | 'paused' | 'stopped' | 'failed' | 'completed';
  currentTaskId?: string;
  currentRunId?: string;
  attemptCount: number;
  startedAt: string;
  updatedAt: string;
};

type SentinelEvent = {
  id: string;
  sentinelRunId: string;
  repoId: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  type:
    | 'sentinel.started'
    | 'sentinel.paused'
    | 'sentinel.resumed'
    | 'sentinel.stopped'
    | 'task.activated'
    | 'run.started'
    | 'review.gate.waiting'
    | 'merge.attempted'
    | 'merge.succeeded'
    | 'merge.failed'
    | 'remediation.started'
    | 'remediation.succeeded'
    | 'remediation.failed';
  message: string;
  metadata?: Record<string, string | number | boolean>;
};
```

## API Additions

1. `GET /api/repos/:repoId/sentinel`
   - current status and effective config.
2. `PATCH /api/repos/:repoId/sentinel/config`
   - update sentinel settings.
3. `POST /api/repos/:repoId/sentinel/start`
   - start sentinel for scope.
4. `POST /api/repos/:repoId/sentinel/pause`
5. `POST /api/repos/:repoId/sentinel/resume`
6. `POST /api/repos/:repoId/sentinel/stop`
7. `GET /api/repos/:repoId/sentinel/events`
   - timeline/audit feed.
8. `POST /api/repos/:repoId/sentinel/retry-merge`
   - optional operator intervention action.

## Sentinel Control Flow

1. Resolve scope:
   - `global`: all non-DONE tasks in repo.
   - `group`: tasks containing configured group tag.
2. Determine next eligible task:
   - respects dependency readiness.
   - respects serial execution (`concurrency = 1`).
3. Activate and start:
   - move task to `ACTIVE`.
   - call existing run start API.
4. Wait for `REVIEW`.
5. Apply review completion gate:
   - checks green and mergeable.
   - auto-review findings resolved.
6. Merge using repo merge policy.
7. On merge success:
   - mark task `DONE`.
   - proceed to next eligible task.
8. On merge failure:
   - run conflict policy:
     - optional rebase attempt
     - optional remediation run
     - retry merge up to max attempts
   - if still failing: pause sentinel and emit actionable event.

## UI Surfaces

### Repo settings

1. Sentinel enabled toggle.
2. Scope defaults:
   - global
   - group tag
3. Review gate settings.
4. Merge policy settings.
5. Conflict policy settings.

### Sentinel status panel

1. Current sentinel state.
2. Current scope and task.
3. Last action and failure reason.
4. Buttons:
   - start
   - pause
   - resume
   - stop
   - retry merge (if blocked)

## Staged Implementation Plan

### S1 — Domain and Persistence Foundation

**Scope**

1. Add sentinel config to repo model and validation.
2. Add task tags support.
3. Add sentinel runtime entities (`SentinelRun`, `SentinelEvent`).
4. Add DB migration(s) and repository access helpers.

**Acceptance criteria**

1. Repo sentinel config persists and reads correctly.
2. Task tags are persisted and queryable.
3. Sentinel state/events storage works.

---

### S2 — Sentinel APIs and Repo Controls

**Scope**

1. Implement sentinel config/status/action APIs.
2. Add repo settings UI for sentinel policy.
3. Add basic sentinel status display.

**Acceptance criteria**

1. Operators can start/pause/resume/stop sentinel.
2. Repo sentinel settings are editable in UI and API.

---

### S3 — Selector and Serial Progression Engine

**Scope**

1. Implement group/global selection based on task tags.
2. Enforce dependency readiness and serial progression.
3. Ensure sentinel activates and starts the next eligible task.

**Acceptance criteria**

1. Global sentinel progresses through all eligible tasks.
2. Group sentinel only progresses tagged tasks.
3. Exactly one active task per sentinel scope.

---

### S4 — Review Gate and Merge Policy Engine

**Scope**

1. Implement review completion gate evaluator.
2. Implement merge policy executor using repo preferences.
3. Move tasks to `DONE` only after successful merge.

**Acceptance criteria**

1. Sentinel waits when review gate is not satisfied.
2. Sentinel merges using configured method/options.
3. Task progression occurs only after merge success.

---

### S5 — Conflict Rebase/Remediation Strategy

**Scope**

1. Implement rebase-before-merge option.
2. Implement remediation attempt path for merge failures.
3. Add bounded retries and pause-on-exhaustion behavior.

**Acceptance criteria**

1. Merge conflicts trigger remediation flow.
2. Sentinel retries within configured limits.
3. Sentinel pauses with clear event logs on terminal failure.

---

### S6 — Observability, Hardening, and Rollout

**Scope**

1. Finalize sentinel event timeline and audit UX.
2. Add idempotency/lease protections for race conditions.
3. Add operational docs and rollout playbook.
4. Document script-to-native migration path from `autopilot/sentinel` scripts.

**Acceptance criteria**

1. Operators can diagnose sentinel behavior from events.
2. Duplicate processing/races are prevented.
3. Docs clearly cover setup, operations, and failure handling.

## Test Plan

### Unit tests

1. Scope selector (`group/global`).
2. Eligibility resolver with dependencies.
3. Review gate evaluator.
4. Merge policy resolver.
5. Conflict retry/remediation policy.

### Integration tests

1. Start/pause/resume/stop sentinel APIs.
2. Serial progression across eligible tasks.
3. Merge blocked until review gate passes.
4. Conflict remediation then merge retry behavior.
5. Pause behavior on terminal remediation failure.

### Regression tests

1. Existing manual task/run flow unaffected when sentinel disabled.
2. Existing request-changes and run lifecycle behavior unaffected.

## Risks and Mitigations

1. **Race conditions between multiple sentinels**
   - Mitigation: scoped lease/lock and task-level ownership guard.
2. **False-positive merge readiness**
   - Mitigation: strict gate checks + revalidation before merge attempt.
3. **Noisy auto-advancement**
   - Mitigation: event-driven observability and explicit pause controls.
4. **Provider-specific merge behavior mismatch**
   - Mitigation: provider adapter abstraction and policy capability checks.

## Rollout Strategy

1. Ship behind feature flag at repo level (`sentinelConfig.enabled` false by default).
2. Pilot in one repo and one group scope.
3. Expand to global scope after stability/observability validation.
4. Decommission external script usage in favor of built-in controls.

## Final Success Criteria

1. Operators can define and control sentinel from product UI/API.
2. Sentinel can progress either grouped tasks or all upcoming tasks.
3. Sentinel merges only after review completion conditions pass.
4. Sentinel handles merge conflicts via configured remediation strategy.
5. Sentinel is observable, auditable, and safe to run in production.
