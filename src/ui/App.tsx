import type { ChangeEvent, FormEvent } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Board } from './components/Board';
import { ControlSurfaceHeader, SummaryRow } from './components/ControlSurface';
import { DetailPanel } from './components/DetailPanel';
import { RepoForm, TaskForm } from './components/Forms';
import { Modal } from './components/Modal';
import { RunTerminal } from './components/RunTerminal';
import { getTaskDetail, getTasksByColumn, getTasksForRepo } from './domain/selectors';
import type { RunCommand, RunEvent, RunLogEntry, TaskStatus, TerminalBootstrap } from './domain/types';
import type { AgentBoardApi, AuthSession, InviteRecord, RepoSentinelStatus, UserApiTokenRecord } from './domain/api';
import { getAgentBoardApi } from './api';
import { downloadJson } from './store/import-export';
import { getSelectedTaskIdFromUrl, setSelectedTaskIdInUrl } from './url-state';

export default function App({ api: providedApi }: { api?: AgentBoardApi }) {
  const api = useMemo(() => providedApi ?? getAgentBoardApi(), [providedApi]);
  const snapshot = useSyncExternalStore(
    api.subscribe.bind(api),
    () => api.getSnapshot(),
    () => api.getSnapshot()
  );
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [repoToEditId, setRepoToEditId] = useState<string | undefined>();
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskToEditId, setTaskToEditId] = useState<string | undefined>();
  const [changeRequestRunId, setChangeRequestRunId] = useState<string | undefined>();
  const [changeRequestPrompt, setChangeRequestPrompt] = useState('');
  const [changeRequestMode, setChangeRequestMode] = useState<'all' | 'include' | 'exclude' | 'freeform'>('all');
  const [changeRequestFindingIds, setChangeRequestFindingIds] = useState('');
  const [changeRequestInstruction, setChangeRequestInstruction] = useState('');
  const [changeRequestIncludeReplies, setChangeRequestIncludeReplies] = useState(false);
  const [selectedRunEvents, setSelectedRunEvents] = useState<RunEvent[]>([]);
  const [selectedRunCommands, setSelectedRunCommands] = useState<RunCommand[]>([]);
  const [terminalBootstrap, setTerminalBootstrap] = useState<TerminalBootstrap | undefined>();
  const [terminalModalRunId, setTerminalModalRunId] = useState<string | undefined>();
  const [terminalResumeCopied, setTerminalResumeCopied] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [authSession, setAuthSession] = useState<AuthSession | undefined>();
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'accept_invite'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [acceptInviteId, setAcceptInviteId] = useState('');
  const [acceptInviteToken, setAcceptInviteToken] = useState('');
  const [acceptDisplayName, setAcceptDisplayName] = useState('');
  const [authError, setAuthError] = useState<string | undefined>();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'owner' | 'member'>('member');
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [inviteCreateError, setInviteCreateError] = useState<string | undefined>();
  const [inviteListError, setInviteListError] = useState<string | undefined>();
  const [createdInviteToken, setCreatedInviteToken] = useState<{ inviteId: string; token: string } | undefined>();
  const [apiTokenName, setApiTokenName] = useState('');
  const [apiTokenScopes, setApiTokenScopes] = useState('');
  const [apiTokenExpiresAt, setApiTokenExpiresAt] = useState('');
  const [apiTokens, setApiTokens] = useState<UserApiTokenRecord[]>([]);
  const [createdApiToken, setCreatedApiToken] = useState<string | undefined>();
  const [apiTokenError, setApiTokenError] = useState<string | undefined>();
  const [taskSelectionHydrated, setTaskSelectionHydrated] = useState(false);
  const [repoSentinelStatus, setRepoSentinelStatus] = useState<RepoSentinelStatus | undefined>();
  const [repoSentinelLoading, setRepoSentinelLoading] = useState(false);
  const [repoSentinelError, setRepoSentinelError] = useState<string | undefined>();

  const selectedRepoId = snapshot.ui.selectedRepoId;
  const selectedTaskId = snapshot.ui.selectedTaskId;
  const repos = snapshot.repos;
  const selectedRepo = selectedRepoId === 'all' ? undefined : repos.find((repo) => repo.repoId === selectedRepoId);
  const repoToEdit = repoToEditId ? repos.find((repo) => repo.repoId === repoToEditId) : undefined;
  const visibleTasks = getTasksForRepo(snapshot.tasks, selectedRepoId);
  const tasksByColumn = getTasksByColumn(visibleTasks);
  const detail = getTaskDetail(snapshot, selectedTaskId);
  const taskToEdit = taskToEditId ? snapshot.tasks.find((task) => task.taskId === taskToEditId) : undefined;
  const logs: RunLogEntry[] = detail?.latestRun
    ? snapshot.logs.filter((entry) => entry.runId === detail.latestRun?.runId)
    : [];
  const terminalRun = terminalModalRunId ? snapshot.runs.find((run) => run.runId === terminalModalRunId) : undefined;
  const terminalLogs = terminalModalRunId ? snapshot.logs.filter((entry) => entry.runId === terminalModalRunId) : [];
  const terminalExecutorLogs = terminalLogs.filter((entry) => entry.phase === 'codex');
  const terminalStreamLogs = terminalExecutorLogs.length ? terminalExecutorLogs : terminalLogs;
  const isOwner = Boolean(authSession?.memberships.some((membership) => membership.role === 'owner' && membership.seatState === 'active'));

  useEffect(() => {
    let cancelled = false;
    void api.getAuthSession()
      .then((session) => {
        if (!cancelled) {
          setAuthSession(session);
          setAuthLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!authSession) {
      setInvites([]);
      setApiTokens([]);
      return;
    }

    if (isOwner) {
      void api.listInvites()
        .then((nextInvites) => {
          setInvites(nextInvites);
          setInviteListError(undefined);
        })
        .catch((error) => {
          setInviteListError(error instanceof Error ? error.message : 'Failed to load invites.');
        });
    } else {
      setInvites([]);
      setInviteListError(undefined);
    }

    void api.listApiTokens()
      .then((tokens) => {
        setApiTokens(tokens);
        setApiTokenError(undefined);
      })
      .catch((error) => {
        setApiTokenError(error instanceof Error ? error.message : 'Failed to load API tokens.');
      });
  }, [api, authSession, isOwner]);

  useEffect(() => {
    const runId = detail?.latestRun?.runId;
    if (!runId) {
      setSelectedRunEvents([]);
      setSelectedRunCommands([]);
      setTerminalBootstrap(undefined);
      return;
    }

    void api.getRunEvents(runId).then(setSelectedRunEvents).catch(() => setSelectedRunEvents([]));
    void api.getRunCommands(runId).then(setSelectedRunCommands).catch(() => setSelectedRunCommands([]));
  }, [api, detail?.latestRun?.runId]);

  useEffect(() => {
    if (taskSelectionHydrated) {
      return;
    }

    const taskIdFromUrl = getSelectedTaskIdFromUrl();
    if (!taskIdFromUrl) {
      setTaskSelectionHydrated(true);
      return;
    }

    if (!snapshot.tasks.length) {
      return;
    }

    setTaskSelectionHydrated(true);
    const taskExists = snapshot.tasks.some((task) => task.taskId === taskIdFromUrl);
    if (taskExists && taskIdFromUrl !== selectedTaskId) {
      void api.setSelectedTaskId(taskIdFromUrl);
      return;
    }

    if (!taskExists) {
      setSelectedTaskIdInUrl(undefined);
    }
  }, [api, selectedTaskId, snapshot.tasks, taskSelectionHydrated]);

  useEffect(() => {
    if (!repoToEditId) {
      setRepoSentinelStatus(undefined);
      setRepoSentinelError(undefined);
      setRepoSentinelLoading(false);
      return;
    }
    setRepoSentinelLoading(true);
    setRepoSentinelError(undefined);
    void api.getRepoSentinel(repoToEditId)
      .then((status) => {
        setRepoSentinelStatus(status);
        setRepoSentinelLoading(false);
      })
      .catch((error) => {
        setRepoSentinelError(error instanceof Error ? error.message : 'Failed to load sentinel status.');
        setRepoSentinelLoading(false);
      });
  }, [api, repoToEditId]);

  useEffect(() => {
    if (!taskSelectionHydrated) {
      return;
    }

    if (selectedTaskId && !snapshot.tasks.some((task) => task.taskId === selectedTaskId)) {
      void api.setSelectedTaskId(undefined);
      return;
    }

    setSelectedTaskIdInUrl(selectedTaskId);
  }, [api, selectedTaskId, snapshot.tasks, taskSelectionHydrated]);

  async function moveTask(taskId: string, status: TaskStatus) {
    const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      return;
    }

    const latestRun = snapshot.runs
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    const hasActiveRun = latestRun && !['DONE', 'FAILED'].includes(latestRun.status);
    if (task.status === 'ACTIVE' && hasActiveRun && status !== 'ACTIVE') {
      setNotice('Active runs stay pinned to Active until the current lifecycle finishes.');
      return;
    }

    await api.updateTask(taskId, { status });
    if (status === 'ACTIVE') {
      await api.startRun(taskId);
    }
    await api.setSelectedTaskId(taskId);
    setNotice(status === 'ACTIVE' ? 'Run started from the board.' : `Moved task to ${status}.`);
  }

  async function retryRun(runId: string) {
    const run = await api.retryRun(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Started retry run.');
  }

  async function rerunReview(runId: string) {
    const run = await api.rerunReview(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Queued manual review rerun for this review context.');
  }

  async function retryPreview(runId: string) {
    const run = await api.retryPreview(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Retrying preview discovery for the current PR.');
  }

  async function retryEvidence(runId: string) {
    const run = await api.retryEvidence(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Retrying evidence for the current PR.');
  }

  async function openTerminal(runId: string) {
    const targetRun = snapshot.runs.find((run) => run.runId === runId);
    const shouldPreferReviewSandbox = targetRun?.reviewExecution?.status === 'completed'
      && ['DONE', 'FAILED'].includes(targetRun.status)
      && Boolean(targetRun.reviewSandboxId);
    const candidates: Array<'main' | 'review'> = shouldPreferReviewSandbox ? ['review', 'main'] : ['main', 'review'];

    for (const sandboxRole of candidates) {
      try {
        const bootstrap = await api.getTerminalBootstrap(runId, sandboxRole);
        if (bootstrap.attachable) {
          setTerminalBootstrap(bootstrap);
          setTerminalModalRunId(runId);
          setTerminalResumeCopied(false);
          setNotice('Terminal connected to the live sandbox session.');
          return;
        }
        if (sandboxRole === 'main') {
          setTerminalBootstrap(bootstrap);
          setTerminalModalRunId(runId);
          setTerminalResumeCopied(false);
          setNotice(`Terminal unavailable: ${bootstrap.reason ?? 'unknown error'}.`);
          return;
        }
      } catch (error) {
        if (sandboxRole === 'main') {
          setNotice(error instanceof Error ? error.message : 'Failed to open terminal.');
          return;
        }
      }
    }
  }

  async function takeOverRun(runId: string) {
    const run = await api.takeOverRun(runId);
    await api.setSelectedTaskId(run.taskId);
    setNotice('Operator takeover recorded for the live sandbox.');
  }

  async function requestChanges(runId: string) {
    const prompt = changeRequestPrompt.trim();
    if (!prompt) {
      setNotice('Enter the requested changes before starting a review rerun.');
      return;
    }

    const requestedFindingIds = changeRequestFindingIds
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    const reviewSelection = {
      mode: changeRequestMode,
      ...(requestedFindingIds.length ? { findingIds: requestedFindingIds } : {}),
      ...(changeRequestInstruction.trim() ? { instruction: changeRequestInstruction.trim() } : {}),
      ...(changeRequestIncludeReplies ? { includeReplies: true } : {})
    };

    const run = await api.requestRunChanges(runId, {
      prompt,
      ...(Object.keys(reviewSelection).length ? { reviewSelection } : {})
    });

    setChangeRequestPrompt('');
    setChangeRequestMode('all');
    setChangeRequestFindingIds('');
    setChangeRequestInstruction('');
    setChangeRequestIncludeReplies(false);
    await api.setSelectedTaskId(run.taskId);
    setChangeRequestRunId(undefined);
    setNotice('Started a review rerun on the existing PR branch.');
  }

  useEffect(() => {
    if (!changeRequestRunId) {
      return;
    }

    setChangeRequestPrompt('');
    setChangeRequestMode('all');
    setChangeRequestFindingIds('');
    setChangeRequestInstruction('');
    setChangeRequestIncludeReplies(false);
  }, [changeRequestRunId]);

  async function toggleTaskSelection(taskId: string) {
    await api.setSelectedTaskId(selectedTaskId === taskId ? undefined : taskId);
  }

  async function copyTerminalResumeCommand() {
    const command = terminalRun?.llmResumeCommand ?? terminalRun?.latestCodexResumeCommand;
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      setTerminalResumeCopied(true);
      setNotice('Copied the latest resume command.');
      window.setTimeout(() => setTerminalResumeCopied(false), 2_000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to copy the resume command.');
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await api.importState(await file.text());
      setNotice('Imported board state.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      event.target.value = '';
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError(undefined);
    try {
      const session = await api.login({ email: authEmail.trim(), password: authPassword });
      setAuthSession(session);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed.');
    }
  }

  async function handleAcceptInviteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError(undefined);
    try {
      const session = await api.acceptInvite({
        inviteId: acceptInviteId.trim(),
        token: acceptInviteToken.trim(),
        password: authPassword,
        displayName: acceptDisplayName.trim() || undefined
      });
      setAuthSession(session);
      setAcceptInviteId('');
      setAcceptInviteToken('');
      setAcceptDisplayName('');
      setNotice('Invite accepted and account created.');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Failed to accept invite.');
    }
  }

  async function handleLogout() {
    await api.logout();
    setAuthSession(undefined);
    setCreatedApiToken(undefined);
    setCreatedInviteToken(undefined);
    setNotice('Signed out.');
  }

  async function handleCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteCreateError(undefined);
    try {
      const result = await api.createInvite({ email: inviteEmail.trim(), role: inviteRole });
      setInvites((current) => [result.invite, ...current]);
      setInviteEmail('');
      setInviteRole('member');
      setCreatedInviteToken({ inviteId: result.invite.id, token: result.token });
      setNotice(`Invite created for ${result.invite.email}.`);
    } catch (error) {
      setInviteCreateError(error instanceof Error ? error.message : 'Failed to create invite.');
    }
  }

  async function handleCreateApiToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApiTokenError(undefined);
    try {
      const scopes = apiTokenScopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      const expiresAt = apiTokenExpiresAt ? new Date(apiTokenExpiresAt).toISOString() : undefined;
      const created = await api.createApiToken({ name: apiTokenName.trim(), scopes, expiresAt });
      setApiTokens((tokens) => [created.tokenRecord, ...tokens]);
      setCreatedApiToken(created.token);
      setApiTokenName('');
      setApiTokenScopes('');
      setApiTokenExpiresAt('');
      setNotice('Created personal API token.');
    } catch (error) {
      setApiTokenError(error instanceof Error ? error.message : 'Failed to create API token.');
    }
  }

  async function handleRevokeApiToken(tokenId: string) {
    setApiTokenError(undefined);
    try {
      await api.revokeApiToken(tokenId);
      setApiTokens((tokens) => tokens.filter((token) => token.id !== tokenId));
      setNotice('Revoked API token.');
    } catch (error) {
      setApiTokenError(error instanceof Error ? error.message : 'Failed to revoke API token.');
    }
  }

  async function triggerRepoSentinelAction(
    repoId: string,
    action: 'start' | 'pause' | 'resume' | 'stop'
  ) {
    setRepoSentinelError(undefined);
    try {
      const result = action === 'start'
        ? await api.startRepoSentinel(repoId)
        : action === 'pause'
          ? await api.pauseRepoSentinel(repoId)
          : action === 'resume'
            ? await api.resumeRepoSentinel(repoId)
            : await api.stopRepoSentinel(repoId);
      setRepoSentinelStatus(result);
      setNotice(`Sentinel ${action}${result.changed ? ' applied' : ' already in target state'}.`);
    } catch (error) {
      setRepoSentinelError(error instanceof Error ? error.message : `Failed to ${action} sentinel.`);
    }
  }

  if (authLoading) {
    return <div className="min-h-screen px-4 py-8 text-slate-100">Loading...</div>;
  }

  if (!authSession) {
    return (
      <div className="min-h-screen px-4 py-8 text-slate-100 sm:px-6 xl:px-8">
        <div className="mx-auto w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900/80 p-6 shadow-xl">
          <h1 className="text-2xl font-semibold">{authMode === 'login' ? 'Sign in' : 'Accept invite'}</h1>
          <p className="mt-1 text-sm text-slate-400">Authenticate to access this deployment.</p>
          {authMode === 'login' ? (
            <form className="mt-5 space-y-3" onSubmit={(event) => void handleAuthSubmit(event)}>
              <input className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required />
              <input className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Password" type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required />
              {authError ? <div className="text-sm text-rose-300">{authError}</div> : null}
              <button type="submit" className="h-11 w-full rounded-xl border border-cyan-400/35 bg-cyan-500/15 text-sm font-medium text-cyan-50">
                Sign in
              </button>
            </form>
          ) : (
            <form className="mt-5 space-y-3" onSubmit={(event) => void handleAcceptInviteSubmit(event)}>
              <input className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Invite ID" value={acceptInviteId} onChange={(event) => setAcceptInviteId(event.target.value)} required />
              <input className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Invite token" value={acceptInviteToken} onChange={(event) => setAcceptInviteToken(event.target.value)} required />
              <input className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Display name (optional)" value={acceptDisplayName} onChange={(event) => setAcceptDisplayName(event.target.value)} />
              <input className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Password" type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required />
              {authError ? <div className="text-sm text-rose-300">{authError}</div> : null}
              <button type="submit" className="h-11 w-full rounded-xl border border-cyan-400/35 bg-cyan-500/15 text-sm font-medium text-cyan-50">
                Accept invite
              </button>
            </form>
          )}
          <button className="mt-3 text-sm text-cyan-200" onClick={() => setAuthMode(authMode === 'login' ? 'accept_invite' : 'login')}>
            {authMode === 'login' ? 'Have an invite? Accept it' : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-4 text-slate-100 sm:px-6 xl:px-8">
      <div className="mx-auto flex w-full max-w-[1900px] flex-col gap-3">
        <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm">
          <div className="flex items-center gap-3">
            <span className="text-slate-300">Signed in as <span className="text-slate-100">{authSession.user.email}</span></span>
            <span className="rounded-lg border border-slate-700 px-2 py-1 text-xs uppercase tracking-[0.1em] text-slate-300">
              {isOwner ? 'owner' : 'member'}
            </span>
          </div>
          <button className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
        <div className={`grid gap-3 ${isOwner ? 'xl:grid-cols-2' : ''}`}>
          {isOwner ? (
            <section className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
              <h2 className="text-sm font-semibold text-slate-100">Invite Management</h2>
              <form className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_auto]" onSubmit={(event) => void handleCreateInvite(event)}>
                <input
                  className="h-10 rounded-lg border border-slate-700 bg-slate-900/90 px-3 text-sm"
                  placeholder="Invite email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  required
                />
                <select className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'owner' | 'member')}>
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </select>
                <button type="submit" className="h-10 rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-sm text-cyan-50">Create invite</button>
              </form>
              {inviteCreateError ? <div className="mt-2 text-sm text-rose-300">{inviteCreateError}</div> : null}
              {inviteListError ? <div className="mt-2 text-sm text-rose-300">{inviteListError}</div> : null}
              {createdInviteToken ? (
                <div className="mt-3 rounded-lg border border-amber-400/35 bg-amber-500/10 p-3 text-xs text-amber-100">
                  <div>Invite token (shown once):</div>
                  <code className="mt-1 block break-all">{createdInviteToken.token}</code>
                  <div className="mt-1 text-amber-200">Invite ID: {createdInviteToken.inviteId}</div>
                </div>
              ) : null}
              <div className="mt-3 max-h-48 space-y-2 overflow-auto">
                {invites.length ? invites.map((invite) => (
                  <div key={invite.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
                    <div>{invite.email} · {invite.role} · {invite.status}</div>
                    <div className="text-slate-500">Created {new Date(invite.createdAt).toLocaleString()}</div>
                  </div>
                )) : (
                  <div className="text-xs text-slate-500">No invites yet.</div>
                )}
              </div>
            </section>
          ) : null}
          <section className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <h2 className="text-sm font-semibold text-slate-100">Personal API Tokens</h2>
            <form className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={(event) => void handleCreateApiToken(event)}>
              <input className="h-10 rounded-lg border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Token name" value={apiTokenName} onChange={(event) => setApiTokenName(event.target.value)} required />
              <input className="h-10 rounded-lg border border-slate-700 bg-slate-900/90 px-3 text-sm" placeholder="Scopes (comma-separated)" value={apiTokenScopes} onChange={(event) => setApiTokenScopes(event.target.value)} />
              <input className="h-10 rounded-lg border border-slate-700 bg-slate-900/90 px-3 text-sm" type="datetime-local" value={apiTokenExpiresAt} onChange={(event) => setApiTokenExpiresAt(event.target.value)} />
              <button type="submit" className="h-10 rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-sm text-cyan-50">Create token</button>
            </form>
            {apiTokenError ? <div className="mt-2 text-sm text-rose-300">{apiTokenError}</div> : null}
            {createdApiToken ? (
              <div className="mt-3 rounded-lg border border-amber-400/35 bg-amber-500/10 p-3 text-xs text-amber-100">
                <div>API token (shown once):</div>
                <code className="mt-1 block break-all">{createdApiToken}</code>
              </div>
            ) : null}
            <div className="mt-3 max-h-48 space-y-2 overflow-auto">
              {apiTokens.length ? apiTokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
                  <div>
                    <div>{token.name}</div>
                    <div className="text-slate-500">{token.scopes.join(', ') || 'No scopes'} · Created {new Date(token.createdAt).toLocaleString()}</div>
                  </div>
                  <button className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-rose-200" onClick={() => void handleRevokeApiToken(token.id)}>
                    Revoke
                  </button>
                </div>
              )) : (
                <div className="text-xs text-slate-500">No API tokens yet.</div>
              )}
            </div>
          </section>
        </div>
        <ControlSurfaceHeader
          repos={repos}
          selectedRepoId={selectedRepoId}
          onRepoChange={(repoId) => void api.setSelectedRepoId(repoId)}
          onAddRepo={() => setRepoModalOpen(true)}
          onEditRepo={selectedRepo ? () => setRepoToEditId(selectedRepo.repoId) : undefined}
          onCreateTask={() => setTaskModalOpen(true)}
          onExport={() => downloadJson('agents-kanban-export.json', api.exportState())}
          onImport={handleImport}
        />

        <SummaryRow repos={repos} visibleTasks={visibleTasks} />

        {notice ? (
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-2.5 text-sm text-cyan-50 shadow-[0_8px_24px_rgba(8,47,73,0.25)]">
            {notice}
          </div>
        ) : null}

        <main className={detail ? 'grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2.15fr)_minmax(20rem,0.85fr)] 2xl:grid-cols-[minmax(0,2.35fr)_minmax(22rem,0.78fr)]' : 'grid min-w-0 gap-4'}>
          <div className="min-w-0">
            <Board
              tasksByColumn={tasksByColumn}
              repos={repos}
              runs={snapshot.runs}
              selectedTaskId={selectedTaskId}
              onSelectTask={(taskId) => void toggleTaskSelection(taskId)}
              onMoveTask={(taskId, status) => void moveTask(taskId, status)}
            />
          </div>
          {detail ? (
            <div className="min-w-0">
              <DetailPanel
                detail={detail}
                logs={logs}
                events={selectedRunEvents}
                commands={selectedRunCommands}
                terminalBootstrap={terminalBootstrap}
                onEditTask={(taskId) => setTaskToEditId(taskId)}
                onRequestChanges={(runId) => setChangeRequestRunId(runId)}
                onRetryRun={(runId) => void retryRun(runId)}
                onRerunReview={(runId) => void rerunReview(runId)}
                onRetryPreview={(runId) => void retryPreview(runId)}
                onRetryEvidence={(runId) => void retryEvidence(runId)}
                onOpenTerminal={(runId) => void openTerminal(runId)}
                onTakeOverRun={(runId) => void takeOverRun(runId)}
              />
            </div>
          ) : null}
        </main>
      </div>

      {repoModalOpen ? (
        <Modal title="Add repo" onClose={() => setRepoModalOpen(false)}>
          <RepoForm
            onSubmit={async (input) => {
              await api.createRepo(input);
              setRepoModalOpen(false);
              setNotice('Repo added to the board.');
            }}
          />
        </Modal>
      ) : null}

      {repoToEdit ? (
        <Modal title={`Edit ${repoToEdit.projectPath ?? repoToEdit.slug}`} onClose={() => setRepoToEditId(undefined)}>
          <div className="space-y-4">
            <RepoForm
              initialValues={{
                slug: repoToEdit.slug,
                scmProvider: repoToEdit.scmProvider,
                scmBaseUrl: repoToEdit.scmBaseUrl,
                projectPath: repoToEdit.projectPath,
                defaultBranch: repoToEdit.defaultBranch,
                baselineUrl: repoToEdit.baselineUrl,
                previewMode: repoToEdit.previewMode,
                evidenceMode: repoToEdit.evidenceMode,
                previewAdapter: repoToEdit.previewAdapter,
                previewConfig: repoToEdit.previewConfig,
                commitConfig: repoToEdit.commitConfig,
                previewProvider: repoToEdit.previewProvider,
                previewCheckName: repoToEdit.previewCheckName,
                llmAdapter: repoToEdit.llmAdapter,
                llmProfileId: repoToEdit.llmProfileId,
                llmAuthBundleR2Key: repoToEdit.llmAuthBundleR2Key,
                codexAuthBundleR2Key: repoToEdit.codexAuthBundleR2Key,
                autoReview: repoToEdit.autoReview,
                sentinelConfig: repoToEdit.sentinelConfig
              }}
              submitLabel="Save repo"
              onSubmit={async (input) => {
                const { sentinelConfig, ...repoPatch } = input;
                await api.updateRepo(repoToEdit.repoId, repoPatch);
                if (sentinelConfig) {
                  const status = await api.updateRepoSentinelConfig(repoToEdit.repoId, sentinelConfig);
                  setRepoSentinelStatus(status);
                }
                setRepoToEditId(undefined);
                setNotice(`Updated ${input.projectPath ?? input.slug ?? repoToEdit.projectPath ?? repoToEdit.slug}.`);
              }}
            />
            <section className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-100">Sentinel status</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {repoSentinelLoading
                      ? 'Loading status...'
                      : `Run state: ${repoSentinelStatus?.run?.status ?? 'idle'} · Scope: ${repoSentinelStatus?.run?.scopeType ?? 'n/a'}`}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-emerald-400/35 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100"
                    onClick={() => void triggerRepoSentinelAction(repoToEdit.repoId, 'start')}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-100"
                    onClick={() => void triggerRepoSentinelAction(repoToEdit.repoId, 'pause')}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100"
                    onClick={() => void triggerRepoSentinelAction(repoToEdit.repoId, 'resume')}
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-rose-400/35 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-100"
                    onClick={() => void triggerRepoSentinelAction(repoToEdit.repoId, 'stop')}
                  >
                    Stop
                  </button>
                </div>
              </div>
              {repoSentinelError ? <div className="mt-2 text-sm text-rose-300">{repoSentinelError}</div> : null}
              <div className="mt-3 max-h-52 space-y-2 overflow-auto">
                {repoSentinelStatus?.diagnostics?.latestErrorEvent ? (
                  <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    <div className="font-semibold">Latest error</div>
                    <div className="mt-1">{repoSentinelStatus.diagnostics.latestErrorEvent.message}</div>
                  </div>
                ) : null}
                {(repoSentinelStatus?.events ?? []).length ? (
                  repoSentinelStatus?.events.map((event) => (
                    <div key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-300">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={
                            event.level === 'error'
                              ? 'rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] uppercase text-rose-200'
                              : event.level === 'warn'
                                ? 'rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase text-amber-200'
                                : 'rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] uppercase text-cyan-200'
                          }
                          >
                            {event.level}
                          </span>
                          <span>{event.type}</span>
                        </div>
                        <span className="text-slate-500">{new Date(event.at).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 text-slate-400">{event.message}</div>
                      {event.metadata && Object.keys(event.metadata).length ? (
                        <div className="mt-1 text-[11px] text-slate-500">
                          {Object.entries(event.metadata).map(([key, value]) => `${key}=${String(value)}`).join(' · ')}
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-slate-500">No sentinel events yet.</div>
                )}
              </div>
            </section>
          </div>
        </Modal>
      ) : null}

      {taskModalOpen ? (
        <Modal title="Create task" onClose={() => setTaskModalOpen(false)}>
          <TaskForm
            repos={repos}
            onSubmit={async (input) => {
              const task = await api.createTask(input);
              await api.setSelectedTaskId(task.taskId);
              if (input.status === 'ACTIVE') {
                await api.startRun(task.taskId);
              }
              setTaskModalOpen(false);
              setNotice('Task created.');
            }}
          />
        </Modal>
      ) : null}

      {taskToEdit ? (
        <Modal title={`Edit ${taskToEdit.title}`} onClose={() => setTaskToEditId(undefined)}>
          <TaskForm
            repos={repos}
            initialValues={{
              repoId: taskToEdit.repoId,
              title: taskToEdit.title,
              description: taskToEdit.description,
              sourceRef: taskToEdit.sourceRef,
              dependencies: taskToEdit.dependencies,
              dependencyState: taskToEdit.dependencyState,
              automationState: taskToEdit.automationState,
              branchSource: taskToEdit.branchSource,
              taskPrompt: taskToEdit.taskPrompt,
              acceptanceCriteria: taskToEdit.acceptanceCriteria,
              context: taskToEdit.context,
              status: taskToEdit.status,
              baselineUrlOverride: taskToEdit.baselineUrlOverride,
              autoReviewMode: taskToEdit.uiMeta?.autoReviewMode,
              autoReviewPrompt: taskToEdit.uiMeta?.autoReviewPrompt,
              llmAdapter: taskToEdit.uiMeta?.llmAdapter,
              llmModel: taskToEdit.uiMeta?.llmModel,
              llmReasoningEffort: taskToEdit.uiMeta?.llmReasoningEffort,
              codexModel: taskToEdit.uiMeta?.codexModel,
              codexReasoningEffort: taskToEdit.uiMeta?.codexReasoningEffort
            }}
            submitLabel="Save task"
            onSubmit={async (input) => {
              await api.updateTask(taskToEdit.taskId, input);
              await api.setSelectedTaskId(taskToEdit.taskId);
              setTaskToEditId(undefined);
              setNotice(`Updated ${taskToEdit.title}.`);
            }}
          />
        </Modal>
      ) : null}

      {changeRequestRunId ? (
        <Modal title="Request changes" onClose={() => setChangeRequestRunId(undefined)}>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              await requestChanges(changeRequestRunId);
            }}
          >
            <label className="grid gap-2 text-sm">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Change request</span>
              <textarea
                className="rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                value={changeRequestPrompt}
                onChange={(event) => setChangeRequestPrompt(event.target.value)}
                rows={6}
                placeholder="Describe the changes you want on the current PR."
                required
              />
              <span className="text-xs text-slate-500">This creates a fresh run on the existing review branch and updates the same PR.</span>
            </label>
            <label className="grid gap-2 text-sm">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Review scope</span>
              <select
                className="rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                value={changeRequestMode}
                onChange={(event) => {
                  setChangeRequestMode(event.target.value as 'all' | 'include' | 'exclude' | 'freeform');
                  setChangeRequestFindingIds('');
                }}
              >
                <option value="all">All findings</option>
                <option value="include">Include finding IDs</option>
                <option value="exclude">Exclude finding IDs</option>
                <option value="freeform">Freeform instruction</option>
              </select>
            </label>
            <label className="grid gap-2 text-sm">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                Finding IDs (comma or newline separated)
              </span>
              <textarea
                className="rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                value={changeRequestFindingIds}
                onChange={(event) => setChangeRequestFindingIds(event.target.value)}
                rows={2}
                placeholder="f1, f2, f3"
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Rerun intent</span>
              <textarea
                className="rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                value={changeRequestInstruction}
                onChange={(event) => setChangeRequestInstruction(event.target.value)}
                rows={2}
                placeholder="Optional instruction to prioritize or scope your rerun."
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={changeRequestIncludeReplies}
                onChange={(event) => setChangeRequestIncludeReplies(event.target.checked)}
                type="checkbox"
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-400 focus:ring-2 focus:ring-cyan-400/35 focus:ring-offset-0"
              />
              <span>Include provider replies in request context</span>
            </label>
            <button
              type="submit"
              className="inline-flex h-11 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/15 px-4 text-sm font-medium text-amber-50 transition hover:bg-amber-500/25"
            >
              Start review rerun
            </button>
          </form>
        </Modal>
      ) : null}

      {terminalModalRunId && terminalBootstrap ? (
        <Modal
          title={`Live terminal · ${terminalRun?.branchName ?? terminalModalRunId}`}
          closeLabel="Disconnect"
          className="max-w-7xl"
          onClose={() => {
            setTerminalModalRunId(undefined);
            setTerminalBootstrap(undefined);
            setTerminalResumeCopied(false);
          }}
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(22rem,0.85fr)]">
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Operator session</div>
                  <div className="mt-1 text-sm text-slate-200">
                    {terminalRun?.operatorSession?.connectionState ?? (terminalBootstrap.attachable ? 'connecting' : 'unavailable')}
                    {' · '}
                    {terminalRun?.operatorSession?.takeoverState ?? 'observing'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Separate operator shell. The executor keeps running until you explicitly take over.
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {terminalRun?.status !== 'OPERATOR_CONTROLLED' ? (
                    <button
                      type="button"
                      onClick={() => void takeOverRun(terminalModalRunId)}
                      className="inline-flex h-8 items-center rounded-lg border border-amber-400/35 bg-amber-500/15 px-3 text-xs font-medium text-amber-50 transition hover:bg-amber-500/25"
                    >
                      Take over
                    </button>
                  ) : null}
                  <div className="text-xs text-slate-500">
                    {terminalBootstrap.sessionName} · {terminalBootstrap.cols}x{terminalBootstrap.rows}
                  </div>
                </div>
              </div>
              {terminalBootstrap.attachable ? (
                <RunTerminal bootstrap={terminalBootstrap} />
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm text-slate-400">
                  Terminal unavailable: {terminalBootstrap.reason ?? 'unknown error'}.
                </div>
              )}
            </section>

            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Live executor stream</div>
                  <div className="mt-1 text-sm text-slate-300">
                    {terminalExecutorLogs.length ? 'Streaming executor output.' : 'Showing live run logs while dedicated executor output is unavailable.'}
                  </div>
                </div>
                {(terminalRun?.llmResumeCommand ?? terminalRun?.latestCodexResumeCommand) ? (
                  <button
                    type="button"
                    onClick={() => void copyTerminalResumeCommand()}
                    className="inline-flex h-8 items-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 text-xs font-medium text-cyan-50 transition hover:bg-cyan-500/25"
                  >
                    {terminalResumeCopied ? 'Copied resume' : 'Copy resume'}
                  </button>
                ) : null}
              </div>
              {(terminalRun?.llmResumeCommand ?? terminalRun?.latestCodexResumeCommand) ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Resume command</div>
                  <code className="mt-2 block break-all text-xs text-cyan-200">{terminalRun?.llmResumeCommand ?? terminalRun?.latestCodexResumeCommand}</code>
                </div>
              ) : null}
              <div className="max-h-[28rem] space-y-2 overflow-auto rounded-xl border border-slate-900 bg-[#040812] p-3 font-mono text-xs">
                {terminalStreamLogs.length ? (
                  terminalStreamLogs.map((log) => (
                    <div key={log.id} className="rounded-lg border border-slate-900/80 bg-slate-950/80 px-3 py-2">
                      <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                        <span className={log.level === 'error' ? 'text-rose-300' : 'text-cyan-300'}>{log.phase ?? 'run'}</span>
                        <span>{new Date(log.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <code className="mt-2 block whitespace-pre-wrap break-words text-slate-200">{log.message}</code>
                    </div>
                  ))
                ) : (
                  <p className="text-slate-500">Logs will stream here once the run emits output.</p>
                )}
              </div>
            </section>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
