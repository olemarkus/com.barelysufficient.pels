import type { SteppedLoadActualStepSource, SteppedLoadCommandStatus } from '../utils/types';
import { normalizeStepId } from '../utils/stepIds';

type StepId = string;

type StepObservation =
  | { kind: 'reported'; stepId: StepId; source: 'native' | 'flow'; observedAtMs: number }
  | { kind: 'unknown' };

type StepIntent =
  | { kind: 'target'; stepId: StepId; changedAtMs: number; status: SteppedLoadCommandStatus }
  | { kind: 'none' };

type StepPlanningAssumption =
  | { kind: 'fallback'; stepId: StepId; reason: 'lowest_active_step' }
  | { kind: 'none' };

type RestoreStepPreparation =
  | { kind: 'prepared'; stepId: StepId; source: 'reported' | 'suppressed_flow'; observedAtMs: number }
  | { kind: 'not_prepared' };

type NormalizedSteppedLoadStepState = {
  observation: StepObservation;
  intent: StepIntent;
  planningAssumption: StepPlanningAssumption;
  restorePreparation: RestoreStepPreparation;
};

type ReportedStepEvidenceInput = {
  stepId?: string | null;
  source: 'native' | 'flow';
  observedAtMs?: number | null;
};

type TargetStepIntentInput = {
  stepId?: string | null;
  changedAtMs?: number | null;
  status?: SteppedLoadCommandStatus | null;
};

type PlanningFallbackInput = {
  stepId?: string | null;
  reason: 'lowest_active_step';
};

type SuppressedFlowStepInput = {
  stepId?: string | null;
  observedAtMs?: number | null;
};

type SuppressedFlowRestorePreparationPolicy =
  | { kind: 'disabled' }
  | { kind: 'intent_match'; maxAgeMs: number }
  | { kind: 'fresh'; maxAgeMs: number };

type NormalizeSteppedLoadStepStateParams = {
  nowMs: number;
  reportedStep?: ReportedStepEvidenceInput | null;
  targetStep?: TargetStepIntentInput | null;
  planningFallback?: PlanningFallbackInput | null;
  suppressedFlowStep?: SuppressedFlowStepInput | null;
  suppressedFlowPreparationPolicy?: SuppressedFlowRestorePreparationPolicy | null;
};

type LegacyStepFields = {
  reportedStepId?: string;
  targetStepId?: string;
  desiredStepId?: string;
  selectedStepId?: string;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  restorePreparedStepId?: string;
};

export function serializeLegacyStepFieldsFromEvidence(params: {
  nowMs: number;
  reportedStepId?: string;
  reportedStepSource: 'native' | 'flow';
  reportedObservedAtMs?: number;
  targetStepId?: string;
  targetChangedAtMs?: number;
  targetStatus?: SteppedLoadCommandStatus;
  fallbackStepId?: string;
}): LegacyStepFields {
  const state = normalizeSteppedLoadStepState({
    nowMs: params.nowMs,
    reportedStep: params.reportedStepId
      ? {
        stepId: params.reportedStepId,
        source: params.reportedStepSource,
        observedAtMs: params.reportedObservedAtMs,
      }
      : undefined,
    targetStep: params.targetStepId
      ? {
        stepId: params.targetStepId,
        changedAtMs: params.targetChangedAtMs,
        status: params.targetStatus,
      }
      : undefined,
    planningFallback: !params.reportedStepId && params.fallbackStepId
      ? {
        stepId: params.fallbackStepId,
        reason: 'lowest_active_step',
      }
      : undefined,
  });
  return serializeLegacyStepFields(state);
}

export function normalizeSteppedLoadStepState(
  params: NormalizeSteppedLoadStepStateParams,
): NormalizedSteppedLoadStepState {
  const observation = normalizeObservation(params.reportedStep, params.nowMs);
  const intent = normalizeIntent(params.targetStep, params.nowMs);
  const planningAssumption = normalizePlanningAssumption(params.planningFallback);
  return {
    observation,
    intent,
    planningAssumption,
    restorePreparation: resolveRestorePreparation({
      observation,
      intent,
      suppressedFlowStep: params.suppressedFlowStep,
      policy: params.suppressedFlowPreparationPolicy ?? { kind: 'disabled' },
      nowMs: params.nowMs,
    }),
  };
}

export function resolveEffectiveStepId(state: NormalizedSteppedLoadStepState): StepId | 'unknown' {
  if (state.observation.kind === 'reported') return state.observation.stepId;
  if (state.planningAssumption.kind === 'fallback') return state.planningAssumption.stepId;
  return 'unknown';
}

