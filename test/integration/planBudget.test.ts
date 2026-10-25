import { getHourBucketKey } from '../../lib/utils/hourBuckets';
import {
  computeDailyUsageSoftLimit,
  computeDynamicSoftLimit,
  computeShortfallThreshold,
  isDailyBudgetBelowPlanningCeiling,
  resolveCapacityAdmissionHeadroomKw,
} from '../../lib/plan/planBudget';
import { CapacityDrainStart, type DrainStart } from '../../lib/plan/capacityDrainStart';
import { capacityOnlyPowerLimits, powerLimits } from '../helpers/powerLimitSettings';

// What the house drew when the hour's drain window opened at :50. Read only inside the window.
const HOUSE_DRAW_KW = 8;
const DRAIN_START: DrainStart = { drawKw: HOUSE_DRAW_KW, minutesRemaining: 10 };
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';

const budgetSnapshot = (dailyBudgetKWh: number, hours: number, enabled = true): DailyBudgetUiPayload => {
  const dateKey = '2026-10-25';
  const zeros = Array.from({ length: hours }, () => 0);
  return {
    todayKey: dateKey,
    days: {
      [dateKey]: {
        dateKey,
        timeZone: 'Europe/Oslo',
        nowUtc: '2026-10-25T12:00:00.000Z',
        dayStartUtc: '2026-10-24T22:00:00.000Z',
        currentBucketIndex: 12,
        budget: { enabled, dailyBudgetKWh, priceShapingEnabled: false },
        state: {
          usedNowKWh: 0,
          allowedNowKWh: 0,
          remainingKWh: dailyBudgetKWh,
          deviationKWh: 0,
          exceeded: false,
          frozen: false,
          confidence: 1,
          priceShapingActive: false,
        },
        buckets: {
          startUtc: Array.from({ length: hours }, (_, index) => new Date(index * 3_600_000).toISOString()),
          startLocalLabels: Array.from({ length: hours }, (_, index) => String(index)),
          plannedWeight: zeros,
          plannedKWh: zeros,
          plannedUncontrolledKWh: zeros,
          plannedControlledKWh: zeros,
          actualKWh: zeros,
          actualControlledKWh: zeros,
          actualUncontrolledKWh: zeros,
          allowedCumKWh: zeros,
          price: zeros,
          priceFactor: zeros,
        },
      },
    },
  };
};

