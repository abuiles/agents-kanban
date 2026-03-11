import { Hono, type Context } from 'hono';
import {
  handleAcceptInvite,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthSignup,
  handleBoard,
  handleBoardWs,
  handleCancelRun,
  handleCreateApiToken,
  handleCreateInvite,
  handleCreateRepo,
  handleCreateReviewPlaybook,
  handleCreateTask,
  handleDebugExport,
  handleDebugImport,
  handleDebugSandboxFile,
  handleDebugSandboxRun,
  handleDeleteApiToken,
  handleDeleteRepo,
  handleDeleteTask,
  handleGetRepoSentinel,
  handleGetRun,
  handleGetRunCheckpoints,
  handleGetRunArtifacts,
  handleGetRunCommands,
  handleGetRunEvents,
  handleGetRunLogs,
  handleGetRunTerminal,
  handleGetRunUsage,
  handleGetRunWs,
  handleGetScmCredential,
  handleGetTask,
  handleGetTaskCheckpoints,
  handleListApiTokens,
  handleListInvites,
  handleListRepos,
  handleListReviewPlaybooks,
  handleListScmCredentials,
  handleListTasks,
  handleMe,
  handlePatchRepoSentinelConfig,
  handlePauseRepoSentinel,
  handleRequestChanges,
  handleResumeRepoSentinel,
  handleRerunReview,
  handleRetryEvidence,
  handleRetryPreview,
  handleRetryRun,
  handleRunTask,
  handleStartRepoSentinel,
  handleStopRepoSentinel,
  handleListRepoSentinelEvents,
  handleTakeoverRun,
  handleTenantRunUsage,
  handleTenantUsageSummary,
  handleUpdateRepo,
  handleUpdateReviewPlaybook,
  handleUpdateTask,
  handleDeleteReviewPlaybook,
  handleUpsertScmCredential,
  handleSlackCommands,
  handleSlackEvents,
  handleSlackInteractions,
  handleGitlabWebhook,
  handleGithubWebhook
} from './router';
import { json } from './http/response';

const apiRouter = new Hono();

apiRouter.post('/api/auth/signup', (c: Context) => handleAuthSignup(c.req.raw, c.env as Env));
apiRouter.post('/api/auth/login', (c: Context) => handleAuthLogin(c.req.raw, c.env as Env));
apiRouter.post('/api/auth/logout', (c: Context) => handleAuthLogout(c.req.raw, c.env as Env));
apiRouter.get('/api/me', (c: Context) => handleMe(c.req.raw, c.env as Env));
apiRouter.get('/api/invites', (c: Context) => handleListInvites(c.req.raw, c.env as Env));
apiRouter.post('/api/invites', (c: Context) => handleCreateInvite(c.req.raw, c.env as Env));
apiRouter.post('/api/invites/:inviteId/accept', (c: Context) =>
  handleAcceptInvite(c.req.raw, c.env as Env, { inviteId: c.req.param('inviteId') })
);
apiRouter.get('/api/me/api-tokens', (c: Context) => handleListApiTokens(c.req.raw, c.env as Env));
apiRouter.post('/api/me/api-tokens', (c: Context) => handleCreateApiToken(c.req.raw, c.env as Env));
apiRouter.delete('/api/me/api-tokens/:tokenId', (c: Context) =>
  handleDeleteApiToken(c.req.raw, c.env as Env, { tokenId: c.req.param('tokenId') })
);

