import type { CreateRepoInput, CreateTaskInput, UpdateRepoInput, UpdateTaskInput } from '../../ui/domain/api';
import { badRequest } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown, field: string, required = true): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readTrimmedString(value: unknown, field: string, required = true): string | undefined {
  const result = readString(value, field, required);
  return typeof result === 'string' ? result.trim() : result;
}

function readBoolean(value: unknown, field: string, required = false): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readStringArray(value: unknown, field: string, required = true): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readContext(value: unknown, required = true): CreateTaskInput['context'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest('Invalid context.');
  }

  const linksValue = value.links;
  if (!Array.isArray(linksValue)) {
    throw badRequest('Invalid context.links.');
  }

  const links = linksValue.map((item, index) => {
    if (!isRecord(item)) {
      throw badRequest(`Invalid context.links[${index}].`);
    }

    return {
      id: readString(item.id, `context.links[${index}].id`)!,
      label: readString(item.label, `context.links[${index}].label`)!,
      url: readString(item.url, `context.links[${index}].url`)!
    };
  });

  return {
    links,
    notes: readString(value.notes, 'context.notes', false)
  };
}

export async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
}

export function parseCreateRepoInput(body: unknown): CreateRepoInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid repo payload.');
  }

  return {
    slug: readTrimmedString(body.slug, 'slug')!,
    defaultBranch: readTrimmedString(body.defaultBranch, 'defaultBranch', false),
    baselineUrl: readTrimmedString(body.baselineUrl, 'baselineUrl')!,
    enabled: readBoolean(body.enabled, 'enabled', false),
    previewCheckName: readTrimmedString(body.previewCheckName, 'previewCheckName', false),
    codexAuthBundleR2Key: readTrimmedString(body.codexAuthBundleR2Key, 'codexAuthBundleR2Key', false)
  };
}

export function parseUpdateRepoInput(body: unknown): UpdateRepoInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid repo patch payload.');
  }

  const patch: UpdateRepoInput = {};
  if (hasOwn(body, 'slug')) patch.slug = readTrimmedString(body.slug, 'slug', false);
  if (hasOwn(body, 'defaultBranch')) patch.defaultBranch = readTrimmedString(body.defaultBranch, 'defaultBranch', false);
  if (hasOwn(body, 'baselineUrl')) patch.baselineUrl = readTrimmedString(body.baselineUrl, 'baselineUrl', false);
  if (hasOwn(body, 'enabled')) patch.enabled = readBoolean(body.enabled, 'enabled', false);
  if (hasOwn(body, 'previewCheckName')) patch.previewCheckName = readTrimmedString(body.previewCheckName, 'previewCheckName', false);
  if (hasOwn(body, 'codexAuthBundleR2Key')) patch.codexAuthBundleR2Key = readTrimmedString(body.codexAuthBundleR2Key, 'codexAuthBundleR2Key', false);
  return patch;
}

export function parseCreateTaskInput(body: unknown): CreateTaskInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid task payload.');
  }

  return {
    repoId: readString(body.repoId, 'repoId')!,
    title: readString(body.title, 'title')!,
    description: readString(body.description, 'description', false),
    taskPrompt: readString(body.taskPrompt, 'taskPrompt')!,
    acceptanceCriteria: readStringArray(body.acceptanceCriteria, 'acceptanceCriteria')!,
    context: readContext(body.context)!,
    baselineUrlOverride: readString(body.baselineUrlOverride, 'baselineUrlOverride', false),
    status: readString(body.status, 'status', false) as CreateTaskInput['status'],
    simulationProfile: readString(body.simulationProfile, 'simulationProfile', false) as CreateTaskInput['simulationProfile']
  };
}

export function parseUpdateTaskInput(body: unknown): UpdateTaskInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid task patch payload.');
  }

  const patch: UpdateTaskInput = {};
  if (hasOwn(body, 'repoId')) patch.repoId = readString(body.repoId, 'repoId', false);
  if (hasOwn(body, 'title')) patch.title = readString(body.title, 'title', false);
  if (hasOwn(body, 'description')) patch.description = readString(body.description, 'description', false);
  if (hasOwn(body, 'taskPrompt')) patch.taskPrompt = readString(body.taskPrompt, 'taskPrompt', false);
  if (hasOwn(body, 'acceptanceCriteria')) patch.acceptanceCriteria = readStringArray(body.acceptanceCriteria, 'acceptanceCriteria', false);
  if (hasOwn(body, 'context')) patch.context = readContext(body.context, false);
  if (hasOwn(body, 'baselineUrlOverride')) patch.baselineUrlOverride = readString(body.baselineUrlOverride, 'baselineUrlOverride', false);
  if (hasOwn(body, 'status')) patch.status = readString(body.status, 'status', false) as UpdateTaskInput['status'];
  if (hasOwn(body, 'simulationProfile')) patch.simulationProfile = readString(body.simulationProfile, 'simulationProfile', false) as UpdateTaskInput['simulationProfile'];
  if (hasOwn(body, 'runId')) patch.runId = readString(body.runId, 'runId', false);
  return patch;
}
