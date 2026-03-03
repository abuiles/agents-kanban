# P3: Scale and Scheduling

**Status:** Planned

## Summary

P3 introduces explicit scheduling behavior for concurrent runs in a single-tenant deployment.

This replaces old Stage 7 in the new roadmap.

## Goals

- Make queued/running states explicit and understandable.
- Enforce concurrency limits coherently.
- Prevent noisy workload patterns from starving interactive runs.

## Scope

In scope:

- queue state on run records and board projection
- reason codes for queued/blocked states
- per-repo and global concurrency limits
- scheduler fairness and backpressure behavior

Out of scope:

- security governance and policy restrictions (P4)

## API/Model Additions

- queue metadata on run models/projections
- queue reason fields in run detail and board snapshots

## Acceptance Criteria

1. Runs expose clear queued/running/blocked status.
2. Queue reasons are visible in API/UI.
3. Global and per-repo limits are enforced consistently.
4. Multi-run behavior is predictable under load.
