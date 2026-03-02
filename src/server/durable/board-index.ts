import type { CreateRepoInput, UpdateRepoInput, UpsertScmCredentialInput } from '../../ui/domain/api';
import type { BoardSnapshotV1, Repo, ScmCredential, ScmProvider } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { conflict, notFound } from '../http/errors';
import { createRepoId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { buildBoardSnapshot, type BoardSyncResponse } from '../shared/state';
import { buildRepoScmKey, getRepoHost, getRepoProjectPath, normalizeCredentialHost, normalizeRepo } from '../../shared/scm';

const REPOS_STORAGE_KEY = 'board-index-repos';
const SCM_CREDENTIALS_STORAGE_KEY = 'board-index-scm-credentials';

type StoredScmCredential = ScmCredential & {
  token: string;
};

export class BoardIndexDO extends DurableObject<Env> {
  private repos: Repo[] = [];
  private scmCredentials: StoredScmCredential[] = [];
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const storedRepos = (await this.ctx.storage.get<Repo[]>(REPOS_STORAGE_KEY)) ?? [];
      const storedScmCredentials = (await this.ctx.storage.get<StoredScmCredential[]>(SCM_CREDENTIALS_STORAGE_KEY)) ?? [];
      this.repos = storedRepos.map((repo) => normalizeRepo(repo));
      this.scmCredentials = storedScmCredentials.map((credential) => normalizeStoredScmCredential(credential));
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
    const candidate = buildRepoRecord(input);
    if (this.repos.some((repo) => buildRepoScmKey(repo) === buildRepoScmKey(candidate))) {
      throw conflict(`Repo ${candidate.slug} already exists.`);
    }

    const repo = {
      ...candidate,
      repoId: createRepoIdentity(candidate),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.repos = [repo, ...this.repos];
    await this.persist();
    await this.broadcast({ type: 'repo.updated', payload: { repo } }, repo.repoId);
    return repo;
  }

  async updateRepo(repoId: string, patch: UpdateRepoInput) {
    await this.ready;
    const existing = await this.getRepo(repoId);
    const updated = buildRepoRecord({
      ...existing,
      ...patch,
      slug: patch.slug ?? patch.projectPath ?? existing.slug,
      projectPath: patch.projectPath ?? patch.slug ?? existing.projectPath,
      repoId: existing.repoId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt
    });
    if (
      this.repos.some((repo) => repo.repoId !== repoId && buildRepoScmKey(repo) === buildRepoScmKey(updated))
    ) {
      throw conflict(`Repo ${updated.slug} already exists.`);
    }

    this.repos = this.repos.map((repo) =>
      repo.repoId === repoId
        ? {
            ...updated,
            repoId,
            createdAt: existing.createdAt,
            updatedAt: new Date().toISOString()
          }
        : repo
    );
    await this.persist();
    const finalRepo = this.repos.find((repo) => repo.repoId === repoId) ?? existing;
    await this.broadcast({ type: 'repo.updated', payload: { repo: finalRepo } }, repoId);
    return finalRepo;
  }

  async listScmCredentials(): Promise<ScmCredential[]> {
    await this.ready;
    return [...this.scmCredentials]
      .sort((left, right) => left.credentialId.localeCompare(right.credentialId))
      .map(stripScmCredentialSecret);
  }

  async getScmCredential(scmProvider: ScmProvider, host: string): Promise<ScmCredential | undefined> {
    await this.ready;
    const credential = this.scmCredentials.find((candidate) => candidate.credentialId === buildScmCredentialId(scmProvider, host));
    return credential ? stripScmCredentialSecret(credential) : undefined;
  }

  async getScmCredentialSecret(scmProvider: ScmProvider, host: string): Promise<string | undefined> {
    await this.ready;
    return this.scmCredentials.find((candidate) => candidate.credentialId === buildScmCredentialId(scmProvider, host))?.token;
  }

  async upsertScmCredential(input: UpsertScmCredentialInput): Promise<ScmCredential> {
    await this.ready;
    const now = new Date().toISOString();
    const credentialId = buildScmCredentialId(input.scmProvider, input.host);
    const existing = this.scmCredentials.find((candidate) => candidate.credentialId === credentialId);
    const credential: StoredScmCredential = normalizeStoredScmCredential({
      credentialId,
      scmProvider: input.scmProvider,
      host: input.host,
      label: input.label,
      hasSecret: true,
      token: input.token,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });

    this.scmCredentials = existing
      ? this.scmCredentials.map((candidate) => (candidate.credentialId === credentialId ? credential : candidate))
      : [...this.scmCredentials, credential];
    await this.persist();
    return stripScmCredentialSecret(credential);
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
    this.repos = snapshot.repos.map((repo) => normalizeRepo(repo));
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
    await this.ctx.storage.put(SCM_CREDENTIALS_STORAGE_KEY, this.scmCredentials);
  }
}

function buildRepoRecord(input: CreateRepoInput | Repo): Repo {
  const normalized = normalizeRepo({
    ...input,
    repoId: 'repoId' in input ? input.repoId : '',
    defaultBranch: input.defaultBranch ?? 'main',
    baselineUrl: input.baselineUrl,
    enabled: input.enabled ?? true,
    llmAdapter: input.llmAdapter,
    llmProfileId: input.llmProfileId,
    githubAuthMode: 'githubAuthMode' in input ? input.githubAuthMode : undefined,
    previewMode: 'previewMode' in input ? input.previewMode : 'auto',
    evidenceMode: 'evidenceMode' in input ? input.evidenceMode : 'auto',
    previewAdapter: 'previewAdapter' in input ? input.previewAdapter : undefined,
    previewConfig: 'previewConfig' in input ? input.previewConfig : undefined,
    previewProvider: 'previewProvider' in input ? input.previewProvider : undefined,
    previewCheckName: input.previewCheckName,
    previewUrlPattern: 'previewUrlPattern' in input ? input.previewUrlPattern : undefined,
    llmAdapter: input.llmAdapter,
    llmProfileId: input.llmProfileId,
    llmAuthBundleR2Key: input.llmAuthBundleR2Key ?? input.codexAuthBundleR2Key,
    codexAuthBundleR2Key: input.codexAuthBundleR2Key ?? input.llmAuthBundleR2Key,
    createdAt: 'createdAt' in input ? input.createdAt : '',
    updatedAt: 'updatedAt' in input ? input.updatedAt : ''
  });

  return normalized;
}

function createRepoIdentity(repo: Repo): string {
  const host = getRepoHost(repo);
  const projectPath = getRepoProjectPath(repo);
  if (repo.scmProvider === 'github' && host === 'github.com') {
    return createRepoId(projectPath);
  }

  return createRepoId(`${repo.scmProvider}_${host}_${projectPath}`);
}

function buildScmCredentialId(scmProvider: ScmProvider, host: string) {
  return `${scmProvider}:${normalizeCredentialHost(host)}`;
}

function normalizeStoredScmCredential(credential: StoredScmCredential): StoredScmCredential {
  return {
    ...credential,
    credentialId: buildScmCredentialId(credential.scmProvider, credential.host),
    host: normalizeCredentialHost(credential.host),
    hasSecret: Boolean(credential.token)
  };
}

function stripScmCredentialSecret(credential: StoredScmCredential): ScmCredential {
  return {
    credentialId: credential.credentialId,
    scmProvider: credential.scmProvider,
    host: credential.host,
    label: credential.label,
    hasSecret: credential.hasSecret,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt
  };
}
