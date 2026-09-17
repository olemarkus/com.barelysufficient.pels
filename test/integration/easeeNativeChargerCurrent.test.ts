import Homey from 'homey';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import {
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
} from '../../lib/device/nativeSteppedLoadWiring';
import { __resetNativeEvWiringLogStateForTests } from '../../lib/device/managerNativeEv';
import {
  buildEvTargetPowerCandidateProfile,
  buildTargetPowerReachabilityState,
} from '../../lib/device/targetPowerReachability';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import type { SteppedLoadProfile, TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { mockHomeyInstance } from '../mocks/homey';

// Shapes are taken from a production Easee charger on the deployed Easee app
// 2.0.5: `target_charger_current` is the setable dynamic charger current in amps,
// and the driver id / owner uri are the app's.
const EASEE_ID = 'easee-1';

const evPreset: TargetPowerSteppedLoadConfig = {
  enabled: true,
  preset: 'ev_charger_1_phase',
  max: 7_360,
};

const continuousPowerConfig: TargetPowerSteppedLoadConfig = {
  enabled: true,
  min: 0,
  max: 7_000,
  step: 1_000,
};

const presetProfile: SteppedLoadProfile = buildEvTargetPowerCandidateProfile(evPreset);

const EASEE_CAPABILITIES = [
  'onoff',
  'target_circuit_current',
  'target_charger_current',
  'measure_power',
  'evcharger_charging',
  'evcharger_charging_state',
];

const buildEaseeCapabilityObj = (
  capabilityOverrides: DeviceCapabilityMap = {},
): DeviceCapabilityMap => ({
  onoff: { value: true, setable: true },
  target_circuit_current: { value: 32, setable: true, min: 0, max: 40 },
  target_charger_current: {
    value: 16,
    setable: true,
    min: 0,
    max: 40,
    lastUpdated: '2026-09-15T04:41:52.000Z',
  },
  measure_power: { value: 3_600 },
  evcharger_charging: { value: true, setable: true },
  evcharger_charging_state: { value: 'plugged_in_charging' },
  ...capabilityOverrides,
});

const buildEaseeCharger = (
  capabilityOverrides: DeviceCapabilityMap = {},
): HomeyDeviceLike => ({
  id: EASEE_ID,
  name: 'Elbillader',
  class: 'evcharger',
  driverId: 'homey:app:no.easee:charger',
  ownerUri: 'homey:app:no.easee',
  capabilities: EASEE_CAPABILITIES,
  capabilitiesObj: buildEaseeCapabilityObj(capabilityOverrides),
  available: true,
  ready: true,
});

const createLogger = () => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}) as unknown as Logger;

const createEaseeTransport = (
  nativeWiringEnabled: boolean,
  targetPowerConfig: TargetPowerSteppedLoadConfig = evPreset,
) => createTestDeviceTransport(
  mockHomeyInstance as unknown as Homey.App,
  createLogger(),
  {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
    getDeviceTargetPowerConfig: (deviceId) => (deviceId === EASEE_ID ? targetPowerConfig : undefined),
    getNativeEvWiringEnabled: () => nativeWiringEnabled,
  },
);

