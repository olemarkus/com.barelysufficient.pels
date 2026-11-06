import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import type { PowerTrackerState } from './trackerTypes';
import { resolveAttributionSplit } from '../../packages/shared-domain/src/dailyBudget/attributionSplit';
import {
  buildLocalDayBuckets,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../../packages/shared-domain/src/utils/dateUtils';

/** A measured energy split, in kWh. Control authority and exemption are independent axes. */
type EnergySplit = { controlled: number; background: number };

/**
 * Power-owned accounting for one UTC hour. Actual attribution is gross appliance
 * consumption. `learned` splits the whole metered energy by control authority:
 * power-limited (managed) devices and background, summing to `meteredKwh`.
 * Budget exemption does not move energy between them; budget learning and the
 * observed statistics read this split, with `learnedGross` for the background
 * reserve's gross-demand model. `counted` is the NET budget axis, with exempt
 * energy removed. `measurement` and `attribution` describe the historical
 * evidence, not device state.
 */
export type EnergyBucket = {
  measurement: 'recorded' | 'unrecorded';
  attribution: 'controlled' | 'background' | 'meter';
  meteredKwh: number;
  exemptKwh: number;
  budgetCountedKwh: number;
  actual: EnergySplit;
  learned: EnergySplit;
  learnedGross: EnergySplit;
  counted: EnergySplit;
};

type EnergyWindow = {
  bucketKeys: string[];
  bucketUsage: number[];
  bucketUsageControlled: Array<number | null>;
  bucketUsageUncontrolled: Array<number | null>;
  bucketUsageExempt?: number[];
  budgetControlBucketUsage: number[];
  budgetControlUsedNowKWh: number;
  meteredUsedNowKWh: number;
  exemptUsedNowKWh: number;
  usedNowKWh: number;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonNegative = (value: unknown): number => (finite(value) ? Math.max(0, value) : 0);
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * Read service over one immutable tracker snapshot. This is the only runtime
 * reader which combines the persisted attribution families. A missing meter
 * bucket has no booked usage, but cannot qualify a day as completely measured.
 * Legacy exemptions were managed-only: absent uncontrolledExempt is exactly zero
 * recorded background exemption, never a reconstruction of unrecorded device draw.
 */
export class EnergyAccounting {
  constructor(private readonly tracker: PowerTrackerState) {}

  bucket(key: string): EnergyBucket {
    const total = this.tracker.buckets?.[key];
    const controlled = this.tracker.controlledBuckets?.[key];
    const background = this.tracker.uncontrolledBuckets?.[key];
    const meteredKwh = nonNegative(total);
    const exemptGross = nonNegative(this.tracker.exemptBuckets?.[key]);
    const backgroundExempt = Math.min(exemptGross, nonNegative(this.tracker.uncontrolledExemptBuckets?.[key]));
    const managedExempt = exemptGross - backgroundExempt;
    const exemptKwh = Math.min(meteredKwh, exemptGross);
    const budgetCountedKwh = meteredKwh - exemptKwh;
    const split = resolveHourlyUsageSplit(total, controlled, background);
    const actual = { controlled: split.controlledKWh ?? 0, background: split.uncontrolledKWh ?? meteredKwh };
    const countedGross = {
      controlled: Math.max(0, actual.controlled - managedExempt),
      background: Math.max(0, actual.background - backgroundExempt),
    };
    const attribution = resolveAttributionSource(controlled, background);
    return {
      measurement: finite(total) ? 'recorded' : 'unrecorded',
      attribution,
      meteredKwh,
      exemptKwh,
      budgetCountedKwh,
      actual,
      learned: resolveNetSplit(attribution, actual, meteredKwh),
      learnedGross: attribution === 'meter' ? { controlled: 0, background: meteredKwh } : actual,
      counted: resolveNetSplit(attribution, countedGross, budgetCountedKwh),
    };
  }

  hourUsage(key: string): HourUsage {
    return resolveHourlyUsageSplit(
      this.tracker.buckets?.[key], this.tracker.controlledBuckets?.[key], this.tracker.uncontrolledBuckets?.[key],
    );
  }

  window(bucketStartUtcMs: readonly number[]): EnergyWindow {
    const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
    const buckets = bucketKeys.map((key) => this.bucket(key));
    const bucketUsage = buckets.map((bucket) => bucket.meteredKwh);
    const exempt = buckets.map((bucket) => bucket.exemptKwh);
    const budgetControlBucketUsage = buckets.map((bucket) => bucket.budgetCountedKwh);
    const meteredUsedNowKWh = sum(bucketUsage);
    return {
      bucketKeys,
      bucketUsage,
      bucketUsageControlled: buckets.map((bucket) => (
        bucket.attribution === 'meter' ? null : bucket.actual.controlled
      )),
      bucketUsageUncontrolled: buckets.map((bucket) => (
        bucket.attribution === 'meter' ? null : bucket.actual.background
      )),
      bucketUsageExempt: exempt.some((value) => value > 0) ? exempt : undefined,
      budgetControlBucketUsage,
      budgetControlUsedNowKWh: sum(budgetControlBucketUsage),
      meteredUsedNowKWh,
      exemptUsedNowKWh: sum(exempt),
      usedNowKWh: meteredUsedNowKWh,
    };
  }

  /** A complete local day, including the 23/25-hour DST days; gaps are not zero usage. */
  budgetCountedDay(dateKey: string, timeZone: string): number | undefined {
    const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
    const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
    const { bucketStartUtcMs } = buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone });
    const buckets = bucketStartUtcMs.map((ts) => this.bucket(new Date(ts).toISOString()));
    if (buckets.length === 0 || buckets.some((bucket) => bucket.measurement === 'unrecorded')) return undefined;
    return sum(buckets.map((bucket) => bucket.budgetCountedKwh));
  }
}

