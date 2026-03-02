import type { CreateRepoInput, UpdateRepoInput, UpsertProviderCredentialInput } from '../../ui/domain/api';
import type { BoardSnapshotV1, ProviderCredential, Repo } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { conflict, notFound } from '../http/errors';
import { createRepoId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { buildBoardSnapshot, type BoardSyncResponse } from '../shared/state';
import {
  buildProviderCredentialId,
  getRepoIdentityKey,
  normalizeProviderCredential,
  normalizeProviderCredentials,
  normalizeRepo,
  normalizeRepos
} from '../../shared/scm';

const REPOS_STORAGE_KEY = 'board-index-repos';
const PROVIDER_CREDENTIALS_STORAGE_KEY = 'board-index-provider-credentials';

export class BoardIndexDO extends DurableObject<Env> {
  private repos: Repo[] = [];
  private providerCredentials: ProviderCredential[] = [];
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.repos = normalizeRepos(await this.ctx.storage.get<Repo[]>(REPOS_STORAGE_KEY));
      this.providerCredentials = normalizeProviderCredentials(await this.ctx.storage.get<ProviderCredential[]>(PROVIDER_CREDENTIALS_STORAGE_KEY));
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

  async listProviderCredentials() {
    await this.ready;
    return [...this.providerCredentials].sort((left, right) => left.credentialId.localeCompare(right.credentialId));
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
    const now = new Date().toISOString();
    const repo = normalizeRepo({
      repoId: createRepoId(input.projectPath ?? input.slug ?? ''),
      slug: input.slug ?? input.projectPath ?? '',
      scmProvider: input.scmProvider,
      scmBaseUrl: input.scmBaseUrl,
      projectPath: input.projectPath ?? input.slug,
      defaultBranch: input.defaultBranch ?? 'main',
      baselineUrl: input.baselineUrl,
      enabled: input.enabled ?? true,
      previewCheckName: input.previewCheckName,
      codexAuthBundleR2Key: input.codexAuthBundleR2Key,
      createdAt: now,
      updatedAt: now
    });
    if (this.repos.some((candidate) => getRepoIdentityKey(candidate) === getRepoIdentityKey(repo))) {
      throw conflict(`Repo ${repo.projectPath} already exists.`);
    }

    this.repos = [repo, ...this.repos];
    await this.persist();
    await this.broadcast({ type: 'repo.updated', payload: { repo } }, repo.repoId);
    return repo;
  }

  async updateRepo(repoId: string, patch: UpdateRepoInput) {
    await this.ready;
    const existing = await this.getRepo(repoId);
    const updated = normalizeRepo({
      ...existing,
      ...patch,
      slug: patch.slug ?? patch.projectPath ?? existing.slug,
      projectPath: patch.projectPath ?? patch.slug ?? existing.projectPath,
      updatedAt: new Date().toISOString()
    });
    if (
      this.repos.some((repo) => repo.repoId !== repoId && getRepoIdentityKey(repo) === getRepoIdentityKey(updated))
    ) {
      throw conflict(`Repo ${updated.projectPath} already exists.`);
    }
    this.repos = this.repos.map((repo) => (repo.repoId === repoId ? updated : repo));
    await this.persist();
    await this.broadcast({ type: 'repo.updated', payload: { repo: updated } }, repoId);
    return updated;
  }

  async upsertProviderCredential(input: UpsertProviderCredentialInput) {
    await this.ready;
    const now = new Date().toISOString();
    const credentialId = buildProviderCredentialId(input.scmProvider, input.scmBaseUrl ?? '');
    const existing = this.providerCredentials.find((candidate) => candidate.credentialId === credentialId);
    const credential = normalizeProviderCredential({
      credentialId,
      scmProvider: input.scmProvider,
      scmBaseUrl: input.scmBaseUrl ?? '',
      host: '',
      authType: input.authType ?? 'kv_pat',
      secretRef: input.secretRef,
      label: input.label,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });

    this.providerCredentials = [
      credential,
      ...this.providerCredentials.filter((candidate) => candidate.credentialId !== credential.credentialId)
    ];
    await this.persist();
    await this.broadcast({ type: 'provider_credential.updated', payload: { credential } });
    return credential;
  }

  async findProviderCredentialForRepo(repoId: string) {
    await this.ready;
    const repo = await this.getRepo(repoId);
    const credentialId = buildProviderCredentialId(repo.scmProvider ?? 'github', repo.scmBaseUrl ?? '');
    return this.providerCredentials.find((candidate) => candidate.credentialId === credentialId);
  }

  async getBoardSync(repoId?: string): Promise<BoardSyncResponse> {
    await this.ready;
    const repos = await this.listRepos();
    const selected = repoId && repoId !== 'all' ? repos.filter((repo) => repo.repoId === repoId) : repos;
    const slices = await Promise.all(selected.map((repo) => this.env.REPO_BOARD.getByName(repo.repoId).getBoardSlice()));
    const tasks = slices.flatMap((slice) => slice.tasks);
    const runs = slices.flatMap((slice) => slice.runs);
    const logs = slices.flatMap((slice) => slice.logs);
    const events = slices.flatMap((slice) => slice.events ?? []);
    const commands = slices.flatMap((slice) => slice.commands ?? []);

    return {
      repos,
      providerCredentials: await this.listProviderCredentials(),
      tasks: tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      runs: runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      logs: logs.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      events: events.sort((left, right) => left.at.localeCompare(right.at)),
      commands: commands.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    };
  }

  async exportBoard(): Promise<BoardSnapshotV1> {
    return buildBoardSnapshot(await this.getBoardSync('all'));
  }

  async importBoard(snapshot: BoardSnapshotV1) {
    await this.ready;
    const previousRepoIds = new Set(this.repos.map((repo) => repo.repoId));
    this.repos = normalizeRepos(snapshot.repos);
    this.providerCredentials = normalizeProviderCredentials(snapshot.providerCredentials);
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
          }),
          events: snapshot.events.filter((event) => event.repoId === repoId),
          commands: snapshot.commands.filter((command) => {
            const run = snapshot.runs.find((candidate) => candidate.runId === command.runId);
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
    await this.ctx.storage.put(REPOS_STORAGE_KEY, this.repos);
    await this.ctx.storage.put(PROVIDER_CREDENTIALS_STORAGE_KEY, this.providerCredentials);
  }
}
