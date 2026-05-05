import Homey from 'homey';
import {
  DeviceManager,
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
} from '../lib/core/deviceManager';
import {
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadProfileSuggestion,
  resolveNativeSteppedLoadReportedStepId,
} from '../lib/core/nativeSteppedLoadWiring';
import { setObservedNativeSteppedLoadStep } from '../lib/core/deviceManagerNativeSteppedCommand';
import { applySteppedLoadCommand, type PlanExecutorSteppedContext } from '../lib/executor/steppedLoadExecutor';
import { buildExecutableSteppedLoadDevice } from '../lib/executor/executableSteppedLoadProjection';
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

const buildTargetPowerDevice = (overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  id: 'target-power-1',
  name: 'Target power charger',
  class: 'evcharger',
  driverId: 'homey:app:com.example:charger',
  ownerUri: 'homey:app:com.example',
  capabilities: ['measure_power', 'target_power'],
  capabilitiesObj: {
    measure_power: { value: 1380 },
    target_power: {
      value: 1380,
      min: 0,
      max: 3680,
      step: 460,
      excludeMin: 1,
      excludeMax: 1380,
      setable: true,
      lastUpdated: '2026-05-04T06:00:00.000Z',
    },
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

  it('builds a stepped-load profile from setable target_power capability options', () => {
    const device = buildTargetPowerDevice();

    expect(resolveNativeSteppedLoadProfileSuggestion({
      device,
      capabilities: device.capabilities ?? [],
      capabilityObj: device.capabilitiesObj as NonNullable<HomeyDeviceLike['capabilitiesObj']>,
    })).toEqual({
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: '1380w', planningPowerW: 1380 },
        { id: '1840w', planningPowerW: 1840 },
        { id: '2300w', planningPowerW: 2300 },
        { id: '2760w', planningPowerW: 2760 },
        { id: '3220w', planningPowerW: 3220 },
        { id: '3680w', planningPowerW: 3680 },
      ],
    });
  });

  it('supports target_power EV charger phase presets', () => {
    const device = buildTargetPowerDevice({
      settings: { pelsTargetPowerPreset: 'ev_charger_3_phase' },
    });

    expect(resolveNativeSteppedLoadProfileSuggestion({
      device,
      capabilities: device.capabilities ?? [],
      capabilityObj: device.capabilitiesObj as NonNullable<HomeyDeviceLike['capabilitiesObj']>,
    })).toEqual({
      model: 'stepped_load',
      steps: expect.arrayContaining([
        { id: 'off', planningPowerW: 0 },
        { id: '6a', planningPowerW: 4140 },
        { id: '16a', planningPowerW: 11040 },
        { id: '32a', planningPowerW: 22080 },
      ]),
    });
  });

  it('supports target_power EV charger phase presets from snake-case settings', () => {
    const device = buildTargetPowerDevice({
      settings: { pels_target_power_preset: 'ev_charger_1_phase' },
    });

    expect(resolveNativeSteppedLoadProfileSuggestion({
      device,
      capabilities: device.capabilities ?? [],
      capabilityObj: device.capabilitiesObj as NonNullable<HomeyDeviceLike['capabilitiesObj']>,
    })).toEqual({
      model: 'stepped_load',
      steps: expect.arrayContaining([
        { id: 'off', planningPowerW: 0 },
        { id: '6a', planningPowerW: 1380 },
        { id: '16a', planningPowerW: 3680 },
        { id: '32a', planningPowerW: 7360 },
      ]),
    });
  });

  it('maps target_power observations and commands through the stepped-load profile', () => {
    const profile: SteppedLoadProfile = {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: '6a', planningPowerW: 1380 },
        { id: '8a', planningPowerW: 1840 },
      ],
    };

    expect(resolveNativeSteppedLoadReportedStepId({
      profile,
      capabilities: ['target_power'],
      capabilityObj: { target_power: { value: 1840, setable: true } },
    })).toBe('8a');
    expect(resolveNativeSteppedLoadCommand({
      profile,
      desiredStepId: 'off',
      capabilities: ['target_power'],
      capabilityObj: { target_power: { value: 1840, setable: true } },
    })).toEqual({ capabilityId: 'target_power', value: 0 });
    expect(resolveNativeSteppedLoadCommand({
      profile,
      desiredStepId: '6a',
      capabilities: ['target_power'],
      capabilityObj: { target_power: { value: 1840, setable: true } },
    })).toEqual({ capabilityId: 'target_power', value: 1380 });
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

  it('projects target_power controls as stepped-load wiring at the observation boundary', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildTargetPowerDevice()]);
    expect(parsed).toEqual(expect.objectContaining({
      id: 'target-power-1',
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: false,
        activationRequired: false,
        activationEnabled: true,
      },
      controlModel: 'stepped_load',
      reportedStepId: '1380w',
      suggestedSteppedLoadProfile: expect.objectContaining({
        model: 'stepped_load',
      }),
      steppedLoadProfile: expect.objectContaining({
        model: 'stepped_load',
      }),
    }));
    expect(parsed.capabilities).not.toContain('target_power');
  });

  it('applies saved target_power configs to devices that already expose target_power', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
        getDeviceTargetPowerConfig: (deviceId) => (
          deviceId === 'target-power-1'
            ? { enabled: true, preset: 'ev_charger_3_phase' }
            : undefined
        ),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildTargetPowerDevice({
      capabilitiesObj: {
        measure_power: { value: 4140 },
        target_power: {
          value: 4140,
          setable: true,
          min: 1380,
          max: 3680,
          step: 460,
        },
      },
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'target-power-1',
      controlModel: 'stepped_load',
      targetPowerConfig: { enabled: true, preset: 'ev_charger_3_phase' },
      reportedStepId: '6a',
      steppedLoadProfile: expect.objectContaining({
        model: 'stepped_load',
        steps: expect.arrayContaining([
          { id: '6a', planningPowerW: 4140 },
          { id: '16a', planningPowerW: 11040 },
        ]),
      }),
    }));
    expect(parsed.capabilities).not.toContain('target_power');
  });

  it('projects configured target_power details as stepped-load without a native command adapter', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
        getDeviceTargetPowerConfig: (deviceId) => (
          deviceId === 'synthetic-target-power-1'
            ? { enabled: true, preset: 'ev_charger_1_phase' }
            : undefined
        ),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildTargetPowerDevice({
      id: 'synthetic-target-power-1',
      capabilities: ['measure_power'],
      capabilitiesObj: {
        measure_power: { value: 920 },
      },
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'synthetic-target-power-1',
      controlAdapter: undefined,
      controlModel: 'stepped_load',
      targetPowerConfig: { enabled: true, preset: 'ev_charger_1_phase' },
      steppedLoadProfile: expect.objectContaining({
        model: 'stepped_load',
        steps: expect.arrayContaining([
          { id: '6a', planningPowerW: 1380 },
          { id: '16a', planningPowerW: 3680 },
        ]),
      }),
    }));
  });

  it('parses test-device target_power compatibility metadata from JSON string settings', () => {
    const deviceManager = new DeviceManager(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getExperimentalEvSupportEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildTargetPowerDevice({
      id: 'test-device-target-power-1',
      ownerUri: 'homey:app:com.olemarkus.testdevices',
      driverId: 'homey:app:com.olemarkus.testdevices:mock',
      capabilities: ['measure_power'],
      capabilitiesObj: {
        measure_power: { value: 460 },
      },
      settings: {
        pelsCompatibilityOwnerUri: 'homey:app:com.example',
        pelsCompatibilityDriverId: 'homey:app:com.example:charger',
        pelsCompatibilityTargetPower: JSON.stringify({
          preset: 'ev_charger_1_phase',
          min: 0,
          max: 7360,
          step: 460,
          excludeMin: 1,
          excludeMax: 1380,
        }),
      },
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'test-device-target-power-1',
      controlAdapter: undefined,
      controlModel: 'stepped_load',
      targetPowerConfig: {
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
        excludeMin: 1,
        excludeMax: 1380,
      },
      steppedLoadProfile: expect.objectContaining({
        model: 'stepped_load',
      }),
    }));
  });

  it('uses target_power capability writes for target_power stepped-load commands', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'target-power-1': buildTargetPowerDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get, post: vi.fn().mockResolvedValue({ ok: true }), put });
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
        deviceId: 'target-power-1',
        profile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: '8a', planningPowerW: 1840 },
          ],
        },
        desiredStepId: '8a',
        setCapability: (capabilityId, value) => deviceManager.setCapability('target-power-1', capabilityId, value),
      })).resolves.toBe(true);

      expect(put).toHaveBeenCalledWith(
        'manager/devices/device/target-power-1/capability/target_power',
        { value: 1840 },
      );
    } finally {
      restoreMockRestClient();
    }
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

  it('triggers the stepped-load flow for configured target_power models without native capability support', async () => {
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
      id: 'synthetic-target-power-1',
      name: 'Configured charger',
      currentOn: true,
      currentState: 'on',
      plannedState: 'shed',
      currentTarget: null,
      plannedTarget: null,
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: '6a', planningPowerW: 1380 },
          { id: '8a', planningPowerW: 1840 },
        ],
      },
      selectedStepId: '8a',
      desiredStepId: '6a',
      shedAction: 'set_step',
      reason: { code: 'overCapacity', label: 'over capacity' },
    });

    expect(action).not.toBeNull();
    const wrote = await applySteppedLoadCommand(ctx, action!, 'plan');

    expect(wrote).toBe(true);
    expect(setNativeSteppedLoadStep).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith({
      step_id: '6a',
      planning_power_w: 1380,
      planning_current_a: 0,
      previous_step_id: '8a',
    }, {
      deviceId: 'synthetic-target-power-1',
    });
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'synthetic-target-power-1',
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      desiredStepId: '6a',
    }));
  });

  it('triggers the stepped-load flow for EV target-power presets with native EV wiring', async () => {
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
      id: 'zaptec-go-1',
      name: 'Zaptec Go',
      currentOn: true,
      currentState: 'on',
      plannedState: 'shed',
      currentTarget: null,
      plannedTarget: null,
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: '6a', planningPowerW: 4140 },
          { id: '16a', planningPowerW: 11040 },
        ],
      },
      selectedStepId: '16a',
      desiredStepId: '6a',
      controlCapabilityId: 'evcharger_charging',
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: true,
        activationEnabled: true,
      },
      targetPowerConfig: { enabled: true, preset: 'ev_charger_3_phase' },
      shedAction: 'set_step',
      reason: { code: 'overCapacity', label: 'over capacity' },
    });

    expect(action).not.toBeNull();
    const wrote = await applySteppedLoadCommand(ctx, action!, 'plan');

    expect(wrote).toBe(true);
    expect(setNativeSteppedLoadStep).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith({
      step_id: '6a',
      planning_power_w: 4140,
      planning_current_a: 4140 / (230 * 3),
      previous_step_id: '16a',
    }, {
      deviceId: 'zaptec-go-1',
    });
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'zaptec-go-1',
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      desiredStepId: '6a',
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
      expect(liveStateObserved).toHaveBeenCalledWith(expect.objectContaining({
        source: 'realtime_capability',
        deviceId: 'hoiax-1',
        observationSeq: 1,
        observedAtMs: expect.any(Number),
        capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      }));
      expect(realtimeReconcile).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: 'hoiax-1',
        observationSeq: 1,
        observedAtMs: expect.any(Number),
        name: 'Connected 300',
        changes: [{
          capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
          previousValue: 'medium',
          nextValue: 'max',
        }],
      }));

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
      expect(realtimeReconcile).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: 'hoiax-1',
        name: 'Connected 300',
        changes: [{
          capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
          previousValue: 'off',
          nextValue: 'unknown',
        }],
      }));
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

});
