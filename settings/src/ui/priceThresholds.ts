export const calculateThresholds = (avgPrice: number, thresholdPercent: number) => {
  const multiplier = thresholdPercent / 100;
  return {
    low: avgPrice * (1 - multiplier),
    high: avgPrice * (1 + multiplier),
  };
};
