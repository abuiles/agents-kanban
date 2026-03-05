import { describe, expect, it } from 'vitest';
import {
  parseAcceptTenantInviteInput,
  parseAuthLoginInput,
  parseAuthSignupInput,
  parseCreateRepoInput,
  parseCreateTaskInput,
  parseCreateUserApiTokenInput,
  parseStartRepoSentinelInput,
  parseRetryRunInput,
  parseTakeOverRunInput,
  parseRequestRunChangesInput,
  parseUpdateRepoSentinelConfigInput,
  parseUpdateRepoInput,
  parseUpdateTaskInput,
  parseUpsertScmCredentialInput
} from './validation';

function createTaskPayload(overrides: Record<string, unknown> = {}) {
  return {
    repoId: 'repo_demo',
    title: 'Task title',
    taskPrompt: 'Do work',
    acceptanceCriteria: ['Criterion 1'],
    context: {
      links: [{ id: 'link_1', label: 'Stage doc', url: 'https://example.com' }]
    },
    ...overrides
  };
}

describe('task validation', () => {
  it('parses create payload with dependency fields', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        dependencies: [{ upstreamTaskId: 'task_upstream', mode: 'review_ready', primary: true }],
        dependencyState: {
          blocked: false,
          unblockedAt: '2026-03-02T01:05:00.000Z',
          reasons: [{ upstreamTaskId: 'task_upstream', state: 'ready', message: 'Upstream task is in review.' }]
        },
        automationState: {
          autoStartEligible: true,
          autoStartedAt: '2026-03-02T00:00:00.000Z',
          lastDependencyRefreshAt: '2026-03-02T01:00:00.000Z'
        },
        branchSource: {
          kind: 'dependency_review_head',
          upstreamTaskId: 'task_upstream',
          upstreamRunId: 'run_upstream',
          upstreamReviewUrl: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
          upstreamReviewNumber: 42,
          upstreamReviewProvider: 'gitlab',
          upstreamPrNumber: 42,
          upstreamHeadSha: 'abc123',
          resolvedRef: 'refs/heads/agent/task_upstream/run_upstream',
          resolvedAt: '2026-03-02T00:05:00.000Z'
        }
      })
    );

    expect(parsed.dependencies).toEqual([{ upstreamTaskId: 'task_upstream', mode: 'review_ready', primary: true }]);
    expect(parsed.dependencyState?.blocked).toBe(false);
    expect(parsed.dependencyState?.reasons[0]?.state).toBe('ready');
    expect(parsed.automationState?.autoStartEligible).toBe(true);
    expect(parsed.branchSource?.kind).toBe('dependency_review_head');
    expect(parsed.branchSource?.upstreamReviewProvider).toBe('gitlab');
  });

  it('parses and normalizes task tags for create and update payloads', () => {
    const created = parseCreateTaskInput(
      createTaskPayload({
        tags: [' p1 ', 'backend', 'p1', '']
      })
    );
    expect(created.tags).toEqual(['p1', 'backend']);

    const updated = parseUpdateTaskInput({
      tags: ['ops', ' ops ', 'infra']
    });
    expect(updated.tags).toEqual(['ops', 'infra']);
  });

  it('parses generic llm task fields and mirrors codex aliases', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex-spark',
        llmReasoningEffort: 'high'
      })
    );

    expect(parsed).toMatchObject({
      llmAdapter: 'codex',
      llmModel: 'gpt-5.3-codex-spark',
      llmReasoningEffort: 'high',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });
  });

  it('accepts gpt-5.4 and xhigh for codex task payloads', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        llmAdapter: 'codex',
        llmModel: 'gpt-5.4',
        llmReasoningEffort: 'xhigh'
      })
    );

    expect(parsed).toMatchObject({
      llmAdapter: 'codex',
      llmModel: 'gpt-5.4',
      llmReasoningEffort: 'xhigh',
      codexModel: 'gpt-5.4',
      codexReasoningEffort: 'xhigh'
    });
  });

  it('accepts codex compatibility fields without explicit llmAdapter', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        codexModel: 'gpt-5.3-codex-spark',
        codexReasoningEffort: 'high'
      })
    );

    expect(parsed).toMatchObject({
      llmAdapter: 'codex',
      llmModel: 'gpt-5.3-codex-spark',
      llmReasoningEffort: 'high'
    });
  });

  it('rejects create payload with multiple primary dependencies', () => {
    expect(() =>
      parseCreateTaskInput(
        createTaskPayload({
          dependencies: [
            { upstreamTaskId: 'task_a', mode: 'review_ready', primary: true },
            { upstreamTaskId: 'task_b', mode: 'review_ready', primary: true }
          ]
        })
      )
    ).toThrow('Invalid dependencies: only one primary dependency is allowed.');
  });

  it('rejects update payload with invalid dependency mode', () => {
    expect(() =>
      parseUpdateTaskInput({
        dependencies: [{ upstreamTaskId: 'task_a', mode: 'done_ready' }]
      })
    ).toThrow('Invalid dependencies[0].mode.');
  });

  it('rejects update payload with invalid automationState shape', () => {
    expect(() =>
      parseUpdateTaskInput({
        automationState: { autoStartEligible: 'yes' }
      })
    ).toThrow('Invalid automationState.autoStartEligible.');
  });

  it('rejects update payload with invalid dependencyState shape', () => {
    expect(() =>
      parseUpdateTaskInput({
        dependencyState: { blocked: 'yes', reasons: [] }
      })
    ).toThrow('Invalid dependencyState.blocked.');
  });

  it('rejects update payload with invalid branchSource fields', () => {
    expect(() =>
      parseUpdateTaskInput({
        branchSource: {
          kind: 'dependency_review_head',
          upstreamReviewNumber: 0,
          resolvedRef: 'refs/heads/demo',
          resolvedAt: '2026-03-02T00:00:00.000Z'
        }
      })
    ).toThrow('Invalid branchSource.upstreamReviewNumber.');
  });

  it('rejects mismatched llm and codex compatibility fields', () => {
    expect(() =>
      parseUpdateTaskInput({
        llmModel: 'gpt-5.3-codex',
        codexModel: 'gpt-5.3-codex-spark'
      })
    ).toThrow('Invalid LLM payload: llmModel and codexModel must match when both are provided.');
  });

  it('rejects codex compatibility fields for non-codex adapters', () => {
    expect(() =>
      parseUpdateTaskInput({
        llmAdapter: 'cursor_cli',
        codexModel: 'gpt-5.3-codex'
      })
    ).toThrow('Invalid LLM payload: codex compatibility fields require llmAdapter "codex".');
  });

  it('rejects xhigh for non-codex task adapters', () => {
    expect(() =>
      parseUpdateTaskInput({
        llmAdapter: 'cursor_cli',
        llmReasoningEffort: 'xhigh'
      })
    ).toThrow('Invalid llmReasoningEffort.');
  });

  it('defaults task auto-review mode to inherit for create payloads', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload()
    );

    expect(parsed.autoReviewMode).toBe('inherit');
    expect(parsed.autoReviewPrompt).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
  });

  it('parses task auto-review overrides', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        autoReviewMode: 'on',
        autoReviewPrompt: 'Keep reviews tight'
      })
    );

    expect(parsed.autoReviewMode).toBe('on');
    expect(parsed.autoReviewPrompt).toBe('Keep reviews tight');
  });

  it('rejects invalid task auto-review mode', () => {
    expect(() =>
      parseCreateTaskInput(
        createTaskPayload({
          autoReviewMode: 'sometimes'
        })
      )
    ).toThrow('Invalid autoReviewMode.');
  });
});

