import type { DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import { isEvPlanDevice } from './planEvDevice';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { buildEffectiveShedPosture, isAnyOtherDeviceLimited } from './keepInvariantPosture';
import {
  resolveSteppedLoadDirectShedStepId,
  resolveSteppedShedCurrentDesiredStepId,
} from './planSteppedShedResolution';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { applySurplusAbsorbDelta, resolveSurplusEligibility, type PriceOptDeviceConfig } from './planSurplusAbsorb';
import { RECENT_RESTORE_SHED_GRACE_MS } from './planConstants';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import { applyOffStateReason } from './planOffStateReason';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { buildBasePlanDevice } from './planDevicesBase';
import {
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
  // Trust the producer-resolved label (`toPlanDevice` resolves it from the raw
  // observed state once); the raw binary axis it was folded from no longer rides
  // on the plan input.
  return device.currentState ?? 'unknown';
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
