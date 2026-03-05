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
      llmSupportsResume: true,
      llmResumeCommand: 'codex resume thread_1',
      llmSessionId: 'thread_1',
      latestCodexResumeCommand: 'codex resume thread_1'
    });
    expect(run.operatorSession).toMatchObject({
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread_1',
      llmResumeCommand: 'codex resume thread_1'
    });
  });

  it('keeps non-resumable adapters truthful without fabricating resume commands', () => {
    const run = normalizeRunLlmState({
      runId: 'run_2',
      taskId: 'task_2',
      repoId: 'repo_2',
      status: 'RUNNING_CODEX',
      branchName: 'agent/task_2/run_2',
      llmAdapter: 'cursor_cli',
      errors: [],
      startedAt: '2026-03-02T00:00:00.000Z',
      timeline: [],
      simulationProfile: 'happy_path',
      pendingEvents: []
    });

    expect(run.llmSupportsResume).toBe(false);
    expect(run.llmResumeCommand).toBeUndefined();
    expect(run.latestCodexResumeCommand).toBeUndefined();
  });

  it('marks claude_code as non-resumable by default', () => {
    const run = normalizeRunLlmState({
      runId: 'run_3',
      taskId: 'task_3',
      repoId: 'repo_3',
      status: 'RUNNING_CODEX',
      branchName: 'agent/task_3/run_3',
      llmAdapter: 'claude_code',
      errors: [],
      startedAt: '2026-03-02T00:00:00.000Z',
      timeline: [],
      simulationProfile: 'happy_path',
      pendingEvents: []
    });

    expect(run.llmSupportsResume).toBe(false);
    expect(run.llmResumeCommand).toBeUndefined();
  });
});
