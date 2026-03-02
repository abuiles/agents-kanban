# AgentsKanban Stage 4.6 (Org Onboarding + Platform Support Access)

**Status:** ✅ Implemented

## Goal

Add production-safe org onboarding primitives:

- strict session-auth for tenant-scoped APIs
- employee onboarding via invites by email
- platform "god/admin" support mode with scoped tenant sessions and audit log

## Implemented API surface

### Org onboarding

- `POST /api/tenants/:tenantId/invites` (owner-only)
- `GET /api/tenants/:tenantId/invites` (owner-only)
- `POST /api/invites/:inviteId/accept`

### Platform support/admin

- `POST /api/platform/auth/login`
- `POST /api/platform/support/assume-tenant`
- `POST /api/platform/support/release-tenant`
- `GET /api/platform/support/sessions`
- `GET /api/platform/audit-log`

## Auth and tenancy rules

- Tenant-scoped endpoints now require an auth session or a platform support session.
- Legacy header fallback (`x-user-id` + default tenant) is no longer used for protected APIs.
- Platform support mode is tenant-scoped via `x-support-session-token`.
- Cross-tenant access remains denied unless support mode targets that tenant.

## Invite flow

1. Tenant owner creates invite with email (+ optional role).
2. Invite response includes one-time token.
3. Invitee calls `POST /api/invites/:inviteId/accept` with token while authenticated.
4. Membership is activated and invite is marked accepted.

## Platform admin bootstrap

Platform admin bootstrap is env-driven:

- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`

If configured, a platform admin account is created automatically in `BoardIndexDO` state.

## Audit and support-session behavior

- Support sessions are time-bound and require a reason.
- Session release is explicit (`/release-tenant`) or automatic on expiry.
- Security events are recorded in an audit log for:
  - platform login
  - support session enter/exit
  - invite creation/acceptance

## Notes

- This stage keeps persistence DO-backed for now (invites/admin/support/audit), aligned with current runtime architecture.
- D1 migration for identity/admin tables can be done as a follow-up if required for analytics/reporting at scale.
