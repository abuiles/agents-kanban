import { getSandbox } from '@cloudflare/sandbox';
import {
  badRequest,
  forbidden,
  notFound,
  unauthorized
} from './http/errors';
import { handleError, json } from './http/response';
import {
  parseAcceptTenantInviteInput,
  parseAuthLoginInput,
  parseStartRepoSentinelInput,
  parseCreateTenantInviteInput,
  parseCreateUserApiTokenInput,
  parseAuthSignupInput,
  parseCreateRepoInput,
  parseCreateReviewPlaybookInput,
  parseCreateTaskInput,
  parseCreateTenantInput,
  parseCreateTenantMemberInput,
  parsePlatformAuthLoginInput,
  parsePlatformSupportAssumeTenantInput,
  parseRetryRunInput,
  parseTakeOverRunInput,
  parseSetActiveTenantInput,
  parseRequestRunChangesInput,
  parseUpdateRepoSentinelConfigInput,
  parseUpdateRepoInput,
  parseUpdateReviewPlaybookInput,
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
import { getRepoHost, getRepoProjectPath, getRepoScmBaseUrl, getRunReviewProvider, hasRunReview } from '../shared/scm';
import * as tenantAuthDb from './tenant-auth-db';
import { DEFAULT_REPO_SENTINEL_CONFIG } from '../shared/sentinel';
import { SentinelController } from './sentinel';
import { buildRequestChangesPrompt, mergeReviewReplyContext, resolveRequestRunChangesSelection } from './request-changes';
import {
  handleSlackCommands as handleSlackCommandsHandler,
  handleSlackEvents as handleSlackEventsHandler,
  handleSlackInteractions as handleSlackInteractionsHandler
} from './integrations/slack/handlers';
import { handleGitlabWebhook as handleGitlabWebhookHandler } from './integrations/gitlab/handlers';
import { handleGithubWebhook as handleGithubWebhookHandler } from './integrations/github/handlers';
import { listGithubReplyContextHints } from './integrations/github/reply-context-store';
import type { AutoReviewProvider, Repo, SandboxRole, SentinelRun } from '../ui/domain/types';
import { getScmAdapter } from './scm/registry';
import { getReviewPostingAdapter } from './review-posting/registry';
import type { ReviewReplyContext } from './review-posting/adapter';

const BOARD_OBJECT_NAME = 'agentboard';

type RouteParams = {
  tenantId?: string;
  memberId?: string;
  inviteId?: string;
  tokenId?: string;
  repoId?: string;
  provider?: 'github' | 'gitlab';
  credentialId?: string;
  taskId?: string;
  runId?: string;
  playbookId?: string;
};

function withApiError(task: () => Promise<Response>): Promise<Response> {
  return task().catch(handleError);
}

function getBoard(env: Env) {
  return env.BOARD_INDEX.getByName(BOARD_OBJECT_NAME);
}

async function resolveTenantContextFromRequest(env: Env, request: Request, options: { requireSession?: boolean } = {}) {
  const board = getBoard(env);
  const requestContext = await resolveRequestTenantContext(env, board, request, options);
  return { board, requestContext };
}

function parsePathParam(value: string | undefined) {
  return decodeURIComponent(value ?? '');
}

function normalizeTagFilters(searchParams: URLSearchParams) {
  const values = [
    ...searchParams.getAll('tag'),
    ...searchParams.getAll('tags').flatMap((value) => value.split(','))
  ];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags;
}

function isReviewOnlyTask(task: { tags?: string[] }) {
  return (task.tags ?? []).includes('review_only');
}

function resolveReviewOnlyRunMode(task: { tags?: string[] }): 'review_only' | 'full_run' {
  return isReviewOnlyTask(task) ? 'review_only' : 'full_run';
}

function buildCanonicalReviewUrl(repo: Repo, reviewProvider: 'github' | 'gitlab', reviewNumber: number) {
  const origin = getRepoScmBaseUrl(repo);
  const projectPath = getRepoProjectPath(repo);
  return reviewProvider === 'github'
    ? `${origin}/${projectPath}/pull/${reviewNumber}`
    : `${origin}/${projectPath}/-/merge_requests/${reviewNumber}`;
}

function resolveReviewOnlyRunPatch(task: { sourceRef?: string }, repo: Repo) {
  const sourceRef = task.sourceRef?.trim();
  if (!sourceRef) {
    throw badRequest('Review-only tasks require sourceRef to point to an existing pull/merge request.');
  }

  const normalizedSourceRef = getScmAdapter(repo).normalizeSourceRef(sourceRef, repo);
  if (normalizedSourceRef.kind !== 'review_head') {
    throw badRequest('Review-only tasks require sourceRef to resolve to a review head ref.');
  }

  const reviewProvider = normalizedSourceRef.reviewProvider ?? repo.scmProvider;
  if (reviewProvider !== 'github' && reviewProvider !== 'gitlab') {
    throw badRequest('Review-only tasks require github or gitlab review provider metadata.');
  }

  const reviewNumber = normalizedSourceRef.reviewNumber;
  const reviewUrl = sourceRef.startsWith('http://') || sourceRef.startsWith('https://')
    ? sourceRef
    : buildCanonicalReviewUrl(repo, reviewProvider, reviewNumber);

  return {
    status: 'PR_OPEN' as const,
    branchName: normalizedSourceRef.value,
    reviewProvider,
    reviewNumber,
    reviewUrl,
    prNumber: reviewNumber,
    prUrl: reviewUrl
  };
}

export async function handleSlackCommands(request: Request, env: Env, ctx: ExecutionContext<unknown>): Promise<Response> {
  return handleSlackCommandsHandler(request, env, ctx);
}

export async function handleSlackEvents(request: Request, env: Env): Promise<Response> {
  return handleSlackEventsHandler(request, env);
}

export async function handleSlackInteractions(request: Request, env: Env, ctx: ExecutionContext<unknown>): Promise<Response> {
  return handleSlackInteractionsHandler(request, env, ctx);
}

export async function handleGitlabWebhook(request: Request, env: Env): Promise<Response> {
  return handleGitlabWebhookHandler(request, env);
}

export async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  return handleGithubWebhookHandler(request, env);
}

