# P6 Task Pack for AgentsKanban (`AR1..AR6`)

This file contains ready-to-submit task payloads for `POST /api/tasks`.

## Usage

1. Create tasks in order `AR1` through `AR6`.
2. Replace dependency placeholders after each task is created:
   - `<taskId_AR1>`, `<taskId_AR2>`, `<taskId_AR3>`, `<taskId_AR4>`, `<taskId_AR5>`
3. Keep all tasks in `INBOX`.
4. Only run `AR(N+1)` after `AR(N)` is merged to `main`.

All payloads are set to:
- `llmAdapter = codex`
- `codexModel = gpt-5.3-codex-spark`
- `codexReasoningEffort = high`
- `sourceRef = main`

`repoId` must be replaced with your real repo ID.

## AR1 Payload

```json
{
  "repoId": "<repoId>",
  "title": "AR1 - Auto-Review Config, Types, and Validation",
  "description": "Add repo/task auto-review config surfaces with backward-compatible validation and defaults.",
  "sourceRef": "main",
  "taskPrompt": "Implement AR1 from docs/plans/current/p6-auto-review-and-change-loop.md.\n\nHard gates:\n- Start from main.\n- Do not rely on partial AR2+ behavior.\n\nRequired outcomes:\n1. Extend shared domain types and API payload validation for:\n   - Repo.autoReview { enabled, prompt?, provider, postInline }\n   - Task.uiMeta.autoReviewMode = inherit|on|off\n   - Task.uiMeta.autoReviewPrompt\n2. Preserve backward compatibility for existing repo/task payloads.\n3. Add defaults:\n   - repo auto-review disabled unless explicitly enabled\n   - task mode defaults to inherit\n4. Add/update UI form controls for repo/task settings.\n5. Add tests for parser/validation compatibility and defaults.\n\nImplementation guidance:\n- Likely touch: src/ui/domain/types.ts, src/ui/domain/api.ts, src/server/http/validation.ts, router handlers for create/update repo/task, relevant UI forms/components.\n- Keep schema changes additive; do not break existing clients.\n\nDone when:\n- API accepts and persists new fields.\n- Existing payloads still pass unchanged.\n- Unit tests cover new fields and fallback behavior.",
  "acceptanceCriteria": [
    "Repo/task auto-review fields are available in types, validation, and API surfaces.",
    "Legacy create/update payloads remain valid without new fields.",
    "Defaults are deterministic: repo disabled, task inherit.",
    "UI exposes repo/task auto-review settings."
  ],
  "context": {
    "links": [
      {
        "id": "p6-plan",
        "label": "P6 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p6-auto-review-and-change-loop.md"
      },
      {
        "id": "features-api",
        "label": "Features and API Surface",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/features-and-api.md"
      },
      {
        "id": "p5-plan",
        "label": "P5 Plan (context)",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p5-slack-jira-gitlab-mvp.md"
      }
    ],
    "notes": "Sequential chain only. Every AR task starts from main and next task begins only after merge to main."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## AR2 Payload

```json
{
  "repoId": "<repoId>",
  "title": "AR2 - Review Prompt Resolution and Artifact Contract",
  "description": "Implement effective auto-review resolution and a stable review finding artifact contract.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_AR1>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement AR2 from docs/plans/current/p6-auto-review-and-change-loop.md.\n\nHard gates:\n- Start from main.\n- Do not begin until AR1 is merged to main.\n\nRequired outcomes:\n1. Implement effective auto-review resolver:\n   - task off/on overrides repo\n   - task inherit uses repo value\n2. Implement prompt precedence resolver:\n   - task prompt > repo prompt > native review mode\n3. Define structured review finding output schema with stable finding IDs.\n4. Add artifact contract writers for:\n   - findings JSON artifact\n   - review markdown artifact\n5. Add tests for precedence, schema parsing, and artifact metadata.\n\nImplementation guidance:\n- Likely touch: run orchestration/shared modules, new review schema utilities, artifact manifest extensions.\n- Keep this task focused on determination/contract, not provider posting yet.\n\nDone when:\n- Given repo/task config, effective review mode and prompt source are deterministic.\n- Review output is normalized into stable findings and persisted artifacts.",
  "acceptanceCriteria": [
    "Effective review setting and prompt source resolve deterministically.",
    "Structured review output schema produces stable finding IDs.",
    "Findings JSON and markdown artifact contracts are generated and linked.",
    "Tests cover precedence and schema normalization."
  ],
  "context": {
    "links": [
      {
        "id": "p6-plan",
        "label": "P6 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p6-auto-review-and-change-loop.md"
      },
      {
        "id": "run-orchestrator",
        "label": "Run Orchestrator",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/run-orchestrator.ts"
      },
      {
        "id": "run-types",
        "label": "Run and Task Types",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/ui/domain/types.ts"
      }
    ],
    "notes": "Do not introduce provider posting behavior yet; AR3 will add that seam."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## AR3 Payload

```json
{
  "repoId": "<repoId>",
  "title": "AR3 - Provider Posting Adapters for GitLab and Jira",
  "description": "Post normalized review findings to the configured provider and ingest replies for context.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_AR2>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement AR3 from docs/plans/current/p6-auto-review-and-change-loop.md.\n\nHard gates:\n- Start from main.\n- Do not begin until AR2 is merged to main.\n\nRequired outcomes:\n1. Add provider-neutral review posting seam.\n2. GitLab implementation:\n   - post inline notes when location is available\n   - fallback to MR summary note when inline is not possible\n3. Jira implementation:\n   - post issue comments for findings using stable finding IDs\n   - include path/line references where present\n4. Add provider reply ingestion:\n   - fetch comments/replies and map back to finding IDs\n5. Add tests for gitlab/jira posting + fallback + reply normalization.\n\nImplementation guidance:\n- Reuse existing SCM adapters where possible for posting behavior.\n- Keep provider-specific behavior behind an adapter interface.\n- Capture posting IDs/metadata for idempotency and traceability.\n\nDone when:\n- Findings can be posted to selected provider and replies can be read back into normalized context.",
  "acceptanceCriteria": [
    "GitLab and Jira review posting paths both work with provider-specific fallback behavior.",
    "Reply/readback context can be correlated to finding IDs.",
    "Provider failures are non-fatal and observable in run metadata/logs.",
    "Adapter tests cover posting, fallback, and reply ingestion."
  ],
  "context": {
    "links": [
      {
        "id": "p6-plan",
        "label": "P6 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p6-auto-review-and-change-loop.md"
      },
      {
        "id": "gitlab-adapter",
        "label": "GitLab SCM Adapter",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/scm/gitlab.ts"
      },
      {
        "id": "github-adapter",
        "label": "GitHub SCM Adapter (pattern reference)",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/scm/github.ts"
      }
    ],
    "notes": "Provider writes should remain adapter-owned; avoid scattering provider logic across orchestrator."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## AR4 Payload

```json
{
  "repoId": "<repoId>",
  "title": "AR4 - Orchestrator Auto-Review Trigger and Manual Re-Run",
  "description": "Integrate auto-review into run lifecycle on REVIEW and add a manual review re-run endpoint/action.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_AR3>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement AR4 from docs/plans/current/p6-auto-review-and-change-loop.md.\n\nHard gates:\n- Start from main.\n- Do not begin until AR3 is merged to main.\n\nRequired outcomes:\n1. Trigger auto-review on each REVIEW entry when effective setting is enabled.\n2. Add endpoint/action: POST /api/runs/:runId/review for manual re-run.\n3. Persist run-level review execution metadata:\n   - status, trigger source, prompt source, round, timing\n4. Persist review artifacts and provider posting state on run metadata.\n5. Add timeline/log visibility for review start/end/failures.\n6. Add tests for auto trigger, skip when disabled, and manual rerun behavior.\n\nImplementation guidance:\n- Integrate without regressing existing preview/evidence/review lifecycle.\n- Ensure manual rerun does not create duplicate uncontrolled posting for same round.\n\nDone when:\n- Review stage executes deterministically in lifecycle and manual rerun works via API/UI control.",
  "acceptanceCriteria": [
    "Auto-review runs on REVIEW when enabled and skips when disabled.",
    "Manual re-run review endpoint is functional and idempotent-safe.",
    "Run timeline/metadata include review execution details and artifacts.",
    "Existing run lifecycle behavior remains stable."
  ],
  "context": {
    "links": [
      {
        "id": "p6-plan",
        "label": "P6 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p6-auto-review-and-change-loop.md"
      },
      {
        "id": "router",
        "label": "Server Router",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/router.ts"
      },
      {
        "id": "run-orchestrator",
        "label": "Run Orchestrator",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/run-orchestrator.ts"
      }
    ],
    "notes": "Keep trigger semantics explicit: automatic on REVIEW plus explicit manual rerun button/API."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## AR5 Payload

```json
{
  "repoId": "<repoId>",
  "title": "AR5 - Flexible Request-Changes Scope and Reply-Aware Context",
  "description": "Extend request-changes so operators can target all/some findings and include reply context.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_AR4>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement AR5 from docs/plans/current/p6-auto-review-and-change-loop.md.\n\nHard gates:\n- Start from main.\n- Do not begin until AR4 is merged to main.\n\nRequired outcomes:\n1. Extend request-changes payload with optional reviewSelection:\n   - mode: all|include|exclude|freeform\n   - findingIds?\n   - instruction?\n   - includeReplies?\n2. Keep backward compatibility with existing payload { prompt }.\n3. Build change-request prompt context from:\n   - selected findings (or all)\n   - provider replies mapped to those findings\n   - operator freeform instruction\n4. Track selected findings in run metadata/change request context.\n5. Add UI controls in detail panel for selecting review scope and rerun intent.\n6. Add tests for selection modes, unknown IDs, reply context inclusion.\n\nImplementation guidance:\n- Keep behavior flexible (not rigidly IDs-only). Natural instructions should still work.\n- Prioritize deterministic prompt composition with clear sections.\n\nDone when:\n- Operators can request fix-all or selective fixes with reply context and existing flow still works.",
  "acceptanceCriteria": [
    "Request-changes supports all/include/exclude/freeform selection modes.",
    "Legacy prompt-only request-changes path remains functional.",
    "Reply context is incorporated when requested.",
    "Run metadata records targeted findings for auditability."
  ],
  "context": {
    "links": [
      {
        "id": "p6-plan",
        "label": "P6 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p6-auto-review-and-change-loop.md"
      },
      {
        "id": "app-ui",
        "label": "App Request-Changes Flow",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/ui/App.tsx"
      },
      {
        "id": "detail-panel",
        "label": "Detail Panel Actions",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/ui/components/DetailPanel.tsx"
      }
    ],
    "notes": "Flexible scope is required: support both precise finding IDs and natural language instructions."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## AR6 Payload

```json
{
  "repoId": "<repoId>",
  "title": "AR6 - Hardening, End-to-End Validation, and Handoff",
  "description": "Finalize auto-review + change-loop with hardening, docs, E2E tests, and execution handoff pack.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_AR5>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement AR6 from docs/plans/current/p6-auto-review-and-change-loop.md.\n\nHard gates:\n- Start from main.\n- Do not begin until AR5 is merged to main.\n\nRequired outcomes:\n1. Add idempotency/retry handling for provider review posting.\n2. Add end-to-end tests for:\n   - run reaches REVIEW\n   - auto-review executes\n   - findings posted to provider\n   - request-changes selective follow-up\n   - rerun review behavior\n3. Update docs:\n   - README.md\n   - docs/features-and-api.md\n   - docs/local-testing.md\n   - docs/integrations/auto-review-change-loop.md (new)\n4. Publish final operator checklist and known limitations/deferred work.\n5. Prepare task-handoff payloads for execution phase if needed.\n\nImplementation guidance:\n- Keep compatibility with existing run execution and request-changes paths.\n- Ensure observability for review failures and posting retries.\n\nDone when:\n- The full auto-review loop is documented, test-covered, and operationally clear for rollout.",
  "acceptanceCriteria": [
    "End-to-end auto-review and selective change-loop flows are test-covered.",
    "Provider posting has retry/idempotency safeguards.",
    "Documentation is complete for setup, operations, and troubleshooting.",
    "Known limitations and deferred items are explicitly listed."
  ],
  "context": {
    "links": [
      {
        "id": "p6-plan",
        "label": "P6 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p6-auto-review-and-change-loop.md"
      },
      {
        "id": "features-api",
        "label": "Features and API Surface",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/features-and-api.md"
      },
      {
        "id": "local-testing",
        "label": "Local Testing Guide",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/local-testing.md"
      }
    ],
    "notes": "Final hardening task. Keep scope to P6 committed outcomes; do not expand into unrelated platform generalization."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

