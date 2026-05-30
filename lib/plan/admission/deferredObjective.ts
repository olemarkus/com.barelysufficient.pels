import type { PlanInputDevice } from '../planTypes';
import type { DeferredObjectiveDiagnostic } from '../../objectives/deferredObjectives/diagnosticsBridge';
import { LEARNED_THERMOSTAT_DEADBAND_MAX_C } from '../../utils/learnedThermostatDeadbandStore';

export type DeferredReleaseIntent = 'ev_resume' | 'ev_pause' | 'shed_release';

export type DeferredAdmissionDecision =
  | { kind: 'inactive'; budgetExempt: boolean; releaseIntent?: 'ev_pause' | 'shed_release' }
  | {
      kind: 'planned';
      budgetExempt: boolean;
      engageBoost: boolean;
      requestedMinimumStepId: string | null;
      releaseIntent?: 'ev_resume';
    }
  | { kind: 'idle'; budgetExempt: boolean; releaseIntent?: 'ev_pause' | 'shed_release' };

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
// release the device because the objective was the only reason PELS was driving it. EV chargers
// map to 'ev_pause' (the dedicated EV path); every other device kind maps to 'shed_release',
// which fires the device's configured shedBehavior (turn_off / set_temperature / set_step)
// exactly once. The executor's idempotency guards prevent re-actuation on the per-cycle
// re-emission so the intent is safe to broadcast every cycle while the terminal status holds.
// Cap-on devices stay on the planner's normal managed lane and never see a release intent.
const shouldEmitTerminalRelease = (
  diagnostic: DeferredObjectiveDiagnostic,
  device: PlanInputDevice | undefined,
): boolean => (
  diagnostic.status === 'satisfied'
  && device?.controllable === false
);

const resolveReleaseIntentForCapOff = (
  objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
): 'ev_pause' | 'shed_release' => (
  objectiveKind === 'ev_soc' ? 'ev_pause' : 'shed_release'
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
  const currentBucket = horizonPlan.currentBucket;
  const isEvObjective = diagnostic.objectiveKind === 'ev_soc';
  if (!currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0) {
    // Idle bucket: hold the device in its configured release posture.
    //
    // EV chargers (cap-on or cap-off): always pause. Off-peak hours have no capacity
    // pressure, so the planner's normal shed/restore lane would never command the cap-on
    // charger off — but the smart task's whole point is not to charge outside planned hours,
    // so we force ev_pause regardless of cap-on/off.
    //
    // Non-EV cap-off: emit shed_release once so the configured shedBehavior fires. Cap-on
    // non-EV stays on the planner's normal lane — emitting shed_release there would race
    // the planner's own decisions (it might be deliberately restoring the device).
    if (isEvObjective) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'ev_pause' };
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
    requestedMinimumStepId: currentBucket.requestedMinimumStepId,
    ...(isEvObjective ? { releaseIntent: 'ev_resume' as const } : {}),
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
    const currentBucket = diag.horizonPlan?.currentBucket;
    if (!currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0) continue;
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
