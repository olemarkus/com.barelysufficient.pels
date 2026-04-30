import {
  PRICE_FLEX_HIGH,
  PRICE_FLEX_HIGH_THRESHOLD,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
} from '../../../contracts/src/dailyBudgetConstants.ts';

const clampRatio = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

export const reserveModeValue = (value: number): string => (
  clampRatio(value, UNMANAGED_RESERVE_MODE) >= 0.5
    ? UNMANAGED_RESERVE_CONSERVATIVE_MODE.toString()
    : UNMANAGED_RESERVE_MODE.toString()
);

export const priceFlexModeValue = (value: number): string => {
  const safeValue = clampRatio(value, PRICE_SHAPING_FLEX_SHARE);
  if (safeValue <= PRICE_FLEX_LOW) return PRICE_FLEX_LOW.toString();
  if (safeValue > PRICE_FLEX_HIGH_THRESHOLD) return PRICE_FLEX_HIGH.toString();
  return PRICE_FLEX_MEDIUM.toString();
};
