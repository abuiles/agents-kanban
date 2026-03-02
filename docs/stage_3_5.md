# AgentsKanban Stage 3.5 (Provider Adapters)

## Goal

Stage 3.5 makes AgentsKanban provider-adaptable in three independent seams:

- SCM provider adapters: GitHub and GitLab
- LLM executor adapters: Codex and Cursor CLI first
- preview adapters: Cloudflare checks, skip, and customer-defined prompt recipes

The implementation order is fixed:

1. SCM adapters first
2. LLM adapters second
3. preview adapters third

These tracks do not depend on each other conceptually, but the product priority does:

- the most urgent outcome is making the system work with hosted GitLab instances
- after that, we make the coding agent runtime pluggable
- after that, we make preview resolution pluggable

Stage 3.5 does not change the Stage 3.1 orchestration model. Dependencies, fanout, review gating, merge gating, and branch-lineage behavior stay the same.

## Why this stage exists

The current implementation is hard-coded in three places:

- GitHub is assumed for source refs, cloning, pushing, PR creation, comments, checks, and merge detection
- Codex is assumed for auth restore, CLI install, execution, rate limits, resume commands, and takeover behavior
- Cloudflare preview discovery is assumed to come from GitHub check output

That blocks three important product directions:

- using GitLab instead of GitHub
- trying different coding agents
- allowing customer-specific preview resolution flows

Stage 3.5 fixes that by introducing real adapters instead of adding more conditionals to the existing GitHub/Codex path.

## Product decisions locked in

- Stage 3.5 is the next stage before returning to later pending stages
- Git provider support comes first
- first Git providers are `github` and `gitlab`
- GitLab support in the first pass includes arbitrary hosted/self-managed base URLs
- runtime provider operations use HTTP APIs, not `gh` or `glab` inside the sandbox
- local/operator workflows may still use `gh` and `glab` for smoke tests and maintenance
- credentials are globally managed per provider/host, not stored per repo
- GitLab credentials are keyed by host
- Codex remains the default LLM executor
- Cursor CLI is the first additional executor
- preview adapters ship after the LLM adapter split
- the first custom preview method is a free-form prompt recipe supplied by the customer
- Stage 3.1 review semantics stay provider-neutral:
  - GitHub PRs and GitLab MRs both map to task `REVIEW`
  - merged-and-landed-on-default-branch still drives downstream readiness after merge

## Scope

In scope:

- provider-neutral SCM abstraction
- GitHub adapter extraction
- GitLab adapter implementation for hosted/self-managed instances
- provider-neutral source-ref normalization
- provider-neutral review request lifecycle
- provider-neutral merge detection for Stage 3.1
- LLM adapter abstraction
- Codex adapter extraction
- Cursor CLI adapter implementation
- preview adapter abstraction
- Cloudflare check-based preview adapter
- prompt-recipe preview adapter
- repo and task model changes needed to configure the above

Out of scope:

- GitHub App auth
- GitLab OAuth app auth
- merge automation
- provider-specific RBAC
- tenant isolation or billing
- exact parity of resume semantics across all LLM CLIs
- structured preview DSLs

## Architecture

## 1. SCM adapter layer

Introduce a provider-neutral SCM abstraction that hides GitHub/GitLab differences from orchestration.

### New normalized types

```ts
type ScmProvider = 'github' | 'gitlab';

type RepoScmConfig = {
  provider: ScmProvider;
  baseUrl?: string;
  projectPath: string;
  defaultBranch: string;
};

type ScmCredentialRef = {
  provider: ScmProvider;
  hostKey: string;
};

type ScmReviewRef = {
  provider: ScmProvider;
  number: number;
  url: string;
};

type ScmCommitCheck = {
  name: string;
  externalUrl?: string;
  detailsUrl?: string;
  summary?: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failed' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped' | 'action_required';
  appSlug?: string;
  rawSource: 'github_check_run' | 'gitlab_pipeline' | 'gitlab_status';
};

type ScmSourceRef =
  | { kind: 'branch'; value: string; label: string }
  | { kind: 'commit'; value: string; label: string }
  | { kind: 'review_head'; value: string; label: string; reviewNumber: number };

type ScmReviewState = {
  exists: boolean;
  state?: 'open' | 'merged' | 'closed';
  url?: string;
  number?: number;
  headSha?: string;
  baseBranch?: string;
  mergedAt?: string;
};
```