describe('planBudget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('budget-pressure eligibility', () => {
    const capacity = capacityOnlyPowerLimits(5, 0.5);

    it('stays active below hard cap minus margin for the actual local-day length', () => {
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(112.4, 25), capacity)).toBe(true);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(112.5, 25), capacity)).toBe(false);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(103.4, 23), capacity)).toBe(true);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(103.5, 23), capacity)).toBe(false);
    });

    it('is inactive when daily-budget control is disabled', () => {
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(40, 24, false), capacity)).toBe(false);
    });

    it('stays active for any enabled budget when no power limit is enabled', () => {
      // Nothing caps the day but the budget, so the budget is the binding limit;
      // a switched-off 5 kW hard cap must not decide (360 kWh > 4.5 kW × 24 h).
      const noLimits = powerLimits({ enabled: false, limitKw: 5, marginKw: 0.5 }, null);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(360, 24), noLimits)).toBe(true);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(40, 24, false), noLimits)).toBe(false);
    });

    it('compares against the grid import target once Capacity limit is off', () => {
      // 17 kW grid limit: target 16.15 kW, 387.6 kWh over 24 h. The hidden 4.5 kW
      // capacity rate (108 kWh) no longer decides.
      const gridOnly = powerLimits({ enabled: false, limitKw: 5, marginKw: 0.5 }, 17);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(200, 24), gridOnly)).toBe(true);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(387.5, 24), gridOnly)).toBe(true);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(387.7, 24), gridOnly)).toBe(false);
    });

    it('compares against the lower limit when both are enabled', () => {
      // Capacity 10 − 0.2 = 9.8 kW (235.2 kWh); grid 7.4 kW → 7.03 kW (168.72 kWh).
      const both = powerLimits({ enabled: true, limitKw: 10, marginKw: 0.2 }, 7.4);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(168.7, 24), both)).toBe(true);
      expect(isDailyBudgetBelowPlanningCeiling(budgetSnapshot(168.8, 24), both)).toBe(false);
    });
  });

  describe('computeDynamicSoftLimit', () => {
    it('returns 0 when net soft budget is non-positive', () => {
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 5, periodMinutes: 60 },
        {},
        Date.now(), DRAIN_START,
      );
      expect(result).toEqual({ allowedKw: 0, hourlyBudgetExhausted: false, remainingKWh: 0 });
    });

    it('allows burst rate mid-hour when under budget', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 7, marginKw: 0.3, periodMinutes: 60 },
        { buckets: { [bucketKey]: 1.5 } },
        Date.now(), DRAIN_START,
      );

      // Soft budget = 6.7 kWh. Remaining = 5.2 kWh over 0.5h => 10.4 kW burst.
      expect(result.allowedKw).toBeCloseTo(10.4, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('paces a heavy Belgian quarter below the sustainable rate', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 5);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 0.75, trackedMs: nowMs - quarterStartMs },
        },
        Date.now(), DRAIN_START,
      );

      // Quarter allowance = 1.25 kWh. 0.5 kWh remains over 10 minutes => 3 kW.
      expect(result.allowedKw).toBeCloseTo(3, 6);
      expect(result.remainingKWh).toBeCloseTo(0.5, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('never lets an under-used Belgian quarter burst above the sustainable rate', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const capacitySettings = { limitKw: 5, marginKw: 0.2, periodMinutes: 15 } as const;
      // 0.2 kWh by :07:30 leaves 1.0 kWh; spending it would mean 8 kW mid-quarter
      // and 60 kW in the final minute. The pace stays at 5 - 0.2 = 4.8 kW.
      for (const [minute, energyKWh] of [[7.5, 0.2], [14, 0.2]] as const) {
        const nowMs = quarterStartMs + minute * 60 * 1000;
        const result = computeDynamicSoftLimit(
          capacitySettings,
          {
            lastTimestamp: nowMs,
            capacityQuarter: { startMs: quarterStartMs, energyKWh, trackedMs: nowMs - quarterStartMs },
          },
          nowMs, DRAIN_START,
        );
        expect(result.allowedKw).toBeCloseTo(4.8, 6);
        expect(result.remainingKWh).toBeCloseTo(1.0, 6);
      }
    });

    it('carries a sparse Flow meter sample through a settings-triggered quarter rebuild', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const lastTimestamp = quarterStartMs + 7 * 60 * 1000;
      const nowMs = quarterStartMs + 10 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        {
          lastTimestamp,
          lastPowerW: 3_000,
          capacityQuarter: {
            startMs: quarterStartMs,
            energyKWh: 0.75,
            trackedMs: lastTimestamp - quarterStartMs,
          },
        },
        Date.now(), DRAIN_START,
      );

      // The held 3 kW sample contributes another 0.15 kWh from :07 to :10.
      // 0.35 kWh remains over five minutes, so the honest pace is 4.2 kW.
      // Dropping the held interval would read 6 kW and cap at 5 kW.
      expect(result.allowedKw).toBeCloseTo(4.2, 6);
      expect(result.remainingKWh).toBeCloseTo(0.35, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('carries a sparse Flow sample across the Belgian quarter boundary', () => {
      const previousQuarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const lastTimestamp = previousQuarterStartMs + 14 * 60 * 1000;
      const nowMs = previousQuarterStartMs + 17 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        {
          lastTimestamp,
          lastPowerW: 9_000,
          capacityQuarter: {
            startMs: previousQuarterStartMs,
            energyKWh: 0.7,
            trackedMs: lastTimestamp - previousQuarterStartMs,
          },
        },
        Date.now(), DRAIN_START,
      );

      // The held 9 kW sample covers :15–:17 in the new quarter: 0.3 kWh used,
      // 0.95 kWh remains across 13 minutes, so the safe pace is about 4.38 kW.
      // Dropping the held interval would read the new quarter as unused (5 kW).
      expect(result.allowedKw).toBeCloseTo(0.95 / (13 / 60), 6);
      expect(result.remainingKWh).toBeCloseTo(0.95, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('keeps an explicit build timestamp after the wall clock crosses a quarter boundary', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const buildNowMs = quarterStartMs + 14 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(quarterStartMs + 15 * 60 * 1000 + 1);
      const powerTracker = {
        lastTimestamp: buildNowMs,
        lastPowerW: 0,
        capacityQuarter: {
          startMs: quarterStartMs,
          energyKWh: 0.5,
          trackedMs: buildNowMs - quarterStartMs,
        },
      };
      const capacitySettings = { limitKw: 5, marginKw: 0, periodMinutes: 15 } as const;

      const pace = computeDynamicSoftLimit(capacitySettings, powerTracker, buildNowMs, DRAIN_START);
      const shortfallThreshold = computeShortfallThreshold(
        capacitySettings,
        powerTracker,
        buildNowMs,
      );

      expect(pace.remainingKWh).toBeCloseTo(0.75, 6);
      expect(shortfallThreshold).toBeCloseTo(45, 6);
    });

    it('marks a Belgian quarter exhausted at the quarter allowance', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 8);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 1.25, trackedMs: nowMs - quarterStartMs },
        },
        Date.now(), DRAIN_START,
      );

      expect(result.allowedKw).toBe(0);
      expect(result.hourlyBudgetExhausted).toBe(true);
    });

    it('fails closed until the first quarter is tracked from its boundary', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const nowMs = quarterStartMs + 10 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 0.2, trackedMs: 5 * 60 * 1000 },
        },
        Date.now(), DRAIN_START,
      );

      expect(result).toEqual({ allowedKw: 0, hourlyBudgetExhausted: false, remainingKWh: 0 });
    });

    it('falls from the draw the drain opened at toward the sustainable rate', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 55, 0); // 5 minutes remaining
      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 0.5 } },
        nowMs,
        DRAIN_START,
      );

      // Remaining 4.5 kWh over 5 minutes would allow 54 kW. The drain allows
      // 5 + 3 × (1 − expm1(5/4) / expm1(10/4)) = 7.33 kW: below the 8 kW the
      // house drew at :50, still above the 5 kW target.
      expect(result.allowedKw).toBeCloseTo(7.3319, 3);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('opens the drain at the house\'s draw, so nothing is limited at :50', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 50, 0); // exactly 10 minutes remaining
      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 0.5 } },
        nowMs,
        DRAIN_START,
      );

      // The old hard cliff clamped this to 5 kW at exactly 10 minutes and shed
      // every device above it at once.
      expect(result.allowedKw).toBeCloseTo(HOUSE_DRAW_KW, 6);
    });

    it('leaves the budget-driven pace alone before the drain window', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 49, 0); // 11 minutes remaining
      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 0.5 } },
        nowMs,
        DRAIN_START,
      );

      expect(result.allowedKw).toBeCloseTo(4.5 / (11 / 60), 6);
    });

    it('crosses the hour boundary at the sustainable rate', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 59, 999); // ~0 minutes remaining
      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 0.5 } }, // budget remaining, burst would be high
        nowMs,
        DRAIN_START,
      );

      // The next hour starts at its 5 kW target, even with budget left in this one.
      expect(result.allowedKw).toBeCloseTo(5, 2);
    });

    it('holds the sustainable rate through the window when the house draws less', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 55, 0);
      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 0.5 } },
        nowMs,
        { drawKw: 3, minutesRemaining: 10 },
      );

      expect(result.allowedKw).toBeCloseTo(5, 6);
    });

    it('cuts least at the start of the window and most near :00', () => {
      const sample = (minute: number): number => {
        const nowMs = Date.UTC(2025, 0, 15, 12, minute, 0);
        return computeDynamicSoftLimit(
          { limitKw: 5, marginKw: 0, periodMinutes: 60 }, // sustainable = 5 kW
          { buckets: { [getHourBucketKey(nowMs)]: 0.5 } }, // remaining budget keeps burst above the drain
          nowMs,
          DRAIN_START,
        ).allowedKw;
      };

      const series = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59].map((m) => sample(m));
      const cuts = series.slice(1).map((pace, index) => series[index] - pace);
      for (let i = 1; i < cuts.length; i += 1) {
        expect(cuts[i]).toBeGreaterThan(cuts[i - 1]);
      }
      expect(series[0]).toBeCloseTo(HOUSE_DRAW_KW, 6);
      expect(series.at(-1)).toBeCloseTo(5.7229, 3); // 1 min: 5 + 3 × (1 − expm1(9/4) / expm1(10/4))
      expect(series.at(-1)).toBeGreaterThan(5);
    });

    it('uses the actual time left when the remaining budget binds below the drain', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 0);
      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 4.95 } },
        nowMs,
        DRAIN_START,
      );

      // 0.05 kWh over the final minute permits 3 kW, below the 5.72 kW drain.
      expect(result.allowedKw).toBeCloseTo(3, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('drains a busy hour from its draw at :50 without going below the sustainable rate', () => {
      const hourStartMs = Date.UTC(2025, 0, 15, 12);
      const bucketKey = getHourBucketKey(hourStartMs);
      const paces: number[] = [];
      let usedKWh = 3.5;
      // An 8 kW demand follows the allowed pace. At :50, 1.3 kWh remains out of
      // the 4.8 kWh allowance, which allows 7.8 kW: what the house draws then.
      const drainStart: DrainStart = { drawKw: 7.8, minutesRemaining: 10 };

      for (let elapsedSeconds = 50 * 60; elapsedSeconds < 60 * 60; elapsedSeconds += 10) {
        const { allowedKw } = computeDynamicSoftLimit(
          { limitKw: 5, marginKw: 0.2, periodMinutes: 60 },
          { buckets: { [bucketKey]: usedKWh } },
          hourStartMs + elapsedSeconds * 1000,
          drainStart,
        );
        paces.push(allowedKw);
        usedKWh += Math.min(8, allowedKw) * (10 / 3600);
      }

      expect(paces[0]).toBeCloseTo(7.8, 6);
      expect(Math.min(...paces)).toBeGreaterThanOrEqual(4.8 - 1e-9);
      expect(paces.at(-1)).toBeLessThan(5.1);
      expect(usedKWh).toBeLessThanOrEqual(4.8);
    });

    it('starts a fresh allowance at the exact hour boundary', () => {
      const nowMs = Date.UTC(2025, 0, 15, 13);
      const previousBucketKey = getHourBucketKey(nowMs - 1);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0.2, periodMinutes: 60 },
        { buckets: { [previousBucketKey]: 4.8 } },
        nowMs, DRAIN_START,
      );

      expect(result).toEqual({ allowedKw: 4.8, hourlyBudgetExhausted: false, remainingKWh: 4.8 });
    });

    it('marks hourly budget exhausted when usage exceeds soft budget', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 20, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit(
        { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        { buckets: { [bucketKey]: 6 } },
        Date.now(), DRAIN_START,
      );

      expect(result.allowedKw).toBe(0);
      expect(result.hourlyBudgetExhausted).toBe(true);
    });
  });

  describe('the drain start', () => {
    const settings = { limitKw: 5, marginKw: 0, periodMinutes: 60 as const };
    const at = (minute: number) => Date.UTC(2025, 0, 15, 12, minute, 0);
    const tracker = (lastPowerW?: number) => ({ buckets: {}, ...(lastPowerW === undefined ? {} : { lastPowerW }) });

    it('keeps the draw and minute of the first measured build in the window for the rest of the hour', () => {
      const start = new CapacityDrainStart();
      start.record(settings, tracker(3000), at(49), 3); // before the window
      start.record(settings, tracker(9000), at(50), 9);
      start.record(settings, tracker(4000), at(55), 4);
      expect(start.startFor(settings, tracker(4000), at(56))).toEqual({ drawKw: 9, minutesRemaining: 10 });
      // The next hour has no start yet: its draw and minute now.
      expect(start.startFor(settings, tracker(4000), Date.UTC(2025, 0, 15, 13, 55)))
        .toEqual({ drawKw: 4, minutesRemaining: 5 });
    });

    it('reads the target until a reading arrives', () => {
      expect(new CapacityDrainStart().startFor(settings, tracker(), at(51)))
        .toEqual({ drawKw: 5, minutesRemaining: 9 });
    });

    it('opens a drain first seen after a restart at the house\'s draw', () => {
      const nowMs = at(57);
      const result = computeDynamicSoftLimit(
        settings, { buckets: { [getHourBucketKey(nowMs)]: 0.5 } }, nowMs, { drawKw: 8, minutesRemaining: 3 },
      );
      expect(result.allowedKw).toBeCloseTo(8, 6);
    });
  });

  describe('resolveCapacityAdmissionHeadroomKw', () => {
    // An hour's 5 kWh allowance is a 5 kW sustainable rate.
    const hour = { capacityPeriodMinutes: 60 as const, budgetKWh: 5 };

    it('lets an increase in the drain spend only the room under the next hour\'s target', () => {
      // Drain pace 7.3 kW, house at 6 kW: 1.3 kW left to shed against, but an
      // increase would run into the next hour, which allows 5 kW.
      expect(resolveCapacityAdmissionHeadroomKw(
        { ...hour, capacitySoftLimit: 7.3, minutesRemaining: 5 }, 1.3,
      )).toBeCloseTo(-1, 6);
      expect(resolveCapacityAdmissionHeadroomKw(
        { ...hour, capacitySoftLimit: 7.3, minutesRemaining: 5 }, 3.3,
      )).toBeCloseTo(1, 6);
    });

    it('leaves headroom as it is before the window, in a quarter, and with Capacity limit off', () => {
      expect(resolveCapacityAdmissionHeadroomKw({ ...hour, capacitySoftLimit: 20, minutesRemaining: 11 }, 4)).toBe(4);
      expect(resolveCapacityAdmissionHeadroomKw(
        { capacityPeriodMinutes: 15, budgetKWh: 1.25, capacitySoftLimit: 5, minutesRemaining: 2 }, 1,
      )).toBe(1);
      expect(resolveCapacityAdmissionHeadroomKw({ ...hour, capacitySoftLimit: null, minutesRemaining: 5 }, null)).toBeNull();
    });

    it('never adds room when the drain pace is already below the target', () => {
      // A nearly spent hour: the remaining budget binds at 3 kW, below 5 kW.
      expect(resolveCapacityAdmissionHeadroomKw({ ...hour, capacitySoftLimit: 3, minutesRemaining: 1 }, 0.5)).toBe(0.5);
    });
  });

  describe('computeDailyUsageSoftLimit', () => {
    it('returns 0 for non-finite or non-positive planned budget', () => {
      expect(computeDailyUsageSoftLimit({
        plannedKWh: Number.NaN,
        usedKWh: 0,
        bucketStartMs: 0,
        bucketEndMs: 3600000,
      }, Date.now())).toBe(0);

      expect(computeDailyUsageSoftLimit({
        plannedKWh: 0,
        usedKWh: 0,
        bucketStartMs: 0,
        bucketEndMs: 3600000,
      }, Date.now())).toBe(0);
    });

    it('returns 0 for invalid bucket window', () => {
      expect(computeDailyUsageSoftLimit({
        plannedKWh: 4,
        usedKWh: 1,
        bucketStartMs: 1000,
        bucketEndMs: 1000,
      }, Date.now())).toBe(0);
    });

    it('clamps now to bucket range and treats non-finite used as 0', () => {
      const bucketStartMs = Date.UTC(2025, 0, 15, 12, 0, 0);
      const bucketEndMs = bucketStartMs + 60 * 60 * 1000;
      const nowBeforeBucket = bucketStartMs - 30 * 60 * 1000;

      const allowed = computeDailyUsageSoftLimit({
        plannedKWh: 4,
        usedKWh: Number.NaN,
        bucketStartMs,
        bucketEndMs,
      }, nowBeforeBucket);

      // now clamps to bucket start (1h remaining), used treated as 0 => 4 kW
      expect(allowed).toBeCloseTo(4, 6);
    });
  });

  describe('computeShortfallThreshold', () => {
    it('returns 0 when hard-cap budget is non-positive', () => {
      const threshold = computeShortfallThreshold(
        { limitKw: 0, marginKw: 0.5, periodMinutes: 60 },
        {},
        Date.now(),
      );
      expect(threshold).toBe(0);
    });

    it('returns 0 when hard-cap budget for the hour is already exhausted', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const threshold = computeShortfallThreshold(
        { limitKw: 5, marginKw: 0.5, periodMinutes: 60 },
        { buckets: { [bucketKey]: 6 } },
        Date.now(),
      );
      expect(threshold).toBe(0);
    });

    it('uses 0.01h minimum remaining time at end of hour', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 59, 999);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const threshold = computeShortfallThreshold(
        { limitKw: 5, marginKw: 2, periodMinutes: 60 },
        { buckets: { [bucketKey]: 0 } },
        Date.now(),
      );

      // remaining = 5kWh, min remaining time = 0.01h => threshold = 500kW
      expect(threshold).toBeCloseTo(500, 6);
    });

    it('uses the current quarter energy for Belgian shortfall detection', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 10);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const threshold = computeShortfallThreshold(
        { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 1, trackedMs: nowMs - quarterStartMs },
        },
        Date.now(),
      );

      // 0.25 kWh remains over five minutes => 3 kW.
      expect(threshold).toBeCloseTo(3, 6);
    });
  });
});
