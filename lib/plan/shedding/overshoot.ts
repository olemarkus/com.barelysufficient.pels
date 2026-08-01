import type CapacityGuard from '../../power/capacityGuard';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from '../planConstants';
import type { OvershootStats } from './types';

const OVERSHOOT_ESCALATION_INTERVAL_MS = 30 * 1000;

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

export function resolveSameMeasurementSheddingDecision(params: {
  state: PlanEngineState;
  measurementTs: number | null;
  measurementPowerW: number | null;
  neededKw: number;
  nowTs: number;
  allowEscalation?: boolean;
}): { skip: boolean; escalatedSameSample: boolean; heldOnUnchangedReading: boolean } {
  const {
    state,
    measurementTs,
    measurementPowerW,
    neededKw,
    nowTs,
    allowEscalation = true,
  } = params;
  const alreadyShedThisSample = measurementTs !== null
    && measurementTs === state.lastShedPlanMeasurementTs;
  if (!alreadyShedThisSample) {
    if (isUnchangedReadingHeld({ state, measurementPowerW, neededKw, nowTs })) {
      return { skip: true, escalatedSameSample: false, heldOnUnchangedReading: true };
    }
    return { skip: false, escalatedSameSample: false, heldOnUnchangedReading: false };
  }
  if (!allowEscalation) {
    return { skip: true, escalatedSameSample: false, heldOnUnchangedReading: false };
  }
  const escalatedSameSample = shouldEscalateOvershoot(state, nowTs);
  return {
    skip: !escalatedSameSample,
    escalatedSameSample,
    heldOnUnchangedReading: false,
  };
}

/**
 * A NEW sample that carries the exact watts the last shed was decided on, within
 * the hold window. Equality is exact on purpose: a repeated aggregate is
 * byte-identical, while a live meter moves by at least a watt between reads, so
 * any real movement — in either direction — is treated as fresh evidence and
 * shedding proceeds at today's speed. The window is measured from
 * `lastShedPlanAtMs`, the shed's own stamp, NOT `lastOvershootMitigationMs`:
 * `PlanBuilder` runs shedding before `OvershootTracker.updateOvershootState`,
 * whose entry branch nulls the mitigation clock, which would strip the anchor
 * off the first shed of every incident — the exact cycle this hold exists for.
 */
function isUnchangedReadingHeld(params: {
  state: PlanEngineState;
  measurementPowerW: number | null;
  neededKw: number;
  nowTs: number;
}): boolean {
  const {
    state, measurementPowerW, neededKw, nowTs,
  } = params;
  if (measurementPowerW === null) return false;
  if (state.lastShedPlanPowerW === null) return false;
  if (measurementPowerW !== state.lastShedPlanPowerW) return false;
  // The same watts against a TIGHTER limit is a different question, not a
  // re-delivered answer: the deficit grew for a reason the meter cannot show,
  // so the hold has nothing to say about it.
  if (hasDeficitGrown(state.lastShedPlanNeededKw, neededKw)) return false;
  const lastShedAtMs = state.lastShedPlanAtMs;
  if (lastShedAtMs === null) return false;
  const sinceShedMs = nowTs - lastShedAtMs;
  // A backwards clock correction must not read as "still inside the window" and
  // hold shedding until the reading happens to move. Negative elapsed = the
  // stamp is no longer comparable, so fall through and shed.
  if (sinceShedMs < 0) return false;
  return sinceShedMs < UNCHANGED_READING_SHED_HOLD_MS;
}

/**
 * Grown past float noise. The deficit is derived (`softLimit - total`), so an
 * unchanged limit and an unchanged total can still differ in the last bits; 1 W
 * is far below anything a shed decision turns on.
 */
function hasDeficitGrown(latchedKw: number | null, neededKw: number): boolean {
  if (latchedKw === null) return false;
  return neededKw > latchedKw + DEFICIT_GROWTH_EPSILON_KW;
}

export function emitOvershootEscalationBlocked(params: {
  structuredLog?: PinoLogger;
  capacityGuard?: CapacityGuard;
  neededKw: number;
  remainingCandidates: number;
  measurementTs: number | null;
  nowTs: number;
}): void {
  const {
    structuredLog,
    capacityGuard,
    neededKw,
    remainingCandidates,
    measurementTs,
    nowTs,
  } = params;
  structuredLog?.info({
    event: 'capacity_overshoot_escalation_blocked',
    incidentId: capacityGuard?.getCurrentIncidentId() ?? undefined,
    reasonCode: 'no_candidates',
    neededKw,
    remainingCandidates,
    measurementAgeMs: measurementTs === null ? null : Math.max(0, nowTs - measurementTs),
  });
}

export function resolveRecentRestoreState(params: {
  device: Pick<PlanInputDevice, 'id' | 'name'>;
  state: PlanEngineState;
  nowTs: number;
  needed: number;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    device,
    state,
    nowTs,
    needed,
    debugStructured,
  } = params;
  const lastRestore = state.lastDeviceRestoreMs[device.id];
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

export function buildOvershootStats(params: {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
}): OvershootStats {
  const {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
  } = params;
  return {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    allShedCandidatesExhausted: eligibleCandidateCount === 0,
    controlRecoverable: reducibleControlledKw > 0,
  };
}

function shouldEscalateOvershoot(state: PlanEngineState, nowTs: number): boolean {
  if (typeof state.overshootStartedMs !== 'number') return false;
  if (nowTs - state.overshootStartedMs < OVERSHOOT_ESCALATION_INTERVAL_MS) return false;
  const lastAttemptMs = state.lastOvershootMitigationMs
    ?? state.lastOvershootEscalationMs
    ?? state.overshootStartedMs;
  return nowTs - lastAttemptMs >= OVERSHOOT_ESCALATION_INTERVAL_MS;
}
