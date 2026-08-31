// Integration coverage for the R5 membership-complement filter — the single
// seam (`filterDevicesForHome`) shared by main's plan input
// (`buildMainHomeScope.getPlanDevices`) and the sample-pipeline snapshot view
// (`createHomePowerPipeline.getLatestTargetSnapshot`):
// - identity when `hasSubHomes()` is false (SAME array reference — the
//   single-home bit-identical proof) and when the service is not wired;
// - a sub-home zone member excluded from the plan devices AND from the
//   controlled side of the usage split (its draw lands in background usage);
// - a pin-to-main device inside a sub-home zone included again.
// Only outward seams are mocked: the membership service runs real over the
// shared mock settings store; the pipeline runs the real sample ingest.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { executePendingPowerRebuild } from '../../lib/plan/rebuildScheduler/powerDriven';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import { buildMainHomeScope } from '../../setup/homeRuntime/homeScope';
import { buildHomePlanDevices } from '../../setup/homeRuntime/planDevicePrePass';
import { createHomePowerPipeline } from '../../setup/homeRuntime/createHomePowerPipeline';
import {
  filterDevicesForHome,
  HomeMembershipService,
  type HomeMembershipDeviceInput,
} from '../../setup/homeMembership';
import {
  createDeviceHomeAssignmentsStore,
  createHomesStore,
} from '../../setup/homeRegistryAdapter';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { mockHomeyInstance } from '../mocks/homey';

const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];

const ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'Annex', parent: 'z1' },
};
const SUB_HOME = {
  homeId: 'h_sub', name: 'Annex', rootZoneId: 'z2', meterDeviceId: null,
};

const mainDevice = {
  id: 'device-main',
  name: 'Main heater',
  zoneId: 'z1',
  available: true,
  capabilities: [],
  targets: [],
  controllable: true,
  measuredPowerKw: 2,
} as unknown as TargetDeviceSnapshot;
const subDevice = {
  id: 'device-sub',
  name: 'Annex heater',
  zoneId: 'z2',
  available: true,
  capabilities: [],
  targets: [],
  controllable: true,
  measuredPowerKw: 1.5,
} as unknown as TargetDeviceSnapshot;

const makeMembershipService = (
  devices: readonly HomeMembershipDeviceInput[],
  mainMeterDeviceId: string = 'meter-main',
  powerSource: 'homey_energy' | 'flow' = 'homey_energy',
): HomeMembershipService => {
  const service = new HomeMembershipService({
    homesStore: createHomesStore(homeyLike),
    assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
    getZoneTree: () => ZONES,
    getDevices: () => devices,
    getLogger: () => undefined,
    getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: mainMeterDeviceId }),
    getConfiguredPowerSource: () => ({ state: 'resolved', value: powerSource }),
    legacyMultiHomeEnabled: true,
  });
  service.recompute();
  return service;
};

const membershipInputs: HomeMembershipDeviceInput[] = [
  { deviceId: 'device-main', zoneId: 'z1' },
  { deviceId: 'device-sub', zoneId: 'z2' },
];

const makeCtx = (service: HomeMembershipService | undefined) => createAppContextMock({
  latestTargetSnapshot: [mainDevice, subDevice],
  homeMembership: service,
  resolveManagedState: vi.fn(() => true),
});

beforeEach(() => {
  mockHomeyInstance.settings.clear();
  mockHomeyInstance.settings.set('test_fixture_initialized', true);
});

