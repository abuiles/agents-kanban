# Stage: Slack + Jira + GitLab Operator Loop (Strict MVP)

**Status:** Planned

## Goal

Deliver a strict MVP where teams operate from Slack without needing the dashboard for daily execution:

1. Slack command starts work (`/kanvy fix AFCP-1234`)
2. Jira issue is read (read-only) for task context
3. Repo is resolved from Jira project mapping (or user disambiguation)
4. AgentsKanban run executes from `main`, opens GitLab MR
5. GitLab review feedback is mirrored into Slack
6. Slack approval controls whether another fix round starts

This plan intentionally prioritizes a working vertical slice over a generalized plugin platform.

## Product Decisions (Locked)

1. Slack is the primary interaction surface.
2. Jira integration is read-only for MVP.
3. GitLab is the only review provider in MVP.
4. Reruns require explicit Slack approval.
5. Approver policy for MVP: any Slack channel member can approve.
6. Configuration precedence is `channel > repo > tenant`.
7. GitLab writes remain in the existing SCM GitLab adapter.
8. Use narrow integration interfaces, not a universal plugin capability bus in MVP.

## Execution Policy for This 6-Task Plan (Locked)

1. Every task starts from `main`.
2. Do not start Task N+1 until Task N is merged to `main`.
3. No parallel task execution.
4. Each task PR must include migration notes and rollback notes.
5. Task execution profile for AgentsKanban:
   - `llmAdapter = codex`
   - `codexModel = gpt-5.3-codex-spark`
   - `codexReasoningEffort = high`

## MVP Architecture Boundaries

### Keep minimal framework

- `IntegrationRegistry` only
- three typed seams:
  - `TriggerIntegration` (Slack ingress/interactions)
  - `IssueSourceIntegration` (Jira read)
  - `ReviewIntegration` (GitLab webhook feedback normalization)

### Reuse existing systems

- existing run/task lifecycle events in `RepoBoardDO`
- existing run orchestrator for execution/retry/request-changes
- existing GitLab SCM adapter for MR comments and metadata writes

### Defer from MVP

- generic integration event bus/dispatcher
- universal plugin capability model
- full self-serve integration UI
- multi-provider review support (GitHub later)

## Public API Contract (Target)

### Add

- `POST /api/integrations/slack/commands`
- `POST /api/integrations/slack/events`
- `POST /api/integrations/slack/interactions`
- `POST /api/integrations/gitlab/webhook`
- `GET /api/integrations/config`
- `POST /api/integrations/config`
- `PATCH /api/integrations/config/:id`
- `GET /api/integrations/mappings/jira-project-repos`
- `POST /api/integrations/mappings/jira-project-repos`

### Keep unchanged

- existing repo/task/run APIs, including:
  - `POST /api/tasks`
  - `POST /api/tasks/:taskId/run`
  - `POST /api/runs/:runId/request-changes`
  - run events/logs/artifacts endpoints

## Data Model Additions (Target)

1. `integration_configs`
   - `id`, `tenant_id`, `scope_type`, `scope_id`, `plugin_kind`, `enabled`, `settings_json`, `secret_ref`, timestamps
2. `jira_project_repo_mappings`
   - `id`, `tenant_id`, `jira_project_key`, `repo_id`, `priority`, `active`, timestamps
3. `slack_thread_bindings`
   - `id`, `tenant_id`, `task_id`, `channel_id`, `thread_ts`, `current_run_id`, `latest_review_round`, timestamps
4. task/run metadata extension for loop state
   - `loopState`: `QUEUED | RUNNING | MR_OPEN | REVIEW_PENDING | DECISION_REQUIRED | RERUN_QUEUED | PAUSED | DONE | FAILED`

## 6-Task Execution Plan (Strictly Sequential)

### Task 1: Integration Foundation + Persistence

**Start branch:** `main`  
**Merge gate:** must be merged before Task 2 starts

**Scope**

1. Create MVP integration registry and typed interfaces.
2. Add persistence for integration config, Jira project mapping, and Slack thread bindings.
3. Add config precedence resolver (`channel > repo > tenant`).
4. Add shared idempotency utility for webhook/event dedupe keys.

