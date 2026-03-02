# AgentBoard Stage 4 (Observe & Attach)

## Goal

Stage 4 turns AgentBoard into a live operator surface for active runs.

Stage 3 proves the system can execute real runs end to end. Stage 4 makes those runs inspectable and attachable in real time by adding:

- live run event streams
- structured command history
- current-command visibility
- authenticated operator terminal/session attach
- first-class operator session metadata

## Scope

Stage 4 focuses on the operator workflow for an active run.

In scope:

- watching a run update live without refresh
- inspecting current and past commands as structured records
- opening an authenticated session into a live sandbox
- logging attach/disconnect lifecycle in product-visible events
- UI entrypoints for inspection and terminal attach

Out of scope:

- cancellation
- repo execution config
- queueing and fairness
- policy engine beyond minimal auth required for operator access
- credential hardening beyond Stage 3 behavior

## Product decisions locked in

- Stage 4 combines watch and attach into a single operator-access stage
- Worker-routed sandbox WebSockets via `wsConnect()` are the default transport for operator access
- the board and detail panel remain the operator control surface
- terminal support in this stage is full interactive access for active runs
- operator access must be authenticated, even though broader policy controls are deferred to later stages

## Target outcomes

By the end of Stage 4, an operator should be able to:

- watch and inspect a run in real time
- see which command is currently running
- review command history for the run
- open an authenticated terminal/session into a live run sandbox
- see attach and disconnect lifecycle in the run timeline

## Architecture additions

## 1. Run event stream

Add a first-class run event model.

Recommended type:

```ts
type RunEvent = {
  id: string;
  runId: string;
  repoId: string;
  taskId: string;
  at: string;
  actorType: 'workflow' | 'sandbox' | 'system' | 'operator';
  eventType:
    | 'run.status_changed'
    | 'command.started'
    | 'command.completed'
    | 'log.appended'
    | 'operator.attached'
    | 'operator.detached';
  message: string;
  metadata?: Record<string, string | number | boolean>;
};
```

Rules:

- events are append-only
- the event stream must support both active and completed runs
- the board projection may summarize events, but the source record should remain queryable

## 2. Structured command records

Add a first-class command record model for run execution.

Recommended type:

```ts
type RunCommand = {
  id: string;
  runId: string;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push' | 'preview' | 'evidence';
  startedAt: string;
  completedAt?: string;
  command: string;
  exitCode?: number;
  status: 'running' | 'completed' | 'failed';
  stdoutPreview?: string;
  stderrPreview?: string;
};
```

Rules:

- every orchestrator-triggered command should emit `command.started` and `command.completed`
- command status and exit code should be queryable independently of raw logs
- command preview fields should remain concise and product-safe, not full artifact replacements

## 3. Operator session attach

Add authenticated operator session endpoints:

- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/ws`

Use Worker-routed WebSocket upgrades with `sandbox.wsConnect()`.

Recommended session type:

```ts
type OperatorSession = {
  id: string;
  runId: string;
  sandboxId: string;
  startedAt: string;
  endedAt?: string;
  actorId: string;
  actorLabel: string;
  connectionState: 'connecting' | 'open' | 'closed' | 'failed';
};
```

Requirements:

- resolve `runId -> active sandbox`
- reject attach when no live sandbox exists
- enforce operator auth before connecting
- emit `operator.attached` and `operator.detached` events
- log close reason metadata when available
- keep raw sandbox endpoints private by default

## API additions

Add:

- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/commands`
- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/ws`

Response expectations:

- `events` returns append-only `RunEvent[]`
- `commands` returns `RunCommand[]`
- `terminal` returns session bootstrap metadata or connection details needed by the UI
- `ws` upgrades to the authenticated operator session transport

## Durable object / workflow changes

## `RepoBoardDO`

Add projection support for:

- run events
- run commands
- current active command id
- operator session metadata

The board/detail projection should be able to answer:

- what command is currently running
- what commands already ran
- whether an operator session is active

## Workflows and orchestrator

Add support for:

- emitting command start and completion records
- emitting run events for operator attach lifecycle
- exposing enough sandbox metadata to support terminal attach for active runs

## UI expectations

The board remains the control surface, but Stage 4 should add:

- live event timeline in the detail panel
- structured command list with current command highlighted
- `Open terminal` action for active runs
- visible operator session state

The UI should prioritize:

- active run visibility first
- attachment as a next action from the same screen

## Testing plan

Add coverage for:

- live event projection for active runs
- command start/completion records
- authenticated terminal routing
- rejection when sandbox is missing or run is inactive
- attach/disconnect event emission

## Acceptance criteria

Stage 4 is complete when:

- active runs update live without reload
- command execution is visible as structured records, not only raw logs
- operators can open authenticated live connections into active run sandboxes
- attach/disconnect lifecycle appears in the event timeline
- completed runs still expose command and event history for inspection

## Recommended build order

1. Add Stage 4 docs and lock the operator-access scope.
2. Add `RunEvent`, `RunCommand`, and `OperatorSession` additive types.
3. Add event and command projection support to `RepoBoardDO`.
4. Emit structured command records from the orchestrator.
5. Add `GET /api/runs/:runId/events` and `GET /api/runs/:runId/commands`.
6. Add authenticated operator attach endpoints and sandbox routing.
7. Add detail panel event/command UI and `Open terminal` entrypoint.
8. Run end-to-end verification on an active sandbox-backed run.
