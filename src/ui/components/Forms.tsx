import { useEffect, useState } from 'react';
import type { CreateRepoInput, CreateTaskInput } from '../domain/api';
import type { Repo, SimulationProfile, TaskContextLink, TaskStatus } from '../domain/types';

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

export function RepoForm({ onSubmit }: { onSubmit: (input: CreateRepoInput) => Promise<void> | void }) {
  const [slug, setSlug] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [baselineUrl, setBaselineUrl] = useState('');

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit({ slug, defaultBranch, baselineUrl, enabled: true });
        setSlug('');
        setDefaultBranch('main');
        setBaselineUrl('');
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
      <FieldShell label="Baseline URL" hint="Used as the before state for mock and future evidence runs.">
        <input className={inputClass()} value={baselineUrl} onChange={(event) => setBaselineUrl(event.target.value)} placeholder="https://example.com" required />
      </FieldShell>
      <PrimaryButton>Add repo</PrimaryButton>
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

export function TaskForm({
  repos,
  onSubmit,
  initialStatus = 'INBOX'
}: {
  repos: Repo[];
  onSubmit: (input: CreateTaskInput) => Promise<void> | void;
  initialStatus?: TaskStatus;
}) {
  const [repoId, setRepoId] = useState(repos[0]?.repoId ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [criteria, setCriteria] = useState('');
  const [notes, setNotes] = useState('');
  const [links, setLinks] = useState('');
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [simulationProfile, setSimulationProfile] = useState<SimulationProfile>('happy_path');
  const [baselineUrlOverride, setBaselineUrlOverride] = useState('');

  useEffect(() => {
    if (!repos.length) {
      setRepoId('');
      return;
    }

    if (!repos.some((repo) => repo.repoId === repoId)) {
      setRepoId(repos[0].repoId);
    }
  }, [repoId, repos]);

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!repoId) {
          return;
        }

        await onSubmit({
          repoId,
          title,
          description,
          taskPrompt,
          acceptanceCriteria: parseCriteria(criteria),
          context: { links: parseLinks(links), notes },
          status,
          baselineUrlOverride: baselineUrlOverride || undefined,
          simulationProfile
        });
        setTitle('');
        setDescription('');
        setTaskPrompt('');
        setCriteria('');
        setNotes('');
        setLinks('');
        setStatus(initialStatus);
        setSimulationProfile('happy_path');
        setBaselineUrlOverride('');
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

      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Mock run profile">
          <select className={inputClass()} value={simulationProfile} onChange={(event) => setSimulationProfile(event.target.value as SimulationProfile)}>
            <option value="happy_path">happy_path</option>
            <option value="fail_tests">fail_tests</option>
            <option value="fail_preview">fail_preview</option>
          </select>
        </FieldShell>
      </div>

      <PrimaryButton disabled={!repos.length}>Create task</PrimaryButton>
    </form>
  );
}
