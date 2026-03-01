# AgentBoard Stage 3 (Run)

## Goal

Replace the Stage 2 server-side mock executor with real execution:

- real ephemeral Cloudflare Sandbox per run
- real Codex invocation inside the sandbox
- real GitHub branch push and PR creation
- real preview discovery from the PR/head SHA
- real Playwright evidence capture against baseline + preview
- real artifact persistence and PR commenting

Stage 3 is the first end-to-end working version of AgentBoard.

## What must already exist from Stage 2

Stage 3 assumes Stage 2 already provides:

- Worker-hosted SPA + HTTP API
- durable repo/task/run storage
- idempotent run start/retry/evidence endpoints
- durable run lifecycle ownership on the server
- log retrieval endpoint
- stable DTOs and additive-friendly run metadata

Stage 3 must extend those capabilities, not replace their contracts.

## Non-goals

- No full policy engine yet
- No multi-user auth/roles redesign yet
- No advanced scheduling/queue fairness yet
- No multi-run-per-task support yet
- No branch rebasing/merge automation yet
- No full billing/usage accounting yet

## Target architecture

### Control plane
- Cloudflare Worker hosts the SPA and HTTP API
- `BoardDO` remains the source of truth for repos/tasks/runs
- Worker owns GitHub API calls, preview discovery, PR comments, and orchestration handoffs
- R2 stores logs, evidence artifacts, and Codex auth bundle material

### Execution plane
- One ephemeral Cloudflare Sandbox per run
- Sandbox responsibilities:
  - restore Codex auth bundle
  - clone repo
  - create branch
  - write task context into working directory if needed
  - run Codex
  - run tests
  - push branch
- Evidence runner:
  - separate ephemeral sandbox
  - run Playwright against baseline and preview
  - upload screenshots/video/trace
  - report artifact manifest back to control plane

### Integrations
- GitHub token or GitHub App installation token for clone/push/PR/comment
- Cloudflare preview detection via GitHub status/checks/deployments on head SHA

## Stage 3 state model

Stage 2 fields remain. Stage 3 makes them real.

### Repo
Required runtime fields:
- `repoId`
- `slug`
- `defaultBranch`
- `baselineUrl`
- `enabled`

Additive Stage 3 repo metadata:
- `githubInstallationId?`
- `previewProvider?: 'cloudflare' | 'unknown'`
- `previewCheckName?`
- `codexAuthBundleKey?`

### Task
Unchanged shape, but must continue carrying:
- `taskPrompt`
- `acceptanceCriteria`
- `context`
- `baselineUrlOverride?`

### Run
Required Stage 3 fields:
- `runId`
- `taskId`
- `repoId`
- `status`
- `branchName`
- `headSha`
- `prUrl`
- `prNumber`
- `previewUrl`
- `artifactManifest`
- `errors[]`
- `startedAt`
- `endedAt`
- `timeline`

Additive Stage 3 fields:
- `sandboxId?`
- `sandboxSessionId?`
- `executorType: 'sandbox'`
- `previewStatus?: 'UNKNOWN' | 'DISCOVERING' | 'READY' | 'FAILED'`
- `evidenceStatus?: 'NOT_STARTED' | 'RUNNING' | 'READY' | 'FAILED'`

## Lifecycle

The Stage 2 lifecycle remains the public run model:

1. `QUEUED`
2. `BOOTSTRAPPING`
3. `RUNNING_CODEX`
4. `RUNNING_TESTS`
5. `PUSHING_BRANCH`
6. `PR_OPEN`
7. `WAITING_PREVIEW`
8. `EVIDENCE_RUNNING`
9. `DONE` or `FAILED`

Stage 3 maps real work to those states:

- `BOOTSTRAPPING`
  - acquire sandbox
  - restore auth bundle
  - clone repo
  - create branch
- `RUNNING_CODEX`
  - execute Codex with the task prompt + context
- `RUNNING_TESTS`
  - run repo-defined test command or default smoke command
- `PUSHING_BRANCH`
  - commit and push branch if there are changes
- `PR_OPEN`
  - create PR through GitHub API
- `WAITING_PREVIEW`
  - poll GitHub checks/deployments for preview URL
- `EVIDENCE_RUNNING`
  - run Playwright against baseline + preview
- `DONE`
  - artifacts persisted and PR comment posted

## Idempotency requirements

These are mandatory:

- starting a run for a task with a non-terminal run returns the existing run
- evidence retry reruns evidence only, never creates a new PR
- run retry creates a new run record and new branch/PR attempt
- repeated webhook/poll results must not duplicate PR comments or artifact records
- repeated preview discovery must converge on one `previewUrl`

