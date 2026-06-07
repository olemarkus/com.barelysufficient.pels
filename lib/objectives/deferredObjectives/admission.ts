import type { PlanInputDevice } from '../../../packages/planner-types/src/planInputDevice';
import type { DeferredReleaseIntent } from '../../../packages/planner-types/src/deferredDecoration';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectiveHorizonPlan } from './types';
import { LEARNED_THERMOSTAT_DEADBAND_MAX_C } from '../../utils/learnedThermostatDeadbandStore';

export type { DeferredReleaseIntent };

export type DeferredAdmissionDecision =
  | { kind: 'inactive'; budgetExempt: boolean; releaseIntent?: 'binary_release' | 'shed_release' }
  | {
      kind: 'planned';
      budgetExempt: boolean;
      engageBoost: boolean;
      expectedStepId: string | null;
      releaseIntent?: 'binary_restore';
    }
  | { kind: 'idle'; budgetExempt: boolean; releaseIntent?: 'binary_release' | 'shed_release' };

// `satisfied` falls back to inactive: the goal is met, so the objective should
// not keep forcing the device on. `cannot_meet` still drives the device — the
// planner's lowest-step allocation is what we _can_ deliver, not a reason to
// stop trying; runtime is free to step up when headroom appears, so a
// hard-cap miss should still get us as close to the target as possible.
const PLANNABLE_STATUSES = new Set<DeferredObjectiveDiagnostic['status']>([
  'on_track',
  'at_risk',
  'cannot_meet',
]);

// Once a deferred objective transitions to a terminal status for a cap-off device, PELS must
// release the device because the objective was the only reason PELS was driving it. Objectives
// that control their device via a binary signal (EV SoC today) map to 'binary_release' (the
// dedicated binary path); every other device kind maps to 'shed_release', which fires the
// device's configured shedBehavior (turn_off / set_temperature / set_step) exactly once. The
// executor's idempotency guards prevent re-actuation on the per-cycle re-emission so the intent
// is safe to broadcast every cycle while the terminal status holds. Cap-on devices stay on the
// planner's normal managed lane and never see a release intent.
const shouldEmitTerminalRelease = (
  diagnostic: DeferredObjectiveDiagnostic,
  device: PlanInputDevice | undefined,
): boolean => (
  diagnostic.status === 'satisfied'
  && device?.controllable === false
);

// INVARIANT (load-bearing): the release intent is keyed purely on objectiveKind,
// and objectiveKind↔device-type is 1:1 — `ev_soc` only ever attaches to an EV
// charger, `temperature` only to a thermostat. This is enforced at the write seam
// (`flowCards/deadlineObjectiveCards.ts` throws unless `isEvCharger` /
// `supportsTemperatureObjective`) and structurally (an evcharger snapshot always
// has `targets: []`, so it can never carry a temperature objective). The executor
// relies on this: it routes deferred releases solely on the
// `binary_release`/`binary_restore`/`shed_release` intent and does NOT re-check
// `isEvDevice` (so `shed_release` never reaches an EV device, `binary_*` always an
// EV device). If a future change lets an evcharger expose settable targets, or
// relaxes those write-card gates, this binding breaks — restore the executor's
// device-kind guard (or re-key the routing) if that ever happens.
//
// Exhaustive switch (not a ternary) so adding a third objective kind to the
// diagnostic union is a COMPILE error here rather than a silent shed_release —
// forcing a deliberate routing decision for the new kind.
const resolveReleaseIntentForCapOff = (
  objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
): 'binary_release' | 'shed_release' => {
  switch (objectiveKind) {
    case 'ev_soc':
      return 'binary_release';
    case 'temperature':
      return 'shed_release';
    default: {
      const exhaustive: never = objectiveKind;
      return exhaustive;
    }
  }
};

// A deferred current hour is "released" when the device is idled this cycle rather
// than run. Four causes: there is no current bucket, the current bucket carries no
// booked energy, the producer flagged the hour price-deferral-eligible (the device
// is already at/above this hour's trajectory milestone AND a later hour is
// cheaper), or the producer flagged a cold-start release (a later hour is
// meaningfully cheaper and the full need fits into the cheaper future hours at the
// device's real/climbed step — so a fast device must not dump its catch-up into
// this expensive hour). Single source of truth shared by `resolveDecision` (which
// idles the device) and `buildDeferredTargetOverrides` (which must NOT stamp a
// deadline floor target on a released device — otherwise `resolvePlannedTarget`
// would command it to run despite the release).
const isReleasedCurrentHour = (horizonPlan: DeferredObjectiveHorizonPlan): boolean => (
  !horizonPlan.currentBucket
  || horizonPlan.currentBucket.plannedUsefulEnergyKWh <= 0
  || horizonPlan.priceDeferralEligible === true
  || horizonPlan.coldStartReleaseEligible === true
);

