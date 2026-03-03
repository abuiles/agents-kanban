# Stage 4.6 (Superseded)

This stage document is retained for historical context only.

Stage 4.6 tenant-onboarding and platform-support flows are superseded by the single-tenant OSS plan:

- `docs/stage_single_tenant_oss.md`

Current contract differences:

- `/api/platform/*` is removed in single-tenant mode.
- `/api/tenants*` and `POST /api/me/tenant-context` are removed.
- Owner-managed invites are now `POST /api/invites`, `GET /api/invites`, and `POST /api/invites/:inviteId/accept`.
- Personal API tokens are now `POST/GET/DELETE /api/me/api-tokens*`.

Refer to `docs/tenant-auth-api.md` for the current auth/invite/PAT API contract.
