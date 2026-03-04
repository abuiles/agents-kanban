import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailPanel } from './DetailPanel';
import type { TaskDetail } from '../domain/types';

afterEach(() => {
  cleanup();
});

function buildDetail(): TaskDetail {
  return {
    repo: {
      repoId: 'repo_demo',
      slug: 'abuiles/minions-demo',
      defaultBranch: 'main',
      baselineUrl: 'https://main.minions-demo.example',
      enabled: true,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z'
    },
    task: {
      taskId: 'task_demo',
      repoId: 'repo_demo',
      title: 'Fix preview retry routing',
      sourceRef: 'https://github.com/abuiles/minions-demo/pull/4',
      dependencies: [
        { upstreamTaskId: 'task_upstream_a', mode: 'review_ready', primary: true },
        { upstreamTaskId: 'task_upstream_b', mode: 'review_ready' }
      ],
      dependencyState: {
        blocked: true,
        reasons: [
          { upstreamTaskId: 'task_upstream_a', state: 'ready', message: 'Upstream task task_upstream_a is review-ready.' },
          { upstreamTaskId: 'task_upstream_b', state: 'not_ready', message: 'Upstream task task_upstream_b is not review-ready yet.' }
        ]
      },
      automationState: {
        autoStartEligible: true,
        autoStartedAt: '2026-03-01T00:00:00.000Z',
        lastDependencyRefreshAt: '2026-03-01T00:05:00.000Z'
      },
      branchSource: {
        kind: 'dependency_review_head',
        upstreamTaskId: 'task_upstream_a',
        upstreamRunId: 'run_upstream_a',
        upstreamPrNumber: 44,
        upstreamHeadSha: 'abc1234',
        resolvedRef: 'refs/pull/44/head',
        resolvedAt: '2026-03-01T00:06:00.000Z'
      },
      taskPrompt: 'Fix the preview retry button routing.',
      acceptanceCriteria: ['Retry preview uses the preview endpoint.'],
      context: { links: [] },
      status: 'ACTIVE',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z'
    },
    runs: [
      {
        runId: 'run_demo',
        taskId: 'task_demo',
        repoId: 'repo_demo',
        status: 'WAITING_PREVIEW',
        branchName: 'codex/fix-preview-routing',
        prUrl: 'https://github.com/abuiles/minions-demo/pull/2',
        dependencyContext: {
          sourceMode: 'dependency_review_head',
          sourceTaskId: 'task_upstream_a',
          sourceRunId: 'run_upstream_a',
          sourcePrNumber: 44,
          sourceHeadSha: 'abc1234'
        },
        previewStatus: 'DISCOVERING',
        evidenceStatus: 'NOT_STARTED',
        errors: [],
        startedAt: '2026-03-01T00:00:00.000Z',
        timeline: [{ status: 'WAITING_PREVIEW', at: '2026-03-01T00:00:00.000Z' }],
        simulationProfile: 'happy_path',
        pendingEvents: []
      }
    ],
    latestRun: {
      runId: 'run_demo',
      taskId: 'task_demo',
      repoId: 'repo_demo',
      status: 'WAITING_PREVIEW',
      branchName: 'codex/fix-preview-routing',
      prUrl: 'https://github.com/abuiles/minions-demo/pull/2',
      dependencyContext: {
        sourceMode: 'dependency_review_head',
        sourceTaskId: 'task_upstream_a',
        sourceRunId: 'run_upstream_a',
        sourcePrNumber: 44,
        sourceHeadSha: 'abc1234'
      },
      previewStatus: 'DISCOVERING',
      evidenceStatus: 'NOT_STARTED',
      errors: [],
      startedAt: '2026-03-01T00:00:00.000Z',
      timeline: [{ status: 'WAITING_PREVIEW', at: '2026-03-01T00:00:00.000Z' }],
      simulationProfile: 'happy_path',
      pendingEvents: []
    }
  };
}

function buildProps() {
  return {
    detail: buildDetail(),
    logs: [],
    events: [],
    commands: [],
    terminalBootstrap: undefined,
    onEditTask: vi.fn(),
    onRequestChanges: vi.fn(),
    onRetryRun: vi.fn(),
    onRerunReview: vi.fn(),
    onRetryPreview: vi.fn(),
    onRetryEvidence: vi.fn(),
    onOpenTerminal: vi.fn(),
    onTakeOverRun: vi.fn()
  };
}

