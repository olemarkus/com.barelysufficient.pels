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
};

export type PlanPriceWidgetPayload = PlanPriceWidgetEmptyPayload | PlanPriceWidgetReadyPayload;
