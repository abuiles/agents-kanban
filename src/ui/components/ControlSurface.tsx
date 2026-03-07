import type { ReactNode } from 'react';
import type { Repo } from '../domain/types';
import type { DashboardStats, DashboardViewMode } from '../domain/dashboard';

function ActionButton({
  children,
  variant = 'secondary',
  onClick
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  onClick?: () => void;
}) {
  const classes = {
    primary:
      'inline-flex h-10 items-center justify-center rounded-lg border border-blue-400/40 bg-blue-500 px-4 text-sm font-medium text-white shadow-[0_0_0_1px_rgba(96,165,250,0.12)] transition hover:border-blue-300/60 hover:bg-blue-400',
    secondary:
      'inline-flex h-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/80 px-4 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-800/90',
    ghost:
      'inline-flex h-10 items-center justify-center rounded-lg border border-slate-800 bg-slate-950/40 px-4 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:text-white'
  }[variant];

  return (
    <button type="button" className={classes} onClick={onClick}>
      {children}
    </button>
  );
}

function MetricCard({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'active' | 'review' | 'failed' }) {
  const toneClasses = {
    default: 'border-slate-800 bg-slate-950/70 text-slate-100',
    active: 'border-cyan-500/30 bg-cyan-500/8 text-cyan-100',
    review: 'border-violet-500/30 bg-violet-500/8 text-violet-100',
    failed: 'border-rose-500/30 bg-rose-500/8 text-rose-100'
  }[tone];

  return (
    <div className={`rounded-xl border px-4 py-2.5 ${toneClasses}`}>
      <div className="text-xl font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-400">{label}</div>
    </div>
  );
}

export function ControlSurfaceHeader({
  repos,
  selectedRepoId,
  onRepoChange,
  onAddRepo,
  onManageReviewPlaybooks,
  onEditRepo,
  onCreateTask,
  onExport
}: {
  repos: Repo[];
  selectedRepoId: string | 'all';
  onRepoChange: (repoId: string | 'all') => void;
  onAddRepo: () => void;
  onManageReviewPlaybooks?: () => void;
  onEditRepo?: () => void;
  onCreateTask: () => void;
  onExport: () => void;
}) {
  return (
    <header className="rounded-2xl border border-slate-800/80 bg-slate-950/85 px-5 py-4 shadow-[0_12px_40px_rgba(2,6,23,0.45)] backdrop-blur">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cyan-300/80">Control surface</p>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white">AgentsKanban</h1>
              <p className="mt-1 text-sm text-slate-400">Multi-repo background agent control room.</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 xl:min-w-[18rem] xl:items-end">
            <label className="flex min-w-[15rem] flex-col gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
              Repo filter
              <select
                value={selectedRepoId}
                onChange={(event) => onRepoChange(event.target.value as string | 'all')}
                className="h-11 rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm font-medium normal-case tracking-normal text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
              >
                <option value="all">All repos</option>
                {repos.map((repo) => (
                  <option key={repo.repoId} value={repo.repoId}>
                    {repo.slug}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
          <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/8 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Primary flow</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ActionButton variant="primary" onClick={onCreateTask}>
                Create task
              </ActionButton>
              {selectedRepoId !== 'all' && onEditRepo ? (
                <ActionButton variant="secondary" onClick={onEditRepo}>
                  Repo settings
                </ActionButton>
              ) : null}
              <ActionButton variant="secondary" onClick={onAddRepo}>
                Add repo
              </ActionButton>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Configuration</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {onManageReviewPlaybooks ? (
                <ActionButton variant="secondary" onClick={onManageReviewPlaybooks}>
                  Review playbooks
                </ActionButton>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Data</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ActionButton variant="ghost" onClick={onExport}>
                Export
              </ActionButton>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function ViewButton({
  active,
  label,
  count,
  onClick
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] transition',
        active
          ? 'border-cyan-400/35 bg-cyan-500/15 text-cyan-50'
          : 'border-slate-700 bg-slate-900/80 text-slate-300 hover:border-slate-500 hover:text-white'
      ].join(' ')}
    >
      <span>{label}</span>
      <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10px] tracking-[0.14em]">{count}</span>
    </button>
  );
}

export function SummaryRow({
  repos,
  stats,
  taskView,
  onTaskViewChange,
  showArchived,
  onToggleArchived
}: {
  repos: Repo[];
  stats: DashboardStats;
  taskView: DashboardViewMode;
  onTaskViewChange: (view: DashboardViewMode) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  return (
    <div className="space-y-2">
      <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Repos" value={repos.length} />
        <MetricCard label="Visible" value={stats.visible} />
        <MetricCard label="Running now" value={stats.running} tone="active" />
        <MetricCard label="Review done" value={stats.reviewComplete} tone="review" />
        <MetricCard label="Attention" value={stats.attention} tone="failed" />
      </section>
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <ViewButton active={taskView === 'all'} label="All tasks" count={stats.total} onClick={() => onTaskViewChange('all')} />
            <ViewButton active={taskView === 'running'} label="Running" count={stats.running} onClick={() => onTaskViewChange('running')} />
            <ViewButton active={taskView === 'review_complete'} label="Review done" count={stats.reviewComplete} onClick={() => onTaskViewChange('review_complete')} />
            <ViewButton active={taskView === 'attention'} label="Attention" count={stats.attention} onClick={() => onTaskViewChange('attention')} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/8 px-4 py-3 text-sm text-cyan-50">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Archive</div>
            <div className="mt-1 text-sm text-cyan-50/90">{stats.archived} archived tasks are hidden from the main board.</div>
          </div>
          <button
            type="button"
            onClick={onToggleArchived}
            className="inline-flex h-10 items-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-sm font-medium text-cyan-50 transition hover:bg-cyan-500/25"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
      </div>
    </div>
  );
}
