import type { HomeBatterySetpointRange } from '../../packages/contracts/src/types';

/** Ratios are cleaned to this many decimals before rounding, so 0.25 / 0.1 rounds as 2.5, not 2.4999…. */
const STEP_RATIO_DECIMALS = 9;

const toStepRatio = (magnitudeW: number, stepW: number): number => (
  Number((magnitudeW / stepW).toFixed(STEP_RATIO_DECIMALS))
);

/** Decimals a step is written with (0.1 → 1, 0.25 → 2, 5 → 0), so a snapped value carries no float noise. */
const stepDecimals = (stepW: number): number => {
  const [mantissa = '', exponent = '0'] = stepW.toExponential().split('e');
  const fractionDigits = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, fractionDigits - Number(exponent));
};

const clampToRange = (valueW: number, range: HomeBatterySetpointRange): number => (
  Math.min(range.maxW, Math.max(range.minW, valueW))
);

const isStrictlyInsideExcludeBand = (valueW: number, range: HomeBatterySetpointRange): boolean => (
  valueW !== 0 && valueW > range.excludeMinW && valueW < range.excludeMaxW
);

/**
 * The magnitude to write for a nonzero clamped setpoint, before the final
 * clamp. The band edge on the setpoint's side is snapped onto the step grid
 * first (away from zero, so the snapped edge is never inside the band). A
 * setpoint inside the band goes to the nearer of 0 and that snapped edge (a
 * tie goes to 0, the smaller command); one outside it is rounded half away
 * from zero, and lifted to the snapped edge if rounding carried it inside.
 */
const snapMagnitude = (magnitudeW: number, edgeW: number, stepW: number): number => {
  const snappedEdgeW = Math.ceil(toStepRatio(edgeW, stepW)) * stepW;
  if (magnitudeW < edgeW) return snappedEdgeW - magnitudeW < magnitudeW ? snappedEdgeW : 0;
  const roundedW = Math.round(toStepRatio(magnitudeW, stepW)) * stepW;
  return roundedW < edgeW ? snappedEdgeW : roundedW;
};

/**
 * The `target_power` value to write for a signed setpoint, in watts.
 *
 * 1. Clamp to `[minW, maxW]`.
 * 2. Snap the exclude band's edge on the setpoint's side onto the step grid,
 *    away from zero. Homey coerces a write strictly inside the band to 0, so
 *    the band is decided against an edge PELS can actually write.
 * 3. A setpoint inside the band goes to the nearer of 0 and the snapped edge
 *    (a tie goes to 0). One outside it is snapped to the step half away from
 *    zero, so a discharge rounds exactly as the charge of the same size does,
 *    and lifted to the snapped edge if that rounding carried it inside.
 * 4. Clamp again. If the result is still inside the band (a band wider than
 *    the range), the only writable answer is 0.
 * 5. Round to the step's own decimals so a fractional step leaves no float
 *    noise.
 */
export function toTargetPowerCapabilityValue(setpointW: number, range: HomeBatterySetpointRange): number {
  const clampedW = clampToRange(setpointW, range);
  if (clampedW === 0) return 0;
  const sign = Math.sign(clampedW);
  const edgeW = Math.abs(sign > 0 ? range.excludeMaxW : range.excludeMinW);
  const snappedW = clampToRange(sign * snapMagnitude(Math.abs(clampedW), edgeW, range.stepW), range);
  if (isStrictlyInsideExcludeBand(snappedW, range)) return 0;
  return Number(snappedW.toFixed(stepDecimals(range.stepW)));
}

/** Largest writable command no greater in magnitude than the funded request. */
export function floorStorageSetpointW(setpointW: number, range: HomeBatterySetpointRange): number {
  const clampedW = clampToRange(setpointW, range);
  const roundedW = toTargetPowerCapabilityValue(clampedW, range);
  if (Math.abs(roundedW) <= Math.abs(clampedW)) return roundedW;
  const towardZeroW = Math.sign(clampedW) * Math.floor(toStepRatio(Math.abs(clampedW), range.stepW)) * range.stepW;
  return isStrictlyInsideExcludeBand(towardZeroW, range) ? 0 : toTargetPowerCapabilityValue(towardZeroW, range);
}
