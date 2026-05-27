import type { ShedActionIntent } from '../device/deviceActionProjection';
import type { ShedAction } from './planTypes';

/**
 * Materialises the snapshot-side shed-action triple
 * (`shedAction`, `shedTemperature`, `shedStepId`) consumed by
 * `DevicePlanDevice` / the executor projection, from a producer-resolved
 * `ShedActionIntent` plus the per-cycle `shouldShed` decision and the device's
 * binary-control capability.
 *
 * The intent half of the resolution is producer-side (including the
 * `controllable` plan-cycle gate, folded into `resolveShedIntent` in PR A of
 * the post-detype cleanup batch). This adapter only applies the per-cycle
 * `shouldShed` gate and projects the snapshot-shape triple. Split from
 * the chunk-5 inline branches in `lib/plan/planDevices.ts:resolveShedAction`
 * so consumers downstream of the planner (the executor, planRemainingSheddableLoad
 * recompute, planLogging) can share one materialisation contract.
 *
 * Why `shouldShed` stays here and not at the producer:
 *   - `shouldShed` is the planner's per-cycle decision (the shedSet membership
 *     for this device) and has no producer equivalent.
 *
 * `controllable` is producer-resolvable (and resolved) — `resolveShedIntent`
 * collapses cap-off devices to their binary fallback intent so the
 * `set_temperature` branch here only fires for already-cap-on devices.
 * The deferred-objective rescue lane re-resolves the intent in
 * `lib/plan/planDevices.ts:resolveShedAction` with the post-admission
 * `controllable` before calling the materialiser, so the rescue-lane flip is
 * honoured.
 *
 * The materialisation is intentionally narrow: it does not consult device
 * shape, settings, or capabilities directly — only the typed intent and the
 * `shouldShed` gate (plus `hasBinaryControl` for the stepped-shed fallback).
 * Anything else stays at the producer or the consumer's upstream branches.
 */

export type ShedSnapshotTriple = {
  shedAction: ShedAction;
  shedTemperature: number | null;
  shedStepId: string | null;
};

export type ShedSnapshotMaterializationInput = {
  intent: ShedActionIntent;
  shouldShed: boolean;
};

const TURN_OFF: ShedSnapshotTriple = {
  shedAction: 'turn_off',
  shedTemperature: null,
  shedStepId: null,
};

const SET_STEP: ShedSnapshotTriple = {
  shedAction: 'set_step',
  shedTemperature: null,
  shedStepId: null,
};

export function materializeShedSnapshotFields(input: ShedSnapshotMaterializationInput): ShedSnapshotTriple {
  const { intent, shouldShed } = input;
  // `set_temperature` intent already implies the producer saw the device as controllable
  // (the `controllable` fold lives in `resolveShedIntent`). The `shouldShed` per-cycle gate
  // is the only remaining check here: on a non-shedding cycle the device falls through to
  // its binary fallback so the executor projection still has a well-formed snapshot triple.
  if (shouldShed && intent.kind === 'set_temperature') {
    return { shedAction: 'set_temperature', shedTemperature: intent.temperature, shedStepId: null };
  }
  if (intent.kind === 'set_step') {
    // The producer emits `set_step` either for a cap-on stepped device configured for
    // set_step, or for any stepped device with no binary handle (cap-on or cap-off). Both
    // routes use the step capability.
    return SET_STEP;
  }
  // turn_off intent (any cycle), or set_temperature on a non-shedding cycle.
  return TURN_OFF;
}
