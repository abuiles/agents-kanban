# Stage: Auto Review + Selective Change Loop

**Status:** Planned

## Goal

Add an automatic review stage for runs that reach `REVIEW`, with configurable behavior at repo and task level, and a tight follow-up loop for applying requested fixes.

Core outcomes:

1. Auto-review can be enabled at repo level and overridden at task level.
2. Task setting takes precedence over repo setting.
3. Review execution can use model-native review behavior or custom prompts.
4. Review findings are persisted as run artifacts.
5. Findings are posted to the configured review provider (`gitlab` or `jira`).
6. Request changes can address all findings or a selected subset.
7. Provider comment replies are pulled in as additional context for change requests.
8. Operators can manually re-run review for an existing review run.

## Product Decisions (Locked)

1. Repo-level toggle: `autoReview.enabled` (`on/off`).
2. Task-level mode: `autoReviewMode = inherit | on | off` (task precedence).
3. Prompt precedence:
   - task custom review prompt
   - repo custom review prompt
   - model-native review mode
4. Auto-review trigger:
   - automatic when run enters task status `REVIEW`
   - manual re-run via explicit action button/API
5. Change requests remain explicit/manual (no automatic fix run immediately after review).
6. Review sink provider is configurable per repo:
   - `gitlab` (inline MR notes)
   - `jira` (issue comments with file/line references in structured text)
7. Every task in this implementation phase starts from `main` and is merge-gated sequentially.

## Execution Policy for This 6-Task Plan (Locked)

1. Every implementation task starts from `main`.
2. Do not start Task N+1 until Task N is merged to `main`.
3. No parallel feature tasks.
4. Each task PR includes:
   - behavior summary
   - migration/compat notes
   - rollback notes
5. Task execution profile for AgentsKanban:
   - `llmAdapter = codex`
   - `codexModel = gpt-5.3-codex-spark`
   - `codexReasoningEffort = high`

## Public API Contract (Target)

### Repo config changes

Extend repo create/update payloads and model:

- `autoReview`:  
  - `enabled: boolean`  
  - `prompt?: string`  
  - `provider: 'gitlab' | 'jira'`  
  - `postInline: boolean` (effective for GitLab; Jira ignores and posts issue comments)

### Task config changes

Extend task create/update payloads and `uiMeta`:

- `autoReviewMode?: 'inherit' | 'on' | 'off'`
- `autoReviewPrompt?: string`

### Run actions

1. Add `POST /api/runs/:runId/review`
   - manually re-runs review analysis for that run context
2. Extend `POST /api/runs/:runId/request-changes` payload
   - current: `{ prompt }`
   - target:
     - `prompt: string`
     - `reviewSelection?: {`
       - `mode: 'all' | 'include' | 'exclude' | 'freeform'`
       - `findingIds?: string[]`
       - `instruction?: string`
       - `includeReplies?: boolean`
     - `}`

Backward compatibility:
- existing clients sending only `{ prompt }` continue to work.

## Data Model Additions (Target)

### Task/Repo model additions

1. `Repo.autoReview` config object.
2. `Task.uiMeta.autoReviewMode` and `Task.uiMeta.autoReviewPrompt`.

### Run model additions

1. `run.reviewExecution`:
   - `enabled: boolean`
   - `trigger: 'auto_on_review' | 'manual_rerun'`
   - `promptSource: 'task' | 'repo' | 'native'`
   - `status: 'not_started' | 'running' | 'completed' | 'failed'`
   - `round: number`
   - `startedAt`, `endedAt`
2. `run.reviewFindingsSummary`:
   - `total`, `open`, `posted`, `provider`
3. `run.reviewArtifacts`:
   - `findingsJsonKey`
   - `reviewMarkdownKey`
4. `run.reviewPostState`:
   - provider posting metadata (ids, success/failure, retries)

### Normalized finding schema

Each finding:

- `findingId`
- `severity: 'critical' | 'high' | 'medium' | 'low' | 'info'`
- `title`
- `description`
- `filePath?`
- `lineStart?`
- `lineEnd?`
- `providerThreadId?`
- `status: 'open' | 'addressed' | 'ignored'`
- `replyContext?: string[]`

## 6-Task Execution Plan (Strictly Sequential)

### Task 1: Config + Types + Validation

**Start branch:** `main`  
**Merge gate:** must be merged before Task 2 starts

**Scope**

1. Add repo/task auto-review config fields to shared/domain types.
2. Add request validation for new fields in create/update repo/task and request-changes payload.
3. Add compatibility defaults:
   - repo: auto-review disabled unless explicitly enabled
   - task: default mode `inherit`
4. Add UI form fields in repo/task editors for these settings.

**Deliverables**

1. Type-safe config surfaces for repo/task auto-review.
2. Backward-compatible parsers and defaults.
3. Basic UI configuration controls.

**Tests**

1. validation tests for new repo/task fields
2. compatibility tests for missing fields
3. parser tests for extended request-changes payload

**Acceptance criteria**

1. Repo and task settings can be persisted and read.
2. Task override precedence is represented in types and parser logic.
3. Existing payloads remain valid.

---

### Task 2: Review Prompt Resolution + Artifact Contract

