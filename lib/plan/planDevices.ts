import type { DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import {
  withBinaryDiscriminant, withEvDiscriminant, withSteppedDiscriminant, withTemperatureDiscriminant,
} from './planTypes';
import { isEvPlanDevice } from './planEvDevice';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { resolveShedIntent } from '../device/deviceActionProjection';
import { materializeShedSnapshotFields } from './planActionMaterialization';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { buildEffectiveShedPosture, isAnyOtherDeviceLimited } from './keepInvariantPosture';
import {
  resolveSteppedLoadDirectShedStepId,
  resolveSteppedShedCurrentDesiredStepId,
} from './planSteppedShedResolution';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { getRestoreDrawKw } from '../observer/observedPower';
import { applySurplusAbsorbDelta, resolveSurplusEligibility, type PriceOptDeviceConfig } from './planSurplusAbsorb';
import { RECENT_RESTORE_SHED_GRACE_MS } from './planConstants';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import { applyOffStateReason } from './planOffStateReason';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadInitialDesiredStepId,
} from './planSteppedLoad';
import { isBinaryPlanDevice } from './planBinaryDevice';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { resolveObservedCurrentState } from '../observer/observedState';
import {
  buildBoostPlanDeviceFields,
  emitEvBoostStateChange,
  resolveEvBoostActive,
} from './planEvBoost';
import {
  emitTemperatureBoostStateChange,
  resolveTemperatureBoostActive,
  supportsTemperatureBoostDevice,
} from './planTemperatureBoost';
import { addPerfDuration } from '../utils/perfCounters';
import { getLogger } from '../logging/logger';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  clearMissingModeEmitState,
  rememberModeTargetCapability,
  resolveMissingModeTargetSeed,
  type ResolvedModeTargetSeed,
} from './planModeTargetGuard';

const logger = getLogger('plan/devices');

export type PlanDevicesDeps = {
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  getOperatingMode?: () => string;
  // Observer-owned pending-binary-command store; plan-side raw reads go
  // through `peek(id)` rather than `state.pendingBinaryCommands[id]`.
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  debugStructured?: StructuredDebugEmitter;
};

