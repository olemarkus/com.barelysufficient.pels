import {
  mockHomeyInstance,
  setMockDrivers,
} from '../mocks/homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';

// Use fake timers to prevent resource leaks from periodic refresh and control
// timing deterministically.
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });

type ApiCapabilityObj = Record<string, { id: string; value?: unknown }>;
type ApiDevice = {
  id: string;
  name: string;
  class: string;
  virtualClass: string | null;
  capabilities: string[];
  capabilitiesObj: ApiCapabilityObj;
  settings: Record<string, unknown>;
  energyObj?: Record<string, unknown> | null;
};

type SnapshotEntry = {
  id: string;
  deviceType?: string;
  controlCapabilityId?: string;
  powerCapable?: boolean;
  binaryControl?: { on: boolean };
  steppedLoadProfile?: unknown;
  targets?: unknown[];
};

const DEVICE_ID = 'device-a';
const onoffCap = (id: string) => `manager/devices/device/${id}/capability/onoff`;

const findEntry = (id: string): SnapshotEntry | undefined => (
  (getLatestTargetSnapshotForTests() as SnapshotEntry[]).find((entry) => entry.id === id)
);

describe('Device capability lifecycle across SDK pulls', () => {
  let deviceList: Record<string, ApiDevice>;

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockDrivers({});
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    deviceList = {};
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async () => deviceList);
    // Mark the lifecycle device managed/controllable so admission turns purely on
    // capabilities, not on the managed filter.
    mockHomeyInstance.settings.set('managed_devices', { [DEVICE_ID]: true });
    mockHomeyInstance.settings.set('controllable_devices', { [DEVICE_ID]: true });
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  const pull = async (app: unknown) => {
    await (app as { refreshTargetDevicesSnapshot: () => Promise<void> }).refreshTargetDevicesSnapshot();
  };

  it('admits and drops a binary device as its core capabilities appear and disappear', async () => {
    const app = createApp();
    await app.onInit();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // Pull 1 — cold start with no controllable capabilities (only measure_power).
    // A non-EV device with no `onoff` and no target is not manageable: it never
    // enters the snapshot, so nothing is planned or written for it.
    deviceList = {
      [DEVICE_ID]: {
        id: DEVICE_ID,
        name: 'Socket',
        class: 'socket',
        virtualClass: 'appliance',
        capabilities: ['measure_power'],
        capabilitiesObj: { measure_power: { id: 'measure_power', value: 0 } },
        settings: {},
      },
    };
    await pull(app);
    expect(findEntry(DEVICE_ID)).toBeUndefined();

    // Pull 2 — gains `onoff` + a live `measure_power`. It becomes manageable and
    // power-limit capable: a binary, power-capable shed candidate.
    deviceList = {
      [DEVICE_ID]: {
        id: DEVICE_ID,
        name: 'Socket',
        class: 'socket',
        virtualClass: 'appliance',
        capabilities: ['onoff', 'measure_power'],
        capabilitiesObj: {
          onoff: { id: 'onoff', value: true },
          measure_power: { id: 'measure_power', value: 1500 },
        },
        settings: {},
      },
    };
    await pull(app);
    const managed = findEntry(DEVICE_ID);
    expect(managed).toBeDefined();
    expect(managed?.deviceType).toBe('onoff');
    expect(managed?.controlCapabilityId).toBe('onoff');
    expect(managed?.powerCapable).toBe(true);
    expect(managed?.binaryControl?.on).toBe(true);

    // Pull 3 — loses `onoff` again (still has measure_power, no target). It lacks
    // core control capabilities, so it drops back out of the managed snapshot and
    // no binary action is ever issued for it.
    deviceList = {
      [DEVICE_ID]: {
        id: DEVICE_ID,
        name: 'Socket',
        class: 'socket',
        virtualClass: 'appliance',
        capabilities: ['measure_power'],
        capabilitiesObj: { measure_power: { id: 'measure_power', value: 1500 } },
        settings: {},
      },
    };
    await pull(app);
    expect(findEntry(DEVICE_ID)).toBeUndefined();
    expect(putSpy).not.toHaveBeenCalledWith(onoffCap(DEVICE_ID), expect.anything());

    // Persisted user settings survive the drop (a re-appearing capability returns
    // the device as before — we never delete settings on a missing read).
    const managedSetting = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
    const controllableSetting = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(managedSetting[DEVICE_ID]).toBe(true);
    expect(controllableSetting[DEVICE_ID]).toBe(true);
  });

  it('controls a device without a stepped-load profile as a plain binary load', async () => {
    const app = createApp();
    await app.onInit();

    // Has a binary handle and power, but no stepped-load capability/profile, so it
    // is a binary device: no stepped-load classification, controlled via onoff.
    deviceList = {
      [DEVICE_ID]: {
        id: DEVICE_ID,
        name: 'Socket',
        class: 'socket',
        virtualClass: 'appliance',
        capabilities: ['onoff', 'measure_power'],
        capabilitiesObj: {
          onoff: { id: 'onoff', value: true },
          measure_power: { id: 'measure_power', value: 1500 },
        },
        settings: {},
      },
    };
    await pull(app);

    const entry = findEntry(DEVICE_ID);
    expect(entry).toBeDefined();
    expect(entry?.deviceType).toBe('onoff');
    expect(entry?.controlCapabilityId).toBe('onoff');
    expect(entry?.steppedLoadProfile).toBeUndefined();
  });

  it('drops an EV charger entirely when one of its required EV capabilities goes missing', async () => {
    const evId = 'charger-1';
    mockHomeyInstance.settings.set('managed_devices', { [evId]: true });
    mockHomeyInstance.settings.set('controllable_devices', { [evId]: true });

    const app = createApp();
    await app.onInit();

    // Pull 1 — a well-formed charger with both required EV capabilities is admitted
    // and controlled through `evcharger_charging`.
    deviceList = {
      [evId]: {
        id: evId,
        name: 'Wallbox',
        class: 'evcharger',
        virtualClass: null,
        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
        capabilitiesObj: {
          evcharger_charging: { id: 'evcharger_charging', value: true },
          evcharger_charging_state: { id: 'evcharger_charging_state', value: 'plugged_in_charging' },
          measure_power: { id: 'measure_power', value: 7000 },
        },
        settings: {},
      },
    };
    await pull(app);
    const charger = findEntry(evId);
    expect(charger).toBeDefined();
    expect(charger?.controlCapabilityId).toBe('evcharger_charging');

    // Pull 2 — loses `evcharger_charging_state`. An EV charger requires BOTH EV
    // capabilities; without one it is no longer a recognised charger and drops out
    // of the snapshot entirely.
    deviceList = {
      [evId]: {
        id: evId,
        name: 'Wallbox',
        class: 'evcharger',
        virtualClass: null,
        capabilities: ['evcharger_charging', 'measure_power'],
        capabilitiesObj: {
          evcharger_charging: { id: 'evcharger_charging', value: true },
          measure_power: { id: 'measure_power', value: 7000 },
        },
        settings: {},
      },
    };
    await pull(app);
    expect(findEntry(evId)).toBeUndefined();
  });
});
