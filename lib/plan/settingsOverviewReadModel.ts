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
import type {
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  EvChargingState,
  SteppedLoadProfile,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { PlannedTemperatureState } from '../../packages/shared-domain/src/plannedTemperatureState';
import type { ObservedTemperatureState } from '../observer/observedDeviceStateProjection';
import { buildOverviewSteppedLoad } from './planOverviewSteppedState';
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
  // The device's battery level, for the charger card. Observer-owned like the
  // plug-state above: the plan device carries the boost DECISION, never the
  // reading it was made from.
  getObservedStateOfCharge?: (deviceId: string) => DeviceStateOfChargeSnapshot | undefined;
  // The owner's configured boost thresholds, for the card's boost panel. These
  // are settings, so they come from the producer that owns the settings seam —
  // the planner is not a courier for configuration it does not read.
  getEvBoostConfig?: (deviceId: string) => EvBoostConfig | undefined;
  getTemperatureBoostConfig?: (deviceId: string) => TemperatureBoostConfig | undefined;
  getObservedTemperature?: (deviceId: string) => ObservedTemperatureState | null;
  // Observation staleness is observer-owned freshness state — the plan device no
  // longer carries it (the plan has no right to distrust observer data). The
  // gray-state UI label is a display concern, so the read model sources staleness
  // from the observer projection here, NOT off the plan device.
  getObservationStale?: (deviceId: string) => boolean;
  // Observational device kind, for the temperature card. Supplied as a
  // built-once map sourced from the raw, undecorated snapshot so there is no
  // re-decoration side effect. Stepped-ness is NOT resolved from a map: it is
  // the plan device's own ladder (`buildOverviewSteppedLoad`).
  getSteppedLoadProfileById?: () => Map<string, SteppedLoadProfile>;
};