const restoreMockRestClient = (): void => {
  setRestClient({
    get: (path) => mockHomeyInstance.api.get(path),
    post: (path, body) => mockHomeyInstance.api.post(path, body),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
};

let logCapture: LoggerCapture;
beforeEach(() => {
  logCapture = captureLogger();
  __resetNativeEvWiringLogStateForTests();
});
afterEach(() => { logCapture.restore(); });

describe('Easee native charger current', () => {
  it('writes a step as its whole-amp charger current, and the off step as 0 A', () => {
    const capabilityObj = buildEaseeCapabilityObj();

    expect(resolveNativeSteppedLoadCommand({
      profile: presetProfile,
      desiredStepId: '10a',
      capabilities: EASEE_CAPABILITIES,
      capabilityObj,
    })).toEqual({ capabilityId: 'target_charger_current', value: 10 });
    expect(resolveNativeSteppedLoadCommand({
      profile: presetProfile,
      desiredStepId: 'off',
      capabilities: EASEE_CAPABILITIES,
      capabilityObj,
    })).toEqual({ capabilityId: 'target_charger_current', value: 0 });
  });

  it('reads the step from the charger current, not from whether it is charging', () => {
    // The 32 A an Easee resets to on every start is reported as the 32 A rung.
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: presetProfile,
      capabilities: EASEE_CAPABILITIES,
      capabilityObj: buildEaseeCapabilityObj({ target_charger_current: { value: 32, setable: true } }),
    })).toBe('32a');
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: presetProfile,
      capabilities: EASEE_CAPABILITIES,
      capabilityObj: buildEaseeCapabilityObj({ target_charger_current: { value: 0, setable: true } }),
    })).toBe('off');
    // Paused (`onoff` false) while holding 16 A stays on the 16 A rung.
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: presetProfile,
      capabilities: EASEE_CAPABILITIES,
      capabilityObj: buildEaseeCapabilityObj({ onoff: { value: false, setable: true } }),
    })).toBe('16a');
  });

  it('offers built-in control on an EV preset and reads the step back when it is on', () => {
    const [parsed] = createEaseeTransport(true).parseDeviceListForTests([buildEaseeCharger()]);

    expect(parsed).toEqual(expect.objectContaining({
      id: EASEE_ID,
      controlModel: 'stepped_load',
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      reportedStepId: '16a',
      nativeWriteCapabilities: ['target_charger_current', 'setDynamicChargerCurrent'],
    }));
  });

  it('leaves the charger on the Flow while built-in control is off, still visible to the conflict gate', () => {
    const [parsed] = createEaseeTransport(false).parseDeviceListForTests([buildEaseeCharger()]);

    expect(parsed.controlAdapter).toEqual({
      kind: 'capability_adapter',
      activationAvailable: true,
      activationRequired: false,
      activationEnabled: false,
    });
    // Nothing reads `target_charger_current` as the step here: the owner's Flow
    // writes it and reports it.
    expect(parsed.reportedStepId).toBeUndefined();
    expect(parsed.nativeWriteCapabilities).toEqual(['target_charger_current', 'setDynamicChargerCurrent']);
  });

  it('keeps a continuous power model on Flow control even when built-in control is saved on', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { [EASEE_ID]: buildEaseeCharger() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get, put });
    mockHomeyInstance.flow._triggerCardTriggers.desired_stepped_load_changed = [];
    try {
      const deviceManager = createTestDeviceTransport(
        mockHomeyInstance as unknown as Homey.App,
        createLogger(),
        {
          getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
          getDeviceTargetPowerConfig: () => continuousPowerConfig,
          getNativeEvWiringEnabled: () => true,
        },
        undefined,
        { getFlowTriggerCard: (cardId) => mockHomeyInstance.flow.getTriggerCard(cardId) },
      );
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
      deviceManager.setSnapshotForTests([parsed!]);

      expect(parsed).toEqual(expect.objectContaining({
        controlModel: 'stepped_load',
        controlAdapter: undefined,
        nativeWriteCapabilities: undefined,
      }));
      await expect(deviceManager.requestSteppedLoadStep({
        deviceId: EASEE_ID,
        profile: parsed!.steppedLoadProfile!,
        desiredStepId: '1000w',
        planningPowerW: 1_000,
        planningCurrentA: 0,
      })).resolves.toEqual({ requested: true, transport: 'flow' });
      expect(put).not.toHaveBeenCalled();
    } finally {
      restoreMockRestClient();
    }
  });

  it('reports the control mode the charger app implies, for managed and unmanaged chargers alike', async () => {
    const reportingCharger = {
      ...buildEaseeCharger(),
      settings: { phaseMode: 'Locked to single phase', detectedPowerGridType: 'IT_1_PHASE' },
    };
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { [EASEE_ID]: reportingCharger };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    setRestClient({ get, put: vi.fn() });
    try {
      const deviceManager = createEaseeTransport(false);
      await deviceManager.refreshSnapshot({ includeLivePower: false, mainMeterSelection: { state: 'unavailable' } });

      expect(deviceManager.getChargerPhasePresets()).toEqual({ [EASEE_ID]: 'ev_charger_1_phase' });
    } finally {
      restoreMockRestClient();
    }
  });

  it('is not a built-in control candidate without a setable charger current', () => {
    const [parsed] = createEaseeTransport(true).parseDeviceListForTests([
      buildEaseeCharger({ target_charger_current: { value: 16, setable: false } }),
    ]);

    expect(parsed.controlAdapter).toBeUndefined();
    expect(parsed.nativeWriteCapabilities).toBeUndefined();
  });

  it('reports the charger current a live update carries, with its exact watts', () => {
    // As on production: the charger has already shown it reaches 32 A, so the
    // confirmed ladder carries the rung the start-of-session reset lands on.
    const config = {
      ...evPreset,
      reachability: buildTargetPowerReachabilityState({ config: evPreset, maxReachedPowerW: 7_360 }),
    };
    const onSnapshotMutated = vi.fn();
    const deviceManager = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      createLogger(),
      {
        getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
        getDeviceTargetPowerConfig: () => config,
        getNativeEvWiringEnabled: () => true,
      },
      undefined,
      { onSnapshotMutated },
    );
    const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
    deviceManager.setSnapshotForTests([parsed]);

    deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', 32);

    expect(onSnapshotMutated).toHaveBeenCalledWith(expect.objectContaining({
      reportedStepId: '32a',
      reportedStepPowerW: 7_360,
    }), expect.any(Number));
  });

  it('writes the step to target_charger_current instead of triggering the Flow', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === 'manager/devices/device') return { [EASEE_ID]: buildEaseeCharger() };
      throw new Error(`unexpected device fetch: ${path}`);
    });
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get, put });
    try {
      const deviceManager = createEaseeTransport(true);
      await deviceManager.refreshSnapshot({ includeLivePower: false, mainMeterSelection: { state: 'unavailable' } });

      await expect(deviceManager.requestSteppedLoadStep({
        deviceId: EASEE_ID,
        profile: presetProfile,
        desiredStepId: '6a',
        planningPowerW: 1_380,
        planningCurrentA: 6,
      })).resolves.toEqual({ requested: true, transport: 'native_capability' });

      expect(put).toHaveBeenCalledWith(
        `manager/devices/device/${EASEE_ID}/capability/target_charger_current`,
        { value: 6 },
      );
    } finally {
      restoreMockRestClient();
    }
  });
});
