import Homey from 'homey';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { setRestClient, resetRestClient } from '../../lib/device/transport/managerHomeyApi';
import {
  applyNativeEvWiringOverlay,
  buildNativeEvObservationCapabilityObj,
  normalizeNativeEvCapabilityUpdate,
} from '../../lib/device/nativeEvWiring';
import type { Logger, HomeyDeviceLike } from '../../lib/utils/types';
import { mockHomeyInstance } from '../mocks/homey';

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

const buildZaptecDevice = (overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  id: 'zaptec-go-1',
  name: 'Zaptec Go',
  class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go',
  ownerUri: 'homey:app:com.zaptec',
  capabilities: [
    'measure_power',
    'available_installation_current',
    'charging_button',
    'charge_mode',
    'alarm_generic.car_connected',
  ],
  capabilitiesObj: {
    measure_power: { value: 7200 },
    available_installation_current: { value: 16, lastUpdated: '2026-04-22T09:00:00.000Z' },
    charging_button: { value: false, setable: true, lastUpdated: '2026-04-22T09:00:01.000Z' },
    charge_mode: { value: 'Connecting to car', lastUpdated: '2026-04-22T09:00:02.000Z' },
    'alarm_generic.car_connected': { value: true, lastUpdated: '2026-04-22T09:00:03.000Z' },
  },
  data: { id: 'zaptec-go-1', installationId: 'inst-1' },
  available: true,
  ready: true,
  ...overrides,
});

