import type { CapacityPeriodMinutes } from '../../packages/contracts/src/capacitySettings';
import { isObserveOnlyRoleClassKey } from '../../packages/shared-domain/src/observeOnlyRole';
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaMeasuredFields,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanMetaUnmeasuredFields,
  SettingsUiPlanDeviceStarvation,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import type { DevicePlan, PlanMeta } from './planTypes';
import type {
  ObservedStateOfCharge,
  EvChargingState,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type {
  ObservedEvChargingStateRead,
  ObservedStateOfChargeRead,
  ObservedTemperatureRead,
} from '../observer/observedDeviceStateProjection';
import { buildOverviewSteppedLoad } from './planOverviewSteppedState';
import { isBinaryPlanDevice } from './planBinaryDevice';
import {
  resolveOverviewTemperatureFacet,
} from './planOverviewTemperatureState';
import { formatDeviceStatusReason } from '../../packages/shared-domain/src/deviceStatusText';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import { buildDeviceStatus } from './deviceStatusReadModel';

export type SettingsOverviewReadModelDeps = {
  getDeviceExecutionState: (deviceId: string) => DeviceExecutionState;
  dryRun: boolean;
  nowMs: number;
  getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceStarvation | null | undefined;
  getIdleClassification?: (deviceId: string) => 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined;
  // EV charging state is observed state — the observer is its canonical source
  // (`ObservedDeviceState.evChargingState`), not the planner. The read model
  // uses it to resolve presentation; the raw string never reaches the UI.
  getObservedEvChargingState: (deviceId: string) => ObservedEvChargingStateRead;
  getAssociatedCarChargingState?: (deviceId: string) => EvChargingState | undefined;
  // The device's battery level, for the charger card. Observer-owned like the
  // plug-state above: the plan device carries the boost DECISION, never the
  // reading it was made from.
  getObservedStateOfCharge: (deviceId: string) => ObservedStateOfChargeRead;
  getObservedTemperature: (deviceId: string) => ObservedTemperatureRead;
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
function resolveHourBudgetKWh(
  capacityHourBudgetKWh: number,
  dailyBudgetHourKWh: number | undefined,
  capacityPeriodMinutes: CapacityPeriodMinutes,
): number {
  // Daily-budget allocations remain hourly. Dividing one into four equal
  // quarters would invent a constraint the daily planner never decided.
  if (capacityPeriodMinutes === 15) return capacityHourBudgetKWh;
  return dailyBudgetHourKWh === undefined
    ? capacityHourBudgetKWh
    : Math.min(capacityHourBudgetKWh, dailyBudgetHourKWh);
}

/**
 * The wire's measured figures, or the bare signal: the one branch on
 * `powerIsMeasured` the read model makes. The settings UI narrows on the same
 * discriminant once, at the hero's mount, and renders nothing computed when it
 * is false (owner ruling 2026-09-02).
 */
function resolveWireMeasuredFields(
  meta: PlanMeta,
): SettingsUiPlanMetaMeasuredFields | SettingsUiPlanMetaUnmeasuredFields {
  if (!meta.powerIsMeasured) return { powerIsMeasured: false };
  return {
    powerIsMeasured: true,
    controlledKw: meta.controlledKw,
    uncontrolledKw: meta.uncontrolledKw,
  };
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
    hardCapLimitKw: normalizedMeta.hardCapLimitKw,
    capacityPeriodMinutes: normalizedMeta.capacityPeriodMinutes,
    capacityPeriodCoverageComplete: normalizedMeta.capacityPeriodCoverageComplete,
    usedKWh: normalizedMeta.usedKWh,
    hourBudgetKWh: resolveHourBudgetKWh(
      capacityHourBudgetKWh,
      dailyBudgetHourKWh,
      normalizedMeta.capacityPeriodMinutes,
    ),
    minutesRemaining: normalizedMeta.minutesRemaining,
    hourControlledKWh: normalizedMeta.hourControlledKWh,
    hourUncontrolledKWh: normalizedMeta.hourUncontrolledKWh,
    lastPowerUpdateMs: normalizedMeta.lastPowerUpdateMs,
    ...resolveWireMeasuredFields(normalizedMeta),
  };
}

/**
 * The card's battery level. The observer already projected away its own
 * session/invalidation bookkeeping, so this reads the semantic result and
 * re-shapes nothing: `absent` is "this device reports no state of charge",
 * distinct from a present reading whose `level` says there is none
 * (`notes/ev-soc-layering.md`).
 */
function resolveOverviewStateOfCharge(
  deviceId: string,
  deps: SettingsOverviewReadModelDeps,
): ObservedStateOfCharge | undefined {
  const read = deps.getObservedStateOfCharge(deviceId);
  return read.kind === 'observed' ? read.value : undefined;
}

/**
 * The plug-state for the card, or nothing. `absent` is the observer having no
 * reading — not a statement that the device is not a charger, which is what
 * reading presence used to be pressed into meaning.
 */
function resolveOverviewEvChargingState(
  deviceId: string,
  deps: SettingsOverviewReadModelDeps,
): EvChargingState | undefined {
  const read = deps.getObservedEvChargingState(deviceId);
  return read.kind === 'observed' ? read.value : undefined;
}

export function buildSettingsOverviewDeviceReadModel(
  device: DevicePlan['devices'][number],
  deps: SettingsOverviewReadModelDeps,
  reasonAnchorMs: number,
  confirmedSteppedLoadProfile?: SteppedLoadProfile,
): SettingsUiPlanDeviceSnapshot {
  // The battery level comes from the seam that owns it
  // (`getObservedStateOfCharge`), and the raw `evChargingState` from the
  // observer — its canonical owner. Neither rides the plan device: there is no
  // EV cluster on the plan types (owner ruling 2026-08-15, `lib/plan/AGENTS.md`).
  // The owner's configured boost THRESHOLDS reach the settings UI from the
  // settings store directly and are not on this wire at all.
  const temperature = resolveOverviewTemperatureFacet(
    device,
    deps.getObservedTemperature(device.id),
  );
  const temperatureFields = temperature.kind === 'present'
    ? { temperature: temperature.value }
    : {};
  // The stepped discriminant, from the device's own ladder. This site used to
  // reconstruct a `controlModel` setting producer-map-first, which made its
  // stepped rung unreachable — the map is built from the RAW snapshot and cannot
  // see a STORED ladder, so a device the owner had configured as a stepped load
  // was demoted to a generic card.
  const execution = deps.getDeviceExecutionState(device.id);
  const steppedLoad = buildOverviewSteppedLoad(device, execution, confirmedSteppedLoadProfile);
  const starvation = deps.getOverviewStarvation?.(device.id) ?? undefined;
  const idleClassification = deps.getIdleClassification?.(device.id);
  const stateOfCharge = resolveOverviewStateOfCharge(device.id, deps);
  const overviewShape = {
    ...device,
    controllable: device.control.commandAuthority,
    ...temperatureFields,
    steppedLoad,
    currentState: execution.physicalState,
    available: execution.available,
    currentDrawKw: execution.currentDrawKw,
    binaryCommandPending: execution.binaryProgress === 'pending',
    pendingTargetCommand: execution.targetProgress === 'pending' ? true : undefined,
    execution, starvation, idleClassification, stateOfCharge,
    binaryControllable: isBinaryPlanDevice(device),
    evChargingState: resolveOverviewEvChargingState(device.id, deps),
    carChargingState: deps.getAssociatedCarChargingState?.(device.id),
  };
  const presentation = buildDeviceStatus(overviewShape, deps.dryRun, reasonAnchorMs);
  const status = presentation.reason?.countdown ? { ...presentation, reason: { ...presentation.reason,
    text: formatDeviceStatusReason(presentation, deps.nowMs)!,
  } } : presentation;
  return {
    id: device.id,
    name: device.name,
    deviceClass: device.deviceClass,
    controllable: device.control.commandAuthority,
    available: execution.available,
    status,
    deviceRole: device.deviceRole,
    ...(execution.currentDrawKw !== undefined ? { currentDrawKw: execution.currentDrawKw } : {}),
    budgetExempt: device.budgetExempt,
    boostActive: device.boostActive,
    stateOfCharge,
    starvation,
  };
}

export function buildSettingsOverviewReadModel(
  plan: DevicePlan | null,
  deps: SettingsOverviewReadModelDeps,
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
    // the overview. The device-list endpoint already drops them
    // (`getSettingsUiDevicesPayload`, `setup/settingsUiApi.ts`);
    // the overview derives from the plan snapshot, so it must drop them here too, or an
    // auto-tracked battery renders as a clickable no-op card.
    devices: plan.devices
      .filter((device) => !isObserveOnlyRoleClassKey(device.deviceClass))
      .map((device) => buildSettingsOverviewDeviceReadModel(
        device,
        deps,
        plan.generatedAtMs ?? deps.nowMs,
        steppedLoadProfileById.get(device.id),
      )),
  };
}
