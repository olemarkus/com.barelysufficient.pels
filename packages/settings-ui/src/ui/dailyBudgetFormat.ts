export const formatKWh = (value: number, digits = 2) => (
  Number.isFinite(value) ? `${value.toFixed(digits)} kWh` : '-- kWh'
);