describe('repo validation', () => {
  it('parses preview and evidence execution policy fields', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      previewMode: 'skip',
      evidenceMode: 'skip',
      previewProvider: 'cloudflare'
    });

    expect(parsed.previewMode).toBe('skip');
    expect(parsed.evidenceMode).toBe('skip');
    expect(parsed.previewProvider).toBe('cloudflare');
  });

  it('parses generic preview adapter fields and mirrors legacy check name', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      previewAdapter: 'cloudflare_checks',
      previewConfig: {
        checkName: 'Workers Builds: minions'
      }
    });

    expect(parsed.previewAdapter).toBe('cloudflare_checks');
    expect(parsed.previewProvider).toBe('cloudflare');
    expect(parsed.previewCheckName).toBe('Workers Builds: minions');
    expect(parsed.previewConfig?.checkName).toBe('Workers Builds: minions');
  });

  it('parses prompt recipe preview adapter payloads', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      previewAdapter: 'prompt_recipe',
      previewConfig: {
        promptRecipe: 'Read CI logs and return one preview URL.'
      }
    });

    expect(parsed.previewAdapter).toBe('prompt_recipe');
    expect(parsed.previewProvider).toBeUndefined();
    expect(parsed.previewConfig).toEqual({ promptRecipe: 'Read CI logs and return one preview URL.' });
  });

  it('maps legacy preview fields to the new preview config shape', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      previewProvider: 'cloudflare',
      previewCheckName: 'Workers Builds: minions'
    });

    expect(parsed.previewAdapter).toBe('cloudflare_checks');
    expect(parsed.previewConfig).toEqual({ checkName: 'Workers Builds: minions' });
  });

  it('defaults autoReview on payload omission', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com'
    });

    expect(parsed.autoReview).toEqual({
      enabled: false,
      provider: 'gitlab',
      postInline: false,
      postingMode: 'platform'
    });
    expect(parsed.sentinelConfig).toEqual({});
    expect(parsed.checkpointConfig).toEqual({});
  });

  it('parses nested checkpoint config updates', () => {
    const parsed = parseUpdateRepoInput({
      checkpointConfig: {
        enabled: false,
        triggerMode: 'phase_boundary',
        contextNotes: {
          enabled: true,
          filePath: '.agentskanban/context/run-context.md',
          cleanupBeforeReview: false
        },
        reviewPrep: {
          squashBeforeFirstReviewOpen: true,
          rewriteOnChangeRequestRerun: false
        }
      }
    });

    expect(parsed.checkpointConfig).toEqual({
      enabled: false,
      triggerMode: 'phase_boundary',
      contextNotes: {
        enabled: true,
        filePath: '.agentskanban/context/run-context.md',
        cleanupBeforeReview: false
      },
      reviewPrep: {
        squashBeforeFirstReviewOpen: true,
        rewriteOnChangeRequestRerun: false
      }
    });
  });

  it('rejects invalid checkpoint trigger modes', () => {
    expect(() =>
      parseUpdateRepoInput({
        checkpointConfig: {
          triggerMode: 'manual'
        }
      })
    ).toThrow('Invalid checkpointConfig.triggerMode.');
  });

  it('rejects invalid checkpoint context notes payloads', () => {
    expect(() =>
      parseCreateRepoInput({
        slug: 'abuiles/minions',
        baselineUrl: 'https://example.com',
        checkpointConfig: {
          contextNotes: 'invalid'
        }
      })
    ).toThrow('Invalid checkpointConfig.contextNotes.');
  });

  it('parses nested sentinel config updates', () => {
    const parsed = parseUpdateRepoInput({
      sentinelConfig: {
        enabled: true,
        globalMode: true,
        defaultGroupTag: 'p1',
        reviewGate: {
          requireChecksGreen: false
        },
        mergePolicy: {
          autoMergeEnabled: true,
          method: 'rebase',
          deleteBranch: false
        },
        conflictPolicy: {
          remediationEnabled: true,
          rebaseBeforeMerge: true,
          maxAttempts: 3
        }
      }
    });

    expect(parsed.sentinelConfig).toEqual({
      enabled: true,
      globalMode: true,
      defaultGroupTag: 'p1',
      reviewGate: { requireChecksGreen: false },
      mergePolicy: { autoMergeEnabled: true, method: 'rebase', deleteBranch: false },
      conflictPolicy: { remediationEnabled: true, rebaseBeforeMerge: true, maxAttempts: 3 }
    });
  });

  it('rejects invalid sentinel merge policy methods', () => {
    expect(() =>
      parseUpdateRepoInput({
        sentinelConfig: {
          mergePolicy: {
            method: 'fast-forward'
          }
        }
      })
    ).toThrow('Invalid sentinelConfig.mergePolicy.method.');
  });

  it('parses repo sentinel config patch payloads', () => {
    expect(parseUpdateRepoSentinelConfigInput({
      enabled: true,
      conflictPolicy: {
        maxAttempts: 4
      }
    })).toEqual({
      enabled: true,
      conflictPolicy: {
        maxAttempts: 4
      }
    });
  });

  it('rejects invalid sentinel config patch payloads', () => {
    expect(() => parseUpdateRepoSentinelConfigInput('invalid')).toThrow('Invalid sentinel config patch payload.');
  });

  it('parses sentinel start payloads', () => {
    expect(parseStartRepoSentinelInput({
      scopeType: 'group',
      scopeValue: 'payments'
    })).toEqual({
      scopeType: 'group',
      scopeValue: 'payments'
    });
  });

  it('rejects invalid sentinel start payload scope types', () => {
    expect(() => parseStartRepoSentinelInput({ scopeType: 'team' })).toThrow('Invalid scopeType.');
  });

  it('defaults repo auto-review provider and includes prompt when enabled', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      autoReview: {
        enabled: true,
        postInline: true,
        prompt: 'Check all security findings first.'
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'gitlab',
      postInline: true,
      prompt: 'Check all security findings first.',
      postingMode: 'platform'
    });
  });

  it('accepts github as an explicit repo auto-review provider', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      autoReview: {
        enabled: true,
        provider: 'github',
        postInline: true
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'github',
      postInline: true,
      postingMode: 'platform'
    });
  });

  it('parses repo auto-review llm settings with codex compatibility fields', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      autoReview: {
        enabled: true,
        provider: 'github',
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex-spark',
        llmReasoningEffort: 'high',
        codexModel: 'gpt-5.3-codex-spark',
        codexReasoningEffort: 'high'
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'github',
      postInline: false,
      postingMode: 'platform',
      llmAdapter: 'codex',
      llmModel: 'gpt-5.3-codex-spark',
      llmReasoningEffort: 'high',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });
  });

  it('accepts gpt-5.4 and xhigh for codex repo auto-review settings', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      autoReview: {
        enabled: true,
        provider: 'github',
        llmAdapter: 'codex',
        llmModel: 'gpt-5.4',
        llmReasoningEffort: 'xhigh',
        codexModel: 'gpt-5.4',
        codexReasoningEffort: 'xhigh'
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'github',
      postInline: false,
      postingMode: 'platform',
      llmAdapter: 'codex',
      llmModel: 'gpt-5.4',
      llmReasoningEffort: 'xhigh',
      codexModel: 'gpt-5.4',
      codexReasoningEffort: 'xhigh'
    });
  });

  it('rejects xhigh for non-codex repo auto-review adapters', () => {
    expect(() =>
      parseCreateRepoInput({
        slug: 'abuiles/minions',
        baselineUrl: 'https://example.com',
        autoReview: {
          enabled: true,
          llmAdapter: 'cursor_cli',
          llmReasoningEffort: 'xhigh'
        }
      })
    ).toThrow('Invalid autoReview.llmReasoningEffort.');
  });

  it('rejects mismatched repo auto-review llm and codex model values', () => {
    expect(() =>
      parseCreateRepoInput({
        slug: 'abuiles/minions',
        baselineUrl: 'https://example.com',
        autoReview: {
          enabled: true,
          llmAdapter: 'codex',
          llmModel: 'gpt-5.1-codex-mini',
          codexModel: 'gpt-5.3-codex'
        }
      })
    ).toThrow('Invalid autoReview: llmModel and codexModel must match when both are provided.');
  });

  it('defaults enabled auto-review provider to github for github repos', () => {
    const parsed = parseCreateRepoInput({
      scmProvider: 'github',
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      autoReview: {
        enabled: true,
        postInline: false
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'github',
      postInline: false,
      postingMode: 'platform'
    });
  });

  it('defaults enabled auto-review provider to gitlab for gitlab repos', () => {
    const parsed = parseCreateRepoInput({
      scmProvider: 'gitlab',
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      autoReview: {
        enabled: true,
        postInline: false
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'gitlab',
      postInline: false,
      postingMode: 'platform'
    });
  });

  it('defaults update auto-review provider when enabled and scmProvider are provided', () => {
    const parsed = parseUpdateRepoInput({
      scmProvider: 'github',
      autoReview: {
        enabled: true
      }
    });

    expect(parsed.autoReview).toEqual({
      enabled: true,
      provider: 'github'
    });
  });

  it('parses partial repo auto-review update patches without injecting create defaults', () => {
    const parsed = parseUpdateRepoInput({
      autoReview: {
        postInline: true
      }
    });

    expect(parsed.autoReview).toEqual({
      postInline: true
    });
  });

  it('rejects invalid repo execution policy values', () => {
    expect(() =>
      parseUpdateRepoInput({
        previewMode: 'sometimes'
      })
    ).toThrow('Invalid previewMode.');
  });

  it('rejects incompatible legacy and new preview adapter payloads', () => {
    expect(() =>
      parseCreateRepoInput({
        slug: 'abuiles/minions',
        baselineUrl: 'https://example.com',
        previewProvider: 'cloudflare',
        previewAdapter: 'prompt_recipe'
      })
    ).toThrow('Invalid preview payload: previewProvider "cloudflare" requires previewAdapter "cloudflare_checks".');
  });

  it('rejects prompt recipe adapters without a prompt recipe', () => {
    expect(() =>
      parseCreateRepoInput({
        slug: 'abuiles/minions',
        baselineUrl: 'https://example.com',
        previewAdapter: 'prompt_recipe'
      })
    ).toThrow('Invalid preview payload: previewAdapter "prompt_recipe" requires previewConfig.promptRecipe.');
  });

  it('parses provider-neutral repo payloads and keeps slug compatibility', () => {
    const parsed = parseCreateRepoInput({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/platform/repo',
      llmAdapter: 'cursor_cli',
      llmProfileId: 'cursor-default',
      baselineUrl: 'https://repo.example.com'
    });

    expect(parsed).toMatchObject({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/platform/repo',
      slug: 'group/platform/repo',
      llmAdapter: 'cursor_cli',
      llmProfileId: 'cursor-default'
    });
  });

  it('accepts claude_code as a repo llm adapter', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      llmAdapter: 'claude_code',
      llmProfileId: 'claude-default'
    });

    expect(parsed).toMatchObject({
      llmAdapter: 'claude_code',
      llmProfileId: 'claude-default'
    });
  });

  it('parses commit policy config for repo settings', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      commitConfig: {
        messageTemplate: 'feat(cp): {taskTitle} [{taskId}]',
        messageRegex: '^feat\\(cp\\): .+ \\[task_[a-z0-9_]+\\]$',
        messageExamples: ['feat(cp): Add banner support [task_abc123]']
      }
    });

    expect(parsed.commitConfig).toEqual({
      messageTemplate: 'feat(cp): {taskTitle} [{taskId}]',
      messageRegex: '^feat\\(cp\\): .+ \\[task_[a-z0-9_]+\\]$',
      messageExamples: ['feat(cp): Add banner support [task_abc123]']
    });
  });

  it('rejects invalid commit policy regex values', () => {
    expect(() =>
      parseCreateRepoInput({
        slug: 'abuiles/minions',
        baselineUrl: 'https://example.com',
        commitConfig: {
          messageRegex: '[unclosed'
        }
      })
    ).toThrow('Invalid commitConfig.messageRegex.');
  });

  it('accepts legacy GitHub slug-only payloads', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://minions.example.com'
    });

    expect(parsed.slug).toBe('abuiles/minions');
    expect(parsed.projectPath).toBe('abuiles/minions');
    expect(parsed.scmProvider).toBeUndefined();
  });

  it('rejects mismatched slug and projectPath values', () => {
    expect(() =>
      parseUpdateRepoInput({
        slug: 'acme/one',
        projectPath: 'acme/two'
      })
    ).toThrow('Invalid repo patch payload: slug and projectPath must match when both are provided.');
  });

  it('mirrors legacy slug-only repo patch payloads into projectPath', () => {
    expect(parseUpdateRepoInput({
      slug: 'acme/renamed'
    })).toMatchObject({
      slug: 'acme/renamed',
      projectPath: 'acme/renamed'
    });
  });

  it('accepts generic llm auth bundle key and mirrors codex compatibility alias', () => {
    expect(parseCreateRepoInput({
      slug: 'acme/renamed',
      baselineUrl: 'https://example.com',
      llmAuthBundleR2Key: 'auth/llm.tgz'
    })).toMatchObject({
      llmAuthBundleR2Key: 'auth/llm.tgz',
      codexAuthBundleR2Key: 'auth/llm.tgz'
    });
  });
});

