import { PassThrough } from 'node:stream';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import { invalidateOwningHomeRebuildSuppression } from '../../setup/appObservedControlStateRuntime';
import { subscribePlanObservedState } from '../../setup/appInit/planObservedStateSubscription';
import type { Mock } from 'vitest';
import { PlanService } from '../../lib/plan/planService';
import { partialDouble } from '../helpers/partialDouble';
import type { Logger } from '../../lib/logging/logger';
import type {
  DevicePlan,
  PlanInputDevice,
  BinaryControlDiscriminantProbe,
  MeteredDiscriminantProbe,
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
import { steppedPlanDevice } from '../utils/planTestUtils';
import type { BinaryControlObservation } from '../../packages/contracts/src/types';
import * as pelsStatusModule from '../../lib/plan/pelsStatus';
import { getRecentPlanRebuildTraces } from '../../lib/utils/planRebuildTrace';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { fixtureDeviceReason, insufficientHeadroomFixtureReason } from '../utils/deviceReasonTestUtils';
import { buildBinaryObservation } from '../utils/binaryObservationTestUtils';
import { createMockPlanEngine } from '../utils/planEngineMock';
import { buildDeviceLogEntry } from '../../lib/plan/deviceOverviewLog';
import {
  createRootLogger,
  getLogger,
  setRootLogger,
} from '../../lib/logging/logger';
import type { PendingBinaryLiveDevice } from '../../lib/observer/pendingBinaryCommands';
import { PriceLevel } from '../../lib/price/priceLevels';
import type { PlanActuationResult } from '../../lib/planContract/planActuationResult';
import { executionStateFixture } from '../utils/deviceStatusFixture';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  buildPlanDevice,
  buildPlanMeta,
  fixtureControlPosture,
  openPlanBuildGate,
  steppedInputDevice,
  withFixtureResidualKw,
  type PlanMetaOverrides,
} from '../utils/planTestUtils';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';

type PlanServiceDeps = ConstructorParameters<typeof PlanService>[0];

const stubDepsHomey = (parts: { set?: Mock; realtime?: Mock } = {}): PlanServiceDeps['homey'] => partialDouble<PlanServiceDeps['homey']>({
  settings: partialDouble<PlanServiceDeps['homey']['settings']>({ set: parts.set ?? vi.fn() }),
  api: partialDouble<PlanServiceDeps['homey']['api']>({ realtime: parts.realtime ?? vi.fn().mockResolvedValue(undefined) }),
  flow: partialDouble<PlanServiceDeps['homey']['flow']>({}),
});


// What the executor returns for one plan application; a case overrides the counts it cares about.
const actuation = (counts: Partial<PlanActuationResult> = {}): PlanActuationResult => ({
  deviceWriteCount: 0,
  commandRequestCount: 0,
  deviceApplyFailureCount: 0,
  writtenDeviceIds: [],
  ...counts,
});

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
  metaOverrides: PlanMetaOverrides = {},
  deviceOverrides: Partial<DevicePlan['devices'][number]>
    & BinaryControlDiscriminantProbe
    & TemperatureDiscriminantProbe
    & SteppedDiscriminantProbe
    & MeteredDiscriminantProbe = {},
): DevicePlan => {
  const normalizedReason = typeof reason === 'string' ? fixtureDeviceReason(reason)! : reason;
  return {
    meta: buildPlanMeta({
      totalKw: 1,
      softLimitKw: 5,
      headroomKw: 4,
      ...metaOverrides}),
    devices: [
      withSteppedDiscriminant(withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({
        id: 'dev-1',
        name: 'Heater',
        deviceType: 'temperature' as const,
        isEvCharger: false,
        isBatteryOrSolar: false,
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
      })))) as DevicePlan['devices'][number],
    ],
  };
};