export async function handleAuthSignup(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
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
      session: toPublicSession(result.session),
      activeTenantId: result.activeTenantId,
      memberships: result.memberships
    }, { status: 201 });
    response.headers.append('Set-Cookie', buildSessionCookie(request, result.token));
    return response;
  });
}

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const input = parseAuthLoginInput(await readJson(request));
    const result = await tenantAuthDb.login(env, input);
    const response = json({
      user: result.user,
      session: toPublicSession(result.session),
      activeTenantId: result.activeTenantId,
      memberships: result.memberships
    });
    response.headers.append('Set-Cookie', buildSessionCookie(request, result.token));
    return response;
  });
}

export async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    if (requestContext.sessionId) {
      await tenantAuthDb.logout(env, requestContext.sessionId);
    }
    const response = json({ ok: true });
    response.headers.append('Set-Cookie', clearSessionCookie(request));
    return response;
  });
}

export async function handlePlatformAuthLogin(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const input = parsePlatformAuthLoginInput(await readJson(request));
    const result = await tenantAuthDb.platformLogin(env, input);
    return json(result);
  });
}

export async function handleSupportReleaseTenant(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const platformContext = await resolvePlatformAdminContext(env, board, request);
    const supportToken = readPlatformSupportToken(request);
    if (!supportToken) {
      throw unauthorized('Missing support session token.');
    }
    const released = await tenantAuthDb.releasePlatformSupportSession(env, supportToken, platformContext.platformAdminId);
    return json(released);
  });
}

export async function handleSupportSessions(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const platformContext = await resolvePlatformAdminContext(env, board, request);
    return json(await tenantAuthDb.listPlatformSupportSessions(env, platformContext.platformAdminId));
  });
}

export async function handlePlatformAuditLog(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const platformContext = await resolvePlatformAdminContext(env, board, request);
    return json(await tenantAuthDb.listSecurityAuditLog(env, platformContext.platformAdminId));
  });
}

export async function handleSupportAssumeTenant(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const platformContext = await resolvePlatformAdminContext(env, board, request);
    const input = parsePlatformSupportAssumeTenantInput(await readJson(request));
    const result = await tenantAuthDb.createPlatformSupportSession(env, {
      adminId: platformContext.platformAdminId,
      tenantId: input.tenantId,
      reason: input.reason,
      ttlMinutes: input.ttlMinutes
    });
    return json(result, { status: 201 });
  });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const { requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
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
  });
}

export async function handleSetTenantContext(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const { requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
    if (!requestContext.sessionId) {
      throw unauthorized('Tenant context switching requires an auth session.');
    }
    const { tenantId } = parseSetActiveTenantInput(await readJson(request));
    const session = await tenantAuthDb.setSessionActiveTenant(env, requestContext.sessionId, tenantId);
    const response = json({ activeTenantId: session.activeTenantId, session: toPublicSession(session) });
    if (requestContext.sessionToken) {
      response.headers.append('Set-Cookie', buildSessionCookie(request, requestContext.sessionToken));
    }
    return response;
  });
}

export async function handleListTenants(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const { requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
    return json(await tenantAuthDb.listTenantsForUser(env, requestContext.userId));
  });
}

export async function handleCreateTenant(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const { requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
    const input = parseCreateTenantInput(await readJson(request));
    return json(await tenantAuthDb.createTenant(env, input, requestContext.userId), { status: 201 });
  });
}

export async function handleGetTenant(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = parsePathParam(params.tenantId);
    await requireActiveTenantAccess(env, board, requestContext, tenantId);
    return json(await tenantAuthDb.getTenant(env, tenantId));
  });
}

export async function handleListTenantMembers(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = parsePathParam(params.tenantId);
    await requireActiveTenantAccess(env, board, requestContext, tenantId);
    return json({
      members: await tenantAuthDb.listTenantMembers(env, tenantId),
      seatSummary: await tenantAuthDb.getTenantSeatSummary(env, tenantId)
    });
  });
}

export async function handleCreateTenantMember(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = parsePathParam(params.tenantId);
    const input = parseCreateTenantMemberInput(await readJson(request));
    await requireOwnerTenantAccess(env, board, requestContext, tenantId);
    return json(await tenantAuthDb.createTenantMember(env, tenantId, input, requestContext.userId), { status: 201 });
  });
}

export async function handleCreateTenantInvite(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = parsePathParam(params.tenantId);
    const input = parseCreateTenantInviteInput(await readJson(request));
    await requireOwnerTenantAccess(env, board, requestContext, tenantId);
    return json(await tenantAuthDb.createTenantInvite(env, tenantId, input, requestContext.userId), { status: 201 });
  });
}

export async function handleCreateInvite(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const input = parseCreateTenantInviteInput(await readJson(request));
    await requireOwnerTenantAccess(env, board, requestContext);
    return json(await tenantAuthDb.createTenantInvite(env, requestContext.activeTenantId, input, requestContext.userId), { status: 201 });
  });
}

export async function handleListTenantInvites(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = parsePathParam(params.tenantId);
    await requireOwnerTenantAccess(env, board, requestContext, tenantId);
    return json(await tenantAuthDb.listTenantInvites(env, tenantId, requestContext.userId));
  });
}

