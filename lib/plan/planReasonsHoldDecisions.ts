import type {
  DevicePlanDevice, ShedBehavior, TemperatureKind, TemperatureShedBehavior,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { shedFloorCFor } from './normalizedShedFloor';
import type { PlanEngineState } from './planState';
import type { HeadroomReserve } from './admission';
import type { RestoreHeadroomLedger } from './restore/headroomLedger';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  classifyPlanReason,
  renderPlanReasonDecision,
  type PlanReasonDecision,
} from './planReasonStrings';
import { isBudgetReason, isShortfallReason, isSwapReason } from './planReasonsShared';
import { RESTORE_CONFIRM_RETRY_MS } from './planConstants';
import {
  NEUTRAL_STARTUP_HOLD_REASON,
  resolveOffDeviceReason,
  type OffDeviceReasonTiming,
} from './restore/devices';
import {
  buildRestoreCooldownPreviewState,
  resolveGlobalRestoreHold,
  resolveRestoreDecision,
  type HoldDecision,
  type RestoreCooldownPreviewState,
} from './planReasonsRestoreGating';
import type { RestoreCooldownPreview } from './restore/types';

type PendingRestoreDelay = { remainingSec: number; countdownStartedAtMs: number; countdownTotalSec: number };

// The terminal fallback of `getProducerShedReason`. It asserts a POWER-ceiling
// hold on nothing stronger than "some hold applies", so it is the one shape the
// timing ladder may replace (`resolveHoldReason`); every other shape is a
// decision a producer actually made.
const CAPACITY_FALLBACK_REASON: PlanReasonDecision = {
  code: 'existing',
  reason: { code: PLAN_REASON_CODES.capacity },
};

// The reason a producer decided for this device — a fresh shed entry, or a
// carried shortfall/swap/budget reason. `null` when none did, which is exactly
// when the caller may fall back or substitute a timing cause.
function getProducerShedReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, DeviceReason>;
}): PlanReasonDecision | null {
  const { dev, shedReasons } = params;
  const explicitReason = shedReasons.get(dev.id);
  if (explicitReason) return { code: 'existing', reason: explicitReason };

  const classifiedReason = classifyPlanReason(dev.reason);
  if (
    classifiedReason.reason
    && (isShortfallReason(classifiedReason) || isSwapReason(classifiedReason) || isBudgetReason(classifiedReason))
  ) {
    return { code: 'existing', reason: classifiedReason.reason };
  }

  return null;
}

// "The DEVICE reports the shed floor" — read off the observation, never off
// `plannedTarget`, which this lane writes back every cycle. Compared against
// the capability-NORMALIZED floor: the device reports the normalized value,
// so a raw-config comparison never matches for an off-step configured floor
// (`normalizedShedFloor.ts`).
function isObservedAtShedFloor(
  dev: DevicePlanDevice,
  floorC: number,
): boolean {
  return isTemperaturePlanDevice(dev)
    && dev.currentTarget === floorC;
}

/**
 * The reason a held setpoint device carries out of this lane.
 *
 * The `capacity` fallback says "the power ceiling is holding you", which the
 * card renders as a kW gap the owner could close by freeing power. Under a
 * restore cooldown, a shed cooldown, or startup stabilization that sentence is
 * false — no amount of freed power lifts a timer — and the admission arithmetic
 * downstream then finds no gap to state, leaving the bare "Waiting to resume".
 * So when no producer decided a reason, the binary lane's ladder names the
 * cause, and the two lanes stop disagreeing about the same timer.
 *
 * Gated on the floor being OBSERVED, for the reason `resolveRestoreDecision`
 * documents for its own reserve carve-out: `cooldownRestore` is in
 * `RESTORE_ADMISSION_HOLD_REASON_CODES`, so `buildExecutableTargetIntent`
 * (`lib/executor/executableTargetProjection.ts`) builds NO write for a device
 * carrying it. That is free once the device sits at its floor — there is nothing
 * left to write — but while the shed is still in flight (a dropped write, or a
 * setpoint raised outside PELS) the actuating fallback must keep asserting, or
 * the device draws unchecked for the whole 60–300 s cooldown. The gate covers
 * every ladder outcome, not just that one code, so adding a code to the set
 * cannot silently reopen it.
 */