describe('native EV wiring shim', () => {
  afterEach(() => {
    resetRestClient();
    vi.restoreAllMocks();
  });

  it('always wires Zaptec Go through the native EV shim without any opt-in', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {},
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go-1',
      deviceClass: 'evcharger',
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: false,
        activationEnabled: true,
      },
      controlCapabilityId: 'evcharger_charging',
      controlWriteCapabilityId: 'charging_button',
      powerCapable: true,
    }));
  });

  it('keeps Zaptec wired even when the legacy native_ev_wiring_devices entry is explicitly false', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => false,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go-1',
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: false,
        activationEnabled: true,
      },
      controlCapabilityId: 'evcharger_charging',
      controlWriteCapabilityId: 'charging_button',
    }));
  });

  it('maps Zaptec native capabilities to EV charger capabilities when native wiring is enabled', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      controlCapabilityId: 'evcharger_charging',
      controlAdapter: expect.objectContaining({
        kind: 'capability_adapter',
        activationEnabled: true,
      }),
      controlWriteCapabilityId: 'charging_button',
      controlObservationCapabilityId: 'evcharger_charging',
      binaryControl: { on: false },
      evChargingState: 'plugged_in_paused',
      canSetControl: true,
    }));
  });

  it('maps Zaptec available installation current into EV preset stepped-load observations', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
        getDeviceTargetPowerConfig: (deviceId) => (
          deviceId === 'zaptec-go-1'
            ? { enabled: true, preset: 'ev_charger_3_phase' }
            : undefined
        ),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go-1',
      controlCapabilityId: 'evcharger_charging',
      controlWriteCapabilityId: 'charging_button',
      controlAdapter: expect.objectContaining({
        kind: 'capability_adapter',
        activationRequired: false,
        activationEnabled: true,
      }),
      controlModel: 'stepped_load',
      reportedStepId: '16a',
      steppedLoadProfile: expect.objectContaining({
        model: 'stepped_load',
        steps: expect.arrayContaining([
          { id: '6a', planningPowerW: 4140, planningCurrentA: 6 },
          { id: '16a', planningPowerW: 11040, planningCurrentA: 16 },
        ]),
      }),
      targetPowerConfig: { enabled: true, preset: 'ev_charger_3_phase' },
    }));
    expect(parsed.capabilities).toContain('target_power');
    // The target_power here is synthetic (Zaptec has no real setable
    // target_power); PELS drives the charger via charging_button, not
    // target_power, so it must NOT be reported as a native-write capability
    // for the flow-conflict signal.
    expect(parsed.nativeWriteCapabilities).toBeUndefined();
  });

  it('updates EV preset stepped-load observation from realtime available installation current', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { 'zaptec-go-1': buildZaptecDevice() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    setRestClient({ get, put: vi.fn().mockResolvedValue(undefined) });
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
        getDeviceTargetPowerConfig: (deviceId) => (
          deviceId === 'zaptec-go-1'
            ? { enabled: true, preset: 'ev_charger_3_phase' }
            : undefined
        ),
      },
    );

    await deviceManager.refreshSnapshot({ includeLivePower: false });
    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
      reportedStepId: '16a',
    }));

    deviceManager.injectCapabilityUpdateForTest('zaptec-go-1', 'available_installation_current', 10);

    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
      reportedStepId: '10a',
    }));
  });

  it('accepts the real Zaptec app when Homey reports the full driver URI', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice({
      driverId: 'homey:app:com.zaptec:go',
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go-1',
      controlCapabilityId: 'evcharger_charging',
      controlAdapter: expect.objectContaining({
        kind: 'capability_adapter',
        activationEnabled: true,
      }),
      controlWriteCapabilityId: 'charging_button',
      controlObservationCapabilityId: 'evcharger_charging',
      binaryControl: { on: false },
      evChargingState: 'plugged_in_paused',
      powerCapable: true,
    }));
  });

  it('uses a device driver override to treat a mock device as Zaptec Go 2', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
        getDeviceDriverIdOverride: (id) => (
          id === 'zaptec-go2-mock' ? 'homey:app:com.zaptec:go2' : undefined
        ),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice({
      id: 'zaptec-go2-mock',
      name: 'Zaptec Go 2 Mock',
      driverId: 'homey:app:com.olemarkus.testdevices:go2',
      ownerUri: 'homey:app:com.olemarkus.testdevices',
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go2-mock',
      name: 'Zaptec Go 2 Mock',
      controlCapabilityId: 'evcharger_charging',
      controlAdapter: expect.objectContaining({
        kind: 'capability_adapter',
        activationEnabled: true,
      }),
      controlWriteCapabilityId: 'charging_button',
      binaryControl: { on: false },
      evChargingState: 'plugged_in_paused',
      canSetControl: true,
    }));
  });

  it('uses compatibility settings to classify a test-device mock as the real driver', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice({
      id: 'zaptec-go2-compat-mock',
      name: 'Zaptec Go 2 compatibility mock',
      driverId: 'homey:app:com.olemarkus.testdevices:go2',
      ownerUri: 'homey:app:com.olemarkus.testdevices',
      settings: {
        pelsCompatibilityOwnerUri: 'homey:app:com.zaptec',
        pelsCompatibilityDriverId: 'homey:app:com.zaptec:go2',
      },
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go2-compat-mock',
      name: 'Zaptec Go 2 compatibility mock',
      controlCapabilityId: 'evcharger_charging',
      controlAdapter: expect.objectContaining({
        kind: 'capability_adapter',
        activationEnabled: true,
      }),
      binaryControl: { on: false },
      evChargingState: 'plugged_in_paused',
      canSetControl: true,
    }));
  });

  it('drops Zaptec-like devices when driverId is missing or not a supported Zaptec driver', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    expect(deviceManager.parseDeviceListForTests([
      buildZaptecDevice({
        id: 'zaptec-missing-driver',
        driverId: undefined,
      }),
    ])).toEqual([]);
    expect(deviceManager.parseDeviceListForTests([
      buildZaptecDevice({
        id: 'zaptec-clone-go',
        driverId: 'homey:app:com.zaptecclone:go',
      }),
    ])).toEqual([]);
    expect(deviceManager.parseDeviceListForTests([
      buildZaptecDevice({
        id: 'zaptec-testdevices-go2',
        driverId: 'homey:app:com.olemarkus.testdevices:go2',
        ownerUri: 'homey:app:com.olemarkus.testdevices',
      }),
    ])).toEqual([]);
  });

  it('accepts Zaptec Home and Pro through the same native EV wiring path', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [home, pro] = deviceManager.parseDeviceListForTests([
      buildZaptecDevice({ id: 'zaptec-home', driverId: 'homey:app:com.zaptec:home' }),
      buildZaptecDevice({ id: 'zaptec-pro', driverId: 'homey:app:com.zaptec:pro' }),
    ]);

    expect(home).toEqual(expect.objectContaining({
      id: 'zaptec-home',
      controlCapabilityId: 'evcharger_charging',
    }));
    expect(pro).toEqual(expect.objectContaining({
      id: 'zaptec-pro',
      controlCapabilityId: 'evcharger_charging',
    }));
  });

  it('uses the freshest source timestamps for synthesized EV capabilities', () => {
    const device = buildZaptecDevice();
    const overlay = applyNativeEvWiringOverlay({
      device,
      capabilities: [...device.capabilities],
      capabilityObj: {
        measure_power: { value: 7200 },
        charging_button: { value: false, setable: true, lastUpdated: '2026-04-22T09:00:01.000Z' },
        charge_mode: { value: 'Connecting to car', lastUpdated: '2026-04-22T09:00:05.000Z' },
        'alarm_generic.car_connected': { value: true, lastUpdated: '2026-04-22T09:00:07.000Z' },
      },
    });

    expect(overlay.capabilityObj.evcharger_charging?.lastUpdated).toBe('2026-04-22T09:00:05.000Z');
    expect(overlay.capabilityObj.evcharger_charging_state?.lastUpdated).toBe('2026-04-22T09:00:07.000Z');
  });

  it('keeps native evcharger capabilities ahead of the Zaptec shim', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice({
      capabilities: [
        'measure_power',
        'charging_button',
        'charge_mode',
        'alarm_generic.car_connected',
        'evcharger_charging',
        'evcharger_charging_state',
      ],
      capabilitiesObj: {
        measure_power: { value: 7200 },
        charging_button: { value: true, setable: true },
        charge_mode: { value: 'Connecting to car' },
        'alarm_generic.car_connected': { value: true },
        evcharger_charging: { value: true, setable: false },
        evcharger_charging_state: { value: 'plugged_in_charging' },
      },
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      controlCapabilityId: 'evcharger_charging',
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: false,
        activationEnabled: false,
      },
      controlWriteCapabilityId: undefined,
      controlObservationCapabilityId: undefined,
      binaryControl: { on: true },
      evChargingState: 'plugged_in_charging',
      canSetControl: false,
    }));
  });

  it('ignores flow-backed EV reports when Zaptec already has native evcharger support', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
        getFlowReportedCapabilities: () => ({
          evcharger_charging: { value: false, reportedAt: 100, source: 'flow' },
          'alarm_generic.car_connected': { value: false, reportedAt: 100, source: 'flow' },
          pels_evcharger_resumable: { value: true, reportedAt: 100, source: 'flow' },
        }),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice({
      capabilities: [
        'measure_power',
        'charging_button',
        'charge_mode',
        'alarm_generic.car_connected',
        'evcharger_charging',
        'evcharger_charging_state',
      ],
      capabilitiesObj: {
        measure_power: { value: 7200 },
        charging_button: { value: false, setable: true },
        charge_mode: { value: 'Connecting to car' },
        'alarm_generic.car_connected': { value: true },
        evcharger_charging: { value: true, setable: false },
        evcharger_charging_state: { value: 'plugged_in_charging' },
      },
    })]);

    expect(parsed).toEqual(expect.objectContaining({
      binaryControl: { on: true },
      evChargingState: 'plugged_in_charging',
    }));
    expect(parsed.flowBackedCapabilityIds).toBeUndefined();
  });

  it('keeps the Zaptec shim ahead of flow-backed charging reports when enabled', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
        getFlowReportedCapabilities: () => ({
          evcharger_charging: { value: true, reportedAt: 100, source: 'flow' },
          'alarm_generic.car_connected': { value: true, reportedAt: 100, source: 'flow' },
          pels_evcharger_resumable: { value: true, reportedAt: 100, source: 'flow' },
        }),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      controlCapabilityId: 'evcharger_charging',
      controlWriteCapabilityId: 'charging_button',
      binaryControl: { on: false },
      evChargingState: 'plugged_in_paused',
    }));
    expect(parsed.flowBackedCapabilityIds).toBeUndefined();
  });

  it('ignores flow-backed EV reports when Zaptec shim wiring is active', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getManaged: () => true,
        getNativeEvWiringEnabled: () => true,
        getFlowReportedCapabilities: () => ({
          evcharger_charging: { value: true, reportedAt: 100, source: 'flow' },
          'alarm_generic.car_connected': { value: false, reportedAt: 100, source: 'flow' },
          pels_evcharger_resumable: { value: true, reportedAt: 100, source: 'flow' },
        }),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      controlAdapter: expect.objectContaining({
        kind: 'capability_adapter',
        activationEnabled: true,
      }),
      binaryControl: { on: false },
      evChargingState: 'plugged_in_paused',
    }));
    expect(parsed.flowBackedCapabilityIds).toBeUndefined();
  });

  it('ignores flow-backed EV reports for unmanaged Zaptec candidates', () => {
    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getManaged: () => false,
        getFlowReportedCapabilities: () => ({
          evcharger_charging: { value: true, reportedAt: 100, source: 'flow' },
          'alarm_generic.car_connected': { value: true, reportedAt: 100, source: 'flow' },
          pels_evcharger_resumable: { value: true, reportedAt: 100, source: 'flow' },
        }),
      },
    );

    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);

    expect(parsed).toEqual(expect.objectContaining({
      id: 'zaptec-go-1',
      managed: false,
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: false,
        activationEnabled: true,
      },
      controlCapabilityId: 'evcharger_charging',
    }));
    expect(parsed.flowBacked).toBeUndefined();
    expect(parsed.flowBackedCapabilityIds).toBeUndefined();
  });

  it('writes the logical EV command through charging_button for Zaptec', async () => {
    const restClient = {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
    };
    setRestClient(restClient);

    const deviceManager = new DeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getNativeEvWiringEnabled: () => true,
      },
    );
    const [parsed] = deviceManager.parseDeviceListForTests([buildZaptecDevice()]);
    deviceManager.setSnapshotForTests([parsed]);

    await deviceManager.setCapability(parsed.id, 'evcharger_charging', true);

    expect(restClient.put).toHaveBeenCalledWith(
      'manager/devices/device/zaptec-go-1/capability/charging_button',
      { value: true },
    );
  });

  it('maps the real Zaptec charge_mode strings into EV charger states', () => {
    const device = buildZaptecDevice();
    const chargingOverlay = applyNativeEvWiringOverlay({
      device: {
        ...device,
        capabilitiesObj: {
          ...device.capabilitiesObj,
          charging_button: { value: true, setable: true },
          charge_mode: { value: 'Charging' },
          'alarm_generic.car_connected': { value: true },
        },
      },
      capabilities: [...device.capabilities],
      capabilityObj: {
        ...device.capabilitiesObj,
        charging_button: { value: true, setable: true },
        charge_mode: { value: 'Charging' },
        'alarm_generic.car_connected': { value: true },
      },
    });

    const finishedOverlay = applyNativeEvWiringOverlay({
      device: {
        ...device,
        capabilitiesObj: {
          ...device.capabilitiesObj,
          charging_button: { value: true, setable: true },
          charge_mode: { value: 'Charging finished' },
          'alarm_generic.car_connected': { value: true },
        },
      },
      capabilities: [...device.capabilities],
      capabilityObj: {
        ...device.capabilitiesObj,
        charging_button: { value: true, setable: true },
        charge_mode: { value: 'Charging finished' },
        'alarm_generic.car_connected': { value: true },
      },
    });

    const disconnectedOverlay = applyNativeEvWiringOverlay({
      device: {
        ...device,
        capabilitiesObj: {
          ...device.capabilitiesObj,
          charge_mode: { value: 'Disconnected' },
          'alarm_generic.car_connected': { value: false },
        },
      },
      capabilities: [...device.capabilities],
      capabilityObj: {
        ...device.capabilitiesObj,
        charge_mode: { value: 'Disconnected' },
        'alarm_generic.car_connected': { value: false },
      },
    });

    expect(chargingOverlay.capabilityObj.evcharger_charging?.value).toBe(true);
    expect(chargingOverlay.capabilityObj.evcharger_charging_state?.value).toBe('plugged_in_charging');
    expect(finishedOverlay.capabilityObj.evcharger_charging?.value).toBe(true);
    expect(finishedOverlay.capabilityObj.evcharger_charging_state?.value).toBe('plugged_in_paused');
    expect(disconnectedOverlay.capabilityObj.evcharger_charging?.value).toBe(false);
    expect(disconnectedOverlay.capabilityObj.evcharger_charging_state?.value).toBe('plugged_out');
  });

  it('normalizes Zaptec proprietary observations into canonical EV capabilities', () => {
    const device = buildZaptecDevice({
      capabilitiesObj: {
        measure_power: { value: 0 },
        charging_button: { value: false, setable: true, lastUpdated: '2026-04-22T09:00:01.000Z' },
        charge_mode: { value: 'Charging', lastUpdated: '2026-04-22T09:00:02.000Z' },
        'alarm_generic.car_connected': { value: true, lastUpdated: '2026-04-22T09:00:03.000Z' },
      },
    });

    const observedCapabilityObj = buildNativeEvObservationCapabilityObj({
      device,
      previousSnapshot: {
        controlAdapter: {
          kind: 'capability_adapter',
          activationRequired: true,
          activationEnabled: true,
        },
      },
    });
    const normalizedButtonUpdate = normalizeNativeEvCapabilityUpdate({
      snapshot: {
        controlAdapter: {
          kind: 'capability_adapter',
          activationRequired: true,
          activationEnabled: true,
        },
        binaryControl: { on: false },
        evChargingState: 'plugged_in_paused',
      },
      capabilityId: 'charging_button',
      value: true,
    });
    const normalizedChargeModeUpdate = normalizeNativeEvCapabilityUpdate({
      snapshot: {
        controlAdapter: {
          kind: 'capability_adapter',
          activationRequired: true,
          activationEnabled: true,
        },
        binaryControl: { on: false },
        evChargingState: 'plugged_in_paused',
      },
      capabilityId: 'charge_mode',
      value: 'Charging finished',
    });

    expect(observedCapabilityObj).toEqual(expect.objectContaining({
      evcharger_charging: expect.objectContaining({
        value: false,
      }),
      evcharger_charging_state: expect.objectContaining({
        value: 'plugged_in_charging',
      }),
    }));
    expect(normalizedButtonUpdate).toEqual([{ capabilityId: 'evcharger_charging', value: true }]);
    expect(normalizedChargeModeUpdate).toEqual([{
      capabilityId: 'evcharger_charging_state',
      value: 'plugged_in_paused',
    }]);
  });

  it('does not upgrade a paused Zaptec session to charging on car_connected=true alone', () => {
    const normalizedConnectedUpdate = normalizeNativeEvCapabilityUpdate({
      snapshot: {
        controlAdapter: {
          kind: 'capability_adapter',
          activationRequired: true,
          activationEnabled: true,
        },
        binaryControl: { on: true },
        evChargingState: 'plugged_in_paused',
      },
      capabilityId: 'alarm_generic.car_connected',
      value: true,
    });

    expect(normalizedConnectedUpdate).toEqual([{
      capabilityId: 'evcharger_charging_state',
      value: 'plugged_in_paused',
    }]);
  });

  it('keeps a charging Zaptec session as charging on car_connected=true', () => {
    const normalizedConnectedUpdate = normalizeNativeEvCapabilityUpdate({
      snapshot: {
        controlAdapter: {
          kind: 'capability_adapter',
          activationRequired: true,
          activationEnabled: true,
        },
        binaryControl: { on: true },
        evChargingState: 'plugged_in_charging',
      },
      capabilityId: 'alarm_generic.car_connected',
      value: true,
    });

    expect(normalizedConnectedUpdate).toEqual([{
      capabilityId: 'evcharger_charging_state',
      value: 'plugged_in_charging',
    }]);
  });
});
