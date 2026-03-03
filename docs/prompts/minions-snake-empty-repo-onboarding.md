# Minions Snake Demo: Empty-Repo Onboarding Playbook

This playbook defines how to bootstrap a brand-new repo and create a dependency-aware 10-task backlog in AgentsKanban.

Scope for this playbook:
- Create repo + tasks only.
- Do not implement gameplay in this phase.
- Tasks are written so Codex must plan first, then implement.

## 1) Preconditions

- Local API base: `http://127.0.0.1:5173/api`
- Auth header on all requests:

```text
Authorization: Bearer <AGENTS_KANBAN_TOKEN>
```

- Ask the user to create a new empty GitHub test repository first (public or private), then provide:
  - `owner/repo` (for `projectPath`)
  - full repo URL (for `baselineUrl`)
- Starting assumption: target repo has no game implementation yet.

## 2) Create Repo (Empty-Repo Bootstrap)

Only after the user confirms the GitHub test repo exists, create the repo record in AgentsKanban.

```json
{
  "projectPath": "USER_NAME/minions-demo",
  "baselineUrl": "https://github.com/USER_NAME/minions-demo",
  "defaultBranch": "main",
  "scmProvider": "github",
  "status": "INBOX"
}
```

Endpoint:
- `POST /api/repos`

Capture returned `repoId` and use it in all task payloads.

## 3) Task Prompt Standard (Required in Every Task)

Every task `taskPrompt` must include this execution contract:

1. Plan first:
- Produce a decision-complete implementation plan before writing code.
- Plan must include files to change, data/control flow, edge cases, tests, and acceptance mapping.

2. Implement second:
- Execute the approved plan end-to-end.
- If assumptions are needed, state them and proceed with safest default.

3. Validate and report:
- Run relevant tests/checks.
- Report files changed, tests run/results, and residual risks.

Use this exact directive block in each `taskPrompt`:

```text
Execution mode requirements:
1) PLAN FIRST: Before writing code, produce a detailed, decision-complete plan covering architecture, files, data flow, edge cases, and tests mapped to acceptance criteria.
2) IMPLEMENT SECOND: After planning, implement the plan fully. Do not stop at partial scaffolding.
3) VALIDATE: Run relevant tests/checks and include results.
4) REPORT: Summarize files changed, validation output, and any remaining risks.
```

## 4) 10-Task Backlog (Detailed)

Task keys here (`T1..T10`) are for planning; real `taskId` values come from API responses.

### T1 — Bootstrap initial game skeleton and tooling
Type: build
Depends on: none
Parallel lane: foundation
Acceptance:
- A runnable game shell exists in the repo.
- Basic project scripts for run/build/test are present.
- README has local run instructions.
- At least one smoke test target exists.

### T2 — Minion movement loop and entity model
Type: build
Depends on: T1
Parallel lane: gameplay-core
Acceptance:
- Minion entities are represented in game state.
- Tick/update loop moves minions deterministically.
- Basic movement behavior is testable.

### T3 — Collectible spawn system with deterministic seed controls
Type: build
Depends on: T1
Parallel lane: gameplay-core
Acceptance:
- Spawn system supports random placement.
- Seed or deterministic override path exists for tests.
- Spawn API distinguishes collectible types.

### T4 — Explosive avocado trigger mechanic
Type: build
Depends on: T1
Parallel lane: feature
Acceptance:
- Explosive avocado can spawn as collectible type.
- Consumption trigger event fires for explosive avocado.
- Trigger can be simulated deterministically.

### T5 — Consumption/collision pipeline
Type: build
Depends on: T2 (primary), T3
Parallel lane: integration
Acceptance:
- Collision/consumption flow processes collectible events.
- Event pipeline integrates with entity state updates.
- Non-explosive and explosive paths are distinguishable.

### T6 — Survivor resolution: all minions die except one
Type: qa/rules
Depends on: T4 (primary), T5
Parallel lane: rules
Acceptance:
- On explosive avocado consumption, exactly one minion survives.
- Survivor selection rule is deterministic/documented.
- Invalid states (0 survivors, >1 survivors) are guarded.

### T7 — Deterministic simulation harness
Type: qa
Depends on: T3 (primary), T5
Parallel lane: qa
Acceptance:
- Headless or scripted simulation path exists.
- Seeded scenarios replay consistently.
- Harness can produce artifacts/logs for review.

### T8 — Automated tests for explosive-avocado scenarios
Type: qa
Depends on: T6 (primary), T7
Parallel lane: qa
Acceptance:
- Tests cover happy path and edge cases for survivor rule.
- Tests validate deterministic replay behavior.
- Failure messages are actionable.

