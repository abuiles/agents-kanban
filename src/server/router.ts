import { getSandbox } from '@cloudflare/sandbox';
import type { CreateTaskInput } from '../ui/domain/api';
import { badRequest, notFound } from './http/errors';
import { handleError, json } from './http/response';
import { parseCreateRepoInput, parseCreateTaskInput, parseUpdateRepoInput, parseUpdateTaskInput, parseUpsertScmCredentialInput, readJson } from './http/validation';
import { extractRepoIdFromRunId, extractRepoIdFromTaskId } from './shared/ids';
import { parseBoardSnapshot } from '../ui/store/board-snapshot';
import { scheduleRunJob } from './run-orchestrator';

const BOARD_OBJECT_NAME = 'agentboard';

export async function handleApiRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const board = env.BOARD_INDEX.getByName(BOARD_OBJECT_NAME);

  try {
    if (url.pathname === '/api/board' && request.method === 'GET') {
      const repoId = url.searchParams.get('repoId') ?? 'all';
      return json(await board.getBoardSync(repoId));
    }

    if (url.pathname === '/api/board/ws' && request.method === 'GET') {
      return board.fetch(request);
    }

    if (url.pathname === '/api/repos' && request.method === 'GET') {
      return json(await board.listRepos());
    }

    if (url.pathname === '/api/repos' && request.method === 'POST') {
      return json(await board.createRepo(parseCreateRepoInput(await readJson(request))), { status: 201 });
    }

    const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
    if (repoMatch && request.method === 'PATCH') {
      return json(await board.updateRepo(decodeURIComponent(repoMatch[1]), parseUpdateRepoInput(await readJson(request))));
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
      const repoId = url.searchParams.get('repoId');
      if (!repoId || repoId === 'all') {
        return json((await board.getBoardSync('all')).tasks);
      }
      return json(await env.REPO_BOARD.getByName(repoId).listTasks());
    }

    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const input = parseCreateTaskInput(await readJson(request));
      return json(await env.REPO_BOARD.getByName(input.repoId).createTask(input), { status: 201 });
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'GET') {
      const taskId = decodeURIComponent(taskMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      return json(await env.REPO_BOARD.getByName(repoId).getTask(taskId));
    }

    if (taskMatch && request.method === 'PATCH') {
      const taskId = decodeURIComponent(taskMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      return json(await env.REPO_BOARD.getByName(repoId).updateTask(taskId, parseUpdateTaskInput(await readJson(request))));
    }

    if (taskMatch && request.method === 'DELETE') {
      const taskId = decodeURIComponent(taskMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      return json(await env.REPO_BOARD.getByName(repoId).deleteTask(taskId));
    }

    const runStartMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
    if (runStartMatch && request.method === 'POST') {
      const taskId = decodeURIComponent(runStartMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      const run = await env.REPO_BOARD.getByName(repoId).startRun(taskId);
      const workflow = await scheduleRunJob(env, ctx, { repoId, taskId, runId: run.runId, mode: 'full_run' });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId));
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      return json(await env.REPO_BOARD.getByName(repoId).getRun(runId));
    }

    const runRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
    if (runRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(runRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const run = await env.REPO_BOARD.getByName(repoId).retryRun(runId);
      const workflow = await scheduleRunJob(env, ctx, { repoId, taskId: run.taskId, runId: run.runId, mode: 'full_run' });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId));
    }

    const runCancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (runCancelMatch && request.method === 'POST') {
      const runId = decodeURIComponent(runCancelMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
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
      }));
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
      const run = await env.REPO_BOARD.getByName(repoId).requestRunChanges(runId, body.prompt.trim());
      const workflow = await scheduleRunJob(env, ctx, { repoId, taskId: run.taskId, runId: run.runId, mode: 'full_run' });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId));
    }

    const evidenceRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/evidence$/);
    if (evidenceRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(evidenceRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const run = await env.REPO_BOARD.getByName(repoId).retryEvidence(runId);
      const workflow = await scheduleRunJob(env, ctx, {
        repoId,
        taskId: run.taskId,
        runId: run.runId,
        mode: run.previewUrl ? 'evidence_only' : 'preview_only'
      });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId));
    }

    const previewRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/preview$/);
    if (previewRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(previewRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const run = await env.REPO_BOARD.getByName(repoId).retryPreview(runId);
      const workflow = await scheduleRunJob(env, ctx, { repoId, taskId: run.taskId, runId: run.runId, mode: 'preview_only' });
      await env.REPO_BOARD.getByName(repoId).transitionRun(run.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      return json(await env.REPO_BOARD.getByName(repoId).getRun(run.runId));
    }

    const runLogsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
    if (runLogsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runLogsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const tail = url.searchParams.get('tail');
      return json(await env.REPO_BOARD.getByName(repoId).getRunLogs(runId, tail ? Number(tail) : undefined));
    }

    const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (runEventsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runEventsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      return json(await env.REPO_BOARD.getByName(repoId).getRunEvents(runId));
    }

    const runCommandsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/commands$/);
    if (runCommandsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runCommandsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      return json(await env.REPO_BOARD.getByName(repoId).getRunCommands(runId));
    }

    const runTerminalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/terminal$/);
    if (runTerminalMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runTerminalMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const bootstrap = await env.REPO_BOARD.getByName(repoId).getTerminalBootstrap(runId);
      if (!bootstrap.attachable) {
        return json(bootstrap, { status: 409 });
      }
      return json(bootstrap);
    }

    const runTerminalSocketMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/ws$/);
    if (runTerminalSocketMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runTerminalSocketMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const bootstrap = await env.REPO_BOARD.getByName(repoId).getTerminalBootstrap(runId);
      if (!bootstrap.attachable) {
        return json(bootstrap, { status: 409 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        throw badRequest('Expected WebSocket upgrade request.');
      }

      const run = await env.REPO_BOARD.getByName(repoId).getRun(runId);
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
      await env.REPO_BOARD.getByName(repoId).updateOperatorSession(runId, session);
      const sandboxSession = await sandbox.getSession(bootstrap.sessionName);
      return sandboxSession.terminal(request, { cols: bootstrap.cols, rows: bootstrap.rows });
    }

    const runArtifactsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
    if (runArtifactsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runArtifactsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      return json(await env.REPO_BOARD.getByName(repoId).getRunArtifacts(runId));
    }

    const runTakeoverMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/takeover$/);
    if (runTakeoverMatch && request.method === 'POST') {
      const runId = decodeURIComponent(runTakeoverMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const repoBoard = env.REPO_BOARD.getByName(repoId);
      const run = await repoBoard.getRun(runId);
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
      return json(await repoBoard.takeOverRun(runId));
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
