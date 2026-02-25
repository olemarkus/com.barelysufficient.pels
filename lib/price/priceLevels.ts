// Price level constants and mappings for flow cards
export enum PriceLevel {
  CHEAP = 'cheap',
  NORMAL = 'normal',
  EXPENSIVE = 'expensive',
  UNKNOWN = 'unknown',
}

export type PriceLevelOption = {
  id: PriceLevel;
  name: string;
};

// Flow card autocomplete options - maps display names to internal values
export const PRICE_LEVEL_OPTIONS: PriceLevelOption[] = [
  {
    id: PriceLevel.CHEAP,
    name: 'Cheap',
  },
  {
    id: PriceLevel.NORMAL,
    name: 'Normal',
  },
  {
    id: PriceLevel.EXPENSIVE,
    name: 'Expensive',
  },
  {
    id: PriceLevel.UNKNOWN,
    name: 'Unknown',
  },
];