const SKIP_PLANNED_TARGET = Symbol('skip-planned-target');
type ResolvedPlannedTarget = number | undefined | typeof SKIP_PLANNED_TARGET;
const supportsTemperatureDevice = (device: PlanInputDevice): boolean => {
  return supportsTemperatureBoostDevice(device);
};
export function buildInitialPlanDevices(params: {
  context: PlanContext;
  state: PlanEngineState;
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  guardInShortfall: boolean;
  deps: PlanDevicesDeps;
}): DevicePlanDevice[] {
  const {
    context,
    state,
    shedSet,
    shedReasons,
    guardInShortfall,
    deps,
  } = params;
  // Filter the executor-side phantom set_step shed entries that hasExecutableShedDevices
  // ignores, so the keep-invariant shed clamp (docs/technical.md:222) is symmetric.
  const effectiveShedSet = buildEffectiveShedPosture({
    devices: context.devices,
    shedSet,
    isPhantom: (dev) => isPhantomSetStepShed({ dev, devices: context.devices, state, deps }),
  });
  // Per-stage accumulators (split inside the per-device loop). Emitted once
  // after the loop so the perf log shows where plan_devices_ms is going
  // without per-iteration log spam. Added during 2026-05-18 memory-regression
  // investigation; keep as a permanent diagnostic surface for future
  // regressions in this hot path.
  let setupMs = 0;
  let baseMs = 0;
  let offStateMs = 0;
  // Producer pass: resolve surplus-absorb eligibility across all willing devices,
  // reserving the export budget in priority order, before per-device target prep
  // reads the resulting flat bit. Capacity-independent — it reads the signed net
  // (context.total) + device draws, never headroom/shed state.
  resolveSurplusEligibility({
    devices: context.devices,
    state,
    signedNetKw: context.total,
    powerKnown: context.powerKnown,
    getConfig: (deviceId) => deps.getPriceOptimizationSettings()[deviceId],
    getPriority: deps.getPriorityForDevice,
  });
  const result = context.devices.flatMap((dev) => {
    const t0 = Date.now();
    const supportsTemperature = supportsTemperatureDevice(dev);
    const priority = deps.getPriorityForDevice(dev.id);
    const plannedTarget = resolvePlannedTarget({
      dev,
      desiredForMode: context.desiredForMode,
      supportsTemperature,
      state,
      deps,
    });
    if (plannedTarget === SKIP_PLANNED_TARGET) {
      setupMs += Date.now() - t0;
      return [];
    }
    const currentTarget = getPrimaryTargetCapability(dev.targets)?.value ?? null;
    const currentState = resolveCurrentState(dev);
    const controllable = dev.controllable !== false;
    const shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null } = (
      isSteppedLoadDevice(dev) || supportsTemperature
    )
      ? deps.getShedBehavior(dev.id)
      : { action: 'turn_off', temperature: null, stepId: null };
    const previousActive = state.temperatureBoostActiveByDevice[dev.id] === true;
    const active = resolveTemperatureBoostActive(dev);
    emitTemperatureBoostStateChange({ dev, previousActive, active });
    const previousEvBoostActive = state.evBoostActiveByDevice[dev.id] === true;
    const evBoostActive = resolveEvBoostActive(dev);
    emitEvBoostStateChange({
      dev,
      previousActive: previousEvBoostActive,
      active: evBoostActive,
    });
    setupMs += Date.now() - t0;
    const t1 = Date.now();
    const base = buildBasePlanDevice({
      dev,
      devices: context.devices,
      state,
      priority,
      recentlyRestored: isRecentlyRestored(state.lastDeviceRestoreMs[dev.id]),
      binaryCommandPending: isPendingBinaryCommandActive({
        pending: deps.pendingBinaryCommandStore.peek(dev.id),
        communicationModel: dev.communicationModel,
      }) && deps.pendingBinaryCommandStore.peek(dev.id)?.desired === true,
      currentState,
      currentTarget,
      plannedTarget,
      controllable,
      shedBehavior,
      shedSet,
      anyOtherDeviceLimited: isAnyOtherDeviceLimited(effectiveShedSet, dev.id),
      shedReasons,
      temperatureBoostActive: active,
      evBoostActive,
      // Set by resolvePlannedTarget above (read after it ran for this device).
      surplusAbsorbActive: state.surplusAbsorbActiveByDevice[dev.id] === true,
    });
    baseMs += Date.now() - t1;
    state.temperatureBoostActiveByDevice[dev.id] = base.temperatureBoostActive === true;
    // `evBoostActive` lives on the orthogonal `EvKind` cluster; narrow before
    // reading. Non-EV devices never have boost active, so the `false` fallback
    // matches the prior behaviour.
    state.evBoostActiveByDevice[dev.id] = isEvPlanDevice(base) && base.evBoostActive === true;
    const t2 = Date.now();
    const withOffStateReason = applyOffStateReason({
      planDevice: base,
      headroomRaw: context.headroomRaw,
      guardInShortfall,
    });
    offStateMs += Date.now() - t2;
    return [withOffStateReason];
  });
  addPerfDuration('plan_devices_setup_ms', setupMs);
  addPerfDuration('plan_devices_base_ms', baseMs);
  addPerfDuration('plan_devices_offstate_ms', offStateMs);
  return result;
}
function resolvePlannedTarget(params: {
  dev: PlanInputDevice;
  desiredForMode: Record<string, number>;
  supportsTemperature: boolean;
  state: PlanEngineState;
  deps: PlanDevicesDeps;
}): ResolvedPlannedTarget {
  const {
    dev,
    desiredForMode,
    supportsTemperature,
    state,
    deps,
  } = params;
  // Default: surplus is not the binding cause unless the mode branch below proves it is.
  // Reset every cycle for every device so a stale true never lingers.
  state.surplusAbsorbActiveByDevice[dev.id] = false;
  if (!supportsTemperature) return undefined;
  const target = getPrimaryTargetCapability(dev.targets);
  const deferredC = dev.deadlineFloorTargetC;
  const hasDeferred = typeof deferredC === 'number';
  const seed = resolveTemperatureSeed(dev, desiredForMode[dev.id], target, state, deps);
  if (seed.kind === 'skip') {
    // An active deadline objective is itself a strong signal that PELS should plan for the
    // device. When the mode target and current capability value are both missing, use the
    // deferred target as the rescue seed instead of dropping the device. Price-opt is not
    // applied to the deadline target; see comment below.
    if (!hasDeferred) return SKIP_PLANNED_TARGET;
    return normalizeTargetCapabilityValue({ target, value: deferredC });
  }
  if (seed.kind === 'grace_fallback') {
    // During the abandon-grace window the capability read is transiently
    // failing, so `currentTarget` is null. Emitting any `plannedTarget` (cached
    // value or deferred floor) would mismatch `currentTarget` and queue a
    // spurious `set_temperature` actuation each cycle (the executor's
    // `Object.is(observedValue, desired)` skip can't trip when `observedValue`
    // is undefined). Hold off on planning a target value until the SDK comes
    // back — the device stays in the plan with measured power intact so the
    // cascade math still accounts for it; we just don't actuate. When grace
    // exhausts, the seed becomes `skip` and the existing path applies the
    // deferred floor if any.
    return undefined;
  }
  let plannedTarget = seed.value;
  // Track the same target with NO surplus lift in parallel, so surplus's "binding cause" can
  // be decided AFTER all floors AND capability normalization/rounding (below) — not latched
  // mid-computation. Price-opt and surplus-absorb only modulate a configured mode setpoint;
  // for a current-reading fallback or deadline rescue seed, leaving it unmodulated keeps PELS
  // a no-op against whatever the user / deadline already chose.
  let nonSurplusTarget = seed.value;
  const priceOptConfig = deps.getPriceOptimizationSettings()[dev.id];
  if (seed.kind === 'mode') {
    if (deps.getPriceOptimizationEnabled() && priceOptConfig?.enabled) {
      plannedTarget = applyPriceOptimizationDelta(plannedTarget, priceOptConfig, deps);
    }
    nonSurplusTarget = plannedTarget;
    plannedTarget = applySurplusAbsorbDelta({
      baseTarget: seed.value,
      pricedTarget: plannedTarget,
      dev,
      config: priceOptConfig,
      state,
    });
  }
  if (hasDeferred) {
    // The deadline floor applies to both the actual and the non-surplus target.
    plannedTarget = Math.max(plannedTarget, deferredC);
    nonSurplusTarget = Math.max(nonSurplusTarget, deferredC);
  }
  const normalizedTarget = normalizeTargetCapabilityValue({ target, value: plannedTarget });
  const normalizedNonSurplus = normalizeTargetCapabilityValue({ target, value: nonSurplusTarget });
  // Surplus is the binding cause only when, after floors AND capability normalization, the
  // commanded target is strictly higher than it would be WITHOUT the lift. This is false when
  // a deadline floor lands on the surplus value (no extra lift) and when a sub-step delta
  // rounds back to the original setpoint (the device would draw identically without solar).
  state.surplusAbsorbActiveByDevice[dev.id] = typeof normalizedTarget === 'number'
    && typeof normalizedNonSurplus === 'number'
    && normalizedTarget > normalizedNonSurplus;
  return normalizedTarget;
}

