/**
 * Cascade parity test for chunk 4 of the planner-detype refactor.
 *
 * Walks representative devices through `estimateRestorePower` and
 * `computeBaseRestoreNeed` in two passes:
 *   1. Legacy pass — fixtures built without `residualKw.restore`. The
 *      `resolveSteppedRestorePower + getRestoreDrawKw` chain in
 *      `lib/plan/restore/accounting.ts` resolves the value.
 *   2. Producer pass — same fixtures, plus a producer-resolved
 *      `residualKw.restore` field. The chunk-4 dual-read path in
 *      `resolveRestorePower` short-circuits and reads the producer's value.
 *
 * The invariant we pin: per-device estimate AND the summed
 * `computeBaseRestoreNeed` totals must match to the watt across both passes.
 * If chunk 6 deletes the legacy branch and the producer drifts, this test
 * fires.
 *
 * Edge-case coverage closes TODO §"Before chunk 6 — expand restore-accounting
 * cascade-parity test coverage." (2026-05-27):
 *  - (a) stepped, `hasBinaryControl: false`, already at lowest active step
 *        (path-2 → path-3 fall-through with `restoreStep.planningPowerW === 0`
 *        when the profile lowest-active step has no positive planning kW).
 *  - (b) stepped, `selectedStepId` absent and `hasKnownEffectiveStep === false`
 *        (measured-power fallback via path-3 `getRestoreDrawKw`).
 *  - (c) stepped, `selectedStepId` absent but `hasKnownEffectiveStep === true`
 *        (one of `reportedStepId` / `actualStepId` / `assumedStepId` set).
 *  - (d) temperature device with `currentValue == normalized shedTemperature`
 *        (no-op shed case; restore-side parity unaffected by shed semantics).
 */
import { describe, expect, it } from 'vitest';
import {
  computeBaseRestoreNeed,
  estimateRestorePower,
  resolveRestorePowerSource,
} from '../lib/plan/restore/accounting';
import type { DevicePlanDevice } from '../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import {
  resolveResidualKwRestore,
} from '../lib/device/deviceResidualKw';
import { getRestoreDrawKw } from '../lib/observer/observedPower';
import { steppedProfile, buildPlanDevice } from './utils/planTestUtils';

// A degenerate stepped profile whose every step has `planningPowerW <= 0`.
// `getSteppedLoadRestoreStep` falls back to `getSteppedLoadHighestStep` and
// returns a step whose `planningPowerW === 0`, which fails the
// `restoreStep.planningPowerW > 0` guard in both the producer
// (`resolveSteppedResidualKwRestore`) and the legacy chain
// (`resolveSteppedRestorePower`) — both fall through to path-3
// (`getRestoreDrawKw`). Used by edge case (a) to pin parity through that
// fall-through.
const zeroPowerSteppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 0 },
    { id: 'high', planningPowerW: 0 },
  ],
};

function withProducerResolvedRestore(dev: DevicePlanDevice): DevicePlanDevice {
  // Mirror the wiring in `setup/appInit/residualKwForPlanDevice.ts`. The
  // wiring layer is what the real runtime uses; this test recomputes it from
  // the plan-device snapshot directly so we can compare legacy vs producer
  // path on the same fixture.
  const isStepped = dev.controlModel === 'stepped_load'
    && dev.steppedLoadProfile?.model === 'stepped_load';
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
    restoreFallback: getRestoreDrawKw(dev),
  });
  return {
    ...dev,
    residualKw: { shed: 0, restore },
  };
}

