/**
 * Resolves "planning speed" — the per-active-hour useful power the planner
 * commits — for diagnostics. The bucket allocator (`resolveObjectiveSteps`)
 * consumes the same calibration view via {@link resolveStepDeliveryUsefulKw}
 * so the hero meta line and the planner stay in agreement.
 *
 * Excludes zero-power "off" steps for stepped profiles. EV chargers ship a
 * synthetic 1-step "charge" calibration view via
 * `appInit/calibrationViews.buildEvChargerCalibrationView`; the same lookup applies here so
 * we don't duplicate the nameplate fallback.
 */
import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import { isEvDevice } from '../../../packages/shared-domain/src/commandableNow';
import { isTemperatureControlDevice } from '../../../packages/shared-domain/src/temperatureDeviceKind';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';

const positiveOrNull = (value: number): number | null => (
  Number.isFinite(value) && value > 0 ? value : null
);

/**
 * First strictly-positive finite value from `values`, or `null` when none.
 * Shared with the diagnostics bridge and EV calibration helpers so device
 * "expected/planned/measured" candidate lists stay in agreement on what
 * counts as a usable nameplate.
 */
export const firstPositiveFinite = (values: readonly unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
};

const resolveSteppedPlanningSpeedKw = (
  device: ObjectiveDeviceInput,
  steps: NonNullable<ObjectiveDeviceInput['steppedLoadProfile']>['steps'],
): number | null => {
  const stepKws = sortSteppedLoadSteps(steps)
    .map((step) => resolveStepDeliveryUsefulKw(device, step.id, step.planningPowerW / 1000))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (stepKws.length === 0) return null;
  return positiveOrNull(Math.min(...stepKws));
};

/**
 * The per-active-hour useful power the planner will commit. Returns null
 * when no usable step exists so the hero falls back to "Learning…" copy.
 */
export const resolvePlanningSpeedKw = (device: ObjectiveDeviceInput | undefined): number | null => {
  if (!device) return null;
  const profile = device.steppedLoadProfile;
  if (profile && Array.isArray(profile.steps) && profile.steps.length > 0) {
    return resolveSteppedPlanningSpeedKw(device, profile.steps);
  }
  const planning = device.planningPowerKw;
  if (typeof planning === 'number' && Number.isFinite(planning) && planning > 0) {
    // EV chargers carry `planningPowerKw` directly via the synthetic 1-step
    // calibration view from `appInit/calibrationViews.buildEvChargerCalibrationView`. Both
    // paths route through `resolveStepDeliveryUsefulKw` so the hero meta line
    // and the bucket allocator agree on the value.
    return positiveOrNull(resolveStepDeliveryUsefulKw(device, 'charge', planning));
  }
  if (isEvDevice(device)) {
    const expected = firstPositiveFinite([device.expectedPowerKw, device.powerKw]);
    if (expected !== null) {
      return positiveOrNull(resolveStepDeliveryUsefulKw(device, 'charge', expected));
    }
  }
  // Mirror the thermostat-class fallback in `objectiveSteps.ts` so the hero
  // meta line (`kW · duration · mode`) and the planner's per-active-hour
  // commit agree on the synthesised power. Without this parity the planner
  // builds a horizon plan against the fallback rate while the hero degrades
  // to the `hoursLeft` form — a producer/consumer disagreement that hides
  // the rate the user is actually being charged against.
  if (isTemperatureControlDevice(device)) {
    const expected = firstPositiveFinite([
      device.measuredPowerKw,
      device.expectedPowerKw,
      device.powerKw,
    ]);
    if (expected !== null) {
      return positiveOrNull(resolveStepDeliveryUsefulKw(device, 'charge', expected));
    }
  }
  return null;
};
