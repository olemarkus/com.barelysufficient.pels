import { PlanService } from '../lib/plan/planService';
import type { DevicePlan } from '../lib/plan/planTypes';
import * as pelsStatusModule from '../lib/core/pelsStatus';
import { getRecentPlanRebuildTraces } from '../lib/utils/planRebuildTrace';
import { getPerfSnapshot } from '../lib/utils/perfCounters';
import { DETAIL_SNAPSHOT_WRITE_THROTTLE_MS } from '../lib/utils/timingConstants';

const buildPlan = (
  currentTarget: number,
  reason: string,
  metaOverrides: Partial<DevicePlan['meta']> = {},
  deviceOverrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan => ({
  meta: {
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4,
    ...metaOverrides,
  },
  devices: [
    {
      id: 'dev-1',
      name: 'Heater',
      currentOn: true,
      currentState: 'on',
      plannedState: 'keep',
      currentTarget,
      plannedTarget: 20,
      reason,
      controllable: true,
      controlCapabilityId: 'onoff',
      ...deviceOverrides,
    },
  ],
});

const createPlanService = (overrides: Partial<ConstructorParameters<typeof PlanService>[0]> = {}) => {
  const deps = {
    homey: {
      settings: { set: vi.fn() },
      api: { realtime: vi.fn().mockResolvedValue(undefined) },
      flow: {},
    } as any,
    planEngine: {
      buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable')),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    } as any,
    getPlanDevices: () => [],
    getCapacityDryRun: () => false,
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getCombinedPrices: () => null,
    getLastPowerUpdate: () => null,
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };

  return { service: new PlanService(deps as ConstructorParameters<typeof PlanService>[0]), deps };
};

describe('PlanService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-07T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes detail-only snapshot changes immediately', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(19, 'stable'))
        .mockResolvedValueOnce(buildPlan(21, 'sensor_update')),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    const snapshotWrites = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot')
      .map((call: unknown[]) => call[1] as DevicePlan);
    expect(snapshotWrites).toHaveLength(2);
    expect(snapshotWrites[0].devices[0].currentTarget).toBe(19);
    expect(snapshotWrites[1].devices[0].currentTarget).toBe(21);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
  });

  it('emits grouped structured plan debug summaries only when the summary changes', async () => {
    const summaryPlan: DevicePlan = {
      meta: {
        totalKw: 3.97,
        softLimitKw: 3.0,
        capacitySoftLimitKw: 4.0,
        dailySoftLimitKw: 3.0,
        softLimitSource: 'daily',
        headroomKw: -0.97,
      },
      devices: [
        {
          id: 'dev-1',
          name: 'Heater 1',
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: 'insufficient headroom (need 0.98kW, headroom -0.97kW)',
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: 'insufficient headroom (need 1.10kW, headroom -0.97kW)',
        },
        {
          id: 'ev-1',
          name: 'EV',
          currentOn: false,
          currentState: 'off',
          plannedState: 'inactive',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: 'inactive (charger is unplugged)',
        },
      ],
    };
    const debugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: {
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(summaryPlan)
          .mockResolvedValueOnce(summaryPlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      debugStructured,
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(debugStructured).toHaveBeenCalledTimes(1);
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'plan_debug_summary',
      totalKw: 3.97,
      softLimitKw: 3,
      capacitySoftLimitKw: 4,
      dailySoftLimitKw: 3,
      softLimitSource: 'daily',
      headroomKw: -0.97,
      restoreBlockedCount: 2,
      restoreBlockedReasons: [{ reason: 'insufficient headroom', count: 2 }],
      inactiveCount: 1,
      inactiveReasons: [{ reason: 'charger is unplugged', count: 1 }],
    });
  });

  it('writes a fresh snapshot when priority changes without action changes', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { priority: 10 }))
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { priority: 1 })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    const snapshotWrites = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot')
      .map((call: unknown[]) => call[1] as DevicePlan);
    expect(snapshotWrites).toHaveLength(2);
    expect(snapshotWrites[0].devices[0].priority).toBe(10);
    expect(snapshotWrites[1].devices[0].priority).toBe(1);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
  });

  it('normalizes plan_updated emission failures before logging', async () => {
    const realtime = vi.fn().mockRejectedValue('boom');
    const error = vi.fn();
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(19, 'stable')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error,
    });

    await service.rebuildPlanFromCache();
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith('Failed to emit plan_updated event', expect.any(Error));
    expect((error.mock.calls[0]?.[1] as Error).message).toBe('boom');
  });

  it('flushes throttled meta-only snapshot without requiring another rebuild', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.0 }))
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.2 })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(undefined),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    const snapshotWritesAfterThrottle = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot')
      .map((call: unknown[]) => call[1] as DevicePlan);
    expect(snapshotWritesAfterThrottle).toHaveLength(1);
    expect(snapshotWritesAfterThrottle[0].meta.totalKw).toBe(1.0);

    const realtimeAfterThrottle = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(realtimeAfterThrottle).toHaveLength(2);

    vi.advanceTimersByTime(DETAIL_SNAPSHOT_WRITE_THROTTLE_MS);

    const snapshotWritesAfterFlush = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot')
      .map((call: unknown[]) => call[1] as DevicePlan);
    expect(snapshotWritesAfterFlush).toHaveLength(2);
    expect(snapshotWritesAfterFlush[1].meta.totalKw).toBe(1.2);

    const realtimeAfterFlush = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(realtimeAfterFlush).toHaveLength(2);
  });

  it('keeps the latest in-memory plan snapshot fresh while snapshot writes are throttled', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.0 }))
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.2 })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(undefined),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    const snapshotWrites = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot')
      .map((call: unknown[]) => call[1] as DevicePlan);
    expect(snapshotWrites).toHaveLength(1);
    expect(snapshotWrites[0].meta.totalKw).toBe(1.0);
    expect(service.getLatestPlanSnapshot()?.meta.totalKw).toBe(1.2);
  });

  it('reapplies the current plan when the live onoff state drifts', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const realtime = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }), 'reconcile');
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).not.toHaveBeenCalled();
  });

  it('reapplies the current plan when the live target drifts', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const realtime = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 17, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: true,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 17,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }), 'reconcile');
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).not.toHaveBeenCalled();
  });

  it('keeps the observed target stale while exposing pending confirmation state', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const decoratePlanWithPendingTargetCommands = vi.fn((plan: DevicePlan) => ({
      ...plan,
      devices: plan.devices.map((device) => ({
        ...device,
        pendingTargetCommand: {
          desired: 20,
          retryCount: 0,
          nextRetryAtMs: Date.now() + 30_000,
          status: 'waiting_confirmation',
          lastObservedValue: 18,
          lastObservedSource: 'snapshot_refresh' as const,
        },
      })),
    }));

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        hasPendingTargetCommands: vi.fn(() => true),
        syncPendingTargetCommands: vi.fn(() => true),
        decoratePlanWithPendingTargetCommands,
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: true,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(18, 'stable');

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentTarget: 18,
          plannedTarget: 20,
          pendingTargetCommand: expect.objectContaining({
            desired: 20,
            retryCount: 0,
            lastObservedValue: 18,
            lastObservedSource: 'snapshot_refresh',
          }),
        }),
      ],
    }));
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentTarget: 18,
        }),
      ],
    }));
  });

  it('refreshes the stored current target when a pending target command is confirmed', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    let hasPendingTargetCommands = true;
    const decoratePlanWithPendingTargetCommands = vi.fn((plan: DevicePlan) => ({
      ...plan,
      devices: plan.devices.map((device) => ({
        ...device,
        pendingTargetCommand: hasPendingTargetCommands
          ? {
            desired: 20,
            retryCount: 0,
            nextRetryAtMs: Date.now() + 30_000,
            status: 'waiting_confirmation',
            lastObservedValue: 18,
            lastObservedSource: 'rebuild' as const,
          }
          : undefined,
      })),
    }));

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        hasPendingTargetCommands: vi.fn(() => hasPendingTargetCommands),
        syncPendingTargetCommands: vi.fn(() => {
          hasPendingTargetCommands = false;
          return true;
        }),
        decoratePlanWithPendingTargetCommands,
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: true,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = decoratePlanWithPendingTargetCommands(buildPlan(18, 'stable'));

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);
    expect(service.getLatestPlanSnapshot()?.devices[0]).toMatchObject({
      id: 'dev-1',
      currentTarget: 20,
      plannedTarget: 20,
    });
    expect(service.getLatestPlanSnapshot()?.devices[0].pendingTargetCommand).toBeUndefined();
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentTarget: 20,
        }),
      ],
    }));
  });

  it('skips plan reconcile for power-only drift', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: true,
        currentTemperature: 21,
        powerKw: 2,
        expectedPowerKw: 2,
        measuredPowerKw: 2,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
      powerKw: 1,
      expectedPowerKw: 1,
      measuredPowerKw: 1,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(false);
    expect(applyPlanActions).not.toHaveBeenCalled();
  });

  it('skips plan reconcile for target-only drift while a shed device is already off', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 23.5, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(21, 'shed', {}, {
      currentState: 'off',
      plannedState: 'shed',
      currentTarget: 21,
      plannedTarget: 21,
      shedAction: 'turn_off',
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(false);
    expect(applyPlanActions).not.toHaveBeenCalled();
  });

  it('reapplies shed-off intent when live binary state is still on', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: true,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(21, 'shed', {}, {
      currentState: 'on',
      plannedState: 'shed',
      currentTarget: 21,
      plannedTarget: 21,
      shedAction: 'turn_off',
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          plannedState: 'shed',
          shedAction: 'turn_off',
        }),
      ],
    }), 'reconcile');
  });

  it('refreshes the stored plan snapshot when a pending binary command is confirmed by live state', async () => {
    let hasPendingBinaryCommands = true;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        hasPendingBinaryCommands: vi.fn(() => hasPendingBinaryCommands),
        syncPendingBinaryCommands: vi.fn(() => {
          hasPendingBinaryCommands = false;
          return true;
        }),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'cooldown', {}, {
      currentState: 'on',
      plannedState: 'shed',
      currentTarget: 20,
      plannedTarget: 20,
    });

    await expect(service.syncLivePlanState('device_update')).resolves.toBe(true);
    expect(service.getLatestPlanSnapshot()?.devices[0]).toMatchObject({
      id: 'dev-1',
      currentState: 'off',
      plannedState: 'shed',
    });
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
        }),
      ],
    }));
  });

  it('does not replace the stored plan snapshot with drifted live state before reconcile actuation completes', async () => {
    let resolveApply: (() => void) | undefined;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveApply = resolve;
      }),
    );
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
    });

    const reconcilePromise = service.reconcileLatestPlanState();
    await Promise.resolve();

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).not.toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
        }),
      ],
    }));

    resolveApply?.();
    await expect(reconcilePromise).resolves.toBe(true);
  });

  it('reapplies the current plan when reconcile runs from a stale keep/off snapshot', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'off',
      plannedState: 'keep',
      currentTarget: 20,
      plannedTarget: 20,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          plannedState: 'keep',
        }),
      ],
    }), 'reconcile');
  });

  it('does not refresh the stored plan snapshot from stale live state immediately after reconcile actuation', async () => {
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);

    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }), 'reconcile');
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).not.toHaveBeenCalled();
  });

  it('does not refresh the stored plan snapshot from partially updated live state immediately after rebuild actuation', async () => {
    let liveCurrentOnById: Record<string, boolean> = {
      'dev-1': false,
      'dev-2': false,
    };
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      liveCurrentOnById = {
        'dev-1': true,
        'dev-2': false,
      };
    });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
          meta: {
            totalKw: 1,
            softLimitKw: 5,
            headroomKw: 4,
          },
          devices: [
            {
              id: 'dev-1',
              name: 'Heater 1',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'stable',
              controllable: true,
            },
            {
              id: 'dev-2',
              name: 'Heater 2',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'stable',
              controllable: true,
            },
          ],
        }),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [
        {
          id: 'dev-1',
          name: 'Heater 1',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          hasBinaryControl: true,
          currentOn: liveCurrentOnById['dev-1'],
          currentTemperature: 21,
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          hasBinaryControl: true,
          currentOn: liveCurrentOnById['dev-2'],
          currentTemperature: 21,
        },
      ],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
        }),
      ],
    }));
  });

  it('refreshes the stored plan snapshot after rebuild actuation once all live state has settled', async () => {
    let currentOn = false;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      currentOn = true;
    });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable', {}, {
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
        }),
      ],
    }));
  });

  it('refreshes the stored plan snapshot when settled actuation leaves an uncontrollable keep-device off', async () => {
    let liveCurrentOnById: Record<string, boolean> = {
      'dev-1': false,
      'dev-2': false,
    };
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      liveCurrentOnById = {
        'dev-1': true,
        'dev-2': false,
      };
    });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
          meta: {
            totalKw: 1,
            softLimitKw: 5,
            headroomKw: 4,
          },
          devices: [
            {
              id: 'dev-1',
              name: 'Heater 1',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'stable',
              controllable: true,
            },
            {
              id: 'dev-2',
              name: 'Heater 2',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'stable',
              controllable: false,
            },
          ],
        }),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [
        {
          id: 'dev-1',
          name: 'Heater 1',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          hasBinaryControl: true,
          currentOn: liveCurrentOnById['dev-1'],
          currentTemperature: 21,
          controllable: true,
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          hasBinaryControl: true,
          currentOn: liveCurrentOnById['dev-2'],
          currentTemperature: 21,
          controllable: false,
        },
      ],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
        }),
      ],
    }));
  });

  it('refreshes the stored plan snapshot when settled actuation leaves an unavailable keep-device off', async () => {
    let liveCurrentOnById: Record<string, boolean> = {
      'dev-1': false,
      'dev-2': false,
    };
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      liveCurrentOnById = {
        'dev-1': true,
        'dev-2': false,
      };
    });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
          meta: {
            totalKw: 1,
            softLimitKw: 5,
            headroomKw: 4,
          },
          devices: [
            {
              id: 'dev-1',
              name: 'Heater 1',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'stable',
              controllable: true,
              available: true,
            },
            {
              id: 'dev-2',
              name: 'Heater 2',
              currentState: 'off',
              plannedState: 'keep',
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'stable',
              controllable: true,
              available: false,
            },
          ],
        }),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [
        {
          id: 'dev-1',
          name: 'Heater 1',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          hasBinaryControl: true,
          currentOn: liveCurrentOnById['dev-1'],
          currentTemperature: 21,
          controllable: true,
          available: true,
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          hasBinaryControl: true,
          currentOn: liveCurrentOnById['dev-2'],
          currentTemperature: 21,
          controllable: true,
          available: false,
        },
      ],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
          available: false,
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
          available: false,
        }),
      ],
    }));
  });

  it('refreshes the stored plan snapshot after a settled shed-off even if the target remains unchanged', async () => {
    let currentOn = true;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      currentOn = false;
    });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(21, 'stable', {}, {
          currentState: 'on',
          currentTarget: 21,
          plannedState: 'shed',
          plannedTarget: 18,
          shedAction: 'turn_off',
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          currentTarget: 21,
          plannedState: 'shed',
          plannedTarget: 18,
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          currentTarget: 21,
        }),
      ],
    }));
  });
  it('refreshes the live plan snapshot after reconcile re-applies a restore', async () => {
    let currentOn = false;
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      currentOn = true;
    });
    const realtime = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);

    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }), 'reconcile');
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).not.toHaveBeenCalled();
  });

  it('queues reconcile behind an in-flight rebuild and avoids double actuation once the rebuild fixes drift', async () => {
    let currentOn = false;
    let resolveApply: (() => void) | undefined;
    const applyPlanActions = vi.fn().mockImplementation(async () => new Promise<void>((resolve) => {
      resolveApply = () => {
        currentOn = true;
        resolve();
      };
    }));
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable', {}, {
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 20,
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    const rebuildPromise = service.rebuildPlanFromCache('serialize_rebuild');
    await Promise.resolve();
    await Promise.resolve();

    const reconcilePromise = service.reconcileLatestPlanState();
    await Promise.resolve();
    await Promise.resolve();

    expect(applyPlanActions).toHaveBeenCalledTimes(1);

    resolveApply?.();
    await rebuildPromise;
    await expect(reconcilePromise).resolves.toBe(false);
    expect(applyPlanActions).toHaveBeenCalledTimes(1);
  });

  it('queues external shedding behind an in-flight rebuild', async () => {
    let resolveApply: (() => void) | undefined;
    const applyPlanActions = vi.fn().mockImplementation(async () => new Promise<void>((resolve) => {
      resolveApply = resolve;
    }));
    const applySheddingToDevice = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice,
      } as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    const rebuildPromise = service.rebuildPlanFromCache('serialize_rebuild');
    await Promise.resolve();
    await Promise.resolve();

    const shedPromise = service.applySheddingToDevice('dev-1', 'Heater', 'overshoot');
    await Promise.resolve();
    await Promise.resolve();

    expect(applyPlanActions).toHaveBeenCalledTimes(1);
    expect(applySheddingToDevice).not.toHaveBeenCalled();

    resolveApply?.();
    await rebuildPromise;
    await shedPromise;

    expect(applySheddingToDevice).toHaveBeenCalledTimes(1);
    expect(applyPlanActions.mock.invocationCallOrder[0]).toBeLessThan(
      applySheddingToDevice.mock.invocationCallOrder[0],
    );
  });

  it('queues external live plan sync behind an in-flight rebuild', async () => {
    let resolveBuild: (() => void) | undefined;
    const syncPendingTargetCommands = vi.fn(() => true);
    const planEngine = {
      buildDevicePlanSnapshot: vi.fn().mockImplementation(
        async () => new Promise<DevicePlan>((resolve) => {
          resolveBuild = () => resolve(buildPlan(20, 'stable'));
        }),
      ),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(undefined),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      hasPendingTargetCommands: vi.fn(() => true),
      syncPendingTargetCommands,
      decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
    };
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: true,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    const rebuildPromise = service.rebuildPlanFromCache('serialize_rebuild');
    await Promise.resolve();
    await Promise.resolve();

    const syncPromise = service.syncLivePlanState('snapshot_refresh');
    await Promise.resolve();
    await Promise.resolve();

    expect(syncPendingTargetCommands.mock.calls.map(([, source]) => source)).not.toContain('snapshot_refresh');

    resolveBuild?.();
    await rebuildPromise;
    await expect(syncPromise).resolves.toBe(false);
    expect(syncPendingTargetCommands).toHaveBeenCalledWith(expect.any(Array), 'snapshot_refresh');
  });

  it('captures live devices once per rebuild before syncing and building the plan', async () => {
    const firstLiveDevices = [{
      id: 'dev-1',
      name: 'Heater',
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature',
      hasBinaryControl: true,
      currentOn: true,
      currentTemperature: 21,
    }];
    const getPlanDevices = vi.fn()
      .mockReturnValueOnce(firstLiveDevices)
      .mockReturnValueOnce([{
        ...firstLiveDevices[0],
        targets: [{ id: 'target_temperature', value: 26, unit: '°C' }],
      }]);
    const syncPendingTargetCommands = vi.fn(() => false);
    const syncPendingBinaryCommands = vi.fn(() => false);
    const buildDevicePlanSnapshot = vi.fn().mockResolvedValue(buildPlan(20, 'stable'));
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot,
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        syncPendingTargetCommands,
        syncPendingBinaryCommands,
        prunePendingTargetCommands: vi.fn(() => false),
        decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
      } as any,
      getPlanDevices,
      getCapacityDryRun: () => true,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache('capture_live_devices_once');

    expect(getPlanDevices).toHaveBeenCalledTimes(1);
    expect(syncPendingTargetCommands).toHaveBeenCalledWith(firstLiveDevices, 'rebuild');
    expect(syncPendingBinaryCommands).toHaveBeenCalledWith(firstLiveDevices, 'rebuild');
    expect(buildDevicePlanSnapshot).toHaveBeenCalledWith(firstLiveDevices);
  });

  it('clears pending throttled snapshot timer on destroy', async () => {
    const settingsSet = vi.fn();
    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.0 }))
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.2 })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(undefined),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    const snapshotWritesAfterThrottle = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot');
    expect(snapshotWritesAfterThrottle).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    service.destroy();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(DETAIL_SNAPSHOT_WRITE_THROTTLE_MS);
    const snapshotWritesAfterDestroy = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot');
    expect(snapshotWritesAfterDestroy).toHaveLength(1);
  });

  it('skips applyPlanActions on identical rebuilds', async () => {
    const settingsSet = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValue(buildPlan(20, 'stable')),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache('test_identical.first');
    await service.rebuildPlanFromCache('test_identical.second');

    expect(applyPlanActions).toHaveBeenCalledTimes(1);
  });

  it('preserves reconcile drift across detail-only rebuilds', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const liveDeviceBase = {
      id: 'dev-1',
      name: 'Heater',
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature',
      hasBinaryControl: true,
      currentTemperature: 21,
    };
    let liveDevices = [{
      ...liveDeviceBase,
      currentOn: true,
    }];

    const planEngine = {
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'stable', {}, {
          currentState: 'on',
          plannedState: 'keep',
          plannedTarget: 20,
        }))
        .mockResolvedValueOnce(buildPlan(20, 'stable', {}, {
          currentState: 'off',
          plannedState: 'keep',
          plannedTarget: 20,
        })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => liveDevices,
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache('seed_expected_on_state');
    expect(applyPlanActions).toHaveBeenCalledTimes(1);
    applyPlanActions.mockClear();

    liveDevices = [{
      ...liveDeviceBase,
      currentOn: false,
    }];

    await service.rebuildPlanFromCache('detail_only_live_off');
    expect(applyPlanActions).not.toHaveBeenCalled();

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }), 'reconcile');
  });

  it('reuses cached pels status computation when inputs are unchanged', () => {
    const buildPelsStatusSpy = vi.spyOn(pelsStatusModule, 'buildPelsStatus');
    const planService = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: {},
        flow: {},
      } as any,
      planEngine: {} as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => true,
      isCurrentHourCheap: () => true,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => ({ prices: [{ total: 10 }] }),
      getLastPowerUpdate: () => 123456,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    const plan = {
      meta: { totalKw: null, softLimitKw: 0, headroomKw: null },
      devices: [],
    } as any;
    const changes = {
      actionChanged: false,
      actionSignature: 'a',
      detailSignature: 'd',
      metaSignature: 'm',
    };

    planService.updatePelsStatus(plan, changes);
    planService.updatePelsStatus(plan, changes);

    expect(buildPelsStatusSpy).toHaveBeenCalledTimes(1);
  });

  it('records recent rebuild phase timings with reason', async () => {
    const settingsSet = vi.fn(() => {
      vi.advanceTimersByTime(7);
    });
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(11);
        return buildPlan(20, 'stable');
      }),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(13);
        return { deviceWriteCount: 1 };
      }),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache('test_reason.phase_trace');

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'test_reason.phase_trace',
      queueDepth: 1,
      actionChanged: true,
      appliedActions: true,
      deviceWriteCount: 1,
    }));
    expect(trace.buildMs).toBeGreaterThanOrEqual(11);
    expect(trace.snapshotWriteMs).toBeGreaterThanOrEqual(7);
    expect(trace.statusWriteMs).toBeGreaterThanOrEqual(7);
    expect(trace.applyMs).toBeGreaterThanOrEqual(13);
    expect(trace.totalMs).toBeGreaterThanOrEqual(
      trace.buildMs + trace.snapshotWriteMs + trace.statusWriteMs + trace.applyMs,
    );
  });

  it('records failed rebuild attempts in perf counters and traces', async () => {
    const error = vi.fn();
    const settingsSet = vi.fn();
    const planEngine = {
      buildDevicePlanSnapshot: vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(17);
        throw new Error('plan exploded');
      }),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(undefined),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: vi.fn(),
      logDebug: vi.fn(),
      error,
    });

    const beforePerf = getPerfSnapshot();
    await service.rebuildPlanFromCache('test_reason.failed');
    const afterPerf = getPerfSnapshot();

    expect((afterPerf.counts.plan_rebuild_total || 0) - (beforePerf.counts.plan_rebuild_total || 0)).toBe(1);
    expect((afterPerf.counts.plan_rebuild_failed_total || 0) - (beforePerf.counts.plan_rebuild_failed_total || 0)).toBe(1);
    expect((afterPerf.durations.plan_rebuild_ms?.count || 0) - (beforePerf.durations.plan_rebuild_ms?.count || 0)).toBe(1);
    expect(error).toHaveBeenCalledWith('Failed to rebuild plan', expect.any(Error));

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'test_reason.failed',
      failed: true,
      queueDepth: 1,
    }));
    expect(trace.totalMs).toBeGreaterThanOrEqual(17);
  });

  it('suppresses structured rebuild logs for unchanged no-op rebuilds', async () => {
    const structuredLog = { info: vi.fn() };
    const { service } = createPlanService({
      structuredLog: structuredLog as any,
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();

    await service.rebuildPlanFromCache('power_delta');

    expect(structuredLog.info).not.toHaveBeenCalled();
  });

  it('emits structured rebuild logs for initial rebuild reasons even without action changes', async () => {
    const structuredLog = { info: vi.fn() };
    const { service } = createPlanService({
      structuredLog: structuredLog as any,
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();

    await service.rebuildPlanFromCache('initial');

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      reasonCode: 'initial',
      actionChanged: false,
      appliedActions: false,
      deviceWriteCount: 0,
      failed: false,
    }));
  });

  it('emits structured rebuild logs for slow rebuilds even without action changes', async () => {
    const structuredLog = { info: vi.fn() };
    const { service, deps } = createPlanService({
      structuredLog: structuredLog as any,
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();
    (deps.planEngine.buildDevicePlanSnapshot as vi.Mock).mockImplementation(async () => {
      vi.advanceTimersByTime(1501);
      return buildPlan(20, 'stable');
    });

    await service.rebuildPlanFromCache('power_delta');

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      reasonCode: 'power_delta',
      durationMs: expect.any(Number),
      actionChanged: false,
      appliedActions: false,
      deviceWriteCount: 0,
      failed: false,
    }));
    expect((structuredLog.info.mock.calls[0]?.[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(1500);
  });

  it('emits plan_rebuild_completed at debug level when actionChanged but no actions applied (dry-run)', async () => {
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      structuredLog: structuredLog as any,
      getCapacityDryRun: () => true,
    });

    // Seed
    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();
    structuredLog.debug.mockClear();

    // Return a plan with different plannedState to trigger actionChanged
    (deps.planEngine.buildDevicePlanSnapshot as vi.Mock).mockResolvedValueOnce(
      buildPlan(20, 'stable', {}, { plannedState: 'shed' }),
    );
    await service.rebuildPlanFromCache('power_delta');

    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
    }));
    expect(structuredLog.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      actionChanged: true,
      appliedActions: false,
      deviceWriteCount: 0,
    }));
  });

  it('emits plan_rebuild_completed with concrete deviceWriteCount when actuation wrote to devices', async () => {
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      structuredLog: structuredLog as any,
      planEngine: {
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(buildPlan(20, 'stable'))
          .mockResolvedValueOnce(buildPlan(20, 'stable', {}, { plannedState: 'shed' })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 2 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();
    structuredLog.debug.mockClear();

    await service.rebuildPlanFromCache('power_delta');

    expect((deps.planEngine.applyPlanActions as vi.Mock)).toHaveBeenCalled();
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      reasonCode: 'power_delta',
      actionChanged: true,
      appliedActions: true,
      deviceWriteCount: 2,
      failed: false,
    }));
  });

  it('normalizes non-finite actuation write counts to zero in rebuild logs and traces', async () => {
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      structuredLog: structuredLog as any,
      planEngine: {
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(buildPlan(20, 'stable'))
          .mockResolvedValueOnce(buildPlan(20, 'stable', {}, { plannedState: 'shed' })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: Number.NaN }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();
    structuredLog.debug.mockClear();

    await service.rebuildPlanFromCache('power_delta');

    expect((deps.planEngine.applyPlanActions as vi.Mock)).toHaveBeenCalled();
    expect(structuredLog.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      reasonCode: 'power_delta',
      appliedActions: false,
      deviceWriteCount: 0,
    }));

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'power_delta',
      appliedActions: false,
      deviceWriteCount: 0,
    }));
  });

  it('emits structured rebuild logs for failed rebuilds', async () => {
    const structuredLog = { info: vi.fn() };
    const { service, deps } = createPlanService({
      structuredLog: structuredLog as any,
    });
    (deps.planEngine.buildDevicePlanSnapshot as vi.Mock).mockImplementation(async () => {
      vi.advanceTimersByTime(17);
      throw new Error('plan exploded');
    });

    await service.rebuildPlanFromCache('power_delta');

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      reasonCode: 'power_delta',
      failed: true,
    }));
  });

  it('calls schedulePostActuationRefresh after rebuild actuation', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue({ deviceWriteCount: 1 });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable', {}, {
          currentState: 'off',
          plannedState: 'keep',
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call schedulePostActuationRefresh after rebuild actuation when no writes occur', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue({ deviceWriteCount: 0 });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable', {}, {
          currentState: 'off',
          plannedState: 'keep',
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(false),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });

  it('does not call schedulePostActuationRefresh when stepped-load flow actuation is the only rebuild actuation', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const steppedPlan = buildPlan(20, 'stable', {}, {
      currentState: 'off',
      plannedState: 'keep',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'off',
      desiredStepId: 'low',
      currentOn: true,
    });
    const applyPlanActions = vi.fn().mockResolvedValue({ deviceWriteCount: 0 });
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(steppedPlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(false),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Tank',
        targets: [],
        deviceType: 'onoff',
        controlModel: 'stepped_load',
        controlCapabilityId: 'onoff',
        steppedLoadProfile: steppedPlan.devices[0].steppedLoadProfile,
        hasBinaryControl: true,
        currentOn: true,
        selectedStepId: 'off',
        desiredStepId: 'low',
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.rebuildPlanFromCache();

    expect(applyPlanActions).toHaveBeenCalledWith(steppedPlan, 'plan');
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });

  it('calls schedulePostActuationRefresh after reconcile actuation', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        hasBinaryControl: true,
        currentOn: false,
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      plannedTarget: 20,
    });

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
  });

  it('calls schedulePostActuationRefresh after direct shedding actuation', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applySheddingToDevice = vi.fn().mockResolvedValue(true);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice,
      } as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.applySheddingToDevice('dev-1', 'Heater');

    expect(applySheddingToDevice).toHaveBeenCalledWith('dev-1', 'Heater', undefined);
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call schedulePostActuationRefresh after direct shedding when no write occurs', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applySheddingToDevice = vi.fn().mockResolvedValue(false);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice,
      } as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    await service.applySheddingToDevice('dev-1', 'Heater');

    expect(applySheddingToDevice).toHaveBeenCalledWith('dev-1', 'Heater', undefined);
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });
});