### Repo model changes

Current repo fields are too GitHub-specific. Move toward this model:

```ts
type Repo = {
  repoId: string;
  scmProvider: 'github' | 'gitlab';
  scmBaseUrl?: string;
  projectPath: string;
  defaultBranch: string;
  baselineUrl: string;
  enabled: boolean;

  previewMode?: 'auto' | 'skip';
  evidenceMode?: 'auto' | 'skip';

  previewAdapter?: 'cloudflare_checks' | 'prompt_recipe';
  previewConfig?: {
    checkName?: string;
    promptRecipe?: string;
  };

  llmAdapter?: 'codex' | 'cursor_cli';
  llmProfileId?: string;

  createdAt: string;
  updatedAt: string;
};
```

Compatibility defaults:

- existing repos default to `scmProvider = github`
- existing `slug` becomes `projectPath`
- existing repos default to `scmBaseUrl = https://github.com`

### Global credential registry

Add provider/host-scoped credentials stored centrally, not per repo:

```ts
type ProviderCredential = {
  id: string;
  provider: 'github' | 'gitlab' | 'codex' | 'cursor_cli';
  hostKey: string;
  authKind: 'pat' | 'bundle';
  secretRef: string;
  label: string;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- GitHub uses host key `github.com`
- GitLab uses the normalized hostname from `scmBaseUrl`
- repos reference provider/host implicitly from config
- repos never store raw tokens

### SCM adapter interface

Add:

- `src/server/scm/adapter.ts`
- `src/server/scm/github.ts`
- `src/server/scm/gitlab.ts`
- `src/server/scm/registry.ts`
- `src/server/scm/source-ref.ts`

Core interface:

```ts
type ScmAdapter = {
  provider: 'github' | 'gitlab';

  normalizeSourceRef(sourceRef: string, repo: Repo): ScmSourceRef;
  inferSourceRefFromTask(task: Pick<Task, 'sourceRef' | 'title' | 'description' | 'taskPrompt'>, repo: Repo): string | undefined;

  buildCloneUrl(repo: Repo, credential: ProviderCredentialSecret): string;
  createReviewRequest(repo: Repo, task: Task, run: AgentRun, credential: ProviderCredentialSecret): Promise<ScmReviewRef>;
  upsertRunComment(repo: Repo, task: Task, run: AgentRun, credential: ProviderCredentialSecret): Promise<void>;
  getReviewState(repo: Repo, run: AgentRun, credential: ProviderCredentialSecret): Promise<ScmReviewState>;
  listCommitChecks(repo: Repo, headSha: string, credential: ProviderCredentialSecret): Promise<ScmCommitCheck[]>;
  isCommitOnDefaultBranch(repo: Repo, commitSha: string, credential: ProviderCredentialSecret): Promise<boolean>;
};
```

### GitHub adapter

Move current behavior into `GitHubScmAdapter`:

- source-ref URL parsing
- clone URL generation
- PR creation
- PR comment upsert
- check-runs listing
- merged/default-branch confirmation

### GitLab adapter

Implement `GitLabScmAdapter` with support for:

- GitLab MR URLs:
  - `https://gitlab.host/group/project/-/merge_requests/123`
- branch URLs:
  - `https://gitlab.host/group/subgroup/project/-/tree/feature/name`
- commit URLs:
  - `https://gitlab.host/group/project/-/commit/<sha>`
- clone URL auth:
  - `https://oauth2:<token>@<host>/<projectPath>.git`