apiRouter.get('/api/board', (c: Context) => handleBoard(c.req.raw, c.env as Env));
apiRouter.post('/api/integrations/slack/commands', (c: Context) =>
  handleSlackCommands(c.req.raw, c.env as Env, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.post('/api/integrations/slack/events', (c: Context) =>
  handleSlackEvents(c.req.raw, c.env as Env)
);
apiRouter.post('/api/integrations/slack/interactions', (c: Context) =>
  handleSlackInteractions(c.req.raw, c.env as Env, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.post('/api/integrations/gitlab/webhook', (c: Context) =>
  handleGitlabWebhook(c.req.raw, c.env as Env)
);
apiRouter.post('/api/integrations/github/webhook', (c: Context) =>
  handleGithubWebhook(c.req.raw, c.env as Env)
);
apiRouter.get('/api/board/ws', (c: Context) => handleBoardWs(c.req.raw, c.env as Env));
apiRouter.get('/api/repos', (c: Context) => handleListRepos(c.req.raw, c.env as Env));
apiRouter.post('/api/repos', (c: Context) => handleCreateRepo(c.req.raw, c.env as Env));
apiRouter.patch('/api/repos/:repoId', (c: Context) =>
  handleUpdateRepo(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);
apiRouter.delete('/api/repos/:repoId', (c: Context) =>
  handleDeleteRepo(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);
apiRouter.get('/api/review-playbooks', (c: Context) => handleListReviewPlaybooks(c.req.raw, c.env as Env));
apiRouter.post('/api/review-playbooks', (c: Context) => handleCreateReviewPlaybook(c.req.raw, c.env as Env));
apiRouter.patch('/api/review-playbooks/:playbookId', (c: Context) =>
  handleUpdateReviewPlaybook(c.req.raw, c.env as Env, { playbookId: c.req.param('playbookId') })
);
apiRouter.delete('/api/review-playbooks/:playbookId', (c: Context) =>
  handleDeleteReviewPlaybook(c.req.raw, c.env as Env, { playbookId: c.req.param('playbookId') })
);
apiRouter.get('/api/repos/:repoId/sentinel', (c: Context) =>
  handleGetRepoSentinel(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);
apiRouter.patch('/api/repos/:repoId/sentinel/config', (c: Context) =>
  handlePatchRepoSentinelConfig(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);
apiRouter.post('/api/repos/:repoId/sentinel/start', (c: Context) =>
  handleStartRepoSentinel(
    c.req.raw,
    c.env as Env,
    { repoId: c.req.param('repoId') },
    c.executionCtx as unknown as ExecutionContext<unknown>
  )
);
apiRouter.post('/api/repos/:repoId/sentinel/pause', (c: Context) =>
  handlePauseRepoSentinel(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);
apiRouter.post('/api/repos/:repoId/sentinel/resume', (c: Context) =>
  handleResumeRepoSentinel(
    c.req.raw,
    c.env as Env,
    { repoId: c.req.param('repoId') },
    c.executionCtx as unknown as ExecutionContext<unknown>
  )
);
apiRouter.post('/api/repos/:repoId/sentinel/stop', (c: Context) =>
  handleStopRepoSentinel(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);
apiRouter.get('/api/repos/:repoId/sentinel/events', (c: Context) =>
  handleListRepoSentinelEvents(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
);

apiRouter.get('/api/scm/credentials', (c: Context) => handleListScmCredentials(c.req.raw, c.env as Env));
apiRouter.post('/api/scm/credentials', (c: Context) => handleUpsertScmCredential(c.req.raw, c.env as Env));
apiRouter.get('/api/scm/credentials/:provider/:credentialId', (c: Context) =>
  handleGetScmCredential(c.req.raw, c.env as Env, {
    provider: c.req.param('provider') as 'github' | 'gitlab',
    credentialId: c.req.param('credentialId')
  })
);

apiRouter.get('/api/tasks', (c: Context) => handleListTasks(c.req.raw, c.env as Env));
apiRouter.post('/api/tasks', (c: Context) => handleCreateTask(c.req.raw, c.env as Env));
apiRouter.get('/api/tenant-usage', (c: Context) => handleTenantUsageSummary(c.req.raw, c.env as Env));
apiRouter.get('/api/tenant-usage/runs', (c: Context) => handleTenantRunUsage(c.req.raw, c.env as Env));
apiRouter.get('/api/tasks/:taskId', (c: Context) =>
  handleGetTask(c.req.raw, c.env as Env, { taskId: c.req.param('taskId') })
);
apiRouter.get('/api/tasks/:taskId/checkpoints', (c: Context) =>
  handleGetTaskCheckpoints(c.req.raw, c.env as Env, { taskId: c.req.param('taskId') })
);
apiRouter.patch('/api/tasks/:taskId', (c: Context) =>
  handleUpdateTask(c.req.raw, c.env as Env, { taskId: c.req.param('taskId') })
);
apiRouter.delete('/api/tasks/:taskId', (c: Context) =>
  handleDeleteTask(c.req.raw, c.env as Env, { taskId: c.req.param('taskId') })
);
apiRouter.post('/api/tasks/:taskId/run', (c: Context) =>
  handleRunTask(c.req.raw, c.env as Env, { taskId: c.req.param('taskId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
);

apiRouter.get('/api/runs/:runId', (c: Context) =>
  handleGetRun(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.get('/api/runs/:runId/checkpoints', (c: Context) =>
  handleGetRunCheckpoints(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.post('/api/runs/:runId/retry', (c: Context) =>
  handleRetryRun(c.req.raw, c.env as Env, { runId: c.req.param('runId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.post('/api/runs/:runId/review', (c: Context) =>
  handleRerunReview(c.req.raw, c.env as Env, { runId: c.req.param('runId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.post('/api/runs/:runId/cancel', (c: Context) =>
  handleCancelRun(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.post('/api/runs/:runId/request-changes', (c: Context) =>
  handleRequestChanges(c.req.raw, c.env as Env, { runId: c.req.param('runId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.post('/api/runs/:runId/evidence', (c: Context) =>
  handleRetryEvidence(c.req.raw, c.env as Env, { runId: c.req.param('runId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.post('/api/runs/:runId/preview', (c: Context) =>
  handleRetryPreview(c.req.raw, c.env as Env, { runId: c.req.param('runId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
);
apiRouter.get('/api/runs/:runId/logs', (c: Context) =>
  handleGetRunLogs(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.get('/api/runs/:runId/usage', (c: Context) =>
  handleGetRunUsage(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.get('/api/runs/:runId/events', (c: Context) =>
  handleGetRunEvents(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.get('/api/runs/:runId/commands', (c: Context) =>
  handleGetRunCommands(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.get('/api/runs/:runId/terminal', (c: Context) =>
  handleGetRunTerminal(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.get('/api/runs/:runId/ws', (c: Context) => handleGetRunWs(c.req.raw, c.env as Env, { runId: c.req.param('runId') }));
apiRouter.get('/api/runs/:runId/artifacts', (c: Context) =>
  handleGetRunArtifacts(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);
apiRouter.post('/api/runs/:runId/takeover', (c: Context) =>
  handleTakeoverRun(c.req.raw, c.env as Env, { runId: c.req.param('runId') })
);

apiRouter.get('/api/debug/export', (c: Context) => handleDebugExport(c.req.raw, c.env as Env));
apiRouter.post('/api/debug/import', (c: Context) => handleDebugImport(c.req.raw, c.env as Env));
apiRouter.post('/api/debug/sandbox/run', (c: Context) => handleDebugSandboxRun(c.req.raw, c.env as Env));
apiRouter.post('/api/debug/sandbox/file', (c: Context) => handleDebugSandboxFile(c.req.raw, c.env as Env));

apiRouter.notFound((c) => {
  const method = c.req.method.toUpperCase();
  const pathname = new URL(c.req.url).pathname;
  return json({ code: 'NOT_FOUND', message: `No API route for ${method} ${pathname}.`, retryable: false }, { status: 404 });
});

export { apiRouter };
