/**
 * Surplus pass for the plan builder (PR-7): one call that (1) runs the
 * priority-greedy surplus allocator (`resolveSurplusEligibility` — hoisted here
 * from `buildInitialPlanDevices` so eligibility exists when the shed set is
 * assembled; `planDevices` only READS the resulting state), (2) resolves the
 * standing "Run on solar surplus" dump-load hold (`resolveSurplusHold`) with the
 * smart-task precedence exclusions, and (3) merges the three post-shedding holds
 * into the shed set and clears stale posture bookkeeping. Extracted from
 * `planBuilder.ts` so the builder keeps a single statement for the whole pass.
 *
 * Order-neutral for non-solar homes: with no willing device the allocator writes
 * no state and the hold is empty — pinned by the byte-identity integration test
 * in `test/integration/surplusDumpLoadPlan.test.ts`.
 */
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import type { PlanInputDevice } from './planTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';
import { resolveSurplusEligibility, type PriceOptDeviceConfig } from './planSurplusAbsorb';
import { resolveSurplusHold } from './shedding/surplusHold';
import { resolvePauseHold } from './shedding/pauseHold';

// Re-exported so the builder's deps typing needs no extra planSurplusAbsorb import.
export type { PriceOptDeviceConfig };

/**
 * Merge the post-shedding hold id-sets (decoration force-shed, pause-lower-priority,
 * solar dump-load) into the plan's shed set. Nested `for` (no spread allocation
 * inside a loop) per the hot-path perf rule.
 */
export function mergeHoldsIntoShedSet(shedSet: Set<string>, holds: ReadonlyArray<Iterable<string>>): void {
  for (const hold of holds) {
    for (const id of hold) shedSet.add(id);
  }
}

/**
 * Whole surplus + post-shedding-hold pass for the plan builder: resolve the
 * priority-greedy surplus allocator (hoisted here so eligibility exists when the
 * shed set is assembled), resolve the standing dump-load hold with smart-task
 * precedence, then merge the three post-shedding holds into `shedSet` and clear
 * the stale posture bookkeeping. Returns the dump-load `reasonById` for the
 * downstream reason normalization. `shedSet` is mutated in place.
 */
export function runSurplusPass(params: {
  context: PlanContext;
  state: PlanEngineState;
  admittedDevices: PlanInputDevice[];
  shedSet: Set<string>;
  decoration: Pick<
    DeferredDecorationBundle,
    'forceShedSet' | 'deferredAvoidDeviceIds' | 'deferredReleaseIntentByDeviceId' | 'admittedDeviceIds'
  >;
  getConfig: (deviceId: string) => PriceOptDeviceConfig | undefined;
  getPriority: (deviceId: string) => number;
  capacitySettings: { limitKw: number; marginKw: number };
  // Zero-export inferred curtailed-surplus term (producer:
  // `lib/solar/curtailmentSurplus.ts`), injected flat through the plan deps and
  // enlarging the same pool as measured export. Absent ⇒ measured export only.
  getInferredSurplusKw?: () => number | null;
  // Structured emitter for the `surplus_pool` composition log (debug-gated).
  debugStructured?: StructuredDebugEmitter;
  // One timestamp for the whole build, so the settle/dwell clocks and the
  // shed-decision stamps agree on the millisecond.
  nowTs: number;
}): Map<string, DeviceReason> {
  const { context, state, admittedDevices, decoration } = params;
  // Smart-task precedence set, applied at BOTH the allocation stage
  // (`resolveSurplusEligibility` — so a governed device never reserves the pool)
  // AND the hold stage (`resolveSurplusHold`). Computed once so the two stages
  // can never disagree about which devices a deferred objective governs.
  const excludeIds = new Set([
    ...decoration.forceShedSet,
    ...decoration.deferredAvoidDeviceIds,
    ...Object.keys(decoration.deferredReleaseIntentByDeviceId),
    ...decoration.admittedDeviceIds,
  ]);
  resolveSurplusEligibility({
    devices: context.devices,
    state,
    signedNetKw: context.total,
    powerKnown: context.powerKnown,
    inferredSurplusKw: params.getInferredSurplusKw?.() ?? null,
    excludeIds,
    getConfig: params.getConfig,
    getPriority: params.getPriority,
    debugStructured: params.debugStructured,
    nowTs: params.nowTs,
  });
  const surplusHold = resolveSurplusHold({ devices: admittedDevices, state, excludeIds });
  applyPostSheddingHolds({
    shedSet: params.shedSet,
    forceShedSet: decoration.forceShedSet,
    surplusHoldIds: surplusHold.holdIds,
    admittedDevices,
    state,
    context,
    capacitySettings: params.capacitySettings,
    getPriorityForDevice: params.getPriority,
  });
  return surplusHold.reasonById;
}

