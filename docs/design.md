Spec: AgentsKanban — Multi-Repo Task Kanban + Background Agents (Crawl → Walk → Run)

Purpose

Build AgentsKanban, a lightweight system to run background coding agents (Codex in Cloudflare Sandboxes) against multiple GitHub repos. The primary interaction model is:
	•	You create Tasks with context (prompt, links, acceptance criteria).
	•	Tasks appear as cards on a simple kanban board.
	•	Moving a card into Active triggers an Agent Run (ephemeral sandbox).
	•	Each run produces one PR and (after PR preview is ready) Playwright evidence (before/after) posted back to PR.
	•	The UI stays very simple: a “control surface” + visibility into what’s happening (runs, logs, links).

We will build this in three phases: Crawl (UI-first mock), Walk (UI + API + DOs, still mocked execution), Run (full sandboxes + Codex + PR + evidence).

⸻

Key Requirements

Multi-Repo
	•	System supports multiple repos.
	•	User can add new repos via UI.
	•	Assume a single GitHub credential works for all repos (same token/app installation).
	•	Board can be filtered by repo; optionally show “All repos”.

Kanban as Control Surface
	•	The board is the “operating interface”.
	•	Dragging a task card into Active is the primary way to start work.
	•	API must also support creating tasks and starting runs (API-first mental model).

Agent Runs
	•	One run = one ephemeral sandbox.
	•	One PR per run.
	•	Runs have a clear lifecycle and are observable.

Previews
	•	We do not generate previews from sandboxes.
	•	Pushing a PR triggers Cloudflare preview automatically.
	•	System discovers preview URL and runs Playwright against it.

Evidence
	•	Evidence is captured after preview is ready:
	•	Before: baseline URL (configurable, per repo or per task)
	•	After: PR preview URL
	•	Evidence artifacts (screenshots/video/trace) are stored and linked from PR.

⸻

Entities and Data Model (Conceptual)

Repo
	•	repoId (internal)
	•	slug = owner/name
	•	defaultBranch (e.g., main)
	•	baselineUrl (default “before” URL; can be overridden per task)
	•	enabled (true/false)
	•	createdAt, updatedAt

Task

A unit of work that can be queued and executed by an agent.
	•	taskId
	•	repoId
	•	title
	•	description (optional, human readable)
	•	taskPrompt (the instruction to Codex)
	•	context (structured attachments/links; minimal in spike)
	•	status (kanban column): INBOX | READY | ACTIVE | REVIEW | DONE | FAILED
	•	createdAt, updatedAt
	•	run (optional, current/latest run metadata)

Important semantic:
	•	A task can have at most one active run in spike.
	•	Later we can support multiple runs per task.

Run (AgentRun)

Execution record for a task.
	•	runId
	•	taskId, repoId
	•	status:
	•	QUEUED
	•	BOOTSTRAPPING
	•	RUNNING_CODEX
	•	RUNNING_TESTS
	•	PUSHING_BRANCH
	•	PR_OPEN
	•	WAITING_PREVIEW
	•	EVIDENCE_RUNNING
	•	DONE
	•	FAILED
	•	branchName (agent/<taskId>/<runId>)
	•	headSha
	•	prUrl, prNumber
	•	previewUrl
	•	artifacts (keys/links to logs and evidence)
	•	errors[]
	•	startedAt, endedAt

Artifact Manifest

A small structured record:
	•	log pointers
	•	before/after evidence pointers
	•	metadata: timestamps, versions, environment id

⸻

Kanban UI Model

Columns
	•	Inbox: newly created tasks
	•	Ready: tasks triaged and ready to run
	•	Active: tasks currently running (moving a card here starts a run)
	•	Review: PR exists; preview/evidence may be in progress or ready
	•	Done: manually moved when human is satisfied / merged
	•	Failed: terminal failure; can be retried

Drag Behavior
	•	Drag card between columns updates Task.status.
	•	Dropping into Active triggers startRun(taskId) (must be idempotent).
	•	Dropping into Done is manual (not tied to merge detection in spike).

Task Detail Panel
	•	Shows prompt/context
	•	Shows run status timeline
	•	Links: PR, preview, evidence
	•	Buttons:
	•	Retry run (creates a new run or restarts depending on phase)
	•	Retry evidence
	•	Move task between columns

⸻

API (Conceptual; stable across phases)

Repos
	•	POST /repos add repo
	•	GET /repos list repos
	•	PATCH /repos/:repoId update baselineUrl/defaultBranch

Tasks
	•	POST /tasks create task
	•	GET /tasks?repoId= list tasks
	•	GET /tasks/:taskId get detail
	•	PATCH /tasks/:taskId update status/title/prompt/etc.