function resolveHoldReason(params: {
  dev: DevicePlanDevice;
  floorC: number;
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  timing: OffDeviceReasonTiming;
  shouldHold: boolean;
}): PlanReasonDecision {
  const { dev, floorC, state, shedReasons, timing, shouldHold } = params;
  const producerReason = getProducerShedReason({ dev, shedReasons });
  if (producerReason) return producerReason;
  // `shouldHold` false means the shortfall guard aborted the restore with no
  // timing window at all; the ladder has no cause to name there.
  if (!shouldHold || !isObservedAtShedFloor(dev, floorC)) return CAPACITY_FALLBACK_REASON;
  const timedReason = resolveOffDeviceReason(
    timing,
    renderPlanReasonDecision(CAPACITY_FALLBACK_REASON),
    state.lastDeviceControlledMs[dev.id],
  );
  // `null` = startup window on a device PELS has never controlled. The binary
  // lane answers that with the no-actuation neutral hold; here the fallback
  // stands, so the hold keeps a reason its own lane can act on.
  return timedReason === null ? CAPACITY_FALLBACK_REASON : { code: 'existing', reason: timedReason };
}

export type ShedHoldParams = {
  planDevices: DevicePlanDevice[];
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  // The rest of this cycle's `RestoreTiming`, so the hold lane can name WHICH of
  // the four `inShedWindow` causes is holding a device instead of defaulting to
  // the power ceiling. Required, like every other timing field here: optional
  // would let a caller mint a countdown reason with no countdown attached — a
  // shape production never produces.
  inStartupStabilization: boolean;
  restoreCooldownStartedAtMs: number | null;
  restoreCooldownTotalSec: number | null;
  // Per-axis ledger carried over from the restore pass: a budget-exempt
  // setpoint-shed device admits its raise against the CAPACITY axis, exactly
  // like the binary/stepped lanes. Optional so scalar-only callers/tests keep
  // the single-track behavior.
  ledger?: RestoreHeadroomLedger;
  // This cycle's startup reservations, resolved once by the restore pass. A
  // setpoint-shed restore admits against them exactly like the binary/stepped
  // lanes (`restore/gating.ts`) — a raise into a reserved block is PELS giving
  // the promised power away. Optional so scalar-only callers/tests opt out.
  headroomReserves?: readonly HeadroomReserve[];
  guardInShortfall?: boolean;
  debugStructured?: StructuredDebugEmitter;
  restoreCooldownPreview?: RestoreCooldownPreview | null;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  /**
   * The capability-normalized shed floor per temperature device, resolved once
   * per build from the INPUT devices (the plan device carries no capability
   * metadata). This is the SAME value `resolveShedIntent` stamps on a freshly
   * shed device and the shed candidate builder filters on — one floor value
   * per device per build. `applyHoldUpdate` must stamp from here, never the
   * raw configured `behavior.temperature`: an at-floor device is filtered out
   * of shed candidacy, so the held-build fallback is the COMMON case, and a
   * raw stamp for an off-step configured floor plans a setpoint the device
   * can never report back — a futile re-write per cycle — and flip-flops the
   * pre-shed anchor's pinned floor (`preShedAnchor.ts`), destroying the
   * anchor while the device is still parked.
   */
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
};

