import type CapacityGuard from '../../power/capacityGuard';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { PlanEngineState, ShedPlanLatch } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from '../planConstants';
import type { OvershootStats } from './types';

/**
 * How long an UNCHANGED whole-home reading is refused as evidence that the last
 * shed achieved nothing. Whole-home power lags the switch: the meter aggregate
 * (and the 10 s `homey_energy` poll behind it) can repeat the pre-shed watts for
 * a poll or two after a device is confirmed off. A repeat is a re-delivery of
 * the reading we already acted on, not a fresh observation, so deepening on it
 * cuts into devices the user ranked higher for a deficit that is already
 * covered. 30 s ≈ three consecutive identical polls; matched to
 * `OVERSHOOT_ESCALATION_INTERVAL_MS` so a genuinely stuck reading still escalates
 * on the same cadence rather than stalling behind a longer hold.
 *
 * The poll-count reading of the window is `homey_energy`-specific. A flow-source
 * home samples irregularly, and the usual wiring (a `measure_power` CHANGED
 * trigger) cannot deliver a byte-identical repeat at all — the hold simply never
 * engages there, and a sample more than 30 s later never engages it either. Do
 * not widen the constant "for flow homes"; a count-based window is the change
 * that would make the two modes behave identically.
 */
const UNCHANGED_READING_SHED_HOLD_MS = 30 * 1000;

/** 1 W — below any real shed decision, above float drift in a derived deficit. */
const DEFICIT_GROWTH_EPSILON_KW = 0.001;

/**
 * Whether this cycle's measurement may drive a shed: it may (`proceed`,
 * possibly as a same-sample escalation of a sustained incident), it is the
 * very sample the last shed was planned from (`skip_same_sample`), or it
 * re-delivers the latched reading unchanged (`hold`, re-asserting that latch).
 */
export type SameMeasurementSheddingDecision =
  | { kind: 'proceed'; escalatedSameSample: boolean }
  | { kind: 'skip_same_sample' }
  | { kind: 'hold'; latch: ShedPlanLatch };

export function resolveSameMeasurementSheddingDecision(
  state: PlanEngineState,
  measurementTs: number | null,
  measurementPowerW: number | null,
  neededKw: number,
  nowTs: number,
  allowEscalation: boolean,
): SameMeasurementSheddingDecision {
  const alreadyShedThisSample = measurementTs !== null
    && measurementTs === state.lastShedPlanMeasurementTs;
  if (!alreadyShedThisSample) {
    const held = resolveUnchangedReadingHold(state.shedPlanLatch, measurementPowerW, neededKw, nowTs);
    return held === null ? { kind: 'proceed', escalatedSameSample: false } : { kind: 'hold', latch: held };
  }
  if (!allowEscalation) return { kind: 'skip_same_sample' };
  return state.overshoot.shouldEscalate(nowTs)
    ? { kind: 'proceed', escalatedSameSample: true }
    : { kind: 'skip_same_sample' };
}

/**
 * The latch a NEW sample re-delivers unchanged, within the hold window — or
 * null when the sample is fresh evidence. Equality is exact on purpose: a
 * repeated aggregate is byte-identical, while a live meter moves by at least a
 * watt between reads, so any real movement — in either direction — is treated
 * as fresh evidence and shedding proceeds at today's speed. The window is
 * measured from the latch's own stamp, NOT the incident's mitigation clock:
 * `PlanBuilder` runs shedding before `OvershootTracker.updateOvershootState`,
 * whose entry resets that clock, which would strip the anchor off the first
 * shed of every incident — the exact cycle this hold exists for.
 */
function resolveUnchangedReadingHold(
  latch: ShedPlanLatch | null,
  measurementPowerW: number | null,
  neededKw: number,
  nowTs: number,
): ShedPlanLatch | null {
  if (measurementPowerW === null || latch === null) return null;
  if (measurementPowerW !== latch.powerW) return null;
  // The same watts against a TIGHTER limit is a different question, not a
  // re-delivered answer: the deficit grew for a reason the meter cannot show,
  // so the hold has nothing to say about it.
  if (hasDeficitGrown(latch.neededKw, neededKw)) return null;
  const sinceShedMs = nowTs - latch.atMs;
  // A backwards clock correction must not read as "still inside the window" and
  // hold shedding until the reading happens to move. Negative elapsed = the
  // stamp is no longer comparable, so fall through and shed.
  if (sinceShedMs < 0) return null;
  return sinceShedMs < UNCHANGED_READING_SHED_HOLD_MS ? latch : null;
}

/**
 * Grown past float noise. The deficit is derived (`softLimit - total`), so an
 * unchanged limit and an unchanged total can still differ in the last bits; 1 W
 * is far below anything a shed decision turns on.
 */
function hasDeficitGrown(latchedKw: number, neededKw: number): boolean {
  return neededKw > latchedKw + DEFICIT_GROWTH_EPSILON_KW;
}

export function emitOvershootEscalationBlocked(
  capacityGuard: CapacityGuard,
  neededKw: number,
  remainingCandidates: number,
  measurementTs: number | null,
  nowTs: number,
  structuredLog?: PinoLogger,
): void {
  structuredLog?.info({
    event: 'capacity_overshoot_escalation_blocked',
    incidentId: capacityGuard.getCurrentIncidentId() ?? undefined,
    reasonCode: 'no_candidates',
    neededKw,
    remainingCandidates,
    measurementAgeMs: measurementTs === null ? null : Math.max(0, nowTs - measurementTs),
  });
}

export function resolveRecentRestoreState(
  device: Pick<PlanInputDevice, 'id' | 'name'>,
  state: PlanEngineState,
  nowTs: number,
  /** Severity, sentinel-carrying — this is the one reader that wants it. */
  needed: number,
  debugStructured?: StructuredDebugEmitter,
): boolean {
  const lastRestore = state.actuation.lastDeviceRestoreMs[device.id];
  if (!lastRestore) return false;
  const sinceRestoreMs = nowTs - lastRestore;
  const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
  const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
  if (recentlyRestored && !overshootSevere) {
    debugStructured?.({
      event: 'plan_shed_deprioritized_recent_restore',
      deviceId: device.id,
      deviceName: device.name,
      sinceRestoreSec: Math.round(sinceRestoreMs / 1000),
      overshootKw: needed,
    });
    return true;
  }
  return false;
}

/** The candidate-walk summary a cycle's `OvershootStats` is built from. */
export type OvershootStatsInputs = {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
  skippedCandidateCount?: number;
  skippedCandidateReasons?: OvershootStats['skippedCandidateReasons'];
};

export function buildOvershootStats(params: OvershootStatsInputs): OvershootStats {
  const {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    skippedCandidateCount = 0,
    skippedCandidateReasons = [],
  } = params;
  return {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    allShedCandidatesExhausted: eligibleCandidateCount === 0,
    controlRecoverable: reducibleControlledKw > 0,
    // Counted here so "no candidates" is falsifiable: a cycle with zero eligible
    // candidates can now say how many controlled devices were considered and
    // which gate stopped each. Shed-candidacy skips have no other counter — the
    // capacity summary's blocked-device counters are all RESTORE-side holds.
    skippedCandidateCount,
    skippedCandidateReasons,
  };
}
