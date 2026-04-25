import {
  buildEmptyCapacityStateSummary,
  buildNullCapacityStateSummary,
  type CapacityStateSummarySource,
  type PlanCapacityStateSummary,
} from '../core/capacityStateSummary';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
  getPlanReasonLabel,
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice } from './planTypes';
import {
  isCapacityBreached,
  resolveRemainingSheddableLoadKw,
  toPlanRemainingSheddableDevice,
  type RemainingShedBehavior,
} from './planRemainingSheddableLoad';

export type { PlanCapacityStateSummary } from '../core/capacityStateSummary';

type CapacityStateSummaryMetadata = {
  summarySource?: CapacityStateSummarySource;
  summarySourceAtMs?: number | null;
};

export function buildPlanCapacityStateSummary(
  plan: DevicePlan | null | undefined,
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
    summary.staleControlledDevices += Number(device.observationStale === true);
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
  metadata: CapacityStateSummaryMetadata = {},
): PlanCapacityStateSummary {
  const summary = buildEmptyCapacityStateSummary();
  for (const device of devices) {
    if (device.controllable === false) continue;
    summary.controlledDevices += 1;
    const plannedShedCounts = buildPlannedShedCounts({
      plannedShed: shedSet.has(device.id),
      pending: hasPendingInputCommand(device),
      active: isActiveInputDevice(device),
    });
    summary.plannedShedDevices += plannedShedCounts.plannedShedDevices;
    summary.pendingPlannedShedDevices += plannedShedCounts.pendingPlannedShedDevices;
    summary.activePlannedShedDevices += plannedShedCounts.activePlannedShedDevices;
    summary.activeControlledDevices += Number(isActiveInputDevice(device));
    summary.zeroDrawControlledDevices += Number(isZeroDrawInputDevice(device));
    summary.staleControlledDevices += Number(device.observationStale === true);
    summary.pendingControlledDevices += Number(hasPendingInputCommand(device));
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
      shedBehavior: resolvePlanDeviceShedBehavior(sourceDevice),
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
      shedBehavior: resolvePlanDeviceShedBehavior(sourceDevice),
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

function resolvePlanRemainingSheddableContext(plan: DevicePlan): RemainingSheddableContext {
  const capacitySoftLimitKw = plan.meta.capacitySoftLimitKw ?? plan.meta.softLimitKw;
  return {
    limitSource: plan.meta.softLimitSource ?? 'capacity',
    capacityBreached: isCapacityBreached(plan.meta.totalKw, capacitySoftLimitKw),
  };
}

function resolvePlanDeviceShedBehavior(device: DevicePlanDevice | undefined): RemainingShedBehavior {
  if (device?.shedAction === 'set_temperature' && typeof device.shedTemperature === 'number') {
    return { action: 'set_temperature', temperature: device.shedTemperature };
  }
  if (device?.shedAction === 'set_step') {
    return { action: 'set_step' };
  }
  return { action: 'turn_off' };
}

function buildPlanSignatureDevice(device: DevicePlanDevice): Record<string, unknown> {
  return {
    id: device.id,
    controlModel: device.controlModel,
    plannedState: device.plannedState,
    plannedTarget: device.plannedTarget,
    desiredStepId: device.desiredStepId,
    shedAction: device.shedAction,
    controllable: device.controllable,
  };
}

export function buildPlanSignature(plan: DevicePlan): string {
  return JSON.stringify(
    plan.devices.map((device) => buildPlanSignatureDevice(device)),
  );
}

function isActiveControlledDevice(device: DevicePlanDevice): boolean {
  if (device.observationStale === true) return false;
  return resolveEffectiveCurrentOn(device) === true;
}

function isActiveInputDevice(device: PlanInputDevice): boolean {
  if (device.observationStale === true) return false;
  return resolveEffectiveCurrentOn(device) === true;
}

function isZeroDrawControlledDevice(device: DevicePlanDevice): boolean {
  return isActiveControlledDevice(device)
    && typeof device.measuredPowerKw === 'number'
    && Number.isFinite(device.measuredPowerKw)
    && device.measuredPowerKw <= 0;
}

function isZeroDrawInputDevice(device: PlanInputDevice): boolean {
  return isActiveInputDevice(device)
    && typeof device.measuredPowerKw === 'number'
    && Number.isFinite(device.measuredPowerKw)
    && device.measuredPowerKw <= 0;
}

function isActionableShortfallCandidate(device: DevicePlanDevice): boolean {
  if (device.controllable === false) return false;
  if (resolveEffectiveCurrentOn(device) === false) return false;
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

function hasPendingInputCommand(device: PlanInputDevice): boolean {
  return device.binaryCommandPending === true || device.stepCommandPending === true;
}

function isBlockedByCooldown(device: DevicePlanDevice): boolean {
  return device.reason.code === PLAN_REASON_CODES.cooldownShedding
    || device.reason.code === PLAN_REASON_CODES.cooldownRestore
    || device.reason.code === PLAN_REASON_CODES.meterSettling
    || device.reason.code === PLAN_REASON_CODES.headroomCooldown
    || device.reason.code === PLAN_REASON_CODES.restorePending;
}

function isBlockedByPenalty(device: DevicePlanDevice): boolean {
  return device.reason.code === PLAN_REASON_CODES.activationBackoff;
}

function isBlockedByInvariant(device: DevicePlanDevice): boolean {
  return device.reason.code === PLAN_REASON_CODES.shedInvariant;
}

export function buildPlanDetailSignature(plan: DevicePlan): string {
  return JSON.stringify(
    plan.devices.map((d) => ({
      id: d.id,
      priority: d.priority,
      controlModel: d.controlModel,
      plannedState: d.plannedState,
      plannedTarget: d.plannedTarget,
      selectedStepId: d.selectedStepId,
      desiredStepId: d.desiredStepId,
      lastDesiredStepId: d.lastDesiredStepId,
      currentState: d.currentState,
      currentTarget: d.currentTarget,
      reason: buildComparableDeviceReason(d.reason),
      planningPowerKw: d.planningPowerKw,
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
  reason: string;
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

export function buildPlanChangeLines(plan: DevicePlan): string[] {
  const headroom = typeof plan.meta.headroomKw === 'number' ? plan.meta.headroomKw : null;
  const changes = plan.devices
    .filter((d) => isChange(d))
    .slice()
    .sort(compareDevices);
  return changes.map((device) => formatPlanChange(device, headroom));
}

function isChange(device: DevicePlanDevice): boolean {
  if (device.controlModel === 'stepped_load') {
    return device.desiredStepId !== device.selectedStepId;
  }
  const sameTarget = normalizeTarget(device.plannedTarget) === normalizeTarget(device.currentTarget);
  if (device.controllable === false) return !sameTarget;
  const desiredPower = getDesiredPower(device);
  const samePower = desiredPower === device.currentState;
  return !(samePower && sameTarget);
}

function getDesiredPower(device: DevicePlanDevice): string {
  if (device.currentState === 'not_applicable') return 'not_applicable';
  if (device.plannedState === 'inactive') {
    return device.currentState === 'unknown' ? 'unknown' : 'off';
  }
  if (device.plannedState !== 'shed') return 'on';
  return device.shedAction === 'set_temperature' ? 'on' : 'off';
}

function normalizeTarget(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function buildPlanReasonGroups(devices: DevicePlanDevice[]): PlanReasonGroup[] {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const reason = normalizePlanReason(device.reason);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function normalizePlanReason(reason: DeviceReason): string {
  if (reason.code === PLAN_REASON_CODES.inactive && reason.detail) return reason.detail;
  if (reason.code === PLAN_REASON_CODES.insufficientHeadroom) return 'insufficient headroom';
  return getPlanReasonLabel(reason.code);
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
    if (device.plannedState === 'shed' && device.currentState === 'off' && device.controllable !== false) {
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

function formatPlanChange(device: DevicePlanDevice, headroom: number | null): string {
  if (device.controlModel === 'stepped_load') {
    const headroomInfo = typeof headroom === 'number' ? `, headroom ${headroom.toFixed(2)}kW` : '';
    const planningInfo = typeof device.planningPowerKw === 'number'
      ? `, planning ${device.planningPowerKw.toFixed(2)}kW`
      : '';
    const reason = formatDeviceReason(device.reason);
    return `${device.name}: step ${device.selectedStepId ?? 'unknown'} -> ${device.desiredStepId ?? 'unknown'}`
      + `${planningInfo}${headroomInfo}, reason: ${reason}`;
  }
  const temp = `${formatTarget(device.currentTarget)}° -> ${formatTarget(device.plannedTarget)}°`;
  const nextPower = getPlannedPowerLabel(device);
  const power = `${formatPowerState(device.currentState)} -> ${formatPowerState(nextPower)}`;
  const powerInfo = typeof device.powerKw === 'number'
    ? `, est ${device.powerKw.toFixed(2)}kW`
    : '';
  const headroomInfo = typeof headroom === 'number'
    ? `, headroom ${headroom.toFixed(2)}kW`
    : '';
  const restoringHint = buildRestoreHint(device, nextPower, headroom);
  const reason = formatDeviceReason(device.reason);
  return `${device.name}: temp ${temp}, power ${power}${powerInfo}${headroomInfo}, reason: ${reason}${restoringHint}`;
}

function formatTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (value === null || value === undefined) return '–';
  return String(value);
}

function getPlannedPowerLabel(device: DevicePlanDevice): string {
  if (device.currentState === 'not_applicable') return 'not_applicable';
  if (device.controllable === false) return device.currentState;
  if (device.plannedState === 'inactive') {
    return device.currentState === 'unknown' ? 'unknown' : 'off';
  }
  if (device.plannedState !== 'shed') return 'on';
  if (device.shedAction === 'set_temperature') {
    return typeof device.plannedTarget === 'number'
      ? `set temp ${device.plannedTarget}°`
      : 'set temp';
  }
  return 'off';
}

function formatPowerState(value: string | undefined): string {
  if (!value || value === 'unknown') return 'unknown';
  if (value === 'not_applicable') return 'n/a';
  return value;
}

function buildRestoreHint(device: DevicePlanDevice, nextPower: string, headroom: number | null): string {
  if (device.currentState !== 'off' || nextPower !== 'on') return '';
  const needed = typeof device.powerKw === 'number' ? device.powerKw : 1;
  const headroomInfo = typeof headroom === 'number' ? ` vs headroom ${headroom.toFixed(2)}kW` : '';
  return ` (restoring, needs ~${needed.toFixed(2)}kW${headroomInfo})`;
}

function compareDevices(a: DevicePlanDevice, b: DevicePlanDevice): number {
  const pa = a.priority ?? 999;
  const pb = b.priority ?? 999;
  if (pa !== pb) return pa - pb;
  return a.name.localeCompare(b.name);
}
