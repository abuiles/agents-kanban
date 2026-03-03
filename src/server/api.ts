import { Hono } from 'hono';
import {
  resolvePlatformAdminContext,
  resolveRequestTenantContext,
  requireActiveTenantAccess
} from './router';
import { handleApiRequest } from './router';

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

apiRouter.all('/api/*', async (c) => {
  const request = c.req.raw;
  return handleApiRequest(request, c.env as Env, c.executionCtx);
});

export { apiRouter };