### T9 — Demo walkthrough and acceptance checklist
Type: docs
Depends on: T8
Parallel lane: docs
Acceptance:
- Step-by-step demo script exists for showcasing feature behavior.
- Checklist maps to task acceptance criteria.
- Includes expected outputs/screens/log markers.

### T10 — Final onboarding/API execution guide
Type: docs
Depends on: T9
Parallel lane: docs
Acceptance:
- Clear guide for creating same backlog via API in new environments.
- Includes payload examples and dependency wiring instructions.
- Includes troubleshooting and validation checklist.

## 5) Dependency Graph

- T2 <- T1
- T3 <- T1
- T4 <- T1
- T5 <- T2 (primary), T3
- T6 <- T4 (primary), T5
- T7 <- T3 (primary), T5
- T8 <- T6 (primary), T7
- T9 <- T8
- T10 <- T9

## 6) API Payload Templates

All tasks should start as `INBOX`.

### Base payload template

```json
{
  "repoId": "<repoId>",
  "title": "<task title>",
  "description": "<short operator-facing description>",
  "taskPrompt": "<detailed prompt including required execution mode block>",
  "acceptanceCriteria": [
    "<criterion 1>",
    "<criterion 2>",
    "<criterion 3>"
  ],
  "context": {
    "links": [],
    "notes": "Keep implementation scoped. Do not add unnecessary dependencies."
  },
  "status": "INBOX"
}
```

### Dependency payload example (for downstream tasks)

```json
{
  "repoId": "<repoId>",
  "title": "Consumption/collision pipeline",
  "description": "Integrate movement + spawns into collectible consumption handling.",
  "taskPrompt": "Implement collision/consumption event processing that integrates movement and spawn systems.\n\nExecution mode requirements:\n1) PLAN FIRST: Before writing code, produce a detailed, decision-complete plan covering architecture, files, data flow, edge cases, and tests mapped to acceptance criteria.\n2) IMPLEMENT SECOND: After planning, implement the plan fully. Do not stop at partial scaffolding.\n3) VALIDATE: Run relevant tests/checks and include results.\n4) REPORT: Summarize files changed, validation output, and any remaining risks.",
  "acceptanceCriteria": [
    "Collision and consumption events are processed correctly.",
    "Explosive and non-explosive collectibles are distinguished in logic.",
    "Tests or deterministic validation cover core event flow."
  ],
  "dependencies": [
    { "upstreamTaskId": "<taskId_T2>", "mode": "review_ready", "primary": true },
    { "upstreamTaskId": "<taskId_T3>", "mode": "review_ready" }
  ],
  "context": {
    "links": [],
    "notes": "Integrate existing modules; avoid unnecessary refactors."
  },
  "status": "INBOX"
}
```

## 7) Recommended Creation Order

Because dependencies require real `taskId`s, create tasks in topological order:

1. T1
2. T2, T3, T4
3. T5, T7
4. T6
5. T8
6. T9
7. T10

Alternative:
- Create all tasks without dependencies first.
- Patch each task with `PATCH /api/tasks/:taskId` to add dependencies after IDs exist.

## 8) Example API Runbook (Later Execution)

1. `POST /api/repos` and capture `repoId`.
2. `POST /api/tasks` for each task payload in creation order.
3. `GET /api/tasks?repoId=<repoId>` and build a map `T# -> taskId`.
4. If needed, `PATCH /api/tasks/:taskId` to correct dependencies.
5. Re-run `GET /api/tasks?repoId=<repoId>` and verify graph integrity.

## 9) Verification Checklist

- Repo exists and correct `repoId` is used.
- Exactly 10 tasks are present.
- Every downstream dependency references a valid task in same repo.
- No task depends on itself.
- At most one `primary: true` dependency per task.
- All tasks include plan-first/implement-second directive.
- All tasks start in `INBOX` (unless intentionally changed).

## 10) Troubleshooting

- `401 Unauthorized`:
  - Ensure bearer token is present and valid.

- `Invalid dependencies: upstreamTaskId must reference a task in the same repo.`
  - Verify task IDs belong to target repo.

- `Invalid dependencies: only one primary dependency is allowed.`
  - Keep exactly one primary upstream in multi-dependency tasks.

- Dependency not unlocking as expected:
  - Current mode is `review_ready`; ensure upstream task reaches review-ready conditions.

---

This playbook is the canonical onboarding artifact for creating the minion snake demo backlog in an empty repo environment.
