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

describe('DetailPanel', () => {
  it('routes preview retry clicks to the preview handler only', async () => {
    const user = userEvent.setup();
    const onRetryRun = vi.fn();
    const onRetryPreview = vi.fn();
    const onRetryEvidence = vi.fn();

    render(
      <DetailPanel
        detail={buildDetail()}
        logs={[]}
        onEditTask={vi.fn()}
        onRequestChanges={vi.fn()}
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
        detail={buildDetail()}
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
        onEditTask={vi.fn()}
        onRequestChanges={vi.fn()}
        onRetryRun={vi.fn()}
        onRetryPreview={vi.fn()}
        onRetryEvidence={vi.fn()}
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
        detail={buildDetail()}
        logs={[]}
        onEditTask={vi.fn()}
        onRequestChanges={vi.fn()}
        onRetryRun={vi.fn()}
        onRetryPreview={vi.fn()}
        onRetryEvidence={vi.fn()}
      />
    );

    const sourceRefLinks = screen
      .getAllByRole('link', { name: 'https://github.com/abuiles/minions-demo/pull/4' })
      .filter((link) => link.getAttribute('href') === 'https://github.com/abuiles/minions-demo/pull/4');

    expect(sourceRefLinks.length).toBeGreaterThan(0);
  });

  it('routes edit task clicks to the edit handler', async () => {
    const user = userEvent.setup();
    const onEditTask = vi.fn();

    render(
      <DetailPanel
        detail={buildDetail()}
        logs={[]}
        onEditTask={onEditTask}
        onRequestChanges={vi.fn()}
        onRetryRun={vi.fn()}
        onRetryPreview={vi.fn()}
        onRetryEvidence={vi.fn()}
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
        detail={buildDetail()}
        logs={[]}
        onEditTask={vi.fn()}
        onRequestChanges={onRequestChanges}
        onRetryRun={vi.fn()}
        onRetryPreview={vi.fn()}
        onRetryEvidence={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(onRequestChanges).toHaveBeenCalledTimes(1);
    expect(onRequestChanges).toHaveBeenCalledWith('run_demo');
  });
});