**Implementation details**

1. Add server modules for:
   - integration registry
   - config loader and precedence resolver
   - idempotency key tracking
2. Add migration(s) for three tables above.
3. Add lightweight repository helpers for CRUD operations.

**Deliverables**

1. Integration registry available to router/orchestrator.
2. DB tables and typed access functions.
3. Unit-tested precedence resolution.

**Tests**

1. precedence resolution tests
2. idempotency key dedupe tests
3. table CRUD tests

**Acceptance criteria**

1. Integration configs can be resolved for tenant/repo/channel scopes.
2. Idempotency helper rejects duplicate event keys deterministically.
3. No behavior change in existing task/run flows.

---

### Task 2: Slack Ingress + Fast Ack + Conversation Binding

**Start branch:** `main`  
**Merge gate:** must be merged before Task 3 starts

**Scope**

1. Add Slack command/events/interactions endpoints.
2. Implement Slack signature validation.
3. Ensure slash command endpoint acks quickly and defers processing async.
4. Bind Slack thread to task conversation (task-centric, not run-centric).
5. Implement interaction handlers for:
   - repo disambiguation
   - approve rerun
   - pause
   - close

**Implementation details**

1. Router additions for new Slack endpoints.
2. Slack service for:
   - signature verification
   - command parser (`/kanvy fix <JIRA_KEY>`)
   - thread posting helpers
3. Create/update `slack_thread_bindings` on first command.
4. Store and resolve interaction context tokens safely.

**Deliverables**

1. Working slash command ingress with immediate ack.
2. Thread-based conversation state saved and retrievable.
3. Button interaction flow scaffolded.

**Tests**

1. signature verification pass/fail
2. slash command parsing and fast-ack behavior
3. interaction payload validation and replay protection
4. thread binding lifecycle tests

**Acceptance criteria**

1. `/kanvy fix AFCP-1234` creates/updates a thread binding and returns immediate ack.
2. Invalid Slack signatures are rejected.
3. Interaction callbacks can update conversation state safely.

---

### Task 3: Jira Read Adapter + Repo Resolution + Task/Run Kickoff

**Start branch:** `main`  
**Merge gate:** must be merged before Task 4 starts

**Scope**

1. Implement `IssueSourceIntegration` via Jira MCP (platform-side deterministic call path).
2. Normalize Jira issue payload into task context.
3. Resolve repo from `jira_project_repo_mappings`.
4. If ambiguous/missing mapping, request repo choice in Slack interaction.
5. Create task and start run using existing APIs/orchestration from `main`.

**Implementation details**

1. Jira adapter with timeout/retry policy and normalized output schema.
2. Repo resolver:
   - single mapping -> auto-select
   - multiple/none -> interaction prompt
3. Task creation payload should include:
   - issue key in title/context
   - issue summary/description in prompt context
   - `sourceRef = main`
   - model config set to `gpt-5.3-codex-spark` + `high`
4. Trigger run start after task creation.

**Deliverables**

1. End-to-end Slack command -> Jira load -> repo resolve -> task/run start.
2. Deterministic fallback for ambiguous repo mapping.

**Tests**

1. Jira adapter timeout/retry and error mapping
2. repo resolver single/multi/none paths
3. task/run creation integration tests from Slack trigger

**Acceptance criteria**

1. Known Jira project key with one mapping starts a run without dashboard action.
2. Ambiguous repo mapping is resolved via Slack interaction.
3. Jira failures return operator-readable Slack error and no orphan run.

---

### Task 4: Slack Status Timeline + GitLab Review Feedback Mirror

**Start branch:** `main`  
**Merge gate:** must be merged before Task 5 starts

**Scope**

1. Mirror run lifecycle milestones to Slack thread.
2. Add GitLab webhook ingestion endpoint with verification + dedupe.
3. Normalize GitLab review feedback events.
4. Mirror feedback into Slack thread with concise summaries.
5. Keep GitLab write actions inside existing SCM GitLab adapter.

