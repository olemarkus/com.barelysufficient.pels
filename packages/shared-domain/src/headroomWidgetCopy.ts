// User-facing copy for the "Available power" (headroom) dashboard widget.
//
// Lives in shared-domain so the widget render and any runtime logging speak the
// same words for the same signal (per `feedback_ui_text_shared_with_logs`).
// Import this module DIRECTLY — there is no shared-domain barrel, and sibling
// widget chips touch shared-domain, so a barrel would couple unrelated work.
//
// Vocabulary follows `notes/ui-terminology.md` § "Hero bar vocabulary":
//   - left number  = "Power now"      (current instantaneous draw)
//   - right number = "Safe pace now"  (dynamic kW threshold PELS reacts at)
//   - the fixed ceiling is "Hard cap" — a DIFFERENT value, never shown as the
//     right-hand number here.

export type HeadroomWidgetPriceCopyLevel = 'cheap' | 'normal' | 'expensive' | 'unknown';

/** At-limit state of the power bar — drives the state label and bar/text tone. */
export type HeadroomWidgetLimitState =
  /** Below the safe pace — normal headroom. */
  | 'under'
  /** Approaching the safe pace (warn band). */
  | 'near'
  /** At/over the safe pace but still under the hard cap — managed pacing. */
  | 'at_pace'
  /** Over the configured hard cap — genuine exceedance. */
  | 'over_cap';

export const HEADROOM_WIDGET_COPY = {
  /** Eyebrow/caption for the left number. */
  powerNowLabel: 'Power now',
  /**
   * Eyebrow/caption for the right number — the dynamic this-hour threshold.
   * Canonical term carries "now" (notes/ui-terminology.md) to disambiguate the
   * dynamic safe pace from the static "Hard cap"; reads parallel with "Power now".
   */
  safePaceLabel: 'Safe pace now',
  /** Screen-reader prefix for the price chip in the aria-label ("Price Cheap"). */
  priceAriaPrefix: 'Price',
  /** Shown when there is no status to render yet. */
  noDataSubtitle: 'No data yet',
  /** Shown when the widget API call fails. */
  loadErrorSubtitle: 'Unable to load',
} as const;

// Display casing lives in the copy, not in CSS: the chip is rendered verbatim
// (no `text-transform`), so the runtime log path and the widget read the exact
// same words. Title case so the chip reads "Cheap" / "Expensive".
const PRICE_CHIP_LABELS: Record<HeadroomWidgetPriceCopyLevel, string> = {
  cheap: 'Cheap',
  normal: 'Normal',
  expensive: 'Expensive',
  unknown: '—',
};

const LIMIT_STATE_LABELS: Record<HeadroomWidgetLimitState, string> = {
  under: '',
  near: '',
  at_pace: 'At safe pace',
  over_cap: 'Over hard cap',
};

/** Chip text for a price level (`cheap` / `normal` / `expensive`). */
export const headroomPriceChipLabel = (level: HeadroomWidgetPriceCopyLevel): string => (
  PRICE_CHIP_LABELS[level]
);

/**
 * Short state label for the at-limit row. Empty string when there is nothing
 * exceptional to say (`under` / `near`), so callers can hide the element.
 */
export const headroomLimitStateLabel = (state: HeadroomWidgetLimitState): string => (
  LIMIT_STATE_LABELS[state]
);

/** "N kW available" — the available-power headline fragment. */
export const headroomAvailableLabel = (availableKwText: string): string => (
  `${availableKwText} kW available`
);

/** "1 paused" / "N paused" — count of devices PELS is currently holding back. */
export const headroomPausedLabel = (shedCount: number): string => (
  shedCount === 1 ? '1 paused' : `${shedCount} paused`
);
