/**
 * Surplus pass for the plan builder (PR-7): one call that (1) runs the
 * priority-greedy surplus allocator (`resolveSurplusEligibility` — hoisted here
 * from `buildInitialPlanDevices` so eligibility exists when the shed set is
 * assembled; `planDevices` only READS the resulting state), (2) resolves the
 * standing "Run on solar surplus" dump-load hold (`resolveSurplusHold`) with the
 * smart-task precedence exclusions, and (3) merges the post-shedding holds
 * into the shed set and clears stale posture bookkeeping. Extracted from
 * `planBuilder.ts` so the builder keeps a single statement for the whole pass.
 *
 * Order-neutral for non-solar homes: with no willing device the allocator writes
 * no state and the hold is empty — pinned by the byte-identity integration test
 * in `test/integration/surplusDumpLoadPlan.test.ts`.
 */
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';
import type { ShedDecisions } from './shedDecisions';
import type { MeasuredPower, PlanContext } from './planContext';
import type { PlanInputDevice } from './planTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';
import { resolveSurplusEligibility, withdrawSurplusEligibility, type PriceOptDeviceConfig } from './planSurplusAbsorb';
import { resolveSurplusHold } from './shedding/surplusHold';
import { resolveStartPolicyHold } from './shedding/startPolicyHold';

// Re-exported so the builder's deps typing needs no extra planSurplusAbsorb import.
export type { PriceOptDeviceConfig };

/**
 * Merge the post-shedding hold id-sets (decoration force-shed, solar dump-load)
 * into the plan's shed set. Nested `for` (no spread allocation inside a loop)
 * per the hot-path perf rule.
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
 * precedence, then merge the post-shedding holds into `shedSet` and clear
 * the stale posture bookkeeping. Returns the dump-load `reasonById` for the
 * downstream reason normalization. `shedSet` is mutated in place.
 */
export function runStandingPostureHolds(params: {
  context: PlanContext;
  power: MeasuredPower;
  state: PlanEngineState;
  admittedDevices: PlanInputDevice[];
  shedSet: Set<string>;
  /** The shedding plan's decided rungs; a solar stop clears its own. */
  shedStepTargets: Map<string, string>;
  decoration: Pick<
    DeferredDecorationBundle,
    'forceShedSet' | 'deferredAvoidDeviceIds' | 'deferredReleaseIntentByDeviceId' | 'admittedDeviceIds'
  >;
  getConfig: (deviceId: string) => PriceOptDeviceConfig | undefined;
  // Zero-export inferred curtailed-surplus term (kW, >= 0; producer:
  // `lib/solar/curtailmentSurplus.ts`), injected flat through the plan deps and
  // enlarging the same pool as measured export. 0 ⇒ measured export only.
  getInferredSurplusKw: () => number;
  // Structured emitter for the `surplus_pool` composition log (debug-gated).
  debugStructured?: StructuredDebugEmitter;
  // One timestamp for the whole build, so the settle/dwell clocks and the
  // shed-decision stamps agree on the millisecond.
  nowTs: number;
}): Map<string, DeviceReason> {
  const { context, power, state, admittedDevices, decoration } = params;
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
    // Producer-resolved pair: the signed net is always a number (the carried
    // reading), and the allocator gates every raise on the measured flag.
    signedNetKw: power.drawKw,
    inferredSurplusKw: params.getInferredSurplusKw(),
    excludeIds,
    getConfig: params.getConfig,
    debugStructured: params.debugStructured,
    nowTs: params.nowTs,
  });
  const surplusHold = resolveSurplusHold(admittedDevices, state, excludeIds);
  // The second standing posture. It reads each device's own `startPolicyHoldLifted`
  // rather than `excludeIds`: a device its own task left idle this hour must stay
  // held, which is the difference between "only PELS starts it" and "any governing
  // task starts it". See `resolveStartPolicyHold`.
  const startPolicyHold = resolveStartPolicyHold(admittedDevices);
  applyPostSheddingHolds({
    shedSet: params.shedSet,
    shedStepTargets: params.shedStepTargets,
    forceShedSet: decoration.forceShedSet,
    surplusHoldIds: new Set([...surplusHold.holdIds, ...startPolicyHold.holdIds]),
    admittedDevices,
    shedDecisions: state.shedDecisions,
  });
  // Merged into one map because reason normalization asks one question of it:
  // "did a standing posture hold this device this cycle?".
  //
  // The two DO overlap: `isSurplusHeldDevice` covers `surplusTracking` steppers
  // as well as `surplusOnly` dump loads, and either can also carry the start
  // policy. When both hold the same device the start policy wins — the device
  // stays shed even once surplus arrives — and that is the owner's ruling
  // (2026-09-10): "Only PELS starts this device" means a smart task and nothing
  // else, so solar surplus is not a PELS start. The start-policy reason is
  // therefore written SECOND, so the CARD names the posture that is actually
  // holding the device. Writing the surplus reason last read "Waiting for solar
  // surplus" on a device that would never start when surplus arrived, sending the
  // owner to tune an export threshold that could not release it. Locking the two
  // toggles against each other in the settings UI is the open follow-up.
  return new Map([...surplusHold.reasonById, ...startPolicyHold.reasonById]);
}

