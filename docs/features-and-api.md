# AgentsKanban Features & API Surface

> Note: This matrix includes historical stage labels for traceability. The active planning model is `P1-P4` in `docs/plans/current/`.

## Machine-readable feature matrix

| Feature area | Stage | Status | Implemented endpoints | Missing endpoints | Sync notes |
| --- | --- | --- | --- | --- | --- |
| Board and live state | 2, 4 | ✅ Implemented | `GET /api/board?repoId=all|<repoId>`; `GET /api/board/ws` | _none_ | Core board snapshot and websocket state stream are live. |
| Repositories | 2 | ✅ Implemented | `GET /api/repos`; `POST /api/repos`; `PATCH /api/repos/:repoId` | _none_ | Repo edit and listing are in place. |
| Native sentinel orchestration | P7/S2-S6 | ✅ Implemented | `GET /api/repos/:repoId/sentinel`; `PATCH /api/repos/:repoId/sentinel/config`; `POST /api/repos/:repoId/sentinel/start`; `POST /api/repos/:repoId/sentinel/pause`; `POST /api/repos/:repoId/sentinel/resume`; `POST /api/repos/:repoId/sentinel/stop`; `GET /api/repos/:repoId/sentinel/events` | `POST /api/repos/:repoId/sentinel/retry-merge` *(optional follow-up)* | Event timeline + diagnostics are available from status/events responses; progression is lease/idempotency hardened to avoid duplicate processing. |
| SCM credentials | 2, 3.5 | ✅ Implemented | `GET /api/scm/credentials`; `POST /api/scm/credentials`; `GET /api/scm/credentials/:provider/:providerRepoName` | _none_ | Provider credential registry exists, including get/list/upsert. Supports GitHub and GitLab SCM providers. |
| Tasks | 2, 3 | ✅ Implemented | `GET /api/tasks?repoId=all|<repoId>`; `POST /api/tasks`; `GET /api/tasks/:taskId`; `PATCH /api/tasks/:taskId`; `DELETE /api/tasks/:taskId` | _none_ | Full task lifecycle and mutation APIs are in place. |
| Run execution | 3, 3.1, 3.5, 6 | ✅ Implemented | `POST /api/tasks/:taskId/run`; `GET /api/runs/:runId`; `POST /api/runs/:runId/retry`; `POST /api/runs/:runId/preview`; `POST /api/runs/:runId/evidence`; `POST /api/runs/:runId/request-changes`; `POST /api/runs/:runId/review` | `GET /api/runs/:runId/audit` *(Stage 5 target)* | Runtime includes auto review on review entry, manual review rerun endpoint, stable posting and retry metadata. |
| Slack/Jira/GitLab integrations | P5 | ✅ Implemented (MVP) | `POST /api/integrations/slack/commands`; `POST /api/integrations/slack/events`; `POST /api/integrations/slack/interactions`; `POST /api/integrations/gitlab/webhook` | _none in MVP scope_ | Slack ingress uses signature verification + replay protection. GitLab webhook ingress uses token verification + delivery idempotency. Slack thread binding remains the primary operator surface across reruns. |
| Logs and artifacts | 3, 4 | ✅ Implemented | `GET /api/runs/:runId/logs`; `GET /api/runs/:runId/artifacts` | _none_ | Includes tailing behavior for logs and artifact listing per run. |
| Operator observe | 4 | ✅ Implemented | `GET /api/runs/:runId/events`; `GET /api/runs/:runId/commands` | _none_ | Runtime event and structured command history are exposed. |
| Operator attach | 4 | ✅ Implemented | `GET /api/runs/:runId/terminal`; `GET /api/runs/:runId/ws` | _none_ | Websocket attach endpoint requires `Upgrade: websocket`. |
| Operator takeover | 4 | ✅ Implemented | `POST /api/runs/:runId/takeover` | _none_ | Run operator control handoff endpoint exists. |
| Operator control | 6 | ⚠️ Partial | `POST /api/runs/:runId/cancel` | Guidance-mode and explicit control-state/queue semantics not fully in scope yet; broader Stage 6 endpoints absent | Partial completion: cancel transition exists, but guided execution semantics are incomplete. |
| Tenant + metering | 4.5 | ✅ Implemented | `GET /api/tenants`; `POST /api/tenants`; `GET /api/tenants/:tenantId`; `PATCH /api/tenants/:tenantId`; `GET /api/tenants/:tenantId/members`; `POST /api/tenants/:tenantId/members`; `PATCH /api/tenants/:tenantId/members/:memberId`; `POST /api/auth/signup`; `POST /api/auth/login`; `POST /api/auth/logout`; `GET /api/me`; `POST /api/me/tenant-context`; `GET /api/tenant-usage?tenantId=&from=&to=`; `GET /api/tenant-usage/runs?tenantId=&from=&to=`; `GET /api/runs/:runId/usage` | _none_ | Tenant-aware APIs and pre-production rollout constraints are implemented. |
| Org onboarding + support admin | 4.6 | ✅ Implemented | `POST /api/tenants/:tenantId/invites`; `GET /api/tenants/:tenantId/invites`; `POST /api/invites/:inviteId/accept`; `POST /api/platform/auth/login`; `POST /api/platform/support/assume-tenant`; `POST /api/platform/support/release-tenant`; `GET /api/platform/support/sessions`; `GET /api/platform/audit-log` | _none_ | Invite-by-email onboarding and scoped platform support sessions are in place. |
| Explainability/audit | 5 | ⏳ Pending | _none_ | `GET /api/runs/:runId/explanation`; `GET /api/runs/:runId/audit` | Stage 5 not yet implemented. |
| Scale/queueing | 7 | ⏳ Pending | _none_ | queued run endpoints + queue reason APIs | Stage 7 not yet implemented. `max_instances` is currently set in Workers config and is platform-level only. |
| Hardening/policy/credentials | 8 | ⏳ Pending | _none_ | Stage 8 hardening/policy credential APIs and policy guard endpoints | Stage 8 not yet implemented. |
| Debug tools | 2 | ✅ Implemented | `GET /api/debug/export`; `POST /api/debug/import`; `POST /api/debug/sandbox/run`; `POST /api/debug/sandbox/file` | `POST /api/debug/import` may remain internal-only by design | Debug endpoints exist for migration and bootstrap checks. |

