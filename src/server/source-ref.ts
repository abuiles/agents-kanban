import type { Task } from '../ui/domain/types';

type NormalizedTaskSourceRef = {
  fetchSpec: string;
  label: string;
};

export function resolveTaskSourceRef(task: Pick<Task, 'sourceRef' | 'title' | 'description' | 'taskPrompt'>) {
  if (task.sourceRef?.trim()) {
    return task.sourceRef.trim();
  }

  return inferSourceRefFromText([task.title, task.description, task.taskPrompt].filter(Boolean).join('\n'));
}

export function normalizeTaskSourceRef(sourceRef: string, expectedRepoSlug: string): NormalizedTaskSourceRef {
  const trimmed = sourceRef.trim();
  const pullHeadMatch = trimmed.match(/^(?:refs\/)?pull\/(\d+)\/head$/i);
  if (pullHeadMatch) {
    return { fetchSpec: `pull/${pullHeadMatch[1]}/head`, label: `PR #${pullHeadMatch[1]}` };
  }

  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    return { fetchSpec: trimmed, label: `commit ${trimmed.slice(0, 7)}` };
  }

  try {
    const url = new URL(trimmed);
    if (!['github.com', 'www.github.com'].includes(url.hostname)) {
      throw new Error(`Unsupported task source ref URL: ${trimmed}`);
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4) {
      throw new Error(`Unsupported task source ref URL: ${trimmed}`);
    }

    const repoSlug = `${parts[0]}/${parts[1]}`;
    if (repoSlug !== expectedRepoSlug) {
      throw new Error(`Task source ref points to ${repoSlug}, expected ${expectedRepoSlug}.`);
    }

    if (parts[2] === 'pull' && parts[3]) {
      return { fetchSpec: `pull/${parts[3]}/head`, label: `PR #${parts[3]}` };
    }

    if (parts[2] === 'tree' && parts.length >= 4) {
      const branch = decodeURIComponent(parts.slice(3).join('/'));
      return { fetchSpec: branch, label: `branch ${branch}` };
    }

    if (parts[2] === 'commit' && parts[3]) {
      return { fetchSpec: parts[3], label: `commit ${parts[3].slice(0, 7)}` };
    }

    throw new Error(`Unsupported task source ref URL: ${trimmed}`);
  } catch (error) {
    if (error instanceof TypeError) {
      return { fetchSpec: trimmed, label: trimmed };
    }

    throw error;
  }
}

function inferSourceRefFromText(text: string) {
  for (const match of text.matchAll(/https?:\/\/github\.com\/[^\s)]+/gi)) {
    const candidate = trimTrailingPunctuation(match[0]);
    if (isSupportedGithubSourceUrl(candidate)) {
      return candidate;
    }
  }

  const prMatch = text.match(/\b(?:pr|pull request)\s*#\s*(\d+)\b/i);
  if (prMatch) {
    return `pull/${prMatch[1]}/head`;
  }

  const commitMatch = text.match(/\bcommit\s+([0-9a-f]{7,40})\b/i);
  if (commitMatch) {
    return commitMatch[1];
  }

  const branchMatch = text.match(/\b(?:from|use|checkout|start from)\s+branch(?: named| called|:)?\s+([A-Za-z0-9._/-]+)\b/i);
  if (branchMatch) {
    return branchMatch[1];
  }

  return undefined;
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[.,!?;:]+$/g, '');
}

function isSupportedGithubSourceUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['github.com', 'www.github.com'].includes(url.hostname)) {
      return false;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4) {
      return false;
    }

    return ['pull', 'tree', 'commit'].includes(parts[2]);
  } catch {
    return false;
  }
}