describe('request run validation', () => {
  it('accepts legacy payloads containing only prompt', () => {
    const parsed = parseRequestRunChangesInput({
      prompt: 'Please rerun with extra test coverage.'
    });

    expect(parsed).toEqual({
      prompt: 'Please rerun with extra test coverage.',
      reviewSelection: undefined
    });
  });

  it('parses request selection payloads with include mode', () => {
    const parsed = parseRequestRunChangesInput({
      prompt: 'Please rerun with extra test coverage.',
      reviewSelection: {
        mode: 'include',
        findingIds: ['f1', 'f2'],
        instruction: 'Focus on these failures.',
        includeReplies: true
      }
    });

    expect(parsed.reviewSelection).toEqual({
      mode: 'include',
      findingIds: ['f1', 'f2'],
      instruction: 'Focus on these failures.',
      includeReplies: true
    });
  });

  it('accepts freeform and exclude selection payloads', () => {
    const exclude = parseRequestRunChangesInput({
      prompt: 'Adjust only the highest priority finding.',
      reviewSelection: {
        mode: 'exclude',
        findingIds: ['f2'],
        includeReplies: false
      }
    });
    expect(exclude.reviewSelection).toMatchObject({
      mode: 'exclude',
      findingIds: ['f2'],
      includeReplies: false
    });

    const freeform = parseRequestRunChangesInput({
      prompt: 'Please ignore non-blockers and focus on accessibility.',
      reviewSelection: {
        mode: 'freeform',
        instruction: 'Address accessibility blockers first.'
      }
    });
    expect(freeform.reviewSelection).toEqual({
      mode: 'freeform',
      instruction: 'Address accessibility blockers first.'
    });
  });

  it('defaults retry payload to latest-checkpoint mode when empty', () => {
    expect(parseRetryRunInput({})).toEqual({ recoveryMode: 'latest_checkpoint' });
  });

  it('parses retry payload with explicit checkpoint recovery', () => {
    expect(parseRetryRunInput({
      recoveryMode: 'latest_checkpoint',
      checkpointId: 'run_1:cp:002:codex'
    })).toEqual({
      recoveryMode: 'latest_checkpoint',
      checkpointId: 'run_1:cp:002:codex'
    });
  });

  it('rejects checkpointId with fresh recovery mode', () => {
    expect(() =>
      parseRetryRunInput({
        recoveryMode: 'fresh',
        checkpointId: 'run_1:cp:002:codex'
      })
    ).toThrow('checkpointId cannot be provided when recoveryMode is fresh.');
  });

  it('parses takeover payload sandbox role when provided', () => {
    expect(parseTakeOverRunInput({ sandboxRole: 'review' })).toEqual({ sandboxRole: 'review' });
    expect(parseTakeOverRunInput({})).toEqual({});
  });

  it('rejects invalid takeover sandbox role', () => {
    expect(() =>
      parseTakeOverRunInput({ sandboxRole: 'preview' })
    ).toThrow('Invalid sandboxRole.');
  });
});

