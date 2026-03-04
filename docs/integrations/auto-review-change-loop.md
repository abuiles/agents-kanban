# Auto Review + Selective Change Loop (Stage 6)

## Purpose

This guide captures the end-to-end flow for Stage 6 hardening and operation handoff:

- automatic review execution after run lifecycle review entry
- provider posting to GitLab/Jira with retry-safe, idempotent behavior
- selective follow-up request-changes
- manual review-only reruns

## End-to-end operator sequence

1. Enable auto-review in repo config (and optional task override):

   - `repo.autoReview.enabled = true`
   - `repo.autoReview.provider = 'gitlab' | 'jira'`
   - `repo.autoReview.postInline = true` for GitLab inline notes

2. Trigger a normal run:

   - `POST /api/tasks/:taskId/run`

3. Verify review phase is reached:

   - `GET /api/runs/:runId`
   - confirm status moves to `PR_OPEN`
   - confirm timeline contains `Auto review started (round 1).`

4. Confirm findings posting and state:

   - `GET /api/runs/:runId`
   - confirm `reviewExecution` completed and `reviewFindingsSummary` present
   - confirm `reviewPostState.status === 'completed'` and no posting errors

5. Inspect review artifacts:

   - `GET /api/runs/:runId/artifacts`
   - verify review JSON/markdown pointers exist

6. Perform focused request-changes:

   - `POST /api/runs/:runId/request-changes`
   - payload examples:

   - all findings (default): `{ "prompt": "...", "reviewSelection": { "mode": "all" } }`
   - include subset: `{ "prompt": "...", "reviewSelection": { "mode": "include", "findingIds": ["<id>"], "includeReplies": true } }`
   - exclude subset: `{ "prompt": "...", "reviewSelection": { "mode": "exclude", "findingIds": ["<id>"] } }`
   - freeform intent: `{ "prompt": "...", "reviewSelection": { "mode": "freeform", "instruction": "Focus on security findings first." } }`

7. Optional: rerun review manually after follow-up:

   - `POST /api/runs/:runId/review`
   - confirm timeline contains `Manual review started (round N).`

## Execution handoff pack (for next phase)

1. Repo/task state
   - repo auto-review config captured and propagated to task overrides if needed
   - run baseline `reviewFindings` and `changeRequest` snapshots copied into handoff notes

2. Retry observability
   - include latest `reviewPostState` snapshot:
     - provider, status, round, postedCount, findingsCount, errors, timestamps
     - `summaryPosted` and summary thread metadata if present

3. Recovery instructions
   - if review posting fails, rerun with `POST /api/runs/:runId/review`
   - if retries hit quota, inspect run logs for posting failure messages and provider status codes

## Troubleshooting playbook

- `reviewExecution.trigger` remains `auto_on_review` but `round` is still `0`
  - check repo auto-review setting and task override mode resolution
- postings never happen
  - confirm provider credential secret exists (`GITLAB_TOKEN` or `JIRA_TOKEN`)
- duplicate findings comments appearing
  - verify stable marker IDs in provider comments and idempotent mapping behavior
- request-changes prompt missing selection context
  - confirm `reviewSelection` payload is valid JSON and provider replies are enabled only for gitlab/jira

## Known limitations / deferred work

- Jira comment threading is treated as marker-based dedupe only; cross-page/reply threading is not deeply normalized.
- GitLab inline posting recovery after transient network failures depends on re-fetching discussion state before retries.
- Cross-provider review-provider migration for a run is not yet available; changing provider requires a new run cycle.
- Automatic remediation immediately after every finding is intentionally out of scope for this stage.
