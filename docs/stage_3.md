# AgentsKanban Stage 3 (Run)

**Status:** ✅ Implemented

## Goal

Stage 3 replaces the Stage 2 mock executor with real execution.

A task moved to `ACTIVE` should:

- start a real background run
- execute in a real Cloudflare Sandbox
- let Codex work against the target repo with full permissions
- push a branch and open a real GitHub PR
- discover the Cloudflare preview URL from GitHub checks/deployments
- run Playwright evidence against baseline and preview
- persist logs and artifacts durably
- project the full lifecycle back into the board in real time

Stage 3 is the first fully functional AgentsKanban release.

## Stage 2 baseline this plan assumes

Stage 2 already provides:

- Worker-hosted SPA and `/api/*`
- `BoardIndexDO` for repo metadata and all-board fanout
- `RepoBoardDO` for repo-scoped tasks, runs, logs, and live board projection
- a stable WebSocket event model
- stable task/run DTOs used by the existing UI
- idempotent run start, run retry, and evidence retry semantics

Stage 3 extends that architecture. It does not replace it.

## Product decisions locked in

- there is no remaining mock execution path in the product
- Stage 3 is the only run path
- GitHub auth uses a PAT stored in KV
- the PAT is read by the Worker at run time and injected into the sandbox only for that run
- there is one global PAT key for Stage 3
- Codex runs with full permissions inside the sandbox
- Codex decides what install/build/test commands to run
- preview detection is polling-first via GitHub checks/deployments
- operator WebSocket access into sandboxes is documented, but not part of Stage 3 acceptance criteria
- if Codex produces no diff, the run fails with `NO_CHANGES` and no PR is opened
- if a PR already exists and preview/evidence later fails, the task remains in `REVIEW`

## Non-goals

- no policy engine yet
- no repo-specific credential model yet
- no merge automation
- no multi-run-per-task concurrency
- no multi-user auth redesign
- no fairness scheduler or usage billing system yet
- no operator terminal UI as a required Stage 3 feature

## Target architecture

### Control plane

Use these components:

- Cloudflare Worker
- Cloudflare Workflows
- `BoardIndexDO`
- `RepoBoardDO`
- KV for the GitHub PAT
- R2 for logs, evidence, and auth bundle material

### Worker responsibilities

The Worker owns:

- product API routes
- board WebSocket routing
- Workflow trigger endpoints
- GitHub API calls
- preview discovery polling
- PR comment creation and updates
- KV secret reads
- R2 uploads and signed artifact access

### Workflow responsibilities

Use one Workflow instance per run.

The Workflow owns:

- long-running step orchestration
- retries around external APIs
- waiting for preview readiness
- sequencing sandbox execution, PR creation, and evidence capture
- checkpointing the run across failures or restarts

This is the right division of responsibility because Workflows are designed for durable multi-step execution that may wait minutes, hours, or longer, while Durable Objects remain a better fit for projection and live coordination.

### `BoardIndexDO`

Keep its Stage 2 role:

- repo metadata
- board-wide WebSocket fanout
- board aggregation

Additive Stage 3 role:

- richer repo configuration fields needed by real execution

### `RepoBoardDO`

Keep repo as the atom of coordination.

`RepoBoardDO` remains the live projection model for:

- tasks
- runs
- recent logs
- run metadata
- task/run transitions
- repo-scoped WebSocket fanout

Stage 3 removes its mock alarm-driven progression for product runs. Real progression comes from Workflow-driven updates.

## Execution plane

Stage 3 uses two sandbox types.

### Run sandbox

One ephemeral sandbox per run.

Responsibilities:

- restore Codex auth material if needed
- inject GitHub PAT-derived git credentials for the run
- checkout the repo
- create the run branch
- run Codex with the task prompt/context
- allow Codex to decide and run the repo-specific install/build/test commands it needs
- collect executor logs
- push the branch if there is a diff

### Evidence sandbox

One separate ephemeral sandbox per evidence attempt.

Responsibilities:

