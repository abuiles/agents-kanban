# AgentsKanban Stage 4 (Observe & Attach)

**Status:** ✅ Implemented (run visibility/commands/session attach core covered)

## Goal

Stage 4 turns AgentsKanban into a live operator surface for active runs.

Stage 3 proves the system can execute real runs end to end. Stage 4 makes those runs inspectable and attachable in real time by adding:

- live run event streams
- structured command history
- current-command visibility
- authenticated operator terminal/session attach
- operator takeover and resume support for Codex sessions
- first-class operator session metadata

## Scope

Stage 4 focuses on the operator workflow for an active run.

In scope:

- watching a run update live without refresh
- inspecting current and past commands as structured records
- opening an authenticated session into a live sandbox
- letting the operator take over a live Codex session and resume it later
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
- operator takeover is a first-class flow, not just an implementation detail of terminal access
- operator access must be authenticated, even though broader policy controls are deferred to later stages

## Target outcomes

By the end of Stage 4, an operator should be able to:

- watch and inspect a run in real time
- see which command is currently running
- review command history for the run
- open an authenticated terminal/session into a live run sandbox
- interrupt Codex, take over the sandbox manually, and keep the information needed to resume the Codex session later
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

This stage should treat operator attach as a takeover-capable workflow, not just passive terminal viewing.

Primary handoff model:

- when Codex is active in the sandbox, the operator can stop Codex and take over the live environment
- when Codex stops, capture and persist the resume handle emitted by Codex, for example:
  - `codex resume 019cac9f-aca8-7200-b9c2-1b6e634b5f9a`
- the product should expose that resume handle in the run detail so the operator can hand control back to Codex later

Implementation note:

- the product does not need to reimplement Codex session persistence itself if the Codex CLI already emits a stable resume command
- Stage 4 should preserve and surface the resume command as part of operator session metadata and run events

Secondary acceptable models if needed:

- expose the raw terminal first, but still persist the last known Codex resume command whenever one is available
- allow “observe only” attach during early rollout, but the target behavior for Stage 4 remains full operator takeover

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
  takeoverState?: 'observing' | 'operator_control' | 'resumable';
  codexThreadId?: string;
  codexResumeCommand?: string;
  connectionState: 'connecting' | 'open' | 'closed' | 'failed';
};
```

Requirements:

- resolve `runId -> active sandbox`
- reject attach when no live sandbox exists
- enforce operator auth before connecting
- emit `operator.attached` and `operator.detached` events
- emit takeover and resume-related events when control shifts between Codex and the operator
- log close reason metadata when available
- keep raw sandbox endpoints private by default
- persist the most recent Codex resume command when available

## API additions

Add:

- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/commands`
- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/ws`
- `POST /api/runs/:runId/takeover`

Response expectations:

- `events` returns append-only `RunEvent[]`
- `commands` returns `RunCommand[]`
- `terminal` returns session bootstrap metadata, takeover state, and resume details needed by the UI
- `ws` upgrades to the authenticated operator session transport
- `takeover` explicitly records operator control of the live session if a distinct mutation endpoint is preferred over implicit terminal attach

## Durable object / workflow changes

## `RepoBoardDO`

Add projection support for:

- run events
- run commands
- current active command id
- operator session metadata
- latest Codex resume command

The board/detail projection should be able to answer:

- what command is currently running
- what commands already ran
- whether an operator session is active
- whether the operator or Codex currently has control
- how to resume Codex if it has been interrupted

## Workflows and orchestrator

Add support for:

- emitting command start and completion records
- emitting run events for operator attach lifecycle
- detecting and storing Codex resume commands from executor output
- exposing enough sandbox metadata to support terminal attach for active runs

Recommended run events to add:

- `operator.takeover_started`
- `operator.takeover_ended`
- `codex.resume_available`

## UI expectations

The board remains the control surface, but Stage 4 should add:

- live event timeline in the detail panel
- structured command list with current command highlighted
- `Open terminal` action for active runs
- visible operator session state
- visible takeover state
- copyable Codex resume command when available

The UI should prioritize:

- active run visibility first
- attachment as a next action from the same screen
- resuming Codex as a clear follow-up after manual operator intervention

## Testing plan

Add coverage for:

- live event projection for active runs
- command start/completion records
- authenticated terminal routing
- rejection when sandbox is missing or run is inactive
- attach/disconnect event emission
- Codex resume command capture and display
- operator takeover state transitions

## Acceptance criteria

Stage 4 is complete when:

- active runs update live without reload
- command execution is visible as structured records, not only raw logs
- operators can open authenticated live connections into active run sandboxes
- attach/disconnect lifecycle appears in the event timeline
- operators can take over a live sandbox session and the product preserves the Codex resume command when available
- completed runs still expose command and event history for inspection

## Recommended build order

1. Add Stage 4 docs and lock the operator-access scope.
2. Add `RunEvent`, `RunCommand`, and `OperatorSession` additive types.
3. Add event and command projection support to `RepoBoardDO`.
4. Emit structured command records from the orchestrator.
5. Add `GET /api/runs/:runId/events` and `GET /api/runs/:runId/commands`.
6. Detect and persist Codex resume commands from executor output.
7. Add authenticated operator attach endpoints, sandbox routing, and takeover state.
8. Add detail panel event/command UI, `Open terminal`, and resume-command affordances.
9. Run end-to-end verification on an active sandbox-backed run with operator takeover and Codex resume.
