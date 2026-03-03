# Minions Snake (Single-File JS): Empty-Repo Onboarding Playbook

This playbook defines how to bootstrap a brand-new repo and create a dependency-aware 10-task backlog in AgentsKanban to deliver a full playable minion-themed snake game using only:
- `index.html`
- inline or linked vanilla JavaScript
- optional CSS in `index.html` (or a tiny `styles.css` if you choose)

## Hard constraints for the game implementation

- No backend/API for gameplay logic.
- No framework required (no React/Vue/Angular).
- No server required for gameplay state.
- Must be deployable to GitHub Pages.
- Keep architecture simple and readable.

Scope for this playbook:
- Create repo + tasks only.
- Plan work for full game implementation in later runs.
- Tasks are written so Codex must plan first, then implement.

## 1) Preconditions

- Local API base for task orchestration: `http://127.0.0.1:5173/api`
- Auth header on all requests:

```text
x-api-token: <AGENTS_KANBAN_TOKEN>
```

- Ask the user to create a new empty GitHub test repository first (public or private), then provide:
  - `owner/repo` (for `projectPath`)
  - full repo URL (for `baselineUrl`)
- Starting assumption: target repo has no game implementation yet.

## 2) Create Repo (Task Orchestration Bootstrap)

Only after the user confirms the GitHub test repo exists, create the repo record in AgentsKanban.
Example used in this session:
- `projectPath`: `abuiles/minions-demo-2`
- `baselineUrl`: `https://github.com/abuiles/minions-demo-2`
- returned `repoId`: `repo_abuiles_minions_demo_2`

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

## 3) Task Prompt Style (Put This at the Top of Each `taskPrompt`)

Use this friendlier prompt snippet in each `taskPrompt` so tasks stay consistent but not over-constrained:

```text
You are implementing this task for the minions game.

First, plan:
- what files you will touch
- how data and state should flow
- edge cases and assumptions
- the exact checks you will run

Then implement the task end-to-end in one pass (no partial scaffolding).

After implementing, run the checks and report what passed/failed, files changed, and any risk you could not fully resolve.

Constraints:
- Frontend-only gameplay logic
- No backend game API
- Must be deployable to GitHub Pages
```

## 4) 10-Task Backlog (Full Game, Simple HTML/JS)

Task keys (`T1..T10`) are planning labels; real `taskId` values come from API responses.

### T1 — Bootstrap shell + GitHub Pages (`index.html`, pages deployability)
Type: build
Depends on: none
Parallel lane: foundation
Acceptance:
- `index.html` exists and loads game canvas/board area.
- Start/restart controls are visible.
- No framework dependency required.
- GitHub Pages is configured for the repo (or clearly documented configuration steps), and the game can be accessed from a Pages URL.
- The branch-based Pages settings are compatible with a simple static project (`index.html` only).

### T2 — Render board and minion visuals
Type: build
Depends on: T1 (required)
Parallel lane: foundation
Acceptance:
- `index.html` canvas/board renders on desktop and mobile.
- Minion body/head are visually distinct.
- Layout and spacing are stable across ticks.

### T3 — Deterministic game loop
Type: build
Depends on: T1
Parallel lane: engine
Acceptance:
- Main tick cadence is stable and deterministic.
- Start/stop/reset transitions are consistent.
- Loop timing remains stable under active input.

### T4 — Input and direction model
Type: build
Depends on: T1
Parallel lane: engine
Acceptance:
- Keyboard direction controls are deterministic.
- Reverse direction is blocked when illegal.
- Control state survives pause/resume cleanly.

### T5 — Item system and spawn logic (banana/avocado/explosive)
Type: build
Depends on: T1
Parallel lane: gameplay
Acceptance:
- Items spawn only in free cells.
- Banana, avocado, and explosive avocado are all supported.
- Deterministic spawn mode is configurable for tests.

### T6 — Core mechanics integration
Type: build
Depends on: T2 (primary), T3, T4, T5
Parallel lane: integration
Acceptance:
- Movement, collision, scoring, and growth are unified per tick.
- Wall/self-collision rules are enforced.
- Mechanics are deterministic with stable state transitions.

### T7 — Multi-minion game model
Type: build
Depends on: T6
Parallel lane: mechanics
Acceptance:
- Multiple minions share one world and update deterministically.
- Minion life/death state is explicit and traceable.
- No minion behavior regresses existing loop assumptions.

