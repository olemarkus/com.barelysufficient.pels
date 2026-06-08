// Producer that resolves an active plan's kind-split (°C/%) value pairs into the
// unit-agnostic `Resolved…` view consumers receive (the live-task chart, the
// deadlines list card, the smart-tasks widget). Mirrors
// `deferredPlanHistoryResolvedView.ts` for the active-plan surface: this is the
// one place the raw columns are read on the consumer path, so a raw-column read
// is a compile error downstream. See `ResolvedDeferredObjectiveActivePlanV1`.

import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
  ResolvedDeferredObjectiveActivePlanProgressSampleV1,
  ResolvedDeferredObjectiveActivePlanV1,
  ResolvedDeferredObjectiveActivePlansV1,
} from '../../contracts/src/deferredObjectiveActivePlans';
import {
  resolveSampleValue,
  resolveStartProgressValue,
  resolveTargetValue,
} from './deferredObjectiveValues';

export const toResolvedActivePlan = (
  plan: DeferredObjectiveActivePlanV1,
): ResolvedDeferredObjectiveActivePlanV1 => {
  const {
    targetTemperatureC: _targetTemperatureC,
    targetPercent: _targetPercent,
    startProgressC,
    startProgressPercent,
    progressSamples,
    ...rest
  } = plan;
  const resolved: ResolvedDeferredObjectiveActivePlanV1 = {
    ...rest,
    targetValue: resolveTargetValue(plan),
  };
  // `startProgress*` and `progressSamples` are UI-derived (stitched onto the
  // payload by the assembler, never on a loaded plan), so preserve their
  // absence on plans that carry no live trajectory.
  if (startProgressC !== undefined || startProgressPercent !== undefined) {
    resolved.startProgressValue = resolveStartProgressValue(plan);
  }
  if (Array.isArray(progressSamples)) {
    resolved.progressSamples = progressSamples.map(
      (sample): ResolvedDeferredObjectiveActivePlanProgressSampleV1 => ({
        atMs: sample.atMs,
        value: resolveSampleValue(sample),
      }),
    );
  }
  return resolved;
};

export const toResolvedActivePlans = (
  snapshot: DeferredObjectiveActivePlansV1,
): ResolvedDeferredObjectiveActivePlansV1 => {
  const plansByDeviceId: Record<string, ResolvedDeferredObjectiveActivePlanV1> = {};
  for (const [deviceId, plan] of Object.entries(snapshot.plansByDeviceId)) {
    // Defensive: a null/absent plan passes through untouched — resolving it
    // would spread `null`. The record type is non-null, but degraded states can
    // yield a null plan (the consuming widget guards for it), so mirror that.
    plansByDeviceId[deviceId] = plan
      ? toResolvedActivePlan(plan)
      : (plan as unknown as ResolvedDeferredObjectiveActivePlanV1);
  }
  return { version: 1, plansByDeviceId };
};