const createPlanService = (overrides: Partial<ConstructorParameters<typeof PlanService>[0]> = {}) => {
  const { loggers: loggerOverrides, ...rest } = overrides;
  const deps = {
    homeId: 'main',
    hasStandingCommandGrant: () => false,
    getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
    getHomeBatteryCard: () => ({ kind: 'none' } as const),
    getObservedEvChargingState: () => ({ kind: 'absent' } as const),
    getObservedTemperature: () => ({ kind: 'absent' } as const),
    planBuildGate: openPlanBuildGate(),
    homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
    publishPelsStatus: vi.fn(),
    planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep')),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
    }),
    getPlanDevices: () => [],
    getSettleDevices: () => [],
    getSteppedSettleDevices: () => [],
    getCapacityDryRun: () => false,
    readSimulationSetting: () => false,
    getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
    getLastPowerUpdate: () => 1_745_000_000_000,
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

  it.each(['main', 'h_11111111'] as const)(
    'refreshes canonical off status for %s without pending commands, rebuilds or decision timestamp changes',
    async (homeId) => {
    const device = steppedPlanDevice({ id: 'connected-300', currentState: 'on', reportedStepId: 'low',
      selectedStepId: 'low', desiredStepId: 'low', plannedState: 'shed',
      plannedShedTargetKind: 'binary_off', shedAction: 'turn_off', reason: { code: 'deferred_objective_avoid' } });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    let live = { ...executionStateFixture(device), desiredBinary: 'off' as const, desiredStepId: null };
    const engine = { ...createMockPlanEngine(), getDeviceExecutionStates: vi.fn(() => new Map([[device.id, live]])) };
    const recorder = new DeviceOverviewLogRecorder();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const { service, deps } = createPlanService({ homeId, emitsUiRealtime: homeId === 'main', planEngine: engine,
      deviceOverviewLogRecorder: recorder, homey: stubDepsHomey({ realtime }) });
    service['rebuildHost'].publishPlan(plan, 456);
    await service.syncLivePlanState('device_update');
    realtime.mockClear();
    live = { ...live, physicalState: 'off', currentDrawKw: 0, binaryProgress: 'settled' };

    expect(await service.syncLivePlanState('device_update')).toBe(true);
    const wire = service.getLatestPlanSnapshotForUi()!;
    const status = wire.devices![0].status;
    expect(status).toMatchObject({ kind: 'held', label: 'Limited · Off', reason: { text: 'Waiting for cheaper hours' },
      rail: { activeIndex: 0 } });
    expect(realtime).toHaveBeenCalledWith(
      homeId === 'main' ? 'plan_updated' : 'plan_status_published',
      homeId === 'main' ? wire : { homeId },
    );
    expect(deps.publishPelsStatus).not.toHaveBeenCalled();
    expect(recorder.getUiPayload().entriesByDeviceId[device.id][0]).toMatchObject({
      stateMsg: status.label, statusMsg: status.reason!.text, stateKind: status.kind });
    expect(service.getLatestPlanSnapshot()).toBe(plan);
    expect(service.getLatestPlanSnapshotUpdatedAtMs()).toBe(456);
    expect(wire.generatedAtMs).toBe(123);
    expect(engine.buildDevicePlanSnapshot).not.toHaveBeenCalled();
    expect(engine.applyPlanActions).not.toHaveBeenCalled();
    expect(await service.syncLivePlanState('device_update')).toBe(false);
    expect(realtime).toHaveBeenCalledTimes(1);
  });

  it.each([
    { homeId: 'main', shown: ['battery-1'] },
    { homeId: 'h_11111111', shown: [] },
  ] as const)('shows a home battery on the overview of $homeId only when it is Main', async ({ homeId, shown }) => {
    const battery = buildPlanDevice({ id: 'battery-1', name: 'Sessy battery', isBatteryOrSolar: true,
      storageHold: 'relief' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [battery] };
    const engine = { ...createMockPlanEngine(),
      getDeviceExecutionStates: vi.fn(() => new Map([[battery.id, executionStateFixture(battery)]])) };
    const getHomeBatteryCard = vi.fn(() => ({
      kind: 'battery' as const,
      drivable: true,
      power: { kind: 'observed' as const, signedW: -2400 },
      level: { kind: 'observed' as const, percent: 64 },
    }));
    const { service } = createPlanService({ homeId, emitsUiRealtime: homeId === 'main', planEngine: engine,
      getHomeBatteryCard });
    service['rebuildHost'].publishPlan(plan, 456);
    await service.syncLivePlanState('realtime_capability');

    const wire = service.getLatestPlanSnapshotForUi()!;
    expect(wire.devices!.map((device) => device.id)).toEqual(shown);
    if (homeId !== 'main') expect(getHomeBatteryCard).not.toHaveBeenCalled();
  });

  it('joins observations queued behind one live sync into a single status build', async () => {
    const device = steppedPlanDevice({ id: 'heater', currentState: 'on', currentDrawKw: 1.2,
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low', plannedState: 'keep' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    const engine = { ...createMockPlanEngine(),
      getDeviceExecutionStates: vi.fn(() => new Map([[device.id, executionStateFixture(device)]])) };
    const { service } = createPlanService({ planEngine: engine });
    service['rebuildHost'].publishPlan(plan, 456);

    const burst = await Promise.all([1, 2, 3].map(() => service.syncLivePlanState('realtime_capability')));

    expect(engine.getDeviceExecutionStates).toHaveBeenCalledTimes(1);
    expect(new Set(burst).size).toBe(1);
    // A sync that has run absorbs nothing: the next observation builds again.
    await service.syncLivePlanState('realtime_capability');
    expect(engine.getDeviceExecutionStates).toHaveBeenCalledTimes(2);
  });

  it('words cards from the Simulation setting, not the transient write fence', async () => {
    const device = buildPlanDevice({ id: 'heater', currentState: 'off', plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.capacity } });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    const engine = { ...createMockPlanEngine(),
      getDeviceExecutionStates: vi.fn(() => new Map([[device.id, executionStateFixture(device)]])) };
    const { service } = createPlanService({ planEngine: engine, getCapacityDryRun: () => true,
      readSimulationSetting: () => false });
    service['rebuildHost'].publishPlan(plan, 456);

    const status = service.getLatestPlanSnapshotForUi()!.devices![0].status;
    expect(status).toMatchObject({ kind: 'held', wouldLimit: false });
    expect(status.reason?.text ?? '').not.toMatch(/simulation/);
  });

  it('logs the decision and executor facts behind a presentation change for debugging only', async () => {
    const device = steppedPlanDevice({ id: 'ev-1', currentState: 'on', plannedState: 'keep',
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'max' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    const engine = { ...createMockPlanEngine(),
      getDeviceExecutionStates: vi.fn(() => new Map([[device.id, { ...executionStateFixture(device),
        stepProgress: 'pending' as const }]])) };
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({ planEngine: engine, overviewDebugStructured,
      isOverviewDebugEnabled: () => true });
    service['rebuildHost'].publishPlan(plan, 456);

    await service.syncLivePlanState('realtime_capability');

    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed', deviceId: 'ev-1', reasonCode: device.reason.code, plannedState: 'keep',
      observedStepId: 'low', desiredStepId: 'max', stepProgress: 'pending',
    }));
    expect(service.getLatestPlanSnapshotForUi()!.devices![0]).not.toHaveProperty('reasonCode');
  });

  it('pushes a fact-only change to the open card without writing an activity-log entry', async () => {
    const device = steppedPlanDevice({ id: 'ev-1', isEvCharger: true, currentState: 'on',
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low', plannedState: 'keep' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    const engine = { ...createMockPlanEngine(),
      getDeviceExecutionStates: vi.fn(() => new Map([[device.id, executionStateFixture(device)]])) };
    let percent = 64;
    const recorder = new DeviceOverviewLogRecorder();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const { service } = createPlanService({ planEngine: engine, deviceOverviewLogRecorder: recorder,
      homey: stubDepsHomey({ realtime }),
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_in_charging' } as const),
      getObservedStateOfCharge: () => ({ kind: 'observed' as const,
        value: { level: stateOfChargeFixture({ percent, observedAtMs: 1_000 }).level } }) });
    service['rebuildHost'].publishPlan(plan, 456);
    await service.syncLivePlanState('realtime_capability');
    realtime.mockClear();
    const loggedBefore = recorder.getUiPayload().entriesByDeviceId[device.id]?.length ?? 0;

    percent = 65;
    expect(await service.syncLivePlanState('realtime_capability')).toBe(true);

    expect(service.getLatestPlanSnapshotForUi()!.devices![0].status.factText).toBe('Charging · 65 % · level Low');
    expect(realtime).toHaveBeenCalledTimes(1);
    expect(recorder.getUiPayload().entriesByDeviceId[device.id]?.length ?? 0).toBe(loggedBefore);
  });

  it('pushes live power to the open card without logging each reading', async () => {
    // A running device's draw wobbles across a 0.1 kW display boundary on most
    // reports; logging each one evicts the control events the log exists for.
    const device = steppedPlanDevice({ id: 'heater', currentState: 'on', currentDrawKw: 1.44,
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low', plannedState: 'keep' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    let live = executionStateFixture(device);
    const engine = { ...createMockPlanEngine(), getDeviceExecutionStates: vi.fn(() => new Map([[device.id, live]])) };
    const recorder = new DeviceOverviewLogRecorder();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const { service } = createPlanService({ planEngine: engine, deviceOverviewLogRecorder: recorder,
      homey: stubDepsHomey({ realtime }) });
    service['rebuildHost'].publishPlan(plan, 456);
    await service.syncLivePlanState('realtime_capability');
    realtime.mockClear();
    const loggedBefore = recorder.getUiPayload().entriesByDeviceId[device.id]?.length ?? 0;

    for (const drawKw of [1.46, 1.44, 1.46]) {
      live = { ...live, currentDrawKw: drawKw };
      expect(await service.syncLivePlanState('realtime_capability')).toBe(true);
    }

    expect(service.getLatestPlanSnapshotForUi()!.devices![0].status.powerText).toBe('1.5 kW');
    expect(realtime).toHaveBeenCalledTimes(3);
    expect(recorder.getUiPayload().entriesByDeviceId[device.id]?.length ?? 0).toBe(loggedBefore);
  });

  it('classifies idleness from the plan device, not from executor convergence state', () => {
    // Stall evidence feeds smart tasks, a decision input: the classifier reads
    // the observation the plan was built from, never the executor's view.
    const device = steppedPlanDevice({ id: 'heater', currentState: 'on', currentDrawKw: 1.2,
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low', plannedState: 'keep' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    const engine = { ...createMockPlanEngine(), getDeviceExecutionStates: vi.fn(() => new Map([[device.id, {
      ...executionStateFixture(device), physicalState: 'off' as const, currentDrawKw: 0 }]])) };
    const { service } = createPlanService({ planEngine: engine });
    const classifyAll = vi.spyOn(service['idleClassifier'], 'classifyAll');

    service['tickIdleClassifier'](plan);

    expect(classifyAll).toHaveBeenCalledWith([expect.objectContaining({
      id: 'heater', currentState: 'on', currentDrawKw: 1.2, plannedState: 'keep' })], expect.any(Number));
    expect(engine.getDeviceExecutionStates).not.toHaveBeenCalled();
  });

  it('leaves the idle classifier on the plan cadence when observations refresh status', async () => {
    // The capped-idle window keeps a bounded sample history sized for the plan
    // cadence. Observations arrive far more often; sampling on each would push
    // the first half of the window out and make capped idle unreachable.
    const device = steppedPlanDevice({ id: 'heater', currentState: 'on', currentDrawKw: 1.2,
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low', plannedState: 'keep' });
    const plan: DevicePlan = { generatedAtMs: 123, meta: buildPlanMeta({}), devices: [device] };
    let live = executionStateFixture(device);
    const engine = { ...createMockPlanEngine(), getDeviceExecutionStates: vi.fn(() => new Map([[device.id, live]])) };
    const { service } = createPlanService({ planEngine: engine });
    service['rebuildHost'].publishPlan(plan, 456);
    const classifyAll = vi.spyOn(service['idleClassifier'], 'classifyAll');

    for (const drawKw of [1.1, 0, 0.9, 0, 1.3]) {
      live = { ...live, currentDrawKw: drawKw };
      await service.syncLivePlanState('realtime_capability');
    }

    expect(classifyAll).not.toHaveBeenCalled();
  });

  // A pending-target republish is the built plan under a new reference, with
  // the build's draw. Sampling it would record that draw again as a reading.
  it('does not sample the idle classifier when a pending target command settles', async () => {
    const plan = buildPlan(18, 'keep', {}, { currentDrawKw: 0 });
    let pendingTarget = true;
    const engine = {
      ...createMockPlanEngine(),
      hasPendingTargetCommands: vi.fn(() => pendingTarget),
      syncPendingTargetCommands: vi.fn(() => {
        pendingTarget = false;
        return true;
      }),
      decoratePlanWithPendingTargetCommands: vi.fn((current: DevicePlan): DevicePlan => ({
        ...current,
        devices: current.devices.map((device) => ({ ...device, pendingTargetCommand: undefined })),
      })),
    };
    const { service } = createPlanService({ planEngine: engine });
    service['rebuildHost'].publishPlan({
      ...plan,
      devices: plan.devices.map((device) => ({ ...device, pendingTargetCommand: {
        desired: 20, retryCount: 0, nextRetryAtMs: Date.now() + 30_000, status: 'waiting_confirmation' as const,
        lastObservedValue: 18, lastObservedSource: 'rebuild' as const,
      } })),
    }, Date.now());
    const classifyAll = vi.spyOn(service['idleClassifier'], 'classifyAll');

    await expect(service.syncLivePlanState('realtime_capability')).resolves.toBe(true);

    expect(service.getLatestPlanSnapshot()?.devices[0]?.pendingTargetCommand).toBeUndefined();
    expect(classifyAll).not.toHaveBeenCalled();
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
      applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: observedTarget, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta');
    await service.rebuildPlanFromCache('power_delta');

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    const latestDevice = service.getLatestPlanSnapshot()?.devices[0];
    expect(latestDevice && isTemperaturePlanDevice(latestDevice) ? latestDevice.currentTarget : undefined).toBe(21);

    const planUpdatedCalls = realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated');
    expect(planUpdatedCalls).toHaveLength(2);
    expect(planUpdatedCalls[0][1].devices[0].status.factText).toContain('target 19 °C');
    expect(planUpdatedCalls[1][1].devices[0].status.factText).toContain('target 21 °C');
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
      applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    await service.rebuildPlanFromCache('power_delta');
    settingsSet.mockClear();
    realtime.mockClear();
    overviewDebugStructured.mockClear();

    await service.rebuildPlanFromCache('power_delta');

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
        withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0,
          recordRestoreOnTargetApply: false,
          binaryCommandPending: false,
          id: 'dev-1',
          name: 'Heater 1',
          commandableNow: true,
          objectiveSessionInactive: false,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          surplusTracking: false,
          confirmedNotDrawing: false,
          isEvCharger: false,
          isBatteryOrSolar: false,
          storageHold: 'none' as const,
          deviceType: 'onoff' as const,
          binaryCapabilityId: 'onoff' as const,
          binaryControl: { on: false },
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed' as const,
          boostActive: false,
          control: fixtureControlPosture({ controllable: true }),
          available: true,
          reason: insufficientHeadroomFixtureReason({ needKw: 0.98, availableKw: -0.97 }),
        }))) as DevicePlan['devices'][number],
        withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0,
          recordRestoreOnTargetApply: false,
          binaryCommandPending: false,
          id: 'dev-2',
          name: 'Heater 2',
          commandableNow: true,
          objectiveSessionInactive: false,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          surplusTracking: false,
          confirmedNotDrawing: false,
          isEvCharger: false,
          isBatteryOrSolar: false,
          storageHold: 'none' as const,
          deviceType: 'onoff' as const,
          binaryCapabilityId: 'onoff' as const,
          binaryControl: { on: false },
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed' as const,
          boostActive: false,
          control: fixtureControlPosture({ controllable: true }),
          available: true,
          reason: insufficientHeadroomFixtureReason({ needKw: 1.1, availableKw: -0.97 }),
        }))) as DevicePlan['devices'][number],
        withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0,
          recordRestoreOnTargetApply: false,
          binaryCommandPending: false,
          id: 'ev-1',
          name: 'EV',
          commandableNow: true,
          objectiveSessionInactive: false,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          surplusTracking: false,
          confirmedNotDrawing: false,
          isEvCharger: false,
          isBatteryOrSolar: false,
          storageHold: 'none' as const,
          deviceType: 'onoff' as const,
          binaryCapabilityId: 'onoff' as const,
          binaryControl: { on: false },
          currentOn: false,
          currentState: 'off',
          plannedState: 'inactive' as const,
          boostActive: false,
          control: fixtureControlPosture({ controllable: true }),
          available: true,
          reason: fixtureDeviceReason('inactive (charger is unplugged)')!,
        }))) as DevicePlan['devices'][number],
      ],
    };
    const debugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(summaryPlan)
          .mockResolvedValueOnce(summaryPlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
      }),
      loggers: { debugStructured },
    });

    await service.rebuildPlanFromCache('power_delta');
    await service.rebuildPlanFromCache('power_delta');

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
      restoreBlockedReasons: [{ reasonCode: 'insufficient_headroom', count: 2 }],
      inactiveCount: 1,
      inactiveReasons: [{ reasonCode: 'inactive', detail: 'charger is unplugged', count: 1 }],
    });
  });

  it('logs overview changes on rebuild using the shared formatter output', async () => {
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          currentDrawKw: 0,
          expectedPowerKw: 3,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache('power_delta');

    const overview = buildDeviceLogEntry(service.getLatestPlanSnapshotForUi()!.devices![0]);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      component: 'overview',
      event: 'device_overview_changed',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      ...overview,
      currentDrawKw: 0,
    }));
  });

  it('captures device-log entries even when the overview debug log is disabled', async () => {
    const recorder = new DeviceOverviewLogRecorder();
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          currentDrawKw: 0,
          expectedPowerKw: 3,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
      isOverviewDebugEnabled: () => false,
      deviceOverviewLogRecorder: recorder,
    });

    await service.rebuildPlanFromCache('power_delta');

    // Debug log is gated off, but the recorder still captured the entry.
    expect(overviewDebugStructured).not.toHaveBeenCalled();
    const overview = buildDeviceLogEntry(service.getLatestPlanSnapshotForUi()!.devices![0]);
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
      currentDrawKw: 0,
      expectedPowerKw: 3,
    });
    plan.devices.push(withBinaryDiscriminant(withFixtureResidualKw({
      ...plan.devices[0],
      id: 'dev-2',
      name: 'Bedroom',
      currentState: 'off',
      binaryControl: { on: false },
      currentOn: false,
      plannedState: 'shed' as const,
      boostActive: false,
      currentDrawKw: 0,
      expectedPowerKw: 1.2,
      reason: fixtureDeviceReason('shed due to capacity')!,
    })) as DevicePlan['devices'][number]);
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(plan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache('power_delta');

    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      component: 'overview',
      event: 'device_overview_changes',
      changedDeviceCount: 2,
      devices: [
        expect.objectContaining({
          event: 'device_overview_changed',
          deviceId: 'dev-1',
          stateMsg: 'Running',
          powerMsg: '≈ 3.0 kW when active',
        }),
        expect.objectContaining({
          event: 'device_overview_changed',
          deviceId: 'dev-2',
          stateMsg: 'Limited · Off',
          powerMsg: '≈ 1.2 kW when active',
        }),
      ],
    }));
  });

  it('logs the confirmed reported step in overview events', async () => {
    const overviewDebugStructured = vi.fn();
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          // Stepped is the profile-presence capability (the planner no longer reads
          // controlModel); a real stepped device always carries the profile.
          steppedLoadProfile: { steps: [{ id: 'max', planningPowerW: 3000 }] },
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          currentDrawKw: 0,
          planningPowerKw: 3,
          reportedStepId: 'max',
          targetStepId: 'max',
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache('power_delta');

    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed',
      usageMsg: 'Level Max',
    }));
  });

  it('does not log repeated identical overview snapshots', async () => {
    const overviewDebugStructured = vi.fn();
    const samePlan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      currentDrawKw: 0,
      expectedPowerKw: 3,
    });
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValueOnce(samePlan).mockResolvedValueOnce(samePlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache('power_delta');
    await service.rebuildPlanFromCache('power_delta');

    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
  });

  it('logs on usage-only overview changes during rebuilds', async () => {
    const overviewDebugStructured = vi.fn();
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const { service } = createPlanService({
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn()
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
            currentState: 'on',
            plannedState: 'keep',
            boostActive: false,
            currentDrawKw: 0,
            expectedPowerKw: 3,
          }))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
            currentState: 'on',
            plannedState: 'keep',
            boostActive: false,
            currentDrawKw: 0.25,
            expectedPowerKw: 3,
          })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache('power_delta');
    overviewDebugStructured.mockClear();
    settingsSet.mockClear();
    realtime.mockClear();

    await service.rebuildPlanFromCache('power_delta');
    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed',
      powerMsg: '0.3 kW',
      currentDrawKw: 0.25,
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
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(cooldownPlan)
          .mockResolvedValueOnce(cooldownTickPlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured,
    });

    await service.rebuildPlanFromCache('power_delta');
    overviewDebugStructured.mockClear();
    settingsSet.mockClear();
    realtime.mockClear();

    vi.advanceTimersByTime(6_000);
    await service.rebuildPlanFromCache('power_delta');

    expect(overviewDebugStructured).not.toHaveBeenCalled();
    expect(settingsSet.mock.calls.filter((call: unknown[]) => call[0] === LEGACY_PLAN_SNAPSHOT_SETTING)).toHaveLength(0);
    expect(realtime.mock.calls.filter((call: unknown[]) => call[0] === 'plan_updated')).toHaveLength(0);
  });

  it('retains publication signatures even when debug logging is unavailable', async () => {
    const samePlan = buildPlan(20, 'keep', {}, {
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      currentDrawKw: 0,
      expectedPowerKw: 3,
    });
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(samePlan),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
      }),
      overviewDebugStructured: undefined,
      isOverviewDebugEnabled: () => true,
    });

    await service.rebuildPlanFromCache('power_delta');

    expect(service['overviewTransitions']['presentationById'].size).toBe(1);
  });

  it('logs overview changes during live sync when a visible field changes', async () => {
    const overviewDebugStructured = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    let liveOn = false;
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({
        control: fixtureControlPosture({ controllable: true }), available: true,
        id: 'dev-1',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: liveOn },
        currentOn: liveOn,
        currentTemperature: 21,
        currentDrawKw: liveOn ? 0.25 : 0,
        expectedPowerKw: 3, expectedPowerSource: 'default',
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        syncSteppedCommands: () => false,
        syncStorageCommands: () => undefined,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    const publishedPlan = buildPlan(20, 'keep', {}, {
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      currentDrawKw: 0,
      expectedPowerKw: 3,
    });
    service['rebuildHost'].publishPlan(publishedPlan, Date.now());
    service['emitPlanUpdated'](publishedPlan);
    overviewDebugStructured.mockClear();
    // The device turns on after the plan was published.
    liveOn = true;

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);
    expect(overviewDebugStructured).toHaveBeenCalledTimes(1);
    expect(overviewDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_overview_changed',
      stateMsg: 'Running',
      powerMsg: '0.3 kW',
      statusMsg: '',
    }));
    // The card moved; the plan did not. Observations reach the overview from
    // the executor, never by being merged onto the published plan.
    expect(service.getLatestPlanSnapshot()).toBe(publishedPlan);
  });

  it('serializes enriched UI plan fields without changing the runtime snapshot', () => {
    const { service } = createPlanService({
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
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
        priority: 3,
        budgetExempt: false,
        currentTemperature: 16,
        currentDrawKw: 1.2,
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
    service['rebuildHost'].publishPlan(runtimePlan, Date.now());

    expect(service.getLatestPlanSnapshot()).toBe(runtimePlan);
    expect(service.getLatestPlanSnapshotForUi()).toEqual({
      generatedAtMs: undefined,
      meta: expect.objectContaining({
        totalKw: 6.2,
        softLimitKw: 5,
        // The wire carries the signal, never a headroom: the hero derives its
        // above-safe-pace state from the two numbers it prints.
        powerIsMeasured: true,
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
          // The producer-resolved identity the overview forwards; it no longer
          // carries the inventory class.
          isEvCharger: false,
          status: expect.objectContaining({ kind: 'held', tone: 'held', cardKind: 'temperature' }),
          starvation: {
            isStarved: true,
            accumulatedMs: 30 * 60 * 1000,
          },
        }),
      ],
    });
  });

  it('logs the post-actuation overview transition when the device observation arrives', async () => {
    let currentOn = false;
    const overviewDebugStructured = vi.fn();
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentOn: currentOn,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          currentTarget: 20,
          currentTemperature: 20,
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
          return actuation({ deviceWriteCount: 1 });
        }),
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
            overviewDebugStructured,
      isOverviewDebugEnabled: () => true,
    });

    await service.rebuildPlanFromCache('power_delta');
    // The device reports the restore landing: an observed-state change, which
    // production routes into the live sync.
    await service.syncLivePlanState('device_update');

    expect(overviewDebugStructured).toHaveBeenCalledTimes(2);
    expect(overviewDebugStructured.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      event: 'device_overview_changed',
      stateMsg: 'Resuming',
    }));
    expect(overviewDebugStructured.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      event: 'device_overview_changed',
      stateMsg: 'Running',
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
      applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta');
    await service.rebuildPlanFromCache('power_delta');

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
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(19, 'keep')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
      }),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
          });

    await service.rebuildPlanFromCache('power_delta');
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
      applyPlanActions: vi.fn().mockResolvedValue(actuation()),
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta');
    await service.rebuildPlanFromCache('power_delta');

    expect(settingsSet).not.toHaveBeenCalledWith(LEGACY_PLAN_SNAPSHOT_SETTING, expect.anything());
    expect(service.getLatestPlanSnapshot()?.meta.totalKw).toBe(1.2);
  });

  it('does not publish drifted live state as the committed snapshot', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(actuation());
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    service['rebuildHost'].publishPlan(buildPlan(20, 'keep', {}, {
      currentState: 'on',
      currentTarget: 20,
      currentTemperature: 20,
      plannedState: 'keep',
      boostActive: false,
      plannedTarget: 20,
    }), Date.now());

    // `syncLivePlanState` must not publish drifted live state as the committed
    // snapshot: the device reads off while the plan wants it on, which is NOT a
    // settled actuation, so the stored snapshot keeps saying `on` and the
    // live presentation can refresh independently. (Convergence itself is the rebuild's job — see
    // 'actuates on a detail-only rebuild when the device drifted from plan
    // intent', and the per-shape drift coverage in executorConvergence.test.ts.)
    await expect(service.syncLivePlanState('device_update')).resolves.toBe(true);
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
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [expect.objectContaining({ status: expect.objectContaining({ kind: 'resuming' }) })],
    }));
  });

  it('aborts the rebuild (no actuation) when the abort predicate reports a stale revision', async () => {
    // The live onoff state diverges from what the plan intends, so this rebuild
    // WOULD actuate. But `rebuildPlanFromCache` only enqueues; by the time the
    // queued body runs, the caller's precondition (a sub-home ready-edge's
    // meter-sample revision) may have moved. The abort predicate — checked inside
    // the queued body, at the point of use — must prevent the now-stale actuation
    // (R7b P1 TOCTOU), and `onAbort` must fire so the caller can tell an abort
    // from an ordinary no-op.
    const applyPlanActions = vi.fn().mockResolvedValue(actuation());
    const onAbort = vi.fn();
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
    });

    service['rebuildHost'].publishPlan(buildPlan(20, 'keep', {}, {
      currentState: 'on',
      currentTarget: 20,
      currentTemperature: 20,
      plannedState: 'keep',
      boostActive: false,
      plannedTarget: 20,
    }), Date.now());

    // Predicate reports the revision moved → the rebuild aborts before planning
    // or touching devices.
    const outcome = await service.rebuildPlanFromCache('power_delta', {
      detail: 'stale_revision', shouldAbort: () => true, onAbort,
    });
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(outcome.failed).toBe(false);
    expect(outcome.appliedActions).toBe(false);
    expect(applyPlanActions).not.toHaveBeenCalled();
  });


  it('keeps the observed target stale while exposing pending confirmation state', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    const decoratePlanWithPendingTargetCommands = vi.fn((plan: DevicePlan): DevicePlan => ({
      ...plan,
      devices: plan.devices.map((device) => ({
        ...device,
        pendingTargetCommand: {
          desired: 20,
          retryCount: 0,
          nextRetryAtMs: Date.now() + 30_000,
          status: 'waiting_confirmation' as const,
          lastObservedValue: 18,
          lastObservedSource: 'snapshot_refresh' as const,
        },
      })),
    }));

    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 18,
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: 18, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        hasPendingTargetCommands: vi.fn(() => true),
        syncPendingTargetCommands: vi.fn(() => true),
        decoratePlanWithPendingTargetCommands,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    service['rebuildHost'].publishPlan(buildPlan(18, 'keep'), Date.now());

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
        expect.objectContaining({ id: 'dev-1', status: expect.objectContaining({ cardKind: 'temperature', factText: expect.stringContaining('target '+18+' °C') }) }),
      ],
    }));
  });

  it('clears a confirmed pending target command and reads the setpoint live', async () => {
    const settingsSet = vi.fn();
    const realtime = vi.fn().mockResolvedValue(undefined);
    let hasPendingTargetCommands = true;
    const decoratePlanWithPendingTargetCommands = vi.fn((plan: DevicePlan): DevicePlan => ({
      ...plan,
      devices: plan.devices.map((device) => ({
        ...device,
        pendingTargetCommand: hasPendingTargetCommands
          ? {
            desired: 20,
            retryCount: 0,
            nextRetryAtMs: Date.now() + 30_000,
            status: 'waiting_confirmation' as const,
            lastObservedValue: 18,
            lastObservedSource: 'rebuild' as const,
          }
          : undefined,
      })),
    }));

    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({
        kind: 'observed',
        value: { currentTarget: 20, currentTemperature: 21 },
      }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        hasPendingTargetCommands: vi.fn(() => hasPendingTargetCommands),
        syncPendingTargetCommands: vi.fn(() => {
          hasPendingTargetCommands = false;
          return true;
        }),
        decoratePlanWithPendingTargetCommands,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    service['rebuildHost'].publishPlan(decoratePlanWithPendingTargetCommands(buildPlan(18, 'keep')), Date.now());

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);
    // The pending-command decoration is re-applied; the decided device is not
    // re-sourced from live input. The card reads the setpoint from the observer.
    expect(service.getLatestPlanSnapshot()?.devices[0]).toMatchObject({ id: 'dev-1', currentTarget: 18 });
    expect(service.getLatestPlanSnapshot()?.devices[0].pendingTargetCommand).toBeUndefined();
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({ id: 'dev-1', status: expect.objectContaining({ cardKind: 'temperature', factText: expect.stringContaining('target '+20+' °C') }) }),
      ],
    }));
  });

  it('keeps the published plan and its generatedAtMs when live sync re-renders status', async () => {
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        hasPendingBinaryCommands: vi.fn(() => true),
        syncPendingBinaryCommands: vi.fn(() => false),
        syncSteppedCommands: () => false,
        syncStorageCommands: () => undefined,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    const publishedPlan = {
      ...buildPlan(20, 'meter settling (30s remaining)', {}, {
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
      }),
      generatedAtMs: Date.parse('2026-02-06T23:59:30.000Z'),
    };
    service['rebuildHost'].publishPlan(publishedPlan, Date.now());

    vi.setSystemTime(new Date('2026-02-07T00:00:10.000Z'));

    await expect(service.syncLivePlanState('snapshot_refresh')).resolves.toBe(true);

    expect(service.getLatestPlanSnapshot()).toBe(publishedPlan);
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      generatedAtMs: Date.parse('2026-02-06T23:59:30.000Z'),
      devices: [
        expect.objectContaining({ id: 'dev-1', status: expect.objectContaining({ kind: 'held', label: 'Limited · Off' }) }),
      ],
    }));
  });


  it('re-renders status from live state when a pending binary command is confirmed', async () => {
    let hasPendingBinaryCommands = true;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn(),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        hasPendingBinaryCommands: vi.fn(() => hasPendingBinaryCommands),
        syncPendingBinaryCommands: vi.fn(() => {
          hasPendingBinaryCommands = false;
          return true;
        }),
        syncSteppedCommands: () => false,
        syncStorageCommands: () => undefined,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    const publishedPlan = buildPlan(20, 'cooldown (restore, 30s remaining)', {}, {
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      currentTarget: 20,
      currentTemperature: 20,
      plannedTarget: 20,
    });
    service['rebuildHost'].publishPlan(publishedPlan, Date.now());

    await expect(service.syncLivePlanState('device_update')).resolves.toBe(true);
    expect(service.getLatestPlanSnapshot()).toBe(publishedPlan);
    expect(realtime).toHaveBeenCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({ id: 'dev-1', status: expect.objectContaining({ kind: 'held', label: 'Limited · Off' }) }),
      ],
    }));
  });


  it('says which devices can change the actionable load, task grants included', () => {
    const { service } = createPlanService({ hasStandingCommandGrant: (deviceId) => deviceId === 'charger-1' });
    // A standing grant answers with no plan, and for a device the plan does not
    // carry: an ordinary device with no power reading is not planned at all.
    expect(service.canDeviceChangeActionableLoad('charger-1')).toBe(true);
    expect(service.canDeviceChangeActionableLoad('dev-1')).toBe(false);

    // Authority with no standing grant behind it: a smart task's.
    service['rebuildHost'].publishPlan(buildPlan(20, 'keep', {}, {
      control: { managed: true, commandAuthority: true },
      currentDrawKw: 1,
    }), Date.now());
    expect(service.canDeviceChangeActionableLoad('dev-1')).toBe(true);
    expect(service.canDeviceChangeActionableLoad('charger-1')).toBe(true);
    expect(service.canDeviceChangeActionableLoad('absent')).toBe(false);

    service['rebuildHost'].publishPlan(buildPlan(20, 'capacity control off', {}, {
      control: { managed: true, commandAuthority: false },
      currentDrawKw: 1,
    }), Date.now());
    expect(service.canDeviceChangeActionableLoad('dev-1')).toBe(false);
  });

  // End to end from the observation lane: a charger with Power-limit control
  // on and no power reading is not in the plan, so only the standing grant can
  // tell its first reading falsifies a "nothing is actionable" verdict.
  it('lets an unplanned power-limited device clear the throttle with its first reading', () => {
    const { service } = createPlanService({ hasStandingCommandGrant: (deviceId) => deviceId === 'charger-1' });
    service['rebuildHost'].publishPlan(buildPlan(20, 'keep'), Date.now());
    const ctx = createAppContextMock({ planService: service });
    const onObservation = vi.spyOn(ctx.planRebuildThrottle, 'onObservation');
    const emitter = new ObservedStateEmitter();
    subscribePlanObservedState({
      ctx,
      getObservedStateEmitter: () => emitter,
      getHomeRuntimeRegistry: () => undefined,
      syncLivePlanState: () => Promise.resolve(false),
      syncExternalOffHold: vi.fn(),
      invalidateRebuildSuppression: (deviceId) => invalidateOwningHomeRebuildSuppression({ ctx, deviceId }),
    });

    emitter.emitObservedStateChanged({
      deviceId: 'charger-1', source: 'realtime_capability', measurePowerBecameSignificantlyPositive: true,
    });
    emitter.emitObservedStateChanged({
      deviceId: 'lamp-1', source: 'realtime_capability', measurePowerBecameSignificantlyPositive: true,
    });

    expect(onObservation).toHaveBeenCalledTimes(1);
  });

  // Prod 2026-10-01: an EV charger with Power-limit control off, driven by a
  // smart task, read "Manual" after nearly every settled step change. The live
  // planner input predates deferred admission, so it carries no task grant; a
  // live sync that merged it onto the published plan replaced the plan's
  // authority with it until the next rebuild.
  it('keeps a smart task\'s command authority when live sync runs after a confirmed command', async () => {
    let hasPendingBinaryCommands = true;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({
        // The raw input: Power-limit control off, no grant yet.
        control: { managed: true, commandAuthority: false },
        available: true,
        currentDrawKw: 2,
        id: 'dev-1',
        expectedPowerKw: 2, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 19,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn(),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        hasPendingBinaryCommands: vi.fn(() => hasPendingBinaryCommands),
        syncPendingBinaryCommands: vi.fn(() => {
          hasPendingBinaryCommands = false;
          return true;
        }),
        syncSteppedCommands: () => false,
        syncStorageCommands: () => undefined,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
    });

    // Built after admission: the task lent PELS authority and the plan resumed
    // the device, which the confirmed command has now turned on.
    service['rebuildHost'].publishPlan(buildPlan(20, 'keep', {}, {
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      control: { managed: true, commandAuthority: true },
    }), Date.now());

    await expect(service.syncLivePlanState('device_update')).resolves.toBe(true);
    expect(service.getLatestPlanSnapshot()?.devices[0]?.control.commandAuthority).toBe(true);
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          controllable: true,
          status: expect.objectContaining({ kind: 'active', label: 'Running' }),
        }),
      ],
    }));
  });

  it('shows a settled actuation from live state while the plan stays as built', async () => {
    let currentOn = false;
    const realtime = vi.fn().mockResolvedValue(undefined);
    const applyPlanActions = vi.fn().mockImplementation(async () => {
      currentOn = true;
      return actuation();
    });
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: currentOn },
        currentOn: currentOn,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine({ getDriftDevices: liveFixtureDevices }),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          currentTarget: 20,
          currentTemperature: 20,
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta');
    await service.syncLivePlanState('device_update');

    // The plan records the observation it was decided from; the card shows
    // the device as it is now.
    expect(service.getLatestPlanSnapshot()).toEqual(expect.objectContaining({
      devices: [
        expect.objectContaining({
          id: 'dev-1',
          currentState: 'off',
          plannedState: 'keep',
          plannedTarget: 20,
        }),
      ],
    }));
    expect(realtime).toHaveBeenLastCalledWith('plan_updated', expect.objectContaining({
      devices: [
        expect.objectContaining({ id: 'dev-1', status: expect.objectContaining({ kind: 'active' }) }),
      ],
    }));
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
      applyPlanActions: vi.fn().mockResolvedValue(actuation()),
      hasPendingTargetCommands: vi.fn(() => true),
      syncPendingTargetCommands,
      decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
    };
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: true },
        currentOn: true,
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    const rebuildPromise = service.rebuildPlanFromCache('power_delta', { detail: 'serialize_rebuild' });
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
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot,
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        syncPendingTargetCommands,
        syncPendingBinaryCommands,
        prunePendingTargetCommands: vi.fn(() => false),
        decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
      }),
      getPlanDevices,
      // Settle reads its own source in production (the device snapshot); provide one here
      // (a separate fn, same devices) so the binary-settle fallback does not double-count
      // the `getPlanDevices` spy.
      getSettleDevices: () => unavailableBinaryConfirmations(firstLiveDevices),
      getCapacityDryRun: () => true,
      readSimulationSetting: () => true,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta', { detail: 'capture_live_devices_once' });

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
    const buildLiveDevice = (binaryControlObservation: BinaryControlObservation) => (withFixtureResidualKw({
      control: fixtureControlPosture({ controllable: true }), available: true,
      id: 'dev-1',
      expectedPowerKw: 1,
      expectedPowerSource: 'default' as const,
      name: 'Heater',
      currentDrawKw: 0,
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      isEvCharger: false,
      isBatteryOrSolar: false,
      starvationSupported: false,
      currentTarget: 20,
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature' as const,
      binaryCapabilityId: 'onoff' as const,
      currentOn: binaryControlObservation.observedValue,
      currentTemperature: 21,
      binaryControlObservation,
    }));
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
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation()),
        hasPendingBinaryCommands: vi.fn(() => true),
        syncPendingBinaryCommands,
        prunePendingTargetCommands: vi.fn(() => false),
        decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
      }),
      getPlanDevices: () => liveDevices,
      getSettleDevices: () => settleDevices,
      getCapacityDryRun: () => true,
      readSimulationSetting: () => true,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta', { detail: 'binary_evidence_snapshot_refresh' });
    expect(syncPendingBinaryCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        binaryCommandConfirmation: expect.objectContaining({
          state: 'observed',
          observedValue: true,
        }),
      }),
    ], 'rebuild');

    service['rebuildHost'].publishPlan(buildPlan(20, 'keep', {}, { binaryCommandPending: true }), Date.now());
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
    const applyPlanActions = vi.fn().mockResolvedValue(actuation());
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
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta', { detail: 'test_identical.first' });
    await service.rebuildPlanFromCache('power_delta', { detail: 'test_identical.second' });

    expect(applyPlanActions).toHaveBeenCalledTimes(1);
  });

  // A rebuild whose ACTION signature is unchanged must still actuate when the
  // device has drifted away from what that plan wants. Before the apply gate
  // widened, this case fell through to the reconcile lane, which re-asserted a
  // plan built against the older observation — the shape behind inc_26449fb9.
  it('does not actuate on drift the plan never saw, when the observer moved mid-build', async () => {
    // The window is real: `buildPlanForRebuild` awaits `buildDevicePlanSnapshot`,
    // so a realtime capability event can land after the build inputs are
    // captured and before the apply step asks whether work is outstanding.
    //
    // Acting on that newer observation would apply a plan that was never decided
    // against it — the same shape as re-asserting a committed plan, which
    // breached the hard cap in production (inc_26449fb9). The observation that
    // moved is itself a rebuild trigger; the re-decide is the honest answer, so
    // this cycle must decline.
    const applyPlanActions = vi.fn().mockResolvedValue(actuation());
    const liveDeviceBase = {
      control: fixtureControlPosture({ controllable: true }), available: true,
      id: 'dev-1',
      expectedPowerKw: 1,
      expectedPowerSource: 'default' as const,
      name: 'Heater',
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      isEvCharger: false,
      isBatteryOrSolar: false,
      starvationSupported: false,
      currentTarget: 20,
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature' as const,
      binaryCapabilityId: 'onoff' as const,
      currentTemperature: 21,
    };
    // Observed OFF against a plan that keeps it on — genuine drift, and the only
    // reason this cycle would actuate at all.
    const liveDevices: PlanInputDevice[] = [withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({
      currentDrawKw: 0,
      ...liveDeviceBase,
      binaryControl: { on: false },
      currentOn: false,
      binaryControlObservation: buildBinaryObservation('onoff', false),
    }))) as PlanInputDevice];

    // Advances exactly once, standing in for an observation accepted while the
    // build was awaiting.
    let revision = 0;
    const planEngine = {
      ...createMockPlanEngine({
        getDriftDevices: () => liveDevices,
        getObservationRevision: () => revision,
      }),
      buildDevicePlanSnapshot: vi.fn()
        // Seed cycle: the plan is new, so it actuates on changed actions and
        // never consults drift. The world holds still through it.
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
          currentTemperature: 20,
        }))
        // Second cycle: decisions are unchanged, so drift is the only thing that
        // could trigger an apply — and an observation lands while this build is
        // awaiting.
        .mockImplementationOnce(async () => {
          revision += 1;
          return buildPlan(20, 'keep', {}, {
            currentState: 'off',
            plannedState: 'keep',
            boostActive: false,
            plannedTarget: 20,
            currentTemperature: 20,
          });
        }),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => liveDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveDevices),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
    });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed_expected_on_state' });
    applyPlanActions.mockClear();

    await service.rebuildPlanFromCache('power_delta', { detail: 'observer_moved_mid_build' });

    // Drift WOULD have reported work — the device reads off against a keep plan.
    // The epoch gate is what declines it.
    expect(planEngine.hasExecutionWorkOutstanding).toHaveReturnedWith(false);
    expect(applyPlanActions).not.toHaveBeenCalled();
  });

  it('actuates on a detail-only rebuild when the device drifted from plan intent', async () => {
    const applyPlanActions = vi.fn().mockResolvedValue(actuation());
    const liveDeviceBase = {
      control: fixtureControlPosture({ controllable: true }), available: true,
      id: 'dev-1',
      expectedPowerKw: 1,
      expectedPowerSource: 'default' as const,
      name: 'Heater',
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      isEvCharger: false,
      isBatteryOrSolar: false,
      starvationSupported: false,
      currentTarget: 20,
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      deviceType: 'temperature' as const,
      binaryCapabilityId: 'onoff' as const,
      currentTemperature: 21,
    };
    let liveDevices: PlanInputDevice[] = [withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ currentDrawKw: 0,
      ...liveDeviceBase,
      binaryControl: { on: true },
      currentOn: true,
      binaryControlObservation: buildBinaryObservation('onoff', true),
    }))) as PlanInputDevice];

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
          currentTemperature: 20,
        }))
        .mockResolvedValueOnce(buildPlan(20, 'keep', {}, {
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
          currentTemperature: 20,
        })),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => liveDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveDevices),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed_expected_on_state' });
    expect(applyPlanActions).toHaveBeenCalledTimes(1);
    applyPlanActions.mockClear();

    liveDevices = [withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ currentDrawKw: 0,
      ...liveDeviceBase,
      binaryControl: { on: false },
      currentOn: false,
      binaryControlObservation: buildBinaryObservation('onoff', false),
    }))) as PlanInputDevice];

    // The rebuild itself now closes the gap: plan says keep/on, device reads
    // off, so the executor has work outstanding even though no decision moved.
    await service.rebuildPlanFromCache('power_delta', { detail: 'detail_only_live_off' });
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
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey(),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({ ...createMockPlanEngine() }),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => true,
      readSimulationSetting: () => true,
      getCurrentHourPriceLevel: () => PriceLevel.CHEAP,
      getLastPowerUpdate: () => 123456,
          });

    const plan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 0, softLimitKw: 0, headroomKw: 0 }),
      devices: [],
    };
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
        return actuation({ deviceWriteCount: 1 });
      }),
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      // The pels_status write is what `statusWriteMs` measures; route the injected
      // writer to the same fake-timer-advancing spy the settings.set used to be, so
      // the phase-timing assertion keeps observing the ~7ms status write cost.
      publishPelsStatus: settingsSet,
      homey: stubDepsHomey({ set: settingsSet, realtime }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
          });

    await service.rebuildPlanFromCache('power_delta', { detail: 'test_reason.phase_trace' });

    const trace = getRecentPlanRebuildTraces(1)[0];
    expect(trace).toEqual(expect.objectContaining({
      reason: 'power_delta:test_reason.phase_trace',
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
      applyPlanActions: vi.fn().mockResolvedValue(actuation()),
    };

    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: settingsSet, realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
          });

    const beforePerf = getPerfSnapshot();
    await service.rebuildPlanFromCache('power_delta', { detail: 'test_reason.failed' });
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
      reason: 'power_delta:test_reason.failed',
      failed: true,
      queueDepth: 1,
    }));
    expect(trace.totalMs).toBeGreaterThanOrEqual(17);
  });

  it('suppresses structured rebuild logs for unchanged no-op rebuilds', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service } = createPlanService({
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
    });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed' });
    structuredLog.info.mockClear();

    await service.rebuildPlanFromCache('power_delta');

    expect(structuredLog.info).not.toHaveBeenCalled();
  });

  it('emits structured rebuild logs for initial rebuild reasons even without action changes', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service } = createPlanService({
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
    });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed' });
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
          readSimulationSetting: () => false,
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
            applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
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
        readSimulationSetting: () => false,
        planEngine: {
          ...createMockPlanEngine(),
          buildDevicePlanSnapshot: vi.fn().mockRejectedValue(new Error('expected test failure')),
        },
      };
      await createPlanService(failingOverrides).service.rebuildPlanFromCache('power_delta', { detail: 'failure_test' });

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
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
    });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed' });
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
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
      getCapacityDryRun: () => true,
      readSimulationSetting: () => true,
    });

    // Seed
    await service.rebuildPlanFromCache('power_delta', { detail: 'seed' });
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
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(buildPlan(20, 'keep'))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { plannedState: 'shed' })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 2 })),
      }),
    });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed' });
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
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
      schedulePostActuationRefresh,
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi
          .fn()
          .mockResolvedValueOnce(buildPlan(20, 'keep'))
          .mockResolvedValueOnce(buildPlan(20, 'keep', {}, { plannedState: 'shed' })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0, commandRequestCount: 1 })),
      }),
    });

    await service.rebuildPlanFromCache('power_delta', { detail: 'seed' });
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

  it('emits structured rebuild logs for failed rebuilds', async () => {
    const structuredLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { service, deps } = createPlanService({
      loggers: { structuredLog: partialDouble<Logger>(structuredLog) },
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
    const applyPlanActions = vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 1 }));
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
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
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
      schedulePostActuationRefresh,
          });

    await service.rebuildPlanFromCache('power_delta');
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call schedulePostActuationRefresh after rebuild actuation when no writes occur', async () => {
    const schedulePostActuationRefresh = vi.fn();
    const applyPlanActions = vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 }));
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
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
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
      schedulePostActuationRefresh,
          });

    await service.rebuildPlanFromCache('power_delta');
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
    const applyPlanActions = vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 }));
    const planEngine = {
      ...createMockPlanEngine(),
      buildDevicePlanSnapshot: vi.fn().mockResolvedValue(steppedPlan),
      computeDynamicSoftLimit: vi.fn(() => 0),
      computeShortfallThreshold: vi.fn(() => 0),
      handleShortfall: vi.fn().mockResolvedValue(undefined),
      handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
      applyPlanActions,
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
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>(planEngine),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
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
    const applyPlanActions = vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 1, commandRequestCount: 0 }));
    const liveFixtureDevices: () => PlanInputDevice[] = () => [withFixtureResidualKw({ control: fixtureControlPosture({ controllable: true }), available: true, currentDrawKw: 0,
        id: 'dev-1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Heater',
        commandableNow: true,
        objectiveSessionInactive: false,
        boostSupported: false,
        boostRequested: false,
        hasStandingDemand: true,
        surplusTracking: false,
        confirmedNotDrawing: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        currentTarget: 20,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        deviceType: 'temperature',
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        currentOn: false,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
      })];
    const service = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      publishPelsStatus: vi.fn(),
      homey: stubDepsHomey({ set: vi.fn(), realtime: vi.fn().mockResolvedValue(undefined) }),
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep', {}, {
          currentState: 'on',
          currentTarget: 20,
          currentTemperature: 20,
          plannedState: 'keep',
          boostActive: false,
          plannedTarget: 20,
        })),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions,
      }),
      getPlanDevices: liveFixtureDevices,
      getSettleDevices: () => unavailableBinaryConfirmations(liveFixtureDevices()),
      getCapacityDryRun: () => false,
      readSimulationSetting: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getLastPowerUpdate: () => 1_745_000_000_000,
      schedulePostActuationRefresh,
          });

    // The plan wants the device on; it reads off, so the rebuild has work to do.
    await service.rebuildPlanFromCache('power_delta', { detail: 'post_actuation_refresh' });
    expect(applyPlanActions).toHaveBeenCalled();
    expect(schedulePostActuationRefresh).toHaveBeenCalledTimes(1);
  });
});

