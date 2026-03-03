# Local Testing Guide (Single-Tenant)

This playbook validates single-tenant auth plus board/task/run flow on local Workers runtime.

## 1) What this validates

- login/logout/session auth path
- owner invite management + invite acceptance
- personal API token auth path
- board/task/run end-to-end execution
- artifact and attach APIs

## 2) Runtime secrets

Runtime credentials are sourced from Worker secrets only:

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `OPENAI_API_KEY`
- optional `CODEX_AUTH_BUNDLE_R2_KEY`

Set production/preview secrets:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITLAB_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CODEX_AUTH_BUNDLE_R2_KEY
```

Local secret files are supported via `.dev.vars` or `.env` (choose one, not both).

Recommended `.gitignore` entries:

```gitignore
.dev.vars*
.env*
```

## 3) Required bindings

- R2 bucket: `RUN_ARTIFACTS`
- D1: `TENANT_DB`
- Workflow: `RUN_WORKFLOW`
- Durable Objects: `BOARD_INDEX`, `REPO_BOARD`, `Sandbox`

If bindings changed, regenerate types:

```bash
npx wrangler types
```

## 4) D1 migrations

Tenant/auth tables are in [`migrations/`](../migrations).

```bash
npx wrangler d1 migrations list TENANT_DB --local
npx wrangler d1 migrations apply TENANT_DB --local
```

Remote apply:

```bash
npx wrangler d1 migrations apply TENANT_DB --remote
```

## 5) `.codex` auth bundle (optional)

```bash
tmp_dir="$(mktemp -d)"
mkdir -p "$tmp_dir/.codex"
cp "$HOME/.codex/auth.json" "$tmp_dir/.codex/auth.json"
cp "$HOME/.codex/config.toml" "$tmp_dir/.codex/config.toml"
tar -czf codex-auth.tgz -C "$tmp_dir" .codex
npx wrangler r2 object put my-sandbox-run-artifacts/auth/codex-auth.tgz --file ./codex-auth.tgz --remote
rm -rf "$tmp_dir"
```

Set `CODEX_AUTH_BUNDLE_R2_KEY=auth/codex-auth.tgz`.

## 6) Local dev commands

```bash
npm install
npm run build
npm run dev
```

Base API URL:

```text
http://localhost:5173/api
```

## 7) Minimal auth + invite + PAT verification

1. Bootstrap first owner:
- `POST /api/auth/signup`

2. Session login check:
- `POST /api/auth/logout`
- `POST /api/auth/login`
- `GET /api/me`

3. Owner invite flow:
- `POST /api/invites`
- `GET /api/invites`
- `POST /api/invites/:inviteId/accept`

4. PAT flow:
- `POST /api/me/api-tokens`
- `GET /api/me/api-tokens`
- `GET /api/me` with `x-api-token` or `Authorization: Bearer <pat>`
- `DELETE /api/me/api-tokens/:tokenId`

5. Removed-route check:
- verify `/api/tenants*`, `POST /api/me/tenant-context`, and `/api/platform/*` return not found.

## 8) Board/task/run smoke

1. `GET /api/board?repoId=all`
2. `POST /api/repos`
3. `POST /api/tasks`
4. `POST /api/tasks/:taskId/run`
5. `GET /api/runs/:runId`
6. `GET /api/runs/:runId/events`
7. `GET /api/runs/:runId/logs?tail=120`
8. `GET /api/runs/:runId/artifacts`
9. `GET /api/runs/:runId/terminal`
10. `GET /api/runs/:runId/ws`

## 9) Troubleshooting

- `401` on protected routes: verify session/PAT token headers and token freshness.
- Run startup failures: verify provider secret (`GITHUB_TOKEN` or `GITLAB_TOKEN`) for the repo provider.
- Missing Codex auth in sandbox: verify R2 object exists and `CODEX_AUTH_BUNDLE_R2_KEY` matches.
