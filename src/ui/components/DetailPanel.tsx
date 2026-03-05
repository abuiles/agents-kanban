import type { AgentRun, Repo, RunCommand, RunEvent, RunLogEntry, TaskDetail, TerminalBootstrap } from '../domain/types';
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

function shortSha(value?: string) {
  if (!value) {
    return '—';
  }
  return value.slice(0, 8);
}

function statusTone(status: string) {
  if (status === 'FAILED') return 'border-rose-500/25 bg-rose-500/10 text-rose-100';
  if (status === 'DONE') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100';
  if (status === 'OPERATOR_CONTROLLED') return 'border-amber-500/25 bg-amber-500/10 text-amber-100';
  if (status === 'EVIDENCE_RUNNING' || status === 'RUNNING_TESTS' || status === 'RUNNING_CODEX' || status === 'BOOTSTRAPPING') {
    return 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100';
  }
  if (status === 'PR_OPEN' || status === 'WAITING_PREVIEW') return 'border-violet-500/25 bg-violet-500/10 text-violet-100';
  return 'border-slate-700 bg-slate-800/80 text-slate-200';
}

function dependencyReasonTone(state: 'missing' | 'not_ready' | 'ready') {
  if (state === 'ready') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100';
  if (state === 'missing') return 'border-rose-500/25 bg-rose-500/10 text-rose-100';
  return 'border-amber-500/25 bg-amber-500/10 text-amber-100';
}

function llmAdapterLabel(adapter?: AgentRun['llmAdapter']) {
  if (adapter === 'cursor_cli') return 'Cursor CLI';
  if (adapter === 'claude_code') return 'Claude Code';
  return 'Codex';
}

