> Historical doc: superseded by the active P1-P4 plans in [../current/README.md](../current/README.md).

# AgentsKanban Stage 3.1 (Dependency Fanout)

**Status:** ✅ Implemented

## Goal

Stage 3.1 teaches AgentsKanban how to chain related tasks inside the same repo.

The product outcome is simple:

- tasks may depend on upstream tasks in the same repo
- downstream tasks may become ready automatically when those dependencies are satisfied
- when an upstream task reaches `REVIEW`, eligible downstream tasks can auto-start from that upstream branch lineage
- if the upstream later lands in `main`, downstream tasks that are still in `INBOX` or `READY` should be treated as ready and auto-progress according to their automation settings

Stage 3.1 is about orchestration and task readiness. It does not change the core Stage 3 execution path once a run starts.

## Why this stage exists

Stage 3 gives AgentsKanban one real run at a time with real branches, PRs, previews, and evidence.

What it does not yet do is carry momentum across related tasks. Today an operator still has to notice that task B depends on task A, wait for task A to reach review, then manually decide when to start task B and which branch it should inherit from.

Stage 3.1 removes that manual fanout step for same-repo follow-on work.

## Product decisions locked in

- dependencies are only supported between tasks in the same repo
- the first supported dependency mode is `review_ready`
- `REVIEW` is the first readiness milestone that can unblock downstream work
- downstream auto-start is branch-lineage aware, not just status aware
- a downstream task started from an upstream review branch must preserve that source context on the run record
- if the upstream change later lands in the repo default branch, blocked `INBOX` and `READY` downstream tasks should be considered ready from the default branch even if they never started from the review branch
- explicit `sourceRef` remains the highest-priority branch source and is not overridden by dependency fanout
- `autoStartEligible = true` is the execution gate for automatic follow-on work; `READY` is not required
- when multiple upstream review branches could provide lineage, `primary` must identify the source dependency or auto-start stays blocked
- upstream work is only treated as landed after GitHub reports the PR as merged and the change is confirmed on the repo default branch

## Non-goals

- no cross-repo dependencies
- no arbitrary dependency expressions or boolean logic
- no merge automation
- no automatic rebasing or conflict resolution for already-running downstream work
- no attempt to restart or rewrite downstream runs that already opened a PR
- no fairness scheduler redesign beyond what Stage 3 already uses

## User-visible behavior

## 1. Create same-repo dependencies

Tasks may declare one or more upstream task dependencies in the same repo.

Initial supported shape:

- `dependencies[]`
- each dependency references `upstreamTaskId`
- mode is `review_ready`
- one dependency may be marked `primary` for branch lineage decisions when multiple upstreams exist

## 2. Readiness becomes computed, not just manually assigned

A task with unsatisfied dependencies is not truly ready even if an operator places it in `READY`.

The product should surface that distinction through `dependencyState`:

- `blocked = true` while required upstream tasks are not ready
- reasons explain which upstream task is missing, not ready, or ready
- `unblockedAt` records when the dependency set first became satisfied

The board can still show the task in `INBOX` or `READY`, but execution decisions must honor dependency readiness rather than column alone.

## 3. Upstream `REVIEW` can fan out downstream work

When an upstream task reaches `REVIEW`, AgentsKanban should reevaluate dependent tasks in the same repo.

If a downstream task is:

- dependency-unblocked
- not already running
- not already in `REVIEW` or `DONE`
- marked `automationState.autoStartEligible = true`
- not pinned to an explicit `sourceRef`

then the system may start it automatically.

`READY` is not an additional requirement for auto-start. A downstream task may remain in `INBOX` for operator organization and still auto-progress when its automation setting and dependency state allow it.

That downstream run should inherit branch lineage from the upstream review head:

- `branchSource.kind = dependency_review_head`
- capture `upstreamTaskId`
- capture `upstreamRunId`
- capture `upstreamPrNumber`
- capture `upstreamHeadSha`
- persist the resolved ref used for checkout

