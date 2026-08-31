import type { DevicePlanDevice, PlanInputDevice, ShedBehavior } from './planTypes';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { resolveSurplusCeilingStepId, type PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { PriceLevel } from '../price/priceLevels';
import { buildEffectiveShedPosture, isAnyOtherDeviceLimited } from './keepInvariantPosture';
import {
  resolveSteppedShedCurrentDesiredStepId,
  resolveSteppedShedHypotheticalStepId,
} from './planSteppedShedResolution';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { isCoolingCapableTemperatureDeviceClass } from '../../packages/shared-domain/src/temperatureDeviceKind';
import { applySurplusAbsorbDelta, type PriceOptDeviceConfig } from './planSurplusAbsorb';
import { isSurplusHeldDevice } from './shedding/surplusHold';
import { RECENT_RESTORE_SHED_GRACE_MS } from './planConstants';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import { applyOffStateReason } from './planOffStateReason';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { buildBasePlanDevice } from './planDevicesBase';
import { emitBoostStateChange, resolveBoostActive } from './planBoost';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { addPerfDuration } from '../utils/perfCounters';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';

export type PlanDevicesDeps = {
  getShedBehavior: (deviceId: string) => ShedBehavior;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  // Producer-resolved inferred curtailed-surplus term (kW, >= 0) for the surplus
  // allocator's pool; 0 = no inferred surplus. The producer
  // (`lib/solar/curtailmentSurplus.ts`, injected flat via setup wiring) owns
  // every safety decision about the term — this layer never re-validates it.
  getInferredSurplusKw: () => number;
  getOperatingMode?: () => string;
  /**
   * Producer-resolved: does THIS home hold a mode-target RAISE while its own
   * power reading is unknown? See `applyModeSeedModulation`. Absent = no hold
   * (the main home's binding, and every test that does not exercise it).
   */
  holdsModeTargetRaisesWhilePowerUnknown?: () => boolean;
  // Observer-owned pending-binary-command store; plan-side raw reads go
  // through `peek(id)` rather than `state.pendingBinaryCommands[id]`.
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  debugStructured?: StructuredDebugEmitter;
};

// `undefined` ⟺ the device is not a temperature device (no setpoint to plan).
// For a temperature device the resolution is TOTAL: the observer's atomic facet
// guarantees a finite current target, so every seed lane produces a number and
// there is no skip/grace state left to model.
type ResolvedPlannedTarget = number | undefined;
export function buildInitialPlanDevices(params: {
  context: PlanContext;
  state: PlanEngineState;
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  /**
   * The rung the shedding planner priced each stepped shed at. Copied onto the
   * device, never re-derived — see `resolveSteppedLoadDirectShedStepId`.
   */
  shedStepTargets: Map<string, string>;
  guardInShortfall: boolean;
  deps: PlanDevicesDeps;
}): DevicePlanDevice[] {
  const {
    context,
    state,
    shedSet,
    shedReasons,
    shedStepTargets,
    guardInShortfall,
    deps,
  } = params;
  // Drop entries that must NOT count as capacity-shed posture, so the keep-invariant
  // stepped clamp (docs/technical.md:222) is symmetric with the executor's
  // hasExecutableShedDevices: the phantom set_step shed entries it also ignores, PLUS
  // "Run on solar surplus" holds (an opt-in posture, not capacity pressure — mirrors the
  // executor's `awaitingSolarSurplus`-reason exclusion).
  const effectiveShedSet = buildEffectiveShedPosture({
    devices: context.devices,
    shedSet,
    isExcluded: (dev) => isPhantomSetStepShed({ dev, devices: context.devices, state, deps })
      || isSurplusOnlyHoldShed({ dev, state, shedReasons }),
  });
  // Per-stage accumulators (split inside the per-device loop). Emitted once
  // after the loop so the perf log shows where plan_devices_ms is going
  // without per-iteration log spam. Added during 2026-05-18 memory-regression
  // investigation; keep as a permanent diagnostic surface for future
  // regressions in this hot path.
  let setupMs = 0;
  let baseMs = 0;
  let offStateMs = 0;
  // Surplus-absorb eligibility is resolved BEFORE this materialization pass, in
  // `planBuilder.buildPlanSnapshotWithTimings` (hoisted so the standing dump-load
  // hold can read it when the shed set is assembled). This module only READS
  // `state.surplusEligibilityByDevice` — it never advances the allocator.
  const result = context.devices.map((dev) => {
    const t0 = Date.now();
    const priority = dev.priority;
    const plannedTarget = resolvePlannedTarget({
      dev,
      modeTargetCFor: context.modeTargetCFor,
      powerIsMeasured: context.powerIsMeasured,
      currentHourPriceLevel: context.currentHourPriceLevel,
      state,
      deps,
    });
    // Binary dump-load surplus flag: "PELS is running this device on solar
    // surplus right now" — eligible per the allocator, not held this cycle, and
    // actually observed on. `resolvePlannedTarget` above reset the per-cycle
    // default to false, so a released/held/off device can never carry a stale
    // true. Drives the card's "On to use your solar power" line.
    if (dev.surplusOnly === true && isBinaryPlanDevice(dev)) {
      state.surplusAbsorbActiveByDevice[dev.id] = state.surplusEligibilityByDevice[dev.id]?.eligible === true
        && !shedSet.has(dev.id)
        && dev.currentOn;
    }
    // The tracking modality's counterpart. `surplusCeilingStepId` is the rung the
    // allocator bought this device; it is passed FLAT to the base builder rather
    // than the builder reading engine state, matching how `surplusAbsorbActive`
    // and `boostActive` already cross that seam.
    const surplusCeilingStepId = dev.surplusTracking
      ? resolveSurplusCeilingStepId(state, dev.id)
      : undefined;
    if (dev.surplusTracking && isSteppedLoadDevice(dev)) {
      // "PELS is running this device on solar right now" — so the rung has to
      // have been PAID for, not merely held. While the release settle runs, an
      // eligible device keeps its cheapest rung on grid power; saying it is
      // running on solar there would be exactly the dishonesty the whole
      // surplus vocabulary is written to avoid.
      const decision = state.surplusTrackingByDevice[dev.id];
      state.surplusAbsorbActiveByDevice[dev.id] = !shedSet.has(dev.id)
        && decision?.kind === 'rung'
        && decision.funded;
    }
    const currentState = resolveCurrentState(dev);
    const controllable = dev.controllable;
    const shedBehavior: ShedBehavior = (
      isSteppedLoadDevice(dev) || isTemperaturePlanDevice(dev)
    )
      ? deps.getShedBehavior(dev.id)
      : { action: 'turn_off' };
    const previousBoostActive = state.boostActiveByDevice[dev.id] === true;
    const boostActive = resolveBoostActive(dev);
    emitBoostStateChange({ dev, previousActive: previousBoostActive, active: boostActive });
    setupMs += Date.now() - t0;
    const t1 = Date.now();
    const base = buildBasePlanDevice({
      dev,
      priority,
      recentlyRestored: isRecentlyRestored(state.lastDeviceRestoreMs[dev.id]),
      binaryCommandPending: deps.pendingBinaryCommandStore.hasActiveTurnOn(dev.id),
      currentState,
      plannedTarget,
      controllable,
      shedBehavior,
      shedSet,
      shedStepTargets,
      anyOtherDeviceLimited: isAnyOtherDeviceLimited(effectiveShedSet, dev.id),
      shedReasons,
      boostActive,
      // Set by resolvePlannedTarget above (read after it ran for this device).
      surplusAbsorbActive: state.surplusAbsorbActiveByDevice[dev.id] === true,
      surplusCeilingStepId,
    });
    baseMs += Date.now() - t1;
    state.boostActiveByDevice[dev.id] = base.boostActive;
    const t2 = Date.now();
    const withOffStateReason = applyOffStateReason({
      planDevice: base,
      headroomRaw: context.headroomRaw,
      guardInShortfall,
    });
    offStateMs += Date.now() - t2;
    return withOffStateReason;
  });
  addPerfDuration('plan_devices_setup_ms', setupMs);
  addPerfDuration('plan_devices_base_ms', baseMs);
  addPerfDuration('plan_devices_offstate_ms', offStateMs);
  return result;
}
function resolvePlannedTarget(params: {
  dev: PlanInputDevice;
  modeTargetCFor: (device: PlanInputDevice & TemperaturePlanInputKind) => number;
  /** Producer-resolved: did this cycle have a measurement at all. */
  powerIsMeasured: boolean;
  /** `context.currentHourPriceLevel`: producer-resolved once for this build. */
  currentHourPriceLevel: PriceLevel;
  state: PlanEngineState;
  deps: PlanDevicesDeps;
}): ResolvedPlannedTarget {
  const {
    dev,
    modeTargetCFor,
    powerIsMeasured,
    currentHourPriceLevel,
    state,
    deps,
  } = params;
  // Default: surplus is not the binding cause unless the mode branch below proves it is.
  // Reset every cycle for every device so a stale true never lingers.
  state.surplusAbsorbActiveByDevice[dev.id] = false;
  if (!isTemperaturePlanDevice(dev)) return undefined;
  // Capability METADATA (min/max/step) for normalization; the target VALUE truth
  // is the narrowed `dev.currentTarget` (the observer's atomic facet — always a
  // finite number for a temperature device).
  const target = getPrimaryTargetCapability(dev.targets);
  const deferredC = dev.deadlineFloorTargetC;
  const hasDeferred = typeof deferredC === 'number';
  const modulated = applyModeSeedModulation({
    seedValue: modeTargetCFor(dev),
    dev,
    config: deps.getPriceOptimizationSettings()[dev.id],
    observedTarget: dev.currentTarget,
    powerIsMeasured,
    currentHourPriceLevel,
    state,
    deps,
  });
  const resolved = resolveModulatedSeedTargets(modulated, { deferredC });
  if (resolved.done) return resolved.value;
  let plannedTarget = resolved.plannedTarget;
  // Track the same target with NO surplus lift in parallel, so surplus's "binding cause" can
  // be decided AFTER all floors AND capability normalization/rounding (below) — not latched
  // mid-computation.
  let nonSurplusTarget = resolved.nonSurplusTarget;
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

type ModeSeedModulation =
  | { kind: 'value'; plannedTarget: number; nonSurplusTarget: number }
  /** Held at the device's exact observed setpoint — the caller must emit it unnormalized. */
  | { kind: 'held_at_observed'; observedTarget: number };

/**
 * Fold a `ModeSeedModulation` into either a FINAL planned target (`done`) or
 * the planned/non-surplus pair the deferred-floor + normalization tail runs on.
 *
 * - `held_at_observed` without a deadline floor → the EXACT observed value,
 *   bypassing capability normalization: an off-step reading (18.6 with a 1°
 *   step) would otherwise round UP to 19 and defeat the executor's no-op fence
 *   with a load-adding write. Planned === observed is by construction a no-op.
 * - `held_at_observed` WITH a deadline floor → both members of the pair start
 *   at the observed value; the caller's floor/normalization tail lifts them.
 */
function resolveModulatedSeedTargets(
  modulated: ModeSeedModulation,
  params: {
    deferredC: number | undefined;
  },
): { done: true; value: number } | { done: false; plannedTarget: number; nonSurplusTarget: number } {
  const hasDeferred = typeof params.deferredC === 'number';
  if (modulated.kind === 'held_at_observed') {
    return hasDeferred
      ? { done: false, plannedTarget: modulated.observedTarget, nonSurplusTarget: modulated.observedTarget }
      : { done: true, value: modulated.observedTarget };
  }
  return { done: false, plannedTarget: modulated.plannedTarget, nonSurplusTarget: modulated.nonSurplusTarget };
}

/**
 * Price-opt + surplus modulation of a CONFIGURED mode setpoint, plus the
 * unknown-power hold.
 *
 * The hold stops a load-ADDING setpoint change while this home's draw is
 * unknown. Every other way the planner adds load is gated on headroom, which is
 * 0 or negative whenever no trustworthy total exists — but a mode target is issued as
 * an ordinary `target_update`, so it consults neither headroom nor the restore
 * cooldowns / startup stabilization (`lib/executor/executableTargetProjection.ts`
 * advances the restore clocks only for a write the producer stamped
 * `recordRestoreOnTargetApply`, so an 18→22 raise is not a restore).
 * Holding AT the device's own current setpoint makes the write a no-op rather
 * than dropping the device from the plan. Direction is class-aware:
 *
 * - Heat-direction devices (heater, thermostat, water heater): a RAISE is held;
 *   a LOWERING removes draw, so it still applies.
 * - Cooling-capable classes (`isCoolingCapableTemperatureDeviceClass` — heat
 *   pump, air conditioning, air treatment): BOTH directions are held, because
 *   lowering adds compressor load in cooling mode and PELS cannot observe which
 *   mode a reversible unit is in.
 * The deadline floor is applied by the caller AFTER this and is intentionally
 * exempt — a smart task's floor is a promise to the user, not opportunistic load.
 *
 * Producer-gated, not universal: only a home whose scope opts in
 * (`holdsModeTargetRaisesWhilePowerUnknown`) applies the hold. The main home
 * does not — its unknown-power window is normally the seconds before the first
 * Homey Energy poll, and it owns settle/dwell machinery of its own for the
 * power-goes-unknown transition (`lib/plan/planSurplusAbsorb.ts`) that a blanket
 * clamp would pre-empt. A meter area opts in because its window lasts as long as
 * its meter stays offline.
 */
function applyModeSeedModulation(params: {
  seedValue: number;
  dev: PlanInputDevice;
  config: PriceOptDeviceConfig | undefined;
  /**
   * The device's live target setpoint (`dev.currentTarget`), guaranteed finite
   * by the observer's atomic temperature facet — never absent for a temperature
   * device, so the unknown-power hold always has a value to hold at.
   */
  observedTarget: number;
  powerIsMeasured: boolean;
  currentHourPriceLevel: PriceLevel;
  state: PlanEngineState;
  deps: PlanDevicesDeps;
}): ModeSeedModulation {
  const { seedValue, dev, config, observedTarget, powerIsMeasured, currentHourPriceLevel, state, deps } = params;
  const pricedTarget = deps.getPriceOptimizationEnabled() && config?.enabled
    ? applyPriceOptimizationDelta(seedValue, config, currentHourPriceLevel)
    : seedValue;
  const surplusTarget = applySurplusAbsorbDelta({
    baseTarget: seedValue,
    pricedTarget,
    dev,
    config,
    state,
  });
  const holds = !powerIsMeasured && deps.holdsModeTargetRaisesWhilePowerUnknown?.() === true;
  if (!holds) return { kind: 'value', plannedTarget: surplusTarget, nonSurplusTarget: pricedTarget };
  const holdBothDirections = isCoolingCapableTemperatureDeviceClass(dev.deviceClass);
  if (holdBothDirections || surplusTarget > observedTarget) {
    return { kind: 'held_at_observed', observedTarget };
  }
  return { kind: 'value', plannedTarget: surplusTarget, nonSurplusTarget: pricedTarget };
}

function applyPriceOptimizationDelta(
  target: number,
  config: { cheapDelta: number; expensiveDelta: number },
  priceLevel: PriceLevel,
): number {
  if (priceLevel === PriceLevel.CHEAP && config.cheapDelta) {
    return target + config.cheapDelta;
  }
  if (priceLevel === PriceLevel.EXPENSIVE && config.expensiveDelta) {
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
//
// This is the one place that still RECOMPUTES a shed step, and deliberately so.
// It runs before selection, over every stepped `set_step` device rather than the
// chosen ones, and asks a hypothetical — "if this device were shed, would it
// move?" — so there is no planner decision to honour yet. Materialization is the
// opposite case and must never recompute: it is handed the rung the shed was
// priced at (`resolveSteppedLoadDirectShedStepId`).
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
  const directStepId = resolveSteppedShedHypotheticalStepId({
    dev, devices, state, shedBehavior: behavior,
    currentDesiredStepId: resolveSteppedShedCurrentDesiredStepId(dev),
  });
  return directStepId === undefined || directStepId === dev.selectedStepId;
}
// A "Run on solar surplus" hold is an opt-in posture (baseline off), not capacity
// pressure, so it must NOT count toward the keep-invariant stepped clamp (it would
// otherwise cap unrelated stepped loads at their lowest step while merely waiting
// for export). Precise mirror of the executor's `awaitingSolarSurplus`-reason
// exclusion: a surplusOnly device is a surplus HOLD only while it is not eligible
// (surplus not yet allocated) AND no FRESH shed decision (`shedReasons`) claimed it
// this cycle — exactly the condition under which `normalizeShedReasons` adopts the
// `awaitingSolarSurplus` reason. A dump load genuinely capacity-shed (in
// `shedReasons`) is excluded from this and still counts as posture.
function isSurplusOnlyHoldShed(params: {
  dev: PlanInputDevice;
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
}): boolean {
  const { dev, state, shedReasons } = params;
  // Delegates to `isSurplusHeldDevice`, the one definition shared with
  // `resolveSurplusHold`. These two were hand-mirrored and drifted once: the
  // proxy used here missed the release-pending window (eligible latched, still
  // off, `pendingSinceMs` set), letting a pump waiting for solar clamp unrelated
  // stepped loads to their lowest step. A fresh capacity shed reason still wins
  // — that is a real decision this cycle, not a standing posture.
  return !shedReasons.has(dev.id) && isSurplusHeldDevice(dev, state);
}
