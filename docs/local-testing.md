# Local Testing Guide (Single-Tenant)

This playbook validates a real end-to-end local flow for single-tenant OSS mode.

## 1) What this validates

- login/session auth works
- invite creation and acceptance work
- PAT creation/use/revoke works
- board/task/run APIs work end-to-end
- run bootstraps into a sandbox

## 2) Required runtime secrets

Runtime credentials are sourced from Worker secrets:

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `OPENAI_API_KEY`
- optional `CODEX_AUTH_BUNDLE_R2_KEY`

Set local base URL:

```bash
BASE="http://localhost:5173/api"
```

Configure secrets:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITLAB_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CODEX_AUTH_BUNDLE_R2_KEY
```

Set only provider secrets you use for your repos.

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

Tenant/auth tables are in [`migrations/`](../migrations).

```bash
npx wrangler d1 migrations list TENANT_DB --local
npx wrangler d1 migrations apply TENANT_DB --local
```

## 5) `.codex` auth bundle (optional)

Upload bundle to R2 and point `CODEX_AUTH_BUNDLE_R2_KEY` at the object key.

```text
auth/codex-auth.tgz
```

## 6) Local dev commands

```bash
npm install
npm run build
npm run dev
```

API/UI base URL:

```text
http://localhost:5173/api
```

## 7) Minimal end-to-end single-tenant API test

1. Bootstrap owner account:
   - `POST /api/auth/signup`
   - `POST /api/auth/login`
   - `GET /api/me`
2. Invite flow:
   - `POST /api/invites` (owner session)
   - `GET /api/invites`
   - `POST /api/invites/:inviteId/accept`
3. PAT flow:
   - `POST /api/me/api-tokens`
   - `GET /api/me` using `x-api-token` or `Authorization: Bearer <pat>`
   - `DELETE /api/me/api-tokens/:tokenId`
4. Run flow:
   - `GET /api/board?repoId=all`
   - `POST /api/repos`
   - `POST /api/tasks`
   - `POST /api/tasks/:taskId/run`
   - `GET /api/runs/:runId`
   - `GET /api/runs/:runId/events`
   - `GET /api/runs/:runId/logs?tail=120`
   - `GET /api/runs/:runId/artifacts`

## 8) Verification checklist (Task ST-6)

- [x] Worker tests cover login/session flow.
- [x] Worker tests cover owner invite create/list and invite acceptance account creation.
- [x] Worker tests cover PAT create/list/auth/revoke paths.
- [x] Docs reference single-tenant APIs (`/api/invites*`, `/api/me/api-tokens*`) and remove `/api/tenants*`, `/api/platform/*`, `/api/me/tenant-context`.
- [x] Secret model documents Worker secrets as runtime credential source.

### Verification execution log (2026-03-03)

- [x] `npm install`
- [x] `npm run build`
- [x] `npm run test:workers -- tests/worker/stage-4-5-tenant-authz.test.ts tests/worker/stage-4-5-memberships.test.ts`
- [ ] `npm run test:workers` (fails in legacy suites `stage-3-5-scm-dogfood` and `stage-3-5-llm-dogfood` with `401` on `POST /api/repos`; these tests still assume pre-session legacy access and are outside ST-6 scope.)

## 9) Cloudflare references

- Workers secrets: <https://developers.cloudflare.com/workers/configuration/secrets/>
- Workers bindings: <https://developers.cloudflare.com/workers/configuration/bindings/>
- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