function resolveFiniteKWh(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * TOTAL — it always has an answer, so the hero never has to render "no budget".
 *
 * The capacity budget is required on the plan meta (`resolveUsableCapacityKw`
 * of the configured limit, computed every cycle), so the only genuinely
 * optional input is the daily allocation, which is absent when the daily budget
 * is off or the bucket index is out of range. "No daily budget" means the
 * capacity budget binds — not that there is no budget.
 *
 * This used to collect both into an array, filter the numbers out and return
 * `undefined` for an empty list. That empty case was unreachable, and modelling
 * it forced the wire type to declare the field optional, which pushed a
 * `typeof budgetKWh !== 'number'` guard into the hero.
 */
function resolveHourBudgetKWh(params: {
  capacityHourBudgetKWh: number;
  dailyBudgetHourKWh: number | undefined;
}): number {
  const { capacityHourBudgetKWh, dailyBudgetHourKWh } = params;
  return dailyBudgetHourKWh === undefined
    ? capacityHourBudgetKWh
    : Math.min(capacityHourBudgetKWh, dailyBudgetHourKWh);
}

/**
 * Projects the planner's meta onto the settings-UI wire shape.
 *
 * FIELD-BY-FIELD, deliberately — this used to `...spread` the normalized planner
 * meta, which is why half the wire payload was fields no consumer read. A spread
 * bypasses excess-property checking, so every field the planner grew arrived on
 * the wire whether or not anything wanted it, and removing one from the DTO did
 * not stop it being emitted. Listing them makes the wire an actual decision:
 * adding a field here is deliberate, and a planner-side addition stays off the
 * wire until someone puts it here.
 *
 * `capacityHourBudgetKWh` and `dailyBudgetHourKWh` stay local. They are the two
 * inputs to the effective hour budget and nothing renders them; only the
 * resolved `hourBudgetKWh` crosses.
 */
function buildSettingsOverviewMetaReadModel(meta: DevicePlan['meta']): SettingsUiPlanMetaSnapshot {
  const normalizedMeta = normalizePlanMeta(meta);
  // Read directly: `budgetKWh` is required on the plan meta. The daily
  // allocation keeps its finiteness gate because it is genuinely optional.
  const capacityHourBudgetKWh = normalizedMeta.budgetKWh;
  const dailyBudgetHourKWh = resolveFiniteKWh(normalizedMeta.dailyBudgetHourKWh);
  return {
    totalKw: normalizedMeta.totalKw,
    softLimitKw: normalizedMeta.softLimitKw,
    capacitySoftLimitKw: normalizedMeta.capacitySoftLimitKw,
    budgetPaceKw: normalizedMeta.budgetPaceKw,
    projectedExemptKw: normalizedMeta.projectedExemptKw,
    softLimitSource: normalizedMeta.softLimitSource,
    headroomKw: normalizedMeta.headroomKw,
    powerFreshnessState: normalizedMeta.powerFreshnessState,
    hardCapLimitKw: normalizedMeta.hardCapLimitKw,
    usedKWh: normalizedMeta.usedKWh,
    hourBudgetKWh: resolveHourBudgetKWh({ capacityHourBudgetKWh, dailyBudgetHourKWh }),
    minutesRemaining: normalizedMeta.minutesRemaining,
    controlledKw: normalizedMeta.controlledKw,
    uncontrolledKw: normalizedMeta.uncontrolledKw,
    hourControlledKWh: normalizedMeta.hourControlledKWh,
    hourUncontrolledKWh: normalizedMeta.hourUncontrolledKWh,
    lastPowerUpdateMs: normalizedMeta.lastPowerUpdateMs,
  };
}

/**
 * The overview's temperature facet, atomic like everything upstream of it:
 * the complete trio or nothing. The OBSERVED pair wins when the observer
 * answers (it is fresher than the plan snapshot, and it still answers when
 * temperature CONTROL is disabled — the card keeps showing what the device
 * reports); `plannedTarget` is the planner's decision, defaulting to the
 * observed target ("no commanded change") when the device is not
 * temperature-planned this cycle. An observer `null` (the device is no longer
 * temperature-observed) drops the facet wholly — there are no partial or
 * nullable temperature fields on this DTO.
 */
function resolveOverviewTemperatureFacet(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps,
): PlannedTemperatureState | undefined {
  const observed = deps.getObservedTemperature?.(device.id);
  const planned = isTemperaturePlanDevice(device) ? device : null;
  if (observed === null) return undefined;
  if (observed !== undefined) {
    return {
      currentTarget: observed.currentTarget,
      currentTemperature: observed.currentTemperature,
      plannedTarget: planned?.plannedTarget ?? observed.currentTarget,
    };
  }
  return planned
    ? {
      currentTarget: planned.currentTarget,
      currentTemperature: planned.currentTemperature,
      plannedTarget: planned.plannedTarget,
    }
    : undefined;
}

/**
 * Which boost the card should describe. The planner holds ONE boost decision
 * (`boostActive`) — it cannot tell a state-of-charge boost from a temperature
 * one, and has no business doing so — but the wire still carries two flags to
 * pick the card's boost wording, so the AXIS is resolved here from what owns it:
 * the observer's charger identity, plus a configured SoC threshold for a
 * `target_power` charger that exposes no plug state. A boosting device that is
 * neither boosts on temperature; nothing else can be boost-supported at all.
 *
 * Reading the axis off the boost CONFIG instead would be wrong for the case that
 * matters most: a smart-task rescue forces boost on a device whose owner
 * configured no threshold, and that card must still say what it is doing.
 */
/**
 * The card's battery level, projected to the one property the wire type declares
 * rather than passed whole: the observation layer's session/invalidation
 * bookkeeping is its own business, and `level` is the producer's complete answer
 * to whether this charger has a battery level (`notes/ev-soc-layering.md`).
 */
function resolveOverviewStateOfCharge(
  deviceId: string,
  deps: SettingsOverviewReadModelDeps,
): { level: DeviceStateOfChargeSnapshot['level'] } | undefined {
  const stateOfCharge = deps.getObservedStateOfCharge?.(deviceId);
  return stateOfCharge ? { level: stateOfCharge.level } : undefined;
}

function resolveBoostAxis(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps,
): { evBoostActive: boolean; temperatureBoostActive: boolean } {
  if (!device.boostActive) return { evBoostActive: false, temperatureBoostActive: false };
  const onStateOfCharge = deps.getObservedEvChargingState?.(device.id) !== undefined
    || deps.getEvBoostConfig?.(device.id) !== undefined;
  return { evBoostActive: onStateOfCharge, temperatureBoostActive: !onStateOfCharge };
}

export function buildSettingsOverviewDeviceReadModel(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps = {},
  confirmedSteppedLoadProfile?: SteppedLoadProfile,
): SettingsUiPlanDeviceSnapshot {
  // EV boost fields live on the orthogonal `EvKind` cluster (off the base);
  // narrow once so the snapshot can surface them. Non-EV devices have them
  // undefined. The raw `evChargingState` comes from the observer (its canonical
  // owner), NOT the plan device — see `getObservedEvChargingState`.
  const temperature = resolveOverviewTemperatureFacet(device, deps);
  const temperatureFields = temperature !== undefined ? { temperature } : {};
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
    ...temperatureFields,
    steppedLoad,
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
    binaryControllable: isBinaryPlanDevice(device),
    deviceRole: deps.getObservedEvChargingState?.(device.id) !== undefined ? 'ev_charger' : undefined,
    evChargingState: deps.getObservedEvChargingState?.(device.id),
    carChargingState: deps.getAssociatedCarChargingState?.(device.id),
    ...temperatureFields,
    currentDrawKw: device.currentDrawKw,
    expectedPowerKw: device.expectedPowerKw,

    budgetExempt: device.budgetExempt,
    temperatureBoost: deps.getTemperatureBoostConfig?.(device.id),
    surplusAbsorbActive: device.surplusAbsorbActive,
    evBoost: deps.getEvBoostConfig?.(device.id),
    ...resolveBoostAxis(device, deps),
    // Projected to the one property the wire type declares rather than passed
    // whole: the observation layer's session/invalidation bookkeeping is its own
    // business, and `level` is the producer's complete answer to whether this
    // charger has a battery level (`notes/ev-soc-layering.md`).
    stateOfCharge: resolveOverviewStateOfCharge(device.id, deps),
    // Display-only staleness, sourced from the observer (not the plan device).
    observationStale: deps.getObservationStale?.(device.id) ?? false,
    shedAction: device.shedAction,
    shedTemperature: device.shedTemperature,
    // No flat step ids or planning power: every stepped fact rides the
    // `steppedLoad` cluster, built once by `buildOverviewSteppedLoad`. Emitting
    // both was how the corrected target id ended up with an uncorrected twin.
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
        steppedLoadProfileById.get(device.id),
      )),
  };
}
