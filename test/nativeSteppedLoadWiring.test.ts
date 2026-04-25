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
import { applySteppedLoadCommand, type PlanExecutorSteppedContext } from '../lib/plan/planExecutorStepped';
import { AppDeviceControlHelpers } from '../lib/app/appDeviceControlHelpers';
import type { HomeyDeviceLike, Logger, SteppedLoadProfile, TargetDeviceSnapshot } from '../lib/utils/types';
import { mockHomeyInstance } from './mocks/homey';
import { setRestClient } from '../lib/core/deviceManagerHomeyApi';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../lib/core/steppedLoadSyntheticCapabilities';

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
    })).toEqual({ capabilityId: 'max_power_3000', value: 'medium_power' });
    expect(resolveNativeSteppedLoadCommand({
      profile: steppedProfile,
      desiredStepId: 'medium',
      capabilities: ['onoff', 'max_power_3000'],
      capabilityObj: { max_power_3000: { value: undefined } },
    })).toEqual({ capabilityId: 'max_power_3000', value: 'medium_power' });
    expect(resolveNativeSteppedLoadCommand({
      profile: steppedProfile,
      desiredStepId: 'medium',
      capabilities: ['onoff', 'max_power'],
      capabilityObj: { max_power: { value: undefined } },
    })).toEqual({ capabilityId: 'max_power', value: 'medium_power' });
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
    })).toEqual({ capabilityId: 'max_power_3000', value: 'high_power' });
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
    const ctx = {
      state: {},
      logDebug: vi.fn(),
      error: vi.fn(),
      buildBinaryControlDeps: () => ({ deviceManager: { setNativeSteppedLoadStep } }),
      markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
      getDesiredSteppedLoadTrigger: () => ({ trigger }),
      setNativeSteppedLoadStep,
    } as unknown as PlanExecutorSteppedContext;

    const wrote = await applySteppedLoadCommand(ctx, {
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
    }, 'plan');

    expect(wrote).toBe(true);
    expect(setNativeSteppedLoadStep).toHaveBeenCalledWith('hoiax-1', steppedProfile, 'medium');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('applies native stepped-load commands from the cached observed adapter', async () => {
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
        { value: 'medium_power' },
      );

      put.mockClear();
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
        { value: 'medium_power' },
      );

      const liveStateObserved = vi.fn();
      const realtimeReconcile = vi.fn();
      deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateObserved);
      deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeReconcile);
      deviceManager.injectCapabilityUpdateForTest('hoiax-1', 'max_power_3000', 3);

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
        { value: 'medium_power' },
      );
    } finally {
      setRestClient({
        get: (path) => mockHomeyInstance.api.get(path),
        put: (path, body) => mockHomeyInstance.api.put(path, body),
      });
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
        { value: 'high_power' },
      );

      deviceManager.injectCapabilityUpdateForTest('hoiax-1', 'max_power_3000', 'high_power');

      expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
        reportedStepId: 'medium',
      }));
      expect(liveStateObserved).not.toHaveBeenCalled();
      expect(realtimeReconcile).not.toHaveBeenCalled();
    } finally {
      setRestClient({
        get: (path) => mockHomeyInstance.api.get(path),
        put: (path, body) => mockHomeyInstance.api.put(path, body),
      });
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
      setRestClient({
        get: (path) => mockHomeyInstance.api.get(path),
        put: (path, body) => mockHomeyInstance.api.put(path, body),
      });
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
        { value: 'medium_power' },
      );
    } finally {
      setRestClient({
        get: (path) => mockHomeyInstance.api.get(path),
        put: (path, body) => mockHomeyInstance.api.put(path, body),
      });
    }
  });
});
