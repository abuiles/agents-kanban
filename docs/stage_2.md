# AgentBoard Stage 2 (Walk)

## Goal

Replace the Phase 0 local-only store with a real Cloudflare Worker API and Durable Object state, while keeping the same UI, interaction model, and run lifecycle shape.

## Non-goals

- No real Cloudflare Sandbox execution yet
- No Codex invocation yet
- No GitHub clone/push or PR creation yet
- No real preview discovery yet
- No real Playwright evidence runner yet

## Stage 3 dependencies this phase must preserve

Stage 2 is the contract-stabilization phase for real execution in Stage 3.

These guarantees must hold at the end of Stage 2:

- HTTP response shapes stay compatible with the Phase 0 `AgentBoardApi`
- run lifecycle states and idempotency semantics remain unchanged
- `Task`, `AgentRun`, `ArtifactManifest`, and log entry shapes are extended additively only
- run state remains durable and resumable without an open browser tab
- the UI keeps treating the API as the only source of truth

Stage 3 will depend on Stage 2 to already provide:

- durable task/run storage
- durable server-owned lifecycle transitions
- stable run detail and logs endpoints
- a clean place to add real executor metadata without redesigning the API

## Build target

- React UI remains the same client
- Worker serves both the SPA and HTTP API
- One `BoardDO` owns repo/task/run/log state for the spike
- Mock executor moves from browser timers to Durable Object alarms/timestamps
- The `AgentBoardApi` interface remains the contract boundary

## API mapping

### Repos
- `POST /repos`
- `GET /repos`
- `PATCH /repos/:repoId`

### Tasks
- `POST /tasks`
- `GET /tasks?repoId=`
- `GET /tasks/:taskId`
- `PATCH /tasks/:taskId`

### Runs
- `POST /tasks/:taskId/run`
- `GET /runs/:runId`
- `POST /runs/:runId/retry`
- `POST /runs/:runId/evidence`
- `GET /runs/:runId/logs?tail=N`

## State ownership

### Server-owned in Stage 2
- repos
- tasks
- runs
- logs
- task/run transitions
- idempotency for `startRun` and evidence retries

### Client-owned in Stage 2
- selected task in the open tab
- selected repo filter in the open tab
- open/closed modal state
- drag hover visuals and transient banners

## Durable Object shape

Use one `BoardDO` first.

Responsibilities:
- persist normalized repos/tasks/runs/logs in DO SQLite storage
- handle CRUD operations
- enforce one active run per task
- progress mock runs on alarms
- emit consistent state transitions and logs

Do not split into `TaskDO` or `RunDO` yet.

## Anticipated Stage 3 metadata

Stage 2 should structure storage so these real-execution fields can be added without a data-model rewrite:

### Repo extensions
- `githubInstallationId?`
- `previewProvider?: 'cloudflare' | 'unknown'`
- `previewCheckName?`
- `codexAuthBundleKey?`

### Task extensions
- `baselineUrlOverride?` remains supported
- `acceptanceCriteria` remains first-class and durable

### Run extensions
- `sandboxId?`
- `sandboxSessionId?`
- `executorType?: 'mock' | 'sandbox'`
- `pullRequestHeadRef?`
- `pullRequestHeadSha?`
- `githubCheckSuiteId?`
- `previewStatus?: 'UNKNOWN' | 'DISCOVERING' | 'READY' | 'FAILED'`
- `evidenceStatus?: 'NOT_STARTED' | 'RUNNING' | 'READY' | 'FAILED'`
- `artifactManifest?` must remain the canonical container for logs/evidence pointers

These are additive extensions only; Stage 2 should not require them yet.

## Migration sequence from Phase 0

1. Keep domain types stable.
2. Keep UI components stable.
3. Add request/response DTO validation in Worker routes.
4. Add `BoardDO` storage adapters.
5. Port simulator timing logic from `src/ui/mock/run-simulator.ts` to server-side alarms.
6. Add `HttpAgentBoardApi` with the same method signatures as `LocalAgentBoardApi`.
7. Swap app bootstrap to use `HttpAgentBoardApi`.
8. Keep import/export either as a debug-only feature or remove it from the main toolbar.

## Endpoint contract expectations

Responses should stay close to Phase 0 shapes:
- repo objects unchanged
- task objects unchanged
- run objects unchanged
- log entries unchanged
- task detail bundles `task`, `repo`, `runs`, `latestRun`

This keeps the Phase 1 client swap small.

## Error and idempotency contract

Stage 3 will rely on these behaviors being explicit and stable:

- `POST /tasks/:taskId/run` returns the current non-terminal run if one already exists
- `POST /runs/:runId/evidence` never creates a new run or PR
- retrying a run creates a new run record and preserves prior run history
- terminal failures are represented both in `run.status` and structured log/error data
- transient infrastructure failures should still leave the run queryable and observable

Even in Stage 2, return structured error payloads that can survive into Stage 3:

- `code`
- `message`
- `retryable`
- `runId?`
- `taskId?`

## Server-side mocked executor

Lifecycle remains:
- `QUEUED`
- `BOOTSTRAPPING`
- `RUNNING_CODEX`
- `RUNNING_TESTS`
- `PUSHING_BRANCH`
- `PR_OPEN`
- `WAITING_PREVIEW`
- `EVIDENCE_RUNNING`
- `DONE` or `FAILED`

Behavior remains:
- `POST /tasks/:taskId/run` is idempotent while a non-terminal run exists
- evidence retry does not create a new PR
- `PR_OPEN` moves task to `REVIEW`
- `FAILED` moves task to `FAILED`
- `DONE` leaves task in `REVIEW`

## Observability for Stage 2

Add structured Worker logs with:
- `repoId`
- `taskId`
- `runId`
- current transition

Keep per-run log retrieval via polling first.

## Stage 3 observability contract

Stage 2 should define logs so Stage 3 can enrich, not replace, them.

Each log/event record should be able to grow to include:

- `phase` (`bootstrap`, `codex`, `tests`, `push`, `pr`, `preview`, `evidence`)
- `level`
- `message`
- `timestamp`
- `repoId`
- `taskId`
- `runId`
- `attempt?`
- `metadata?`

Stage 2 may keep plain polling, but the UI should consume logs through a single API adapter so Stage 3 can later switch to:

- polling with cursors
- server-sent events
- WebSocket or Worker push stream

without redesigning UI components.

## Acceptance criteria

- Same UX as Phase 0
- State persists server-side across devices and browsers
- Active runs continue when the UI is closed
- Dragging into Active still feels idempotent
- UI swap from local API to HTTP API does not require rewriting board components

## Cut lines if time gets tight

- Poll logs instead of implementing live streaming
- Keep artifacts mocked as manifest records only
- Use one global board DO for the spike
- Leave import/export out of the main nav if it complicates the server-backed model

## Explicit product decisions carried into Stage 3

- Import/export is a Phase 0 convenience feature, not a core Stage 2/Stage 3 workflow
- It may remain as an admin/debug tool, but it should not shape the server-side domain model
- The board remains the primary control surface across all stages
- The task detail view remains the primary place to inspect run status, links, and logs
- One run still maps to one PR
- Preview URLs come from deployed PR infrastructure, not directly from the execution sandbox

## Recommended build order

1. Worker route scaffolding and DTO validation
2. `BoardDO` normalized storage
3. repo/task CRUD
4. run start/retry/evidence endpoints
5. server-side mock scheduler with alarms
6. `HttpAgentBoardApi`
7. client adapter swap
8. regression tests against the preserved UX
