# Stage: GitHub Auto-Review Provider (Dogfooding for AgentsKanban)

**Status:** Planned

## Goal

Extend the existing auto-review flow to support **GitHub** as a first-class provider so AgentsKanban can dogfood auto-review on its own GitHub PR workflow.

Core outcomes:

1. Repo auto-review can target `github` in addition to existing `gitlab` and `jira`.
2. Provider defaulting is SCM-aware (GitHub repos default to GitHub provider).
3. Review findings post to GitHub with inline+summary fallback behavior.
4. GitHub replies are available for selective request-changes context.
5. GitHub webhook ingestion is supported with verification and idempotency.
6. Existing GitLab and Jira behavior remains backward compatible.

---

## Product Decisions (Locked)

1. **Scope:** Add GitHub provider support without removing GitLab/Jira support.
2. **Posting mode:** GitHub uses inline comment when location is available, otherwise summary fallback.
3. **Reply context:** use webhook ingestion + on-demand fetch fallback.
4. **Provider default policy:** if `autoReview.enabled=true` and provider omitted:
   - `repo.scmProvider='github'` => default `provider='github'`
   - `repo.scmProvider='gitlab'` => default `provider='gitlab'`
5. **Trigger semantics unchanged:** auto-review runs when run reaches review context; manual rerun endpoint remains supported.
6. **Execution policy:** tasks start from `main` and run sequentially (G1 -> G5), merge-gated.
7. **PR quality bar:** every task PR must include a detailed description with explicit sections.

---

## Scope

### In scope

1. `AutoReviewProvider` extension to include `github`.
2. Validation/defaulting updates for repo/task auto-review config.
3. GitHub review-posting adapter implementation.
4. GitHub webhook ingress endpoint + verification + dedupe.
5. Reply-context ingestion/merge for request-changes.
6. Docs + local QA flow for GitHub auto-review dogfooding.

### Out of scope

1. New generic integration event bus/dispatcher.
2. Replacing existing GitLab/Jira adapter behavior.
3. New UI design system work beyond provider option/additional operator visibility.

---

## Public API and Type Changes

## 1) Domain model updates

1. Extend `AutoReviewProvider`:
   - from: `'gitlab' | 'jira'`
   - to: `'github' | 'gitlab' | 'jira'`
2. Keep existing task-level controls:
   - `Task.uiMeta.autoReviewMode = inherit | on | off`
   - `Task.uiMeta.autoReviewPrompt`
3. Keep existing repo-level controls:
   - `Repo.autoReview = { enabled, provider, prompt?, postInline }`

## 2) Validation/defaulting updates

For repo create/update payload parsing:

1. If `autoReview.enabled=false`, provider is ignored for execution but still validated if provided.
2. If `autoReview.enabled=true` and `provider` omitted, set default by `repo.scmProvider`:
   - GitHub repo -> `github`
   - GitLab repo -> `gitlab`
3. Existing explicit provider values remain valid (`github`, `gitlab`, `jira`).
4. Backward compatibility: existing payloads without `provider` still accepted and defaulted deterministically.

## 3) New endpoint

Add:

1. `POST /api/integrations/github/webhook`

Contract expectations:

1. Verify webhook signature using shared secret.
2. Use delivery-id dedupe to avoid duplicate ingestion.
3. Normalize review/comment events relevant for reply context.
4. Return deterministic status payloads (accepted/duplicate/ignored/invalid).

---

## Architecture and Data Flow

## 1) Review posting path

`run-orchestrator` -> `review-posting registry` -> provider adapter (`github`).

Steps:

1. Resolve effective auto-review config.
2. Build review findings artifact.
3. Post findings to provider adapter.
4. Persist posting metadata back on run (`providerThreadId`, URLs, status/errors).

## 2) GitHub posting rules

Per finding:

1. Attempt inline PR comment if location and diff context are resolvable.
2. If inline is unavailable, include in summary PR comment.
3. Stamp marker metadata (finding and run marker) for idempotent lookup.
4. On retries, detect existing marker comments and reuse instead of reposting.

## 3) Reply context path

At request-changes time:

1. Load reply context from webhook-ingested store (if present).
2. Fetch on-demand provider replies (fallback/consistency path).
3. Merge + dedupe replies by `findingId`.
4. Inject selected reply context into change request prompt when `includeReplies=true`.

## 4) Webhook ingestion path

`/api/integrations/github/webhook` -> verification -> idempotency -> normalization -> store reply context hints.

Supported event families for MVP:

1. Pull request review comments.
2. PR review submissions/comments that include marker-bearing content.

Non-goals for webhook path:

1. Driving full run state machine transitions (focus is reply context ingestion).
2. Replacing on-demand fetch.

---

## Failure Modes and Handling

1. Missing `GITHUB_TOKEN` for github provider posting:
   - do not crash full run pipeline;
   - mark provider posting errors in run metadata;
   - emit actionable log/timeline notes.
2. GitHub webhook signature invalid:
   - reject with `401`/`403` and no side effects.
3. Duplicate webhook deliveries:
   - return duplicate status and no duplicate ingestion.
4. Provider API transient errors:
   - bounded retries with clear terminal error message.
