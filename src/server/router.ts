import { getSandbox } from '@cloudflare/sandbox';
import type { CreateTaskInput } from '../ui/domain/api';
import { badRequest, forbidden, notFound, unauthorized } from './http/errors';
import { handleError, json } from './http/response';
import {
  parseAcceptTenantInviteInput,
  parseAuthLoginInput,
  parseCreateTenantInviteInput,
  parseAuthSignupInput,
  parseCreateRepoInput,
  parseCreateTaskInput,
  parseCreateTenantInput,
  parseCreateTenantMemberInput,
  parsePlatformAuthLoginInput,
  parsePlatformSupportAssumeTenantInput,
  parseSetActiveTenantInput,
  parseUpdateRepoInput,
  parseUpdateTaskInput,
  parseUpdateTenantMemberInput,
  parseUpsertScmCredentialInput,
  readJson
} from './http/validation';
import { extractRepoIdFromRunId, extractRepoIdFromTaskId } from './shared/ids';
import { parseBoardSnapshot } from '../ui/store/board-snapshot';
import { scheduleRunJob } from './run-orchestrator';
import { getRunUsage, getTenantRunUsage, getTenantUsageSummary } from './usage-reporting';
import { normalizeTenantId, normalizeTenantIdStrict } from '../shared/tenant';
import * as tenantAuthDb from './tenant-auth-db';

const BOARD_OBJECT_NAME = 'agentboard';