function resolveTemperatureSeed(
  dev: PlanInputDevice,
  desired: number | undefined,
  target: ReturnType<typeof getPrimaryTargetCapability>,
  state: PlanEngineState,
  deps: PlanDevicesDeps,
): ResolvedModeTargetSeed {
  const fallback = target?.value;
  const targetCapabilityId = target?.id;
  // Always refresh the cached capability value when a fresh read is available
  // (even if the mode target is also present) so a future double-miss can ride
  // out the grace window. Cache is keyed by capability ID so a re-pair during
  // grace can't reuse a value against a different capability.
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    rememberModeTargetCapability(state, dev.id, fallback, targetCapabilityId);
  }
  if (Number.isFinite(desired)) {
    // Mode target is set — clear any missing-mode emit throttling so the next
    // transition back into missing emits immediately. Cache (if any) is
    // preserved separately above.
    clearMissingModeEmitState(state, dev.id);
    return { kind: 'mode', value: Number(desired) };
  }
  // Mode target missing — delegate fallback / grace / skip + throttled emit
  // to the shared mode-target guard (see `planModeTargetGuard.ts`).
  return resolveMissingModeTargetSeed({
    state,
    deviceId: dev.id,
    capabilityValue: fallback,
    capabilityId: targetCapabilityId,
    payload: { deviceId: dev.id, deviceName: dev.name, operatingMode: deps.getOperatingMode?.() ?? null },
    debugStructured: deps.debugStructured,
    logger,
  });
}
function applyPriceOptimizationDelta(
  target: number,
  config: { cheapDelta: number; expensiveDelta: number },
  deps: Pick<PlanDevicesDeps, 'isCurrentHourCheap' | 'isCurrentHourExpensive'>,
): number {
  if (deps.isCurrentHourCheap() && config.cheapDelta) {
    return target + config.cheapDelta;
  }
  if (deps.isCurrentHourExpensive() && config.expensiveDelta) {
    return target + config.expensiveDelta;
  }
  return target;
}
function resolveCurrentState(device: PlanInputDevice): string {
  return resolveObservedCurrentState(device);
}
// For shed stepped-load devices at the off step, expectedPowerKw should reflect the lowest
// positive step so that restore planning uses a realistic power estimate rather than zero.
function resolveExpectedPowerKw(
  dev: PlanInputDevice,
  currentState: string,
  plannedState: 'shed' | 'keep',
  effectiveDesiredStepId: string | undefined,
): number | undefined {
  const steppedExpectedPowerKw = resolveSteppedExpectedPowerKw({
    dev,
    currentState,
    plannedState,
    effectiveDesiredStepId,
  });
  if (steppedExpectedPowerKw !== null) return steppedExpectedPowerKw;
  if (!hasKnownPowerFields(dev)) return undefined;
  return getRestoreDrawKw(dev).kw;
}
function resolveSteppedExpectedPowerKw(params: {
  dev: PlanInputDevice;
  currentState: string;
  plannedState: 'shed' | 'keep';
  effectiveDesiredStepId: string | undefined;
}): number | null {
  const {
    dev,
    currentState,
    plannedState,
    effectiveDesiredStepId,
  } = params;
  if (
    plannedState === 'keep'
    && currentState === 'off'
    && isSteppedLoadDevice(dev)
  ) {
    const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, effectiveDesiredStepId);
    if (desiredStep && desiredStep.planningPowerW > 0) {
      return desiredStep.planningPowerW / 1000;
    }
  }
  if (
    plannedState === 'shed'
    && isSteppedLoadDevice(dev)
    && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId)
  ) {
    const lowestActiveStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
    if (lowestActiveStep) {
      return lowestActiveStep.planningPowerW / 1000;
    }
  }
  return null;
}
function hasKnownPowerFields(dev: PlanInputDevice): boolean {
  return Number.isFinite(dev.measuredPowerKw)
    || Number.isFinite(dev.expectedPowerKw)
    || Number.isFinite(dev.planningPowerKw)
    || Number.isFinite(dev.powerKw);
}