- MR creation and MR note upsert
- MR state lookup
- default-branch landed confirmation
- commit pipeline/status normalization into `ScmCommitCheck[]`

### Stage 3.1 compatibility

Stage 3.1 merge/readiness behavior becomes provider-neutral:

- open PR or MR maps to task `REVIEW`
- downstream dependency lineage stores provider-neutral review metadata
- merged fallback readiness uses:
  - `getReviewState()`
  - `isCommitOnDefaultBranch()`

## 2. LLM adapter layer

Introduce a provider-neutral execution abstraction for coding agents.

### New normalized types

```ts
type LlmAdapterKind = 'codex' | 'cursor_cli';

type LlmProfile = {
  id: string;
  adapter: LlmAdapterKind;
  defaultModel: string;
  defaultReasoningEffort?: 'low' | 'medium' | 'high';
  authCredentialRef?: string;
  createdAt: string;
  updatedAt: string;
};

type LlmExecutionRequest = {
  repo: Repo;
  task: Task;
  run: AgentRun;
  cwd: string;
  prompt: string;
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
};

type LlmExecutionResult = {
  success: boolean;
  stoppedForTakeover?: boolean;
  stderr?: string;
  resumeCommand?: string;
  threadId?: string;
};
```

### Task/UI model changes

Replace Codex-specific task runtime fields:

Current:

- `codexModel`
- `codexReasoningEffort`

New:

```ts
type TaskUiMeta = {
  simulationProfile?: SimulationProfile;
  llmAdapter?: 'codex' | 'cursor_cli';
  llmModel?: string;
  llmReasoningEffort?: 'low' | 'medium' | 'high';
};
```

Compatibility:

- `codexModel` maps to `llmModel`
- `codexReasoningEffort` maps to `llmReasoningEffort`
- default adapter remains `codex`

### LLM adapter interface

Add:

- `src/server/llm/adapter.ts`
- `src/server/llm/codex.ts`
- `src/server/llm/cursor-cli.ts`
- `src/server/llm/registry.ts`

Core interface:

```ts
type LlmAdapter = {
  kind: 'codex' | 'cursor_cli';

  ensureInstalled(sandbox: SandboxHandle, repoBoard: RepoBoardHandle, runId: string): Promise<void>;
  restoreAuth(env: Env, sandbox: SandboxHandle, repo: Repo, runId: string, repoBoard: RepoBoardHandle): Promise<void>;
  logDiagnostics(sandbox: SandboxHandle, runId: string, repoBoard: RepoBoardHandle, request: LlmExecutionRequest): Promise<void>;
  waitForCapacityIfNeeded?(sandbox: SandboxHandle, runId: string, repoBoard: RepoBoardHandle, request: LlmExecutionRequest, sleepFn: SleepFn): Promise<void>;
  run(sandbox: SandboxHandle, repoBoard: RepoBoardHandle, runId: string, request: LlmExecutionRequest): Promise<LlmExecutionResult>;
};
```

### Codex adapter

Extract current Codex-specific behavior into `CodexLlmAdapter`:

- auth bundle restore
- CLI ensure/install
- rate-limit preflight and wait
- JSON event stream parsing
- resume command extraction
- takeover-aware process handling

### Cursor CLI adapter

First pass expectations:

- selectable as `llmAdapter = cursor_cli`
- installs or verifies Cursor CLI in sandbox
- restores auth bundle from a global credential
- executes non-interactively if supported
- may not support resumable sessions in v1

Product rule:

- if Cursor CLI cannot provide a reliable resume command, the run must report no resume support instead of pretending parity with Codex

## 3. Preview adapter layer

Make preview resolution independent from both SCM and Cloudflare.

### New normalized types

```ts
type PreviewAdapterKind = 'cloudflare_checks' | 'prompt_recipe';

type PreviewResolution = {
  previewUrl?: string;
  adapter: PreviewAdapterKind;
  explanation: string;
  diagnostics: Array<Record<string, string | number | boolean>>;
};
```

### Repo preview configuration

Use:

