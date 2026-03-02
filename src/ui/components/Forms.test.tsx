import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoForm, TaskForm } from './Forms';

afterEach(() => {
  cleanup();
});

function queryLabeledControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(label: string, selector: 'input' | 'select' | 'textarea') {
  for (const node of screen.queryAllByText(label)) {
    const control = node.closest('label')?.querySelector(selector);
    if (control) {
      return control as T;
    }
  }
  return null;
}

function getInputField(label: string) {
  return queryLabeledControl<HTMLInputElement>(label, 'input');
}

function getSelectField(label: string) {
  return queryLabeledControl<HTMLSelectElement>(label, 'select');
}

function getTextareaField(label: string) {
  return queryLabeledControl<HTMLTextAreaElement>(label, 'textarea');
}

describe('RepoForm', () => {
  it('submits provider-neutral SCM repo fields', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<RepoForm onSubmit={onSubmit} />);

    const scmProviderField = getSelectField('SCM provider');
    const scmBaseUrlField = screen.getByDisplayValue('https://github.com');
    const projectPathField = getInputField('Project path');
    const baselineUrlField = getInputField('Baseline URL');
    const previewModeField = getSelectField('Preview mode');
    const evidenceModeField = getSelectField('Evidence mode');
    const previewAdapterField = getSelectField('Preview adapter');

    expect(scmProviderField).not.toBeNull();
    expect(scmBaseUrlField).not.toBeNull();
    expect(projectPathField).not.toBeNull();
    expect(baselineUrlField).not.toBeNull();
    expect(previewModeField).not.toBeNull();
    expect(evidenceModeField).not.toBeNull();
    expect(previewAdapterField).not.toBeNull();

    await user.selectOptions(scmProviderField! as unknown as Element, 'gitlab');
    await user.clear(scmBaseUrlField!);
    await user.type(scmBaseUrlField!, 'https://gitlab.example.com');
    await user.type(projectPathField!, 'group/platform/repo');
    await user.type(baselineUrlField!, 'https://repo.example.com');
    await user.selectOptions(previewModeField! as unknown as Element, 'auto');
    await user.selectOptions(evidenceModeField! as unknown as Element, 'skip');
    await user.selectOptions(previewAdapterField! as unknown as Element, 'cloudflare_checks');
    await user.type(getInputField('Check or pipeline name')!, 'Workers Builds: demo');

    await user.click(screen.getByRole('button', { name: 'Add repo' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'group/platform/repo',
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/platform/repo',
      llmAdapter: 'codex',
      previewMode: 'auto',
      evidenceMode: 'skip',
      previewAdapter: 'cloudflare_checks',
      previewConfig: {
        checkName: 'Workers Builds: demo'
      }
    }));
  });

  it('switches repo settings copy and defaults when GitLab is selected', async () => {
    const user = userEvent.setup();
    render(<RepoForm onSubmit={vi.fn()} />);

    expect(screen.getAllByText('GitHub base URL')).toHaveLength(1);
    expect(screen.getByPlaceholderText('owner/repo')).toBeInTheDocument();

    const scmProviderField = getSelectField('SCM provider');
    expect(scmProviderField).not.toBeNull();
    await user.selectOptions(scmProviderField! as unknown as Element, 'gitlab');

    expect(screen.getByText('GitLab base URL')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('group/subgroup/repo')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://gitlab.com')).toBeInTheDocument();
    expect(screen.getByText(/self-managed GitLab origin/i)).toBeInTheDocument();
  });

  it('switches preview fields when prompt recipe mode is selected', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<RepoForm onSubmit={onSubmit} />);

    await user.type(getInputField('Project path')!, 'abuiles/minions');
    await user.type(getInputField('Baseline URL')!, 'https://repo.example.com');
    await user.selectOptions(getSelectField('Preview adapter')! as unknown as Element, 'prompt_recipe');

    expect(getInputField('Check or pipeline name')).toBeNull();

    const promptRecipeField = getTextareaField('Prompt recipe');
    expect(promptRecipeField).not.toBeNull();
    await user.type(promptRecipeField!, 'Inspect deployment logs and return one preview URL.');
    await user.click(screen.getByRole('button', { name: 'Add repo' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      previewAdapter: 'prompt_recipe',
      previewConfig: {
        promptRecipe: 'Inspect deployment logs and return one preview URL.'
      }
    }));
  });

  it('disables adapter-specific preview config when preview is skipped', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<RepoForm onSubmit={onSubmit} />);

    await user.type(getInputField('Project path')!, 'abuiles/minions');
    await user.type(getInputField('Baseline URL')!, 'https://repo.example.com');
    await user.selectOptions(getSelectField('Preview mode')! as unknown as Element, 'skip');
    expect(getSelectField('Preview adapter')).toBeDisabled();
    expect(getInputField('Check or pipeline name')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add repo' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      previewMode: 'skip',
      previewAdapter: 'cloudflare_checks',
      previewConfig: undefined
    }));
  });
});