This is what makes Stage 3.1 useful: the follow-on task is not just unblocked, it starts from the branch that contains the upstream change before merge.

## 4. Merge to `main` should also unblock queued follow-on work

Sometimes the upstream task reaches `REVIEW`, but no downstream task starts yet because:

- the downstream task is still in `INBOX`
- the downstream task is in `READY` but not auto-start eligible
- the upstream lands in `main` before follow-on work begins

In that case, once AgentsKanban can confirm the upstream branch has landed in the repo default branch, downstream `INBOX` and `READY` tasks should be treated as ready from `main`.

That means:

- dependency blocking clears
- `dependencyState` records the unblocked transition
- branch resolution changes to `default_branch` for any newly started downstream run unless an explicit source ref was supplied
- if the downstream task is auto-start eligible, it should now auto-progress from the default branch

This keeps the product behavior intuitive. Missing the short `REVIEW` window should not strand downstream work.

## Source resolution rules

Stage 3.1 should use a deterministic source selection order for every new run:

1. `explicit_source_ref`
2. `dependency_review_head`
3. `default_branch`

Operational meaning:

- use `explicit_source_ref` when `task.sourceRef` is present
- otherwise, use `dependency_review_head` when the primary upstream has a reviewable run with a known head SHA / PR context
- otherwise, use `default_branch` when dependencies are satisfied because the upstream work has landed on the repo default branch

The chosen source must be persisted on both:

- `task.branchSource`
- `run.dependencyContext`

This is required for auditability and for explaining why a downstream run started from a specific ref.

## State model additions

Stage 3.1 can stay close to the existing additive types already in the codebase:

- `Task.dependencies`
- `Task.dependencyState`
- `Task.automationState`
- `Task.branchSource`
- `AgentRun.dependencyContext`

Recommended semantic additions:

### `TaskDependency`

- keep `mode = review_ready`
- require same `repoId` as the downstream task
- support `primary = true` for source lineage choice when more than one upstream exists

### `TaskDependencyState`

- `blocked` means execution cannot start yet
- `unblockedAt` is the first moment all required dependencies were satisfied
- `reasons[]` is recomputed whenever upstream state changes

### `TaskAutomationState`

- `autoStartEligible` means the system may start the task once dependency and source resolution rules pass
- `autoStartedAt` records the first automatic launch
- `lastDependencyRefreshAt` records the most recent reevaluation driven by upstream transitions or merge detection

### `TaskBranchSource`

Allowed kinds remain:

- `explicit_source_ref`
- `dependency_review_head`
- `default_branch`

This record should reflect the source chosen for the next or latest downstream run, not a vague preference.

## Events that should trigger dependency fanout

Stage 3.1 should recompute downstream dependency state on these events:

1. task created or updated with dependencies
2. upstream task status changes
3. upstream run gains or changes PR/head SHA context
4. upstream run reaches `PR_OPEN`, `WAITING_PREVIEW`, `EVIDENCE_RUNNING`, or `DONE` and therefore maps to task `REVIEW`
5. upstream PR merge is detected and confirmed on the repo default branch
6. repo default branch SHA refresh shows upstream work is now present in `main`

The important product rule is not the exact transport. Polling, webhook acceleration, or explicit refresh are all acceptable as long as downstream readiness converges correctly.

## Orchestration model

## `RepoBoardDO`

Keep `RepoBoardDO` as the repo-scoped coordination point.

Additive Stage 3.1 responsibilities:

- maintain dependency indexes within a repo
- recompute `dependencyState` for affected downstream tasks
- record the resolved branch source for downstream work
- trigger auto-start when a downstream task becomes runnable
- avoid duplicate auto-starts if multiple upstream signals arrive

## Worker / Workflow responsibilities

Keep Stage 3 execution orchestration intact.

Stage 3.1 only adds pre-run coordination:

- resolve the source ref before creating the run
- attach dependency lineage metadata to the run
- confirm whether upstream work is only review-ready or already on the default branch

