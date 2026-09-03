import type CapacityGuard from '../../power/capacityGuard';
import { buildNullCapacityStateSummary } from '../../power/capacityStateSummary';
import { addPerfDuration, incPerfCounter } from '../../utils/perfCounters';
import {
  resetShortfallSuppressionInvalidationWhenRecovered,
  shouldSkipUnrecoverableShortfallRebuild,
} from './shortfallSuppression';
import {
  resolveHardCapBreach,
  resolveHeadroomTight,
  type AdmittedPowerReading,
  type PlanRebuildPosture,
  type PowerRebuildSignal,
  type RebuildCadence,
} from './rebuildSignal';
import {
  schedulePlanRebuildFromPowerSample,
  type PowerRebuildSchedulerPort,
} from './powerDriven';

const resolveEffectiveSignalMinIntervalMs = (
  signal: PowerRebuildSignal,
  cadence: RebuildCadence,
): number => {
  const { minIntervalMs, stableMinIntervalMs } = cadence;
  const boundaryActive = signal.planConvergenceActive
    || resolveHeadroomTight(signal.headroomKw)
    || signal.isInShortfall
    || signal.hardCapBreach.breached;
  const effectiveMinIntervalMs = boundaryActive
    ? minIntervalMs
    : Math.max(minIntervalMs, stableMinIntervalMs);
  if (effectiveMinIntervalMs > minIntervalMs) {
    incPerfCounter('plan_rebuild_signal_stable_interval_total');
  }
  return effectiveMinIntervalMs;
};

/**
 * The signal seam: turns one admitted whole-home reading into a
 * `PowerRebuildSignal` and hands that single value to the decision chain.
 *
 * Everything the chain below needs is resolved HERE, once. `reading` arrives
 * already resolved from the producer — `totalKw` is a number, not a latch that
 * might be missing, because the tracker persists the admitted sample before it
 * awaits this call.
 */
export function schedulePlanRebuildFromSignal(
  port: PowerRebuildSchedulerPort,
  cadence: RebuildCadence,
  reading: AdmittedPowerReading,
  posture: PlanRebuildPosture,
  skipWhileShortfallUnrecoverable: boolean,
  capacityGuard: CapacityGuard,
): Promise<void | string> {
  const rebuildStart = Date.now();
  const { getState, setState, getNowMs } = port;
  const isInShortfall = capacityGuard.isInShortfall();
  const signal: PowerRebuildSignal = {
    currentPowerW: reading.currentPowerW,
    totalKw: reading.totalKw,
    limitKw: reading.limitKw,
    capacityPaceKw: reading.capacityPaceKw,
    headroomKw: reading.capacityPaceKw - reading.totalKw,
    shortfallThresholdKw: reading.shortfallThresholdKw,
    isInShortfall,
    hardCapBreach: resolveHardCapBreach(reading.totalKw, reading.shortfallThresholdKw),
    planConvergenceActive: posture.planConvergenceActive,
    unactionable: posture.unactionable,
  };
  const currentState = resetShortfallSuppressionInvalidationWhenRecovered(getState(), isInShortfall, setState);
  const { maxIntervalMs } = cadence;
  const maxIntervalExceeded = maxIntervalMs > 0
    && (getNowMs() - currentState.lastMs) >= maxIntervalMs;
  if (shouldSkipUnrecoverableShortfallRebuild(
    signal,
    currentState,
    skipWhileShortfallUnrecoverable,
    maxIntervalExceeded,
  )) {
    incPerfCounter('plan_rebuild_skipped_shortfall_unrecoverable_total');
    return Promise.resolve(capacityGuard.checkShortfall({
      hasCandidates: false,
      deficitKw: signal.hardCapBreach.deficitKw,
      totalKw: signal.totalKw,
      shortfallThresholdKw: signal.shortfallThresholdKw,
      capacityStateSummary: buildNullCapacityStateSummary(),
    })).finally(() => {
      addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
    });
  }
  return schedulePlanRebuildFromPowerSample(
    port,
    signal,
    resolveEffectiveSignalMinIntervalMs(signal, cadence),
    maxIntervalMs,
    async (deficitKw) => {
      await capacityGuard.checkShortfall({
        hasCandidates: false,
        deficitKw,
        totalKw: signal.totalKw,
        shortfallThresholdKw: signal.shortfallThresholdKw,
        capacityStateSummary: buildNullCapacityStateSummary(),
      });
    },
  ).finally(() => {
    addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
  });
}
