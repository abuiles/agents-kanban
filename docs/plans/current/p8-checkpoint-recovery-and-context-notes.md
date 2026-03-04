# Stage: Checkpoint Recovery + Ephemeral Context Notes

**Status:** Planned

## Goal

Reduce failure cost for long-running tasks by introducing deterministic run checkpoints and temporary in-repo context notes that enable reliable recovery without polluting final MR content.

MVP operator outcomes:

1. Runs create recoverable checkpoints while progressing.
2. Retries resume from the latest checkpoint by default.
3. Temporary context notes are available during execution.
4. Context notes are removed before first MR open/update.
5. Review-visible branch history is clean (single squashed final commit for first review open).

## Product Decisions (Locked)

1. Checkpoints are phase-boundary based (`bootstrap`, `codex`, `tests`, `push prep`).
2. Context notes live in a tracked file: `.agentskanban/context/run-context.md`.
3. Default retry recovery mode is latest checkpoint.
4. Before first review open/update in a run, squash checkpoint history into a clean final commit.
5. For request-changes reruns on existing review branch, do not rewrite history.
6. Repo-level rollout default is **ON** (opt-out via repo config).

## Scope

### In scope

1. Repo config for checkpoint behavior.
2. Run checkpoint metadata model and APIs.
3. Checkpoint commit creation in orchestrator.
4. Retry-from-checkpoint branch source behavior.
5. Context note lifecycle (write/update/remove).
6. Observability for checkpoint creation/recovery decisions.

### Out of scope

1. User-authored checkpoint scripting.
2. Cross-repo restore.
3. Rich UI editor for context notes.

## Architecture

Add a checkpoint subsystem integrated into current run orchestration:

1. `CheckpointPolicyResolver`
   - resolves effective repo checkpoint policy.
2. `CheckpointWriter`
   - creates checkpoint commits and metadata entries.
3. `ContextNoteManager`
   - appends deterministic execution notes in tracked context file.
4. `CheckpointRecoveryResolver`
   - selects recovery checkpoint for retries.
5. `ReviewPrepCleaner`
   - removes context file and prepares clean review-visible commit.

Reuse existing:

1. `run-orchestrator` branch prep/push/review flow.
2. `RepoBoardDO` run lifecycle and timeline.
3. run events/logs/artifact surfaces.

## Data Model Additions

### Repo config extension

Add `repo.checkpointConfig`:

```ts
type RepoCheckpointConfig = {
  enabled: boolean; // default true
  triggerMode: 'phase_boundary';
  contextNotes: {
    enabled: boolean; // default true
    filePath: string; // default ".agentskanban/context/run-context.md"
    cleanupBeforeReview: boolean; // default true
  };
  reviewPrep: {
    squashBeforeFirstReviewOpen: boolean; // default true
    rewriteOnChangeRequestRerun: boolean; // default false
  };
};
```

### Run extension

Add checkpoint metadata to `AgentRun`:

```ts
type RunCheckpoint = {
  checkpointId: string;
  runId: string;
  repoId: string;
  taskId: string;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push';
  commitSha: string;
  commitMessage: string;
  contextNotesPath?: string;
  createdAt: string;
};
```

Run fields:

1. `checkpoints?: RunCheckpoint[]`
2. `resumedFromCheckpointId?: string`
3. `resumedFromCommitSha?: string`

## API Additions/Changes

### Add

1. `GET /api/runs/:runId/checkpoints`
2. `GET /api/tasks/:taskId/checkpoints?latest=true`

### Extend

`POST /api/runs/:runId/retry` optional body:

```json
{
  "recoveryMode": "latest_checkpoint | fresh",
  "checkpointId": "optional-explicit-id"
}
```

Default when omitted: `latest_checkpoint`.

## Control Flow

### Run execution

1. Prepare branch/source as today.
2. At each checkpoint boundary:
   - if working tree dirty, write/update context note file, commit checkpoint, persist checkpoint metadata.
