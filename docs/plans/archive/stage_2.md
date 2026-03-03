> Historical doc: superseded by the active P1-P4 plans in [../current/README.md](../current/README.md).

# AgentsKanban Stage 2 (Walk)

**Status:** ✅ Implemented

## Goal

Stage 2 turns AgentsKanban into a real server-backed application:

- Cloudflare Worker hosts the SPA and `/api/*`
- Durable Objects own repos, tasks, runs, and logs
- live board and run updates flow over WebSockets
- the current mock executor still drives run state, but it now runs server-side

Stage 2 is no longer a spike. It is the first real backend shape that Stage 3 will extend.

## Architecture

### Worker routing
- static assets still serve the SPA
- product API lives under `/api/*`
- live updates use `/api/board/ws`
- old sandbox demo routes moved to `/api/debug/sandbox/*`

### Durable Objects
Use two SQLite-backed Durable Object classes:

- `BoardIndexDO`
  - owns repo metadata
  - lists repos
  - resolves repo routing
  - exposes board-wide WebSocket fanout
- `RepoBoardDO`
  - one object per repo
  - owns tasks, runs, logs, and mock lifecycle progression
  - enforces run idempotency
  - emits repo-scoped update events

This follows Cloudflare's current Durable Object guidance to design around the smallest coordination unit instead of a global singleton.

## Product decisions locked in

- no automatic seed data in real environments
- WebSockets are the primary live-update transport
- UI-only state remains local (`selectedRepoId`, `selectedTaskId`, modal state, notices)
- IDs encode repo ownership so routes can resolve directly:
  - `task_<repoId>_<unique>`
  - `run_<repoId>_<unique>`

## API surface

### Board
- `GET /api/board?repoId=all|<repoId>`
- `GET /api/board/ws?repoId=all|<repoId>`

### Repos
- `POST /api/repos`
- `GET /api/repos`
- `PATCH /api/repos/:repoId`

### Tasks
- `POST /api/tasks`
- `GET /api/tasks?repoId=`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`

### Runs
- `POST /api/tasks/:taskId/run`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/retry`
- `POST /api/runs/:runId/evidence`
- `GET /api/runs/:runId/logs?tail=N`

### Debug-only
- `GET /api/debug/export`
- `POST /api/debug/import`
- `POST /api/debug/sandbox/run`
- `POST /api/debug/sandbox/file`

## Live update model

The client opens a WebSocket to `/api/board/ws`.

Server events are JSON envelopes:

- `board.snapshot`
- `repo.updated`
- `task.updated`
- `run.updated`
- `run.logs_appended`
- `server.error`

Rules:
- clients receive a snapshot immediately on connect
- later events are incremental
- repo DOs forward updates to the board DO for all-repo listeners
- the Stage 2 socket is read-only; it carries state updates only

## Run lifecycle

Public lifecycle remains unchanged:

1. `QUEUED`
2. `BOOTSTRAPPING`
3. `RUNNING_CODEX`
4. `RUNNING_TESTS`
5. `PUSHING_BRANCH`
6. `PR_OPEN`
7. `WAITING_PREVIEW`
8. `EVIDENCE_RUNNING`
9. `DONE` or `FAILED`

The current mock engine is shared between the UI test harness and the server implementation, but only the server owns lifecycle progression in Stage 2.

## Idempotency contract

These rules are stable and must remain true for Stage 3:

- starting a run for a task with an active non-terminal run returns that run
- retrying a run creates a new run record
- retrying evidence does not create a new run or PR
- `PR_OPEN` moves the task to `REVIEW`
- `DONE` leaves the task in `REVIEW`
- `FAILED` moves the task to `FAILED`

## Client boundary

The UI still depends on `AgentBoardApi`.

Stage 2 swaps in `HttpAgentBoardApi`, which:
- hydrates from `/api/board`
- subscribes to `/api/board/ws`
- keeps local UI preferences in `UiPreferencesStore`
- composes those two sources into the existing `BoardSnapshotV1`

That keeps the React component tree intact.

## Testing

### UI tests
Keep the existing jsdom UI tests against the local API injection path.

### Worker tests
Add a dedicated Workers Vitest config and cover:
- route CRUD behavior
- repo/run orchestration
- WebSocket handshake
- server-side run progression

## Stage 3 dependencies preserved

Stage 2 must already provide:
- durable server-owned run state
- durable logs
- stable task/run DTOs
- stable idempotency behavior
- a clean place to replace the mock executor with real sandbox execution
- live transport suitable for operator visibility
