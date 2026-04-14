import { roundLogValue } from '../logging/logDedupe';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';
import { normalizePlanReason } from './planLogging';

export function emitRestoreDebugEventOnChange(params: {
  state: PlanEngineState;
  key: string;
  payload: Record<string, unknown>;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { state, key, payload, debugStructured } = params;
  const signature = JSON.stringify(normalizeSignatureValue(payload));
  if (state.restoreDecisionLogByKey[key] === signature) return;
  if (!debugStructured) return;
  state.restoreDecisionLogByKey[key] = signature;
  debugStructured(payload);
}

export function clearRestoreDebugEvent(state: PlanEngineState, key: string): void {
  delete state.restoreDecisionLogByKey[key];
}

function normalizeSignatureValue(value: unknown, fieldName?: string): unknown {
  if (typeof value === 'number') return roundLogValue(value, 2);
  if (typeof value === 'string') {
    if (fieldName === 'reason' || fieldName === 'decisionReason') {
      return normalizePlanReason(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSignatureValue(entry));
  }
  if (!value || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'remainingMs');
  return Object.fromEntries(
    entries.map(([key, entryValue]) => [key, normalizeSignatureValue(entryValue, key)]),
  );
}