describe('filterDevicesForHome identity guard', () => {
  it('returns the SAME array reference with no sub-homes configured, and when the service is unwired', () => {
    // Flow: no configured meter sources, so the meter-exclusion arm has
    // nothing to filter. Under homey_energy a named Main meter always exists
    // now, and its exclusion filter legitimately allocates.
    const service = makeMembershipService(membershipInputs, 'meter-main', 'flow');
    const devices = [mainDevice, subDevice];
    expect(service.hasSubHomes()).toBe(false);
    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toBe(devices);
    expect(filterDevicesForHome(undefined, devices, MAIN_HOME_ID)).toBe(devices);
  });

  it('removes an explicit Main meter even when no sub-homes are configured', () => {
    const service = makeMembershipService(membershipInputs, 'device-main');
    const devices = [mainDevice, subDevice];

    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toEqual([subDevice]);
  });

  it('keeps persisted meter selections dormant while Flow supplies whole-home power', () => {
    const service = makeMembershipService(membershipInputs, 'device-main', 'flow');
    const devices = [mainDevice, subDevice];

    expect(service.getConfiguredMeterSources()).toEqual({
      state: 'resolved',
      deviceIds: new Set(),
    });
    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toBe(devices);
    expect(service.isMainHomeActuationFenced()).toBe(false);
  });

  it('does not read or fence on a malformed dormant meter selection in Flow mode', () => {
    const getMainMeterSelection = vi.fn((): MainMeterSelection => ({ state: 'unavailable' }));
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => membershipInputs,
      getLogger: () => undefined,
      getMainMeterSelection,
      getConfiguredPowerSource: () => ({ state: 'resolved', value: 'flow' }),
      legacyMultiHomeEnabled: true,
    });
    service.recompute();
    const devices = [mainDevice, subDevice];

    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toBe(devices);
    expect(service.isMainHomeActuationFenced()).toBe(false);
    expect(getMainMeterSelection).not.toHaveBeenCalled();
  });

  it('fails every home closed and schedules recovery while power-source authority is suspect', () => {
    const getMainMeterSelection = vi.fn((): MainMeterSelection => ({
      state: 'resolved',
      meterDeviceId: 'device-main',
    }));
    const onMainAuthorityUnresolved = vi.fn();
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => membershipInputs,
      getLogger: () => undefined,
      getMainMeterSelection,
      getConfiguredPowerSource: () => ({
        state: 'suspect',
        reason: 'read_failed',
        error: new Error('transient settings read failure'),
      }),
      legacyMultiHomeEnabled: true,
      onMainAuthorityUnresolved,
    });
    service.recompute();
    const devices = [mainDevice, subDevice];

    expect(service.getConfiguredMeterSources()).toEqual({
      state: 'unavailable',
      deviceIds: new Set(),
    });
    expect(onMainAuthorityUnresolved).toHaveBeenCalledOnce();
    expect(getMainMeterSelection).not.toHaveBeenCalled();
    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toEqual([]);
    expect(filterDevicesForHome(service, devices, 'h_sub')).toEqual([]);
    expect(service.isMainHomeActuationFenced()).toBe(true);
  });

  it('fails every home closed when Main meter authority becomes unavailable', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME] });
    let selection: MainMeterSelection = {
      state: 'resolved',
      meterDeviceId: 'device-sub',
    };
    const service = new HomeMembershipService({
      getConfiguredPowerSource: () => ({ state: 'resolved', value: 'homey_energy' }),
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => membershipInputs,
      getLogger: () => undefined,
      getMainMeterSelection: () => selection,
      legacyMultiHomeEnabled: true,
    });
    service.recompute();
    const devices = [mainDevice, subDevice];

    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toEqual([mainDevice]);
    expect(filterDevicesForHome(service, devices, 'h_sub')).toEqual([]);

    selection = { state: 'unavailable' };
    expect(service.getConfiguredMeterSources()).toEqual({
      state: 'unavailable',
      deviceIds: new Set(['device-sub']),
    });
    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toEqual([]);
    expect(filterDevicesForHome(service, devices, 'h_sub')).toEqual([]);

    selection = { state: 'resolved', meterDeviceId: 'device-sub' };
    expect(filterDevicesForHome(service, devices, MAIN_HOME_ID)).toEqual([mainDevice]);
    expect(filterDevicesForHome(service, devices, 'h_sub')).toEqual([]);
  });
});

describe('main plan input (buildMainHomeScope.getPlanDevices)', () => {
  it('preserves commandability state while meter authority is unavailable', () => {
    const ctx = createAppContextMock({
      latestTargetSnapshot: [mainDevice],
      homeMembership: {
        hasSubHomes: () => false,
        getHomeIdForDevice: () => MAIN_HOME_ID,
        getConfiguredMeterSources: () => ({
          state: 'unavailable',
          deviceIds: new Set<string>(),
        }),
      } as unknown as NonNullable<ReturnType<typeof createAppContextMock>['homeMembership']>,
    });

    expect(buildHomePlanDevices(ctx, MAIN_HOME_ID)).toEqual([]);
  });

  it('includes every device while no sub-homes exist', () => {
    const ctx = makeCtx(makeMembershipService(membershipInputs));
    const scope = buildMainHomeScope(ctx);
    expect(scope.getPlanDevices().map((device) => device.id)).toEqual(['device-main', 'device-sub']);
  });

  it('excludes a sub-home zone member from the main plan devices', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME] });
    const ctx = makeCtx(makeMembershipService(membershipInputs));
    const scope = buildMainHomeScope(ctx);
    expect(scope.getPlanDevices().map((device) => device.id)).toEqual(['device-main']);
  });

  it('includes a device pinned to main even inside a sub-home zone', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME] });
    createDeviceHomeAssignmentsStore(homeyLike).write({ 'device-sub': 'main' });
    const ctx = makeCtx(makeMembershipService(membershipInputs));
    const scope = buildMainHomeScope(ctx);
    expect(scope.getPlanDevices().map((device) => device.id)).toEqual(['device-main', 'device-sub']);
  });

  it('projects the lifecycle-visible active set to stable relative priorities', () => {
    const snapshot = [mainDevice, subDevice];
    const ctx = createAppContextMock({
      latestTargetSnapshot: snapshot,
      homeMembership: makeMembershipService(membershipInputs),
      resolveManagedState: vi.fn(() => true),
      // Simulate persisted gaps left by devices that are no longer active.
      capacityPriorities: { Home: { 'device-main': 5, 'device-sub': 9 } },
      operatingMode: 'Home',
    });
    const scope = buildMainHomeScope(ctx);
    const priorities = () => Object.fromEntries(
      scope.getPlanDevices().map((device) => [device.id, device.priority]),
    );

    expect(priorities()).toEqual({ 'device-main': 1, 'device-sub': 2 });

    // The smart-task lifecycle calls this same producer independently of
    // PlanBuilder. A transiently missing former rank 1 must promote the sole
    // remaining device, then restore the original order on reappearance.
    snapshot.shift();
    expect(priorities()).toEqual({ 'device-sub': 1 });
    snapshot.unshift(mainDevice);
    expect(priorities()).toEqual({ 'device-main': 1, 'device-sub': 2 });
  });

  it('uses the owning home priority resolver before assigning relative ranks', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME] });
    createDeviceHomeAssignmentsStore(homeyLike).write({
      'device-main': SUB_HOME.homeId,
      'device-sub': SUB_HOME.homeId,
    });
    const ctx = createAppContextMock({
      latestTargetSnapshot: [mainDevice, subDevice],
      homeMembership: makeMembershipService(membershipInputs),
      resolveManagedState: vi.fn(() => true),
      // Main's order deliberately conflicts with the area's order below.
      capacityPriorities: { Home: { 'device-main': 1, 'device-sub': 2 } },
      operatingMode: 'Home',
    });

    const devices = buildHomePlanDevices(ctx, SUB_HOME.homeId, {
      getBasePriorityForDevice: (deviceId) => deviceId === 'device-sub' ? 4 : 8,
    });

    expect(devices.map(({ id, priority }) => ({ id, priority }))).toEqual([
      { id: 'device-main', priority: 2 },
      { id: 'device-sub', priority: 1 },
    ]);
  });

  it('keeps an unconfigured device behind an explicitly saved rank 100', () => {
    const ctx = createAppContextMock({
      latestTargetSnapshot: [mainDevice, subDevice],
      homeMembership: makeMembershipService(membershipInputs),
      resolveManagedState: vi.fn(() => true),
      capacityPriorities: { Home: { 'device-sub': 100 } },
      operatingMode: 'Home',
    });

    expect(buildMainHomeScope(ctx).getPlanDevices().map(({ id, priority }) => ({ id, priority }))).toEqual([
      { id: 'device-main', priority: 2 },
      { id: 'device-sub', priority: 1 },
    ]);
  });
});

