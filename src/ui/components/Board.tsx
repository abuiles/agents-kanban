import { DndContext, DragEndEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties } from 'react';
import type { AgentRun, Repo, Task, TaskStatus } from '../domain/types';
import { TASK_COLUMNS } from '../domain/selectors';
import { getColumnHeadline, getReviewSignal, getRunSignal, isRunLive, laneStatusLabel, toneClass } from '../domain/dashboard';

const laneStyles: Record<TaskStatus, { tint: string; badge: string; empty: string }> = {
  INBOX: {
    tint: 'from-slate-500/20 to-slate-500/0 border-slate-800',
    badge: 'bg-slate-700/70 text-slate-200',
    empty: 'New tasks land here'
  },
  READY: {
    tint: 'from-blue-500/20 to-blue-500/0 border-blue-500/20',
    badge: 'bg-blue-500/20 text-blue-100',
    empty: 'Ready for an operator to activate'
  },
  ACTIVE: {
    tint: 'from-cyan-500/22 to-cyan-500/0 border-cyan-500/20',
    badge: 'bg-cyan-500/20 text-cyan-50',
    empty: 'Drop here to start work'
  },
  REVIEW: {
    tint: 'from-violet-500/22 to-violet-500/0 border-violet-500/20',
    badge: 'bg-violet-500/20 text-violet-50',
    empty: 'Reviews and evidence collect here'
  },
  DONE: {
    tint: 'from-emerald-500/22 to-emerald-500/0 border-emerald-500/20',
    badge: 'bg-emerald-500/20 text-emerald-50',
    empty: 'Human-approved work finishes here'
  },
  FAILED: {
    tint: 'from-rose-500/22 to-rose-500/0 border-rose-500/20',
    badge: 'bg-rose-500/20 text-rose-50',
    empty: 'Failures and retries need attention'
  }
};

function formatRelativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(delta / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function getLatestRun(runsByTask: Map<string, AgentRun>, task: Task) {
  return runsByTask.get(task.taskId);
}

const clampTwoLines: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word'
};

function TaskCard({
  task,
  repo,
  latestRun,
  isSelected,
  isBulkSelected = false,
  onSelect,
  draggable = true
}: {
  task: Task;
  repo?: Repo;
  latestRun?: AgentRun;
  isSelected: boolean;
  isBulkSelected?: boolean;
  onSelect: () => void;
  draggable?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.taskId,
    disabled: !draggable
  });
  const runSignal = getRunSignal(latestRun);
  const reviewSignal = getReviewSignal(latestRun);
  const isLive = isRunLive(latestRun);
  const liveGlow = isLive ? 'border-cyan-400/60 bg-cyan-500/[0.07] shadow-[0_0_0_1px_rgba(34,211,238,0.16),0_18px_34px_rgba(8,47,73,0.26)]' : '';

  return (
    <button
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.58 : 1 }}
      type="button"
      onClick={onSelect}
      className={[
        'group w-full min-w-0 rounded-xl border px-3 py-2.5 text-left transition duration-150',
        'bg-slate-900/90 shadow-[0_8px_18px_rgba(2,6,23,0.24)] hover:border-slate-500 hover:bg-slate-900',
        isSelected ? 'border-cyan-400 ring-2 ring-cyan-400/30' : isBulkSelected ? 'border-amber-400 ring-2 ring-amber-400/20' : 'border-slate-800',
        liveGlow
      ].join(' ')}
      {...listeners}
      {...attributes}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300">
              {repo?.slug.split('/')[1] ?? task.repoId}
            </span>
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneClass(runSignal.tone)}`}>
              {runSignal.label}
            </span>
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneClass(reviewSignal.tone)}`}>
              {reviewSignal.label}
            </span>
            {task.archived ? (
              <span className="inline-flex rounded-full border border-slate-600 bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-200">
                Archived
              </span>
            ) : null}
            {isBulkSelected ? (
              <span className="inline-flex rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-100">
                Selected
              </span>
            ) : null}
          </div>
          <div className="text-sm font-semibold leading-5 text-slate-50 break-words [overflow-wrap:anywhere]" style={clampTwoLines}>
            {task.title}
          </div>
        </div>
        <div className="mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {isLive ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-200" />
            </span>
          ) : (
            <span className="h-2.5 w-2.5 rounded-full bg-slate-600 group-hover:bg-cyan-300" />
          )}
        </div>
      </div>

      {task.description
        ? (
          <p className="mt-1.5 text-xs leading-5 text-slate-400 break-words [overflow-wrap:anywhere]" style={clampTwoLines}>
            {task.description}
          </p>
        )
        : null}

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{laneStatusLabel(task, latestRun)}</span>
        <span>{formatRelativeTime(task.updatedAt)}</span>
      </div>
    </button>
  );
}

