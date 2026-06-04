import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DevicePlanDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import {
  DeferredObjectiveDecorationController,
  type DeferredObjectiveSettingsV1,
} from '../../lib/objectives/deferredObjectives';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const emptyPendingStore = createPendingBinaryCommandStore({});

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_ID = 'dev_water_heater';
const TARGET_C = 53;
// Keep the planner's physics aligned with the test's per-hour heating simulation:
// low step = 1.5 kW × 1 h = 1.5 kWh ÷ 1.5 kWh/°C = 1 °C/hour, matching the +=1 below.
const KWH_PER_DEGREE = 1.5;

// Six alternating cheap/expensive buckets give a clean 'planned in cheap, idle in expensive'
// shape over the deadline horizon.
const HOURLY_PRICES = [10, 50, 10, 50, 10, 50, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);

const buildDay = (): DailyBudgetDayPayload => {
  const startUtc: string[] = [];
  const startLocalLabels: string[] = [];
  const plannedKWh: number[] = [];
  const plannedWeight: number[] = [];
  const allowedCumKWh: number[] = [];
  const actualKWh: number[] = [];
  let cum = 0;
  for (let i = 0; i < 24; i += 1) {
    startUtc.push(new Date(DAY_START_UTC + i * HOUR_MS).toISOString());
    startLocalLabels.push(String(i).padStart(2, '0'));
    plannedKWh.push(0);
    plannedWeight.push(1);
    actualKWh.push(0);
    cum += 0;
    allowedCumKWh.push(cum);
  }
  return {
    dateKey: '2026-05-10',
    timeZone: 'UTC',
    nowUtc: new Date(DAY_START_UTC).toISOString(),
    dayStartUtc: new Date(DAY_START_UTC).toISOString(),
    currentBucketIndex: 0,
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
      plannedWeight,
      plannedKWh,
      actualKWh,
      allowedCumKWh,
      price: HOURLY_PRICES,
    },
  };
};

const buildDailyBudgetSnapshot = (): DailyBudgetUiPayload => ({
  todayKey: '2026-05-10',
  days: { '2026-05-10': buildDay() },
});

const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  lastTimestamp: nowMs,
  objectiveProfiles: {
    [DEVICE_ID]: {
      kind: 'temperature',
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: 50, unit: 'degree_c' },
      kwhPerUnit: {
        sampleCount: 50,
        mean: KWH_PER_DEGREE,
        m2: 0,
        min: KWH_PER_DEGREE,
        max: KWH_PER_DEGREE,
        confidence: 'high',
        lastUpdatedMs: nowMs,
      },
      acceptedSamples: 50,
      rejectedSamples: 0,
    },
  },
});

const buildDevice = (params: {
  currentTemperatureC: number;
  nowMs: number;
  currentOn: boolean;
  selectedStepId: string;
}): PlanInputDevice => ({
  id: DEVICE_ID,
  name: 'Water Heater',
  controllable: false, // capacity-based control toggle is OFF for this scenario
  controlModel: 'stepped_load',
  hasBinaryControl: true,
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1500 },
    ],
  },
  selectedStepId: params.selectedStepId,
  currentOn: params.currentOn,
  currentTemperature: params.currentTemperatureC,
  lastFreshDataMs: params.nowMs,
  observationStale: false,
  measuredPowerKw: params.currentOn ? 1.5 : 0,
  expectedPowerKw: params.currentOn ? 1.5 : 0,
  planningPowerKw: params.currentOn ? 1.5 : 0,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: '°C', min: 30, max: 75, step: 1 }],
});

const DEADLINE_AT_MS = Date.UTC(2026, 4, 10, 6, 0, 0);

const buildSettings = (): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: {
    [DEVICE_ID]: {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineAtMs: DEADLINE_AT_MS,
    },
  },
});

type BuilderOverrides = {
  modeRef?: { current: string };
  priorityByModeRef?: { current: Record<string, Record<string, number>> };
  capacityGuard?: CapacityGuard;
  capacitySettings?: { limitKw: number; marginKw: number };
};

