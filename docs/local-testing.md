# Local Testing Guide

This playbook captures the local setup needed to run a real end-to-end Stage 3+ flow from your workstation.

## 1) What this validates

Use this flow to verify:

- board/task/run APIs work end-to-end
- run bootstraps into a sandbox
- code changes are committed and pushed
- review/preview/evidence lifecycle is tracked
- attach paths are available (`/api/runs/:runId/terminal`, `/api/runs/:runId/ws`)
- Stage 6 auto-review/change-loop behavior:
  - run reaches review state
  - review auto-posting executes and writes review artifacts
  - selective request-changes with provider-reply context
  - manual review rerun keeps execution metadata updated

## 2) Required accounts and keys

### SCM credentials

The runtime resolves SCM and OpenAI credentials from Worker secrets only:

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `JIRA_TOKEN` (required for Jira review posting)
- `OPENAI_API_KEY`
- Optional platform support-admin bootstrap via worker env:
  - `PLATFORM_ADMIN_EMAIL`
  - `PLATFORM_ADMIN_PASSWORD`

Set this for local examples:

```bash
BASE="http://localhost:5173/api"
```

### Configure runtime secrets

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITLAB_TOKEN
npx wrangler secret put JIRA_TOKEN
npx wrangler secret put OPENAI_API_KEY
```

Set only the providers you use (`GITHUB_TOKEN` for GitHub repos, `GITLAB_TOKEN` for GitLab repos, `JIRA_TOKEN` when review provider is Jira).

## 3) Required infrastructure bindings

These are mandatory for non-mocked runs:

- R2 bucket: `RUN_ARTIFACTS` (artifacts + optional Codex auth bundle)
- D1: `TENANT_DB` (tenant/auth/admin persistence)
- Workflow: `RUN_WORKFLOW`
- Durable Objects: `BOARD_INDEX`, `REPO_BOARD`, `Sandbox`

If bindings changed, run:

```bash
npx wrangler types
```

## 3.5) D1 migrations (required)

Tenant/auth/admin tables are versioned in [`migrations/`](../migrations).

Create a new migration:

```bash
npx wrangler d1 migrations create TENANT_DB <message>
```

List pending migrations:

```bash
npx wrangler d1 migrations list TENANT_DB --local
```

Apply locally (for local dev DB):

```bash
npx wrangler d1 migrations apply TENANT_DB --local
```

Bootstrap single-tenant config + owner users from JSON (idempotent upsert):

```bash
npm run bootstrap:single-tenant -- --input ./scripts/bootstrap-single-tenant.example.json --local
```

Dry-run SQL generation:

```bash
npm run bootstrap:single-tenant -- --input ./scripts/bootstrap-single-tenant.example.json --dry-run
```

Apply remotely (for deployed DB):

```bash
npx wrangler d1 migrations apply TENANT_DB --remote
```

## 4) `.codex` auth bundle (for Codex execution)

From Stage 3 notes: upload only auth files, not the full home directory.

```bash
tmp_dir="$(mktemp -d)"
mkdir -p "$tmp_dir/.codex"
cp "$HOME/.codex/auth.json" "$tmp_dir/.codex/auth.json"
cp "$HOME/.codex/config.toml" "$tmp_dir/.codex/config.toml"
tar -czf codex-auth.tgz -C "$tmp_dir" .codex
npx wrangler r2 object put my-sandbox-run-artifacts/auth/codex-auth.tgz --file ./codex-auth.tgz --remote
rm -rf "$tmp_dir"
```

Set the global Worker secret `CODEX_AUTH_BUNDLE_R2_KEY` to:

```text
auth/codex-auth.tgz
```

```bash
npx wrangler secret put CODEX_AUTH_BUNDLE_R2_KEY
```

## 4.5) Container capacity and concurrency checks

- Confirm sandbox capacity in `wrangler.jsonc`:
  - `containers[0].max_instances` should be `20`
  - `containers[0].instance_type` should be `lite` unless changed intentionally
- Confirm `RUN_WORKFLOW` exists; workflow mode is required for production-style concurrent execution.

## 5) Local dev commands

Run from the repo root:

```bash
npm install
npm run build
npm run dev
```

Base URL example:

```text
http://localhost:5173/api
```

You can continue to use `npx wrangler dev` for Worker-only execution on the legacy port in this environment if needed, but this document defaults to the Vite/Workers bridge port `5173` for API and UI.

## 6) Minimal end-to-end local test

0. Seed a local org and operator context (Stage 4.5):

   - `POST /api/auth/signup` with email/password + tenant name/slug
   - `POST /api/auth/login` and capture session token/cookie
   - `GET /api/me` to confirm active user + tenant context
   - `POST /api/me/tenant-context` to set active tenant if multiple memberships exist
   - Confirm the response contains no `tenant_legacy` fallback tenant and requires an explicit tenant selection.
   - `GET /api/tenants` to verify tenant visibility

0.5 Optional support-admin smoke test (Stage 4.6):

   - `POST /api/platform/auth/login`
   - `POST /api/platform/support/assume-tenant` with `tenantId` and a `reason`
   - Re-run a tenant-scoped endpoint using `x-support-session-token`
   - `POST /api/platform/support/release-tenant`
   - `GET /api/platform/audit-log` to verify audit entries

1. Create/get board and repo
   - `GET /api/board?repoId=all`
   - `POST /api/repos`
2. Create a task
   - `POST /api/tasks`
3. Start a run
   - `POST /api/tasks/:taskId/run`
4. Track run and events
   - `GET /api/runs/:runId`
   - `GET /api/runs/:runId/events`
   - `GET /api/runs/:runId/logs?tail=120`
5. Check artifacts/review links
   - `GET /api/runs/:runId/artifacts`
6. Test retry paths
   - `POST /api/runs/:runId/retry`
   - `POST /api/runs/:runId/preview`
   - `POST /api/runs/:runId/evidence`
6.5. Validate auto-review and selective follow-up loop
   - `GET /api/runs/:runId` (verify `reviewExecution` fields and round count)
   - `GET /api/runs/:runId/artifacts` (verify `reviewFindingsJson` and `reviewMarkdown` review pointers)
   - `POST /api/runs/:runId/request-changes` with `reviewSelection` payload
   - `POST /api/runs/:runId/review` to execute manual review-only rerun

## 7) Operator attach smoke test

1. `GET /api/runs/:runId/terminal`
2. Open websocket to `/api/runs/:runId/ws` after upgrade handshake
3. Confirm attach and takeover:
   - `POST /api/runs/:runId/takeover`

## 8) Troubleshooting matrix

- Missing run start
  - Ensure Worker secrets are configured for `repo.scmProvider`:
    - GitHub repos require `GITHUB_TOKEN`
    - GitLab repos require `GITLAB_TOKEN`
- Missing auth for Codex
  - Ensure R2 contains `auth/codex-auth.tgz`
  - Ensure Worker secret `CODEX_AUTH_BUNDLE_R2_KEY` points to that object key
- No preview URL
  - Confirm preview mode and preview check config are correct
- Evidence never finishes
  - Verify Playwright install can access the baseline and preview URL from sandbox

## 9) Provider key reference (quick)

| Provider | Runtime host key | Runtime credential path | Key format |
| --- | --- | --- | --- |
| GitHub | `host` from repo URL (e.g., `github.com`) | Worker secret | `GITHUB_TOKEN` |
| GitLab | `host` from repo URL (e.g., `gitlab.com` or self-hosted host) | Worker secret | `GITLAB_TOKEN` |
| Jira | `host` from issue URL (e.g., `jira.example.com`) | Worker secret | `JIRA_TOKEN` |

## 10) Sync with docs

Keep this guide aligned with:

- [docs/plans/current/README.md](plans/current/README.md)
- [docs/plans/archive/stage_3.md](plans/archive/stage_3.md)
- [docs/plans/archive/stage_3_5.md](plans/archive/stage_3_5.md)
- [docs/plans/archive/stage_4.md](plans/archive/stage_4.md)
- [docs/sandbox-capacity-and-scheduling.md](sandbox-capacity-and-scheduling.md)

## 11) Parallel run sanity check

Use this check before enabling wide concurrency:

- Start two or more runs against different tasks quickly.
- Verify overlapping `runId` values and no accidental `evidenceSandboxId` reuse.
- Confirm run logs show expected start/completion entries for each run.
