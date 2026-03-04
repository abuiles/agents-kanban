# P5 Task Pack for AgentsKanban (`T1..T6`)

This file contains ready-to-submit task payloads for `POST /api/tasks`.

## Usage

1. Create tasks in order `T1` through `T6`.
2. Replace dependency placeholders after each task is created:
   - `<taskId_T1>`, `<taskId_T2>`, `<taskId_T3>`, `<taskId_T4>`, `<taskId_T5>`
3. Keep all tasks in `INBOX`.
4. Only run `T(N+1)` after `T(N)` is merged to `main`.

All payloads are set to:
- `llmAdapter = codex`
- `codexModel = gpt-5.3-codex-spark`
- `codexReasoningEffort = high`
- `sourceRef = main`

`repoId` must be replaced with your real repo ID.

## T1 Payload

```json
{
  "repoId": "<repoId>",
  "title": "T1 - Integration Foundation + Persistence",
  "description": "Create the strict MVP integration foundation: typed integration seams, persistence tables, precedence resolution, and idempotency primitives.",
  "sourceRef": "main",
  "taskPrompt": "Implement Task 1 from docs/plans/current/p5-slack-jira-gitlab-mvp.md.\n\nHard gate:\n- This task starts from main.\n- Do not assume any previous task exists.\n\nRequired outcomes:\n1. Add MVP integration seams with narrow typed interfaces:\n   - TriggerIntegration\n   - IssueSourceIntegration\n   - ReviewIntegration\n2. Add persistence/migrations for:\n   - integration_configs\n   - jira_project_repo_mappings\n   - slack_thread_bindings\n3. Add config precedence resolver with strict order: channel > repo > tenant.\n4. Add shared idempotency helper for webhook/event dedupe keys.\n5. Add tests for precedence, idempotency, and persistence helpers.\n\nConstraints:\n- Do not introduce a generic IntegrationEventBus/dispatcher in this task.\n- Keep existing run/task behavior unchanged.\n\nReport back with changed files, test outcomes, and migration notes.",
  "acceptanceCriteria": [
    "Integration configs resolve correctly for channel/repo/tenant scopes with channel > repo > tenant precedence.",
    "Idempotency helper deterministically rejects duplicate keys.",
    "Persistence tables and typed accessors exist for integration configs, Jira mappings, and Slack thread bindings.",
    "Existing task/run orchestration behavior remains unchanged."
  ],
  "context": {
    "links": [],
    "notes": "P5 strict MVP. Sequential merge-to-main execution only."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## T2 Payload

```json
{
  "repoId": "<repoId>",
  "title": "T2 - Slack Ingress, Fast Ack, and Conversation Binding",
  "description": "Add Slack command/events/interactions endpoints with signature validation, quick ack, and task-centric thread binding.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_T1>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement Task 2 from docs/plans/current/p5-slack-jira-gitlab-mvp.md.\n\nHard gates:\n- Start from main.\n- Do not begin this task until T1 is merged to main.\n\nRequired outcomes:\n1. Add endpoints:\n   - POST /api/integrations/slack/commands\n   - POST /api/integrations/slack/events\n   - POST /api/integrations/slack/interactions\n2. Implement Slack signature verification and replay protection.\n3. Slash command endpoint must ack quickly; processing continues asynchronously.\n4. Bind Slack conversations to task/thread (not run-first):\n   - threadBindingId, taskId, channelId, threadTs, currentRunId, latestReviewRound\n5. Add button interaction handlers for:\n   - repo disambiguation\n   - approve rerun\n   - pause\n   - close\n6. Add tests for signatures, fast ack behavior, interactions, and thread binding lifecycle.\n\nConstraints:\n- Keep integration interfaces narrow.\n- No generic event bus/dispatcher.\n\nReport changed files and endpoint contract details.",
  "acceptanceCriteria": [
    "Valid slash command requests are acknowledged quickly and processed asynchronously.",
    "Invalid Slack signatures are rejected.",
    "Thread binding is task-centric and persists currentRunId/latestReviewRound.",
    "Interactions endpoint supports repo choice, approve rerun, pause, and close actions."
  ],
  "context": {
    "links": [],
    "notes": "T2 depends on T1. Keep status INBOX until T1 is merged."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## T3 Payload

```json
{
  "repoId": "<repoId>",
  "title": "T3 - Jira Read Adapter + Repo Resolution + Run Kickoff",
  "description": "Implement platform-side Jira read flow, repo resolution, and Slack-triggered task/run creation from main.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_T2>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement Task 3 from docs/plans/current/p5-slack-jira-gitlab-mvp.md.\n\nHard gates:\n- Start from main.\n- Do not begin this task until T2 is merged to main.\n\nRequired outcomes:\n1. Implement IssueSourceIntegration using Jira MCP in a deterministic platform-side service path.\n2. Normalize Jira issue payload into task context fields.\n3. Implement repo resolution from jira_project_repo_mappings:\n   - single mapping => auto-select\n   - multiple/none => ask via Slack interaction\n4. Create task and start run via existing APIs/orchestrator.\n5. Ensure created tasks/runs use:\n   - sourceRef = main\n   - llmAdapter = codex\n   - codexModel = gpt-5.3-codex-spark\n   - codexReasoningEffort = high\n6. Add timeout/retry behavior for Jira reads and clear Slack operator error messages.\n7. Add tests for single/multi/none mapping and Jira failure paths.\n\nConstraints:\n- Do not depend on launching an agent runtime just to read Jira.\n- Keep behavior deterministic with explicit timeout/retry policy.\n\nReport full flow trace: Slack command -> Jira load -> repo resolve -> task/run start.",
  "acceptanceCriteria": [
    "Slack command with a mapped Jira project creates a task and starts a run without dashboard interaction.",
    "Ambiguous or missing mapping is resolved through Slack interaction.",
    "Jira read failures are surfaced clearly and do not leave orphan runs.",
    "Run starts from main with codex spark high profile."
  ],
  "context": {
    "links": [],
    "notes": "T3 depends on T2. Strict merge-to-main gate."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## T4 Payload

```json
{
  "repoId": "<repoId>",
  "title": "T4 - Slack Timeline Updates + GitLab Review Feedback Mirror",
  "description": "Mirror run lifecycle and GitLab review feedback into Slack threads with signature-verified GitLab webhook ingress.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_T3>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement Task 4 from docs/plans/current/p5-slack-jira-gitlab-mvp.md.\n\nHard gates:\n- Start from main.\n- Do not begin this task until T3 is merged to main.\n\nRequired outcomes:\n1. Add endpoint: POST /api/integrations/gitlab/webhook\n2. Verify GitLab webhook secret/signature and dedupe repeated deliveries.\n3. Mirror existing run lifecycle milestones to Slack thread:\n   - queued, running, MR open, review pending, done, failed\n4. Normalize GitLab review feedback events and mirror to Slack thread with concise messages.\n5. Keep GitLab writes in existing SCM GitLab adapter boundary.\n6. Add tests for lifecycle message ordering, webhook dedupe, and feedback normalization.\n\nConstraints:\n- Do not split GitLab write behavior into a second write path.\n- Keep Slack updates clear and low-noise.\n\nReport event mapping table and changed webhook contracts.",
  "acceptanceCriteria": [
    "Operators can track run and review milestones in the same Slack thread.",
    "Duplicate GitLab webhook deliveries do not duplicate mirrored messages.",
    "GitLab write operations remain in the existing SCM adapter path.",
    "Lifecycle and feedback mirroring are covered by tests."
  ],
  "context": {
    "links": [],
    "notes": "T4 depends on T3. Strict merge-to-main gate."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## T5 Payload

```json
{
  "repoId": "<repoId>",
  "title": "T5 - Decision-Gated Rerun State Machine",
  "description": "Implement review-loop state machine with Slack-gated reruns and race-safe transitions.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_T4>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement Task 5 from docs/plans/current/p5-slack-jira-gitlab-mvp.md.\n\nHard gates:\n- Start from main.\n- Do not begin this task until T4 is merged to main.\n\nRequired outcomes:\n1. Add explicit loop states and transitions:\n   - QUEUED -> RUNNING -> MR_OPEN -> REVIEW_PENDING -> DECISION_REQUIRED -> RERUN_QUEUED -> RUNNING\n   - terminal: PAUSED | DONE | FAILED\n2. Implement Slack interaction actions:\n   - approve rerun\n   - pause\n   - close\n3. Approver policy for MVP: any channel member can approve.\n4. On approve, launch rerun through existing request-changes flow.\n5. Persist and increment review round while preserving same thread binding.\n6. Add concurrency guards and dedupe so multiple approvals cannot create duplicate reruns.\n7. Handle late feedback events deterministically.\n\nConstraints:\n- No rerun may start without explicit Slack approval.\n- Keep loop state transitions auditable.\n\nReport transition table and race-condition handling strategy.",
  "acceptanceCriteria": [
    "Reruns are always explicit Slack-approved actions.",
    "At most one rerun starts for concurrent approval attempts.",
    "Loop states persist and progress deterministically across rounds.",
    "Late feedback is handled without unintended reruns."
  ],
  "context": {
    "links": [],
    "notes": "T5 depends on T4. Strict merge-to-main gate."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

## T6 Payload

```json
{
  "repoId": "<repoId>",
  "title": "T6 - Hardening, Docs, and AgentsKanban Handoff",
  "description": "Finalize MVP with hardening, full-flow tests, documentation updates, and handoff artifacts.",
  "sourceRef": "main",
  "dependencies": [
    {
      "upstreamTaskId": "<taskId_T5>",
      "mode": "review_ready",
      "primary": true
    }
  ],
  "taskPrompt": "Implement Task 6 from docs/plans/current/p5-slack-jira-gitlab-mvp.md.\n\nHard gates:\n- Start from main.\n- Do not begin this task until T5 is merged to main.\n\nRequired outcomes:\n1. Add hardening and reliability checks for Slack/GitLab ingress and idempotency paths.\n2. Add end-to-end integration coverage for:\n   - slash command -> Jira load -> repo resolve -> task/run -> MR -> review feedback -> approve rerun\n3. Update docs:\n   - README.md\n   - docs/features-and-api.md\n   - docs/local-testing.md\n   - add docs/integrations/slack-jira-gitlab-mvp.md\n4. Produce final handoff notes for operators and agents.\n\nConstraints:\n- Keep MVP scope strict; no generic event bus/dispatcher expansion.\n- Validate that operators can execute full loop from Slack without dashboard usage for day-to-day flow.\n\nReport final checklist, known limitations, and next-phase defer list.",
  "acceptanceCriteria": [
    "End-to-end Slack-driven MVP flow is documented and test-covered.",
    "Integration endpoints and operational setup docs are complete.",
    "Known MVP limitations and deferred items are explicitly documented.",
    "Handoff artifacts are ready for AgentsKanban execution and operator use."
  ],
  "context": {
    "links": [],
    "notes": "T6 depends on T5. Finalization task."
  },
  "status": "INBOX",
  "llmAdapter": "codex",
  "codexModel": "gpt-5.3-codex-spark",
  "codexReasoningEffort": "high"
}
```

