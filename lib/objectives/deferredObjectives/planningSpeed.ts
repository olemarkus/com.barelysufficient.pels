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

/**
 * The device's live draw, but only when it is actually DRAWING.
 *
 * A thermal device's planning speed is "how fast can this thing deliver energy",
 * and its live draw only answers that mid-cycle. An idle panel heater reporting a
 * few watts of standby would otherwise win the candidate ladder outright and give
 * a planning speed of 0.003 kW — turning a schedulable task into one that needs
 * hundreds of hours.
 *
 * This used to be handled upstream, by the resolver dropping any reading at or
 * below `MIN_SIGNIFICANT_POWER_W`. That floor is gone (it made a real 3 W draw
 * indistinguishable from "no meter", which is what licensed rated-power
 * substitution), so the question "is it drawing enough to time against?" is asked
 * here instead — where it is actually being asked — using the same
 * actively-drawing threshold the admission path uses.
 */
// Duplicated from `MIN_ACTIVE_MEASURED_POWER_KW` in `lib/observer/observedPower.ts`
// rather than imported: `lib/objectives` may not depend on `lib/observer`
// (`no-objectives-to-peer-except-power`). Keep the two in step — they answer the
// same question, "is this device drawing or merely idling".
//
// Distinct from `MIN_CREDIBLE_DEVICE_POWER_KW` (5 W) in `lib/objectives/samples.ts`,
// which asks a different question — "is this reading real enough to learn from" —
// and is deliberately an order of magnitude lower.
const ACTIVELY_DRAWING_MIN_KW = 0.05;

export const drawWhenActivelyDrawingKw = (currentDrawKw: number): number | null => (
  currentDrawKw > ACTIVELY_DRAWING_MIN_KW ? currentDrawKw : null
);

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
  // Same step-ladder gap `resolveObjectiveSteps` answers `[]` for: a stepped
  // device with no live profile has no speed to report, and reporting one here
  // while the planner serves a frozen plan is exactly the producer/consumer
  // disagreement the comment below warns about.
  if (device.controlModel === 'stepped_load') return null;
  if (isEvDevice(device)) {
    return positiveOrNull(resolveStepDeliveryUsefulKw(device, 'charge', device.expectedPowerKw));
  }
  // Mirror the thermostat-class fallback in `objectiveSteps.ts` so the hero
  // meta line (`kW · duration · mode`) and the planner's per-active-hour
  // commit agree on the synthesised power. Without this parity the planner
  // builds a horizon plan against the fallback rate while the hero degrades
  // to the `hoursLeft` form — a producer/consumer disagreement that hides
  // the rate the user is actually being charged against.
  if (isTemperatureControlDevice(device)) {
    const activeDrawKw = drawWhenActivelyDrawingKw(device.currentDrawKw);
    const expected = activeDrawKw ?? device.expectedPowerKw;
    return positiveOrNull(resolveStepDeliveryUsefulKw(device, 'charge', expected));
  }
  return null;
};
