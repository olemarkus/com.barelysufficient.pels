import type {
  HeadroomWidgetLimitState,
  HeadroomWidgetPriceCopyLevel,
} from '../../../packages/shared-domain/src/headroomWidgetCopy';

export type HeadroomWidgetPriceLevel = HeadroomWidgetPriceCopyLevel;

export type HeadroomWidgetReadyPayload = {
  state: 'ready';
  /** Power now (current instantaneous draw), kW. */
  currentKw: number;
  /** Safe pace now (dynamic hourly threshold), kW. */
  hourBudgetKw: number;
  headroomKw: number;
  /**
   * How far current draw is over the physical hard cap, kW (>= 0; 0 when not
   * over cap). Derived from the builder's `hardCapHeadroomKw < 0` magnitude so
   * the renderer never re-derives the overage from raw kW comparisons
   * (layering: resolution belongs in producer).
   */
  overageKw: number;
  shedCount: number;
  priceLevel: HeadroomWidgetPriceLevel;
  /**
   * At-limit state, resolved by the payload producer so the renderer never
   * branches on raw kW comparisons (layering: resolution belongs in producer).
   */
  limitState: HeadroomWidgetLimitState;
  stale: boolean;
};

export type HeadroomWidgetEmptyPayload = {
  state: 'empty';
  subtitle: string;
};

export type HeadroomWidgetPayload = HeadroomWidgetReadyPayload | HeadroomWidgetEmptyPayload;