## API surface

Stage 3 keeps the Stage 2 endpoints:

### Repos
- `POST /repos`
- `GET /repos`
- `PATCH /repos/:repoId`

### Tasks
- `POST /tasks`
- `GET /tasks?repoId=`
- `GET /tasks/:taskId`
- `PATCH /tasks/:taskId`

### Runs
- `POST /tasks/:taskId/run`
- `GET /runs/:runId`
- `POST /runs/:runId/retry`
- `POST /runs/:runId/evidence`
- `GET /runs/:runId/logs?tail=N`

Optional additive Stage 3 endpoints:
- `GET /runs/:runId/artifacts`
- `GET /runs/:runId/events`

Do not require the UI to adopt new endpoints for core flows if existing ones can be extended additively.

## Sandbox execution contract

### Inputs to the executor
- repo slug
- default branch
- task prompt
- acceptance criteria
- structured context links/notes
- baseline URL override if present
- credentials/material references

### Outputs from the executor
- branch name
- head SHA
- execution logs
- test outcome
- commit summary
- failure details if any

## Git workflow inside the sandbox

Stage 3 should use the Sandbox SDK's Git support for initial checkout, then standard Git commands inside the checked-out repo for branching, commit creation, status checks, and push.

### Checkout strategy

Preferred initial clone flow:

- use `sandbox.gitCheckout(repoUrl)` for normal clones
- use `branch` when cloning a non-default branch
- use `depth: 1` for faster shallow checkouts when full history is not needed
- use `targetDir` to place the repo in a deterministic workspace path such as `/workspace/repo`

Examples of expected Stage 3 usage:

- public repo: `await sandbox.gitCheckout("https://github.com/owner/repo", { branch: "main", targetDir: "/workspace/repo" })`
- private repo: construct the clone URL with a short-lived token and then call `gitCheckout()`

### Private repository access

Use a GitHub token or GitHub App installation token in the clone URL at execution time.

Requirements:

- credentials must come from Worker secrets/bindings, never from persisted task data
- credentials must be injected only for the lifetime of the run
- tokens should be short-lived when possible

### Post-checkout git operations

After `gitCheckout()`, use `sandbox.exec()` for normal Git commands inside the repo:

- `git checkout -b <branch>`
- `git status --short`
- `git add ...`
- `git commit -m ...`
- `git push origin <branch>`

### Branching convention

Continue using the run-linked branch convention:

- `agent/<taskId>/<runId>`

This keeps branch identity stable across retries and aligns the PR with a single run attempt.

### Recommended executor sequence

1. `gitCheckout()` into `/workspace/repo`
2. `git checkout -b agent/<taskId>/<runId>`
3. run Codex against that working tree
4. run tests
5. inspect `git status --short`
6. if there are changes, commit and push
7. if there are no changes, decide whether to fail the run or open a no-op PR based on product policy

### Stage 3 decision

Default behavior for Stage 3:

- if Codex produces no diff, mark the run `FAILED` with a structured `NO_CHANGES` error instead of opening a PR

This keeps the one-run/one-meaningful-PR contract intact.

### Failure handling
If the sandbox step fails:
- append structured error
- write terminal logs
- mark run `FAILED`
- preserve partial metadata already known

## GitHub integration

### Required Stage 3 actions
- clone with token/app auth
- push branch
- create PR
- comment on PR with evidence summary and links

### PR requirements
One run maps to one PR.

PR body/comment should include:
- task title
- task prompt summary
- acceptance criteria summary
- run id
- preview link once known
- evidence links once ready

## WebSocket connection patterns

Stage 3 should explicitly support WebSocket-based connections when the product needs live communication with services or sessions running inside a sandbox.

Cloudflare Sandbox supports two distinct patterns:

### 1. Public preview URL for external clients

Use this when a browser or external client should connect directly to a WebSocket service running in the sandbox.

Flow:

1. start a WebSocket-capable service inside the sandbox on a port such as `8080`
2. expose the port with `sandbox.exposePort(port, { hostname })`
3. route requests through `proxyToSandbox(request, env)`
4. return the resulting preview URL to the client and convert `https` to `wss` if needed

Best for:

- public demo sessions
- shared real-time dashboards
- browser clients connecting directly to a sandbox-hosted real-time service

Important production constraint:

- preview URLs require a custom domain with wildcard DNS routing in production
- `.workers.dev` is not sufficient for wildcard sandbox preview hostnames

### 2. Worker-routed WebSocket connection with `wsConnect()`

Use this when the Worker should control the WebSocket upgrade and route traffic into the sandbox itself.

Flow:

