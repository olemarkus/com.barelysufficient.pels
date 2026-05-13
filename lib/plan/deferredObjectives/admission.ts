import type { PlanInputDevice } from '../planTypes';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

export type DeferredAdmissionDecision =
  | { kind: 'inactive'; evCommandIntent?: undefined }
  | { kind: 'planned'; requestedMinimumStepId: string | null; evCommandIntent?: 'ev_resume' }
  | { kind: 'idle'; evCommandIntent?: 'ev_pause' };

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

const resolveDecision = (
  diagnostic: DeferredObjectiveDiagnostic,
): DeferredAdmissionDecision => {
  if (!PLANNABLE_STATUSES.has(diagnostic.status)) return { kind: 'inactive' };
  const horizonPlan = diagnostic.horizonPlan;
  if (!horizonPlan) return { kind: 'inactive' };
  const currentBucket = horizonPlan.currentBucket;
  const isEvObjective = diagnostic.objectiveKind === 'ev_soc';
  if (!currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0) {
    return isEvObjective
      ? { kind: 'idle', evCommandIntent: 'ev_pause' }
      : { kind: 'idle' };
  }
  return {
    kind: 'planned',
    requestedMinimumStepId: currentBucket.requestedMinimumStepId,
    ...(isEvObjective ? { evCommandIntent: 'ev_resume' as const } : {}),
  };
};

export const applyDeferredObjectiveAdmission = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
): Map<string, DeferredAdmissionDecision> => {
  const decisions = new Map<string, DeferredAdmissionDecision>();
  for (const diagnostic of diagnostics) {
    decisions.set(diagnostic.deviceId, resolveDecision(diagnostic));
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
    if (!decision || !requiresOverride(decision, device)) return device;
    if (decision.kind === 'idle') forceShedSet.add(device.id);
    return { ...device, controllable: true };
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
    if (!PLANNABLE_STATUSES.has(diag.status)) continue;
    const currentBucket = diag.horizonPlan?.currentBucket;
    if (!currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0) continue;
    if (diag.targetTemperatureC === null || !Number.isFinite(diag.targetTemperatureC)) continue;
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