3. Before first review open/update:
   - remove context note file;
   - squash checkpoint history into one final review-visible commit;
   - push and open/update review.
4. For change-request reruns:
   - keep linear incremental history (no rewrite);
   - ensure context note file not present in final pushed tree.

### Failure + retry

1. On failure, checkpoints remain on run branch.
2. Retry picks latest checkpoint SHA by default.
3. New retry run branches from selected checkpoint SHA.
4. If no checkpoint exists, fallback to existing start behavior and log warning.

## Failure Handling

1. Checkpoint commit failure:
   - fail run with `CHECKPOINT_FAILED` and include command stderr.
2. Context cleanup failure before review:
   - fail run with `CONTEXT_CLEANUP_FAILED`.
3. Squash/review prep failure:
   - fail run with `REVIEW_PREP_FAILED`.
4. Retry checkpoint missing:
   - fallback to fresh retry + warning event.

## Observability

Add run events:

1. `run.checkpoint.created`
2. `run.checkpoint.restore_selected`
3. `run.context.cleaned`
4. `run.review_prep.squashed`

Add timeline notes for:

1. checkpoint creation (phase + sha)
2. recovery mode selection
3. cleanup/squash outcomes

## 6-Task Execution Plan (Sequential Chain)

### C1 — Checkpoint Domain, Types, and Validation

Scope:

1. Add repo checkpoint config types/defaults/validation.
2. Add run checkpoint metadata types and storage shape.
3. Extend create/update repo and run schemas.

Acceptance:

1. Repo checkpoint config persists with defaults.
2. Run checkpoint fields are type-safe and backward compatible.

---

### C2 — Orchestrator Checkpoint Writer + Context Note Manager

Scope:

1. Add checkpoint boundary hooks in orchestrator.
2. Implement tracked context note creation/update.
3. Persist checkpoint metadata per run.

Acceptance:

1. Checkpoints created at configured phase boundaries when dirty.
2. Context note file updates are deterministic.

---

### C3 — Retry Recovery from Latest Checkpoint

Scope:

1. Extend retry endpoint to support recovery mode.
2. Implement checkpoint selection and run branch source from checkpoint SHA.
3. Add fallback to fresh start when unavailable.

Acceptance:

1. Retry defaults to latest checkpoint.
2. Recovery metadata is visible on new run.

---

### C4 — Review Prep Cleanup + First-Review Squash

Scope:

1. Remove context file before first review open/update.
2. Squash checkpoint history into one clean final commit.
3. Preserve no-rewrite behavior for change-request reruns.

Acceptance:

1. Context note is absent from first review-visible commit.
2. First review open/update uses clean commit history.

---

### C5 — Checkpoint APIs + UI Read Surfaces

Scope:

1. Add run/task checkpoint read endpoints.
2. Add checkpoint listing in run/task detail panel.
3. Show resumed-from-checkpoint indicators.

Acceptance:

1. Operators can inspect checkpoints and recovery provenance.

---

### C6 — Hardening, Docs, and Rollout

Scope:

1. Add race/idempotency safeguards around checkpoint writes.
2. Add full integration/regression coverage.
3. Update docs and rollout playbook.

Acceptance:

1. Checkpoint flow is test-covered and operationally documented.

## Test Plan

### Unit tests

1. config default/validation behavior
2. checkpoint eligibility and commit message formatting
3. retry checkpoint selection logic
4. rerun no-rewrite policy decisions

### Integration tests

1. run checkpoint creation across phases
2. failure then retry-from-checkpoint behavior
3. context-file cleanup before first review
4. first-review squash behavior
5. rerun on existing review without rewrite

### Regression tests

1. old retry API call (no body) remains valid
2. sentinel/manual run flows unaffected when disabled

## Rollout Plan

1. Enable by default via repo config defaults.
2. Allow per-repo opt-out.
3. Monitor:
   - retry success rate
   - median rerun duration
   - checkpoint/review prep failures
4. Document emergency disable path.

