import { PassThrough } from 'node:stream';
import type { Mock } from 'vitest';
import { PlanService } from '../../lib/plan/planService';
import type {
  DevicePlan,
  PlanInputDevice,
  BinaryControlDiscriminantProbe,
  TemperatureDiscriminantProbe,
  SteppedDiscriminantProbe,
} from '../../lib/plan/planTypes';
import {
  withBinaryDiscriminant,
  withTemperatureDiscriminant,
  withSteppedDiscriminant,
} from '../../lib/plan/planTypes';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { buildPlanMeta, openPlanBuildGate, steppedInputDevice } from '../utils/planTestUtils';
import type { BinaryControlObservation } from '../../packages/contracts/src/types';
import * as pelsStatusModule from '../../lib/plan/pelsStatus';
import { getRecentPlanRebuildTraces } from '../../lib/utils/planRebuildTrace';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { formatDeviceOverview } from '../../packages/shared-domain/src/deviceOverview';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { fixtureDeviceReason, insufficientHeadroomFixtureReason } from '../utils/deviceReasonTestUtils';
import { buildBinaryObservation } from '../utils/binaryObservationTestUtils';
import { createMockPlanEngine } from '../utils/planEngineMock';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';
import {
  createRootLogger,
  getLogger,
  setRootLogger,
} from '../../lib/logging/logger';
import type { PendingBinaryLiveDevice } from '../../lib/observer/pendingBinaryCommands';

const LEGACY_PLAN_SNAPSHOT_SETTING = ['device', 'plan', 'snapshot'].join('_');

const unavailableBinaryConfirmations = (
  devices: readonly { id: string; name: string }[],
): PendingBinaryLiveDevice[] => devices.map(({ id, name }) => ({
  id,
  name,
  binaryCommandConfirmation: { state: 'unavailable' },
}));

const buildPlan = (
  currentTarget: number,
  reason: string | DeviceReason,
  metaOverrides: Partial<DevicePlan['meta']> = {},
  deviceOverrides: Partial<DevicePlan['devices'][number]>
    & BinaryControlDiscriminantProbe
    & TemperatureDiscriminantProbe
    & SteppedDiscriminantProbe = {},
): DevicePlan => {
  const normalizedReason = typeof reason === 'string' ? fixtureDeviceReason(reason)! : reason;
  return {
    meta: buildPlanMeta({
      totalKw: 1,
      softLimitKw: 5,
      headroomKw: 4,
      ...metaOverrides}),
    devices: [
      withSteppedDiscriminant(withTemperatureDiscriminant(withBinaryDiscriminant({
        id: 'dev-1',
        name: 'Heater',
        deviceType: 'temperature' as const,
        binaryControl: { on: true },
        currentOn: true,
        currentState: 'on',
        plannedState: 'keep' as const,
        boostActive: false,
        currentTarget,
        currentTemperature: currentTarget,
        plannedTarget: 20,
        reason: normalizedReason,
        controllable: true,
        binaryCapabilityId: 'onoff' as const,
        ...deviceOverrides,
        // Mirror the producer: `finalizePlanDevices` stamps the shed end state on
        // every device before a plan leaves the builder, so a fixture that skips it
        // exercises a shape the planner never emits. An explicit override still
        // wins, so a test can pin a deliberately inconsistent device.
        plannedShedTargetKind: deviceOverrides.plannedShedTargetKind
          ?? resolvePlannedShedTargetKind({
            plannedState: deviceOverrides.plannedState ?? 'keep',
            shedAction: deviceOverrides.shedAction,
            steppedLoadProfile: deviceOverrides.steppedLoadProfile,
            plannedShedStepId: deviceOverrides.plannedShedStepId,
          }),
      }))) as DevicePlan['devices'][number],
    ],
  };
};

