import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Stage 3.5 SCM foundation', () => {
  it('defaults legacy GitHub repo payloads to provider-neutral SCM fields', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'abuiles/minions',
      baselineUrl: 'https://minions.example.com',
      defaultBranch: 'main'
    });

    expect(repo).toMatchObject({
      tenantId: 'tenant_legacy',
      slug: 'abuiles/minions',
      projectPath: 'abuiles/minions',
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com'
    });
  });

  it('backfills tenant ownership on task/run/event/command records for legacy payloads', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/tenant-migration',
      baselineUrl: 'https://tenant-migration.example.com'
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const task = await repoBoard.createTask({
      repoId: repo.repoId,
      title: 'Tenant migration',
      taskPrompt: 'Backfill tenant ownership.',
      acceptanceCriteria: ['ownership defaults are applied'],
      context: { links: [] },
      status: 'READY'
    });
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.appendRunEvents(run.runId, [{
      id: `${run.runId}_tenant_event`,
      runId: run.runId,
      repoId: run.repoId,
      taskId: run.taskId,
      at: new Date().toISOString(),
      actorType: 'system',
      eventType: 'run.status_changed',
      message: 'Tenant migration event.'
    }]);
    await repoBoard.upsertRunCommands(run.runId, [{
      id: `${run.runId}_tenant_command`,
      runId: run.runId,
      phase: 'codex',
      startedAt: new Date().toISOString(),
      command: 'echo tenant',
      status: 'running',
      source: 'system'
    }]);

    const [storedRun, events, commands] = await Promise.all([
      repoBoard.getRun(run.runId),
      repoBoard.getRunEvents(run.runId),
      repoBoard.getRunCommands(run.runId)
    ]);

    expect(repo.tenantId).toBe('tenant_legacy');
    expect(task.tenantId).toBe('tenant_legacy');
    expect(storedRun.tenantId).toBe('tenant_legacy');
    expect(events.every((event) => event.tenantId === 'tenant_legacy')).toBe(true);
    expect(commands.every((command) => command.tenantId === 'tenant_legacy')).toBe(true);
  });

  it('stores provider credentials by provider and host without attaching tokens to repos', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');

    const credential = await board.upsertScmCredential({
      scmProvider: 'github',
      host: 'github.example.com',
      label: 'GitHub Enterprise',
      token: 'ghp_secret'
    });

    expect(credential).toMatchObject({
      scmProvider: 'github',
      host: 'github.example.com',
      label: 'GitHub Enterprise',
      hasSecret: true
    });
    expect(Object.prototype.hasOwnProperty.call(credential, 'token')).toBe(false);

    const listed = await board.listScmCredentials();
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credentialId: 'github:github.example.com',
          scmProvider: 'github',
          host: 'github.example.com'
        })
      ])
    );

    expect(await board.getScmCredentialSecret('github', 'github.example.com')).toBe('ghp_secret');
  });

  it('updates repo projectPath while preserving the legacy slug alias', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/original',
      baselineUrl: 'https://original.example.com'
    });

    const updated = await board.updateRepo(repo.repoId, {
      projectPath: 'acme/renamed'
    });

    expect(updated.projectPath).toBe('acme/renamed');
    expect(updated.slug).toBe('acme/renamed');
    expect(updated.scmProvider).toBe('github');
    expect(updated.scmBaseUrl).toBe('https://github.com');
  });

  it('keeps legacy slug-only repo updates working after projectPath is stored', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/original',
      baselineUrl: 'https://original.example.com'
    });

    const updated = await board.updateRepo(repo.repoId, {
      slug: 'acme/legacy-rename'
    });

    expect(updated.projectPath).toBe('acme/legacy-rename');
    expect(updated.slug).toBe('acme/legacy-rename');
    expect(updated.scmProvider).toBe('github');
    expect(updated.scmBaseUrl).toBe('https://github.com');
  });

  it('persists provider-neutral review metadata while mirroring legacy PR aliases', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/review-demo',
      baselineUrl: 'https://review-demo.example.com',
      defaultBranch: 'main'
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);

    const task = await repoBoard.createTask({
      repoId: repo.repoId,
      title: 'Review metadata',
      taskPrompt: 'Track provider-neutral review refs.',
      acceptanceCriteria: ['review metadata is stored'],
      context: { links: [] },
      status: 'READY'
    });
    const run = await repoBoard.startRun(task.taskId);
    const updated = await repoBoard.transitionRun(run.runId, {
      status: 'PR_OPEN',
      reviewUrl: 'https://github.com/acme/review-demo/pull/12',
      reviewNumber: 12,
      reviewProvider: 'github',
      headSha: 'a'.repeat(40)
    });

    expect(updated).toMatchObject({
      reviewUrl: 'https://github.com/acme/review-demo/pull/12',
      reviewNumber: 12,
      reviewProvider: 'github',
      prUrl: 'https://github.com/acme/review-demo/pull/12',
      prNumber: 12
    });
  });
});