- run Playwright against baseline and preview
- collect screenshots, trace, and optional video
- upload artifacts to R2
- return an artifact manifest

Reasoning:

- coding and evidence are isolated failure domains
- evidence retry should not require reusing the original coding sandbox
- run and evidence logs should remain distinct

## Storage and bindings

### KV

Add a KV binding for secrets.

Recommended binding:

- `SECRETS_KV`

Required key for Stage 3:

- `github_pat`

Rules:

- the PAT is never stored in task/run state
- the PAT is never written into logs
- the PAT is never persisted to R2
- the PAT is injected into the sandbox only for the lifetime of the run

### R2

Add an R2 binding for run artifacts and durable logs.

Recommended binding:

- `RUN_ARTIFACTS`

Recommended object layout:

- `runs/<runId>/logs/worker.ndjson`
- `runs/<runId>/logs/executor.txt`
- `runs/<runId>/logs/evidence.txt`
- `runs/<runId>/evidence/before.png`
- `runs/<runId>/evidence/after.png`
- `runs/<runId>/evidence/trace.zip`
- `runs/<runId>/evidence/video.mp4`
- `runs/<runId>/manifest.json`

### Workflows

Add a Workflow binding.

Recommended binding:

- `RUN_WORKFLOW`

### Wrangler additions

Stage 3 should add bindings for:

- KV
- R2
- Workflows

And keep existing bindings for:

- `BOARD_INDEX`
- `REPO_BOARD`
- `Sandbox`

`wrangler types` must be regenerated after binding changes.

## Required setup commands

Stage 3 needs three external resources configured before a real run will work:

1. KV namespace for the GitHub PAT
2. R2 bucket for run artifacts and Codex auth bundle material
3. Workflow binding for the run orchestrator

The current project uses:

- KV binding: `SECRETS_KV`
- R2 binding: `RUN_ARTIFACTS`
- Workflow binding: `RUN_WORKFLOW`

Set the GitHub PAT in KV:

```bash
npx wrangler kv key put github_pat "$GITHUB_PAT" --binding SECRETS_KV --remote
```

Upload a **minimal** `.codex` auth bundle to the R2 bucket (authentication files only):

```bash
tmp_dir="$(mktemp -d)" && \
mkdir -p "$tmp_dir/.codex" && \
cp "$HOME/.codex/auth.json" "$tmp_dir/.codex/auth.json" && \
cp "$HOME/.codex/config.toml" "$tmp_dir/.codex/config.toml" && \
tar -czf codex-auth.tgz -C "$tmp_dir" .codex && \
npx wrangler r2 object put my-sandbox-run-artifacts/auth/codex-auth.tgz --file ./codex-auth.tgz --remote && \
rm -rf "$tmp_dir"
```

For local development (no remote):

```bash
tmp_dir="$(mktemp -d)" && \
mkdir -p "$tmp_dir/.codex" && \
cp "$HOME/.codex/auth.json" "$tmp_dir/.codex/auth.json" && \
cp "$HOME/.codex/config.toml" "$tmp_dir/.codex/config.toml" && \
tar -czf codex-auth.tgz -C "$tmp_dir" .codex && \
npx wrangler r2 object put my-sandbox-run-artifacts/auth/codex-auth.tgz --file ./codex-auth.tgz && \
rm -rf "$tmp_dir"
```

Policy: do not upload the full `~/.codex` directory. Keep the bundle limited to the files required for Codex authentication (`auth.json` and `config.toml`).

Then set `codexAuthBundleR2Key` on a repo to:

```text
auth/codex-auth.tgz
```

## Public API surface

## Existing endpoints remain

Keep these endpoints and their semantics:

### Board
- `GET /api/board?repoId=all|<repoId>`
- `GET /api/board/ws?repoId=all|<repoId>`

### Repos
- `POST /api/repos`
- `GET /api/repos`
- `PATCH /api/repos/:repoId`

