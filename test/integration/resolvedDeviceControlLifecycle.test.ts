import { markSteppedLoadDesiredStepIssued, pruneStaleSteppedLoadCommandStates, reportSteppedLoadActualStep } from '../../lib/executor/steppedCommandState';
import { normalizeDeviceControlProfiles as normalizeStoredDeviceControlProfiles } from '../../packages/shared-domain/src/deviceControlProfiles';
import { createDeviceControlHelpersForTest } from '../helpers/deviceControlHelpers';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { resolveCurrentOn } from '../../lib/observer/observedState';
import { syncSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import { buildSteppedSettleSnapshot } from '../../lib/observer/steppedSettleSnapshot';
import { steppedStoresForTest } from '../helpers/steppedStores';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';
import type {
  DeviceControlProfiles,
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import {
  resolveEvTargetPowerConfirmedProfile,
  buildTargetPowerReachabilityState,
  type TargetPowerConfigWithReachability,
} from '../../lib/device/targetPowerReachability';

const steppedProfiles: DeviceControlProfiles = {
  'dev-1': {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
};

const baseSnapshot = (
  // Fixtures provide the device owner's chosen ladder before runtime composition.
  overrides: Partial<
    TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
  > = {},
): TargetDeviceSnapshot & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe & ReportedStepObservedProbe => transportSnapshotFixture({
  available: true,
  steppedLoadProfile: steppedProfiles['dev-1'],
  controlModel: 'stepped_load',
  id: 'dev-1',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Water heater',
  targets: [],
  deviceType: 'onoff',
  binaryControl: { on: false },
  measuredPowerKw: 0,
  ...overrides,
});

describe('resolved device control composition and command lifecycle', () => {
  it.each(['disabled', 'deleted'] as const)('retires an EV probe when its config is %s and Flow takes over', (change) => {
    let config: TargetPowerConfigWithReachability | undefined = {
      enabled: true, preset: 'ev_charger_1_phase', max: 7360,
    };
    const snapshot = baseSnapshot({ binaryControl: { on: true }, targetPowerConfig: config,
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, 1380) });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(() => [snapshot], stores, () => config,
      () => true, () => {}, () => null, {});
    helpers.markSteppedLoadDesiredStepIssued({ deviceId: snapshot.id, desiredStepId: '8a',
      previousStepId: '6a', issuedAtMs: 1000 });
    expect(stores.store.getDesired(snapshot.id)?.targetPowerProbeConfirmedMaxPowerW).toBe(1380);

    config = change === 'disabled' ? { ...config, enabled: false } : undefined;
    snapshot.targetPowerConfig = undefined;
    snapshot.steppedLoadProfile = steppedProfiles[snapshot.id];
    helpers.reconcileTargetPowerReachability([snapshot], 1500);

    expect(stores.store.getDesired(snapshot.id)).toBeUndefined();
    expect(stores.store.hasPriorStepCommand(snapshot.id)).toBe(false);
    // A fresh Flow decision is allowed to start its own command session.
    helpers.markSteppedLoadDesiredStepIssued({ deviceId: snapshot.id, desiredStepId: 'low', issuedAtMs: 1600 });
    helpers.reconcileTargetPowerReachability([snapshot], 1700);
    expect(stores.store.getDesired(snapshot.id)).toMatchObject({ stepId: 'low', pending: true });
  });

  it('retires a probe when phase configuration changes the watts represented by its step', () => {
    let config: TargetPowerConfigWithReachability = {
      enabled: true, preset: 'ev_charger_1_phase', max: 7360,
    };
    const snapshot = baseSnapshot({ binaryControl: { on: true }, targetPowerConfig: config,
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, 1380) });
    const stores = steppedStoresForTest();
    const update = vi.fn(() => true);
    const helpers = createDeviceControlHelpersForTest(() => [snapshot], stores, () => config,
      update, () => {}, () => null, {});
    helpers.markSteppedLoadDesiredStepIssued({ deviceId: snapshot.id, desiredStepId: '8a',
      previousStepId: '6a', issuedAtMs: 1000 });
    expect(stores.store.getDesired(snapshot.id)?.planningPowerW).toBe(1840);

    config = { enabled: true, preset: 'ev_charger_3_phase', max: 22080 };
    snapshot.targetPowerConfig = config;
    snapshot.steppedLoadProfile = resolveEvTargetPowerConfirmedProfile(config, 4140);
    snapshot.reportedStepId = '6a';
    snapshot.reportedStepPowerW = 4140;
    snapshot.reportedStepObservedAtMs = 1500;
    helpers.reconcileTargetPowerReachability([snapshot], 1500);

    expect(stores.store.getDesired(snapshot.id)).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('learns a settled EV ceiling and ends the foreground retry lifecycle', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5750,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepId: '25a',
      reportedStepPowerW: 5750,
      reportedStepObservedAtMs: 1500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      issuedAtMs: 1_000,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(92_000);

    helpers.reconcileTargetPowerReachability([snapshot], 92_000);
    snapshot.steppedLoadProfile = resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max);
    const [decorated] = helpers.decorateTargetSnapshotList([snapshot]);

    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 992_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
    expect(decorated.steppedLoadProfile?.steps.at(-1)?.id).toBe('25a');
    expect(decorated.targetPowerConfig).toEqual(baseConfig);
    dateNow.mockRestore();
  });

  it('raises the confirmed ladder when a probe reaches its requested step', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5750,
        probeFailureCount: 2,
        nextProbeAtMs: 1000,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepId: '25a',
      reportedStepPowerW: 5750,
      reportedStepObservedAtMs: 500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1000,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1500);
    expect(helpers.reportSteppedLoadActualStep('dev-1', '28a', 6440)).toBe('changed');
    dateNow.mockReturnValue(1600);

    helpers.reconcileTargetPowerReachability([snapshot], 1_600);
    snapshot.steppedLoadProfile = resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max);
    const [decorated] = helpers.decorateTargetSnapshotList([snapshot]);

    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 6440,
      probeFailureCount: 0,
    });
    expect(config.reachability).not.toHaveProperty('nextProbeAtMs');
    expect(decorated.reportedStepId).toBe('28a');
    expect(decorated.steppedLoadProfile?.steps.at(-1)?.id).toBe('28a');
    dateNow.mockRestore();
  });

  it('finalizes a refused Flow-backed probe from repeated exact feedback', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5750,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'Flow EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(92_000);

    // The pending window lapses on the settle pass, not on a projection read.
    syncSteppedCommands({
      store: stores.store,
      devices: buildSteppedSettleSnapshot(helpers.decorateTargetSnapshotList([snapshot])),
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')?.status).toBe('stale');
    expect(helpers.reportSteppedLoadActualStep('dev-1', '25a')).toBe('changed');
    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 992_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
    dateNow.mockRestore();
  });

  it('does not lower learned reachability after a successful downward command', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfig,
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 900_000,
    });
    const config: TargetPowerConfigWithReachability = { ...baseConfig, reachability };
    const updateTargetPowerReachability = vi.fn(() => true);
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepId: '24a',
      reportedStepPowerW: 5520,
      reportedStepObservedAtMs: 1500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '24a',
      previousStepId: '25a',
      issuedAtMs: 1000,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2000);

    helpers.reconcileTargetPowerReachability([snapshot], 2_000);

    expect(updateTargetPowerReachability).not.toHaveBeenCalled();
    expect(config.reachability).toBe(reachability);
    dateNow.mockRestore();
  });

  it('does not classify an ordinary increase inside the confirmed ladder as a probe', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    const config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 7_360 }),
    };
    const updateTargetPowerReachability = vi.fn(() => true);
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepPowerW: 1_380,
      reportedStepObservedAtMs: 1_500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '16a',
      previousStepId: '6a',
      issuedAtMs: 1_000,
    });
    helpers.reconcileTargetPowerReachability([snapshot], 2_000);

    expect(updateTargetPowerReachability).not.toHaveBeenCalled();
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: '16a',
      pending: true,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1'))
      .not.toHaveProperty('targetPowerProbeConfirmedMaxPowerW');
  });

  it('moves a silent refused probe to background backoff without lowering its proven maximum', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_750 }),
    };
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
    });
    helpers.reconcileTargetPowerReachability([snapshot], 92_000);

    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 992_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('ends a refused foreground probe even when its reachability update reports no change', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    const config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5_750,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      vi.fn(() => false), () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
    });
    helpers.reconcileTargetPowerReachability([snapshot], 92_000);

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('arms no reachability probe for a write the hub never acknowledged', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_750 }),
    };
    const scheduleTargetPowerProbeSettlement = vi.fn();
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, scheduleTargetPowerProbeSettlement, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
      unacknowledged: true,
    });

    // No probe armed, and no settlement scheduled to fail later.
    expect(scheduleTargetPowerProbeSettlement).not.toHaveBeenCalled();
    const desired = helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1');
    expect(desired?.targetPowerProbeStartedAtMs).toBeUndefined();
    // The pending record itself is still written — the device stays unsettled.
    expect(desired).toMatchObject({ lastIssuedAtMs: 1_000, stepId: '28a' });

    // Settling the window records no reachability failure: PELS learned nothing
    // about this charger from a socket it abandoned.
    helpers.reconcileTargetPowerReachability([snapshot], 1_100);
    expect(config.reachability).toMatchObject({ probeFailureCount: 0 });
    // The rung sits above the confirmed ladder by design, so reconciling the
    // configuration must not retire it as a removed rung and drop its pacing.
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: '28a', pending: true, lastIssuedAtMs: 1_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadStepCommandIssuedByDeviceId.has('dev-1')).toBe(true);
  });

  it('retires an unacknowledged EV command whose rung a phase change removed', () => {
    let config: TargetPowerConfigWithReachability = {
      enabled: true, preset: 'ev_charger_1_phase', max: 7_360,
    };
    const snapshot = baseSnapshot({ binaryControl: { on: true }, targetPowerConfig: config,
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, 1_380) });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(() => [snapshot], stores, () => config,
      () => true, () => {}, () => null, {});
    helpers.markSteppedLoadDesiredStepIssued({ deviceId: snapshot.id, desiredStepId: '8a',
      previousStepId: '6a', issuedAtMs: 1_000, unacknowledged: true });
    helpers.reconcileTargetPowerReachability([snapshot], 1_100);
    expect(stores.store.getDesired(snapshot.id)).toMatchObject({ stepId: '8a', planningPowerW: 1_840 });

    config = { enabled: true, preset: 'ev_charger_3_phase', max: 22_080 };
    snapshot.targetPowerConfig = config;
    snapshot.steppedLoadProfile = resolveEvTargetPowerConfirmedProfile(config, 4_140);
    helpers.reconcileTargetPowerReachability([snapshot], 1_500);

    expect(stores.store.getDesired(snapshot.id)).toBeUndefined();
  });

  it('keeps a probe settlement anchored to its first issue across command retries', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_750 }),
    };
    const scheduleTargetPowerProbeSettlement = vi.fn();
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, scheduleTargetPowerProbeSettlement, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
    });
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_050,
    });

    expect(scheduleTargetPowerProbeSettlement).toHaveBeenNthCalledWith(1, 91_000);
    expect(scheduleTargetPowerProbeSettlement).toHaveBeenNthCalledWith(2, 91_000);
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      lastIssuedAtMs: 1_050,
      targetPowerProbeStartedAtMs: 1_000,
      retryCount: 1,
    });

    helpers.reconcileTargetPowerReachability([snapshot], 91_000);
    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('prefers newer Flow exact feedback when native control is not authoritative', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_520 }),
    };
    const snapshot = baseSnapshot({
      name: 'Flow EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
      reportedStepPowerW: 5_520,
      reportedStepObservedAtMs: 500,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config,
      (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      }, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2_000);

    expect(helpers.reportSteppedLoadActualStep('dev-1', '25a')).toBe('changed');

    expect(config.reachability?.maxReachedPowerW).toBe(5_750);
    dateNow.mockRestore();
  });

  it.each([
    ['inside the ladder', '16a', 3_600],
    ['just below the lowest rung', '6a', 1_320],
  ])('admits a Flow power report %s as the rung the card matched', (_case, stepId, reportedW) => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    const config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_520 }),
    };
    const snapshot = baseSnapshot({
      name: 'Flow EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, config.reachability?.maxReachedPowerW ?? config.max),
      targetPowerConfig: baseConfig,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config, () => true, () => {}, () => null,
      { structuredLog: { info: vi.fn(), warn: vi.fn() } as never, debugStructured: vi.fn() },
    );
    helpers.markSteppedLoadDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: stepId, issuedAtMs: 1_000 });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2_000);

    // Cars draw a little under nominal; the card resolves such a reading to the
    // rung just above it, and the owner must accept the rung it was handed.
    expect(helpers.reportSteppedLoadActualStep('dev-1', stepId, reportedW)).toBe('changed');

    expect(stores.reportedStore.get('dev-1')).toMatchObject({ stepId, planningPowerW: reportedW });
    expect(stores.store.getDesired('dev-1')).toMatchObject({ stepId, pending: false, status: 'success' });
    // The rung is reported as-is: the ladder gains no off-grid exact step.
    expect(helpers.getSteppedLoadProfile('dev-1')?.steps.map((step) => step.id)).not.toContain(
      `${String(Math.round((reportedW / 230) * 1000) / 1000)}a`,
    );
    dateNow.mockRestore();
  });

  it('still rejects a Flow power report too far below the rung it names', () => {
    const config: TargetPowerSteppedLoadConfig = { enabled: true, preset: 'ev_charger_1_phase', max: 7_360 };
    const snapshot = baseSnapshot({
      binaryControl: { on: true },
      steppedLoadProfile: resolveEvTargetPowerConfirmedProfile(config, 5_520),
      targetPowerConfig: config,
    });
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshot], stores, () => config, () => true, () => {}, () => null, { debugStructured: vi.fn() },
    );

    expect(helpers.reportSteppedLoadActualStep('dev-1', '16a', 3_000)).toBe('invalid');
    expect(stores.reportedStore.get('dev-1')).toBeUndefined();
  });

  it('preserves the latest plan target when flow feedback reports stepped-load drift', () => {
    const structuredLogger = { info: vi.fn() };
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: true } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      { structuredLog: structuredLogger as never, debugStructured: vi.fn() },
    );

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    const runtimeState = helpers.getRuntimeStateForTests();
    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'max',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'max',
      retryCount: 0,
      pending: false,
      status: 'idle',
    });

    const [decorated] = helpers.decorateTargetSnapshotList(snapshots);
    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    expect(decorated.targetStepId).toBe('low');
    expect(decorated.desiredStepId).toBe('low');

    expect(structuredLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_feedback_mismatch',
      deviceId: 'dev-1',
      measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      reportedStepId: 'max',
      desiredStepId: 'low',
    }));
  });

  it('accepts flow feedback for snapshot-derived stepped-load profiles', () => {
    const structuredLogger = { info: vi.fn() };
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({
        binaryControl: { on: true },
        steppedLoadProfile: steppedProfiles['dev-1'],
      })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({ devices: [] } as never),
      { structuredLog: structuredLogger as never, debugStructured: vi.fn() },
    );

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'max',
    });
  });

  it('returns snapshot-defined stepped-load profiles when no stored profile exists', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfiles['dev-1'],
      })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: undefined, debugStructured: vi.fn() },
    );

    expect(helpers.getSteppedLoadProfile('dev-1')).toBe(steppedProfiles['dev-1']);
  });

  it('does not treat inactive native suggestions as effective stepped-load profiles', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({
        controlAdapter: {
          kind: 'capability_adapter',
          activationAvailable: true,
          activationEnabled: false,
          activationRequired: false,
        },
        steppedLoadProfile: undefined,
        suggestedSteppedLoadProfile: steppedProfiles['dev-1'],
      })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: undefined, debugStructured: vi.fn() },
    );

    expect(helpers.getSteppedLoadProfile('dev-1')).toBeNull();
  });

  it('preserves latest plan targets for snapshot-only stepped-load feedback', () => {
    const structuredLogger = { info: vi.fn() };
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({
        binaryControl: { on: true },
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfiles['dev-1'],
      })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      { structuredLog: structuredLogger as never, debugStructured: vi.fn() },
    );

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'max',
      retryCount: 0,
      pending: false,
      status: 'idle',
    });
    expect(structuredLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_feedback_mismatch',
      deviceId: 'dev-1',
      reportedStepId: 'max',
      desiredStepId: 'low',
    }));
  });

  it('replaces a stale desired step with the latest plan target when feedback catches up', () => {
    const structuredLogger = { info: vi.fn() };
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: true } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      { structuredLog: structuredLogger as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');

    const runtimeState = helpers.getRuntimeStateForTests();
    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'low',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'low',
      retryCount: 0,
      pending: false,
      status: 'success',
    });

    const [decorated] = helpers.decorateTargetSnapshotList(snapshots);
    expect(decorated.reportedStepId).toBe('low');
    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.targetStepId).toBe('low');
    expect(decorated.desiredStepId).toBe('low');

    expect(structuredLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_feedback_confirmed',
      deviceId: 'dev-1',
      measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      reportedStepId: 'low',
      desiredStepId: 'low',
    }));
  });

  it('replaces a stale desired step even when the repeated feedback report is unchanged', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: true } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('unchanged');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      retryCount: 0,
      pending: false,
      status: 'success',
    });
  });

  // A non-off flow report matching the PENDING desired step while the device is
  // off is real telemetry: it lands on the OBSERVED axis and confirms the
  // commanded one through the ordinary report path (prod 2026-07-05 Elbillader
  // deadlock: dropping it wholesale left restore-from-off looping
  // waiting_confirmation -> stale -> retry_backoff forever).
  it('admits a matching non-off flow report while off as observed evidence and confirms the command', () => {
    const structuredLogger = { info: vi.fn() };
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: structuredLogger as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    // Observed axis: real flow evidence, recorded even though the binary axis reads off.
    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
    // Commanded axis: confirmed.
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      pending: false,
      status: 'success',
      retryCount: 0,
      nextRetryAtMs: undefined,
    });

    const [decorated] = helpers.decorateTargetSnapshotList(snapshots);
    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    // The binary axis still owns the on/off fold — a non-off observed step does
    // not resurrect a device PELS has turned off.
    expect(resolveCurrentOn(decorated)).toBe(false);
    expect(decorated.stepCommandStatus).toBe('success');
    expect(decorated.stepCommandPending).toBe(false);

    // The confirmation survives subsequent off-cycle decorations — only an on→off
    // TRANSITION expires it, not steady off state.
    const [redecorated] = helpers.decorateTargetSnapshotList(snapshots);
    expect(redecorated.stepCommandStatus).toBe('success');
  });

  it('expires a confirmed command on the observed on→off transition', () => {
    // A confirmation given while the device was ON (e.g. the shed-prep echo at
    // the lowest step) is evidence about a configuration that can drift
    // invisibly once the device is off. It must not fast-track a later
    // restore-from-off past its fresh prepare-and-confirm handshake.
    const snapshotHolder = { current: baseSnapshot({ binaryControl: { on: true } }) };
    const stores = steppedStoresForTest();
    const helpers = createDeviceControlHelpersForTest(
      () => [snapshotHolder.current], stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'max',
      issuedAtMs: 1_000,
    });
    // Report while ON is admitted normally and confirms the command.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    const [onDecorated] = helpers.decorateTargetSnapshotList([snapshotHolder.current]);
    expect(onDecorated.stepCommandStatus).toBe('success');
    // The settle pass runs every cycle in production, so the on-session is
    // observed before it ends — the on→off expiry is a two-sample edge.
    syncSteppedCommands({
      store: stores.store,
      devices: buildSteppedSettleSnapshot([onDecorated]),
    });

    // Device turns off: the stale confirmation is downgraded, so the next
    // restore-from-off must re-confirm through the flow. Decoration only
    // PROJECTS, so the downgrade happens on the settle pass and the projection
    // carries it on the next read — the production order.
    snapshotHolder.current = baseSnapshot({ binaryControl: { on: false } });
    const [offProjection] = helpers.decorateTargetSnapshotList([snapshotHolder.current]);
    syncSteppedCommands({
      store: stores.store,
      devices: buildSteppedSettleSnapshot([offProjection]),
    });

    const [offDecorated] = helpers.decorateTargetSnapshotList([snapshotHolder.current]);
    expect(offDecorated.stepCommandStatus).toBe('idle');
    expect(offDecorated.stepCommandPending).toBe(false);
  });

  it('confirms a preserved (never-commanded) desired step from a matching non-off report', () => {
    // Pinning intended behavior: an 'idle' entry created by plan-target
    // preservation can be confirmed by a matching non-off report while off —
    // the report attests the device's actual configured step, which is
    // stronger evidence than a command echo.
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{ id: 'dev-1', targetStepId: 'max', desiredStepId: 'max' }],
      } as never),
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    // An off-step report while off is admitted; plan-target preservation seeds
    // the tracked desired entry at status 'idle'.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'off')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      status: 'idle',
    });

    // The matching non-off report is admitted as observed evidence and confirms
    // the tracked step.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      status: 'success',
    });
  });

  it('lets a newer conflicting NON-OFF report invalidate a while-off confirmation', () => {
    // The device attests a different non-off step than the confirmed one — the
    // Easee case: the charger re-raised its dynamic current while paused. The
    // stale success must drop so the next restore re-handshakes at the real
    // configuration, and the conflicting step becomes the observed truth so the
    // planner stops modelling the commanded step it is no longer at.
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'off',
      issuedAtMs: 1_000,
    });
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      status: 'success',
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'low',
      pending: false,
      status: 'idle',
    });
  });

  it('lets a newer conflicting admitted report invalidate a while-off confirmation', () => {
    // off → prepare-confirmed → the charger current is re-zeroed and the flow
    // reports the off step. The fresher telemetry contradicts the earlier
    // confirmation, which must lose so a stale 'success' cannot fast-track a
    // restore whose preparation was un-applied.
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{ id: 'dev-1', targetStepId: 'max', desiredStepId: 'max' }],
      } as never),
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      status: 'success',
    });

    // The off-step report while off is admitted and is newer than the confirmation.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'off')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      pending: false,
      status: 'idle',
    });
  });

  it('lets a matching non-off flow report confirm a STALE desired step (slow charger answered late)', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });
    // Expire the pending window so the command goes stale before the report.
    pruneStaleSteppedLoadCommandStates(helpers.getRuntimeStateForTests(), 91_001);
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      status: 'stale',
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      pending: false,
      status: 'success',
      nextRetryAtMs: undefined,
    });
  });

  // Newly reachable once non-off reports are admitted while off: the report falls
  // through to plan-target preservation, which it could not do before. Pinned as
  // intended — when the plan has moved the target from 'max' to 'low', the in-flight
  // 'max' command IS obsolete, so dropping it and resetting the retry budget for the
  // new target is correct, not a lost command.
  it('lets a non-off report while off hand an in-flight command over to a newer plan target', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => ({
        devices: [{ id: 'dev-1', targetStepId: 'low', desiredStepId: 'low' }],
      } as never),
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'off',
      issuedAtMs: 1_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      status: 'pending',
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'low',
      pending: false,
      status: 'idle',
      retryCount: 0,
    });
    // The report still lands on the observed axis regardless of the handover.
    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
  });

  it('does not let a NON-matching non-off flow report confirm the pending desired step', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    // 'low' is non-off and contradicts the commanded 'max': admitted as observed
    // truth, but it confirms nothing — the command stays pending.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');

    expect(stores.reportedStore.get('dev-1')).toMatchObject({
      stepId: 'low',
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      pending: true,
      status: 'pending',
      retryCount: 0,
    });
  });

  it('returns invalid for unknown flow step reports even when currentOn=false', () => {
    const stores = steppedStoresForTest();
    const snapshots = [baseSnapshot({ binaryControl: { on: false } })];
    const helpers = createDeviceControlHelpersForTest(
      () => snapshots, stores, () => undefined,
      () => false, () => {}, () => null,
      { structuredLog: { info: vi.fn() } as never, debugStructured: vi.fn() },
    );

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'missing')).toBe('invalid');
    expect(stores.reportedStore.get('dev-1')).toBeUndefined();
  });

  it('increments stepped-load retry metadata when the same desired step is re-issued', () => {
    const { store } = steppedStoresForTest();
    const runtimeState = store.getStateForTests();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 61_000)).toBe(false);
    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 91_001)).toBe(true);
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      retryCount: 0,
      nextRetryAtMs: 121_000,
      pending: false,
      status: 'stale',
    });

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 122_000,
    });

    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      retryCount: 1,
      nextRetryAtMs: undefined,
      pending: true,
      status: 'pending',
    });
  });

  it('resets retry escalation after a same-step command has already been confirmed', () => {
    const { store, reportedStore } = steppedStoresForTest();
    const runtimeState = store.getStateForTests();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });
    expect(reportSteppedLoadActualStep(runtimeState, reportedStore, {
      deviceId: 'dev-1', stepId: 'max', planningPowerW: 3000, observedAtMs: 2_000,
    })).toBe('changed');

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 3_000,
    });

    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      retryCount: 0,
      nextRetryAtMs: undefined,
      pending: true,
      status: 'pending',
    });
  });

  it('normalizes stored stepped-load profile maps', () => {
    expect(normalizeStoredDeviceControlProfiles({
      'dev-1': steppedProfiles['dev-1'],
      'dev-2': { steps: [{ id: '', planningPowerW: 0 }] },
    })).toEqual({
      'dev-1': steppedProfiles['dev-1'],
    });

    expect(normalizeStoredDeviceControlProfiles(null)).toBeNull();
  });
});
