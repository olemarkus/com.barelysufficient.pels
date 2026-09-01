import {
  buildEmptyCapacityStateSummary,
  buildNullCapacityStateSummary,
  type CapacityStateSummarySource,
  type PlanCapacityStateSummary,
} from '../power/capacityStateSummary';
import {
  buildComparableDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isPlanDeviceObservedOn, isSteppedLoadDevice } from './planSteppedLoad';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice } from './planTypes';
import {
  isActivationPenaltyBlockedReason,
  isCooldownBlockedReason,
  isShedInvariantBlockedReason,
} from '../planContract/planDecisionSemantics';
import {
  isCapacityBreached,
  resolveRemainingSheddableLoadKw,
  toPlanRemainingSheddableDevice,
} from './planRemainingSheddableLoad';

export type { PlanCapacityStateSummary } from '../power/capacityStateSummary';

type CapacityStateSummaryMetadata = {
  summarySource?: CapacityStateSummarySource;
  summarySourceAtMs?: number | null;
};

/**
 * Unwinnable plan state: the last plan proved there is nothing left to shed AND
 * nothing left to reduce, so a full rebuild cannot change any device action.
 * `=== false` (not `!== true`) so a null/startup summary is not unactionable.
 * Owns this resolution for every consumer (rebuild throttling, convergence) —
 * do not re-derive it from summary fields at call sites.
 */
export function isPlanUnactionable(summary: PlanCapacityStateSummary): boolean {
  return summary.remainingActionableControlledLoad === false
    && summary.remainingReducibleControlledLoad === false;
}

/**
 * The summary's input is narrowed to exactly what it reads: the device list, and
 * the managed/background split off `meta`. It used to take a whole `DevicePlan`,
 * which let a caller satisfy the type while omitting the only two meta fields
 * this function touches — and one did. `planBuilderOvershoot` synthesised
 * `{ totalKw, softLimitKw, headroomKw }`, none of which is read here, so every
 * `overshoot_entered` log recorded a null `controlledPowerW` /
 * `uncontrolledPowerW`. Asking for what is used makes that a compile error
 * instead of a silently empty diagnostic.
 */
export type PlanCapacityStateSummaryInput = Pick<DevicePlan, 'devices'> & {
  meta: Pick<
    DevicePlan['meta'],
    'controlledKw' | 'uncontrolledKw' | 'totalKw' | 'softLimitKw'
    | 'capacitySoftLimitKw' | 'softLimitSource' | 'powerIsMeasured'
  >;
};

export function buildPlanCapacityStateSummary(
  plan: PlanCapacityStateSummaryInput | null | undefined,
  metadata: CapacityStateSummaryMetadata = {},
): PlanCapacityStateSummary {
  if (!plan) {
    return buildNullCapacityStateSummary();
  }

  const summary = buildEmptyCapacityStateSummary();
  for (const device of plan.devices) {
    if (device.controllable === false) continue;
    summary.controlledDevices += 1;
    const plannedShedCounts = buildPlannedShedCounts({
      plannedShed: device.plannedState === 'shed',
      pending: hasPendingCommand(device),
      active: isActiveControlledDevice(device),
    });
    summary.plannedShedDevices += plannedShedCounts.plannedShedDevices;
    summary.pendingPlannedShedDevices += plannedShedCounts.pendingPlannedShedDevices;
    summary.activePlannedShedDevices += plannedShedCounts.activePlannedShedDevices;
    summary.activeControlledDevices += Number(isActiveControlledDevice(device));
    summary.zeroDrawControlledDevices += Number(isZeroDrawControlledDevice(device));
    summary.pendingControlledDevices += Number(hasPendingCommand(device));
    summary.blockedByCooldownDevices += Number(isBlockedByCooldown(device));
    summary.blockedByPenaltyDevices += Number(isBlockedByPenalty(device));
    summary.blockedByInvariantDevices += Number(isBlockedByInvariant(device));
  }
  const remainingContext = resolvePlanRemainingSheddableContext(plan);
  const remainingReducibleControlledLoadKw = sumPlanRemainingSheddableLoadKw(plan.devices, remainingContext);
  const remainingActionableControlledLoadKw = sumActionableControlledLoadKw(plan.devices, remainingContext);
  const remainingReducibleControlledLoadW = roundPowerW(remainingReducibleControlledLoadKw);
  const remainingActionableControlledLoadW = roundPowerW(remainingActionableControlledLoadKw);
  return {
    ...summary,
    controlledPowerW: roundPowerW(plan.meta.controlledKw),
    uncontrolledPowerW: roundPowerW(plan.meta.uncontrolledKw),
    remainingReducibleControlledLoadW,
    remainingReducibleControlledLoad: (remainingReducibleControlledLoadW ?? 0) > 0,
    remainingActionableControlledLoadW,
    remainingActionableControlledLoad: (remainingActionableControlledLoadW ?? 0) > 0,
    actuationInFlight: summary.pendingControlledDevices > 0,
    summarySource: metadata.summarySource ?? null,
    summarySourceAtMs: metadata.summarySourceAtMs ?? null,
  };
}

