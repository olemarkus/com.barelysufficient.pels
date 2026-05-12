import {
  resolveRemainingSheddableLoadKw,
  toPlanRemainingSheddableDevice,
  type RemainingShedBehavior,
} from '../lib/plan/planRemainingSheddableLoad';
import { buildPlanDevice } from './utils/planTestUtils';

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
