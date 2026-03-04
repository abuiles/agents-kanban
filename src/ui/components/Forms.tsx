import { useEffect, useState } from 'react';
import type { CreateRepoInput, CreateTaskInput } from '../domain/api';
import type {
  AutoReviewMode,
  AutoReviewProvider,
  CodexModel,
  LlmAdapter,
  LlmReasoningEffort,
  PreviewAdapterKind,
  Repo,
  ScmProvider,
  TaskContextLink,
  TaskDependency,
  TaskStatus
} from '../domain/types';
import { normalizeRepoPreviewConfig } from '../../shared/preview';

const DEFAULT_SCM_BASE_URLS: Record<ScmProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com'
};

const CODEX_MODELS: Array<{ value: CodexModel; label: string }> = [
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini (default)' },
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
  { value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' }
];

const DEFAULT_LLM_MODELS: Record<LlmAdapter, string> = {
  codex: 'gpt-5.1-codex-mini',
  cursor_cli: 'cursor-default'
};

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
  const initialScmProvider = initialValues?.scmProvider ?? 'github';
  const initialProjectPath = initialValues?.projectPath ?? initialValues?.slug ?? '';
  const initialScmBaseUrl = initialValues?.scmBaseUrl ?? DEFAULT_SCM_BASE_URLS[initialScmProvider];
  const initialDefaultBranch = initialValues?.defaultBranch ?? 'main';
  const initialBaselineUrl = initialValues?.baselineUrl ?? '';
  const initialLlmAdapter = initialValues?.llmAdapter ?? 'codex';
  const initialLlmProfileId = initialValues?.llmProfileId ?? '';
  const initialLlmAuthBundleR2Key = initialValues?.llmAuthBundleR2Key ?? initialValues?.codexAuthBundleR2Key ?? '';
  const normalizedPreview = normalizeRepoPreviewConfig({
    previewAdapter: initialValues?.previewAdapter,
    previewConfig: initialValues?.previewConfig,
    previewProvider: initialValues?.previewProvider,
    previewCheckName: initialValues?.previewCheckName
  });
  const initialAutoReviewEnabled = initialValues?.autoReview?.enabled ?? false;
  const initialAutoReviewProvider = initialValues?.autoReview?.provider ?? 'gitlab';
  const initialAutoReviewPostInline = initialValues?.autoReview?.postInline ?? false;
  const initialAutoReviewPrompt = initialValues?.autoReview?.prompt ?? '';
  const initialPreviewMode = initialValues?.previewMode ?? 'auto';
  const initialEvidenceMode = initialValues?.evidenceMode ?? 'auto';
  const initialPreviewAdapter = normalizedPreview.previewAdapter ?? 'cloudflare_checks';
  const initialPreviewCheckName = normalizedPreview.previewConfig?.checkName ?? '';
  const initialPromptRecipe = normalizedPreview.previewConfig?.promptRecipe ?? '';
  const initialCodexAuthBundleR2Key = initialValues?.codexAuthBundleR2Key ?? '';
  const initialCommitMessageTemplate = initialValues?.commitConfig?.messageTemplate ?? '';
  const initialCommitMessageRegex = initialValues?.commitConfig?.messageRegex ?? '';
  const initialCommitMessageExamples = (initialValues?.commitConfig?.messageExamples ?? []).join('\n');

  const [scmProvider, setScmProvider] = useState<ScmProvider>(initialScmProvider);
  const [scmBaseUrl, setScmBaseUrl] = useState(initialScmBaseUrl);
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [defaultBranch, setDefaultBranch] = useState(initialDefaultBranch);
  const [baselineUrl, setBaselineUrl] = useState(initialBaselineUrl);
  const [previewMode, setPreviewMode] = useState<NonNullable<CreateRepoInput['previewMode']>>(initialPreviewMode);
  const [evidenceMode, setEvidenceMode] = useState<NonNullable<CreateRepoInput['evidenceMode']>>(initialEvidenceMode);
  const [previewAdapter, setPreviewAdapter] = useState<PreviewAdapterKind>(initialPreviewAdapter);
  const [previewCheckName, setPreviewCheckName] = useState(initialPreviewCheckName);
  const [llmAdapter, setLlmAdapter] = useState<LlmAdapter>(initialLlmAdapter);
  const [llmProfileId, setLlmProfileId] = useState(initialLlmProfileId);
  const [llmAuthBundleR2Key, setLlmAuthBundleR2Key] = useState(initialLlmAuthBundleR2Key);
  const [promptRecipe, setPromptRecipe] = useState(initialPromptRecipe);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(initialAutoReviewEnabled);
  const [autoReviewProvider, setAutoReviewProvider] = useState<AutoReviewProvider>(initialAutoReviewProvider);
  const [autoReviewPostInline, setAutoReviewPostInline] = useState(initialAutoReviewPostInline);
  const [autoReviewPrompt, setAutoReviewPrompt] = useState(initialAutoReviewPrompt);
  const [codexAuthBundleR2Key, setCodexAuthBundleR2Key] = useState(initialCodexAuthBundleR2Key);
  const [commitMessageTemplate, setCommitMessageTemplate] = useState(initialCommitMessageTemplate);
  const [commitMessageRegex, setCommitMessageRegex] = useState(initialCommitMessageRegex);
  const [commitMessageExamples, setCommitMessageExamples] = useState(initialCommitMessageExamples);

  useEffect(() => {
    setScmProvider(initialScmProvider);
    setScmBaseUrl(initialScmBaseUrl);
    setProjectPath(initialProjectPath);
    setDefaultBranch(initialDefaultBranch);
    setBaselineUrl(initialBaselineUrl);
    setPreviewMode(initialPreviewMode);
    setEvidenceMode(initialEvidenceMode);
    setPreviewAdapter(initialPreviewAdapter);
    setPreviewCheckName(initialPreviewCheckName);
    setLlmAdapter(initialLlmAdapter);
    setLlmProfileId(initialLlmProfileId);
    setLlmAuthBundleR2Key(initialLlmAuthBundleR2Key);
    setPromptRecipe(initialPromptRecipe);
    setAutoReviewEnabled(initialAutoReviewEnabled);
    setAutoReviewProvider(initialAutoReviewProvider);
    setAutoReviewPostInline(initialAutoReviewPostInline);
    setAutoReviewPrompt(initialAutoReviewPrompt);
    setCodexAuthBundleR2Key(initialCodexAuthBundleR2Key);
    setCommitMessageTemplate(initialCommitMessageTemplate);
    setCommitMessageRegex(initialCommitMessageRegex);
    setCommitMessageExamples(initialCommitMessageExamples);
  }, [
    initialScmProvider,
    initialScmBaseUrl,
    initialProjectPath,
    initialDefaultBranch,
    initialBaselineUrl,
    initialAutoReviewEnabled,
    initialAutoReviewProvider,
    initialAutoReviewPostInline,
    initialAutoReviewPrompt,
    initialPreviewMode,
    initialEvidenceMode,
    initialPreviewAdapter,
    initialPreviewCheckName,
    initialLlmAdapter,
    initialLlmProfileId,
    initialLlmAuthBundleR2Key,
    initialPromptRecipe,
    initialCodexAuthBundleR2Key,
    initialCommitMessageTemplate,
    initialCommitMessageRegex,
    initialCommitMessageExamples
  ]);

  const projectPathHint = scmProvider === 'gitlab'
    ? 'Use the GitLab project path like group/subgroup/repo.'
    : 'Use the GitHub repository path like owner/repo.';
  const projectPathPlaceholder = scmProvider === 'gitlab' ? 'group/subgroup/repo' : 'owner/repo';
  const scmBaseUrlLabel = scmProvider === 'gitlab' ? 'GitLab base URL' : 'GitHub base URL';
  const scmBaseUrlHint = scmProvider === 'gitlab'
    ? 'Use https://gitlab.com for hosted GitLab, or your self-managed GitLab origin.'
    : 'Use the GitHub host origin for GitHub.com or GitHub Enterprise Server.';
  const previewCheckHint = scmProvider === 'gitlab'
    ? 'Optional check or pipeline name used to discover the Cloudflare preview URL.'
    : 'Optional check name used to discover the Cloudflare preview URL.';
  const previewEnabled = previewMode !== 'skip';
  const previewConfig = {
    ...(previewAdapter === 'cloudflare_checks' && previewCheckName.trim() ? { checkName: previewCheckName.trim() } : {}),
    ...(previewAdapter === 'prompt_recipe' && promptRecipe.trim() ? { promptRecipe: promptRecipe.trim() } : {})
  };
  const commitMessageExamplesList = commitMessageExamples
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const commitConfig = {
    ...(commitMessageTemplate.trim() ? { messageTemplate: commitMessageTemplate.trim() } : {}),
    ...(commitMessageRegex.trim() ? { messageRegex: commitMessageRegex.trim() } : {}),
    ...(commitMessageExamplesList.length ? { messageExamples: commitMessageExamplesList } : {})
  };

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit({
          slug: projectPath,
          scmProvider,
          scmBaseUrl,
          projectPath,
          llmAdapter,
          llmProfileId: llmProfileId || undefined,
          llmAuthBundleR2Key: llmAuthBundleR2Key || undefined,
          defaultBranch,
          baselineUrl,
          enabled: true,
          autoReview: {
            enabled: autoReviewEnabled,
            provider: autoReviewProvider,
            postInline: autoReviewPostInline,
            ...(autoReviewPrompt.trim() ? { prompt: autoReviewPrompt.trim() } : {})
          },
          previewMode,
          evidenceMode,
          previewAdapter,
          previewConfig: Object.keys(previewConfig).length > 0 ? previewConfig : undefined,
          commitConfig: Object.keys(commitConfig).length > 0 ? commitConfig : undefined,
          previewCheckName: previewCheckName || undefined,
          codexAuthBundleR2Key: codexAuthBundleR2Key || (llmAdapter === 'codex' ? (llmAuthBundleR2Key || undefined) : undefined)
        });
        setScmProvider('github');
        setScmBaseUrl(DEFAULT_SCM_BASE_URLS.github);
        setProjectPath('');
        setDefaultBranch('main');
        setBaselineUrl('');
        setPreviewMode('auto');
        setEvidenceMode('auto');
        setPreviewAdapter('cloudflare_checks');
        setPreviewCheckName('');
        setLlmAdapter('codex');
        setLlmProfileId('');
        setLlmAuthBundleR2Key('');
        setPromptRecipe('');
        setAutoReviewEnabled(false);
        setAutoReviewProvider('gitlab');
        setAutoReviewPostInline(false);
        setAutoReviewPrompt('');
        setCodexAuthBundleR2Key('');
        setCommitMessageTemplate('');
        setCommitMessageRegex('');
        setCommitMessageExamples('');
      }}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <FieldShell label="SCM provider">
          <select
            className={inputClass()}
            value={scmProvider}
            onChange={(event) => {
              const nextProvider = event.target.value as ScmProvider;
              setScmProvider(nextProvider);
              setScmBaseUrl((currentValue) => {
                const normalizedValue = currentValue.trim();
                if (!normalizedValue || normalizedValue === DEFAULT_SCM_BASE_URLS[scmProvider]) {
                  return DEFAULT_SCM_BASE_URLS[nextProvider];
                }
                return currentValue;
              });
            }}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </FieldShell>
        <FieldShell label={scmBaseUrlLabel} hint={scmBaseUrlHint}>
          <input
            className={inputClass()}
            value={scmBaseUrl}
            onChange={(event) => setScmBaseUrl(event.target.value)}
            placeholder={DEFAULT_SCM_BASE_URLS[scmProvider]}
            required
          />
        </FieldShell>
        <FieldShell label="Project path" hint={projectPathHint}>
          <input
            className={inputClass()}
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder={projectPathPlaceholder}
            required
          />
        </FieldShell>
        <FieldShell label="Default branch">
          <input className={inputClass()} value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} required />
        </FieldShell>
      </div>
      <FieldShell label="Baseline URL" hint="Used as the before state for evidence runs.">
        <input className={inputClass()} value={baselineUrl} onChange={(event) => setBaselineUrl(event.target.value)} placeholder="https://example.com" required />
      </FieldShell>
      <div className="grid gap-4 md:grid-cols-3">
        <FieldShell label="Preview mode" hint="Skip bypasses preview discovery entirely.">
          <select className={inputClass()} value={previewMode} onChange={(event) => setPreviewMode(event.target.value as NonNullable<CreateRepoInput['previewMode']>)}>
            <option value="auto">Auto</option>
            <option value="skip">Skip</option>
          </select>
        </FieldShell>
        <FieldShell label="Evidence mode" hint="Skip disables evidence even when preview succeeds.">
          <select className={inputClass()} value={evidenceMode} onChange={(event) => setEvidenceMode(event.target.value as NonNullable<CreateRepoInput['evidenceMode']>)}>
            <option value="auto">Auto</option>
            <option value="skip">Skip</option>
          </select>
        </FieldShell>
        <FieldShell label="Preview adapter" hint={previewEnabled ? 'Choose how preview URLs are resolved.' : 'Preview is skipped, so adapter settings are inactive.'}>
          <select
            className={inputClass()}
            value={previewAdapter}
            onChange={(event) => setPreviewAdapter(event.target.value as PreviewAdapterKind)}
            disabled={!previewEnabled}
          >
            <option value="cloudflare_checks">Cloudflare checks</option>
            <option value="prompt_recipe">Prompt recipe</option>
          </select>
        </FieldShell>
      </div>
      {previewEnabled && previewAdapter === 'cloudflare_checks' ? (
        <FieldShell label="Check or pipeline name" hint={previewCheckHint}>
          <input className={inputClass()} value={previewCheckName} onChange={(event) => setPreviewCheckName(event.target.value)} placeholder="Workers Builds: app" />
        </FieldShell>
      ) : null}
      {previewEnabled && previewAdapter === 'prompt_recipe' ? (
        <FieldShell label="Prompt recipe" hint="Instructions for deriving a usable preview URL from repo metadata, review state, and checks.">
          <textarea
            className={textareaClass()}
            value={promptRecipe}
            onChange={(event) => setPromptRecipe(event.target.value)}
            rows={5}
            placeholder="Find the preview URL from deployment logs or commit statuses and return one usable URL."
            required
          />
        </FieldShell>
      ) : null}
      <div className="grid gap-4 md:grid-cols-3">
        <FieldShell label="Auto-review enabled" hint="Enable automatic review runs for this repo by default.">
          <div className="flex h-11 items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm text-slate-100">
            <input
              type="checkbox"
              checked={autoReviewEnabled}
              onChange={(event) => setAutoReviewEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-cyan-400 focus:ring-cyan-400/30"
            />
            <span>{autoReviewEnabled ? 'Enabled' : 'Disabled'}</span>
          </div>
        </FieldShell>
        <FieldShell label="Auto-review provider" hint="Which integration should handle review automation.">
          <select className={inputClass()} value={autoReviewProvider} onChange={(event) => setAutoReviewProvider(event.target.value as AutoReviewProvider)}>
            <option value="gitlab">GitLab</option>
            <option value="jira">Jira</option>
          </select>
        </FieldShell>
        <FieldShell label="Post inline comments" hint="Add findings directly in review comments when supported.">
          <div className="flex h-11 items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/90 px-3 text-sm text-slate-100">
            <input
              type="checkbox"
              checked={autoReviewPostInline}
              onChange={(event) => setAutoReviewPostInline(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-cyan-400 focus:ring-cyan-400/30"
            />
            <span>{autoReviewPostInline ? 'Enabled' : 'Disabled'}</span>
          </div>
        </FieldShell>
      </div>
      <FieldShell label="Auto-review prompt" hint="Optional override prompt used when auto-review is enabled.">
        <textarea
          className={textareaClass()}
          value={autoReviewPrompt}
          onChange={(event) => setAutoReviewPrompt(event.target.value)}
          rows={4}
          placeholder="Prioritize API contract stability and security findings."
        />
      </FieldShell>
      <div className="grid gap-4 md:grid-cols-3">
        <FieldShell label="LLM adapter">
          <select className={inputClass()} value={llmAdapter} onChange={(event) => setLlmAdapter(event.target.value as LlmAdapter)}>
            <option value="codex">Codex</option>
            <option value="cursor_cli">Cursor CLI</option>
          </select>
        </FieldShell>
        <FieldShell label="LLM profile id" hint="Optional profile identifier used by adapter integrations.">
          <input className={inputClass()} value={llmProfileId} onChange={(event) => setLlmProfileId(event.target.value)} placeholder="codex-default" />
        </FieldShell>
        <FieldShell label="LLM auth bundle key" hint="Optional R2 key for executor credentials (for example `.codex` auth tarball).">
          <input className={inputClass()} value={llmAuthBundleR2Key} onChange={(event) => setLlmAuthBundleR2Key(event.target.value)} placeholder={llmAdapter === 'codex' ? 'auth/codex.tgz' : 'auth/cursor.tgz'} />
        </FieldShell>
      </div>
      <div className="grid gap-4 md:grid-cols-1">
        <FieldShell label="Codex auth bundle key" hint="Optional R2 key for a `.codex` auth bundle tarball.">
          <input className={inputClass()} value={codexAuthBundleR2Key} onChange={(event) => setCodexAuthBundleR2Key(event.target.value)} placeholder="auth/codex.tgz" />
        </FieldShell>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Commit template" hint="Optional. Tokens: {taskTitle}, {taskId}, {runId}, {repoSlug}, {defaultMessage}.">
          <input
            className={inputClass()}
            value={commitMessageTemplate}
            onChange={(event) => setCommitMessageTemplate(event.target.value)}
            placeholder="feat(cp): {taskTitle} [{taskId}]"
          />
        </FieldShell>
        <FieldShell label="Commit regex" hint="Optional JS regex that commit messages must match.">
          <input
            className={inputClass()}
            value={commitMessageRegex}
            onChange={(event) => setCommitMessageRegex(event.target.value)}
            placeholder="^feat\\(cp\\): .+ \\[task_[a-z0-9_]+\\]$"
          />
        </FieldShell>
      </div>
      <FieldShell label="Commit examples" hint="Optional. One example commit message per line.">
        <textarea
          className={textareaClass()}
          value={commitMessageExamples}
          onChange={(event) => setCommitMessageExamples(event.target.value)}
          rows={4}
          placeholder={'feat(cp): Add banner block support [task_abc123]\nfix(cp): Correct CTA URL handling [task_def456]'}
        />
      </FieldShell>
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
  const initialLlmAdapter = initialValues?.llmAdapter ?? 'codex';
  const initialLlmModel = initialValues?.llmModel ?? initialValues?.codexModel ?? DEFAULT_LLM_MODELS[initialLlmAdapter];
  const initialLlmReasoningEffort = initialValues?.llmReasoningEffort ?? initialValues?.codexReasoningEffort ?? 'medium';
  const initialAutoReviewMode = initialValues?.autoReviewMode ?? 'inherit';
  const initialAutoReviewPrompt = initialValues?.autoReviewPrompt ?? '';

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
  const [autoReviewMode, setAutoReviewMode] = useState<NonNullable<AutoReviewMode>>(initialAutoReviewMode);
  const [autoReviewPrompt, setAutoReviewPrompt] = useState(initialAutoReviewPrompt);
  const [llmAdapter, setLlmAdapter] = useState<LlmAdapter>(initialLlmAdapter);
  const [llmModel, setLlmModel] = useState(initialLlmModel);
  const [llmReasoningEffort, setLlmReasoningEffort] = useState<LlmReasoningEffort>(initialLlmReasoningEffort);

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
    setAutoReviewMode(initialAutoReviewMode);
    setAutoReviewPrompt(initialAutoReviewPrompt);
    setLlmAdapter(initialLlmAdapter);
    setLlmModel(initialLlmModel);
    setLlmReasoningEffort(initialLlmReasoningEffort);
  }, [
    initialAutoStartEligible,
    initialAutoReviewMode,
    initialAutoReviewPrompt,
    initialBaselineUrlOverride,
    initialLlmAdapter,
    initialLlmModel,
    initialLlmReasoningEffort,
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
          autoReviewMode,
          autoReviewPrompt: autoReviewPrompt.trim() || undefined,
          simulationProfile: 'happy_path',
          llmAdapter,
          llmModel: llmModel || undefined,
          llmReasoningEffort,
          codexModel: llmAdapter === 'codex' ? (llmModel as CodexModel) : undefined,
          codexReasoningEffort: llmAdapter === 'codex' ? llmReasoningEffort : undefined
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
        setAutoReviewMode('inherit');
        setAutoReviewPrompt('');
        setLlmAdapter('codex');
        setLlmModel('gpt-5.1-codex-mini');
        setLlmReasoningEffort('medium');
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
      <div className="grid gap-4 xl:grid-cols-2">
        <FieldShell label="Auto-review mode" hint="inherit uses repo setting; on/off force behavior for this task.">
          <select className={inputClass()} value={autoReviewMode} onChange={(event) => setAutoReviewMode(event.target.value as CreateTaskInput['autoReviewMode'])}>
            <option value="inherit">Inherit</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </FieldShell>
        <FieldShell label="Auto-review prompt" hint="Optional override prompt for this task.">
          <textarea
            className={textareaClass()}
            value={autoReviewPrompt}
            onChange={(event) => setAutoReviewPrompt(event.target.value)}
            rows={4}
            placeholder="Inspect for security and performance regressions."
          />
        </FieldShell>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="LLM adapter" hint="Selects the executor for this task.">
          <select
            className={inputClass()}
            value={llmAdapter}
            onChange={(event) => {
              const nextAdapter = event.target.value as LlmAdapter;
              setLlmAdapter(nextAdapter);
              if (!llmModel || llmModel === DEFAULT_LLM_MODELS.codex || llmModel === DEFAULT_LLM_MODELS.cursor_cli) {
                setLlmModel(DEFAULT_LLM_MODELS[nextAdapter]);
              }
            }}
          >
            <option value="codex">Codex</option>
            <option value="cursor_cli">Cursor CLI</option>
          </select>
        </FieldShell>
        <FieldShell label="LLM model" hint="Per-task execution model for the selected adapter.">
          {llmAdapter === 'codex' ? (
            <select className={inputClass()} value={llmModel} onChange={(event) => setLlmModel(event.target.value)}>
              {CODEX_MODELS.map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : (
            <input className={inputClass()} value={llmModel} onChange={(event) => setLlmModel(event.target.value)} placeholder="cursor-default" />
          )}
        </FieldShell>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Reasoning effort" hint="Executor reasoning effort hint.">
          <select
            className={inputClass()}
            value={llmReasoningEffort}
            onChange={(event) => setLlmReasoningEffort(event.target.value as LlmReasoningEffort)}
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
