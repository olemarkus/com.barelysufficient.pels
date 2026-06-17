// Pure data derivations for the Budget-tab chart: cumulative plan/actual
// series, the end-of-day projection, and the pinned-readout content bundles
// (chart-overhaul Phase 3). No ECharts/DOM dependencies — everything here is
// unit-testable against a bare `DailyBudgetDayPayload`.
import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import { resolvePriceUnitLabel } from './priceUnit.ts';
import {
  buildBudgetHourlyReadout,
  buildBudgetProgressReadout,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';

export type BudgetRedesignDayView = 'today' | 'tomorrow' | 'yesterday';

const cumulative = (values: number[]): number[] => {
  let total = 0;
  return values.map((value) => {
    total += Number.isFinite(value) ? value : 0;
    return Number(total.toFixed(3));
  });
};

// A producer cumulative series is only authoritative when it covers every
// bucket with finite values. An absent, empty (`[]` is truthy), short, or
// NaN-bearing array falls back to the local recompute rather than leaking a
// truncated curve or NaN readouts into the chart.
const isFiniteSeriesOfLength = (values: number[] | undefined, length: number): values is number[] => (
  Array.isArray(values)
  && values.length === length
  && values.every((value) => Number.isFinite(value))
);

export const resolveActualUpToIndex = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
) => {
  if (view === 'tomorrow') return -1;
  if (view === 'yesterday') return (payload.buckets.actualKWh || []).length - 1;
  return Math.max(-1, Math.min(payload.currentBucketIndex, (payload.buckets.actualKWh || []).length - 1));
};

const buildActualCumulative = (
  actual: number[],
  actualUpToIndex: number,
): Array<number | null> => {
  let total = 0;
  return actual.map((value, index) => {
    if (index > actualUpToIndex || !Number.isFinite(value)) return null;
    total += value;
    return Number(total.toFixed(3));
  });
};

export const buildProjectionCumulative = (params: {
  planned: number[];
  actualCumulative: Array<number | null>;
  actualUpToIndex: number;
  view: BudgetRedesignDayView;
}): Array<number | null> => {
  const { planned, actualCumulative, actualUpToIndex, view } = params;
  const projection = planned.map(() => null as number | null);
  if (view !== 'today' || actualUpToIndex < 0 || actualUpToIndex >= planned.length) return projection;
  const startValue = actualCumulative[actualUpToIndex];
  if (!Number.isFinite(startValue)) return projection;
  const previousActualTotal = actualUpToIndex > 0 ? actualCumulative[actualUpToIndex - 1] : 0;
  if (!Number.isFinite(previousActualTotal)) return projection;
  const currentActual = Math.max(0, (startValue as number) - (previousActualTotal as number));
  const currentPlanned = Number.isFinite(planned[actualUpToIndex]) ? planned[actualUpToIndex] : 0;
  let total = (startValue as number) + Math.max(0, (currentPlanned as number) - currentActual);
  projection[actualUpToIndex] = Number(total.toFixed(3));
  for (let index = actualUpToIndex + 1; index < planned.length; index += 1) {
    total += Number.isFinite(planned[index]) ? planned[index] : 0;
    projection[index] = Number(total.toFixed(3));
  }
  return projection;
};

export const normalizePriceValues = (
  prices: Array<number | null> | undefined,
  length: number,
  display: CostDisplay,
): number[] => {
  const divisor = Math.max(1, display.divisor);
  return (prices || [])
    .slice(0, length)
    .filter((value): value is number => Number.isFinite(value))
    .map((value) => Number((value / divisor).toFixed(4)));
};

// `startLocalLabels` arrive as `HH:MM` from the runtime producer; normalise
// defensively so a bare-hour label still renders the canonical `13:00` form.
const normalizeHourLabel = (label: string): string => {
  const trimmed = label.trim();
  return trimmed.includes(':') ? trimmed : `${trimmed}:00`;
};

// End-of-bucket label: the next bucket's start, closing the day at `00:00`.
// DST-safe — derived from the actual label array (23/25 buckets), not a
// fixed +1h arithmetic.
const resolveBucketEndLabel = (labels: string[], index: number): string => {
  const next = labels[index + 1];
  return next === undefined ? '00:00' : normalizeHourLabel(next);
};

const resolveBucketHourRange = (labels: string[], index: number): string => (
  `${normalizeHourLabel(labels[index] ?? '')}–${resolveBucketEndLabel(labels, index)}`
);

// Progress rows anchor on each bucket's END boundary ("By 14:00" = the
// cumulative value reached at that boundary). The final boundary reads
// "By midnight" — "By 00:00" misreads as the day's start (the hourly range
// form keeps `23:00–00:00`; see `notes/ui-terminology.md`).
const resolveProgressEndLabel = (labels: string[], index: number): string => (
  index >= labels.length - 1 ? 'midnight' : resolveBucketEndLabel(labels, index)
);

const indexOfMax = (values: number[]): number => {
  let best = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  values.forEach((value, index) => {
    if (Number.isFinite(value) && value > bestValue) {
      bestValue = value;
      best = index;
    }
  });
  return best;
};

// Default readout selection — the row is never empty. Today: the current
// hour. Yesterday/tomorrow: the peak hour of the day's real data (mirrors
// the Usage-tab "current hour on Today, peak point otherwise" grammar).
// Hourly mode uses this for every view; progress mode only for today —
// its non-today views anchor on the end-of-day column instead (the
// cumulative chart's answer is how the day ends, not its peak hour).
export const resolveBudgetDefaultReadoutIndex = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
): number => {
  const labels = payload.buckets.startLocalLabels || [];
  if (labels.length === 0) return 0;
  if (view === 'today') {
    return Math.max(0, Math.min(payload.currentBucketIndex, labels.length - 1));
  }
  const source = view === 'yesterday'
    ? (payload.buckets.actualKWh || [])
    : (payload.buckets.plannedKWh || []);
  return indexOfMax(source);
};

