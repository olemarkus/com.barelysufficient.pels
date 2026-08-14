// Producer that resolves a persisted plan-history entry's kind-split (°C/%)
// value pairs into the unit-agnostic `Resolved…` view consumers receive. This
// is the ONE place the raw columns are read on the consumer path — everything
// downstream (UI payload, widget payload, shared-domain formatters) takes the
// resolved view, so a raw-column read is a compile error there. See
// `ResolvedDeferredObjectivePlanHistoryEntry`.

import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRecord,
  ResolvedDeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryProgressSample,
} from '../../contracts/src/deferredObjectivePlanHistory';
import {
  resolveFinalProgressValue,
  resolveSampleValue,
  resolveStartProgressValue,
  resolveTargetValue,
} from './deferredObjectiveValues';

const isCompactHistoryRecord = (
  entry: DeferredObjectivePlanHistoryEntry | DeferredObjectivePlanHistoryRecord,
): entry is DeferredObjectivePlanHistoryRecord => (
  'targetValue' in entry
    && 'startProgressValue' in entry
    && 'finalProgressValue' in entry
    && !('objectiveKind' in entry)
);

export const toPlanHistoryRecord = (
  entry: DeferredObjectivePlanHistoryEntry | DeferredObjectivePlanHistoryRecord,
): DeferredObjectivePlanHistoryRecord => {
  if (isCompactHistoryRecord(entry)) {
    return {
      ...entry,
      progressSamples: Array.isArray(entry.progressSamples)
        ? entry.progressSamples.map((sample) => ({ ...sample }))
        : undefined,
    };
  }
  const {
    deviceName: _deviceName,
    objectiveKind: _objectiveKind,
    targetTemperatureC: _targetTemperatureC,
    targetPercent: _targetPercent,
    startProgressC: _startProgressC,
    startProgressPercent: _startProgressPercent,
    finalProgressC: _finalProgressC,
    finalProgressPercent: _finalProgressPercent,
    progressSamples,
    ...rest
  } = entry;
  const resolved: DeferredObjectivePlanHistoryRecord = {
    ...rest,
    outcome: entry.outcome === 'unknown' ? 'abandoned' : entry.outcome,
    targetValue: resolveTargetValue(entry),
    startProgressValue: resolveStartProgressValue(entry),
    finalProgressValue: resolveFinalProgressValue(entry),
  };
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

export const toResolvedPlanHistoryEntry = (
  entry: DeferredObjectivePlanHistoryEntry | DeferredObjectivePlanHistoryRecord,
  device: { name: string; objectiveKind: 'temperature' | 'ev_soc' },
): ResolvedDeferredObjectivePlanHistoryEntry => {
  const record = toPlanHistoryRecord(entry);
  return {
    ...record,
    deviceName: device.name,
    objectiveKind: device.objectiveKind,
  };
};

/** Compatibility projection for already-validated legacy rows. Runtime API
 * producers must use `toResolvedPlanHistoryEntry` with current device data. */
export const toResolvedLegacyPlanHistoryEntry = (
  entry: DeferredObjectivePlanHistoryEntry,
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedPlanHistoryEntry(entry, {
  name: entry.deviceName === null ? entry.deviceId : entry.deviceName,
  objectiveKind: entry.objectiveKind,
});