describe('SCM credential validation', () => {
  it('parses provider credential payloads', () => {
    expect(parseUpsertScmCredentialInput({
      scmProvider: 'github',
      host: 'github.com',
      token: 'secret-token',
      label: 'Default GitHub'
    })).toMatchObject({
      scmProvider: 'github',
      host: 'github.com',
      token: 'secret-token',
      label: 'Default GitHub'
    });
  });

  it('rejects unknown providers', () => {
    expect(() =>
      parseUpsertScmCredentialInput({
        scmProvider: 'bitbucket',
        host: 'example.com',
        token: 'secret-token'
      })
    ).toThrow('Invalid scmProvider.');
  });
});

describe('auth and token validation', () => {
  it('preserves password whitespace for signup/login/invite acceptance', () => {
    expect(parseAuthSignupInput({
      email: 'owner@example.com',
      password: '  pass with spaces  ',
      tenantName: 'Local'
    }).password).toBe('  pass with spaces  ');

    expect(parseAuthLoginInput({
      email: 'owner@example.com',
      password: '  pass with spaces  '
    }).password).toBe('  pass with spaces  ');

    expect(parseAcceptTenantInviteInput({
      token: 'invite_token',
      password: '  invited secret  '
    }).password).toBe('  invited secret  ');
  });

  it('rejects empty invite token values', () => {
    expect(() =>
      parseAcceptTenantInviteInput({
        token: '',
        password: 'secret'
      })
    ).toThrow('Invalid token.');
  });

  it('normalizes API token expiration timestamps and rejects invalid values', () => {
    expect(parseCreateUserApiTokenInput({
      name: 'CI token',
      expiresAt: '2026-03-02T00:00:00Z'
    }).expiresAt).toBe('2026-03-02T00:00:00.000Z');

    expect(() =>
      parseCreateUserApiTokenInput({
        name: 'CI token',
        expiresAt: 'not-a-date'
      })
    ).toThrow('Invalid expiresAt.');
  });
});
