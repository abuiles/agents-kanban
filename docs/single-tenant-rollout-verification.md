# Single-Tenant Rollout Verification (Task ST-6)

Date: 2026-03-03

## Scope

Verification for Task 6 in `docs/stage_single_tenant_oss.md`:

- tests aligned to single-tenant login/invite/PAT contract
- docs aligned to single-tenant API + secret model
- local rollout checklist executed and captured

## Checklist Results

- [x] Worker tests cover login path
  - `tests/worker/stage-6-single-tenant-auth.test.ts`
  - validated signup -> logout -> login -> `GET /api/me`
- [x] Worker tests cover invite path
  - owner create/list invite + invite acceptance account creation
- [x] Worker tests cover PAT auth path
  - create/list/revoke PAT
  - `x-api-token` and `Authorization: Bearer <pat>` auth
- [x] Unit tests cover auth store login/invite/PAT lifecycle
  - `src/server/tenant-auth-db.test.ts`
- [x] Docs updated to single-tenant API + secret model
  - `docs/tenant-auth-api.md`
  - `docs/features-and-api.md`
  - `docs/local-testing.md`
  - `docs/roadmap.md`
  - `docs/stage_4_6.md`

## Command Log

1. `npm install`
- Result: pass

2. `npm run test -- src/server/tenant-auth-db.test.ts`
- Result: pass (4/4 tests)

3. `npm run test:workers -- tests/worker/stage-6-single-tenant-auth.test.ts`
- Result: pass (4/4 tests)

4. `npm run typecheck`
- Result: pass

5. `npm run build`
- Result: pass

6. `npm run test:workers`
- Result: fail in legacy Stage 3.5 worker dogfood suites due auth expectation mismatch (`/api/repos` returns `401` without session/PAT)
- ST-6 single-tenant auth suite passed in the same run

7. `npm run test`
- Result: fail outside ST-6 scope:
  - `src/server/run-orchestrator.test.ts` assertion mismatch on workflow invocation ID format
  - `src/ui/App.test.tsx` import resolution for `@cloudflare/sandbox/xterm`

## Cloudflare Secret-Model Reference Check

The docs update was validated against current Cloudflare Workers documentation for:

- Worker secrets via `wrangler secret put`
- local secret files (`.dev.vars` / `.env`) and gitignore expectations

References:

- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/development-testing/environment-variables/
- https://developers.cloudflare.com/workers/wrangler/environments/
