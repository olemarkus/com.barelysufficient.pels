import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanContext } from '../../lib/plan/planContext';
import { createPlanEngineState } from '../../lib/plan/planState';
import { applyRestorePlan } from '../../lib/plan/restore';
import { buildPlanDevice } from '../utils/planTestUtils';
import { reasonText } from '../utils/deviceReasonTestUtils';

// A mid-hour clock so power-sample timestamps look fresh (epoch-0 timestamps
// force stale_fail_closed and silently change shed/admission behaviour — see
// project memory). All deps below stamp lastTimestamp = now.
const NOW = Date.UTC(2024, 0, 1, 10, 30, 0);

const buildContext = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices: [],
  desiredForMode: {},
  total: 0,
  powerKnown: true,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  softLimit: 0,
  capacitySoftLimit: 0,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  hourBucketKey: '2024-01-01T10',
  budgetKWh: 5,
  usedKWh: 0,
  minutesRemaining: 30,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  hardCapBurstRateKw: 20,
  ...overrides,
});

const makeDeps = () => ({
  powerTracker: { lastTimestamp: NOW } as PowerTrackerState,
  getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
  logDebug: vi.fn(),
  debugStructured: vi.fn(),
});

// A 2.5 kW heater: expected restore draw 2.5 kW, restore buffer 0.35 kW → need 2.85 kW.
// On a 1 kW soft-rail headroom, the legacy gate (need + 0.25 reserve = 3.10) rejects.
const buildHeater = (overrides: Record<string, unknown> = {}) =>
  buildPlanDevice({
    id: 'heater',
    name: 'Big heater',
    currentState: 'off',
    powerKw: 2.5,
    expectedPowerKw: 2.5,
    ...overrides,
  });

