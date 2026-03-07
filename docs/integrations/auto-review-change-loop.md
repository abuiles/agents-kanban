# Auto Review + Selective Change Loop (Stage 6)

## Purpose

This guide captures the end-to-end flow for Stage 6 hardening and operation handoff:

- automatic review execution after run lifecycle review entry
- provider posting to GitHub/GitLab/Jira with retry-safe, idempotent behavior
- selective follow-up request-changes
- manual review-only reruns

## End-to-end operator sequence

1. Enable auto-review in repo config (and optional task override):

   - `repo.autoReview.enabled = true`
   - `repo.autoReview.provider = 'github' | 'gitlab' | 'jira'`
   - `repo.autoReview.postInline = true` for GitLab inline notes
   - optional repo-level playbook: `repo.autoReview.playbookId = "<playbookId>"`
   - optional task-level override: `task.uiMeta.autoReviewPlaybookId = "<playbookId>" | "" | inherit`
   - for GitHub repos, provider defaults to `github` when omitted and `autoReview.enabled=true`

2. (Optional) manage playbooks through API:

   - `GET /api/review-playbooks`
   - `POST /api/review-playbooks`
   - `PATCH /api/review-playbooks/:playbookId`
   - `DELETE /api/review-playbooks/:playbookId`

3. Trigger a normal run:

   - `POST /api/tasks/:taskId/run`

4. Verify review phase is reached:

   - `GET /api/runs/:runId`
   - confirm status moves to `PR_OPEN`
   - confirm timeline contains `Auto review started (round 1).`

5. Confirm findings posting and state:

   - `GET /api/runs/:runId`
   - confirm `reviewExecution` completed and `reviewFindingsSummary` present
   - confirm `reviewPostState.status === 'completed'` and no posting errors

6. Inspect review artifacts:

   - `GET /api/runs/:runId/artifacts`
   - verify review JSON/markdown pointers exist

7. Perform focused request-changes:

   - `POST /api/runs/:runId/request-changes`
   - payload examples:

   - all findings (default): `{ "prompt": "...", "reviewSelection": { "mode": "all" } }`
   - include subset: `{ "prompt": "...", "reviewSelection": { "mode": "include", "findingIds": ["<id>"], "includeReplies": true } }`
   - exclude subset: `{ "prompt": "...", "reviewSelection": { "mode": "exclude", "findingIds": ["<id>"] } }`
   - freeform intent: `{ "prompt": "...", "reviewSelection": { "mode": "freeform", "instruction": "Focus on security findings first." } }`

8. Optional: rerun review manually after follow-up:

   - `POST /api/runs/:runId/review`
   - confirm timeline contains `Manual review started (round N).`

## GitHub dogfood setup and QA

1. Runtime secrets:
   - set `GITHUB_TOKEN` in Worker secrets (write access to PR comments/reviews).
2. Webhook verification secret:
   - set `github/webhook-secret` in `SECRETS_KV`.
3. GitHub webhook subscription:
   - endpoint: `POST /api/integrations/github/webhook`
   - events: `Pull request review comments`, `Pull request reviews`, `Issue comments`
4. Dry run one PR flow in AgentsKanban repo:
   - run task with `sourceRef=main`
   - confirm findings post to PR with marker comments
   - reply to at least one marker-bearing finding comment on GitHub
5. Trigger selective request-changes with replies:
   - send `POST /api/runs/:runId/request-changes` and set:
   - `{ "reviewSelection": { "mode": "include", "findingIds": ["<id>"], "includeReplies": true } }`
6. Verify merged context:
   - prompt includes deduped reply lines from both webhook-ingested hints and on-demand fetch
   - ordering is deterministic (source-priority + stable lexical sort)

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
- playbook appears selected but prompt source is still `native`/`repo`/`task`
  - verify playbook exists and `enabled=true`
  - verify selected playbook belongs to the active tenant
- postings never happen
  - confirm provider credential secret exists (`GITHUB_TOKEN`, `GITLAB_TOKEN`, or `JIRA_TOKEN`)
- duplicate findings comments appearing
  - verify stable marker IDs in provider comments and idempotent mapping behavior
- request-changes prompt missing selection context
  - confirm `reviewSelection` payload is valid JSON and provider replies are enabled for github/gitlab/jira
- GitHub replies missing from request-changes context
  - verify webhook secret is configured in KV as `github/webhook-secret`
  - verify webhook deliveries return `status: accepted` (not signature errors)
  - verify review number/project path in webhook payload matches the run review metadata

## Known limitations / deferred work

- GitHub webhook ingestion only stores marker-bearing comment/review content; non-marker conversational context is ignored.
- Reply merge currently dedupes by normalized body text and source order; richer thread semantics (author/timestamp weighting) are deferred.
- Webhook ingestion is tenant-primary; multi-tenant, per-repo GitHub app installation mapping is deferred.
- Jira comment threading is treated as marker-based dedupe only; cross-page/reply threading is not deeply normalized.
- GitLab inline posting recovery after transient network failures depends on re-fetching discussion state before retries.
- Cross-provider review-provider migration for a run is not yet available; changing provider requires a new run cycle.
- Automatic remediation immediately after every finding is intentionally out of scope for this stage.