### Tasks
- `POST /api/tasks`
- `GET /api/tasks?repoId=`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`

### Runs
- `POST /api/tasks/:taskId/run`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/retry`
- `POST /api/runs/:runId/preview`
- `POST /api/runs/:runId/evidence`
- `GET /api/runs/:runId/logs?tail=N`

## Additive Stage 3 endpoints

Add:

- `GET /api/runs/:runId/artifacts`
  - returns the artifact manifest and durable log/artifact pointers

Optional but planned:

- `POST /api/github/webhook`
  - webhook acceleration for preview detection later

Keep debug/admin routes separate under `/api/debug/*` if they still exist, but they are not part of the product execution path.

## Request and response payloads

The API is intended to be agent-friendly.

Rules:

- all write endpoints accept `application/json`
- write endpoints return the created or updated resource
- action endpoints like `run`, `retry`, `preview`, and `evidence` return the current `AgentRun`
- errors return a consistent JSON object

### Error shape

```json
{
  "code": "BAD_REQUEST",
  "message": "Invalid task payload.",
  "retryable": false,
  "taskId": "task_optional",
  "runId": "run_optional"
}
```

### `GET /api/board?repoId=all|<repoId>`

Response shape:

```json
{
  "repos": [],
  "tasks": [],
  "runs": [],
  "logs": []
}
```

This is the best single endpoint for an agent to hydrate the current board state.

### `POST /api/repos`

Request:

```json
{
  "slug": "abuiles/minions-demo",
  "defaultBranch": "main",
  "baselineUrl": "https://minions-demo.abuiles.workers.dev/",
  "enabled": true,
  "previewCheckName": "Workers Builds: minions-demo",
  "codexAuthBundleR2Key": "auth/codex-auth.tgz"
}
```

Response:

```json
{
  "repoId": "repo_abuiles_minions_demo",
  "slug": "abuiles/minions-demo",
  "defaultBranch": "main",
  "baselineUrl": "https://minions-demo.abuiles.workers.dev/",
  "enabled": true,
  "previewCheckName": "Workers Builds: minions-demo",
  "codexAuthBundleR2Key": "auth/codex-auth.tgz",
  "createdAt": "2026-03-02T00:00:00.000Z",
  "updatedAt": "2026-03-02T00:00:00.000Z"
}
```

### `PATCH /api/repos/:repoId`

Request body is partial.

Example:

```json
{
  "baselineUrl": "https://minions-demo.abuiles.workers.dev/",
  "previewCheckName": "Workers Builds: minions-demo"
}
```

Response is the updated `Repo`.

### `POST /api/tasks`

Request:

```json
{
  "repoId": "repo_abuiles_minions_demo",
  "title": "Build simple snake game on index",
  "description": "Create a dummy and simple snake game on the index page.",
  "taskPrompt": "Create a dummy and simple snake game on the index page. Keep it lightweight and easy to review.",
  "acceptanceCriteria": [
    "A playable snake game is visible on the index page.",
    "The implementation is intentionally simple.",
    "No unnecessary dependencies are introduced."
  ],
  "context": {
    "links": [
      {
        "id": "link_homepage",
        "label": "Preview",
        "url": "https://minions-demo.abuiles.workers.dev/"
      }
    ],
    "notes": "Keep this one intentionally small."
  },
  "baselineUrlOverride": "https://minions-demo.abuiles.workers.dev/",
  "status": "INBOX",
  "simulationProfile": "happy_path",
  "codexModel": "gpt-5.1-codex-mini",
  "codexReasoningEffort": "medium"
}
```

Response:

```json
{
  "taskId": "task_repo_abuiles_minions_demo_x1u43w0q",
  "repoId": "repo_abuiles_minions_demo",
  "title": "Build simple snake game on index",
  "description": "Create a dummy and simple snake game on the index page.",
  "taskPrompt": "Create a dummy and simple snake game on the index page. Keep it lightweight and easy to review.",
  "acceptanceCriteria": [
    "A playable snake game is visible on the index page.",
    "The implementation is intentionally simple.",
    "No unnecessary dependencies are introduced."
  ],
  "context": {
    "links": [
      {
        "id": "link_homepage",
        "label": "Preview",
        "url": "https://minions-demo.abuiles.workers.dev/"
      }
    ],
    "notes": "Keep this one intentionally small."
  },
  "baselineUrlOverride": "https://minions-demo.abuiles.workers.dev/",
  "status": "INBOX",
  "createdAt": "2026-03-02T00:00:00.000Z",
  "updatedAt": "2026-03-02T00:00:00.000Z",
  "uiMeta": {
    "simulationProfile": "happy_path",
    "codexModel": "gpt-5.1-codex-mini",
    "codexReasoningEffort": "medium"
  }
}
```

