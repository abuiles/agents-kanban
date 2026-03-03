import { Hono, type Context } from 'hono';
import {
  resolvePlatformAdminContext,
  resolveRequestTenantContext,
  requireActiveTenantAccess
} from './router';
import { handleApiRequest } from './router';
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

async function handleApiRoute(c: Context) {
  const request = c.req.raw;
  return handleApiRequest(request, c.env as Env, c.executionCtx as unknown as ExecutionContext);
}

apiRouter.post('/api/auth/signup', handleApiRoute);
apiRouter.post('/api/auth/login', handleApiRoute);
apiRouter.post('/api/platform/auth/login', handleApiRoute);
apiRouter.post('/api/platform/support/release-tenant', handleApiRoute);
apiRouter.get('/api/platform/support/sessions', handleApiRoute);
apiRouter.post('/api/platform/support/assume-tenant', handleApiRoute);
apiRouter.get('/api/platform/audit-log', handleApiRoute);

apiRouter.post('/api/auth/logout', handleApiRoute);
apiRouter.get('/api/me', handleApiRoute);
apiRouter.post('/api/me/tenant-context', handleApiRoute);
apiRouter.get('/api/tenants', handleApiRoute);
apiRouter.post('/api/tenants', handleApiRoute);
apiRouter.get('/api/tenants/:tenantId', handleApiRoute);
apiRouter.get('/api/tenants/:tenantId/members', handleApiRoute);
apiRouter.post('/api/tenants/:tenantId/members', handleApiRoute);
apiRouter.get('/api/tenants/:tenantId/invites', handleApiRoute);
apiRouter.post('/api/tenants/:tenantId/invites', handleApiRoute);
apiRouter.post('/api/invites/:inviteId/accept', handleApiRoute);
apiRouter.patch('/api/tenants/:tenantId/members/:memberId', handleApiRoute);

apiRouter.get('/api/board', handleApiRoute);
apiRouter.get('/api/board/ws', handleApiRoute);
apiRouter.get('/api/repos', handleApiRoute);
apiRouter.post('/api/repos', handleApiRoute);
apiRouter.patch('/api/repos/:repoId', handleApiRoute);

apiRouter.get('/api/scm/credentials', handleApiRoute);
apiRouter.post('/api/scm/credentials', handleApiRoute);
apiRouter.get('/api/scm/credentials/:provider/:credentialId', handleApiRoute);

apiRouter.get('/api/tasks', handleApiRoute);
apiRouter.post('/api/tasks', handleApiRoute);
apiRouter.get('/api/tenant-usage', handleApiRoute);
apiRouter.get('/api/tenant-usage/runs', handleApiRoute);
apiRouter.get('/api/tasks/:taskId', handleApiRoute);
apiRouter.patch('/api/tasks/:taskId', handleApiRoute);
apiRouter.delete('/api/tasks/:taskId', handleApiRoute);
apiRouter.post('/api/tasks/:taskId/run', handleApiRoute);

apiRouter.get('/api/runs/:runId', handleApiRoute);
apiRouter.post('/api/runs/:runId/retry', handleApiRoute);
apiRouter.post('/api/runs/:runId/cancel', handleApiRoute);
apiRouter.post('/api/runs/:runId/request-changes', handleApiRoute);
apiRouter.post('/api/runs/:runId/evidence', handleApiRoute);
apiRouter.post('/api/runs/:runId/preview', handleApiRoute);
apiRouter.get('/api/runs/:runId/logs', handleApiRoute);
apiRouter.get('/api/runs/:runId/usage', handleApiRoute);
apiRouter.get('/api/runs/:runId/events', handleApiRoute);
apiRouter.get('/api/runs/:runId/commands', handleApiRoute);
apiRouter.get('/api/runs/:runId/terminal', handleApiRoute);
apiRouter.get('/api/runs/:runId/ws', handleApiRoute);
apiRouter.get('/api/runs/:runId/artifacts', handleApiRoute);
apiRouter.post('/api/runs/:runId/takeover', handleApiRoute);

apiRouter.get('/api/debug/export', handleApiRoute);
apiRouter.post('/api/debug/import', handleApiRoute);
apiRouter.post('/api/debug/sandbox/run', handleApiRoute);
apiRouter.post('/api/debug/sandbox/file', handleApiRoute);

apiRouter.notFound((c) => {
  const method = c.req.method.toUpperCase();
  const pathname = new URL(c.req.url).pathname;
  return json({ code: 'NOT_FOUND', message: `No API route for ${method} ${pathname}.`, retryable: false }, { status: 404 });
});

export { apiRouter };
