# Local Testing Guide

This playbook captures the local setup needed to run a real end-to-end Stage 3+ flow from your workstation.

## 1) What this validates

Use this flow to verify:

- board/task/run APIs work end-to-end
- run bootstraps into a sandbox
- code changes are committed and pushed
- review/preview/evidence lifecycle is tracked
- attach paths are available (`/api/runs/:runId/terminal`, `/api/runs/:runId/ws`)

## 2) Required accounts and keys

### SCM credentials

The runtime resolves credentials in this order:

1. Provider credential registry (`/api/scm/credentials`) keyed by provider + host
2. (GitHub only) legacy fallback in KV key `github_pat`

Set this for local examples:

```bash
BASE="http://localhost:5173/api"
```

### GitHub keys

- Store per-host token in repository credential registry:

```bash
curl -X POST "$BASE/api/scm/credentials" \
  -H "content-type: application/json" \
  -d '{
    "scmProvider": "github",
    "host": "github.com",
    "label": "GitHub PAT",
    "token": "ghp_..."
  }'
```

- Legacy fallback (still supported): `github_pat` in `SECRETS_KV`

```bash
npx wrangler kv key put github_pat "ghp_..." --binding SECRETS_KV --remote
```

- Self-hosted GitHub Enterprise

```bash
{
  "scmProvider": "github",
  "host": "github.example.com",
  "label": "GitHub Enterprise",
  "token": "ghp_..."
}
```

### GitLab keys

GitLab tokens must be registered in the credential registry (no legacy KV fallback):

- Hosted GitLab

```bash
curl -X POST "$BASE/api/scm/credentials" \
  -H "content-type: application/json" \
  -d '{
    "scmProvider": "gitlab",
    "host": "gitlab.com",
    "label": "GitLab Token",
    "token": "glpat_..."
  }'
```

- Self-managed GitLab

```bash
{
  "scmProvider": "gitlab",
  "host": "gitlab.example.internal",
  "label": "Self-hosted GitLab",
  "token": "glpat_..."
}
```

### Verify registered credentials

```bash
curl "$BASE/api/scm/credentials"
```

Expected output includes `hasSecret: true` per host/provider row.

## 3) Required infrastructure bindings

These are mandatory for non-mocked runs:

- KV: `SECRETS_KV`
- R2 bucket: `RUN_ARTIFACTS` (artifacts + optional Codex auth bundle)
- Workflow: `RUN_WORKFLOW`
- Durable Objects: `BOARD_INDEX`, `REPO_BOARD`, `Sandbox`

If bindings changed, run:

```bash
npx wrangler types
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

Set `codexAuthBundleR2Key` on the repo to:

```text
auth/codex-auth.tgz
```

Use `POST /api/repos` or `PATCH /api/repos/:repoId` to set/override this field.

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

## 7) Operator attach smoke test

1. `GET /api/runs/:runId/terminal`
2. Open websocket to `/api/runs/:runId/ws` after upgrade handshake
3. Confirm attach and takeover:
   - `POST /api/runs/:runId/takeover`

## 8) Troubleshooting matrix

- Missing run start
  - Ensure repo has enabled credentials for `repo.scmProvider` + `repo.scmBaseUrl` host
  - For GitHub, confirm one of:
    - matching `/api/scm/credentials` row
    - KV `github_pat`
- Missing auth for Codex
  - Ensure R2 contains `auth/codex-auth.tgz`
  - Ensure repo `codexAuthBundleR2Key` is exactly that path
- No preview URL
  - Confirm preview mode and preview check config are correct
- Evidence never finishes
  - Verify Playwright install can access the baseline and preview URL from sandbox

## 9) Provider key reference (quick)

| Provider | Runtime host key | Runtime credential path | Key format |
| --- | --- | --- | --- |
| GitHub | `host` from repo URL (e.g., `github.com`) | Registry + optional KV fallback | `POST /api/scm/credentials`, `npx wrangler kv key put github_pat` |
| GitLab | `host` from repo URL (e.g., `gitlab.com` or self-hosted host) | Registry only | `POST /api/scm/credentials` |

## 10) Sync with docs

Keep this guide aligned with:

- [docs/stage_3.md](stage_3.md)
- [docs/stage_3_5.md](stage_3_5.md)
- [docs/stage_4.md](stage_4.md)
- [docs/sandbox-capacity-and-scheduling.md](sandbox-capacity-and-scheduling.md)

## 11) Parallel run sanity check

Use this check before enabling wide concurrency:

- Start two or more runs against different tasks quickly.
- Verify overlapping `runId` values and no accidental `evidenceSandboxId` reuse.
- Confirm run logs show expected start/completion entries for each run.
