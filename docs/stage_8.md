# AgentsKanban Stage 8 (Harden)

## Goal

Stage 8 adds the security, policy, and credential controls needed for broader rollout.

Stage 8 deliberately comes last in this roadmap so the earlier stages can optimize for product usefulness first.

## Scope

In scope:

- repo/task execution policy controls
- finer-grained credentials
- operator auth hardening
- command and network governance
- audit completeness for policy and credential decisions

Out of scope:

- major UI redesign
- billing systems unless directly required by quotas or governance

## Target outcomes

By the end of Stage 8, an operator should be able to:

- control whether terminal access is allowed for a repo
- control whether full-auto Codex mode is allowed
- understand which credential source was used for a run
- trust that policy decisions are enforced server-side and auditable

## Additive model

Recommended type:

```ts
type RepoPolicy = {
  allowTerminalAccess: boolean;
  allowFullAuto: boolean;
  maxRunDurationSeconds?: number;
  maxEvidenceDurationSeconds?: number;
  deniedCommands?: string[];
  allowedCommandPrefixes?: string[];
};
```

Rules:

- policy enforcement happens in the control plane, not in the UI alone
- credentials must not be persisted to task/run payloads
- credential source selection should be logged without leaking secrets

## Credential model

Preferred target:

- GitHub App installation auth as the default production model

Interim acceptable model:

- PAT per owner or per repo stored in KV

Requirements:

- credential rotation support
- credential source audit
- no secret material in logs, task payloads, or public artifacts

## API additions

Add:

- `PATCH /api/repos/:repoId/policy`
- `GET /api/repos/:repoId/policy`

Existing audit surfaces should be extended to include:

- policy decisions
- credential source decisions
- operator authorization outcomes

## UI expectations

Add:

- repo policy editor
- visible policy warnings on tasks and runs
- audit visibility for denied commands or blocked terminal attach

## Testing plan

Add coverage for:

- denied command enforcement
- terminal attach denial by policy
- credential source selection and rotation
- audit completeness for operator, credential, and policy actions

## Acceptance criteria

Stage 8 is complete when:

- repo/task controls are enforced server-side
- credentials are finer-grained than the Stage 3 global PAT model
- policy and credential decisions are auditable
- operator access and execution behavior can be constrained per repo coherently

## Recommended build order

1. Add Stage 8 docs and lock the hardening model.
2. Add repo policy types and storage.
3. Add credential source abstraction and audit metadata.
4. Enforce policy checks before operator attach and command execution where applicable.
5. Extend audit surfaces for policy and credential decisions.
6. Validate hardened behavior on real runs and operator sessions.
