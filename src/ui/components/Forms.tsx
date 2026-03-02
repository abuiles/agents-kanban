import { useEffect, useState } from 'react';
import type { CreateRepoInput, CreateTaskInput } from '../domain/api';
import type { CodexModel, CodexReasoningEffort, Repo, TaskContextLink, TaskDependency, TaskStatus } from '../domain/types';

const CODEX_MODELS: Array<{ value: CodexModel; label: string }> = [
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini (default)' },
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
  { value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' }
];

function FieldShell({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{label}</span>
      {children}
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

function inputClass() {
  return 'h-11 rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20';
}

function textareaClass() {
  return 'rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20';
}

function PrimaryButton({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="inline-flex h-11 items-center justify-center rounded-xl border border-cyan-400/35 bg-cyan-500/15 px-4 text-sm font-medium text-cyan-50 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-500"
    >
      {children}
    </button>
  );
}

export function RepoForm({
  onSubmit,
  initialValues,
  submitLabel = 'Add repo'
}: {
  onSubmit: (input: CreateRepoInput) => Promise<void> | void;
  initialValues?: Partial<CreateRepoInput>;
  submitLabel?: string;
}) {
  const initialSlug = initialValues?.slug ?? '';
  const initialDefaultBranch = initialValues?.defaultBranch ?? 'main';
  const initialBaselineUrl = initialValues?.baselineUrl ?? '';
  const initialPreviewCheckName = initialValues?.previewCheckName ?? '';
  const initialCodexAuthBundleR2Key = initialValues?.codexAuthBundleR2Key ?? '';

  const [slug, setSlug] = useState(initialSlug);
  const [defaultBranch, setDefaultBranch] = useState(initialDefaultBranch);
  const [baselineUrl, setBaselineUrl] = useState(initialBaselineUrl);
  const [previewCheckName, setPreviewCheckName] = useState(initialPreviewCheckName);
  const [codexAuthBundleR2Key, setCodexAuthBundleR2Key] = useState(initialCodexAuthBundleR2Key);

  useEffect(() => {
    setSlug(initialSlug);
    setDefaultBranch(initialDefaultBranch);
    setBaselineUrl(initialBaselineUrl);
    setPreviewCheckName(initialPreviewCheckName);
    setCodexAuthBundleR2Key(initialCodexAuthBundleR2Key);
  }, [initialSlug, initialDefaultBranch, initialBaselineUrl, initialPreviewCheckName, initialCodexAuthBundleR2Key]);

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit({
          slug,
          defaultBranch,
          baselineUrl,
          enabled: true,
          previewCheckName: previewCheckName || undefined,
          codexAuthBundleR2Key: codexAuthBundleR2Key || undefined
        });
        setSlug('');
        setDefaultBranch('main');
        setBaselineUrl('');
        setPreviewCheckName('');
        setCodexAuthBundleR2Key('');
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Repo slug" hint="Use the GitHub owner/name format.">
          <input className={inputClass()} value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="owner/name" required />
        </FieldShell>
        <FieldShell label="Default branch">
          <input className={inputClass()} value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} required />
        </FieldShell>
      </div>
      <FieldShell label="Baseline URL" hint="Used as the before state for evidence runs.">
        <input className={inputClass()} value={baselineUrl} onChange={(event) => setBaselineUrl(event.target.value)} placeholder="https://example.com" required />
      </FieldShell>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Preview check name" hint="Optional GitHub check name used to discover the Cloudflare preview URL.">
          <input className={inputClass()} value={previewCheckName} onChange={(event) => setPreviewCheckName(event.target.value)} placeholder="Cloudflare Pages" />
        </FieldShell>
        <FieldShell label="Codex auth bundle key" hint="Optional R2 key for a `.codex` auth bundle tarball.">
          <input className={inputClass()} value={codexAuthBundleR2Key} onChange={(event) => setCodexAuthBundleR2Key(event.target.value)} placeholder="auth/codex.tgz" />
        </FieldShell>
      </div>
      <PrimaryButton>{submitLabel}</PrimaryButton>
    </form>
  );
}

function parseCriteria(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseLinks(value: string): TaskContextLink[] {
  return value
    .split('\n')
    .map((line, index) => {
      const [label, url] = line.split('|').map((segment) => segment.trim());
      if (!label || !url) {
        return undefined;
      }

      return { id: `link_${index}_${label}`, label, url };
    })
    .filter((link): link is TaskContextLink => Boolean(link));
}

function serializeDependencies(value: CreateTaskInput['dependencies']): string {
  return (value ?? [])
    .map((dependency) => `${dependency.upstreamTaskId}${dependency.primary ? '|primary' : ''}`)
    .join('\n');
}

function parseDependencies(value: string): TaskDependency[] {
  const dependencies: TaskDependency[] = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [upstreamTaskIdRaw, primaryRaw] = line.split('|').map((segment) => segment.trim());
      const upstreamTaskId = upstreamTaskIdRaw ?? '';
      const primaryToken = (primaryRaw ?? '').toLowerCase();
      const primary = primaryToken === 'primary' || primaryToken === 'true' || primaryToken === 'yes';
      return { upstreamTaskId, mode: 'review_ready' as const, primary };
    })
    .filter((dependency) => Boolean(dependency.upstreamTaskId));

  if (dependencies.filter((dependency) => dependency.primary).length > 1) {
    return dependencies.map((dependency, index) => ({ ...dependency, primary: index === 0 && dependency.primary }));
  }

  return dependencies;
}