// blockedByCooldownDevices, blockedByPenaltyDevices, blockedByInvariantDevices are not populated here
// because PlanInputDevice has no reason field — those fields remain 0 in the returned summary.
export function buildPlanInputCapacityStateSummary(
  devices: PlanInputDevice[],
  shedSet: ReadonlySet<string>,
  /**
   * "Is a binary command in flight for this device", answered by
   * `PendingBinaryCommandStore` (`lib/observer/pendingBinaryCommands`). Passed
   * in because in-flight command state does not ride on `PlanInputDevice`.
   *
   * ANY direction counts here, unlike the plan device's `binaryCommandPending`
   * (a pending turn-ON only). The two are different questions — this one asks
   * whether the house is mid-actuation, which a turn-OFF answers just as much
   * as a turn-ON — and answering both with one field is what let the meaning
   * drift between a fresh build and a republish.
   */
  isBinaryCommandPending: (deviceId: string) => boolean,
  metadata: CapacityStateSummaryMetadata = {},
): PlanCapacityStateSummary {
  const summary = buildEmptyCapacityStateSummary();
  for (const device of devices) {
    if (device.controllable === false) continue;
    summary.controlledDevices += 1;
    // Resolved once: the reader reaches the command store, and asking it twice
    // per device was the shape this summary had before the store owned the
    // question.
    const pending = hasPendingInputCommand(device, isBinaryCommandPending);
    const plannedShedCounts = buildPlannedShedCounts({
      plannedShed: shedSet.has(device.id),
      pending,
      active: isActiveInputDevice(device),
    });
    summary.plannedShedDevices += plannedShedCounts.plannedShedDevices;
    summary.pendingPlannedShedDevices += plannedShedCounts.pendingPlannedShedDevices;
    summary.activePlannedShedDevices += plannedShedCounts.activePlannedShedDevices;
    summary.activeControlledDevices += Number(isActiveInputDevice(device));
    summary.zeroDrawControlledDevices += Number(isZeroDrawInputDevice(device));
    summary.pendingControlledDevices += Number(pending);
  }
  return {
    ...summary,
    remainingActionableControlledLoadW: 0,
    remainingActionableControlledLoad: false,
    actuationInFlight: summary.pendingControlledDevices > 0,
    summarySource: metadata.summarySource ?? null,
    summarySourceAtMs: metadata.summarySourceAtMs ?? null,
  };
}

function buildPlannedShedCounts(
  counts: { plannedShed: boolean; pending: boolean; active: boolean },
): Pick<
  ReturnType<typeof buildEmptyCapacityStateSummary>,
  'plannedShedDevices' | 'pendingPlannedShedDevices' | 'activePlannedShedDevices'
> {
  return {
    plannedShedDevices: Number(counts.plannedShed),
    pendingPlannedShedDevices: Number(counts.plannedShed && counts.pending),
    activePlannedShedDevices: Number(counts.plannedShed && counts.active),
  };
}

function sumPlanRemainingSheddableLoadKw(
  devices: DevicePlanDevice[],
  context: RemainingSheddableContext,
): number {
  let totalKw = 0;
  for (const sourceDevice of devices) {
    const power = resolveRemainingSheddableLoadKw({
      device: toPlanRemainingSheddableDevice(sourceDevice),
      alreadyShed: sourceDevice.plannedState === 'shed',
      limitSource: context.limitSource,
      capacityBreached: context.capacityBreached,
    });
    if (power > 0) {
      totalKw += power;
    }
  }
  return totalKw;
}

function sumActionableControlledLoadKw(
  devices: DevicePlanDevice[],
  context: RemainingSheddableContext,
): number {
  let totalKw = 0;
  for (const sourceDevice of devices) {
    if (!isActionableShortfallCandidate(sourceDevice)) continue;
    const power = resolveRemainingSheddableLoadKw({
      device: toPlanRemainingSheddableDevice(sourceDevice),
      alreadyShed: sourceDevice.plannedState === 'shed',
      limitSource: context.limitSource,
      capacityBreached: context.capacityBreached,
    });
    if (power > 0) {
      totalKw += power;
    }
  }
  return totalKw;
}

function roundPowerW(powerKw: number | null | undefined): number | null {
  if (typeof powerKw !== 'number' || !Number.isFinite(powerKw)) return null;
  return Math.round(Math.max(0, powerKw * 1000));
}

