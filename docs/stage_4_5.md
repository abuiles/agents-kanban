# AgentsKanban Stage 4.5 (Tenant Metering)

**Status:** ⚙️ In Progress

## Execution defaults

- Run the local app from `localhost:5173`.
- Use same-origin API calls at `http://localhost:5173/api`.
- All implementation tasks in this plan use:
  - `codexModel`: `gpt-5.3-codex`
  - `codexReasoningEffort`: `medium`

Execution baseline command:

```bash
npm run dev
```

## Goal

Stage 4.5 adds the minimum tenant model and usage accounting needed to run AgentsKanban as a shared SaaS.

Stage 4 already adds the runtime visibility needed to meter usage:

- run events
- command records
- operator sessions
- sandbox attachment
- richer workflow metadata

Stage 4.5 uses that signal to make the product tenant-aware without changing Stage 4 scope while it is already in progress.

Important: Stage 4.5 defines tenant ownership and metering, while per-tenant run capacity, queuing, and fairness controls are implemented in Stage 7+ scheduler work.

## Why this stage exists

The current roadmap assumes a single trust boundary for too long:

- Stage 2 is repo-scoped
- Stage 3 uses a global credential model
- Stage 4 adds powerful operator attach flows
- Stage 8 defers broader hardening

That is acceptable for an internal tool, but it is too late for a shared SaaS where multiple companies use the same deployment.

Stage 4.5 fixes that timing problem without re-scoping Stage 4.

## Product decisions locked in

- Stage 4 remains unchanged in scope and sequencing
- Stage 4.5 is the first tenancy-aware stage
- the initial business model is shared SaaS, not one deployment per customer
- tenant core, tenant memberships/seats, tenant-scoped access, and usage/metering all land in Stage 4.5
- container-level capacity configuration (`max_instances`) remains an infrastructure-level limit
- cost tracking is approximate attribution, not invoice-grade billing
- usage is recorded per run and aggregated per tenant
- usage accounting must be product-generated, not inferred only from Cloudflare dashboards
- provider credential ownership is explicitly deferred to a later stage
- Stage 4.5 must work whether execution currently relies on a developer-connected account or a later tenant-owned provider credential model
- all new entities added after this stage must carry `tenantId`

## Stage 4.5 contract note (locked, non-reversible)

This section is normative. Stage 4.5 implementation and follow-up tasks must conform to this contract.

Contract lock:

- Stage 4.5 scope is frozen to tenant core, memberships/seats, tenant-scoped access control, and usage accounting/metering.
- Stage 4.5 must not expand to provider credential ownership decisions.
- Stage 4.5 must not redefine Stage 4 operator observe/attach/takeover behavior.
- any change that would violate these constraints is out of Stage 4.5 scope and must be introduced as a later-stage change.

Explicit preservation of Stage 4 flows:

- preserve Stage 4 observe endpoints and semantics (`/api/runs/:runId/events`, `/api/runs/:runId/commands`)
- preserve Stage 4 attach endpoints and semantics (`/api/runs/:runId/terminal`, `/api/runs/:runId/ws`)
- preserve Stage 4 takeover endpoint semantics (`POST /api/runs/:runId/takeover`)
- add tenant authorization checks around these flows without changing their Stage 4 operator intent

Explicit deferral of provider-owned credentials:

- tenant-owned OpenAI/API-provider credentials are deferred
- tenant-owned ChatGPT/Codex/Cursor account ownership is deferred
- provider credential source-of-truth and per-tenant switching policy are deferred
- current execution may continue using the existing developer-connected provider path until a later stage introduces tenant-owned provider credentials

## Organization model additions

- Stage 4.5 introduces persistent operator identity for org signup and membership enforcement.
- Minimal implementation baseline uses D1 for identity + tenant metadata and DOs for board/task/run workflow state.

## Scope

In scope:

- first-class `tenantId` ownership
- tenant membership and seat assignment
- tenant-scoped repos, tasks, runs, events, commands, and operator sessions
- per-run usage ledger entries
- per-tenant aggregated usage and estimated cost views
- tenant-aware auth checks on read and write APIs
- groundwork for Stage 7 quotas and Stage 8 billing/policy hardening

Out of scope:

