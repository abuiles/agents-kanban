import { Sandbox } from '@cloudflare/sandbox';
import { BoardIndexDO } from './server/durable/board-index';
import { RepoBoardDO } from './server/durable/repo-board';
import { handleApiRequest } from './server/router';

export { Sandbox, BoardIndexDO, RepoBoardDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
