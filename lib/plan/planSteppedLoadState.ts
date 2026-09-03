import type { SteppedLoadCommandStatus } from '../../packages/contracts/src/types';
import { normalizeStepId } from '../utils/stepIds';

type StepId = string;

export type StepObservation =
  | { kind: 'reported'; stepId: StepId; source: 'native' | 'flow'; observedAtMs: number }
  | { kind: 'unknown' };

export type StepIntent =
  | { kind: 'target'; stepId: StepId; changedAtMs: number; status: SteppedLoadCommandStatus }
  | { kind: 'none' };

export type StepPlanningAssumption =
  | { kind: 'fallback'; stepId: StepId; reason: 'lowest_active_step' }
  | { kind: 'none' };

export type RestoreStepPreparation =
  | { kind: 'prepared'; stepId: StepId; source: 'reported'; observedAtMs: number }
  | { kind: 'not_prepared' };

export type NormalizedSteppedLoadStepState = {
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

type NormalizeSteppedLoadStepStateParams = {
  nowMs: number;
  reportedStep?: ReportedStepEvidenceInput | null;
  targetStep?: TargetStepIntentInput | null;
  planningFallback?: PlanningFallbackInput | null;
};

/**
 * The resolved stepped-load step fields a producer materializes onto a
 * snapshot / plan device. `selectedStepId` is the producer-resolved EFFECTIVE
 * step (`reportedStepId ?? planning fallback`). The legacy raw-evidence trio
 * (`actualStepId` / `assumedStepId` / `actualStepSource`) was retired; the
 * discriminated `NormalizedSteppedLoadStepState` is the only carrier of that
 * provenance now.
 */
type SteppedLoadStepFields = {
  reportedStepId?: string;
  targetStepId?: string;
  desiredStepId?: string;
  selectedStepId?: string;
  restorePreparedStepId?: string;
};

export type LegacySteppedLoadStepFieldsInput = {
  reportedStepId?: string | null;
  targetStepId?: string | null;
  desiredStepId?: string | null;
  selectedStepId?: string | null;
  restorePreparedStepId?: string | null;
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
}): SteppedLoadStepFields {
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
    restorePreparation: resolveRestorePreparation(observation),
  };
}

export function normalizeSteppedLoadStepStateFromLegacyFields(params: {
  fields: LegacySteppedLoadStepFieldsInput;
  nowMs?: number;
  selectedStepFallbackIsPlanningAssumption?: boolean;
}): NormalizedSteppedLoadStepState {
  const {
    fields,
    selectedStepFallbackIsPlanningAssumption = true,
  } = params;
  const nowMs = params.nowMs ?? 0;
  const reportedStepId = normalizeStepId(fields.reportedStepId);
  const targetStepId = normalizeStepId(fields.targetStepId) ?? normalizeStepId(fields.desiredStepId);
  // When there is no reported step, the producer-resolved `selectedStepId` is
  // the planning fallback (the lowest active step). It is the only fallback
  // carrier now that the raw `assumedStepId` evidence field is retired.
  const fallbackStepId = selectedStepFallbackIsPlanningAssumption && !reportedStepId
    ? normalizeStepId(fields.selectedStepId)
    : undefined;
  const restorePreparedStepId = normalizeStepId(fields.restorePreparedStepId);
  const state = normalizeSteppedLoadStepState({
    nowMs,
    reportedStep: reportedStepId
      ? {
        stepId: reportedStepId,
        source: 'flow',
        observedAtMs: nowMs,
      }
      : undefined,
    targetStep: targetStepId
      ? {
        stepId: targetStepId,
        changedAtMs: nowMs,
        status: 'idle',
      }
      : undefined,
    planningFallback: fallbackStepId
      ? {
        stepId: fallbackStepId,
        reason: 'lowest_active_step',
      }
      : undefined,
  });
  if (!restorePreparedStepId) return state;
  return {
    ...state,
    restorePreparation: {
      kind: 'prepared',
      stepId: restorePreparedStepId,
      source: 'reported',
      observedAtMs: nowMs,
    },
  };
}

export function resolveEffectiveStepId(state: NormalizedSteppedLoadStepState): StepId | 'unknown' {
  if (state.observation.kind === 'reported') return state.observation.stepId;
  if (state.planningAssumption.kind === 'fallback') return state.planningAssumption.stepId;
  return 'unknown';
}

export function resolveKnownEffectiveStepId(state: NormalizedSteppedLoadStepState): StepId | undefined {
  const effectiveStepId = resolveEffectiveStepId(state);
  return effectiveStepId === 'unknown' ? undefined : effectiveStepId;
}

export function isReportedStep(state: NormalizedSteppedLoadStepState, stepId: string | undefined): boolean {
  return state.observation.kind === 'reported' && state.observation.stepId === stepId;
}

export function serializeLegacyStepFields(state: NormalizedSteppedLoadStepState): SteppedLoadStepFields {
  const effectiveStepId = resolveEffectiveStepId(state);
  const reportedStepId = state.observation.kind === 'reported' ? state.observation.stepId : undefined;
  const targetStepId = state.intent.kind === 'target' ? state.intent.stepId : undefined;
  const restorePreparedStepId = state.restorePreparation.kind === 'prepared'
    ? state.restorePreparation.stepId
    : undefined;
  return {
    reportedStepId,
    targetStepId,
    desiredStepId: targetStepId,
    selectedStepId: effectiveStepId === 'unknown' ? undefined : effectiveStepId,
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

// A step is prepared for restore when the device REPORTED it. There is no age
// test and no second evidence source: `lib/plan` holds no concept of observation
// freshness, and a reported step is the trusted last-known step however long ago
// it arrived (`lib/observer/AGENTS.md` — silence means "unchanged").
function resolveRestorePreparation(observation: StepObservation): RestoreStepPreparation {
  if (observation.kind !== 'reported') return { kind: 'not_prepared' };
  return {
    kind: 'prepared',
    stepId: observation.stepId,
    source: 'reported',
    observedAtMs: observation.observedAtMs,
  };
}

function normalizeTimestamp(value: number | null | undefined, fallbackMs: number): number {
  return Number.isFinite(value) ? Number(value) : fallbackMs;
}