1. receive a request with `Upgrade: websocket`
2. resolve the sandbox for the target run/session
3. call `sandbox.wsConnect(request, port)`
4. return the WebSocket `Response`

Best for:

- authentication/authorization gates in the Worker
- routing to the correct run-specific sandbox
- situations where the Worker must decide which sandbox or port to connect to

### Stage 3 usage in AgentBoard

Stage 3 does not require end-user WebSocket interaction for the core board flow, but it should document the path for real-time operator tooling.

Recommended uses:

- live terminal or shell access into a run sandbox
- real-time agent/session stream for debugging
- direct connection to an internal WebSocket service started by the agent

### Recommended default for AgentBoard

Default to `wsConnect()` for operator-facing or authenticated connections because:

- the Worker can enforce auth and run ownership
- the Worker can map a connection to a specific `runId`
- it avoids exposing raw preview endpoints for internal tooling by default

Use preview-URL-based WebSockets only when an external client must connect directly.

### Future route shape

Reserve routes like:

- `GET /runs/:runId/ws`
- `GET /runs/:runId/terminal`

These should:

- validate operator access
- resolve the sandbox for `runId`
- forward the WebSocket upgrade with `wsConnect()`

### Observability for WebSocket sessions

If WebSocket sessions are added in Stage 3, log:

- `runId`
- target sandbox id
- target port
- connection start/end time
- close code/reason
- auth/routing decision path

## Preview discovery

Preview is not generated from the sandbox.

Stage 3 must:
- detect the preview from GitHub deployment/check/status data on the PR head SHA
- persist the discovered URL on the run
- mark `previewStatus`
- proceed to evidence only after preview is ready

### Failure mode
If preview does not appear before timeout:
- mark run `FAILED`
- persist discovery logs
- keep PR link and branch info intact

## Evidence runner

### Inputs
- baseline URL (repo default or task override)
- preview URL
- run id
- repo/task metadata

### Outputs
- before screenshot
- after screenshot
- trace archive
- video if enabled
- artifact manifest
- PR comment/update

### Storage
Persist artifacts in R2 and record stable keys in `artifactManifest`.

Recommended key layout:
- `runs/<runId>/logs/*.txt`
- `runs/<runId>/evidence/before.png`
- `runs/<runId>/evidence/after.png`
- `runs/<runId>/evidence/trace.zip`
- `runs/<runId>/evidence/video.mp4`

## Observability

### Structured event/log shape
Every event/log should be able to include:
- `timestamp`
- `level`
- `phase`
- `repoId`
- `taskId`
- `runId`
- `message`
- `metadata?`

### Required phases
- `bootstrap`
- `codex`
- `tests`
- `push`
- `pr`
- `preview`
- `evidence`

### UI consumption
The UI may keep polling at first, but Stage 3 should structure logs/events so it can later support:
- cursor-based polling
- SSE
- streaming progress

without changing the board/detail UI contract.

## Security and secrets

Stage 3 must not hardcode credentials into the repo or task data.

Use bindings/secrets/R2 references for:
- GitHub credentials
- Codex auth bundle
- any Playwright or preview-discovery tokens

The sandbox should restore only the minimum required credentials for the run.

## Import/export decision

Import/export is not a core Stage 3 feature.

Decision:
- keep it as an admin/debug workflow only if it is still useful
- do not let it influence the server-side architecture
- do not block Stage 3 on making it parity-complete with local Phase 0 behavior

## Acceptance criteria

Stage 3 is done when:

- dragging a task to `ACTIVE` starts a real run
- a real sandbox executes Codex work against the selected repo
- a branch is pushed and a real PR is created
- preview URL is discovered automatically from PR-related deployment/check data
- evidence is captured against baseline + preview
- artifacts are persisted and linked from the PR
- the board/detail view reflects the full real lifecycle
- retry run and retry evidence preserve the defined idempotency rules

## Cut lines if time gets tight

- poll preview/check state instead of using webhooks
- poll logs instead of implementing streaming
- support a single GitHub credential path first
- keep one `BoardDO` if per-run DO split is not yet necessary
- use a simple repo-configured test command instead of auto-detecting every framework

## Recommended build order

1. Finalize Stage 2 API/storage contract
2. Add R2 bindings for artifacts/logs/auth bundle references
3. Add GitHub auth/config plumbing
4. Implement sandbox bootstrap + repo clone + branch creation
5. Implement Codex invocation and log capture
6. Implement test execution and failure handling
7. Implement push + PR creation
8. Implement preview discovery
9. Implement evidence runner and artifact upload
10. Implement PR commenting
11. Wire enriched logs/status back to UI
12. Run full end-to-end verification on at least one repo
