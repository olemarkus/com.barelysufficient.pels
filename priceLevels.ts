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

// Helper function to get display title from internal value
export function getPriceLevelTitle(priceLevel: PriceLevel): string {
  const option = PRICE_LEVEL_OPTIONS.find((opt) => opt.id === priceLevel);
  return option?.name ?? 'Unknown';
}

// Helper function to get internal value from title
export function getPriceLevelFromTitle(title: string): PriceLevel {
  const normalized = (title || '').toLowerCase();
  const option = PRICE_LEVEL_OPTIONS.find((opt) => opt.name.toLowerCase() === normalized);
  return option?.id ?? PriceLevel.UNKNOWN;
}