/**
 * Drop the shedding planner's decided rung for a device the solar posture stops.
 *
 * Both lanes can pick the same device in one build: `selectShedDevices` runs
 * first and may price a capacity shed at a gentle rung, and the surplus hold is
 * merged afterwards. Materialization delivers the decided rung and reads the
 * configured shed action only when none was decided
 * (`resolveSteppedLoadDirectShedStepId`), so leaving the capacity rung in place
 * would dilute the stop to whatever capacity happened to need — a charger parked
 * at 10 A, importing from the grid, under a card reading "Waiting for solar
 * surplus". Clearing it hands the question back to the configured shed action,
 * which is this PR's whole point: a solar stop parks where a capacity stop
 * parks. The action's floor is the deepest the cycle may go and a priced rung
 * never sits below it, so this can only ever deepen the shed, never soften it.
 *
 * Only a stepped device can carry an entry, so the binary dump loads in the same
 * id-set delete nothing.
 */
/**
 * The silent-meter pass's surplus stage: no measurement, so no surplus —
 * eligibility is withdrawn for every willing device and the standing
 * dump-load hold engages for each surplus-only device, exactly as a
 * collapsed surplus would hold it. Returns the hold reasons the pass writes
 * onto those devices (it runs no reason-normalization stage).
 */
export function runSilentMeterSurplusHold(
  context: PlanContext,
  state: PlanEngineState,
  admittedDevices: PlanInputDevice[],
  shedSet: Set<string>,
  shedStepTargets: Map<string, string>,
  decoration: Pick<
    DeferredDecorationBundle,
    'forceShedSet' | 'deferredAvoidDeviceIds' | 'deferredReleaseIntentByDeviceId' | 'admittedDeviceIds'
  >,
  cycle: { getConfig: (deviceId: string) => PriceOptDeviceConfig | undefined; nowTs: number },
): Map<string, DeviceReason> {
  const excludeIds = new Set([
    ...decoration.forceShedSet,
    ...decoration.deferredAvoidDeviceIds,
    ...Object.keys(decoration.deferredReleaseIntentByDeviceId),
    ...decoration.admittedDeviceIds,
  ]);
  withdrawSurplusEligibility(context.devices, state, cycle.getConfig, excludeIds, cycle.nowTs);
  const surplusHold = resolveSurplusHold(admittedDevices, state, excludeIds);
  // BOTH standing postures, here as on the measured path. A standing posture is
  // not capacity pressure, so a missing meter does not change what it decides —
  // and the start policy's floor is OFF, not the owner's power-limiting floor.
  // Without it the fail-closed directive shed a `pels_only` charger to its
  // configured rung, and the composed gate then blocks every rebuild until a
  // sample returns, so it kept drawing there for the whole outage.
  const startPolicyHold = resolveStartPolicyHold(admittedDevices);
  applyPostSheddingHolds({
    shedSet,
    shedStepTargets,
    forceShedSet: decoration.forceShedSet,
    surplusHoldIds: new Set([...surplusHold.holdIds, ...startPolicyHold.holdIds]),
    admittedDevices,
    shedDecisions: state.shedDecisions,
  });
  // Start policy written second, so it wins the card — the same precedence the
  // measured pass applies.
  return new Map([...surplusHold.reasonById, ...startPolicyHold.reasonById]);
}

function clearShedStepTargets(
  shedStepTargets: Map<string, string>,
  surplusHoldIds: Iterable<string>,
): void {
  for (const id of surplusHoldIds) shedStepTargets.delete(id);
}

/**
 * Merge the post-shedding holds into the plan's shed set and then clear the stale
 * posture bookkeeping. (1) Merge the decoration force-shed and solar dump-load
 * holds. (2) Release a device that left the dump-load posture.
 *
 * Note there is deliberately no lane here that sheds devices on another device's
 * behalf. The smart-task "pause lower-priority devices" permission used to add one
 * (`resolvePauseHold`), which selected every lower-priority managed device — idle
 * ones included, for zero relief. It is now an admission term instead:
 * `lib/plan/admission/headroomReserve.ts` holds power back from lower-priority
 * devices' admission without shedding anyone.
 */
