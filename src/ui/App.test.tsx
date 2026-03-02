import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { getLocalAgentBoardApi, resetLocalAgentBoardApi } from './mock/local-agent-board-api';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  resetLocalAgentBoardApi();
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

    await waitFor(() => {
      expect(window.location.search).toBe('?taskId=task_nav');
    });

    const taskCard = await screen.findByRole('button', { name: /refresh homepage hero copy/i });
    await user.click(taskCard);

    await waitFor(() => {
      expect(window.location.search).toBe('?taskId=task_landing');
    });

    await user.click(taskCard);

    await waitFor(() => {
      expect(window.location.search).toBe('?taskId=task_nav');
    });
  });
});
