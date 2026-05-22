// Sub-interval energy accumulator for the learned-rate profile (Step 1 of
// Cause #1 — see notes/deferred-load-objectives/feasibility-confidence.md).
// Stepped devices change power mid-window; billing the whole baseline→rise
// window at one power poisons `kwhPerUnit`. These helpers integrate each
// sub-interval at its own left-edge power across the `rise_too_small` skips
// that the baseline-preserving path used to discard. Lives beside
// `objectiveProfiles.ts` to keep that file within the `max-lines` lint cap and
// to match the existing `objectiveProfile*` companion-file split.
import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './objectiveProfileTypes';

// Left edge of the currently-open sub-interval: the most recent raw sample's
// timestamp + the power to bill from there to the next sample. Seeds from the
// accumulator fields, falling back to the baseline (`lastSample`) for a legacy
// profile or a freshly-opened window with no `rise_too_small` skips yet — which
// makes the no-skip case bill exactly `baselinePower × wholeInterval`, identical
// to the pre-accumulator behaviour.
export function resolveSubIntervalLeftEdge(
  previous: DeviceObjectiveProfile,
): { fromMs: number; powerW: number | undefined } {
  return {
    fromMs: previous.subIntervalStartMs ?? previous.lastSample.observedAtMs,
    powerW: previous.subIntervalPowerW ?? previous.lastSample.crediblePowerW,
  };
}

export function subIntervalEnergyKwh(powerW: number, fromMs: number, toMs: number): number {
  return powerW * ((toMs - fromMs) / 3_600_000) / 1000;
}

// Total energy across the open baseline→`sample` window: the closed sub-intervals
// already summed into `pendingEnergyKWh`, plus the final open sub-interval billed
// at its left-edge power. Returns `undefined` when the open sub-interval's
// left-edge power is absent OR non-positive (device not drawing / coasting) — the
// window is then thermally contaminated and yields no `kwhPerUnit`, matching the
// pre-accumulator rule that an unpowered baseline produces no energy estimate and
// the symmetric `powerW <= 0` discard in `accrueSubIntervalSkip`. Without the
// `<= 0` guard an accept after a coasting skip (banked `subIntervalPowerW = 0`)
// would emit a `kwhPerUnit` from a partly-unpowered window — the exact coast
// poisoning Step 1 removes.
export function calculateWindowEnergyKwh(
  previous: DeviceObjectiveProfile,
  sample: DeviceObjectiveProfileSample,
): number | undefined {
  const { fromMs, powerW } = resolveSubIntervalLeftEdge(previous);
  if (typeof powerW !== 'number' || powerW <= 0) return undefined;
  return (previous.pendingEnergyKWh ?? 0) + subIntervalEnergyKwh(powerW, fromMs, sample.observedAtMs);
}

// Clears the in-progress accumulator. Spread onto a profile whenever the baseline
// resets (accept, value-fell, interval-too-long, recovery, contamination) so a
// partial window is never carried into the next, unrelated one. The `undefined`
// keys drop on JSON serialization for `power_tracker_state`.
export const CLEARED_ENERGY_ACCUMULATOR = {
  pendingEnergyKWh: undefined,
  subIntervalStartMs: undefined,
  subIntervalPowerW: undefined,
} as const;
