# AgentBoard Stage 4 (Operate)

## Goal

Stage 4 hardens AgentBoard after real execution is working.

Stage 3 proves the system can execute real runs end to end. Stage 4 turns that into an operational product by adding:

- operator tooling
- security and policy controls
- stronger execution governance
- scaling and queueing controls
- production observability and auditability

## Scope

Stage 4 focuses on running AgentBoard safely and repeatedly across many repos and runs.

In scope:

- authenticated operator access to live sandboxes
- policy controls for agent execution
- repo-level execution configuration and constraints
- queueing, concurrency, and fairness controls
- richer observability and audit trails
- failure recovery and replay tooling
- credential hardening beyond the single global PAT model

Out of scope:

- major UI redesign unrelated to operations
- merge automation beyond explicit operator actions
- full billing system unless directly required for quota enforcement

## Product decisions locked in

- Stage 4 adds operator tooling as a real product feature
- Worker-routed sandbox WebSockets via `wsConnect()` are the default for operator access
- policy enforcement happens in the control plane before and during execution, not in the UI alone
- Stage 4 introduces deterministic execution controls where useful, but still allows a repo to opt into broader Codex autonomy when desired
- the single global PAT model from Stage 3 should be replaced or deprecated in favor of finer-grained credentials

## Target outcomes

By the end of Stage 4, an operator should be able to:

- watch and inspect a run in real time
- open an authenticated terminal/session into a run sandbox
- understand exactly what commands were run and why
- constrain what a repo or task is allowed to do
- control concurrency and rate of execution across repos
- retry or recover failed runs without corrupting state
- audit credentials, actions, and artifacts after the fact

## Architecture additions

## 1. Operator sandbox access

Add authenticated operator endpoints such as:

- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/ws`

Use Worker-routed WebSocket upgrades with `sandbox.wsConnect()`.

Requirements:

- resolve `runId -> sandbox`
- enforce operator auth before connecting
- log connection start/end, close codes, and target port
- keep raw sandbox preview endpoints private by default

## 2. Policy engine

Introduce a policy layer for execution.

Policy should operate at:

- global level
- repo level
- optional task override level

Policy areas:

- allowed/denied commands
- filesystem restrictions inside the sandbox where feasible
- network egress rules
- max run duration
- max evidence duration
- whether terminal access is permitted
- whether Codex full-permission mode is allowed for that repo

## 3. Repo execution configuration

Stage 4 should add explicit repo execution configuration instead of leaving everything entirely to Codex.

Recommended repo config fields:

```ts
type RepoExecutionConfig = {
  installCommand?: string;
  buildCommand?: string;
  testCommand?: string;
  previewCheckName?: string;
  workingDirectory?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  codexMode?: 'full_auto' | 'guided';
};
```

Rules:

- Stage 3 remains valid without these fields
- Stage 4 allows repos to opt into deterministic commands
- when config is present, execution should prefer config over Codex inference/autonomy

## 4. Credential model hardening

Replace the single global PAT model with finer-grained auth.

Preferred target:

- GitHub App installation auth as the default production model

Interim acceptable model:

- PAT per owner or per repo stored in KV

Requirements:

- support credential rotation
- log which credential source was used, without exposing the secret
- keep credentials out of task/run payloads

## 5. Queueing and concurrency control

Stage 4 should prevent noisy repos from dominating capacity.

Add:

- per-repo concurrency limits
- global concurrency limits
- queue priorities or scheduling classes
- backpressure when sandbox capacity is exhausted
- visible queued state and reason codes

Cloudflare Queues may be introduced here if they materially simplify delivery and backpressure, but DO + Workflow orchestration remains acceptable if it stays coherent.

## 6. Observability and audit trail

Add a more complete audit and observability model.

Required additions:

- append-only run event log
- operator action log
- credential source audit
- policy decision audit
- command execution audit
- artifact access audit where practical

Recommended event shape:

```ts
type RunEvent = {
  id: string;
  runId: string;
  repoId: string;
  taskId: string;
  at: string;
  actorType: 'system' | 'operator' | 'workflow' | 'sandbox';
  eventType: string;
  message: string;
  metadata?: Record<string, string | number | boolean>;
};
```

## API additions

## Operator access

Add:

- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/cancel`
- `POST /api/runs/:runId/pause` if pause is implemented
- `POST /api/runs/:runId/resume` if pause is implemented

## Repo policy/config

Add:

- `PATCH /api/repos/:repoId/execution-config`
- `PATCH /api/repos/:repoId/policy`
- `GET /api/repos/:repoId/policy`

## Audit/observability

Add:

- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/commands`
- `GET /api/runs/:runId/audit`

These can overlap internally, but the contract must make audit data first-class.

## Durable object / workflow changes

## `RepoBoardDO`

Add projection support for:

- queued reasons
- cancellation state
- policy-derived metadata
- operator session metadata
- run event summaries for board/detail views

## Workflows

Add support for:

- cancellation checks between steps
- emitting richer event payloads
- honoring repo/task policy constraints
- execution mode selection (`full_auto` vs `guided`)

## Failure recovery model

Stage 4 should make recovery explicit.

Add support for:

- canceling a running workflow and sandbox cleanly
- resuming evidence independently
- replaying or re-projecting run state from durable events when DO projection drifts
- operator-triggered rerun from a known checkpoint only if the checkpoint model is coherent; otherwise require full rerun

## UI expectations

The board remains the control surface, but Stage 4 should add:

- clear queued reason/status
- visible policy warnings on tasks/runs
- run event timeline beyond status changes
- operator access entry points in the detail panel
- audit/event viewer
- cancel action for active runs

## Testing plan

Add coverage for:

- operator websocket auth/routing
- cancel and cleanup behavior
- policy enforcement on denied commands or modes
- repo config precedence over Codex autonomy when configured
- queue fairness and concurrency limits
- audit event completeness
- credential source selection and rotation behavior

## Acceptance criteria

Stage 4 is complete when:

- operators can open authenticated live connections into a run sandbox
- runs can be canceled safely
- repo/task policy constraints are enforced server-side
- repo execution config can make runs deterministic where desired
- concurrency limits and queueing are visible and enforced
- a complete audit trail exists for run state, commands, policy decisions, and operator actions
- credential handling is finer-grained than the Stage 3 global PAT model

## Recommended build order

1. Add Stage 4 docs and lock policy/operator goals.
2. Add authenticated operator WebSocket endpoints.
3. Add cancellation flow through Workflow + sandbox cleanup.
4. Add repo execution config and precedence rules.
5. Add server-side policy enforcement.
6. Add queueing/concurrency controls.
7. Add run event/audit log model and APIs.
8. Add credential model hardening beyond global PAT.
9. Add end-to-end operational tests.
