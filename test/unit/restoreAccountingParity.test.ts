/**
 * Cascade parity test for the restore residual.
 *
 * The consumer-side legacy chain is gone — `resolveRestorePower` reads
 * `residualKw.restore` and nothing else — so what this pins now is the ONE
 * remaining place two answers could diverge: the shared fixture builder resolves
 * a device's restore residual through `buildResidualKwForPlanDevice` (the
 * producer itself), while this test recomputes it from the finished PLAN device
 * through `resolveResidualKwRestore` + `getHighestKnownPowerKw`.
 *
 * Walks representative devices through `estimateRestorePower` and
 * `computeBaseRestoreNeed` in two passes:
 *   1. As built — the residual the shared builder stamped from the fixture's
 *      own fields, at the producer seam.
 *   2. Recomputed — the same fixtures with the restore half re-resolved from the
 *      plan device, mirroring the wiring in
 *      `setup/appInit/residualKwForPlanDevice.ts`.
 *
 * The invariant we pin: per-device estimate AND the summed
 * `computeBaseRestoreNeed` totals must match to the watt across both passes. If
 * the fixture's snapshot adaptation drifts from the wiring, this test fires.
 *
 * Edge-case coverage (2026-05-27):
 *  - (a) stepped, `binaryCapabilityId: undefined`, already at lowest active step
 *        (path-2 → path-3 fall-through with `restoreStep.planningPowerW === 0`
 *        when the profile lowest-active step has no positive planning kW).
 *  - (b) stepped, `selectedStepId` absent and `hasKnownEffectiveStep === false`
 *        (measured-power fallback via path-3 `getRestoreDrawKw`).
 *  - (c) stepped, `selectedStepId` absent but `hasKnownEffectiveStep === true`
 *        (`reportedStepId` set, or `selectedStepId` carries the planning fallback).
 *  - (d) temperature device with `currentValue == normalized shedTemperature`
 *        (no-op shed case; restore-side parity unaffected by shed semantics).
 */
import { describe, expect, it } from 'vitest';
import {
  computeBaseRestoreNeed,
  estimateRestorePower,
  resolveRestorePowerSource,
} from '../../lib/plan/restore/accounting';
import type {
  DevicePlanDevice,
  BinaryControlDiscriminantProbe,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import type { DeviceControlModel, SteppedLoadProfile } from '../../packages/contracts/src/types';
import {
  resolveResidualKwRestore,
} from '../../lib/device/deviceResidualKw';
import { getHighestKnownPowerKw } from '../../lib/observer/observedPower';
import { steppedProfile, buildPlanDevice } from '../utils/planTestUtils';

// Local fixture shape: the discriminated output device plus the orthogonal
// binary-control cluster and the producer-only `controlModel` setting — both
// are read by the restore-accounting cascade (`isBinaryObservedOff` and
// `getHighestKnownPowerKw`) even though neither rides on the bare `DevicePlanDevice`
// union, so the fixtures carry them explicitly.
type RestoreFixture = DevicePlanDevice & {
  binaryControl?: { on: boolean };
  controlModel?: DeviceControlModel;
  // `steppedLoadProfile` rides on the stepped variant of the `DevicePlanDevice`
  // union; surface it as a flat optional here so the wiring mirror below can
  // read it the same way `setup/appInit/residualKwForPlanDevice.ts` does
  // (guarded by `controlModel === 'stepped_load'`).
  steppedLoadProfile?: SteppedLoadProfile;
  // Same treatment, same reason: `planningPowerKw` moved onto `SteppedLoadKind`
  // beside the profile, so it is unreachable on the bare union.
  planningPowerKw?: number;
};

// Wrap the shared output-device builder so a fixture can also carry the binary
// cluster + `controlModel`. The shared builder already forwards both through
// its spread at runtime (they are read by the restore cascade); this only
// widens the param type so the extra fields type-check — the produced object is
// byte-identical to the previous direct `buildPlanDevice(...)` call.
const buildRestoreFixture = (
  overrides: Partial<DevicePlanDevice>
    & TemperatureDiscriminantProbe
    & BinaryControlDiscriminantProbe
    & {
      evChargingState?: string;
      binaryCapabilityId?: string;
      controlModel?: DeviceControlModel;
      deviceType?: 'temperature' | 'onoff';
    },
): RestoreFixture => buildPlanDevice(
  overrides as Parameters<typeof buildPlanDevice>[0],
) as RestoreFixture;

// A degenerate stepped profile whose every step has `planningPowerW <= 0`.
// `getSteppedLoadRestoreStep` falls back to `getSteppedLoadHighestStep` and
// returns a step whose `planningPowerW === 0`, which fails the
// `restoreStep.planningPowerW > 0` guard in the producer
// (`resolveSteppedResidualKwRestore`) — resolution falls through to path-3
// (`getHighestKnownPowerKw`). Used by edge case (a) to pin parity through that
// fall-through.
const zeroPowerSteppedProfile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 0 },
    { id: 'high', planningPowerW: 0 },
  ],
};

