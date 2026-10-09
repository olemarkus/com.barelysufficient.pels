/**
 * What the daily budget has observed of each local hour of the day over the
 * trailing window, as one domain object. `buildObservedHourlyStatsFromWindow`
 * (`dailyBudgetObservedStats.ts`) produces it; each series holds 24 values
 * indexed by local hour. The peaks cap a planned hour, the minimums and the net
 * (uncontrolled) quantiles floor it, and the gross quantiles plan the always-on
 * background.
 *
 * `DailyBudgetState` holds it flat under these same names, one persisted field
 * per series, and a stored state may lack a series (an older install, or a row
 * the store quarantined). {@link resolveObservedHourlyStats} is the boundary
 * that turns what the state holds into a complete object; everything past it
 * takes {@link ObservedHourlyStats} whole.
 */

/**
 * The series by the group the learner backfills together. The field list and
 * the type are derived from these groups, so a new series cannot be added
 * without a group, and so without a backfill.
 */
export const OBSERVED_HOURLY_STATS_GROUPS = {
  max: ['profileObservedMaxUncontrolledKWh', 'profileObservedMaxControlledKWh'],
  min: ['profileObservedMinUncontrolledKWh', 'profileObservedMinControlledKWh'],
  netReserve: [
    'profileObservedP50UncontrolledKWh',
    'profileObservedP75UncontrolledKWh',
    'profileObservedP90UncontrolledKWh',
    'profileObservedUncontrolledSampleCounts',
  ],
  grossReserve: [
    'profileObservedP50GrossUncontrolledKWh',
    'profileObservedP75GrossUncontrolledKWh',
    'profileObservedP90GrossUncontrolledKWh',
    'profileObservedGrossUncontrolledSampleCounts',
  ],
} as const;

/** Every series, in the order the producer builds them. */
export const OBSERVED_HOURLY_STATS_FIELDS = [
  ...OBSERVED_HOURLY_STATS_GROUPS.max,
  ...OBSERVED_HOURLY_STATS_GROUPS.min,
  ...OBSERVED_HOURLY_STATS_GROUPS.netReserve,
  ...OBSERVED_HOURLY_STATS_GROUPS.grossReserve,
] as const;

export type ObservedSeriesField = (typeof OBSERVED_HOURLY_STATS_FIELDS)[number];

export type ObservedHourlyStats = Record<ObservedSeriesField, number[]>;

/**
 * The one way to build a complete {@link ObservedHourlyStats} from a rule per
 * series. The assertion is sound because the type is derived from the very
 * list mapped here, so every field is present.
 */
const buildObservedHourlyStats = (
  seriesFor: (field: ObservedSeriesField) => number[],
): ObservedHourlyStats => Object.fromEntries(
  OBSERVED_HOURLY_STATS_FIELDS.map((field) => [field, seriesFor(field)]),
) as ObservedHourlyStats;

const emptyHourly = (): number[] => Array.from({ length: 24 }, () => 0);

/** Nothing observed yet: 24 zeros in every series, each its own array. */
export const emptyObservedHourlyStats = (): ObservedHourlyStats => buildObservedHourlyStats(emptyHourly);

const isValidObservedHourlySeries = (values: number[] | undefined): values is number[] => (
  Array.isArray(values)
  && values.length === 24
  && values.every((value) => typeof value === 'number' && Number.isFinite(value))
);

/**
 * The series a stored state holds, each kept as is (the same array) when it is
 * a valid 24-hour series and 24 zeros where it is missing or malformed. Zeros
 * read as "no observation" everywhere downstream: no cap, no floor, no samples.
 */
export const resolveObservedHourlyStats = (held: Partial<ObservedHourlyStats>): ObservedHourlyStats => (
  buildObservedHourlyStats((field) => {
    const series = held[field];
    return isValidObservedHourlySeries(series) ? series : emptyHourly();
  })
);
