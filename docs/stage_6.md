# AgentsKanban Stage 6 (Control)

## Goal

Stage 6 gives operators basic control over active runs and repo execution behavior.

## Scope

In scope:

- canceling active runs
- repo execution configuration
- guided vs full-auto execution mode
- clearer run control affordances in the UI

Out of scope:

- queueing and fairness
- policy engine
- credential hardening

## Target outcomes

By the end of Stage 6, an operator should be able to:

- cancel a run safely
- choose whether a repo runs in `full_auto` or `guided` mode
- configure install/build/test commands for a repo
- see whether a run is using repo-configured commands or Codex-selected behavior

## Additive model

Recommended type:

```ts
type RepoExecutionConfig = {
  installCommand?: string;
  buildCommand?: string;
  testCommand?: string;
  workingDirectory?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  executionMode: 'full_auto' | 'guided';
};
```

Rules:

- `full_auto` preserves current Stage 3 behavior
- `guided` prefers repo configuration over Codex inference for install/build/test
- cancellation must stop workflow progression and clean up active sandbox/session state coherently

## API additions

Add:

- `POST /api/runs/:runId/cancel`
- `PATCH /api/repos/:repoId/execution-config`
- `GET /api/repos/:repoId/execution-config`

## UI expectations

Add:

- `Cancel run` action on active runs
- repo execution config editor
- run badge showing `Full auto` or `Guided`
- cancellation state in the run timeline

## Testing plan

Add coverage for:

- safe cancellation and sandbox cleanup
- guided config precedence over Codex inference
- rerun behavior after cancel
- UI distinction between canceled, failed, and completed runs

## Acceptance criteria

Stage 6 is complete when:

- operators can cancel active runs safely
- repos can opt into guided execution
- the UI clearly shows guided vs full-auto execution mode
- cancellation is reflected consistently in run state, events, and operator session state

## Recommended build order

1. Add Stage 6 docs and lock the control model.
2. Add repo execution config types and storage.
3. Add cancellation flow through Workflow and sandbox cleanup.
4. Add execution mode precedence rules in the orchestrator.
5. Add control UI and repo config editor.
6. Validate guided and canceled runs end to end.