export async function handleListInvites(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    return json(await tenantAuthDb.listTenantInvites(env, requestContext.activeTenantId, requestContext.userId));
  });
}

export async function handleAcceptInvite(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const body = parseAcceptTenantInviteInput(await readJson(request));
    const inviteId = parsePathParam(params.inviteId);
    const resolvedInvite = await tenantAuthDb.resolvePendingTenantInviteByToken(env, body.token);
    if (resolvedInvite.invite.id !== inviteId) {
      throw forbidden('Invite token does not match requested invite id.');
    }
    const signup = await tenantAuthDb.signup(env, {
      email: resolvedInvite.invite.email,
      password: body.password,
      displayName: body.displayName,
      tenant: { name: 'Local deployment' }
    });
    const accepted = await tenantAuthDb.acceptTenantInvite(env, body.token, signup.user.id);
    const response = json({
      user: signup.user,
      session: toPublicSession(signup.session),
      activeTenantId: signup.activeTenantId,
      memberships: [accepted.membership],
      invite: accepted.invite
    }, { status: 201 });
    response.headers.append('Set-Cookie', buildSessionCookie(request, signup.token));
    return response;
  });
}

export async function handleCreateApiToken(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const { board, requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const input = parseCreateUserApiTokenInput(await readJson(request));
    return json(await tenantAuthDb.createUserApiToken(env, requestContext.userId, input), { status: 201 });
  });
}

export async function handleListApiTokens(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const { board, requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    return json(await tenantAuthDb.listUserApiTokens(env, requestContext.userId));
  });
}

export async function handleDeleteApiToken(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const { board, requestContext } = await resolveTenantContextFromRequest(env, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const tokenId = parsePathParam(params.tokenId);
    return json(await tenantAuthDb.revokeUserApiToken(env, requestContext.userId, tokenId));
  });
}

export async function handleUpdateTenantMember(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = parsePathParam(params.tenantId);
    const memberId = parsePathParam(params.memberId);
    const patch = parseUpdateTenantMemberInput(await readJson(request));
    await requireOwnerTenantAccess(env, board, requestContext, tenantId);
    return json(await tenantAuthDb.updateTenantMember(env, tenantId, memberId, patch, requestContext.userId));
  });
}

export async function handleBoard(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const repoId = url.searchParams.get('repoId') ?? 'all';
    if (repoId !== 'all') {
      await assertRepoAccess(env, board, requestContext, repoId);
    }
    return json(await board.getBoardSync(repoId, requestContext.activeTenantId));
  });
}

export async function handleBoardWs(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const repoId = url.searchParams.get('repoId');
    if (repoId && repoId !== 'all') {
      await assertRepoAccess(env, board, requestContext, repoId);
    }
    const wsUrl = new URL(request.url);
    wsUrl.searchParams.set('tenantId', requestContext.activeTenantId);
    wsUrl.searchParams.set('repoId', repoId ?? 'all');
    return board.fetch(new Request(wsUrl.toString(), request));
  });
}

export async function handleListRepos(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    return json(await board.listRepos(requestContext.activeTenantId));
  });
}

export async function handleListReviewPlaybooks(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    return json(await board.listReviewPlaybooks(requestContext.activeTenantId));
  });
}

export async function handleCreateReviewPlaybook(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const input = parseCreateReviewPlaybookInput(await readJson(request));
    return json(await board.createReviewPlaybook({ tenantId: requestContext.activeTenantId, ...input }), { status: 201 });
  });
}

export async function handleUpdateReviewPlaybook(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const playbookId = parsePathParam(params.playbookId);
    const patch = parseUpdateReviewPlaybookInput(await readJson(request));
    return json(await board.updateReviewPlaybook(playbookId, patch, requestContext.activeTenantId));
  });
}

export async function handleDeleteReviewPlaybook(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const playbookId = parsePathParam(params.playbookId);
    return json(await board.deleteReviewPlaybook(playbookId, requestContext.activeTenantId));
  });
}

export async function handleCreateRepo(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const input = parseCreateRepoInput(await readJson(request));
    const tenantId = normalizeTenantId(input.tenantId ?? requestContext.activeTenantId);
    await requireActiveTenantAccess(env, board, requestContext, tenantId);
    if (input.autoReview?.playbookId) {
      await assertReviewPlaybookAccess(board, tenantId, input.autoReview.playbookId);
    }
    return json(await board.createRepo({ ...input, tenantId }), { status: 201 });
  });
}

export async function handleUpdateRepo(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const patch = parseUpdateRepoInput(await readJson(request));
    if (patch.tenantId && normalizeTenantId(patch.tenantId) !== repo.tenantId) {
      throw forbidden('Repo tenantId cannot be changed.');
    }
    if (patch.autoReview?.playbookId) {
      await assertReviewPlaybookAccess(board, repo.tenantId ?? requestContext.activeTenantId, patch.autoReview.playbookId);
    }
    return json(await board.updateRepo(repoId, patch));
  });
}

function mergeRepoSentinelConfig(
  base: typeof DEFAULT_REPO_SENTINEL_CONFIG,
  patch: {
    enabled?: boolean;
    globalMode?: boolean;
    defaultGroupTag?: string;
    reviewGate?: Partial<(typeof DEFAULT_REPO_SENTINEL_CONFIG)['reviewGate']>;
    mergePolicy?: Partial<(typeof DEFAULT_REPO_SENTINEL_CONFIG)['mergePolicy']>;
    conflictPolicy?: Partial<(typeof DEFAULT_REPO_SENTINEL_CONFIG)['conflictPolicy']>;
  }
) {
  return {
    ...base,
    ...patch,
    reviewGate: {
      ...base.reviewGate,
      ...(patch.reviewGate ?? {})
    },
    mergePolicy: {
      ...base.mergePolicy,
      ...(patch.mergePolicy ?? {})
    },
    conflictPolicy: {
      ...base.conflictPolicy,
      ...(patch.conflictPolicy ?? {})
    }
  };
}