### `PATCH /api/tasks/:taskId`

Request body is partial.

Example:

```json
{
  "status": "ACTIVE"
}
```

Response is the updated `Task`.

### `GET /api/tasks/:taskId`

Response:

```json
{
  "task": {},
  "repo": {},
  "runs": [],
  "latestRun": {}
}
```

This is the best endpoint for an agent that wants the full execution context for one task.

### `POST /api/tasks/:taskId/run`

Request body:

```json
{}
```

Response is the new or existing `AgentRun`.

### `POST /api/runs/:runId/retry`

Request body:

```json
{}
```

Behavior:

- creates or resumes a full run for the task
- returns the active `AgentRun`

### `POST /api/runs/:runId/preview`

Request body:

```json
{}
```

Behavior:

- forces preview discovery again for the existing PR/run
- clears the current `previewUrl`
- returns the updated `AgentRun`

### `POST /api/runs/:runId/evidence`

Request body:

```json
{}
```

Behavior:

- reruns evidence if a preview already exists
- otherwise falls back to preview discovery first
- returns the updated `AgentRun`

### `GET /api/runs/:runId`

Response is the current `AgentRun`.

Important fields agents should watch:

- `status`
- `previewStatus`
- `evidenceStatus`
- `prUrl`
- `previewUrl`
- `headSha`
- `workflowInstanceId`
- `artifactManifest`
- `errors`

### `GET /api/runs/:runId/logs?tail=N`

Response:

```json
[
  {
    "id": "run_repo_abuiles_minions_demo_x_created_abc123",
    "runId": "run_repo_abuiles_minions_demo_x",
    "createdAt": "2026-03-02T00:00:00.000Z",
    "level": "info",
    "message": "Preview discovery attempt 1/12.",
    "phase": "preview",
    "metadata": {
      "headSha": "04c8e944e2f097c2c0b7aa977f9c0797c15a864e"
    }
  }
]
```

### `GET /api/runs/:runId/artifacts`

Response:

```json
{
  "logs": {
    "key": "runs/run_repo_abuiles_minions_demo_x/logs/executor.txt",
    "label": "Executor logs"
  },
  "before": {
    "key": "runs/run_repo_abuiles_minions_demo_x/evidence/before.png",
    "label": "Before screenshot",
    "url": "https://minions-demo.abuiles.workers.dev/"
  },
  "after": {
    "key": "runs/run_repo_abuiles_minions_demo_x/evidence/after.png",
    "label": "After screenshot",
    "url": "https://preview.example.workers.dev/"
  },
  "trace": {
    "key": "runs/run_repo_abuiles_minions_demo_x/evidence/trace.zip",
    "label": "Playwright trace",
    "url": "r2://runs/run_repo_abuiles_minions_demo_x/evidence/trace.zip"
  },
  "video": {
    "key": "runs/run_repo_abuiles_minions_demo_x/evidence/video.mp4",
    "label": "Playwright video",
    "url": "r2://runs/run_repo_abuiles_minions_demo_x/evidence/video.mp4"
  },
  "metadata": {
    "generatedAt": "2026-03-02T00:00:00.000Z",
    "environmentId": "repo-board-do-id",
    "workflowInstanceId": "preview-only-run_repo_abuiles_minions_demo_x-20260302010101",
    "sandboxId": "run_repo_abuiles_minions_demo_x",
    "evidenceSandboxId": "run_repo_abuiles_minions_demo_x-evidence",
    "previewUrl": "https://preview.example.workers.dev/",
    "baselineUrl": "https://minions-demo.abuiles.workers.dev/"
  }
}
```

