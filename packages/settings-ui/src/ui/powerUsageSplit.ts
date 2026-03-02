export type UsageSplit = {
  controlledKWh?: number;
  uncontrolledKWh?: number;
};

const hasFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const clampValue = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const resolveUsageSplit = (params: {
  totalKWh: number;
  rawControlled: unknown;
  rawUncontrolled: unknown;
}): UsageSplit => {
  const { totalKWh, rawControlled, rawUncontrolled } = params;
  const total = Math.max(0, totalKWh);

  if (hasFiniteNumber(rawControlled)) {
    const controlled = clampValue(rawControlled, 0, total);
    return {
      controlledKWh: controlled,
      uncontrolledKWh: Math.max(0, total - controlled),
    };
  }

  if (hasFiniteNumber(rawUncontrolled)) {
    const uncontrolled = clampValue(rawUncontrolled, 0, total);
    return {
      controlledKWh: Math.max(0, total - uncontrolled),
      uncontrolledKWh: uncontrolled,
    };
  }

  return {};
};
