import type { PlanInputDevice } from '../../../packages/planner-types/src/planInputDevice';
import type { DeferredReleaseIntent } from '../../../packages/planner-types/src/deferredDecoration';
import type { TaskEvaluation } from './taskEvaluation';

export type { DeferredReleaseIntent };

export type DeferredAdmissionDecision =
  | { kind: 'inactive'; budgetExempt: boolean; releaseIntent?: never }
  | {
      kind: 'planned';
      budgetExempt: boolean;
      engageBoost: boolean;
      // Boost-free startup reservation: the plan layer may hold this device's lowest-active-step
      // power back from lower-priority devices' admission until it starts. Distinct from
      // engageBoost — it reserves power, it does not escalate this device or shed anyone.
      reservesStartupPower: boolean;
      deadlineFloorTargetC?: number;
      releaseIntent?: 'binary_restore';
    }
  | { kind: 'idle'; budgetExempt: boolean; releaseIntent?: 'binary_release' | 'shed_release' };

export const buildDeferredDemandDeviceIds = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): ReadonlySet<string> => new Set(
  [...decisions]
    .filter(([, decision]) => decision.kind === 'planned')
    .map(([deviceId]) => deviceId),
);

// Release routing is keyed on the device's CONTROL MODALITY, not the objective
// kind — a smart task is device-agnostic (the only EV-specific thing, the SoC
// unit, lives in the objective's progress/target math, never here). A
// `binary_power` device (e.g. an EV charger) is released/resumed via its binary
// control (`binary_release` / `binary_restore`); `temperature_target` and
// `stepped_load` devices fire their configured shedBehavior (`shed_release`).
// Mirrors the "branch on control modality, not device kind" rule used elsewhere.
const usesBinaryReleaseControl = (device: PlanInputDevice | undefined): boolean => (
  device?.controlModel === 'binary_power'
);

const resolveDecision = (
  evaluation: TaskEvaluation,
  device: PlanInputDevice | undefined,
): DeferredAdmissionDecision => {
  if (evaluation.completion.kind === 'target_reached'
    || evaluation.completion.kind === 'accepted_near_target'
    || evaluation.planning.kind === 'inactive') return { kind: 'inactive', budgetExempt: false };
  const horizonPlan = evaluation.planning.plan;
  const releasesViaBinary = usesBinaryReleaseControl(device);
  // The producer resolved the claim this hour carries (`resolveCurrentHourClaim`);
  // admission maps it 1:1 and adds only the release ROUTING, which is a
  // device-modality question the producer cannot answer.
  if (horizonPlan.currentHourClaim === 'released') {
    // Released bucket: hold the device in its configured release posture. Besides
    // genuine idle hours (nothing booked here and nothing left to deliver), the claim
    // resolver (`resolveCurrentHourClaim`) also releases a booked hour for price
    // deferral (the device is already at/above this hour's trajectory milestone and
    // a later booked hour is cheaper) or cold-start release (a cold thermostat's whole
    // need fits the cheaper hours). This is a live per-cycle control decision on the
    // admission path; the clock-driven recorder is insulated, so no revision is
    // written (the device's idling re-books the cheaper hours at the next :58 settle).
    //
    // Binary-controlled devices (cap-on or cap-off): always release the binary control.
    // A device with authority of its own is ALSO held off through the planner
    // (`holdsDeviceOff`), so the plan's shed and this release agree: the smart task's
    // whole point is not to run outside planned hours.
    //
    // Non-binary cap-off: emit shed_release once so the configured shedBehavior fires. Cap-on
    // non-binary gets no release intent — emitting shed_release there would race the
    // planner's own decisions — and is held off through the planner instead
    // (`holdsDeviceOff`, `deferredHoldActive`).
    if (releasesViaBinary) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' };
    }
    if (device?.control.commandAuthority === false) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'shed_release' };
    }
    return { kind: 'idle', budgetExempt: false };
  }
  // Taking capacity from other loads (boost past the shed invariant, holding startup
  // power back from lower-priority admission) backs a promise, so it applies only
  // where the hour books energy. A hour booked at 0 kWh runs on capacity that turns
  // out to be free; escalating there would let a task take an hour a
  // higher-priority task reserved, because the boost bypasses are priority-blind.
  const promisesEnergy = (horizonPlan.currentBucket?.plannedUsefulEnergyKWh ?? 0) > 0;
  return {
    kind: 'planned',
    budgetExempt: evaluation.permissions.budgetExempt,
    engageBoost: evaluation.permissions.limitLowerPriority && promisesEnergy,
    reservesStartupPower: evaluation.permissions.pauseLowerPriority && promisesEnergy,
    ...(evaluation.targetControl.kind === 'temperature'
      ? { deadlineFloorTargetC: evaluation.targetControl.value } : {}),
    ...(releasesViaBinary ? { releaseIntent: 'binary_restore' as const } : {}),
  };
};

