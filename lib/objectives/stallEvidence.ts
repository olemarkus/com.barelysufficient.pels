import type { StallEvidence } from '../../packages/contracts/src/idleClassification';
import type { ObjectiveProgressDirectionRead } from './types';

/**
 * Single source of truth for "which idle classifications mean the device has
 * settled as far as it will go and the objective should read as satisfied".
 *
 * `near_target_idle` (parked inside the hysteresis band) and `capped_idle`
 * (parked at the device's own internal cap below the PELS target) both mean
 * the device's own controller has stopped — pushing harder won't move it, so
 * the deferred objective is "as met as it gets". `unresponsive` (below target
 * and not drawing) and `undefined` (active / no classification) deliberately do
 * NOT count — a device that isn't actually reaching its target must never read
 * as satisfied.
 *
 * Used by BOTH the live status producer (`diagnosticsBridge`) and the
 * postmortem met-reason mapping (`stallClassificationToMetReason`) so the
 * user-facing live status and the recorded outcome can never disagree about
 * what counts as a stall.
 */
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
