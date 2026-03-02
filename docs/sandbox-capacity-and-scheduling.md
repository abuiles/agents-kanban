# Sandbox Capacity and Scheduling

## Status
**Status:** ✅ In progress

This doc describes how AgentsKanban runs Workflows and Cloudflare Sandboxes in the current architecture, with the new default of `max_instances = 20`.

## Runtime model

- Active run execution is kicked off from `POST /api/tasks/:taskId/run` (or related run control actions).
- The Worker schedules each run through `RUN_WORKFLOW` as a separate workflow invocation.
- Each run uses the Sandbox binding with run-specific IDs:
  - Main coding sandbox: `runId`
  - Evidence sandbox: `${runId}-evidence`
  - Preview sandbox: `${runId}-preview` (when the preview runner path is used)

These are created on demand by request and run IDs, so two runs can coexist under different sandbox IDs.

## Container configuration

Current production container binding (`wrangler.jsonc`) is:

- `instance_type`: `lite`
- `max_instances`: `20`

This is the maximum number of concurrent container instances for the `Sandbox` binding.

### What `max_instances` means

- A run is not limited to **one** sandbox if it needs secondary steps (evidence/preview helpers).
- The configured maximum is a binding-level hard ceiling.
- This ceiling applies to all runtime callers of the same binding and is separate from the workflow scheduler.

## What changed with `max_instances = 20`

- The platform can now run up to 20 sandbox instances concurrently for this Worker binding.
- In practice, Stage 7 queueing remains pending, so multiple runs can overlap but queue semantics are not yet a first-class product signal.
- Local-alarm execution path is still serialized by Durable Object logic and is separate from production workflow behavior.

## Known limits and precedence

- Workflow execution and run lifecycle are currently the only gating mechanism for overlap.
- Stage 7 (Scale) must add:
  - per-repo and global concurrency caps,
  - queued state and visible reason codes,
  - backpressure behavior.
- Stage 4.5 (Tenant Metering) will later use this same runtime signal to attach tenant-aware usage and enforcement policy, but does not itself provide per-tenant sandbox quota controls yet.

## Capacity behavior to document in APIs/UIs

Until Stage 7 is implemented:

- `POST /api/tasks/:taskId/run` returns a run record immediately.
- Runs may remain active/queued due to runtime/platform capacity and this is only indirectly visible today.
- Operator and automation consumers should treat repeated status polling as the supported way to observe actual run state.

Planned Stage 7 additions:

- `queued` vs `running` run state
- machine-readable queue reason (e.g., `global_capacity` / `repo_capacity`)
- priority/fairness visibility

## Run sandbox lifecycle semantics

- Sandbox scope is ephemeral per run ID.
- Credentials are injected for the run duration and are not designed to persist inside sandbox state.
- Evidence runs are isolated and should not reuse the main coding sandbox.
- Evidence and preview operations can still leave traces in run logs and artifact output.

## Failure modes to include in release notes

- Sandbox startup/resource saturation can fail after orchestration has accepted a run.
- Failures should be represented as runtime failure events on the run state so recovery logic can choose retry or manual operator intervention.
- If we add explicit queueing before run start in Stage 7, this is expected to reduce the observed "start failed due to capacity" rate.