async function getLatestRepoSentinelRun(env: Env, tenantId: string, repoId: string) {
  const runs = await tenantAuthDb.listSentinelRuns(env, tenantId, { repoId });
  return runs[0];
}

async function buildRepoSentinelState(env: Env, tenantId: string, repoId: string) {
  const [run, events] = await Promise.all([
    getLatestRepoSentinelRun(env, tenantId, repoId),
    tenantAuthDb.listSentinelEvents(env, tenantId, { repoId, limit: 20 })
  ]);
  const latestEvent = events[0];
  const latestErrorEvent = events.find((event) => event.level === 'error');
  const latestWarningEvent = events.find((event) => event.level === 'warn');
  return {
    run,
    events,
    diagnostics: {
      latestEvent,
      latestErrorEvent,
      latestWarningEvent
    }
  };
}

export async function handleGetRepoSentinel(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const state = await buildRepoSentinelState(env, requestContext.activeTenantId, repoId);
    return json({
      repoId,
      config: repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG,
      ...state
    });
  });
}

export async function handlePatchRepoSentinelConfig(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const patch = parseUpdateRepoSentinelConfigInput(await readJson(request));
    const merged = mergeRepoSentinelConfig(repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG, patch);
    const [savedConfig, updatedRepo] = await Promise.all([
      tenantAuthDb.upsertRepoSentinelConfig(env, {
        tenantId: requestContext.activeTenantId,
        repoId,
        config: merged
      }),
      board.updateRepo(repoId, { sentinelConfig: merged })
    ]);
    const state = await buildRepoSentinelState(env, requestContext.activeTenantId, repoId);
    return json({
      repoId,
      config: savedConfig,
      repo: updatedRepo,
      ...state
    });
  });
}

async function transitionRepoSentinelRun(
  env: Env,
  tenantId: string,
  repoId: string,
  action: 'start' | 'pause' | 'resume' | 'stop',
  options?: { scopeType?: 'group' | 'global'; scopeValue?: string }
) {
  const current = await getLatestRepoSentinelRun(env, tenantId, repoId);
  const now = new Date().toISOString();
  let changed = false;
  let run = current;
  let eventType: Parameters<typeof tenantAuthDb.appendSentinelEvent>[1]['type'] | undefined;
  let eventMessage: string | undefined;

  if (action === 'start') {
    if (!current) {
      run = await tenantAuthDb.createSentinelRun(env, {
        tenantId,
        repoId,
        scopeType: options?.scopeType ?? 'global',
        scopeValue: options?.scopeValue,
        status: 'running',
        startedAt: now,
        updatedAt: now
      });
      changed = true;
      eventType = 'sentinel.started';
      eventMessage = `Sentinel started for ${repoId}.`;
    } else if (current.status === 'paused') {
      run = await tenantAuthDb.updateSentinelRun(env, tenantId, current.id, { status: 'running', updatedAt: now });
      changed = true;
      eventType = 'sentinel.resumed';
      eventMessage = `Sentinel resumed for ${repoId}.`;
    } else if (current.status !== 'running') {
      run = await tenantAuthDb.createSentinelRun(env, {
        tenantId,
        repoId,
        scopeType: options?.scopeType ?? current.scopeType,
        scopeValue: options?.scopeValue ?? current.scopeValue,
        status: 'running',
        startedAt: now,
        updatedAt: now
      });
      changed = true;
      eventType = 'sentinel.started';
      eventMessage = `Sentinel started for ${repoId}.`;
    }
  } else if (action === 'pause' && current && current.status === 'running') {
    run = await tenantAuthDb.updateSentinelRun(env, tenantId, current.id, { status: 'paused', updatedAt: now });
    changed = true;
    eventType = 'sentinel.paused';
    eventMessage = `Sentinel paused for ${repoId}.`;
  } else if (action === 'resume' && current && current.status === 'paused') {
    run = await tenantAuthDb.updateSentinelRun(env, tenantId, current.id, { status: 'running', updatedAt: now });
    changed = true;
    eventType = 'sentinel.resumed';
    eventMessage = `Sentinel resumed for ${repoId}.`;
  } else if (action === 'stop' && current && (current.status === 'running' || current.status === 'paused')) {
    run = await tenantAuthDb.updateSentinelRun(env, tenantId, current.id, {
      status: 'stopped',
      currentTaskId: undefined,
      currentRunId: undefined,
      updatedAt: now
    });
    changed = true;
    eventType = 'sentinel.stopped';
    eventMessage = `Sentinel stopped for ${repoId}.`;
  }

  if (changed && run && eventType && eventMessage) {
    await tenantAuthDb.appendSentinelEvent(env, {
      tenantId,
      repoId,
      sentinelRunId: run.id,
      type: eventType,
      level: 'info',
      message: eventMessage,
      at: now
    });
  }

  return {
    run,
    changed
  };
}

