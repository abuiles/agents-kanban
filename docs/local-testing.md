# Local Testing Guide

This playbook verifies the single-tenant end-to-end flow on local Worker/Vite runtime.

## 1) What this validates

- session auth (signup/login/logout)
- invite onboarding (owner create invite -> invitee accepts -> login)
- personal API token auth (create/list/revoke + protected API access)
- board/task/run APIs and attach paths (`/api/runs/:runId/terminal`, `/api/runs/:runId/ws`)
- runtime secrets model (Cloudflare Worker secrets only)

## 2) Runtime secret model

Runtime SCM/LLM credentials must come from Worker secrets, not DB/KV API endpoints.

Required secrets (set only what your repos/providers use):

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `OPENAI_API_KEY`
- `CODEX_AUTH_BUNDLE_R2_KEY`

Set secrets:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITLAB_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CODEX_AUTH_BUNDLE_R2_KEY
```

Cloudflare references:

- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/platform/limits/

## 3) Required infrastructure bindings

- R2 bucket: `RUN_ARTIFACTS`
- D1: `TENANT_DB`
- Workflow: `RUN_WORKFLOW`
- Durable Objects: `BOARD_INDEX`, `REPO_BOARD`, `Sandbox`

If bindings changed:

```bash
npx wrangler types
```

## 4) D1 migrations

```bash
npx wrangler d1 migrations list TENANT_DB --local
npx wrangler d1 migrations apply TENANT_DB --local
```

## 5) `.codex` auth bundle (R2)

Upload only auth files, not full home directory.

```bash
tmp_dir="$(mktemp -d)"
mkdir -p "$tmp_dir/.codex"
cp "$HOME/.codex/auth.json" "$tmp_dir/.codex/auth.json"
cp "$HOME/.codex/config.toml" "$tmp_dir/.codex/config.toml"
tar -czf codex-auth.tgz -C "$tmp_dir" .codex
npx wrangler r2 object put my-sandbox-run-artifacts/auth/codex-auth.tgz --file ./codex-auth.tgz --remote
rm -rf "$tmp_dir"
```

Use this secret value:

```text
auth/codex-auth.tgz
```

## 6) Local commands

```bash
npm install
npm run build
npm run dev
```

Base URL:

```text
http://localhost:5173/api
```

## 7) API verification flow (single-tenant)

1. Session bootstrap
   - `POST /api/auth/signup`
   - `POST /api/auth/login`
   - `GET /api/me`
2. Invite flow
   - Owner `POST /api/invites`
   - `GET /api/invites`
   - Invitee `POST /api/invites/:inviteId/accept`
   - Invitee `POST /api/auth/login`
3. PAT flow
   - `POST /api/me/api-tokens`
   - `GET /api/me/api-tokens`
   - Use PAT via `x-api-token` or `Authorization: Bearer <pat>` on protected endpoint (for example `GET /api/repos`)
   - `DELETE /api/me/api-tokens/:tokenId`
4. Negative contract checks
   - `POST /api/me/tenant-context` returns `404`
   - `/api/platform/*` routes return `404`

## 8) Worker/unit verification checklist (Task ST-6)

Run:

```bash
npm run test -- src/server/tenant-auth-db.test.ts
npm run test:workers -- tests/worker/stage-6-single-tenant-auth.test.ts
npm run test:workers
npm run test
npm run typecheck
```

Capture the date and outputs in release notes/PR summary.

### Verification capture (2026-03-03 UTC)

- `npm run test -- src/server/tenant-auth-db.test.ts` -> PASS
- `npm run test:workers -- tests/worker/stage-6-single-tenant-auth.test.ts` -> PASS
- `npm run test:workers` -> PASS (18 tests)
- `npm run typecheck` -> PASS
- `npm run test` -> FAIL (unrelated existing failures)
  - `src/server/run-orchestrator.test.ts` expectation mismatch for `buildWorkflowInvocationId`
  - `src/ui/App.test.tsx` import resolution for `@cloudflare/sandbox/xterm`
- Route contract grep (`src/server/api.ts`, `src/server/router.ts`) -> no active `/api/tenants*`, `/api/me/tenant-context`, or `/api/platform/*` routes

## 9) Troubleshooting

- `TENANT_DB schema is missing required tables`
  - Apply D1 migrations locally/remotely.
- `app_tenant_config is empty`
  - Seed tenant row using bootstrap flow/script before API use.
- PAT rejected
  - Confirm token is unrevoked and unexpired.
- Run start failures
  - Verify provider secret for selected `scmProvider` is configured.
