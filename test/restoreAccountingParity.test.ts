/**
 * Cascade parity test for chunk 4 of the planner-detype refactor.
 *
 * Walks 4 representative devices through `estimateRestorePower` and
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
 */
import { describe, expect, it } from 'vitest';
import {
  computeBaseRestoreNeed,
  estimateRestorePower,
  resolveRestorePowerSource,
} from '../lib/plan/restore/accounting';
import type { DevicePlanDevice } from '../lib/plan/planTypes';
import {
  resolveResidualKwRestore,
} from '../lib/device/deviceResidualKw';
import { getRestoreDrawKw } from '../lib/observer/observedPower';
import { steppedProfile, buildPlanDevice } from './utils/planTestUtils';

function withProducerResolvedRestore(dev: DevicePlanDevice): DevicePlanDevice {
  // Mirror the wiring in `lib/app/appInit/residualKwForPlanDevice.ts`. The
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

  const fixtures = [deviceA, deviceB, deviceC, deviceD] as const;

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