export function TaskForm({
  repos,
  onSubmit,
  initialStatus = 'INBOX',
  initialValues,
  submitLabel = 'Create task'
}: {
  repos: Repo[];
  onSubmit: (input: CreateTaskInput) => Promise<void> | void;
  initialStatus?: TaskStatus;
  initialValues?: Partial<CreateTaskInput>;
  submitLabel?: string;
}) {
  const initialRepoId = initialValues?.repoId ?? repos[0]?.repoId ?? '';
  const initialTitle = initialValues?.title ?? '';
  const initialDescription = initialValues?.description ?? '';
  const initialSourceRef = initialValues?.sourceRef ?? '';
  const initialTaskPrompt = initialValues?.taskPrompt ?? '';
  const initialCriteria = initialValues?.acceptanceCriteria?.join('\n') ?? '';
  const initialNotes = initialValues?.context?.notes ?? '';
  const initialLinks = initialValues?.context?.links?.map((link) => `${link.label}|${link.url}`).join('\n') ?? '';
  const initialDependencies = serializeDependencies(initialValues?.dependencies);
  const initialTaskStatus = initialValues?.status ?? initialStatus;
  const initialBaselineUrlOverride = initialValues?.baselineUrlOverride ?? '';
  const initialAutoStartEligible = initialValues?.automationState?.autoStartEligible ?? false;
  const initialCodexModel = initialValues?.codexModel ?? 'gpt-5.1-codex-mini';
  const initialCodexReasoningEffort = initialValues?.codexReasoningEffort ?? 'medium';

  const [repoId, setRepoId] = useState(initialRepoId);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [sourceRef, setSourceRef] = useState(initialSourceRef);
  const [taskPrompt, setTaskPrompt] = useState(initialTaskPrompt);
  const [criteria, setCriteria] = useState(initialCriteria);
  const [notes, setNotes] = useState(initialNotes);
  const [links, setLinks] = useState(initialLinks);
  const [dependencies, setDependencies] = useState(initialDependencies);
  const [status, setStatus] = useState<TaskStatus>(initialTaskStatus);
  const [baselineUrlOverride, setBaselineUrlOverride] = useState(initialBaselineUrlOverride);
  const [autoStartEligible, setAutoStartEligible] = useState(initialAutoStartEligible);
  const [codexModel, setCodexModel] = useState<CodexModel>(initialCodexModel);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(initialCodexReasoningEffort);

  useEffect(() => {
    if (!repos.length) {
      setRepoId('');
      return;
    }

    if (!repos.some((repo) => repo.repoId === repoId)) {
      setRepoId(repos[0].repoId);
    }
  }, [repoId, repos]);

  useEffect(() => {
    setRepoId(initialRepoId);
    setTitle(initialTitle);
    setDescription(initialDescription);
    setSourceRef(initialSourceRef);
    setTaskPrompt(initialTaskPrompt);
    setCriteria(initialCriteria);
    setNotes(initialNotes);
    setLinks(initialLinks);
    setDependencies(initialDependencies);
    setStatus(initialTaskStatus);
    setBaselineUrlOverride(initialBaselineUrlOverride);
    setAutoStartEligible(initialAutoStartEligible);
    setCodexModel(initialCodexModel);
    setCodexReasoningEffort(initialCodexReasoningEffort);
  }, [
    initialAutoStartEligible,
    initialBaselineUrlOverride,
    initialCodexModel,
    initialCodexReasoningEffort,
    initialCriteria,
    initialDependencies,
    initialDescription,
    initialLinks,
    initialNotes,
    initialRepoId,
    initialSourceRef,
    initialTaskPrompt,
    initialTaskStatus,
    initialTitle
  ]);

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!repoId) {
          return;
        }

        const parsedDependencies = parseDependencies(dependencies);

        await onSubmit({
          repoId,
          title,
          description,
          sourceRef: sourceRef || undefined,
          dependencies: parsedDependencies.length ? parsedDependencies : undefined,
          automationState: { autoStartEligible },
          taskPrompt,
          acceptanceCriteria: parseCriteria(criteria),
          context: { links: parseLinks(links), notes },
          status,
          baselineUrlOverride: baselineUrlOverride || undefined,
          simulationProfile: 'happy_path',
          codexModel,
          codexReasoningEffort
        });
        setTitle('');
        setDescription('');
        setSourceRef('');
        setTaskPrompt('');
        setCriteria('');
        setNotes('');
        setLinks('');
        setDependencies('');
        setStatus(initialStatus);
        setBaselineUrlOverride('');
        setAutoStartEligible(false);
        setCodexModel('gpt-5.1-codex-mini');
        setCodexReasoningEffort('medium');
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Repo">
          <select className={inputClass()} value={repoId} onChange={(event) => setRepoId(event.target.value)} required disabled={!repos.length}>
            {repos.map((repo) => (
              <option key={repo.repoId} value={repo.repoId}>
                {repo.slug}
              </option>
            ))}
          </select>
        </FieldShell>
        <FieldShell label="Initial status">
          <select className={inputClass()} value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
            {['INBOX', 'READY', 'ACTIVE', 'REVIEW', 'DONE', 'FAILED'].map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </FieldShell>
      </div>

      {!repos.length ? <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Add a repo before creating tasks.</p> : null}

      <FieldShell label="Title">
        <input className={inputClass()} value={title} onChange={(event) => setTitle(event.target.value)} required />
      </FieldShell>

      <FieldShell label="Description">
        <textarea className={textareaClass()} value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
      </FieldShell>

      <FieldShell label="Source ref" hint="Optional GitHub PR URL, branch URL, branch name, or commit SHA to start the run from.">
        <input
          className={inputClass()}
          value={sourceRef}
          onChange={(event) => setSourceRef(event.target.value)}
          placeholder="https://github.com/owner/repo/pull/4"
        />
      </FieldShell>

      <FieldShell label="Task prompt">
        <textarea className={textareaClass()} value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} rows={5} required />
      </FieldShell>

      <div className="grid gap-4 xl:grid-cols-2">
        <FieldShell label="Acceptance criteria" hint="One line per criterion.">
          <textarea className={textareaClass()} value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={5} required />
        </FieldShell>
        <FieldShell label="Context links" hint="Use label|url per line.">
          <textarea className={textareaClass()} value={links} onChange={(event) => setLinks(event.target.value)} rows={5} placeholder="Spec|https://docs.example.com/spec" />
        </FieldShell>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <FieldShell label="Notes">
          <textarea className={textareaClass()} value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
        </FieldShell>
        <FieldShell label="Baseline override">
          <input className={inputClass()} value={baselineUrlOverride} onChange={(event) => setBaselineUrlOverride(event.target.value)} placeholder="https://staging.example.com" />
        </FieldShell>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <FieldShell label="Dependencies" hint="One upstream task id per line. Optional: task_id|primary">
          <textarea
            className={textareaClass()}
            value={dependencies}
            onChange={(event) => setDependencies(event.target.value)}
            rows={4}
            placeholder="task_repo_123abc\ntask_repo_456def|primary"
          />
        </FieldShell>
        <FieldShell label="Auto-start eligibility" hint="When enabled, this task can auto-start once dependency/source rules pass.">
          <div className="flex h-11 items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm text-slate-100">
            <input
              type="checkbox"
              checked={autoStartEligible}
              onChange={(event) => setAutoStartEligible(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-cyan-400 focus:ring-cyan-400/30"
            />
            <span>{autoStartEligible ? 'Eligible' : 'Not eligible'}</span>
          </div>
        </FieldShell>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Codex model" hint="Per-task execution model.">
          <select className={inputClass()} value={codexModel} onChange={(event) => setCodexModel(event.target.value as CodexModel)}>
            {CODEX_MODELS.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </select>
        </FieldShell>
        <FieldShell label="Reasoning effort" hint="Passed to Codex as model reasoning effort.">
          <select
            className={inputClass()}
            value={codexReasoningEffort}
            onChange={(event) => setCodexReasoningEffort(event.target.value as CodexReasoningEffort)}
          >
            <option value="low">low</option>
            <option value="medium">medium (default)</option>
            <option value="high">high</option>
          </select>
        </FieldShell>
      </div>
      <PrimaryButton disabled={!repos.length}>{submitLabel}</PrimaryButton>
    </form>
  );
}
