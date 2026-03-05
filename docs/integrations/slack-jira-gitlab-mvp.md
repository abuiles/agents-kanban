# Slack + Jira + GitLab MVP Runbook and Handoff

This document is the operator and agent handoff artifact for the P5 MVP vertical slice.

## Scope

In scope (MVP):

- Slack-triggered task start from Jira key (`/kanvy fix <JIRA_KEY>`)
- Slack slash help response (`/kanvy help`) with concise usage examples
- Slack free-text intake (`/kanvy <request>`) with in-thread clarification loop
- Jira issue load and repo resolution (mapping and disambiguation)
- Task/run start from `main`
- GitLab MR lifecycle and feedback mirrored to Slack thread
- Decision-gated rerun with Slack `approve_rerun`
- Thread binding continuity across rounds

Out of scope (this phase):

- Generic plugin/event-bus expansion
- Multi-provider policy engines
- Dashboard-first operation requirements for day-to-day run loop

## Required configuration

1. Secrets / tokens
   - `slack/signing-secret`
   - `slack/bot-token` (or tenant-scoped bot token secret)
   - `gitlab/webhook-secret`
   - `JIRA_TOKEN`
   - `GITLAB_TOKEN`
   - `OPENAI_API_KEY`
2. Tenant mapping
   - Jira project key -> repo mapping must exist for auto-start.
3. Webhook endpoints
   - Slack commands: `POST /api/integrations/slack/commands`
   - Slack events: `POST /api/integrations/slack/events`
   - Slack interactions: `POST /api/integrations/slack/interactions`
   - GitLab webhook: `POST /api/integrations/gitlab/webhook`

## Operator day-to-day flow (no dashboard required)

1. In Slack, run `/kanvy fix ABC-123` for deterministic Jira flow, or `/kanvy <free-text request>` from channel or thread.
2. Add extra task context directly in the command when needed, including execution overrides such as `/kanvy fix ABC-123 use codex 5.3 medium include rollback notes in the task`.
3. Use the same pattern for review tasks, for example `/kanvy review 1234 use claude sonnet medium focus on auth regressions`.
4. If no per-task override is provided, the task uses the repo's default task execution settings (`LLM adapter`, `LLM model`, `Reasoning effort`) from repo settings.
5. If free-text starts in channel (non-thread), the system posts a thread kickoff and sends an ephemeral handoff link; continue clarification in that thread.
6. For free-text flow, answer clarifying questions in the same thread (max 4 turns before structured handoff prompt).
7. For usage guidance, run `/kanvy help`.
8. If multiple repo mappings are available, click a repo disambiguation button (Jira flow) or reply with repo id (free-text flow).
9. Monitor status and MR feedback in the same Slack thread.
10. When feedback arrives and run enters `DECISION_REQUIRED`, click `Approve rerun`.
11. Continue the thread loop until `DONE`, `PAUSED`, or `FAILED`.

## Reliability and hardening behavior

Ingress checks:

- Slack requests:
  - HMAC signature verification
  - replay window + replay cache checks
  - duplicate slash command delivery suppression
  - duplicate interaction delivery suppression
- GitLab webhooks:
  - webhook token verification
  - strict JSON parse with `400 BAD_REQUEST` on malformed bodies
  - delivery idempotency and per-thread feedback dedupe

State and idempotency checks:

- Rerun starts only from `DECISION_REQUIRED`.
- Concurrent/duplicate approvals do not create duplicate reruns.
- Late feedback remains deterministic via loop-state and dedupe keys.

## Loop-state reference

1. `QUEUED -> RUNNING -> MR_OPEN -> REVIEW_PENDING -> DECISION_REQUIRED`
2. `DECISION_REQUIRED -> RERUN_QUEUED -> RUNNING` (on Slack approval)
3. Terminal: `PAUSED | DONE | FAILED`

## Failure playbook

1. Jira lookup failure
   - Symptom: slash command ack succeeds but follow-up reports Jira fetch failure.
   - Operator action: verify `JIRA_TOKEN`, issue key, Jira reachability.
   - Logs: inspect structured `slack_command_lifecycle` checkpoints (`jira_fetch_started`, `jira_fetch_failed`) including Jira host/path, category, and sanitized message.
2. Missing repo mapping
   - Symptom: disambiguation or no-mapping message in Slack.
   - Operator action: add/enable Jira project -> repo mapping.
3. GitLab webhook failures
   - Symptom: no review feedback in Slack thread.
   - Operator action: verify webhook secret and project path mapping.
4. Slack posting failures
   - Symptom: no mirrored feedback/status messages.
   - Operator action: verify Slack bot token/config; run-state progression still continues.

## Final checklist (T6)

- [x] Slack/GitLab ingress hardening and idempotency checks are implemented.
- [x] End-to-end automated coverage includes:
  - slash command -> Jira load -> repo resolve -> task/run -> MR -> feedback -> approve rerun.
- [x] Operator docs updated in `README.md`, `docs/features-and-api.md`, and `docs/local-testing.md`.
- [x] Dedicated MVP integration runbook and handoff document added.
- [x] Day-to-day loop validated as Slack-first (no dashboard required for normal operation).

## Known MVP limitations

- Slack feedback and timeline posting are best-effort; webhook processing does not fail when Slack posting fails.
- Slash-command dedupe window may suppress immediate repeated identical commands in a short interval.
- GitLab run mapping depends on project path + review number correlation to existing runs.
- Approver policy is channel-member level for MVP (no fine-grained approver ACL).

## Deferred to next phase

1. Durable idempotency ledger with stronger atomic guarantees than KV get/put races.
2. Explicit dead-letter and retry queues for webhook processing.
3. Rich operator policy/authorization for rerun approvals.
4. Replay/audit endpoint for integration event processing traces.
5. Optional dashboard observability overlays for integration state.

## AgentsKanban handoff notes

Execution sequencing for task pack remains strict:

1. T1 -> T2 -> T3 -> T4 -> T5 -> T6
2. Every task starts from `main`.
3. Start the next task only after prior task is merged to `main`.

Model config standard for task creation:

- Task defaults come from the repo settings fields `LLM adapter`, `LLM model`, and `Reasoning effort`.
- The task form can override those values per task without mutating the repo defaults.
- Slack can override those values per task with natural-language command text such as `use codex 5.3 medium`.
- If neither task nor repo specifies values, the final fallback remains `codex` / `gpt-5.1-codex-mini` / `medium`.
