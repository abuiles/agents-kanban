# Stage: Review Playbook Selection (API-managed)

**Status:** Implemented

## Goal

Add API-managed review playbooks that operators can create, select, disable, and delete, while keeping review execution valid when no playbook is selected.

## Product Decisions

1. Playbooks are optional at both repo and task levels.
2. No hardcoded/default playbooks are seeded in code.
3. Task-level selection precedence is:
   - task playbook override
   - repo default playbook
   - fallback to existing prompt precedence (`task prompt` -> `repo prompt` -> native mode)
4. Disabled or missing playbooks never hard-fail review resolution; flow falls back to non-playbook prompt logic.

## API and Data Model Changes

New resource:

- `ReviewPlaybook { playbookId, tenantId, name, prompt, enabled, createdAt, updatedAt }`

New endpoints:

1. `GET /api/review-playbooks`
2. `POST /api/review-playbooks`
3. `PATCH /api/review-playbooks/:playbookId`
4. `DELETE /api/review-playbooks/:playbookId`

Extended fields:

1. `Repo.autoReview.playbookId?: string`
2. `Task.uiMeta.autoReviewPlaybookId?: string`

Clear behavior:

1. Task/repo playbook assignments can be cleared explicitly (set to no playbook).

## Runtime Behavior

1. Auto-review resolver reads tenant playbooks from `BOARD_INDEX`.
2. Effective prompt source can now be `playbook`.
3. If selected playbook exists, enabled, and has prompt, it is used for review prompt.
4. If selected playbook is absent/disabled, resolver falls back to prior behavior.

## UI Changes

1. Added `Review playbooks` control in the top control surface.
2. Added modal for:
   - create playbook
   - enable/disable playbook
   - delete playbook
3. Repo form:
   - `Auto-review playbook` select (`None` allowed)
4. Task form:
   - `Auto-review playbook` select with `Inherit` and `None`

## Testing Coverage

1. Validation tests for explicit playbook-clear semantics.
2. Review resolver tests for:
   - playbook prompt precedence
   - fallback when playbook missing/disabled

## Compatibility Notes

1. Existing repos/tasks with no playbook remain valid.
2. Existing auto-review prompt resolution remains intact when playbook is unset.
3. Deleting a playbook does not break run orchestration; runs fall back safely.
