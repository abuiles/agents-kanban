# Stage: Slack Free-Text Intent Intake + Model-Selectable Parser (One-Shot Execution)

**Status:** Implemented

## Goal

Evolve Slack from rigid Jira-only parsing into a smart intake surface where users can write natural requests in `/kanvy ...`, and the system can:

1. resolve deterministic Jira requests immediately,
2. parse free-text intent with a cheap model,
3. ask clarifying follow-ups in-thread when needed,
4. auto-create and run tasks once intent is complete.

Primary outcome:

- Slack becomes a true day-to-day control plane without requiring dashboard interaction for common task creation.

## Product Decisions (Locked)

1. Slash command accepts free text (`/kanvy <anything>`).
2. Deterministic fast-path remains for Jira pattern:
   - `fix <JIRA_KEY>`
3. V1 intents:
   - `fix_jira`
   - `create_task`
4. If intent parse is high-confidence and complete, task is auto-created.
5. Clarification loop max turns:
   - `4` assistant clarification turns, then explicit handoff prompt.
6. Intake model selection is configurable with precedence:
   - `channel > repo > tenant`
7. Codex/OpenAI intake default model:
   - `gpt-5.1-codex-mini` unless overridden by scoped config.

## Scope

### In scope

1. Free-text slash command intake behavior.
2. LLM-backed intent parser for non-fast-path inputs.
3. Thread-scoped clarification loop with persisted intake session state.
4. Auto-create task/run when required fields are complete.
5. Scoped intake model configuration and defaults.
6. Slack docs/plans updates.

### Out of scope

1. Generic plugin framework expansion.
2. New non-codex intent parser backends.
3. Free-text control actions (pause/close/rerun) in V1.

## Architecture and Data Contracts

## 1) Ingress behavior

`POST /api/integrations/slack/commands`:

1. verify signature + replay + dedupe (existing behavior),
2. parse slash command text:
   - empty -> return help,
   - Jira fast-path (`fix KEY-123`) -> existing deterministic Jira flow,
   - otherwise -> intent parser flow.

## 2) Clarification continuation

`POST /api/integrations/slack/events`:

1. continue supporting `url_verification`,
2. handle thread replies for active intake sessions,
3. dedupe by provider event identity.

## 3) Session persistence

Add `slack_intake_sessions` persistence:

1. key identity: `tenant_id + channel_id + thread_ts`,
2. lifecycle: `active | completed | cancelled | expired`,
3. data payload:
   - normalized intent fields,
   - unresolved/missing fields,
   - turn count,
   - last parser confidence.

## 4) Intent parser contract (strict JSON)

Normalized parse output:

1. `intent`: `fix_jira | create_task | unknown`
2. `confidence`: number in `[0,1]`
3. optional fields:
   - `jiraKey`
   - `repoHint` or `repoId`
   - `taskTitle`
   - `taskPrompt`
   - `acceptanceCriteria[]`
4. `missingFields[]`
5. `clarifyingQuestion`

## 5) Completion policy

Auto-create when:

1. `confidence >= 0.80`,
2. required fields are complete for selected intent,
3. auto-create setting is enabled.

Otherwise:

1. ask one targeted clarification question in-thread,
2. persist updated session state,
3. enforce max-turn rule.

## 6) Repo resolution for generic tasks

Resolution order:

1. explicit repo from user/parser,
2. scoped Slack config `defaultRepoId`,
3. single enabled repo in tenant (auto-select),
4. Slack disambiguation action.

## 7) Intake model config (scoped)

Extend Slack integration settings (existing `integration_configs` path):

1. `intentEnabled` (default `true`)
2. `intentModel` (default `gpt-5.1-codex-mini`)
3. `intentReasoningEffort` (default `low`)
4. `intentAutoCreate` (default `true`)
5. `intentClarifyMaxTurns` (default `4`)
6. `defaultRepoId` (optional)

## 8) Task creation defaults

For generic intent-created tasks:

1. `sourceRef = main`
2. `llmAdapter = codex`
3. `codexModel = gpt-5.1-codex-mini` (unless explicit override)
4. `codexReasoningEffort = medium`

For Jira fast-path:

1. preserve deterministic Jira task construction,
2. update default model to `gpt-5.1-codex-mini` unless explicit override is provided by scoped config.

## Public API / Type Changes

1. Extend Slack parsing/types to support free-text payloads.
2. Add new intake session type definitions.
3. Add new interaction actions:
   - `intent_repo_select`
   - `intent_confirm_create`
   - `intent_cancel`
4. Add DB helpers for intake session CRUD + expiry handling.

## Reliability, Safety, and Failure Handling

1. Duplicate ingress protection must prevent duplicate task/run creation.
2. If parser fails or times out:
   - ask user for structured restatement (repo + goal + acceptance criteria),
   - keep session active unless max-turn reached.
3. If repo cannot be resolved:
   - do not create task,
   - force disambiguation.
4. Session expiry:
   - expire after 24h inactivity.

## Testing and Acceptance

## Unit tests

1. Free-text slash parsing and backward-compatible Jira parsing.
2. Intent output validation and confidence threshold logic.
3. Config precedence (`channel > repo > tenant`) for intake model settings.
4. Clarification turn counter + max-turn handoff behavior.

## Integration tests

1. `/kanvy fix AFCP-1234` still triggers existing Jira deterministic flow.
2. `/kanvy draft MR for README improvements`:
   - asks follow-up if repo missing,
   - creates task/run once repo provided.
3. Duplicate slash/event deliveries do not create duplicate tasks.

## Release acceptance criteria

1. Existing Jira fast-path remains stable (no regressions).
2. Free-text command can produce tasks with clarification loop.
3. Model selection works with scoped precedence and sane defaults.
4. Slack docs/plans are updated.

## Implementation constraints

1. Start from `main`.
2. One-shot execution in a single task/PR.
3. PR description must include:
   - Objective
   - Scope
   - Behavior changes
   - API/type changes
   - Backward compatibility
   - Manual QA
   - Risks/Rollback
   - Deferred follow-ups
