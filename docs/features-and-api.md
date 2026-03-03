# AgentsKanban Features & API Surface

## Machine-readable feature matrix

| Feature area | Stage | Status | Implemented endpoints | Missing endpoints | Sync notes |
| --- | --- | --- | --- | --- | --- |
| Board and live state | 2, 4 | ✅ Implemented | `GET /api/board?repoId=all|<repoId>`; `GET /api/board/ws` | _none_ | Core board snapshot and websocket state stream are live. |
| Repositories | 2 | ✅ Implemented | `GET /api/repos`; `POST /api/repos`; `PATCH /api/repos/:repoId` | _none_ | Repo edit and listing are in place. |
| Tasks | 2, 3 | ✅ Implemented | `GET /api/tasks?repoId=all|<repoId>`; `POST /api/tasks`; `GET /api/tasks/:taskId`; `PATCH /api/tasks/:taskId`; `DELETE /api/tasks/:taskId` | _none_ | Full task lifecycle and mutation APIs are in place. |
| Run execution | 3, 3.1, 3.5 | ✅ Implemented | `POST /api/tasks/:taskId/run`; `GET /api/runs/:runId`; `POST /api/runs/:runId/retry`; `POST /api/runs/:runId/preview`; `POST /api/runs/:runId/evidence`; `POST /api/runs/:runId/request-changes`; `POST /api/runs/:runId/cancel` | `GET /api/runs/:runId/audit` *(Stage 5 target)* | Runtime, retry, preview/evidence orchestration and cancel/change-request flows are implemented. |
| Logs and artifacts | 3, 4 | ✅ Implemented | `GET /api/runs/:runId/logs`; `GET /api/runs/:runId/artifacts` | _none_ | Includes tailing behavior for logs and artifact listing per run. |
| Operator observe + attach + takeover | 4 | ✅ Implemented | `GET /api/runs/:runId/events`; `GET /api/runs/:runId/commands`; `GET /api/runs/:runId/terminal`; `GET /api/runs/:runId/ws`; `POST /api/runs/:runId/takeover` | _none_ | Observe/attach flows are live. |
| Single-tenant auth | single-tenant OSS | ✅ Implemented | `POST /api/auth/signup`; `POST /api/auth/login`; `POST /api/auth/logout`; `GET /api/me` | _none_ | Session auth and PAT auth are supported for protected APIs. |
| Invites + personal API tokens | single-tenant OSS | ✅ Implemented | `POST /api/invites`; `GET /api/invites`; `POST /api/invites/:inviteId/accept`; `POST /api/me/api-tokens`; `GET /api/me/api-tokens`; `DELETE /api/me/api-tokens/:tokenId` | _none_ | Owner-managed invites and user PAT lifecycle are in place. |
| Usage reports | 4.5 | ✅ Implemented | `GET /api/tenant-usage?tenantId=&from=&to=`; `GET /api/tenant-usage/runs?tenantId=&from=&to=`; `GET /api/runs/:runId/usage` | _none_ | Usage APIs remain available; deployment is single-tenant. |
| Debug tools | 2 | ✅ Implemented | `GET /api/debug/export`; `POST /api/debug/import`; `POST /api/debug/sandbox/run`; `POST /api/debug/sandbox/file` | `POST /api/debug/import` may remain internal-only by design | Debug endpoints exist for migration/bootstrap checks. |
| Explainability/audit | 5 | ⏳ Pending | _none_ | `GET /api/runs/:runId/explanation`; `GET /api/runs/:runId/audit` | Stage 5 not yet implemented. |
| Scale/queueing | 7 | ⏳ Pending | _none_ | queued run endpoints + queue reason APIs | Stage 7 not yet implemented. |
| Hardening/policy/credentials | 8 | ⏳ Pending | _none_ | Stage 8 hardening/policy credential APIs and policy guard endpoints | Stage 8 not yet implemented. |

## Related guides

- Single-tenant auth API guide: `docs/tenant-auth-api.md`
- Single-tenant migration plan: `docs/stage_single_tenant_oss.md`
- Stage 4.6 history (superseded): `docs/stage_4_6.md`