- invoice-grade billing
- payment collection
- customer invoicing UI
- full RBAC design
- tenant-owned OpenAI API keys
- tenant-owned ChatGPT, Codex, or Cursor account connections
- per-tenant provider credential switching or policy
- per-tenant dedicated infrastructure deployments
- exact Cloudflare invoice reconciliation

## Additive model

### Tenant

```ts
type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  domain?: string;
  createdByUserId: string;
  defaultSeatLimit: number;
  seatLimit: number;
  settings?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
};
```

### Tenant membership

```ts
type TenantMember = {
  id: string;
  tenantId: string;
  userId: string;
  role: 'owner' | 'member';
  seatState: 'active' | 'invited' | 'revoked';
  createdAt: string;
  updatedAt: string;
};
```

### User

```ts
type User = {
  id: string;
  email: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
};
```

### Session

```ts
type UserSession = {
  id: string;
  userId: string;
  tenantId: string;
  activeTenantId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
};
```

### Seat summary

```ts
type TenantSeatSummary = {
  tenantId: string;
  seatLimit: number;
  seatsUsed: number;
  seatsAvailable: number;
};
```

### Ownership changes

Add `tenantId` to:

- `Repo`
- `Task`
- `Run`
- `RunEvent`
- `RunCommand`
- `OperatorSession`
- artifact manifest records
- board snapshot and projection DTOs that return tenant-owned records

Rules:

- a repo belongs to exactly one tenant
- a task belongs to the same tenant as its repo
- a run belongs to the same tenant as its task and repo
- every authenticated operator acts through a tenant membership
- an operator can access a tenant only if they hold an active seat in that tenant
- cross-tenant reads and writes are forbidden server-side

### Usage ledger

```ts
type UsageLedgerEntry = {
  id: string;
  tenantId: string;
  repoId: string;
  taskId?: string;
  runId?: string;
  at: string;
  category:
    | 'worker_request'
    | 'workflow_execution'
    | 'workflow_step'
    | 'workflow_duration_ms'
    | 'sandbox_runtime_ms'
    | 'operator_session_ms'
    | 'r2_storage_bytes'
    | 'r2_write_ops'
    | 'r2_read_ops'
    | 'artifact_download'
    | 'durable_object_request'
    | 'durable_object_storage_bytes';
  quantity: number;
  unit: string;
  source: 'worker' | 'workflow' | 'sandbox' | 'operator' | 'system';
  metadata?: Record<string, string | number | boolean>;
};
```

### Cost rate table

```ts
type CostRateConfig = {
  version: string;
  effectiveAt: string;
  rates: Record<string, number>;
};
```

Example usage:

- `workflow_execution` -> estimated dollars per execution
- `workflow_step` -> estimated dollars per step
- `sandbox_runtime_ms` -> estimated dollars per millisecond
- `r2_storage_bytes` -> estimated dollars per byte-month proxy rate

### Tenant usage summary

```ts
type TenantUsageSummary = {
  tenantId: string;
  windowStart: string;
  windowEnd: string;
  totals: {
    runs: number;
    workflowExecutions: number;
    workflowSteps: number;
    sandboxRuntimeMs: number;
    operatorSessionMs: number;
    r2StorageBytes: number;
    r2WriteOps: number;
    r2ReadOps: number;
    estimatedCostUsd: number;
  };
};
```

## Architecture changes

### Durable Objects

Keep Stage 4 objects in place. Add tenant awareness instead of replacing the current architecture.

`BoardIndexDO`

- stores tenant metadata
- resolves tenant -> repos
- rejects cross-tenant board queries
- supports tenant-scoped board snapshots and tenant-scoped WebSocket fanout

`RepoBoardDO`

- persists tenant-owned repo, task, run, event, command, and operator-session data
- emits usage ledger entries when run state changes or operator sessions change

Rules:

- repo remains the coordination unit
- tenant becomes a mandatory ownership attribute on every repo-scoped object

### Workflows

Each workflow instance must receive `tenantId` in its input payload.

Stage 4.5 adds these workflow responsibilities:

- emit usage entries for execution start and end
- emit usage entries for significant steps
- emit runtime duration totals at completion
- tag artifacts and logs with tenant-owned metadata
- treat sandbox startup/runtime failures as tenant-attributed usage and platform signals, then normalize queue/fairness logic in Stage 7+

