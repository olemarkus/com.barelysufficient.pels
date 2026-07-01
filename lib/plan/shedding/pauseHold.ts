import type { PlanInputDevice } from '../planTypes';
import { getLogger } from '../../logging/logger';
import { getMeasuredDrawKw, MIN_ACTIVE_MEASURED_POWER_KW } from '../../observer/observedPower';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { getSteppedLoadLowestActiveStep } from '../../utils/deviceControlProfiles';
import { isFiniteNumber } from '../../utils/appTypeGuards';

/**
 * Proactive priority-hold for the smart-task "pause lower-priority devices" permission.
 *
 * Ownership: the objectives layer (admission) only flags the reserved device with
 * `holdLowerPriority`. THIS module — the single home for shedding selection
 * (`lib/plan/shedding/AGENTS.md`) — resolves the plan-level questions it alone can see:
 *   1. RELEASE once the reserved device is genuinely running (observed draw at ~its lowest
 *      step — see `RELEASE_ACTIVE_FRACTION`, not a bare `> 0` that a standby trickle trips).
 *      Lower-priority devices then share whatever headroom remains via normal admission.
 *   2. FEASIBILITY LIFT (mathematical): if even holding EVERY lower-priority managed device off
 *      cannot admit the reserved device under the hard cap (minus margin), holding heats nobody
 *      — so do not hold. This is per-cycle admission math, not the horizon deadline verdict.
 *   3. SELECTION: hold every lower-priority MANAGED device (incl. ones currently drawing 0 W),
 *      so cycling loads can't nibble the block the reserved device needs to start.
 *
 * `hard-cap-is-physical`: the hold only ever ADDS lower-priority devices to the shed set, up to
 * the cap; it never lets the reserved device exceed the cap. Boost-free by construction (this
 * module does not touch the reserved device's own step). Only OBSERVED draw is consulted for
 * activeness/feasibility (never the fabricated configured/expected fallback), and it declines to
 * hold on stale/unknown power.
 */

const logger = getLogger('plan/pause-hold');

// A reserved device counts as running "at its lowest step" — and so releases the hold — once its
// OBSERVED draw reaches half its lowest step: comfortably past standby/trickle, yet tolerant of
// measurement variance and duty-cycle dips. A bare `> 0` would release on a few watts of standby
// and silently no-op the feature for exactly the devices it targets.
const RELEASE_ACTIVE_FRACTION = 0.5;

export type PauseHoldOutcome = 'held' | 'released_active' | 'infeasible';

export type PauseHoldDecision = {
  deviceId: string;
  deviceName: string;
  outcome: PauseHoldOutcome;
  heldCount: number;
  lowestStepKw: number | null;
  otherLoadKw: number | null;
};

export type PauseHoldResult = {
  holdIds: Set<string>;
  decisions: PauseHoldDecision[];
};

// Factory (not a shared singleton): the result carries a mutable Set + array, so each early
// return must hand back a fresh value rather than let a caller mutate a shared empty.
const emptyResult = (): PauseHoldResult => ({ holdIds: new Set(), decisions: [] });

// The lowest running power (kW) the reserved device draws once admitted. Stepped devices use the
// lowest active step's planning power; others use the expected/configured demand. Returns null
// when no finite positive estimate exists (then we cannot reason → do not hold).
function resolveLowestStepKw(device: PlanInputDevice): number | null {
  if (isSteppedLoadDevice(device)) {
    const lowest = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
    if (lowest && isFiniteNumber(lowest.planningPowerW) && lowest.planningPowerW > 0) {
      return lowest.planningPowerW / 1000;
    }
    return null;
  }
  const candidate = device.expectedPowerKw ?? device.powerKw;
  return isFiniteNumber(candidate) && candidate > 0 ? candidate : null;
}

// Observed draw only — never the configured/expected fallback `getCurrentDrawKw` fabricates. "Is
// it running now?" must be answered by real metering, so a device not reporting a draw reads 0.
const observedDrawKw = (device: PlanInputDevice): number => Math.max(0, getMeasuredDrawKw(device) ?? 0);

