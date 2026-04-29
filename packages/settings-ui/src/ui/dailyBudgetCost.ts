export type CostDisplay = {
  unit: string;
  divisor: number;
};

export const formatCost = (value: number | null | undefined, display: CostDisplay) => {
  const unit = display.unit.trim();
  const suffix = unit ? ` ${unit}` : '';
  if (!Number.isFinite(value)) return `--${suffix}`;
  const adjusted = (value as number) / Math.max(1, display.divisor);
  return `${adjusted.toFixed(2)}${suffix}`;
};