Once the run starts, Stage 3 behavior stays the same.

## Merge detection

Stage 3.1 needs a product-safe answer to one question: has the upstream work landed in the repo default branch?

Acceptable first implementation:

- use GitHub PR merge state when the upstream run has a PR
- confirm the merged change is reachable from the repo default branch before treating downstream work as ready from `default_branch`

The doc does not require a specific API shape yet, but the system must avoid treating a merely closed PR as merged or treating an unverified merge signal as equivalent to landing on `main`.

## Edge cases and required behavior

## Multiple upstream dependencies

Support multiple same-repo dependencies, but keep source lineage deterministic:

- all required dependencies must be satisfied before auto-start
- one dependency may be `primary`
- if more than one dependency is eligible to provide `dependency_review_head` lineage and none is marked primary, the system should not auto-start and should surface a clear blocking reason

## Upstream changed after downstream already started

Do not automatically restart or rewrite downstream work that is already:

- `ACTIVE`
- `REVIEW`
- `DONE`

Stage 3.1 only guarantees automatic progression for not-yet-started downstream tasks.

## Upstream review branch disappears

If a downstream task has not started yet and the upstream review branch is no longer usable, but the change is merged into default branch, the downstream task should still be considered ready from `default_branch`.

If neither a valid review branch nor merged default-branch state can be confirmed, the downstream task remains blocked.

## Manual control still wins

Operators may still:

- create downstream tasks early
- leave a dependency-unblocked task in `INBOX`
- turn off `autoStartEligible`
- provide an explicit `sourceRef`

Stage 3.1 adds automation, not a forced pipeline.

## Acceptance criteria

Stage 3.1 is complete when:

- tasks can declare same-repo dependencies
- downstream dependency state is recomputed automatically when upstream task/run state changes
- an upstream task entering `REVIEW` can auto-start eligible downstream work from the upstream review branch lineage
- downstream runs persist dependency/source metadata explaining why that branch was chosen
- downstream `INBOX` and `READY` tasks become effectively ready once upstream work lands in the repo default branch
- auto-start eligible downstream tasks can auto-progress from the default branch after merge
- duplicate fanout signals do not create duplicate downstream runs
- tasks with explicit `sourceRef` are not overwritten by dependency fanout
- auto-start does not require the downstream task to be in `READY`
- multi-upstream review-lineage fanout does not auto-start without a declared `primary`
- merge-to-default-branch readiness requires merged PR state plus default-branch confirmation
- already-started downstream runs are not silently restarted when upstream state changes later

## Implementation status

Stage 3.1 is complete.

Completed in product:

- same-repo task dependencies are supported
- downstream readiness is recomputed from upstream task and run transitions
- eligible downstream tasks can auto-start from upstream review lineage
- downstream runs persist dependency and branch-source context
- merged-to-default-branch fallback readiness works for not-yet-started downstream tasks
- duplicate fanout signals are guarded against
- the stage was dogfooded end-to-end in `abuiles/minions` through `S31-01` to `S31-09`

Known cleanup follow-up:

- repos configured to skip preview and evidence should not leave successful review-ready runs in a misleading `PREVIEW_TIMEOUT` terminal run state
- this does not block Stage 3.1 completion, but the workflow should be aligned so run status matches repo execution mode

## Recommended build order

1. Finalize task dependency and branch-source semantics in the API and shared types.
2. Add repo-scoped dependency indexing and recomputation hooks in `RepoBoardDO`.
3. Implement source resolution rules for `explicit_source_ref`, `dependency_review_head`, and `default_branch`.
4. Trigger dependency refresh from upstream task/run transitions into `REVIEW`.
5. Persist downstream branch lineage metadata on task and run records.
6. Add idempotent auto-start for dependency-unblocked tasks with `autoStartEligible = true`.
7. Add upstream merge detection and default-branch readiness propagation.
8. Verify that `INBOX` and `READY` downstream tasks auto-progress correctly after merge without duplicate runs.
