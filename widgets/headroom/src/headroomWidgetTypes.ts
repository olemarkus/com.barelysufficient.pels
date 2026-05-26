export type HeadroomWidgetPriceLevel = 'cheap' | 'normal' | 'expensive' | 'unknown';

export type HeadroomWidgetReadyPayload = {
  state: 'ready';
  currentKw: number;
  hourBudgetKw: number;
  headroomKw: number;
  shedCount: number;
  priceLevel: HeadroomWidgetPriceLevel;
  stale: boolean;
};

export type HeadroomWidgetEmptyPayload = {
  state: 'empty';
  subtitle: string;
};

export type HeadroomWidgetPayload = HeadroomWidgetReadyPayload | HeadroomWidgetEmptyPayload;
