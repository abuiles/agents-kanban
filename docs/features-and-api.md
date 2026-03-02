# AgentsKanban Features & API Surface

## Machine-readable feature matrix

| Feature area | Stage | Status | Implemented endpoints | Missing endpoints | Sync notes |
| --- | --- | --- | --- | --- | --- |
| Board and live state | 2, 4 | ✅ Implemented | `GET /api/board?repoId=all|<repoId>`; `GET /api/board/ws` | _none_ | Core board snapshot and websocket state stream are live. |
| Repositories | 2 | ✅ Implemented | `GET /api/repos`; `POST /api/repos`; `PATCH /api/repos/:repoId` | _none_ | Repo edit and listing are in place. |
| SCM credentials | 2, 3.5 | ✅ Implemented | `GET /api/scm/credentials`; `POST /api/scm/credentials`; `GET /api/scm/credentials/:provider/:providerRepoName` | _none_ | Provider credential registry exists, including get/list/upsert. |
| Tasks | 2, 3 | ✅ Implemented | `GET /api/tasks?repoId=all|<repoId>`; `POST /api/tasks`; `GET /api/tasks/:taskId`; `PATCH /api/tasks/:taskId`; `DELETE /api/tasks/:taskId` | _none_ | Full task lifecycle and mutation APIs are in place. |
| Run execution | 3, 3.1, 3.5 | ✅ Implemented | `POST /api/tasks/:taskId/run`; `GET /api/runs/:runId`; `POST /api/runs/:runId/retry`; `POST /api/runs/:runId/preview`; `POST /api/runs/:runId/evidence`; `POST /api/runs/:runId/request-changes` | `GET /api/runs/:runId/audit` *(Stage 5 target)* | Runtime, retry, preview/evidence orchestration and change-request flows are implemented. |
| Logs and artifacts | 3, 4 | ✅ Implemented | `GET /api/runs/:runId/logs`; `GET /api/runs/:runId/artifacts` | _none_ | Includes tailing behavior for logs and artifact listing per run. |
| Operator observe | 4 | ✅ Implemented | `GET /api/runs/:runId/events`; `GET /api/runs/:runId/commands` | _none_ | Runtime event and structured command history are exposed. |
| Operator attach | 4 | ✅ Implemented | `GET /api/runs/:runId/terminal`; `GET /api/runs/:runId/ws` | _none_ | Websocket attach endpoint requires `Upgrade: websocket`. |
| Operator takeover | 4 | ✅ Implemented | `POST /api/runs/:runId/takeover` | _none_ | Run operator control handoff endpoint exists. |
| Operator control | 6 | ⚠️ Partial | `POST /api/runs/:runId/cancel` | Guidance-mode and explicit control-state/queue semantics not fully in scope yet; broader Stage 6 endpoints absent | Partial completion: cancel transition exists, but guided execution semantics are incomplete. |
| Tenant + metering | 4.5 | ⏳ Pending | _none_ | `GET /api/tenant`; `POST /api/tenant`; `PATCH /api/tenant/:tenantId`; `GET /api/tenant-usage`; `GET /api/tenant-usage/:tenantId`; `GET /api/tenant-usage/:tenantId/repo/:repoId` | Stage 4.5 not yet implemented. |
| Explainability/audit | 5 | ⏳ Pending | _none_ | `GET /api/runs/:runId/explanation`; `GET /api/runs/:runId/audit` | Stage 5 not yet implemented. |
| Scale/queueing | 7 | ⏳ Pending | _none_ | queued run endpoints + queue reason APIs | Stage 7 not yet implemented. |
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

## Sync template

Use this block as a checklist per release:

- [x] All implemented endpoints are functional in preview
- [x] No untracked production API regressions
- [ ] Stage 6 control semantics completed
- [ ] Stage 4.5 APIs added
- [ ] Stage 5 audit/explanation APIs added
- [ ] Stage 7 queue APIs added
- [ ] Stage 8 policy APIs added
