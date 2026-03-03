# P2: Control and Explainability

**Status:** Planned

## Summary

P2 merges remaining operator control work and explainability work into one single-tenant phase.

This replaces unfinished portions of old Stage 5 and Stage 6.

## Goals

- Explain what happened during a run and why.
- Give operators clear, safe run controls.
- Keep control/decision behavior auditable and visible in UI.

## Scope

In scope:

- run audit timeline and rationale model
- command attribution (`system` vs `agent` vs `operator`)
- safe cancel semantics and state transitions
- guided/full-auto execution mode controls (if retained)
- operator-facing UI for explanation + control state

Out of scope:

- queueing/fairness logic (P3)
- deep security policy controls (P4)

## API/Model Additions

- `GET /api/runs/:runId/audit`
- enriched run/command metadata for attribution and rationale
- stable canceled-state handling for run lifecycle

## Acceptance Criteria

1. Operators can cancel active runs safely and predictably.
2. Operators can inspect why key run transitions happened.
3. Audit and command attribution are visible in API and UI.
4. Failed runs provide actionable failure context without raw-log deep dives.