export const resolveBudgetCountedDayKwh = (
  tracker: PowerTrackerState,
  dateKey: string,
  timeZone: string,
): number | undefined => new EnergyAccounting(tracker).budgetCountedDay(dateKey, timeZone);

type HourUsage = { totalKWh?: number; controlledKWh?: number; uncontrolledKWh?: number };

export function resolveHourlyUsageSplit(
  totalRaw: unknown,
  controlledRaw: unknown,
  uncontrolledRaw: unknown,
): HourUsage {
  const hasTotal = isFiniteNumber(totalRaw);
  const hasControlled = isFiniteNumber(controlledRaw);
  const hasUncontrolled = isFiniteNumber(uncontrolledRaw);

  if (hasTotal) {
    const totalKWh = Math.max(0, totalRaw);
    // plan.meta DISPLAY split (hourControlledKWh/hourUncontrolledKWh) via the shared
    // gross-preferring resolver, consistent with the Power view and daily-budget view.
    const { controlled, uncontrolled } = resolveAttributionSplit({
      totalNet: totalKWh,
      controlledGross: hasControlled ? controlledRaw : undefined,
      uncontrolledGross: hasUncontrolled ? uncontrolledRaw : undefined,
    });
    return {
      totalKWh,
      controlledKWh: controlled ?? undefined,
      uncontrolledKWh: uncontrolled ?? undefined,
    };
  }

  if (hasControlled || hasUncontrolled) {
    return {
      controlledKWh: hasControlled ? Math.max(0, controlledRaw) : undefined,
      uncontrolledKWh: hasUncontrolled ? Math.max(0, uncontrolledRaw) : undefined,
    };
  }

  return {};
}


const resolveAttributionSource = (controlled: unknown, background: unknown): EnergyBucket['attribution'] => {
  if (finite(controlled)) return 'controlled';
  return finite(background) ? 'background' : 'meter';
};

const resolveNetSplit = (
  attribution: EnergyBucket['attribution'],
  gross: EnergySplit,
  netKwh: number,
): EnergySplit => {
  // Net allocation keeps the established managed-first attribution under PV.
  // With only background evidence, resolve that side first instead.
  if (attribution === 'controlled') {
    const controlled = Math.min(netKwh, gross.controlled);
    return { controlled, background: netKwh - controlled };
  }
  const background = attribution === 'background'
    ? Math.min(netKwh, gross.background) : netKwh;
  return { controlled: netKwh - background, background };
};
