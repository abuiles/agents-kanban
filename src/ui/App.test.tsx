import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { getLocalAgentBoardApi, resetLocalAgentBoardApi } from './mock/local-agent-board-api';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  resetLocalAgentBoardApi();
});

afterEach(() => {
  cleanup();
});

describe('App', () => {
  it('renders seeded board content', async () => {
    render(<App api={getLocalAgentBoardApi()} />);
    expect(await screen.findByRole('heading', { name: 'AgentBoard' })).toBeInTheDocument();
    expect(await screen.findByText('Refresh homepage hero copy')).toBeInTheDocument();
    expect(await screen.findAllByText('Fix settings navigation overflow')).toHaveLength(2);
  });

  it('toggles the inspector when clicking the selected card again', async () => {
    const user = userEvent.setup();
    render(<App api={getLocalAgentBoardApi()} />);

    const [taskCard] = await screen.findAllByRole('button', { name: /fix settings navigation overflow/i });
    expect(screen.queryByRole('heading', { name: 'Select a task' })).not.toBeInTheDocument();

    await user.click(taskCard);

    expect(screen.getByRole('heading', { name: 'Select a task' })).toBeInTheDocument();

    await user.click(taskCard);

    expect(screen.queryByRole('heading', { name: 'Select a task' })).not.toBeInTheDocument();
  });

  it('updates repo details from the edit repo modal', async () => {
    const user = userEvent.setup();
    const api = getLocalAgentBoardApi();
    render(<App api={api} />);

    const [repoFilter] = await screen.findAllByLabelText(/repo filter/i);
    await user.selectOptions(repoFilter, 'repo_website');
    await waitFor(() => {
      expect(repoFilter).toHaveValue('repo_website');
    });
    await user.click(screen.getByRole('button', { name: 'Edit repo' }));

    const baselineUrlInput = screen.getByLabelText(/baseline url/i);
    await user.clear(baselineUrlInput);
    await user.type(baselineUrlInput, 'https://marketing-updated.acme.test');

    await user.click(screen.getByRole('button', { name: 'Save repo' }));

    await waitFor(() => {
      expect(api.getSnapshot().repos.find((repo) => repo.repoId === 'repo_website')?.baselineUrl).toBe('https://marketing-updated.acme.test');
    });
    expect(await screen.findByText('Updated acme/site-marketing.')).toBeInTheDocument();
  });

  it('opens the task from the URL on load', async () => {
    window.history.replaceState({}, '', '/?taskId=task_kpi');
    localStorage.setItem('agentboard.ui-preferences.v1', JSON.stringify({ selectedRepoId: 'all', selectedTaskId: 'task_nav' }));

    render(<App api={getLocalAgentBoardApi()} />);

    expect(await screen.findByRole('heading', { name: 'Add funnel KPI definitions' })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.search).toBe('?taskId=task_kpi');
    });
  });

  it('syncs the URL when selecting and deselecting a task', async () => {
    const user = userEvent.setup();
    render(<App api={getLocalAgentBoardApi()} />);

    const taskCard = (await screen.findAllByRole('button', { name: /refresh homepage hero copy/i }))[0];
    await user.click(taskCard);

    await waitFor(() => {
      expect(window.location.search).toBe('?taskId=task_landing');
    });

    await user.click(taskCard);

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
  });

  it('edits the selected task from the inspector', async () => {
    const user = userEvent.setup();
    const api = getLocalAgentBoardApi();

    render(<App api={api} />);

    await user.click(await screen.findByRole('button', { name: /refresh homepage hero copy/i }));
    await user.click(screen.getByRole('button', { name: 'Edit task' }));

    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Refresh hero with stronger copy');
    await user.click(screen.getByRole('button', { name: 'Save task' }));

    await waitFor(() => {
      expect(api.getSnapshot().tasks.find((task) => task.taskId === 'task_landing')?.title).toBe('Refresh hero with stronger copy');
    });
    expect(await screen.findByText('Updated Refresh homepage hero copy.')).toBeInTheDocument();
  });

  it('requests changes from a review task and starts a rerun on the same PR branch', async () => {
    const user = userEvent.setup();
    const api = getLocalAgentBoardApi();
    const previousRun = api.getSnapshot().runs.find((run) => run.runId === 'run_nav_1');

    render(<App api={api} />);

    await screen.findByRole('heading', { name: 'Fix settings navigation overflow' });
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.type(
      await screen.findByPlaceholderText('Describe the changes you want on the current PR.'),
      'Tighten the spacing and update the review copy.'
    );
    await user.click(screen.getByRole('button', { name: 'Start review rerun' }));

    await waitFor(() => {
      const task = api.getSnapshot().tasks.find((candidate) => candidate.taskId === 'task_nav');
      expect(task?.status).toBe('ACTIVE');
      const latestRun = api.getSnapshot().runs
        .filter((run) => run.taskId === 'task_nav')
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      expect(latestRun.baseRunId).toBe('run_nav_1');
      expect(latestRun.branchName).toBe('agent/task_nav/run_nav_1');
      expect(latestRun.changeRequest?.prompt).toContain('Tighten the spacing');
      expect(latestRun.prUrl).toBe(previousRun?.prUrl);
    });

    expect(await screen.findByText('Started a review rerun on the existing PR branch.')).toBeInTheDocument();
  });

  it('opens the terminal in a modal with the live stream panel', async () => {
    const user = userEvent.setup();

    render(<App api={getLocalAgentBoardApi()} />);

    await screen.findByRole('heading', { name: 'Fix settings navigation overflow' });
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    expect(await screen.findByRole('heading', { name: /Live terminal/i })).toBeInTheDocument();
    expect(screen.getByText('Live Codex stream')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Take over' }).length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});
