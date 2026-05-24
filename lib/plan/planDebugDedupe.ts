import { roundLogValue } from '../logging/logDedupe';
import { getLogger } from '../logging/logger';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';

const logger = getLogger('plan/debug-dedupe');

export function emitRestoreDebugEventOnChange(params: {
  state: PlanEngineState;
  key: string;
  payload: Record<string, unknown>;
  signaturePayload?: Record<string, unknown>;
  /** Deprecated. Pass-through still accepted while callers migrate to the
   *  module logger; future chips drop this. New callers should omit it. */
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { state, key, payload, signaturePayload, debugStructured } = params;
  // Skip the recursive normalization + JSON.stringify when nothing would
  // emit anyway. Module-logger path uses pino's level check (cheap); the
  // legacy debugStructured path is presence-gated (the caller hands us a
  // function only when the topic is enabled).
  const willEmit = debugStructured !== undefined || logger.isLevelEnabled('debug');
  if (!willEmit) return;
  const signature = JSON.stringify(normalizeSignatureValue(signaturePayload ?? payload));
  if (state.restoreDecisionLogByKey[key] === signature) return;
  const restoreDecisionLogByKey = state.restoreDecisionLogByKey;
  restoreDecisionLogByKey[key] = signature;
  if (debugStructured) {
    debugStructured(payload);
  } else {
    logger.debug(payload);
  }
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