## Public type/interface changes

## `Repo`

Keep existing fields and add:

```ts
type Repo = {
  repoId: string;
  slug: string;
  defaultBranch: string;
  baselineUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;

  githubAuthMode?: 'kv_pat';
  previewProvider?: 'cloudflare';
  previewCheckName?: string;
  previewUrlPattern?: string;
  codexAuthBundleR2Key?: string;
};
```

Notes:

- PAT is global in KV, so there is no per-repo PAT field
- `previewCheckName` is the primary deterministic hint for preview discovery

## `Task`

No breaking changes required.

The existing fields remain the execution contract:

- `taskPrompt`
- `acceptanceCriteria`
- `context`
- `baselineUrlOverride?`

## `AgentRun`

Keep existing fields and add:

```ts
type AgentRun = {
  executorType?: 'sandbox';
  workflowInstanceId?: string;

  sandboxId?: string;
  evidenceSandboxId?: string;

  previewStatus?: 'UNKNOWN' | 'DISCOVERING' | 'READY' | 'FAILED';
  evidenceStatus?: 'NOT_STARTED' | 'RUNNING' | 'READY' | 'FAILED';

  commitSha?: string;
  commitMessage?: string;

  artifactManifest?: ArtifactManifest;

  executionSummary?: {
    codexOutcome?: 'changes' | 'no_changes' | 'failed';
    testsOutcome?: 'passed' | 'failed' | 'skipped';
    prCommented?: boolean;
  };
};
```

## `ArtifactManifest`

Use a real manifest shape:

```ts
type ArtifactManifest = {
  logs: { key: string; label: string };
  before?: { key: string; label: string; url?: string };
  after?: { key: string; label: string; url?: string };
  trace?: { key: string; label: string; url?: string };
  video?: { key: string; label: string; url?: string };
  metadata: {
    generatedAt: string;
    environmentId: string;
    workflowInstanceId?: string;
    sandboxId?: string;
    evidenceSandboxId?: string;
    previewUrl?: string;
    baselineUrl?: string;
  };
};
```

## `RunError`

Standardize structured run errors:

```ts
type RunError = {
  at: string;
  code:
    | 'BOOTSTRAP_FAILED'
    | 'CODEX_FAILED'
    | 'NO_CHANGES'
    | 'TESTS_FAILED'
    | 'PUSH_FAILED'
    | 'PR_CREATE_FAILED'
    | 'PREVIEW_TIMEOUT'
    | 'PREVIEW_FAILED'
    | 'EVIDENCE_FAILED'
    | 'ARTIFACT_UPLOAD_FAILED';
  message: string;
  retryable: boolean;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push' | 'pr' | 'preview' | 'evidence';
  metadata?: Record<string, string | number | boolean>;
};
```

## Workflow design

Use one Workflow instance per run.

### Workflow input

```ts
type RunWorkflowInput = {
  runId: string;
  taskId: string;
  repoId: string;
};
```

### Workflow contract

The Workflow must:

1. load repo/task/run state from `RepoBoardDO`
2. project each transition back into `RepoBoardDO`
3. append logs to `RepoBoardDO` as the authoritative live read model
4. stream durable logs to R2 as the run progresses or at step boundaries
5. retry transient external failures where safe
6. terminate with a final projected state

### Source-of-truth rule

The Workflow is the durable orchestrator.
`RepoBoardDO` is the live projection and client-facing read model.

The UI must continue to read from existing API/WS surfaces, not directly from Workflow state.

## Run lifecycle mapping

The public lifecycle remains:

1. `QUEUED`
2. `BOOTSTRAPPING`
3. `RUNNING_CODEX`
4. `RUNNING_TESTS`
5. `PUSHING_BRANCH`
6. `PR_OPEN`
7. `WAITING_PREVIEW`
8. `EVIDENCE_RUNNING`
9. `DONE` or `FAILED`

