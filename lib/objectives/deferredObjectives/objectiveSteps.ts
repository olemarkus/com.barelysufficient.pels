import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import { isEvDevice } from '../../../packages/shared-domain/src/commandableNow';
import { isTemperatureControlDevice } from '../../../packages/shared-domain/src/temperatureDeviceKind';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { drawWhenActivelyDrawingKw } from './planningSpeed';
import type { DeferredObjectiveStep } from './types';

// Grid draw for a step: the calibrated admission power when one exists, else the
// nameplate. `null` when neither yields a usable figure — the caller then DROPS the
// rung rather than planning with a made-up one.
//
// `DeferredObjectiveStep.admissionPowerKw` promises finite and non-negative and
// consumers now read it flat on that promise, so this is one of the two producers
// that has to make it true. The stepped-profile caller derives the nameplate as
// `planningPowerW / 1000`, so junk upstream would otherwise arrive as NaN and
// poison the priority-reservation sum, publishing `reservedHeadroomKw: NaN` to every
// lower-priority task.
//
// Substituting 0 would be worse than the NaN, not better: a rung claiming to draw
// nothing while delivering positive useful power passes every headroom check and
// could be planned straight past the hard cap. Absence is absence — see the root
// AGENTS.md ("never fabricate `0`") and `hard-cap-is-physical`.
const resolveAdmissionPowerKw = (
  device: ObjectiveDeviceInput,
  stepId: string,
  fallbackKw: number,
): number | null => {
  const calibrated = device.stepPowerCalibration?.[stepId]?.admissionPowerKw;
  if (typeof calibrated === 'number' && Number.isFinite(calibrated) && calibrated > 0) return calibrated;
  return Number.isFinite(fallbackKw) && fallbackKw >= 0 ? fallbackKw : null;
};

// Drop a rung whose grid draw could not be resolved. A ladder is allowed to be
// shorter than the device's nameplate profile; it is not allowed to contain a rung
// the planner cannot cost.
const withResolvedAdmission = (
  steps: Array<{ id: string; usefulPowerKw: number; admissionPowerKw: number | null }>,
): DeferredObjectiveStep[] => steps.flatMap((step) => (
  step.admissionPowerKw === null
    ? []
    : [{ id: step.id, usefulPowerKw: step.usefulPowerKw, admissionPowerKw: step.admissionPowerKw }]
));

// The single synthetic rung a device without a stepped ladder gets. Both callers
// route through the same calibrated lookups so the allocator's per-step useful
// power and the hero's planning-speed reading cannot disagree. It yields the
// LOOSE shape on purpose: `withResolvedAdmission` above still has to be able to
// drop it when its grid draw cannot be costed.
const buildSyntheticChargeStep = (
  device: ObjectiveDeviceInput,
  nameplateKw: number,
): { id: string; usefulPowerKw: number; admissionPowerKw: number | null } => ({
  id: 'charge',
  usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', nameplateKw),
  admissionPowerKw: resolveAdmissionPowerKw(device, 'charge', nameplateKw),
});

// Resolves the per-objective step list the horizon planner consumes. Stepped
// devices expose their full ladder via `steppedLoadProfile`; EV chargers and
// thermal devices without stepped controls route through the same calibrated
// lookup so the allocator's per-step useful power agrees with the hero's
// planning-speed reading (otherwise a confident calibration below nameplate
// would let the allocator over-promise delivery while the hero shows a slower
// speed). Returns an empty list when the device has neither a stepped profile
// nor a usable planning/expected/measured power.
export const resolveObjectiveSteps = (device: ObjectiveDeviceInput): DeferredObjectiveStep[] => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    return withResolvedAdmission(sortSteppedLoadSteps(profile.steps).map((step) => {
      const nameplateKw = step.planningPowerW / 1000;
      return {
        id: step.id,
        usefulPowerKw: resolveStepDeliveryUsefulKw(device, step.id, nameplateKw),
        admissionPowerKw: resolveAdmissionPowerKw(device, step.id, nameplateKw),
      };
    }));
  }
  const planning = device.planningPowerKw;
  if (typeof planning === 'number' && Number.isFinite(planning) && planning > 0) {
    return withResolvedAdmission([{
      id: 'charge',
      usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', planning),
      admissionPowerKw: resolveAdmissionPowerKw(device, 'charge', planning),
    }]);
  }
  // Configured as a stepped load, but carrying no live ladder this cycle. Answer
  // "no steps" so the committed task serves its frozen plan (`liveStepsUnavailable`
  // → `resolveServedFrozenRead`) instead of replanning against one synthetic rung.
  //
  // This is the condition that protection was always FOR. It used to be reached
  // by accident, via "no usable power figure" — a proxy that stopped working the
  // moment `expectedPowerKw` became a guaranteed positive number, because every
  // device could then produce a rung. Then it was inferred here, from a
  // `controlModel` tag that survived the cluster rebuild. It is now the producer's
  // answer, read flat: `toPlanDevice` is where the configured intent and the
  // ladder the planner will run are both visible, and this layer trusts it rather
  // than reconstructing it (resolution-in-producer). Prod 2026-08-01: a stepped
  // water heater lost its profile across a restart and its committed task degraded
  // to `unknown` for 9.5 h; regression-guarded at the SDK boundary by
  // `test/e2e/deferredObjectiveStepGapRestartSdkE2E.test.ts`.
  //
  // MOVES WITH `resolvePlanningSpeedKw` in `planningSpeed.ts` — the two are
  // mirrors, and a divergence means the diagnostic and the hero copy disagree
  // about the same device in the same cycle.
  if (device.steppedLadderMissing === true) return [];
  if (isEvDevice(device)) {
    return withResolvedAdmission([buildSyntheticChargeStep(device, device.expectedPowerKw)]);
  }
  // Thermal-without-stepped-controls fallback: emit one synthetic "charge"
  // step so the bucket allocator can build a horizon plan instead of leaving
  // the smart task stuck on `objective_missing_charge_rate` /
  // `pendingReason: missing_capacity`.
  // The live draw (`currentDrawKw`) is preferred — on a heating cycle it is the
  // most accurate nameplate we have for these devices; `drawWhenActivelyDrawingKw`
  // ignores a standby trickle, so an idle heater falls through to the producer's
  // resolved `expectedPowerKw`. EV chargers do not use the live draw here because
  // their `expectedPowerKw` is the calibrated 1-step view from
  // `appInit/calibrationViews.buildEvChargerCalibrationView` and the existing
  // branch above is the documented invariant for EV planning speed.
  // Mill-/Adax-/Glamox-shaped Norwegian panel heaters report class
  // `thermostat`, `onoff` + `target_temperature` + `measure_power`, no
  // stepped controls; before this branch they kept `pendingReason:
  // missing_capacity` indefinitely even with a converged learned profile.
  if (isTemperatureControlDevice(device)) {
    const activeDrawKw = drawWhenActivelyDrawingKw(device.currentDrawKw);
    return withResolvedAdmission([
      buildSyntheticChargeStep(device, activeDrawKw ?? device.expectedPowerKw),
    ]);
  }
  return [];
};