### T8 — Explosive avocado survival rule
Type: rules
Depends on: T7
Parallel lane: mechanics
Acceptance:
- On explosive avocado, only one minion survives.
- Survivor selection is deterministic.
- Edge conditions (single minion, concurrent collisions) are safe.

### T9 — Persistence + deterministic QA mode
Type: qa
Depends on: T6 (primary), T8
Parallel lane: qa
Acceptance:
- High score and last run summary persist locally.
- Deterministic scenario checks are reproducible.
- Corrupt/missing saved state degrades safely.

### T10 — GitHub Pages deployment and operator playbook
Type: docs/devops
Depends on: T9
Parallel lane: release
Acceptance:
- Repo is deployable on GitHub Pages.
- README includes Pages deployment steps and live URL pattern.
- Playbook includes how to demo the game end-to-end.

## 5) Dependency Graph

- T1: Setup
- T2: Render ← T1
- T3: Loop ← T1
- T4: Input ← T1
- T5: Spawn ← T1
- T6: Core integration ← T2 (primary), T3, T4, T5
- T7: Multi-minion ← T6
- T8: Explosive rule ← T7
- T9: Persistence + QA ← T6 (primary), T8
- T10: GitHub Pages playbook ← T9

## 5a) Suggested parallel run lanes

- T2, T3, T4, T5 are safe to run in parallel after `T1`.
- T7 and T8 branch from `T6` and can be staged in READY at similar time.
- T9 waits on `T6` and `T8`; `T10` waits on `T9`.

## 6) API Payload Templates

All tasks should start as `INBOX`.

### Base payload template

```json
{
  "repoId": "<repoId>",
  "title": "<task title>",
  "description": "<short operator-facing description>",
  "taskPrompt": "<include the task prompt style block from section 3>",
  "acceptanceCriteria": [
    "<criterion 1>",
    "<criterion 2>",
    "<criterion 3>"
  ],
  "context": {
    "links": [],
    "notes": "Frontend-only game. No backend game API. Keep it GitHub Pages deployable."
  },
  "status": "INBOX"
}
```

### Dependency payload example (for downstream tasks)

```json
{
  "repoId": "<repoId>",
  "title": "Consumption/collision event pipeline",
  "description": "Integrate movement and item systems into one event flow.",
  "taskPrompt": "You are implementing this task for the minions game.\n\nFirst, plan what files to touch, state flow, edge cases, and checks. Then implement the task end-to-end. After implementation, run checks and report outcomes, changed files, and risks. Keep frontend-only gameplay, no backend game API, and GitHub Pages compatibility.",
  "acceptanceCriteria": [
    "Consumption/collision events are processed correctly.",
    "Explosive and non-explosive item outcomes are separated.",
    "State updates remain consistent per game tick."
  ],
  "dependencies": [
    { "upstreamTaskId": "<taskId_T2>", "mode": "review_ready", "primary": true },
    { "upstreamTaskId": "<taskId_T3>", "mode": "review_ready" }
  ],
  "context": {
    "links": [],
    "notes": "No framework requirement. Keep logic readable and testable."
  },
  "status": "INBOX"
}
```

## 7) Recommended Creation Order

Because dependencies require real `taskId`s, create tasks in topological order:

1. T1
2. T2, T3, T4, T5
3. T6
4. T7, T8
5. T9
6. T10

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
- Graph has intended fork/join shape:
  - `T2/T3/T4/T5` parallel after `T1`.
  - `T7` and `T8` parallel after `T6`.
- All task prompts enforce frontend-only + GitHub Pages constraints.
- All tasks start in `INBOX` (unless intentionally changed).

## 10) Troubleshooting

- `401 Unauthorized`:
  - Ensure bearer token is present and valid.

- `Invalid dependencies: upstreamTaskId must reference a task in the same repo.`
  - Verify task IDs belong to target repo.

- `Invalid dependencies: only one primary dependency is allowed.`
  - Keep exactly one primary upstream in multi-dependency tasks.

- Game task drifts into backend/API design:
  - Re-assert constraints in prompt: no backend game API, keep single-file JS approach.

---

This playbook is the canonical onboarding artifact for creating the full minion snake game backlog (simple HTML/JS, GitHub Pages deployable) in an empty repo environment.