Stage 3 maps real work to these states as follows.

### `QUEUED`

- `POST /api/tasks/:taskId/run` checks idempotency in `RepoBoardDO`
- creates the run record
- marks the task `ACTIVE`
- starts the Workflow instance
- stores `workflowInstanceId`

### `BOOTSTRAPPING`

Workflow step:

- load repo/task config
- read `github_pat` from KV
- resolve Codex auth bundle material if needed
- create the sandbox
- inject only the run-scoped credentials/material needed
- checkout the repo with `gitCheckout()`
- create branch `agent/<taskId>/<runId>`

### `RUNNING_CODEX`

Workflow step:

- invoke Codex inside the sandbox with:
  - task prompt
  - acceptance criteria
  - structured context
  - any baseline URL context needed
- Codex has full permissions in the sandbox
- Codex decides what installation, build, and repository-specific setup work it needs to perform

### `RUNNING_TESTS`

Workflow step:

- Codex decides and runs the relevant validation commands for the repo
- the system captures the exact commands and outcomes in executor logs
- the system records a summarized pass/fail/skipped result in run metadata

This is deliberately non-deterministic at the product level in Stage 3. Auditability comes from logs, not from a repo command registry.

### `PUSHING_BRANCH`

Workflow step:

- inspect git diff/status
- if there is no diff:
  - mark the run `FAILED`
  - append `NO_CHANGES`
  - do not create a PR
- if there is a diff:
  - commit changes
  - push the run branch using PAT-backed auth

### `PR_OPEN`

Workflow step:

- create PR through GitHub API
- persist `prNumber`, `prUrl`, and `headSha`
- move the task to `REVIEW`

### `WAITING_PREVIEW`

Workflow step:

- poll GitHub checks/deployments on `headSha`
- use `previewCheckName` when available to constrain matching
- log every poll attempt
- when preview is found:
  - persist `previewUrl`
  - set `previewStatus = READY`
- if timeout expires:
  - fail the run with `PREVIEW_TIMEOUT`

### `EVIDENCE_RUNNING`

Workflow step:

- create evidence sandbox
- run Playwright against:
  - baseline URL = `task.baselineUrlOverride ?? repo.baselineUrl`
  - preview URL
- upload artifacts to R2
- persist `artifactManifest`
- create or update the run’s PR comment

### `DONE`

- persist final artifact/log references
- set `evidenceStatus = READY`
- keep the task in `REVIEW`

### `FAILED`

For any terminal failure:

- persist structured `RunError`
- persist terminal logs
- update task status according to these rules:
  - if the run failed before PR creation, move task to `FAILED`
  - if the run failed after PR creation, keep task in `REVIEW`

## Git workflow inside the sandbox

Use the Sandbox SDK Git support for checkout, then standard Git commands through `sandbox.exec()`.

### Checkout strategy

Use:

- `sandbox.gitCheckout(repoUrl, { branch, targetDir })`

Recommended target directory:

- `/workspace/repo`

For private repos:

- the Worker builds a token-authenticated clone URL using the PAT loaded from KV
- the token exists only for the run

### Post-checkout commands

Inside `/workspace/repo`, the executor should use normal Git commands such as:

- `git checkout -b agent/<taskId>/<runId>`
- `git status --short`
- `git add -A`
- `git commit -m ...`
- `git push origin agent/<taskId>/<runId>`

### Branch convention

Locked:

- `agent/<taskId>/<runId>`

### No-diff policy

Locked:

- if Codex produces no diff, fail with `NO_CHANGES`
- do not open a PR

## Durable Object changes required

## `BoardIndexDO`

Minimal additive changes:

- store richer repo config fields
- continue repo metadata lookup
- continue all-board WebSocket fanout

## `RepoBoardDO`

Add RPC methods for Workflow-driven projection, for example:

