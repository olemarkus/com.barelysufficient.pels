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
//
// The price chip reuses the canonical "Price low" / "Price high" pair from
// `priceLevelChips.ts` (notes/ui-terminology.md § "Headroom-widget chips") so
// the widget, the settings UI, and runtime logging speak the same words for the
// same signal.

import { resolvePriceLevelChip } from './priceLevelChips';

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
  /** Shown when there is no status to render yet. */
  noDataSubtitle: 'No data yet',
  /** Shown when the widget API call fails. */
  loadErrorSubtitle: 'Unable to load',
} as const;

// The chip is rendered verbatim (no CSS `text-transform`), so the runtime log
// path and the widget read the exact same words. Only `cheap` / `expensive` are
// ever shown (see `SHOW_PRICE_CHIP_FOR` in the renderer); the widget HIDES the
// chip for both `normal` and `unknown`. The empty string (`normal`) and the
// placeholder dash (`unknown`) below are only the helper's return values for
// log/aria callers — the widget never paints them.
const PLACEHOLDER_LABEL = '—';

const LIMIT_STATE_LABELS: Record<HeadroomWidgetLimitState, string> = {
  under: '',
  near: '',
  at_pace: 'At safe pace',
  over_cap: 'Over hard cap',
};

/**
 * Chip text for a price level. Reuses the canonical `priceLevelChips.ts` pair
 * so `cheap` → "Price low" and `expensive` → "Price high"; `normal` returns the
 * empty string (no chip) and `unknown` the placeholder dash.
 */
export const headroomPriceChipLabel = (level: HeadroomWidgetPriceCopyLevel): string => {
  if (level === 'unknown') return PLACEHOLDER_LABEL;
  return resolvePriceLevelChip(level)?.label ?? '';
};

/**
 * Grammatical screen-reader phrasing for the price chip, e.g. "Price: low".
 * Derives the bare level word from the canonical chip label so the aria text
 * can never regress to the broken "Price Price low" / "Price Cheap" forms.
 * Returns the empty string when there is no chip to announce.
 */
export const headroomPriceAriaLabel = (level: HeadroomWidgetPriceCopyLevel): string => {
  const chip = level === 'unknown' ? null : resolvePriceLevelChip(level);
  if (!chip) return '';
  // Canonical labels are "Price low" / "Price high" — the trailing word is the
  // already-lowercase human level. Strip the leading "Price " prefix and reuse
  // the remainder verbatim as the grammatical "Price: <level>" phrase.
  const levelWord = chip.label.replace(/^Price\s+/u, '');
  return `Price: ${levelWord}`;
};

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

/**
 * "1 held back" / "N held back" — count of devices PELS is currently holding
 * back. Uses "held back" to match the dedicated Held-back-devices widget
 * (notes/ui-terminology.md § "Headroom-widget chips").
 */
export const headroomHeldBackLabel = (shedCount: number): string => (
  shedCount === 1 ? '1 held back' : `${shedCount} held back`
);

/**
 * "X kW over hard cap" — how far the current draw exceeds the physical hard
 * cap, the severity signal for the `over_cap` state. States the overage
 * factually; the hard cap is physical (notes/ui-terminology.md § "Hard cap is
 * physical"), so the copy never invites raising it. The caller passes the
 * already-formatted kW magnitude so the widget owns its kW number formatting.
 */
export const headroomOverCapLabel = (overageKwText: string): string => (
  `${overageKwText} kW over hard cap`
);
