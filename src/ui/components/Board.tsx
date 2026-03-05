import { DndContext, DragEndEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties } from 'react';
import type { AgentRun, Repo, Task, TaskStatus } from '../domain/types';
import { TASK_COLUMNS } from '../domain/selectors';

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

function deriveRunSignal(run?: AgentRun) {
  if (!run) {
    return { label: 'Idle', tone: 'text-slate-400' };
  }

  switch (run.status) {
    case 'QUEUED':
    case 'BOOTSTRAPPING':
    case 'RUNNING_CODEX':
    case 'OPERATOR_CONTROLLED':
    case 'RUNNING_TESTS':
    case 'PUSHING_BRANCH':
      return run.status === 'OPERATOR_CONTROLLED'
        ? { label: 'Operator', tone: 'text-amber-300' }
        : { label: 'Running', tone: 'text-cyan-300' };
    case 'PR_OPEN':
    case 'WAITING_PREVIEW':
      return { label: 'Review open', tone: 'text-violet-300' };
    case 'EVIDENCE_RUNNING':
      return { label: 'Evidence', tone: 'text-amber-300' };
    case 'DONE':
      return { label: 'Evidence ready', tone: 'text-emerald-300' };
    case 'FAILED':
      return { label: 'Failed', tone: 'text-rose-300' };
    default:
      return { label: run.status, tone: 'text-slate-400' };
  }
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
  onSelect
}: {
  task: Task;
  repo?: Repo;
  latestRun?: AgentRun;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.taskId
  });
  const signal = deriveRunSignal(latestRun);

  return (
    <button
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.58 : 1 }}
      type="button"
      onClick={onSelect}
      className={[
        'group rounded-xl border px-3 py-2.5 text-left transition duration-150',
        'bg-slate-900/90 shadow-[0_8px_18px_rgba(2,6,23,0.24)] hover:border-slate-500 hover:bg-slate-900',
        isSelected ? 'border-cyan-400 ring-2 ring-cyan-400/30' : 'border-slate-800'
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
            <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${signal.tone}`}>{signal.label}</span>
          </div>
          <div className="text-sm font-semibold leading-5 text-slate-50 break-words" style={clampTwoLines}>
            {task.title}
          </div>
        </div>
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-600 group-hover:bg-cyan-300" />
      </div>

      {task.description
        ? (
          <p className="mt-1.5 text-xs leading-5 text-slate-400 break-words" style={clampTwoLines}>
            {task.description}
          </p>
        )
        : null}

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{(latestRun?.reviewNumber ?? latestRun?.prNumber) ? `Review #${latestRun.reviewNumber ?? latestRun.prNumber}` : 'No review yet'}</span>
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
  onSelectTask
}: {
  status: TaskStatus;
  tasks: Task[];
  repos: Repo[];
  runsByTask: Map<string, AgentRun>;
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const style = laneStyles[status];

  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${status}`}
      className={[
        'relative flex min-h-[28rem] min-w-64 flex-col rounded-2xl border bg-slate-950/65',
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
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${style.badge}`}>{tasks.length}</span>
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

export function Board({
  tasksByColumn,
  repos,
  runs,
  selectedTaskId,
  onSelectTask,
  onMoveTask
}: {
  tasksByColumn: Record<TaskStatus, Task[]>;
  repos: Repo[];
  runs: AgentRun[];
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  onMoveTask: (taskId: string, status: TaskStatus) => void;
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
                onSelectTask={onSelectTask}
              />
            ))}
          </div>
        </div>
      </DndContext>
    </section>
  );
}