const resolveDecision = (
  diagnostic: DeferredObjectiveDiagnostic,
  device: PlanInputDevice | undefined,
): DeferredAdmissionDecision => {
  // Producer-resolved flat flag: the smart task's exempt-from-budget permission is active
  // for the current planned bucket. Idle/background cycles must not inherit a standing
  // budget exemption from a future planned bucket.
  const budgetExempt = diagnostic.budgetExemptApplied === true && PLANNABLE_STATUSES.has(diagnostic.status);
  // The limit-lower-priority permission engages the device's boost, but only while the task
  // is in its planned hours (the 'planned' decision below) — so it claims capacity from
  // lower-priority devices only when it is actually scheduled to run.
  const engageBoost = diagnostic.limitLowerPriorityApplied === true && PLANNABLE_STATUSES.has(diagnostic.status);
  if (!PLANNABLE_STATUSES.has(diagnostic.status)) {
    if (!shouldEmitTerminalRelease(diagnostic, device)) return { kind: 'inactive', budgetExempt: false };
    const releaseIntent = resolveReleaseIntentForCapOff(diagnostic.objectiveKind);
    return { kind: 'inactive', budgetExempt: false, releaseIntent };
  }
  const horizonPlan = diagnostic.horizonPlan;
  if (!horizonPlan) return { kind: 'inactive', budgetExempt: false };
  const isEvObjective = diagnostic.objectiveKind === 'ev_soc';
  if (isReleasedCurrentHour(horizonPlan)) {
    // Released bucket: hold the device in its configured release posture. Besides
    // genuine idle hours (no current bucket / no booked energy), this also fires
    // when the producer flagged the hour price-deferral-eligible — the device is
    // already at/above this hour's trajectory milestone and a later hour is
    // cheaper, so release the device this cycle. This is a live per-cycle control decision on the
    // admission path; the clock-driven recorder is insulated, so no revision is
    // written (the device's idling re-books the cheaper hours at the next :58 settle).
    //
    // Binary-controlled objectives (EV SoC today, cap-on or cap-off): always release the binary
    // control. Off-peak hours have no capacity pressure, so the planner's normal shed/restore
    // lane would never command the cap-on device off — but the smart task's whole point is not
    // to run outside planned hours, so we force binary_release regardless of cap-on/off.
    //
    // Non-binary cap-off: emit shed_release once so the configured shedBehavior fires. Cap-on
    // non-binary stays on the planner's normal lane — emitting shed_release there would race
    // the planner's own decisions (it might be deliberately restoring the device).
    if (isEvObjective) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' };
    }
    if (device?.controllable === false) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'shed_release' };
    }
    return { kind: 'idle', budgetExempt: false };
  }
  return {
    kind: 'planned',
    budgetExempt,
    engageBoost,
    expectedStepId: horizonPlan.currentBucket?.expectedStepId ?? null,
    ...(isEvObjective ? { releaseIntent: 'binary_restore' as const } : {}),
  };
};

export const applyDeferredObjectiveAdmission = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
  devices: readonly PlanInputDevice[] = [],
): Map<string, DeferredAdmissionDecision> => {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const decisions = new Map<string, DeferredAdmissionDecision>();
  for (const diagnostic of diagnostics) {
    decisions.set(diagnostic.deviceId, resolveDecision(diagnostic, deviceById.get(diagnostic.deviceId)));
  }
  return decisions;
};

// Soft deferred objectives only override the cap-off (controllable=false) fallback. When the
// user keeps capacity-based control on for the device, normal PELS behavior already runs and
// the deferred plan should not bypass restore admission, cooldowns, or daily-budget logic.
const requiresOverride = (decision: DeferredAdmissionDecision, device: PlanInputDevice): boolean => (
  decision.kind !== 'inactive' && device.controllable === false
);

export type DeferredAdmissionInput = {
  devices: PlanInputDevice[];
  forceShedSet: Set<string>;
};

// A planned limit-lower-priority task forces the device's boost on. The boost resolvers
// (resolveTemperatureBoostActive / resolveEvBoostActive) honour the request by device kind,
// so the existing escalation/shedding machinery claims capacity from lower-priority devices.
const resolveBoostFields = (engageBoost: boolean): { forceBoostActive?: true } => (
  engageBoost ? { forceBoostActive: true } : {}
);

