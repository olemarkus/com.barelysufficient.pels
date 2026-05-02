import Homey from 'homey';
import {
  DeviceManager,
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
} from '../lib/core/deviceManager';
import {
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
} from '../lib/core/nativeSteppedLoadWiring';
import { setObservedNativeSteppedLoadStep } from '../lib/core/deviceManagerNativeSteppedCommand';
import { ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE } from '../lib/core/zaptecNativeSteppedLoad';
import { applySteppedLoadCommand, type PlanExecutorSteppedContext } from '../lib/executor/steppedLoadExecutor';
import { buildExecutableSteppedLoadDevice } from '../lib/plan/planExecutableSteppedLoad';
import { AppDeviceControlHelpers } from '../lib/app/appDeviceControlHelpers';
import type { HomeyDeviceLike, Logger, SteppedLoadProfile, TargetDeviceSnapshot } from '../lib/utils/types';
import { mockHomeyInstance } from './mocks/homey';
import { setRestClient } from '../lib/core/deviceManagerHomeyApi';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../lib/core/steppedLoadSyntheticCapabilities';

const steppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const createLogger = () => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}) as unknown as Logger;

const buildHoiaxDevice = () => ({
  id: 'hoiax-1',
  name: 'Connected 300',
  class: 'heater',
  driverId: 'homey:app:no.hoiax:connected300',
  ownerUri: 'homey:app:no.hoiax',
  capabilities: ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'max_power_3000'],
  capabilitiesObj: {
    measure_power: { value: 1750 },
    target_temperature: { value: 65 },
    measure_temperature: { value: 60 },
    onoff: { value: true, setable: true },
    max_power_3000: { value: 'medium_power', setable: true },
  },
  available: true,
  ready: true,
});

const buildZaptecDevice = (overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  id: 'zaptec-go-1',
  name: 'Zaptec Go',
  class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go',
  ownerUri: 'homey:app:com.zaptec',
  data: {
    id: 'zaptec-go-1',
    installationId: 'inst-zaptec-1',
  },
  capabilities: [
    'measure_power',
    'available_installation_current',
    'charging_button',
    'charge_mode',
    'alarm_generic.car_connected',
  ],
  capabilitiesObj: {
    measure_power: { value: 3680, lastUpdated: '2026-04-22T09:00:00.000Z' },
    available_installation_current: { value: 16, lastUpdated: '2026-04-22T09:00:01.000Z' },
    charging_button: { value: true, setable: true, lastUpdated: '2026-04-22T09:00:02.000Z' },
    charge_mode: { value: 'Charging', lastUpdated: '2026-04-22T09:00:03.000Z' },
    'alarm_generic.car_connected': { value: true, lastUpdated: '2026-04-22T09:00:04.000Z' },
  },
  available: true,
  ready: true,
  ...overrides,
});