export function applyShedTemperatureHold(params: ShedHoldParams): {
  planDevices: DevicePlanDevice[];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  // Post-pass per-axis availability, for the reason-normalization stage to
  // compute per-device shortfalls against the SAME axes this lane debited —
  // rebuilding from the restore-pass axes there would miss the temperature
  // restores admitted here and over-report availability. `null` when the
  // caller ran scalar-only (no ledger supplied).
  ledgerAxes: { capacityAvailableKw: number; budgetAvailableKw: number | null } | null;
} {
  const {
    planDevices,
    state,
    shedReasons,
    inShedWindow,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    ledger,
    headroomReserves,
    guardInShortfall = false,
    debugStructured,
    getShedBehavior,
    restoreCooldownPreview,
    normalizedShedFloorCByDevice,
  } = params;

  // The shed-window facts, assembled once per cycle in the shape the shared
  // reason ladder reads (`resolveOffDeviceReason`).
  const offDeviceTiming: OffDeviceReasonTiming = {
    activeOvershoot: params.activeOvershoot,
    inCooldown: params.inCooldown,
    inStartupStabilization: params.inStartupStabilization,
    restoreCooldownSeconds,
    shedCooldownRemainingSec: params.shedCooldownRemainingSec,
    shedCooldownStartedAtMs: params.shedCooldownStartedAtMs,
    shedCooldownTotalSec: params.shedCooldownTotalSec,
    restoreCooldownStartedAtMs: params.restoreCooldownStartedAtMs,
    restoreCooldownTotalSec: params.restoreCooldownTotalSec,
  };

  let headroom = availableHeadroom;
  let restoredOne = restoredOneThisCycle;
  const nextDevices: DevicePlanDevice[] = [];
  const pendingRestoreDelay = getPendingRestoreDelay(
    planDevices, state, getShedBehavior, normalizedShedFloorCByDevice,
  );
  const cooldownPreviewState = restoreCooldownPreview
    ? buildRestoreCooldownPreviewState(restoreCooldownPreview)
    : undefined;

  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    let availableForDevice = headroom;
    if (cooldownPreviewState) availableForDevice = cooldownPreviewState.ledger.availableFor(dev);
    else if (ledger) availableForDevice = ledger.availableFor(dev);
    const result = applyHoldToDevice({
      dev,
      behavior,
      normalizedShedFloorCByDevice,
      state,
      shedReasons,
      inShedWindow,
      offDeviceTiming,
      availableHeadroom: availableForDevice,
      restoredOneThisCycle: restoredOne,
      restoredThisCycle,
      holdDuringRestoreCooldown,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelay,
      headroomReserves,
      guardInShortfall,
      debugStructured,
      cooldownPreviewState,
    });
    if (ledger) {
      ledger.commit(dev, availableForDevice - result.availableHeadroom);
      headroom = ledger.summaryAvailableKw();
    } else if (!cooldownPreviewState) {
      headroom = result.availableHeadroom;
    }
    restoredOne = result.restoredOneThisCycle;
    nextDevices.push(result.device);
  }

  return {
    planDevices: nextDevices,
    availableHeadroom: headroom,
    restoredOneThisCycle: restoredOne,
    ledgerAxes: ledger ? ledger.axes() : null,
  };
}

function resolveHoldGating(params: {
  dev: DevicePlanDevice;
  floorC: number;
  state: PlanEngineState;
  inShedWindow: boolean;
  holdDuringRestoreCooldown: boolean;
  guardInShortfall: boolean;
}): { shouldAbortRestoreForShortfall: boolean; shouldHold: boolean; wasShedLastPlan: boolean } {
  const { dev, floorC, state, inShedWindow, holdDuringRestoreCooldown, guardInShortfall } = params;
  const isTemperature = isTemperaturePlanDevice(dev);
  // All three floor facts read the NORMALIZED floor — the observation and the
  // hold stamps both carry normalized values, so a raw comparison would make
  // an off-step-floor device ineligible for the hold and let it restore
  // through startup stabilization or an active overshoot.
  const atMinTemp = isTemperature
    && (dev.currentTarget === floorC || dev.plannedTarget === floorC);
  const alreadyMinTempShed = dev.shedAction === 'set_temperature' && dev.shedTemperature === floorC;
  const wasShedLastPlan = state.lastPlannedShedIds.has(dev.id);
  const eligible = dev.plannedState === 'shed' || atMinTemp || alreadyMinTempShed || wasShedLastPlan;
  const shouldAbortRestoreForShortfall = guardInShortfall && eligible;
  const shouldHold = (inShedWindow || holdDuringRestoreCooldown) && eligible;
  return { shouldAbortRestoreForShortfall, shouldHold, wasShedLastPlan };
}

