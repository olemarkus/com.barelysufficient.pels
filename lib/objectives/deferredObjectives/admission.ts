import { resolvedTrajectoryStatus } from './diagnosticTypes';
import type { PlanInputDevice } from '../../../packages/planner-types/src/planInputDevice';
import type { DeferredReleaseIntent } from '../../../packages/planner-types/src/deferredDecoration';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

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
      expectedStepId: string | null;
      releaseIntent?: 'binary_restore';
    }
  | { kind: 'idle'; budgetExempt: boolean; releaseIntent?: 'binary_release' | 'shed_release' }
  // The task booked nothing into this hour but is still short on the hours it did
  // book, so it neither claims the hour nor gives it up. The device is handed to
  // the planner as managed and then competes on its own priority like any other
  // load — no forced shed, no release intent, no deadline floor, and none of the
  // rescue claims a planned hour carries. See `resolveCurrentHourClaim`.
  // `releaseIntent?: never` is the load-bearing half: not claiming an hour must never
  // command the device anywhere, so this kind cannot carry one even by accident.
  | { kind: 'unclaimed'; budgetExempt: false; releaseIntent?: never };

// `satisfied` falls back to inactive: the goal is met, so the objective should
// not keep forcing the device on. `cannot_meet` still drives the device — the
// planner's lowest-step allocation is what we _can_ deliver, not a reason to
// stop trying; runtime is free to step up when headroom appears, so a
// hard-cap miss should still get us as close to the target as possible.
const PLANNABLE_STATUSES = new Set<ReturnType<typeof resolvedTrajectoryStatus>>([
  'on_track',
  'at_risk',
  'cannot_meet',
]);

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
  diagnostic: DeferredObjectiveDiagnostic,
  device: PlanInputDevice | undefined,
): DeferredAdmissionDecision => {
  // Producer-resolved flat flag: the smart task's exempt-from-budget permission is active
  // for the current planned bucket. Idle/background cycles must not inherit a standing
  // budget exemption from a future planned bucket.
  const plannable = PLANNABLE_STATUSES.has(resolvedTrajectoryStatus(diagnostic));
  const budgetExempt = diagnostic.budgetExemptApplied === true && plannable;
  // The limit-lower-priority permission engages the device's boost, but only while the task
  // is in its planned hours (the 'planned' decision below) — so it claims capacity from
  // lower-priority devices only when it is actually scheduled to run.
  const engageBoost = diagnostic.limitLowerPriorityApplied === true && plannable;
  // Boost-free sibling of engageBoost: the pause-lower-priority permission entitles the device to
  // reserve the power it needs to start, so cycling loads cannot nibble the block away. The plan
  // layer (lib/plan/admission/headroomReserve.ts) owns the amount, the release, and the bound —
  // here we only surface the granted intent for planned hours.
  const reservesStartupPower = diagnostic.pauseLowerPriorityApplied === true && plannable;
  if (!plannable) {
    // Terminal fallback actuation belongs exclusively to the lifecycle clock. In particular,
    // `handleDeferredSatisfied` retries cap-off devices until their fallback posture is observed;
    // the power-driven plan must not duplicate it.
    return { kind: 'inactive', budgetExempt: false };
  }
  const horizonPlan = diagnostic.horizonPlan;
  if (!horizonPlan) return { kind: 'inactive', budgetExempt: false };
  const releasesViaBinary = usesBinaryReleaseControl(device);
  // The producer resolved which of the three claims this hour carries
  // (`resolveCurrentHourClaim`); admission maps it 1:1 and adds only the release
  // ROUTING, which is a device-modality question the producer cannot answer.
  if (horizonPlan.currentHourClaim !== 'claimed') {
    // Unclaimed: nothing booked here, and the task cannot finish without the hour —
    // so there is nothing to defer into. Hand the device to the planner as managed
    // and let it compete on its own priority; the task takes whatever the normal
    // shed/restore lane gives it rather than commanding a stand-down.
    if (horizonPlan.currentHourClaim === 'unclaimed') return { kind: 'unclaimed', budgetExempt: false };
    // Released bucket: hold the device in its configured release posture. Besides
    // genuine idle hours (nothing booked here and nothing left to deliver), this also
    // fires when the producer flagged the hour price-deferral-eligible — the device is
    // already at/above this hour's trajectory milestone and a later hour is
    // cheaper, so release the device this cycle. This is a live per-cycle control decision on the
    // admission path; the clock-driven recorder is insulated, so no revision is
    // written (the device's idling re-books the cheaper hours at the next :58 settle).
    //
    // Binary-controlled devices (cap-on or cap-off): always release the binary control.
    // Off-peak hours have no capacity pressure, so the planner's normal shed/restore lane
    // would never command the cap-on device off — but the smart task's whole point is not
    // to run outside planned hours, so we force binary_release regardless of cap-on/off.
    //
    // Non-binary cap-off: emit shed_release once so the configured shedBehavior fires. Cap-on
    // non-binary stays on the planner's normal lane — emitting shed_release there would race
    // the planner's own decisions (it might be deliberately restoring the device).
    if (releasesViaBinary) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' };
    }
    if (device?.controllable === false) {
      return { kind: 'idle', budgetExempt: false, releaseIntent: 'shed_release' };
    }
    return { kind: 'idle', budgetExempt: false };
  }
  return {
    kind: 'planned',
    budgetExempt,
    engageBoost,
    reservesStartupPower,
    expectedStepId: horizonPlan.currentBucket?.expectedStepId ?? null,
    ...(releasesViaBinary ? { releaseIntent: 'binary_restore' as const } : {}),
  };
};