describe('banked-energy min-run restore admission (PR 1b)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('admits a 2.5 kW heater via the banked path when the legacy instantaneous gate would reject', () => {
    const state = createPlanEngineState();
    const deps = makeDeps();

    const result = applyRestorePlan({
      planDevices: [buildHeater({ minRunMinutes: 20 })],
      // Soft budget 5 kWh, ~1 kWh used → banked admit (1 + 2.5·20/60 = 1.83 ≤ 5).
      // Headroom 1 kW → legacy gate rejects (postReserveMargin = 1 − 3.10 < 0.25).
      // total 3 kW + 2.5 = 5.5 ≤ hardCapBurstRateKw 20 → hard-cap safe.
      context: buildContext({
        budgetKWh: 5,
        usedKWh: 1,
        total: 3,
        hardCapBurstRateKw: 20,
        headroomRaw: 1,
        headroom: 1,
      }),
      state,
      sheddingActive: false,
      deps,
    });

    const heater = result.planDevices.find((d) => d.id === 'heater');
    expect(heater?.plannedState).not.toBe('shed');
    expect(result.restoredThisCycle.has('heater')).toBe(true);
    expect(result.restoredOneThisCycle).toBe(true);

    const admittedEvent = deps.debugStructured.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.event === 'restore_admitted' && payload.deviceId === 'heater');
    expect(admittedEvent?.admissionPath).toBe('banked_min_run');
  });

  it('rejects the banked path late in the hour when the min-run energy would exceed the budget', () => {
    const state = createPlanEngineState();
    const deps = makeDeps();

    const result = applyRestorePlan({
      planDevices: [buildHeater({ minRunMinutes: 20 })],
      // 4.8 + 2.5·20/60 = 5.63 > 5 → banked path rejects. Legacy gate also rejects
      // at 1 kW headroom, so the device stays shed.
      context: buildContext({
        budgetKWh: 5,
        usedKWh: 4.8,
        total: 3,
        hardCapBurstRateKw: 20,
        headroomRaw: 1,
        headroom: 1,
      }),
      state,
      sheddingActive: false,
      deps,
    });

    const heater = result.planDevices.find((d) => d.id === 'heater');
    expect(heater?.plannedState).toBe('shed');
    expect(reasonText(heater?.reason)).toContain('insufficient headroom');
    expect(result.restoredThisCycle.has('heater')).toBe(false);
  });

  it('rejects the banked path when turning on now would breach the physical hard cap', () => {
    const state = createPlanEngineState();
    const deps = makeDeps();

    const result = applyRestorePlan({
      planDevices: [buildHeater({ minRunMinutes: 20 })],
      // Banked budget is fine (1 + 0.83 ≤ 5), but current total 4.9 + draw 2.5 =
      // 7.4 > hardCapBurstRateKw 5 → hard-cap guard rejects despite banked budget.
      context: buildContext({
        budgetKWh: 5,
        usedKWh: 1,
        total: 4.9,
        hardCapBurstRateKw: 5,
        headroomRaw: 1,
        headroom: 1,
      }),
      state,
      sheddingActive: false,
      deps,
    });

    const heater = result.planDevices.find((d) => d.id === 'heater');
    expect(heater?.plannedState).toBe('shed');
    expect(result.restoredThisCycle.has('heater')).toBe(false);
  });

  it('does not relax admission via the banked path when power is stale (not trusted)', () => {
    const state = createPlanEngineState();
    const deps = makeDeps();

    const result = applyRestorePlan({
      planDevices: [buildHeater({ minRunMinutes: 20 })],
      // Banked budget + hard cap would BOTH pass on fresh power, but the
      // whole-home sample is stale (powerKnown false). A stale, non-null total
      // understates used kWh and freezes the draw — the banked path must fail
      // closed and leave the legacy (rejecting) gate in charge.
      context: buildContext({
        budgetKWh: 5,
        usedKWh: 1,
        total: 3,
        hardCapBurstRateKw: 20,
        headroomRaw: 1,
        headroom: 1,
        powerKnown: false,
        powerFreshnessState: 'stale_hold',
      }),
      state,
      sheddingActive: false,
      deps,
    });

    const heater = result.planDevices.find((d) => d.id === 'heater');
    expect(heater?.plannedState).toBe('shed');
    expect(result.restoredThisCycle.has('heater')).toBe(false);
  });

  it('is byte-identical to legacy admission when minRunMinutes is unset', () => {
    const baseContext = buildContext({
      budgetKWh: 5,
      usedKWh: 1,
      total: 3,
      hardCapBurstRateKw: 20,
      headroomRaw: 1,
      headroom: 1,
    });

    const withMinRun = applyRestorePlan({
      planDevices: [buildHeater()],
      context: baseContext,
      state: createPlanEngineState(),
      sheddingActive: false,
      deps: makeDeps(),
    });
    const heaterNoMinRun = withMinRun.planDevices.find((d) => d.id === 'heater');

    // No minRunMinutes → banked path never engages → legacy gate rejects at 1 kW
    // headroom, exactly as before this feature.
    expect(heaterNoMinRun?.plannedState).toBe('shed');
    expect(reasonText(heaterNoMinRun?.reason)).toContain('insufficient headroom');
    expect(withMinRun.restoredThisCycle.has('heater')).toBe(false);
  });

  it('still admits via the legacy path (instantaneous) when there is ample headroom, regardless of min-run', () => {
    const state = createPlanEngineState();
    const deps = makeDeps();

    const result = applyRestorePlan({
      planDevices: [buildHeater({ minRunMinutes: 20 })],
      // Ample headroom (5 kW ≥ need 2.85 + reserve) → legacy gate admits first.
      context: buildContext({
        budgetKWh: 5,
        usedKWh: 1,
        total: 3,
        hardCapBurstRateKw: 20,
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps,
    });

    expect(result.restoredThisCycle.has('heater')).toBe(true);
    const admittedEvent = deps.debugStructured.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.event === 'restore_admitted' && payload.deviceId === 'heater');
    expect(admittedEvent?.admissionPath).toBe('instantaneous');
  });
});