```ts
startRealRun(taskId: string): Promise<AgentRun>
appendRunLogs(runId: string, logs: RunLogEntry[]): Promise<void>
transitionRun(runId: string, patch: RunTransitionPatch): Promise<AgentRun>
storeArtifactManifest(runId: string, manifest: ArtifactManifest): Promise<void>
markPreviewReady(runId: string, previewUrl: string): Promise<void>
markRunFailed(runId: string, error: RunError): Promise<AgentRun>
```

`RunTransitionPatch` must support:

- status changes
- `workflowInstanceId`
- `sandboxId`
- `evidenceSandboxId`
- `prUrl`, `prNumber`, `headSha`
- `previewUrl`, `previewStatus`
- `evidenceStatus`
- terminal metadata

## Live update model

Keep the Stage 2 event model.

Primary events remain:

- `board.snapshot`
- `repo.updated`
- `task.updated`
- `run.updated`
- `run.logs_appended`
- `server.error`

If needed, add:

- `run.artifacts_updated`

But prefer keeping artifact changes inside `run.updated` unless a dedicated event materially simplifies the client.

## Evidence runner design

### Inputs

- `runId`
- repo/task/run snapshot
- baseline URL
- preview URL

### Execution contract

The evidence sandbox must:

- visit baseline URL
- capture before screenshot
- visit preview URL
- capture after screenshot
- capture trace
- optionally capture video

### Persistence

The evidence runner must:

- upload artifacts to R2
- persist `ArtifactManifest` to `RepoBoardDO`
- write `manifest.json` to R2

### PR comment behavior

Use one AgentsKanban comment per run.

Requirements:

- identify the comment using a hidden marker containing `runId`
- update the existing comment on retries instead of creating duplicates
- include preview link and evidence links when available

## Logging and observability

## Required log streams

Persist three logical streams:

- control-plane logs
- sandbox executor logs
- evidence runner logs

## Log entry shape

Extend current logs to support:

```ts
type RunLogEntry = {
  id: string;
  runId: string;
  createdAt: string;
  level: 'info' | 'error';
  message: string;
  phase?: 'bootstrap' | 'codex' | 'tests' | 'push' | 'pr' | 'preview' | 'evidence';
  metadata?: Record<string, string | number | boolean>;
};
```

## Logging requirements

- every state transition logs old/new state
- every external call that can fail logs phase and attempt
- the actual commands Codex ran must be captured in executor logs
- preview polling attempts must log the check/deployment names inspected
- PR comment create/update actions must be logged
- secrets must be redacted from all logs

## WebSocket connection patterns for sandboxes

Stage 3 does not require end-user WebSocket access to the sandbox, but the path should be documented for the next stage.

Cloudflare Sandbox supports two patterns:

### Public preview URL

Use `exposePort()` plus preview URL routing when an external client must connect directly to a service in the sandbox.

### Worker-routed WebSocket

Use `wsConnect()` when the Worker should authenticate and route a WebSocket connection into the sandbox.

### AgentsKanban decision

For future operator tooling, prefer Worker-routed `wsConnect()` because:

- the Worker can enforce auth
- the Worker can resolve `runId -> sandbox`
- it avoids exposing raw sandbox endpoints by default

Stage 3 documents this path but does not require implementing `/api/runs/:runId/terminal` yet.

## Security model

## Secrets

- PAT stored in KV
- auth bundle material stored in R2 or another non-repo secret store
- secrets injected only for the run lifetime
- secrets never persisted in task/run DTOs
- secrets never exposed to the browser

## Sandbox permissions

Locked decision:

- Codex runs with full permissions inside the sandbox

Tradeoff:

- execution is flexible but less deterministic
- therefore logs and auditability are mandatory

## Failure modes and edge cases

## Bootstrap failures

Examples:

- missing PAT in KV
- sandbox creation failure
- git checkout failure

Result:

- `FAILED`
- `BOOTSTRAP_FAILED`

## Codex failures

Examples:

- executor non-zero exit
- unrecoverable Codex/session failure

Result:

- `FAILED`
- `CODEX_FAILED`

## No changes

Result:

- `FAILED`
- `NO_CHANGES`
- no PR

## Test failures

Result:

