import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanEngineState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { compareDeviceIdAsc } from '../planSort';
import { phaseShare } from '../phase/phaseRoom';
import type { PhaseShedOutcome } from '../phase/phaseShedPass';
import { PENDING_SHED_RELIEF_WINDOW_MS } from './pendingRelief';
import { resolveShedReason } from './selection';
import type { PlanSheddingResult, SheddingDeps } from './types';

export function readLastResortOwnedOffAtMs(
  context: PlanContext, pending: SheddingDeps['pendingBinaryCommandStore'],
): Map<string, number> {
  return new Map(context.devices.flatMap((device) => {
    const observedAtMs = device.lastResort?.observedOffAtMs;
    return device.control.commandAuthority && observedAtMs !== undefined
      && pending.ownsLastResortOff(device.id, observedAtMs, device.binarySwitchGeneration)
      ? [[device.id, pending.getLastResortOffSettledAt(device.id)] as const] : [];
  }));
}

/* eslint-disable functional/immutable-data, no-param-reassign -- This pass owns the per-home last-resort episode. */
function canEscalateLastResort(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  scalar: PlanSheddingResult,
  phase: PhaseShedOutcome,
  pending: SheddingDeps['pendingBinaryCommandStore'],
): boolean {
  if (scalar.outcome.kind === 'shed' || phase.shedSet.size > 0 || phase.storageSetpoints.size > 0) {
    state.lastResortShedWaitUntilMs = context.nowTs + PENDING_SHED_RELIEF_WINDOW_MS;
    state.lastResortShedReadingMs = Math.max(power.sampledAtMs, state.lastResortShedReadingMs);
  }
  const previous = state.lastResortPriorCutId;
  if (previous && pending.hasActiveTurnOff(previous)) {
    state.lastResortShedReadingMs = Math.max(power.sampledAtMs, state.lastResortShedReadingMs);
    return false;
  }
  const lastSettledMs = previous ? pending.getLastResortOffSettledAt(previous) : 0;
  if (previous && lastSettledMs >= state.lastResortDecisionAtMs) state.lastResortShedAttempts.add(previous);
  return context.nowTs >= state.lastResortShedWaitUntilMs
    && scalar.pendingReliefKw <= 0 && phase.additionalReliefKw <= 0
    && power.sampledAtMs > Math.max(lastSettledMs, state.lastResortShedReadingMs);
}

export function selectLastResortCut(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  scalar: PlanSheddingResult,
  phase: PhaseShedOutcome,
  pending: SheddingDeps['pendingBinaryCommandStore'],
): { deviceId: string; reason: ReturnType<typeof resolveShedReason> } | undefined {
  const hourSpent = state.capacityPeriodSpentFor(context);
  const scalarPressure = (scalar.remainingDeficitKw ?? 0) > 0 || hourSpent;
  if (!scalarPressure && phase.openPhases.length === 0) {
    if (power.headroom.kind !== 'on' || power.headroom.kw >= 0) state.lastResortShedAttempts.clear();
    return undefined;
  }
  if (!canEscalateLastResort(context, power, state, scalar, phase, pending)) return undefined;

  const candidates = context.devices.filter((device) => (
    device.lastResort !== undefined && device.control.commandAuthority && device.commandableNow
      && isBinaryPlanDevice(device) && device.currentOn === true
      && (scalarPressure || device.phaseFootprint.kind === 'unknown'
        || phase.openPhases.some((open) => phaseShare(device.phaseFootprint, open) > 0))
  )).sort((a, b) => b.priority - a.priority || compareDeviceIdAsc(a, b));
  const candidate = candidates.find(({ id }) => !state.lastResortShedAttempts.has(id));
  if (!candidate) return undefined;
  state.lastResortPriorCutId = candidate.id;
  state.lastResortDecisionAtMs = context.nowTs;
  state.lastResortShedReadingMs = power.sampledAtMs;
  state.lastResortShedWaitUntilMs = context.nowTs + PENDING_SHED_RELIEF_WINDOW_MS;
  const source = context.binding.kind === 'bound' ? context.binding.source : 'none';
  const reason = scalarPressure ? resolveShedReason(source, power.physicalLimitBreached, hourSpent)
    : { code: PLAN_REASON_CODES.gridImport };
  return { deviceId: candidate.id, reason };
}
/* eslint-enable functional/immutable-data, no-param-reassign */
