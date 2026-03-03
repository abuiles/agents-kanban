# Stage 4.6 (Superseded)

This stage document is superseded by the single-tenant OSS cutover plan.

- Replacement plan: [docs/stage_single_tenant_oss.md](stage_single_tenant_oss.md)
- Current auth API contract: [docs/tenant-auth-api.md](tenant-auth-api.md)

## Superseded scope

The old Stage 4.6 design assumed multi-tenant onboarding and platform support-admin endpoints.
Those APIs are no longer part of the active contract.

Removed endpoint groups:

- `/api/tenants*`
- `POST /api/me/tenant-context`
- `/api/platform/*`

Use the single-tenant invite and personal API-token model instead.
