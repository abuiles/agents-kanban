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
  - selective request-changes with merged provider-reply context (webhook + on-demand for GitHub)
  - manual review rerun keeps execution metadata updated
- Stage 7 native sentinel behavior:
  - start/pause/resume/stop control actions
  - serial task progression within sentinel scope
  - review gate wait/merge/remediation events are operator-actionable
  - no sentinel side effects when `sentinelConfig.enabled = false`

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

Set GitHub webhook verification secret in KV when validating GitHub reply-context ingestion:

```bash
npx wrangler kv key put --binding SECRETS_KV github/webhook-secret "<shared-webhook-secret>"
```

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

Tunnel behavior for `npm run dev` / `yarn dev`:

- default (automatic):
  - if `AK_DEV_PUBLIC_URL` is set, uses `external` mode
  - else if `cloudflared` is installed, starts `auto` quick tunnel
  - else falls back to `off` (local only)

- default (no tunnel):
  - `AK_DEV_TUNNEL=off`
- auto-start Cloudflare quick tunnel:
  - `AK_DEV_TUNNEL=auto`
- bring your own tunnel/public URL:
  - `AK_DEV_TUNNEL=external`
  - `AK_DEV_PUBLIC_URL=https://<your-public-host>`

Examples:

```bash
# no tunnel
AK_DEV_TUNNEL=off yarn dev

# auto Cloudflare tunnel (prints trycloudflare URL in logs)
AK_DEV_TUNNEL=auto yarn dev

# external tunnel URL (ngrok/cloudflared named tunnel/deployed host)
AK_DEV_TUNNEL=external AK_DEV_PUBLIC_URL=https://my-host.example.com yarn dev
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
   - for GitHub dogfood:
     - ensure webhook target is configured: `POST /api/integrations/github/webhook`
     - reply to a marker-bearing PR finding comment
     - confirm webhook delivery status is `accepted`
     - rerun `POST /api/runs/:runId/request-changes` with `includeReplies=true` and verify merged reply context in prompt
   - `POST /api/runs/:runId/review` to execute manual review-only rerun
6.6 Validate native sentinel orchestration
   - `PATCH /api/repos/:repoId/sentinel/config` with `{ "enabled": true }` plus desired scope/gate/policy
   - `POST /api/repos/:repoId/sentinel/start`
   - `GET /api/repos/:repoId/sentinel` and verify:
     - `run.status`, `run.currentTaskId`, `run.attemptCount`
     - `diagnostics.latestErrorEvent` / `diagnostics.latestWarningEvent`
     - event timeline includes `task.activated`, `run.started`, and merge/gate/remediation events
   - `POST /api/repos/:repoId/sentinel/pause`, `resume`, and `stop`
   - `GET /api/repos/:repoId/sentinel/events?limit=50` for operator timeline review
6.7 Validate checkpoint lifecycle and recovery fallback
   - Ensure repo checkpoint config is enabled (default):
     - `checkpointConfig.enabled = true`
     - `checkpointConfig.triggerMode = "phase_boundary"`
   - Run one full task and confirm checkpoints exist:
     - `GET /api/runs/:runId/checkpoints`
   - Confirm task-level latest checkpoint read:
     - `GET /api/tasks/:taskId/checkpoints?latest=true`
   - Verify retry defaults to latest checkpoint:
     - `POST /api/runs/:runId/retry` (no request body)
   - Verify explicit fallback path:
     - `POST /api/runs/:runId/retry` with `{ "recoveryMode": "latest_checkpoint", "checkpointId": "missing-id" }`
     - confirm run timeline includes `reason=checkpoint_not_found` fallback note
   - Verify disable behavior is no-op/safe:
     - `PATCH /api/repos/:repoId` with `{ "checkpointConfig": { "enabled": false } }`
     - run again and confirm `GET /api/runs/:runId/checkpoints` returns an empty list

## 7) Operator attach smoke test

1. `GET /api/runs/:runId/terminal`
2. Open websocket to `/api/runs/:runId/ws` after upgrade handshake
3. Confirm attach and takeover:
   - `POST /api/runs/:runId/takeover`

## 8) Slack -> Jira -> GitLab MVP local loop

Use this when validating day-to-day operator flow without dashboard actions.

1. Configure Slack and GitLab webhook secrets in Worker secrets KV:
   - `slack/signing-secret`
   - `gitlab/webhook-secret`
2. Configure Jira project -> repo mapping for the tenant.
3. Trigger slash command:
   - `/kanvy fix ABC-123`
   - `/kanvy help`
4. Confirm slash command ack is immediate and async processing posts one of:
   - run start confirmation
   - repo disambiguation buttons
   - failure message (for example Jira read failure)
   - usage instructions with examples for Jira fast-path and free-text flow (for `/kanvy help`)
5. Confirm run thread binding stores:
   - `taskId`, `channelId`, `threadTs`, `currentRunId`, `latestReviewRound`
6. Simulate or receive GitLab webhook events:
   - MR open/update -> `REVIEW_PENDING`
   - MR note feedback -> `DECISION_REQUIRED`
7. Click `Approve rerun` in the same Slack thread.
8. Confirm exactly one rerun is queued and thread binding updates to the new `currentRunId`.

Ingress/idempotency checks to verify in local logs:

- Slack signature + replay protection rejects forged/replayed requests.
- Duplicate slash command deliveries are ignored for the same command response envelope.
- Duplicate interaction deliveries are ignored to prevent duplicate task/run starts.
- GitLab duplicate deliveries are ignored.

## 9) Slack/GitLab failure-path checks

- Jira timeout/failure:
  - slash command still acks quickly
  - response URL receives explicit failure text
  - no task/run is created
- Slack post failure:
  - run and state transitions continue
  - Slack mirror posting remains best-effort (does not fail webhook processing)
- GitLab malformed webhook body:
  - returns `400 BAD_REQUEST`
  - no run state transition occurs

## 10) Troubleshooting matrix

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
- Sentinel does not start
  - Confirm `repo.sentinelConfig.enabled = true` (start/resume are rejected when disabled)
  - Confirm SCM token exists (`GITHUB_TOKEN` or `GITLAB_TOKEN`) for merge/review state checks
- Sentinel appears stuck
  - Check `GET /api/repos/:repoId/sentinel` diagnostics (`latestErrorEvent`, `latestWarningEvent`)
  - Check event metadata fields (`reason`, `reviewGate*`, `attempt`, `attemptCount`, `taskId`, `runId`)
  - Validate conflict policy limits (`conflictPolicy.maxAttempts`) and whether sentinel is paused on exhaustion

## 11) Provider key reference (quick)

| Provider | Runtime host key | Runtime credential path | Key format |
| --- | --- | --- | --- |
| GitHub | `host` from repo URL (e.g., `github.com`) | Worker secret | `GITHUB_TOKEN` |
| GitLab | `host` from repo URL (e.g., `gitlab.com` or self-hosted host) | Worker secret | `GITLAB_TOKEN` |
| Jira | `host` from issue URL (e.g., `jira.example.com`) | Worker secret | `JIRA_TOKEN` |

## 12) Sync with docs

Keep this guide aligned with:

- [docs/plans/current/README.md](plans/current/README.md)
- [docs/plans/archive/stage_3.md](plans/archive/stage_3.md)
- [docs/plans/archive/stage_3_5.md](plans/archive/stage_3_5.md)
- [docs/plans/archive/stage_4.md](plans/archive/stage_4.md)
- [docs/sandbox-capacity-and-scheduling.md](sandbox-capacity-and-scheduling.md)
- [docs/integrations/slack-jira-gitlab-mvp.md](integrations/slack-jira-gitlab-mvp.md)
- [docs/integrations/sentinel-orchestration.md](integrations/sentinel-orchestration.md)
- [docs/integrations/checkpoint-recovery.md](integrations/checkpoint-recovery.md)

## 13) Script-to-native sentinel migration

Use this sequence to migrate from script automation to native APIs/UI:

1. Disable external loops:
   - stop `scripts/autopilot.sh`
   - stop `scripts/p5-sentinel.sh`
2. Enable native sentinel config on one pilot repo:
   - `PATCH /api/repos/:repoId/sentinel/config` with `"enabled": true`
3. Start in narrow scope first:
   - group scope (`scopeType = "group"`, `scopeValue = <tag>`)
4. Observe for one full lifecycle:
   - activation -> run -> review gate -> merge/remediation -> done
5. Expand to global scope only after stable event timelines and expected remediation behavior.

Fallback:

- Immediate stop: `POST /api/repos/:repoId/sentinel/stop`
- Disable native sentinel: `PATCH /api/repos/:repoId/sentinel/config` with `"enabled": false`
- Resume manual run/task operation (`POST /api/tasks/:taskId/run`) while sentinel remains disabled

## 14) Parallel run sanity check

Use this check before enabling wide concurrency:

- Start two or more runs against different tasks quickly.
- Verify overlapping `runId` values and no accidental `evidenceSandboxId` reuse.
- Confirm run logs show expected start/completion entries for each run.
