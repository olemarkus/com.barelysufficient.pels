// What an hour the allocator booked NOTHING into means to the device, driven across
// a whole task lifecycle — and how the answer changes with the task's position.
//
// An hour books 0 kWh for two unrelated reasons. Either the fill already met the
// need and the hour is surplus — the price decision, "don't use an hour we don't
// have to" — or a ceiling left no room. Most often that ceiling is the soft daily
// budget's forecast controlled share for the hour, which can legitimately be 0
// (`policyHorizon.resolveMaxUsefulEnergyKWh`). Admission used to read both the same
// and stand the device down, which stops a task that is behind for no reason the
// physical world imposed.
//
// TIER: integration, per `notes/testing-taxonomy.md` § "The border cases" — it spans
// several layers with nothing internal mocked, but it DRIVES them by calling
// `buildDeferredObjectiveDiagnostics` / `applyDeferredObjectiveAdmission` and asserts
// on their returns, which is integration rather than SDK-in/logs-out. It follows the
// simulate-only-the-SDK-boundary rule from
// `lib/objectives/deferredObjectives/AGENTS.md` (device temperature, prices, the
// clock; nothing internal mocked — not `aheadOfHourMilestone`, not the fresh/frozen
// dispatch, not the allocator), which is a rule about what may be faked, not about
// which folder the spec lives in.
//
// The 5-minute grid never lands on the `:58` settle mark, so the bootstrap cycle runs
// the real fresh allocator and every later cycle is the frozen read — which is how
// both producers of `currentHourClaim` get exercised, not just the fresh one.
//
// What it deliberately does NOT cover: the plan layer. An `unclaimed` device is
// modelled here as running, because this harness has no `PlanBuilder` to hold it.
// That the daily-budget pace really does hold it is the design's load-bearing
// assumption and wants a spec of its own.
//
// The scenario is ONE run of a single task, watched across the transition it makes
// on its own: a cold tank at 18:00 cannot finish by 06:00 at its floor step, and as
// it heats it becomes coverable. Two hours are given a zero controlled share — one
// on each side of that transition — so the same cause (no budget share) is observed
// while the task is short and again once it is covered.
import { describe, expect, it } from 'vitest';
import {
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
} from '../../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDiagnostics } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { type PlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { withFixtureResidualKw } from '../utils/planTestUtils';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const DAY = Date.UTC(2026, 0, 1, 0);
const DEVICE_ID = 'heater-1';
const TARGET_C = 63;
// Two positions for the same task. Cold: 22.4 kWh needed against ~6 kWh of budget
// share, so the booked hours cannot cover it however the device steps — the
// shortfall is `limited_by_daily_budget`. Nearly-warm: 1.6 kWh needed, comfortably
// inside the same share, so the task can finish without any hour it skipped.
const COLD_START_C = 35;
const NEARLY_WARM_START_C = 61;
const RATE = 0.8; // kWh/°C, matching the learned mean seeded below
const FLOOR_KW = 1.25; // the step the commitment is sized at
const ELEMENT_KW = 5; // the real bang-bang element
const STANDBY_C_PER_H = 0.3;
const STEP_MS = 5 * MIN_MS;
const START_MS = DAY + 18 * HOUR_MS; // 18:00, cold tank
const END_MS = DAY + 30 * HOUR_MS; // 06:00 next day (the deadline)
const EXPENSIVE = 86.1;
const CHEAP = 73.0;

// 22.4 kWh needed (28 °C × 0.8) against 12 hours at the 1.25 kW floor step = 15 kWh.
// The task therefore starts SHORT, and heating at the real 5 kW element makes it
// coverable partway through — the transition this test watches.

// Hours the daily budget forecasts NO controlled share for, as hour-of-day on the
// 18:00→06:00 timeline (so 26 is 02:00 the next morning). One lands while the task
// is still short, one after it is covered.
const ZERO_SHARE_HODS = new Set([19, 26]);

const OUT_OF_HORIZON = 999;
const todayPriceFor = (h: number): number => {
  if (h === 18 || h === 19) return EXPENSIVE;
  return h >= 20 ? CHEAP : OUT_OF_HORIZON;
};
const todayPrices = Array.from({ length: 24 }, (_, h) => todayPriceFor(h));
const tomorrowPrices = Array.from({ length: 24 }, (_, h) => (h <= 5 ? CHEAP : OUT_OF_HORIZON));
const priceForHourOfDay = (hod: number): number => (hod < 24 ? todayPrices[hod]! : tomorrowPrices[hod - 24]!);

const buildDevice = (tempC: number, nowMs: number): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({
  available: true,
  currentDrawKw: 0,
  expectedPowerKw: 1,
  expectedPowerSource: 'default' as const,
  id: DEVICE_ID,
  name: 'Connected 300',
  commandableNow: true,
  objectiveSessionInactive: false,
  boostSupported: false,
  boostRequested: false,
  hasStandingDemand: true,
  surplusTracking: false,
  confirmedNotDrawing: false,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
  binaryCapabilityId: 'onoff' as const,
  binaryControl: { on: false },
  controllable: false, // cap-off: the smart task is the only reason PELS drives it
  deviceType: 'temperature',
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
})) as PlanInputDevice;