describe('DetailPanel', () => {
  it('routes preview retry clicks to the preview handler only', async () => {
    const user = userEvent.setup();
    const onRetryRun = vi.fn();
    const onRetryPreview = vi.fn();
    const onRetryEvidence = vi.fn();
    const props = buildProps();

    render(
      <DetailPanel
        {...props}
        onRetryRun={onRetryRun}
        onRetryPreview={onRetryPreview}
        onRetryEvidence={onRetryEvidence}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Retry preview fetch' }));

    expect(onRetryPreview).toHaveBeenCalledTimes(1);
    expect(onRetryPreview).toHaveBeenCalledWith('run_demo');
    expect(onRetryRun).not.toHaveBeenCalled();
    expect(onRetryEvidence).not.toHaveBeenCalled();
  });

  it('copies logs for debugging', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    render(
      <DetailPanel
        {...buildProps()}
        logs={[
          {
            id: 'log_1',
            runId: 'run_demo',
            createdAt: '2026-03-01T00:00:00.000Z',
            level: 'info',
            phase: 'preview',
            message: 'Preview discovery matched a Cloudflare preview URL.'
          }
        ]}
      />
    );

    const copyButton = screen.getAllByRole('button', { name: 'Copy logs' }).find((button) => !button.hasAttribute('disabled'));
    expect(copyButton).toBeDefined();
    await user.click(copyButton!);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Preview discovery matched a Cloudflare preview URL.');
    expect(writeText.mock.calls[0][0]).toContain('(preview)');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });

  it('shows the task source ref', () => {
    render(
      <DetailPanel
        {...buildProps()}
      />
    );

    const sourceRefLinks = screen
      .getAllByRole('link', { name: 'https://github.com/abuiles/minions-demo/pull/4' })
      .filter((link) => link.getAttribute('href') === 'https://github.com/abuiles/minions-demo/pull/4');

    expect(sourceRefLinks.length).toBeGreaterThan(0);
  });

  it('shows dependency reasons and resolved branch source details', () => {
    render(
      <DetailPanel
        {...buildProps()}
      />
    );

    expect(screen.getByText('Upstream task task_upstream_b is not review-ready yet.')).toBeInTheDocument();
    expect(screen.getByText('dependency_review_head')).toBeInTheDocument();
    expect(screen.getByText('refs/pull/44/head')).toBeInTheDocument();
    expect(screen.getByText('Mode: dependency_review_head')).toBeInTheDocument();
  });

  it('renders truthful resume capability messaging for Codex and Cursor CLI runs', () => {
    const codexProps = buildProps();
    codexProps.detail = {
      ...codexProps.detail,
      latestRun: {
        ...codexProps.detail.latestRun!,
        llmAdapter: 'codex',
        llmSupportsResume: true,
        llmResumeCommand: 'codex resume thread-123',
        latestCodexResumeCommand: 'codex resume thread-123'
      }
    };

    const { rerender } = render(<DetailPanel {...codexProps} />);
    expect(screen.getByText('codex resume thread-123')).toBeInTheDocument();

    const cursorProps = buildProps();
    cursorProps.detail = {
      ...cursorProps.detail,
      latestRun: {
        ...cursorProps.detail.latestRun!,
        llmAdapter: 'cursor_cli',
        llmSupportsResume: false,
        llmResumeCommand: undefined,
        latestCodexResumeCommand: undefined
      }
    };

    rerender(<DetailPanel {...cursorProps} />);
    expect(screen.getByText('Cursor CLI does not advertise resumable takeover for this run.')).toBeInTheDocument();
  });

  it('renders checkpoint list and resumed-from indicator on latest run', () => {
    const props = buildProps();
    props.detail = {
      ...props.detail,
      runs: [{
        ...props.detail.runs[0],
        checkpoints: [{
          checkpointId: 'run_demo:cp:001:codex',
          runId: 'run_demo',
          repoId: 'repo_demo',
          taskId: 'task_demo',
          phase: 'codex',
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          commitMessage: 'agentskanban checkpoint 001 (codex) [run_demo]',
          createdAt: '2026-03-01T00:01:00.000Z'
        }]
      }],
      latestRun: {
        ...props.detail.latestRun!,
        checkpoints: [{
          checkpointId: 'run_demo:cp:001:codex',
          runId: 'run_demo',
          repoId: 'repo_demo',
          taskId: 'task_demo',
          phase: 'codex',
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          commitMessage: 'agentskanban checkpoint 001 (codex) [run_demo]',
          createdAt: '2026-03-01T00:01:00.000Z'
        }],
        resumedFromCheckpointId: 'run_demo:cp:001:codex',
        resumedFromCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }
    };

    render(<DetailPanel {...props} />);

    expect(screen.getByText('Resumed from checkpoint')).toBeInTheDocument();
    expect(screen.getAllByText('resumed-from').length).toBeGreaterThan(0);
    expect(screen.getByText(/run_demo:cp:001:codex · codex · aaaaaaaa/)).toBeInTheDocument();
  });

  it('renders empty checkpoint states when metadata is absent', () => {
    render(<DetailPanel {...buildProps()} />);

    expect(screen.getByText('No checkpoints recorded on this run.')).toBeInTheDocument();
    expect(screen.getByText('No checkpoints recorded for this task yet.')).toBeInTheDocument();
  });

  it('routes edit task clicks to the edit handler', async () => {
    const user = userEvent.setup();
    const onEditTask = vi.fn();

    render(
      <DetailPanel
        {...buildProps()}
        onEditTask={onEditTask}
      />
    );

    await user.click(screen.getAllByRole('button', { name: 'Edit task' })[0]);

    expect(onEditTask).toHaveBeenCalledTimes(1);
    expect(onEditTask).toHaveBeenCalledWith('task_demo');
  });

  it('routes request changes clicks to the review handler', async () => {
    const user = userEvent.setup();
    const onRequestChanges = vi.fn();

    render(
      <DetailPanel
        {...buildProps()}
        onRequestChanges={onRequestChanges}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(onRequestChanges).toHaveBeenCalledTimes(1);
    expect(onRequestChanges).toHaveBeenCalledWith('run_demo');
  });

  it('routes terminal and takeover clicks to the corresponding handlers', async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const onTakeOverRun = vi.fn();

    render(
      <DetailPanel
        {...buildProps()}
        onOpenTerminal={onOpenTerminal}
        onTakeOverRun={onTakeOverRun}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    await user.click(screen.getByRole('button', { name: 'Take over' }));

    expect(onOpenTerminal).toHaveBeenCalledWith('run_demo');
    expect(onTakeOverRun).toHaveBeenCalledWith('run_demo');
  });

  it('routes re-run review clicks to the review rerun handler', async () => {
    const user = userEvent.setup();
    const onRerunReview = vi.fn();

    render(
      <DetailPanel
        {...buildProps()}
        onRerunReview={onRerunReview}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Re-run review' }));

    expect(onRerunReview).toHaveBeenCalledTimes(1);
    expect(onRerunReview).toHaveBeenCalledWith('run_demo');
  });
});