function BoardColumn({
  status,
  tasks,
  repos,
  runsByTask,
  selectedTaskId,
  selectedTaskIds,
  onSelectTask,
  onArchiveColumn
}: {
  status: TaskStatus;
  tasks: Task[];
  repos: Repo[];
  runsByTask: Map<string, AgentRun>;
  selectedTaskId?: string;
  selectedTaskIds: Set<string>;
  onSelectTask: (taskId: string) => void;
  onArchiveColumn: (status: TaskStatus) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const style = laneStyles[status];
  const headline = getColumnHeadline(status);
  const canArchiveColumn = (status === 'DONE' || status === 'FAILED') && tasks.length > 0;

  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${status}`}
      className={[
        'relative flex min-h-[28rem] w-80 min-w-0 shrink-0 flex-col rounded-2xl border bg-slate-950/65',
        'bg-gradient-to-b px-3 pb-3 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]',
        style.tint,
        isOver ? 'border-cyan-300 bg-cyan-500/10 ring-2 ring-cyan-400/25' : ''
      ].join(' ')}
    >
      <div className={`absolute inset-x-3 top-0 h-px bg-gradient-to-r ${style.tint.split(' ')[0]} ${style.tint.split(' ')[1]}`} />
      <header className="sticky top-0 z-10 mb-3 flex items-center justify-between rounded-xl border border-white/5 bg-slate-950/88 px-3 py-2.5 backdrop-blur">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-white">{status}</h3>
          <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">{style.empty}</div>
          {headline ? <div className="mt-1 text-xs text-slate-500">{headline}</div> : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${style.badge}`}>{tasks.length}</span>
          {canArchiveColumn ? (
            <button
              type="button"
              title={`Archive all ${status.toLowerCase()} tasks`}
              onClick={() => onArchiveColumn(status)}
              className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border border-white/10 bg-slate-900/90 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300 transition hover:border-white/20 hover:text-white"
            >
              Archive
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3">
        {tasks.length ? (
          tasks.map((task) => (
            <TaskCard
              key={task.taskId}
              task={task}
              repo={repos.find((repo) => repo.repoId === task.repoId)}
              latestRun={getLatestRun(runsByTask, task)}
              isSelected={selectedTaskId === task.taskId}
              isBulkSelected={selectedTaskIds.has(task.taskId)}
              onSelect={() => onSelectTask(task.taskId)}
            />
          ))
        ) : (
          <div className="flex flex-1 items-center">
            <div className="w-full rounded-xl border border-dashed border-slate-800 bg-slate-950/55 px-3 py-4 text-center text-xs leading-5 text-slate-500">
              {style.empty}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ArchivedTasksShelf({
  archivedTasks,
  repos,
  runsByTask,
  selectedTaskId,
  selectedTaskIds,
  onSelectTask,
  showArchived,
  onToggleArchived
}: {
  archivedTasks: Task[];
  repos: Repo[];
  runsByTask: Map<string, AgentRun>;
  selectedTaskId?: string;
  selectedTaskIds: Set<string>;
  onSelectTask: (taskId: string) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  if (!archivedTasks.length) {
    return null;
  }

  return (
    <section className="border-t border-slate-800 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">Archive</h3>
          <p className="mt-1 text-sm text-slate-500">Archived tasks stay searchable and restorable, but do not crowd the main board.</p>
        </div>
        <button
          type="button"
          onClick={onToggleArchived}
          className="inline-flex h-10 items-center rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-200 transition hover:border-slate-500"
        >
          {showArchived ? `Hide archived (${archivedTasks.length})` : `Show archived (${archivedTasks.length})`}
        </button>
      </div>
      {showArchived ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {archivedTasks.map((task) => (
            <TaskCard
              key={task.taskId}
              task={task}
              repo={repos.find((repo) => repo.repoId === task.repoId)}
              latestRun={getLatestRun(runsByTask, task)}
              isSelected={selectedTaskId === task.taskId}
              isBulkSelected={selectedTaskIds.has(task.taskId)}
              onSelect={() => onSelectTask(task.taskId)}
              draggable={false}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function Board({
  tasksByColumn,
  repos,
  runs,
  archivedTasks,
  showArchived,
  multiSelectMode,
  selectedTaskIds,
  selectedTaskId,
  onSelectTask,
  onMoveTask,
  onToggleArchived,
  onToggleMultiSelectMode,
  onClearSelectedTasks,
  onArchiveSelectedTasks,
  onArchiveColumn
}: {
  tasksByColumn: Record<TaskStatus, Task[]>;
  repos: Repo[];
  runs: AgentRun[];
  archivedTasks: Task[];
  showArchived: boolean;
  multiSelectMode: boolean;
  selectedTaskIds: Set<string>;
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  onMoveTask: (taskId: string, status: TaskStatus) => void;
  onToggleArchived: () => void;
  onToggleMultiSelectMode: () => void;
  onClearSelectedTasks: () => void;
  onArchiveSelectedTasks: () => void;
  onArchiveColumn: (status: TaskStatus) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const runsByTask = new Map(
    runs
      .slice()
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((run) => [run.taskId, run])
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-950/70 shadow-[0_16px_44px_rgba(2,6,23,0.38)]">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">Board operations</h2>
          <p className="mt-1 text-sm text-slate-500">Active starts a run. Review collects review requests and evidence.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggleMultiSelectMode}
            className={[
              'inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition',
              multiSelectMode
                ? 'border-amber-400/35 bg-amber-500/15 text-amber-50'
                : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500'
            ].join(' ')}
          >
            {multiSelectMode ? 'Exit select mode' : 'Select tasks'}
          </button>
          {multiSelectMode ? (
            <>
              <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                {selectedTaskIds.size} selected
              </span>
              <button
                type="button"
                onClick={onClearSelectedTasks}
                className="inline-flex h-9 items-center rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-200 transition hover:border-slate-500"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={onArchiveSelectedTasks}
                disabled={!selectedTaskIds.size}
                className="inline-flex h-9 items-center rounded-lg border border-amber-400/35 bg-amber-500/15 px-3 text-sm font-medium text-amber-50 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-500"
              >
                Archive selected
              </button>
            </>
          ) : null}
        </div>
      </div>
      <DndContext
        sensors={sensors}
        onDragEnd={(event: DragEndEvent) => {
          const taskId = String(event.active.id || '');
          const status = event.over?.id as TaskStatus | undefined;
          if (taskId && status) {
            onMoveTask(taskId, status);
          }
        }}
      >
        <div className="overflow-x-auto px-4 py-4">
          <div className="flex min-w-max gap-3">
            {TASK_COLUMNS.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                tasks={tasksByColumn[status]}
                repos={repos}
                runsByTask={runsByTask}
                selectedTaskId={selectedTaskId}
                selectedTaskIds={selectedTaskIds}
                onSelectTask={onSelectTask}
                onArchiveColumn={onArchiveColumn}
              />
            ))}
          </div>
        </div>
        <ArchivedTasksShelf
          archivedTasks={archivedTasks}
          repos={repos}
          runsByTask={runsByTask}
          selectedTaskId={selectedTaskId}
          selectedTaskIds={selectedTaskIds}
          onSelectTask={onSelectTask}
          showArchived={showArchived}
          onToggleArchived={onToggleArchived}
        />
      </DndContext>
    </section>
  );
}
