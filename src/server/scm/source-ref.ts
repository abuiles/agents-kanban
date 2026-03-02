import type { ScmProvider } from '../../ui/domain/types';

export type ScmSourceRef =
  | { kind: 'branch'; value: string; label: string }
  | { kind: 'commit'; value: string; label: string }
  | { kind: 'review_head'; value: string; label: string; reviewNumber: number; reviewProvider?: ScmProvider };

export type LegacyNormalizedScmSourceRef = {
  fetchSpec: string;
  label: string;
};

export function getScmSourceRefFetchSpec(sourceRef: ScmSourceRef) {
  return sourceRef.value;
}

export function toLegacyNormalizedScmSourceRef(sourceRef: ScmSourceRef): LegacyNormalizedScmSourceRef {
  return {
    fetchSpec: getScmSourceRefFetchSpec(sourceRef),
    label: sourceRef.label
  };
}