// Source the temperature sensor reading from the input device through the
// temperature narrowing (the plan-input base omits `currentTemperature`). Kept
// as a standalone helper so `buildBasePlanDevice` stays under the complexity cap.
function resolveInputCurrentTemperature(dev: PlanInputDevice): number | undefined {
  return isTemperaturePlanDevice(dev) ? dev.currentTemperature : undefined;
}

// Source the binary cluster only when the input device is binary this cycle;
// `withBinaryDiscriminant` re-derives presence from `controlCapabilityId`. The
// producer-resolved `currentOn` (the public on/off truth) is forwarded from the
// input device unchanged — it is resolved once at `toPlanDevice`, not recomputed.
function resolveInputBinaryControlField(
  dev: PlanInputDevice,
): { binaryControl?: { on: boolean }; currentOn?: boolean } {
  return isBinaryPlanDevice(dev)
    ? { binaryControl: dev.binaryControl, currentOn: dev.currentOn }
    : {};
}

function buildBasePlanDevice(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: PlanEngineState;
  priority: number;
  recentlyRestored: boolean;
  binaryCommandPending: boolean;
  currentState: string;
  currentTarget: number | null;
  plannedTarget: number | undefined;
  controllable: boolean;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  shedSet: Set<string>;
  anyOtherDeviceLimited: boolean;
  shedReasons: Map<string, DeviceReason>;
  temperatureBoostActive: boolean;
  evBoostActive: boolean;
  surplusAbsorbActive: boolean;
}): DevicePlanDevice {
  const {
    dev,
    devices,
    state,
    priority,
    recentlyRestored,
    binaryCommandPending,
    currentState,
    currentTarget,
    plannedTarget,
    controllable,
    shedBehavior,
    shedSet,
    shedReasons,
    temperatureBoostActive,
    evBoostActive,
    surplusAbsorbActive,
  } = params;
  const initialDesiredStepId = resolveSteppedLoadInitialDesiredStepId(dev);
  const runtimeDesiredStepId = dev.desiredStepId ?? initialDesiredStepId;
  const directShedStepId = resolveSteppedLoadDirectShedStepId({
    dev,
    devices,
    state,
    shedBehavior,
    shouldShed: shedSet.has(dev.id),
    currentDesiredStepId: resolveSteppedShedCurrentDesiredStepId(dev),
  });
  const shedDesiredStepId = directShedStepId;
  const desiredStepId = shedDesiredStepId ?? runtimeDesiredStepId;
  const isSteppedShed = isSteppedLoadDevice(dev)
    && shedDesiredStepId !== undefined
    && shedDesiredStepId !== dev.selectedStepId;
  const plannedState = resolvePlannedState(controllable, shedSet.has(dev.id) || isSteppedShed);
  const effectiveDesiredStepId = resolveSteppedKeepDesiredStepId({
    ...dev,
    currentState,
    plannedState,
    desiredStepId,
  }, { anyOtherDeviceLimited: params.anyOtherDeviceLimited });
  const baseReason: DeviceReason = controllable
    ? shedReasons.get(dev.id) ?? { code: PLAN_REASON_CODES.keep, detail: recentlyRestored ? 'recently restored' : null }
    : { code: PLAN_REASON_CODES.capacityControlOff };
  const { shedAction, shedTemperature, releaseShedStepId } = resolveShedAction({
    dev,
    controllable,
    shouldShed: shedSet.has(dev.id),
    shedBehavior,
  });
  const resolvedPlannedTarget = shedAction === 'set_temperature' && shedTemperature !== null
    ? shedTemperature
    : plannedTarget;
  // The stepped, EV, temperature, and binary discriminants are set explicitly in
  // the loose literal, then re-tied: `withEvDiscriminant`/`withTemperatureDiscriminant`/
  // `withBinaryDiscriminant` regroup their orthogonal clusters (binary keyed on
  // `controlCapabilityId` presence) and `withSteppedDiscriminant` lands the result
  // in one stepped union member. The temperature sensor reading is sourced from the
  // input device through the temperature narrowing (the base omits `currentTemperature`).
  return withSteppedDiscriminant(withTemperatureDiscriminant(withEvDiscriminant(withBinaryDiscriminant({
    id: dev.id,
    name: dev.name,
    deviceClass: dev.deviceClass,
    deviceType: dev.deviceType,
    ...resolveInputBinaryControlField(dev),
    currentState,
    plannedState,
    currentTarget,
    currentTemperature: resolveInputCurrentTemperature(dev),
    ...(resolvedPlannedTarget !== undefined ? { plannedTarget: resolvedPlannedTarget } : {}),
    observationStale: dev.observationStale,
    communicationModel: dev.communicationModel,
    steppedLoadProfile: isSteppedLoadDevice(dev) ? dev.steppedLoadProfile : undefined,
    reportedStepId: dev.reportedStepId,
    targetStepId: effectiveDesiredStepId,
    selectedStepId: dev.selectedStepId,
    desiredStepId: effectiveDesiredStepId,
    previousStepId: dev.previousStepId,
    lastDesiredStepId: dev.desiredStepId,
    lastStepCommandIssuedAt: dev.lastStepCommandIssuedAt,
    stepCommandRetryCount: dev.stepCommandRetryCount,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
    priority,
    powerKw: dev.powerKw,
    expectedPowerKw: resolveExpectedPowerKw(dev, currentState, plannedState, effectiveDesiredStepId),
    planningPowerKw: dev.planningPowerKw,
    expectedPowerSource: dev.expectedPowerSource,
    measuredPowerKw: dev.measuredPowerKw,
    controlCapabilityId: dev.controlCapabilityId,
    controlAdapter: dev.controlAdapter,
    // Flat EV plug-state sub-fields are base fields materialized once upstream at
    // `toPlanDevice`; forward them straight from the input device onto the output
    // plan device (no EV narrowing needed — they live on the base).
    evBlockReason: dev.evBlockReason,
    evSessionInactive: dev.evSessionInactive,
    evChargerNotResumable: dev.evChargerNotResumable,
    reason: baseReason,
    zone: dev.zone || 'Unknown',
    controllable,
    budgetExempt: dev.budgetExempt,
    available: dev.available,
    ...buildBoostPlanDeviceFields({ dev, temperatureBoostActive, evBoostActive, surplusAbsorbActive }),
    stepCommandPending: dev.stepCommandPending,
    stepCommandStatus: dev.stepCommandStatus,
    binaryCommandPending: binaryCommandPending || undefined,
    shedAction,
    shedTemperature,
    releaseShedStepId,
    ...pickPropagatedPlanFields(dev),
  }))));
}

