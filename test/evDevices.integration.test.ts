import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEFERRED_OBJECTIVES_SETTINGS,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../lib/utils/settingsKeys';
import { getDateKeyInTimeZone, getDateKeyStartMs } from '../lib/utils/dateUtils';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import { getLatestPlanSnapshotForTests, MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp, getLatestTargetSnapshotForTests } from './utils/appTestUtils';
import { reasonText } from './utils/deviceReasonTestUtils';

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
  dailyBudgetService: {
    getSnapshot(): DailyBudgetUiPayload | null;
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
  deferredEvCommandIntent?: 'ev_resume' | 'ev_pause';
};

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));
const HOUR_MS = 60 * 60 * 1000;
const EV_DEADLINE_TEST_NOW_MS = Date.UTC(2026, 4, 13, 10, 0, 0);

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
        'measure_battery',
      ],
      'evcharger',
    );
    this.chargePowerW = options?.chargePowerW ?? 7200;
    if (typeof options?.loadW === 'number') {
      this.setSettings({ load: options.loadW });
    }
  }

  private chargePowerW: number;

  async seedState(state: EaseeChargingState, options?: { socPercent?: number }): Promise<void> {
    await super.setCapabilityValue('target_charger_current', 0);
    await super.setCapabilityValue('target_circuit_current', 0);
    await super.setCapabilityValue('measure_battery', options?.socPercent ?? 40);
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
  global.Date.now = vi.fn(() => currentTimeMs);
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
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupApps();
  });

  it.each([
    ['plugged_in_charging', true],
    ['plugged_in_paused', true],
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
      currentOn: true,
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
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);
    expect(charger.commandLog.some((entry) => entry.capabilityId === 'onoff')).toBe(false);
    expect(charger.commandLog.some((entry) => entry.capabilityId === 'target_charger_current')).toBe(false);
    expect(charger.commandLog.some((entry) => entry.capabilityId === 'target_circuit_current')).toBe(false);

    snapshot = await refreshSnapshot(app);
    entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_paused',
      controlCapabilityId: 'evcharger_charging',
    }));
  });

  it('keeps a connected but non-resumable Easee-like charger inactive from plugged_in state', async () => {
    const charger = new EaseeMockCharger({ loadW: 7200 });
    await charger.seedState('plugged_in');
    const app = await createEvApp(charger);

    const plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).toBe('inactive');
    expect(reasonText(evPlan.reason)).toBe('inactive (charger is not resumable)');
    expect(charger.getCommandSequence()).toEqual([]);

    const snapshot = await refreshSnapshot(app);
    const entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: false,
      evChargingState: 'plugged_in',
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
      expect(reasonText(evPlan.reason)).toBe(`inactive (${reason})`);
      expect(charger.commandLog).toHaveLength(0);

      const snapshot = await refreshSnapshot(app);
      const entry = getSnapshotEntry(snapshot, charger.idValue);
      expect(entry).toEqual(expect.objectContaining({
        currentOn: false,
        evChargingState: state,
      }));
    },
  );

  it('resumes a paused plugged-in charger during a planned EV deadline bucket', async () => {
    currentTimeMs = EV_DEADLINE_TEST_NOW_MS;
    const charger = new EaseeMockCharger({ loadW: 7200 });
    await charger.seedState('plugged_in_paused');
    const app = await createEvApp(charger, [charger], {
      evDeadlinePricesByRelativeHour: [1, 50, 50, 50],
    });

    const plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.deferredEvCommandIntent).toBe('ev_resume');
    expect(evPlan.plannedState).not.toBe('inactive');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:true']);

    const snapshot = await refreshSnapshot(app);
    const entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_charging',
    }));
  });

  it('pauses a charging charger during an idle EV deadline bucket', async () => {
    currentTimeMs = EV_DEADLINE_TEST_NOW_MS;
    const charger = new EaseeMockCharger();
    await charger.seedState('plugged_in_charging');
    const app = await createEvApp(charger, [charger], {
      evDeadlinePricesByRelativeHour: [100, 1, 1, 1],
    });

    await rebuildPlan(app, { totalPowerKw: 7.2, softLimitKw: 10.0 });

    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);

    const snapshot = await refreshSnapshot(app);
    const entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_paused',
    }));
  });

  // Note's "EV Semantics" §"Power-limit control off": meeting the deadline target removes the
  // deferred-objective allowance and PELS should pause the charger. Without a terminal pause,
  // a cap-off charger would keep running past the user's target.
  it('emits a terminal ev_pause when the EV reaches target with Power-limit control off', async () => {
    currentTimeMs = EV_DEADLINE_TEST_NOW_MS;
    const charger = new EaseeMockCharger();
    // SoC already at 80, target 42 → diagnostic resolves to `satisfied` immediately.
    await charger.seedState('plugged_in_charging', { socPercent: 80 });
    const app = await createEvApp(charger, [charger], {
      // Prices irrelevant once satisfied, but pricing payload still required by the bridge.
      evDeadlinePricesByRelativeHour: [1, 1, 1, 1],
      // Power-limit control off for this device.
      controllableOverrides: { [charger.idValue]: false },
      evDeadlineTargetPercent: 42,
    });

    const plan = await rebuildPlan(app, { totalPowerKw: 7.2, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.deferredEvCommandIntent).toBe('ev_pause');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);

    const snapshot = await refreshSnapshot(app);
    const entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_paused',
    }));
  });

  // Counter-case: same satisfied + already paused scenario must NOT re-issue the pause command.
  // Once the charger is paused, the executor's pause intent is a no-op.
  it('does not re-pause an already-paused charger that has reached target with Power-limit control off', async () => {
    currentTimeMs = EV_DEADLINE_TEST_NOW_MS;
    const charger = new EaseeMockCharger();
    await charger.seedState('plugged_in_paused', { socPercent: 80 });
    const app = await createEvApp(charger, [charger], {
      evDeadlinePricesByRelativeHour: [1, 1, 1, 1],
      controllableOverrides: { [charger.idValue]: false },
      evDeadlineTargetPercent: 42,
    });

    await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });

    // Pause intent is plumbed so the executor can act on a future flip back to charging,
    // but no new command should be issued while the charger is already paused.
    expect(charger.getCommandSequence()).toEqual([]);
  });

  // Counter-case: Power-limit control ON + satisfied must NOT emit a deferred ev_pause. Normal
  // managed charging behavior takes over once admission drops out. The note's pause guarantee
  // is specific to the cap-off path.
  it('does not emit a deferred ev_pause when satisfied while Power-limit control is on', async () => {
    currentTimeMs = EV_DEADLINE_TEST_NOW_MS;
    const charger = new EaseeMockCharger();
    await charger.seedState('plugged_in_charging', { socPercent: 80 });
    const app = await createEvApp(charger, [charger], {
      evDeadlinePricesByRelativeHour: [1, 1, 1, 1],
      // Default controllable=true (Power-limit control on)
      evDeadlineTargetPercent: 42,
    });

    const plan = await rebuildPlan(app, { totalPowerKw: 7.2, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.deferredEvCommandIntent).toBeUndefined();
  });

  it('skips planned EV deadline resume when power is stale-fail-closed', async () => {
    currentTimeMs = EV_DEADLINE_TEST_NOW_MS;
    const charger = new EaseeMockCharger();
    await charger.seedState('plugged_in_paused');
    const app = await createEvApp(charger, [charger], {
      evDeadlinePricesByRelativeHour: [1, 50, 50, 50],
    });

    const appState = app as InternalApp & { powerTracker: { lastTimestamp?: number } };
    appState.computeDynamicSoftLimit = () => 10.0;
    appState.capacityGuard.reportTotalPower(0.4);
    appState.powerTracker.lastTimestamp = currentTimeMs - 10 * 60 * 1000;
    await appState.planService.rebuildPlanFromCache('ev_deadline_stale_power_test');
    await flushPromises();

    const plan = getLatestPlanSnapshotForTests() as { devices: PlanDeviceEntry[] };
    expect(getPlanEntry(plan, charger.idValue).deferredEvCommandIntent).toBeUndefined();
    expect(charger.getCommandSequence()).toEqual([]);

    appState.powerTracker.lastTimestamp = currentTimeMs;
    await appState.planService.rebuildPlanFromCache('ev_deadline_power_fresh_test');
    await flushPromises();

    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:true']);
  });

  it('keeps non-deadline paused charger behavior unchanged when power is unknown', async () => {
    const charger = new EaseeMockCharger();
    await charger.seedState('plugged_in_paused');
    const app = await createEvApp(charger);

    const initialSnapshot = await refreshSnapshot(app);
    expect(getSnapshotEntry(initialSnapshot, charger.idValue)?.expectedPowerSource).toBe('default');

    const plan = await rebuildPlan(app, { totalPowerKw: 0.4, softLimitKw: 10.0 });
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(evPlan.plannedState).not.toBe('inactive');
    expect(charger.getCommandSequence()).toEqual([]);

    const snapshot = await refreshSnapshot(app);
    const entry = getSnapshotEntry(snapshot, charger.idValue);
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_paused',
    }));
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
    expect(reasonText(evPlan.reason)).toBe('inactive (charger is unplugged)');
    expect(charger.getCommandSequence()).toEqual(['evcharger_charging:false']);
  });

  it('does not swap out lower-priority load for a paused charger that is already allowed on', async () => {
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

    const plan = await rebuildPlan(app, { totalPowerKw: 1.0, softLimitKw: 2.3 });
    const heaterPlan = getPlanEntry(plan, heater.idValue);
    const evPlan = getPlanEntry(plan, charger.idValue);

    expect(heaterPlan.plannedState).toBe('keep');
    expect(evPlan.plannedState).not.toBe('shed');
    expect(charger.getCommandSequence()).toEqual([]);
    expect(heater.getSetCapabilityValue('onoff')).toBe(true);
    expect(charger.commandLog.every((entry) => entry.capabilityId === 'evcharger_charging')).toBe(true);

    const snapshot = await refreshSnapshot(app);
    const heaterEntry = getSnapshotEntry(snapshot, heater.idValue);
    const chargerEntry = getSnapshotEntry(snapshot, charger.idValue);

    expect(heaterEntry).toEqual(expect.objectContaining({
      currentOn: true,
    }));
    expect(chargerEntry).toEqual(expect.objectContaining({
      currentOn: true,
      evChargingState: 'plugged_in_paused',
      expectedPowerSource: 'load-setting',
    }));
  });
});