describe('restore accounting parity — producer vs legacy chain', () => {
  // Four representative devices spanning the load-bearing branches:
  //   A — binary EV charger, currently off (uses getRestoreDrawKw fallback path).
  //   B — binary water heater, currently on (uses measured power directly).
  //   C — stepped device at a low step (observed-on with positive planning kW).
  //   D — stepped device observed-off (uses profile lowest-active step).
  const deviceA = buildPlanDevice({
    id: 'A-ev',
    name: 'EV',
    currentOn: false,
    currentState: 'off',
    controlCapabilityId: 'evcharger_charging',
    // No measured / expected / planning kW — exercises the EV fallback path.
  });
  const deviceB = buildPlanDevice({
    id: 'B-heater',
    name: 'Heater',
    currentOn: true,
    currentState: 'on',
    measuredPowerKw: 2.4,
    planningPowerKw: 2,
  });
  const deviceC = buildPlanDevice({
    id: 'C-stepped-on',
    name: 'Stepped on',
    currentOn: true,
    currentState: 'on',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    planningPowerKw: 1.25,
  });
  const deviceD = buildPlanDevice({
    id: 'D-stepped-off',
    name: 'Stepped off',
    currentOn: false,
    currentState: 'off',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'off',
    planningPowerKw: 0,
  });

  // Edge-case fixtures added 2026-05-27 to harden cascade-parity coverage
  // before chunk 6 removes the legacy fallback.
  //
  // (a) Stepped device, `hasBinaryControl: false`, already at lowest active
  //     step. Profile has every step at planningPowerW = 0, so
  //     `getSteppedLoadRestoreStep` returns a zero-power step which fails the
  //     `> 0` guard. Both legacy and producer fall through to path-3
  //     `getRestoreDrawKw`, which (with no measured/expected/planning kW)
  //     returns the generic 1.0 kW fallback.
  const deviceE = buildPlanDevice({
    id: 'E-stepped-lowest-no-binary',
    name: 'Stepped lowest no-binary',
    currentOn: false,
    currentState: 'off',
    controlModel: 'stepped_load',
    steppedLoadProfile: zeroPowerSteppedProfile,
    selectedStepId: 'low',
    hasBinaryControl: false,
    planningPowerKw: 0,
  });
  // (b) Stepped device with `selectedStepId` absent and
  //     `hasKnownEffectiveStep === false`. With no reported / actual / assumed
  //     step set, both paths see no positive planning kW and the legacy chain's
  //     `dev.currentState !== 'off' && planningPowerKw > 0` branch fails. The
  //     profile's lowest-active step is still positive, so both legacy and
  //     producer take path-2 (source `'stepped'`, kw from lowest-active step).
  const deviceF = buildPlanDevice({
    id: 'F-stepped-step-absent-unknown',
    name: 'Stepped unknown step',
    currentOn: true,
    currentState: 'on',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    measuredPowerKw: 1.1,
  });
  // (c) Stepped device with `selectedStepId` absent but
  //     `hasKnownEffectiveStep === true` via `reportedStepId`. The legacy
  //     `resolveSteppedRestorePower` doesn't look at reported/actual/assumed;
  //     it gates on `planningPowerKw` (live planning kW). Without a positive
  //     `planningPowerKw`, both paths still take path-2 (source `'stepped'`).
  //     This pins that the producer's `hasKnownEffectiveStep` flag does not
  //     accidentally change the restore-side resolution.
  const deviceG = buildPlanDevice({
    id: 'G-stepped-reported',
    name: 'Stepped reported only',
    currentOn: true,
    currentState: 'on',
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    reportedStepId: 'medium',
    measuredPowerKw: 2.05,
  });
  // (d) Temperature device with `currentValue == normalized shedTemperature`.
  //     The restore-side code does not consult the temperature target at all
  //     (shed semantics live on the shed-residual producer); both legacy and
  //     producer route through path-3 `getRestoreDrawKw` which returns the
  //     highest of measured/expected/planning/configured.
  const deviceH = buildPlanDevice({
    id: 'H-temperature-noop-shed',
    name: 'Thermostat at shed setpoint',
    currentOn: true,
    currentState: 'on',
    measuredPowerKw: 1.8,
    expectedPowerKw: 1.8,
    shedAction: 'set_temperature',
    shedTemperature: 18,
    currentTarget: 18,
  });

  const fixtures = [deviceA, deviceB, deviceC, deviceD, deviceE, deviceF, deviceG, deviceH] as const;

  it('estimateRestorePower returns the same number per device across legacy and producer paths', () => {
    for (const dev of fixtures) {
      const legacy = estimateRestorePower(dev);
      const producer = estimateRestorePower(withProducerResolvedRestore(dev));
      expect(producer).toBeCloseTo(legacy, 9);
    }
  });

  it('resolveRestorePowerSource returns the same source label per device across paths', () => {
    for (const dev of fixtures) {
      const legacy = resolveRestorePowerSource(dev);
      const producer = resolveRestorePowerSource(withProducerResolvedRestore(dev));
      expect(producer).toBe(legacy);
    }
  });

  it('computeBaseRestoreNeed returns matching power / buffer / needed across paths', () => {
    for (const dev of fixtures) {
      const legacy = computeBaseRestoreNeed(dev);
      const producer = computeBaseRestoreNeed(withProducerResolvedRestore(dev));
      expect(producer.power).toBeCloseTo(legacy.power, 9);
      expect(producer.buffer).toBeCloseTo(legacy.buffer, 9);
      expect(producer.needed).toBeCloseTo(legacy.needed, 9);
    }
  });

  it('summed restore need across the cascade matches between legacy and producer paths', () => {
    let legacyTotal = 0;
    let producerTotal = 0;
    for (const dev of fixtures) {
      legacyTotal += computeBaseRestoreNeed(dev).needed;
      producerTotal += computeBaseRestoreNeed(withProducerResolvedRestore(dev)).needed;
    }
    expect(producerTotal).toBeCloseTo(legacyTotal, 9);
  });

  // Adversarial guard: each new edge-case fixture must actually exercise
  // the resolution path we documented in its comment, not just happy-path
  // equality through the same branch. If a future refactor changes which
  // branch handles a fixture, this assertion fires.
  it('edge-case fixtures exercise the intended resolution sources', () => {
    expect(resolveRestorePowerSource(deviceE)).toBe('fallback');
    expect(resolveRestorePowerSource(deviceF)).toBe('stepped');
    expect(resolveRestorePowerSource(deviceG)).toBe('stepped');
    // Path-3 with measuredPowerKw set returns source 'measured'.
    expect(resolveRestorePowerSource(deviceH)).toBe('measured');
  });

  it('cap-off device (controllable=false) restore residual is unaffected — both paths read the same kW', () => {
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
