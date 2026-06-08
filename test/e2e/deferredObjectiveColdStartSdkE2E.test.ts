// SDK-boundary characterization test for the cold-start ⇄ price-deferral
// interaction — the behaviour almost every reviewer reading the per-cycle frozen
// read gets WRONG (see notes/deferred-load-objectives/execution-adaptation.md,
// "Interaction with the per-cycle frozen read").
//
// THE RULE THIS TEST ENFORCES: a deferred-objective e2e simulates ONLY the Homey
// SDK boundary — device temperature, prices, and the clock — and drives the REAL
// bridge + recorder + admission. It never mocks PELS internals (`aheadOfHourMilestone`,
// the fresh/frozen dispatch, the allocator). An earlier reproduction pinned
// `aheadOfHourMilestone = false`, which severed the price-deferral backstop and made
// the cold-start case look like a catastrophe (device runs the whole expensive hour).
// The real stack shows the opposite: the frozen read drops `coldStartReleaseEligible`,
// but WI-2 price-deferral still releases the device once it crosses its low,
// re-anchored milestone — so the residual peak consumption is only the floor
// bookings that spilled onto the expensive hours, not the full bang-bang element run.
//
// A cold tank during the evening peak (Connected 300, the prod replay WI-4 targeted):
// 18:00/19:00 expensive, 20:00→05:00 cheap, deadline 06:00. The booked floor step is
// 1.25 kW; the real element is 5 kW.
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
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const DAY = Date.UTC(2026, 0, 1, 0);
const DEVICE_ID = 'heater-1';
const TARGET_C = 63;
const START_C = 35;
const RATE = 0.8; // kWh/°C, matches the power-tracker learned mean below
const FLOOR_KW = 1.25; // the step the commitment is sized at
const ELEMENT_KW = 5; // the real bang-bang element the climbed step reflects
const STANDBY_C_PER_H = 0.3;
const STEP_MS = 5 * MIN_MS;
const START_MS = DAY + 18 * HOUR_MS; // 18:00, cold tank
const END_MS = DAY + 30 * HOUR_MS; // 06:00 next day (the deadline)
const EXPENSIVE = 86.1;
const CHEAP = 73.0;

// 24-h price arrays. Outside the horizon prices are set high so the allocator
// never books them; only 18:00/19:00 (expensive) and 20:00→05:00 (cheap) matter.
const OUT_OF_HORIZON = 999;
const todayPriceFor = (h: number): number => {
  if (h === 18 || h === 19) return EXPENSIVE;
  return h >= 20 ? CHEAP : OUT_OF_HORIZON;
};
const todayPrices = Array.from({ length: 24 }, (_, h) => todayPriceFor(h));
const tomorrowPrices = Array.from({ length: 24 }, (_, h) => (h <= 5 ? CHEAP : OUT_OF_HORIZON));
const priceForHourOfDay = (hod: number): number => (hod < 24 ? todayPrices[hod]! : tomorrowPrices[hod - 24]!);

const buildDevice = (tempC: number, nowMs: number): PlanInputDevice => ({
  id: DEVICE_ID,
  name: 'Connected 300',
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
  binaryControl: { on: false },
  controllable: false, // cap-off: the deferred objective is the only reason PELS drives it
  deviceType: 'temperature',
  controlModel: 'stepped_load',
  currentTemperature: tempC,
  lastFreshDataMs: nowMs,
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: FLOOR_KW * 1000 },
      { id: 'max', planningPowerW: ELEMENT_KW * 1000 },
    ],
  },
});

const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  objectiveProfiles: {
    [DEVICE_ID]: {
      kind: 'temperature',
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: START_C, unit: 'degree_c' },
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
      actualKWh: Array.from({ length: 24 }, () => 0),
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

// Prices are an SDK-boundary input: the allocation horizon now reads them from
// the price layer (`CombinedPricesV2`), not the daily-budget snapshot. Build the
// store from the SAME today/tomorrow arrays so this e2e still drives the real
// producer from raw prices.
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
    [DEVICE_ID]: { enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: TARGET_C, deadlineAtMs: resolveDeadline() },
  },
});