### R2 object layout

Move to tenant-prefixed keys:

- `tenants/<tenantId>/runs/<runId>/logs/worker.ndjson`
- `tenants/<tenantId>/runs/<runId>/logs/executor.txt`
- `tenants/<tenantId>/runs/<runId>/logs/evidence.txt`
- `tenants/<tenantId>/runs/<runId>/manifest.json`
- `tenants/<tenantId>/runs/<runId>/evidence/*`

Rules:

- artifact access checks must validate both `tenantId` and run ownership
- old non-tenant-prefixed keys do not need migration in this stage unless the product already has shared-SaaS data

## API changes

### Tenant-aware request model

Every authenticated request must resolve an operator identity and an allowed tenant set.

Recommended initial model:

- one active tenant context per session or request
- explicit tenant selection in the UI
- all list and detail endpoints filter by current tenant
- membership lookup and seat enforcement happen before repo/task/run authorization
- provider credential ownership is not resolved here; Stage 4.5 only establishes who can act for a tenant, not which external AI account the tenant owns

### New endpoints

Add:

- `GET /api/tenants`
- `POST /api/tenants`
- `GET /api/tenants/:tenantId`
- `PATCH /api/tenants/:tenantId`
- `GET /api/tenants/:tenantId/members`
- `POST /api/tenants/:tenantId/members`
- `PATCH /api/tenants/:tenantId/members/:memberId`
- `POST /api/me/tenant-context`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/tenant-usage?tenantId=&from=&to=`
- `GET /api/tenant-usage/runs?tenantId=&from=&to=`
- `GET /api/runs/:runId/usage`

### Existing endpoint changes

Add tenant scoping to:

- `GET /api/board`
- `GET /api/board/ws`
- `POST /api/repos`
- `GET /api/repos`
- `PATCH /api/repos/:repoId`
- `POST /api/tasks`
- `GET /api/tasks`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`
- `POST /api/tasks/:taskId/run`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/commands`
- `GET /api/runs/:runId/terminal`
- `GET /api/runs/:runId/ws`
- `POST /api/runs/:runId/takeover`

Rules:

- tenant scoping must be enforced server-side
- no endpoint may return resources from multiple tenants unless explicitly designed for platform-admin use
- run attach and takeover must fail if the operator is not authorized for the run's tenant

## Metering model

### What to record

Record usage at these moments:

Run lifecycle:

- run created
- workflow started
- workflow completed
- workflow failed

Workflow:

- each major step entered
- total workflow duration at completion

Sandbox:

- sandbox allocated
- sandbox attach opened
- sandbox attach closed
- total sandbox runtime at completion

Operator:

- session opened
- session closed
- total operator-controlled session duration

Artifacts:

- artifact manifest written
- artifact object written
- artifact object read via product endpoint
- total stored artifact bytes per run

Control plane:

- Worker API request count
- Durable Object request count where practical to estimate

### Estimation model

For each ledger category:

- multiply `quantity` by a configurable rate from `CostRateConfig`
- store both raw usage totals and estimated USD totals
- version rates so old runs remain explainable

Rules:

- estimated cost must be reproducible from stored ledger entries
- cost formulas must be configurable without rewriting historical usage
- dashboards must label figures as estimated, not invoice-exact

## Storage choice

Recommended implementation:

- store identity, tenant metadata, and usage ledger entries in D1
- keep repo/task/run/event/command/operator-session projections in Durable Objects
- keep short-horizon counters and workflow telemetry in Durable Objects when needed for low-latency reads

Default:

- use D1 as the canonical store for tenant/auth and usage tables
- use DO-backed projections for active runtime state and board streams

## Analytics integration

Use Cloudflare native analytics for platform reconciliation, not tenant ownership.

Use:

- Workers metrics for script-level totals
- Durable Objects metrics for namespace-level totals
- Workflows metrics for workflow totals
- R2 metrics for bucket totals
- Workers Analytics Engine only if ad hoc analytic querying becomes useful beyond the product ledger

Rules:

- tenant attribution comes from product-emitted usage ledger entries
- Cloudflare native analytics are used to compare aggregate totals and calibrate estimation rates

## UI expectations

Add:

- tenant selector in the app shell
- tenant member and seat summary surface, even if invite management stays minimal
- tenant-scoped board and repo views
- tenant usage summary page
- run detail usage panel showing per-run consumption and estimated cost
- usage labels that clearly mark cost figures as estimated

Display at minimum:

- runs in period
- sandbox runtime
- workflow count and duration
- operator session time
- artifact bytes stored
- estimated total cost

## Acceptance criteria

Stage 4.5 is complete when:

- every repo, task, run, event, command, and operator session has a `tenantId`
- every operator-facing request resolves through an active tenant membership and seat check
- APIs and board subscriptions are tenant-scoped server-side
- every run emits usage ledger entries
- the product can show per-run and per-tenant estimated usage and cost
- artifact access is tenant-scoped
- operator attach and takeover are denied across tenant boundaries
- the system can produce daily and monthly tenant usage summaries

## Test cases and scenarios

### Ownership and isolation

- creating a repo requires a tenant owner
- switching tenant context requires an active membership in that tenant
- a revoked or seatless member cannot open board, run, or usage views for that tenant
- listing repos only returns repos for the active tenant
- reading a task or run from another tenant returns an authorization failure
- board WebSocket only streams tenant-owned updates

### Run metering

- a successful run writes usage entries for workflow, sandbox, and artifacts
- a failed run still writes partial usage entries
- retrying evidence appends new usage entries without overwriting old ones
- operator takeover adds operator session usage for that run

### Artifact and attach security

- artifact reads fail across tenants
- terminal attach fails across tenants
- takeover fails across tenants
- same-tenant authorized attach succeeds

### Aggregation

- tenant summary totals equal the sum of underlying ledger entries
- run usage detail matches the run's emitted events and artifacts
- historical cost estimates remain stable when rate versions change

### Regression protection

- Stage 4 operator session flows still work when tenant metadata is present
- Stage 5 audit design can consume tenant-aware run data without schema rewrite
- Stage 7 queueing can add tenant-level quotas without changing run ownership again

## Execution-ready task graph

### S45-00. Lock contract and explicit deferrals

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- freeze Stage 4.5 scope around tenant core, memberships/seats, tenant-scoped access, and usage/metering
- document that provider credential ownership is deferred
- document that current execution may continue using the existing developer-connected credential path until a later stage introduces tenant-owned provider credentials

Depends on:

- none

Unblocks:

- every other Stage 4.5 task

### S45-10. Tenant core data model

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- add `Tenant` model and persistence contract
- add `tenantId` ownership to repo/task/run/event/command/operator-session/artifact projection models
- define ownership invariants and required migration defaults for pre-tenant records
- add D1 tables for `tenants`, `users`, `user_sessions`, and `tenant_memberships` (schema and seed strategy)

Depends on:

- `S45-00`

Unblocks:

- `S45-20`
- `S45-30`
- `S45-40`
- `S45-50`
- `S45-60`

### S45-20. Tenant memberships and seats

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- add `TenantMember` and seat summary model
- define active membership and seat enforcement rules
- define minimal owner/member role semantics needed for Stage 4.5 authorization
- implement tenant signup and membership endpoints:
  - `POST /api/tenants`
  - `POST /api/tenants/:tenantId/members`
  - `PATCH /api/tenants/:tenantId/members/:memberId`

Depends on:

- `S45-10`

Unblocks:

- `S45-30`
- `S45-80`

### S45-30. Tenant context resolution and access control

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- resolve authenticated operator -> allowed tenant set -> active tenant context
- enforce membership and seat checks before repo/task/run access
- define authorization failure behavior for cross-tenant reads, writes, attach, and takeover
- implement `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `GET /api/me`, `POST /api/me/tenant-context`

