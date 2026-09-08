import { roundLogValue } from '../logging/logDedupe';
import { getDebugEmitter, isDebugTopicEnabled } from '../logging/logger';
import type { PlanEngineState } from './planState';

const emitPlanDebug = getDebugEmitter('plan', 'plan');

export function emitRestoreDebugEventOnChange(params: {
  state: PlanEngineState;
  key: string;
  payload: Record<string, unknown>;
  signaturePayload?: Record<string, unknown>;
}): void {
  const { state, key, payload, signaturePayload } = params;
  // Skip the recursive normalization + JSON.stringify when the topic is off.
  // The gate and the sink now name one topic, so they cannot disagree about
  // which events this function may emit — while callers threaded their own
  // emitter in, nothing stopped one carrying a different topic from being
  // gated by `plan` and stamped with something else.
  if (!isDebugTopicEnabled('plan')) return;
  const signature = JSON.stringify(normalizeSignatureValue(signaturePayload ?? payload));
  if (state.restoreDecisionLogByKey[key] === signature) return;
  const restoreDecisionLogByKey = state.restoreDecisionLogByKey;
  restoreDecisionLogByKey[key] = signature;
  emitPlanDebug(payload);
}

export function clearRestoreDebugEvent(state: PlanEngineState, key: string): void {
  const restoreDecisionLogByKey = state.restoreDecisionLogByKey;
  delete restoreDecisionLogByKey[key];
}

function normalizeSignatureValue(value: unknown): unknown {
  if (typeof value === 'number') return roundLogValue(value, 2);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSignatureValue(entry));
  }
  if (!value || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'remainingMs');
  return Object.fromEntries(
    entries.map(([key, entryValue]) => [key, normalizeSignatureValue(entryValue)]),
  );
}
