# AgentBoard Stage 4.5 (Tenant Metering)

## Goal

Stage 4.5 adds the minimum tenant model and usage accounting needed to run AgentBoard as a shared SaaS.

Stage 4 already adds the runtime visibility needed to meter usage:

- run events
- command records
- operator sessions
- sandbox attachment
- richer workflow metadata

Stage 4.5 uses that signal to make the product tenant-aware without changing Stage 4 scope while it is already in progress.

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
- cost tracking is approximate attribution, not invoice-grade billing
- usage is recorded per run and aggregated per tenant
- usage accounting must be product-generated, not inferred only from Cloudflare dashboards
- all new entities added after this stage must carry `tenantId`

## Scope

In scope:

- first-class `tenantId` ownership
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
  createdAt: string;
  updatedAt: string;
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

### New endpoints

Add:

- `GET /api/tenants`
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

- store usage ledger entries in a dedicated SQLite-backed Durable Object namespace unless reporting needs force a later move to D1

Default:

- continue with SQLite-backed Durable Objects for consistency with the current architecture
- revisit D1 only if reporting queries become awkward or too expensive

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
- APIs and board subscriptions are tenant-scoped server-side
- every run emits usage ledger entries
- the product can show per-run and per-tenant estimated usage and cost
- artifact access is tenant-scoped
- operator attach and takeover are denied across tenant boundaries
- the system can produce daily and monthly tenant usage summaries

## Test cases and scenarios

### Ownership and isolation

- creating a repo requires a tenant owner
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

## Recommended build order

1. Add Stage 4.5 docs and lock the tenancy and metering contract.
2. Add `tenantId` to core DTOs and persisted state.
3. Add tenant-aware auth and tenant-scoped API filtering.
4. Add usage ledger model and write paths from Workflow, Worker, and operator session flows.
5. Add R2 tenant-prefixed object layout and access checks.
6. Add tenant usage APIs and run usage detail API.
7. Add tenant selector and usage views in the UI.
8. Validate aggregate estimated totals against Cloudflare account-level metrics.

## Assumptions and defaults

- Stage 4 remains in progress and is not re-scoped
- initial rollout is shared SaaS
- cost reporting is approximate attribution, not invoice-grade billing
- one repo belongs to one tenant only
- one operator request is evaluated in one tenant context at a time
- platform-admin cross-tenant views are out of scope for this stage
- rate tables are configurable and versioned
- Cloudflare native analytics are used for reconciliation, not direct tenant billing
