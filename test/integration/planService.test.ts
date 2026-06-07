import { PlanService } from '../../lib/plan/planService';
import { buildExecutablePlan } from '../../lib/executor/executablePlanProjection';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import type { BinaryControlObservation } from '../../packages/contracts/src/types';
import * as pelsStatusModule from '../../lib/plan/pelsStatus';
import { getRecentPlanRebuildTraces } from '../../lib/utils/planRebuildTrace';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';
import { formatDeviceOverview } from '../../packages/shared-domain/src/deviceOverview';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { legacyDeviceReason } from '../utils/deviceReasonTestUtils';
import { buildBinaryObservation } from '../utils/binaryObservationTestUtils';
import { createMockPlanEngine } from '../utils/planEngineMock';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';

const LEGACY_PLAN_SNAPSHOT_SETTING = ['device', 'plan', 'snapshot'].join('_');

const buildPlan = (
  currentTarget: number,
  reason: string | DeviceReason,
  metaOverrides: Partial<DevicePlan['meta']> = {},
  deviceOverrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan => {
  const normalizedReason = typeof reason === 'string' ? legacyDeviceReason(reason) : reason;
  return {
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
        binaryControl: { on: true },
        currentState: 'on',
        plannedState: 'keep',
        currentTarget,
        plannedTarget: 20,
        reason: normalizedReason,
        controllable: true,
        controlCapabilityId: 'onoff',
        ...deviceOverrides,
      },
    ],
  };
};