```ts
type Repo = {
  ...
  previewMode?: 'auto' | 'skip';
  evidenceMode?: 'auto' | 'skip';
  previewAdapter?: 'cloudflare_checks' | 'prompt_recipe';
  previewConfig?: {
    checkName?: string;
    promptRecipe?: string;
  };
};
```

### Preview adapter interface

Add:

- `src/server/preview/adapter.ts`
- `src/server/preview/cloudflare-checks.ts`
- `src/server/preview/prompt-recipe.ts`
- `src/server/preview/registry.ts`

Core interface:

```ts
type PreviewAdapter = {
  kind: 'cloudflare_checks' | 'prompt_recipe';

  resolvePreview(
    repo: Repo,
    task: Task,
    run: AgentRun,
    deps: {
      scm: ScmAdapter;
      scmCredential: ProviderCredentialSecret;
      llm?: LlmAdapter;
      llmProfile?: LlmProfile;
    }
  ): Promise<PreviewResolution>;
};
```

### Cloudflare checks adapter

Refactor current preview discovery so it:

- consumes normalized `ScmCommitCheck[]`
- does not call GitHub APIs directly
- works with either GitHub or GitLab if SCM adapters can expose normalized checks/pipeline data

### Prompt recipe adapter

Customer supplies free-form preview instructions in `previewConfig.promptRecipe`.

Behavior:

- invoke the selected LLM adapter with a narrow task:
  - obtain one usable preview URL
  - use repo metadata, branch, commit, review URL, baseline URL, and normalized checks/statuses
  - return strict JSON `{ "previewUrl": "https://..." }`
- if no valid preview URL is produced, fail preview resolution clearly
- if `evidenceMode = skip`, do not launch evidence even after preview succeeds

## Public API changes

### Repo APIs

`POST /api/repos` and `PATCH /api/repos/:repoId` should support:

```json
{
  "projectPath": "group/subgroup/project",
  "scmProvider": "gitlab",
  "scmBaseUrl": "https://gitlab.company.com",
  "defaultBranch": "main",
  "baselineUrl": "https://app.example.com",
  "enabled": true,
  "previewMode": "auto",
  "evidenceMode": "skip",
  "previewAdapter": "cloudflare_checks",
  "previewConfig": {
    "checkName": "Workers Builds: app"
  },
  "llmAdapter": "codex",
  "llmProfileId": "codex-default"
}
```

Compatibility layer must still accept:

- legacy `slug`
- legacy `previewProvider`
- legacy Codex-specific task fields

### Provider credential APIs

Add:

- `GET /api/provider-credentials`
- `POST /api/provider-credentials`
- `PATCH /api/provider-credentials/:credentialId`

These store:

- GitHub global credential
- GitLab host credentials
- Codex auth bundle reference
- Cursor CLI auth bundle reference

### Task APIs

Task create/update should support:

- `llmAdapter`
- `llmModel`
- `llmReasoningEffort`

and continue accepting:

- `codexModel`
- `codexReasoningEffort`

### Run model changes

Add provider-neutral review/runtime fields:

```ts
type AgentRun = {
  ...
  reviewUrl?: string;
  reviewNumber?: number;
  reviewProvider?: 'github' | 'gitlab';
  llmAdapter?: 'codex' | 'cursor_cli';
  llmResumeCommand?: string;
  llmSessionId?: string;
};
```

Compatibility:

- keep `prUrl` / `prNumber` during migration as aliases

## UI changes

### Repo settings

Replace GitHub/Codex-specific assumptions with:

- SCM provider select
- SCM base URL
- project path
- preview mode / preview adapter config
- LLM adapter / profile selection

### Task and run detail

Use provider-neutral language:

- “Review” instead of “PR” in generic surfaces
- show provider badge: `GitHub` or `GitLab`
- show executor badge: `Codex` or `Cursor CLI`
- show preview adapter type
- if executor does not support resume, surface that truthfully

## Implementation order

### Phase A: SCM adapters and GitLab support