**Start branch:** `main`  
**Merge gate:** must be merged before Task 3 starts

**Scope**

1. Implement effective review config resolver:
   - task `on/off` overrides
   - task `inherit` uses repo setting
2. Implement review prompt resolver:
   - task prompt > repo prompt > native review mode
3. Define structured review output schema for the LLM review step.
4. Add artifact write helpers for review JSON + markdown.

**Deliverables**

1. deterministic config/prompt resolution module
2. reusable review output parser and normalizer
3. review artifact generation functions

**Tests**

1. precedence tests for config and prompt
2. schema parse/validation tests
3. artifact metadata shape tests

**Acceptance criteria**

1. Review execution inputs are deterministic for any repo/task combination.
2. Findings can be normalized into stable IDs.
3. Artifacts are generated without provider posting dependency.

---

### Task 3: Review Provider Posting Adapters (`gitlab` + `jira`)

**Start branch:** `main`  
**Merge gate:** must be merged before Task 4 starts

**Scope**

1. Add provider posting abstraction for review findings.
2. GitLab path:
   - post inline notes when file/line context is available
   - fallback to MR-level review summary comment
3. Jira path:
   - post issue comments with file/line references for each finding
   - include stable `findingId` markers for reply tracking
4. Add provider readback for replies/thread comments to enrich change-request context.

**Deliverables**

1. provider-neutral review posting interface
2. gitlab and jira implementations
3. provider readback/reply collector

**Tests**

1. gitlab posting + fallback tests
2. jira comment posting tests
3. reply extraction normalization tests

**Acceptance criteria**

1. Findings post correctly to selected provider.
2. Provider failures are captured without crashing run flow.
3. Replies can be mapped back to findings.

---

### Task 4: Orchestrator Integration (Auto + Manual Re-Run Review)

**Start branch:** `main`  
**Merge gate:** must be merged before Task 5 starts

**Scope**

1. Hook auto-review execution into run lifecycle when task enters `REVIEW`.
2. Add manual endpoint/action for review re-run on existing review context.
3. Persist review execution state and timeline notes.
4. Ensure review can reconnect/reuse appropriate sandbox/review branch context safely.

**Deliverables**

1. lifecycle-triggered review step
2. `POST /api/runs/:runId/review`
3. run metadata updates for review rounds/execution

**Tests**

1. trigger-on-review lifecycle tests
2. manual rerun endpoint tests
3. no-review-when-disabled tests

**Acceptance criteria**

1. Enabled runs execute review automatically on `REVIEW`.
2. Disabled runs skip review cleanly.
3. Manual re-run review works independently.

---

### Task 5: Selective Request-Changes with Reply Context

**Start branch:** `main`  
**Merge gate:** must be merged before Task 6 starts

**Scope**

1. Extend request-changes construction to support:
   - all findings
   - include/exclude lists
   - flexible freeform instruction
2. Pull provider replies for selected findings and inject into review change prompt context.
3. Track targeted findings in new change-request run metadata.
4. Add UI affordances in detail panel:
   - mode selector (all/include/exclude/freeform)
   - optional finding IDs
   - include replies toggle

**Deliverables**

1. enriched request-changes payload and prompt builder
2. reply-aware context stitching
3. UI controls for scope selection

**Tests**

1. selection mode tests (`all/include/exclude/freeform`)
2. finding-id validation and unknown-id behavior tests
3. prompt context composition tests including replies

**Acceptance criteria**

1. Operators can target all or subset of findings.
2. Provider replies influence follow-up run context.
3. Existing simple `{ prompt }` path still works.

---

### Task 6: Hardening, Docs, and Rollout Pack

**Start branch:** `main`  
**Merge gate:** final task

**Scope**

1. Add end-to-end coverage for full loop:
   - run -> review -> provider comments -> selective request-changes -> rerun -> review
2. Add idempotency and retry behavior for provider comment posting.
3. Update docs and operator runbook.
4. Produce AgentsKanban handoff pack for execution tasks with strict sequencing.

**Documentation updates**

1. `docs/features-and-api.md`
2. `docs/local-testing.md`
3. `README.md` (feature summary and configuration)
4. new guide: `docs/integrations/auto-review-change-loop.md`

**Deliverables**

1. hardened end-to-end flow with explicit operational guidance
2. updated docs for config, usage, and troubleshooting
3. task payload pack for execution phase

**Tests**

1. end-to-end auto-review lifecycle test
2. provider posting retry/idempotency tests
3. backward-compat request-changes tests

**Acceptance criteria**

1. Auto-review loop is stable across GitLab and Jira provider modes.
2. Review artifacts are consistently present on reviewed runs.
3. Operators can execute full flow without hidden/manual side paths.

## Dependency Graph (Strict Serial)

- **Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6**

No exceptions.

## Final Acceptance Criteria

1. Repo and task settings can deterministically enable/disable auto-review with task precedence.
2. Review execution supports native and custom prompts with clear precedence.
3. Findings are preserved as artifacts and posted to configured provider.
4. Request-changes can target all/some findings and include provider reply context.
5. Manual review re-run is available.
6. Docs and tests are sufficient for production rollout in controlled stages.