describe('sample-pipeline usage split (createHomePowerPipeline)', () => {
  const runSample = async (service: HomeMembershipService): Promise<PowerTrackerState> => {
    const ctx = makeCtx(service);
    let saved: PowerTrackerState = {};
    const planEngine = {
      state: undefined,
      clearStartupRestoreStabilization: vi.fn(),
    } as unknown as PlanEngine;
    const planService = {
      getLatestPlanSnapshot: vi.fn(() => null),
      getLatestPlanSnapshotUpdatedAtMs: vi.fn(() => null),
      rebuildPlanFromCache: vi.fn(async () => undefined),
      computeDynamicSoftLimit: () => 9.5,
    } as unknown as PlanService;
    const nowMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    // Mirrors `PlanRebuildIntentPolicy.executeIntent`: the sample promise is a
    // deferred on `powerSampleRebuildState` that ONLY this executor resolves —
    // an inert executeIntent stub would hang the recordPowerSample await.
    const executeIntent = () => executePendingPowerRebuild({
      getState: () => ctx.powerSampleRebuildState,
      setState: (state) => { ctx.powerSampleRebuildState = state; },
      getNowMs: () => nowMs,
      rebuildPlanFromCache: async () => undefined,
    });
    const pipeline = createHomePowerPipeline({
      ctx,
      homeId: MAIN_HOME_ID,
      noteSampleAdmitted: () => {},
      planRebuildScheduler: new PlanRebuildScheduler({
        getNowMs: () => nowMs,
        resolveDueAtMs: () => nowMs,
        executeIntent,
        shouldExecuteImmediately: () => true,
      }),
      getPlanEngine: () => planEngine,
      getPlanService: () => planService,
      getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
      getPlanRebuildNowMs: () => nowMs,
      savePowerTracker: (state) => { saved = state; },
      setPowerSampleRebuildState: (state) => { ctx.powerSampleRebuildState = state; },
    });
    await pipeline.recordPowerSample(5000, nowMs);
    return saved;
  };

  it('counts both devices as controlled while no sub-homes exist (identity)', async () => {
    const saved = await runSample(makeMembershipService(membershipInputs));
    expect(saved.lastControlledPowerW).toBe(3500);
    expect(saved.lastUncontrolledPowerW).toBe(1500);
  });

  it('moves a sub-home member out of the controlled split — its draw becomes background usage', async () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME] });
    const saved = await runSample(makeMembershipService(membershipInputs));
    expect(saved.lastControlledPowerW).toBe(2000);
    expect(saved.lastUncontrolledPowerW).toBe(3000);
  });

  it('keeps a pin-to-main device in the controlled split', async () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME] });
    createDeviceHomeAssignmentsStore(homeyLike).write({ 'device-sub': 'main' });
    const saved = await runSample(makeMembershipService(membershipInputs));
    expect(saved.lastControlledPowerW).toBe(3500);
    expect(saved.lastUncontrolledPowerW).toBe(1500);
  });
});
