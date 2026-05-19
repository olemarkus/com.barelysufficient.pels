export const KWH_ROUNDING_FACTOR = 1000;

export const roundKWh = (value: number): number => (
  Math.round(value * KWH_ROUNDING_FACTOR) / KWH_ROUNDING_FACTOR
);