1. Introduce provider-neutral repo fields and migration defaults.
2. Add provider credential registry and APIs.
3. Extract GitHub logic into `GitHubScmAdapter`.
4. Move source-ref parsing behind SCM adapter.
5. Refactor orchestrator to use SCM adapter for clone, review creation, comments, checks, and merge state.
6. Refactor Stage 3.1 merge/readiness logic to use provider-neutral review state.
7. Implement `GitLabScmAdapter`.
8. Add GitLab MR source-ref parsing, MR creation, and merge detection.
9. Add smoke-test docs for hosted GitLab using `glab` as an operator validation tool.

### Phase B: LLM adapters

1. Rename Codex-specific task/runtime config to generic LLM config.
2. Extract current Codex behavior into `CodexLlmAdapter`.
3. Add LLM credential/profile registry.
4. Implement `CursorCliLlmAdapter`.
5. Update UI to reflect generic executor metadata and resume capability.

### Phase C: Preview adapters

1. Refactor Cloudflare preview detection to consume normalized SCM checks.
2. Add preview adapter registry.
3. Implement `cloudflare_checks`.
4. Implement `prompt_recipe`.
5. Update repo settings UI for prompt-based preview recipes.

## Test cases

### SCM adapter tests

- GitHub clone/push/PR flow remains unchanged
- GitHub source-ref parsing still supports PR/branch/commit URLs
- GitLab MR URL parsing works for hosted and self-managed base URLs
- GitLab branch and commit URLs work with subgroup paths
- wrong-repo source URLs are rejected for both providers
- GitHub merged PR plus default-branch reachability unblocks downstream tasks
- GitLab merged MR plus default-branch reachability unblocks downstream tasks
- closed-not-merged reviews do not unblock downstream tasks

### LLM adapter tests

- Codex path still supports rate-limit waiting, resume command extraction, and takeover flow
- Cursor CLI runs can execute successfully
- Cursor CLI runs truthfully report lack of resume support if unsupported

### Preview adapter tests

- Cloudflare preview extraction still works with GitHub normalized checks
- Cloudflare preview extraction works with GitLab normalized pipelines/statuses
- prompt recipe can return a valid preview URL
- malformed prompt recipe result fails with clear diagnostics
- `previewMode = skip` bypasses preview work entirely

### End-to-end scenarios

1. GitHub repo + Codex + Cloudflare checks
2. GitLab repo + Codex + preview skipped
3. GitLab repo + Codex + Cloudflare checks
4. GitLab repo + Cursor CLI + preview skipped
5. Stage 3.1 fanout on GitLab:
   - Task A opens MR
   - Task B auto-starts from A review head
   - A merges
   - Task C starts from default branch if it had not started before merge

## Documentation changes

Add:

- `docs/stage_3_5.md`
- `docs/git-providers.md`
- `docs/llm-adapters.md`
- `docs/preview-adapters.md`

Update:

- `docs/stage_3.md`
- `docs/stage_3_1.md`
- `docs/api_prompt.md`

The docs should explicitly state:

- GitHub/GitLab support is runtime-provider-based, not CLI-based
- `glab` is acceptable for local/operator testing, not a runtime dependency
- Codex remains default, Cursor CLI is the second executor
- custom preview recipes are LLM-driven prompt recipes

## Acceptance criteria

Stage 3.5 is complete when:

- the same task/run/orchestration flow works against GitHub or GitLab repos
- hosted/self-managed GitLab repos can complete Stage 3 review flow through MR creation
- Stage 3.1 dependency fanout and merged-to-default-branch fallback work for GitLab as well as GitHub
- Codex behavior is preserved behind an LLM adapter
- Cursor CLI can be selected for at least basic non-resumable runs
- preview logic is no longer hard-wired to GitHub plus Cloudflare
- preview skip, Cloudflare checks, and prompt-recipe modes are all supported in repo configuration
- UI no longer assumes “PR” and “Codex” are universal concepts
