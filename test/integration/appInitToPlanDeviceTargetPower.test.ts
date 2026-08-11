import { toPlanDevice } from '../../setup/appInit';
import {
  buildTargetPowerReachabilityState,
  resolveEvTargetPowerConfirmedProfile,
} from '../../lib/device/targetPowerReachability';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';

describe('toPlanDevice target-power reachability boundary', () => {
  it('keeps the planner ladder capped until the runtime retry becomes due', () => {
    const baseConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase' as const,
      max: 7_360,
    };
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfig,
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 2_000,
    });
    const runtimeConfig = { ...baseConfig, reachability };
    const device: DecoratedDeviceSnapshot = {
      id: 'charger',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      name: 'Charger',
      targets: [],
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(runtimeConfig),
      targetPowerConfig: baseConfig,
      binaryControl: { on: true },
    };
    const ctx = createAppContextMock({
      deviceTargetPowerConfigs: { charger: runtimeConfig },
      getNow: () => new Date(1_999),
    });

    const beforeDue = toPlanDevice(ctx, device);
    expect(isSteppedLoadDevice(beforeDue)).toBe(true);
    if (!isSteppedLoadDevice(beforeDue)) throw new Error('expected stepped plan device');
    expect(beforeDue.steppedLoadProfile?.steps.at(-1)?.id).toBe('25a');
    expect(beforeDue.targetPowerConfig).toEqual(baseConfig);

    ctx.getNow = () => new Date(2_000);
    const whenDue = toPlanDevice(ctx, device);
    expect(isSteppedLoadDevice(whenDue)).toBe(true);
    if (!isSteppedLoadDevice(whenDue)) throw new Error('expected stepped plan device');
    expect(whenDue.steppedLoadProfile?.steps.at(-1)?.id).toBe('28a');
    expect(whenDue.targetPowerConfig).toEqual(baseConfig);
  });

  // `planningPowerKw` is REQUIRED on the stepped variant, so this boundary must
  // not forward a non-finite value into `lib/plan` — `??` would, since it only
  // gates on null/undefined. `planningPowerW` comes from persisted settings and
  // the carried value from the decoration layer, so either can be junk, and a
  // NaN kW poisons every sum it reaches (reserve, headroom, restore sizing)
  // silently. Each rung is gated separately so junk falls THROUGH rather than
  // dropping a device out of stepped control that a lower rung could price.
  it('falls through a non-finite carried planning power to the ladder rung', () => {
    const config = { enabled: true, preset: 'ev_charger_1_phase' as const, max: 7_360 };
    const device: DecoratedDeviceSnapshot = {
      id: 'charger',
      expectedPowerKw: 1,
      expectedPowerSource: 'default',
      name: 'Charger',
      targets: [],
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config),
      targetPowerConfig: config,
      binaryControl: { on: true },
      // No `selectedStepId`, so the first rung finds nothing and the carried
      // value is consulted next — as junk.
      planningPowerKw: Number.NaN,
    };
    const ctx = createAppContextMock({ deviceTargetPowerConfigs: { charger: config } });

    const planDevice = toPlanDevice(ctx, device);

    expect(isSteppedLoadDevice(planDevice)).toBe(true);
    if (!isSteppedLoadDevice(planDevice)) throw new Error('expected stepped plan device');
    expect(Number.isFinite(planDevice.planningPowerKw)).toBe(true);
    expect(planDevice.planningPowerKw).toBeGreaterThan(0);
  });
});
