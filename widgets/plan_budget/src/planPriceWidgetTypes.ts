import type { PlanPriceSummaryTone } from '../../../packages/shared-domain/src/planPriceWidgetCopy';

export type WidgetTarget = 'today' | 'tomorrow';

export type PlanPriceWidgetEmptyPayload = {
  state: 'empty';
  target: WidgetTarget;
  title: string;
  subtitle: string;
};

export type PlanPriceWidgetReadyPayload = {
  state: 'ready';
  target: WidgetTarget;
  dateKey: string;
  bucketLabels: string[];
  plannedKwh: number[];
  actualKwh: Array<number | null>;
  showActual: boolean;
  priceSeries: Array<number | null>;
  hasPriceData: boolean;
  currentIndex: number;
  showNow: boolean;
  labelEvery: number;
  maxPlan: number;
  priceMin: number;
  priceMax: number;
  // Per-kWh price-rate label for the right y-axis (e.g. `øre/kWh`). Empty when
  // no usable unit is known. Resolved by the producer from the price store.
  priceAxisUnit: string;
  // Projected day totals, resolved by the producer so the renderer never does
  // unit/currency math. `projectedCost` is null when no usable cost unit
  // exists (Flow/Homey placeholder); `costUnit` is then empty.
  projectedKwh: number;
  projectedCost: number | null;
  costUnit: string;
  // On-track / over-budget tone for the summary line. Null for tomorrow (no
  // measured budget comparison yet).
  summaryTone: PlanPriceSummaryTone | null;
};

export type PlanPriceWidgetPayload = PlanPriceWidgetEmptyPayload | PlanPriceWidgetReadyPayload;