async function progressRepoSentinel(
  env: Env,
  tenantId: string,
  repoId: string,
  run: SentinelRun | undefined,
  ctx: ExecutionContext<unknown>,
  repo: Repo
) {
  if (!run || run.status !== 'running') {
    return run;
  }
  const leaseToken = `sentinel_lease_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`;
  const leasedRun = await tenantAuthDb.acquireSentinelRunLease(env, tenantId, run.id, { leaseToken, ttlSeconds: 30 });
  if (!leasedRun) {
    return run;
  }
  const board = env.REPO_BOARD.getByName(repoId);
  const controller = new SentinelController({
    env,
    tenantId,
    repo: repo as Repo,
    repoId,
    scmAdapter: getScmAdapter(repo),
    run: leasedRun,
    board: {
      listTasks: async (tenantIdOverride?: string, options?: { tags?: string[] }) => {
        return board.listTasks(tenantIdOverride, options);
      },
      getTask: async (taskId: string, tenantIdOverride?: string) => {
        return board.getTask(taskId, tenantIdOverride);
      },
      startRun: async (taskId: string, options?: { tenantId?: string }) => {
        return board.startRun(taskId, options);
      },
      transitionRun: async (runId, patch) => {
        return board.transitionRun(runId, patch);
      },
      updateTask: async (taskId, patch) => {
        return board.updateTask(taskId, patch);
      }
    },
    executionContext: ctx
  });
  try {
    const progressed = await controller.progress();
    return progressed.run;
  } finally {
    await tenantAuthDb.releaseSentinelRunLease(env, tenantId, leasedRun.id, leaseToken);
  }
}

export async function handleStartRepoSentinel(
  request: Request,
  env: Env,
  params: RouteParams,
  ctx: ExecutionContext<unknown> = {} as unknown as ExecutionContext<unknown>
): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    if (!repo.sentinelConfig?.enabled) {
      throw badRequest('Sentinel is disabled for this repo. Enable repo sentinel config first.');
    }
    const body = await readJson(request).catch(() => ({}));
    const input = parseStartRepoSentinelInput(body);
    const scopeType = input.scopeType ?? (repo.sentinelConfig?.globalMode ? 'global' : 'group');
    const scopeValue = scopeType === 'group'
      ? (input.scopeValue ?? repo.sentinelConfig?.defaultGroupTag)
      : undefined;
    const transition = await transitionRepoSentinelRun(env, requestContext.activeTenantId, repoId, 'start', { scopeType, scopeValue });
    await progressRepoSentinel(env, requestContext.activeTenantId, repoId, transition.run, ctx, repo);
    const state = await buildRepoSentinelState(env, requestContext.activeTenantId, repoId);
    return json({
      repoId,
      config: repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG,
      ...transition,
      ...state
    });
  });
}

export async function handlePauseRepoSentinel(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const transition = await transitionRepoSentinelRun(env, requestContext.activeTenantId, repoId, 'pause');
    const state = await buildRepoSentinelState(env, requestContext.activeTenantId, repoId);
    return json({
      repoId,
      config: repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG,
      ...transition,
      ...state
    });
  });
}

export async function handleResumeRepoSentinel(
  request: Request,
  env: Env,
  params: RouteParams,
  ctx: ExecutionContext<unknown> = {} as unknown as ExecutionContext<unknown>
): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    if (!repo.sentinelConfig?.enabled) {
      throw badRequest('Sentinel is disabled for this repo. Enable repo sentinel config first.');
    }
    const transition = await transitionRepoSentinelRun(env, requestContext.activeTenantId, repoId, 'resume');
    await progressRepoSentinel(env, requestContext.activeTenantId, repoId, transition.run, ctx, repo);
    const state = await buildRepoSentinelState(env, requestContext.activeTenantId, repoId);
    return json({
      repoId,
      config: repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG,
      ...transition,
      ...state
    });
  });
}

export async function handleStopRepoSentinel(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const transition = await transitionRepoSentinelRun(env, requestContext.activeTenantId, repoId, 'stop');
    const state = await buildRepoSentinelState(env, requestContext.activeTenantId, repoId);
    return json({
      repoId,
      config: repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG,
      ...transition,
      ...state
    });
  });
}

export async function handleListRepoSentinelEvents(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const repoId = parsePathParam(params.repoId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (typeof limit !== 'undefined' && (!Number.isInteger(limit) || limit <= 0)) {
      throw badRequest('Invalid limit.');
    }
    const events = await tenantAuthDb.listSentinelEvents(env, requestContext.activeTenantId, {
      repoId,
      ...(typeof limit === 'number' ? { limit } : {})
    });
    return json(events);
  });
}

export async function handleListScmCredentials(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    return json(await board.listScmCredentials());
  });
}

export async function handleUpsertScmCredential(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    return json(await board.upsertScmCredential(parseUpsertScmCredentialInput(await readJson(request))), { status: 201 });
  });
}

export async function handleGetScmCredential(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    const provider = parsePathParam(params.provider) as 'github' | 'gitlab';
    const credentialId = parsePathParam(params.credentialId);
    const credential = await board.getScmCredential(provider, credentialId);
    if (!credential) {
      throw notFound(`SCM credential ${provider}:${credentialId} not found.`);
    }
    return json(credential);
  });
}

export async function handleListTasks(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireActiveTenantAccess(env, board, requestContext);
    const repoId = url.searchParams.get('repoId');
    const tags = normalizeTagFilters(url.searchParams);
    if (!repoId || repoId === 'all') {
      const tasks = (await board.getBoardSync('all', requestContext.activeTenantId)).tasks;
      if (!tags.length) {
        return json(tasks);
      }
      return json(tasks.filter((task) => tags.every((tag) => task.tags?.includes(tag))));
    }
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).listTasks(requestContext.activeTenantId, { tags }));
  });
}

export async function handleCreateTask(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const input = parseCreateTaskInput(await readJson(request));
    const repo = await assertRepoAccess(env, board, requestContext, input.repoId);
    if (input.autoReviewPlaybookId) {
      await assertReviewPlaybookAccess(board, repo.tenantId ?? requestContext.activeTenantId, input.autoReviewPlaybookId);
    }
    return json(await env.REPO_BOARD.getByName(input.repoId).createTask(input), { status: 201 });
  });
}

