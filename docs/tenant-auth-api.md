# Tenant & Auth API Guide

This guide explains how tenant management and auth work for API consumers.

## Overview

- Every authenticated request executes in one active tenant context.
- Access is membership-based: a user must have an active seat in the tenant.
- Tenant ownership controls member management operations.
- Repo/task/run access is tenant-scoped server-side.
- Protected APIs require a valid session token (no legacy header fallback path).

## Core Concepts

- `User`: authenticated operator identity.
- `Tenant`: organization/account boundary.
- `TenantMember`: user membership in a tenant with role and seat state.
- `UserSession`: auth session with `activeTenantId`.

## Authentication

### Endpoints

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `POST /api/me/tenant-context`

### Token sources (request precedence)

The API resolves session token in this order:

1. `Authorization: Bearer <token>`
2. `x-session-token` header
3. `minions_session` cookie

If no session token is present, protected endpoints fail once tenant membership checks run.

### Session cookie

- Name: `minions_session`
- Set on signup/login
- Cleared on logout

## Tenant Management

### Endpoints

- `GET /api/tenants`
- `POST /api/tenants`
- `GET /api/tenants/:tenantId`
- `GET /api/tenants/:tenantId/members`
- `POST /api/tenants/:tenantId/members`
- `PATCH /api/tenants/:tenantId/members/:memberId`
- `POST /api/tenants/:tenantId/invites`
- `GET /api/tenants/:tenantId/invites`
- `POST /api/invites/:inviteId/accept`

### Role and seat behavior

- `owner` can manage tenant members.
- `member` can access tenant-scoped resources if seat is active.
- Seat states:
  - `active`: can access tenant resources
  - `invited` / `revoked`: no active access

## Tenant Context Switching

Use `POST /api/me/tenant-context` to switch active tenant for the current session.

Request body:

```json
{
  "tenantId": "tenant_acme"
}
```

Rules:

- Requires an auth session.
- User must have an active seat in the selected tenant.

## Tenant-Scoped Resource Access

These endpoints require active-tenant authorization and enforce tenant scoping:

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

### Cross-tenant guard behavior

- Access is denied if the resource tenant does not match the active tenant.
- Access is denied if membership/seat is not active in the relevant tenant.

## Usage and Metering Endpoints

- `GET /api/tenant-usage?tenantId=<id>&from=<iso>&to=<iso>`
- `GET /api/tenant-usage/runs?tenantId=<id>&from=<iso>&to=<iso>`
- `GET /api/runs/:runId/usage`

## Platform Support ("God/Admin") Mode

Platform support mode is scoped and auditable.

### Endpoints

- `POST /api/platform/auth/login`
- `POST /api/platform/support/assume-tenant`
- `POST /api/platform/support/release-tenant`
- `GET /api/platform/support/sessions`
- `GET /api/platform/audit-log`

### Behavior

- Support actions require platform admin auth.
- Tenant access in support mode requires an active support session token.
- Support sessions are time-bound and tenant-scoped.
- Enter/exit and related security events are recorded in audit log.

## Common Error Semantics

- `401 Unauthorized`
  - Invalid or expired session
  - Missing required auth session for endpoint behavior (for example tenant-context switch)
- `403 Forbidden`
  - No active seat in tenant
  - Missing owner role for owner-only operations
  - Cross-tenant resource access attempt
- `404 Not Found`
  - Tenant/resource does not exist (or cannot be resolved)
- `409 Conflict`
  - Seat limit/capacity or business-rule conflict

## Example Flows

### Signup and first tenant

1. `POST /api/auth/signup`
2. Read session + memberships from response
3. Call `GET /api/board?repoId=all` under active tenant

### Login and switch tenant

1. `POST /api/auth/login`
2. `POST /api/me/tenant-context` with a tenant where membership seat is `active`
3. `GET /api/repos` and `GET /api/tasks` for the active tenant

### Owner adds a member

1. Owner calls `POST /api/tenants/:tenantId/members`
2. Owner optionally updates role/seat via `PATCH /api/tenants/:tenantId/members/:memberId`
3. Member can access tenant-scoped resources only when seat state is `active`
