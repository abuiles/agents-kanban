import type { AgentRun, BoardSnapshotV1, Repo, RunCommand, RunEvent, RunLogEntry, Task } from '../domain/types';

const now = new Date('2026-03-01T12:00:00.000Z');

function iso(minutesAgo: number) {
  return new Date(now.getTime() - minutesAgo * 60_000).toISOString();
}

const repos: Repo[] = [
  {
    repoId: 'repo_website',
    slug: 'acme/site-marketing',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'acme/site-marketing',
    defaultBranch: 'main',
    baselineUrl: 'https://www.acme.test',
    enabled: true,
    createdAt: iso(600),
    updatedAt: iso(300)
  },
  {
    repoId: 'repo_dashboard',
    slug: 'acme/internal-dashboard',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'acme/internal-dashboard',
    defaultBranch: 'main',
    baselineUrl: 'https://dashboard.acme.test',
    enabled: true,
    createdAt: iso(540),
    updatedAt: iso(240)
  },
  {
    repoId: 'repo_stage_45',
    slug: 'stage-4.5-tenant-metering',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'acme/stage-4.5-tenant-metering',
    defaultBranch: 'main',
    baselineUrl: 'https://stage45.internal.example',
    enabled: true,
    createdAt: iso(90),
    updatedAt: iso(10)
  }
];