5. Reply context merge conflict/duplicates:
   - dedupe by stable key (`findingId` + normalized body).

---

## Testing Plan

## Unit tests

1. Validation/defaulting tests for `AutoReviewProvider='github'` and SCM-aware defaults.
2. GitHub posting adapter tests:
   - inline success
   - summary fallback
   - marker idempotency reuse
   - retry without duplicate comments
3. GitHub webhook verification and dedupe tests.
4. Reply context merge tests (webhook + fetch fallback).

## Integration tests

1. Orchestrator path with `provider='github'` posting flow.
2. Request-changes with selection modes and `includeReplies=true`.
3. Backward compatibility for existing GitLab/Jira providers.

## Non-regression tests

1. Existing auto-review tests for GitLab/Jira remain passing.
2. Existing request-changes legacy payload `{ prompt }` still works.

---

## Manual QA (Dogfood) Checklist

1. Configure an AgentsKanban GitHub repo with `autoReview.enabled=true` and no explicit provider.
2. Verify effective provider resolves to `github`.
3. Run task to PR-open state and confirm review findings are posted.
4. Verify at least one finding is inline and one fallback summary entry is posted.
5. Reply in GitHub to finding comments.
6. Trigger request-changes with reply inclusion.
7. Confirm generated follow-up prompt includes mapped reply context.
8. Replay the same webhook delivery and confirm duplicate handling.
9. Re-run review and confirm idempotent posting (no duplicated finding comments).

---

## Setup Instructions (GitHub Auto-Review)

## 1) Required secrets

1. `GITHUB_TOKEN` with repo write access to PR comments/reviews.
2. `github/webhook-secret` in secrets KV for webhook signature verification.

## 2) Repo config

1. Set `repo.scmProvider='github'`.
2. Set `repo.autoReview.enabled=true`.
3. Optional: set `repo.autoReview.provider='github'` explicitly (otherwise SCM-aware default applies).
4. Optional: set `repo.autoReview.prompt` and `postInline=true`.

## 3) GitHub app/webhook setup

1. Add webhook target: `POST /api/integrations/github/webhook`.
2. Subscribe to PR review/comment events.
3. Use the same webhook secret as `github/webhook-secret`.

## 4) Operator flow

1. Start run from task.
2. Let auto-review post findings to PR.
3. Developer replies on PR comments.
4. Operator triggers request-changes and chooses inclusion mode.
5. Follow-up run uses reply-aware context.

---

## 5-Task Execution Plan (Sequential)

### G1 — GitHub Provider Contract and SCM-Aware Defaults

Scope:

1. Extend provider union and parser validation for `github`.
2. Implement SCM-aware default provider behavior.
3. Keep compatibility for existing payloads.
4. Add validation tests.

Acceptance:

1. GitHub provider is accepted and persisted.
2. Enabled auto-review defaults to provider by SCM when omitted.
3. Existing clients remain compatible.

---

### G2 — GitHub Review Posting Adapter (Inline + Summary Fallback)

Scope:

1. Add `GitHubReviewPostingAdapter` and registry wiring.
2. Implement inline posting with summary fallback.
3. Implement marker-based idempotent upsert behavior.
4. Add adapter tests.

Acceptance:

1. Findings post to GitHub PR with correct fallback.
2. Retries do not duplicate finding posts.
3. Posting metadata is persisted per finding.

---

### G3 — Orchestrator Wiring and Credential Handling for GitHub Provider

Scope:

1. Wire provider selection + credential resolution for `github`.
2. Ensure run metadata/timeline captures posting outcomes and errors.
3. Add orchestrator tests for enabled/disabled/missing-token cases.

Acceptance:

1. Auto-review with `provider='github'` executes through posting flow.
2. Missing token fails gracefully with actionable metadata.
3. Existing GitLab/Jira orchestrator behavior remains stable.

---

### G4 — GitHub Webhook Ingestion, Verification, and Reply Context Store

Scope:

1. Add `POST /api/integrations/github/webhook`.
2. Implement signature verification and delivery dedupe.
3. Normalize comment/review replies with marker extraction.
4. Persist reply context hints for request-changes enrichment.
5. Add webhook tests.

Acceptance:

1. Valid webhooks ingest reply context.
2. Invalid signatures rejected.
3. Duplicate deliveries ignored deterministically.

---

### G5 — Reply Context Merge, Request-Changes Enrichment, Docs, and Dogfood QA

Scope:

1. Merge webhook-ingested and on-demand reply contexts.
2. Integrate merged context into request-changes prompt composition.
3. Update docs and add local testing instructions.
4. Add end-to-end tests across review posting + request-changes.

Acceptance:

1. Request-changes reliably includes selected GitHub reply context.
2. Docs cover setup and QA for GitHub auto-review.
3. End-to-end dogfood path is validated.

---

## PR Description Requirement (for every G task)

Every PR must include:

1. **Objective**
2. **Scope** (files/components changed)
3. **Behavior changes**
4. **API/type changes**
5. **Backward compatibility notes**
6. **Manual QA steps run**
7. **Risks and rollback**
8. **Follow-ups explicitly deferred**

This requirement is mandatory in each task prompt and acceptance checklist.