/** Admission consumes live evaluations; the objective controller excludes expired tasks before this seam. */
export const applyDeferredObjectiveAdmission = (
  evaluations: readonly TaskEvaluation[],
  devices: readonly PlanInputDevice[] = [],
): Map<string, DeferredAdmissionDecision> => {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const decisions = new Map<string, DeferredAdmissionDecision>();
  for (const evaluation of evaluations) {
    decisions.set(evaluation.deviceId, resolveDecision(evaluation, deviceById.get(evaluation.deviceId)));
  }
  return decisions;
};

/**
 * "Leave off until turned on again" against a smart task: the task wins (owner
 * ruling, 2026-10-06). An hour the task books LIFTS the hold for this cycle: the
 * device drops the flag here, and the executor's own hold gate reads the lift
 * (`externalOffHoldLiftedDeviceIds` → `PlanEngineState.isExternalOffHeld`).
 *
 * Lifted, never cleared. The stored hold ends the ordinary way, when the device
 * is observed on (the release sweep in `setup/homeRuntime/planDevicePrePass.ts`).
 * A booked hour PELS cannot start the device in (shed all hour, a dry run)
 * therefore leaves the hold in place for when the task is gone.
 *
 * An hour the task does not book leaves the hold alone: both want the device
 * off, and the owner's off action stays the reason shown for it.
 */
const liftsExternalOffHold = (
  decision: DeferredAdmissionDecision,
  device: PlanInputDevice,
): boolean => decision.kind === 'planned' && device.externalOffHoldActive === true;

const withoutExternalOffHold = (device: PlanInputDevice): PlanInputDevice => {
  const { externalOffHoldActive: _lifted, ...rest } = device;
  void _lifted;
  return rest;
};

/**
 * Does this task need to CONTRIBUTE authority for the device this cycle?
 *
 * Only when PELS has no standing authority over the device. With authority,
 * normal behaviour runs — the deferred plan must not bypass
 * restore admission, cooldowns, or daily-budget logic.
 *
 * This used to write `controllable: true` onto the device, i.e. runtime code
 * overwriting an owner setting mid-cycle, which forced every downstream reader
 * to know whether it ran before or after admission
 * (`lib/device/deviceActionProjection.ts` documents ordering around exactly
 * that). It now contributes a term to the derived `commandAuthority` instead, so
 * the settings stay the owner's and the ordering constraint is gone.
 */
const contributesCommandAuthority = (
  decision: DeferredAdmissionDecision,
  device: PlanInputDevice,
): boolean => (
  decision.kind !== 'inactive'
  && device.control.commandAuthority === false
  // A held device in an hour the task does not book is already off by its
  // owner's hand; there is nothing for the task to release.
  && device.externalOffHoldActive !== true
);