function pickPropagatedPlanFields(
  dev: Pick<
    PlanInputDevice,
    'stepPowerCalibration' | 'hasRecentObservedDrawAtSelectedStep' | 'residualKw'
  >,
): Partial<Pick<
  DevicePlanDevice,
  'stepPowerCalibration' | 'hasRecentObservedDrawAtSelectedStep' | 'residualKw'
>> {
  return {
    ...(dev.stepPowerCalibration ? { stepPowerCalibration: dev.stepPowerCalibration } : {}),
    ...(dev.hasRecentObservedDrawAtSelectedStep !== undefined
      ? { hasRecentObservedDrawAtSelectedStep: dev.hasRecentObservedDrawAtSelectedStep }
      : {}),
    ...(dev.residualKw ? { residualKw: dev.residualKw } : {}),
  };
}
function isRecentlyRestored(lastRestoreMs: number | undefined): boolean {
  if (!lastRestoreMs) return false;
  return Date.now() - lastRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
}
// Mirrors isDroppedUnderspecifiedSetStepShed at plan-build time, minus the
// !isHeldByRestoreAdmission conjunct: plan reasons aren't computed at this pre-pass.
// Mild inverse-direction asymmetry vs. lib/executor/executablePlanProjection.ts:126-135 —
// tracked as a P3 in TODO.md.
function isPhantomSetStepShed(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: PlanEngineState;
  deps: PlanDevicesDeps;
}): boolean {
  const { dev, devices, state, deps } = params;
  if (!isSteppedLoadDevice(dev)) return false;
  const behavior = deps.getShedBehavior(dev.id);
  if (behavior.action !== 'set_step') return false;
  const directStepId = resolveSteppedLoadDirectShedStepId({
    dev, devices, state, shedBehavior: behavior, shouldShed: true,
    currentDesiredStepId: resolveSteppedShedCurrentDesiredStepId(dev),
  });
  return directStepId === undefined || directStepId === dev.selectedStepId;
}

function resolvePlannedState(controllable: boolean, shouldShed: boolean): 'shed' | 'keep' {
  if (!controllable) return 'keep';
  return shouldShed ? 'shed' : 'keep';
}
function resolveShedAction(params: {
  dev: PlanInputDevice;
  controllable: boolean;
  shouldShed: boolean;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
}): { shedAction: ShedAction; shedTemperature: number | null; releaseShedStepId: string | null } {
  const { dev, controllable, shouldShed, shedBehavior } = params;
  // Single resolution site for the shed-action intent. Called once here with
  // the post-admission `controllable` so the deferred-objective rescue lane
  // (`applyDeferredAdmissionToInput`) is honoured. The materialiser then only
  // gates on the per-cycle `shouldShed` decision (no producer equivalent).
  const intent = resolveShedIntent({
    shedBehavior,
    controllable,
    controlCapabilityId: dev.controlCapabilityId,
    steppedLoadProfile: isSteppedLoadDevice(dev) ? dev.steppedLoadProfile : undefined,
    primaryTarget: getPrimaryTargetCapability(dev.targets),
  });
  return materializeShedSnapshotFields({
    intent,
    shouldShed,
  });
}
