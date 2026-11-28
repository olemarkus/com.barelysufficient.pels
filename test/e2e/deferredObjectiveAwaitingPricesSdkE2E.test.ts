// SDK-boundary e2e for a smart task created before the next day's prices exist.
//
// An evening task books today's priced intervals and schedules the rest on
// available power. Later prices replace that fallback without erasing elapsed
// priced work. If prices never arrive, the saved fallback still runs.
//
// HOW IT IS SIMULATED: only the device temperature, the published prices and
// the clock. The real evaluation, recorder and admission run every cycle. A
// device the task leaves to normal control (`inactive`) heats at once, as a
// thermostat below its setpoint does.
import { noDeviceExclusion, noDeliveredEnergy, noStallEvidence } from '../helpers/deferredObjectiveWiringFixtures';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { describe, expect, it } from 'vitest';
import { objectiveRosterFor } from '../utils/objectiveRoster';
import { buildFixtureDiagnosticsForLane } from '../helpers/taskEvaluationFixture';
import { priceHorizonFromStore } from '../helpers/priceHorizonFromStore';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { TaskPlanningTurns } from '../../lib/objectives/deferredObjectives/taskPlanningTurns';
import type { DeferredObjectiveActivePlanRevisionV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { type MeteredPlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const STEP_MS = 5 * MIN_MS;
const DAY = Date.UTC(2026, 0, 1, 0);
const DEVICE_ID = 'heater-1';
const TARGET_C = 63;
const START_C = 53;
const RATE = 0.8; // kWh per degree, the learned mean below
const FLOOR_KW = 1.25;
const ELEMENT_KW = 5;
const START_MS = DAY + 21 * HOUR_MS;
const PUBLISH_MS = DAY + 22 * HOUR_MS + 10 * MIN_MS;
const DEADLINE_MS = DAY + 31 * HOUR_MS; // 07:00 next day
// Three priced hours can deliver 3 kWh. The other 5 kWh take four hours
// at the lowest rung, so the fallback starts at 02:00 and leaves the reserve.
const FALLBACK_START_MS = DAY + 26 * HOUR_MS;
const TODAY_PRICE = 100;
const NIGHT_PRICE = 50;

const todayPrices = Array.from({ length: 24 }, () => TODAY_PRICE);
const tomorrowPrices = Array.from({ length: 24 }, (_, h) => (h <= 6 ? NIGHT_PRICE : TODAY_PRICE));

const buildDevice = (tempC: number, nowMs: number): MeteredPlanInputDevice & { thermalDirection: 'heating' } => withBinaryDiscriminant(withFixtureResidualKw({ available: true, currentDrawKw: 0,
  id: DEVICE_ID,
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Water heater',
  commandableNow: true,
  objectiveSessionInactive: false, waitingForCarAssociation: false,
  boostSupported: false,
  boostRequested: false,
  hasStandingDemand: true,
  surplusTracking: false,
  confirmedNotDrawing: false,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
  binaryCapabilityId: 'onoff' as const,
  binaryControl: { on: false },
  control: fixtureControlPosture({ controllable: true }),
  deviceType: 'temperature',
  thermalDirection: 'heating',
  controlModel: 'stepped_load',
  currentTemperature: tempC,
  lastFreshDataMs: nowMs,
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: FLOOR_KW * 1000 },
      { id: 'max', planningPowerW: ELEMENT_KW * 1000 },
    ],
  },
})) as unknown as MeteredPlanInputDevice & { thermalDirection: 'heating' };

const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  objectiveProfiles: {
    [DEVICE_ID]: {
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: START_C },
      kwhPerUnit: { sampleCount: 8, mean: RATE, m2: 0, min: RATE, max: RATE, confidence: 'high', lastUpdatedMs: nowMs },
      acceptedSamples: 8,
      rejectedSamples: 0,
    },
  },
});

