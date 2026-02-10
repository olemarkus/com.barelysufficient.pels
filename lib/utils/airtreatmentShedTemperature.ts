import {
  AIRTREATMENT_SHED_FLOOR_C,
  SHED_DEFAULT_DELTA_C,
  SHED_FALLBACK_TARGET_C,
  SHED_MAX_C,
  SHED_MIN_C,
  SHED_STEP_C,
} from './airtreatmentConstants';

export function normalizeShedTemperature(value: number): number {
  const clamped = Math.max(SHED_MIN_C, Math.min(SHED_MAX_C, value));
  return Math.round(clamped / SHED_STEP_C) * SHED_STEP_C;
}

export function computeDefaultAirtreatmentShedTemperature(params: {
  modeTarget: number | null;
  currentTarget: number | null;
  minFloorC?: number;
}): number {
  const { modeTarget, currentTarget, minFloorC = AIRTREATMENT_SHED_FLOOR_C } = params;
  const baseTarget = modeTarget ?? currentTarget ?? SHED_FALLBACK_TARGET_C;
  const candidate = Math.max(minFloorC, baseTarget - SHED_DEFAULT_DELTA_C);
  return normalizeShedTemperature(candidate);
}