Depends on:

- `S45-10`
- `S45-20`

Unblocks:

- `S45-40`
- `S45-50`
- `S45-70`
- `S45-80`

### S45-40. Tenant-scoped persistence, APIs, and board fanout

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- persist tenant-owned records in `BoardIndexDO` and `RepoBoardDO`
- add tenant-scoped filtering to board, repo, task, and run APIs
- make board snapshots and WebSocket fanout tenant-scoped

Depends on:

- `S45-10`
- `S45-30`

Unblocks:

- `S45-50`
- `S45-60`
- `S45-70`
- `S45-80`

### S45-50. Workflow propagation and tenant-owned artifact layout

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- require `tenantId` in workflow input and runtime metadata
- move artifacts and logs to tenant-prefixed R2 keys
- enforce tenant checks on artifact download, terminal attach, and takeover-related resource reads

Depends on:

- `S45-10`
- `S45-30`
- `S45-40`

Unblocks:

- `S45-60`
- `S45-70`

### S45-60. Usage ledger emission

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- add `UsageLedgerEntry` storage and rate-version metadata
- emit ledger entries from workflow lifecycle, sandbox lifecycle, operator sessions, artifact reads/writes, and control-plane estimates
- guarantee partial usage recording for failed runs

Depends on:

- `S45-10`
- `S45-40`
- `S45-50`