const buildDay = (dateKey: string, startMs: number, prices: number[], nowMs: number): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: 24 }, (_, i) => new Date(startMs + i * HOUR_MS).toISOString());
  return {
    dateKey,
    timeZone: 'UTC',
    nowUtc: new Date(nowMs).toISOString(),
    dayStartUtc: new Date(startMs).toISOString(),
    currentBucketIndex: Math.max(0, Math.min(23, Math.floor((nowMs - startMs) / HOUR_MS))),
    budget: { enabled: true, dailyBudgetKWh: 100, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0, allowedNowKWh: 0, remainingKWh: 100, deviationKWh: 0,
      exceeded: false, frozen: false, confidence: 1, priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, i) => `${String(i).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: Array.from({ length: 24 }, () => 1),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1),
      actualKWh: Array.from({ length: 24 }, () => 0),
      actualControlledKWh: Array.from({ length: 24 }, () => 0),
      actualUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      allowedCumKWh: Array.from({ length: 24 }, (_, i) => (i + 1) * 4),
      price: prices,
      priceFactor: prices.map((p) => (p <= 10 ? 1.2 : 0.8)),
    },
  };
};

const buildSnapshot = (nowMs: number): DailyBudgetUiPayload => ({
  days: {
    '2026-01-01': buildDay('2026-01-01', DAY, todayPrices, nowMs),
    '2026-01-02': buildDay('2026-01-02', DAY + 24 * HOUR_MS, tomorrowPrices, nowMs),
  },
  todayKey: '2026-01-01',
  tomorrowKey: '2026-01-02',
});

const buildDayHours = (startMs: number, prices: number[]): CombinedPriceEntry[] => (
  prices.map((total, i) => ({
    startsAt: new Date(startMs + i * HOUR_MS).toISOString(),
    total,
    isCheap: total <= 10,
    isExpensive: false,
  }))
);
/** The stored prices at `nowMs`: the next day appears once it is published. */
const buildCombinedPrices = (
  nowMs: number, publishAtMs: number | null, todayPublished: boolean,
): CombinedPricesV2 => ({
  version: 2,
  days: {
    ...(todayPublished ? { '2026-01-01': { hours: buildDayHours(DAY, todayPrices) } } : {}),
    ...(publishAtMs !== null && nowMs >= publishAtMs
      ? { '2026-01-02': { hours: buildDayHours(DAY + 24 * HOUR_MS, tomorrowPrices) } } : {}),
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

type Cycle = {
  nowMs: number;
  decision: string;
  usesAvailablePower: boolean;
  kWh: number;
  plan: DeferredObjectiveActivePlanRevisionV1 | null;
};

const runScenario = (
  publishAtMs: number | null, todayPublished = true,
): { cycles: Cycle[]; finalTempC: number } => {
  const settings = objectiveRosterFor({
    objectivesByDeviceId: {
      [DEVICE_ID]: {
        enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: TARGET_C, deadlineAtMs: DEADLINE_MS,
      },
    },
  });
  let recorder = new DeferredObjectiveActivePlanRecorder({ load: () => null, save: () => true });
  let turns = new TaskPlanningTurns();
  const cycles: Cycle[] = [];
  let tempC = START_C;
  for (let nowMs = START_MS; nowMs < DEADLINE_MS; nowMs += STEP_MS) {
    if (publishAtMs === null && nowMs === DAY + 25 * HOUR_MS) {
      const saved = recorder.getActivePlansSnapshot();
      recorder = new DeferredObjectiveActivePlanRecorder({ load: () => saved, save: () => true });
      turns = new TaskPlanningTurns();
    }
    const device = buildDevice(tempC, nowMs);
    const [diag] = buildFixtureDiagnosticsForLane({
      hasSolarProduction: false,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      hasObservedTask: () => false,
      isReservationSuppressed: () => false,
      getDeliveredEnergyKWh: noDeliveredEnergy,
      getPrioritiesForDevices: createFixturePriorityQuery([device]),
      powerLimits: capacityOnlyPowerLimits(100),
      nowMs,
      timeZone: 'UTC',
      devices: [device],
      settings,
      powerTracker: buildPowerTracker(nowMs),
      dailyBudgetSnapshot: buildSnapshot(nowMs),
      buildPriceHorizon: (n, deadlineAtMs) => (
        priceHorizonFromStore(buildCombinedPrices(nowMs, publishAtMs, todayPublished), n, deadlineAtMs)
      ),
      priceOptimizationEnabled: true,
      activePlans: recorder.getActivePlansSnapshot(),
    }, { kind: 'scheduled', turns });
    recorder.observe(diag ? [diag] : [], nowMs);
    const decision = diag ? applyDeferredObjectiveAdmission([diag.evaluation], [device]).get(DEVICE_ID) : undefined;
    // `inactive` hands the device to normal control, where a heater below its
    // setpoint runs; `idle` is the task holding it off.
    const runs = decision?.kind !== 'idle';
    const usesAvailablePower = decision?.usesAvailablePower === true;
    const dtH = STEP_MS / HOUR_MS;
    const powerKw = usesAvailablePower ? FLOOR_KW : 1;
    const kWh = runs && tempC < TARGET_C ? Math.min(powerKw * dtH, (TARGET_C - tempC) * RATE) : 0;
    tempC += kWh / RATE;
    cycles.push({
      nowMs,
      decision: decision?.kind ?? 'none',
      usesAvailablePower,
      kWh,
      plan: recorder.getActivePlan(DEVICE_ID)?.latest ?? null,
    });
  }
  return { cycles, finalTempC: tempC };
};

const sumKWh = (cycles: Cycle[]): number => cycles.reduce((sum, cycle) => sum + cycle.kWh, 0);

describe('smart task created before the next day\'s prices (SDK-boundary e2e)', () => {
  it('books priced work immediately and revises the remaining schedule when prices arrive', () => {
    const { cycles, finalTempC } = runScenario(PUBLISH_MS);
    const first = cycles[0];
    expect(first?.decision).toBe('planned');
    expect(first?.plan?.hours.filter((hour) => hour.plannedKWh > 0)).toHaveLength(3);
    expect(first?.plan?.partialPriceSchedule?.fallbackWindows[0]?.startsAtMs).toBe(FALLBACK_START_MS);
    expect(sumKWh(cycles.filter((cycle) => cycle.nowMs < PUBLISH_MS))).toBeGreaterThan(1);

    const revised = cycles.find((cycle) => cycle.nowMs === PUBLISH_MS)?.plan;
    expect(revised?.reason).toBe('prices_revised');
    expect(revised?.partialPriceSchedule).toBeUndefined();
    expect(revised?.hours).toEqual(expect.arrayContaining([
      expect.objectContaining({ startsAtMs: START_MS, endsAtMs: START_MS + HOUR_MS, plannedKWh: 1 }),
    ]));
    expect(revised?.hours.some((hour) => hour.startsAtMs >= DAY + 24 * HOUR_MS && hour.plannedKWh > 0)).toBe(true);
    expect(finalTempC).toBeGreaterThanOrEqual(TARGET_C - 1);
  });

  it('runs the saved fallback on available power after the last priced interval and a restart', () => {
    const { cycles, finalTempC } = runScenario(null);
    const held = cycles.filter((cycle) => cycle.nowMs >= DAY + 24 * HOUR_MS && cycle.nowMs < FALLBACK_START_MS);
    const started = cycles.find((cycle) => cycle.nowMs === FALLBACK_START_MS);
    expect(held.every((cycle) => cycle.decision === 'idle')).toBe(true);
    expect(sumKWh(held)).toBe(0);
    expect(started).toMatchObject({ decision: 'planned', usesAvailablePower: true, kWh: expect.any(Number) });
    expect(started?.kWh).toBeGreaterThan(0);
    expect(finalTempC).toBeGreaterThanOrEqual(TARGET_C - 1);
  });

  it('leaves the device to normal control when there are no prices at all', () => {
    const { cycles } = runScenario(null, false);
    expect(cycles[0]?.decision).toBe('inactive');
    expect(cycles[0]?.kWh).toBeGreaterThan(0);
  });
});
