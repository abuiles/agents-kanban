# P9 Task Pack for AgentsKanban (`G1..G5`)

This file contains ready-to-submit task payloads for `POST /api/tasks`.

## Usage

1. Create tasks in order `G1` through `G5`.
2. Replace dependency placeholders after each task is created:
   - `<taskId_G1>`, `<taskId_G2>`, `<taskId_G3>`, `<taskId_G4>`
3. Keep all tasks in `INBOX` until activated by sentinel.
4. Only run `G(N+1)` after `G(N)` is merged to `main`.

All payloads are set to:

- `sourceRef = main`
- `llmAdapter = codex`
- `codexModel = gpt-5.3-codex`
- `codexReasoningEffort = medium`

`repoId` must be replaced with your real repo ID.

## Shared requirement for every G task

1. Start from `main`.
2. Do not begin until upstream dependency task is merged to `main`.
3. PR description must include sections:
   - Objective
   - Scope
   - Behavior changes
   - API/type changes
   - Backward compatibility
   - Manual QA
   - Risks/Rollback
   - Deferred follow-ups

## G1 Payload

```json
{
  "repoId": "<repoId>",
  "title": "G1 - GitHub Auto-Review Provider Contract and Defaults",
  "description": "Add GitHub as supported auto-review provider with SCM-aware default behavior and compatibility-safe validation.",
  "sourceRef": "main",
  "taskPrompt": "Implement G1 from docs/plans/current/p9-github-auto-review-provider.md.\n\nHard gates:\n- Start from main.\n- Keep behavior backward compatible for existing GitLab/Jira flows.\n\nRequired outcomes:\n1. Extend AutoReviewProvider to include github.\n2. Update validation/defaulting for repo autoReview provider:\n   - if enabled and provider omitted, default by repo scmProvider\n   - github repo -> github\n   - gitlab repo -> gitlab\n3. Keep existing payload compatibility for legacy clients.\n4. Add parser/validation tests for github provider and defaulting.\n5. Update related domain/api types.\n\nPR description must include sections:\n- Objective\n- Scope\n- Behavior changes\n- API/type changes\n- Backward compatibility\n- Manual QA\n- Risks/Rollback\n- Deferred follow-ups",
  "acceptanceCriteria": [
    "AutoReviewProvider supports github in domain and API validation layers.",
    "Enabled auto-review defaults provider by repo.scmProvider when omitted.",
    "Legacy payloads continue to parse and persist correctly.",
    "PR description includes all required sections."
  ],
  "context": {
    "links": [
      {
        "id": "p9-plan",
        "label": "P9 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p9-github-auto-review-provider.md"
      },
      {
        "id": "types",
        "label": "Domain Types",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/ui/domain/types.ts"
      },
      {
        "id": "validation",
        "label": "HTTP Validation",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/http/validation.ts"
      }
    ],
    "notes": "Decision locked: provider defaults by SCM when autoReview is enabled and provider omitted."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex",
  "codexReasoningEffort": "medium"
}
```

## G2 Payload

```json
{
  "repoId": "<repoId>",
  "title": "G2 - GitHub Review Posting Adapter (Inline + Summary Fallback)",
  "description": "Implement GitHub provider posting adapter with marker-based idempotency and fallback behavior.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_G1>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement G2 from docs/plans/current/p9-github-auto-review-provider.md.\n\nHard gates:\n- Start from main.\n- Do not begin until G1 is merged to main.\n\nRequired outcomes:\n1. Add GitHubReviewPostingAdapter implementing review-posting adapter contract.\n2. Post inline PR comments when file/line context exists.\n3. Fallback to summary PR comment when inline context is unavailable.\n4. Apply marker-based idempotent behavior to avoid duplicate posts on retries.\n5. Register github adapter in review-posting registry.\n6. Add adapter tests for inline, fallback, and idempotency.\n\nPR description must include sections:\n- Objective\n- Scope\n- Behavior changes\n- API/type changes\n- Backward compatibility\n- Manual QA\n- Risks/Rollback\n- Deferred follow-ups",
  "acceptanceCriteria": [
    "Findings post to GitHub with inline+summary fallback behavior.",
    "Marker-based idempotency prevents duplicate finding posts on retries.",
    "Review-posting registry resolves github adapter.",
    "PR description includes all required sections."
  ],
  "context": {
    "links": [
      {
        "id": "p9-plan",
        "label": "P9 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p9-github-auto-review-provider.md"
      },
      {
        "id": "adapter-contract",
        "label": "Review Posting Adapter Contract",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/review-posting/adapter.ts"
      },
      {
        "id": "registry",
        "label": "Review Posting Registry",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/review-posting/registry.ts"
      }
    ],
    "notes": "Keep existing gitlab/jira adapter behavior unchanged; this task adds github path only."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex",
  "codexReasoningEffort": "medium"
}
```

## G3 Payload