type ProgressSeriesData = {
  labels: string[];
  planCumulative: number[];
  actualCumulative: Array<number | null>;
  projection: Array<number | null>;
};

export const resolveProgressSeriesData = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
): ProgressSeriesData => {
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const actualUpToIndex = resolveActualUpToIndex(payload, view);
  // The single green reference is the producer's STABLE budget-pace curve
  // (PR-A) — dailyBudgetKWh spread by the day-start profile, ending at the cap,
  // and NOT re-paced as the user under/over-spends. Fall back to the legacy plan
  // cumulative only if the producer field is absent.
  const planCumulative = isFiniteSeriesOfLength(payload.buckets.budgetPaceCumKWh, labels.length)
    ? payload.buckets.budgetPaceCumKWh
    : cumulative(planned);
  const actualCumulative = buildActualCumulative(actual, actualUpToIndex);
  // Projection comes from the producer (one source of truth, shared with the
  // hero verdict and the widget), rendered dashed from "now" forward. Only the
  // today view has a forward projection. Fall back to the local recompute if the
  // producer field is absent.
  const producerProjection = payload.buckets.projectionCumKWh;
  let projection: Array<number | null>;
  if (view !== 'today' || actualUpToIndex < 0) {
    // No forward projection off the today view, and none before the first
    // actual lands — otherwise the producer's cold-start projection (~0 with no
    // usage to extrapolate from) would draw a premature dashed line from midnight.
    projection = labels.map((): number | null => null);
  } else if (isFiniteSeriesOfLength(producerProjection, labels.length)) {
    projection = producerProjection.map((value, index): number | null => (index < actualUpToIndex ? null : value));
  } else {
    projection = buildProjectionCumulative({ planned, actualCumulative, actualUpToIndex, view });
  }
  return { labels, planCumulative, actualCumulative, projection };
};

export type BudgetReadoutBundle = {
  readouts: ChartReadoutContent[];
  defaultIndex: number;
  // Native select targets per mode: the bar series carrying the on-surface
  // select border in hourly mode; empty in progress mode (lines have no
  // visible select state — the marker series carries the identity).
  selectSeriesIndexes: number[];
  // Progress-mode marker y-values; null in hourly mode.
  markerValues: Array<number | null> | null;
};

// Progress mode content: `By 14:00` / `Budget 8.4 kWh · Actual 7.9 kWh` +
// `Projection 8.6 kWh` when the projection covers the hour; the end-of-day
// column reads `By midnight`. Exported for the exact-string content-resolver
// suites.
export const buildBudgetProgressReadoutBundle = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
): BudgetReadoutBundle => {
  const { labels, planCumulative, actualCumulative, projection } = resolveProgressSeriesData(payload, view);
  const readouts = labels.map((_label, index) => buildBudgetProgressReadout({
    endLabel: resolveProgressEndLabel(labels, index),
    budgetKWh: planCumulative[index] ?? 0,
    actualKWh: actualCumulative[index] ?? null,
    projectionKWh: projection[index] ?? null,
  }));
  const markerValues = labels.map((_label, index) => (
    actualCumulative[index] ?? projection[index] ?? planCumulative[index] ?? null
  ));
  return {
    readouts,
    // Today follows the current hour; yesterday/tomorrow anchor on the
    // end-of-day column — the cumulative chart's answer for a finished (or
    // fully planned) day is its total, not its peak hour.
    defaultIndex: view === 'today'
      ? resolveBudgetDefaultReadoutIndex(payload, view)
      : Math.max(0, labels.length - 1),
    selectSeriesIndexes: [],
    markerValues,
  };
};

// Hourly mode content: `13:00–14:00` / `Budget 0.92 kWh (Managed 0.51 ·
// Background 0.41)` + `Price 0.84 kr/kWh` + `Actual 0.71 kWh`. Exported for
// the exact-string content-resolver suites.
export const buildBudgetHourlyReadoutBundle = (params: {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  priceReliable: boolean;
  costDisplay: CostDisplay;
}): BudgetReadoutBundle => {
  const { payload, view, priceReliable, costDisplay } = params;
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const actualUpToIndex = resolveActualUpToIndex(payload, view);
  const plannedBackground = payload.buckets.plannedUncontrolledKWh || [];
  const plannedManaged = payload.buckets.plannedControlledKWh || [];
  const hasSplit = plannedBackground.length === labels.length
    && plannedManaged.length === labels.length;
  const priceValues = priceReliable
    ? normalizePriceValues(payload.buckets.price, labels.length, costDisplay)
    : [];
  const hasPrice = priceValues.length === labels.length;
  const priceUnit = costDisplay.unit.trim() ? resolvePriceUnitLabel(costDisplay) : null;
  const readouts = labels.map((_label, index) => buildBudgetHourlyReadout({
    hourRange: resolveBucketHourRange(labels, index),
    budgetKWh: Number.isFinite(planned[index]) ? planned[index] : 0,
    managedKWh: hasSplit ? plannedManaged[index] : null,
    backgroundKWh: hasSplit ? plannedBackground[index] : null,
    price: hasPrice ? { value: priceValues[index], unitLabel: priceUnit } : null,
    actualKWh: index <= actualUpToIndex && Number.isFinite(actual[index]) ? actual[index] : null,
  }));
  return {
    readouts,
    defaultIndex: resolveBudgetDefaultReadoutIndex(payload, view),
    selectSeriesIndexes: hasSplit ? [0, 1] : [0],
    markerValues: null,
  };
};
