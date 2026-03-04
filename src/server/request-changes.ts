import type { ReviewReplyContext } from './review-posting/adapter';
import type { RequestRunChangesSelection } from '../ui/domain/api';
import type { ChangeRequestSelection, ReviewFinding, ReviewSelectionMode } from '../ui/domain/types';

const MAX_DESCRIPTION_SNIPPET_LENGTH = 280;

function normalizeFindingIds(value: string[] | undefined) {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawId of value ?? []) {
    const normalizedId = rawId.trim();
    if (!normalizedId || seen.has(normalizedId)) {
      continue;
    }

    seen.add(normalizedId);
    normalized.push(normalizedId);
  }

  return normalized;
}

function getOpenFindings(findings: ReviewFinding[]) {
  return findings.filter((finding) => finding.status === 'open');
}

export function resolveRequestRunChangesSelection(input: {
  findings: ReviewFinding[];
  reviewSelection?: RequestRunChangesSelection;
}): ChangeRequestSelection | undefined {
  if (!input.reviewSelection) {
    return undefined;
  }

  const findings = getOpenFindings(input.findings);
  const availableIds = findings.map((finding) => finding.findingId);
  const availableIdSet = new Set(availableIds);
  const requestedFindingIds = normalizeFindingIds(input.reviewSelection.findingIds);

  const resolved: ChangeRequestSelection = {
    mode: input.reviewSelection.mode,
    selectedFindingIds: [],
    includeReplies: Boolean(input.reviewSelection.includeReplies),
    ...(input.reviewSelection.instruction?.trim() ? { instruction: input.reviewSelection.instruction.trim() } : {})
  };

  const requestedSet = new Set(requestedFindingIds);
  switch (input.reviewSelection.mode) {
    case 'all':
      resolved.selectedFindingIds = [...availableIds];
      break;
    case 'include':
      resolved.selectedFindingIds = findings
        .filter((finding) => requestedSet.has(finding.findingId))
        .map((finding) => finding.findingId);
      break;
    case 'exclude': {
      const excludedSet = new Set(requestedFindingIds);
      resolved.selectedFindingIds = findings
        .filter((finding) => !excludedSet.has(finding.findingId))
        .map((finding) => finding.findingId);
      break;
    }
    case 'freeform':
      resolved.selectedFindingIds = [...availableIds];
      break;
    default:
      resolved.mode = 'all' as ReviewSelectionMode;
      resolved.selectedFindingIds = [...availableIds];
  }

  const unknownFindingIds = requestedFindingIds.filter((id) => !availableIdSet.has(id));
  if (unknownFindingIds.length) {
    resolved.unknownFindingIds = unknownFindingIds;
  }

  if (requestedFindingIds.length) {
    resolved.requestedFindingIds = requestedFindingIds;
  }

  return resolved;
}

function formatFindingLine(finding: ReviewFinding) {
  const location = finding.filePath
    ? ` (${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''}${finding.lineEnd ? `-${finding.lineEnd}` : ''})`
    : '';
  const severity = finding.severity.toUpperCase();

  return `- ${finding.findingId} · ${finding.title}${location} [${severity}]`;
}

function formatFindingContext(finding: ReviewFinding) {
  return [
    formatFindingLine(finding),
    `  description: ${finding.description.slice(0, MAX_DESCRIPTION_SNIPPET_LENGTH)}${finding.description.length > MAX_DESCRIPTION_SNIPPET_LENGTH ? '...' : ''}`
  ];
}

function formatReplyContext(id: string, replyContext?: ReviewReplyContext) {
  const replies = replyContext?.[id];
  if (!replies?.length) {
    return [];
  }

  return [
    `Provider replies for ${id}:`,
    ...replies.map((reply) => `- ${reply}`)
  ];
}

export function buildRequestChangesPrompt(input: {
  operatorPrompt: string;
  selection?: ChangeRequestSelection;
  selectedFindings: ReviewFinding[];
  replyContext?: ReviewReplyContext;
}) {
  const trimmedPrompt = input.operatorPrompt.trim();
  if (!input.selection) {
    return trimmedPrompt;
  }

  const findingIds = input.selection.selectedFindingIds;
  const lines = [
    trimmedPrompt,
    '',
    'Review change request context:',
    `Mode: ${input.selection.mode}`,
    `Selected findings: ${findingIds.length ? findingIds.join(', ') : 'None'}`
  ];

  if (input.selection.requestedFindingIds?.length) {
    lines.push(`Requested findings: ${input.selection.requestedFindingIds.join(', ')}`);
  }

  if (input.selection.unknownFindingIds?.length) {
    lines.push(`Unknown findings: ${input.selection.unknownFindingIds.join(', ')}`);
  }

  if (input.selection.includeReplies) {
    lines.push('Include provider replies: enabled');
  }

  if (input.selection.instruction) {
    lines.push('', 'Rerun intent:', input.selection.instruction);
  }

  if (input.selectedFindings.length) {
    lines.push('', 'Selected finding context:');
    input.selectedFindings.forEach((finding) => {
      lines.push(...formatFindingContext(finding));
      lines.push(...formatReplyContext(finding.findingId, input.replyContext));
    });
  } else {
    lines.push('', 'No selected findings were available for this request.');
  }

  return lines.join('\n');
}
