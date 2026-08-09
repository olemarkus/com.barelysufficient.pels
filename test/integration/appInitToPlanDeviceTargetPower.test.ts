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
});