Unblocks:

- `S45-70`
- `S45-80`

### S45-70. Usage aggregation and reporting APIs

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- add per-run usage detail endpoint
- add tenant usage summary and run-list usage endpoints
- implement daily/monthly aggregation that is reproducible from ledger entries and rate versions

Depends on:

- `S45-30`
- `S45-40`
- `S45-50`
- `S45-60`

Unblocks:

- `S45-80`
- Stage 7 tenant quotas
- Stage 8 billing and policy hardening

### S45-80. Tenant-aware UI shell and operator surfaces

Assigned execution model: `gpt-5.3-codex`, `codexReasoningEffort: medium`.

Deliverables:

- add tenant selector and active-tenant app shell treatment
- show tenant-scoped board and repo/task/run views
- add tenant usage summary, per-run usage panel, and member/seat summary view
- label estimated cost clearly and preserve current Stage 4 attach workflows inside the active tenant

Depends on:

- `S45-20`
- `S45-30`
- `S45-40`
- `S45-60`
- `S45-70`

Unblocks:

- operator validation
- rollout readiness

## Dependency graph

```text
S45-00
  -> S45-10
S45-10
  -> S45-20
  -> S45-30
  -> S45-40
  -> S45-50
  -> S45-60
S45-20
  -> S45-30
  -> S45-80
S45-30
  -> S45-40
  -> S45-50
  -> S45-70
  -> S45-80
S45-40
  -> S45-50
  -> S45-60
  -> S45-70
  -> S45-80
S45-50
  -> S45-60
  -> S45-70
S45-60
  -> S45-70
  -> S45-80
S45-70
  -> S45-80
  -> Stage 7 quotas
  -> Stage 8 billing/policy
```

## Parallel fanout points

- After `S45-10`, split work between tenant membership/seats (`S45-20`) and raw ownership propagation (`S45-40` prep and `S45-50` prep).
- After `S45-30`, API/board isolation (`S45-40`) and workflow/artifact changes (`S45-50`) can proceed in parallel if both consume the same tenant-resolution contract.
- After `S45-60`, reporting APIs (`S45-70`) and UI presentation wiring (`S45-80` partial work) can overlap, but `S45-80` should not finalize until aggregation contracts are stable.

## Explicit deferral: provider credential ownership

Stage 4.5 must not decide whether a tenant brings:

- its own OpenAI API key
- a tenant-owned ChatGPT account
- a tenant-owned Codex account
- a tenant-owned Cursor account

Stage 4.5 only establishes:

- which tenant a run belongs to
- which members have seats and can act for that tenant
- how tenant-owned activity is isolated and metered

Later work can layer provider credential ownership onto this model by attaching credentials or account connections to a tenant without rewriting tenant ownership, membership, or usage semantics.

## Assumptions and defaults

- Stage 4 remains in progress and is not re-scoped
- initial rollout is shared SaaS
- cost reporting is approximate attribution, not invoice-grade billing
- one repo belongs to one tenant only
- one operator request is evaluated in one tenant context at a time
- seat enforcement is required for tenant access even if seat purchase and invite workflows remain minimal in Stage 4.5
- platform-admin cross-tenant views are out of scope for this stage
- execution may continue using the existing developer-connected provider path until tenant-owned provider credentials are introduced later
- rate tables are configurable and versioned
- Cloudflare native analytics are used for reconciliation, not direct tenant billing
