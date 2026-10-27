import type { InverterControlBinding, InverterObservation } from '../../packages/contracts/src/inverterControl';

/** Binding identity excludes observation clocks and retained-read authority. */
export function inverterBindingsMatch(left: InverterControlBinding, right: InverterControlBinding): boolean {
  if (left.maxW !== right.maxW || left.stepW !== right.stepW || left.mode !== right.mode) return false;
  return left.mode === 'direct' || (right.mode === 'switchable'
    && left.modeValues.length === right.modeValues.length
    && left.modeValues.every((value) => right.modeValues.includes(value)));
}

/** Do not chase meter noise smaller than the controller's 100 W import/export band. */
export const inverterLimitDeadbandW = (binding: InverterControlBinding): number => Math.max(100, binding.stepW);

/** Half a native step accepts rounding, with a one-watt floor for integer reports. */
export const inverterLimitToleranceW = (binding: InverterControlBinding): number => Math.max(1, binding.stepW / 2);

/** Preserve the owner's ceiling when a new native range cannot represent the saved watts. */
export function inverterRestorationLimitW(savedLimitW: number, binding: InverterControlBinding): number {
  if (savedLimitW >= binding.maxW) return binding.maxW;
  return Math.floor(savedLimitW / binding.stepW) * binding.stepW;
}

/**
 * The planner's production decision. A limit captures the reports it used only
 * for stale-command preflight; that capture is never published as live truth.
 */
export type InverterDecision =
  | { kind: 'limit'; deviceId: string; limitW: number;
    binding: InverterControlBinding; observation: InverterObservation }
  | { kind: 'release'; deviceId: string };
