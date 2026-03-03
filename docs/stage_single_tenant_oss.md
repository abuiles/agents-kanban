# Stage: Single-Tenant OSS Simplification

**Status:** Planned

## Goal

Simplify the project from multi-tenant SaaS to single-tenant OSS deployment:

- one tenant per deployment (no tenant switching, no platform support mode)
- email/password auth for users
- owner-managed invites
- invite acceptance creates account + password
- user-generated personal API tokens for API automation
- runtime credentials from Cloudflare Worker secrets
- `.codex` auth remains an R2 bundle reference

This stage is intentionally **breaking** and **non-backward-compatible**.

## Product Decisions (Locked)

1. Single-tenant is strict (`hard single-tenant`).
2. Auth baseline is email/password.
3. Invite acceptance creates accounts directly.
4. API tokens are personal tokens with scopes.
5. Runtime secrets are global Cloudflare Worker secrets only.
6. `.codex` auth bundle remains upload-based in R2.

## Public API Contract (Target)

### Keep

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- existing board/repo/task/run read-write APIs (protected by auth)

### Add

- `POST /api/invites` (owner only)
- `GET /api/invites` (owner only)
- `POST /api/invites/:inviteId/accept` with `{ token, password, displayName? }`
- `POST /api/me/api-tokens`
- `GET /api/me/api-tokens`
- `DELETE /api/me/api-tokens/:tokenId`

### Remove

- `/api/tenants*`
- `POST /api/me/tenant-context`
- `/api/platform/*`
- SCM credential registry write/read APIs for runtime secret management

## Secret Model (Target)

Runtime credential source is only Worker secrets:

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `OPENAI_API_KEY`
- optional `CODEX_AUTH_BUNDLE_R2_KEY` (or equivalent env var)

No DB/KV API path for runtime SCM/OpenAI secrets.

`.codex` auth remains R2-uploaded (`auth/codex-auth.tgz` style key), globally configured.

## Data Model (Target)

Replace current tenant/platform schema with single-tenant auth schema:

- `app_tenant_config` (singleton tenant metadata)
- `users` (includes role: `owner` or `member`)
- `user_sessions`
- `invites`
- `user_api_tokens` (hashed at rest, one-time reveal)
- optional `security_audit_log`

Remove:

- `tenants`
- `tenant_memberships`
- `platform_admins`
- `platform_support_sessions`

## 6-Task Execution Plan

### Task 1: Schema Reset + Auth Store Refactor

**Scope**

- Replace `migrations/0000_tenant_auth_schema.sql` with single-tenant schema.
- Refactor `src/server/tenant-auth-db.ts` to remove tenant membership/platform support flows.
- Implement user role model (`owner`/`member`), invite persistence, API token persistence.

**Deliverables**

- new schema migration file(s)
- updated auth data access layer
- removed platform/tenant table assumptions

**Dependencies**

- None (foundational task)

### Task 2: API/Routing Cutover to Single Tenant

**Scope**

- Update `src/server/api.ts` and `src/server/router.ts`.
- Remove tenant-context and platform support endpoints.
- Add invite and personal API token endpoints.
- Update auth resolution to allow PAT and session tokens.

**Deliverables**

- final single-tenant route map
- owner/member authorization checks
- invite accept creates account flow

**Dependencies**

- Depends on **Task 1**

### Task 3: Runtime Credential Simplification (Cloudflare Secrets)

**Scope**

- Remove runtime reliance on credential registry/KV for SCM/OpenAI.
- Read SCM/OpenAI credentials directly from Worker secrets (`env`).
- Move Codex bundle key resolution to global config, not per repo.

**Deliverables**

- orchestrator/scm credential resolution uses `env` secrets only
- no runtime DB/KV secret writes for provider credentials

**Dependencies**

- Depends on **Task 2** (auth middleware and request model changes should be stable first)

### Task 4: Bootstrap Script + Operational Setup

**Scope**

- Add `scripts/bootstrap-single-tenant.ts` (JSON-input, idempotent).
- Seed singleton tenant config + initial owners.
- Document `wrangler secret put` workflow for required runtime secrets.

**Deliverables**

- bootstrap script and npm script entry
- sample bootstrap JSON format
- operator instructions

**Dependencies**

- Depends on **Task 1**

### Task 5: UI Adaptation

**Scope**

- Update auth UI to remove tenant-selection/signup-tenant behavior.
- Add invite management UI (owner only).
- Add personal API token management UI (create/list/revoke).

**Deliverables**

- updated UI auth/session flow
- invite screens/components
- API token screens/components

**Dependencies**

- Depends on **Task 2**

### Task 6: Tests + Docs + Rollout Verification

**Scope**

- Replace stage 4.5/4.6 multi-tenant tests with single-tenant auth/invite/PAT tests.
- Update docs:
  - `docs/tenant-auth-api.md`
  - `docs/features-and-api.md`
  - `docs/local-testing.md`
  - `docs/roadmap.md`
  - `docs/stage_4_6.md` (or mark superseded and reference this doc)
- Verify local flow end-to-end.

**Deliverables**

- passing worker/unit tests for new auth model
- docs aligned with new public API and secret model
- concise verification checklist
- captured verification record: `docs/single-tenant-rollout-verification.md`

**Dependencies**

- Depends on **Task 3**, **Task 4**, and **Task 5**

## Dependency Graph (Summary)

- **Task 1** -> **Task 2**
- **Task 1** -> **Task 4**
- **Task 2** -> **Task 3**
- **Task 2** -> **Task 5**
- **Task 3**, **Task 4**, **Task 5** -> **Task 6**

## Acceptance Criteria

1. No tenant-switching or platform support endpoints remain.
2. Auth works with sessions and personal API tokens.
3. Invite acceptance can create user accounts.
4. Runtime SCM/OpenAI creds come from Cloudflare secrets only.
5. `.codex` auth bundle is globally configured and usable in runs.
6. Docs and tests match the new single-tenant contract.
