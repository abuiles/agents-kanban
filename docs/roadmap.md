# AgentsKanban Roadmap

## Stage status (current)

| Stage | Status | Doc |
| --- | --- | --- |
| 2 | ✅ Implemented | [docs/stage_2.md](stage_2.md) |
| 3 | ✅ Implemented | [docs/stage_3.md](stage_3.md) |
| 3.1 | ✅ Implemented | [docs/stage_3_1.md](stage_3_1.md) |
| 3.5 | ✅ Implemented | [docs/stage_3_5.md](stage_3_5.md) |
| 4 | ✅ Implemented (core) | [docs/stage_4.md](stage_4.md) |
| Single-tenant OSS simplification | 🚧 In progress | [docs/stage_single_tenant_oss.md](stage_single_tenant_oss.md) |
| 4.5 | ⚠️ Superseded by single-tenant stage | [docs/stage_4_5.md](stage_4_5.md) |
| 4.6 | ⚠️ Superseded by single-tenant stage | [docs/stage_4_6.md](stage_4_6.md) |
| 5 | ⏳ Pending | [docs/stage_5.md](stage_5.md) |
| 6 | ⚠️ Partial | [docs/stage_6.md](stage_6.md) |
| 7 | ⏳ Pending | [docs/stage_7.md](stage_7.md) |
| 8 | ⏳ Pending | [docs/stage_8.md](stage_8.md) |

## Execution order

1. Stage 2: Board/server foundation
2. Stage 3: Run execution
3. Stage 3.1: Dependency fanout
4. Stage 3.5: Provider/adapter seams
5. Stage 4: Observe + attach runs
6. Single-tenant OSS simplification (breaking auth/tenant model cutover)
7. Stage 6: Operator control completion
8. Stage 5: Audit/explainability
9. Stage 7: Scale/queueing/concurrency
10. Stage 8: Hardening/security/policy

## Sync checklist

- [x] Stage 2 complete
- [x] Stage 3 complete
- [x] Stage 3.1 complete
- [x] Stage 3.5 complete
- [x] Stage 4 core complete
- [ ] Single-tenant OSS stage complete
- [ ] Stage 5 complete
- [ ] Stage 6 full control complete
- [ ] Stage 7 complete
- [ ] Stage 8 complete

## Focus now

- Finish single-tenant OSS cutover and rollout verification.
- Keep Stage 5 and Stage 8 after the single-tenant cutover and queueing work.
