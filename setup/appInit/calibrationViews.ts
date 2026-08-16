import {
  getAdmissionPowerKw,
  getDeliveryPowerKw,
  hasRecentDrawAt,
  isStepCalibrationConfident,
} from '../../lib/device/devicePowerCalibration';
import { firstPositiveFinite } from '../../lib/objectives/deferredObjectives/planningSpeed';
import type { StepPowerCalibrationView } from '../../lib/plan/planTypes';
import { isFiniteNumber } from '../../lib/utils/appTypeGuards';
import { MIN_ACTIVE_MEASURED_POWER_KW } from '../../lib/observer/observedPower';
import { normalizeMeasuredPowerKw } from '../../packages/shared-domain/src/measuredPowerObservedState';
import type {
  DecoratedDeviceSnapshot,
  MeasuredPowerObservedProbe,
} from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';

const BOOST_RECENT_DRAW_WINDOW_MS = 10 * 60 * 1000;
// One minute, matching the calibration store's own `DEFAULT_FRESHNESS_WINDOW_MS`
// staleness gate: a reading the sample recorder would refuse as stale is not
// evidence here either.
const MEASURED_DRAW_FRESHNESS_WINDOW_MS = 60 * 1000;

export function buildStepPowerCalibrationView(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot,
): Record<string, StepPowerCalibrationView> | undefined {
  const profile = device.steppedLoadProfile;
  if (profile && Array.isArray(profile.steps) && profile.steps.length > 0) {
    return buildSteppedCalibrationView(ctx, device, profile.steps);
  }
  // EV chargers ship a single useful "charge" step rather than a stepped
  // profile. The deferred-objective planner (`resolveObjectiveSteps`) and
  // the hero planning-speed reading both go through
  // `resolveStepDeliveryUsefulKw`, so producing a synthetic 1-step view here
  // unifies the calibration path for both stepped and binary loads instead
  // of duplicating the lookup logic.
  if (device.deviceClass === 'evcharger') {
    return buildEvChargerCalibrationView(ctx, device);
  }
  return undefined;
}

