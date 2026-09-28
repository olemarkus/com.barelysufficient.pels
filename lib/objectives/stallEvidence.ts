import type { StallEvidence } from '../../packages/contracts/src/idleClassification';
import type { ObjectiveProgressDirectionRead } from './types';

export const classificationImpliesStallSatisfied = (
  classification: StallEvidence['classification'] | undefined,
): boolean => (
  classification === 'near_target_idle' || classification === 'capped_idle'
);

/** A parked setpoint proves the task only when it reaches the target in its direction. */
export const stallEvidenceCoversTarget = (
  evidence: StallEvidence | undefined,
  targetValue: number | null,
  progressDirection: ObjectiveProgressDirectionRead,
): evidence is StallEvidence => {
  if (evidence === undefined || targetValue === null || progressDirection === 'unknown') return false;
  if (!classificationImpliesStallSatisfied(evidence.classification)) return false;
  if (progressDirection === 'decreasing' && evidence.temperatureGapC < 0) return false;
  return progressDirection === 'increasing'
    ? evidence.classifiedAgainstTargetValue >= targetValue
    : evidence.classifiedAgainstTargetValue <= targetValue;
};
