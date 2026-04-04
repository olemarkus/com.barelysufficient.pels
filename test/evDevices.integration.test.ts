import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';

type EaseeChargingState =
  | 'plugged_in_charging'
  | 'plugged_in_discharging'
  | 'plugged_in_paused'
  | 'plugged_in'
  | 'plugged_out'
  | 'mystery';

type InternalApp = {
  onInit(): Promise<void>;
  onUninit(): Promise<void>;
  refreshTargetDevicesSnapshot(options?: { fast?: boolean }): Promise<void>;
  planService: {
    rebuildPlanFromCache(reason?: string): Promise<void>;
  };
  capacityGuard: {
    reportTotalPower(powerKw: number): void;
  };
  powerTracker: {
    lastTimestamp?: number;
  };
  computeDynamicSoftLimit: () => number;
};

type CommandEntry = {
  capabilityId: string;
  value: unknown;
};

type SnapshotEntry = {
  id: string;
  name: string;
  deviceClass?: string;
  controlCapabilityId?: string;
  currentOn: boolean;
  evChargingState?: string;
  expectedPowerSource?: string;
  powerKw?: number;
};

type PlanDeviceEntry = {
  id: string;
  plannedState?: string;
  reason?: string;
};

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

let currentTimeMs = 1_730_000_000_000;
const originalDateNow = Date.now;

class EaseeMockCharger extends MockDevice {
  public readonly commandLog: CommandEntry[] = [];

  private observedState: EaseeChargingState = 'plugged_out';

  constructor(options?: {
    id?: string;
    name?: string;
    loadW?: number | null;
    chargePowerW?: number;
  }) {
    super(
      options?.id ?? 'ev-easee',
      options?.name ?? 'Easee Charger',
      [
        'measure_power',
        'onoff',
        'target_charger_current',
        'target_circuit_current',
        'evcharger_charging',
        'evcharger_charging_state',
      ],
      'evcharger',
    );
    this.chargePowerW = options?.chargePowerW ?? 7200;
    if (typeof options?.loadW === 'number') {
      this.setSettings({ load: options.loadW });
    }
  }

  private chargePowerW: number;

  async seedState(state: EaseeChargingState): Promise<void> {
    await super.setCapabilityValue('target_charger_current', 0);
    await super.setCapabilityValue('target_circuit_current', 0);
    await this.applyObservedState(state);
  }

  async setObservedState(state: EaseeChargingState): Promise<void> {
    await this.applyObservedState(state);
  }

  clearCommandLog(): void {
    this.commandLog.length = 0;
  }

  getCommandSequence(): string[] {
    return this.commandLog.map((entry) => `${entry.capabilityId}:${String(entry.value)}`);
  }

  override async setCapabilityValue(capabilityId: string, value: unknown): Promise<void> {
    this.commandLog.push({ capabilityId, value });

    if (capabilityId === 'evcharger_charging' || capabilityId === 'onoff') {
      const desired = value === true;
      const nextState = desired
        ? 'plugged_in_charging'
        : this.resolveStoppedState();
      await this.applyObservedState(nextState);
      return;
    }

    await super.setCapabilityValue(capabilityId, value);
  }

  private resolveStoppedState(): EaseeChargingState {
    if (this.observedState === 'plugged_out') return 'plugged_out';
    if (this.observedState === 'plugged_in_discharging') return 'plugged_in_discharging';
    return 'plugged_in_paused';
  }

  private async applyObservedState(state: EaseeChargingState): Promise<void> {
    this.observedState = state;
    const isCharging = state === 'plugged_in_charging';
    const powerW = isCharging ? this.chargePowerW : 0;

    await super.setCapabilityValue('evcharger_charging_state', state);
    await super.setCapabilityValue('evcharger_charging', isCharging);
    await super.setCapabilityValue('onoff', isCharging);
    await super.setCapabilityValue('measure_power', powerW);
  }
}

beforeAll(() => {
  global.Date.now = jest.fn(() => currentTimeMs);
});

afterAll(() => {
  global.Date.now = originalDateNow;
});