describe('TaskForm', () => {
  it('submits Stage 3.1 dependency and execution settings', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <TaskForm
        repos={[
          {
            repoId: 'repo_demo',
            slug: 'abuiles/minions-demo',
            defaultBranch: 'main',
            baselineUrl: 'https://minions-demo.abuiles.workers.dev/',
            enabled: true,
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-01T00:00:00.000Z'
          }
        ]}
        onSubmit={onSubmit}
      />
    );

    const acceptanceCriteriaField = screen.getByText('Acceptance criteria').closest('label')?.querySelector('textarea');
    const dependenciesField = screen.getByText('Dependencies').closest('label')?.querySelector('textarea');
    const llmAdapterField = screen.getByText('LLM adapter').closest('label')?.querySelector('select');
    const llmModelField = screen.getByText('LLM model').closest('label')?.querySelector('select');
    const reasoningEffortField = screen.getByText('Reasoning effort').closest('label')?.querySelector('select');
    expect(acceptanceCriteriaField).not.toBeNull();
    expect(dependenciesField).not.toBeNull();
    expect(llmAdapterField).not.toBeNull();
    expect(llmModelField).not.toBeNull();
    expect(reasoningEffortField).not.toBeNull();

    const sourceRefField = screen.getByText('Source ref').closest('label')?.querySelector('input');
    expect(sourceRefField).not.toBeNull();

    await user.type(screen.getByLabelText('Title'), 'Build snake game');
    await user.type(sourceRefField!, 'https://github.com/abuiles/minions-demo/pull/4');
    await user.type(screen.getByLabelText('Task prompt'), 'Create a simple snake game on the homepage.');
    await user.type(acceptanceCriteriaField!, 'A playable snake game appears on index.');
    await user.type(dependenciesField!, 'task_repo_123abc\ntask_repo_456def|primary');
    await user.click(screen.getByRole('checkbox'));
    await user.selectOptions(llmAdapterField! as unknown as Element, 'codex');
    await user.selectOptions(llmModelField! as unknown as Element, 'gpt-5.3-codex-spark');
    await user.selectOptions(reasoningEffortField! as unknown as Element, 'high');

    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      repoId: 'repo_demo',
      title: 'Build snake game',
      sourceRef: 'https://github.com/abuiles/minions-demo/pull/4',
      dependencies: [
        { upstreamTaskId: 'task_repo_123abc', mode: 'review_ready', primary: false },
        { upstreamTaskId: 'task_repo_456def', mode: 'review_ready', primary: true }
      ],
      automationState: {
        autoStartEligible: true
      },
      taskPrompt: 'Create a simple snake game on the homepage.',
      acceptanceCriteria: ['A playable snake game appears on index.'],
      llmAdapter: 'codex',
      llmModel: 'gpt-5.3-codex-spark',
      llmReasoningEffort: 'high',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });
  });
});
