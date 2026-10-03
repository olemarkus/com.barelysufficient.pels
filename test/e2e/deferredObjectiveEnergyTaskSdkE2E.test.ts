// SDK-boundary e2e for an energy smart task: "deliver 6 kWh to the water heater
// between 22:00 and 06:00" on a heater switched by a plain relay, with no
// temperature reading and no battery level. The Flow that creates the task runs
// at 22:00, so the task starts then.
//
// The simulated inputs are what the device and the world report — the relay's
// measured power and whether it is a live measurement, prices and the clock —
// handed in as the planner-input device the device layer would project, the
// same boundary the cold-start SDK e2e drives. The REAL delivery tracker,
// bridge, recorder and admission are driven, cycle by cycle, exactly as the
// lifecycle clock drives them (see `lib/objectives/deferredObjectives/AGENTS.md`);
// nothing inside the smart-task stack is mocked.
import { describe, expect, it } from 'vitest';
import { normalizeDeferredObjectiveSettings } from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { resolveDeferredObjectiveDeadline } from '../../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDiagnostics } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { EnergyTaskDeliveryTracker } from '../../lib/objectives/deferredObjectives/energyDelivery';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';
import { type MeteredPlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import {
  createMemoryEnergyDeliveryStore,
  noDeviceExclusion,
  noStallEvidence,
} from '../helpers/deferredObjectiveWiringFixtures';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const STEP_MS = 5 * MIN_MS;
const DAY = Date.UTC(2026, 0, 1, 0);
const DEVICE_ID = 'water-heater-relay';
const ELEMENT_KW = 2;
const TARGET_KWH = 6;
const START_MS = DAY + 22 * HOUR_MS;
const END_MS = DAY + 30 * HOUR_MS; // 06:00 next day, the deadline
const CHEAP = 20;
const EXPENSIVE = 90;
const OUT_OF_HORIZON = 999;
const TEST_SUSTAINABLE_RATE_KW = 100;

// Inside the 22:00 → 06:00 window only 01:00, 02:00 and 03:00 are cheap: three
// hours of a 2 kW element is exactly the 6 kWh asked for.
const isCheapHourOfDay = (hod: number): boolean => hod >= 25 && hod <= 27;
const priceForHourOfDay = (hod: number): number => {
  if (hod < 22 || hod >= 30) return OUT_OF_HORIZON;
  return isCheapHourOfDay(hod) ? CHEAP : EXPENSIVE;
};

const buildDayHours = (dayStartMs: number, firstHod: number): CombinedPriceEntry[] => (
  Array.from({ length: 24 }, (_, i) => {
    const total = priceForHourOfDay(firstHod + i);
    return {
      startsAt: new Date(dayStartMs + i * HOUR_MS).toISOString(),
      total,
      isCheap: total === CHEAP,
      isExpensive: total === EXPENSIVE,
    };
  })
);

const buildCombinedPrices = (): CombinedPricesV2 => ({
  version: 2,
  days: {
    '2026-01-01': { hours: buildDayHours(DAY, 0) },
    '2026-01-02': { hours: buildDayHours(DAY + 24 * HOUR_MS, 24) },
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

// A plain relay: on/off, a measured draw, and nothing else — no target, no
// temperature, no stepped controls. Cap-off, so the smart task is the only
// reason PELS switches it on.
// `thermalDirection` is what the objective boundary attaches from the observer;
// a relay never heats or cools toward a setpoint, so the observer's default
// ('heating') is what reaches it.
const buildRelay = (
  drawKw: number,
  on: boolean,
  nowMs: number,
): MeteredPlanInputDevice & { thermalDirection: 'heating' } => (
  withBinaryDiscriminant(withFixtureResidualKw({
    available: true,
    currentDrawKw: drawKw,
    id: DEVICE_ID,
    expectedPowerKw: ELEMENT_KW,
    expectedPowerSource: 'measured-peak',
    name: 'Water heater relay',
    commandableNow: true,
    objectiveSessionInactive: false,
    boostSupported: false,
    boostRequested: false,
    hasStandingDemand: true,
    surplusTracking: false,
    confirmedNotDrawing: false,
    targets: [],
    binaryCapabilityId: 'onoff' as const,
    binaryControl: { on },
    control: fixtureControlPosture({ controllable: false }),
    deviceType: 'onoff',
    lastFreshDataMs: nowMs,
    thermalDirection: 'heating',
  })) as unknown as MeteredPlanInputDevice & { thermalDirection: 'heating' }
);

const resolveDeadline = (): number => {
  const resolution = resolveDeferredObjectiveDeadline({ nowMs: START_MS, timeZone: 'UTC', deadlineLocalTime: '06:00' });
  if (resolution.deadlineAtMs === null) throw new Error('failed to resolve deadline');
  return resolution.deadlineAtMs;
};

type HourOutcome = { hod: number; kWh: number };
type Scenario = {
  hours: HourOutcome[];
  deliveredKWh: number;
  countedKWh: number;
  finalStatus: string | undefined;
};

// `tankFullAfterKWh`: the heater's own thermostat cuts the element once the
// tank is hot, and then the relay being on draws nothing. `meterOnlyHourOfDay`:
// for that hour the relay's own power reading is gone and its power figure is
// a rate derived from its cumulative meter, which is not a live measurement.
// The relay still switches as commanded.
const runScenario = (tankFullAfterKWh: number, meterOnlyHourOfDay: number | null = null): Scenario => {
  const deadlineAtMs = resolveDeadline();
  const settings = normalizeDeferredObjectiveSettings({
    version: 1,
    objectivesByDeviceId: {
      [DEVICE_ID]: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: TARGET_KWH, deadlineAtMs },
    },
  });
  let liveReading = true;
  const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), () => liveReading);
  const recorder = new DeferredObjectiveActivePlanRecorder({ load: () => null, save: () => true });
  const byHour = new Map<number, HourOutcome>();
  let relayOn = false;
  let deliveredKWh = 0;
  let finalStatus: string | undefined;

  for (let nowMs = START_MS; nowMs < END_MS; nowMs += STEP_MS) {
    // What the relay's meter reports now: the element runs while the relay is on
    // and the tank still takes heat.
    const hodNow = Math.floor((nowMs - DAY) / HOUR_MS);
    liveReading = hodNow !== meterOnlyHourOfDay;
    const drawKw = relayOn && deliveredKWh < tankFullAfterKWh ? ELEMENT_KW : 0;
    const device = buildRelay(drawKw, relayOn, nowMs);
    tracker.observe([device], settings, nowMs);
    const [diag] = buildDeferredObjectiveDiagnostics({
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      isReservationSuppressed: () => false,
      getDeliveredEnergyKWh: tracker.getDeliveredKWh,
      getPrioritiesForDevices: createFixturePriorityQuery([device]),
      sustainableRateKw: TEST_SUSTAINABLE_RATE_KW,
      nowMs,
      timeZone: 'UTC',
      devices: [device],
      settings,
      powerTracker: {},
      dailyBudgetSnapshot: null,
      buildPriceHorizon: (n, deadline) => buildPriceHorizonFromCombined(buildCombinedPrices(), n, deadline),
      priceOptimizationEnabled: true,
      activePlans: recorder.getActivePlansSnapshot(),
    });
    recorder.observe(diag ? [diag] : [], nowMs);
    const decision = diag ? applyDeferredObjectiveAdmission([diag.evaluation], [device]).get(DEVICE_ID) : undefined;
    relayOn = decision?.kind === 'planned';
    finalStatus = diag?.horizonPlan?.status;

    // The energy the element actually delivers until the next cycle.
    const stepKWh = relayOn && deliveredKWh < tankFullAfterKWh
      ? Math.min(ELEMENT_KW * (STEP_MS / HOUR_MS), tankFullAfterKWh - deliveredKWh)
      : 0;
    deliveredKWh += stepKWh;
    const hod = Math.floor((nowMs - DAY) / HOUR_MS);
    const outcome = byHour.get(hod) ?? { hod, kWh: 0 };
    outcome.kWh += stepKWh;
    byHour.set(hod, outcome);
  }
  return {
    hours: [...byHour.values()].sort((a, b) => a.hod - b.hod),
    deliveredKWh,
    countedKWh: tracker.getDeliveredKWh(DEVICE_ID, deadlineAtMs),
    finalStatus,
  };
};

const sumKWh = (hours: HourOutcome[], pred: (hod: number) => boolean): number => (
  hours.filter((hour) => pred(hour.hod)).reduce((sum, hour) => sum + hour.kWh, 0)
);

describe('energy smart task on a relay (SDK-boundary e2e)', () => {
  describe('a heater that takes all the energy asked for', () => {
    const scenario = runScenario(Number.POSITIVE_INFINITY);

    it('feeds the device the energy asked for by the deadline', () => {
      expect(scenario.deliveredKWh).toBeGreaterThanOrEqual(TARGET_KWH - 0.2);
      // It stands the relay down at the target rather than running on.
      expect(scenario.deliveredKWh).toBeLessThanOrEqual(TARGET_KWH + ELEMENT_KW * (STEP_MS / HOUR_MS) + 0.01);
    });

    it('spends the energy in the cheapest hours of the window', () => {
      const cheapKWh = sumKWh(scenario.hours, isCheapHourOfDay);
      const expensiveKWh = sumKWh(scenario.hours, (hod) => !isCheapHourOfDay(hod));
      expect(cheapKWh).toBeGreaterThanOrEqual(TARGET_KWH - 0.5);
      expect(expensiveKWh).toBeLessThan(0.5);
    });

    it('counts the energy it plans from off the relay\'s own power readings', () => {
      // The count books each reading over the interval after it, so it trails
      // what the element delivered by at most one cycle's worth of energy.
      expect(Math.abs(scenario.countedKWh - scenario.deliveredKWh))
        .toBeLessThanOrEqual(ELEMENT_KW * (STEP_MS / HOUR_MS) + 0.01);
      expect(scenario.finalStatus).toBe('satisfied');
    });
  });

  describe('a relay whose live power reading goes away during a cheap hour', () => {
    // 02:00-03:00 its power figure is meter-derived, not a live measurement.
    // The element heats, but none of that hour counts, so the task asks for
    // more rather than crediting a rate that lingers after switch-off. It errs
    // toward delivering too much, never too little.
    const scenario = runScenario(Number.POSITIVE_INFINITY, 26);

    it('counts only live readings, and still delivers the target', () => {
      expect(scenario.countedKWh).toBeLessThan(scenario.deliveredKWh - 1);
      expect(scenario.deliveredKWh).toBeGreaterThanOrEqual(TARGET_KWH - 0.2);
    });
  });

  describe('a heater whose own thermostat cuts out once the tank is hot', () => {
    const scenario = runScenario(4);

    it('stops taking energy, and the task ends short of its target instead of claiming it', () => {
      expect(scenario.deliveredKWh).toBeCloseTo(4);
      expect(scenario.countedKWh).toBeLessThan(TARGET_KWH);
      expect(scenario.finalStatus).not.toBe('satisfied');
    });
  });
});
