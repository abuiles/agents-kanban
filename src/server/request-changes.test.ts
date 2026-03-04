import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../ui/domain/types';
import { buildRequestChangesPrompt, resolveRequestRunChangesSelection } from './request-changes';

const findings: ReviewFinding[] = [
  {
    findingId: 'finding_1',
    severity: 'high',
    title: 'Spacing issue',
    description: 'Buttons should use a 12px gap.',
    filePath: 'src/components/spacing.ts',
    lineStart: 10,
    lineEnd: 11,
    status: 'open'
  },
  {
    findingId: 'finding_2',
    severity: 'medium',
    title: 'Copy issue',
    description: 'Text should be sentence case.',
    filePath: 'src/components/copy.ts',
    lineStart: 20,
    status: 'addressed'
  },
  {
    findingId: 'finding_3',
    severity: 'low',
    title: 'Legacy issue',
    description: 'Consolidate duplicate helper imports.',
    filePath: 'src/lib/helpers.ts',
    lineStart: 3,
    status: 'open'
  }
];

describe('resolveRequestRunChangesSelection', () => {
  it('resolves include mode with unknown ids', () => {
    const resolution = resolveRequestRunChangesSelection({
      findings,
      reviewSelection: {
        mode: 'include',
        findingIds: ['finding_1', 'missing_1'],
        includeReplies: true
      }
    });

    expect(resolution).toEqual({
      mode: 'include',
      selectedFindingIds: ['finding_1'],
      unknownFindingIds: ['missing_1'],
      includeReplies: true,
      requestedFindingIds: ['finding_1', 'missing_1']
    });
  });

  it('resolves all mode deterministically', () => {
    const resolution = resolveRequestRunChangesSelection({
      findings,
      reviewSelection: {
        mode: 'all'
      }
    });

    expect(resolution).toEqual({
      mode: 'all',
      selectedFindingIds: ['finding_1', 'finding_3'],
      includeReplies: false
    });
  });

  it('resolves exclude mode deterministically', () => {
    const resolution = resolveRequestRunChangesSelection({
      findings,
      reviewSelection: {
        mode: 'exclude',
        findingIds: ['finding_3']
      }
    });

    expect(resolution).toEqual({
      mode: 'exclude',
      selectedFindingIds: ['finding_1'],
      includeReplies: false,
      requestedFindingIds: ['finding_3']
    });
  });

  it('supports freeform mode for natural language intent', () => {
    const resolution = resolveRequestRunChangesSelection({
      findings,
      reviewSelection: {
        mode: 'freeform',
        instruction: 'Prioritize accessibility blockers first.'
      }
    });

    expect(resolution).toEqual({
      mode: 'freeform',
      selectedFindingIds: ['finding_1', 'finding_3'],
      includeReplies: false,
      instruction: 'Prioritize accessibility blockers first.'
    });
  });
});

describe('buildRequestChangesPrompt', () => {
  it('builds a deterministic request context with reply context', () => {
    const prompt = buildRequestChangesPrompt({
      operatorPrompt: 'Address the findings in this review.',
      selection: {
        mode: 'include',
        requestedFindingIds: ['finding_1', 'missing_2'],
        selectedFindingIds: ['finding_1'],
        unknownFindingIds: ['missing_2'],
        includeReplies: true,
        instruction: 'Focus on spacing and labels.'
      },
      selectedFindings: [findings[0]],
      replyContext: {
        finding_1: ['Reviewer said this spacing change will break 4k layouts.', 'Also align to 16px baseline.']
      }
    });

    expect(prompt).toContain('Review change request context:');
    expect(prompt).toContain('Mode: include');
    expect(prompt).toContain('Selected findings: finding_1');
    expect(prompt).toContain('Requested findings: finding_1, missing_2');
    expect(prompt).toContain('Unknown findings: missing_2');
    expect(prompt).toContain('Include provider replies: enabled');
    expect(prompt).toContain('Rerun intent:');
    expect(prompt).toContain('Selected finding context:');
    expect(prompt).toContain('Provider replies for finding_1:');
    expect(prompt).toContain('Reviewer said this spacing change will break 4k layouts.');
  });
});
