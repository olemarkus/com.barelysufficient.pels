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
      currentState: 'on',
      plannedState: 'keep',
      currentTarget,
      plannedTarget: 20,
      reason,
      controllable: true,
      ...deviceOverrides,
    },
  ],
});

describe('PlanService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-07T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes detail-only snapshot changes immediately', async () => {
    const settingsSet = jest.fn();
    const realtime = jest.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: jest
        .fn()
        .mockResolvedValueOnce(buildPlan(19, 'stable'))
        .mockResolvedValueOnce(buildPlan(21, 'sensor_update')),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions: jest.fn().mockResolvedValue(undefined),
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
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
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
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

  it('writes a fresh snapshot when priority changes without action changes', async () => {
    const settingsSet = jest.fn();
    const realtime = jest.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: jest
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { priority: 10 }))
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { priority: 1 })),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions: jest.fn().mockResolvedValue(undefined),
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
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
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
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

  it('flushes throttled meta-only snapshot without requiring another rebuild', async () => {
    const settingsSet = jest.fn();
    const realtime = jest.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: jest
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.0 }))
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.2 })),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions: jest.fn().mockResolvedValue(undefined),
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
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
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
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

    jest.advanceTimersByTime(DETAIL_SNAPSHOT_WRITE_THROTTLE_MS);

    const snapshotWritesAfterFlush = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot')
      .map((call: unknown[]) => call[1] as DevicePlan);
    expect(snapshotWritesAfterFlush).toHaveLength(2);
    expect(snapshotWritesAfterFlush[1].meta.totalKw).toBe(1.2);

    const realtimeAfterFlush = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(realtimeAfterFlush).toHaveLength(2);
  });

  it('clears pending throttled snapshot timer on destroy', async () => {
    const settingsSet = jest.fn();
    const planEngine = {
      buildDevicePlanSnapshot: jest
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.0 }))
        .mockResolvedValueOnce(buildPlan(20, 'stable', { totalKw: 1.2 })),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions: jest.fn().mockResolvedValue(undefined),
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime: jest.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    const snapshotWritesAfterThrottle = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot');
    expect(snapshotWritesAfterThrottle).toHaveLength(1);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    service.destroy();
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(DETAIL_SNAPSHOT_WRITE_THROTTLE_MS);
    const snapshotWritesAfterDestroy = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === 'device_plan_snapshot');
    expect(snapshotWritesAfterDestroy).toHaveLength(1);
  });

  it('still runs applyPlanActions on identical rebuilds', async () => {
    const settingsSet = jest.fn();
    const applyPlanActions = jest.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: jest
        .fn()
        .mockResolvedValue(buildPlan(20, 'stable')),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions,
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime: jest.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
    });

    await service.rebuildPlanFromCache('test_identical.first');
    await service.rebuildPlanFromCache('test_identical.second');

    expect(applyPlanActions).toHaveBeenCalledTimes(2);
  });

  it('reuses cached pels status computation when inputs are unchanged', () => {
    const buildPelsStatusSpy = jest.spyOn(pelsStatusModule, 'buildPelsStatus');
    const planService = new PlanService({
      homey: {
        settings: { set: jest.fn() },
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
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
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
    const settingsSet = jest.fn(() => {
      jest.advanceTimersByTime(7);
    });
    const realtime = jest.fn().mockResolvedValue(undefined);
    const planEngine = {
      buildDevicePlanSnapshot: jest.fn().mockImplementation(async () => {
        jest.advanceTimersByTime(11);
        return buildPlan(20, 'stable');
      }),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions: jest.fn().mockImplementation(async () => {
        jest.advanceTimersByTime(13);
      }),
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
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
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
    });

    await service.rebuildPlanFromCache('test_reason.phase_trace');

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'test_reason.phase_trace',
      queueDepth: 1,
      actionChanged: true,
      appliedActions: true,
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
    const error = jest.fn();
    const settingsSet = jest.fn();
    const planEngine = {
      buildDevicePlanSnapshot: jest.fn().mockImplementation(async () => {
        jest.advanceTimersByTime(17);
        throw new Error('plan exploded');
      }),
      computeDynamicSoftLimit: jest.fn(() => 0),
      computeShortfallThreshold: jest.fn(() => 0),
      handleShortfall: jest.fn().mockResolvedValue(undefined),
      handleShortfallCleared: jest.fn().mockResolvedValue(undefined),
      applyPlanActions: jest.fn().mockResolvedValue(undefined),
      applySheddingToDevice: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime: jest.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      log: jest.fn(),
      logDebug: jest.fn(),
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
});
