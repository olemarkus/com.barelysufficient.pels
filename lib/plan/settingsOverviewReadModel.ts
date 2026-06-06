import {
  getDeviceOverviewReportedStepId,
} from '../../packages/shared-domain/src/deviceOverview';
import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanDeviceStarvation,
  SettingsUiPlanSnapshot,
  SettingsUiPlanSteppedLoadState,
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import type { DevicePlan } from './planTypes';
import { isEvPlanDevice } from './planEvDevice';

export type SettingsOverviewReadModelDeps = {
  getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceStarvation | null | undefined;
  getIdleClassification?: (deviceId: string) => 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined;
};

function resolveFiniteKWh(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveHourBudgetKWh(params: {
  capacityHourBudgetKWh: number | undefined;
  dailyBudgetHourKWh: number | undefined;
}): number | undefined {
  const budgets = [params.capacityHourBudgetKWh, params.dailyBudgetHourKWh]
    .filter((value): value is number => typeof value === 'number');
  if (!budgets.length) return undefined;
  return Math.min(...budgets);
}

function buildSettingsOverviewMetaReadModel(meta: DevicePlan['meta']): SettingsUiPlanMetaSnapshot {
  const normalizedMeta = normalizePlanMeta(meta);
  const capacityHourBudgetKWh = resolveFiniteKWh(normalizedMeta.budgetKWh);
  const dailyBudgetHourKWh = resolveFiniteKWh(normalizedMeta.dailyBudgetHourKWh);
  return {
    ...normalizedMeta,
    capacityHourBudgetKWh,
    hourBudgetKWh: resolveHourBudgetKWh({ capacityHourBudgetKWh, dailyBudgetHourKWh }),
  };
}

function resolveOverviewTargetStepId(device: DevicePlan['devices'][number]): string | null {
  return device.targetStepId ?? device.desiredStepId ?? null;
}

function buildSteppedLoadReadState(
  device: DevicePlan['devices'][number],
): SettingsUiPlanSteppedLoadState | undefined {
  if (device.controlModel !== 'stepped_load' || device.steppedLoadProfile?.model !== 'stepped_load') {
    return undefined;
  }
  return {
    profile: device.steppedLoadProfile,
    reportedStepId: getDeviceOverviewReportedStepId(device) ?? null,
    targetStepId: resolveOverviewTargetStepId(device),
    commandPending: device.binaryCommandPending === true
      || device.stepCommandPending === true
      || device.pendingTargetCommand != null,
  };
}

export function buildSettingsOverviewDeviceReadModel(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps = {},
): SettingsUiPlanDeviceSnapshot {
  // EV fields live on the orthogonal `EvKind` cluster (off the base); narrow
  // once so the snapshot can surface them. Non-EV devices have them undefined.
  const ev = isEvPlanDevice(device) ? device : null;
  return {
    id: device.id,
    name: device.name,
    deviceClass: device.deviceClass,
    priority: device.priority,
    zone: device.zone,
    controllable: device.controllable,
    available: device.available,
    currentState: device.currentState,
    plannedState: device.plannedState,
    controlModel: device.controlModel,
    controlCapabilityId: device.controlCapabilityId,
    evChargingState: ev?.evChargingState,
    currentTarget: device.currentTarget,
    plannedTarget: device.plannedTarget,
    currentTemperature: device.currentTemperature,
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    budgetExempt: device.budgetExempt,
    temperatureBoost: device.temperatureBoost,
    temperatureBoostActive: device.temperatureBoostActive,
    evBoost: ev?.evBoost,
    evBoostActive: ev?.evBoostActive,
    observationStale: device.observationStale,
    shedAction: device.shedAction,
    shedTemperature: device.shedTemperature,
    selectedStepId: device.selectedStepId,
    desiredStepId: device.desiredStepId,
    reportedStepId: device.reportedStepId,
    targetStepId: device.targetStepId,
    binaryCommandPending: device.binaryCommandPending,
    pendingTargetCommand: device.pendingTargetCommand,
    stateKind: resolvePlanStateKind(device),
    stateTone: resolvePlanStateTone(device),
    reason: device.reason,
    starvation: deps.getOverviewStarvation?.(device.id) ?? undefined,
    steppedLoad: buildSteppedLoadReadState(device),
    idleClassification: deps.getIdleClassification?.(device.id),
  };
}

export function buildSettingsOverviewReadModel(
  plan: DevicePlan | null,
  deps: SettingsOverviewReadModelDeps = {},
): SettingsUiPlanSnapshot | null {
  if (!plan) return null;
  return {
    generatedAtMs: plan.generatedAtMs,
    meta: buildSettingsOverviewMetaReadModel(plan.meta),
    devices: plan.devices.map((device) => buildSettingsOverviewDeviceReadModel(device, deps)),
  };
}
