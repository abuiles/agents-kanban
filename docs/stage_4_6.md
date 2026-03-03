# Stage 4.6 (Superseded)

**Status:** Superseded by single-tenant migration

This document described the previous multi-tenant onboarding and platform-support-admin model.

That contract is no longer active.

## Replacement docs

- Current migration and acceptance criteria: `docs/stage_single_tenant_oss.md`
- Current auth API contract: `docs/tenant-auth-api.md`

## Removed from current API

- `/api/tenants*`
- `POST /api/me/tenant-context`
- `/api/platform/*`

## Current replacement APIs

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/invites`
- `POST /api/invites`
- `POST /api/invites/:inviteId/accept`
- `GET /api/me/api-tokens`
- `POST /api/me/api-tokens`
- `DELETE /api/me/api-tokens/:tokenId`