async function createEvApp(
  charger: EaseeMockCharger,
  devices: MockDevice[] = [charger],
  options?: {
    capacityPriorities?: Record<string, Record<string, number>>;
    evDeadlinePricesByRelativeHour?: number[];
    controllableOverrides?: Record<string, boolean>;
    evDeadlineTargetPercent?: number;
  },
): Promise<InternalApp> {
  setMockDrivers({
    easee: new MockDriver('easee', devices),
  });

  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.2);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  const controllableMap = Object.fromEntries(devices.map((device) => [device.idValue, true]));
  if (options?.controllableOverrides) {
    Object.assign(controllableMap, options.controllableOverrides);
  }
  mockHomeyInstance.settings.set(
    CONTROLLABLE_DEVICES,
    controllableMap,
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
  if (options?.evDeadlinePricesByRelativeHour) {
    app.dailyBudgetService.getSnapshot = () => buildEvDeadlineDailyBudgetSnapshot(options.evDeadlinePricesByRelativeHour!);
  }
  await app.refreshTargetDevicesSnapshot({ fast: false });
  if (options?.evDeadlinePricesByRelativeHour) {
    configureEvDeadlineObjective(charger, options.evDeadlineTargetPercent);
  }
  charger.clearCommandLog();
  return app;
}

function buildEvDeadlineDailyBudgetSnapshot(pricesByRelativeHour: number[]): DailyBudgetUiPayload {
  const now = new Date(currentTimeMs);
  const timeZone = 'Europe/Oslo';
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const day = buildEvDeadlineDay({ dateKey: todayKey, timeZone, pricesByRelativeHour });
  return {
    todayKey,
    days: {
      [todayKey]: day,
    },
  };
}

