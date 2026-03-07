# Stage: `.agents` Home Bundle Injection

**Status:** Implemented

## Goal

Support a standard team-distributed `.agents` directory by restoring an optional tarball into `$HOME/.agents` in sandbox runs, similar to the existing `.codex` bundle workflow.

## Product Decisions

1. Bundle key resolution is repo-first, then global fallback.
2. Restore mode is overlay extraction into `$HOME` (no pre-delete).
3. Failure mode is best-effort: log and continue.
4. Behavior applies to both full runs and prompt-runtime execution paths.

## API and Data Model Changes

Add repo field:

- `agentsBundleR2Key?: string`

Accepted in:

1. `POST /api/repos`
2. `PATCH /api/repos/:repoId`

Persisted and returned in repo snapshots.

## Runtime Behavior

1. Resolve bundle key from:
   - `repo.agentsBundleR2Key`
   - fallback `AGENTS_BUNDLE_R2_KEY` Worker secret
2. Read bundle object from `RUN_ARTIFACTS`.
3. Restore with:
   - decode `agents-home.tgz.b64` in sandbox
   - `tar -xzf ... -C "$HOME"`
   - verify `$HOME/.agents` exists
4. Append bootstrap logs for diagnostics.
5. Continue run on any `.agents` restore failure.

## UI Changes

Repo form includes:

- `.agents bundle key`

This allows per-repo overrides without changing global Worker secrets.

## Ops Setup

1. Build a bundle containing `.agents` root.
2. Upload to `RUN_ARTIFACTS` bucket.
3. Configure one of:
   - Repo-level `agentsBundleR2Key`
   - global Worker secret `AGENTS_BUNDLE_R2_KEY`

## Testing Coverage

1. Validation test for create/update acceptance of `agentsBundleR2Key`.
2. Orchestrator test confirming `.agents` restore command path and success logging with global fallback key.

## Compatibility Notes

1. Existing repos are unchanged unless key is configured.
2. `.codex` auth behavior is unchanged.
3. Missing `.agents` configuration is non-fatal by design.
