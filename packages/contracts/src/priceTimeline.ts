/** A price level as the price service resolved it. */
export type PriceTimelineLevel = 'cheap' | 'normal' | 'expensive';

/**
 * One published price period with the level PELS gave it: an hour, or a
 * quarter-hour on a source that publishes 15-minute prices. Prices are in the
 * source's own unit (`PriceTimeline.priceUnit`).
 */
export type PriceTimelinePeriod = {
  startsAt: string;
  durationMinutes: number;
  /** The import price the owner is billed on; the level classifies this. */
  importPrice: number;
  /** The export (feed-in) price for this period, when one is set up. Signed. */
  exportPrice?: number;
  level: PriceTimelineLevel;
};

/**
 * The lines the owner's band draws over the series, after the minimum
 * difference is applied: at or below `cheapAtOrBelow` is cheap, at or above
 * `expensiveFrom` is expensive. The two only meet on a degenerate series (an
 * average of zero with no minimum difference), and then cheap wins, as it does
 * in the classifier.
 */
export type PriceTimelineLines = {
  average: number;
  cheapAtOrBelow: number;
  expensiveFrom: number;
};

export type PriceTimeline = {
  /** Every period the level is computed over, in time order. */
  periods: PriceTimelinePeriod[];
  lines: PriceTimelineLines;
  priceUnit: string;
  /** Whether any period carries an export price. */
  hasExportPrice: boolean;
};

/**
 * The price series with its levels, for the price widget. `unavailable` says
 * why: the source has delivered no prices (`no_prices`), or building the series
 * failed this time (`read_failed`, a transient settings read; the next poll
 * retries).
 */
export type PriceTimelineRead =
  | ({ state: 'ready' } & PriceTimeline)
  | { state: 'unavailable'; reason: 'no_prices' | 'read_failed' };
