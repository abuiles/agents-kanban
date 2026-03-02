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

function queryLabeledControl<T extends HTMLSelectElement | HTMLTextAreaElement>(label: string, selector: 'select' | 'textarea') {
  for (const node of screen.queryAllByText(label)) {
    const control = node.closest('label')?.querySelector(selector);
    if (control) {
      return control as T;
    }
  }
  return null;
}

function getSelectField(label: string) {
  return queryLabeledControl<HTMLSelectElement>(label, 'select');
}

function getTextareaField(label: string) {
  return queryLabeledControl<HTMLTextAreaElement>(label, 'textarea');
}

describe('App', () => {
  it('renders seeded board content', async () => {
    render(<App api={getLocalAgentBoardApi()} />);
    expect(await screen.findByRole('heading', { name: 'AgentsKanban' })).toBeInTheDocument();
    expect(await screen.findByText('Refresh homepage hero copy')).toBeInTheDocument();
    expect(await screen.findAllByText('Fix settings navigation overflow')).toHaveLength(2);
  });

  it('shows and hides the inspector only when a task is selected', async () => {
    const user = userEvent.setup();
    render(<App api={getLocalAgentBoardApi()} />);

    const [taskCard] = await screen.findAllByRole('button', { name: /fix settings navigation overflow/i });
    await user.click(taskCard);

    expect(screen.queryByRole('heading', { name: 'Fix settings navigation overflow' })).not.toBeInTheDocument();
    expect(screen.queryByText('Inspector')).not.toBeInTheDocument();
    expect(screen.queryByText('Select a task')).not.toBeInTheDocument();

    await user.click(taskCard);

    expect(screen.getByRole('heading', { name: 'Fix settings navigation overflow' })).toBeInTheDocument();
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

  it('updates repo preview adapter settings from the edit repo modal', async () => {
    const user = userEvent.setup();
    const api = getLocalAgentBoardApi();
    render(<App api={api} />);

    const [repoFilter] = await screen.findAllByLabelText(/repo filter/i);
    await user.selectOptions(repoFilter, 'repo_website');
    await waitFor(() => {
      expect(repoFilter).toHaveValue('repo_website');
    });
    await user.click(screen.getByRole('button', { name: 'Edit repo' }));

    await user.selectOptions(getSelectField('Preview adapter')! as unknown as Element, 'prompt_recipe');
    await user.type(getTextareaField('Prompt recipe')!, 'Inspect CI output and return one preview URL.');
    await user.selectOptions(getSelectField('Evidence mode')! as unknown as Element, 'skip');
    await user.click(screen.getByRole('button', { name: 'Save repo' }));

    await waitFor(() => {
      const repo = api.getSnapshot().repos.find((candidate) => candidate.repoId === 'repo_website');
      expect(repo?.previewAdapter).toBe('prompt_recipe');
      expect(repo?.previewConfig).toEqual({ promptRecipe: 'Inspect CI output and return one preview URL.' });
      expect(repo?.previewProvider).toBeUndefined();
      expect(repo?.evidenceMode).toBe('skip');
    });
    expect(await screen.findByText('Updated acme/site-marketing.')).toBeInTheDocument();
  });

  it('edits repo SCM settings for a GitLab project without falling back to GitHub defaults', async () => {
    const user = userEvent.setup();
    const api = getLocalAgentBoardApi();
    const gitlabRepo = await api.createRepo({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/platform/demo',
      baselineUrl: 'https://demo.example.com'
    });

    render(<App api={api} />);

    const [repoFilter] = await screen.findAllByLabelText(/repo filter/i);
    await user.selectOptions(repoFilter, gitlabRepo.repoId);
    await waitFor(() => {
      expect(repoFilter).toHaveValue(gitlabRepo.repoId);
    });
    await user.click(screen.getByRole('button', { name: 'Edit repo' }));

    expect(screen.getByText('GitLab base URL')).toBeInTheDocument();
    const projectPathInput = screen.getByPlaceholderText('group/subgroup/repo');
    await user.clear(projectPathInput);
    await user.type(projectPathInput, 'group/platform/renamed');

    await user.click(screen.getByRole('button', { name: 'Save repo' }));

    await waitFor(() => {
      const repo = api.getSnapshot().repos.find((candidate) => candidate.repoId === gitlabRepo.repoId);
      expect(repo?.scmProvider).toBe('gitlab');
      expect(repo?.scmBaseUrl).toBe('https://gitlab.example.com');
      expect(repo?.projectPath).toBe('group/platform/renamed');
      expect(repo?.slug).toBe('group/platform/renamed');
    });
    expect(await screen.findByText('Updated group/platform/renamed.')).toBeInTheDocument();
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

  it('requests changes from a review task and starts a rerun on the same review branch', async () => {
    const user = userEvent.setup();
    const api = getLocalAgentBoardApi();
    const previousRun = api.getSnapshot().runs.find((run) => run.runId === 'run_nav_1');

    render(<App api={api} />);

    await screen.findByRole('heading', { name: 'Fix settings navigation overflow' });
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.type(
      await screen.findByPlaceholderText('Describe the changes you want on the current review.'),
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

    expect(await screen.findByText('Started a review rerun on the existing review branch.')).toBeInTheDocument();
  });

  it('opens the terminal in a modal with the live stream panel', async () => {
    const user = userEvent.setup();

    render(<App api={getLocalAgentBoardApi()} />);

    await screen.findByRole('heading', { name: 'Fix settings navigation overflow' });
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    expect(await screen.findByRole('heading', { name: /Live terminal/i })).toBeInTheDocument();
    expect(screen.getByText('Live executor stream')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Take over' }).length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});
