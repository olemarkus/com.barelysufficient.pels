/* Root runtime Jest does not transform executable TS from packages/contracts,
 * so runtime tests map that module to this shim while production code uses the
 * shared contracts helper directly.
 */
type TargetCapabilityLike = {
  id: string;
  value: unknown;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
};

const DEFAULT_TEMPERATURE_TARGET_STEP = 0.5;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const getDecimalPlaces = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const match = value.toString().match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return 0;
  const decimals = match[1] ? match[1].length : 0;
  const exponent = match[2] ? Number.parseInt(match[2], 10) : 0;
  return Math.max(0, decimals - exponent);
};

export const getPrimaryTargetCapability = (
  targets?: TargetCapabilityLike[] | null,
): TargetCapabilityLike | null => (
  Array.isArray(targets) && targets.length > 0 ? targets[0] : null
);

const clampTargetCapabilityValue = (
  target: Partial<Pick<TargetCapabilityLike, 'min' | 'max'>> | null | undefined,
  value: number,
): number => {
  let normalized = value;
  if (isFiniteNumber(target?.min)) {
    normalized = Math.max(target.min, normalized);
  }
  if (isFiniteNumber(target?.max)) {
    normalized = Math.min(target.max, normalized);
  }
  return normalized;
};

const roundTargetCapabilityValue = (
  target: Partial<Pick<TargetCapabilityLike, 'min' | 'max' | 'step'>> | null | undefined,
  value: number,
): number => {
  if (!isFiniteNumber(target?.step) || target.step <= 0) return value;
  const base = isFiniteNumber(target?.min) ? target.min : 0;
  const decimals = Math.max(
    getDecimalPlaces(target.step),
    isFiniteNumber(target?.min) ? getDecimalPlaces(target.min) : 0,
    isFiniteNumber(target?.max) ? getDecimalPlaces(target.max) : 0,
  );
  return Number(
    (base + (Math.round((value - base) / target.step) * target.step)).toFixed(decimals),
  );
};

export const getTargetCapabilityStep = (
  target?: Partial<Pick<TargetCapabilityLike, 'step'>> | null,
  fallback = DEFAULT_TEMPERATURE_TARGET_STEP,
): number => {
  if (isFiniteNumber(target?.step) && target.step > 0) return target.step;
  return fallback;
};

export const normalizeTargetCapabilityValue = (params: {
  target?: Partial<Pick<TargetCapabilityLike, 'min' | 'max' | 'step'>> | null;
  value: number;
}): number => {
  const { target, value } = params;
  const clamped = clampTargetCapabilityValue(target, value);
  const rounded = roundTargetCapabilityValue(target, clamped);
  return clampTargetCapabilityValue(target, rounded);
};
