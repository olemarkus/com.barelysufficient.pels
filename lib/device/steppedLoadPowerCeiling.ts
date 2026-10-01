import type { SteppedLoadProfile, SteppedLoadStep } from '../../packages/contracts/src/types';

const STEPPED_LOAD_POWER_CEILING_MARGIN_RATIO = 0.05;
const STEPPED_LOAD_POWER_CEILING_MARGIN_MAX_W = 150;

/**
 * How far below a rung a reported power may sit and still be that rung. Devices
 * draw a little under nominal (a car on a 16 A rung reads ~3.6 kW, not 3.68 kW),
 * so the Flow report card resolves a reading to the rung just above it. The
 * device owner admits that same pairing; one definition keeps the two agreeing.
 */
export function getSteppedLoadPowerCeilingMarginW(stepPowerW: number): number {
  return Math.min(
    STEPPED_LOAD_POWER_CEILING_MARGIN_MAX_W,
    Math.max(0, stepPowerW * STEPPED_LOAD_POWER_CEILING_MARGIN_RATIO),
  );
}

export function isWithinSteppedLoadPowerCeiling(stepPowerW: number, reportedPowerW: number): boolean {
  const roundedStepPowerW = Math.round(stepPowerW);
  const deficitW = roundedStepPowerW - reportedPowerW;
  return deficitW >= 0 && deficitW <= getSteppedLoadPowerCeilingMarginW(roundedStepPowerW);
}

/**
 * The ladder rung a report names when its watts sit just under that rung. Such
 * a report is the rung, with the raw watts as its evidence, and adds no
 * off-grid step. Admission and every later refresh that carries the report
 * forward must recognize the same pairing.
 */
export function resolveSteppedLoadCeilingStep(
  profile: SteppedLoadProfile,
  stepId: string,
  reportedPowerW: number,
): SteppedLoadStep | undefined {
  const step = profile.steps.find((candidate) => candidate.id === stepId);
  return step && isWithinSteppedLoadPowerCeiling(step.planningPowerW, reportedPowerW) ? step : undefined;
}
