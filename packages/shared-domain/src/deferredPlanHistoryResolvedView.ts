// Producer that resolves a persisted plan-history entry's kind-split (°C/%)
// value pairs into the unit-agnostic `Resolved…` view consumers receive. This
// is the ONE place the raw columns are read on the consumer path — everything
// downstream (UI payload, widget payload, shared-domain formatters) takes the
// resolved view, so a raw-column read is a compile error there. See
// `ResolvedDeferredObjectivePlanHistoryEntry`.

import type {
  DeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryProgressSample,
} from '../../contracts/src/deferredObjectivePlanHistory';
import {
  resolveFinalProgressValue,
  resolveSampleValue,
  resolveStartProgressValue,
  resolveTargetValue,
} from './deferredObjectiveValues';

export const toResolvedPlanHistoryEntry = (
  entry: DeferredObjectivePlanHistoryEntry,
): ResolvedDeferredObjectivePlanHistoryEntry => {
  const {
    targetTemperatureC: _targetTemperatureC,
    targetPercent: _targetPercent,
    startProgressC: _startProgressC,
    startProgressPercent: _startProgressPercent,
    finalProgressC: _finalProgressC,
    finalProgressPercent: _finalProgressPercent,
    progressSamples,
    ...rest
  } = entry;
  const resolved: ResolvedDeferredObjectivePlanHistoryEntry = {
    ...rest,
    targetValue: resolveTargetValue(entry),
    startProgressValue: resolveStartProgressValue(entry),
    finalProgressValue: resolveFinalProgressValue(entry),
  };
  // `Array.isArray` (not `!== undefined`): a persisted entry can carry
  // `progressSamples: null` (Homey settings round-trip unset keys as null), and
  // `.map()` on null would throw. Absent/null both degrade to "no samples".
  if (Array.isArray(progressSamples)) {
    resolved.progressSamples = progressSamples.map(
      (sample): ResolvedDeferredObjectivePlanHistoryProgressSample => ({
        atMs: sample.atMs,
        value: resolveSampleValue(sample),
      }),
    );
  }
  return resolved;
};
