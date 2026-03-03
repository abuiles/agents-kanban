> Historical doc: superseded by the active P1-P4 plans in [../current/README.md](../current/README.md).

# AgentsKanban Stage 5 (Explain)

**Status:** ⏳ Pending

## Goal

Stage 5 makes it obvious what ran and why.

Stage 4 makes runs watchable and attachable. Stage 5 adds command attribution and execution rationale so operators can understand run behavior without reverse-engineering raw logs.

## Scope

In scope:

- command attribution
- run decision and transition audit records
- rationale for major command execution steps
- failure explanation surfaces in the UI

Out of scope:

- cancellation
- repo execution config
- queueing and fairness
- broad policy enforcement

## Target outcomes

By the end of Stage 5, an operator should be able to:

- tell whether a command came from the system, Codex, or an operator
- understand why a command ran
- identify what failed and what it blocked
- inspect a run in product terms, not just shell terms

## Additive model

Recommended type:

```ts
type RunAuditEntry = {
  id: string;
  runId: string;
  at: string;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push' | 'preview' | 'evidence';
  subjectType: 'command' | 'decision' | 'transition';
  subjectId?: string;
  source: 'system' | 'codex' | 'operator';
  summary: string;
  rationale?: string;
  metadata?: Record<string, string | number | boolean>;
};
```

Rules:

- every major transition should have an audit entry
- commands should include attribution to `system`, `codex`, or `operator`
- rationale should be concise and operator-facing
- the audit model is explanatory, not a replacement for raw logs

## API additions

Add:

- `GET /api/runs/:runId/audit`

`commands` may also be enriched with attribution metadata, but `audit` remains the first-class explanation surface.

## UI expectations

Add:

- “why this ran” detail for commands
- grouped audit timeline by phase
- failure summary card showing the failed command, source, and rationale

## Testing plan

Add coverage for:

- system vs Codex vs operator attribution
- rationale presence on major transitions
- failure explanation rendering
- audit API consistency with command/event history

## Acceptance criteria

Stage 5 is complete when:

- commands have attribution
- major transitions have explanation records
- failed runs show what failed and why it mattered
- operators can understand run behavior without reading the entire raw log stream

## Recommended build order

1. Add Stage 5 docs and lock the explanation model.
2. Add `RunAuditEntry` and attribution fields to command records.
3. Emit audit entries from the orchestrator and operator attach flows.
4. Add `GET /api/runs/:runId/audit`.
5. Add explanation UI to the detail panel.
6. Validate the explanation model on successful and failing real runs.