export function applyPostSheddingHolds(params: {
  shedSet: Set<string>;
  shedStepTargets: Map<string, string>;
  forceShedSet: Iterable<string>;
  surplusHoldIds: Iterable<string>;
  admittedDevices: PlanInputDevice[];
  shedDecisions: ShedDecisions;
}): void {
  mergeHoldsIntoShedSet(params.shedSet, [params.forceShedSet, params.surplusHoldIds]);
  clearShedStepTargets(params.shedStepTargets, params.surplusHoldIds);
  releaseAbandonedSurplusPosture({
    shedDecisions: params.shedDecisions, admittedDevices: params.admittedDevices, shedSet: params.shedSet,
  });
}

/**
 * Release the stale shed bookkeeping of a device that WAS surplus-held but is no
 * longer a dump-load candidate this cycle (the user toggled "Run on solar
 * surplus" off, or the device was unmanaged). Clears `shedDecisions.decidedMs` and the
 * `shedDecisions.surplusOnlyByDevice` stamp so the device is no longer RECORDED as a
 * PELS-shed / dump-load device.
 *
 * Why this matters: leaving the stale stamps in place mis-attributes the device
 * as PELS-shed to the decision-time readers — the stepped-restore-blocking gate
 * (`hasOtherDevicesBlockingSteppedRestore` reads `shedDecisions.decidedMs`) and the
 * executor's capacity-control-off carve-out (`skipRestoreForSurplusPosture`
 * reads `shedDecisions.surplusOnlyByDevice`) — so a later capacity-control-off or a
 * neighbouring stepped restore would branch on stale surplus state. Clearing
 * them returns the device to a clean, plainly-managed record.
 *
 * NOTE (deliberate scope): this does NOT keep a released dump load OFF. Once the
 * posture is gone the device is a plain managed binary device, and PELS's
 * generic restore lane runs off managed binary devices under available power
 * (pre-existing behaviour, independent of this feature and of `shedDecisions.decidedMs`).
 * Persisting a released dump load's OFF baseline needs a managed-restore policy
 * change and is deliberately out of scope here.
 *
 * `lastDeviceShedMs` is intentionally NOT cleared here: if PELS actually turned
 * the device off, that shed-cooldown clock is legitimate and clearing it would
 * only let the device restore sooner. Only clears a device the shed set no
 * longer holds (`!shedSet.has(id)`) — a device the posture left but that
 * capacity is still shedding keeps its decision clock (it stays shed; the
 * decision-time readers must not under-stamp it).
 *
 * A device that left the SNAPSHOT entirely is covered, and the loop shape is why:
 * it iterates the stamp map, not `admittedDevices`. An absent device is in
 * neither `surplusOnlyNow` nor `shedSet`, so it falls through both guards to the
 * clear. An earlier version of this comment wrongly said the case was unhandled;
 * that was a misreading of this loop, and the two prune pins in
 * `test/integration/surplusDumpLoadPlan.test.ts` exist so it cannot be made true
 * by accident.
 */
export function releaseAbandonedSurplusPosture(params: {
  shedDecisions: ShedDecisions;
  admittedDevices: PlanInputDevice[];
  shedSet: ReadonlySet<string>;
}): void {
  const { shedDecisions, admittedDevices, shedSet } = params;
  const stampedIds = Object.keys(shedDecisions.surplusOnlyByDevice);
  if (stampedIds.length === 0) return;
  // EITHER baseline-off posture keeps the stamp alive, matching what stamps it
  // (`ShedDecisions.recordPlannedShed`). A `pels_only` device the owner has just
  // opted OUT of is in neither set and falls through to the clear, which is the
  // whole point: without it the stale decision let the uncontrolled-restore lane
  // force the device ON as PELS's last act before losing authority.
  const baselineOffNow = new Set(
    admittedDevices
      .filter((dev) => dev.surplusOnly === true || dev.startPolicy === 'pels_only')
      .map((dev) => dev.id),
  );
  for (const id of stampedIds) {
    if (baselineOffNow.has(id)) continue; // still a baseline-off device — keep the stamp
    if (shedSet.has(id)) continue; // capacity still holds it off — keep its decision clock
    shedDecisions.clearFor(id); // clears the decision clock + the surplus stamp
  }
}
