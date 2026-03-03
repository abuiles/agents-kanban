# Single-Tenant Auth API Guide

This guide describes the current single-tenant auth contract.

## Overview

- One deployment maps to one tenant (`app_tenant_config` singleton in D1).
- All authenticated users belong to that tenant.
- User role is `owner` or `member`.
- Protected APIs accept either session auth or personal API tokens (PATs).
- Platform-admin/support auth flows are removed.

## Authentication Endpoints

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`

`POST /api/auth/signup` is used for initial owner/member account creation in local/self-hosted setups and by invite acceptance.

## Invite Endpoints (Owner-managed)

- `POST /api/invites` (owner only)
- `GET /api/invites` (owner only)
- `POST /api/invites/:inviteId/accept` with `{ token, password, displayName? }`

Invite acceptance creates the account (using invite email), signs the user in, and marks invite status `accepted`.

## Personal API Token Endpoints

- `POST /api/me/api-tokens`
- `GET /api/me/api-tokens`
- `DELETE /api/me/api-tokens/:tokenId`

PATs are one-time reveal on creation and stored hashed at rest.

## Auth Token Resolution

Request auth is resolved in this order:

1. Session token from `x-session-token` header.
2. Session token from `minions_session` cookie.
3. API token from `x-api-token` header.
4. `Authorization: Bearer <token>` where token is resolved as session first, then PAT.

## Authorization Rules

- `owner` can create/list invites.
- `member` can use protected read/write board/repo/task/run APIs but cannot create invites.
- All users must have an active membership in the single tenant.

## Secret Model

Runtime provider credentials are Worker secrets only:

- `GITHUB_TOKEN`
- `GITLAB_TOKEN`
- `OPENAI_API_KEY`
- optional `CODEX_AUTH_BUNDLE_R2_KEY`

Runtime secret writes via API are not part of the single-tenant contract.

## Removed APIs

- `/api/tenants*`
- `POST /api/me/tenant-context`
- `/api/platform/*`

## Common Error Semantics

- `401 Unauthorized`: missing/invalid/expired session or PAT.
- `403 Forbidden`: owner-only operation attempted by non-owner, or invalid tenant target in single-tenant mode.
- `404 Not Found`: invite/token/resource not found.
- `409 Conflict`: invite or account state conflict.

## Example Flows

### Login

1. `POST /api/auth/login`
2. `GET /api/me`

### Invite acceptance

1. Owner `POST /api/invites`
2. Invitee `POST /api/invites/:inviteId/accept`
3. Invitee `GET /api/me`

### PAT automation

1. `POST /api/me/api-tokens`
2. Call protected endpoint with `x-api-token` or `Authorization: Bearer <token>`
3. `DELETE /api/me/api-tokens/:tokenId`
