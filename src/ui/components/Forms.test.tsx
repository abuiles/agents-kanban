import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskForm } from './Forms';

describe('TaskForm', () => {
  it('submits the selected Codex model and reasoning effort', async () => {
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
    const codexModelField = screen.getByText('Codex model').closest('label')?.querySelector('select');
    const reasoningEffortField = screen.getByText('Reasoning effort').closest('label')?.querySelector('select');
    expect(acceptanceCriteriaField).not.toBeNull();
    expect(codexModelField).not.toBeNull();
    expect(reasoningEffortField).not.toBeNull();

    const sourceRefField = screen.getByText('Source ref').closest('label')?.querySelector('input');
    expect(sourceRefField).not.toBeNull();

    await user.type(screen.getByLabelText('Title'), 'Build snake game');
    await user.type(sourceRefField!, 'https://github.com/abuiles/minions-demo/pull/4');
    await user.type(screen.getByLabelText('Task prompt'), 'Create a simple snake game on the homepage.');
    await user.type(acceptanceCriteriaField!, 'A playable snake game appears on index.');
    await user.selectOptions(codexModelField! as unknown as Element, 'gpt-5.3-codex-spark');
    await user.selectOptions(reasoningEffortField! as unknown as Element, 'high');

    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      repoId: 'repo_demo',
      title: 'Build snake game',
      sourceRef: 'https://github.com/abuiles/minions-demo/pull/4',
      taskPrompt: 'Create a simple snake game on the homepage.',
      acceptanceCriteria: ['A playable snake game appears on index.'],
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });
  });
});
