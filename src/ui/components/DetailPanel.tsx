import type { AgentRun, Repo, RunLogEntry, TaskDetail } from '../domain/types';
import { getBaselineUrl } from '../domain/selectors';
import { useState } from 'react';

function formatTimestamp(value?: string) {
  if (!value) {
    return '—';
  }

  return new Date(value).toLocaleString();
}

function formatRelativeTime(value?: string) {
  if (!value) {
    return '—';
  }

  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(delta / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function compactUrl(value: string) {
  try {
    const url = new URL(value);
    const trimmedPath = url.pathname.length > 20 ? `${url.pathname.slice(0, 20)}...` : url.pathname;
    return `${url.host}${trimmedPath}`;
  } catch {
    return value;
  }
}

function statusTone(status: string) {
  if (status === 'FAILED') return 'border-rose-500/25 bg-rose-500/10 text-rose-100';
  if (status === 'DONE') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100';
  if (status === 'EVIDENCE_RUNNING' || status === 'RUNNING_TESTS' || status === 'RUNNING_CODEX' || status === 'BOOTSTRAPPING') {
    return 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100';
  }
  if (status === 'PR_OPEN' || status === 'WAITING_PREVIEW') return 'border-violet-500/25 bg-violet-500/10 text-violet-100';
  return 'border-slate-700 bg-slate-800/80 text-slate-200';
}

function PanelSection({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ArtifactLinks({ run }: { run?: AgentRun }) {
  if (!run?.artifactManifest) {
    return <p className="text-sm text-slate-500">Artifacts will appear after evidence runs complete.</p>;
  }

  const manifest = run.artifactManifest;
  const links = [
    { label: 'Mock logs', value: manifest.logs.key, href: undefined },
    manifest.before ? { label: 'Before', value: manifest.before.url, href: manifest.before.url } : undefined,
    manifest.after ? { label: 'After', value: manifest.after.url, href: manifest.after.url } : undefined,
    manifest.trace ? { label: 'Trace', value: manifest.trace.url, href: manifest.trace.url } : undefined,
    manifest.video ? { label: 'Video', value: manifest.video.url, href: manifest.video.url } : undefined
  ].filter(Boolean) as Array<{ label: string; value: string; href?: string }>;

  return (
    <div className="space-y-2">
      {links.map((link) => (
        <div key={link.label} className="flex items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm">
          <span className="text-slate-400">{link.label}</span>
          {link.href ? (
            <a
              href={link.href}
              title={link.value}
              target="_blank"
              rel="noreferrer"
              className="break-all text-right text-cyan-300 hover:text-cyan-200"
            >
              {compactUrl(link.value)}
            </a>
          ) : (
            <code className="break-all text-right text-slate-200">{link.value}</code>
          )}
        </div>
      ))}
    </div>
  );
}

export function DetailPanel({
  detail,
  logs,
  onRetryRun,
  onRetryPreview,
  onRetryEvidence
}: {
  detail?: TaskDetail;
  logs: RunLogEntry[];
  onRetryRun: (runId: string) => void;
  onRetryPreview: (runId: string) => void;
  onRetryEvidence: (runId: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  if (!detail) {
    return (
      <aside className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-6 shadow-[0_16px_44px_rgba(2,6,23,0.38)]">
        <div className="grid min-h-[24rem] place-items-center rounded-2xl border border-dashed border-slate-800 bg-slate-950/60 text-center">
          <div className="max-w-sm space-y-2 px-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Inspector</p>
            <h2 className="text-xl font-semibold text-white">Select a task</h2>
            <p className="text-sm leading-6 text-slate-400">Inspect the latest run, retry actions, preview links, artifacts, and logs from the right-side console.</p>
          </div>
        </div>
      </aside>
    );
  }

  const { task, repo, latestRun } = detail;
  const baselineUrl = getBaselineUrl(task, repo as Repo);
  const canCopyLogs = logs.length > 0;
  const codexModel = task.uiMeta?.codexModel ?? 'gpt-5.1-codex-mini';
  const codexReasoningEffort = task.uiMeta?.codexReasoningEffort ?? 'medium';

  async function copyLogs() {
    if (!canCopyLogs) {
      return;
    }

    const payload = logs
      .map((log) => [`[${formatTimestamp(log.createdAt)}]`, log.level.toUpperCase(), log.phase ? `(${log.phase})` : undefined, log.message]
        .filter(Boolean)
        .join(' '))
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(payload);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    }
  }

  return (
    <aside className="space-y-4 rounded-2xl border border-slate-800/80 bg-slate-950/70 p-4 shadow-[0_16px_44px_rgba(2,6,23,0.38)] xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-auto">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                {repo.slug}
              </span>
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${statusTone(task.status)}`}>
                {task.status}
              </span>
              {latestRun ? (
                <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${statusTone(latestRun.status)}`}>
                  {latestRun.status}
                </span>
              ) : null}
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-white">{task.title}</h2>
              {task.description ? <p className="mt-2 text-sm leading-6 text-slate-400">{task.description}</p> : null}
            </div>
          </div>
        </div>
      </div>

      <PanelSection
        title="Latest run"
        aside={
          latestRun ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onRetryRun(latestRun.runId)}
                className="inline-flex h-9 items-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-sm font-medium text-cyan-50 transition hover:bg-cyan-500/25"
              >
                Retry run
              </button>
              <button
                type="button"
                onClick={() => onRetryPreview(latestRun.runId)}
                title="Retry preview fetch only"
                className="inline-flex h-9 items-center rounded-lg border border-violet-400/35 bg-violet-500/15 px-3 text-sm font-medium text-violet-50 transition hover:bg-violet-500/25"
              >
                Retry preview fetch
              </button>
              <button
                type="button"
                onClick={() => onRetryEvidence(latestRun.runId)}
                className="inline-flex h-9 items-center rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-200 transition hover:border-slate-500"
              >
                Retry evidence
              </button>
            </div>
          ) : null
        }
      >
        {latestRun ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Branch</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{latestRun.branchName}</code>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Baseline</div>
                <a
                  href={baselineUrl}
                  title={baselineUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block break-all text-xs text-cyan-300 hover:text-cyan-200"
                >
                  {compactUrl(baselineUrl)}
                </a>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">PR</div>
                {latestRun.prUrl ? (
                  <a
                    href={latestRun.prUrl}
                    title={latestRun.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block break-all text-xs text-cyan-300 hover:text-cyan-200"
                  >
                    {compactUrl(latestRun.prUrl)}
                  </a>
                ) : (
                  <div className="mt-1 text-xs text-slate-500">Pending</div>
                )}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Preview</div>
                {latestRun.previewUrl ? (
                  <a
                    href={latestRun.previewUrl}
                    title={latestRun.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block break-all text-xs text-cyan-300 hover:text-cyan-200"
                  >
                    {compactUrl(latestRun.previewUrl)}
                  </a>
                ) : (
                  <div className="mt-1 text-xs text-slate-500">Waiting for preview</div>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Timeline</div>
                <div className="text-xs text-slate-500" title={formatTimestamp(latestRun.startedAt)}>{formatRelativeTime(latestRun.startedAt)}</div>
              </div>
              <div className="space-y-3">
                {latestRun.timeline.map((entry, index) => (
                  <div key={`${entry.status}_${entry.at}_${index}`} className="relative pl-5">
                    <div className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full bg-cyan-400" />
                    {index < latestRun.timeline.length - 1 ? <div className="absolute left-[4px] top-4 h-[calc(100%+0.35rem)] w-px bg-slate-800" /> : null}
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-slate-100">{entry.status}</div>
                        {entry.note ? <p className="mt-1 text-xs leading-5 text-slate-400">{entry.note}</p> : null}
                      </div>
                      <div className="text-xs text-slate-500" title={formatTimestamp(entry.at)}>{formatRelativeTime(entry.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No run started yet.</p>
        )}
      </PanelSection>

      <PanelSection title="Artifacts">
        <ArtifactLinks run={latestRun} />
      </PanelSection>

      <details className="group rounded-xl border border-slate-800 bg-slate-950/55 p-4">
        <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 marker:hidden">
          Task brief
        </summary>
        <div className="mt-4 grid gap-4 xl:grid-cols-1">
          <PanelSection title="Execution">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Model</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{codexModel}</code>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Reasoning</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{codexReasoningEffort}</code>
              </div>
            </div>
          </PanelSection>

          <PanelSection title="Prompt">
            <p className="text-sm leading-6 text-slate-300">{task.taskPrompt}</p>
          </PanelSection>

          <PanelSection title="Acceptance criteria">
            <ul className="space-y-2 text-sm leading-6 text-slate-300">
              {task.acceptanceCriteria.map((criterion) => (
                <li key={criterion} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 rounded-full bg-cyan-400" />
                  <span>{criterion}</span>
                </li>
              ))}
            </ul>
          </PanelSection>

          <PanelSection title="Context">
            <div className="space-y-3 text-sm text-slate-300">
              {task.context.links.length ? (
                <div className="space-y-2">
                  {task.context.links.map((link) => (
                    <a
                      key={link.id}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-cyan-300 hover:text-cyan-200"
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-slate-500">No structured links attached.</p>
              )}
              {task.context.notes ? <p className="leading-6 text-slate-400">{task.context.notes}</p> : null}
            </div>
          </PanelSection>
        </div>
      </details>

      <PanelSection
        title="Logs"
        aside={
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">{logs.length} lines</span>
            <button
              type="button"
              onClick={() => void copyLogs()}
              disabled={!canCopyLogs}
              className="inline-flex h-8 items-center rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-950 disabled:text-slate-500"
            >
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy logs'}
            </button>
          </div>
        }
      >
        <div className="max-h-72 space-y-2 overflow-auto rounded-xl border border-slate-900 bg-[#040812] p-3 font-mono text-xs">
          {logs.length ? (
            logs.map((log) => (
              <div key={log.id} className="rounded-lg border border-slate-900/80 bg-slate-950/80 px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  <span className={log.level === 'error' ? 'text-rose-300' : 'text-slate-500'}>{log.level}</span>
                  <span>{formatTimestamp(log.createdAt)}</span>
                </div>
                <code className="mt-2 block whitespace-pre-wrap break-words text-slate-200">{log.message}</code>
              </div>
            ))
          ) : (
            <p className="text-slate-500">Logs stream here once the run starts.</p>
          )}
        </div>
      </PanelSection>
    </aside>
  );
}
