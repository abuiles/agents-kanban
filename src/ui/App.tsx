import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Board } from './components/Board';
import { ControlSurfaceHeader, SummaryRow } from './components/ControlSurface';
import { DetailPanel } from './components/DetailPanel';
import { RepoForm, TaskForm } from './components/Forms';
import { Modal } from './components/Modal';
import { getTaskDetail, getTasksByColumn, getTasksForRepo } from './domain/selectors';
import type { RunLogEntry, TaskStatus } from './domain/types';
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
  const logs: RunLogEntry[] = detail?.latestRun
    ? snapshot.logs.filter((entry) => entry.runId === detail.latestRun?.runId)
    : [];

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
    if (hasActiveRun && status !== 'ACTIVE') {
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

  async function toggleTaskSelection(taskId: string) {
    await api.setSelectedTaskId(selectedTaskId === taskId ? undefined : taskId);
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
            onRetryRun={(runId) => void retryRun(runId)}
            onRetryPreview={(runId) => void retryPreview(runId)}
            onRetryEvidence={(runId) => void retryEvidence(runId)}
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
    </div>
  );
}
