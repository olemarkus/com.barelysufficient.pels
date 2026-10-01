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
