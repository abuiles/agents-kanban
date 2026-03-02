import { Sandbox } from '@cloudflare/sandbox';
import { BoardIndexDO } from './server/durable/board-index';
import { RepoBoardDO } from './server/durable/repo-board';
import { handleApiRequest } from './server/router';
import { RunWorkflow } from './server/workflows/run-workflow';

export { Sandbox, BoardIndexDO, RepoBoardDO, RunWorkflow };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};
