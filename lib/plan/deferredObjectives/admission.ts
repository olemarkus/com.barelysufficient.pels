import type { PlanInputDevice } from '../planTypes';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

export type DeferredAdmissionDecision =
  | { kind: 'inactive' }
  | { kind: 'planned'; requestedMinimumStepId: string | null }
  | { kind: 'idle' };

// `satisfied` and `cannot_meet` deliberately fall back to inactive: when the goal is met or
// physically impossible, the deferred objective should not keep forcing the device on or off.
const PLANNABLE_STATUSES = new Set<DeferredObjectiveDiagnostic['status']>([
  'on_track',
  'at_risk',
]);

const resolveDecision = (
  diagnostic: DeferredObjectiveDiagnostic,
): DeferredAdmissionDecision => {
  if (!PLANNABLE_STATUSES.has(diagnostic.status)) return { kind: 'inactive' };
  const horizonPlan = diagnostic.horizonPlan;
  if (!horizonPlan) return { kind: 'inactive' };
  const currentBucket = horizonPlan.currentBucket;
  if (!currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0) {
    return { kind: 'idle' };
  }
  return {
    kind: 'planned',
    requestedMinimumStepId: currentBucket.requestedMinimumStepId,
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