// Translate an active deferred objective into a temporary capacity-control-on signal for the
// shedding/restore pipeline. The shedding and restore modules stay agnostic of objectives:
// they only see a managed device and (for idle hours) a seeded shed-set entry. The deadline
// thermostat-floor (built once via `buildDeferredTargetOverrides`) is stamped onto the device
// here too so `resolvePlannedTarget` can read it from a single per-device field instead of a
// parallel id→°C map.
export const applyDeferredAdmissionToInput = (
  devices: PlanInputDevice[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  targetOverrides: Readonly<Record<string, number>> = {},
): DeferredAdmissionInput => {
  if (decisions.size === 0 && Object.keys(targetOverrides).length === 0) {
    return { devices, forceShedSet: new Set() };
  }
  const forceShedSet = new Set<string>();
  const transformed = devices.map((device) => {
    const decision = decisions.get(device.id);
    const deadlineFloorTargetC = targetOverrides[device.id];
    const hasDeadlineFloor = typeof deadlineFloorTargetC === 'number';
    if (!decision) return hasDeadlineFloor ? { ...device, deadlineFloorTargetC } : device;
    const override = requiresOverride(decision, device);
    if (override && decision.kind === 'idle') forceShedSet.add(device.id);
    // Engage the device's boost while a limit-lower-priority task is in its planned hours.
    // This reuses the existing boost machinery (EV chargers via evBoost, stepped thermal
    // devices via temperatureBoost) to escalate past the shed-invariant and claim capacity
    // from lower-priority devices — the deferred target override already commands the task's
    // target. Physical capacity stays enforced by the capacity guard.
    const engageBoost = decision.kind === 'planned' && decision.engageBoost;
    // The rescue budget exemption applies cap-agnostically, but only during the
    // planned current bucket. It should not turn idle/background cycles into the
    // device's standing budget-exemption setting.
    if (!override && !decision.budgetExempt && !engageBoost && !hasDeadlineFloor) return device;
    return {
      ...device,
      ...(override ? { controllable: true } : {}),
      ...(decision.budgetExempt ? { budgetExempt: true } : {}),
      ...resolveBoostFields(engageBoost),
      ...(hasDeadlineFloor ? { deadlineFloorTargetC } : {}),
    };
  });
  return { devices: transformed, forceShedSet };
};

// Per-cycle map of the deadline temperature target a device should be commanded to during a
// planned hour. EV objectives and non-planned diagnostics are skipped. Consumed by
// `resolvePlannedTarget` to lift the mode setpoint above the configured operating-mode target so
// the device's own thermostat can actually reach the deadline.
//
// `getLearnedDeadbandC` is the producer-resolved per-device over-command (°C) that PELS adds to
// the raw user target so the device's local-control deadband doesn't leave the room short of
// target (e.g. a 21 °C target + 0.2 °C learned deadband ⇒ commanded 21.2 °C, room satisfies at
// 21.0 °C). The reader defaults to 0 °C when absent (fresh install, no learned value yet, or
// test harnesses that don't wire the store). The producer side
// (`updateLearnedThermostatDeadbandFromEntry`) EMA-updates from clean met/stalled runs, so the
// store self-heals — see `feedback_layering_resolution_in_producer`.
export const buildDeferredTargetOverrides = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
  getLearnedDeadbandC?: (deviceId: string) => number,
): Record<string, number> => {
  const overrides: Record<string, number> = {};
  for (const diag of diagnostics) {
    if (diag.objectiveKind !== 'temperature') continue;
    if (!PLANNABLE_STATUSES.has(diag.status)) continue;
    const horizonPlan = diag.horizonPlan;
    // Skip released hours (mirrors `resolveDecision`'s idle gate via the shared
    // `isReleasedCurrentHour`): an idle / price-deferred device must not be
    // commanded to the deadline floor, or `resolvePlannedTarget` would lift the
    // setpoint and run it in the very hour we released it from.
    if (!horizonPlan || isReleasedCurrentHour(horizonPlan)) continue;
    // Defensive: persisted settings can yield NaN/Infinity on corrupt reads; the type-level
    // `number` invariant does not survive Homey settings drift. See feedback_homey_sdk_unreliable.
    if (!Number.isFinite(diag.targetTemperatureC)) continue;
    const rawDeadbandC = getLearnedDeadbandC?.(diag.deviceId) ?? 0;
    // Defensive against a reader that returns out-of-bounds values (non-finite, negative, or
    // above the over-command cap). The store helper clamps on read so the expected range is
    // [0, LEARNED_THERMOSTAT_DEADBAND_MAX_C]; anything outside is treated as 0 rather than
    // applied, so a wiring bug or pathological store state cannot cause a runaway overshoot
    // beyond the design cap.
    const safeDeadbandC = Number.isFinite(rawDeadbandC)
      && rawDeadbandC > 0
      && rawDeadbandC <= LEARNED_THERMOSTAT_DEADBAND_MAX_C
      ? rawDeadbandC
      : 0;
    overrides[diag.deviceId] = diag.targetTemperatureC + safeDeadbandC;
  }
  return overrides;
};

export const buildDeferredReleaseIntents = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): Record<string, DeferredReleaseIntent> => {
  const intents: Record<string, DeferredReleaseIntent> = {};
  for (const [deviceId, decision] of decisions) {
    if (!decision.releaseIntent) continue;
    intents[deviceId] = decision.releaseIntent;
  }
  return intents;
};