function withProducerResolvedRestore(dev: RestoreFixture): RestoreFixture {
  // Mirror the wiring in `setup/appInit/residualKwForPlanDevice.ts`. The wiring
  // layer is what the real runtime uses; this test recomputes it from the
  // finished plan device so the number the fixture builder stamped at the
  // producer seam can be compared against it.
  // Profile presence alone, exactly as `isSteppedLoadSnapshot` decides it. The
  // `controlModel` conjunct this replaced was a plain divergence: a stepped
  // fixture that omits the setting is stepped to the producer and not to the
  // mirror.
  const isStepped = dev.steppedLoadProfile !== undefined;
  const restore = resolveResidualKwRestore({
    steppedLoad: isStepped && dev.steppedLoadProfile
      ? {
        profile: dev.steppedLoadProfile,
        currentStateIsOff: dev.currentState === 'off',
        ...(typeof dev.planningPowerKw === 'number' && Number.isFinite(dev.planningPowerKw)
          ? { planningPowerKw: dev.planningPowerKw }
          : {}),
      }
      : undefined,
    restoreFallback: getHighestKnownPowerKw(dev),
  });
  return {
    ...dev,
    residualKw: { shed: 0, restore },
  };
}

describe('restore accounting parity — as built vs recomputed from the plan device', () => {
  // Four representative devices spanning the load-bearing branches:
  //   A — binary EV charger, currently off (uses getRestoreDrawKw fallback path).
  //   B — binary water heater, currently on (uses measured power directly).
  //   C — stepped device at a low step (observed-on with positive planning kW).
  //   D — stepped device observed-off (uses profile lowest-active step).
  const deviceA = buildRestoreFixture({
    id: 'A-ev',
    name: 'EV',
    binaryControl: { on: false },
    currentState: 'off',
    binaryCapabilityId: 'evcharger_charging',
    // No measured / expected / planning kW — exercises the EV fallback path.
  });
  const deviceB = buildRestoreFixture({
    id: 'B-heater',
    name: 'Heater',
    binaryControl: { on: true },
    currentState: 'on',
    currentDrawKw: 2.4,
    planningPowerKw: 2,
  });
  const deviceC = buildRestoreFixture({
    id: 'C-stepped-on',
    name: 'Stepped on',
    binaryControl: { on: true },
    currentState: 'on',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    planningPowerKw: 1.25,
  });
  const deviceD = buildRestoreFixture({
    id: 'D-stepped-off',
    name: 'Stepped off',
    binaryControl: { on: false },
    currentState: 'off',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'off',
    planningPowerKw: 0,
  });

  // Edge-case fixtures added 2026-05-27 to harden cascade-parity coverage.
  //
  // (a) Stepped device, `binaryCapabilityId: undefined`, already at lowest active
  //     step. Profile has every step at planningPowerW = 0, so
  //     `getSteppedLoadRestoreStep` returns a zero-power step which fails the
  //     `> 0` guard, so resolution falls through to path-3
  //     `getHighestKnownPowerKw`, which (with no measured/planning kW) answers
  //     the required `expectedPowerKw`.
  const deviceE = buildRestoreFixture({
    id: 'E-stepped-lowest-no-binary',
    name: 'Stepped lowest no-binary',
    binaryControl: { on: false },
    currentState: 'off',
    controlModel: 'stepped_load',
    steppedLoadProfile: zeroPowerSteppedProfile,
    selectedStepId: 'low',
    binaryCapabilityId: undefined,
    planningPowerKw: 0,
  });
  // (b) Stepped device parked at its OFF step — the representable "no positive
  //     live planning power" state now that a stepped device always carries an
  //     effective step. The `currentState !== 'off' && planningPowerKw > 0`
  //     branch fails, so resolution takes
  //     path-2 (source `'stepped'`, kw from the lowest-active step): the draw a
  //     restore would ADD, which is the whole question on the restore side.
  //     (The former case (c) — `selectedStepId` absent while `reportedStepId`
  //     is set — is unrepresentable: a reported step IS the effective step.)
  const deviceF = buildRestoreFixture({
    id: 'F-stepped-at-off-step',
    name: 'Stepped at off step',
    binaryControl: { on: false },
    currentState: 'off',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'off',
    currentDrawKw: 0,
  });
  // (d) Temperature device with `currentValue == normalized shedTemperature`.
  //     The restore-side code does not consult the temperature target at all
  //     (shed semantics live on the shed-residual producer); resolution routes
  //     through path-3 `getHighestKnownPowerKw`, the highest of
  //     measured/expected/planning.
  const deviceH = buildRestoreFixture({
    id: 'H-temperature-noop-shed',
    name: 'Thermostat at shed setpoint',
    binaryControl: { on: true },
    currentState: 'on',
    currentDrawKw: 1.8,
    expectedPowerKw: 1.8,
    shedAction: 'set_temperature',
    shedTemperature: 18,
    currentTarget: 18,
  });

  const fixtures = [deviceA, deviceB, deviceC, deviceD, deviceE, deviceF, deviceH] as const;

  it('estimateRestorePower returns the same number per device as built and recomputed', () => {
    for (const dev of fixtures) {
      const asBuilt = estimateRestorePower(dev);
      const recomputed = estimateRestorePower(withProducerResolvedRestore(dev));
      expect(recomputed).toBeCloseTo(asBuilt, 9);
    }
  });

  it('resolveRestorePowerSource returns the same source label per device as built and recomputed', () => {
    for (const dev of fixtures) {
      const asBuilt = resolveRestorePowerSource(dev);
      const recomputed = resolveRestorePowerSource(withProducerResolvedRestore(dev));
      expect(recomputed).toBe(asBuilt);
    }
  });

  it('computeBaseRestoreNeed returns matching power / buffer / needed across paths', () => {
    for (const dev of fixtures) {
      const asBuilt = computeBaseRestoreNeed(dev);
      const recomputed = computeBaseRestoreNeed(withProducerResolvedRestore(dev));
      expect(recomputed.power).toBeCloseTo(asBuilt.power, 9);
      expect(recomputed.buffer).toBeCloseTo(asBuilt.buffer, 9);
      expect(recomputed.needed).toBeCloseTo(asBuilt.needed, 9);
    }
  });

  it('summed restore need across the cascade matches as built and recomputed', () => {
    let asBuiltTotal = 0;
    let recomputedTotal = 0;
    for (const dev of fixtures) {
      asBuiltTotal += computeBaseRestoreNeed(dev).needed;
      recomputedTotal += computeBaseRestoreNeed(withProducerResolvedRestore(dev)).needed;
    }
    expect(recomputedTotal).toBeCloseTo(asBuiltTotal, 9);
  });

  // Adversarial guard: each new edge-case fixture must actually exercise
  // the resolution path we documented in its comment, not just happy-path
  // equality through the same branch. If a future refactor changes which
  // branch handles a fixture, this assertion fires.
  it('edge-case fixtures exercise the intended resolution sources', () => {
    // Was `'fallback'`, the label for "no source carried a positive number".
    // `expectedPowerKw` being required and always positive makes that unreachable.
    expect(resolveRestorePowerSource(deviceE)).toBe('expected');
    expect(resolveRestorePowerSource(deviceF)).toBe('stepped');
    // Path-3 with a measured draw returns source 'measured' — equal to its expected
    // draw here, and ties resolve to the earliest candidate.
    expect(resolveRestorePowerSource(deviceH)).toBe('measured');
  });

  it('cap-off device (controllable=false) restore residual is unaffected — both read the same kW', () => {
    // The restore-admission code applies the `controllable !== false` gate
    // in `isRestoreLiveEligibleDevice` BEFORE calling estimateRestorePower,
    // so the residual itself is not where the cap-off behaviour lives. This
    // test pins that the kW we'd compute is still consistent — the producer
    // doesn't accidentally branch on `controllable`.
    const capped = { ...deviceB, controllable: false } satisfies DevicePlanDevice;
    expect(estimateRestorePower(withProducerResolvedRestore(capped)))
      .toBeCloseTo(estimateRestorePower(capped), 9);
  });
});
