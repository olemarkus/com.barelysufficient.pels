import { sortSteppedLoadSteps } from '../../../packages/shared-domain/src/deviceControlProfiles';
import { isEvDevice } from '../../../packages/shared-domain/src/commandableNow';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { drawWhenActivelyDrawingKw } from './planningSpeed';
import type { DeferredObjectiveStep } from './types';

// Grid draw for a step: the step's NAMEPLATE, never its learned power. `null` when
// the nameplate is not a usable figure — the caller then DROPS the rung rather than
// planning with a made-up one.
//
// This is the figure every capacity question asks about the rung: the bucket's
// contended-room fit, the reservation a higher-priority booking holds against the
// tasks behind it, and the committed step a fully-reserved hour climbs to. It is
// the same price the planner's own restore admission puts on the rung
// (`resolveStepChangeKw` in `lib/plan/planSteppedLoad.ts`), so a task cannot book
// room the planner will then refuse. The learned figure is at or below nameplate
// and can be polluted low (a charger's `6a` rung learned 0.79 kW from trickle
// samples against a 1.38 kW nameplate, 2026-10-01), so it answers `usefulPowerKw`
// — how fast energy lands — and nothing that fits a rung into room.
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
const resolveAdmissionPowerKw = (nameplateKw: number): number | null => (
  Number.isFinite(nameplateKw) && nameplateKw >= 0 ? nameplateKw : null
);

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
  admissionPowerKw: resolveAdmissionPowerKw(nameplateKw),
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
        admissionPowerKw: resolveAdmissionPowerKw(nameplateKw),
      };
    }));
  }
  const planning = device.planningPowerKw;
  if (typeof planning === 'number' && Number.isFinite(planning) && planning > 0) {
    return withResolvedAdmission([{
      id: 'charge',
      usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', planning),
      admissionPowerKw: resolveAdmissionPowerKw(planning),
    }]);
  }
  // The producer refused an incomplete stepped projection cluster. Answer
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
  // than reconstructing it (resolution-in-producer). Resolved owner profiles now
  // survive restart without feedback. The defensive frozen-serving behavior is
  // covered by `test/integration/deferredObjectiveProjectionGapCommitment.test.ts`.
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
  // `planInput/calibrationViews.buildEvChargerCalibrationView` and the existing
  // branch above is the documented invariant for EV planning speed.
  // Mill-/Adax-/Glamox-shaped Norwegian panel heaters report class
  // `thermostat`, `onoff` + `target_temperature` + `measure_power`, no
  // stepped controls; before this branch they kept `pendingReason:
  // missing_capacity` indefinitely even with a converged learned profile.
  //
  // Every other device PELS can only switch takes the same single rung, because
  // running is the one thing it can do: a plain on/off device (a relay-switched
  // water heater carrying an energy task), and equally an on/off device with a
  // settable target that a heating Flow card gave a task, which used to stay at
  // `missing_capacity` for want of a rung. MOVES WITH the mirror in
  // `planningSpeed.ts`.
  const activeDrawKw = drawWhenActivelyDrawingKw(device.currentDrawKw);
  return withResolvedAdmission([
    buildSyntheticChargeStep(device, activeDrawKw ?? device.expectedPowerKw),
  ]);
};