type HourOutcome = { hod: number; price: number; kWh: number; minutesDriven: number; priceDeferredHere: boolean };

// Drive the real stack from the SDK boundary, cycle by cycle, against a bang-bang
// thermal model. Only temperature/prices/clock are simulated.
const runScenario = (): { hours: HourOutcome[]; finalTempC: number } => {
  const settings = buildSettings();
  const recorder = new DeferredObjectiveActivePlanRecorder({ load: () => null, save: () => true });
  const byHour = new Map<number, HourOutcome>();
  let tempC = START_C;

  // 5-minute grid from the top of the hour: the bootstrap cycle runs the real
  // fresh allocator, and every later cycle is the frozen read (the grid never
  // lands on the :58 settle mark). That is exactly the cold-start frozen-read case
  // under test — the frozen read drops coldStartReleaseEligible and WI-2 must carry
  // the release. (A :58-resettle path is covered elsewhere.)
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
    const driven = decision?.kind === 'planned';

    const dtH = STEP_MS / HOUR_MS;
    let kWh = 0;
    if (driven && tempC < TARGET_C) {
      kWh = Math.min(ELEMENT_KW * dtH, (TARGET_C - tempC) * RATE);
      tempC += kWh / RATE;
    } else {
      tempC = Math.max(START_C, tempC - STANDBY_C_PER_H * dtH);
    }

    const hod = Math.floor((nowMs - DAY) / HOUR_MS);
    const outcome = byHour.get(hod) ?? { hod, price: priceForHourOfDay(hod), kWh: 0, minutesDriven: 0, priceDeferredHere: false };
    outcome.kWh += kWh;
    outcome.minutesDriven += driven ? 5 : 0;
    if (diag?.horizonPlan?.priceDeferralEligible) outcome.priceDeferredHere = true;
    byHour.set(hod, outcome);
  }
  return { hours: [...byHour.values()].sort((a, b) => a.hod - b.hod), finalTempC: tempC };
};

describe('cold-start ⇄ price-deferral (SDK-boundary e2e)', () => {
  const { hours, finalTempC } = runScenario();
  const sumKWh = (pred: (h: HourOutcome) => boolean): number => hours.filter(pred).reduce((s, h) => s + h.kWh, 0);
  const peakKWh = sumKWh((h) => h.price === EXPENSIVE);
  const cheapKWh = sumKWh((h) => h.price === CHEAP);
  const peakHours = hours.filter((h) => h.price === EXPENSIVE);

  it('still reaches the target by the deadline (the task succeeds either way)', () => {
    expect(finalTempC).toBeGreaterThanOrEqual(TARGET_C - 1);
  });

  it('loads the cheap window, not the peak (price-deferral does the heavy lifting)', () => {
    expect(peakKWh).toBeLessThan(cheapKWh);
    // A full bang-bang run of the two peak hours would be ~10 kWh (2 h × 5 kW). The
    // backstop bounds peak draw to roughly the spilled floor bookings (~1.25 kWh/h),
    // NOT the element run — this is the whole point reviewers miss.
    expect(peakKWh).toBeLessThanOrEqual(3.5);
  });

  it('price-deferral releases the device mid-hour in the peak hours (the backstop fires)', () => {
    // Every expensive hour ends up price-deferred once the device crosses its low,
    // re-anchored milestone — the frozen read drops `coldStartReleaseEligible`, but
    // WI-2 still idles the device. If a future change pins `aheadOfHourMilestone`,
    // this assertion (and the bound above) is what catches the lost backstop.
    expect(peakHours.length).toBeGreaterThan(0);
    expect(peakHours.every((h) => h.priceDeferredHere)).toBe(true);
    // …and because it is released, no peak hour runs the full 60 minutes.
    expect(peakHours.every((h) => h.minutesDriven < 60)).toBe(true);
  });
});