/**
 * A deferred hour holds a device that has command authority of its OWN (Power-limit
 * control on, or "Only PELS starts this device" in force) off, through the planner.
 *
 * During an active smart task the task decides whether the device runs, also with
 * power limiting on (owner ruling, 2026-09-25): the task may aim higher than the
 * mode would, so running as normal in an hour it skipped spends energy it has
 * scheduled for a cheaper one. This used to be left to "the planner's normal
 * lane", which had nothing to hold a stepped device with, so it ran on spare
 * capacity, and released a binary one by command while the plan kept it on.
 *
 * A device the task lends authority to (`contributesCommandAuthority`) keeps its
 * own route: force-shed with a release to its configured posture.
 */
const holdsDeviceOff = (
  decision: DeferredAdmissionDecision,
  device: PlanInputDevice,
): boolean => decision.kind === 'idle' && device.control.commandAuthority === true;

export type DeferredAdmissionInput = {
  devices: PlanInputDevice[];
  forceShedSet: Set<string>;
  /** Devices this cycle's task lends PELS authority over (`contributesCommandAuthority`). */
  lentAuthorityDeviceIds: Set<string>;
  /** Devices whose "Leave off" hold this cycle's booked hour lifts (`liftsExternalOffHold`). */
  externalOffHoldLiftedDeviceIds: Set<string>;
};

// A planned limit-lower-priority task forces the device's boost on. `resolveBoostActive`
// (`lib/plan/planBoost.ts`) honours the request wherever the producer resolved a drivable
// boost (`boostSupported`), so the existing escalation/shedding machinery claims
// capacity from lower-priority devices — whatever kind of device it is.
const resolveBoostFields = (engageBoost: boolean): { forceBoostActive?: true } => (
  engageBoost ? { forceBoostActive: true } : {}
);

// The per-device decoration spread. Hoisted out of the map callback so that callback's
// cyclomatic complexity stays within budget; each flag is only ever added when set.
// `deadlineFloorTargetC` is `undefined` when this device has no deadline floor this cycle.
const buildAdmissionDecoration = (
  device: PlanInputDevice,
  override: boolean,
  claims: DeferredHourClaims,
  deadlineFloorTargetC: number | undefined,
): Partial<PlanInputDevice> => ({
  // OR'd onto the device's current posture, never assigned: the owner's two
  // settings are untouched and only the derived per-cycle authority moves.
  ...(override ? { control: { ...device.control, commandAuthority: true } } : {}),
  ...(claims.budgetExempt ? { budgetExempt: true } : {}),
  ...resolveBoostFields(claims.engageBoost),
  ...(claims.reservesStartupPower ? { reservesStartupPower: true } : {}),
  ...(claims.liftsStartPolicyHold ? { startPolicyHoldLifted: true } : {}),
  ...(typeof deadlineFloorTargetC === 'number' ? { deadlineFloorTargetC } : {}),
});

/**
 * What this decision claims ON BEHALF of the device for this hour. Grouped
 * rather than inlined so the map callback stays within its complexity budget.
 */
type DeferredHourClaims = {
  budgetExempt: boolean;
  engageBoost: boolean;
  reservesStartupPower: boolean;
  liftsStartPolicyHold: boolean;
};