function buildEvDeadlineDay(params: {
  dateKey: string;
  timeZone: string;
  pricesByRelativeHour: number[];
}): DailyBudgetDayPayload {
  const { dateKey, timeZone, pricesByRelativeHour } = params;
  const now = new Date(currentTimeMs);
  const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
  const currentHour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(now));
  const pricesByHour = Array.from({ length: 24 }, () => 50);
  pricesByRelativeHour.forEach((price, offset) => {
    pricesByHour[(currentHour + offset) % 24] = price;
  });

  const startUtc = Array.from({ length: 24 }, (_, hour) => new Date(dayStartMs + hour * HOUR_MS).toISOString());
  const startLocalLabels = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
  const zeros = Array.from({ length: 24 }, () => 0);
  return {
    dateKey,
    timeZone,
    nowUtc: now.toISOString(),
    dayStartUtc: new Date(dayStartMs).toISOString(),
    currentBucketIndex: currentHour,
    budget: { enabled: false, dailyBudgetKWh: 0, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 0,
      remainingKWh: 0,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels,
      plannedWeight: Array.from({ length: 24 }, () => 1),
      plannedKWh: zeros,
      actualKWh: zeros,
      allowedCumKWh: zeros,
      price: pricesByHour,
    },
  };
}

function configureEvDeadlineObjective(charger: EaseeMockCharger, targetPercent: number = 42): void {
  mockHomeyInstance.settings.set(DEFERRED_OBJECTIVES_SETTINGS, {
    version: 1,
    objectivesByDeviceId: {
      [charger.idValue]: {
        enabled: true,
        kind: 'ev_soc',
        enforcement: 'soft',
        targetPercent,
        deadlineAtMs: currentTimeMs + 3 * HOUR_MS,
      },
    },
  });
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
  return getLatestPlanSnapshotForTests() as { devices: PlanDeviceEntry[] };
}

async function refreshSnapshot(app: InternalApp): Promise<SnapshotEntry[]> {
  await app.refreshTargetDevicesSnapshot({ fast: false });
  await flushPromises();
  return getLatestTargetSnapshotForTests() as SnapshotEntry[];
}

function getSnapshotEntry(snapshot: SnapshotEntry[], deviceId: string): SnapshotEntry | undefined {
  return snapshot.find((entry) => entry.id === deviceId);
}

function getPlanEntry(plan: { devices: PlanDeviceEntry[] }, deviceId: string): PlanDeviceEntry {
  const entry = plan.devices.find((device) => device.id === deviceId);
  expect(entry).toBeDefined();
  return entry as PlanDeviceEntry;
}
