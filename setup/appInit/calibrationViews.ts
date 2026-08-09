import {
  getAdmissionPowerKw,
  getDeliveryPowerKw,
  hasRecentDrawAt,
  isStepCalibrationConfident,
} from '../../lib/device/devicePowerCalibration';
import { firstPositiveFinite } from '../../lib/objectives/deferredObjectives/planningSpeed';
import type { StepPowerCalibrationView } from '../../lib/plan/planTypes';
import { isFiniteNumber } from '../../lib/utils/appTypeGuards';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';

const BOOST_RECENT_DRAW_WINDOW_MS = 10 * 60 * 1000;

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

export function resolveHasRecentObservedDraw(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot,
): boolean | undefined {
  // Use the observed step (reportedStepId) only. Falling back to
  // `selectedStepId` would convert "no observation yet" into a concrete
  // `false` for a step the device may never have visited, blocking boost
  // escalation during the warmup window — the gate's contract treats
  // `undefined` as "no calibration opinion, keep the legacy bypass."
  const stepId = device.reportedStepId;
  if (typeof stepId !== 'string' || stepId.length === 0) return undefined;
  const snapshot = ctx.getPowerCalibrationSnapshot();
  // Use the AppContext clock so the planner can be tested deterministically
  // and so this stays consistent with other plan-input enrichment helpers
  // (per state-management/AGENTS.md "use a single clock per cycle").
  const nowMs = ctx.getNow().getTime();
  // Recent in-band draw at ANY step proves the device is accepting load.
  // Checking only the reported step misreads "just stepped up" as "idle":
  // right after a step change the new step has no accepted samples yet (ramp
  // readings are skipped as out-of-band) while the previous step's fresh
  // samples still show a live element. Only the all-steps-quiet case below
  // may produce a concrete `false`.
  //
  // Accepted collateral: a device shed DOWN a step and now idle at its
  // setpoint keeps reading `true` from the departed step's samples for the
  // rest of the window, so a boosted swap can briefly pause a lower-priority
  // device for demand that never comes. Bounded to the window + active
  // boost, and strictly narrower than the pre-gate (pre-2026-05-13)
  // unconditional swap. Scoping cross-step evidence to non-confident
  // reported steps would re-break the ramp case this exists for — the stale
  // step there IS calibration-confident.
  const steps = device.steppedLoadProfile?.steps ?? [];
  for (const step of steps) {
    if (!step || typeof step.id !== 'string') continue;
    const stepNameplateKw = isFiniteNumber(step.planningPowerW) && step.planningPowerW > 0
      ? step.planningPowerW / 1000
      : undefined;
    if (hasRecentDrawAt({
      snapshot,
      deviceId: device.id,
      stepId: step.id,
      windowMs: BOOST_RECENT_DRAW_WINDOW_MS,
      nowMs,
      nameplateKw: stepNameplateKw,
    })) {
      return true;
    }
  }
  const planningPowerW = steps.find((step) => step.id === stepId)?.planningPowerW;
  const nameplateKw = isFiniteNumber(planningPowerW) && planningPowerW > 0
    ? planningPowerW / 1000
    : undefined;
  // Warm-up samples (below the confidence threshold) must not produce a
  // concrete `false` — the gate would treat that as authoritative and
  // suppress boost escalation for newly-paired devices.
  if (!isStepCalibrationConfident(snapshot, device.id, stepId, nameplateKw)) return undefined;
  return false;
}