export const applyDeferredObjectiveAdmission = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
  devices: readonly PlanInputDevice[] = [],
): Map<string, DeferredAdmissionDecision> => {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const decisions = new Map<string, DeferredAdmissionDecision>();
  for (const diagnostic of diagnostics) {
    decisions.set(diagnostic.deviceId, resolveDecision(diagnostic, deviceById.get(diagnostic.deviceId)));
  }
  return decisions;
};

/**
 * "Leave off until turned on again": the hold guarantees this device will not
 * start, so every rescue decoration is spent on a device that cannot use it —
 * and each one costs OTHER devices. `reservesStartupPower` holds available
 * power out of every lower-priority device's reach, `engageBoost` escalates
 * past the shed invariant, the cap-off `override` hands the planner a
 * controllable device to resume, and `budgetExempt` spends daily budget. All of
 * that would be pure collateral damage on unrelated loads, potentially for the
 * whole planned window. An explicit off action beats the task; the task reports
 * the deadline risk instead (`objective_device_left_off`).
 */
const rescueBlockedByExternalOffHold = (device: PlanInputDevice): boolean => (
  device.externalOffHoldActive === true
);

// Soft deferred objectives only override the cap-off (controllable=false) fallback. When the
// user keeps capacity-based control on for the device, normal PELS behavior already runs and
// the deferred plan should not bypass restore admission, cooldowns, or daily-budget logic.
const requiresOverride = (decision: DeferredAdmissionDecision, device: PlanInputDevice): boolean => (
  decision.kind !== 'inactive'
  && device.controllable === false
  && !rescueBlockedByExternalOffHold(device)
);

