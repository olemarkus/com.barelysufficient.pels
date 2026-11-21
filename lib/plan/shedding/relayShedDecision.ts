import type { RelayShedDecision } from '../../planContract/executionPlan';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { phaseShare } from '../phase/phaseRoom';
import type { PhaseShedOutcome } from '../phase/phaseShedPass';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import type { MeasuredPower, PlanContext } from '../planContext';
import type { BinaryPlanInputKind } from '../../../packages/planner-types/src/planInputDevice';
import type { PlanInputDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import { resolveShedLever } from './shedLever';
import { PENDING_RELIEF_EPSILON_KW } from './pendingRelief';
import type { PlanSheddingResult } from './types';
import { resolveShedReason } from './selection';

/** Permission accompanies a final OFF only. This pass never adds a device to the shed set. */
export function resolveRelayShedDecisions(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  scalar: PlanSheddingResult,
  phase: PhaseShedOutcome,
  scalarShedAuthorized: boolean,
): Map<string, RelayShedDecision> {
  const result = new Map<string, RelayShedDecision>();
  const measuredDecision = state.isNewRelayMeterDecision(power.sampledAtMs);
  const remainingKw = (scalar.remainingDeficitKw ?? 0) - phase.additionalReliefKw;
  for (const device of context.devices) {
    if (!canShedBinary(device, context)) continue;
    const shedDecisionAtMs = selectedStamp(device.id, scalar, phase, state);
    if (shedDecisionAtMs !== undefined) result.set(device.id, { shedDecisionAtMs });
    if (device.currentOn || !measuredDecision) continue;
    const scalarApplies = scalarShedAuthorized && remainingKw > PENDING_RELIEF_EPSILON_KW
      && scalarLimitApplies(device, context, power, state);
    const phaseApplies = phase.openPhases.some((name) => phaseShare(device.phaseFootprint, name) > 0);
    if (scalarApplies || phaseApplies) {
      result.set(device.id, { shedDecisionAtMs, relayRecoveryMeterAtMs: power.sampledAtMs });
    }
  }
  return result;
}

function selectedStamp(
  id: string, scalar: PlanSheddingResult, phase: PhaseShedOutcome, state: PlanEngineState,
): number | undefined {
  if (phase.shedSet.has(id)) return state.phaseShed.decisions.get(id)?.atMs;
  if (!scalar.shedSet.has(id)) return undefined;
  const { outcome } = scalar;
  if (outcome.kind !== 'shed' && outcome.kind !== 'held') return undefined;
  return outcome.latch.decisions.get(id)?.at(-1)?.decidedAtMs;
}

function canShedBinary(device: PlanInputDevice, context: PlanContext): device is PlanInputDevice & BinaryPlanInputKind {
  return device.control.commandAuthority && isBinaryPlanDevice(device)
    && resolveShedLever(device, context.temperatureSetpoints).kind === 'binary';
}

/** A failed candidate can be paced out while its prior restrictive intent still stands.
 * Preserve that posture under the applicable pressure, without reselecting or crediting it.
 */
export function retainNoAckShedPosture(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  selected: Pick<PlanSheddingResult, 'shedSet' | 'shedReasons'>,
  relayShedDecisions: Map<string, RelayShedDecision>,
): void {
  const source = context.binding.kind === 'bound' ? context.binding.source : 'none';
  const hourSpent = state.capacityPeriodSpentFor(context);
  for (const device of context.devices) {
    if (!device.relayShedNoAck || selected.shedSet.has(device.id) || !canShedBinary(device, context)
      || !device.currentOn) continue;
    const scalarApplies = (hourSpent || (power.headroom.kind === 'on' && power.headroom.kw < 0))
      && scalarLimitApplies(device, context, power, state);
    const phase = power.phase.kind === 'off' ? undefined : power.phase.phases.find((item) => (
      item.breached && (device.phaseFootprint.kind === 'unknown' || phaseShare(device.phaseFootprint, item.phase) > 0)
    ));
    const reason: DeviceReason | undefined = scalarApplies
      ? resolveShedReason(power.gridBreached ? 'grid' : source, power.physicalLimitBreached, hourSpent)
      : phase && { code: PLAN_REASON_CODES.phaseLimit, phase: phase.phase };
    if (reason === undefined) continue;
    relayShedDecisions.set(device.id, { relayNoAckPosture: true });
    selected.shedSet.add(device.id);
    selected.shedReasons.set(device.id, reason);
  }
}

function scalarLimitApplies(
  device: PlanInputDevice, context: PlanContext, power: MeasuredPower, state: PlanEngineState,
): boolean {
  if (!device.budgetExempt || power.physicalLimitBreached) return true;
  if (state.capacityPeriodSpentFor(context)) return false;
  return context.binding.kind !== 'bound' || context.binding.source !== 'daily';
}