type RemainingSheddableContext = {
  limitSource: 'capacity' | 'daily' | 'both';
  capacityBreached: boolean;
};

function resolvePlanRemainingSheddableContext(
  plan: PlanCapacityStateSummaryInput,
): RemainingSheddableContext {
  // No `?? plan.meta.softLimitKw` and no `?? 'capacity'`: both are required on
  // the plan meta, so the fallbacks defended against a state the planner cannot
  // produce — and the `softLimitSource` one silently answered "capacity" for a
  // budget-bound cycle if it ever had fired.
  return {
    limitSource: plan.meta.softLimitSource,
    // From the MEASURED total, matching what the plan's own device-level
    // `capacityBreached` now reports. Reading the raw `totalKw` here made the two
    // disagree on exactly the cycles where the meter could not be trusted.
    capacityBreached: plan.meta.powerIsMeasured
      && isCapacityBreached(plan.meta.totalKw, plan.meta.capacitySoftLimitKw),
  };
}

function buildPlanSignatureDevice(device: DevicePlanDevice): Record<string, unknown> {
  return {
    id: device.id,
    controlKind: isSteppedLoadDevice(device) ? 'stepped_load' : undefined,
    plannedState: device.plannedState,
    plannedTarget: isTemperaturePlanDevice(device) ? device.plannedTarget : undefined,
    desiredStepId: device.desiredStepId,
    shedAction: device.shedAction,
    deferredReleaseIntent: device.deferredReleaseIntent,
    controllable: device.controllable,
  };
}

export function buildPlanSignature(plan: DevicePlan): string {
  return JSON.stringify(
    plan.devices.map((device) => buildPlanSignatureDevice(device)),
  );
}

function isActiveControlledDevice(device: DevicePlanDevice): boolean {
  // "Active" = on. Kind-aware: a binary device via `currentOn`, a step-only
  // stepper via its (active) step — so step-only steppers are counted too.
  return isPlanDeviceObservedOn(device);
}

function isActiveInputDevice(device: PlanInputDevice): boolean {
  // "Active" = on. Kind-aware: a binary device via `currentOn`, a step-only
  // stepper via its (active) step — so step-only steppers are counted too.
  return isPlanDeviceObservedOn(device);
}

function isZeroDrawControlledDevice(device: DevicePlanDevice): boolean {
  return isActiveControlledDevice(device) && device.currentDrawKw <= 0;
}

function isZeroDrawInputDevice(device: PlanInputDevice): boolean {
  return isActiveInputDevice(device) && device.currentDrawKw <= 0;
}

function isActionableShortfallCandidate(device: DevicePlanDevice): boolean {
  if (device.controllable === false) return false;
  if (isBinaryPlanDevice(device) && !device.currentOn) return false;
  if (device.plannedState === 'shed') return false;
  if (isBlockedByCooldown(device) || isBlockedByPenalty(device)) {
    return false;
  }
  return true;
}

function hasPendingCommand(device: DevicePlanDevice): boolean {
  return device.binaryCommandPending === true
    || device.stepCommandPending === true
    || device.pendingTargetCommand !== undefined;
}

function hasPendingInputCommand(
  device: PlanInputDevice,
  isBinaryCommandPending: (deviceId: string) => boolean,
): boolean {
  return isBinaryCommandPending(device.id) || device.stepCommandPending === true;
}

function isBlockedByCooldown(device: DevicePlanDevice): boolean {
  return isCooldownBlockedReason(device.reason);
}

function isBlockedByPenalty(device: DevicePlanDevice): boolean {
  return isActivationPenaltyBlockedReason(device.reason);
}

function isBlockedByInvariant(device: DevicePlanDevice): boolean {
  return isShedInvariantBlockedReason(device.reason);
}

// The kind-cluster slices of the comparable record, split out so the signature
// mapper stays under the complexity cap.
function buildComparableKindFields(d: DevicePlan['devices'][number]): {
  controlKind: 'stepped_load' | undefined;
  selectedStepId: string | undefined;
  planningPowerKw: number | undefined;
  plannedTarget: number | undefined;
  currentTarget: number | null;
} {
  return {
    controlKind: isSteppedLoadDevice(d) ? 'stepped_load' : undefined,
    selectedStepId: isSteppedLoadDevice(d) ? d.selectedStepId : undefined,
    planningPowerKw: isSteppedLoadDevice(d) ? d.planningPowerKw : undefined,
    plannedTarget: isTemperaturePlanDevice(d) ? d.plannedTarget : undefined,
    currentTarget: isTemperaturePlanDevice(d) ? d.currentTarget : null,
  };
}