export async function handleApiRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const board = env.BOARD_INDEX.getByName(BOARD_OBJECT_NAME);

  try {
    if (url.pathname === '/api/auth/signup' && request.method === 'POST') {
      const input = parseAuthSignupInput(await readJson(request));
      const result = await tenantAuthDb.signup(env, {
        email: input.email,
        password: input.password,
        displayName: input.displayName,
        tenant: {
          name: input.tenantName,
          domain: input.tenantDomain,
          seatLimit: input.seatLimit,
          defaultSeatLimit: input.defaultSeatLimit
        }
      });
      const response = json({
        user: result.user,
        session: result.session,
        activeTenantId: result.activeTenantId,
        memberships: result.memberships,
        token: result.token
      }, { status: 201 });
      response.headers.append('Set-Cookie', buildSessionCookie(result.token));
      return response;
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const input = parseAuthLoginInput(await readJson(request));
      const result = await tenantAuthDb.login(env, input);
      const response = json({
        user: result.user,
        session: result.session,
        activeTenantId: result.activeTenantId,
        memberships: result.memberships,
        token: result.token
      });
      response.headers.append('Set-Cookie', buildSessionCookie(result.token));
      return response;
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
      if (requestContext.sessionId) {
        await tenantAuthDb.logout(env, requestContext.sessionId);
      }
      const response = json({ ok: true });
      response.headers.append('Set-Cookie', clearSessionCookie());
      return response;
    }

    if (url.pathname === '/api/platform/auth/login' && request.method === 'POST') {
      const input = parsePlatformAuthLoginInput(await readJson(request));
      const result = await tenantAuthDb.platformLogin(env, input);
      return json(result);
    }

    if (url.pathname === '/api/platform/support/release-tenant' && request.method === 'POST') {
      const platformContext = await resolvePlatformAdminContext(env, board, request);
      const supportToken = readPlatformSupportToken(request);
      if (!supportToken) {
        throw unauthorized('Missing support session token.');
      }
      const released = await tenantAuthDb.releasePlatformSupportSession(env, supportToken, platformContext.platformAdminId);
      return json(released);
    }

    if (url.pathname === '/api/platform/support/sessions' && request.method === 'GET') {
      const platformContext = await resolvePlatformAdminContext(env, board, request);
      return json(await tenantAuthDb.listPlatformSupportSessions(env, platformContext.platformAdminId));
    }

    if (url.pathname === '/api/platform/audit-log' && request.method === 'GET') {
      const platformContext = await resolvePlatformAdminContext(env, board, request);
      return json(await tenantAuthDb.listSecurityAuditLog(env, platformContext.platformAdminId));
    }

    if (url.pathname === '/api/platform/support/assume-tenant' && request.method === 'POST') {
      const platformContext = await resolvePlatformAdminContext(env, board, request);
      const input = parsePlatformSupportAssumeTenantInput(await readJson(request));
      const result = await tenantAuthDb.createPlatformSupportSession(env, {
        adminId: platformContext.platformAdminId,
        tenantId: input.tenantId,
        reason: input.reason,
        ttlMinutes: input.ttlMinutes
      });
      return json(result, { status: 201 });
    }

    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });

    if (url.pathname === '/api/me' && request.method === 'GET') {
      const user = await tenantAuthDb.getUserById(env, requestContext.userId);
      if (!user) {
        throw unauthorized(`User ${requestContext.userId} not found.`);
      }
      const memberships = await tenantAuthDb.listUserMemberships(env, user.id);
      const tenants = await tenantAuthDb.listTenantsForUser(env, user.id);
      return json({
        user,
        memberships,
        tenants,
        activeTenantId: requestContext.activeTenantId
      });
    }

    if (url.pathname === '/api/me/tenant-context' && request.method === 'POST') {
      if (!requestContext.sessionId) {
        throw unauthorized('Tenant context switching requires an auth session.');
      }
      const { tenantId } = parseSetActiveTenantInput(await readJson(request));
      const session = await tenantAuthDb.setSessionActiveTenant(env, requestContext.sessionId, tenantId);
      const response = json({ activeTenantId: session.activeTenantId, session });
      if (requestContext.sessionToken) {
        response.headers.append('Set-Cookie', buildSessionCookie(requestContext.sessionToken));
      }
      return response;
    }

    if (url.pathname === '/api/tenants' && request.method === 'GET') {
      return json(await tenantAuthDb.listTenantsForUser(env, requestContext.userId));
    }

    if (url.pathname === '/api/tenants' && request.method === 'POST') {
      const input = parseCreateTenantInput(await readJson(request));
      return json(await tenantAuthDb.createTenant(env, input, requestContext.userId), { status: 201 });
    }

    const tenantMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)$/);
    if (tenantMatch && request.method === 'GET') {
      const tenantId = decodeURIComponent(tenantMatch[1]);
      await requireActiveTenantAccess(env, board, requestContext, tenantId);
      return json(await tenantAuthDb.getTenant(env, tenantId));
    }

    const tenantMembersMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/members$/);
    if (tenantMembersMatch && request.method === 'GET') {
      const tenantId = decodeURIComponent(tenantMembersMatch[1]);
      await requireActiveTenantAccess(env, board, requestContext, tenantId);
      return json({
        members: await tenantAuthDb.listTenantMembers(env, tenantId),
        seatSummary: await tenantAuthDb.getTenantSeatSummary(env, tenantId)
      });
    }

    if (tenantMembersMatch && request.method === 'POST') {
      const tenantId = decodeURIComponent(tenantMembersMatch[1]);
      const input = parseCreateTenantMemberInput(await readJson(request));
      await requireOwnerTenantAccess(env, board, requestContext, tenantId);
      return json(await tenantAuthDb.createTenantMember(env, tenantId, input, requestContext.userId), { status: 201 });
    }

    const tenantInvitesMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/invites$/);
    if (tenantInvitesMatch && request.method === 'POST') {
      const tenantId = decodeURIComponent(tenantInvitesMatch[1]);
      const input = parseCreateTenantInviteInput(await readJson(request));
      await requireOwnerTenantAccess(env, board, requestContext, tenantId);
      return json(await tenantAuthDb.createTenantInvite(env, tenantId, input, requestContext.userId), { status: 201 });
    }

    if (tenantInvitesMatch && request.method === 'GET') {
      const tenantId = decodeURIComponent(tenantInvitesMatch[1]);
      await requireOwnerTenantAccess(env, board, requestContext, tenantId);
      return json(await tenantAuthDb.listTenantInvites(env, tenantId, requestContext.userId));
    }

    const inviteAcceptMatch = url.pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
    if (inviteAcceptMatch && request.method === 'POST') {
      const body = parseAcceptTenantInviteInput(await readJson(request));
      const inviteId = decodeURIComponent(inviteAcceptMatch[1]);
      const resolvedInvite = await tenantAuthDb.resolvePendingTenantInviteByToken(env, body.token);
      if (resolvedInvite.invite.id !== inviteId) {
        throw forbidden('Invite token does not match requested invite id.');
      }
      const result = await tenantAuthDb.acceptTenantInvite(env, body.token, requestContext.userId);
      return json(result);
    }

    const tenantMemberMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/members\/([^/]+)$/);
    if (tenantMemberMatch && request.method === 'PATCH') {
      const tenantId = decodeURIComponent(tenantMemberMatch[1]);
      const memberId = decodeURIComponent(tenantMemberMatch[2]);
      const patch = parseUpdateTenantMemberInput(await readJson(request));
      await requireOwnerTenantAccess(env, board, requestContext, tenantId);
      return json(await tenantAuthDb.updateTenantMember(env, tenantId, memberId, patch, requestContext.userId));
    }

    if (url.pathname === '/api/board' && request.method === 'GET') {
      await requireActiveTenantAccess(env, board, requestContext);
      const repoId = url.searchParams.get('repoId') ?? 'all';
      if (repoId !== 'all') {
        await assertRepoAccess(env, board, requestContext, repoId);
      }
      return json(await board.getBoardSync(repoId, requestContext.activeTenantId));
    }

    if (url.pathname === '/api/board/ws' && request.method === 'GET') {
      await requireActiveTenantAccess(env, board, requestContext);
      const repoId = url.searchParams.get('repoId');
      if (repoId && repoId !== 'all') {
        await assertRepoAccess(env, board, requestContext, repoId);
      }
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set('tenantId', requestContext.activeTenantId);
      wsUrl.searchParams.set('repoId', repoId ?? 'all');
      return board.fetch(new Request(wsUrl.toString(), request));
    }

    if (url.pathname === '/api/repos' && request.method === 'GET') {
      await requireActiveTenantAccess(env, board, requestContext);
      return json(await board.listRepos(requestContext.activeTenantId));
    }

    if (url.pathname === '/api/repos' && request.method === 'POST') {
      const input = parseCreateRepoInput(await readJson(request));
      const tenantId = normalizeTenantId(input.tenantId ?? requestContext.activeTenantId);
      await requireActiveTenantAccess(env, board, requestContext, tenantId);
      return json(await board.createRepo({ ...input, tenantId }), { status: 201 });
    }

    const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
    if (repoMatch && request.method === 'PATCH') {
      const repoId = decodeURIComponent(repoMatch[1]);
      const repo = await assertRepoAccess(env, board, requestContext, repoId);
      const patch = parseUpdateRepoInput(await readJson(request));
      if (patch.tenantId && normalizeTenantId(patch.tenantId) !== repo.tenantId) {
        throw forbidden('Repo tenantId cannot be changed.');
      }
      return json(await board.updateRepo(repoId, patch));
    }

    if (url.pathname === '/api/scm/credentials' && request.method === 'GET') {
      return json(await board.listScmCredentials());
    }

    if (url.pathname === '/api/scm/credentials' && request.method === 'POST') {
      return json(await board.upsertScmCredential(parseUpsertScmCredentialInput(await readJson(request))), { status: 201 });
    }

    const scmCredentialMatch = url.pathname.match(/^\/api\/scm\/credentials\/([^/]+)\/([^/]+)$/);
    if (scmCredentialMatch && request.method === 'GET') {
      const credential = await board.getScmCredential(
        decodeURIComponent(scmCredentialMatch[1]) as 'github' | 'gitlab',
        decodeURIComponent(scmCredentialMatch[2])
      );
      if (!credential) {
        throw notFound(`SCM credential ${decodeURIComponent(scmCredentialMatch[1])}:${decodeURIComponent(scmCredentialMatch[2])} not found.`);
      }
      return json(credential);
    }

    if (url.pathname === '/api/tasks' && request.method === 'GET') {
      await requireActiveTenantAccess(env, board, requestContext);
      const repoId = url.searchParams.get('repoId');
      if (!repoId || repoId === 'all') {
        return json((await board.getBoardSync('all', requestContext.activeTenantId)).tasks);
      }
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).listTasks(requestContext.activeTenantId));
    }

    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const input = parseCreateTaskInput(await readJson(request));
      await assertRepoAccess(env, board, requestContext, input.repoId);
      return json(await env.REPO_BOARD.getByName(input.repoId).createTask(input), { status: 201 });
    }

    if (url.pathname === '/api/tenant-usage' && request.method === 'GET') {
      const tenantId = url.searchParams.get('tenantId') ?? requestContext.activeTenantId;
      await requireActiveTenantAccess(env, board, requestContext, tenantId);
      return json(await getTenantUsageSummary(url, env));
    }

    if (url.pathname === '/api/tenant-usage/runs' && request.method === 'GET') {
      const tenantId = url.searchParams.get('tenantId') ?? requestContext.activeTenantId;
      await requireActiveTenantAccess(env, board, requestContext, tenantId);
      return json(await getTenantRunUsage(url, env));
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'GET') {
      const taskId = decodeURIComponent(taskMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).getTask(taskId, requestContext.activeTenantId));
    }

    if (taskMatch && request.method === 'PATCH') {
      const taskId = decodeURIComponent(taskMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).updateTask(taskId, parseUpdateTaskInput(await readJson(request)), requestContext.activeTenantId));
    }

    if (taskMatch && request.method === 'DELETE') {
      const taskId = decodeURIComponent(taskMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).deleteTask(taskId, requestContext.activeTenantId));
    }

    const runStartMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
    if (runStartMatch && request.method === 'POST') {
      const taskId = decodeURIComponent(runStartMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const run = await env.REPO_BOARD.getByName(repoId).startRun(taskId, { tenantId: requestContext.activeTenantId });
      const workflow = await scheduleRunJob(env, ctx, {
        tenantId: requestContext.activeTenantId,
        repoId,
        taskId,
        runId: run.runId,
        mode: 'full_run'
      });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId, requestContext.activeTenantId));
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).getRun(runId, requestContext.activeTenantId));
    }

    const runRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
    if (runRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(runRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const run = await env.REPO_BOARD.getByName(repoId).retryRun(runId, requestContext.activeTenantId);
      const workflow = await scheduleRunJob(env, ctx, {
        tenantId: requestContext.activeTenantId,
        repoId,
        taskId: run.taskId,
        runId: run.runId,
        mode: 'full_run'
      });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId, requestContext.activeTenantId));
    }

    const runCancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (runCancelMatch && request.method === 'POST') {
      const runId = decodeURIComponent(runCancelMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const body = await readJson(request).catch(() => ({}));
      const reason = typeof (body as { reason?: unknown })?.reason === 'string' && (body as { reason?: string }).reason?.trim()
        ? (body as { reason: string }).reason.trim()
        : 'Run was cancelled by operator.';
      return json(await env.REPO_BOARD.getByName(repoId).markRunFailed(runId, {
        at: new Date().toISOString(),
        code: 'CANCELLED',
        message: reason,
        retryable: true,
        phase: 'codex'
      }, requestContext.activeTenantId));
    }

    const requestChangesMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/request-changes$/);
    if (requestChangesMatch && request.method === 'POST') {
      const runId = decodeURIComponent(requestChangesMatch[1]);
      const body = await readJson(request);
      if (
        typeof body !== 'object'
        || !body
        || !('prompt' in body)
        || typeof body.prompt !== 'string'
        || !body.prompt.trim()
      ) {
        throw badRequest('Invalid request changes payload.');
      }
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const run = await env.REPO_BOARD.getByName(repoId).requestRunChanges(runId, body.prompt.trim(), requestContext.activeTenantId);
      const workflow = await scheduleRunJob(env, ctx, {
        tenantId: requestContext.activeTenantId,
        repoId,
        taskId: run.taskId,
        runId: run.runId,
        mode: 'full_run'
      });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId, requestContext.activeTenantId));
    }

    const evidenceRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/evidence$/);
    if (evidenceRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(evidenceRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const run = await env.REPO_BOARD.getByName(repoId).retryEvidence(runId, requestContext.activeTenantId);
      const workflow = await scheduleRunJob(env, ctx, {
        tenantId: requestContext.activeTenantId,
        repoId,
        taskId: run.taskId,
        runId: run.runId,
        mode: run.previewUrl ? 'evidence_only' : 'preview_only'
      });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId, requestContext.activeTenantId));
    }

    const previewRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/preview$/);
    if (previewRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(previewRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const run = await env.REPO_BOARD.getByName(repoId).retryPreview(runId, requestContext.activeTenantId);
      const workflow = await scheduleRunJob(env, ctx, {
        tenantId: requestContext.activeTenantId,
        repoId,
        taskId: run.taskId,
        runId: run.runId,
        mode: 'preview_only'
      });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId, requestContext.activeTenantId));
    }

    const runLogsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
    if (runLogsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runLogsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const tail = url.searchParams.get('tail');
      return json(await env.REPO_BOARD.getByName(repoId).getRunLogs(runId, tail ? Number(tail) : undefined, requestContext.activeTenantId));
    }

    const runUsageMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/usage$/);
    if (runUsageMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runUsageMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await getRunUsage(runId, env));
    }

    const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (runEventsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runEventsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).getRunEvents(runId, requestContext.activeTenantId));
    }

    const runCommandsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/commands$/);
    if (runCommandsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runCommandsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).getRunCommands(runId, requestContext.activeTenantId));
    }

    const runTerminalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/terminal$/);
    if (runTerminalMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runTerminalMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const bootstrap = await env.REPO_BOARD.getByName(repoId).getTerminalBootstrap(runId, requestContext.activeTenantId);
      if (!bootstrap.attachable) {
        return json(bootstrap, { status: 409 });
      }
      return json(bootstrap);
    }

    const runTerminalSocketMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/ws$/);
    if (runTerminalSocketMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runTerminalSocketMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const bootstrap = await env.REPO_BOARD.getByName(repoId).getTerminalBootstrap(runId, requestContext.activeTenantId);
      if (!bootstrap.attachable) {
        return json(bootstrap, { status: 409 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        throw badRequest('Expected WebSocket upgrade request.');
      }

      const run = await env.REPO_BOARD.getByName(repoId).getRun(runId, requestContext.activeTenantId);
      const session = {
        tenantId: run.tenantId,
        id: `${runId}:${bootstrap.sessionName}`,
        runId,
        sandboxId: bootstrap.sandboxId,
        sessionName: bootstrap.sessionName,
        startedAt: run.operatorSession?.startedAt ?? new Date().toISOString(),
        actorId: run.operatorSession?.actorId ?? 'same-session',
        actorLabel: run.operatorSession?.actorLabel ?? 'Operator',
        connectionState: 'connecting' as const,
        takeoverState: run.operatorSession?.takeoverState ?? 'observing',
        llmAdapter: run.operatorSession?.llmAdapter ?? run.llmAdapter ?? 'codex',
        llmSupportsResume: run.operatorSession?.llmSupportsResume ?? run.llmSupportsResume,
        llmSessionId: run.operatorSession?.llmSessionId ?? run.operatorSession?.codexThreadId ?? run.llmSessionId,
        llmResumeCommand: run.operatorSession?.llmResumeCommand ?? run.operatorSession?.codexResumeCommand ?? run.llmResumeCommand ?? run.latestCodexResumeCommand,
        codexThreadId: run.operatorSession?.codexThreadId,
        codexResumeCommand: run.operatorSession?.codexResumeCommand ?? run.latestCodexResumeCommand
      };
      const sandbox = getSandbox(env.Sandbox, bootstrap.sandboxId);
      try {
        await sandbox.createSession({
          id: bootstrap.sessionName,
          cwd: '/workspace/repo'
        });
      } catch (error) {
        console.warn('Operator session already existed or could not be created with cwd', {
          runId,
          sessionName: bootstrap.sessionName,
          error
        });
      }
      await env.REPO_BOARD.getByName(repoId).updateOperatorSession(runId, session, requestContext.activeTenantId);
      const sandboxSession = await sandbox.getSession(bootstrap.sessionName);
      return sandboxSession.terminal(request, { cols: bootstrap.cols, rows: bootstrap.rows });
    }

    const runArtifactsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
    if (runArtifactsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runArtifactsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      return json(await env.REPO_BOARD.getByName(repoId).getRunArtifacts(runId, requestContext.activeTenantId));
    }

    const runTakeoverMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/takeover$/);
    if (runTakeoverMatch && request.method === 'POST') {
      const runId = decodeURIComponent(runTakeoverMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      await assertRepoAccess(env, board, requestContext, repoId);
      const repoBoard = env.REPO_BOARD.getByName(repoId);
      const run = await repoBoard.getRun(runId, requestContext.activeTenantId);
      if (run.sandboxId && run.codexProcessId) {
        const sandbox = getSandbox(env.Sandbox, run.sandboxId);
        try {
          await sandbox.killProcess(run.codexProcessId);
          const stopDeadline = Date.now() + 3_000;
          while (Date.now() < stopDeadline) {
            const process = await sandbox.getProcess(run.codexProcessId);
            if (!process || process.status !== 'running') {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch (error) {
          console.warn('Failed to kill Codex process during takeover', { runId, processId: run.codexProcessId, error });
        }
      }
      return json(await repoBoard.takeOverRun(runId, { actorId: 'same-session', actorLabel: 'Operator' }, requestContext.activeTenantId));
    }

    if (url.pathname === '/api/debug/export' && request.method === 'GET') {
      return json(await board.exportBoard());
    }

    if (url.pathname === '/api/debug/import' && request.method === 'POST') {
      const body = await readJson(request);
      if (typeof body !== 'object' || !body || !('version' in body)) {
        throw badRequest('Invalid board snapshot payload.');
      }
      await board.importBoard(parseBoardSnapshot(JSON.stringify(body)));
      return json({ ok: true });
    }

    if (url.pathname === '/api/debug/sandbox/run' && request.method === 'POST') {
      const sandbox = getSandbox(env.Sandbox, 'my-sandbox');
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return json({
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode,
        success: result.success
      });
    }

    if (url.pathname === '/api/debug/sandbox/file' && request.method === 'POST') {
      const sandbox = getSandbox(env.Sandbox, 'my-sandbox');
      await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
      const file = await sandbox.readFile('/workspace/hello.txt');
      return json({ content: file.content });
    }

    throw notFound(`No API route for ${request.method} ${url.pathname}.`);
  } catch (error) {
    return handleError(error);
  }
}

async function resolveRepoIdForTask(board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>, taskId: string) {
  return resolveRepoId(taskId, extractRepoIdFromTaskId(taskId), () => board.findTaskRepoId(taskId), 'Task');
}

async function resolveRepoIdForRun(board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>, runId: string) {
  return resolveRepoId(runId, extractRepoIdFromRunId(runId), () => board.findRunRepoId(runId), 'Run');
}

async function resolveRepoId(entityId: string, inferred: string | undefined, fallback: () => Promise<string | undefined>, label: 'Task' | 'Run') {
  const repoId = inferred ?? (await fallback());
  if (!repoId) {
    throw notFound(`${label} ${entityId} not found.`, label === 'Task' ? { taskId: entityId } : { runId: entityId });
  }
  return repoId;
}

export type RequestTenantContext = {
  userId: string;
  activeTenantId: string;
  sessionId?: string;
  sessionToken?: string;
  platformAdminId?: string;
  supportSessionId?: string;
};

type RequestTenantContextOptions = {
  requireSession?: boolean;
};

export type PlatformAdminContext = {
  platformAdminId: string;
};

export async function resolveRequestTenantContext(
  env: Env,
  board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>,
  request: Request,
  options: RequestTenantContextOptions = {}
): Promise<RequestTenantContext> {
  const supportToken = readPlatformSupportToken(request);
  if (supportToken) {
    const support = await tenantAuthDb.resolvePlatformSupportSessionByToken(env, supportToken);
    return {
      userId: `platform_admin:${support.session.adminId}`,
      activeTenantId: normalizeTenantIdStrict(support.session.tenantId),
      sessionToken: supportToken,
      platformAdminId: support.session.adminId,
      supportSessionId: support.session.id
    };
  }

  const sessionToken = readSessionToken(request);
  if (sessionToken) {
    const resolved = await tenantAuthDb.resolveSessionByToken(env, sessionToken);
    return {
      userId: resolved.user.id,
      activeTenantId: normalizeTenantIdStrict(resolved.session.activeTenantId),
      sessionId: resolved.session.id,
      sessionToken
    };
  }

  if (options.requireSession) {
    throw unauthorized('Missing auth session.');
  }

  const userId = request.headers.get('x-user-id')?.trim();
  const activeTenantId = request.headers.get('x-tenant-id')?.trim();
  if (!userId || !activeTenantId) {
    throw unauthorized('Missing auth session.');
  }
  return { userId, activeTenantId: normalizeTenantIdStrict(activeTenantId) };
}

export async function resolvePlatformAdminContext(
  env: Env,
  board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>,
  request: Request
): Promise<PlatformAdminContext> {
  const token = readPlatformAdminToken(request);
  if (!token) {
    throw unauthorized('Missing platform admin token.');
  }
  const resolved = await tenantAuthDb.resolvePlatformAdminByToken(env, token);
  return {
    platformAdminId: resolved.admin.id
  };
}

export async function requireActiveTenantAccess(
  env: Env,
  board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>,
  context: RequestTenantContext,
  tenantId = context.activeTenantId
) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (!context.userId) {
    throw unauthorized('Missing user identity.');
  }
  if (context.supportSessionId) {
    if (context.activeTenantId !== normalizedTenantId) {
      throw forbidden(`Support session only grants access to active tenant ${context.activeTenantId}.`);
    }
    return;
  }
  const hasAccess = await tenantAuthDb.hasActiveTenantAccess(env, normalizedTenantId, context.userId);
  if (!hasAccess) {
    throw forbidden(`User ${context.userId} does not have an active seat in tenant ${normalizedTenantId}.`);
  }
}

export async function requireOwnerTenantAccess(
  env: Env,
  board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>,
  context: RequestTenantContext,
  tenantId = context.activeTenantId
) {
  await requireActiveTenantAccess(env, board, context, tenantId);
  const membership = await tenantAuthDb.getTenantMembership(env, tenantId, context.userId);
  if (!membership || membership.role !== 'owner') {
    throw forbidden(`User ${context.userId} must be an owner of tenant ${normalizeTenantId(tenantId)}.`);
  }
}

async function assertRepoAccess(
  env: Env,
  board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>,
  context: RequestTenantContext,
  repoId: string
) {
  const repo = await board.getRepo(repoId);
  await requireActiveTenantAccess(env, board, context, repo.tenantId);
  if (repo.tenantId !== context.activeTenantId) {
    throw forbidden(`Cross-tenant access denied: repo ${repoId} belongs to tenant ${repo.tenantId}, active tenant is ${context.activeTenantId}.`);
  }
  return repo;
}

function readSessionToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')?.trim();
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) {
      return token;
    }
  }

  const headerToken = request.headers.get('x-session-token')?.trim();
  if (headerToken) {
    return headerToken;
  }

  const cookies = request.headers.get('cookie');
  if (!cookies) {
    return undefined;
  }

  for (const part of cookies.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === 'minions_session') {
      const token = rawValue.join('=').trim();
      return token || undefined;
    }
  }

  return undefined;
}

function readPlatformAdminToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')?.trim();
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) {
      return token;
    }
  }
  return request.headers.get('x-platform-admin-token')?.trim() || undefined;
}

function readPlatformSupportToken(request: Request): string | undefined {
  const headerToken = request.headers.get('x-support-session-token')?.trim();
  if (headerToken) {
    return headerToken;
  }
  return undefined;
}

function buildSessionCookie(token: string) {
  return `minions_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearSessionCookie() {
  return 'minions_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}
