# P4: Security and Governance

**Status:** Planned

## Summary

P4 hardens the single-tenant system with server-enforced policy, stronger credential governance, and complete auditability.

This replaces old Stage 8 in the new roadmap.

## Goals

- Enforce policy at runtime, not just in UI.
- Improve credential handling and traceability.
- Reduce security risk in operator and automation flows.

## Scope

In scope:

- repo/run policy model and enforcement
- credential-source governance and audit trails
- auth/session/API-token hardening improvements
- command/network constraints where applicable

Out of scope:

- major UX redesign unrelated to security controls

## API/Model Additions

- policy read/update endpoints
- policy-decision and credential-source audit records

## Acceptance Criteria

1. Policy checks are enforced server-side for protected actions.
2. Credential source decisions are auditable without leaking secrets.
3. Security-sensitive paths (auth, invites, tokens) have hardened validation and tests.
4. Operators can understand denied actions through policy-aware API/UI signals.
