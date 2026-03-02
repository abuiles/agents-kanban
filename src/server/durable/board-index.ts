import type { CreateRepoInput, UpdateRepoInput } from '../../ui/domain/api';
import type { BoardSnapshotV1, Repo } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { conflict, notFound } from '../http/errors';
import { createRepoId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { buildBoardSnapshot, type BoardSyncResponse } from '../shared/state';

const STORAGE_KEY = 'board-index-repos';

export class BoardIndexDO extends DurableObject<Env> {
  private repos: Repo[] = [];
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.repos = (await this.ctx.storage.get<Repo[]>(STORAGE_KEY)) ?? [];
    });
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      const repoId = url.searchParams.get('repoId') ?? 'all';
      return this.handleWebSocket(repoId);
    }

    return new Response('Not found', { status: 404 });
  }

  async listRepos() {
    await this.ready;
    return [...this.repos].sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async getRepo(repoId: string) {
    await this.ready;
    const repo = this.repos.find((candidate) => candidate.repoId === repoId);
    if (!repo) {
      throw notFound(`Repo ${repoId} not found.`);
    }
    return repo;
  }

  async createRepo(input: CreateRepoInput) {
    await this.ready;
    if (this.repos.some((repo) => repo.slug === input.slug)) {
      throw conflict(`Repo ${input.slug} already exists.`);
    }

    const now = new Date().toISOString();
    const repo: Repo = {
      repoId: createRepoId(input.slug),
      slug: input.slug,
      defaultBranch: input.defaultBranch ?? 'main',
      baselineUrl: input.baselineUrl,
      enabled: input.enabled ?? true,
      githubAuthMode: 'kv_pat',
      previewProvider: 'cloudflare',
      previewCheckName: input.previewCheckName,
      codexAuthBundleR2Key: input.codexAuthBundleR2Key,
      createdAt: now,
      updatedAt: now
    };

    this.repos = [repo, ...this.repos];
    await this.persist();
    await this.broadcast({ type: 'repo.updated', payload: { repo } }, repo.repoId);
    return repo;
  }

  async updateRepo(repoId: string, patch: UpdateRepoInput) {
    await this.ready;
    const existing = await this.getRepo(repoId);
    if (patch.slug && patch.slug !== existing.slug && this.repos.some((repo) => repo.slug === patch.slug)) {
      throw conflict(`Repo ${patch.slug} already exists.`);
    }

    const updated: Repo = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.repos = this.repos.map((repo) => (repo.repoId === repoId ? updated : repo));
    await this.persist();
    await this.broadcast({ type: 'repo.updated', payload: { repo: updated } }, repoId);
    return updated;
  }

  async getBoardSync(repoId?: string): Promise<BoardSyncResponse> {
    await this.ready;
    const repos = await this.listRepos();
    const selected = repoId && repoId !== 'all' ? repos.filter((repo) => repo.repoId === repoId) : repos;
    const slices = await Promise.all(selected.map((repo) => this.env.REPO_BOARD.getByName(repo.repoId).getBoardSlice()));
    const tasks = slices.flatMap((slice) => slice.tasks);
    const runs = slices.flatMap((slice) => slice.runs);
    const logs = slices.flatMap((slice) => slice.logs);

    return {
      repos,
      tasks: tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      runs: runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      logs: logs.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };
  }

  async exportBoard(): Promise<BoardSnapshotV1> {
    return buildBoardSnapshot(await this.getBoardSync('all'));
  }

  async importBoard(snapshot: BoardSnapshotV1) {
    await this.ready;
    const previousRepoIds = new Set(this.repos.map((repo) => repo.repoId));
    this.repos = snapshot.repos.map((repo) => ({ ...repo }));
    await this.persist();

    const nextRepoIds = new Set(snapshot.repos.map((repo) => repo.repoId));
    const allRepoIds = new Set([...previousRepoIds, ...nextRepoIds]);

    await Promise.all(
      [...allRepoIds].map(async (repoId) => {
        const repoState = {
          tasks: snapshot.tasks.filter((task) => task.repoId === repoId),
          runs: snapshot.runs.filter((run) => run.repoId === repoId),
          logs: snapshot.logs.filter((log) => {
            const run = snapshot.runs.find((candidate) => candidate.runId === log.runId);
            return run?.repoId === repoId;
          })
        };
        await this.env.REPO_BOARD.getByName(repoId).replaceState(repoState);
      })
    );

    await this.broadcast({ type: 'board.snapshot', payload: await this.getBoardSync('all') });
  }

  async findTaskRepoId(taskId: string) {
    await this.ready;
    for (const repo of this.repos) {
      if (await this.env.REPO_BOARD.getByName(repo.repoId).hasTask(taskId)) {
        return repo.repoId;
      }
    }

    return undefined;
  }

  async findRunRepoId(runId: string) {
    await this.ready;
    for (const repo of this.repos) {
      if (await this.env.REPO_BOARD.getByName(repo.repoId).hasRun(runId)) {
        return repo.repoId;
      }
    }

    return undefined;
  }

  async notifyRepoEvent(event: BoardEvent & { repoId?: string }) {
    await this.ready;
    const message = stringifyBoardEvent(event);
    for (const socket of this.ctx.getWebSockets('scope:all')) {
      socket.send(message);
    }

    if (event.repoId) {
      for (const socket of this.ctx.getWebSockets(`scope:repo:${event.repoId}`)) {
        socket.send(message);
      }
    }
  }

  private async handleWebSocket(repoId: string) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tag = repoId === 'all' ? 'scope:all' : `scope:repo:${repoId}`;
    this.ctx.acceptWebSocket(server, [tag]);
    server.send(stringifyBoardEvent({ type: 'board.snapshot', payload: await this.getBoardSync(repoId) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(event: BoardEvent, repoId?: string) {
    await this.notifyRepoEvent({ ...event, repoId });
  }

  private async persist() {
    await this.ctx.storage.put(STORAGE_KEY, this.repos);
  }
}
