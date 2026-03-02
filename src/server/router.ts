import { getSandbox } from '@cloudflare/sandbox';
import type { CreateTaskInput } from '../ui/domain/api';
import { badRequest, notFound } from './http/errors';
import { handleError, json } from './http/response';
import { parseCreateRepoInput, parseCreateTaskInput, parseUpdateRepoInput, parseUpdateTaskInput, readJson } from './http/validation';
import { extractRepoIdFromRunId, extractRepoIdFromTaskId } from './shared/ids';
import { parseBoardSnapshot } from '../ui/store/board-snapshot';

const BOARD_OBJECT_NAME = 'agentboard';

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
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

    const runStartMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
    if (runStartMatch && request.method === 'POST') {
      const taskId = decodeURIComponent(runStartMatch[1]);
      const repoId = await resolveRepoIdForTask(board, taskId);
      return json(await env.REPO_BOARD.getByName(repoId).startRun(taskId));
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
      return json(await env.REPO_BOARD.getByName(repoId).retryRun(runId));
    }

    const evidenceRetryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/evidence$/);
    if (evidenceRetryMatch && request.method === 'POST') {
      const runId = decodeURIComponent(evidenceRetryMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      return json(await env.REPO_BOARD.getByName(repoId).retryEvidence(runId));
    }

    const runLogsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
    if (runLogsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(runLogsMatch[1]);
      const repoId = await resolveRepoIdForRun(board, runId);
      const tail = url.searchParams.get('tail');
      return json(await env.REPO_BOARD.getByName(repoId).getRunLogs(runId, tail ? Number(tail) : undefined));
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
