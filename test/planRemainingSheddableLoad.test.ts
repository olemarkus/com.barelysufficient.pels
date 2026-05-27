import {
  resolveRemainingSheddableLoadKw,
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
  toPlanRemainingSheddableDevice,
  type RemainingShedBehavior,
} from '../lib/plan/planRemainingSheddableLoad';
import { buildPlanDevice, buildPlanInputDevice, steppedProfile } from './utils/planTestUtils';

describe('resolveRemainingSheddableLoadKw — stale observation handling', () => {
  const turnOffBehavior: RemainingShedBehavior = { action: 'turn_off' };

  it('falls back to configured demand for a stale currentOn=false device instead of reporting 0', () => {
    // Regression: stale snapshots with currentOn: false and missing live
    // measurement must not be silently zeroed out — the device may still be
    // drawing, and excluding it from remaining sheddable load can mis-signal
    // "no actionable load left" during shortfall handling. In production the
    // plan-device projection already maps stale devices to currentState
    // 'unknown', which lets resolveEffectiveCurrentOn return null so the
    // observationStale-aware getCurrentDrawKw branch can take over.
    const stale = toPlanRemainingSheddableDevice(buildPlanDevice({
      id: 'stale-off',
      controllable: true,
      currentOn: false,
      currentState: 'unknown',
      observationStale: true,
      expectedPowerKw: 1.4,
    }));
    const kw = resolveRemainingSheddableLoadKw({
      device: stale,
      shedBehavior: turnOffBehavior,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(kw).toBeCloseTo(1.4, 6);
  });

  it('still returns 0 for a fresh currentOn=false device — shedding gives no immediate relief', () => {
    const fresh = toPlanRemainingSheddableDevice(buildPlanDevice({
      id: 'fresh-off',
      controllable: true,
      currentOn: false,
      currentState: 'off',
      observationStale: false,
      expectedPowerKw: 1.4,
    }));
    const kw = resolveRemainingSheddableLoadKw({
      device: fresh,
      shedBehavior: turnOffBehavior,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(kw).toBe(0);
  });
});

describe('sumRemainingSheddableLoadKw — chunk-3 producer-resolved path parity', () => {
  // Behaviour-preservation regression for the producer-resolved residual.
  // We build a representative cascade scenario (mixed simple / temperature /
  // stepped devices) and assert that the producer-resolved path yields the
  // same total as the legacy dual-read fallback. The dual-read fallback fires
  // when `residualKw` is absent; the producer-resolved path fires when it is
  // populated.
  const turnOffBehavior: RemainingShedBehavior = { action: 'turn_off' };

  it('agrees with the legacy fallback across a representative cascade scenario', () => {
    const simpleOn = buildPlanInputDevice({
      id: 'simple-on',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      measuredPowerKw: 1.4,
    });
    const steppedMax = buildPlanInputDevice({
      id: 'stepped-max',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'max',
      hasBinaryControl: true,
      measuredPowerKw: 2.9,
    });
    const steppedAtLowestActive = buildPlanInputDevice({
      id: 'stepped-low',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      hasBinaryControl: true,
      measuredPowerKw: 1.2,
    });

    // Legacy fallback path — residualKw absent on every input.
    const legacyDevices = [simpleOn, steppedMax, steppedAtLowestActive].map(toInputRemainingSheddableDevice);
    const legacyTotal = sumRemainingSheddableLoadKw({
      devices: legacyDevices,
      shedBehaviorForDevice: () => turnOffBehavior,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    // Producer-resolved path — populate residualKw with what the producer
    // would emit for a turn_off shed. The shape mirrors `toPlanDevice` in
    // `lib/app/appInit.ts`.
    const producerDevices = [
      { ...simpleOn, residualKw: { shed: 1.4 } },
      { ...steppedMax, residualKw: { shed: 2.9 } },
      // Already at lowest active + has binary control → producer says it can
      // still shed via the binary capability.
      { ...steppedAtLowestActive, residualKw: { shed: 1.2 } },
    ].map(toInputRemainingSheddableDevice);
    const producerTotal = sumRemainingSheddableLoadKw({
      devices: producerDevices,
      shedBehaviorForDevice: () => turnOffBehavior,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    expect(producerTotal).toBeCloseTo(legacyTotal, 6);
    expect(producerTotal).toBeGreaterThan(0);
  });
});