export function serializeLegacyStepFields(state: NormalizedSteppedLoadStepState): LegacyStepFields {
  const effectiveStepId = resolveEffectiveStepId(state);
  const reportedStepId = state.observation.kind === 'reported' ? state.observation.stepId : undefined;
  const targetStepId = state.intent.kind === 'target' ? state.intent.stepId : undefined;
  const assumedStepId = state.planningAssumption.kind === 'fallback'
    ? state.planningAssumption.stepId
    : undefined;
  const restorePreparedStepId = state.restorePreparation.kind === 'prepared'
    ? state.restorePreparation.stepId
    : undefined;
  return {
    reportedStepId,
    targetStepId,
    desiredStepId: targetStepId,
    selectedStepId: effectiveStepId === 'unknown' ? undefined : effectiveStepId,
    actualStepId: reportedStepId,
    assumedStepId,
    actualStepSource: resolveActualStepSource({ reportedStepId, assumedStepId }),
    restorePreparedStepId,
  };
}

function normalizeObservation(
  evidence: ReportedStepEvidenceInput | null | undefined,
  nowMs: number,
): StepObservation {
  const stepId = normalizeStepId(evidence?.stepId);
  if (!stepId || !evidence) return { kind: 'unknown' };
  return {
    kind: 'reported',
    stepId,
    source: evidence.source,
    observedAtMs: normalizeTimestamp(evidence.observedAtMs, nowMs),
  };
}

function normalizeIntent(
  evidence: TargetStepIntentInput | null | undefined,
  nowMs: number,
): StepIntent {
  const stepId = normalizeStepId(evidence?.stepId);
  if (!stepId) return { kind: 'none' };
  return {
    kind: 'target',
    stepId,
    changedAtMs: normalizeTimestamp(evidence?.changedAtMs, nowMs),
    status: evidence?.status ?? 'idle',
  };
}

function normalizePlanningAssumption(
  fallback: PlanningFallbackInput | null | undefined,
): StepPlanningAssumption {
  const stepId = normalizeStepId(fallback?.stepId);
  if (!stepId || !fallback) return { kind: 'none' };
  return {
    kind: 'fallback',
    stepId,
    reason: fallback.reason,
  };
}

function resolveRestorePreparation(params: {
  observation: StepObservation;
  intent: StepIntent;
  suppressedFlowStep: SuppressedFlowStepInput | null | undefined;
  policy: SuppressedFlowRestorePreparationPolicy;
  nowMs: number;
}): RestoreStepPreparation {
  const { observation, intent, suppressedFlowStep, policy, nowMs } = params;
  if (observation.kind === 'reported') {
    return {
      kind: 'prepared',
      stepId: observation.stepId,
      source: 'reported',
      observedAtMs: observation.observedAtMs,
    };
  }
  const suppressed = normalizeSuppressedFlowStep(suppressedFlowStep);
  if (!suppressed || policy.kind === 'disabled') return { kind: 'not_prepared' };
  if (!isFreshEnough({ observedAtMs: suppressed.observedAtMs, nowMs, maxAgeMs: policy.maxAgeMs })) {
    return { kind: 'not_prepared' };
  }
  if (policy.kind === 'intent_match') {
    if (intent.kind !== 'target') return { kind: 'not_prepared' };
    if (intent.stepId !== suppressed.stepId) return { kind: 'not_prepared' };
    if (suppressed.observedAtMs < intent.changedAtMs) return { kind: 'not_prepared' };
  }
  return {
    kind: 'prepared',
    stepId: suppressed.stepId,
    source: 'suppressed_flow',
    observedAtMs: suppressed.observedAtMs,
  };
}

function normalizeSuppressedFlowStep(
  evidence: SuppressedFlowStepInput | null | undefined,
): { stepId: StepId; observedAtMs: number } | null {
  const stepId = normalizeStepId(evidence?.stepId);
  if (!stepId || !Number.isFinite(evidence?.observedAtMs)) return null;
  return {
    stepId,
    observedAtMs: Number(evidence?.observedAtMs),
  };
}

function isFreshEnough(params: { observedAtMs: number; nowMs: number; maxAgeMs: number }): boolean {
  const { observedAtMs, nowMs, maxAgeMs } = params;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  if (observedAtMs > nowMs) return false;
  return nowMs - observedAtMs <= maxAgeMs;
}

function normalizeTimestamp(value: number | null | undefined, fallbackMs: number): number {
  return Number.isFinite(value) ? Number(value) : fallbackMs;
}

function resolveActualStepSource(params: {
  reportedStepId: string | undefined;
  assumedStepId: string | undefined;
}): SteppedLoadActualStepSource | undefined {
  if (params.reportedStepId) return 'reported';
  if (params.assumedStepId) return 'assumed';
  return undefined;
}