export async function handleTenantUsageSummary(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = url.searchParams.get('tenantId') ?? requestContext.activeTenantId;
    await requireActiveTenantAccess(env, board, requestContext, tenantId);
    return json(await getTenantUsageSummary(url, env));
  });
}

export async function handleTenantRunUsage(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const tenantId = url.searchParams.get('tenantId') ?? requestContext.activeTenantId;
    await requireActiveTenantAccess(env, board, requestContext, tenantId);
    return json(await getTenantRunUsage(url, env));
  });
}

export async function handleGetTask(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const taskId = parsePathParam(params.taskId);
    const repoId = await resolveRepoIdForTask(board, taskId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).getTask(taskId, requestContext.activeTenantId));
  });
}

export async function handleGetTaskCheckpoints(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const taskId = parsePathParam(params.taskId);
    const repoId = await resolveRepoIdForTask(board, taskId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const latest = url.searchParams.get('latest') === 'true';
    return json(await env.REPO_BOARD.getByName(repoId).getTaskCheckpoints(taskId, { latest, tenantId: requestContext.activeTenantId }));
  });
}

export async function handleUpdateTask(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const taskId = parsePathParam(params.taskId);
    const repoId = await resolveRepoIdForTask(board, taskId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const patch = parseUpdateTaskInput(await readJson(request));
    if (patch.autoReviewPlaybookId) {
      await assertReviewPlaybookAccess(board, repo.tenantId ?? requestContext.activeTenantId, patch.autoReviewPlaybookId);
    }
    return json(await env.REPO_BOARD.getByName(repoId).updateTask(taskId, patch, requestContext.activeTenantId));
  });
}

export async function handleDeleteTask(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const taskId = parsePathParam(params.taskId);
    const repoId = await resolveRepoIdForTask(board, taskId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).deleteTask(taskId, requestContext.activeTenantId));
  });
}

export async function handleRunTask(request: Request, env: Env, params: RouteParams, ctx: ExecutionContext<unknown>): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const taskId = parsePathParam(params.taskId);
    const repoId = await resolveRepoIdForTask(board, taskId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const repoBoard = env.REPO_BOARD.getByName(repoId);
    const taskDetail = await repoBoard.getTask(taskId, requestContext.activeTenantId);
    const mode = resolveReviewOnlyRunMode(taskDetail.task);
    const run = await repoBoard.startRun(taskId, { tenantId: requestContext.activeTenantId });
    if (mode === 'review_only') {
      await repoBoard.transitionRun(run.runId, resolveReviewOnlyRunPatch(taskDetail.task, repo), requestContext.activeTenantId);
    }
    const workflow = await scheduleRunJob(env, ctx as unknown as ExecutionContext, {
      tenantId: requestContext.activeTenantId,
      repoId,
      taskId,
      runId: run.runId,
      mode
    });
    await repoBoard.transitionRun(run.runId, {
      workflowInstanceId: workflow.id,
      orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
    }, requestContext.activeTenantId);
    return json(await repoBoard.getRun(run.runId, requestContext.activeTenantId));
  });
}

export async function handleGetRun(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).getRun(runId, requestContext.activeTenantId));
  });
}

export async function handleGetRunCheckpoints(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).getRunCheckpoints(runId, requestContext.activeTenantId));
  });
}

export async function handleRetryRun(request: Request, env: Env, params: RouteParams, ctx: ExecutionContext<unknown>): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const repoBoard = env.REPO_BOARD.getByName(repoId);
    const run = await repoBoard.getRun(runId, requestContext.activeTenantId);
    const taskDetail = await repoBoard.getTask(run.taskId, requestContext.activeTenantId);
    const mode = resolveReviewOnlyRunMode(taskDetail.task);
    const retryInput = parseRetryRunInput(await readJson(request).catch(() => ({})));
    const targetRun = mode === 'review_only'
      ? run
      : await repoBoard.retryRun(runId, {
        tenantId: requestContext.activeTenantId,
        ...retryInput
      });

    if (mode === 'review_only' && !hasRunReview(run)) {
      throw badRequest('Manual review rerun requires an existing review context on this run.');
    }
    if (mode === 'review_only' && run.reviewExecution?.status === 'running') {
      return json(run);
    }

    const workflow = await scheduleRunJob(env, ctx as unknown as ExecutionContext, {
      tenantId: requestContext.activeTenantId,
      repoId,
      taskId: targetRun.taskId,
      runId: targetRun.runId,
      mode
    });
    await repoBoard.transitionRun(targetRun.runId, {
      workflowInstanceId: workflow.id,
      orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow',
      ...(mode === 'review_only' ? { appendTimelineNote: 'Manual review rerun queued from retry.' } : {})
    });
    return json(await repoBoard.getRun(targetRun.runId, requestContext.activeTenantId));
  });
}

export async function handleRerunReview(request: Request, env: Env, params: RouteParams, ctx: ExecutionContext<unknown>): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const repoBoard = env.REPO_BOARD.getByName(repoId);
    const run = await repoBoard.getRun(runId, requestContext.activeTenantId);
    if (!hasRunReview(run)) {
      throw badRequest('Manual review rerun requires an existing review context on this run.');
    }
    if (run.reviewExecution?.status === 'running') {
      return json(run);
    }

    const workflow = await scheduleRunJob(env, ctx as unknown as ExecutionContext, {
      tenantId: requestContext.activeTenantId,
      repoId,
      taskId: run.taskId,
      runId,
      mode: 'review_only'
    });
    await repoBoard.transitionRun(run.runId, {
      workflowInstanceId: workflow.id,
      orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow',
      appendTimelineNote: 'Manual review rerun queued.'
    });
    return json(await repoBoard.getRun(run.runId, requestContext.activeTenantId));
  });
}