const buildBuilder = (
  powerTrackerRef: { current: PowerTrackerState },
  overrides: BuilderOverrides = {},
) => {
  const capacityGuard = overrides.capacityGuard ?? new CapacityGuard({ limitKw: 100, softMarginKw: 0 });
  if (!overrides.capacityGuard) capacityGuard.reportTotalPower(0);
  const capacitySettings = overrides.capacitySettings ?? { limitKw: 100, marginKw: 0 };
  const deferredController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => buildSettings(),
    getTimeZone: () => 'UTC',
    getPowerTracker: () => powerTrackerRef.current,
    getPriceOptimizationEnabled: () => true,
    getHardCapKw: () => capacitySettings.limitKw,
  });
  return new PlanBuilder({
    homey: { settings: { set: vi.fn() } } as never,
    getCapacityGuard: () => capacityGuard,
    getCapacitySettings: () => capacitySettings,
    getOperatingMode: () => overrides.modeRef?.current ?? 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => true,
    getPriceOptimizationSettings: () => ({}),
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getPowerTracker: () => powerTrackerRef.current,
    getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(),
    decorateDeferredObjectives: (input) => deferredController.decorate(input),
    getPriorityForDevice: (deviceId) => {
      const mode = overrides.modeRef?.current ?? 'Home';
      return overrides.priorityByModeRef?.current?.[mode]?.[deviceId] ?? 1;
    },
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    log: vi.fn(),
    logDebug: vi.fn(),
    pendingBinaryCommandStore: emptyPendingStore,
  }, createPlanEngineState());
};

const findDevice = (devices: DevicePlanDevice[], id: string = DEVICE_ID): DevicePlanDevice => {
  const device = devices.find((d) => d.id === id);
  if (!device) throw new Error(`expected device ${id} in plan snapshot`);
  return device;
};

const CONTENDER_ID = 'dev_contender';

const buildContender = (params: {
  currentOn: boolean;
  nowMs: number;
  controllable?: boolean;
}): PlanInputDevice => ({
  id: CONTENDER_ID,
  name: 'Contender',
  controllable: params.controllable ?? true,
  hasBinaryControl: true,
  currentOn: params.currentOn,
  measuredPowerKw: params.currentOn ? 1.5 : 0,
  expectedPowerKw: 1.5,
  planningPowerKw: 1.5,
  observationStale: false,
  lastFreshDataMs: params.nowMs,
  targets: [],
});

