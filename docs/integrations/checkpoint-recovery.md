# Checkpoint Recovery

This runbook documents checkpoint lifecycle behavior, rollout sequencing, and fallback controls for checkpoint-based retry recovery.

## What it does

- Creates deterministic checkpoint commits at phase boundaries (`bootstrap`, `codex`, `tests`, `push`) when the worktree is dirty.
- Persists checkpoint metadata on the run (`checkpoints[]`).
- Defaults retry recovery to the latest checkpoint when available.
- Records recovery provenance on the retried run:
  - `resumedFromCheckpointId`
  - `resumedFromCommitSha`
- Falls back safely to fresh retry when recovery cannot use a checkpoint.

## API surface

- `GET /api/runs/:runId/checkpoints`
- `GET /api/tasks/:taskId/checkpoints?latest=true`
- `POST /api/runs/:runId/retry`
  - Optional body:
    - `recoveryMode`: `latest_checkpoint` | `fresh`
    - `checkpointId`: explicit checkpoint id

## Reliability safeguards

- Checkpoint writes are phase-idempotent:
  - if the run already has a checkpoint for that phase, no new checkpoint is written.
- Checkpoint write reconciliation handles no-op commit races:
  - if `git commit` reports "nothing to commit" but HEAD already contains the expected checkpoint commit message, metadata is reconciled instead of failing.
- Metadata writes are de-duplicated before persistence:
  - no duplicate checkpoint entry for the same checkpoint id/commit sha.
- Recovery selection ignores malformed checkpoints:
  - invalid commit SHA entries are excluded from selection.
- Recovery selection is deterministic:
  - sequence (`:cp:NNN:`) ordering wins, then timestamp, then id/sha tie-breakers.

## Rollout checklist

1. Validate on one pilot repo:
   - confirm checkpoint creation appears in run timeline and `GET /api/runs/:runId/checkpoints`.
2. Validate default retry behavior:
   - run `POST /api/runs/:runId/retry` (no body) and confirm resume provenance fields are set.
3. Validate fallback path:
   - retry with a missing explicit checkpoint id and confirm fallback timeline note contains `reason=checkpoint_not_found`.
4. Verify review-prep cleanup:
   - confirm context note file is absent from the review-visible HEAD commit.
5. Verify no-regression when disabled:
   - set `checkpointConfig.enabled=false`, rerun, and confirm no checkpoint creation side effects.
6. Expand rollout by repo cohort after pilot is stable.

## Observability checks

Review these during rollout:

- Run timeline notes:
  - `Checkpoint created (...)`
  - recovery decision/fallback notes from retry.
- Run events:
  - `run.checkpoint.created`
  - review-prep events (`run.review_prep.context_cleaned`, `run.review_prep.squashed`)
- API surfaces:
  - run checkpoints endpoint output shape
  - task latest checkpoint endpoint output shape

## Fallback and disable playbook

Use this when checkpoint behavior causes operational risk in production.

1. Disable checkpointing per repo:
   - `PATCH /api/repos/:repoId`
   - body:
     ```json
     {
       "checkpointConfig": {
         "enabled": false
       }
     }
     ```
2. Continue using fresh retries:
   - `POST /api/runs/:runId/retry` with `{ "recoveryMode": "fresh" }`
3. Confirm disablement:
   - new runs no longer append checkpoint entries.
4. Collect diagnostics from failed run logs/events before re-enabling.
5. Re-enable only after reproducer is covered by regression tests.

## Troubleshooting

- Symptom: retry did not resume from checkpoint
  - Check `GET /api/runs/:runId/checkpoints` for malformed or missing checkpoint metadata.
  - Check retried run timeline for fallback reason (`no_checkpoints`, `checkpoint_not_found`, `checkpoint_invalid`).
- Symptom: duplicate checkpoint metadata suspected
  - Verify run checkpoint list for duplicate `checkpointId` values; selection logic now deduplicates by latest usable entry.
- Symptom: review branch contains context note file
  - Confirm repo has `checkpointConfig.contextNotes.cleanupBeforeReview=true`.
  - Check review-prep timeline/events for cleanup and squash outcomes.