export async function handleCancelRun(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
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
  });
}

export async function handleRequestChanges(request: Request, env: Env, params: RouteParams, ctx: ExecutionContext<unknown>): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const body = parseRequestRunChangesInput(await readJson(request));
    const repoId = await resolveRepoIdForRun(board, runId);
    const repo = await assertRepoAccess(env, board, requestContext, repoId);
    const repoBoard = env.REPO_BOARD.getByName(repoId);
    const existingRun = await repoBoard.getRun(runId, requestContext.activeTenantId);
    const taskDetail = await repoBoard.getTask(existingRun.taskId, requestContext.activeTenantId);
    const mode = resolveReviewOnlyRunMode(taskDetail.task);
    const selection = resolveRequestRunChangesSelection({
      findings: existingRun.reviewFindings ?? [],
      reviewSelection: body.reviewSelection
    });
    const selectedFindingIds = new Set(selection?.selectedFindingIds);
    const selectedFindings = existingRun.reviewFindings?.filter(
      (finding) => finding.status === 'open' && selectedFindingIds.has(finding.findingId)
    ) ?? [];
    let replyContext;
    if (selection?.includeReplies && selectedFindings.length) {
      const reviewProvider = getRunReviewProvider(existingRun) as AutoReviewProvider | undefined;
      if (reviewProvider !== 'github' && reviewProvider !== 'gitlab' && reviewProvider !== 'jira') {
        throw badRequest('Cannot include replies for this review provider.');
      }
      if (!repo.scmProvider) {
        throw badRequest('Cannot include replies without SCM provider metadata for this repo.');
      }
      const token = await board.getScmCredentialSecret(repo.scmProvider, getRepoHost(repo));
      if (!token) {
        throw badRequest(`No SCM credential found for ${repo.scmProvider} host ${getRepoHost(repo)}.`);
      }
      const taskDetail = await repoBoard.getTask(existingRun.taskId, requestContext.activeTenantId);
      const fetchedReplyContext = await getReviewPostingAdapter(reviewProvider).fetchReplyContext({
        repo,
        task: taskDetail.task,
        run: existingRun,
        credential: { token },
        findingIds: selection.selectedFindingIds
      });

      if (reviewProvider === 'github') {
        const reviewNumber = existingRun.reviewNumber ?? existingRun.prNumber;
        const storedHints = reviewNumber
          ? await listGithubReplyContextHints({
            env,
            tenantId: requestContext.activeTenantId,
            projectPath: getRepoProjectPath(repo),
            reviewNumber,
            findingIds: selection.selectedFindingIds
          })
          : {};
        const persistedReplyContext = Object.entries(storedHints).reduce<ReviewReplyContext>((output, [findingId, hints]) => {
          const bodies = hints.map((hint) => hint.body.trim()).filter(Boolean);
          if (bodies.length) {
            output[findingId] = bodies;
          }
          return output;
        }, {});
        replyContext = mergeReviewReplyContext({
          findingIds: selection.selectedFindingIds,
          sources: [persistedReplyContext, fetchedReplyContext]
        });
      } else {
        replyContext = mergeReviewReplyContext({
          findingIds: selection.selectedFindingIds,
          sources: [fetchedReplyContext]
        });
      }
    }

    const prompt = buildRequestChangesPrompt({
      operatorPrompt: body.prompt,
      selection,
      selectedFindings,
      replyContext
    });
    const run = await repoBoard.requestRunChanges(
      runId,
      {
        prompt,
        ...(selection ? { selection } : {})
      },
      requestContext.activeTenantId
    );
    const workflow = await scheduleRunJob(env, ctx as unknown as ExecutionContext, {
      tenantId: requestContext.activeTenantId,
      repoId,
      taskId: run.taskId,
      runId: run.runId,
      mode
    });
    await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
      workflowInstanceId: workflow.id,
      orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
    });
    return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId, requestContext.activeTenantId));
  });
}

export async function handleRetryEvidence(request: Request, env: Env, params: RouteParams, ctx: ExecutionContext<unknown>): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const run = await env.REPO_BOARD.getByName(repoId).retryEvidence(runId, requestContext.activeTenantId);
    const workflow = await scheduleRunJob(env, ctx as unknown as ExecutionContext, {
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
  });
}

export async function handleRetryPreview(request: Request, env: Env, params: RouteParams, ctx: ExecutionContext<unknown>): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const run = await env.REPO_BOARD.getByName(repoId).retryPreview(runId, requestContext.activeTenantId);
    const workflow = await scheduleRunJob(env, ctx as unknown as ExecutionContext, {
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
  });
}

export async function handleGetRunLogs(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const tail = url.searchParams.get('tail');
    return json(await env.REPO_BOARD.getByName(repoId).getRunLogs(runId, tail ? Number(tail) : undefined, requestContext.activeTenantId));
  });
}

export async function handleGetRunUsage(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await getRunUsage(runId, env));
  });
}

export async function handleGetRunEvents(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).getRunEvents(runId, requestContext.activeTenantId));
  });
}

export async function handleGetRunCommands(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).getRunCommands(runId, requestContext.activeTenantId));
  });
}

export async function handleGetRunTerminal(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const sandboxRole = parseSandboxRoleQuery(url.searchParams.get('sandboxRole'));
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const bootstrap = await env.REPO_BOARD.getByName(repoId).getTerminalBootstrap(runId, requestContext.activeTenantId, sandboxRole);
    if (!bootstrap.attachable) {
      return json(bootstrap, { status: 409 });
    }
    return json(bootstrap);
  });
}