const restoreMockRestClient = () => {
  setRestClient({
    get: (path) => mockHomeyInstance.api.get(path),
    post: (path, body) => mockHomeyInstance.api.post(path, body),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
};

describe('native stepped-load wiring', () => {
  it('maps Høiax max_power values to the configured stepped-load profile', () => {
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: steppedProfile,
      capabilities: ['max_power_3000'],
      capabilityObj: { max_power_3000: { value: 'low_power' }, onoff: { value: true } },
    })).toBe('low');
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: steppedProfile,
      capabilities: ['max_power_3000'],
      capabilityObj: { max_power_3000: { value: '2' }, onoff: { value: true } },
    })).toBe('medium');
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: steppedProfile,
      capabilities: ['max_power_3000'],
      capabilityObj: { max_power_3000: { value: '3' }, onoff: { value: true } },
    })).toBe('max');
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: steppedProfile,
      capabilities: ['max_power_3000'],
      capabilityObj: { max_power_3000: { value: 'high_power' }, onoff: { value: false } },
    })).toBe('max');
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: steppedProfile,
      capabilities: ['max_power_3000'],
      capabilityObj: { max_power_3000: { value: undefined }, onoff: { value: false } },
    })).toBe('off');
  });

  it('maps desired stepped-load steps to native Høiax writes', () => {
    expect(resolveNativeSteppedLoadCommand({
      profile: steppedProfile,
      desiredStepId: 'medium',
      capabilities: ['onoff', 'max_power_3000'],
      capabilityObj: { max_power_3000: { value: 'high_power' } },
    })).toEqual({ capabilityId: 'max_power_3000', value: '2' });
    expect(resolveNativeSteppedLoadCommand({
      profile: steppedProfile,
      desiredStepId: 'medium',
      capabilities: ['onoff', 'max_power_3000'],
      capabilityObj: { max_power_3000: { value: undefined } },
    })).toEqual({ capabilityId: 'max_power_3000', value: '2' });
    expect(resolveNativeSteppedLoadCommand({
      profile: steppedProfile,
      desiredStepId: 'medium',
      capabilities: ['onoff', 'max_power'],
      capabilityObj: { max_power: { value: undefined } },
    })).toEqual({ capabilityId: 'max_power', value: '2' });
    expect(resolveNativeSteppedLoadCommand({
      profile: steppedProfile,
      desiredStepId: 'off',
      capabilities: ['onoff', 'max_power_3000'],
    })).toEqual({ capabilityId: 'onoff', value: false });
    expect(resolveNativeSteppedLoadCommand({
      profile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      desiredStepId: 'max',
      capabilities: ['onoff', 'max_power_3000'],
      capabilityObj: { max_power_3000: { value: 'medium_power' } },
    })).toEqual({ capabilityId: 'max_power_3000', value: '3' });
  });

  it('exposes native stepped-load wiring from the device-supported profile', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildHoiaxDevice()]);
    expect(parsed).toEqual(expect.objectContaining({
      id: 'hoiax-1',
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      reportedStepId: 'medium',
      suggestedSteppedLoadProfile: steppedProfile,
    }));
    expect(parsed.capabilities).not.toContain('max_power_3000');
  });

  it('does not treat unrelated max_power capabilities as native stepped-load wiring', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
        getDeviceControlProfile: () => steppedProfile,
      },
    );
    const [parsed] = deviceManager.parseDeviceListForTests([{
      ...buildHoiaxDevice(),
      id: 'other-1',
      ownerUri: 'homey:app:com.example',
      driverId: 'homey:app:com.example:heater',
    }]);

    expect(parsed.controlAdapter).toBeUndefined();
    expect(parsed.suggestedSteppedLoadProfile).toBeUndefined();
    expect(parsed.capabilities).toContain('max_power_3000');
  });

  it('detects native stepped-load wiring from real Høiax driver shapes', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => false,
      },
    );

    const [compactDriverId, nestedDriverOwner, myuplinkHoiax, myuplinkOther] = deviceManager.parseDeviceListForTests([
      {
        ...buildHoiaxDevice(),
        id: 'compact-driver-id',
        driverId: 'no.hoiax:hiax-connected-200',
        ownerUri: undefined,
        capabilities: ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'max_power'],
        capabilitiesObj: {
          ...buildHoiaxDevice().capabilitiesObj,
          max_power: { value: 'medium_power', setable: true },
        },
      },
      {
        ...buildHoiaxDevice(),
        id: 'nested-driver-owner',
        driverId: 'hiax-connected-300',
        ownerUri: undefined,
        driver: { owner_uri: 'homey:app:no.hoiax' },
      },
      {
        ...buildHoiaxDevice(),
        id: 'myuplink-hoiax',
        driverId: 'homey:app:com.myuplink:hoiax',
        ownerUri: undefined,
      },
      {
        ...buildHoiaxDevice(),
        id: 'myuplink-other',
        driverId: 'homey:app:com.myuplink:ctc',
        ownerUri: undefined,
        capabilities: ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'max_power_2000'],
        capabilitiesObj: {
          ...buildHoiaxDevice().capabilitiesObj,
          max_power_2000: { value: 'medium_power', setable: true },
        },
      },
    ]);

    expect(compactDriverId.controlAdapter).toEqual(expect.objectContaining({
      activationAvailable: true,
      activationEnabled: false,
    }));
    expect(nestedDriverOwner.controlAdapter).toEqual(expect.objectContaining({
      activationAvailable: true,
      activationEnabled: false,
    }));
    expect(myuplinkHoiax.controlAdapter).toEqual(expect.objectContaining({
      activationAvailable: true,
      activationEnabled: false,
    }));
    expect(myuplinkOther.controlAdapter).toBeUndefined();
  });

  it('detects native stepped-load wiring from MyUplink Høiax Connected 300 shape', () => {
    const nativeStepObservedAt = '2026-04-01T12:03:00.000Z';
    const device = {
      id: 'myuplink-hoiax-connected-300',
      name: 'Connected 300',
      class: 'heater',
      driverId: 'homey:app:com.myuplink:hoiax',
      available: true,
      capabilities: [
        'measure_power',
        'target_temperature',
        'measure_temperature',
        'onoff',
        'max_power_3000',
      ],
      capabilitiesObj: {
        measure_power: { value: 1193 },
        target_temperature: { value: 80 },
        measure_temperature: { value: 54.8 },
        onoff: { value: true },
        max_power_3000: { value: '1', setable: true, lastUpdated: nativeStepObservedAt },
      },
    } satisfies HomeyDeviceLike;

    const disabledManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => false,
      },
    );
    const [disabledParsed] = disabledManager.parseDeviceListForTests([device]);

    expect(disabledParsed.controlAdapter).toEqual(expect.objectContaining({
      activationAvailable: true,
      activationEnabled: false,
    }));
    expect(disabledParsed.capabilities).not.toContain('max_power_3000');

    const enabledManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );
    const [enabledParsed] = enabledManager.parseDeviceListForTests([device]);

    expect(enabledParsed.controlAdapter).toEqual(expect.objectContaining({
      activationEnabled: true,
    }));
    expect(enabledParsed.reportedStepId).toBe('low');
    expect(enabledParsed.lastFreshDataMs).toBe(new Date(nativeStepObservedAt).getTime());
    expect(enabledParsed.lastUpdated).toBe(new Date(nativeStepObservedAt).getTime());
  });

  it('uses native stepped-load feedback instead of flow reports when native wiring is enabled', () => {
    const flowSnapshot = {
      id: 'hoiax-1',
      name: 'Connected 300',
      targets: [],
      currentOn: true,
      measuredPowerKw: 1.75,
    } satisfies TargetDeviceSnapshot;
    const nativeSnapshot = {
      ...flowSnapshot,
      reportedStepId: 'low',
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      suggestedSteppedLoadProfile: steppedProfile,
    } satisfies TargetDeviceSnapshot;
    let snapshots = [flowSnapshot];
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({ 'hoiax-1': steppedProfile }),
      getDeviceSnapshots: () => snapshots,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('hoiax-1', 'max')).toBe('changed');
    const [flowDecorated] = helpers.decorateTargetSnapshotList([flowSnapshot]);
    expect(flowDecorated).toEqual(expect.objectContaining({
      reportedStepId: 'max',
      selectedStepId: 'max',
      actualStepSource: 'reported',
    }));

    snapshots = [nativeSnapshot];
    expect(helpers.reportSteppedLoadActualStep('hoiax-1', 'max')).toBe('unchanged');
    const [decorated] = helpers.decorateTargetSnapshotList([nativeSnapshot]);

    expect(decorated).toEqual(expect.objectContaining({
      controlModel: 'stepped_load',
      reportedStepId: 'low',
      selectedStepId: 'low',
      planningPowerKw: 1.25,
    }));

    const [afterNativeDisabled] = helpers.decorateTargetSnapshotList([flowSnapshot]);
    expect(afterNativeDisabled).toEqual(expect.objectContaining({
      reportedStepId: undefined,
      selectedStepId: 'low',
      actualStepSource: 'assumed',
    }));
  });

  it('uses device-supported native steps instead of configured profile steps', () => {
    const configuredProfile: SteppedLoadProfile = {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'eco', planningPowerW: 900 },
        { id: 'boost', planningPowerW: 4000 },
      ],
    };
    const nativeSnapshot = {
      id: 'hoiax-1',
      name: 'Connected 300',
      targets: [],
      currentOn: true,
      measuredPowerKw: 1.75,
      reportedStepId: 'medium',
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      suggestedSteppedLoadProfile: steppedProfile,
    } satisfies TargetDeviceSnapshot;
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({ 'hoiax-1': configuredProfile }),
      getDeviceSnapshots: () => [nativeSnapshot],
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
    });

    const [decorated] = helpers.decorateTargetSnapshotList([nativeSnapshot]);

    expect(decorated).toEqual(expect.objectContaining({
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      reportedStepId: 'medium',
      selectedStepId: 'medium',
      planningPowerKw: 1.75,
    }));
    expect(helpers.getSteppedLoadProfile('hoiax-1')).toEqual(steppedProfile);
  });

  it('writes native capability instead of triggering the stepped-load flow when enabled', async () => {
    const setNativeSteppedLoadStep = vi.fn(async () => true);
    const trigger = vi.fn(async () => undefined);
    const structuredLog = { info: vi.fn(), error: vi.fn() };
    const ctx = {
      state: {},
      logDebug: vi.fn(),
      error: vi.fn(),
      structuredLog,
      buildBinaryControlDeps: () => ({ deviceManager: { setNativeSteppedLoadStep } }),
      markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
      getDesiredSteppedLoadTrigger: () => ({ trigger }),
      setNativeSteppedLoadStep,
    } as unknown as PlanExecutorSteppedContext;

    const action = buildExecutableSteppedLoadDevice({
      id: 'hoiax-1',
      name: 'Connected 300',
      currentOn: true,
      currentState: 'on',
      plannedState: 'shed',
      currentTarget: null,
      plannedTarget: null,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'max',
      desiredStepId: 'medium',
      controlCapabilityId: 'onoff',
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      reason: { code: 'overCapacity', label: 'over capacity' },
    });

    expect(action).not.toBeNull();
    const wrote = await applySteppedLoadCommand(ctx, action!, 'plan');

    expect(wrote).toBe(true);
    expect(setNativeSteppedLoadStep).toHaveBeenCalledWith('hoiax-1', steppedProfile, 'medium');
    expect(trigger).not.toHaveBeenCalled();
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'hoiax-1',
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      desiredStepId: 'medium',
      commandTransport: 'native_capability',
    }));
  });

  it('applies native stepped-load commands from the cached observed adapter', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'hoiax-1': buildHoiaxDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get, put });
    try {
      const debugStructured = vi.fn();
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getNativeEvWiringEnabled: () => true,
          getDeviceControlProfile: () => steppedProfile,
        },
        undefined,
        { debugStructured },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });
      expect(get).toHaveBeenCalledTimes(1);
      get.mockRejectedValue(new Error('command path must not fetch devices'));

      await expect(setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'hoiax-1',
        profile: steppedProfile,
        desiredStepId: 'medium',
        setCapability: (capabilityId, value) => deviceManager.setCapability('hoiax-1', capabilityId, value),
      }))
        .resolves.toBe(true);

      expect(get).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith(
        'manager/devices/device/hoiax-1/capability/max_power_3000',
        { value: '2' },
      );
      expect(debugStructured).toHaveBeenCalledWith({
        event: 'device_capability_write_requested',
        deviceId: 'hoiax-1',
        deviceName: 'Connected 300',
        capabilityId: 'max_power_3000',
        writeCapabilityId: 'max_power_3000',
        value: '2',
        valueType: 'string',
      });
      expect(debugStructured).toHaveBeenCalledWith({
        event: 'device_capability_write_accepted',
        deviceId: 'hoiax-1',
        deviceName: 'Connected 300',
        capabilityId: 'max_power_3000',
        writeCapabilityId: 'max_power_3000',
        value: '2',
        valueType: 'string',
      });

      put.mockClear();
      debugStructured.mockClear();
      deviceManager.injectDeviceUpdateForTest({
        ...buildHoiaxDevice(),
        capabilitiesObj: {
          ...buildHoiaxDevice().capabilitiesObj,
          max_power_3000: { value: 2, setable: true },
        },
      });

      await expect(setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'hoiax-1',
        profile: steppedProfile,
        desiredStepId: 'medium',
        setCapability: (capabilityId, value) => deviceManager.setCapability('hoiax-1', capabilityId, value),
      }))
        .resolves.toBe(true);

      expect(put).toHaveBeenCalledWith(
        'manager/devices/device/hoiax-1/capability/max_power_3000',
        { value: '2' },
      );

      const liveStateObserved = vi.fn();
      const realtimeReconcile = vi.fn();
      deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateObserved);
      deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeReconcile);
      deviceManager.injectCapabilityUpdateForTest('hoiax-1', 'max_power_3000', '3');

      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        reportedStepId: 'max',
      }));
      expect(liveStateObserved).toHaveBeenCalledWith({
        source: 'realtime_capability',
        deviceId: 'hoiax-1',
        capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      });
      expect(realtimeReconcile).toHaveBeenCalledWith({
        deviceId: 'hoiax-1',
        name: 'Connected 300',
        changes: [{
          capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
          previousValue: 'medium',
          nextValue: 'max',
        }],
      });

      put.mockClear();
      await expect(setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'hoiax-1',
        profile: steppedProfile,
        desiredStepId: 'medium',
        setCapability: (capabilityId, value) => deviceManager.setCapability('hoiax-1', capabilityId, value),
      }))
        .resolves.toBe(true);

      expect(put).toHaveBeenCalledWith(
        'manager/devices/device/hoiax-1/capability/max_power_3000',
        { value: '2' },
      );
    } finally {
      restoreMockRestClient();
    }
  });

  it('ignores native stepped-load local write echoes as reported step feedback', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'hoiax-1': buildHoiaxDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get, put });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getNativeEvWiringEnabled: () => true,
          getDeviceControlProfile: () => steppedProfile,
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });

      const liveStateObserved = vi.fn();
      const realtimeReconcile = vi.fn();
      deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateObserved);
      deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeReconcile);

      await expect(setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'hoiax-1',
        profile: steppedProfile,
        desiredStepId: 'max',
        setCapability: (capabilityId, value) => deviceManager.setCapability('hoiax-1', capabilityId, value),
      }))
        .resolves.toBe(true);

      expect(put).toHaveBeenCalledWith(
        'manager/devices/device/hoiax-1/capability/max_power_3000',
        { value: '3' },
      );

      deviceManager.injectCapabilityUpdateForTest('hoiax-1', 'max_power_3000', '3');

      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        reportedStepId: 'medium',
      }));
      expect(liveStateObserved).not.toHaveBeenCalled();
      expect(realtimeReconcile).not.toHaveBeenCalled();
    } finally {
      restoreMockRestClient();
    }
  });

  it('clears fallback off-step reporting when native onoff turns back on', async () => {
    const offDevice = {
      ...buildHoiaxDevice(),
      capabilitiesObj: {
        ...buildHoiaxDevice().capabilitiesObj,
        onoff: { value: false, setable: true },
        max_power_3000: { value: undefined, setable: true },
      },
    };
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'hoiax-1': offDevice };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    setRestClient({ get, put: vi.fn().mockResolvedValue(undefined) });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getNativeEvWiringEnabled: () => true,
          getDeviceControlProfile: () => steppedProfile,
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });
      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        currentOn: false,
        reportedStepId: 'off',
      }));

      const realtimeReconcile = vi.fn();
      deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeReconcile);
      deviceManager.injectCapabilityUpdateForTest('hoiax-1', 'onoff', true);

      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        currentOn: true,
      }));
      expect(deviceManager.getSnapshot()[0]).not.toHaveProperty('reportedStepId');
      expect(realtimeReconcile).toHaveBeenCalledWith({
        deviceId: 'hoiax-1',
        name: 'Connected 300',
        changes: [{
          capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
          previousValue: 'off',
          nextValue: 'unknown',
        }],
      });
    } finally {
      restoreMockRestClient();
    }
  });

  it('uses driver overrides when caching native stepped-load command adapters', async () => {
    const rawMockDevice = {
      ...buildHoiaxDevice(),
      id: 'hoiax-mock',
      name: 'Connected 300 Mock',
      driverId: 'homey:app:com.example:heater',
      ownerUri: 'homey:app:com.example',
    } satisfies HomeyDeviceLike;
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'hoiax-mock': rawMockDevice };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get, put });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getNativeEvWiringEnabled: () => true,
          getDeviceControlProfile: () => steppedProfile,
          getDeviceDriverIdOverride: (deviceId) => (
            deviceId === 'hoiax-mock' ? 'homey:app:no.hoiax:connected300' : undefined
          ),
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });

      await expect(setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'hoiax-mock',
        profile: steppedProfile,
        desiredStepId: 'medium',
        setCapability: (capabilityId, value) => deviceManager.setCapability('hoiax-mock', capabilityId, value),
      }))
        .resolves.toBe(true);

      expect(put).toHaveBeenCalledWith(
        'manager/devices/device/hoiax-mock/capability/max_power_3000',
        { value: '2' },
      );
    } finally {
      setRestClient({
        get: (path) => mockHomeyInstance.api.get(path),
        put: (path, body) => mockHomeyInstance.api.put(path, body),
      });
    }
  });

  it('exposes Zaptec native stepped-load wiring automatically with the built-in 1-phase profile', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);
    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go-1',
      controlAdapter: expect.objectContaining({
        activationEnabled: true,
      }),
      suggestedSteppedLoadProfile: ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE,
      reportedStepId: '16a',
      nativeSteppedLoadStatus: expect.objectContaining({
        modelLabel: 'Zaptec stepped current: 1-phase default model',
        currentStepLabel: 'Current stepped model: 16a / 3.68 kW',
      }),
    }));
  });

  it('runs Zaptec stepped-load commands through the external flow card instead of a capability write', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'zaptec-go-1': buildZaptecDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn().mockResolvedValue({ ok: true });
    setRestClient({ get, post, put });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getExperimentalEvSupportEnabled: () => true,
          getNativeEvWiringEnabled: () => true,
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });

      await expect(setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'zaptec-go-1',
        profile: ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE,
        desiredStepId: '20a',
        setCapability: (capabilityId, value) => deviceManager.setCapability('zaptec-go-1', capabilityId, value),
      })).resolves.toBe(true);

      expect(post).toHaveBeenCalledWith(
        'manager/flow/flowcardaction/homey%3Aapp%3Acom.zaptec/installation_current_control/run',
        {
          args: {
            device: { id: 'zaptec-go-1', name: 'Zaptec Go' },
            current1: 20,
            current2: 0,
            current3: 0,
          },
        },
      );
      expect(put).not.toHaveBeenCalledWith(
        expect.stringContaining('/capability/available_installation_current'),
        expect.anything(),
      );
    } finally {
      setRestClient({
        get: (path) => mockHomeyInstance.api.get(path),
        put: (path, body) => mockHomeyInstance.api.put(path, body),
      });
    }
  });

  it('falls back to binary control when Zaptec chargers share an installation', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
        getNativeEvWiringEnabled: () => true,
      },
    );

    const parsed = deviceManager.parseDeviceListForTests([
      buildZaptecDevice({ id: 'zaptec-a', data: { id: 'zaptec-a', installationId: 'shared-1' } }),
      buildZaptecDevice({ id: 'zaptec-b', data: { id: 'zaptec-b', installationId: 'shared-1' } }),
    ]);

    expect(parsed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'zaptec-a',
        suggestedSteppedLoadProfile: undefined,
        nativeSteppedLoadStatus: expect.objectContaining({
          blockedReasonCode: 'zaptec_stepped_blocked_shared_installation',
        }),
      }),
      expect.objectContaining({
        id: 'zaptec-b',
        suggestedSteppedLoadProfile: undefined,
        nativeSteppedLoadStatus: expect.objectContaining({
          blockedReasonCode: 'zaptec_stepped_blocked_shared_installation',
        }),
      }),
    ]));
  });

  it('blocks the Zaptec stepped session when measured power is far above the built-in model', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'zaptec-go-1': buildZaptecDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    setRestClient({ get, post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue(undefined) });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getExperimentalEvSupportEnabled: () => true,
          getNativeEvWiringEnabled: () => true,
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'available_installation_current', 6);
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'measure_power', 2500);
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'measure_power', 2600);

      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        nativeSteppedLoadStatus: expect.objectContaining({
          blockedReasonCode: 'zaptec_stepped_blocked_power_mismatch',
        }),
      }));
    } finally {
      restoreMockRestClient();
    }
  });

  it('clears a Zaptec power-mismatch block on normalized disconnect updates', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'zaptec-go-1': buildZaptecDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    setRestClient({ get, post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue(undefined) });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getExperimentalEvSupportEnabled: () => true,
          getNativeEvWiringEnabled: () => true,
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'available_installation_current', 6);
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'measure_power', 2500);
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'measure_power', 2600);
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'alarm_generic.car_connected', false);

      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        suggestedSteppedLoadProfile: ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE,
        nativeSteppedLoadStatus: expect.objectContaining({
          blockedReasonCode: undefined,
        }),
        reportedStepId: 'off',
      }));
    } finally {
      restoreMockRestClient();
    }
  });

  it('does not block Zaptec mismatch validation while a higher step is still pending confirmation', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') {
        return {
          'zaptec-go-1': buildZaptecDevice({
            capabilitiesObj: {
              measure_power: { value: 1380, lastUpdated: '2026-04-22T09:00:00.000Z' },
              available_installation_current: { value: 6, lastUpdated: '2026-04-22T09:00:01.000Z' },
              charging_button: { value: true, setable: true, lastUpdated: '2026-04-22T09:00:02.000Z' },
              charge_mode: { value: 'Charging', lastUpdated: '2026-04-22T09:00:03.000Z' },
              'alarm_generic.car_connected': { value: true, lastUpdated: '2026-04-22T09:00:04.000Z' },
            },
          }),
        };
      }
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const post = vi.fn().mockResolvedValue({ ok: true });
    setRestClient({ get, post, put: vi.fn().mockResolvedValue(undefined) });
    try {
      const deviceManager = new DeviceManager(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getExperimentalEvSupportEnabled: () => true,
          getNativeEvWiringEnabled: () => true,
        },
      );

      await deviceManager.refreshSnapshot({ includeLivePower: false });
      await setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: 'zaptec-go-1',
        profile: ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE,
        desiredStepId: '20a',
        setCapability: (capabilityId, value) => deviceManager.setCapability('zaptec-go-1', capabilityId, value),
      });

      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'measure_power', 2500);
      deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'measure_power', 2600);

      expect(post).toHaveBeenCalled();
      expect(deviceManager.getSnapshot()[0].nativeSteppedLoadStatus?.blockedReasonCode).toBeUndefined();
    } finally {
      restoreMockRestClient();
    }
  });

  it('rebuilds the stepped adapter when a realtime device update switches provider kind', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
        getNativeEvWiringEnabled: () => true,
      },
    );

    deviceManager.parseDeviceListForTests([
      { ...buildHoiaxDevice(), id: 'switch-device' },
    ]);

    deviceManager.injectDeviceUpdateForTest(buildZaptecDevice({
      id: 'switch-device',
      data: {
        id: 'switch-device',
        installationId: 'inst-switch',
      },
    }));

    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
      id: 'switch-device',
      suggestedSteppedLoadProfile: ZAPTEC_NATIVE_STEPPED_LOAD_PROFILE,
      nativeSteppedLoadStatus: expect.objectContaining({
        provider: 'zaptec',
      }),
    }));
  });

  it('recomputes shared-installation blocking from current realtime topology', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
        getNativeEvWiringEnabled: () => true,
      },
    );

    deviceManager.parseDeviceListForTests([
      buildZaptecDevice({ id: 'zaptec-a', data: { id: 'zaptec-a', installationId: 'inst-a' } }),
      buildZaptecDevice({ id: 'zaptec-b', data: { id: 'zaptec-b', installationId: 'inst-b' } }),
    ]);

    deviceManager.injectDeviceUpdateForTest(buildZaptecDevice({
      id: 'zaptec-b',
      data: {
        id: 'zaptec-b',
        installationId: 'inst-a',
      },
    }));

    const snapshotById = new Map(deviceManager.getSnapshot().map((device) => [device.id, device]));
    expect(snapshotById.get('zaptec-b')).toEqual(expect.objectContaining({
      suggestedSteppedLoadProfile: undefined,
      nativeSteppedLoadStatus: expect.objectContaining({
        blockedReasonCode: 'zaptec_stepped_blocked_shared_installation',
      }),
    }));
  });
});
