// Canonical user-facing copy + price/cost resolution for the "Budget and Price"
// dashboard widget (widgets/plan_budget). Lives in shared-domain so the widget
// payload builder (which runs in the app process) and the browser renderer use
// one source of truth, and so runtime log breadcrumbs can quote identical
// wording (per feedback_ui_text_shared_with_logs.md).
//
// Imported DIRECTLY by file path (no barrel/index), so sibling chips touching
// shared-domain don't collide on an index edit.

// --- Static copy --------------------------------------------------------

export const PLAN_PRICE_WIDGET_TITLE = 'Budget and Price';

// Legend labels. `Used` reads more plainly than `Actual` for measured
// consumption, and `Budget` is clearer than `Plan` for the planned-kWh bars
// (the bars are the daily-budget allocation, not the planning-layer "plan" —
// see feedback_terminology_plan_vs_deadline). `Price` is unchanged.
export const PLAN_PRICE_WIDGET_LEGEND = {
  planned: 'Budget',
  used: 'Used',
  price: 'Price',
} as const;

export const PLAN_PRICE_WIDGET_AXIS = {
  // Left axis: planned/used energy is always kWh.
  energy: 'kWh',
} as const;

// Empty / error sublines. These describe the daily-BUDGET feature, so they say
// "budget" rather than "plan" (the bars are the daily-budget allocation, not the
// planning-layer "plan" — see feedback_terminology_plan_vs_deadline).
export const PLAN_PRICE_WIDGET_EMPTY = {
  budgetDisabled: 'Daily budget disabled',
  noData: 'No budget data available',
  tomorrowPending: "Tomorrow's budget not available yet",
  loadError: 'Unable to load widget',
} as const;

// Chart SVG aria-labels (screen-reader description of the chart region). Kept
// here alongside the other widget copy so runtime/renderer share one source.
export const PLAN_PRICE_WIDGET_ARIA = {
  unavailable: 'Budget and price chart unavailable',
  tomorrow: 'Budget and price chart for tomorrow',
  today: 'Budget and price chart for today',
} as const;

export const PLAN_PRICE_WIDGET_PRICE_MISSING = 'Price data missing';

// AM/PM segmented-control labels. The day splits at noon: 00–12 / 12–24.
export const PLAN_PRICE_WIDGET_TABS = {
  morning: '00–12',
  afternoon: '12–24',
} as const;

export type PlanPriceWidgetHalf = 'morning' | 'afternoon';

// --- Price-unit + cost resolution --------------------------------------

// `Σ price × kWh` lands in the price-RATE money unit (øre for the Norwegian
// Nordpool scheme). Totals are shown in the larger display currency (kr), so
// the øre product is divided by 100. Flow/Homey schemes carry their own unit
// and are already amount-shaped (divisor 1).
export type PlanPriceCostDisplay = {
  // Money unit for a TOTAL cost figure, e.g. `kr`. Empty when the active
  // scheme provides no usable unit (Flow/Homey with a placeholder unit) — the
  // caller suppresses the cost half rather than inventing one.
  costUnit: string;
  // Divisor mapping the raw `Σ price × kWh` product into `costUnit`.
  costDivisor: number;
  // Per-kWh RATE label for the right y-axis, e.g. `øre/kWh`. Empty when no
  // usable unit is known.
  priceAxisUnit: string;
};

const ORE_PER_KWH_LABEL = 'øre/kWh';
const PLACEHOLDER_UNIT = 'price units';

// A unit is already rate-shaped if it ends in a `/kWh` suffix, tolerating
// surrounding whitespace (`kr/kWh`, `NOK / kWh`). Shared by the axis-normalizer
// and the total-stripper so they agree on what "rate-shaped" means.
const KWH_RATE_SUFFIX = /\s*\/\s*kwh\s*$/i;

const normalizeUnitWithKwh = (unit: string): string => (
  KWH_RATE_SUFFIX.test(unit) ? unit : `${unit}/kWh`
);

// Inverse of `normalizeUnitWithKwh`, for the TOTAL cost figure: a total is an
// amount, not a rate, so a rate-shaped source unit like `kr/kWh` must drop its
// trailing `/kWh` to read `kr` (otherwise the projected total renders as e.g.
// `12.3 kr/kWh`). Leaves an already amount-shaped unit (`kr`) untouched.
const stripKwhRateSuffix = (unit: string): string => (
  unit.replace(KWH_RATE_SUFFIX, '').trim()
);

/**
 * Resolve the cost/axis units for the widget from the persisted price store
 * fields. Mirrors the settings-UI `resolveCostDisplayFromCombinedPrices` /
 * `resolveRawPriceUnitLabel` pair, but lives in shared-domain so the widget
 * (which must not import settings-ui) can reuse it. Kept in sync deliberately;
 * consolidation across the arch boundary is not allowed.
 */
export const resolvePlanPriceCostDisplay = (params: {
  priceScheme?: string;
  priceUnit?: string;
}): PlanPriceCostDisplay => {
  const { priceScheme, priceUnit } = params;
  if (priceScheme === 'flow' || priceScheme === 'homey') {
    const hasUnit = typeof priceUnit === 'string'
      && priceUnit.trim() !== ''
      && priceUnit !== PLACEHOLDER_UNIT;
    const unit = hasUnit ? priceUnit.trim() : '';
    return {
      // Strip a rate suffix so a total reads `kr`, not `kr/kWh`; the axis keeps
      // the per-kWh rate shape.
      costUnit: unit ? stripKwhRateSuffix(unit) : '',
      costDivisor: 1,
      priceAxisUnit: unit ? normalizeUnitWithKwh(unit) : '',
    };
  }
  // Default Norwegian Nordpool scheme: raw prices are øre/kWh, totals in kr.
  return {
    costUnit: 'kr',
    costDivisor: 100,
    priceAxisUnit: ORE_PER_KWH_LABEL,
  };
};

// --- Projected summary line --------------------------------------------

export type PlanPriceSummaryTone = 'on_track' | 'over';

const formatKwh = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(1)} ${PLAN_PRICE_WIDGET_AXIS.energy}`;
};

/**
 * Build the projected-summary line shown above the chart, e.g.
 * `Projected 12.4 kWh · 9.80 kr · On track`. The cost half is dropped when no
 * usable cost unit is known (Flow/Homey placeholder). The tone word is dropped
 * when `tone` is null (e.g. tomorrow, where there's no budget comparison yet).
 */
export const formatPlanPriceSummary = (params: {
  projectedKwh: number;
  projectedCost: number | null;
  costUnit: string;
  tone: PlanPriceSummaryTone | null;
}): string => {
  const parts: string[] = [`Projected ${formatKwh(Math.max(0, params.projectedKwh))}`];

  const unit = params.costUnit.trim();
  if (unit && params.projectedCost !== null && Number.isFinite(params.projectedCost)) {
    parts.push(`${params.projectedCost.toFixed(2)} ${unit}`);
  }

  if (params.tone === 'on_track') {
    parts.push('On track');
  } else if (params.tone === 'over') {
    parts.push('Over budget');
  }

  return parts.join(' · ');
};
