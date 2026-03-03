# AgentsKanban Roadmap

## Stage status (current)

| Stage | Status | Doc |
| --- | --- | --- |
| 2 | ✅ Implemented | [docs/stage_2.md](stage_2.md) |
| 3 | ✅ Implemented | [docs/stage_3.md](stage_3.md) |
| 3.1 | ✅ Implemented | [docs/stage_3_1.md](stage_3_1.md) |
| 3.5 | ✅ Implemented | [docs/stage_3_5.md](stage_3_5.md) |
| 4 | ✅ Implemented (core) | [docs/stage_4.md](stage_4.md) |
| ST-6 Single-tenant OSS migration | ✅ Implemented | [docs/stage_single_tenant_oss.md](stage_single_tenant_oss.md) |
| 5 | ⏳ Pending | [docs/stage_5.md](stage_5.md) |
| 7 | ⏳ Pending | [docs/stage_7.md](stage_7.md) |
| 8 | ⏳ Pending | [docs/stage_8.md](stage_8.md) |

## Execution order

1. Stage 2: Board/server foundation
2. Stage 3: Run execution
3. Stage 3.1: Dependency fanout
4. Stage 3.5: Provider/adapter seams
5. Stage 4: Observe + attach runs
6. ST-6: Single-tenant OSS migration (replaces stage 4.5/4.6 contract)
7. Stage 5: Audit/explainability
8. Stage 7: Scale/queueing/concurrency
9. Stage 8: Hardening/security/policy

## Sync checklist

- [x] Stage 2 complete
- [x] Stage 3 complete
- [x] Stage 3.1 complete
- [x] Stage 3.5 complete
- [x] Stage 4 core complete
- [x] ST-6 single-tenant contract complete
- [ ] Stage 5 complete
- [ ] Stage 7 complete
- [ ] Stage 8 complete

## Focus now

- Ship Stage 5 explainability/audit endpoints.
- Add Stage 7 queue semantics and capacity APIs.
- Complete Stage 8 hardening/policy work.
