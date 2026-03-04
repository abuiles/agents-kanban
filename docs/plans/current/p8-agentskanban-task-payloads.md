# P8 Task Pack for AgentsKanban (`C1..C6`)

This file contains ready-to-submit task payloads for `POST /api/tasks`.

## Usage

1. Create tasks in order `C1` through `C6`.
2. Replace dependency placeholders after each task is created:
   - `<taskId_C1>`, `<taskId_C2>`, `<taskId_C3>`, `<taskId_C4>`, `<taskId_C5>`
3. Keep tasks in `INBOX` or `READY` until current active batches are complete.
4. Do not start `C1` until `T6`, `AR6`, and `S6` are merged to `main`.

All payloads are set to:

- `sourceRef = main`
- `llmAdapter = codex`
- `codexModel = gpt-5.3-codex-spark`
- `codexReasoningEffort = high`

## Shared requirement for every C task

1. Before pushing the branch, run `yarn typecheck` and fix all issues.
2. Make sure that `yarn test` passes.

## C1 Payload

```json
{
  "repoId": "<repoId>",
  "title": "C1 - Checkpoint Domain, Types, and Validation",
  "description": "Add checkpoint config and run checkpoint metadata foundations with backward-compatible validation.",
  "sourceRef": "main",
  "dependencies": [
    { "upstreamTaskId": "<taskId_T6>", "mode": "review_ready", "primary": true },
    { "upstreamTaskId": "<taskId_AR6>", "mode": "review_ready" },
    { "upstreamTaskId": "<taskId_S6>", "mode": "review_ready" }
  ],
  "taskPrompt": "Implement C1 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until T6, AR6, and S6 are merged to main.\n\nRequired outcomes:\n1. Add RepoCheckpointConfig type and defaults:\n   - enabled=true\n   - triggerMode=phase_boundary\n   - contextNotes defaults\n   - reviewPrep defaults\n2. Extend repo create/update validation + persistence for checkpointConfig.\n3. Add run checkpoint metadata types:\n   - RunCheckpoint\n   - run.checkpoints\n   - resumedFromCheckpointId\n   - resumedFromCommitSha\n4. Keep backward compatibility with existing repo/run payloads.\n5. Add tests for validation/defaulting and compatibility.\n\nImplementation guidance:\n- Touch domain types, API validation, repo persistence, and run model normalization.\n- Keep schema additive and non-breaking.\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.",
  "acceptanceCriteria": [
    "Repo checkpoint config is persisted with deterministic defaults.",
    "Run checkpoint metadata fields are available and backward compatible.",
    "Validation rejects malformed checkpoint config safely.",
    "Before pushing the branch, run yarn typecheck and fix all issues.",
    "make sure that \"yarn test\" passes"
  ],
  "context": {
    "links": [
      {
        "id": "p8-plan",
        "label": "P8 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p8-checkpoint-recovery-and-context-notes.md"
      },
      {
        "id": "run-orchestrator",
        "label": "Run Orchestrator",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/run-orchestrator.ts"
      },
      {
        "id": "run-types",
        "label": "Run/Repo Types",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/ui/domain/types.ts"
      }
    ],
    "notes": "C chain must start only after current T/AR/S batches are fully merged to main."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## C2 Payload

```json
{
  "repoId": "<repoId>",
  "title": "C2 - Checkpoint Writer and Context Note Manager",
  "description": "Create deterministic checkpoint commits and tracked context notes during run progression.",
  "sourceRef": "main",
  "dependencies": [
    { "upstreamTaskId": "<taskId_C1>", "mode": "review_ready", "primary": true }
  ],
  "taskPrompt": "Implement C2 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until C1 is merged to main.\n\nRequired outcomes:\n1. Add phase-boundary checkpoint hooks in run orchestrator.\n2. Create checkpoint commits when working tree is dirty.\n3. Add tracked context notes file updates at each checkpoint:\n   - .agentskanban/context/run-context.md\n4. Persist checkpoint metadata on run and emit checkpoint events/timeline notes.\n5. Add tests for checkpoint creation and context-note updates.\n\nImplementation guidance:\n- Ensure no empty checkpoint commits.\n- Keep checkpoint commit messages deterministic.\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.",
  "acceptanceCriteria": [
    "Checkpoints are created at phase boundaries when there are changes.",
    "Context notes file is tracked and updated deterministically.",
    "Checkpoint metadata is persisted and observable.",
    "Before pushing the branch, run yarn typecheck and fix all issues.",
    "make sure that \"yarn test\" passes"
  ],
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## C3 Payload

```json
{
  "repoId": "<repoId>",
  "title": "C3 - Retry Recovery from Latest Checkpoint",
  "description": "Extend retry semantics to restore from latest checkpoint by default with explicit fallback behavior.",
  "sourceRef": "main",
  "dependencies": [
    { "upstreamTaskId": "<taskId_C2>", "mode": "review_ready", "primary": true }
  ],
  "taskPrompt": "Implement C3 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until C2 is merged to main.\n\nRequired outcomes:\n1. Extend retry endpoint semantics:\n   - optional recoveryMode: latest_checkpoint|fresh\n   - optional checkpointId\n2. Default retry path should restore from latest checkpoint.\n3. Branch/source resolution for retry must support checkpoint commit SHA.\n4. Persist recovery provenance on run:\n   - resumedFromCheckpointId\n   - resumedFromCommitSha\n5. Add fallback to fresh retry when checkpoint is unavailable.\n6. Add tests for latest/default/explicit/fallback paths.\n\nImplementation guidance:\n- Keep compatibility with existing POST /api/runs/:runId/retry requests without body.\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.",
  "acceptanceCriteria": [
    "Retry defaults to latest checkpoint when available.",
    "Recovery provenance is stored on retried run.",
    "Fresh fallback path is deterministic and logged when checkpoint is unavailable.",
    "Before pushing the branch, run yarn typecheck and fix all issues.",
    "make sure that \"yarn test\" passes"
  ],
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## C4 Payload

```json
{
  "repoId": "<repoId>",
  "title": "C4 - Review Prep Cleanup and First-Review Squash",
  "description": "Clean context notes before review and squash checkpoint history for first review-open/update while preserving no-rewrite reruns.",
  "sourceRef": "main",
  "dependencies": [
    { "upstreamTaskId": "<taskId_C3>", "mode": "review_ready", "primary": true }
  ],
  "taskPrompt": "Implement C4 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until C3 is merged to main.\n\nRequired outcomes:\n1. Before first review open/update in a run:\n   - remove tracked context file\n   - prepare one clean final commit (squash checkpoint history)\n2. Keep no-rewrite behavior for request-changes reruns on existing review branch.\n3. Ensure context note file does not persist in first review-visible commit.\n4. Emit timeline/events for context cleanup and squash operations.\n5. Add tests for first-review rewrite and rerun no-rewrite semantics.\n\nImplementation guidance:\n- Reuse existing push/review flow and SCM adapter boundaries.\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.",
  "acceptanceCriteria": [
    "First review open/update uses clean squashed commit history.",
    "Context notes file is not present in first review-visible commit.",
    "Change-request reruns do not rewrite history.",
    "Before pushing the branch, run yarn typecheck and fix all issues.",
    "make sure that \"yarn test\" passes"
  ],
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## C5 Payload

```json
{
  "repoId": "<repoId>",
  "title": "C5 - Checkpoint APIs and UI Surfaces",
  "description": "Expose checkpoint visibility through APIs and run/task detail UI for operators.",
  "sourceRef": "main",
  "dependencies": [
    { "upstreamTaskId": "<taskId_C4>", "mode": "review_ready", "primary": true }
  ],
  "taskPrompt": "Implement C5 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until C4 is merged to main.\n\nRequired outcomes:\n1. Add endpoint: GET /api/runs/:runId/checkpoints.\n2. Add endpoint: GET /api/tasks/:taskId/checkpoints?latest=true.\n3. Add UI checkpoint list in run/task detail surfaces.\n4. Show resume provenance indicators for retry runs.\n5. Add tests for endpoint contracts and UI rendering states.\n\nImplementation guidance:\n- Keep UI concise and operator-oriented (phase, sha, timestamp, resumed-from).\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.",
  "acceptanceCriteria": [
    "Operators can list checkpoints for runs and tasks.",
    "UI clearly shows checkpoint and resumed-from metadata.",
    "API responses are deterministic and backward compatible.",
    "Before pushing the branch, run yarn typecheck and fix all issues.",
    "make sure that \"yarn test\" passes"
  ],
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## C6 Payload

```json
{
  "repoId": "<repoId>",
  "title": "C6 - Hardening, Docs, and Rollout",
  "description": "Finalize reliability safeguards, complete docs, and provide rollout playbook for checkpoint recovery.",
  "sourceRef": "main",
  "dependencies": [
    { "upstreamTaskId": "<taskId_C5>", "mode": "review_ready", "primary": true }
  ],
  "taskPrompt": "Implement C6 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until C5 is merged to main.\n\nRequired outcomes:\n1. Add race/idempotency safeguards around checkpoint writes and recovery selection.\n2. Add integration and regression coverage for full checkpoint lifecycle.\n3. Update docs:\n   - README.md\n   - docs/features-and-api.md\n   - docs/local-testing.md\n   - docs/integrations/checkpoint-recovery.md (new)\n4. Provide rollout checklist and fallback/disable playbook.\n\nImplementation guidance:\n- Ensure existing flows are unchanged when checkpointConfig.enabled=false.\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.",
  "acceptanceCriteria": [
    "Checkpoint flow has race/idempotency protections.",
    "Integration/regression coverage validates checkpoint lifecycle and fallback paths.",
    "Operational documentation is complete for rollout and troubleshooting.",
    "Before pushing the branch, run yarn typecheck and fix all issues.",
    "make sure that \"yarn test\" passes"
  ],
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