export async function handleGetRunWs(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const url = new URL(request.url);
    const sandboxRole = parseSandboxRoleQuery(url.searchParams.get('sandboxRole'));
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const bootstrap = await env.REPO_BOARD.getByName(repoId).getTerminalBootstrap(runId, requestContext.activeTenantId, sandboxRole);
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
      sandboxRole,
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
  });
}

export async function handleGetRunArtifacts(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    return json(await env.REPO_BOARD.getByName(repoId).getRunArtifacts(runId, requestContext.activeTenantId));
  });
}

export async function handleTakeoverRun(request: Request, env: Env, params: RouteParams): Promise<Response> {
  return withApiError(async () => {
    const input = parseTakeOverRunInput(await readOptionalJson(request));
    const sandboxRole = input.sandboxRole ?? 'main';
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    const runId = parsePathParam(params.runId);
    const repoId = await resolveRepoIdForRun(board, runId);
    await assertRepoAccess(env, board, requestContext, repoId);
    const repoBoard = env.REPO_BOARD.getByName(repoId);
    const run = await repoBoard.getRun(runId, requestContext.activeTenantId);
    const selectedSandboxId = sandboxRole === 'review' ? run.reviewSandboxId : run.sandboxId;
    if (selectedSandboxId && run.codexProcessId) {
      const sandbox = getSandbox(env.Sandbox, selectedSandboxId);
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
    return json(await repoBoard.takeOverRun(runId, { actorId: 'same-session', actorLabel: 'Operator' }, requestContext.activeTenantId, sandboxRole));
  });
}

function parseSandboxRoleQuery(value: string | null): SandboxRole {
  if (!value) {
    return 'main';
  }
  if (value === 'main' || value === 'review') {
    return value;
  }
  throw badRequest('Invalid sandboxRole.');
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
}

export async function handleDebugExport(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    return json(await board.exportBoard());
  });
}

export async function handleDebugImport(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    const body = await readJson(request);
    if (typeof body !== 'object' || !body || !('version' in body)) {
      throw badRequest('Invalid board snapshot payload.');
    }
    await board.importBoard(parseBoardSnapshot(JSON.stringify(body)));
    return json({ ok: true });
  });
}

export async function handleDebugSandboxRun(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');
    const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
    return json({
      output: result.stdout,
      error: result.stderr,
      exitCode: result.exitCode,
      success: result.success
    });
  });
}

export async function handleDebugSandboxFile(request: Request, env: Env): Promise<Response> {
  return withApiError(async () => {
    const board = getBoard(env);
    const requestContext = await resolveRequestTenantContext(env, board, request, { requireSession: true });
    await requireOwnerTenantAccess(env, board, requestContext);
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');
    await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
    const file = await sandbox.readFile('/workspace/hello.txt');
    return json({ content: file.content });
  });
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
  apiTokenId?: string;
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

  const apiToken = readApiToken(request);
  if (apiToken) {
    const resolved = await tenantAuthDb.resolveApiToken(env, apiToken);
    const memberships = await tenantAuthDb.listUserMemberships(env, resolved.user.id);
    const membership = memberships.find((entry) => entry.seatState === 'active');
    if (!membership) {
      throw unauthorized(`User ${resolved.user.id} does not have an active tenant membership.`);
    }
    return {
      userId: resolved.user.id,
      activeTenantId: normalizeTenantIdStrict(membership.tenantId),
      apiTokenId: resolved.tokenRecord.id
    };
  }

  const bearerToken = readBearerToken(request);
  if (bearerToken) {
    try {
      const resolvedSession = await tenantAuthDb.resolveSessionByToken(env, bearerToken);
      return {
        userId: resolvedSession.user.id,
        activeTenantId: normalizeTenantIdStrict(resolvedSession.session.activeTenantId),
        sessionId: resolvedSession.session.id,
        sessionToken: bearerToken
      };
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }
    }
    const resolvedPat = await tenantAuthDb.resolveApiToken(env, bearerToken);
    const memberships = await tenantAuthDb.listUserMemberships(env, resolvedPat.user.id);
    const membership = memberships.find((entry) => entry.seatState === 'active');
    if (!membership) {
      throw unauthorized(`User ${resolvedPat.user.id} does not have an active tenant membership.`);
    }
    return {
      userId: resolvedPat.user.id,
      activeTenantId: normalizeTenantIdStrict(membership.tenantId),
      apiTokenId: resolvedPat.tokenRecord.id
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

async function assertReviewPlaybookAccess(
  board: DurableObjectStub<import('./durable/board-index').BoardIndexDO>,
  tenantId: string,
  playbookId: string
) {
  const playbook = await board.getReviewPlaybook(playbookId);
  if (!playbook || normalizeTenantId(playbook.tenantId) !== normalizeTenantId(tenantId)) {
    throw notFound(`Review playbook ${playbookId} not found.`);
  }
  if (!playbook.enabled) {
    throw forbidden(`Review playbook ${playbookId} is disabled.`);
  }
  return playbook;
}

function readSessionToken(request: Request): string | undefined {
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

function readApiToken(request: Request): string | undefined {
  return request.headers.get('x-api-token')?.trim() || undefined;
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')?.trim();
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    return token || undefined;
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

function isUnauthorizedError(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && (error as { status?: unknown }).status === 401;
}

function toPublicSession(session: { id: string; userId: string; tenantId: string; activeTenantId: string; expiresAt: string; lastSeenAt: string }) {
  return {
    id: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    activeTenantId: session.activeTenantId,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt
  };
}

function buildSessionCookie(request: Request, token: string) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `minions_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `minions_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
