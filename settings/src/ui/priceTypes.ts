export type PriceEntry = {
  startsAt: string;
  total: number;
  spotPrice?: number;
  nettleie?: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

export type CombinedPriceData = {
  prices: PriceEntry[];
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
};
