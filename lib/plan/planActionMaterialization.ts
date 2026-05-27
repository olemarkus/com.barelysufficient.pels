import type { ShedActionIntent } from '../device/deviceActionProjection';
import type { ShedAction } from './planTypes';

/**
 * Materialises the snapshot-side shed-action triple
 * (`shedAction`, `shedTemperature`, `shedStepId`) consumed by
 * `DevicePlanDevice` / the executor projection, from a producer-resolved
 * `ShedActionIntent` plus the plan-cycle gates (`controllable`,
 * `shouldShed`) and the device's binary-control capability.
 *
 * The intent half of the resolution is producer-side; this module owns the
 * plan-cycle gate application and the snapshot-shape projection. Split from
 * the chunk-5 inline branches in `lib/plan/planDevices.ts:resolveShedAction`
 * so consumers downstream of the planner (the executor, planRemainingSheddableLoad
 * recompute, planLogging) can share one materialisation contract.
 *
 * Why the gates stay here and not at the producer:
 *   - `controllable` is plan-cycle-mutable (the deferred-objective rescue lane
 *     flips cap-off devices to cap-on for one cycle, after `toPlanDevice`
 *     ran). Resolving it inside the producer at `toPlanDevice` time would
 *     capture the pre-admission state.
 *   - `shouldShed` is the planner's per-cycle decision and has no producer
 *     equivalent.
 *
 * The materialisation is intentionally narrow: it does not consult device
 * shape, settings, or capabilities directly — only the typed intent and the
 * cycle gates. Anything else stays at the producer or the consumer's
 * upstream branches.
 */

export type ShedSnapshotTriple = {
  shedAction: ShedAction;
  shedTemperature: number | null;
  shedStepId: string | null;
};

export type ShedSnapshotMaterializationInput = {
  intent: ShedActionIntent;
  controllable: boolean;
  shouldShed: boolean;
  hasBinaryControl: boolean | undefined;
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
  const { intent, controllable, shouldShed, hasBinaryControl } = input;
  // set_temperature requires both gates: the device must be controllable this cycle (cap-on
  // or admitted by the deferred-objective rescue lane) and shouldShed must be true. Cap-off
  // or non-shedding cycles fall through and use the device's binary fallback (turn_off /
  // set_step) so the executor still has a well-formed snapshot triple to project.
  if (controllable && shouldShed && intent.kind === 'set_temperature') {
    return { shedAction: 'set_temperature', shedTemperature: intent.temperature, shedStepId: null };
  }
  if (intent.kind === 'set_step') {
    return materializeSteppedShedTriple({ controllable, hasBinaryControl });
  }
  return TURN_OFF;
}

function materializeSteppedShedTriple(params: {
  controllable: boolean;
  hasBinaryControl: boolean | undefined;
}): ShedSnapshotTriple {
  const { controllable, hasBinaryControl } = params;
  // Stepped intent + cap-on => use the step capability.
  if (controllable) return SET_STEP;
  // Stepped intent + cap-off + no binary handle => still set_step (the device has no other
  // shed handle; matches the legacy `resolveSteppedShedAction` fallback).
  if (hasBinaryControl === false) return SET_STEP;
  // Stepped intent + cap-off + has binary handle => fall back to turn_off, matching the
  // legacy behaviour for cap-off stepped devices with binary control.
  return TURN_OFF;
}
