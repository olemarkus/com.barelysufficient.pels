export const formatKWh = (value: number, digits = 2) => (
  Number.isFinite(value) ? `${value.toFixed(digits)} kWh` : '-- kWh'
);

export const formatSignedKWh = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return '-- kWh';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)} kWh`;
};

export const formatPercent = (value: number) => (
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : '--%'
);
