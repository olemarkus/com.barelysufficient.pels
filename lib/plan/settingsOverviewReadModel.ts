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
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import type { DevicePlan } from './planTypes';
import type { EvChargingState, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { buildOverviewSteppedLoad } from './planOverviewSteppedState';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isBinaryPlanDevice } from './planBinaryDevice';

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
    currentTarget: number;
    currentTemperature: number;
  } | null;
  // Observation staleness is observer-owned freshness state — the plan device no
  // longer carries it (the plan has no right to distrust observer data). The
  // gray-state UI label is a display concern, so the read model sources staleness
  // from the observer projection here, NOT off the plan device.
  getObservationStale?: (deviceId: string) => boolean;
  // Observational device kind, for the temperature card. Supplied as a
  // built-once map sourced from the raw, undecorated snapshot so there is no
  // re-decoration side effect. Stepped-ness is NOT resolved from a map: it is
  // the plan device's own ladder (`buildOverviewSteppedLoad`).
  getDeviceTypeById?: () => Map<string, 'temperature' | 'onoff'>;
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

function resolveOverviewTemperatureState(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps,
): { currentTarget: number | null; plannedTarget?: number; currentTemperature?: number } {
  const observed = deps.getObservedTemperature?.(device.id);
  const planned = isTemperaturePlanDevice(device) ? device : null;
  if (observed === null) {
    return { currentTarget: null, plannedTarget: planned?.plannedTarget };
  }
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
  confirmedSteppedLoadProfile?: SteppedLoadProfile,
): SettingsUiPlanDeviceSnapshot {
  // EV boost fields live on the orthogonal `EvKind` cluster (off the base);
  // narrow once so the snapshot can surface them. Non-EV devices have them
  // undefined. The raw `evChargingState` comes from the observer (its canonical
  // owner), NOT the plan device — see `getObservedEvChargingState`.
  const temperature = resolveOverviewTemperatureState(device, deps);
  // The stepped discriminant, from the device's own ladder. This site used to
  // reconstruct a `controlModel` setting producer-map-first, which made its
  // stepped rung unreachable — the map is built from the RAW snapshot and cannot
  // see a STORED ladder, so a device the owner had configured as a stepped load
  // was demoted to a generic card.
  const steppedLoad = buildOverviewSteppedLoad(device, confirmedSteppedLoadProfile);
  // The shared-domain label resolvers below take a `DeviceOverviewSnapshot`, which
  // names the draw `currentDrawKw` — the same producer-resolved field the plan
  // device carries — so the device passes through with only the control-model
  // and temperature overlays applied.
  const overviewShape = {
    ...device,
    ...temperature,
    steppedLoad,
    deviceType: producerDeviceType,
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
    deviceType: producerDeviceType,
    binaryControllable: isBinaryPlanDevice(device),
    deviceRole: deps.getObservedEvChargingState?.(device.id) !== undefined ? 'ev_charger' : undefined,
    evChargingState: deps.getObservedEvChargingState?.(device.id),
    carChargingState: deps.getAssociatedCarChargingState?.(device.id),
    currentTarget: temperature.currentTarget,
    plannedTarget: temperature.plannedTarget,
    currentTemperature: temperature.currentTemperature,
    currentDrawKw: device.currentDrawKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: isSteppedLoadDevice(device) ? device.planningPowerKw : undefined,
    budgetExempt: device.budgetExempt,
    temperatureBoost: device.temperatureBoost,
    temperatureBoostActive: device.temperatureBoostActive,
    surplusAbsorbActive: device.surplusAbsorbActive,
    evBoost: device.evBoost,
    evBoostActive: device.evBoostActive,
    // Projected to the one property the wire type declares rather than passed
    // whole: the observation layer's session/invalidation bookkeeping is its own
    // business, and `level` is the producer's complete answer to whether this
    // charger has a battery level (`notes/ev-soc-layering.md`).
    stateOfCharge: device.stateOfCharge ? { level: device.stateOfCharge.level } : undefined,
    // Display-only staleness, sourced from the observer (not the plan device).
    observationStale: deps.getObservationStale?.(device.id) ?? false,
    shedAction: device.shedAction,
    shedTemperature: device.shedTemperature,
    selectedStepId: isSteppedLoadDevice(device) ? device.selectedStepId : undefined,
    desiredStepId: device.desiredStepId,
    reportedStepId: device.reportedStepId,
    targetStepId: device.targetStepId,
    binaryCommandPending: device.binaryCommandPending,
    pendingTargetCommand: device.pendingTargetCommand,
    // These read the draw off a `DeviceOverviewSnapshot`, where `currentDrawKw`
    // is REQUIRED — a carrier that does not populate it no longer compiles. It
    // used to be optional, and a carrier that forgot it silently read
    // `undefined`, which `isSatisfiedTargetOnlyDevice` treats as `0 kW` and
    // labels a drawing target-only device "Idle". Since both sides now name the
    // producer-resolved `currentDrawKw`, the plan device satisfies the shape
    // directly and there is no adapter left to forget.
    stateKind: resolvePlanStateKind(overviewShape),
    stateTone: resolvePlanStateTone(overviewShape),
    reason: device.reason,
    starvation: deps.getOverviewStarvation?.(device.id) ?? undefined,
    steppedLoad,
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
        steppedLoadProfileById.get(device.id),
      )),
  };
}
