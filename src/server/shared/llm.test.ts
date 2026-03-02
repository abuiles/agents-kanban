import { describe, expect, it } from 'vitest';
import { normalizeOperatorSession, normalizeRunLlmState, normalizeTaskUiMeta } from '../../shared/llm';

describe('llm compatibility normalization', () => {
  it('hydrates generic task llm fields from codex aliases', () => {
    expect(normalizeTaskUiMeta({
      simulationProfile: 'happy_path',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    })).toMatchObject({
      llmAdapter: 'codex',
      llmModel: 'gpt-5.3-codex-spark',
      llmReasoningEffort: 'high',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });
  });

  it('hydrates generic run and operator session fields from codex aliases', () => {
    const session = normalizeOperatorSession({
      id: 'session_1',
      runId: 'run_1',
      sandboxId: 'sandbox_1',
      sessionName: 'operator-run_1',
      startedAt: '2026-03-02T00:00:00.000Z',
      actorId: 'same-session',
      actorLabel: 'Operator',
      connectionState: 'open',
      takeoverState: 'resumable',
      codexThreadId: 'thread_1',
      codexResumeCommand: 'codex resume thread_1'
    });

    const run = normalizeRunLlmState({
      runId: 'run_1',
      taskId: 'task_1',
      repoId: 'repo_1',
      status: 'OPERATOR_CONTROLLED',
      branchName: 'agent/task_1/run_1',
      latestCodexResumeCommand: 'codex resume thread_1',
      operatorSession: session,
      errors: [],
      startedAt: '2026-03-02T00:00:00.000Z',
      timeline: [],
      simulationProfile: 'happy_path',
      pendingEvents: []
    });

    expect(run).toMatchObject({
      llmAdapter: 'codex',
      llmResumeCommand: 'codex resume thread_1',
      llmSessionId: 'thread_1',
      latestCodexResumeCommand: 'codex resume thread_1'
    });
    expect(run.operatorSession).toMatchObject({
      llmAdapter: 'codex',
      llmSessionId: 'thread_1',
      llmResumeCommand: 'codex resume thread_1'
    });
  });
});
