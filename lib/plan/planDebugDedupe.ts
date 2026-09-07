import { roundLogValue } from '../logging/logDedupe';
import { getDebugEmitter, isDebugTopicEnabled } from '../logging/logger';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';

const emitPlanDebug = getDebugEmitter('plan', 'plan');

export function emitRestoreDebugEventOnChange(params: {
  state: PlanEngineState;
  key: string;
  payload: Record<string, unknown>;
  signaturePayload?: Record<string, unknown>;
  /** The threaded plan emitter, while callers still forward one. Omitting it is
   *  equivalent — the fallback is the same `plan`-topic channel — and every
   *  caller may drop it when `lib/plan/restore` migrates off the parameter.
   *  Until then it must stay a `plan`-topic emitter: the gate below names that
   *  topic, so an emitter carrying a different one would be gated by `plan` and
   *  stamped with something else. */
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { state, key, payload, signaturePayload, debugStructured } = params;
  // Skip the recursive normalization + JSON.stringify when the topic is off.
  // Whether an emitter was passed says nothing about that: the plan wiring
  // hands one to every caller unconditionally and the topic check lives inside
  // it, so the previous presence gate was always open and this walked and
  // stringified a payload on every restore decision with `plan` switched off.
  if (!isDebugTopicEnabled('plan')) return;
  const signature = JSON.stringify(normalizeSignatureValue(signaturePayload ?? payload));
  if (state.restoreDecisionLogByKey[key] === signature) return;
  const restoreDecisionLogByKey = state.restoreDecisionLogByKey;
  restoreDecisionLogByKey[key] = signature;
  (debugStructured ?? emitPlanDebug)(payload);
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