export function buildPlanDetailSignature(plan: DevicePlan): string {
  return JSON.stringify(
    plan.devices.map((d) => ({
      id: d.id,
      priority: d.priority,
      ...buildComparableKindFields(d),
      plannedState: d.plannedState,
      surplusAbsorbActive: d.surplusAbsorbActive === true,
      desiredStepId: d.desiredStepId,
      lastDesiredStepId: d.lastDesiredStepId,
      currentState: d.currentState,
      reason: buildComparableDeviceReason(d.reason),
      shedAction: d.shedAction,
      controllable: d.controllable,
      stepCommandPending: d.stepCommandPending ?? null,
      stepCommandStatus: d.stepCommandStatus ?? null,
      pendingTargetDesired: d.pendingTargetCommand?.desired ?? null,
      pendingTargetRetryCount: d.pendingTargetCommand?.retryCount ?? null,
      pendingTargetNextRetryAtMs: d.pendingTargetCommand?.nextRetryAtMs ?? null,
      pendingTargetStatus: d.pendingTargetCommand?.status ?? null,
    })),
  );
}

export type PlanReasonGroup = {
  reasonCode: string;
  // Only the `inactive` code carries one, and it is shared-domain copy the device
  // card renders (`commandableNowReason.ts`) — it discriminates WHICH
  // commandability cause, which the code alone cannot.
  detail?: string;
  count: number;
};

export type PlanDebugSummaryEvent = {
  event: 'plan_debug_summary';
  totalKw: number | null;
  softLimitKw: number | null;
  capacitySoftLimitKw: number | null;
  dailySoftLimitKw: number | null;
  softLimitSource: DevicePlan['meta']['softLimitSource'] | null;
  headroomKw: number | null;
  restoreBlockedCount: number;
  restoreBlockedReasons: PlanReasonGroup[];
  inactiveCount: number;
  inactiveReasons: PlanReasonGroup[];
};

export function buildPlanDebugSummaryEvent(plan: DevicePlan): PlanDebugSummaryEvent {
  const categories = categorizePlanDebugDevices(plan.devices);
  return {
    event: 'plan_debug_summary',
    totalKw: roundPlanDebugNumber(plan.meta.totalKw),
    softLimitKw: roundPlanDebugNumber(plan.meta.softLimitKw),
    capacitySoftLimitKw: roundPlanDebugNumber(plan.meta.capacitySoftLimitKw),
    dailySoftLimitKw: roundPlanDebugNumber(plan.meta.dailySoftLimitKw),
    softLimitSource: plan.meta.softLimitSource ?? null,
    headroomKw: roundPlanDebugNumber(plan.meta.headroomKw),
    restoreBlockedCount: categories.restoreBlockedCount,
    restoreBlockedReasons: categories.restoreBlockedReasons,
    inactiveCount: categories.inactiveCount,
    inactiveReasons: categories.inactiveReasons,
  };
}

export function buildPlanDebugSummarySignatureFromEvent(event: PlanDebugSummaryEvent): string {
  return JSON.stringify(event);
}

// Grouped by the reason CODE. This used to group by a rendered label
// (`getPlanReasonLabel`), which put prose in a structured field and made the
// group key un-joinable against the `reasonCode` every other plan event carries.
function buildPlanReasonGroups(devices: DevicePlanDevice[]): PlanReasonGroup[] {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const { reason } = device;
    const detail = reason.code === PLAN_REASON_CODES.inactive ? reason.detail : undefined;
    const key = detail ? `${reason.code}\u0000${detail}` : reason.code;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => {
      const [reasonCode, detail] = key.split('\u0000');
      return detail === undefined
        ? { reasonCode: reasonCode ?? '', count }
        : { reasonCode: reasonCode ?? '', detail, count };
    })
    .sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode));
}

function categorizePlanDebugDevices(devices: DevicePlanDevice[]): {
  restoreBlockedCount: number;
  restoreBlockedReasons: PlanReasonGroup[];
  inactiveCount: number;
  inactiveReasons: PlanReasonGroup[];
} {
  const restoreBlockedDevices: DevicePlanDevice[] = [];
  const inactiveDevices: DevicePlanDevice[] = [];
  for (const device of devices) {
    if (device.plannedState === 'inactive') {
      inactiveDevices.push(device);
      continue;
    }
    if (device.plannedState === 'shed' && device.currentState === 'off' && device.controllable) {
      restoreBlockedDevices.push(device);
    }
  }
  return {
    restoreBlockedCount: restoreBlockedDevices.length,
    restoreBlockedReasons: buildPlanReasonGroups(restoreBlockedDevices),
    inactiveCount: inactiveDevices.length,
    inactiveReasons: buildPlanReasonGroups(inactiveDevices),
  };
}

function roundPlanDebugNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}