export type DeferredAdmissionInput = {
  devices: PlanInputDevice[];
  forceShedSet: Set<string>;
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
const buildAdmissionDecoration = (params: {
  override: boolean;
  budgetExempt: boolean;
  engageBoost: boolean;
  reservesStartupPower: boolean;
  hasDeadlineFloor: boolean;
  deadlineFloorTargetC: number;
}): Partial<PlanInputDevice> => ({
  ...(params.override ? { controllable: true } : {}),
  ...(params.budgetExempt ? { budgetExempt: true } : {}),
  ...resolveBoostFields(params.engageBoost),
  ...(params.reservesStartupPower ? { reservesStartupPower: true } : {}),
  ...(params.hasDeadlineFloor ? { deadlineFloorTargetC: params.deadlineFloorTargetC } : {}),
});

// Translate an active deferred objective into a temporary capacity-control-on signal for the
// shedding/restore pipeline. The shedding and restore modules stay agnostic of objectives:
// they only see a managed device and (for idle hours) a seeded shed-set entry. The deadline
// thermostat-floor (built once via `buildDeferredTargetOverrides`) is stamped onto the device
// here too so `resolvePlannedTarget` can read it from a single per-device field instead of a
// parallel id→°C map.
export const applyDeferredAdmissionToInput = (
  devices: PlanInputDevice[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  targetOverrides: Readonly<Record<string, number>> = {},
): DeferredAdmissionInput => {
  if (decisions.size === 0 && Object.keys(targetOverrides).length === 0) {
    return { devices, forceShedSet: new Set() };
  }
  const forceShedSet = new Set<string>();
  const transformed = devices.map((device) => {
    const decision = decisions.get(device.id);
    const deadlineFloorTargetC = targetOverrides[device.id];
    const hasDeadlineFloor = typeof deadlineFloorTargetC === 'number';
    if (!decision) return hasDeadlineFloor ? { ...device, deadlineFloorTargetC } : device;
    // Every claim below is made ON BEHALF of this device; a held device cannot
    // use any of them. See `rescueBlockedByExternalOffHold`.
    const heldOff = rescueBlockedByExternalOffHold(device);
    const override = requiresOverride(decision, device);
    if (override && decision.kind === 'idle') forceShedSet.add(device.id);
    // Engage the device's boost while a limit-lower-priority task is in its planned hours.
    // This reuses the existing boost machinery (EV chargers via evBoost, stepped thermal
    // devices via temperatureBoost) to escalate past the shed-invariant and claim capacity
    // from lower-priority devices — the deferred target override already commands the task's
    // target. Physical capacity stays enforced by the capacity guard.
    const engageBoost = !heldOff && decision.kind === 'planned' && decision.engageBoost;
    // Boost-free startup reservation: entitle the device to hold its lowest-active-step power
    // back from lower-priority admission until it starts. Only during planned hours (same gate
    // as engageBoost); it never sets forceBoostActive and never sheds anyone.
    const reservesStartupPower = !heldOff && decision.kind === 'planned' && decision.reservesStartupPower;
    // The rescue budget exemption applies cap-agnostically, but only during the
    // planned current bucket. It should not turn idle/background cycles into the
    // device's standing budget-exemption setting.
    const budgetExempt = !heldOff && decision.budgetExempt;
    if (!override && !budgetExempt && !engageBoost && !reservesStartupPower && !hasDeadlineFloor) return device;
    return {
      ...device,
      ...buildAdmissionDecoration({
        override,
        budgetExempt,
        engageBoost,
        reservesStartupPower,
        hasDeadlineFloor,
        deadlineFloorTargetC,
      }),
    };
  });
  return { devices: transformed, forceShedSet };
};

// Per-cycle map of the deadline temperature target a device should be commanded to during a
// planned hour. EV objectives and non-planned diagnostics are skipped. Consumed by
// `resolvePlannedTarget` to lift the mode setpoint above the configured operating-mode target so
// the device's own thermostat can actually reach the deadline.
export const buildDeferredTargetOverrides = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
): Record<string, number> => {
  const overrides: Record<string, number> = {};
  for (const diag of diagnostics) {
    if (diag.objectiveKind !== 'temperature') continue;
    if (!PLANNABLE_STATUSES.has(resolvedTrajectoryStatus(diag))) continue;
    const horizonPlan = diag.horizonPlan;
    // Skip every hour the task does not claim, reading the SAME producer verdict
    // `resolveDecision` maps so the two cannot drift: a released, price-deferred OR
    // unclaimed device must not be commanded to the deadline floor, or
    // `resolvePlannedTarget` would lift the setpoint and run it in an hour the task
    // either released it from or never claimed.
    if (!horizonPlan || horizonPlan.currentHourClaim !== 'claimed') continue;
    // Defensive: persisted settings can yield NaN/Infinity on corrupt reads; the type-level
    // `number` invariant does not survive Homey settings drift. See feedback_homey_sdk_unreliable.
    if (!Number.isFinite(diag.targetTemperatureC)) continue;
    overrides[diag.deviceId] = diag.targetTemperatureC;
  }
  return overrides;
};

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
