import type { SteppedLoadStep } from '../../contracts/src/types';

/**
 * The one place that decides whether a `target_power` range yields a usable
 * step ladder, and the one place that builds it.
 *
 * Both the runtime producer (`lib/device/nativeSteppedLoadWiring.ts`) and the
 * settings UI's save validation call in here, so a range the UI accepts is
 * exactly a range the producer can drive. When they disagreed, the UI happily
 * saved a `target_power` config that the producer could not turn into a ladder,
 * and the device was left classified as stepped with nothing to stand on.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

export const TARGET_POWER_MAX_GENERATED_STEPS = 128;

export type TargetPowerLadderIssue =
  | 'missing_max'
  | 'missing_step'
  | 'min_excludes_zero'
  | 'negative_max'
  | 'negative_step'
  | 'step_exceeds_range'
  | 'too_many_generated_steps';

export type TargetPowerLadderAssessment =
  | { valid: true }
  | { valid: false; issue: TargetPowerLadderIssue };

export type TargetPowerLadderOptions = {
  min?: number;
  max?: number;
  step?: number;
  excludeMax?: number;
};

/**
 * Why a target_power range yields no ladder, or `undefined` when it does.
 *
 * The contract requires that the range includes 0 (so the device can be set to
 * idle). The minimum operating power is modeled with excludeMin/excludeMax,
 * not by raising `min`. Any options with `min > 0` violate the contract and
 * must be ignored — the off step always maps to `target_power = 0`.
 *
 * Callers that want to explain the rejection read this directly; the settings
 * UI compiles without `strictNullChecks`, where narrowing the assessment union
 * below down to its issue does not hold.
 */
export const resolveTargetPowerLadderIssue = (
  options: TargetPowerLadderOptions | undefined,
): TargetPowerLadderIssue | undefined => {
  const numericIssue = assessNumericFields(options);
  if (numericIssue) return numericIssue;
  const max = options?.max as number;
  const step = options?.step as number;
  const minW = resolveActiveMinW(options, step);
  if (minW > max) return 'step_exceeds_range';
  const stepCount = resolveLadderRungCount(minW, max, step);
  if (stepCount < 1) return 'step_exceeds_range';
  if (stepCount > TARGET_POWER_MAX_GENERATED_STEPS) return 'too_many_generated_steps';
  return undefined;
};

/**
 * How many rungs a range yields — the one definition, shared by the assessment
 * that accepts a range and the builder that walks it, so the ladder can never
 * be longer than the count that was approved.
 */
const resolveLadderRungCount = (minW: number, maxW: number, stepW: number): number => (
  Math.floor((maxW - minW) / stepW) + 1
);

/** {@link resolveTargetPowerLadderIssue} in the typed-result shape. */
export const assessTargetPowerLadderOptions = (
  options: TargetPowerLadderOptions | undefined,
): TargetPowerLadderAssessment => {
  const issue = resolveTargetPowerLadderIssue(options);
  return issue ? { valid: false, issue } : { valid: true };
};

/**
 * The ladder for a validated range: an off step plus every reachable rung.
 *
 * Returns `undefined` for a range that cannot produce one — the caller's cue to
 * drop the whole stepped classification, never to keep it with an empty ladder.
 * Every returned ladder has at least one rung above zero, so
 * `hasUsableSteppedLoadLadder` holds by construction.
 */
export const buildTargetPowerLadderSteps = (
  options: TargetPowerLadderOptions | undefined,
): SteppedLoadStep[] | undefined => {
  if (resolveTargetPowerLadderIssue(options) !== undefined) return undefined;
  const maxW = options?.max as number;
  const stepW = options?.step as number;
  const minW = resolveActiveMinW(options, stepW);

  // Each rung is derived from its index rather than accumulated with `+=`, so
  // the ladder is exactly as long as the count `resolveTargetPowerLadderIssue`
  // approved. Accumulating drifts at watt scale, and `Number.EPSILON` is an
  // absolute tolerance far too small to correct it, so the last rung could
  // appear or vanish depending on the step size.
  const steps: SteppedLoadStep[] = [{ id: 'off', planningPowerW: 0 }];
  const seenPowerW = new Set<number>([0]);
  for (let index = 0; index < resolveLadderRungCount(minW, maxW, stepW); index += 1) {
    const roundedValue = Math.round(minW + (index * stepW));
    // A sub-watt step rounds several rungs onto the same watt. They would carry
    // the same `<n>w` id, and step lookup by id is how the whole ladder is
    // addressed — so keep the first and drop the rest rather than mint a
    // duplicate key.
    if (seenPowerW.has(roundedValue)) continue;
    seenPowerW.add(roundedValue);
    steps.push({
      id: `${roundedValue}w`,
      planningPowerW: roundedValue,
    });
  }
  return steps;
};

const assessNumericFields = (
  options: TargetPowerLadderOptions | undefined,
): TargetPowerLadderIssue | undefined => {
  const max = options?.max;
  const step = options?.step;
  if (typeof max !== 'number' || !Number.isFinite(max)) return 'missing_max';
  if (typeof step !== 'number' || !Number.isFinite(step)) return 'missing_step';
  if (max <= 0) return 'negative_max';
  if (step <= 0) return 'negative_step';
  const min = options?.min;
  if (typeof min === 'number' && Number.isFinite(min) && min > 0) return 'min_excludes_zero';
  return undefined;
};

/**
 * The lowest RUNNING level a target-power config yields, in watts — the first
 * rung above off. `excludeMax` is the floor when set (an EV preset carries the
 * 6 A rung there: 1380 W on one phase, 4140 W on three), otherwise the range's
 * own minimum, otherwise one step.
 *
 * Exported because it is the number the solar-surplus floor setting is about,
 * and the settings UI has to state it in visible text. Deriving it there from a
 * built ladder would be a second definition of "the lowest level" that could
 * drift from the one the ladder actually uses.
 */
export const resolveTargetPowerFloorW = (
  options: TargetPowerLadderOptions | undefined,
): number | undefined => {
  const stepW = finitePositiveNumber(options?.step);
  if (stepW === undefined) return undefined;
  return resolveActiveMinW(options, stepW);
};

const resolveActiveMinW = (
  options: TargetPowerLadderOptions | undefined,
  stepW: number,
): number => {
  const excludeMax = finitePositiveNumber(options?.excludeMax);
  if (excludeMax) return excludeMax;
  const min = finitePositiveNumber(options?.min);
  if (min) return min;
  return stepW;
};

const finitePositiveNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
);