**Implementation details**

1. Subscribe to existing run/task state transitions and post Slack updates for:
   - queued
   - running
   - MR open
   - review pending
   - done/failed
2. Webhook handler parses relevant MR note/review events.
3. State transitions to `REVIEW_PENDING` and `DECISION_REQUIRED` when applicable.

**Deliverables**

1. End-to-end timeline updates in Slack thread.
2. GitLab feedback mirrored to Slack with dedupe.

**Tests**

1. run lifecycle -> Slack message ordering tests
2. webhook signature + dedupe tests
3. feedback normalization tests

**Acceptance criteria**

1. Operators can follow run and review status entirely in Slack thread.
2. Duplicate GitLab webhook deliveries do not duplicate Slack messages.
3. GitLab comment posting behavior remains adapter-owned.

---

### Task 5: Decision-Gated Rerun State Machine

**Start branch:** `main`  
**Merge gate:** must be merged before Task 6 starts

**Scope**

1. Implement review-loop state machine:
   - `QUEUED -> RUNNING -> MR_OPEN -> REVIEW_PENDING -> DECISION_REQUIRED -> RERUN_QUEUED -> RUNNING`
   - terminal: `PAUSED | DONE | FAILED`
2. Handle Slack interaction decisions:
   - approve rerun
   - pause
   - close
3. Launch rerun via existing `request-changes` flow when approved.
4. Increment review round tracking and keep same Slack thread.

**Implementation details**

1. Persist loop state on run/task metadata.
2. Concurrency guard: only one active decision transition at a time.
3. Late feedback handling:
   - attach to current round
   - do not auto-trigger rerun without new approval

**Deliverables**

1. Reliable decision-gated rerun loop.
2. Slack buttons drive state transitions deterministically.

**Tests**

1. state machine transition tests
2. concurrent approvals/race tests
3. late webhook event handling tests

**Acceptance criteria**

1. No rerun starts without explicit Slack approval.
2. Multiple near-simultaneous approvals cause at most one rerun.
3. Thread remains the single operator surface across rounds.

---

### Task 6: Hardening, Docs, and AgentsKanban Handoff Pack

**Start branch:** `main`  
**Merge gate:** final task

**Scope**

1. Add operator-facing docs for setup and operation.
2. Add rollout checklist and failure playbooks.
3. Add end-to-end regression coverage for MVP flow.
4. Produce 6-task handoff pack for AgentsKanban execution with strict sequencing notes.

**Documentation updates**

1. `docs/features-and-api.md` (new integration endpoints and states)
2. `README.md` (Slack/Jira/GitLab MVP capability + setup references)
3. `docs/local-testing.md` (local webhook testing + interaction flows)
4. new ops guide: `docs/integrations/slack-jira-gitlab-mvp.md`

**Handoff pack contents**

1. task titles, prompts, acceptance criteria, dependencies
2. model config standard:
   - `codex`
   - `gpt-5.3-codex-spark`
   - `high`
3. rule reminder:
   - each task starts from `main`
   - start next task only after previous is merged to `main`

**Tests**

1. full integration scenario test:
   - slash command -> run -> MR -> review feedback -> approval -> rerun
2. auth/security checks for webhook verification
3. failure-path tests for Jira timeout, Slack post failure, webhook replay

**Acceptance criteria**

1. Docs are sufficient for another engineer to deploy and operate MVP.
2. Full vertical flow is covered by automated tests.
3. Handoff artifacts are ready to create AgentsKanban tasks without additional design work.

## Dependency Graph (Strict Serial)

- **Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6**

No exceptions.

## Final MVP Acceptance Criteria

1. A user can trigger work from Slack with a Jira key.
2. Jira context is loaded and used to create a run from `main`.
3. GitLab MR review feedback is mirrored into the same Slack thread.
4. Reruns are explicitly user-approved from Slack interactions.
5. Operators can execute the full loop without opening the dashboard.
6. Every task in this plan can be executed in AgentsKanban with strict merge-to-main sequencing.