function resolveHoldDecision(params: {
  dev: DevicePlanDevice;
  behavior: TemperatureShedBehavior;
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  inShedWindow: boolean;
  offDeviceTiming: OffDeviceReasonTiming;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelay: PendingRestoreDelay | null;
  headroomReserves?: readonly HeadroomReserve[];
  guardInShortfall: boolean;
  debugStructured?: StructuredDebugEmitter;
  cooldownPreviewState?: RestoreCooldownPreviewState;
}): HoldDecision {
  const {
    dev,
    behavior,
    normalizedShedFloorCByDevice,
    state,
    shedReasons,
    inShedWindow,
    offDeviceTiming,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelay,
    headroomReserves,
    guardInShortfall, debugStructured, cooldownPreviewState,
  } = params;

  if (dev.controllable === false) {
    return { type: 'skip' };
  }

  // ONE floor per device per build: every comparison below reads the
  // capability-normalized floor (`normalizedShedFloor.ts`), never raw config.
  const floorC = shedFloorCFor(normalizedShedFloorCByDevice, dev.id, behavior);
  const { shouldAbortRestoreForShortfall, shouldHold, wasShedLastPlan } = resolveHoldGating({
    dev,
    floorC,
    state,
    inShedWindow,
    holdDuringRestoreCooldown,
    guardInShortfall,
  });

  const observedAtShedFloor = isObservedAtShedFloor(dev, floorC);
  const globalRestoreHold = resolveGlobalRestoreHold(cooldownPreviewState, wasShedLastPlan, observedAtShedFloor);
  if (globalRestoreHold) return globalRestoreHold;
  const shouldResolveRestore = wasShedLastPlan && (
    (!shouldAbortRestoreForShortfall && !shouldHold)
    || (holdDuringRestoreCooldown && cooldownPreviewState !== undefined && observedAtShedFloor)
  );
  if (shouldResolveRestore) {
    // "Observed at the shed floor" means the DEVICE reports the floor target —
    // not the plan's own `plannedTarget`, which the hold writes back each
    // cycle. Until the floor is observed, a reserve block must keep asserting
    // the original shed (an actuating reason) rather than the no-actuation
    // `reservedForStart` hold, or the pending floor command stops being
    // retried and the device keeps drawing inside the reserved block.
    return resolvePostHoldRestoreDecision({
      dev,
      state,
      availableHeadroom,
      restoredOneThisCycle,
      restoredThisCycle,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelay,
      headroomReserves,
      observedAtShedFloor,
      baseShedReason: getProducerShedReason({ dev, shedReasons }) ?? CAPACITY_FALLBACK_REASON,
      debugStructured,
      cooldownPreview: cooldownPreviewState,
    });
  }

  if (!shouldAbortRestoreForShortfall && !shouldHold) {
    return { type: 'skip' };
  }

  return {
    type: 'hold',
    reason: resolveHoldReason({
      dev,
      floorC,
      state,
      shedReasons,
      timing: offDeviceTiming,
      shouldHold,
    }),
  };
}

function resolvePostHoldRestoreDecision(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelay: PendingRestoreDelay | null;
  headroomReserves?: readonly HeadroomReserve[];
  observedAtShedFloor?: boolean;
  baseShedReason?: PlanReasonDecision;
  debugStructured?: StructuredDebugEmitter;
  cooldownPreview?: RestoreCooldownPreviewState;
}): HoldDecision {
  const {
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelay,
    headroomReserves,
    observedAtShedFloor,
    baseShedReason,
    debugStructured,
    cooldownPreview,
  } = params;
  if (pendingRestoreDelay !== null) {
    return {
      type: 'hold',
      reason: {
        code: 'restore_pending',
        remainingSec: pendingRestoreDelay.remainingSec,
        countdownTiming: {
          countdownStartedAtMs: pendingRestoreDelay.countdownStartedAtMs,
          countdownTotalSec: pendingRestoreDelay.countdownTotalSec,
        },
      },
    };
  }
  return resolveRestoreDecision({
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    headroomReserves,
    observedAtShedFloor,
    baseShedReason,
    debugStructured,
    cooldownPreview,
  });
}

