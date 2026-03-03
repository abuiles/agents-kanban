# Single-Tenant Auth API Guide

This guide documents the current single-tenant auth contract.

## Contract Summary

- One deployment == one tenant (`tenant_local` by default).
- No tenant switching and no platform support mode.
- User auth supports session tokens and personal API tokens (PATs).
- Invite acceptance creates a new user account and an active membership.
- Runtime SCM/LLM credentials come from Cloudflare secrets at Worker runtime.
- Auth data is stored in D1 (`TENANT_DB`): `app_tenant_config`, `users`, `user_sessions`, `invites`, `user_api_tokens`.

## Core Entities

- `User`: authenticated operator identity.
- `UserSession`: login session token.
- `Invite`: owner-created pending invite for an email.
- `UserApiToken`: personal token hashed at rest; plain token is shown once at creation.

## Auth Endpoints

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`

### Signup

`POST /api/auth/signup`

```json
{
  "email": "owner@example.com",
  "password": "secret-pass",
  "displayName": "Owner",
  "tenantName": "Local Tenant"
}
```

Notes:

- First created user becomes `owner`; subsequent users default to `member`.
- `tenantName` is accepted for compatibility, but tenant creation is not multi-tenant.

### Login

`POST /api/auth/login`

```json
{
  "email": "owner@example.com",
  "password": "secret-pass"
}
```

Optional:

- `tenantId` may be provided, but only the deployment tenant is allowed.

### Logout

`POST /api/auth/logout`

- Requires a valid session token.
- Clears `minions_session` cookie.

## Invite Endpoints (Owner-only creation/list)

- `GET /api/invites`
- `POST /api/invites`
- `POST /api/invites/:inviteId/accept`

### Create invite

```json
{
  "email": "new-user@example.com",
  "role": "member"
}
```

### Accept invite

`POST /api/invites/:inviteId/accept`

```json
{
  "token": "<invite token>",
  "password": "new-password",
  "displayName": "New User"
}
```

Behavior:

- Invite token must match `:inviteId`.
- Accept creates user account and login session.
- Invite status transitions from `pending` to `accepted`.

## Personal API Tokens

- `GET /api/me/api-tokens`
- `POST /api/me/api-tokens`
- `DELETE /api/me/api-tokens/:tokenId`

Create payload:

```json
{
  "name": "Automation Token",
  "scopes": ["repos:read", "runs:write"],
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

Notes:

- `token` is returned only on creation.
- Stored token values are hashed.
- Revoked or expired tokens are rejected.

## Auth Token Resolution Order

Protected endpoints resolve auth in this order:

1. `x-session-token`
2. `x-api-token`
3. `Authorization: Bearer <token>`
   - tries session token first
   - falls back to PAT resolution
4. `minions_session` cookie (session)

## Protected Resource APIs

These require authenticated access (session or PAT where supported by auth resolution):

- Board/repo/task/run APIs under `/api/board`, `/api/repos`, `/api/tasks`, `/api/runs`
- Usage endpoints: `/api/tenant-usage`, `/api/tenant-usage/runs`, `/api/runs/:runId/usage`

## Removed APIs (Not Available)

- `/api/tenants*`
- `POST /api/me/tenant-context`
- `/api/platform/*`

## Error Semantics

- `401 Unauthorized`
  - Missing/invalid session or PAT
  - Expired invite/token/session
- `403 Forbidden`
  - Non-owner on owner-only operations
  - Tenant mismatch in single-tenant mode
- `404 Not Found`
  - Unknown resource id
- `409 Conflict`
  - Duplicate user/invite or similar state conflict