describe('EV charger integration', () => {
  beforeEach(() => {
    currentTimeMs = 1_730_000_000_000;
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupApps();
  });

  it.each([
    ['plugged_in_charging', true],
    ['plugged_in_paused', false],
    ['plugged_in', false],
    ['plugged_out', false],
    ['plugged_in_discharging', false],
  ] as Array<[EaseeChargingState, boolean]>)(
    'maps Easee state %s to currentOn=%s in the app snapshot',
    async (state, expectedOn) => {
      const charger = new EaseeMockCharger({ loadW: 7200 });
      await charger.seedState(state);
      const app = await createEvApp(charger);

      const snapshot = await refreshSnapshot(app);
      const entry = getSnapshotEntry(snapshot, charger.idValue);

      expect(entry).toEqual(expect.objectContaining({
        id: charger.idValue,
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        currentOn: expectedOn,
        evChargingState: state,
      }));
    },
  );

  it('sheds and later restores an Easee-like charger through evcharger_charging only', async () => {
    const charger = new EaseeMockCharger({ loadW: 7200 });
    await charger.seedState('plugged_in_charging');
    const app = await createEvApp(charger);

    let plan = await rebuildPlan(app, { totalPowerKw: 7.2, softLimitKw: 4.0 });
    let evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).toBe('shed');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);
    expect(charger.commandLog.every((entry) => entry.capabilityId === 'evcharger_charging')).toBe(true);

    let snapshot = await refreshSnapshot(app);
    let entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: false,
      evChargingState: 'plugged_in_paused',
      powerKw: 7.2,
      controlCapabilityId: 'evcharger_charging',
    }));

    currentTimeMs += 61_000;
    (app as any).computeDynamicSoftLimit = () => 10.0;
    (app as any).capacityGuard.reportTotalPower(0.4);
    // Deactivate the guard after restoring headroom so shedding hysteresis allows it.
    await (app as any).capacityGuard?.setSheddingActive(false);
    (app as any).planEngine.state.lastRecoveryMs = currentTimeMs - 61_000;
    plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).not.toBe('shed');
    expect(charger.getCommandSequence()).toEqual([
      'evcharger_charging:false',
      'evcharger_charging:true',
    ]);
    expect(charger.commandLog.some((entry) => entry.capabilityId === 'onoff')).toBe(false);
    expect(charger.commandLog.some((entry) => entry.capabilityId === 'target_charger_current')).toBe(false);
    expect(charger.commandLog.some((entry) => entry.capabilityId === 'target_circuit_current')).toBe(false);

    snapshot = await refreshSnapshot(app);
    entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_charging',
      controlCapabilityId: 'evcharger_charging',
    }));
  });

  it('restores a connected but idle Easee-like charger from plugged_in state', async () => {
    const charger = new EaseeMockCharger({ loadW: 7200 });
    await charger.seedState('plugged_in');
    const app = await createEvApp(charger);

    const plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).not.toBe('shed');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:true']);

    const snapshot = await refreshSnapshot(app);
    const entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_charging',
    }));
  });

  it.each([
    ['plugged_out', 'charger is unplugged'],
    ['plugged_in_discharging', 'charger is discharging'],
    ['mystery', "unknown charging state 'mystery'"],
  ] as Array<[EaseeChargingState, string]>)(
    'marks an Easee-like charger inactive when restore is blocked by state %s',
    async (state, reason) => {
      const charger = new EaseeMockCharger({ loadW: 7200 });
      await charger.seedState(state);
      const app = await createEvApp(charger);

      const plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
      const evPlan = getPlanEntry(plan, charger.idValue);

      expect(evPlan.plannedState).toBe('inactive');
      expect(evPlan.reason).toBe(`inactive (${reason})`);
      expect(charger.commandLog).toHaveLength(0);

      const snapshot = await refreshSnapshot(app);
      const entry = getSnapshotEntry(snapshot, charger.idValue);
      expect(entry).toEqual(expect.objectContaining({
        currentOn: false,
        evChargingState: state,
      }));
    },
  );

  it('marks a paused charger inactive when power is unknown', async () => {
    const charger = new EaseeMockCharger();
    await charger.seedState('plugged_in_paused');
    const app = await createEvApp(charger);

    const initialSnapshot = await refreshSnapshot(app);
    expect(getSnapshotEntry(initialSnapshot, charger.idValue)?.expectedPowerSource).toBe('default');

    const plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).toBe('inactive');
    expect(evPlan.reason).toContain('charger power unknown');
    expect(charger.commandLog).toHaveLength(0);
  });

  it('keeps an unplugged charger inactive during restore cooldown instead of marking it shed', async () => {
    const charger = new EaseeMockCharger({ loadW: 7200 });
    await charger.seedState('plugged_in_charging');
    const app = await createEvApp(charger);

    let plan = await rebuildPlan(app, { totalPowerKw: 7.2, softLimitKw: 4.0 });
    expect(getPlanEntry(plan, charger.idValue).plannedState).toBe('shed');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);

    await charger.setObservedState('plugged_out');
    await refreshSnapshot(app);
    currentTimeMs += 5_000;

    plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).toBe('inactive');
    expect(evPlan.reason).toBe('inactive (charger is unplugged)');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);
  });

  it('restores a paused charger by swapping out a lower-priority running load', async () => {
    const heater = new MockDevice(
      'heater-low',
      'Garage Heater',
      ['onoff', 'measure_power', 'meter_power', 'rms_voltage', 'rms_current'],
      'socket',
    );
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 1000);

    const charger = new EaseeMockCharger({ loadW: 1200 });
    await charger.seedState('plugged_in_paused');
    const app = await createEvApp(charger, [heater, charger], {
      capacityPriorities: {
        Home: {
          [charger.idValue]: 1,
          [heater.idValue]: 10,
        },
      },
    });

    const plan = await rebuildPlan(app, { totalPowerKw: 1.0, softLimitKw: 2.0 });
    const heaterPlan = getPlanEntry(plan, heater.idValue);
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(heaterPlan.plannedState).toBe('shed');
    expect(heaterPlan.reason).toContain(`swapped out for ${charger.getName()}`);
    expect(evPlan.plannedState).not.toBe('shed');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:true']);
    expect(heater.getSetCapabilityValue('onoff')).toBe(false);
    expect(charger.commandLog.every((entry) => entry.capabilityId === 'evcharger_charging')).toBe(true);

    const snapshot = await refreshSnapshot(app);
    const heaterEntry = getSnapshotEntry(snapshot, heater.idValue);
    const chargerEntry = getSnapshotEntry(snapshot, charger.idValue);

    expect(heaterEntry).toEqual(expect.objectContaining({
      currentOn: false,
    }));
    expect(chargerEntry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_charging',
      expectedPowerSource: 'load-setting',
    }));
  });
});

