import {
  getAdmissionPowerKw,
  getDeliveryPowerKw,
  hasRecentDrawAt,
  isStepCalibrationConfident,
} from '../../device/devicePowerCalibration';
import { firstPositiveFinite } from '../../objectives/deferredObjectives/planningSpeed';
import type { StepPowerCalibrationView } from '../../plan/planTypes';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { AppContext } from '../appContext';

const BOOST_RECENT_DRAW_WINDOW_MS = 10 * 60 * 1000;

export function buildStepPowerCalibrationView(
  ctx: AppContext,
  device: TargetDeviceSnapshot,
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
  device: TargetDeviceSnapshot,
  steps: NonNullable<TargetDeviceSnapshot['steppedLoadProfile']>['steps'],
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
  device: TargetDeviceSnapshot,
): Record<string, StepPowerCalibrationView> | undefined {
  const nameplateKw = firstPositiveFinite([
    device.planningPowerKw,
    device.expectedPowerKw,
    device.powerKw,
  ]);
  if (nameplateKw === null) return undefined;
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

export function resolveHasRecentObservedDrawAtSelectedStep(
  ctx: AppContext,
  device: TargetDeviceSnapshot,
): boolean | undefined {
  // Use the observed step (reportedStepId) only. Falling back to
  // `selectedStepId` would convert "no observation yet" into a concrete
  // `false` for a step the device may never have visited, blocking boost
  // escalation during the warmup window — the gate's contract treats
  // `undefined` as "no calibration opinion, keep the legacy bypass."
  const stepId = device.reportedStepId;
  if (typeof stepId !== 'string' || stepId.length === 0) return undefined;
  const snapshot = ctx.getPowerCalibrationSnapshot();
  const planningPowerW = device.steppedLoadProfile?.steps.find((step) => step.id === stepId)?.planningPowerW;
  const nameplateKw = isFiniteNumber(planningPowerW) && planningPowerW > 0
    ? planningPowerW / 1000
    : undefined;
  // Warm-up samples (below the confidence threshold) must not produce a
  // concrete `false` — the gate would treat that as authoritative and
  // suppress boost escalation for newly-paired devices.
  if (!isStepCalibrationConfident(snapshot, device.id, stepId, nameplateKw)) return undefined;
  // Use the AppContext clock so the planner can be tested deterministically
  // and so this stays consistent with other plan-input enrichment helpers
  // (per state-management/AGENTS.md "use a single clock per cycle").
  return hasRecentDrawAt({
    snapshot,
    deviceId: device.id,
    stepId,
    windowMs: BOOST_RECENT_DRAW_WINDOW_MS,
    nowMs: ctx.getNow().getTime(),
    nameplateKw,
  });
}
