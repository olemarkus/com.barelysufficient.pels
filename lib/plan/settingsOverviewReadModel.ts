import {
  getDeviceOverviewReportedStepId,
} from '../../packages/shared-domain/src/deviceOverview';
import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import { isObserveOnlyRoleClassKey } from '../../packages/shared-domain/src/observeOnlyRole';
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanDeviceStarvation,
  SettingsUiPlanSnapshot,
  SettingsUiPlanSteppedLoadState,
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import type { DevicePlan } from './planTypes';
import type { EvChargingState, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadHighestStep, getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { isEvPlanDevice } from './planEvDevice';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';

export type SettingsOverviewReadModelDeps = {
  getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceStarvation | null | undefined;
  getIdleClassification?: (deviceId: string) => 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined;
  // EV charging state is observed state — the observer is its canonical source
  // (`ObservedDeviceState.evChargingState`), not the planner. The settings-UI
  // read model surfaces the raw string for display, so it reads it from the
  // observer here rather than off the plan device (which no longer carries it).
  getObservedEvChargingState?: (deviceId: string) => EvChargingState | undefined;
  getAssociatedCarChargingState?: (deviceId: string) => EvChargingState | undefined;
  getObservedTemperature?: (deviceId: string) => {
    currentTarget: number | null;
    currentTemperature?: number;
  } | undefined;
  // Observation staleness is observer-owned freshness state — the plan device no
  // longer carries it (the plan has no right to distrust observer data). The
  // gray-state UI label is a display concern, so the read model sources staleness
  // from the observer projection here, NOT off the plan device.
  getObservationStale?: (deviceId: string) => boolean;
  // `controlModel` is a producer-only SETTING the planner no longer carries, but
  // the settings-UI still needs it to pick the device card (stepped / temperature
  // / generic). Stepped is the decorated truth (`isSteppedLoadDevice` on the plan
  // device); the temperature-vs-binary split for non-stepped devices comes from
  // the producer's `deviceType`, supplied here as a built-once map (sourced from
  // the raw, undecorated snapshot so there is no re-decoration side effect). This
  // is a UI display concern at the planner→UI seam, NOT a planning evaluation.
  getDeviceTypeById?: () => Map<string, 'temperature' | 'onoff'>;
  getControlModelById?: () => Map<string, 'stepped_load' | 'temperature_target' | 'binary_power'>;
  getSteppedLoadProfileById?: () => Map<string, SteppedLoadProfile>;
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
  confirmedProfile?: SteppedLoadProfile,
): SettingsUiPlanSteppedLoadState | undefined {
  if (!isSteppedLoadDevice(device)) {
    return undefined;
  }
  const profile = confirmedProfile ?? device.steppedLoadProfile;
  const reportedStepId = getDeviceOverviewReportedStepId(device) ?? null;
  const plannedTargetStepId = resolveOverviewTargetStepId(device);
  const plannerOnlyTarget = confirmedProfile !== undefined
    && plannedTargetStepId !== null
    && getSteppedLoadStep(confirmedProfile, plannedTargetStepId) === null;
  const targetStepId = plannerOnlyTarget
    ? getSteppedLoadStep(profile, reportedStepId ?? undefined)?.id
      ?? getSteppedLoadHighestStep(profile)?.id
      ?? null
    : plannedTargetStepId;
  return {
    profile,
    reportedStepId,
    targetStepId,
    commandPending: !plannerOnlyTarget && (device.binaryCommandPending === true
      || device.stepCommandPending === true
      || device.pendingTargetCommand != null),
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
  producerControlModel?: 'stepped_load' | 'temperature_target' | 'binary_power',
): 'stepped_load' | 'temperature_target' | 'binary_power' {
  if (producerControlModel !== undefined) return producerControlModel;
  if (isSteppedLoadDevice(device)) return 'stepped_load';
  return producerDeviceType === 'temperature' ? 'temperature_target' : 'binary_power';
}

function resolveOverviewTemperatureState(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps,
): { currentTarget: number | null; plannedTarget?: number; currentTemperature?: number } {
  const observed = deps.getObservedTemperature?.(device.id);
  const planned = isTemperaturePlanDevice(device) ? device : null;
  if (observed !== undefined) {
    return {
      currentTarget: observed.currentTarget,
      plannedTarget: planned?.plannedTarget,
      currentTemperature: observed.currentTemperature,
    };
  }
  return {
    currentTarget: planned?.currentTarget ?? null,
    plannedTarget: planned?.plannedTarget,
    currentTemperature: planned?.currentTemperature,
  };
}

export function buildSettingsOverviewDeviceReadModel(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps = {},
  producerDeviceType?: 'temperature' | 'onoff',
  producerControlModel?: 'stepped_load' | 'temperature_target' | 'binary_power',
  confirmedSteppedLoadProfile?: SteppedLoadProfile,
): SettingsUiPlanDeviceSnapshot {
  // EV boost fields live on the orthogonal `EvKind` cluster (off the base);
  // narrow once so the snapshot can surface them. Non-EV devices have them
  // undefined. The raw `evChargingState` comes from the observer (its canonical
  // owner), NOT the plan device — see `getObservedEvChargingState`.
  const ev = isEvPlanDevice(device) ? device : null;
  const temperature = resolveOverviewTemperatureState(device, deps);
  // The shared-domain label resolvers below take a `DeviceOverviewSnapshot`,
  // which names the draw `measuredPowerKw` because the settings UI feeds them
  // real snapshots. Adapt once here rather than at each call.
  const overviewShape = {
    ...device,
    ...temperature,
    measuredPowerKw: device.currentDrawKw,
  };
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
    deviceType: producerDeviceType,
    controlModel: resolveDisplayControlModel(device, producerDeviceType, producerControlModel),
    controlCapabilityId: device.controlCapabilityId,
    evChargingState: deps.getObservedEvChargingState?.(device.id),
    carChargingState: deps.getAssociatedCarChargingState?.(device.id),
    currentTarget: temperature.currentTarget,
    plannedTarget: temperature.plannedTarget,
    currentTemperature: temperature.currentTemperature,
    measuredPowerKw: device.currentDrawKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    budgetExempt: device.budgetExempt,
    temperatureBoost: device.temperatureBoost,
    temperatureBoostActive: device.temperatureBoostActive,
    surplusAbsorbActive: device.surplusAbsorbActive,
    evBoost: ev?.evBoost,
    evBoostActive: ev?.evBoostActive,
    // Projected to the two properties the wire type declares rather than passed
    // whole: the observation layer's session/invalidation bookkeeping is its own
    // business, and `status` already answers everything a card needs to know
    // about the reading's currency (`notes/ev-soc-layering.md`).
    stateOfCharge: ev?.stateOfCharge
      ? { percent: ev.stateOfCharge.percent, status: ev.stateOfCharge.status }
      : undefined,
    // Display-only staleness, sourced from the observer (not the plan device).
    observationStale: deps.getObservationStale?.(device.id) ?? false,
    shedAction: device.shedAction,
    shedTemperature: device.shedTemperature,
    selectedStepId: device.selectedStepId,
    desiredStepId: device.desiredStepId,
    reportedStepId: device.reportedStepId,
    targetStepId: device.targetStepId,
    binaryCommandPending: device.binaryCommandPending,
    pendingTargetCommand: device.pendingTargetCommand,
    // These read `measuredPowerKw` off a `DeviceOverviewSnapshot`, a shape shared
    // with the settings UI (which reads real snapshots). A plan device does not
    // carry that name, and the field is OPTIONAL on the shared type — so passing
    // the plan device compiles and silently reads `undefined`, which
    // `isSatisfiedTargetOnlyDevice` then treats as `0 kW` and labels a drawing
    // target-only device "Idle". Feed them the resolved draw under the name the
    // shared type uses, exactly as `planOverviewEmit` does for the log seam.
    stateKind: resolvePlanStateKind(overviewShape),
    stateTone: resolvePlanStateTone(overviewShape),
    reason: device.reason,
    starvation: deps.getOverviewStarvation?.(device.id) ?? undefined,
    steppedLoad: buildSteppedLoadReadState(device, confirmedSteppedLoadProfile),
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
  const controlModelById = deps.getControlModelById?.()
    ?? new Map<string, 'stepped_load' | 'temperature_target' | 'binary_power'>();
  const steppedLoadProfileById = deps.getSteppedLoadProfileById?.() ?? new Map<string, SteppedLoadProfile>();
  return {
    generatedAtMs: plan.generatedAtMs,
    meta: buildSettingsOverviewMetaReadModel(plan.meta),
    // Auto-tracked observe-only role devices (home batteries → 'battery', solar/PV →
    // 'solarpanel') ride the plan internally (the planner observes them) but are NOT
    // user-facing: PELS never controls them and they carry no managed-load semantics on
    // the overview. The device-list endpoint already drops them (`getSettingsUiDevices`);
    // the overview derives from the plan snapshot, so it must drop them here too, or an
    // auto-tracked battery renders as a clickable no-op card.
    devices: plan.devices
      .filter((device) => !isObserveOnlyRoleClassKey(device.deviceClass))
      .map((device) => buildSettingsOverviewDeviceReadModel(
        device,
        deps,
        deviceTypeById.get(device.id),
        controlModelById.get(device.id),
        steppedLoadProfileById.get(device.id),
      )),
  };
}
