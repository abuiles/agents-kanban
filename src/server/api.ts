import { Hono, type Context } from 'hono';
import {
  handleAuthLogin,
  handleAuthLogout,
  handleAuthSignup,
  handleCancelRun,
  handleCreateRepo,
  handleCreateTask,
  handleCreateTenant,
  handleCreateTenantInvite,
  handleCreateTenantMember,
  handleDebugExport,
  handleDebugImport,
  handleDebugSandboxFile,
  handleDebugSandboxRun,
  handleDeleteTask,
  handleGetRun,
  handleGetRunArtifacts,
  handleGetRunCommands,
  handleGetRunEvents,
  handleGetRunLogs,
  handleGetRunTerminal,
  handleGetRunUsage,
  handleGetRunWs,
  handleGetScmCredential,
  handleGetTask,
  handleGetTenant,
  handleListRepos,
  handleListScmCredentials,
  handleListTasks,
  handleListTenantInvites,
  handleListTenantMembers,
  handleListTenants,
  handleMe,
  handlePlatformAuditLog,
  handlePlatformAuthLogin,
  handleRequestChanges,
  handleRetryEvidence,
  handleRetryPreview,
  handleRetryRun,
  handleRunTask,
  handleSetTenantContext,
  handleSupportAssumeTenant,
  handleSupportReleaseTenant,
  handleSupportSessions,
  handleTakeoverRun,
  handleTenantRunUsage,
  handleTenantUsageSummary,
  handleUpdateRepo,
  handleUpdateTask,
  handleUpdateTenantMember,
  handleUpsertScmCredential,
  handleAcceptInvite,
  handleBoard,
  handleBoardWs,
  requireActiveTenantAccess,
  resolvePlatformAdminContext,
  resolveRequestTenantContext
} from './router';
import { json } from './http/response';

const apiRouter = new Hono();

const BOARD_OBJECT_NAME = 'agentboard';

function isPublicApiRoute(pathname: string, method: string) {
  return (
    (pathname === '/api/auth/signup' && method === 'POST') ||
    (pathname === '/api/auth/login' && method === 'POST') ||
    (pathname === '/api/platform/auth/login' && method === 'POST')
  );
}

function isPlatformAdminApiRoute(pathname: string, method: string) {
  return (
    (pathname === '/api/platform/support/release-tenant' && method === 'POST') ||
    (pathname === '/api/platform/support/sessions' && method === 'GET') ||
    (pathname === '/api/platform/support/assume-tenant' && method === 'POST') ||
    (pathname === '/api/platform/audit-log' && method === 'GET')
  );
}

function isDebugRoute(pathname: string, method: string) {
  return (
    (pathname === '/api/debug/export' && method === 'GET') ||
    (pathname === '/api/debug/import' && method === 'POST') ||
    (pathname === '/api/debug/sandbox/run' && method === 'POST') ||
    (pathname === '/api/debug/sandbox/file' && method === 'POST')
  );
}

apiRouter.use('/api/*', async (c, next) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (isPublicApiRoute(pathname, method)) {
    return next();
  }

  const env = c.env as Env;
  const board = env.BOARD_INDEX.getByName(BOARD_OBJECT_NAME);

  if (isPlatformAdminApiRoute(pathname, method)) {
    await resolvePlatformAdminContext(env, board, request);
    return next();
  }

  if (isDebugRoute(pathname, method)) {
    await resolvePlatformAdminContext(env, board, request);
    return next();
  }

  const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
  await requireActiveTenantAccess(env, board, requestContext, requestContext.activeTenantId);

  return next();
});

apiRouter.post('/api/auth/signup', (c: Context) => handleAuthSignup(c.req.raw, c.env as Env));
apiRouter.post('/api/auth/login', (c: Context) => handleAuthLogin(c.req.raw, c.env as Env));
apiRouter.post('/api/platform/auth/login', (c: Context) => handlePlatformAuthLogin(c.req.raw, c.env as Env));
apiRouter.post('/api/platform/support/release-tenant', (c: Context) =>
  handleSupportReleaseTenant(c.req.raw, c.env as Env)
);
apiRouter.get('/api/platform/support/sessions', (c: Context) => handleSupportSessions(c.req.raw, c.env as Env));
apiRouter.post('/api/platform/support/assume-tenant', (c: Context) =>
  handleSupportAssumeTenant(c.req.raw, c.env as Env)
);
apiRouter.get('/api/platform/audit-log', (c: Context) => handlePlatformAuditLog(c.req.raw, c.env as Env));

apiRouter.post('/api/auth/logout', (c: Context) => handleAuthLogout(c.req.raw, c.env as Env));
apiRouter.get('/api/me', (c: Context) => handleMe(c.req.raw, c.env as Env));
apiRouter.post('/api/me/tenant-context', (c: Context) => handleSetTenantContext(c.req.raw, c.env as Env));
apiRouter.get('/api/tenants', (c: Context) => handleListTenants(c.req.raw, c.env as Env));
apiRouter.post('/api/tenants', (c: Context) => handleCreateTenant(c.req.raw, c.env as Env));
apiRouter.get('/api/tenants/:tenantId', (c: Context) =>
  handleGetTenant(c.req.raw, c.env as Env, { tenantId: c.req.param('tenantId') })
);
apiRouter.get('/api/tenants/:tenantId/members', (c: Context) =>
  handleListTenantMembers(c.req.raw, c.env as Env, { tenantId: c.req.param('tenantId') })
);
apiRouter.post('/api/tenants/:tenantId/members', (c: Context) =>
  handleCreateTenantMember(c.req.raw, c.env as Env, { tenantId: c.req.param('tenantId') })
);
apiRouter.get('/api/tenants/:tenantId/invites', (c: Context) =>
  handleListTenantInvites(c.req.raw, c.env as Env, { tenantId: c.req.param('tenantId') })
);
apiRouter.post('/api/tenants/:tenantId/invites', (c: Context) =>
  handleCreateTenantInvite(c.req.raw, c.env as Env, { tenantId: c.req.param('tenantId') })
);
apiRouter.post('/api/invites/:inviteId/accept', (c: Context) =>
  handleAcceptInvite(c.req.raw, c.env as Env, { inviteId: c.req.param('inviteId') })
);
apiRouter.patch('/api/tenants/:tenantId/members/:memberId', (c: Context) =>
  handleUpdateTenantMember(c.req.raw, c.env as Env, {
    tenantId: c.req.param('tenantId'),
    memberId: c.req.param('memberId')
  })
);

apiRouter.get('/api/board', (c: Context) => handleBoard(c.req.raw, c.env as Env));
apiRouter.get('/api/board/ws', (c: Context) => handleBoardWs(c.req.raw, c.env as Env));
apiRouter.get('/api/repos', (c: Context) => handleListRepos(c.req.raw, c.env as Env));
apiRouter.post('/api/repos', (c: Context) => handleCreateRepo(c.req.raw, c.env as Env));
apiRouter.patch('/api/repos/:repoId', (c: Context) =>
  handleUpdateRepo(c.req.raw, c.env as Env, { repoId: c.req.param('repoId') })
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
apiRouter.post('/api/runs/:runId/retry', (c: Context) =>
  handleRetryRun(c.req.raw, c.env as Env, { runId: c.req.param('runId') }, c.executionCtx as unknown as ExecutionContext<unknown>)
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