const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  objectiveProfiles: {
    [DEVICE_ID]: {
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: COLD_START_C },
      kwhPerUnit: { sampleCount: 8, mean: RATE, m2: 0, min: RATE, max: RATE, confidence: 'high', lastUpdatedMs: nowMs },
      acceptedSamples: 8,
      rejectedSamples: 0,
    },
  },
});

// `plannedControlledKWh` is what the allocator reads as an hour's ceiling. Zero for
// the chosen hours (the budget layer forecast no room for managed load there), and
// deliberately TIGHT elsewhere: 0.5 kWh/h across 12 hours is 6 kWh against 22.4
// needed, and it binds every step equally, so the climbed-band probe cannot rescue
// it either. That makes the shortfall `limited_by_daily_budget` — a cause the task
// cannot climb or re-estimate its way out of, which is the whole condition for
// keeping an unbooked hour. A generous share would instead yield
// `feasible_above_floor`, where the task CAN finish by climbing and correctly gives
// the hour up.
const buildDay = (dateKey: string, startMs: number, prices: number[], nowMs: number): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: 24 }, (_, i) => new Date(startMs + i * HOUR_MS).toISOString());
  const hodOf = (index: number): number => Math.round((startMs + index * HOUR_MS - DAY) / HOUR_MS);
  const controlled = Array.from({ length: 24 }, (_, i) => (ZERO_SHARE_HODS.has(hodOf(i)) ? 0 : 0.5));
  return {
    dateKey,
    timeZone: 'UTC',
    nowUtc: new Date(nowMs).toISOString(),
    dayStartUtc: new Date(startMs).toISOString(),
    currentBucketIndex: Math.max(0, Math.min(23, Math.floor((nowMs - startMs) / HOUR_MS))),
    budget: { enabled: true, dailyBudgetKWh: 200, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0, allowedNowKWh: 0, remainingKWh: 200, deviationKWh: 0,
      exceeded: false, frozen: false, confidence: 1, priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, i) => `${String(i).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: controlled.map((kWh) => kWh + 1),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1),
      plannedGrossUncontrolledKWh: Array.from({ length: 24 }, () => 1),
      plannedControlledKWh: controlled,
      actualKWh: Array.from({ length: 24 }, () => 0),
      actualControlledKWh: Array.from({ length: 24 }, () => 0),
      actualUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      allowedCumKWh: Array.from({ length: 24 }, (_, i) => (i + 1) * 8),
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
const buildCombinedPrices = (): CombinedPricesV2 => ({
  version: 2,
  days: {
    '2026-01-01': { hours: buildDayHours(DAY, todayPrices) },
    '2026-01-02': { hours: buildDayHours(DAY + 24 * HOUR_MS, tomorrowPrices) },
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

const resolveDeadline = (): number => {
  const r = resolveDeferredObjectiveDeadline({ nowMs: START_MS, timeZone: 'UTC', deadlineLocalTime: '06:00' });
  if (r.deadlineAtMs === null) throw new Error('failed to resolve deadline');
  return r.deadlineAtMs;
};

const buildSettings = () => normalizeDeferredObjectiveSettings({
  version: 1,
  objectivesByDeviceId: {
    [DEVICE_ID]: {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineAtMs: resolveDeadline(),
    },
  },
});

type Cycle = {
  hod: number;
  price: number;
  currentBookedKWh: number;
  // The producer's claim on the hour — read off the plan, never recomputed here.
  claim: string;
  kind: string;
  releaseIntent: string | undefined;
  kWh: number;
};

// One task's whole life at 5-minute cycles. `startC` is the ONLY thing that varies
// between the two scenarios: it sets how much energy the task needs, and therefore
// whether the hours it can book cover that need.
const runScenario = (startC: number): { cycles: Cycle[]; finalTempC: number } => {
  const settings = buildSettings();
  const recorder = new DeferredObjectiveActivePlanRecorder({ load: () => null, save: () => true });
  const cycles: Cycle[] = [];
  let tempC = startC;

  for (let nowMs = START_MS; nowMs < END_MS; nowMs += STEP_MS) {
    const device = buildDevice(tempC, nowMs);
    const activePlans = recorder.getActivePlansSnapshot();
    const [diag] = buildDeferredObjectiveDiagnostics({
      nowMs,
      timeZone: 'UTC',
      devices: [device],
      settings,
      powerTracker: buildPowerTracker(nowMs),
      dailyBudgetSnapshot: buildSnapshot(nowMs),
      buildPriceHorizon: (n, deadlineAtMs) => buildPriceHorizonFromCombined(buildCombinedPrices(), n, deadlineAtMs),
      priceOptimizationEnabled: true,
      activePlans,
    });
    recorder.observe(diag ? [diag] : [], nowMs);
    const decision = diag ? applyDeferredObjectiveAdmission([diag], [device]).get(DEVICE_ID) : undefined;

    // What the device does with each decision. `planned` drives it. `unclaimed`
    // hands it to the planner as managed, which with no competing load and no
    // capacity pressure runs it — the modelled stand-in for the planner this
    // harness does not include. `idle` / `inactive` deliver nothing.
    const driven = decision?.kind === 'planned' || decision?.kind === 'unclaimed';
    const dtH = STEP_MS / HOUR_MS;
    let kWh = 0;
    if (driven && tempC < TARGET_C) {
      kWh = Math.min(ELEMENT_KW * dtH, (TARGET_C - tempC) * RATE);
      tempC += kWh / RATE;
    } else {
      tempC = Math.max(startC, tempC - STANDBY_C_PER_H * dtH);
    }

    const hod = Math.floor((nowMs - DAY) / HOUR_MS);
    cycles.push({
      hod,
      price: priceForHourOfDay(hod),
      currentBookedKWh: diag?.horizonPlan?.currentBucket?.plannedUsefulEnergyKWh ?? 0,
      claim: diag?.horizonPlan?.currentHourClaim ?? 'none',
      kind: decision?.kind ?? 'none',
      releaseIntent: decision?.releaseIntent,
      kWh,
    });
  }
  return { cycles, finalTempC: tempC };
};

const summarise = (cycles: readonly Cycle[]): string => cycles
  .map((c) => `  hod ${c.hod} @${c.price}  booked ${c.currentBookedKWh.toFixed(2)}  claim ${c.claim.padEnd(9)}  ${c.kind}`)
  .join('\n');

describe('an unbooked smart-task hour (SDK-boundary e2e)', () => {
  const unbookedOf = (cycles: readonly Cycle[]): Cycle[] => (
    cycles.filter((c) => c.currentBookedKWh <= 0 && c.kind !== 'inactive')
  );

  describe('while the booked hours cannot cover the need', () => {
    const { cycles } = runScenario(COLD_START_C);
    const unbooked = unbookedOf(cycles);

    it('reproduces the budget-bound shortfall the rule is about', () => {
      // Fixture guard: without unbooked hours, and without them being the
      // zero-share ones, the assertions below would pass vacuously.
      expect(unbooked.length, summarise(cycles)).toBeGreaterThan(0);
      expect([...new Set(unbooked.map((c) => c.hod))].every((hod) => ZERO_SHARE_HODS.has(hod)))
        .toBe(true);
    });

    it('keeps the device in play instead of standing it down', () => {
      // Nothing about the hour's price can explain the empty booking: a task this
      // short books every hour it is allowed to touch, so an unbooked one is
      // always a ceiling — here the daily budget's forecast share.
      expect(
        [...new Set(unbooked.map((c) => c.kind))],
        `a budget-bound task must not stand its device down.\n${summarise(cycles)}`,
      ).toEqual(['unclaimed']);
      expect(unbooked.every((c) => c.releaseIntent === undefined)).toBe(true);
    });

    it('still releases from a BOOKED hour when price deferral says so', () => {
      // The narrow reading matters: even a task that cannot finish gives up an hour
      // it HAS booked once it is ahead of that hour's milestone and a cheaper hour
      // is booked ahead — `priceDeferralEligible` carries its own justification. So
      // "a task that cannot finish never releases" is only true of the
      // unbooked-hour path, which is what the assertion above pins.
      const released = cycles.filter((c) => c.kind === 'idle');
      expect(released.length, summarise(cycles)).toBeGreaterThan(0);
      expect(released.every((c) => c.currentBookedKWh > 0)).toBe(true);
    });
  });

  describe('once the booked hours cover the need', () => {
    const { cycles, finalTempC } = runScenario(NEARLY_WARM_START_C);
    const unbooked = unbookedOf(cycles);

    it('gives the same zero-share hours up, now that it can', () => {
      // Identical budget shares and prices to the scenario above. The ONLY thing
      // that changed is whether the task can finish without those hours.
      expect(unbooked.length, summarise(cycles)).toBeGreaterThan(0);
      expect(
        [...new Set(unbooked.map((c) => c.kind))],
        `a covered task must release the hours it does not need.\n${summarise(cycles)}`,
      ).toEqual(['idle']);
    });

    it('leaves only the cheapest hours carrying load', () => {
      const peakKWh = cycles.filter((c) => c.price === EXPENSIVE).reduce((s, c) => s + c.kWh, 0);
      const cheapKWh = cycles.filter((c) => c.price === CHEAP).reduce((s, c) => s + c.kWh, 0);
      expect(cheapKWh, summarise(cycles)).toBeGreaterThan(0);
      expect(peakKWh, summarise(cycles)).toBeLessThan(cheapKWh);
    });

    it('still reaches the target by the deadline', () => {
      expect(finalTempC).toBeGreaterThanOrEqual(TARGET_C - 1);
    });
  });
});
