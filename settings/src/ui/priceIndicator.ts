export type PriceIndicatorTone = 'cheap' | 'expensive' | 'neutral';

export const getPriceIndicatorIcon = (tone: PriceIndicatorTone): string => {
  if (tone === 'cheap') return '🟢';
  if (tone === 'expensive') return '🔴';
  return '⚪';
};
