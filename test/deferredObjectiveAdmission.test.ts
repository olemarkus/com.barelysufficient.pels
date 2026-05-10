import CapacityGuard from '../lib/core/capacityGuard';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { DevicePlanDevice, PlanInputDevice } from '../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import type { DeferredObjectiveSettingsV1 } from '../lib/plan/deferredObjectives';

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

const buildSettings = (): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: {
    [DEVICE_ID]: {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineLocalTime: '06:00',
    },
  },
});

const buildBuilder = (powerTrackerRef: { current: PowerTrackerState }) => {
  const capacityGuard = new CapacityGuard({ limitKw: 100, softMarginKw: 0 });
  capacityGuard.reportTotalPower(0);
  return new PlanBuilder({
    homey: { settings: { set: vi.fn() } } as never,
    getCapacityGuard: () => capacityGuard,
    getCapacitySettings: () => ({ limitKw: 100, marginKw: 0 }),
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => true,
    getPriceOptimizationSettings: () => ({}),
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getPowerTracker: () => powerTrackerRef.current,
    getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(),
    getDeferredObjectiveSettings: () => buildSettings(),
    getTimeZone: () => 'UTC',
    getPriorityForDevice: () => 1,
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    log: vi.fn(),
    logDebug: vi.fn(),
  }, createPlanEngineState());
};

const findDevice = (devices: DevicePlanDevice[]): DevicePlanDevice => {
  const device = devices.find((d) => d.id === DEVICE_ID);
  if (!device) throw new Error('expected device in plan snapshot');
  return device;
};

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
      getDeferredObjectiveSettings: () => ({
        version: 1,
        objectivesByDeviceId: {
          [DEVICE_ID]: {
            enabled: false,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: TARGET_C,
            deadlineLocalTime: '06:00',
          },
        },
      }),
      getTimeZone: () => 'UTC',
      getPriorityForDevice: () => 1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
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
