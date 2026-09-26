import Homey from 'homey';
import { createTestDeviceTransport, onObservedState, onObservedControlState } from '../helpers/deviceTransportHarness';
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

// When the production read was taken; Homey dates every value it holds.
const READ_AT = '2026-09-15T04:41:52.000Z';

const buildEaseeCapabilityObj = (
  capabilityOverrides: DeviceCapabilityMap = {},
): DeviceCapabilityMap => ({
  onoff: { value: true, setable: true, lastUpdated: READ_AT },
  target_circuit_current: { value: 32, setable: true, min: 0, max: 40 },
  target_charger_current: {
    value: 16,
    setable: true,
    min: 0,
    max: 40,
    lastUpdated: READ_AT,
  },
  measure_power: { value: 3_600, lastUpdated: READ_AT },
  evcharger_charging: { value: true, setable: true, lastUpdated: READ_AT },
  evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: READ_AT },
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
    // 1-5 A is too little to charge at: the charger pauses, so it is the off step.
    for (const pausedA of [3, 5]) {
      expect(resolveNativeSteppedLoadReportedStepId({
        profile: presetProfile,
        capabilities: EASEE_CAPABILITIES,
        capabilityObj: buildEaseeCapabilityObj({ target_charger_current: { value: pausedA, setable: true } }),
      })).toBe('off');
    }
    expect(resolveNativeSteppedLoadReportedStepId({
      profile: presetProfile,
      capabilities: EASEE_CAPABILITIES,
      capabilityObj: buildEaseeCapabilityObj({ target_charger_current: { value: 6, setable: true } }),
    })).toBe('6a');
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

  describe('charging switch observation', () => {
    // Production, 2026-09-25: Homey held the `evcharger_charging = true` PELS had
    // written for a charger that never started charging; the owner then set 0 A
    // in the Easee app.
    const zeroedInTheApp: DeviceCapabilityMap = {
      target_charger_current: { value: 0, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
      evcharger_charging: { value: true, setable: true, lastUpdated: '2026-09-15T04:40:00.000Z' },
      evcharger_charging_state: { value: 'plugged_in_paused', lastUpdated: READ_AT },
      measure_power: { value: 0, lastUpdated: READ_AT },
    };

    it('reads a paused charger at 0 A as off, whatever Homey holds for the switch', () => {
      const [parsed] = createEaseeTransport(true).parseDeviceListForTests([buildEaseeCharger(zeroedInTheApp)]);

      expect(parsed.binaryControl).toEqual({ on: false });
      expect(parsed.reportedStepId).toBe('off');
    });

    it('reads the switch from the plug state, whatever switch Homey holds', () => {
      const withPlugState = (state: string, switchOn: boolean): DeviceCapabilityMap => ({
        target_charger_current: { value: 16, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
        evcharger_charging: { value: switchOn, setable: true, lastUpdated: READ_AT },
        evcharger_charging_state: { value: state, lastUpdated: READ_AT },
      });
      const transport = createEaseeTransport(true);
      const read = (state: string, switchOn: boolean) => transport
        .parseDeviceListForTests([buildEaseeCharger(withPlugState(state, switchOn))])[0].binaryControl;

      expect(read('plugged_in_charging', false)).toEqual({ on: true });
      // A stopped session holds a PELS start on the switch until the app publishes again.
      expect(read('plugged_in', true)).toEqual({ on: false });
    });

    it('reads a charger paused at a charging current as on: Easee holds a resumed charger before it charges', () => {
      // Production, 2026-09-25 09:56:08: PELS resumed at 6 A, and the charger stayed
      // `Paused` until 10:01:16 before it offered the car current.
      const [parsed] = createEaseeTransport(true).parseDeviceListForTests([buildEaseeCharger({
        ...zeroedInTheApp,
        target_charger_current: { value: 6, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
        evcharger_charging: { value: false, setable: true, lastUpdated: READ_AT },
      })]);

      expect(parsed.binaryControl).toEqual({ on: true });
      expect(parsed.reportedStepId).toBe('6a');
    });

    it('reads a paused charger as on once it holds a charging current, whatever the app switch reports', () => {
      const deviceManager = createEaseeTransport(true);
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger({
        ...zeroedInTheApp,
        evcharger_charging: { value: false, setable: true, lastUpdated: READ_AT },
      })]);
      deviceManager.setSnapshotForTests([parsed]);

      // Homey's echo of a switch write says nothing about the charger.
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging', true);
      expect(parsed.binaryControl).toEqual({ on: false });

      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', 6);
      expect(parsed.binaryControl).toEqual({ on: true });

      // Easee offers the car current: the app sends its switch, then the plug state.
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging', true);
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging_state', 'plugged_in_charging');
      expect(parsed.binaryControl).toEqual({ on: true });
    });

    it('reads the switch as off when a charging session is stopped', () => {
      const deviceManager = createEaseeTransport(true);
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
      deviceManager.setSnapshotForTests([parsed]);

      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging', false);
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging_state', 'plugged_in');

      expect(parsed.binaryControl).toEqual({ on: false });
    });

    it.each([
      ['evcharger_charging_state', 'unplugged'],
      ['evcharger_charging_state', null],
      ['target_charger_current', Number.NaN],
      ['target_charger_current', '0'],
      ['evcharger_charging', 'off'],
    ])('reads no switch change from a malformed %s report: %s', (capabilityId, value) => {
      const deviceManager = createEaseeTransport(true);
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
      deviceManager.setSnapshotForTests([parsed]);
      const controlChanged = vi.fn();
      onObservedControlState(deviceManager, controlChanged);

      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, capabilityId, value);

      expect(parsed.binaryControl).toEqual({ on: true });
      expect(controlChanged).not.toHaveBeenCalled();
    });

    it('reads the switch as the charger reports it while built-in control is off', () => {
      const [parsed] = createEaseeTransport(false).parseDeviceListForTests([buildEaseeCharger(zeroedInTheApp)]);

      expect(parsed.binaryControl).toEqual({ on: true });
    });

    it.each([0, 3])('turns the switch off when %d A is set outside PELS and the charger pauses', (currentA) => {
      const deviceManager = createEaseeTransport(true);
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
      deviceManager.setSnapshotForTests([parsed]);
      const controlChanged = vi.fn();
      onObservedControlState(deviceManager, controlChanged);

      // The current lands first; 0-5 A reads as the off level at once.
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', currentA);
      expect(parsed.reportedStepId).toBe('off');

      // Seconds later the app reports the pause (4 s in production). Its switch
      // event may still say on, as Homey held it; the paused plug state wins.
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging', true);
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging_state', 'plugged_in_paused');

      expect(parsed.binaryControl).toEqual({ on: false });
      expect(controlChanged).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: EASEE_ID,
        changes: expect.arrayContaining([expect.objectContaining({
          capabilityId: 'evcharger_charging',
          previousValue: 'on',
          nextValue: 'off',
        })]),
      }));
    });

    it('leaves the switch alone when 0 A is set on a charger under Flow control', () => {
      const deviceManager = createEaseeTransport(false);
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
      deviceManager.setSnapshotForTests([parsed]);

      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', 0);

      expect(parsed.binaryControl).toEqual({ on: true });
    });
  });

  describe('charging switch writes', () => {
    const CHARGER_CURRENT_PATH = `manager/devices/device/${EASEE_ID}/capability/target_charger_current`;
    const CHARGING_SWITCH_PATH = `manager/devices/device/${EASEE_ID}/capability/evcharger_charging`;
    const triggerFlow = vi.fn();

    // The charger as the Easee app publishes it after PELS set 0 A: paused, the
    // session still open, and `evcharger_charging` false because it is not charging.
    const pausedAtZeroCurrent: DeviceCapabilityMap = {
      target_charger_current: { value: 0, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
      evcharger_charging: { value: false, setable: true, lastUpdated: READ_AT },
      evcharger_charging_state: { value: 'plugged_in_paused', lastUpdated: READ_AT },
      measure_power: { value: 0, lastUpdated: READ_AT },
    };

    const writeSwitch = async (
      nativeWiringEnabled: boolean,
      capabilityOverrides: DeviceCapabilityMap,
      desired: boolean,
    ): Promise<ReturnType<typeof vi.fn>> => {
      const get = vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return { [EASEE_ID]: buildEaseeCharger(capabilityOverrides) };
        throw new Error(`unexpected device fetch: ${path}`);
      });
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get, put });
      try {
        const deviceManager = createEaseeTransport(nativeWiringEnabled);
        await deviceManager.refreshSnapshot({ includeLivePower: false, mainMeterSelection: { state: 'unavailable' } });
        await deviceManager.requestBinaryControl(EASEE_ID, desired, triggerFlow);
      } finally {
        restoreMockRestClient();
      }
      return put;
    };

    it('pauses a charging charger at 0 A instead of stopping its session', async () => {
      const put = await writeSwitch(true, {}, false);

      expect(put.mock.calls).toEqual([[CHARGER_CURRENT_PATH, { value: 0 }]]);
    });

    it('resumes its own 0 A pause at the lowest charging current, without starting a session', async () => {
      const put = await writeSwitch(true, pausedAtZeroCurrent, true);

      expect(put.mock.calls).toEqual([[CHARGER_CURRENT_PATH, { value: 6 }]]);
    });

    it('resumes a charger paused at a current too low to charge at by current, without starting a session', async () => {
      const put = await writeSwitch(true, {
        ...pausedAtZeroCurrent,
        target_charger_current: { value: 3, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
      }, true);

      expect(put.mock.calls).toEqual([[CHARGER_CURRENT_PATH, { value: 6 }]]);
    });

    it('resumes at the lowest charging current while the plug state still trails the 0 A report', async () => {
      const put = await writeSwitch(true, {
        ...pausedAtZeroCurrent,
        evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: READ_AT },
      }, true);

      expect(put.mock.calls).toEqual([[CHARGER_CURRENT_PATH, { value: 6 }]]);
    });

    it('starts a session that was stopped outside PELS', async () => {
      // Stopped in the Easee app: the session is gone and the charger is
      // waiting, not paused, with its current left where it was.
      const put = await writeSwitch(true, {
        evcharger_charging: { value: false, setable: true, lastUpdated: READ_AT },
        evcharger_charging_state: { value: 'plugged_in', lastUpdated: READ_AT },
        measure_power: { value: 0, lastUpdated: READ_AT },
      }, true);

      expect(put.mock.calls).toEqual([[CHARGING_SWITCH_PATH, { value: true }]]);
    });

    it('retries a resume during the Easee hold by current, without starting a session', async () => {
      // Production, 2026-09-25 08:05:30: 6 A already set, the charger still paused
      // in Easee's ~5-minute hold, and the retry went out as a start (32 A reset).
      const put = await writeSwitch(true, {
        ...pausedAtZeroCurrent,
        target_charger_current: { value: 6, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
      }, true);

      expect(put.mock.calls).toEqual([[CHARGER_CURRENT_PATH, { value: 6 }]]);
    });

    // Homey applies a write and dates it just before the PUT returns; the app
    // publishes nothing until the charger mode changes.
    const readBackAfterWrite = async (
      capabilityOverrides: DeviceCapabilityMap,
      desired: boolean,
    ): Promise<{ on: boolean } | undefined> => {
      let capabilityObj = buildEaseeCapabilityObj(capabilityOverrides);
      const get = vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return { [EASEE_ID]: { ...buildEaseeCharger(), capabilitiesObj: capabilityObj } };
        throw new Error(`unexpected device fetch: ${path}`);
      });
      const put = vi.fn(async (path: string, body: unknown) => {
        const capabilityId = path.split('/').pop() ?? '';
        const { value } = body as { value: unknown };
        const lastUpdated = new Date(Date.now() - 50).toISOString();
        capabilityObj = { ...capabilityObj, [capabilityId]: { ...capabilityObj[capabilityId], value, lastUpdated } };
      });
      setRestClient({ get, put });
      try {
        const deviceManager = createEaseeTransport(true);
        const refresh = () => deviceManager.refreshSnapshot({
          includeLivePower: false,
          mainMeterSelection: { state: 'unavailable' },
        });
        await refresh();
        await deviceManager.requestBinaryControl(EASEE_ID, desired, triggerFlow);
        await refresh();
        return deviceManager.getSnapshot()[0]?.binaryControl;
      } finally {
        restoreMockRestClient();
      }
    };

    it('reads a started session as off until it charges, though Homey holds the true PELS wrote', async () => {
      const binaryControl = await readBackAfterWrite({
        evcharger_charging: { value: false, setable: true, lastUpdated: READ_AT },
        evcharger_charging_state: { value: 'plugged_in', lastUpdated: READ_AT },
        measure_power: { value: 0, lastUpdated: READ_AT },
      }, true);

      expect(binaryControl).toEqual({ on: false });
    });

    it('reads a paused charger as on until Easee reports the pause', async () => {
      const binaryControl = await readBackAfterWrite({}, false);

      expect(binaryControl).toEqual({ on: true });
    });

    it('leaves the switch to the charger while built-in control is off', async () => {
      const put = await writeSwitch(false, {}, false);

      expect(put.mock.calls).toEqual([[CHARGING_SWITCH_PATH, { value: false }]]);
    });

    it('resumes a charger paused at 0 A by current after built-in control was turned off', async () => {
      // A start cannot resume a session paused below 6 A, and without built-in
      // control nothing else would raise the current PELS left at 0 A.
      const put = await writeSwitch(false, pausedAtZeroCurrent, true);

      expect(put.mock.calls).toEqual([[CHARGER_CURRENT_PATH, { value: 6 }]]);
    });

    it('leaves a paused charger holding a charging current to the switch while built-in control is off', async () => {
      const put = await writeSwitch(false, {
        ...pausedAtZeroCurrent,
        target_charger_current: { value: 16, setable: true, min: 0, max: 40, lastUpdated: READ_AT },
      }, true);

      expect(put.mock.calls).toEqual([[CHARGING_SWITCH_PATH, { value: true }]]);
    });
  });

  it.each([null, undefined, '16', Number.NaN, Infinity, -Infinity, -1])(
    'keeps the last-good current observation on an invalid report: %s',
    (invalidCurrent) => {
      const deviceManager = createEaseeTransport(true);
      const [parsed] = deviceManager.parseDeviceListForTests([buildEaseeCharger()]);
      deviceManager.setSnapshotForTests([parsed]);
      const observed = vi.fn();
      const controlChanged = vi.fn();
      onObservedState(deviceManager, observed);
      onObservedControlState(deviceManager, controlChanged);
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', 16);
      const lastGood = structuredClone(parsed);
      observed.mockClear();
      controlChanged.mockClear();

      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', invalidCurrent);

      expect(parsed).toEqual(lastGood);
      expect(observed).not.toHaveBeenCalled();
      expect(controlChanged).not.toHaveBeenCalled();
      // A binary observation re-reads the adapter's retained current. Invalid
      // current reports must not poison it even if the snapshot is unchanged.
      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'evcharger_charging_state', 'plugged_in_paused');
      expect(parsed.reportedStepId).toBe('16a');

      deviceManager.injectCapabilityUpdateForTest(EASEE_ID, 'target_charger_current', 8);
      expect(parsed.reportedStepId).toBe('8a');
      expect(parsed.reportedStepPowerW).toBe(1_840);
    },
  );
});