/**
 * The sweep-before-device-read ordering is the whole safety argument for the
 * observation lane not requesting a rebuild
 * (`lib/plan/admission/binaryCommandReachability.ts`, `onTimedOut`). `onTimedOut`
 * records the reachability failure synchronously but asks for no rebuild, and
 * that is only safe because every rebuild runs the pending-binary sweep BEFORE
 * it reads the devices — so a timeout raised by the sweep is projected
 * uncommandable in the SAME pass that would otherwise have acted on the device.
 *
 * Swapping these two statements in `buildPlanForRebuild` would break that
 * silently, with no other test failing, so it is pinned here rather than left to
 * a comment. See `test/integration/observationLaneNoPlanRebuild.test.ts` for the
 * invariant this ordering protects.
 */
describe('rebuild ordering', () => {
  it('sweeps pending binary commands before reading plan devices', async () => {
    const syncPendingBinaryCommands = vi.fn(() => false);
    const getPlanDevices = vi.fn(() => []);
    const { service } = createPlanService({
      planEngine: partialDouble<PlanServiceDeps['planEngine']>({
        ...createMockPlanEngine(),
        buildDevicePlanSnapshot: vi.fn().mockResolvedValue(buildPlan(20, 'keep')),
        computeDynamicSoftLimit: vi.fn(() => 0),
        computeShortfallThreshold: vi.fn(() => 0),
        handleShortfall: vi.fn().mockResolvedValue(undefined),
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        applyPlanActions: vi.fn().mockResolvedValue(actuation({ deviceWriteCount: 0 })),
        syncPendingBinaryCommands,
      }),
      getPlanDevices,
    });

    await service.rebuildPlanFromCache('power_delta');

    expect(syncPendingBinaryCommands).toHaveBeenCalled();
    expect(getPlanDevices).toHaveBeenCalled();
    expect(syncPendingBinaryCommands.mock.invocationCallOrder[0])
      .toBeLessThan(getPlanDevices.mock.invocationCallOrder[0]!);
  });

  describe('isDeviceLimitedInLatestPlan', () => {
    it('answers from the latest committed plan, and nothing is limited before one exists', () => {
      // The mode-target adoption path asks this so an owner's reaction to a
      // limit is not saved as the mode's target. "Limited" is the same
      // `plannedState === 'shed'` the Overview renders.
      const { service } = createPlanService();
      expect(service.isDeviceLimitedInLatestPlan('dev-1')).toBe(false);

      service['rebuildHost'].publishPlan(buildPlan(20, 'shed due to capacity', {}, {
        plannedState: 'shed', shedAction: 'set_temperature',
      }), Date.now());
      expect(service.isDeviceLimitedInLatestPlan('dev-1')).toBe(true);
      expect(service.isDeviceLimitedInLatestPlan('someone-else')).toBe(false);

      // Limited BY SETPOINT only: a device PELS turned off has not had its
      // setpoint touched, so a change there is a preference and is adopted.
      service['rebuildHost'].publishPlan(buildPlan(20, 'shed due to capacity', {}, {
        plannedState: 'shed', shedAction: 'turn_off',
      }), Date.now());
      expect(service.isDeviceLimitedInLatestPlan('dev-1')).toBe(false);

      service['rebuildHost'].publishPlan(buildPlan(20, 'keep', {}, { plannedState: 'keep' }), Date.now());
      expect(service.isDeviceLimitedInLatestPlan('dev-1')).toBe(false);
    });
  });
});