const createPlanService = (overrides: Partial<ConstructorParameters<typeof PlanService>[0]> = {}) => {
  const { loggers: loggerOverrides, ...rest } = overrides;
  const deps = {
    homeId: 'main',
    getObservedTemperature: () => ({ kind: 'absent' } as const),
    planBuildGate: openPlanBuildGate(),
    homey: {
      settings: { set: vi.fn() },
      api: { realtime: vi.fn().mockResolvedValue(undefined) },
      flow: {},
    } as any,
    writePelsStatus: vi.fn(),
    planEngine: {
        ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep')),
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
    getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
    let observedTarget = 19;
    const planEngine = {
      ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi
        .fn()
        .mockImplementationOnce(async () => {
          observedTarget = 19;
          return buildPlan(19, 'keep');
        })
        .mockImplementationOnce(async () => {
          observedTarget = 21;
          return buildPlan(21, 'keep');
        }),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: observedTarget, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    const latestDevice = service.getLatestPlanSnapshot()?.devices[0];
    expect(latestDevice && isTemperaturePlanDevice(latestDevice) ? latestDevice.currentTarget : undefined).toBe(21);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
    expect(planUpdatedCalls[0][1].devices[0].temperature.currentTarget).toBe(19);
    expect(planUpdatedCalls[1][1].devices[0].temperature.currentTarget).toBe(21);
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
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
      meta: buildPlanMeta({
        totalKw: 3.97,
        softLimitKw: 3.0,
        capacitySoftLimitKw: 4.0,
        dailySoftLimitKw: 3.0,
        softLimitSource: 'daily',
        headroomKw: -0.97}),
      devices: [
        withTemperatureDiscriminant(withBinaryDiscriminant({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-1',
          name: 'Heater 1',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          binaryCapabilityId: 'onoff' as const,
          binaryControl: { on: false },
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed' as const,
          boostActive: false,
          controllable: true,
          available: true,
          reason: insufficientHeadroomFixtureReason({ needKw: 0.98, availableKw: -0.97 }),
        })) as DevicePlan['devices'][number],
        withTemperatureDiscriminant(withBinaryDiscriminant({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-2',
          name: 'Heater 2',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          binaryCapabilityId: 'onoff' as const,
          binaryControl: { on: false },
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed' as const,
          boostActive: false,
          controllable: true,
          available: true,
          reason: insufficientHeadroomFixtureReason({ needKw: 1.1, availableKw: -0.97 }),
        })) as DevicePlan['devices'][number],
        withTemperatureDiscriminant(withBinaryDiscriminant({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'ev-1',
          name: 'EV',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          binaryCapabilityId: 'onoff' as const,
          binaryControl: { on: false },
          currentOn: false,
          currentState: 'off',
          plannedState: 'inactive' as const,
          boostActive: false,
          controllable: true,
          available: true,
          reason: fixtureDeviceReason('inactive (charger is unplugged)')!,
        })) as DevicePlan['devices'][number],
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
          boostActive: false,
          currentDrawKw: 0, residualKw: { shed: 0 },
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
      reason: fixtureDeviceReason('keep')!,
      currentDrawKw: 0,
      expectedPowerKw: 3,
      // The plan device carries no stepped ladder, so the emit seam builds no
      // `steppedLoad` cluster for it — a plain binary device, which is what the
      // real overview is built from. The mirror must match that absence.
      controllable: true,
      available: true,
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
      currentDrawKw: 0,
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
          boostActive: false,
          currentDrawKw: 0, residualKw: { shed: 0 },
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
      reason: fixtureDeviceReason('keep')!,
      currentDrawKw: 0,
      expectedPowerKw: 3,
      // The plan device carries no stepped ladder, so the emit seam builds no
      // `steppedLoad` cluster for it — a plain binary device, which is what the
      // real overview is built from. The mirror must match that absence.
      controllable: true,
      available: true,
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
      boostActive: false,
      currentDrawKw: 0, residualKw: { shed: 0 },
      expectedPowerKw: 3,
    });
    plan.devices.push(withBinaryDiscriminant({
      ...plan.devices[0],
      id: 'dev-2',
      name: 'Bedroom',
      currentState: 'off',
      binaryControl: { on: false },
      currentOn: false,
      plannedState: 'shed' as const,
      boostActive: false,
      currentDrawKw: 0, residualKw: { shed: 0 },
      expectedPowerKw: 1.2,
      reason: fixtureDeviceReason('shed due to capacity')!,
    }) as DevicePlan['devices'][number]);
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
          // Stepped is the profile-presence capability (the planner no longer reads
          // controlModel); a real stepped device always carries the profile.
          steppedLoadProfile: { steps: [{ id: 'max', planningPowerW: 3000 }] },
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          currentDrawKw: 0, residualKw: { shed: 0 },
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
      usageMsg: 'Measured: 0.00 kW / Planned: 3.00 kW (reported: Max)',
    }));
  });

  it('does not log repeated identical overview snapshots', async () => {
    const overviewDebugStructured = vi.fn();
    const samePlan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      currentDrawKw: 0, residualKw: { shed: 0 },
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
            boostActive: false,
            currentDrawKw: 0, residualKw: { shed: 0 },
            expectedPowerKw: 3,
          }))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
            currentState: 'on',
            plannedState: 'keep',
            boostActive: false,
            currentDrawKw: 0.25, residualKw: { shed: 0.25 },
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
      currentDrawKw: 0.25,
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
      boostActive: false,
    });
    const cooldownTickPlan = buildPlan(20, 'meter settling (24s remaining)', {}, {
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
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
      boostActive: false,
      currentDrawKw: 0, residualKw: { shed: 0 },
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{
        controllable: true, available: true,
        id: 'dev-1',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
        currentDrawKw: 0.25, residualKw: { shed: 0.25 },
        expectedPowerKw: 3, expectedPowerSource: 'default',
        binaryCommandPending: true,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'keep', {}, {
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      currentDrawKw: 0, residualKw: { shed: 0 },
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
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: 18, currentTemperature: 16 },
      }),
      deviceDiagnostics: {
        getOverviewStarvation: vi.fn(() => ({
          isStarved: true,
          accumulatedMs: 30 * 60 * 1000,
        })),
      },
    });
    const runtimePlan = buildPlan(
      18,
      'shed due to capacity',
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
        boostActive: false,
        shedAction: 'set_temperature',
        shedTemperature: 12,
        deviceClass: 'thermostat',
        priority: 3,
        zone: 'Living room',
        budgetExempt: false,
        currentTemperature: 16,
        currentDrawKw: 1.2, residualKw: { shed: 1.2 },
        expectedPowerKw: 2.5,
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
        usedKWh: 1.23,
        // Proves BOTH hour-budget inputs were rounded and the tighter one won:
        // capacity 2.345 -> 2.35, daily 1.987 -> 1.99, min = 1.99. The inputs
        // themselves are local to the read model and no longer on the wire, so
        // this is where their normalization is observable.
        hourBudgetKWh: 1.99,
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
          temperature: expect.objectContaining({ currentTemperature: 16 }),
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
          },
        }),
      ],
    });
  });

  it('logs a post-actuation overview transition once the live state settles', async () => {
    let currentOn = false;
    const overviewDebugStructured = vi.fn();
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentOn: currentOn,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
          boostActive: false,
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    expect(service.getLatestPlanSnapshot()?.devices[0].priority).toBe(1);

    // The invariant is that the second rebuild is NOT deduped away: a priority
    // change with no action change still publishes. It is observed on the
    // internal plan above rather than on the emitted payload, because priority
    // is a settings fact about the device and no longer rides the plan wire —
    // the Overview reads it from the device list it orders by.
    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
    expect(planUpdatedCalls[0][1].devices[0]).not.toHaveProperty('priority');
  });

  it('normalizes plan_updated emission failures before logging', async () => {
    const realtime = vi.fn().mockRejectedValue('boom');
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(19, 'keep')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(undefined),
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
        .mockResolvedValueOnce(buildPlan(20, 'keep', { totalKw: 1.0 }))
        .mockResolvedValueOnce(buildPlan(20, 'keep', { totalKw: 1.2 })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(undefined),
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache();
    await service.rebuildPlanFromCache();

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    expect(service.getLatestPlanSnapshot()?.meta.totalKw).toBe(1.2);
  });

  it('does not publish drifted live state as the committed snapshot', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    (service as any).latestPlanSnapshot = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      boostActive: false,
      plannedTarget: 20,
    });

    // `syncLivePlanState` must not publish drifted live state as the committed
    // snapshot: the device reads off while the plan wants it on, which is NOT a
    // settled actuation, so the stored snapshot keeps saying `on` and no
    // `plan_updated` goes out. (Convergence itself is the rebuild's job — see
    // 'actuates on a detail-only rebuild when the device drifted from plan
    // intent', and the per-shape drift coverage in executorConvergence.test.ts.)
    await expect(service.syncLivePlanState('device_update')).resolves.toBe(false);
    expect(applyPlanActions).not.toHaveBeenCalled();
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).not.toHaveBeenCalled();
  });

  it('aborts the rebuild (no actuation) when the abort predicate reports a stale revision', async () => {
    // The live onoff state diverges from what the plan intends, so this rebuild
    // WOULD actuate. But `rebuildPlanFromCache` only enqueues; by the time the
    // queued body runs, the caller's precondition (a sub-home ready-edge's
    // meter-sample revision) may have moved. The abort predicate — checked inside
    // the queued body, at the point of use — must prevent the now-stale actuation
    // (R7b P1 TOCTOU), and `onAbort` must fire so the caller can tell an abort
    // from an ordinary no-op.
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const onAbort = vi.fn();
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
    });

    (service as any).latestPlanSnapshot = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      currentTarget: 20,
      plannedState: 'keep',
      boostActive: false,
      plannedTarget: 20,
    });

    // Predicate reports the revision moved → the rebuild aborts before planning
    // or touching devices.
    const outcome = await service.rebuildPlanFromCache('stale_revision', () => true, onAbort);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(outcome.failed).toBe(false);
    expect(outcome.appliedActions).toBe(false);
    expect(applyPlanActions).not.toHaveBeenCalled();
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

    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 18,
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: 18, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    (service as any).latestPlanSnapshot = buildPlan(18, 'keep');

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
          temperature: expect.objectContaining({ currentTarget: 18 }),
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

    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: 20, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    (service as any).latestPlanSnapshot = decoratePlanWithPendingTargetCommands(buildPlan(18, 'keep'));

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
          temperature: expect.objectContaining({ currentTarget: 20 }),
        }),
      ],
    }));
  });

  it('preserves generatedAtMs when syncLivePlanState refreshes live state', async () => {
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    (service as any).latestPlanSnapshot = {
      ...buildPlan(20, 'meter settling (30s remaining)', {}, {
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
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
          boostActive: false,
        }),
      ],
    }));
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      generatedAtMs: Date.parse('2026-02-06T23:59:30.000Z'),
    }));
  });


  it('refreshes the stored plan snapshot when a pending binary command is confirmed by live state', async () => {
    let hasPendingBinaryCommands = true;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    (service as any).latestPlanSnapshot = buildPlan(20, 'cooldown (restore, 30s remaining)', {}, {
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      currentTarget: 20,
      plannedTarget: 20,
    });

    await expect(service.syncLivePlanState('device_update')).resolves.toBe(true);
    expect(service.getLatestPlanSnapshot()?.devices[0]).toMatchObject({
      id: 'dev-1',
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [
        { controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-1',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Heater 1',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          currentTarget: 20,
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          binaryCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-1'] },
          currentOn: liveCurrentOnById['dev-1'],
          currentTemperature: 21,
        },
        { controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-2',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Heater 2',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          currentTarget: 20,
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          binaryCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-2'] },
          currentOn: liveCurrentOnById['dev-2'],
          currentTemperature: 21,
        },
      ];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
          meta: buildPlanMeta({
            totalKw: 1,
            softLimitKw: 5,
            headroomKw: 4}),
          devices: [
            {
              id: 'dev-1',
              name: 'Heater 1',
              currentState: 'off',
              plannedState: 'keep',
              boostActive: false,
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'keep',
              controllable: true,
              binaryCapabilityId: 'onoff',
              currentOn: false,
            },
            {
              id: 'dev-2',
              name: 'Heater 2',
              currentState: 'off',
              plannedState: 'keep',
              boostActive: false,
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'keep',
              controllable: true,
              binaryCapabilityId: 'onoff',
              currentOn: false,
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
          boostActive: false,
          plannedTarget: 20,
        }),
        expect.objectContaining({
          id: 'dev-2',
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          boostActive: false,
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentOn: currentOn,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          currentTarget: 20,
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
          boostActive: false,
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [
        { available: true, currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-1',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Heater 1',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          currentTarget: 20,
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          binaryCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-1'] },
          currentOn: liveCurrentOnById['dev-1'],
          currentTemperature: 21,
          controllable: true,
        },
        { available: true, currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-2',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Heater 2',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          currentTarget: 20,
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          binaryCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-2'] },
          currentOn: liveCurrentOnById['dev-2'],
          currentTemperature: 21,
          controllable: false,
        },
      ];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
          meta: buildPlanMeta({
            totalKw: 1,
            softLimitKw: 5,
            headroomKw: 4}),
          devices: [
            {
              id: 'dev-1',
              name: 'Heater 1',
              deviceType: 'temperature',
              currentState: 'off',
              plannedState: 'keep',
              boostActive: false,
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'keep',
              controllable: true,
            },
            {
              id: 'dev-2',
              name: 'Heater 2',
              deviceType: 'temperature',
              currentState: 'off',
              plannedState: 'keep',
              boostActive: false,
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'keep',
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [
        { currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-1',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Heater 1',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          currentTarget: 20,
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          binaryCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-1'] },
          currentOn: liveCurrentOnById['dev-1'],
          currentTemperature: 21,
          controllable: true,
          available: true,
        },
        { currentDrawKw: 0, residualKw: { shed: 0 },
          id: 'dev-2',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Heater 2',
          // `available: false` below: the producer resolves that to
          // commandableNow=false ('device unavailable'), so the fixture must too.
          commandableNow: false,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          confirmedNotDrawing: false,
          currentTarget: 20,
          targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
          deviceType: 'temperature',
          binaryCapabilityId: 'onoff',
          binaryControl: { on: liveCurrentOnById['dev-2'] },
          currentOn: liveCurrentOnById['dev-2'],
          currentTemperature: 21,
          controllable: true,
          available: false,
        },
      ];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
          meta: buildPlanMeta({
            totalKw: 1,
            softLimitKw: 5,
            headroomKw: 4}),
          devices: [
            {
              id: 'dev-1',
              name: 'Heater 1',
              deviceType: 'temperature',
              currentState: 'off',
              plannedState: 'keep',
              boostActive: false,
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'keep',
              controllable: true,
              available: true,
            },
            {
              id: 'dev-2',
              name: 'Heater 2',
              deviceType: 'temperature',
              currentState: 'off',
              plannedState: 'keep',
              boostActive: false,
              currentTarget: 20,
              plannedTarget: 20,
              reason: 'keep',
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentOn: currentOn,
        currentTarget: 21,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: 21, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(21, 'keep', {}, {
          currentState: 'on',
          currentTarget: 21,
          plannedState: 'shed',
          boostActive: false,
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
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
          boostActive: false,
          plannedTarget: 18,
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          temperature: expect.objectContaining({ currentTarget: 21 }),
        }),
      ],
    }));
  });

  it('queues external shedding behind an in-flight rebuild', async () => {
    let resolveApply: (() => void) | undefined;
    const applyPlanActions = vi.fn().mockImplementation(async () => new Promise<void>((resolve) => {
      resolveApply = resolve;
    }));
    const applySheddingToDevice = vi.fn().mockResolvedValue(undefined);
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice,
      } as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
    const syncPendingTargetCommands = vi.fn((_devices: unknown, _source?: string) => true);
    const planEngine = {
      ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi.fn().mockImplementation(
        async () => new Promise<DevicePlan>((resolve) => {
          resolveBuild = () => resolve(buildPlan(20, 'keep'));
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
      expectedPowerKw: 1,
      name: 'Heater',
      currentTarget: 20,
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: true },
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
    const buildDevicePlanSnapshot = vi.fn().mockResolvedValue(buildPlan(20, 'keep'));
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getSettleDevices: () => unavailableBinaryConfirmations(firstLiveDevices),
      getCapacityDryRun: () => true,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache('capture_live_devices_once');

    expect(getPlanDevices).toHaveBeenCalledTimes(1);
    expect(syncPendingTargetCommands).toHaveBeenCalledWith(firstLiveDevices, 'rebuild');
    expect(syncPendingBinaryCommands).toHaveBeenCalledWith(
      unavailableBinaryConfirmations(firstLiveDevices),
      'rebuild',
    );
    expect(buildDevicePlanSnapshot).toHaveBeenCalledWith(firstLiveDevices);
  });

  it('passes producer-resolved binary confirmation to rebuild and live sync', async () => {
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
      controllable: true, available: true,
      id: 'dev-1',
      expectedPowerKw: 1,
      expectedPowerSource: 'default' as const,
      name: 'Heater',
      currentDrawKw: 0, residualKw: { shed: 0 },
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
      currentTarget: 20,
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature' as const,
      binaryCapabilityId: 'onoff' as const,
      currentOn: binaryControlObservation.observedValue,
      currentTemperature: 21,
      binaryControlObservation,
    });
    let liveDevices = [buildLiveDevice(snapshotRefreshEvidence)];
    let settleDevices: PendingBinaryLiveDevice[] = [{
      id: 'dev-1',
      name: 'Heater',
      binaryCommandConfirmation: {
        state: 'observed',
        observedValue: true,
        observedAtMs: snapshotRefreshEvidence.observedAtMs,
      },
    }];
    const syncPendingBinaryCommands = vi.fn(() => false);
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep')),
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
      getSettleDevices: () => settleDevices,
      getCapacityDryRun: () => true,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache('binary_evidence_snapshot_refresh');
    expect(syncPendingBinaryCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        binaryCommandConfirmation: expect.objectContaining({
          state: 'observed',
          observedValue: true,
        }),
      }),
    ], 'rebuild');

    (service as any).latestPlanSnapshot = buildPlan(20, 'keep', {}, { binaryCommandPending: true });
    liveDevices = [buildLiveDevice(realtimeEvidence)];
    settleDevices = [{
      id: 'dev-1',
      name: 'Heater',
      binaryCommandConfirmation: {
        state: 'observed',
        observedValue: false,
        observedAtMs: realtimeEvidence.observedAtMs,
      },
    }];
    await service.syncLivePlanState('realtime_capability');

    expect(syncPendingBinaryCommands).toHaveBeenLastCalledWith([
      expect.objectContaining({
        binaryCommandConfirmation: expect.objectContaining({
          state: 'observed',
          observedValue: false,
        }),
      }),
    ], 'realtime_capability');
  });

  it('skips applyPlanActions on identical rebuilds', async () => {
    const settingsSet = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const planEngine = {
      ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValue(buildPlan(20, 'keep')),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
      applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
    };

    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: settingsSet },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache('test_identical.first');
    await service.rebuildPlanFromCache('test_identical.second');

    expect(applyPlanActions).toHaveBeenCalledTimes(1);
  });

  // A rebuild whose ACTION signature is unchanged must still actuate when the
  // device has drifted away from what that plan wants. Before the apply gate
  // widened, this case fell through to the reconcile lane, which re-asserted a
  // plan built against the older observation — the shape behind inc_26449fb9.
  it('actuates on a detail-only rebuild when the device drifted from plan intent', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(undefined);
    const liveDeviceBase = {
      controllable: true, available: true,
      id: 'dev-1',
      expectedPowerKw: 1,
      expectedPowerSource: 'default' as const,
      name: 'Heater',
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
      currentTarget: 20,
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature' as const,
      binaryCapabilityId: 'onoff' as const,
      currentTemperature: 21,
    };
    let liveDevices: PlanInputDevice[] = [withTemperatureDiscriminant(withBinaryDiscriminant({ currentDrawKw: 0, residualKw: { shed: 0 },
      ...liveDeviceBase,
      binaryControl: { on: true },
      currentOn: true,
      binaryControlObservation: buildBinaryObservation('onoff', true),
    })) as PlanInputDevice];

    const planEngine = {
      // The executor reads its live side from the observer now, so the drift
      // this test is about only exists if the observation says so.
      ...createMockPlanEngine({ getDriftDevices: () => liveDevices }),
      buildDevicePlanSnapshot: vi
        .fn()
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        }))
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
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
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => liveDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveDevices),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    await service.rebuildPlanFromCache('seed_expected_on_state');
    expect(applyPlanActions).toHaveBeenCalledTimes(1);
    applyPlanActions.mockClear();

    liveDevices = [withTemperatureDiscriminant(withBinaryDiscriminant({ currentDrawKw: 0, residualKw: { shed: 0 },
      ...liveDeviceBase,
      binaryControl: { on: false },
      currentOn: false,
      binaryControlObservation: buildBinaryObservation('onoff', false),
    })) as PlanInputDevice];

    // The rebuild itself now closes the gap: plan says keep/on, device reads
    // off, so the executor has work outstanding even though no decision moved.
    await service.rebuildPlanFromCache('detail_only_live_off');
    expect(applyPlanActions).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        }),
      ],
    }));
  });

  it('reuses cached pels status computation when inputs are unchanged', () => {
    const buildPelsStatusSpy = vi.spyOn(pelsStatusModule, 'buildPelsStatus');
    const planService = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: {},
        flow: {},
      } as any,
      planEngine: { ...createMockPlanEngine() } as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => true,
      getCurrentHourPriceLevel: () => ({ cheap: true, expensive: false }),
      getCombinedPrices: () => ({ prices: [{ total: 10 }] }),
      getLastPowerUpdate: () => 123456,
          });

    const plan = {
      meta: buildPlanMeta({ totalKw: null, softLimitKw: 0, headroomKw: 0 }),
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
        return buildPlan(20, 'keep');
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
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      // The pels_status write is what `statusWriteMs` measures; route the injected
      // writer to the same fake-timer-advancing spy the settings.set used to be, so
      // the phase-timing assertion keeps observing the ~7ms status write cost.
      writePelsStatus: settingsSet,
      homey: {
        settings: { set: settingsSet },
        api: { realtime },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: settingsSet },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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

  it('isolates owning-home attribution across concurrent queued rebuilds', async () => {
    const destination = new PassThrough();
    const lines: string[] = [];
    destination.on('data', (chunk: Buffer) => { lines.push(chunk.toString()); });
    setRootLogger(createRootLogger(destination, 'debug'));

    try {
      const serviceFor = (homeId: string) => {
        const scopedOverrides = {
          homeId,
          getCapacityDryRun: () => false,
          planEngine: {
            ...createMockPlanEngine(),
            buildDevicePlanSnapshot: vi.fn(async () => {
              await Promise.resolve();
              getLogger('executor/test').info({
                event: 'home_scoped_descendant_test',
                expectedHomeId: homeId,
              });
              return buildPlan(20, 'keep');
            }),
            computeDynamicSoftLimit: vi.fn(() => 0),
            computeShortfallThreshold: vi.fn(() => 0),
            handleShortfall: vi.fn().mockResolvedValue(undefined),
            handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
            applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0 }),
            applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
          },
        };
        return createPlanService(scopedOverrides).service;
      };
      const homeIds = ['h_area_a', 'h_area_b'];
      const services = homeIds.map(serviceFor);

      await Promise.all(services.map((service) => service.rebuildPlanFromCache('initial')));
      const failingHomeId = 'h_area_failure';
      const failingOverrides = {
        homeId: failingHomeId,
        getCapacityDryRun: () => false,
        planEngine: {
          ...createMockPlanEngine(),
          buildDevicePlanSnapshot: vi.fn().mockRejectedValue(new Error('expected test failure')),
        },
      };
      await createPlanService(failingOverrides).service.rebuildPlanFromCache('failure_test');

      const events = lines.join('').trim().split('\n').map((line) => JSON.parse(line));
      for (const homeId of homeIds) {
        const descendant = events.find((event) => (
          event.event === 'home_scoped_descendant_test'
          && event.expectedHomeId === homeId
        ));
        expect(descendant).toMatchObject({
          homeId,
          rebuildId: expect.any(String),
        });
        expect(events.find((event) => (
          event.event === 'plan_rebuild_completed'
          && event.rebuildId === descendant.rebuildId
        ))).toMatchObject({
          homeId,
          rebuildId: descendant.rebuildId,
        });
      }
      expect(events.find((event) => (
        event.event === 'plan_operation_failed'
        && event.message === 'Failed to rebuild plan'
      ))).toMatchObject({ homeId: failingHomeId });
    } finally {
      setRootLogger(createRootLogger(new PassThrough(), 'silent'));
    }
  });

  it('emits structured rebuild logs for slow rebuilds even without action changes', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      loggers: { structuredLog: structuredLog as any },
    });

    await service.rebuildPlanFromCache('seed');
    structuredLog.info.mockClear();
    (deps.planEngine.buildDevicePlanSnapshot as Mock).mockImplementation(async () => {
      vi.advanceTimersByTime(1501);
      return buildPlan(20, 'keep');
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
    (deps.planEngine.buildDevicePlanSnapshot as Mock).mockResolvedValueOnce(
      buildPlan(20, 'keep', {}, { plannedState: 'shed' }),
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
          .mockResolvedValueOnce(buildPlan(20, 'keep'))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { plannedState: 'shed' })),
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

    expect((deps.planEngine.applyPlanActions as Mock)).toHaveBeenCalled();
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
          .mockResolvedValueOnce(buildPlan(20, 'keep'))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { plannedState: 'shed' })),
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

    expect((deps.planEngine.applyPlanActions as Mock)).toHaveBeenCalled();
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
          .mockResolvedValueOnce(buildPlan(20, 'keep'))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { plannedState: 'shed' })),
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

    expect((deps.planEngine.applyPlanActions as Mock)).toHaveBeenCalled();
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
    (deps.planEngine.buildDevicePlanSnapshot as Mock).mockImplementation(async () => {
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(false),
      } as any,
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
          });

    await service.rebuildPlanFromCache();
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });

  it('retries unchanged stepped-load step-up plans while the reported step is still lower than desired', async () => {
    const steppedPlan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      steppedLoadProfile: {
        steps: [
          { id: 'step_0', planningPowerW: 0 },
          { id: 'step_1', planningPowerW: 1_200 },
          { id: 'step_2', planningPowerW: 1_640 },
        ],
      },
      selectedStepId: 'step_1',
      desiredStepId: 'step_2',
      binaryControl: { on: true },
      currentOn: true,
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
          isSteppedLoadDevice(device)
          && device.plannedState === 'keep'
          && device.selectedStepId !== device.desiredStepId
          && device.stepCommandPending !== true
        ))
      )),
    };
    const liveFixtureDevices: () => PlanInputDevice[] = () => {
        const planDevice = steppedPlan.devices[0];
        const steppedLoadProfile = isSteppedLoadDevice(planDevice)
          ? planDevice.steppedLoadProfile
          : undefined;
        return [steppedInputDevice({
          id: 'dev-1',
          expectedPowerKw: 1,
          name: 'RovikCharger',
          targets: [],
          deviceType: 'onoff',
          binaryCapabilityId: 'onoff',
          steppedLoadProfile,
          selectedStepId: 'step_1',
          desiredStepId: 'step_2',
        })];
      };
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: planEngine as any,
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
          });

    const firstOutcome = await service.rebuildPlanFromCache('power_delta');
    const secondOutcome = await service.rebuildPlanFromCache('power_delta');

    expect(firstOutcome.actionChanged).toBe(true);
    expect(secondOutcome.actionChanged).toBe(false);
    expect(applyPlanActions).toHaveBeenCalledTimes(2);
  });

  it('calls schedulePostActuationRefresh after rebuild actuation', async () => {
    const schedulePostActuationRefresh = vi.fn();
    // Report a real device write so the rebuild resolves `appliedActions: true` —
    // the post-actuation refresh is gated on having actually written.
    const applyPlanActions = vi.fn().mockResolvedValue({ deviceWriteCount: 1, commandRequestCount: 0 });
    const liveFixtureDevices: () => PlanInputDevice[] = () => [{ controllable: true, available: true, currentDrawKw: 0, residualKw: { shed: 0 },
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        confirmedNotDrawing: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      }];
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
      homey: {
        settings: { set: vi.fn() },
        api: { realtime: vi.fn().mockResolvedValue(undefined) },
        flow: {},
      } as any,
      planEngine: {
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          currentTarget: 20,
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
        applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
      } as any,
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
          });

    // The plan wants the device on; it reads off, so the rebuild has work to do.
    await service.rebuildPlanFromCache('post_actuation_refresh');
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
  });

  it('calls schedulePostActuationRefresh after direct shedding actuation', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applySheddingToDevice = vi.fn().mockResolvedValue(true);
    const service = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      writePelsStatus: vi.fn(),
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
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      schedulePostActuationRefresh,
          });

    await service.applySheddingToDevice('dev-1', 'Heater');

    expect(applySheddingToDevice).toHaveBeenCalledWith('dev-1', 'Heater', undefined);
    expect(schedulePostActuationRefresh).not.toHaveBeenCalled();
  });
});