async function createEvApp(
  charger: EaseeMockCharger,
  devices: MockDevice[] = [charger],
  options?: {
    capacityPriorities?: Record<string, Record<string, number>>;
  },
): Promise<InternalApp> {
  setMockDrivers({
    easee: new MockDriver('easee', devices),
  });

  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(EXPERIMENTAL_EV_SUPPORT_ENABLED, true);
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.2);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(
    CONTROLLABLE_DEVICES,
    Object.fromEntries(devices.map((device) => [device.idValue, true])),
  );
  mockHomeyInstance.settings.set(
    MANAGED_DEVICES,
    Object.fromEntries(devices.map((device) => [device.idValue, true])),
  );
  if (options?.capacityPriorities) {
    mockHomeyInstance.settings.set('capacity_priorities', options.capacityPriorities);
  }

  const app = createApp() as unknown as InternalApp;
  await app.onInit();
  await app.refreshTargetDevicesSnapshot({ fast: false });
  charger.clearCommandLog();
  return app;
}

async function rebuildPlan(
  app: InternalApp,
  options: { totalPowerKw: number; softLimitKw: number },
): Promise<{ devices: PlanDeviceEntry[] }> {
  const appState = app as InternalApp & {
    computeDynamicSoftLimit: () => number;
    powerTracker: { lastTimestamp?: number };
  };
  appState.computeDynamicSoftLimit = () => options.softLimitKw;
  appState.capacityGuard.reportTotalPower(options.totalPowerKw);
  appState.powerTracker.lastTimestamp = currentTimeMs;
  await appState.planService.rebuildPlanFromCache('ev_integration_test');
  await flushPromises();
  return mockHomeyInstance.settings.get('device_plan_snapshot') as { devices: PlanDeviceEntry[] };
}

async function refreshSnapshot(app: InternalApp): Promise<SnapshotEntry[]> {
  await app.refreshTargetDevicesSnapshot({ fast: false });
  await flushPromises();
  return mockHomeyInstance.settings.get('target_devices_snapshot') as SnapshotEntry[];
}

function getSnapshotEntry(snapshot: SnapshotEntry[], deviceId: string): SnapshotEntry | undefined {
  return snapshot.find((entry) => entry.id === deviceId);
}

function getPlanEntry(plan: { devices: PlanDeviceEntry[] }, deviceId: string): PlanDeviceEntry {
  const entry = plan.devices.find((device) => device.id === deviceId);
  expect(entry).toBeDefined();
  return entry as PlanDeviceEntry;
}
