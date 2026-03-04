# Stage: Review Sandbox Operator Control and Attachability

**Status:** Planned

## Goal

Allow operators to explicitly attach to and take over the **review sandbox** (not only the main run sandbox), so they can manually run Codex, make changes, and push when needed during review loops.

## Problem Summary

Current behavior:

1. Main execution uses `buildSandboxId(runId, 'main')` and stores it on `run.sandboxId`.
2. Review execution uses `buildSandboxId(runId, 'review')` but does not expose this sandbox in terminal bootstrap APIs.
3. `/api/runs/:runId/terminal`, `/api/runs/:runId/ws`, and takeover are effectively pinned to `run.sandboxId` (main sandbox).

Result:

- Operators cannot intentionally attach to the review sandbox through existing APIs.

## Product Decisions (Locked)

1. Add explicit sandbox role selection for terminal attach and takeover.
2. Default role remains `main` for backward compatibility.
3. Review sandbox attach is allowed only while run is in review-capable statuses.
4. Operator session metadata stores sandbox role and selected sandbox id.
5. No implicit role switching during a live session.

## API Changes

## 1) `GET /api/runs/:runId/terminal`

Add query parameter:

- `sandboxRole=main|review` (default `main`)

Behavior:

1. Resolve target sandbox id by role.
2. Return `409` with structured reason when role sandbox is unavailable.

## 2) `GET /api/runs/:runId/ws`

Add query parameter:

- `sandboxRole=main|review` (default `main`)

Behavior:

1. Bootstrap session against role-selected sandbox id.
2. Persist operator session with role + sandbox id.

## 3) `POST /api/runs/:runId/takeover`

Add optional payload:

- `{ "sandboxRole": "main" | "review" }` (default `main`)

Behavior:

1. Stop active executor process for the selected role if applicable.
2. Move run to operator-controlled state tied to selected sandbox role.

## Data Model Changes

## Run shape

Add fields:

1. `reviewSandboxId?: string`
2. `operatorSession.sandboxRole?: 'main' | 'review'`

Keep:

1. `sandboxId` as main sandbox id for compatibility.

## Terminal bootstrap contract

Extend bootstrap payload:

1. `sandboxRole`
2. `requestedSandboxId`
3. `resolvedSandboxId`

## Runtime/Orchestrator Changes

1. Set `run.reviewSandboxId` when review sandbox is created in `executeRunReview`.
2. Keep review sandbox lifecycle role-specific and independent from main sandbox.
3. Add resolver utility:
   - `resolveRunSandboxByRole(run, role)` -> id or reason.
4. Ensure takeover kill behavior only targets process ids associated with selected role.

## Validation and Error Handling

1. Invalid role -> `400 BAD_REQUEST`.
2. Role sandbox missing -> `409` with `reason`:
   - `sandbox_missing`
   - `review_sandbox_not_initialized`
   - `run_not_active`
3. Access control remains unchanged (tenant/repo authorization still required).

## Backward Compatibility

1. Existing clients with no role param keep current behavior (`main`).
2. Existing run schema consumers continue to read `sandboxId`.
3. No changes required for non-review workflows.

## Testing Plan

## Unit tests

1. Sandbox role resolver (`main/review`) with missing/invalid cases.
2. Terminal bootstrap payload contains role metadata.

## Integration tests

1. Run with review stage creates `reviewSandboxId`.
2. `/terminal?sandboxRole=review` works after review sandbox init.
3. `/ws?sandboxRole=review` establishes operator session on review sandbox.
4. `takeover` with review role updates run/operator session state correctly.
5. Legacy `/terminal` and `/ws` without role remain functional.

## Manual QA

1. Start run and wait for review stage.
2. Attach to main sandbox and verify existing behavior unchanged.
3. Attach to review sandbox via query param and verify shell access.
4. Start Codex manually in review sandbox, apply change, push.
5. Confirm follow-up run/PR flow proceeds normally.

## Acceptance Criteria

1. Operators can explicitly attach to review sandbox through terminal/ws APIs.
2. Takeover can target review sandbox explicitly.
3. Backward-compatible main sandbox attach remains unchanged.
4. Role-aware attach/takeover has automated coverage.
