// One actual price period, with its source's bounds. Smart-task scheduling
// consumes the planning price; money estimates consume the import price.
// The price owner resolves both before handing this flat contract inward.
export type PriceHorizonEntry = {
  startMs: number;
  endMs: number;
  price: number;
  moneyPrice: number;
};

// Import prices for metered delivery. Missing spans are absent from the series;
// the delivery owner retains their energy and marks the cost incomplete.
export type MeteredPricePeriod = {
  startMs: number;
  endMs: number;
  priceValue: number;
  tone: 'cheap' | 'normal' | 'expensive';
  costDisplay: { unit: string; divisor: number };
};