const tasks: Task[] = [
  {
    taskId: 'task_landing',
    repoId: 'repo_website',
    title: 'Refresh homepage hero copy',
    description: 'Update headline and CTA hierarchy to align with launch messaging.',
    taskPrompt: 'Update the homepage hero section to match the new March launch story.',
    acceptanceCriteria: ['Hero headline mentions automation', 'Primary CTA is Start free trial', 'Secondary CTA links to product tour'],
    context: {
      links: [{ id: 'link_1', label: 'Launch brief', url: 'https://docs.example.invalid/launch-brief' }],
      notes: 'Keep the existing visual treatment; only update copy and spacing if needed.'
    },
    status: 'READY',
    createdAt: iso(220),
    updatedAt: iso(20),
    uiMeta: { simulationProfile: 'happy_path' }
  },
  {
    taskId: 'task_pricing',
    repoId: 'repo_website',
    title: 'Audit pricing page comparison table',
    description: 'Add missing enterprise row and clarify annual billing language.',
    taskPrompt: 'Adjust pricing comparison table content and wording for enterprise plan.',
    acceptanceCriteria: ['Enterprise row appears', 'Annual billing language matches plan docs'],
    context: { links: [], notes: 'Use current layout.' },
    status: 'INBOX',
    createdAt: iso(180),
    updatedAt: iso(60),
    uiMeta: { simulationProfile: 'happy_path' }
  },
  {
    taskId: 'task_nav',
    repoId: 'repo_dashboard',
    title: 'Fix settings navigation overflow',
    description: 'The mobile settings nav wraps awkwardly.',
    taskPrompt: 'Make the settings nav scroll horizontally on small screens.',
    acceptanceCriteria: ['Nav stays on one line below 768px', 'No overlap with content header'],
    context: { links: [], notes: 'Preview on mobile layout.' },
    status: 'ACTIVE',
    createdAt: iso(150),
    updatedAt: iso(10),
    runId: 'run_nav_1',
    uiMeta: { simulationProfile: 'happy_path' }
  },
  {
    taskId: 'task_kpi',
    repoId: 'repo_dashboard',
    title: 'Add funnel KPI definitions',
    description: 'Document KPI definitions directly in the dashboard.',
    taskPrompt: 'Add hover or inline definitions for the top-line funnel metrics.',
    acceptanceCriteria: ['Every KPI has definition copy', 'Definitions match analytics glossary'],
    context: {
      links: [{ id: 'link_2', label: 'Analytics glossary', url: 'https://docs.example.invalid/glossary' }]
    },
    status: 'REVIEW',
    createdAt: iso(300),
    updatedAt: iso(15),
    runId: 'run_kpi_1',
    uiMeta: { simulationProfile: 'happy_path' }
  },
  {
    taskId: 'task_auth',
    repoId: 'repo_dashboard',
    title: 'Resolve failing auth settings test',
    description: 'Mocked suite should show a failed run to demo recovery.',
    taskPrompt: 'Stabilize auth settings test around region selection.',
    acceptanceCriteria: ['No flaky auth settings test', 'Document root cause in PR'],
    context: { links: [], notes: 'This task is seeded to demo the Failed column.' },
    status: 'FAILED',
    createdAt: iso(360),
    updatedAt: iso(30),
    runId: 'run_auth_1',
    uiMeta: { simulationProfile: 'fail_tests' }
  },
  {
    taskId: 'task_export',
    repoId: 'repo_website',
    title: 'Add board JSON export affordance',
    description: 'Seeded done task for the full board story.',
    taskPrompt: 'Ship a board export affordance.',
    acceptanceCriteria: ['Export downloads JSON'],
    context: { links: [], notes: 'Already completed.' },
    status: 'DONE',
    createdAt: iso(500),
    updatedAt: iso(100),
    uiMeta: { simulationProfile: 'happy_path' }
  },
  {
    taskId: 'task_s45_00',
    repoId: 'repo_stage_45',
    title: 'S45-00 Lock contract and explicit deferrals',
    description: 'Lock the Stage 4.5 scope and document explicit credential ownership deferrals.',
    taskPrompt: 'Create a complete, non-reversible contract note for Stage 4.5: tenant core scope, usage accounting scope, and deferred provider-owned credentials.',
    acceptanceCriteria: [
      'Contract is documented',
      'Provider credential ownership explicitly deferred in plan docs',
      'Existing Stage 4 flows preserved'
    ],
    context: { links: [], notes: 'Use gpt-5.3-codex / medium.' },
    status: 'INBOX',
    createdAt: iso(70),
    updatedAt: iso(70),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_10',
    repoId: 'repo_stage_45',
    title: 'S45-10 Tenant core data model',
    description: 'Add tenant data model and tenantId ownership to repo/task/run/event/command/operator session records.',
    taskPrompt: 'Implement tenant domain and ownership fields across Stage 4 projection/domain records with migration defaults.',
    acceptanceCriteria: [
      'Tenant entities and tenantId fields are defined',
      'Ownership invariants documented',
      'Legacy records have migration behavior'
    ],
    context: { links: [], notes: 'Depends on S45-00.' },
    dependencies: [{ upstreamTaskId: 'task_s45_00', mode: 'review_ready', primary: true }],
    status: 'INBOX',
    createdAt: iso(65),
    updatedAt: iso(65),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_20',
    repoId: 'repo_stage_45',
    title: 'S45-20 Tenant memberships and seats',
    description: 'Build org memberships, seat states, owner/member role semantics, and membership APIs.',
    taskPrompt: 'Define membership schema and implement seat enforcement semantics for Stage 4.5.',
    acceptanceCriteria: [
      'Owner/member roles are implemented',
      'Seat states enforced on access checks',
      'Member endpoints for create/update are implemented'
    ],
    context: { links: [], notes: 'Depends on S45-10.' },
    dependencies: [{ upstreamTaskId: 'task_s45_10', mode: 'review_ready', primary: true }],
    status: 'INBOX',
    createdAt: iso(60),
    updatedAt: iso(60),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_30',
    repoId: 'repo_stage_45',
    title: 'S45-30 Tenant context resolution + access control',
    description: 'Add tenant context resolution from auth session and enforce tenant-based authorization.',
    taskPrompt: 'Implement tenant-aware auth middleware behavior and cross-tenant deny paths for board/task/run endpoints.',
    acceptanceCriteria: [
      'Active tenant resolution works for each request',
      'Cross-tenant reads/writes fail with explicit errors',
      'Auth signup/login/me endpoints exist'
    ],
    context: { links: [], notes: 'Depends on S45-20 and S45-10.' },
    dependencies: [
      { upstreamTaskId: 'task_s45_20', mode: 'review_ready', primary: true },
      { upstreamTaskId: 'task_s45_10', mode: 'review_ready' }
    ],
    status: 'INBOX',
    createdAt: iso(55),
    updatedAt: iso(55),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_40',
    repoId: 'repo_stage_45',
    title: 'S45-40 Tenant-scoped persistence + APIs',
    description: 'Tenant-filter all board/task/repo/run APIs and update board websocket fanout by tenant.',
    taskPrompt: 'Apply tenant filtering to all tenant-owned read/write paths and board snapshot projection.',
    acceptanceCriteria: [
      'Board/task/list endpoints enforce tenant filter',
      'WS fanout is tenant-scoped',
      'No cross-tenant updates are visible'
    ],
    context: { links: [], notes: 'Depends on S45-30.' },
    dependencies: [{ upstreamTaskId: 'task_s45_30', mode: 'review_ready', primary: true }],
    status: 'INBOX',
    createdAt: iso(50),
    updatedAt: iso(50),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_50',
    repoId: 'repo_stage_45',
    title: 'S45-50 Workflow + tenant-owned artifact layout',
    description: 'Pass tenantId into workflow payload and move artifact/log keys to tenant-prefixed R2 paths.',
    taskPrompt: 'Update workflow invocation contract and artifact access checks for tenant isolation.',
    acceptanceCriteria: [
      'tenantId appears in workflow input',
      'R2 keys include tenants/{tenantId}/runs/{runId}/...',
      'Tenant checks protect artifact and terminal reads'
    ],
    context: { links: [], notes: 'Depends on S45-10 and S45-40.' },
    dependencies: [
      { upstreamTaskId: 'task_s45_10', mode: 'review_ready', primary: true },
      { upstreamTaskId: 'task_s45_40', mode: 'review_ready' }
    ],
    status: 'INBOX',
    createdAt: iso(45),
    updatedAt: iso(45),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_60',
    repoId: 'repo_stage_45',
    title: 'S45-60 Usage ledger emission',
    description: 'Emit tenant-attributed usage entries across workflow, sandbox, operator, and artifacts.',
    taskPrompt: 'Implement usage ledger writes and preserve partial ledger entries on failed runs.',
    acceptanceCriteria: [
      'Usage entries include tenantId and source',
      'Failed runs still emit partial usage',
      'Rate-version metadata is captured'
    ],
    context: { links: [], notes: 'Depends on S45-40 and S45-50.' },
    dependencies: [
      { upstreamTaskId: 'task_s45_40', mode: 'review_ready', primary: true },
      { upstreamTaskId: 'task_s45_50', mode: 'review_ready' }
    ],
    status: 'INBOX',
    createdAt: iso(40),
    updatedAt: iso(40),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_70',
    repoId: 'repo_stage_45',
    title: 'S45-70 Usage aggregation + reporting APIs',
    description: 'Add tenant and run-level usage reporting endpoints with reproducible aggregate formulas.',
    taskPrompt: 'Build usage reporting SQL queries and response shapes for daily/monthly tenant views.',
    acceptanceCriteria: [
      '/api/tenant-usage',
      '/api/tenant-usage/runs',
      '/api/runs/:runId/usage implemented',
      'Aggregation sums reconcile with raw ledger'
    ],
    context: { links: [], notes: 'Depends on S45-60 and S45-40.' },
    dependencies: [
      { upstreamTaskId: 'task_s45_60', mode: 'review_ready', primary: true },
      { upstreamTaskId: 'task_s45_40', mode: 'review_ready' }
    ],
    status: 'INBOX',
    createdAt: iso(35),
    updatedAt: iso(35),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  },
  {
    taskId: 'task_s45_80',
    repoId: 'repo_stage_45',
    title: 'S45-80 Tenant-aware UI shell and usage surfaces',
    description: 'Expose active tenant selector and usage summaries in the UI, preserving Stage 4 attach flow.',
    taskPrompt: 'Update agentboard UI to support tenant context switches and per-run/tenant usage summaries.',
    acceptanceCriteria: [
      'Tenant selector exists',
      'Board/task/run views are tenant scoped',
      'Usage panels show estimated costs clearly'
    ],
    context: { links: [], notes: 'Depends on S45-70 and S45-30.' },
    dependencies: [
      { upstreamTaskId: 'task_s45_70', mode: 'review_ready', primary: true },
      { upstreamTaskId: 'task_s45_30', mode: 'review_ready' }
    ],
    status: 'INBOX',
    createdAt: iso(30),
    updatedAt: iso(30),
    uiMeta: { codexModel: 'gpt-5.3-codex', codexReasoningEffort: 'medium' }
  }
];

