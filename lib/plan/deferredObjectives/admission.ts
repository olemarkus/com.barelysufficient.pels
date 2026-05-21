import type { PlanInputDevice } from '../planTypes';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

export type DeferredAdmissionDecision =
  | { kind: 'inactive'; budgetExempt: boolean; evCommandIntent?: 'ev_pause' }
  | {
      kind: 'planned';
      budgetExempt: boolean;
      engageBoost: boolean;
      requestedMinimumStepId: string | null;
      evCommandIntent?: 'ev_resume';
    }
  | { kind: 'idle'; budgetExempt: boolean; evCommandIntent?: 'ev_pause' };

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

// Note's "EV Semantics" §"Power-limit control off": once the deadline objective is satisfied for a
// cap-off charger, PELS should pause charging because the deferred objective was the only reason
// PELS allowed charging at all. We emit a one-shot `ev_pause` whenever the diagnostic reports
// `satisfied` and the device is cap-off; the executor guards against re-issuing pauses to an
// already-paused charger so the per-cycle re-emission is idempotent. Cap-on chargers still rely on
// normal managed admission, so the pause does not fire there.
const shouldEmitSatisfiedPause = (
  diagnostic: DeferredObjectiveDiagnostic,
  device: PlanInputDevice | undefined,
): boolean => (
  diagnostic.status === 'satisfied'
  && diagnostic.objectiveKind === 'ev_soc'
  && device?.controllable === false
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
    return shouldEmitSatisfiedPause(diagnostic, device)
      ? { kind: 'inactive', budgetExempt: false, evCommandIntent: 'ev_pause' }
      : { kind: 'inactive', budgetExempt: false };
  }
  const horizonPlan = diagnostic.horizonPlan;
  if (!horizonPlan) return { kind: 'inactive', budgetExempt: false };
  const currentBucket = horizonPlan.currentBucket;
  const isEvObjective = diagnostic.objectiveKind === 'ev_soc';
  if (!currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0) {
    return isEvObjective
      ? { kind: 'idle', budgetExempt: false, evCommandIntent: 'ev_pause' }
      : { kind: 'idle', budgetExempt: false };
  }
  return {
    kind: 'planned',
    budgetExempt,
    engageBoost,
    requestedMinimumStepId: currentBucket.requestedMinimumStepId,
    ...(isEvObjective ? { evCommandIntent: 'ev_resume' as const } : {}),
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
// they only see a managed device and (for idle hours) a seeded shed-set entry.
export const applyDeferredAdmissionToInput = (
  devices: PlanInputDevice[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): DeferredAdmissionInput => {
  if (decisions.size === 0) return { devices, forceShedSet: new Set() };
  const forceShedSet = new Set<string>();
  const transformed = devices.map((device) => {
    const decision = decisions.get(device.id);
    if (!decision) return device;
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
    if (!override && !decision.budgetExempt && !engageBoost) return device;
    return {
      ...device,
      ...(override ? { controllable: true } : {}),
      ...(decision.budgetExempt ? { budgetExempt: true } : {}),
      ...resolveBoostFields(engageBoost),
    };
  });
  return { devices: transformed, forceShedSet };
};

// Per-cycle map of the deadline temperature target a device should be commanded to during a
// planned hour. EV objectives and non-planned diagnostics are skipped. Consumed by
// `resolvePlannedTarget` to lift the mode setpoint above the configured operating-mode target so
// the device's own thermostat can actually reach the deadline.
export const buildDeferredTargetOverrides = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
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
    overrides[diag.deviceId] = diag.targetTemperatureC;
  }
  return overrides;
};

export const buildDeferredEvCommandIntents = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): Record<string, 'ev_resume' | 'ev_pause'> => {
  const intents: Record<string, 'ev_resume' | 'ev_pause'> = {};
  for (const [deviceId, decision] of decisions) {
    if (!decision.evCommandIntent) continue;
    intents[deviceId] = decision.evCommandIntent;
  }
  return intents;
};