## Primary operator flow

1. `GET /api/board?repoId=all`
2. `POST /api/tasks`
3. `POST /api/tasks/:taskId/run`
4. `GET /api/runs/:runId`
5. `GET /api/runs/:runId/events`
6. `GET /api/runs/:runId/logs`
7. `GET /api/runs/:runId/artifacts`
8. `POST /api/runs/:runId/retry`
9. `GET /api/runs/:runId/terminal`
10. `GET /api/runs/:runId/ws`

## Related guides

- Tenant/auth API guide: `docs/tenant-auth-api.md`
- Active plans index: `docs/plans/current/README.md`
- Historical Stage 4.6 doc: `docs/plans/archive/stage_4_6.md`
- Auto-review + selective change-loop runbook: `docs/integrations/auto-review-change-loop.md`
- Native sentinel orchestration runbook: `docs/integrations/sentinel-orchestration.md`

## Stage 6 surface notes

- Added to run model:
  - `reviewExecution`: enabled/trigger/prompt source/round/timing.
  - `reviewFindingsSummary`: total/open/posted counts and provider.
  - `reviewPostState`: posting status, round, errors, and provider metadata.
  - `reviewArtifacts`: stable `findings.json` and markdown artifact pointers.
- Added routing:
  - `POST /api/runs/:runId/review` for manual review rerun (`review_only` orchestration mode).
- Enhanced request-changes input:
  - `reviewSelection.mode`: `all` / `include` / `exclude` / `freeform`.
  - Optional provider-reply stitching via `includeReplies`.

## Slack/Jira/GitLab MVP flow states

Decision-gated rerun loop for Slack-driven operation:

1. `QUEUED -> RUNNING -> MR_OPEN -> REVIEW_PENDING -> DECISION_REQUIRED`
2. On Slack approval: `DECISION_REQUIRED -> RERUN_QUEUED -> RUNNING`
3. Terminal states: `PAUSED | DONE | FAILED`

Operational notes:

- `approve_rerun` is required to start a rerun from review feedback.
- Multiple near-simultaneous approvals are deduped by loop-state transition guard.
- Slack and GitLab ingress paths include delivery dedupe checks to reduce duplicate task/run starts and duplicate feedback posts.

## Integration endpoint contract summary

- `POST /api/integrations/slack/commands`
  - Verified with Slack signing secret and replay window checks.
  - Accepts `/kanvy fix <JIRA_KEY>`.
  - Acknowledges immediately and continues Jira/repo/run processing asynchronously.
- `POST /api/integrations/slack/interactions`
  - Supports actions: `repo_disambiguation`, `approve_rerun`, `pause`, `close`.
  - Uses thread binding context (`taskId`, `channelId`, `threadTs`, `currentRunId`, `latestReviewRound`) to keep decisions in one thread.
- `POST /api/integrations/gitlab/webhook`
  - Verified with GitLab webhook token.
  - Normalizes MR and note webhooks into `REVIEW_PENDING` / `DECISION_REQUIRED` loop-state transitions.
  - Dedupes deliveries and Slack thread feedback mirrors by idempotency key.

## Sync template

Use this block as a checklist per release:

- [x] All implemented endpoints are functional in preview
- [x] No untracked production API regressions
- [ ] Stage 6 control semantics completed
- [x] Stage 4.5 APIs added
- [ ] Stage 5 audit/explanation APIs added
- [ ] Stage 7 queue APIs added
- [ ] Stage 8 policy APIs added