const runs: AgentRun[] = [
  {
    runId: 'run_nav_1',
    taskId: 'task_nav',
    repoId: 'repo_dashboard',
    status: 'RUNNING_TESTS',
    branchName: 'agent/task_nav/run_nav_1',
    sandboxId: 'run_nav_1',
    errors: [],
    startedAt: iso(12),
    timeline: [
      { status: 'QUEUED', at: iso(12) },
      { status: 'BOOTSTRAPPING', at: iso(11) },
      { status: 'RUNNING_CODEX', at: iso(10) },
      { status: 'RUNNING_TESTS', at: iso(9) }
    ],
    currentStepStartedAt: iso(9),
    simulationProfile: 'happy_path',
    pendingEvents: [
      { status: 'PUSHING_BRANCH', executeAt: iso(-2) },
      { status: 'PR_OPEN', executeAt: iso(-4) },
      { status: 'WAITING_PREVIEW', executeAt: iso(-6) },
      { status: 'EVIDENCE_RUNNING', executeAt: iso(-10) },
      { status: 'DONE', executeAt: iso(-15) }
    ]
  },
  {
    runId: 'run_kpi_1',
    taskId: 'task_kpi',
    repoId: 'repo_dashboard',
    status: 'DONE',
    branchName: 'agent/task_kpi/run_kpi_1',
    sandboxId: 'run_kpi_1',
    headSha: 'abc1234',
    prUrl: 'https://github.com/acme/internal-dashboard/pull/104',
    prNumber: 104,
    previewUrl: 'https://preview.example.invalid/internal-dashboard/104',
    artifacts: ['runs/run_kpi_1/before.png', 'runs/run_kpi_1/after.png'],
    artifactManifest: {
      logs: { key: 'runs/run_kpi_1/logs.txt', label: 'Mock logs' },
      before: { key: 'runs/run_kpi_1/before.png', label: 'Before screenshot', url: 'https://artifacts.example.invalid/runs/run_kpi_1/before.png' },
      after: { key: 'runs/run_kpi_1/after.png', label: 'After screenshot', url: 'https://artifacts.example.invalid/runs/run_kpi_1/after.png' },
      metadata: {
        generatedAt: iso(14),
        simulatorVersion: 'phase-0',
        environmentId: 'mock-env-1'
      }
    },
    errors: [],
    startedAt: iso(40),
    endedAt: iso(14),
    timeline: [
      { status: 'QUEUED', at: iso(40) },
      { status: 'BOOTSTRAPPING', at: iso(39) },
      { status: 'RUNNING_CODEX', at: iso(37) },
      { status: 'RUNNING_TESTS', at: iso(32) },
      { status: 'PUSHING_BRANCH', at: iso(29) },
      { status: 'PR_OPEN', at: iso(27) },
      { status: 'WAITING_PREVIEW', at: iso(25) },
      { status: 'EVIDENCE_RUNNING', at: iso(21) },
      { status: 'DONE', at: iso(14) }
    ],
    currentStepStartedAt: iso(21),
    simulationProfile: 'happy_path',
    pendingEvents: []
  },
  {
    runId: 'run_auth_1',
    taskId: 'task_auth',
    repoId: 'repo_dashboard',
    status: 'FAILED',
    branchName: 'agent/task_auth/run_auth_1',
    sandboxId: 'run_auth_1',
    errors: [{ at: iso(31), message: 'Mock tests failed during auth settings suite.' }],
    startedAt: iso(35),
    endedAt: iso(31),
    timeline: [
      { status: 'QUEUED', at: iso(35) },
      { status: 'BOOTSTRAPPING', at: iso(34) },
      { status: 'RUNNING_CODEX', at: iso(33) },
      { status: 'RUNNING_TESTS', at: iso(32) },
      { status: 'FAILED', at: iso(31), note: 'Mock tests failed during auth settings suite.' }
    ],
    currentStepStartedAt: iso(32),
    simulationProfile: 'fail_tests',
    pendingEvents: []
  }
];

const logs: RunLogEntry[] = [
  { id: 'log_1', runId: 'run_nav_1', createdAt: iso(12), level: 'info', phase: 'bootstrap', message: 'Queued task and reserved a mock sandbox.' },
  { id: 'log_2', runId: 'run_nav_1', createdAt: iso(10), level: 'info', phase: 'codex', message: 'Codex is updating responsive navigation styles.' },
  { id: 'log_3', runId: 'run_nav_1', createdAt: iso(9), level: 'info', phase: 'tests', message: 'Running dashboard test suite.' },
  { id: 'log_4', runId: 'run_kpi_1', createdAt: iso(14), level: 'info', message: 'Evidence complete. Mock before/after screenshots attached.' },
  { id: 'log_5', runId: 'run_auth_1', createdAt: iso(31), level: 'error', message: 'Test failure: region selector never resolved.' }
];

const events: RunEvent[] = [];
const commands: RunCommand[] = [];

export function createSeedSnapshot(): BoardSnapshotV1 {
  return {
    version: 1,
    repos,
    tasks,
    runs,
    logs,
    events,
    commands,
    ui: {
      selectedRepoId: 'all',
      selectedTaskId: 'task_nav',
      seeded: true
    }
  };
}