- `FAILED`
- `TESTS_FAILED`
- no PR

## Push failures

Result:

- `FAILED`
- `PUSH_FAILED`

## PR creation failures

Result:

- `FAILED`
- branch info remains available
- task does not move to `REVIEW`

## Preview timeout/failure

Result:

- run `FAILED`
- task remains in `REVIEW` if a PR exists
- preview logs remain available

## Evidence failure

Result:

- run `FAILED`
- task remains in `REVIEW` if a PR exists
- `Retry evidence` remains available

## Testing plan

## Unit tests

Add coverage for:

- run projection reducer logic
- no-diff handling
- preview detection parsing
- PR comment idempotency markers
- artifact manifest assembly
- secret redaction

## Worker / DO tests

Add coverage for:

- `POST /api/tasks/:taskId/run` creates a real run record and starts a Workflow
- idempotent start returns the existing active run
- retry run creates a new run record
- retry evidence reuses the existing run
- Workflow-driven transitions emit WebSocket events
- preview/evidence failures keep the task in `REVIEW` when a PR exists

## Workflow tests

Cover these flows with fakes/stubs:

1. happy path
2. no changes
3. tests failed
4. PR creation failed
5. preview timeout
6. evidence failed
7. evidence retry succeeds after a prior failure

## Integration tests

Use fakes or test doubles for:

- sandbox
- GitHub API
- R2
- KV
- preview detection responses

## End-to-end acceptance scenarios

On at least one real test repo:

1. create repo and task
2. move task to `ACTIVE`
3. watch live lifecycle progression
4. verify branch push
5. verify PR creation
6. verify preview discovery
7. verify evidence artifacts in R2
8. verify PR comment updated
9. verify `Retry evidence` does not create a new PR
10. verify `Retry run` creates a new run/branch/PR attempt

## Acceptance criteria

Stage 3 is complete when:

- moving a task to `ACTIVE` starts a real Workflow-backed run
- the run uses a real Cloudflare Sandbox
- Codex works inside the sandbox with full permissions
- the repo is updated, committed, and pushed when there is a diff
- a real GitHub PR is created
- no-diff runs fail with `NO_CHANGES` and do not create PRs
- preview URL is discovered by polling GitHub checks/deployments
- evidence is captured in a separate sandbox against baseline + preview
- artifacts and durable logs are stored in R2
- the existing board and detail panel reflect the real lifecycle without a structural UI rewrite
- retry run and retry evidence preserve the idempotency contract
- GitHub PAT is sourced from KV and injected per run only

## Recommended build order

1. Update `docs/stage_3.md` to match this architecture.
2. Add Stage 3 bindings for KV, R2, and Workflows.
3. Extend repo/run types with additive execution metadata.
4. Add Workflow-driven run projection RPC methods to `RepoBoardDO`.
5. Implement the run Workflow entrypoint.
6. Implement sandbox bootstrap helpers:
   - PAT from KV
   - auth injection
   - git checkout
   - branch creation
7. Implement Codex execution with full executor log capture.
8. Implement no-diff detection, commit, and push.
9. Implement GitHub PR creation and idempotent PR comment updates.
10. Implement preview polling against GitHub checks/deployments.
11. Implement evidence sandbox execution and R2 uploads.
12. Wire all real transitions/logs back through `RepoBoardDO` and existing WebSockets.
13. Run integration and end-to-end verification on a real repo.

## What the next stages should cover

Stage 3 should deliberately stop at the first complete real run system.

The immediate follow-on is Stage 3.1, which adds dependency fanout and automatic follow-on execution for tasks in the same repo. That plan is documented in:

- `docs/stage_3_1.md`

The next five stages should focus on:

- live operator visibility and sandbox attach
- command and decision explainability
- operator control and deterministic execution options
- scaling, queueing, and multi-run behavior
- security, policy, and credential hardening

Those stages are documented in:

- `docs/stage_4.md`
- `docs/stage_5.md`
- `docs/stage_6.md`
- `docs/stage_7.md`
- `docs/stage_8.md`