const createPlanService = (overrides: Partial<ConstructorParameters<typeof PlanService>[0]> = {}) => {
  const { loggers: loggerOverrides, ...rest } = overrides;
  const deps = {
    homey: {
      settings: { set: vi.fn() },
      api: { realtime: vi.fn().mockResolvedValue(undefined) },
      flow: {},
    } as any,
    planEngine: {
        ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable')),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    } as any,
    getPlanDevices: () => [],
    getSettleDevices: () => [],
    getCapacityDryRun: () => false,
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getCombinedPrices: () => null,
    getLastPowerUpdate: () => null,
    loggers: {
      ...loggerOverrides,
    },
    isOverviewDebugEnabled: () => true,
    ...rest,
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

  it('keeps detail-only plan changes in memory and emits realtime updates', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      ...createMockPlanEngine(),
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
          });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    expect(service.getLatestPlanSnapshot()?.devices[0].currentTarget).toBe(21);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
    expect(planUpdatedCalls[0][1].devices[0].currentTarget).toBe(19);
    expect(planUpdatedCalls[1][1].devices[0].currentTarget).toBe(21);
  });

  it('ignores shortfall reason jitter when computing comparable detail changes', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const overviewDebugStructured = vi.fn();
    const planEngine = {
      ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(
          20,
          { code: 'shortfall', needKw: 1.21, headroomKw: -1.23 },
          { totalKw: 3.2, softLimitKw: 2, headroomKw: -1.23 },
          { currentState: 'off', binaryControl: { on: false }, plannedState: 'shed' },
        ))
        .mockResolvedValueOnce(buildPlan(
          20,
          { code: 'shortfall', needKw: 1.24, headroomKw: -1.24 },
          { totalKw: 3.2, softLimitKw: 2, headroomKw: -1.24 },
          { currentState: 'off', binaryControl: { on: false }, plannedState: 'shed' },
        )),
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
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    await service.rebuildPlanFromCache();
    settingsSet.mockClear();
    realtime.mockClear();
    overviewDebugStructured.mockClear();

    await service.rebuildPlanFromCache();

    const snapshotWrites = settingsSet.mock.calls
      .filter((call: unknown[]) => call[0] === LEGACY_PLAN_SNAPSHOT_SETTING);
    expect(snapshotWrites).toHaveLength(0);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(0);
    expect(overviewDebugStructured).not.toHaveBeenCalled();
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
          binaryControl: { on: false },
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          controllable: true,
          reason: legacyDeviceReason('insufficient headroom to restore (need 0.98kW, available -0.97kW)'),
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          binaryControl: { on: false },
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          controllable: true,
          reason: legacyDeviceReason('insufficient headroom to restore (need 1.10kW, available -0.97kW)'),
        },
        {
          id: 'ev-1',
          name: 'EV',
          binaryControl: { on: false },
          currentState: 'off',
          plannedState: 'inactive',
          currentTarget: null,
          controllable: true,
          reason: legacyDeviceReason('inactive (charger is unplugged)'),
        },
      ],
    };
    const debugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
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
      loggers: { debugStructured },
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

  it('logs overview changes on rebuild using the shared formatter output', async () => {
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 0,
          expectedPowerKw: 3,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache();

    const overview = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: legacyDeviceReason('keep'),
      measuredPowerKw: 0,
      expectedPowerKw: 3,
      controllable: true,
    });
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      component: 'overview',
      event: 'device_overview_changed',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      ...overview,
      currentState: 'on',
      plannedState: 'keep',
      reasonCode: 'keep',
      reasonText: '',
      measuredPowerKw: 0,
      expectedPowerKw: 3,
      reportedStepId: null,
      targetStepId: null,
      desiredStepId: null,
    }));
  });

  it('captures device-log entries even when the overview debug log is disabled', async () => {
    const recorder = new DeviceOverviewLogRecorder();
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 0,
          expectedPowerKw: 3,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
      isOverviewDebugEnabled: () => false,
      deviceOverviewLogRecorder: recorder,
    });

    await service.rebuildPlanFromCache();

    // Debug log is gated off, but the recorder still captured the entry.
    expect(overviewDebugStructured).not.toHaveBeenCalled();
    const overview = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: legacyDeviceReason('keep'),
      measuredPowerKw: 0,
      expectedPowerKw: 3,
      controllable: true,
    });
    const payload = service.getDeviceLogUiPayload();
    expect(payload.entriesByDeviceId['dev-1']).toEqual([
      expect.objectContaining({
        stateMsg: overview.stateMsg,
        statusMsg: overview.statusMsg,
        usageMsg: overview.usageMsg,
      }),
    ]);
  });

  it('batches multiple overview changes from the same rebuild', async () => {
    const overviewDebugStructured = vi.fn();
    const plan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 3,
    });
    plan.devices.push({
      ...plan.devices[0],
      id: 'dev-2',
      name: 'Bedroom',
      currentState: 'off',
      binaryControl: { on: false },
      plannedState: 'shed',
      measuredPowerKw: 0,
      expectedPowerKw: 1.2,
      reason: legacyDeviceReason('shed due to capacity'),
    });
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(plan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache();

    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      component: 'overview',
      event: 'device_overview_changes',
      changedDeviceCount: 2,
      devices: [
        expect.objectContaining({
          event: 'device_overview_changed',
          deviceId: 'dev-1',
          stateMsg: 'Active',
          usageMsg: 'Measured: 0.00 kW / Expected: 3.00 kW',
        }),
        expect.objectContaining({
          event: 'device_overview_changed',
          deviceId: 'dev-2',
          stateMsg: 'Turned off',
          usageMsg: 'Measured: 0.00 kW / Expected: 1.20 kW',
        }),
      ],
    }));
  });

  it('logs the confirmed reported step in overview events', async () => {
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          controlModel: 'stepped_load',
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 0,
          planningPowerKw: 3,
          reportedStepId: 'max',
          targetStepId: 'max',
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache();

    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed',
      reportedStepId: 'max',
      targetStepId: 'max',
      usageMsg: 'Measured: 0.00 kW / Expected: 3.00 kW (reported: max)',
    }));
  });

  it('does not log repeated identical overview snapshots', async () => {
    const overviewDebugStructured = vi.fn();
    const samePlan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 3,
    });
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValueOnce(samePlan).mockResolvedValueOnce(samePlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
  });

  it('logs on usage-only overview changes during rebuilds', async () => {
    const overviewDebugStructured = vi.fn();
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const { service } = createPlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn()
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
            currentState: 'on',
            plannedState: 'keep',
            measuredPowerKw: 0,
            expectedPowerKw: 3,
          }))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
            currentState: 'on',
            plannedState: 'keep',
            measuredPowerKw: 0.25,
            expectedPowerKw: 3,
          })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache();
    overviewDebugStructured.mockClear();
    settingsSet.mockClear();
    realtime.mockClear();

    await service.rebuildPlanFromCache();
    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed',
      usageMsg: 'Measured: 0.25 kW / Expected: 3.00 kW',
      measuredPowerKw: 0.25,
      expectedPowerKw: 3,
    }));
    // A usage-only overview change must NOT persist the plan snapshot (no
    // action/detail/meta change), but it DOES emit `plan_updated` so the open
    // settings-UI activity-log view refreshes for the new overview transition.
    expect(settingsSet.mock.calls.filter((call: unknown[]) => call[0] === LEGACY_PLAN_SNAPSHOT_SETTING)).toHaveLength(0);
    expect(realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated')).toHaveLength(1);
  });

  it('suppresses countdown-only cooldown changes for overview logs, snapshots, and plan updates', async () => {
    const overviewDebugStructured = vi.fn();
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const cooldownPlan = buildPlan(20, 'meter settling (30s remaining)', {}, {
      currentState: 'off',
      plannedState: 'keep',
    });
    const cooldownTickPlan = buildPlan(20, 'meter settling (24s remaining)', {}, {
      currentState: 'off',
      plannedState: 'keep',
    });
    const { service } = createPlanService({
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(cooldownPlan)
          .mockResolvedValueOnce(cooldownTickPlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache();
    overviewDebugStructured.mockClear();
    settingsSet.mockClear();
    realtime.mockClear();

    await service.rebuildPlanFromCache();

    expect(overviewDebugStructured).not.toHaveBeenCalled();
    expect(settingsSet.mock.calls.filter((call: unknown[]) => call[0] === LEGACY_PLAN_SNAPSHOT_SETTING)).toHaveLength(0);
    expect(realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated')).toHaveLength(0);
  });

  it('does not cache overview signatures when the overview emitter is missing', async () => {
    const samePlan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 3,
    });
    const { service } = createPlanService({
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(samePlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      overviewDebugStructured: undefined,
      isOverviewDebugEnabled: () => true,
    });

    await service.rebuildPlanFromCache();

    expect((service as any).lastOverviewSignatureByDeviceId.size).toBe(0);
  });

  it('logs overview changes during live sync when a visible field changes', async () => {
    const overviewDebugStructured = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        hasPendingBinaryCommands: vi.fn(() => true),
        syncPendingBinaryCommands: vi.fn(() => false),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentTemperature: 21,
        measuredPowerKw: 0.25,
        expectedPowerKw: 3,
        binaryCommandPending: true,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'keep', {}, {
      currentState: 'off',
      plannedState: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 3,
      binaryCommandPending: true,
    });
    (service as any).emitPlanUpdated((service as any).latestPlanSnapshot);
    overviewDebugStructured.mockClear();

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);
    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed',
      powerMsg: 'on',
      stateMsg: 'Active',
      usageMsg: 'Measured: 0.25 kW / Expected: 3.00 kW',
      statusMsg: '',
    }));
  });

  it('serializes enriched UI plan fields without changing the runtime snapshot', () => {
    const { service } = createPlanService({
      deviceDiagnostics: {
        getOverviewStarvation: vi.fn(() => ({
          isStarved: true,
          accumulatedMs: 30 * 60 * 1000,
          cause: 'capacity',
          startedAtMs: 1_234,
        })),
      },
    });
    const runtimePlan = buildPlan(
      18,
      'capacity',
      {
        totalKw: 6.24,
        softLimitKw: 5.04,
        headroomKw: -1.2,
        hardCapLimitKw: 7.01,
        hardCapHeadroomKw: 0.77,
        usedKWh: 1.234,
        budgetKWh: 2.345,
        dailyBudgetHourKWh: 1.987,
        minutesRemaining: 8.4,
        lastPowerUpdateMs: 1_700_000_000_000,
      },
      {
        plannedState: 'shed',
        shedAction: 'set_temperature',
        shedTemperature: 12,
        deviceClass: 'thermostat',
        controlModel: 'temperature_target',
        priority: 3,
        zone: 'Living room',
        budgetExempt: false,
        currentTemperature: 16,
        measuredPowerKw: 1.2,
        expectedPowerKw: 2.5,
        observationStale: false,
        pendingTargetCommand: {
          desired: 20,
          retryCount: 1,
          nextRetryAtMs: Date.now() + 30_000,
          status: 'temporary_unavailable',
          lastObservedValue: 18,
          lastObservedSource: 'snapshot_refresh',
        },
      },
    );
    (service as any).latestPlanSnapshot = runtimePlan;

    expect(service.getLatestPlanSnapshot()).toBe(runtimePlan);
    expect(service.getLatestPlanSnapshotForUi()).toEqual({
      generatedAtMs: undefined,
      meta: expect.objectContaining({
        totalKw: 6.2,
        softLimitKw: 5,
        headroomKw: -1.2000000000000002,
        hardCapLimitKw: 7,
        hardCapHeadroomKw: 0.8,
        usedKWh: 1.23,
        budgetKWh: 2.35,
        dailyBudgetHourKWh: 1.99,
        minutesRemaining: 8,
      }),
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          name: 'Heater',
          deviceClass: 'thermostat',
          plannedState: 'shed',
          stateKind: 'held',
          stateTone: 'held',
          currentTemperature: 16,
          pendingTargetCommand: expect.objectContaining({
            desired: 20,
            retryCount: 1,
            status: 'temporary_unavailable',
            lastObservedValue: 18,
            lastObservedSource: 'snapshot_refresh',
          }),
          starvation: {
            isStarved: true,
            accumulatedMs: 30 * 60 * 1000,
            cause: 'capacity',
            startedAtMs: 1_234,
          },
        }),
      ],
    });
  });

  it('logs a post-actuation overview transition once the live state settles', async () => {
    let currentOn = false;
    const overviewDebugStructured = vi.fn();
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockImplementation(async () => {
          currentOn = true;
          return { deviceWriteCount: 1 };
        }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        controlCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    await service.rebuildPlanFromCache();

    expect(overviewDebugStructured).toHaveBeenCalledTimes(2);
    expect(overviewDebugStructured.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      event: 'device_overview_changed',
      powerMsg: 'off',
      stateMsg: 'Resuming',
    }));
    expect(overviewDebugStructured.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      event: 'device_overview_changed',
      powerMsg: 'on',
      stateMsg: 'Active',
    }));
  });

  it('writes a fresh snapshot when priority changes without action changes', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      ...createMockPlanEngine(),
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
          });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    expect(service.getLatestPlanSnapshot()?.devices[0].priority).toBe(1);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
    expect(planUpdatedCalls[0][1].devices[0].priority).toBe(10);
    expect(planUpdatedCalls[1][1].devices[0].priority).toBe(1);
  });

  it('normalizes plan_updated emission failures before logging', async () => {
    const realtime = vi.fn().mockRejectedValue('boom');
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
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
      loggers: { structuredLog: structuredLog as any },
          });

    await service.rebuildPlanFromCache();
    await Promise.resolve();

    expect(structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_updated_emit_failed',
      error: expect.objectContaining({ message: 'boom' }),
    }));
  });

  it('keeps the latest in-memory plan snapshot fresh for meta-only changes', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      ...createMockPlanEngine(),
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
          });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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

  it('blocks stale EV deadline resume intents during realtime reconcile', async () => {
    const applyPlanActions = vi.fn().mockImplementation(async (plan: DevicePlan) => {
      expect(plan.meta.powerFreshnessState).toBe('stale_hold');
      expect(buildExecutablePlan(plan).devices[0].release).toBeNull();
      return { deviceWriteCount: 0, commandRequestCount: 0 };
    });
    const liveDevices: PlanInputDevice[] = [{
      id: 'ev-1',
      name: 'EV Charger',
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      binaryControl: { on: false },
    }];
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => liveDevices,
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => Date.now() - POWER_SAMPLE_STALE_THRESHOLD_MS,
          });

    (service as any).latestPlanSnapshot = buildPlan(
      null,
      'stable',
      { powerFreshnessState: 'fresh' },
      {
        id: 'ev-1',
        name: 'EV Charger',
        binaryControl: { on: false },
        currentState: 'off',
        currentTarget: null,
        plannedState: 'keep',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        deferredReleaseIntent: 'binary_restore',
      },
    );

    await expect(service.reconcileLatestPlanState()).resolves.toBe(true);
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ powerFreshnessState: 'stale_hold' }),
      devices: [
        expect.objectContaining({
          id: 'ev-1',
          deferredReleaseIntent: 'binary_restore',
        }),
      ],
    }), 'reconcile');
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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

  it('preserves generatedAtMs when syncLivePlanState refreshes live state', async () => {
    const realtime = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        hasPendingBinaryCommands: vi.fn(() => true),
        syncPendingBinaryCommands: vi.fn(() => false),
      } as any,
      getPlanDevices: () => [{
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    (service as any).latestPlanSnapshot = {
      ...buildPlan(20, 'meter settling (30s remaining)', {}, {
        currentState: 'on',
        plannedState: 'shed',
      }),
      generatedAtMs: Date.parse('2026-02-06T23:59:30.000Z'),
    };

    vi.setSystemTime(new Date('2026-02-07T00:00:10.000Z'));

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);

    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      generatedAtMs: Date.parse('2026-02-06T23:59:30.000Z'),
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          plannedState: 'shed',
        }),
      ],
    }));
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      generatedAtMs: Date.parse('2026-02-06T23:59:30.000Z'),
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        binaryControlObservation: buildBinaryObservation('onoff', true),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
          controlCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-1'] },
          currentTemperature: 21,
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          controlCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-2'] },
          currentTemperature: 21,
        },
      ],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
          controlCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-1'] },
          currentTemperature: 21,
          controllable: true,
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          controlCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-2'] },
          currentTemperature: 21,
          controllable: false,
        },
      ],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
          controlCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-1'] },
          currentTemperature: 21,
          controllable: true,
          available: true,
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          controlCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-2'] },
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        binaryControlObservation: buildBinaryObservation('onoff', currentOn),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
        ...createMockPlanEngine(),
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
      ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
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
      controlCapabilityId: 'onoff',
      binaryControl: { on: true },
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
        ...createMockPlanEngine(),
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
      // Settle reads its own source in production (the device snapshot); provide one here
      // (a separate fn, same devices) so the binary-settle fallback does not double-count
      // the `getPlanDevices` spy.
      getSettleDevices: () => firstLiveDevices,
      getCapacityDryRun: () => true,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache('capture_live_devices_once');

    expect(getPlanDevices).toHaveBeenCalledTimes(1);
    expect(syncPendingTargetCommands).toHaveBeenCalledWith(firstLiveDevices, 'rebuild');
    expect(syncPendingBinaryCommands).toHaveBeenCalledWith(firstLiveDevices, 'rebuild');
    expect(buildDevicePlanSnapshot).toHaveBeenCalledWith(firstLiveDevices);
  });

  it('passes snapshot_refresh and realtime_capability binary evidence to rebuild and live sync without source filtering', async () => {
    const snapshotRefreshEvidence = {
      valid: true as const,
      capabilityId: 'onoff' as const,
      observedValue: true,
      observedCapabilityIds: ['onoff'],
      observedAtMs: Date.now() + 1,
      source: 'snapshot_refresh' as const,
    };
    const realtimeEvidence = {
      ...snapshotRefreshEvidence,
      observedValue: false,
      observedAtMs: Date.now() + 2,
      source: 'realtime_capability' as const,
    };
    const buildLiveDevice = (binaryControlObservation: BinaryControlObservation) => ({
      id: 'dev-1',
      name: 'Heater',
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature' as const,
      controlCapabilityId: 'onoff' as const,
      currentOn: binaryControlObservation.observedValue,
      currentTemperature: 21,
      binaryControlObservation,
    });
    let liveDevices = [buildLiveDevice(snapshotRefreshEvidence)];
    const syncPendingBinaryCommands = vi.fn(() => false);
    const service = new PlanService({
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'stable')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
        hasPendingBinaryCommands: vi.fn(() => true),
        syncPendingBinaryCommands,
        prunePendingTargetCommands: vi.fn(() => false),
        decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
      } as any,
      getPlanDevices: () => liveDevices,
      getCapacityDryRun: () => true,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache('binary_evidence_snapshot_refresh');
    expect(syncPendingBinaryCommands).toHaveBeenCalledWith([
      expect.objectContaining({ binaryControlObservation: snapshotRefreshEvidence }),
    ], 'rebuild');

    (service as any).latestPlanSnapshot = buildPlan(20, 'stable', {}, { binaryCommandPending: true });
    liveDevices = [buildLiveDevice(realtimeEvidence)];
    await service.syncLivePlanState('realtime_capability');

    expect(syncPendingBinaryCommands).toHaveBeenLastCalledWith([
      expect.objectContaining({ binaryControlObservation: realtimeEvidence }),
    ], 'realtime_capability');
  });

  it('skips applyPlanActions on identical rebuilds', async () => {
    const settingsSet = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      ...createMockPlanEngine(),
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
      controlCapabilityId: 'onoff',
      currentTemperature: 21,
    };
    let liveDevices = [{
      ...liveDeviceBase,
      binaryControl: { on: true },
      binaryControlObservation: buildBinaryObservation('onoff', true),
    }];

    const planEngine = {
      ...createMockPlanEngine(),
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
          });

    await service.rebuildPlanFromCache('seed_expected_on_state');
    expect(applyPlanActions).toHaveBeenCalledTimes(1);
    applyPlanActions.mockClear();

    liveDevices = [{
      ...liveDeviceBase,
      binaryControl: { on: false },
      binaryControlObservation: buildBinaryObservation('onoff', false),
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
      planEngine: { ...createMockPlanEngine() } as any,
      getPlanDevices: () => [],
      getCapacityDryRun: () => true,
      isCurrentHourCheap: () => true,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => ({ prices: [{ total: 10 }] }),
      getLastPowerUpdate: () => 123456,
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
      ...createMockPlanEngine(),
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
    expect(trace.statusWriteMs).toBeGreaterThanOrEqual(7);
    expect(trace.applyMs).toBeGreaterThanOrEqual(13);
    expect(trace.totalMs).toBeGreaterThanOrEqual(
      trace.buildMs + trace.snapshotMs + trace.statusWriteMs + trace.applyMs,
    );
  });

  it('records failed rebuild attempts in perf counters and traces', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const settingsSet = vi.fn();
    const planEngine = {
      ...createMockPlanEngine(),
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
      loggers: { structuredLog: structuredLog as any },
          });

    const beforePerf = getPerfSnapshot();
    await service.rebuildPlanFromCache('test_reason.failed');
    const afterPerf = getPerfSnapshot();

    expect((afterPerf.counts.plan_rebuild_total || 0) - (beforePerf.counts.plan_rebuild_total || 0)).toBe(1);
    expect((afterPerf.counts.plan_rebuild_failed_total || 0) - (beforePerf.counts.plan_rebuild_failed_total || 0)).toBe(1);
    expect((afterPerf.durations.plan_rebuild_ms?.count || 0) - (beforePerf.durations.plan_rebuild_ms?.count || 0)).toBe(1);
    expect(structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_operation_failed',
      message: 'Failed to rebuild plan',
      error: expect.objectContaining({ message: 'plan exploded' }),
    }));

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'test_reason.failed',
      failed: true,
      queueDepth: 1,
    }));
    expect(trace.totalMs).toBeGreaterThanOrEqual(17);
  });

  it('suppresses structured rebuild logs for unchanged no-op rebuilds', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();

    await service.rebuildPlanFromCache('power_delta');

    expect(structuredLog.info).not.toHaveBeenCalled();
  });

  it('emits structured rebuild logs for initial rebuild reasons even without action changes', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
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
      plannedShedDevices: 0,
      pendingPlannedShedDevices: 0,
      activePlannedShedDevices: 0,
      summarySource: 'plan_snapshot',
      summarySourceAtMs: expect.any(Number),
    }));
    expect(structuredLog.info.mock.calls[0]?.[0]).not.toHaveProperty('shedDevices');
  });

  it('emits structured rebuild logs for slow rebuilds even without action changes', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
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
      loggers: { structuredLog: structuredLog as any },
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
      loggers: { structuredLog: structuredLog as any },
      planEngine: {
        ...createMockPlanEngine(),
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
      commandRequestCount: 0,
      failed: false,
    }));
  });

  it('emits plan_rebuild_completed with commandRequestCount when actuation requested commands', async () => {
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const schedulePostActuationRefresh = vi.fn();
    const { service, deps } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
      schedulePostActuationRefresh,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(buildPlan(20, 'stable'))
          .mockResolvedValueOnce(buildPlan(20, 'stable', {}, { plannedState: 'shed' })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0, commandRequestCount: 1 }),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();
    structuredLog.debug.mockClear();
    schedulePostActuationRefresh.mockClear();

    await service.rebuildPlanFromCache('power_delta');

    expect((deps.planEngine.applyPlanActions as vi.Mock)).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_completed',
      reasonCode: 'power_delta',
      actionChanged: true,
      appliedActions: true,
      deviceWriteCount: 0,
      commandRequestCount: 1,
      failed: false,
    }));

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'power_delta',
      appliedActions: true,
      deviceWriteCount: 0,
      commandRequestCount: 1,
    }));
  });

  it('normalizes non-finite actuation counts to zero in rebuild logs and traces', async () => {
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(buildPlan(20, 'stable'))
          .mockResolvedValueOnce(buildPlan(20, 'stable', {}, { plannedState: 'shed' })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue({
          deviceWriteCount: Number.NaN,
          commandRequestCount: Number.POSITIVE_INFINITY,
        }),
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
      commandRequestCount: 0,
    }));

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'power_delta',
      appliedActions: false,
      deviceWriteCount: 0,
      commandRequestCount: 0,
    }));
  });

  it('emits structured rebuild logs for failed rebuilds', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
          });

    await service.rebuildPlanFromCache();
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });

  it('retries unchanged stepped-load step-up plans while the reported step is still lower than desired', async () => {
    const steppedPlan = buildPlan(20, 'stable', {}, {
      currentState: 'on',
      plannedState: 'keep',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'step_0', planningPowerW: 0 },
          { id: 'step_1', planningPowerW: 1_200 },
          { id: 'step_2', planningPowerW: 1_640 },
        ],
      },
      selectedStepId: 'step_1',
      desiredStepId: 'step_2',
      binaryControl: { on: true },
    });
    const applyPlanActions = vi.fn().mockResolvedValue({ deviceWriteCount: 0 });
    const planEngine = {
      ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi.fn().mockResolvedValue(steppedPlan),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
      applySheddingToDevice: vi.fn().mockResolvedValue(false),
      shouldApplyStablePlanActions: vi.fn(() => (
        steppedPlan.devices.some((device) => (
          device.controlModel === 'stepped_load'
          && device.plannedState === 'keep'
          && device.selectedStepId !== device.desiredStepId
          && device.stepCommandPending !== true
        ))
      )),
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
        name: 'RovikCharger',
        targets: [],
        deviceType: 'onoff',
        controlModel: 'stepped_load',
        controlCapabilityId: 'onoff',
        steppedLoadProfile: steppedPlan.devices[0].steppedLoadProfile,
        binaryControl: { on: true },
        selectedStepId: 'step_1',
        desiredStepId: 'step_2',
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    const firstOutcome = await service.rebuildPlanFromCache('power_delta');
    const secondOutcome = await service.rebuildPlanFromCache('power_delta');

    expect(firstOutcome.actionChanged).toBe(true);
    expect(secondOutcome.actionChanged).toBe(false);
    expect(applyPlanActions).toHaveBeenCalledTimes(2);
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
        ...createMockPlanEngine(),
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
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
        ...createMockPlanEngine(),
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
        ...createMockPlanEngine(),
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
          });

    await service.applySheddingToDevice('dev-1', 'Heater');

    expect(applySheddingToDevice).toHaveBeenCalledWith('dev-1', 'Heater', undefined);
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });
});
