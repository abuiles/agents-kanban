import type { ChangeEvent, ReactNode } from 'react';
import type { Repo, Task } from '../domain/types';

function ActionButton({
  children,
  variant = 'secondary',
  onClick,
  asLabel,
  input
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  onClick?: () => void;
  asLabel?: boolean;
  input?: ReactNode;
}) {
  const classes = {
    primary:
      'inline-flex h-10 items-center justify-center rounded-lg border border-blue-400/40 bg-blue-500 px-4 text-sm font-medium text-white shadow-[0_0_0_1px_rgba(96,165,250,0.12)] transition hover:border-blue-300/60 hover:bg-blue-400',
    secondary:
      'inline-flex h-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/80 px-4 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-800/90',
    ghost:
      'inline-flex h-10 items-center justify-center rounded-lg border border-slate-800 bg-slate-950/40 px-4 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:text-white'
  }[variant];

  if (asLabel) {
    return (
      <label className={`${classes} cursor-pointer`}>
        {children}
        {input}
      </label>
    );
  }

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
  onEditRepo,
  onCreateTask,
  onExport,
  onImport
}: {
  repos: Repo[];
  selectedRepoId: string | 'all';
  onRepoChange: (repoId: string | 'all') => void;
  onAddRepo: () => void;
  onEditRepo?: () => void;
  onCreateTask: () => void;
  onExport: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <header className="rounded-2xl border border-slate-800/80 bg-slate-950/85 px-5 py-4 shadow-[0_12px_40px_rgba(2,6,23,0.45)] backdrop-blur">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cyan-300/80">Control surface</p>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">AgentsKanban</h1>
            <p className="mt-1 text-sm text-slate-400">Multi-repo background agent control room.</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 xl:min-w-[34rem] xl:items-end">
          <div className="flex w-full flex-col gap-3 xl:flex-row xl:items-end xl:justify-end">
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

            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              <ActionButton variant="primary" onClick={onCreateTask}>
                Create task
              </ActionButton>
              {selectedRepoId !== 'all' && onEditRepo ? (
                <ActionButton variant="secondary" onClick={onEditRepo}>
                  Edit repo
                </ActionButton>
              ) : null}
              <ActionButton variant="secondary" onClick={onAddRepo}>
                Add repo
              </ActionButton>
              <ActionButton variant="ghost" onClick={onExport}>
                Export
              </ActionButton>
              <ActionButton
                variant="ghost"
                asLabel
                input={<input type="file" accept="application/json" className="hidden" onChange={onImport} />}
              >
                Import
              </ActionButton>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export function SummaryRow({ repos, visibleTasks }: { repos: Repo[]; visibleTasks: Task[] }) {
  const reviewCount = visibleTasks.filter((task) => task.status === 'REVIEW').length;
  const failedCount = visibleTasks.filter((task) => task.status === 'FAILED').length;
  const activeCount = visibleTasks.filter((task) => task.status === 'ACTIVE').length;

  return (
    <div className="space-y-2">
      <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Repos" value={repos.length} />
        <MetricCard label="Visible" value={visibleTasks.length} />
        <MetricCard label="Active" value={activeCount} tone="active" />
        <MetricCard label="Review" value={reviewCount} tone="review" />
        <MetricCard label="Failed" value={failedCount} tone="failed" />
      </section>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/8 px-4 py-2.5 text-sm text-cyan-50">
        <span className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
          Run mode
        </span>
        <span className="text-sm text-cyan-50/90">Drag a task into Active to start a real run with Codex, PR creation, preview discovery, and evidence.</span>
      </div>
    </div>
  );
}
