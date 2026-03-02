import { describe, expect, it } from 'vitest';
import { parseBoardSnapshot } from './board-snapshot';

describe('board snapshot normalization', () => {
  it('normalizes legacy codex task and run fields into generic llm aliases', () => {
    const snapshot = parseBoardSnapshot(JSON.stringify({
      version: 1,
      repos: [],
      tasks: [
        {
          taskId: 'task_1',
          repoId: 'repo_1',
          title: 'Legacy task',
          taskPrompt: 'Do the thing',
          acceptanceCriteria: ['done'],
          context: { links: [] },
          status: 'READY',
          createdAt: '2026-03-02T00:00:00.000Z',
          updatedAt: '2026-03-02T00:00:00.000Z',
          uiMeta: {
            simulationProfile: 'happy_path',
            codexModel: 'gpt-5.3-codex',
            codexReasoningEffort: 'medium'
          }
        }
      ],
      runs: [
        {
          runId: 'run_1',
          taskId: 'task_1',
          repoId: 'repo_1',
          status: 'OPERATOR_CONTROLLED',
          branchName: 'agent/task_1/run_1',
          latestCodexResumeCommand: 'codex resume thread_123',
          operatorSession: {
            id: 'session_1',
            runId: 'run_1',
            sandboxId: 'run_1',
            sessionName: 'operator-run_1',
            startedAt: '2026-03-02T00:00:00.000Z',
            actorId: 'same-session',
            actorLabel: 'Operator',
            connectionState: 'open',
            takeoverState: 'resumable',
            codexThreadId: 'thread_123',
            codexResumeCommand: 'codex resume thread_123'
          },
          errors: [],
          startedAt: '2026-03-02T00:00:00.000Z',
          timeline: [],
          simulationProfile: 'happy_path',
          pendingEvents: []
        }
      ],
      logs: [],
      events: [],
      commands: [],
      ui: {
        selectedRepoId: 'all',
        seeded: false
      }
    }));

    expect(snapshot.tasks[0]?.uiMeta).toMatchObject({
      llmAdapter: 'codex',
      llmModel: 'gpt-5.3-codex',
      llmReasoningEffort: 'medium',
      codexModel: 'gpt-5.3-codex',
      codexReasoningEffort: 'medium'
    });
    expect(snapshot.runs[0]).toMatchObject({
      llmAdapter: 'codex',
      llmResumeCommand: 'codex resume thread_123',
      llmSessionId: 'thread_123',
      latestCodexResumeCommand: 'codex resume thread_123'
    });
    expect(snapshot.runs[0]?.operatorSession).toMatchObject({
      llmAdapter: 'codex',
      llmSessionId: 'thread_123',
      llmResumeCommand: 'codex resume thread_123',
      codexThreadId: 'thread_123',
      codexResumeCommand: 'codex resume thread_123'
    });
  });
});
