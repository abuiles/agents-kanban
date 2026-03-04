# P10 One-Shot Task Payload for AgentsKanban (`S10`)

This file contains a single ready-to-submit task payload for `POST /api/tasks`.

Execution policy for this task:

1. Start from `main`.
2. Implement the full plan in one pass.
3. Keep existing Slack Jira fast-path behavior backward compatible.
4. Use:
   - `llmAdapter = codex`
   - `codexModel = gpt-5.3-codex-spark`
   - `codexReasoningEffort = high`

`repoId` is pre-filled for the local dogfood repo.

## S10 Payload

```json
{
  "repoId": "repo_abuiles_agents_kanban",
  "title": "S10 - Slack Free-Text Intent Intake + Clarification Loop (One-Shot)",
  "description": "Implement free-text /kanvy intent intake with deterministic Jira fast-path, model-selectable parser defaults, thread clarification loop, and auto task creation when complete.",
  "sourceRef": "main",
  "taskPrompt": "Implement P10 from docs/plans/current/p10-slack-intent-intake-one-shot.md in one pass.\n\nHard gates:\n- Start from main.\n- Single task implementation (no split across multiple tasks).\n- Preserve backward compatibility for existing /kanvy fix <JIRA_KEY> path.\n\nRequired outcomes:\n1. Upgrade slash parsing to accept free text after /kanvy.\n2. Keep deterministic Jira fast-path for fix <JIRA_KEY>.\n3. Add LLM intent parser path for non-fast-path inputs using strict JSON output.\n4. Add thread-based intake session persistence and clarification loop.\n5. Add max clarification turns (default 4) with explicit handoff message.\n6. Add scoped intake model config with precedence channel > repo > tenant.\n7. Default intake parser model to gpt-5.1-codex-mini for codex/OpenAI unless overridden.\n8. Auto-create task/run when intent is complete and high-confidence.\n9. Add repo resolution fallback/disambiguation for generic tasks.\n10. Extend tests for parser behavior, session flow, dedupe safety, and non-regression.\n11. Update Slack-related docs and plan references.\n\nImplementation constraints:\n- Reuse existing integration config + idempotency infrastructure.\n- Do not expand into generic plugin/event-bus platform work.\n- Keep rerun/pause/close interactions operational.\n\nPR description must include:\n- Objective\n- Scope\n- Behavior changes\n- API/type changes\n- Backward compatibility\n- Manual QA\n- Risks/Rollback\n- Deferred follow-ups",
  "acceptanceCriteria": [
    "Slack command accepts free text while preserving deterministic Jira fast-path behavior.",
    "Intent parser flow can ask clarifying questions in-thread and complete task creation without dashboard intervention.",
    "Intake model selection follows channel > repo > tenant precedence with default gpt-5.1-codex-mini.",
    "Duplicate deliveries do not create duplicate tasks/runs.",
    "Slack-related docs and current plan index are updated for the new intake behavior.",
    "PR description contains all required sections."
  ],
  "context": {
    "links": [
      {
        "id": "p10-plan",
        "label": "P10 Plan",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p10-slack-intent-intake-one-shot.md"
      },
      {
        "id": "slack-handlers",
        "label": "Slack Handlers",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/integrations/slack/handlers.ts"
      },
      {
        "id": "slack-payload",
        "label": "Slack Payload Parsing",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/integrations/slack/payload.ts"
      },
      {
        "id": "integration-resolution",
        "label": "Integration Config Resolution",
        "url": "https://github.com/abuiles/agents-kanban/blob/main/src/server/integrations/config-resolution.ts"
      }
    ],
    "notes": "One-shot execution requested by operator. Preserve existing Jira and review-loop behavior while introducing free-text intake."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```