export function resolvePauseHold(params: {
  devices: readonly PlanInputDevice[];
  total: number | null;
  powerKnown: boolean;
  hardCapKw: number;
  marginKw: number;
  getPriorityForDevice: (deviceId: string) => number;
}): PauseHoldResult {
  const {
    devices, total, powerKnown, hardCapKw, marginKw, getPriorityForDevice,
  } = params;
  const reserved = devices.filter((device) => device.holdLowerPriority === true);
  if (reserved.length === 0) return emptyResult();
  // Boundary: without a fresh, trustworthy total / hard cap the feasibility math would run on
  // stale power, so we must NOT hold (a wrong hold would strand lower-priority devices for
  // nothing). Mirrors the planner's `powerKnown` freshness discipline.
  if (!powerKnown || !isFiniteNumber(total) || !isFiniteNumber(hardCapKw)) return emptyResult();
  const ceilingKw = hardCapKw - (isFiniteNumber(marginKw) ? marginKw : 0);

  const holdIds = new Set<string>();
  const decisions: PauseHoldDecision[] = [];

  for (const device of reserved) {
    const lowestStepKw = resolveLowestStepKw(device);
    if (lowestStepKw === null) continue; // cannot reason about its draw → do not hold

    // (1) Release once the device is genuinely running (observed draw ~its lowest step).
    const activeThresholdKw = Math.max(MIN_ACTIVE_MEASURED_POWER_KW, lowestStepKw * RELEASE_ACTIVE_FRACTION);
    if (observedDrawKw(device) >= activeThresholdKw) {
      decisions.push({
        deviceId: device.id,
        deviceName: device.name,
        outcome: 'released_active',
        heldCount: 0,
        lowestStepKw,
        otherLoadKw: null,
      });
      continue;
    }

    const devicePriority = getPriorityForDevice(device.id);
    const lowerPriority = devices.filter((other) => (
      other.id !== device.id
      && other.managed !== false
      && other.controllable !== false
      && getPriorityForDevice(other.id) > devicePriority // higher number = lower importance
    ));
    const reclaimableKw = lowerPriority.reduce(
      (sum, other) => sum + Math.max(0, observedDrawKw(other)),
      0,
    );
    // Everything that stays on if we hold all lower-priority off = total − this device's own
    // observed draw − the lower-priority draw we would reclaim (= unmanaged + any higher-priority).
    // Clamp at 0: under measurement skew the summed device draws can momentarily exceed the
    // reported total, and a negative otherLoad would wrongly pass the feasibility check when the
    // lowest step alone already exceeds the ceiling.
    const otherLoadKw = Math.max(0, total - observedDrawKw(device) - reclaimableKw);

    // (2) Mathematical feasibility lift.
    if (otherLoadKw + lowestStepKw > ceilingKw) {
      decisions.push({
        deviceId: device.id,
        deviceName: device.name,
        outcome: 'infeasible',
        heldCount: 0,
        lowestStepKw,
        otherLoadKw,
      });
      continue;
    }

    // (3) Hold every lower-priority managed device, including idle ones.
    for (const other of lowerPriority) holdIds.add(other.id);
    decisions.push({
      deviceId: device.id,
      deviceName: device.name,
      outcome: 'held',
      heldCount: lowerPriority.length,
      lowestStepKw,
      otherLoadKw,
    });
  }

  emitDecisions(decisions, ceilingKw);
  return { holdIds, decisions };
}

// Structured debug only (not info): a hold re-evaluates every plan cycle, so an always-on info
// line would be per-rebuild noise across a multi-hour reheat. The held devices already surface
// through the plan's normal shed output; this is supplementary diagnostics.
function emitDecisions(decisions: readonly PauseHoldDecision[], ceilingKw: number): void {
  for (const decision of decisions) {
    logger.debug({
      event: decision.outcome === 'held' ? 'pause_hold_applied' : 'pause_hold_lifted',
      deviceId: decision.deviceId,
      deviceName: decision.deviceName,
      outcome: decision.outcome,
      heldCount: decision.heldCount,
      lowestStepKw: decision.lowestStepKw,
      otherLoadKw: decision.otherLoadKw,
      ceilingKw,
    });
  }
}