function applyHoldToDevice(params: {
  dev: DevicePlanDevice;
  behavior: ShedBehavior;
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  inShedWindow: boolean;
  offDeviceTiming: OffDeviceReasonTiming;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelay: PendingRestoreDelay | null;
  headroomReserves?: readonly HeadroomReserve[];
  guardInShortfall: boolean;
  debugStructured?: StructuredDebugEmitter;
  cooldownPreviewState?: RestoreCooldownPreviewState;
}): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    behavior,
    normalizedShedFloorCByDevice,
    state,
    shedReasons,
    inShedWindow,
    offDeviceTiming,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelay,
    headroomReserves,
    guardInShortfall,
    debugStructured,
    cooldownPreviewState,
  } = params;

  if (dev.plannedState === 'shed' && dev.reason.code === NEUTRAL_STARTUP_HOLD_REASON.code) {
    return { device: dev, availableHeadroom, restoredOneThisCycle };
  }

  // This whole lane is the SETPOINT hold: everything below reads a shed floor and
  // writes a `plannedTarget`, so it needs a device with a setpoint and a
  // behaviour that names one. Both narrows used to sit inside
  // `resolveHoldDecision` as `skip`s, which return this same value; they are
  // hoisted so `applyHoldUpdate` inherits them instead of re-checking.
  if (behavior.action !== 'set_temperature' || !isTemperaturePlanDevice(dev)) {
    return { device: dev, availableHeadroom, restoredOneThisCycle };
  }

  const decision = resolveHoldDecision({
    dev,
    behavior,
    normalizedShedFloorCByDevice,
    state,
    shedReasons,
    inShedWindow,
    offDeviceTiming,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelay,
    headroomReserves,
    guardInShortfall,
    debugStructured,
    cooldownPreviewState,
  });

  if (decision.type === 'restore') {
    return {
      device: dev,
      availableHeadroom: decision.availableHeadroom,
      restoredOneThisCycle: decision.restoredOneThisCycle,
    };
  }
  if (decision.type === 'hold') {
    return applyHoldUpdate({
      dev,
      behavior,
      normalizedShedFloorCByDevice,
      reason: renderPlanReasonDecision(decision.reason),
      availableHeadroom,
      restoredOneThisCycle,
    });
  }
  return { device: dev, availableHeadroom, restoredOneThisCycle };
}

function getPendingRestoreDelay(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
  getShedBehavior: (deviceId: string) => ShedBehavior,
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
): PendingRestoreDelay | null {
  let maxRemainingMs = 0;
  let countdownStartedAtMs: number | null = null;
  const nowMs = Date.now();
  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    if (behavior.action !== 'set_temperature') continue;
    if (!isTemperaturePlanDevice(dev)) continue;
    const floorC = shedFloorCFor(normalizedShedFloorCByDevice, dev.id, behavior);
    if (dev.currentTarget !== floorC) continue;
    if (dev.plannedTarget <= floorC) continue;

    const lastRestoreMs = state.lastDeviceRestoreMs[dev.id];
    if (!lastRestoreMs) continue;

    const elapsedMs = nowMs - lastRestoreMs;
    const remainingMs = RESTORE_CONFIRM_RETRY_MS - elapsedMs;
    if (remainingMs > maxRemainingMs) {
      maxRemainingMs = remainingMs;
      countdownStartedAtMs = lastRestoreMs;
    }
  }
  if (maxRemainingMs <= 0 || countdownStartedAtMs === null) return null;
  return {
    remainingSec: Math.ceil(maxRemainingMs / 1000),
    countdownStartedAtMs,
    countdownTotalSec: Math.ceil(RESTORE_CONFIRM_RETRY_MS / 1000),
  };
}

function applyHoldUpdate(params: {
  dev: DevicePlanDevice & TemperatureKind;
  behavior: TemperatureShedBehavior;
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  reason: DeviceReason;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
}): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, behavior, normalizedShedFloorCByDevice, reason, availableHeadroom, restoredOneThisCycle } = params;
  // Annotated so `plannedTarget` lands on the temperature cluster rather than
  // reading as a stray property on the bare union. It used to ride in through a
  // `behavior.temperature !== null` conditional spread — a branch the caller's
  // narrow has already decided, and one that could never have been false.
  //
  // The floor VALUE comes from the per-build normalized map (semantics on
  // `ShedHoldParams.normalizedShedFloorCByDevice`) so every stage stamps the
  // SAME capability-normalized floor a fresh shed would. The raw fallback is
  // the map-absent case only — a caller that resolved no capability floor for
  // this device (scalar-only test harnesses) — never the ordinary held build.
  const floorC = shedFloorCFor(normalizedShedFloorCByDevice, dev.id, behavior);
  const device: DevicePlanDevice & TemperatureKind = {
    ...dev,
    plannedState: 'shed',
    shedAction: 'set_temperature',
    shedTemperature: floorC,
    plannedTarget: floorC,
    reason,
  };
  return { device, availableHeadroom, restoredOneThisCycle };
}