/**
 * Assemble the three post-shedding holds into the plan's shed set and then clear
 * the stale posture bookkeeping. (1) Proactive pause-lower-priority hold: a smart
 * task with the permission holds lower-priority managed devices off (up to — never
 * above — the hard cap) so the reserved device can start; the helper owns
 * release-on-active + the feasibility-lift. (2) Merge force-shed + pause + solar
 * dump-load holds. (3) Release a device that left the dump-load posture.
 */
export function applyPostSheddingHolds(params: {
  shedSet: Set<string>;
  forceShedSet: Iterable<string>;
  surplusHoldIds: Iterable<string>;
  admittedDevices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'surplusOnlyShedByDevice' | 'clearShedDecision'>;
  context: Pick<PlanContext, 'total' | 'powerKnown'>;
  capacitySettings: { limitKw: number; marginKw: number };
  getPriorityForDevice: (deviceId: string) => number;
}): void {
  const pauseHoldIds = resolvePauseHold({
    devices: params.admittedDevices,
    total: params.context.total,
    powerKnown: params.context.powerKnown,
    hardCapKw: params.capacitySettings.limitKw,
    marginKw: params.capacitySettings.marginKw,
    getPriorityForDevice: params.getPriorityForDevice,
  }).holdIds;
  mergeHoldsIntoShedSet(params.shedSet, [params.forceShedSet, pauseHoldIds, params.surplusHoldIds]);
  releaseAbandonedSurplusPosture({
    state: params.state, admittedDevices: params.admittedDevices, shedSet: params.shedSet,
  });
}

/**
 * Release the stale shed bookkeeping of a device that WAS surplus-held but is no
 * longer a dump-load candidate this cycle (the user toggled "Run on solar
 * surplus" off, or the device was unmanaged). Clears `shedDecidedMs` and the
 * `surplusOnlyShedByDevice` stamp so the device is no longer RECORDED as a
 * PELS-shed / dump-load device.
 *
 * Why this matters: leaving the stale stamps in place mis-attributes the device
 * as PELS-shed to the decision-time readers — the stepped-restore-blocking gate
 * (`hasOtherDevicesBlockingSteppedRestore` reads `shedDecidedMs`) and the
 * executor's capacity-control-off carve-out (`skipRestoreForSurplusPosture`
 * reads `surplusOnlyShedByDevice`) — so a later capacity-control-off or a
 * neighbouring stepped restore would branch on stale surplus state. Clearing
 * them returns the device to a clean, plainly-managed record.
 *
 * NOTE (deliberate scope): this does NOT keep a released dump load OFF. Once the
 * posture is gone the device is a plain managed binary device, and PELS's
 * generic restore lane runs off managed binary devices under available power
 * (pre-existing behaviour, independent of this feature and of `shedDecidedMs`).
 * Persisting a released dump load's OFF baseline needs a managed-restore policy
 * change and is tracked in TODO.md.
 *
 * `lastDeviceShedMs` is intentionally NOT cleared here: if PELS actually turned
 * the device off, that shed-cooldown clock is legitimate and clearing it would
 * only let the device restore sooner. Only clears a device the shed set no
 * longer holds (`!shedSet.has(id)`) — a device the posture left but that
 * capacity is still shedding keeps its decision clock (it stays shed; the
 * decision-time readers must not under-stamp it). A device that left the
 * snapshot entirely is not handled here — tracked in TODO.md.
 */
export function releaseAbandonedSurplusPosture(params: {
  state: Pick<PlanEngineState, 'surplusOnlyShedByDevice' | 'clearShedDecision'>;
  admittedDevices: PlanInputDevice[];
  shedSet: ReadonlySet<string>;
}): void {
  const { state, admittedDevices, shedSet } = params;
  const stampedIds = Object.keys(state.surplusOnlyShedByDevice);
  if (stampedIds.length === 0) return;
  const surplusOnlyNow = new Set(
    admittedDevices.filter((dev) => dev.surplusOnly === true).map((dev) => dev.id),
  );
  for (const id of stampedIds) {
    if (surplusOnlyNow.has(id)) continue; // still a dump-load device — keep the stamp
    if (shedSet.has(id)) continue; // capacity still holds it off — keep its decision clock
    state.clearShedDecision(id); // clears shedDecidedMs + the surplusOnlyShedByDevice stamp
  }
}
