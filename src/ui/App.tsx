import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Board } from './components/Board';
import { ControlSurfaceHeader, SummaryRow } from './components/ControlSurface';
import { DetailPanel } from './components/DetailPanel';
import { RepoForm, TaskForm } from './components/Forms';
import { Modal } from './components/Modal';
import { RunTerminal } from './components/RunTerminal';
import { getTaskDetail, getTasksByColumn, getTasksForRepo } from './domain/selectors';
import type { RunCommand, RunEvent, RunLogEntry, TaskStatus, TerminalBootstrap } from './domain/types';
import type { AgentBoardApi } from './domain/api';
import { getAgentBoardApi } from './api';
import { downloadJson } from './store/import-export';
import { getSelectedTaskIdFromUrl, setSelectedTaskIdInUrl } from './url-state';

export default function App({ api: providedApi }: { api?: AgentBoardApi }) {
  const api = useMemo(() => providedApi ?? getAgentBoardApi(), [providedApi]);
  const snapshot = useSyncExternalStore(
    api.subscribe.bind(api),
    () => api.getSnapshot(),
    () => api.getSnapshot()
  );
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [repoToEditId, setRepoToEditId] = useState<string | undefined>();
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskToEditId, setTaskToEditId] = useState<string | undefined>();
  const [changeRequestRunId, setChangeRequestRunId] = useState<string | undefined>();
  const [changeRequestPrompt, setChangeRequestPrompt] = useState('');
  const [selectedRunEvents, setSelectedRunEvents] = useState<RunEvent[]>([]);
  const [selectedRunCommands, setSelectedRunCommands] = useState<RunCommand[]>([]);
  const [terminalBootstrap, setTerminalBootstrap] = useState<TerminalBootstrap | undefined>();
  const [terminalModalRunId, setTerminalModalRunId] = useState<string | undefined>();
  const [terminalResumeCopied, setTerminalResumeCopied] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [taskSelectionHydrated, setTaskSelectionHydrated] = useState(false);

  const selectedRepoId = snapshot.ui.selectedRepoId;
  const selectedTaskId = snapshot.ui.selectedTaskId;
  const repos = snapshot.repos;
  const selectedRepo = selectedRepoId === 'all' ? undefined : repos.find((repo) => repo.repoId === selectedRepoId);
  const repoToEdit = repoToEditId ? repos.find((repo) => repo.repoId === repoToEditId) : undefined;
  const visibleTasks = getTasksForRepo(snapshot.tasks, selectedRepoId);
  const tasksByColumn = getTasksByColumn(visibleTasks);
  const detail = getTaskDetail(snapshot, selectedTaskId);
  const taskToEdit = taskToEditId ? snapshot.tasks.find((task) => task.taskId === taskToEditId) : undefined;
  const logs: RunLogEntry[] = detail?.latestRun
    ? snapshot.logs.filter((entry) => entry.runId === detail.latestRun?.runId)
    : [];
  const terminalRun = terminalModalRunId ? snapshot.runs.find((run) => run.runId === terminalModalRunId) : undefined;
  const terminalLogs = terminalModalRunId ? snapshot.logs.filter((entry) => entry.runId === terminalModalRunId) : [];
  const terminalCodexLogs = terminalLogs.filter((entry) => entry.phase === 'codex');
  const terminalStreamLogs = terminalCodexLogs.length ? terminalCodexLogs : terminalLogs;

  useEffect(() => {
    const runId = detail?.latestRun?.runId;
    if (!runId) {
      setSelectedRunEvents([]);
      setSelectedRunCommands([]);
      setTerminalBootstrap(undefined);
      return;
    }

    void api.getRunEvents(runId).then(setSelectedRunEvents).catch(() => setSelectedRunEvents([]));
    void api.getRunCommands(runId).then(setSelectedRunCommands).catch(() => setSelectedRunCommands([]));
  }, [api, detail?.latestRun?.runId]);

  useEffect(() => {
    if (taskSelectionHydrated) {
      return;
    }

    const taskIdFromUrl = getSelectedTaskIdFromUrl();
    if (!taskIdFromUrl) {
      setTaskSelectionHydrated(true);
      return;
    }

    if (!snapshot.tasks.length) {
      return;
    }

    setTaskSelectionHydrated(true);
    const taskExists = snapshot.tasks.some((task) => task.taskId === taskIdFromUrl);
    if (taskExists && taskIdFromUrl !== selectedTaskId) {
      void api.setSelectedTaskId(taskIdFromUrl);
      return;
    }

    if (!taskExists) {
      setSelectedTaskIdInUrl(undefined);
    }
  }, [api, selectedTaskId, snapshot.tasks, taskSelectionHydrated]);

  useEffect(() => {
    if (!taskSelectionHydrated) {
      return;
    }

    if (selectedTaskId && !snapshot.tasks.some((task) => task.taskId === selectedTaskId)) {
      void api.setSelectedTaskId(undefined);
      return;
    }

    setSelectedTaskIdInUrl(selectedTaskId);
  }, [api, selectedTaskId, snapshot.tasks, taskSelectionHydrated]);

  async function moveTask(taskId: string, status: TaskStatus) {
    const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      return;
    }

    const latestRun = snapshot.runs
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    const hasActiveRun = latestRun && !['DONE', 'FAILED'].includes(latestRun.status);
    if (task.status === 'ACTIVE' && hasActiveRun && status !== 'ACTIVE') {
      setNotice('Active runs stay pinned to Active until the current lifecycle finishes.');
      return;
    }

    await api.updateTask(taskId, { status });
    if (status === 'ACTIVE') {
      await api.startRun(taskId);
    }
    await api.setSelectedTaskId(taskId);
    setNotice(status === 'ACTIVE' ? 'Run started from the board.' : `Moved task to ${status}.`);
  }

  async function retryRun(runId: string) {
    const run = await api.retryRun(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Started a fresh run.');
  }

  async function retryPreview(runId: string) {
    const run = await api.retryPreview(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Retrying preview discovery for the current PR.');
  }

  async function retryEvidence(runId: string) {
    const run = await api.retryEvidence(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Retrying evidence for the current PR.');
  }

  async function openTerminal(runId: string) {
    try {
      const bootstrap = await api.getTerminalBootstrap(runId);
      setTerminalBootstrap(bootstrap);
      setTerminalModalRunId(runId);
      setTerminalResumeCopied(false);
      setNotice(bootstrap.attachable ? 'Terminal connected to the live sandbox session.' : `Terminal unavailable: ${bootstrap.reason ?? 'unknown error'}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to open terminal.');
    }
  }

  async function takeOverRun(runId: string) {
    const run = await api.takeOverRun(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Operator takeover recorded for the live sandbox.');
  }

  async function requestChanges(runId: string) {
    const prompt = changeRequestPrompt.trim();
    if (!prompt) {
      setNotice('Enter the requested changes before starting a review rerun.');
      return;
    }

    const run = await api.requestRunChanges(runId, { prompt });
    await api.setSelectedTaskId(run.taskId);
    setChangeRequestRunId(undefined);
    setChangeRequestPrompt('');
    setNotice('Started a review rerun on the existing PR branch.');
  }

  async function toggleTaskSelection(taskId: string) {
    await api.setSelectedTaskId(selectedTaskId === taskId ? undefined : taskId);
  }

  async function copyTerminalResumeCommand() {
    const command = terminalRun?.latestCodexResumeCommand;
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      setTerminalResumeCopied(true);
      setNotice('Copied the latest Codex resume command.');
      window.setTimeout(() => setTerminalResumeCopied(false), 2_000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to copy the Codex resume command.');
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await api.importState(await file.text());
      setNotice('Imported board state.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      event.target.value = '';
    }
  }

  return (
    <div className="min-h-screen px-4 py-4 text-slate-100 sm:px-6 xl:px-8">
      <div className="mx-auto flex w-full max-w-[1900px] flex-col gap-3">
        <ControlSurfaceHeader
          repos={repos}
          selectedRepoId={selectedRepoId}
          onRepoChange={(repoId) => void api.setSelectedRepoId(repoId)}
          onAddRepo={() => setRepoModalOpen(true)}
          onEditRepo={selectedRepo ? () => setRepoToEditId(selectedRepo.repoId) : undefined}
          onCreateTask={() => setTaskModalOpen(true)}
          onExport={() => downloadJson('agentboard-export.json', api.exportState())}
          onImport={handleImport}
        />

        <SummaryRow repos={repos} visibleTasks={visibleTasks} />

        {notice ? (
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-2.5 text-sm text-cyan-50 shadow-[0_8px_24px_rgba(8,47,73,0.25)]">
            {notice}
          </div>
        ) : null}

        <main className="grid gap-4 xl:grid-cols-[minmax(0,2.15fr)_minmax(20rem,0.85fr)] 2xl:grid-cols-[minmax(0,2.35fr)_minmax(22rem,0.78fr)]">
          <Board
            tasksByColumn={tasksByColumn}
            repos={repos}
            runs={snapshot.runs}
            selectedTaskId={selectedTaskId}
            onSelectTask={(taskId) => void toggleTaskSelection(taskId)}
            onMoveTask={(taskId, status) => void moveTask(taskId, status)}
          />
          <DetailPanel
            detail={detail}
            logs={logs}
            events={selectedRunEvents}
            commands={selectedRunCommands}
            terminalBootstrap={terminalBootstrap}
            onEditTask={(taskId) => setTaskToEditId(taskId)}
            onRequestChanges={(runId) => setChangeRequestRunId(runId)}
            onRetryRun={(runId) => void retryRun(runId)}
            onRetryPreview={(runId) => void retryPreview(runId)}
            onRetryEvidence={(runId) => void retryEvidence(runId)}
            onOpenTerminal={(runId) => void openTerminal(runId)}
            onTakeOverRun={(runId) => void takeOverRun(runId)}
          />
        </main>
      </div>

      {repoModalOpen ? (
        <Modal title="Add repo" onClose={() => setRepoModalOpen(false)}>
          <RepoForm
            onSubmit={async (input) => {
              await api.createRepo(input);
              setRepoModalOpen(false);
              setNotice('Repo added to the board.');
            }}
          />
        </Modal>
      ) : null}

      {repoToEdit ? (
        <Modal title={`Edit ${repoToEdit.slug}`} onClose={() => setRepoToEditId(undefined)}>
          <RepoForm
            initialValues={{
              slug: repoToEdit.slug,
              defaultBranch: repoToEdit.defaultBranch,
              baselineUrl: repoToEdit.baselineUrl,
              previewCheckName: repoToEdit.previewCheckName,
              codexAuthBundleR2Key: repoToEdit.codexAuthBundleR2Key
            }}
            submitLabel="Save repo"
            onSubmit={async (input) => {
              await api.updateRepo(repoToEdit.repoId, input);
              setRepoToEditId(undefined);
              setNotice(`Updated ${repoToEdit.slug}.`);
            }}
          />
        </Modal>
      ) : null}

      {taskModalOpen ? (
        <Modal title="Create task" onClose={() => setTaskModalOpen(false)}>
          <TaskForm
            repos={repos}
            onSubmit={async (input) => {
              const task = await api.createTask(input);
              await api.setSelectedTaskId(task.taskId);
              if (input.status === 'ACTIVE') {
                await api.startRun(task.taskId);
              }
              setTaskModalOpen(false);
              setNotice('Task created.');
            }}
          />
        </Modal>
      ) : null}

      {taskToEdit ? (
        <Modal title={`Edit ${taskToEdit.title}`} onClose={() => setTaskToEditId(undefined)}>
          <TaskForm
            repos={repos}
            initialValues={{
              repoId: taskToEdit.repoId,
              title: taskToEdit.title,
              description: taskToEdit.description,
              sourceRef: taskToEdit.sourceRef,
              taskPrompt: taskToEdit.taskPrompt,
              acceptanceCriteria: taskToEdit.acceptanceCriteria,
              context: taskToEdit.context,
              status: taskToEdit.status,
              baselineUrlOverride: taskToEdit.baselineUrlOverride,
              codexModel: taskToEdit.uiMeta?.codexModel,
              codexReasoningEffort: taskToEdit.uiMeta?.codexReasoningEffort
            }}
            submitLabel="Save task"
            onSubmit={async (input) => {
              await api.updateTask(taskToEdit.taskId, input);
              await api.setSelectedTaskId(taskToEdit.taskId);
              setTaskToEditId(undefined);
              setNotice(`Updated ${taskToEdit.title}.`);
            }}
          />
        </Modal>
      ) : null}

      {changeRequestRunId ? (
        <Modal title="Request changes" onClose={() => setChangeRequestRunId(undefined)}>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              await requestChanges(changeRequestRunId);
            }}
          >
            <label className="grid gap-2 text-sm">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Change request</span>
              <textarea
                className="rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                value={changeRequestPrompt}
                onChange={(event) => setChangeRequestPrompt(event.target.value)}
                rows={6}
                placeholder="Describe the changes you want on the current PR."
                required
              />
              <span className="text-xs text-slate-500">This creates a fresh run on the existing review branch and updates the same PR.</span>
            </label>
            <button
              type="submit"
              className="inline-flex h-11 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/15 px-4 text-sm font-medium text-amber-50 transition hover:bg-amber-500/25"
            >
              Start review rerun
            </button>
          </form>
        </Modal>
      ) : null}

      {terminalModalRunId && terminalBootstrap ? (
        <Modal
          title={`Live terminal · ${terminalRun?.branchName ?? terminalModalRunId}`}
          closeLabel="Disconnect"
          className="max-w-7xl"
          onClose={() => {
            setTerminalModalRunId(undefined);
            setTerminalBootstrap(undefined);
            setTerminalResumeCopied(false);
          }}
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(22rem,0.85fr)]">
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Operator session</div>
                  <div className="mt-1 text-sm text-slate-200">
                    {terminalRun?.operatorSession?.connectionState ?? (terminalBootstrap.attachable ? 'connecting' : 'unavailable')}
                    {' · '}
                    {terminalRun?.operatorSession?.takeoverState ?? 'observing'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Separate operator shell. Codex keeps running until you explicitly take over.
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  {terminalBootstrap.sessionName} · {terminalBootstrap.cols}x{terminalBootstrap.rows}
                </div>
              </div>
              {terminalBootstrap.attachable ? (
                <RunTerminal bootstrap={terminalBootstrap} />
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm text-slate-400">
                  Terminal unavailable: {terminalBootstrap.reason ?? 'unknown error'}.
                </div>
              )}
            </section>

            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Live Codex stream</div>
                  <div className="mt-1 text-sm text-slate-300">
                    {terminalCodexLogs.length ? 'Streaming Codex output.' : 'Showing live run logs while Codex output is unavailable.'}
                  </div>
                </div>
                {terminalRun?.latestCodexResumeCommand ? (
                  <button
                    type="button"
                    onClick={() => void copyTerminalResumeCommand()}
                    className="inline-flex h-8 items-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-xs font-medium text-cyan-50 transition hover:bg-cyan-500/25"
                  >
                    {terminalResumeCopied ? 'Copied resume' : 'Copy resume'}
                  </button>
                ) : null}
              </div>
              {terminalRun?.latestCodexResumeCommand ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Resume command</div>
                  <code className="mt-2 block break-all text-xs text-cyan-200">{terminalRun.latestCodexResumeCommand}</code>
                </div>
              ) : null}
              <div className="max-h-[28rem] space-y-2 overflow-auto rounded-xl border border-slate-900 bg-[#040812] p-3 font-mono text-xs">
                {terminalStreamLogs.length ? (
                  terminalStreamLogs.map((log) => (
                    <div key={log.id} className="rounded-lg border border-slate-900/80 bg-slate-950/80 px-3 py-2">
                      <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                        <span className={log.level === 'error' ? 'text-rose-300' : 'text-cyan-300'}>{log.phase ?? 'run'}</span>
                        <span>{new Date(log.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <code className="mt-2 block whitespace-pre-wrap break-words text-slate-200">{log.message}</code>
                    </div>
                  ))
                ) : (
                  <p className="text-slate-500">Logs will stream here once the run emits output.</p>
                )}
              </div>
            </section>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