function PanelSection({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
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
  events,
  commands,
  terminalBootstrap,
  onEditTask,
  onRequestChanges,
  onRetryRun,
  onRerunReview,
  onRetryPreview,
  onRetryEvidence,
  onCancelRun,
  onOpenTerminal,
  onTakeOverRun
}: {
  detail?: TaskDetail;
  logs: RunLogEntry[];
  events: RunEvent[];
  commands: RunCommand[];
  terminalBootstrap?: TerminalBootstrap;
  onEditTask: (taskId: string) => void;
  onRequestChanges: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onRerunReview: (runId: string) => void;
  onRetryPreview: (runId: string) => void;
  onRetryEvidence: (runId: string) => void;
  onCancelRun: (runId: string) => void;
  onOpenTerminal: (runId: string) => void;
  onTakeOverRun: (runId: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  if (!detail) {
    return null;
  }

  const { task, repo, latestRun } = detail;
  const baselineUrl = getBaselineUrl(task, repo as Repo);
  const canCopyLogs = logs.length > 0;
  const taskLlmAdapter = task.uiMeta?.llmAdapter ?? 'codex';
  const taskLlmModel = task.uiMeta?.llmModel
    ?? task.uiMeta?.codexModel
    ?? (taskLlmAdapter === 'claude_code' ? 'claude-sonnet-4-0' : taskLlmAdapter === 'cursor_cli' ? 'cursor-default' : 'gpt-5.1-codex-mini');
  const taskLlmReasoningEffort = task.uiMeta?.llmReasoningEffort ?? task.uiMeta?.codexReasoningEffort ?? 'medium';
  const latestRunResumeCommand = latestRun?.llmResumeCommand ?? latestRun?.latestCodexResumeCommand;
  const latestCommands = latestRun ? commands.filter((command) => command.runId === latestRun.runId) : [];
  const latestEvents = latestRun ? events.filter((event) => event.runId === latestRun.runId) : [];
  const currentCommand = latestRun?.currentCommandId ? latestCommands.find((command) => command.id === latestRun.currentCommandId) : undefined;
  const latestRunCheckpoints = latestRun?.checkpoints ?? [];
  const canCancelRun = latestRun && !['DONE', 'FAILED'].includes(latestRun.status);
  const taskCheckpoints = detail.runs
    .flatMap((run) => run.checkpoints ?? [])
    .sort((left, right) => {
      const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }
      return right.checkpointId.localeCompare(left.checkpointId);
    });
  const latestTaskCheckpoint = taskCheckpoints[0];

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
    <aside className="min-w-0 space-y-4 rounded-2xl border border-slate-800/80 bg-slate-950/70 p-4 shadow-[0_16px_44px_rgba(2,6,23,0.38)] xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-auto">
      <div className="min-w-0 rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
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
              <h2 className="text-xl font-semibold tracking-tight text-white break-words [overflow-wrap:anywhere]">{task.title}</h2>
              {task.description ? <p className="mt-2 text-sm leading-6 text-slate-400 break-words [overflow-wrap:anywhere]">{task.description}</p> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onEditTask(task.taskId)}
            className="inline-flex h-9 shrink-0 items-center rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-200 transition hover:border-slate-500"
          >
            Edit task
          </button>
        </div>
      </div>

      <PanelSection
        title="Latest run"
        aside={
          latestRun ? (
            <div className="flex flex-wrap gap-2">
              {canCancelRun ? (
                <button
                  type="button"
                  onClick={() => onCancelRun(latestRun.runId)}
                  className="inline-flex h-9 items-center rounded-lg border border-rose-400/35 bg-rose-500/15 px-3 text-sm font-medium text-rose-50 transition hover:bg-rose-500/25"
                >
                  Cancel run
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onRequestChanges(latestRun.runId)}
                className="inline-flex h-9 items-center rounded-lg border border-amber-400/35 bg-amber-500/15 px-3 text-sm font-medium text-amber-50 transition hover:bg-amber-500/25"
              >
                Request changes
              </button>
              <button
                type="button"
                onClick={() => onRetryRun(latestRun.runId)}
                className="inline-flex h-9 items-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-sm font-medium text-cyan-50 transition hover:bg-cyan-500/25"
              >
                Retry run
              </button>
              <button
                type="button"
                onClick={() => onRerunReview(latestRun.runId)}
                className="inline-flex h-9 items-center rounded-lg border border-indigo-400/35 bg-indigo-500/15 px-3 text-sm font-medium text-indigo-50 transition hover:bg-indigo-500/25"
              >
                Re-run review
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
            <div className="min-w-0 grid gap-2 sm:grid-cols-2">
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
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Executor</div>
                <div className="mt-1 text-xs text-slate-200">{llmAdapterLabel(latestRun.llmAdapter)}</div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Model</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{latestRun.llmModel ?? taskLlmModel}</code>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Reasoning</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{latestRun.llmReasoningEffort ?? taskLlmReasoningEffort}</code>
              </div>
              {latestRun.resumedFromCheckpointId || latestRun.resumedFromCommitSha ? (
                <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-cyan-200">Resumed from checkpoint</div>
                  <div className="mt-1 text-xs text-cyan-50">{latestRun.resumedFromCheckpointId ?? 'unknown checkpoint'}</div>
                  <div className="mt-1 text-xs text-cyan-100/80">Commit {shortSha(latestRun.resumedFromCommitSha)}</div>
                </div>
              ) : null}
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
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100">{entry.status}</div>
                        {entry.note ? <p className="mt-1 text-xs leading-5 text-slate-400 break-words [overflow-wrap:anywhere]">{entry.note}</p> : null}
                      </div>
                      <div className="text-xs text-slate-500" title={formatTimestamp(entry.at)}>{formatRelativeTime(entry.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Operator terminal</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenTerminal(latestRun.runId)}
                    className="inline-flex h-8 items-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-xs font-medium text-cyan-50 transition hover:bg-cyan-500/25"
                  >
                    Open terminal
                  </button>
                  <button
                    type="button"
                    onClick={() => onTakeOverRun(latestRun.runId)}
                    className="inline-flex h-8 items-center rounded-lg border border-amber-400/35 bg-amber-500/15 px-3 text-xs font-medium text-amber-50 transition hover:bg-amber-500/25"
                  >
                      Take over
                  </button>
                </div>
              </div>
              <p className="text-sm text-slate-400">
                Open the terminal in a dedicated modal window. It attaches to a separate operator session, so the executor can keep running unless you explicitly take over.
              </p>
              {terminalBootstrap && !terminalBootstrap.attachable ? (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-400">
                  Terminal unavailable: {terminalBootstrap.reason ?? 'unknown error'}.
                </div>
              ) : null}
              {latestRun.operatorSession || terminalBootstrap ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Session</div>
                    <div className="mt-1 text-xs text-slate-200">
                      {latestRun.operatorSession?.connectionState ?? (terminalBootstrap?.attachable ? 'ready' : 'idle')}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Control</div>
                    <div className="mt-1 text-xs text-slate-200">{latestRun.operatorSession?.takeoverState ?? 'codex_control'}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Target</div>
                    <div className="mt-1 text-xs text-slate-200">
                      {terminalBootstrap?.sessionName ?? latestRun.operatorSession?.sessionName ?? 'operator'}
                    </div>
                  </div>
                </div>
              ) : null}
              {latestRun ? (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Resume capability</div>
                  {latestRun.llmSupportsResume ? (
                    latestRunResumeCommand ? (
                      <code className="mt-1 block break-all text-xs text-cyan-200">{latestRunResumeCommand}</code>
                    ) : (
                      <div className="mt-1 text-xs text-slate-400">{llmAdapterLabel(latestRun.llmAdapter)} supports resume, but no command is available yet.</div>
                    )
                  ) : (
                    <div className="mt-1 text-xs text-slate-400">{llmAdapterLabel(latestRun.llmAdapter)} does not advertise resumable takeover for this run.</div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Checkpoints</div>
              <div className="space-y-2">
                {latestRunCheckpoints.length ? latestRunCheckpoints.map((checkpoint) => (
                  <div key={checkpoint.checkpointId} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                      <span>{checkpoint.phase}</span>
                      <span title={formatTimestamp(checkpoint.createdAt)}>{formatRelativeTime(checkpoint.createdAt)}</span>
                    </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs">
                    <code className="break-all text-slate-200">{shortSha(checkpoint.commitSha)}</code>
                      {latestRun.resumedFromCheckpointId === checkpoint.checkpointId ? (
                        <span className="rounded-full border border-cyan-500/35 bg-cyan-500/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-cyan-100">
                          resumed-from
                        </span>
                      ) : null}
                    </div>
                  </div>
                )) : <p className="text-sm text-slate-500">No checkpoints recorded on this run.</p>}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Current command</div>
              {currentCommand ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                  <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                    <span>{currentCommand.phase}</span>
                    <span>{currentCommand.status}</span>
                  </div>
                  <code className="mt-2 block whitespace-pre-wrap break-words text-xs text-slate-200">{currentCommand.command}</code>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No active command recorded.</p>
              )}
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Command history</div>
              <div className="space-y-2">
                {latestCommands.length ? latestCommands.map((command) => (
                  <div key={command.id} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                      <span>{command.phase}</span>
                      <span>{command.status}{typeof command.exitCode === 'number' ? ` · ${command.exitCode}` : ''}</span>
                    </div>
                    <code className="mt-2 block whitespace-pre-wrap break-words text-xs text-slate-200">{command.command}</code>
                  </div>
                )) : <p className="text-sm text-slate-500">Commands will appear here as the run progresses.</p>}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Event timeline</div>
              <div className="space-y-2">
                {latestEvents.length ? latestEvents.map((event) => (
                  <div key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                      <span>{event.eventType}</span>
                      <span title={formatTimestamp(event.at)}>{formatRelativeTime(event.at)}</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-200 break-words [overflow-wrap:anywhere]">{event.message}</p>
                  </div>
                )) : <p className="text-sm text-slate-500">Events will appear here once the run starts.</p>}
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
        <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-1">
          <PanelSection title="Execution">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Adapter</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{llmAdapterLabel(taskLlmAdapter)}</code>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Model</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{taskLlmModel}</code>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Reasoning</div>
                <code className="mt-1 block break-all text-xs text-slate-200">{taskLlmReasoningEffort}</code>
              </div>
            </div>
          </PanelSection>

          <PanelSection title="Prompt">
            <p className="text-sm leading-6 text-slate-300 break-words [overflow-wrap:anywhere]">{task.taskPrompt}</p>
          </PanelSection>

          {task.sourceRef ? (
            <PanelSection title="Source ref">
              {task.sourceRef.startsWith('http://') || task.sourceRef.startsWith('https://') ? (
                <a
                  href={task.sourceRef}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all text-sm text-cyan-300 hover:text-cyan-200"
                >
                  {task.sourceRef}
                </a>
              ) : (
                <code className="block break-all text-xs text-slate-200">{task.sourceRef}</code>
              )}
            </PanelSection>
          ) : null}

          <PanelSection title="Dependencies">
            {task.dependencies?.length ? (
              <div className="space-y-2">
                {task.dependencies.map((dependency) => (
                  <div key={`${dependency.upstreamTaskId}_${dependency.mode}`} className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                      <span>{dependency.mode}</span>
                      {dependency.primary ? (
                        <span className="rounded-full border border-cyan-400/35 bg-cyan-500/15 px-2 py-0.5 text-cyan-50">primary</span>
                      ) : null}
                    </div>
                    <code className="mt-1 block break-all text-xs text-slate-200">{dependency.upstreamTaskId}</code>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No upstream dependencies.</p>
            )}
          </PanelSection>

          <PanelSection title="Dependency state">
            {task.dependencyState ? (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Blocked</div>
                    <div className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] ${task.dependencyState.blocked ? 'border-amber-500/35 bg-amber-500/15 text-amber-100' : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-100'}`}>
                      {task.dependencyState.blocked ? 'Yes' : 'No'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Unblocked at</div>
                    <div className="mt-1 text-xs text-slate-200">{formatTimestamp(task.dependencyState.unblockedAt)}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {task.dependencyState.reasons.map((reason) => (
                    <div key={`${reason.upstreamTaskId}_${reason.state}`} className={`rounded-lg border px-3 py-2 ${dependencyReasonTone(reason.state)}`}>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em]">{reason.state.replace('_', ' ')}</div>
                      <p className="mt-1 text-sm">{reason.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Dependency state has not been computed yet.</p>
            )}
          </PanelSection>

          <PanelSection title="Automation">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Auto-start</div>
                <div className="mt-1 text-xs text-slate-200">{task.automationState?.autoStartEligible ? 'Eligible' : 'Not eligible'}</div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Auto-started at</div>
                <div className="mt-1 text-xs text-slate-200">{formatTimestamp(task.automationState?.autoStartedAt)}</div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Last dependency refresh</div>
                <div className="mt-1 text-xs text-slate-200">{formatTimestamp(task.automationState?.lastDependencyRefreshAt)}</div>
              </div>
            </div>
          </PanelSection>

          <PanelSection title="Resolved branch source">
            {task.branchSource ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Kind</div>
                  <code className="mt-1 block break-all text-xs text-slate-200">{task.branchSource.kind}</code>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Resolved ref</div>
                  <code className="mt-1 block break-all text-xs text-slate-200">{task.branchSource.resolvedRef}</code>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Upstream task</div>
                  <code className="mt-1 block break-all text-xs text-slate-200">{task.branchSource.upstreamTaskId ?? '—'}</code>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Resolved at</div>
                  <div className="mt-1 text-xs text-slate-200">{formatTimestamp(task.branchSource.resolvedAt)}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Run source will resolve to explicit source ref, dependency lineage, or default branch when a run starts.</p>
            )}
            {latestRun?.dependencyContext ? (
              <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Latest run dependency context</div>
                <div className="mt-1 grid gap-1 text-xs text-slate-200">
                  <div>Mode: {latestRun.dependencyContext.sourceMode}</div>
                  <div>Upstream task: {latestRun.dependencyContext.sourceTaskId ?? '—'}</div>
                  <div>Upstream run: {latestRun.dependencyContext.sourceRunId ?? '—'}</div>
                  <div>Upstream PR: {latestRun.dependencyContext.sourcePrNumber ?? '—'}</div>
                  <div>Upstream head SHA: {latestRun.dependencyContext.sourceHeadSha ?? '—'}</div>
                </div>
              </div>
            ) : null}
          </PanelSection>

          <PanelSection title="Task checkpoints">
            {latestTaskCheckpoint ? (
              <div className="space-y-2">
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Latest checkpoint</div>
                <div className="mt-1 text-xs text-slate-200 break-words [overflow-wrap:anywhere]">
                  {latestTaskCheckpoint.checkpointId} · {latestTaskCheckpoint.phase} · {shortSha(latestTaskCheckpoint.commitSha)}
                </div>
                  <div className="mt-1 text-xs text-slate-400">{formatTimestamp(latestTaskCheckpoint.createdAt)}</div>
                </div>
                <div className="text-xs text-slate-500">
                  {taskCheckpoints.length} checkpoint{taskCheckpoints.length === 1 ? '' : 's'} across {detail.runs.length} run{detail.runs.length === 1 ? '' : 's'}.
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No checkpoints recorded for this task yet.</p>
            )}
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
