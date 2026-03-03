# Single-Tenant Auth & Access API Guide

This guide documents the current single-tenant auth contract for API consumers.

## Overview

- Each deployment has exactly one tenant (`tenant_local` by default).
- Users authenticate with email/password sessions.
- Owners manage invites.
- Invite acceptance creates a user account and logs the user in.
- Users can create personal API tokens (PATs) for automation.
- Runtime provider credentials come from Worker secrets, not tenant/platform APIs.

## Authentication

### Endpoints

- `POST /api/auth/signup` (bootstrap/owner setup)
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`

### Session and token resolution

Protected APIs resolve auth in this order:

1. Session token from `x-session-token` header
2. Session token from `minions_session` cookie
3. API token from `x-api-token` header
4. `Authorization: Bearer <token>`
   - resolved as session token first
   - falls back to PAT if not a valid session token

### Session cookie

- Name: `minions_session`
- Set on signup/login
- Cleared on logout

## Roles

- `owner`: can create/list invites.
- `member`: standard authenticated access.

All authenticated users map to the singleton tenant membership with an active seat.

## Invite Management

### Endpoints

- `POST /api/invites` (owner only)
- `GET /api/invites` (owner only)
- `POST /api/invites/:inviteId/accept`

### Invite accept payload

```json
{
  "token": "one-time-invite-token",
  "password": "new-user-password",
  "displayName": "Optional Name"
}
```

Notes:

- Invite token must match the `:inviteId` in the URL.
- Invite acceptance creates the user account and returns an authenticated session token.

## Personal API Tokens (PAT)

### Endpoints

- `POST /api/me/api-tokens`
- `GET /api/me/api-tokens`
- `DELETE /api/me/api-tokens/:tokenId`

PAT lifecycle behavior:

- token secret is only returned at creation time
- list returns metadata only
- revoked PATs immediately stop authenticating

## Protected Board/Repo/Task/Run APIs

These APIs require valid auth (session or PAT):

- `GET /api/board`
- `GET /api/board/ws`
- `GET /api/repos`
- `POST /api/repos`
- `PATCH /api/repos/:repoId`
- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`
- `DELETE /api/tasks/:taskId`
- `POST /api/tasks/:taskId/run`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/retry`
- `POST /api/runs/:runId/preview`
- `POST /api/runs/:runId/evidence`
- `POST /api/runs/:runId/request-changes`
- `POST /api/runs/:runId/cancel`
- `GET /api/runs/:runId/logs`
- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/commands`
- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/ws`
- `GET /api/runs/:runId/artifacts`
- `POST /api/runs/:runId/takeover`

## Removed APIs (single-tenant cutover)

- `/api/tenants*`
- `POST /api/me/tenant-context`
- `/api/platform/*`

## Runtime Secret Model

Runtime provider and LLM credentials are configured only as Worker secrets:

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `OPENAI_API_KEY`
- optional `CODEX_AUTH_BUNDLE_R2_KEY`

No runtime DB/KV secret-management API is exposed for SCM/OpenAI credentials.

## Common Error Semantics

- `401 Unauthorized`
  - Missing/invalid/expired session or PAT
- `403 Forbidden`
  - Owner-only action requested by non-owner user
- `404 Not Found`
  - Unknown route/resource
- `409 Conflict`
  - Duplicate user/invite or business-rule conflict