describe('PlanBuilder deferred-objective admission walkthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Single priority-1 stepped device, capacity-based control toggle OFF.
  // Target +3 °C with kWh/°C=1.5 needs 4.5 kWh; at the low step (1.5 kW) that is
  // three full charging hours. With prices [10,50,10,50,10,50] the planner picks the
  // three cheapest current-or-future buckets each cycle; the expensive buckets in
  // between become idle hours where the device must be held off.
  it('charges in the planned cheap hours and stays off in the expensive ones until the target is met', async () => {
    let temperatureC = 50;
    const powerTrackerRef = { current: buildPowerTracker(DAY_START_UTC) };
    const builder = buildBuilder(powerTrackerRef);

    // Simulate the executor + device-feedback loop: this iteration's plannedState becomes the
    // next iteration's currentOn / selectedStepId so the device input reflects the executor's
    // last command instead of being stuck in the off state forever.
    let currentOn = false;
    let selectedStepId = 'off';
    const observed: Array<{ hour: number; plannedState: string; ran: boolean }> = [];

    for (let hour = 0; hour < 6; hour += 1) {
      const nowMs = DAY_START_UTC + hour * HOUR_MS;
      vi.setSystemTime(new Date(nowMs));
      powerTrackerRef.current = buildPowerTracker(nowMs);

      const snapshot = await builder.buildDevicePlanSnapshot([
        buildDevice({ currentTemperatureC: temperatureC, nowMs, currentOn, selectedStepId }),
      ]);
      const device = findDevice(snapshot.devices);
      const ran = device.plannedState !== 'shed';
      observed.push({ hour, plannedState: device.plannedState, ran });

      // Simulate the executor reflecting plannedState back into actuator state for the next cycle.
      if (ran) {
        currentOn = true;
        selectedStepId = 'low';
        // Simulate that the device actually heated by 1°C while it was running on plan.
        temperatureC += 1;
      } else {
        currentOn = false;
        selectedStepId = 'off';
      }
    }

    // Cap-off device, +3 °C target, 1.5 kWh per °C, 1.5 kW low step. The planner physics
    // gives 1 °C of useful heating per hour at low (1.5 kWh ÷ 1.5 kWh/°C), so meeting the
    // +3 °C target needs three full cheap hours; the planner picks buckets 0, 2, 4 (cheap)
    // and keeps the device shed in 1 and 3 (expensive) between them. After hour 4 the target
    // is met and the deferred objective becomes satisfied at hour 5, so the device returns
    // to its normal capacity-off behavior (kept idle but no longer actively shed by the
    // deferred plan).
    expect(observed).toEqual([
      { hour: 0, plannedState: 'keep', ran: true },
      { hour: 1, plannedState: 'shed', ran: false },
      { hour: 2, plannedState: 'keep', ran: true },
      { hour: 3, plannedState: 'shed', ran: false },
      { hour: 4, plannedState: 'keep', ran: true },
      { hour: 5, plannedState: 'keep', ran: true },
    ]);
    expect(temperatureC).toBeGreaterThanOrEqual(TARGET_C);
  });

  // Regression: the planner must lift the device's commanded setpoint to the deadline
  // target whenever the active operating mode's target is lower. Without this, the
  // executor would write the mode target to the device, the heater's own thermostat
  // would stop at the mode target, and the deferred objective could never reach its
  // goal even with admission and shed-set wiring fully in place.
  it('commands the deadline target when the operating mode target is below it', async () => {
    const powerTrackerRef = { current: buildPowerTracker(DAY_START_UTC) };
    const modeRef = { current: 'Home' };
    const deferredController = new DeferredObjectiveDecorationController({
      getDeferredObjectiveSettings: () => buildSettings(),
      getTimeZone: () => 'UTC',
      getPowerTracker: () => powerTrackerRef.current,
      getPriceOptimizationEnabled: () => true,
      getHardCapKw: () => 100,
    });
    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => {
        const guard = new CapacityGuard({ limitKw: 100, softMarginKw: 0 });
        guard.reportTotalPower(0);
        return guard;
      },
      getCapacitySettings: () => ({ limitKw: 100, marginKw: 0 }),
      getOperatingMode: () => modeRef.current,
      // Mode target sits 3 °C below the deadline target — exactly the bug this test pins.
      getModeDeviceTargets: () => ({ [modeRef.current]: { [DEVICE_ID]: TARGET_C - 3 } }),
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => powerTrackerRef.current,
      getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(),
      decorateDeferredObjectives: (input) => deferredController.decorate(input),
      getPriorityForDevice: () => 1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, createPlanEngineState());

    vi.setSystemTime(new Date(DAY_START_UTC));
    powerTrackerRef.current = buildPowerTracker(DAY_START_UTC);

    const snapshot = await builder.buildDevicePlanSnapshot([
      buildDevice({ currentTemperatureC: 50, nowMs: DAY_START_UTC, currentOn: false, selectedStepId: 'off' }),
    ]);
    const device = findDevice(snapshot.devices);

    // Cycle 0 is a planned hour (cheap-bucket selection from the test fixture's price series).
    expect(device.plannedState).toBe('keep');
    // The override raises plannedTarget to the deadline target; without the fix it would be 50.
    expect(device.plannedTarget).toBe(TARGET_C);
  });

  // The deferred horizon planner and admission decision do not read operating mode, and
  // priority is resolved fresh per cycle from `capacityPriorities[mode][deviceId]`. So a
  // mid-horizon mode flip should be transparent for a single deferred device with no
  // contending managed devices: the per-hour shape is unchanged, and the priority field on
  // the plan output reflects the new mode immediately on the next cycle.
  it('mid-horizon mode flip Home → Away is transparent for a single deferred device', async () => {
    let temperatureC = 50;
    const powerTrackerRef = { current: buildPowerTracker(DAY_START_UTC) };
    const modeRef = { current: 'Home' };
    const priorityByModeRef = {
      current: {
        Home: { [DEVICE_ID]: 1 },
        Away: { [DEVICE_ID]: 5 },
      },
    };
    const builder = buildBuilder(powerTrackerRef, { modeRef, priorityByModeRef });

    let currentOn = false;
    let selectedStepId = 'off';
    const observed: Array<{ hour: number; mode: string; plannedState: string; priority: number }> = [];

    for (let hour = 0; hour < 6; hour += 1) {
      const nowMs = DAY_START_UTC + hour * HOUR_MS;
      vi.setSystemTime(new Date(nowMs));
      powerTrackerRef.current = buildPowerTracker(nowMs);
      // Flip to Away starting at hour 3 (mid-horizon, between deferred-active windows).
      if (hour === 3) modeRef.current = 'Away';

      const snapshot = await builder.buildDevicePlanSnapshot([
        buildDevice({ currentTemperatureC: temperatureC, nowMs, currentOn, selectedStepId }),
      ]);
      const device = findDevice(snapshot.devices);
      observed.push({
        hour,
        mode: modeRef.current,
        plannedState: device.plannedState,
        priority: device.priority,
      });

      if (device.plannedState !== 'shed') {
        currentOn = true;
        selectedStepId = 'low';
        temperatureC += 1;
      } else {
        currentOn = false;
        selectedStepId = 'off';
      }
    }

    expect(observed).toEqual([
      { hour: 0, mode: 'Home', plannedState: 'keep', priority: 1 },
      { hour: 1, mode: 'Home', plannedState: 'shed', priority: 1 },
      { hour: 2, mode: 'Home', plannedState: 'keep', priority: 1 },
      { hour: 3, mode: 'Away', plannedState: 'shed', priority: 5 },
      { hour: 4, mode: 'Away', plannedState: 'keep', priority: 5 },
      { hour: 5, mode: 'Away', plannedState: 'keep', priority: 5 },
    ]);
    expect(temperatureC).toBeGreaterThanOrEqual(TARGET_C);
  });

  // Two managed devices share a 2.5 kW budget that fits exactly one at low. In Home the
  // deferred device is priority 1 and wins the head-to-head; the contender stays shed. After
  // the mode flips to Away at hour 3 the priorities invert: the contender becomes priority 1
  // and the deferred device priority 5, so when both compete in hour 4 (a planned hour for
  // the deferred objective) restore admits the contender first and the deferred device misses
  // its planned hour. The horizon allocator then re-plans on the next cycle and falls back to
  // bucket 5 (originally an "avoid" bucket) as a backup hour. Once the contender finishes
  // externally before bucket 5 runs, the deferred device is admitted again and meets its
  // target via the backup.
  it('falls back to a backup bucket when capacity contention costs the deferred device a planned hour', async () => {
    const capacityGuard = new CapacityGuard({ limitKw: 2.5, softMarginKw: 0 });
    const powerTrackerRef = { current: buildPowerTracker(DAY_START_UTC) };
    const modeRef = { current: 'Home' };
    const priorityByModeRef = {
      current: {
        Home: { [DEVICE_ID]: 1, [CONTENDER_ID]: 5 },
        Away: { [DEVICE_ID]: 5, [CONTENDER_ID]: 1 },
      },
    };
    const builder = buildBuilder(powerTrackerRef, {
      modeRef,
      priorityByModeRef,
      capacityGuard,
      capacitySettings: { limitKw: 2.5, marginKw: 0 },
    });

    let deferTemp = 50;
    let deferOn = false;
    let deferStep = 'off';
    let contendOn = false;
    let contendFinished = false;
    const observed: Array<{
      hour: number;
      mode: string;
      defer: string;
      contend: string;
      deferPriority: number;
    }> = [];

    for (let hour = 0; hour < 6; hour += 1) {
      const nowMs = DAY_START_UTC + hour * HOUR_MS;
      vi.setSystemTime(new Date(nowMs));
      powerTrackerRef.current = buildPowerTracker(nowMs);
      if (hour === 3) modeRef.current = 'Away';
      // Contender finishes externally before bucket 5 runs, freeing capacity for the backup.
      if (hour === 5) {
        contendFinished = true;
        contendOn = false;
      }

      capacityGuard.reportTotalPower((deferOn ? 1.5 : 0) + (contendOn ? 1.5 : 0));

      const snapshot = await builder.buildDevicePlanSnapshot([
        buildDevice({ currentTemperatureC: deferTemp, nowMs, currentOn: deferOn, selectedStepId: deferStep }),
        // After the contender finishes externally we drop it out of PELS management so the
        // freed capacity is available to the deferred device's backup hour. In real PELS this
        // would be e.g. an EV switching to `plugged_in_fully_charged` (its restore lane block
        // reason kicks in) or the user toggling capacity-based control off; for the test we
        // model "no longer managed" with controllable=false.
        buildContender({ currentOn: contendOn, nowMs, controllable: !contendFinished }),
      ]);
      const defer = findDevice(snapshot.devices, DEVICE_ID);
      const contend = findDevice(snapshot.devices, CONTENDER_ID);
      observed.push({
        hour,
        mode: modeRef.current,
        defer: defer.plannedState,
        contend: contend.plannedState,
        deferPriority: defer.priority,
      });

      if (defer.plannedState !== 'shed') {
        deferOn = true;
        deferStep = 'low';
        deferTemp += 1;
      } else {
        deferOn = false;
        deferStep = 'off';
      }
      if (!contendFinished) {
        contendOn = contend.plannedState !== 'shed';
      }
    }

    expect(observed).toEqual([
      // Home, defer pri 1, contend pri 5: defer wins restore admission, contender insufficient headroom.
      { hour: 0, mode: 'Home', defer: 'keep', contend: 'shed', deferPriority: 1 },
      // Idle hour for defer: force-shed; contender can't fit the residual headroom either.
      { hour: 1, mode: 'Home', defer: 'shed', contend: 'shed', deferPriority: 1 },
      { hour: 2, mode: 'Home', defer: 'keep', contend: 'shed', deferPriority: 1 },
      // Mode flips. Idle hour for defer; defer force-shed; contender still can't fit.
      { hour: 3, mode: 'Away', defer: 'shed', contend: 'shed', deferPriority: 5 },
      // Planned hour for defer, but in Away the contender is pri 1 and wins restore first;
      // defer misses this planned hour.
      { hour: 4, mode: 'Away', defer: 'shed', contend: 'keep', deferPriority: 5 },
      // Contender finished externally before bucket 5 — the horizon allocator falls back to
      // bucket 5 (originally an "avoid" / expensive bucket) and the deferred device is
      // admitted there. The contender shows plannedState='keep' because cap-off devices are
      // left alone; PELS isn't actively managing it any more.
      { hour: 5, mode: 'Away', defer: 'keep', contend: 'keep', deferPriority: 5 },
    ]);
    expect(deferTemp).toBeGreaterThanOrEqual(TARGET_C);
  });

  it('routes the planned-hour stepped device toward its lowest active step so the executor will turn it on', async () => {
    const nowMs = DAY_START_UTC; // hour 0, cheap bucket
    vi.setSystemTime(new Date(nowMs));
    const builder = buildBuilder({ current: buildPowerTracker(nowMs) });

    const snapshot = await builder.buildDevicePlanSnapshot([
      buildDevice({ currentTemperatureC: 50, nowMs, currentOn: false, selectedStepId: 'off' }),
    ]);
    const device = findDevice(snapshot.devices);

    expect(device.plannedState).toBe('keep');
    // Off-current + planned-keep should target the lowest active step so the executor turns it on.
    expect(device.desiredStepId).toBe('low');
    // controllable should now reflect the deferred objective override so restore can drive it.
    expect(device.controllable).toBe(true);
  });

  it('falls back to capacity-control-off behavior when the deferred objective is disabled', async () => {
    const nowMs = DAY_START_UTC;
    vi.setSystemTime(new Date(nowMs));
    const powerTracker = buildPowerTracker(nowMs);

    const capacityGuard = new CapacityGuard({ limitKw: 100, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0);
    const deferredController = new DeferredObjectiveDecorationController({
      getDeferredObjectiveSettings: () => ({
        version: 1,
        objectivesByDeviceId: {
          [DEVICE_ID]: {
            enabled: false,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: TARGET_C,
            deadlineAtMs: DEADLINE_AT_MS,
          },
        },
      }),
      getTimeZone: () => 'UTC',
      getPowerTracker: () => powerTracker,
      getPriceOptimizationEnabled: () => true,
      getHardCapKw: () => 100,
    });
    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 100, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => powerTracker,
      getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(),
      decorateDeferredObjectives: (input) => deferredController.decorate(input),
      getPriorityForDevice: () => 1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, createPlanEngineState());

    const snapshot = await builder.buildDevicePlanSnapshot([
      buildDevice({ currentTemperatureC: 50, nowMs, currentOn: false, selectedStepId: 'off' }),
    ]);
    const device = findDevice(snapshot.devices);
    expect(device.plannedState).toBe('keep');
    expect(device.reason.code).toBe('capacity_control_off');
    expect(device.controllable).toBe(false);
  });
});
