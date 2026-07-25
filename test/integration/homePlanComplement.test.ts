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
  controllable: true,
  measuredPowerKw: 2,
} as unknown as TargetDeviceSnapshot;
const subDevice = {
  id: 'device-sub',
  name: 'Annex heater',
  zoneId: 'z2',
  available: true,
  capabilities: [],
  controllable: true,
  measuredPowerKw: 1.5,
} as unknown as TargetDeviceSnapshot;

const makeMembershipService = (
  devices: readonly HomeMembershipDeviceInput[],
  mainMeterDeviceId: string | null = null,
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
});

describe('filterDevicesForHome identity guard', () => {
  it('returns the SAME array reference with no sub-homes configured, and when the service is unwired', () => {
    const service = makeMembershipService(membershipInputs);
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
});

describe('sample-pipeline usage split (createHomePowerPipeline)', () => {
  const runSample = async (service: HomeMembershipService): Promise<PowerTrackerState> => {
    const ctx = makeCtx(service);
    ctx.capacityGuard = undefined;
    let saved: PowerTrackerState = {};
    const planEngine = {
      state: undefined,
      clearStartupRestoreStabilization: vi.fn(),
    } as unknown as PlanEngine;
    const planService = {
      getLatestPlanSnapshot: vi.fn(() => null),
      getLatestPlanSnapshotUpdatedAtMs: vi.fn(() => null),
      rebuildPlanFromCache: vi.fn(async () => undefined),
    } as unknown as PlanService;
    const nowMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    // Mirrors `PelsApp.executePlanRebuildIntent`: the sample promise is a
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
      planRebuildScheduler: new PlanRebuildScheduler({
        getNowMs: () => nowMs,
        resolveDueAtMs: () => nowMs,
        executeIntent,
        shouldExecuteImmediately: () => true,
      }),
      getPlanEngine: () => planEngine,
      getPlanService: () => planService,
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
