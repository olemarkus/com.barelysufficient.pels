import { roundLogValue } from '../logging/logDedupe';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';

export function emitRestoreDebugEventOnChange(params: {
  state: PlanEngineState;
  key: string;
  payload: Record<string, unknown>;
  signaturePayload?: Record<string, unknown>;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { state, key, payload, signaturePayload, debugStructured } = params;
  const signature = JSON.stringify(normalizeSignatureValue(signaturePayload ?? payload));
  if (state.restoreDecisionLogByKey[key] === signature) return;
  if (!debugStructured) return;
  const restoreDecisionLogByKey = state.restoreDecisionLogByKey;
  restoreDecisionLogByKey[key] = signature;
  debugStructured(payload);
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