Runs
	•	POST /tasks/:taskId/run start run (idempotent)
	•	GET /runs/:runId run detail
	•	POST /runs/:runId/retry (optional)
	•	POST /runs/:runId/evidence retry evidence

Logs/Artifacts
	•	GET /runs/:runId/logs?tail=N
	•	GET /artifacts/:key (auth-gated later)

Phase 1 (Crawl) implements these endpoints as mocked in-memory/local storage inside the UI only (no backend), but keep the shape.

⸻

System Architecture (Run phase target)

Control Plane
	•	Cloudflare Worker: HTTP API + UI hosting + integrations.
	•	Durable Objects:
	•	BoardDO (or RepoDO) for repo+task listing + lightweight orchestration
	•	TaskDO (optional later) for per-task state
	•	RunDO (optional) for per-run lifecycle + logs
	•	R2:
	•	evidence artifacts
	•	logs
	•	codex auth bundle

Execution Plane
	•	Cloudflare Sandbox per run (ephemeral):
	•	restore Codex auth bundle (~/.codex)
	•	auth bundle should contain only `auth.json` and `config.toml` (not the full `~/.codex` directory)
	•	clone repo
	•	create branch
	•	run Codex
	•	run tests
	•	push branch
	•	(PR open from Worker preferred)
	•	Evidence runner (ephemeral sandbox):
	•	run Playwright against baseline + preview URL
	•	upload artifacts
	•	comment on PR

Integrations
	•	GitHub:
	•	clone/push with token or GitHub App installation token
	•	create PR, comment PR
	•	discover preview URL via checks/deployments on PR head SHA
	•	Cloudflare Preview:
	•	discovered from GitHub status/check output (preferred for spike)

⸻

Lifecycle & State Machine

Task → Run coupling
	•	Task.status = ACTIVE implies “a run is queued/running”.
	•	Task.status = REVIEW implies “PR exists; run is at least PR_OPEN”.
	•	Task.status = DONE is manual.

Run lifecycle
	1.	QUEUED
	2.	BOOTSTRAPPING (restore auth, install prerequisites)
	3.	RUNNING_CODEX
	4.	RUNNING_TESTS
	5.	PUSHING_BRANCH
	6.	PR_OPEN
	7.	WAITING_PREVIEW (poll until preview URL is ready)
	8.	EVIDENCE_RUNNING (baseline + preview Playwright)
	9.	DONE or FAILED

Idempotency rules:
	•	Starting a run when a run is already active should not start another.
	•	Evidence retries should not create new PRs; only rerun evidence.

⸻

Crawl → Walk → Run Plan

Phase 0: Crawl (UI-only mock)

Deliver a static UI that demonstrates the mental model:
	•	Multi-repo: add repo, select repo, see tasks for repo
	•	Create tasks
	•	Kanban drag/drop across columns
	•	Moving to Active triggers a mock run:
	•	run status changes over time (simulated)
	•	fake PR/preview/evidence links appear as placeholders
	•	Task detail panel shows:
	•	prompt/context
	•	run timeline
	•	mock logs that “stream” (simulated)
	•	Persistence:
	•	local-only (localStorage)
	•	import/export board state as JSON
	•	No real network calls; but keep an internal “API service layer” interface matching the future API shape.

Acceptance criteria:
	•	You can use the UI to manage multiple repos and tasks.
	•	Dragging a task to Active visibly “starts work” and progresses.
	•	The interface feels right before writing backend.

Phase 1: Walk (Real Worker API + DO state, still mocked execution)

Replace local persistence with Worker + DO:
	•	UI calls real endpoints
	•	DO stores repos/tasks/runs
	•	Starting a run triggers a mocked run executor (no sandbox yet):
	•	run progresses via timers/state machine in DO
	•	logs generated by DO and returned to UI

Acceptance criteria:
	•	Same UX as Crawl, but state persists server-side and works across devices.

Phase 2: Run (Sandboxes + Codex + GitHub + Evidence)

Swap mocked executor for real sandboxes:
	•	agent run uses sandbox
	•	PR creation via GitHub API
	•	preview discovery works
	•	evidence runner uses Playwright and comments on PR

Acceptance criteria:
	•	Real PRs created per run
	•	Evidence artifacts exist and are linked
	•	Board reflects real lifecycle

⸻

Design Principles (from day 1)
	•	API-first: UI is a client of the API, not the source of truth (even in mock, keep the interface).
	•	Idempotency: drag/drop actions can be repeated safely.
	•	Standard artifacts: every run produces a manifest and logs.
	•	Simple extension points: easy to add “policies” later (limits, allow/deny commands, etc).
	•	Multi-repo is first-class: repo context is always visible (badges, filters).

⸻
