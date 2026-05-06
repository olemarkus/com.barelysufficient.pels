import {
  getDeviceOverviewReportedStepId,
} from '../../packages/shared-domain/src/deviceOverview';
import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanDeviceStarvation,
  SettingsUiPlanSnapshot,
  SettingsUiPlanSteppedLoadState,
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import type { DevicePlan } from './planTypes';

export type SettingsOverviewReadModelDeps = {
  getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceStarvation | null | undefined;
};

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
    evChargingState: device.evChargingState,
    currentTarget: device.currentTarget,
    plannedTarget: device.plannedTarget,
    currentTemperature: device.currentTemperature,
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    budgetExempt: device.budgetExempt,
    temperatureBoost: device.temperatureBoost,
    temperatureBoostActive: device.temperatureBoostActive,
    evBoost: device.evBoost,
    evBoostActive: device.evBoostActive,
    observationStale: device.observationStale,
    shedAction: device.shedAction,
    shedTemperature: device.shedTemperature,
    selectedStepId: device.selectedStepId,
    desiredStepId: device.desiredStepId,
    reportedStepId: device.reportedStepId,
    targetStepId: device.targetStepId,
    actualStepId: device.actualStepId,
    assumedStepId: device.assumedStepId,
    actualStepSource: device.actualStepSource,
    binaryCommandPending: device.binaryCommandPending,
    pendingTargetCommand: device.pendingTargetCommand,
    stateKind: resolvePlanStateKind(device),
    stateTone: resolvePlanStateTone(device),
    reason: device.reason,
    starvation: deps.getOverviewStarvation?.(device.id) ?? undefined,
    steppedLoad: buildSteppedLoadReadState(device),
  };
}

export function buildSettingsOverviewReadModel(
  plan: DevicePlan | null,
  deps: SettingsOverviewReadModelDeps = {},
): SettingsUiPlanSnapshot | null {
  if (!plan) return null;
  return {
    generatedAtMs: plan.generatedAtMs,
    meta: normalizePlanMeta(plan.meta),
    devices: plan.devices.map((device) => buildSettingsOverviewDeviceReadModel(device, deps)),
  };
}
