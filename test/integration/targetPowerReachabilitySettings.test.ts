import { buildTargetPowerReachabilityState } from '../../lib/device/targetPowerReachability';
import { DEVICE_TARGET_POWER_REACHABILITY } from '../../lib/utils/settingsKeys';
import { writeTargetPowerReachabilitySetting } from '../../setup/targetPowerReachabilitySettings';
import type { DeviceTargetPowerConfigs } from '../../packages/contracts/src/types';
import { createTargetPowerReachabilityAppWiring } from '../../setup/appTargetPowerReachabilityWiring';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { AppContext } from '../../lib/app/appContext';

const baseConfigs: DeviceTargetPowerConfigs = {
  charger: {
    enabled: true,
    preset: 'ev_charger_1_phase',
    max: 7360,
  },
  heater: {
    enabled: true,
    min: 0,
    max: 3000,
    step: 500,
  },
};

describe('targetPowerReachabilitySettings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fresh-reads and merges the runtime-owned reachability map', () => {
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 900_000,
    });
    expect(reachability).toBeDefined();
    const fresh = { otherCharger: reachability! };
    const settings = {
      get: vi.fn(() => fresh),
      set: vi.fn(),
    } as unknown as Parameters<typeof writeTargetPowerReachabilitySetting>[0]['settings'];
    expect(writeTargetPowerReachabilitySetting({
      settings,
      config: baseConfigs.charger,
      deviceId: 'charger',
      reachability: reachability!,
    })).toBe('persisted');

    expect(settings.set).toHaveBeenCalledWith(DEVICE_TARGET_POWER_REACHABILITY, {
      ...fresh,
      charger: reachability,
    });
  });

  it('abandons a stale learned write when a concurrent user edit changed the candidate profile', () => {
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5750,
    });
    const settings = {
      get: vi.fn(() => ({})),
      set: vi.fn(),
    } as unknown as Parameters<typeof writeTargetPowerReachabilitySetting>[0]['settings'];

    expect(writeTargetPowerReachabilitySetting({
      settings,
      config: { ...baseConfigs.charger, max: 5750 },
      deviceId: 'charger',
      reachability: reachability!,
    })).toBe('unavailable');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('abandons the write when a listed setting transiently reads empty', () => {
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5_750,
    });
    const settings = {
      get: vi.fn(() => null),
      getKeys: vi.fn(() => [DEVICE_TARGET_POWER_REACHABILITY]),
      set: vi.fn(),
    } as unknown as Parameters<typeof writeTargetPowerReachabilitySetting>[0]['settings'];

    expect(writeTargetPowerReachabilitySetting({
      settings,
      config: baseConfigs.charger,
      deviceId: 'charger',
      reachability: reachability!,
    })).toBe('unavailable');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('abandons the write when the fresh settings read throws', () => {
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5_750,
    });
    const settings = {
      get: vi.fn(() => { throw new Error('temporary read failure'); }),
      getKeys: vi.fn(() => ['another_key']),
      set: vi.fn(),
    } as unknown as Parameters<typeof writeTargetPowerReachabilitySetting>[0]['settings'];

    expect(writeTargetPowerReachabilitySetting({
      settings,
      config: baseConfigs.charger,
      deviceId: 'charger',
      reachability: reachability!,
    })).toBe('unavailable');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('abandons the whole-map write when a sibling entry is malformed', () => {
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5_750,
    });
    const settings = {
      get: vi.fn(() => ({ otherCharger: { maxReachedPowerW: 'new-schema' } })),
      set: vi.fn(),
    } as unknown as Parameters<typeof writeTargetPowerReachabilitySetting>[0]['settings'];

    expect(writeTargetPowerReachabilitySetting({
      settings,
      config: baseConfigs.charger,
      deviceId: 'charger',
      reachability: reachability!,
    })).toBe('unavailable');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('applies learned reachability immediately and retries unavailable persistence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let settingsAvailable = false;
    const settings = {
      get: vi.fn(() => (settingsAvailable ? {} : null)),
      getKeys: vi.fn(() => [DEVICE_TARGET_POWER_REACHABILITY]),
      set: vi.fn(),
    } as unknown as AppContext['homey']['settings'];
    const scheduleTargetPowerProbe = vi.fn();
    const timers = new TimerRegistry();
    const ctx = {
      homey: { settings },
      deviceTargetPowerConfigs: { ...baseConfigs },
      timers,
      snapshotHelpers: {
        scheduleTargetPowerProbe,
      },
      deviceControlHelpers: {
        reconcileTargetPowerReachability: vi.fn(),
        hasPendingTargetPowerProbe: vi.fn(() => false),
      },
      getStructuredLogger: vi.fn(() => undefined),
    } as unknown as AppContext;
    const rebuildOwningHomePlanForDevice = vi.fn().mockResolvedValue(undefined);
    const wiring = createTargetPowerReachabilityAppWiring(ctx, rebuildOwningHomePlanForDevice);
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 901_000,
    });

    expect(wiring.deviceControlDeps.updateTargetPowerReachability('charger', reachability!))
      .toBe(true);
    expect(ctx.deviceTargetPowerConfigs.charger.reachability).toEqual(reachability);
    expect(scheduleTargetPowerProbe).toHaveBeenCalledTimes(1);
    expect(rebuildOwningHomePlanForDevice).toHaveBeenCalledWith(
      'charger',
      'target_power_reachability_updated',
    );
    expect(settings.set).not.toHaveBeenCalled();

    settingsAvailable = true;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settings.set).toHaveBeenCalledWith(DEVICE_TARGET_POWER_REACHABILITY, {
      charger: reachability,
    });
    timers.clearAll();
  });

  it('schedules retries only for present managed devices', () => {
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfigs.charger,
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 901_000,
    });
    let snapshots: Array<{ id: string }> = [];
    let managed = true;
    const ctx = {
      deviceTargetPowerConfigs: {
        charger: { ...baseConfigs.charger, reachability },
      },
      deviceManager: { getSnapshot: () => snapshots },
      resolveManagedState: () => managed,
      isCapacityControlEnabled: () => true,
      timers: new TimerRegistry(),
      snapshotHelpers: { scheduleTargetPowerProbe: vi.fn() },
      deviceControlHelpers: {
        reconcileTargetPowerReachability: vi.fn(),
        hasPendingTargetPowerProbe: vi.fn(() => false),
      },
    } as unknown as AppContext;
    const wiring = createTargetPowerReachabilityAppWiring(ctx, vi.fn().mockResolvedValue(undefined));

    expect(wiring.snapshotDeps.getNextTargetPowerProbe()).toBeUndefined();
    snapshots = [{ id: 'charger' }];
    expect(wiring.snapshotDeps.getNextTargetPowerProbe()).toEqual({
      deviceId: 'charger',
      dueAtMs: 901_000,
    });
    managed = false;
    expect(wiring.snapshotDeps.getNextTargetPowerProbe()).toBeUndefined();
  });
});
