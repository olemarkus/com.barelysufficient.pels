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
import type { EvChargingState } from '../../packages/contracts/src/types';
import { isEvPlanDevice } from './planEvDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';

export type SettingsOverviewReadModelDeps = {
  getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceStarvation | null | undefined;
  getIdleClassification?: (deviceId: string) => 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined;
  // EV charging state is observed state — the observer is its canonical source
  // (`ObservedDeviceState.evChargingState`), not the planner. The settings-UI
  // read model surfaces the raw string for display, so it reads it from the
  // observer here rather than off the plan device (which no longer carries it).
  getObservedEvChargingState?: (deviceId: string) => EvChargingState | undefined;
  // `controlModel` is a producer-only SETTING the planner no longer carries, but
  // the settings-UI still needs it to pick the device card (stepped / temperature
  // / generic). Stepped is the decorated truth (`isSteppedLoadDevice` on the plan
  // device); the temperature-vs-binary split for non-stepped devices comes from
  // the producer's `deviceType`, supplied here as a built-once map (sourced from
  // the raw, undecorated snapshot so there is no re-decoration side effect). This
  // is a UI display concern at the planner→UI seam, NOT a planning evaluation.
  getDeviceTypeById?: () => Map<string, 'temperature' | 'onoff'>;
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
  if (!isSteppedLoadDevice(device)) {
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

/**
 * Reproduce the decorated `controlModel` SETTING for the settings-UI card.
 * Stepped is the decorated truth (profile presence on the plan device); the
 * temperature-vs-binary split for non-stepped devices mirrors
 * `resolveDefaultControlModel` (the producer's `deviceType`). Faithful to the
 * prior snapshot value — including the `temperature_target` case a temperature
 * device with no `plannedTarget` (skip / abandon-grace) relies on to still
 * render as a temperature card. This is a UI display concern, not a planning
 * evaluation.
 */
function resolveDisplayControlModel(
  device: DevicePlan['devices'][number],
  producerDeviceType?: 'temperature' | 'onoff',
): 'stepped_load' | 'temperature_target' | 'binary_power' {
  if (isSteppedLoadDevice(device)) return 'stepped_load';
  return producerDeviceType === 'temperature' ? 'temperature_target' : 'binary_power';
}

export function buildSettingsOverviewDeviceReadModel(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps = {},
  producerDeviceType?: 'temperature' | 'onoff',
): SettingsUiPlanDeviceSnapshot {
  // EV boost fields live on the orthogonal `EvKind` cluster (off the base);
  // narrow once so the snapshot can surface them. Non-EV devices have them
  // undefined. The raw `evChargingState` comes from the observer (its canonical
  // owner), NOT the plan device — see `getObservedEvChargingState`.
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
    // `controlModel` is a producer-only setting no longer carried on the plan
    // device; reproduce the decorated value for the UI card (see
    // `resolveDisplayControlModel`).
    controlModel: resolveDisplayControlModel(device, producerDeviceType),
    controlCapabilityId: device.controlCapabilityId,
    evChargingState: deps.getObservedEvChargingState?.(device.id),
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
  // Built once per serialize (not per device) so the raw-snapshot scan stays O(n).
  const deviceTypeById = deps.getDeviceTypeById?.() ?? new Map<string, 'temperature' | 'onoff'>();
  return {
    generatedAtMs: plan.generatedAtMs,
    meta: buildSettingsOverviewMetaReadModel(plan.meta),
    devices: plan.devices.map((device) => buildSettingsOverviewDeviceReadModel(
      device,
      deps,
      deviceTypeById.get(device.id),
    )),
  };
}