const resolveHourClaims = (
  decision: DeferredAdmissionDecision,
  device: PlanInputDevice,
): DeferredHourClaims => {
  const planned = decision.kind === 'planned';
  return {
    // The rescue budget exemption applies cap-agnostically, but only during the
    // planned current bucket. It should not turn idle/background cycles into the
    // device's standing budget-exemption setting.
    budgetExempt: decision.budgetExempt,
    // Engage the device's boost while a limit-lower-priority task is in its planned hours.
    // This reuses the existing boost machinery (EV chargers via evBoost, stepped thermal
    // devices via temperatureBoost) to escalate past the shed-invariant and claim capacity
    // from lower-priority devices — the deferred target override already commands the task's
    // target. Physical capacity stays enforced by the capacity guard.
    engageBoost: planned && decision.engageBoost,
    // Boost-free startup reservation: entitle the device to hold its lowest-active-step power
    // back from lower-priority admission until it starts. Only during planned hours (same gate
    // as engageBoost); it never sets forceBoostActive and never sheds anyone.
    reservesStartupPower: planned && decision.reservesStartupPower,
    // "Only PELS starts this device" means a smart task and nothing else, so a
    // task that books this hour is the one thing that lifts the baseline of off,
    // also when it booked it at 0 kWh (wanted on price, but the forecast left no
    // room). Lifting only hands the device to the live planner, which still admits
    // it on real capacity, so it runs only when the house has room.
    // `idle` / `released` stay held: the task decided it can finish without the
    // hour, typically waiting for a cheaper one, and lifting there would let the
    // ordinary restore lane start a device its own task chose to leave alone.
    // The policy IN FORCE, not the stored one: with Power-limit control on there
    // is no hold to lift (`resolveStartPolicyInForce`).
    // The literal, not a shared predicate: see the note on
    // `isStartPolicyHeldDevice` (`lib/plan/shedding/startPolicyHold.ts`) — the
    // boundary that separates these two readers is why the comparison is
    // duplicated, and shared-domain is not a legal home for it.
    liftsStartPolicyHold: planned && device.startPolicyInForce === 'pels_only',
  };
};

const claimsAnything = (claims: DeferredHourClaims): boolean => (
  claims.budgetExempt || claims.engageBoost || claims.reservesStartupPower || claims.liftsStartPolicyHold
);

// Translate an active deferred objective into a temporary capacity-control-on signal for the
// shedding/restore pipeline. The shedding and restore modules stay agnostic of objectives:
// they only see a managed device and (for idle hours) a seeded shed-set entry. The deadline
// thermostat floor travels on the same planned decision as the task's other claims.
export const applyDeferredAdmissionToInput = (
  devices: PlanInputDevice[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): DeferredAdmissionInput => {
  if (decisions.size === 0) {
    return {
      devices, forceShedSet: new Set(), lentAuthorityDeviceIds: new Set(), externalOffHoldLiftedDeviceIds: new Set(),
    };
  }
  const forceShedSet = new Set<string>();
  const lentAuthorityDeviceIds = new Set<string>();
  const externalOffHoldLiftedDeviceIds = new Set<string>();
  const transformed = devices.map((heldOrFree) => {
    const decision = decisions.get(heldOrFree.id);
    if (!decision) return heldOrFree;
    const liftsHold = liftsExternalOffHold(decision, heldOrFree);
    if (liftsHold) externalOffHoldLiftedDeviceIds.add(heldOrFree.id);
    const device = liftsHold ? withoutExternalOffHold(heldOrFree) : heldOrFree;
    const deadlineFloorTargetC = decision.kind === 'planned' ? decision.deadlineFloorTargetC : undefined;
    const hasDeadlineFloor = typeof deadlineFloorTargetC === 'number';
    const override = contributesCommandAuthority(decision, device);
    if (override) lentAuthorityDeviceIds.add(device.id);
    const holdsOwnAuthorityOff = holdsDeviceOff(decision, device);
    if ((override && decision.kind === 'idle') || holdsOwnAuthorityOff) forceShedSet.add(device.id);
    const claims = resolveHourClaims(decision, device);
    if (!override && !holdsOwnAuthorityOff && !hasDeadlineFloor && !claimsAnything(claims)) return device;
    return {
      ...device,
      ...buildAdmissionDecoration(device, override, claims, deadlineFloorTargetC),
      ...(holdsOwnAuthorityOff ? { deferredHoldActive: true as const } : {}),
    };
  });
  return {
    devices: transformed, forceShedSet, lentAuthorityDeviceIds, externalOffHoldLiftedDeviceIds,
  };
};

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export const buildDeferredReleaseIntents = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): Record<string, DeferredReleaseIntent> => {
  const intents: Record<string, DeferredReleaseIntent> = {};
  for (const [deviceId, decision] of decisions) {
    if (!decision.releaseIntent) continue;
    intents[deviceId] = decision.releaseIntent;
  }
  return intents;
};
/* eslint-enable functional/immutable-data */