function buildSteppedCalibrationView(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot,
  steps: NonNullable<DecoratedDeviceSnapshot['steppedLoadProfile']>['steps'],
): Record<string, StepPowerCalibrationView> | undefined {
  const snapshot = ctx.getPowerCalibrationSnapshot();
  const deviceEntry = snapshot.devices[device.id];
  if (!deviceEntry) return undefined;
  const entries = steps.flatMap((step): Array<[string, StepPowerCalibrationView]> => {
    if (!step || typeof step.id !== 'string') return [];
    if (step.planningPowerW <= 0) return [];
    if (!deviceEntry.steps[step.id]) return [];
    const nameplateKw = step.planningPowerW / 1000;
    return [[step.id, {
      admissionPowerKw: getAdmissionPowerKw(snapshot, device.id, step.id, nameplateKw),
      deliveryPowerKw: getDeliveryPowerKw(snapshot, device.id, step.id, nameplateKw),
    }]];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildEvChargerCalibrationView(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot,
): Record<string, StepPowerCalibrationView> | undefined {
  // `planningPowerKw` is the decorated per-step figure and still wins when the
  // decorator supplied one; otherwise the producer's resolved expected power is
  // the answer. No `?? powerKw` tail and no null arm — `expectedPowerKw` is
  // required and positive, so an EV charger can no longer fail to get a view.
  const nameplateKw = firstPositiveFinite([device.planningPowerKw]) ?? device.expectedPowerKw;
  const snapshot = ctx.getPowerCalibrationSnapshot();
  const stepId = 'charge';
  // Even when no calibration entries exist yet we expose the nameplate
  // values so the hero planning-speed reading has a useful default. The
  // calibration accessors fall back to nameplate when no confident sample
  // exists, so this stays consistent with stepped devices.
  return {
    [stepId]: {
      admissionPowerKw: getAdmissionPowerKw(snapshot, device.id, stepId, nameplateKw),
      deliveryPowerKw: getDeliveryPowerKw(snapshot, device.id, stepId, nameplateKw),
    },
  };
}

/**
 * Producer-resolved: this device is measurably drawing nothing right now.
 *
 * `true` requires POSITIVE evidence of idleness, and is reserved for the
 * idle-at-setpoint device: a Hoiax holding at its element setpoint, a thermostat
 * in a room already at target, a charger whose car has stopped accepting charge.
 * Four things must all hold — a fresh meter reading below the active floor, a
 * device PELS is not itself holding off, no in-band draw at any step inside the
 * window, and a confidence-qualified reported step.
 *
 * **The live reading is load-bearing, not a belt-and-braces check.** Sample
 * ACCEPTANCE is EMA hygiene, not an answer to "is it drawing": `recordSample`
 * drops a reading that is out of band for its rung — below the next-lower rung's
 * ceiling (`isBelowLowerStep`), above the nameplate, or stale — so a charger
 * parked on a high rung while a PHEV or a tapering session pulls 1-2 kW records
 * NOTHING for as long as it lasts. Concluding idleness from that silence
 * released the boost on a device drawing at full rate, which clamped it down a
 * rung (`resolveSteppedKeepDesiredStepId`) and then blocked the climb back
 * through the shed-invariant bypass that release also gates — a ~15-minute
 * oscillation, one ladder climb per cycle. Absence of a sample is not zero draw,
 * and absence of a METER is not zero draw either: `getCurrentDrawKw` resolves an
 * unreadable meter to `0`, so this reads the normalized reading directly and
 * declines to answer when there is none.
 *
 * Everything else is `false`, including every shape of "no opinion": no reported
 * step yet, no fresh reading, or warm-up samples below the confidence threshold.
 * There is no third state to represent. The consumer (`resolveBoostActive`)
 * releases a boost on `true`, so folding "no opinion" into the idle arm would
 * silently switch boost off for every newly-paired device.
 */
/**
 * The device's own live testimony: a meter reading that is present, fresh, and
 * below the active floor. This is the POSITIVE half of the verdict — it is what
 * separates "measurably drawing nothing" from "we have not heard anything".
 *
 * A reading is only evidence while it is fresh; without the freshness gate a
 * silent or unreadable meter keeps answering with whatever it last said. And
 * `null` is declined rather than read as zero, because `getCurrentDrawKw`
 * resolves an unreadable meter to `0` and a device with no meter would otherwise
 * testify to its own idleness.
 *
 * Freshness is judged on `measuredPowerObservedAtMs` — the timestamp that
 * travels with the READING — and never on device-wide `lastFreshDataMs`, which
 * is a max across every capability. A device whose power meter has gone silent
 * while its thermometer keeps reporting has a fresh `lastFreshDataMs` and a
 * stale cached `measuredPowerKw`, which is precisely the shape that would let an
 * unknown draw pass as zero and cancel a configured or forced boost.
 */
const isMeasurablyIdle = (
  device: MeasuredPowerObservedProbe,
  nowMs: number,
): boolean => {
  const measuredKw = normalizeMeasuredPowerKw(device.measuredPowerKw);
  if (measuredKw === null) return false;
  if (measuredKw >= MIN_ACTIVE_MEASURED_POWER_KW) return false;
  const observedAtMs = device.measuredPowerObservedAtMs;
  if (!isFiniteNumber(observedAtMs)) return false;
  return (nowMs - observedAtMs) <= MEASURED_DRAW_FRESHNESS_WINDOW_MS;
};

/**
 * The calibration store's half: no accepted in-band draw at ANY of the device's
 * rungs inside the window.
 *
 * Checking only the reported step misreads "just stepped up" as "idle" — right
 * after a step change the new rung has no accepted samples yet (ramp readings
 * are out of band) while the rung it came from still holds fresh ones. Scanning
 * every rung is what keeps a boosted staircase climbing instead of releasing its
 * boost at each step change.
 *
 * Accepted collateral: a device shed DOWN a rung and now idle at its setpoint
 * keeps its boost for the rest of the window off the departed rung's samples, so
 * a boosted swap can briefly pause a lower-priority device for demand that never
 * comes. Bounded to the window plus an active boost. Scoping cross-rung evidence
 * to non-confident reported steps would re-break the ramp case this exists for —
 * the stale rung there IS calibration-confident.
 */
const hasNoRecentDrawAtAnyStep = (params: {
  snapshot: ReturnType<AppContext['getPowerCalibrationSnapshot']>;
  deviceId: string;
  steps: NonNullable<DecoratedDeviceSnapshot['steppedLoadProfile']>['steps'];
  nowMs: number;
}): boolean => {
  const { snapshot, deviceId, steps, nowMs } = params;
  for (const step of steps) {
    if (!step || typeof step.id !== 'string') continue;
    const stepNameplateKw = isFiniteNumber(step.planningPowerW) && step.planningPowerW > 0
      ? step.planningPowerW / 1000
      : undefined;
    if (hasRecentDrawAt({
      snapshot,
      deviceId,
      stepId: step.id,
      windowMs: BOOST_RECENT_DRAW_WINDOW_MS,
      nowMs,
      nameplateKw: stepNameplateKw,
    })) {
      return false;
    }
  }
  return true;
};

export function resolveConfirmedNotDrawing(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & MeasuredPowerObservedProbe,
  observedOff: boolean,
): boolean {
  // A device PELS is holding off is reporting the consequence of PELS's own
  // shed, not a fact about its demand. It must never testify itself out of the
  // boost that would resume it — `reportedStepId` keeps the rung the device
  // announces even while the binary axis holds it off (an Easee reverts to 32 A
  // and says so while paused — `lib/device/AGENTS.md`), so the off step's
  // never-confident calibration does NOT cover this case on its own.
  if (observedOff) return false;
  // Use the observed step (reportedStepId) only. Falling back to
  // `selectedStepId` would claim confident idleness for a step the device may
  // never have visited, releasing boost during the warm-up window.
  const stepId = device.reportedStepId;
  if (typeof stepId !== 'string' || stepId.length === 0) return false;
  const snapshot = ctx.getPowerCalibrationSnapshot();
  // Use the AppContext clock so the planner can be tested deterministically
  // and so this stays consistent with other plan-input enrichment helpers
  // (per state-management/AGENTS.md "use a single clock per cycle").
  const nowMs = ctx.getNow().getTime();
  if (!isMeasurablyIdle(device, nowMs)) return false;
  const steps = device.steppedLoadProfile?.steps ?? [];
  // No ladder, no recency scan — and therefore no verdict. Without this the
  // confidence check below would be the whole answer, which contradicts this
  // function's contract that idleness requires a quiet window too.
  if (steps.length === 0) return false;
  if (!hasNoRecentDrawAtAnyStep({ snapshot, deviceId: device.id, steps, nowMs })) return false;
  const planningPowerW = steps.find((step) => step.id === stepId)?.planningPowerW;
  const nameplateKw = isFiniteNumber(planningPowerW) && planningPowerW > 0
    ? planningPowerW / 1000
    : undefined;
  // Warm-up samples (below the confidence threshold) are not a verdict. Only a
  // confidence-qualified reported step may conclude the device is idle.
  return isStepCalibrationConfident(snapshot, device.id, stepId, nameplateKw);
}
