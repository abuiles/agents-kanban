import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { getLocalAgentBoardApi, resetLocalAgentBoardApi } from './mock/local-agent-board-api';

beforeEach(() => {
  localStorage.clear();
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
});
