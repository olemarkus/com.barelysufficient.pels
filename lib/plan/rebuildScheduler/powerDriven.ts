import type { PlanRebuildScheduler } from './scheduler';
import type { HardCapBreach, PowerRebuildSignal } from './rebuildSignal';
import type { PowerSampleRebuildTrigger } from '../planRebuildTrigger';
import {
  handleSkippedRebuildDecision,
  requestPowerSampleRebuild,
  resolvePowerSampleDecision,
} from './powerDrivenScheduling';

export {
  cancelPendingPowerRebuild,
  executePendingPowerRebuild,
} from './powerDrivenScheduling';

/**
 * Reports a hard-cap breach that did NOT earn a rebuild, so the guard still
 * sees the deficit. Per-sample rather than part of the port: it answers with
 * THIS reading's totals, and a breach the guard never hears about is
 * indistinguishable from no breach.
 */
export type TightNoopHardCapReporter = (deficitKw: number) => Promise<void>;

export type PowerSampleRebuildState = {
  lastMs: number;
  lastRebuildPowerW?: number;
  lastCapacityPaceKw?: number;
  lastHardCapBreached?: boolean;
  lastHardCapDeficitKw?: number;
  shortfallSuppressionInvalidated?: boolean;
  // Stamped from the last decision so the execution-side due-time floor can bound
  // rebuild frequency while nothing is actionable, independent of decision logic.
  tightUnactionable?: boolean;
  tightNoopStreak?: number;
  backoffUntilMs?: number;
  mitigationHoldoffUntilMs?: number;
  inFlight?: Promise<void | string>;
  pending?: Promise<void | string>;
  pendingResolve?: (reason?: string) => void;
  pendingReject?: (error: Error) => void;
  pendingPowerW?: number;
  pendingCapacityPaceKw?: number;
  pendingReason?: PowerSampleRebuildTrigger;
  /**
   * Bumped by every device observation (`invalidateRebuildSuppressionForObservation`).
   * A rebuild captures it at dispatch and compares on completion: if it moved, the
   * house changed after the rebuild read its devices, so that rebuild's
   * "nothing is actionable" verdict must not be allowed to install a backoff.
   */
  observationSeq?: number;
  pendingDueMs?: number;
  pendingHardCapBreach?: HardCapBreach;
  pendingIsInShortfall?: boolean;
  pendingOnTightNoopHardCapBreach?: TightNoopHardCapReporter;
};

/**
 * The scheduler and everything it needs to reach the outside world: its state
 * and its clock. Built by the wiring layer per sample and passed as a unit — it
 * is the scheduler's environment, not an argument list.
 */
export type PowerSampleRebuildStore = {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
};

export type PowerRebuildSchedulerPort = PowerSampleRebuildStore & {
  scheduler: PlanRebuildScheduler;
  getNowMs: () => number;
};

export function schedulePlanRebuildFromPowerSample(
  port: PowerRebuildSchedulerPort,
  signal: PowerRebuildSignal,
  minIntervalMs: number,
  maxIntervalMs: number,
  reportTightNoopHardCap: TightNoopHardCapReporter,
): Promise<void | string> {
  const { getState, getNowMs } = port;
  const state = getState();
  const now = getNowMs();

  const outcome = resolvePowerSampleDecision(signal, state, now, maxIntervalMs);

  if (!outcome.decision.shouldRebuild) {
    handleSkippedRebuildDecision(port, signal, state, outcome.decision, now);
    // Deliberately do NOT drive `checkShortfall` from the throttled skip: entering
    // shortfall without a rebuild having observed the live device state would let a
    // stale "unactionable" summary keep the unrecoverable-shortfall skip bypassing
    // rebuilds — a device that returned load could then never be discovered/shed.
    // Shortfall entry/clear detection rides the max-interval rebuild instead (the
    // decision throttle always yields a rebuild at least every max-interval, and the
    // unrecoverable-shortfall skip in `signalDriven.ts` now honours it too).
    return Promise.resolve();
  }

  return requestPowerSampleRebuild(port, signal, outcome, now, minIntervalMs, reportTightNoopHardCap);
}