```json
{
  "repoId": "<repoId>",
  "title": "G3 - Orchestrator and Credential Wiring for GitHub Auto-Review",
  "description": "Wire github provider through orchestrator execution and credential resolution paths with observability and graceful failures.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_G2>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement G3 from docs/plans/current/p9-github-auto-review-provider.md.\n\nHard gates:\n- Start from main.\n- Do not begin until G2 is merged to main.\n\nRequired outcomes:\n1. Ensure auto-review orchestrator path supports provider=github.\n2. Resolve posting credentials for github using GITHUB_TOKEN.\n3. Emit clear provider-specific errors when token is missing.\n4. Persist posting outcomes in run metadata/timeline.\n5. Add orchestrator tests for github success and missing-token scenarios.\n\nPR description must include sections:\n- Objective\n- Scope\n- Behavior changes\n- API/type changes\n- Backward compatibility\n- Manual QA\n- Risks/Rollback\n- Deferred follow-ups",
  "acceptanceCriteria": [
    "Orchestrator executes github review-posting path when configured.",
    "Missing GITHUB_TOKEN is handled gracefully with actionable metadata.",
    "Run metadata/timeline reflects github posting outcomes.",
    "PR description includes all required sections."
  ],
  "context": {
    "links": [
      {
        "id": "p9-plan",
        "label": "P9 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p9-github-auto-review-provider.md"
      },
      {
        "id": "run-orchestrator",
        "label": "Run Orchestrator",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/run-orchestrator.ts"
      },
      {
        "id": "review-contract",
        "label": "Review Contract Resolver",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/shared/review-contract.ts"
      }
    ],
    "notes": "Do not change review trigger semantics; only extend provider execution support."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex",
  "codexReasoningEffort": "medium"
}
```

## G4 Payload

```json
{
  "repoId": "<repoId>",
  "title": "G4 - GitHub Webhook Ingestion, Verification, and Dedupe",
  "description": "Add GitHub webhook endpoint for reply-context ingestion with signature verification and idempotent delivery handling.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_G3>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement G4 from docs/plans/current/p9-github-auto-review-provider.md.\n\nHard gates:\n- Start from main.\n- Do not begin until G3 is merged to main.\n\nRequired outcomes:\n1. Add endpoint: POST /api/integrations/github/webhook.\n2. Implement webhook signature verification using shared secret.\n3. Add delivery-id dedupe and idempotency handling.\n4. Normalize relevant review/comment events for reply context mapping.\n5. Persist normalized reply context hints for later request-changes use.\n6. Add tests for valid, invalid, duplicate, and ignored event cases.\n\nPR description must include sections:\n- Objective\n- Scope\n- Behavior changes\n- API/type changes\n- Backward compatibility\n- Manual QA\n- Risks/Rollback\n- Deferred follow-ups",
  "acceptanceCriteria": [
    "GitHub webhook endpoint verifies signature and rejects invalid requests.",
    "Duplicate deliveries are deduped deterministically.",
    "Normalized reply context hints are persisted for downstream use.",
    "PR description includes all required sections."
  ],
  "context": {
    "links": [
      {
        "id": "p9-plan",
        "label": "P9 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p9-github-auto-review-provider.md"
      },
      {
        "id": "gitlab-webhook-reference",
        "label": "GitLab Webhook Handler Reference",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/integrations/gitlab/handlers.ts"
      },
      {
        "id": "idempotency",
        "label": "Integration Idempotency Helpers",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/integrations/idempotency.ts"
      }
    ],
    "notes": "Webhook path should focus on reply-context ingestion; do not expand into full run-state orchestration changes."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex",
  "codexReasoningEffort": "medium"
}
```

## G5 Payload

```json
{
  "repoId": "<repoId>",
  "title": "G5 - Reply Context Merge, Request-Changes Enrichment, Docs, and Dogfood QA",
  "description": "Merge webhook and on-demand GitHub replies into request-changes context and complete documentation plus dogfood QA guidance.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_G4>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement G5 from docs/plans/current/p9-github-auto-review-provider.md.\n\nHard gates:\n- Start from main.\n- Do not begin until G4 is merged to main.\n\nRequired outcomes:\n1. Merge reply context from webhook-ingested store and on-demand provider fetch, with dedupe + deterministic ordering.\n2. Integrate merged context into request-changes prompt composition when includeReplies=true.\n3. Add integration tests for selective request-changes + reply context.\n4. Update docs and local setup/QA instructions for GitHub auto-review dogfooding.\n5. Document known limitations and deferred follow-ups.\n\nPR description must include sections:\n- Objective\n- Scope\n- Behavior changes\n- API/type changes\n- Backward compatibility\n- Manual QA\n- Risks/Rollback\n- Deferred follow-ups",
  "acceptanceCriteria": [
    "Request-changes includes merged GitHub reply context when requested.",
    "Reply merge logic is deterministic and deduped.",
    "Docs include setup and manual QA instructions for GitHub auto-review dogfooding.",
    "PR description includes all required sections."
  ],
  "context": {
    "links": [
      {
        "id": "p9-plan",
        "label": "P9 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p9-github-auto-review-provider.md"
      },
      {
        "id": "request-changes-router",
        "label": "Request Changes Route",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/router.ts"
      },
      {
        "id": "review-posting-adapter",
        "label": "Review Posting Adapter Contract",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/review-posting/adapter.ts"
      }
    ],
    "notes": "Final task should leave a clear dogfood playbook for using GitHub auto-review in AgentsKanban's own repo workflows."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex",
  "codexReasoningEffort": "medium"
}
```
