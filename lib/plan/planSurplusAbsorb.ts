import { resolveSurplusCeilingStepId, type PlanEngineState } from './planState';
import type { ResolvedPriceOptimizationConfig } from '../price/priceOptimizer';
import type { DeviceControlPosture } from '../../packages/planner-types/src/planInputDevice';
import type { MeteredPlanInputDevice, PlanInputDevice } from './planTypes';
import { isMeteredPlanDevice } from './planMeteredDevice';
import type { StructuredDebugEmitter } from '../logging/logger';
import type {
  SteppedLoadProfile,
  SteppedLoadStep,
  TargetCapabilitySnapshot,
} from '../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { getHighestKnownPowerKw } from '../observer/observedPower';
import {
  clearSurplusEligibility,
  clearSurplusTracking,
  SURPLUS_ABSORB_HARD_OFF_IMPORT_KW,
  SURPLUS_ABSORB_RESERVE_KW,
  SURPLUS_TRACK_STEP_MIN_INTERVAL_MS,
  syncSurplusEligibilityState,
} from './admission';
import { hasTemperatureBoostTarget } from '../../packages/shared-domain/src/settings/temperatureBoost';
import { resolveBoostActive } from './planBoost';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import {
  isSteppedLoadDevice,
  resolveHighestStepWithinKw,
} from './planSteppedLoad';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { IDLE_MEASURED_POWER_THRESHOLD_KW } from '../observer/idleDetector';

// A surplus LIFT is a setpoint raise, so it only means anything on a device with
// a temperature target to raise. This is the one place the question is asked;
// it moved here from the retired `planTemperatureBoost.ts` when the two per-kind
// boost modules collapsed into the generic `planBoost.ts`.
const supportsTemperatureLift = (device: PlanInputDevice): boolean => (
  hasTemperatureBoostTarget(device.targets)
);

// Per-device price-opt blob, extended with the surplus-absorb opt-in fields it
// rides. By convention the planner keeps a local structural copy of this blob
// (matching the inline shapes in planEngine/planBuilder) so it depends on the
// settings-deps seam rather than lib/price's persistence type. The settings
// adapter has already resolved legacy omissions before this reaches planning.
export type PriceOptDeviceConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  surplusWilling: boolean;
  surplusDelta: number;
};

type SurplusConfig = Pick<PriceOptDeviceConfig, 'surplusWilling' | 'surplusDelta'>;

const positiveOrZero = (value: unknown): number => (isFiniteNumber(value) && value > 0 ? value : 0);

// A device only absorbs surplus when it is willing AND has a real (finite, > 0)
// lift configured; a no-op (zero/absent/NaN delta) must not be admitted to the
// allocator, or it would reserve export it never draws and starve lower-priority
// devices.
const willingWithLift = (config: SurplusConfig | undefined): boolean => (
  config !== undefined && config.surplusWilling && config.surplusDelta > 0
);

/**
 * "Run on solar surplus" dump-load candidacy (PR-7) — the SINGLE resolution of
 * the binary posture, evaluated once by the producer (`toPlanDevice`) onto the
 * flat `PlanInputDevice.surplusOnly` bit. The same `surplusWilling` opt-in in
 * the per-device price-opt blob disambiguates by modality: a temperature device
 * gets the setpoint lift (above), a plain binary device gets this baseline-off
 * dump-load posture (`surplusDelta` is ignored). Candidates are exactly the
 * plain binary loads: not temperature (no `target_temperature`), not stepped,
 * not continuous / target-power, not EV (class or `evcharger_charging`
 * capability), and both managed and power-limit-controllable. The
 * continuous/target-power/non-binary classification is pre-resolved AT THE
 * PRODUCER into the flat `plainBinaryControlModel` bit, so this planner helper
 * carries no control-model / target-power branch (control-model vocab rule).
 * Structural params so the producer can
 * call it on the raw snapshot; the runtime predicates match the plan guards AND
 * the settings-UI gate (`resolveDeviceDetailControlMode !== 'default'`), so
 * runtime candidacy never disagrees with what the toggle offers — a device the
 * UI classifies continuous/preset/stepped is never stamped `surplusOnly`.
 *
 * Candidacy is SOURCE-INDEPENDENT but NOT unconditional. It used to carry a
 * `meteredPowerSource` bit on the premise that surplus "physically cannot exist
 * on the flow power source". That reasoning was wrong — both sources report
 * signed net, and the measured pool is `-signedNetKw` (`composeSurplusPool`)
 * with no production term in its path — but the bit was doing real work, and
 * dropping it outright re-opened the trap it had been holding shut: a device
 * stamped `surplusOnly` in a home whose pool can never open is held OFF
 * forever by `resolveSurplusHold`, with no time-based escape.
 *
 * `surplusPoolReachable` replaces it with the honest question — has this home
 * been observed to export, or can its curtailment estimator contribute? — which
 * is a runtime fact about accumulated evidence rather than a property of the
 * configured source. A flow home sending `import − export` passes it; a flow
 * home whose Flow predates signed watts does not, and its dump load keeps
 * running. Resolved at the producer (`resolveSurplusPoolReachable`) so this
 * helper carries no tracker or estimator branch.
 */
export function resolveSurplusOnlyPosture(params: {
  surplusWilling: boolean;
  hasBinaryControl: boolean;
  // Producer-resolved: being off means going without. A dump load qualifies; a
  // charger does not, because its demand arrives with a car. Asked as this bit
  // rather than as the device's kind — the planner does not get to know which
  // kinds exist (`PlanInputDevice.hasStandingDemand`).
  hasStandingDemand: boolean;
  targets: readonly TargetCapabilitySnapshot[] | undefined;
  steppedLoadProfile: SteppedLoadProfile | undefined;
  // Producer-resolved: true only for a plain binary-power control device — i.e.
  // NOT an enabled continuous / target-power (EV-preset) config and NOT a
  // non-binary control model. Resolved at the producer so this planner helper
  // carries no target-power / control-model branch.
  plainBinaryControlModel: boolean;
  control: DeviceControlPosture;
  // Producer-resolved: can this home's surplus pool ever be non-zero? False
  // means no surplus can arrive, so stamping the posture would hold the device
  // off indefinitely rather than merely leaving it idle.
  surplusPoolReachable: boolean;
}): boolean {
  return params.surplusWilling
    && params.surplusPoolReachable
    && params.hasBinaryControl
    && params.hasStandingDemand
    && !isSteppedLoadSnapshot(params)
    && params.plainBinaryControlModel
    && params.targets?.some((target) => target.id === 'target_temperature') !== true
    && params.control.commandAuthority
    && params.control.managed;
}

/**
 * "Match solar surplus" TRACKING candidacy — the modulating third modality,
 * resolved once by the producer onto the flat `PlanInputDevice.surplusTracking`
 * bit exactly as {@link resolveSurplusOnlyPosture} is. The same `surplusWilling`
 * opt-in disambiguates by modality: a temperature device gets the setpoint lift,
 * a plain binary device gets the baseline-off dump-load hold, and a device with
 * a usable step ladder gets this one — the allocator parks it on the highest
 * rung its allocated surplus covers.
 *
 * Candidacy is the ladder, not the device kind. An EV charger under a
 * current-control preset qualifies because it is a stepped load, not because it
 * is an EV; a manually configured stepped water heater qualifies on identical
 * terms. That is deliberate — the planner does not get to know which kinds exist
 * (`lib/plan/AGENTS.md`, `scripts/check-ev-vocab.mjs`).
 *
 * Two gates from the binary posture are deliberately ABSENT:
 *
 * - `plainBinaryControlModel`, which exists to keep stepped/continuous/preset
 *   devices out of the binary hold. Those devices are precisely this modality's
 *   subject, so the bit is inverted here rather than required.
 * - `hasStandingDemand`, which carries two arguments: that being off means going
 *   without, and that a charger with no car would reserve surplus it never
 *   draws. The first does not apply — a tracking device's ladder floor IS its
 *   "going without", and the floor policy is the owner's answer to it. The
 *   second is real, and is answered at the allocator by `commandableNow` (an
 *   unplugged charger claims nothing), which is the honest mechanism rather than
 *   a bit that only names EVs.
 */
export function resolveSurplusTrackingPosture(params: {
  surplusWilling: boolean;
  targets: readonly TargetCapabilitySnapshot[] | undefined;
  steppedLoadProfile: SteppedLoadProfile | undefined;
  control: DeviceControlPosture;
  // Same producer-resolved question as the binary posture: can this home's
  // surplus pool ever be non-zero? False means stamping the posture would clamp
  // the device to its floor forever rather than merely leaving it unmodulated.
  surplusPoolReachable: boolean;
}): boolean {
  return params.surplusWilling
    && params.surplusPoolReachable
    && isSteppedLoadSnapshot(params)
    && params.targets?.some((target) => target.id === 'target_temperature') !== true
    && params.control.commandAuthority
    && params.control.managed;
}

// Hard-off: the release condition is unambiguous — the whole-home signal is
// lost, or the home is drawing sustained grid import beyond what a zero-export
// controller's standing import can explain. The gate may then release an
// engaged lift without waiting out the min dwell (the dwell only protects the
// passing-cloud dip, where net hovers near zero).
//
// The import counted is the one the surplus devices cause, hidden or not. A
// battery whose own mode holds the meter at 0 W discharges to cover a device
// the solar no longer funds, so the meter shows no import while stored energy
// runs a surplus device. Its discharge (`StorageSurplus.dischargeW`) counts as
// import here, so the device yields exactly as it would to visible import; the
// battery is not claimed for it.
const isHardOffCondition = (signedNetKw: number, storageDischargeKw: number): boolean => (
  signedNetKw + storageDischargeKw > SURPLUS_ABSORB_HARD_OFF_IMPORT_KW
);

/**
 * Does this device's own draw belong back in the pool?
 *
 * A FIXED claimant (temperature lift, binary dump load) only draws on the
 * surplus while eligible — off that, its draw is its ordinary baseline and is
 * genuinely part of household load, so the eligibility gate is the right
 * question.
 *
 * A TRACKING device is different, and the difference is the whole reason this
 * predicate exists. Stopping it is a shed, and a shed parks it wherever the
 * configured shed action says — which for `set_step`, or for `turn_off` on a
 * step-only stepper, is a rung that still draws. That draw depresses measured
 * export exactly as an engaged one does, so gating the add-back on eligibility
 * left the pool reading low by the device's own consumption and the device
 * unable to earn its way back up: re-engaging took roughly twice the true
 * surplus it should have. `claimForTrackingDevice` reserves the same draw, so it
 * is subtracted once and lower-priority devices are still never offered it.
 */
const addsBackOwnDraw = (state: PlanEngineState, dev: MeteredPlanInputDevice): boolean => {
  if (!dev.surplusTracking) return state.surplusEligibilityByDevice[dev.id]?.eligible === true;
  // ...but only the draw this posture actually governs. A device PELS cannot
  // command, and one a boost has taken over, both keep drawing whatever the pool
  // says: their consumption is ordinary household load, subtracted once by the
  // meter and freed by no decision made here. Crediting it would hand a
  // higher-priority absorber export that is already spoken for, and report the
  // result as solar. Both cases claim 0 below, so each draw still counts once.
  if (dev.commandableNow !== true || resolveBoostActive(dev)) return false;
  return state.surplusTrackingByDevice[dev.id] !== undefined;
};

/**
 * The pool, kW, the part of it that is the willing devices' own add-back, and
 * the devices whose measured draw is in it.
 */
type SurplusPool = { poolKw: number; deviceAddBackKw: number; addedBackIds: ReadonlySet<string> };

/**
 * Compose the whole-home surplus budget: measured export + the add-back of
 * already-absorbing willing devices + the charge the home batteries store that
 * PELS can free, less what they discharge + the producer-resolved inferred
 * curtailed surplus (max(0, term)). Every battery's charge is in it, so the
 * consumers ranked above a battery may take that charge; the battery reserves
 * it again at its own turn (`StorageSurplusClaimant.reservedW`). Emits the `surplus_pool` composition record — the
 * only place the inferred term is distinguishable from measured export
 * (downstream sees only the flat pool).
 */
function composeSurplusPool(params: {
  willing: MeteredPlanInputDevice[];
  state: PlanEngineState;
  signedNetKw: number;
  storage: StorageSurplus;
  inferredSurplusKw: number;
  debugStructured?: StructuredDebugEmitter;
}): SurplusPool {
  let deviceAddBackKw = 0;
  const addedBackIds = new Set<string>();
  for (const dev of params.willing) {
    if (!addsBackOwnDraw(params.state, dev)) continue;
    deviceAddBackKw += positiveOrZero(dev.currentDrawKw);
    addedBackIds.add(dev.id);
  }
  const measuredExportKw = -params.signedNetKw;
  const storageChargeW = params.storage.claimants.reduce((totalW, claimant) => totalW + claimant.chargeW, 0);
  // No clamp: the producers already answer a finite kW >= 0 for every state
  // they can be in, so re-guarding them here would be the hedging consumer
  // AGENTS.md rules out. The components therefore sum to poolKw by construction.
  const storageTermKw = (storageChargeW - params.storage.dischargeW) / 1000;
  const { inferredSurplusKw } = params;
  const poolKw = measuredExportKw + deviceAddBackKw + storageTermKw + inferredSurplusKw;
  // Only when there is something to allocate it to: a willing device, or a
  // battery whose charge is in it.
  if (params.willing.length > 0 || storageChargeW > 0) {
    params.debugStructured?.({
      event: 'surplus_pool',
      measuredExportKw,
      addBackKw: deviceAddBackKw,
      storageChargeKw: storageChargeW / 1000,
      storageDischargeKw: params.storage.dischargeW / 1000,
      inferredSurplusKw,
      poolKw,
    });
  }
  return { poolKw, deviceAddBackKw, addedBackIds };
}

/**
 * Whether surplus this large, kW, could fund a device's smallest runnable
 * step: the bar its eligibility engages at (`SURPLUS_ABSORB_RESERVE_KW`).
 */
const couldFund = (availableKw: number, runKw: number): boolean => availableKw >= runKw + SURPLUS_ABSORB_RESERVE_KW;

/**
 * What a willing device wants of the surplus this cycle, as a home battery
 * ranked below it reads it (`battery/storageRelief.ts`):
 *
 * - `running` — it runs on surplus and draws, and the pool it was offered
 *   covers that draw. Its draw is measured, so it is already out of the export.
 * - `waiting` — it is not running, and the pool it was offered (battery charge
 *   PELS could free included) could fund its smallest runnable step, `runKw`.
 * - `none` — it runs and draws nothing (a tank at its lifted setpoint, a full
 *   car), it draws more than the surplus covers, the pool could never fund it,
 *   or it cannot draw now or a boost holds it up.
 */
export type SurplusWant = { kind: 'none' } | { kind: 'running' } | { kind: 'waiting'; runKw: number };

/** One willing device's claim: the kW it reserves from the devices after it, and what it wants. */
type SurplusClaim = { claimKw: number; want: SurplusWant };

const NO_WANT: SurplusWant = { kind: 'none' };

/** A device that reserves nothing and wants nothing. */
const NO_CLAIM: SurplusClaim = { claimKw: 0, want: NO_WANT };

/** An engaged device's want: `running` while it draws, on surplus that covers its draw. */
const runningWant = (dev: MeteredPlanInputDevice, availableKw: number): SurplusWant => (
  dev.currentDrawKw > IDLE_MEASURED_POWER_THRESHOLD_KW && availableKw >= dev.currentDrawKw
    ? { kind: 'running' }
    : NO_WANT
);

/** A device that is not running: `waiting` when the pool could fund its smallest runnable step. */
const waitingWant = (availableKw: number, runKw: number): SurplusWant => (
  couldFund(availableKw, runKw) ? { kind: 'waiting', runKw } : NO_WANT
);

/**
 * The strongest demand the devices ranked above a home battery put on it this
 * cycle: a device `waiting` for power its charge could free, else one
 * `running` on surplus, else `none`.
 */
export type SurplusDemand = SurplusWant['kind'];

const DEMAND_RANK: Readonly<Record<SurplusDemand, number>> = { none: 0, running: 1, waiting: 2 };

/**
 * A home battery as the allocator ranks it: an ordinary surplus consumer at
 * its own place in the priority order (owner ruling, 2026-10-06). Resolved by
 * the builder (`resolveStorageSurplus`, `battery/storageRelief.ts`), so this
 * allocator reads no battery. Only a battery PELS may claim is one: Managed
 * on, readable, and drivable.
 */
export type StorageSurplusClaimant = {
  deviceId: string;
  /** Its place in the priority order (`1` is highest), as a device's. */
  priority: number;
  /**
   * The charge it stores that PELS can free, W: added back into the pool for
   * the consumers ranked above it.
   */
  chargeW: number;
  /**
   * The charge it keeps at its own turn, W, at least `chargeW`: under a hold,
   * the setpoint PELS holds it at, or the charge its own mode takes once
   * handed back if that is more, so a raise the battery has not followed yet,
   * or the own-mode charge a hold is keeping from it, is never offered to the
   * consumers ranked below it.
   */
  reservedW: number;
};

/** The home batteries as the surplus pool counts them. */
export type StorageSurplus = {
  claimants: readonly StorageSurplusClaimant[];
  /**
   * Every battery's own discharge, W: stored energy, never surplus. Out of the
   * pool, and counted as import by the hard-off.
   */
  dischargeW: number;
};

/**
 * What the allocator offers one home battery at its turn
 * (`battery/storageRelief.ts`).
 */
export type StorageSurplusOffer = {
  /**
   * What the consumers ranked above it left for it, W: measured export, plus
   * the charge of every battery not reached yet (its own included), less what
   * every battery discharges, plus any inferred curtailed production, less the
   * smallest runnable step of every `waiting` device above it and what each
   * battery above it reserved. A running device's measured draw is already
   * out of the export; a reservation for a device that draws nothing is never
   * taken from a battery. Negative when the waiting devices outrun it.
   */
  availableW: number;
  demandAbove: SurplusDemand;
  /**
   * What the consumers ranked below it take out of `availableW`, W: the
   * smallest runnable step of every `waiting` device, what every other device
   * reserves beyond its measured draw, and the charge of every battery below
   * it. A raise past the battery's own mode's charge comes only out of what is
   * left, so no watt is funded twice.
   */
  belowW: number;
};

/** A consumer in the priority order: a willing device, or a home battery. */
type RankedSurplusConsumer =
  | { kind: 'device'; priority: number; dev: MeteredPlanInputDevice }
  | { kind: 'storage'; priority: number; claimant: StorageSurplusClaimant };

/**
 * Top priority first (PELS priority `1` is highest — ascending order). A
 * battery sharing a device's priority comes after it: devices, then the
 * battery, as with the battery last.
 */
const compareConsumers = (a: RankedSurplusConsumer, b: RankedSurplusConsumer): number => (
  a.priority - b.priority || Number(a.kind === 'storage') - Number(b.kind === 'storage')
);

/**
 * Drop every per-device surplus map entry for a device that is still in the
 * snapshot but is no longer a willing candidate this cycle (its mode target went
 * missing, it stopped being willing, its lift was cleared, or a smart task took
 * it over). Departed-from-snapshot devices are pruned by the lockstep cleanup in
 * `planHeadroomState`; this catches the still-present-but-not-a-candidate case.
 *
 * All three maps are pruned together because each leaks differently if it is
 * not: a stale eligibility re-engages from `eligible = true` with no surplus when
 * the device returns to the candidate set, lifting the setpoint until the
 * release settle expires; a stale `surplusAbsorbActiveByDevice` keeps the
 * curtailment estimator's `Object.values(...).some()` reporting an engaged lift
 * forever, so its `lastLiftEngaged` never clears; and a stale tracking decision
 * clamps a device the posture has left to a rung nothing is maintaining.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
function pruneNonCandidateSurplusState(
  state: PlanEngineState,
  willingIds: ReadonlySet<string>,
): void {
  for (const deviceId of Object.keys(state.surplusEligibilityByDevice)) {
    if (!willingIds.has(deviceId)) clearSurplusEligibility(state, deviceId);
  }
  const liftActive = state.surplusAbsorbActiveByDevice;
  for (const deviceId of Object.keys(liftActive)) {
    if (!willingIds.has(deviceId)) delete liftActive[deviceId];
  }
  for (const deviceId of Object.keys(state.surplusTrackingByDevice)) {
    if (!willingIds.has(deviceId)) clearSurplusTracking(state, deviceId);
  }
}
/* eslint-enable functional/immutable-data */

/**
 * Hold a ceiling CLIMB back until `SURPLUS_TRACK_STEP_MIN_INTERVAL_MS` has passed
 * since the last one; drops pass through untouched. Answers the rung to use.
 *
 * The pool is recomputed every build, so without this the ceiling would chase
 * every cloud edge at build cadence — a charger current change every 10 s. The
 * asymmetry is the point: waiting to take more power costs a little
 * self-consumption, while waiting to give it back means importing against
 * surplus that is already gone.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
function paceCeilingClimb(params: {
  dev: MeteredPlanInputDevice;
  state: PlanEngineState;
  target: SteppedLoadStep;
  nowTs: number;
}): SteppedLoadStep {
  const { dev, state, target, nowTs } = params;
  const currentId = resolveSurplusCeilingStepId(state, dev.id);
  if (currentId === undefined || currentId === target.id) {
    state.surplusTrackingRaisedMs[dev.id] = nowTs;
    return target;
  }
  if (!isSteppedLoadDevice(dev)) return target;
  const current = getSteppedLoadStep(dev.steppedLoadProfile, currentId);
  // An unknown current rung (profile changed under us) is not evidence of
  // anything — take the fresh answer rather than pacing against a ghost.
  if (!current) {
    state.surplusTrackingRaisedMs[dev.id] = nowTs;
    return target;
  }
  if (target.planningPowerW <= current.planningPowerW) return target;
  const raisedMs = state.surplusTrackingRaisedMs[dev.id];
  if (isFiniteNumber(raisedMs) && nowTs - raisedMs < SURPLUS_TRACK_STEP_MIN_INTERVAL_MS) {
    return current;
  }
  state.surplusTrackingRaisedMs[dev.id] = nowTs;
  return target;
}
/* eslint-enable functional/immutable-data */

/**
 * The VARIABLE claimant. A fixed claimant (temperature lift, binary dump load)
 * reserves one number it cannot change — `getHighestKnownPowerKw` — and the
 * pool's remainder after the last claimant is discarded. A tracking device
 * instead chooses how much of the pool to take, so it reserves exactly the rung
 * it was allocated and hands the rest down the priority order.
 *
 * Three things are settled here, in this order:
 *
 * 1. **A device that cannot draw claims nothing.** `commandableNow === false` is
 *    an unplugged charger (or an unavailable device). Reserving for it would
 *    starve the lower-priority devices behind it on surplus that will never be
 *    consumed — the exact failure `hasStandingDemand` guards the binary posture
 *    against. Releasing rather than deleting-and-forgetting keeps the settle
 *    clock honest when the car comes back.
 * 2. **The on↔off gate runs against the ladder FLOOR**, not against the rung
 *    finally chosen. The floor is what it costs to run at all, so it is the
 *    right `expectedDrawKw` for a settle/dwell/hard-off decision that is about
 *    whether to run — the rung is a separate, cheaper question asked below.
 * 3. **Eligibility alone owns the on↔off flip.** While the gate says the device
 *    may run it always holds SOME rung — {@link resolveTrackingRung} falls back
 *    to the ladder floor — and it stops only when the gate releases, with the
 *    90 s settle, the 5 min dwell and the hard-off bypass all applying exactly
 *    as they do to the other two modalities.
 *
 *    This used to be split in two. The rung was chosen against `pool − reserve`
 *    while the gate released at a bare `pool < floorKw`, so anywhere in the
 *    0.25 kW band between them the device was eligible but "nothing fit" — and
 *    was stopped on a SINGLE build, with no settle and no dwell. On a
 *    three-phase charger (floor 4.14 kW) every dip below 4.39 kW ended the
 *    charging session, which is precisely the passing-cloud chatter the settle
 *    exists to absorb.
 *
 * Returns the kW to subtract from the pool: the chosen rung while running, and
 * the device's MEASURED draw while stopped; and what it wants of the surplus. A stop is a shed, and a shed parks
 * the device wherever its configured shed action says — which may still draw.
 * Reserving that keeps the pool honest for lower-priority devices, and pairs
 * with the add-back in {@link addsBackOwnDraw} so the draw is counted once.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
function claimForTrackingDevice(params: {
  dev: MeteredPlanInputDevice;
  state: PlanEngineState;
  poolKw: number;
  nowTs: number;
}): SurplusClaim {
  const { dev, state, poolKw, nowTs } = params;
  // A tracking device gets its OWN hard-off test, and it must: the shared one
  // (`isHardOffCondition`) reads raw net import, which for a fixed-draw absorber
  // is honest evidence that surplus is gone. For a modulating one it is not —
  // this device's own draw is what pushed net positive, so any cloud at all
  // would trip a 0.35 kW threshold and release it outright. The right answer to
  // "my rung is now too high" is to step DOWN, which the pool arithmetic already
  // produces (the add-back reconstructs the true surplus). So the unambiguous
  // condition here is the POOL being gone, not the meter reading positive.
  const hardOff = poolKw <= 0;
  // Narrowing, not a re-derivation: the posture already required a ladder, so a
  // device reaching here without one is a producer bug rather than a state to
  // model. Leave it unclamped.
  if (!isSteppedLoadDevice(dev)) {
    clearSurplusTracking(state, dev.id);
    return NO_CLAIM;
  }
  if (dev.commandableNow !== true) {
    syncSurplusEligibilityState({
      state, deviceId: dev.id, willing: false, availableSurplusKw: null,
      expectedDrawKw: 0, hardOff, nowTs,
    });
    clearSurplusTracking(state, dev.id);
    return NO_CLAIM;
  }
  // A boost outranks the surplus posture — `isSurplusHeldDevice` deliberately
  // lets a boosted tracker keep running — so its draw is a live demand this
  // module cannot end. Decide nothing for it: no rung, because the sun is not
  // what is holding it up; and no claim, because its draw was never added back
  // (`addsBackOwnDraw`) and the meter already carries it as ordinary load.
  if (resolveBoostActive(dev)) {
    syncSurplusEligibilityState({
      state, deviceId: dev.id, willing: false, availableSurplusKw: null,
      expectedDrawKw: 0, hardOff, nowTs,
    });
    clearSurplusTracking(state, dev.id);
    return NO_CLAIM;
  }

  const floorStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
  if (!floorStep) {
    // No runnable rung: the ladder cannot express the posture. Leave the device
    // unclamped rather than inventing a decision out of an unusable profile.
    clearSurplusTracking(state, dev.id);
    return NO_CLAIM;
  }
  // Every rung is priced at its nameplate here, as `resolveHighestStepWithinKw`
  // fits it: the claim on the pool is what the rung may draw, never a learned
  // figure that can only be lower.
  const floorKw = floorStep.planningPowerW / 1000;

  const { eligible } = syncSurplusEligibilityState({
    state,
    deviceId: dev.id,
    willing: true,
    availableSurplusKw: poolKw,
    expectedDrawKw: floorKw,
    hardOff,
    nowTs,
  });

  if (eligible) {
    const paced = paceCeilingClimb({
      dev, state, target: resolveTrackingRung({ dev, state, poolKw, floorStep }), nowTs,
    });
    const rungKw = paced.planningPowerW / 1000;
    state.surplusTrackingByDevice[dev.id] = {
      kind: 'rung', stepId: paced.id, funded: rungKw <= poolKw,
    };
    return { claimKw: rungKw, want: runningWant(dev, poolKw) };
  }

  // The gate has released: the device stops. THAT is all this module decides —
  // what stopping means belongs to the configured shed action, reached through
  // the ordinary shed path (`resolveSteppedLoadDirectShedStepId`), so a solar
  // stop and a capacity stop park the device in the same place instead of this
  // module inventing a second answer out of the ladder's rungs.
  state.surplusTrackingByDevice[dev.id] = { kind: 'stopped' };
  return { claimKw: positiveOrZero(dev.currentDrawKw), want: waitingWant(poolKw, floorKw) };
}
/* eslint-enable functional/immutable-data */

/**
 * The rung an ELIGIBLE tracking device holds this build. Never null: eligibility
 * has already said the device may run, and the ladder floor is the cheapest way
 * to do that, so "may run but no rung" is not a state worth representing.
 *
 * Asymmetric, and deliberately the same band the eligibility gate itself uses:
 * buying a NEW or HIGHER rung must clear `pool − reserve`, while a rung already
 * held costs only its bare admission power to keep. The reserve is the
 * hysteresis, exactly as it is for the engage/release decision — without the
 * keep arm, a pool wandering across the reserve band would re-price the device
 * every build.
 */
function resolveTrackingRung(params: {
  dev: MeteredPlanInputDevice;
  state: PlanEngineState;
  poolKw: number;
  floorStep: SteppedLoadStep;
}): SteppedLoadStep {
  const { dev, state, poolKw, floorStep } = params;
  // What the pool would buy from scratch, reserve included.
  const affordable = resolveHighestStepWithinKw(dev, poolKw - SURPLUS_ABSORB_RESERVE_KW);
  const held = resolveHeldStep(dev, state);
  if (held && held.planningPowerW / 1000 <= poolKw) {
    // The held rung is still covered on the bare pool, so keep it — and move
    // only for something strictly HIGHER. Answering `affordable` here instead
    // would step the device DOWN the moment the pool dipped inside the reserve,
    // which is the re-pricing this band exists to stop.
    return affordable && affordable.planningPowerW > held.planningPowerW ? affordable : held;
  }
  // Nothing the pool covers, but the gate has not released yet. Hold the
  // CHEAPEST rung rather than the one it had: still running, as the settle and
  // dwell require, but importing as little as the ladder allows while they run.
  // Recorded as unfunded, so nothing downstream calls this "running on solar".
  return affordable ?? floorStep;
}

const resolveHeldStep = (
  dev: MeteredPlanInputDevice,
  state: PlanEngineState,
): SteppedLoadStep | undefined => {
  const heldId = resolveSurplusCeilingStepId(state, dev.id);
  if (heldId === undefined || !isSteppedLoadDevice(dev)) return undefined;
  return getSteppedLoadStep(dev.steppedLoadProfile, heldId) ?? undefined;
};

/**
 * Priority-greedy surplus allocator — the *producer* of surplus-absorb
 * eligibility. Runs once per plan build, BEFORE per-device target resolution, and
 * reserves the whole-home export budget across all willing temperature devices in
 * priority order, so two devices cannot both engage on the same surplus and
 * oscillate (the limit cycle). It writes each device's eligibility into
 * `PlanEngineState`; the prep path (`applySurplusAbsorbDelta`) only reads the flat
 * bit.
 *
 * Budget baseline = the export that would exist if no willing device absorbed:
 * `-net + Σ measuredDraw(eligible willing devices) + inferred curtailed surplus`.
 * Adding back the draw of already-absorbing devices keeps the pool from being
 * double-charged for power the measured net already reflects. The inferred term
 * (producer: `lib/solar/curtailmentSurplus.ts`, injected flat through the plan
 * deps) is production a zero-export inverter is throttling away — it enlarges
 * the pool exactly like measured export, and every safety decision about it
 * (import guard, verification, battery suppression) is already resolved in the
 * producer: this allocator never branches on where the pool's kW came from.
 * Each admitted/settling device then reserves its expected draw from the running
 * pool, so lower-priority devices only see what is left. Priority is top-first
 * (PELS priority `1` is highest), so the most important willing device claims
 * scarce surplus before the rest.
 *
 * The willing set is the union of ALL THREE surplus modalities in ONE pool,
 * ordered purely by user priority: temperature devices with a real lift
 * (`willingWithLift`), binary dump loads carrying the producer-resolved
 * `surplusOnly` posture, and stepped loads carrying `surplusTracking`. Every one
 * of them runs the same settle/dwell/hard-off gate, so a thermostat, a pool pump
 * and an EV charger can never all engage on the same export.
 *
 * They differ in what they RESERVE. The first two are fixed claimants: they
 * reserve `getHighestKnownPowerKw`, a number they cannot change, and whatever is
 * left after the last claimant is discarded. A tracking device is a VARIABLE
 * claimant — it chooses a rung from the pool and reserves exactly that, so the
 * remainder keeps flowing down the priority order instead of being thrown away
 * (see {@link claimForTrackingDevice}).
 *
 * A home battery is a consumer in the same order, at its own priority (owner
 * ruling, 2026-10-06: surplus by priority; last, the default, is devices, then
 * the battery, then export). Its charge is in the pool, so a device ranked
 * above it may take that charge, which the storage stage answers by capping
 * the battery for it; at its turn the battery reserves that charge (under a
 * hold, the setpoint PELS holds or its own mode's charge if more), as far as
 * the consumers above it left it, so a device ranked below it only sees what
 * is left. The allocator answers each battery's offer (`StorageSurplusOffer`)
 * to the storage stage (`battery/storageRelief.ts`), with what the consumers
 * below it take (`belowW`), so a raise past the battery's own mode's charge
 * never funds a watt they were offered. The pool is composed even
 * with no willing device, so a battery PELS already holds keeps storing the
 * export until it is handed back.
 */
/**
 * The silent-meter pass's half of eligibility: with no measurement there is no
 * surplus to allocate, so every willing device is released — the same
 * hard-off release a sustained import produces, without waiting out a dwell.
 * (Owner ruling 2026-09-02: this used to be an `!powerIsMeasured` branch inside
 * `resolveSurplusEligibility`; it is the unmeasured path's own call now.)
 */
export function withdrawSurplusEligibility(
  devices: PlanInputDevice[],
  state: PlanEngineState,
  getConfig: (deviceId: string) => SurplusConfig | undefined,
  excludeIds: ReadonlySet<string>,
  nowTs: number,
): void {
  // Absorbing surplus is spending measured export, so only a device with a power
  // reading can take part; a temperature device without one keeps its setpoint
  // logic and never claims from the pool.
  const willing = devices.filter(
    (dev): dev is MeteredPlanInputDevice => isMeteredPlanDevice(dev) && !excludeIds.has(dev.id)
      && (dev.surplusOnly === true
        || dev.surplusTracking
        || (willingWithLift(getConfig(dev.id)) && supportsTemperatureLift(dev))),
  );
  pruneNonCandidateSurplusState(state, new Set(willing.map((dev) => dev.id)));
  for (const dev of willing) {
    syncSurplusEligibilityState({
      state,
      deviceId: dev.id,
      willing: true,
      availableSurplusKw: null,
      expectedDrawKw: getHighestKnownPowerKw(dev).kw,
      hardOff: true,
      nowTs,
    });
  }
}

export function resolveSurplusEligibility(params: {
  devices: PlanInputDevice[];
  state: PlanEngineState;
  /** The measured whole-home draw, signed (`MeasuredPower.drawKw`). */
  signedNetKw: number;
  // Producer-resolved inferred curtailed-surplus term (kW, >= 0; producer:
  // `lib/solar/curtailmentSurplus.ts`), 0 when it has nothing to claim or is
  // suppressed. `composeSurplusPool` sums it with measured export and the
  // add-back, so on a zero-export home — where the meter is pinned near zero
  // and reports no export — a positive inferred term is precisely what opens
  // the pool. It only ever adds.
  inferredSurplusKw: number;
  // The home batteries (`resolveStorageSurplus`): resolved by the builder, so
  // this allocator never reads a battery.
  storage: StorageSurplus;
  getConfig: (deviceId: string) => SurplusConfig | undefined;
  // Smart-task precedence at the ALLOCATION stage (mirrors the hold exclusion):
  // a device an active deferred objective currently governs must never be
  // eligible for surplus and must never RESERVE the shared pool ahead of a
  // lower-priority willing device. Excluded devices are dropped from the willing
  // set below, and the lockstep cleanup then clears any latched eligibility so a
  // newly-governed device stops reserving immediately. Empty in the common
  // case (no smart tasks) — byte-identical there.
  excludeIds: ReadonlySet<string>;
  debugStructured?: StructuredDebugEmitter;
  // One timestamp for the whole admission pass, so a single plan build cannot
  // flip devices on different milliseconds at the settle/dwell threshold.
  nowTs: number;
}): ReadonlyMap<string, StorageSurplusOffer> {
  const { state, getConfig, excludeIds, nowTs, storage } = params;
  // See the twin filter above: the pool is measured power, so only metered devices take part.
  const willing = params.devices.filter(
    (dev): dev is MeteredPlanInputDevice => isMeteredPlanDevice(dev)
      && !excludeIds.has(dev.id)
      && (dev.surplusOnly === true
        || dev.surplusTracking
        || (willingWithLift(getConfig(dev.id)) && supportsTemperatureLift(dev))),
  );

  pruneNonCandidateSurplusState(state, new Set(willing.map((dev) => dev.id)));

  const hardOff = isHardOffCondition(params.signedNetKw, storage.dischargeW / 1000);

  const pool = composeSurplusPool({
    willing,
    state,
    signedNetKw: params.signedNetKw,
    storage,
    inferredSurplusKw: params.inferredSurplusKw,
    debugStructured: params.debugStructured,
  });
  let { poolKw } = pool;
  // A battery's share starts without the devices' own add-back: a running
  // device's measured draw is already out of the export.
  let storageKw = pool.poolKw - pool.deviceAddBackKw;
  let demandAbove: SurplusDemand = 'none';
  // What every consumer so far takes of a battery's share, kW, and each
  // battery's offer at its turn with that running total: what the consumers
  // after it take is the difference at the end.
  let takenKw = 0;
  const turns = new Map<string, { availableW: number; demandAbove: SurplusDemand; takenAtTurnKw: number }>();

  const ranked: RankedSurplusConsumer[] = [
    ...willing.map((dev) => ({ kind: 'device' as const, priority: dev.priority, dev })),
    ...storage.claimants.map((claimant) => ({ kind: 'storage' as const, priority: claimant.priority, claimant })),
  ].sort(compareConsumers);
  for (const consumer of ranked) {
    if (consumer.kind === 'storage') {
      const { claimant } = consumer;
      const availableW = storageKw * 1000;
      // It keeps its charge as far as the consumers above it left it; past
      // that, the storage stage caps it to what they left.
      const reservedKw = Math.min(claimant.reservedW / 1000, Math.max(0, storageKw));
      poolKw -= reservedKw;
      storageKw -= reservedKw;
      takenKw += Math.max(claimant.chargeW / 1000, reservedKw);
      turns.set(claimant.deviceId, { availableW, demandAbove, takenAtTurnKw: takenKw });
      continue;
    }
    const { dev } = consumer;
    const claim = dev.surplusTracking
      ? claimForTrackingDevice({ dev, state, poolKw, nowTs })
      : claimForFixedDevice(dev, state, poolKw, hardOff, nowTs);
    poolKw -= claim.claimKw;
    if (claim.want.kind === 'waiting') storageKw -= claim.want.runKw;
    if (DEMAND_RANK[claim.want.kind] > DEMAND_RANK[demandAbove]) demandAbove = claim.want.kind;
    // What it takes of a battery's share above it: its smallest step while it
    // waits, else what it reserves beyond the draw already out of the export.
    const measuredKw = pool.addedBackIds.has(dev.id) ? positiveOrZero(dev.currentDrawKw) : 0;
    takenKw += claim.want.kind === 'waiting' ? claim.want.runKw : Math.max(0, claim.claimKw - measuredKw);
  }
  return new Map([...turns].map(([deviceId, { takenAtTurnKw, ...offer }]): [string, StorageSurplusOffer] => (
    [deviceId, { ...offer, belowW: (takenKw - takenAtTurnKw) * 1000 }]
  )));
}

/**
 * A FIXED claimant (temperature lift, binary dump load) against the pool the
 * devices before it left: its eligibility advanced, the kW it reserves, and
 * what it wants. It reserves its expected draw while eligible OR settling
 * toward engage, so a lower-priority device cannot claim the same surplus.
 */
function claimForFixedDevice(
  dev: MeteredPlanInputDevice,
  state: PlanEngineState,
  poolKw: number,
  hardOff: boolean,
  nowTs: number,
): SurplusClaim {
  const expectedDrawKw = getHighestKnownPowerKw(dev).kw;
  const { eligible } = syncSurplusEligibilityState({
    state,
    deviceId: dev.id,
    willing: true,
    availableSurplusKw: poolKw,
    expectedDrawKw,
    hardOff,
    nowTs,
  });
  if (eligible) return { claimKw: expectedDrawKw, want: runningWant(dev, poolKw) };
  const want = waitingWant(poolKw, expectedDrawKw);
  return { claimKw: want.kind === 'waiting' ? expectedDrawKw : 0, want };
}

/**
 * Whether the allocator has this temperature device absorbing surplus this
 * cycle. Eligibility is resolved up-front by {@link resolveSurplusEligibility};
 * this only reads the flat bit. Capacity-independent — the capacity layer stays
 * the ceiling. The lifted SETPOINT is not computed here: it is resolved before
 * the planner with every other setpoint, in the device's own heating/cooling
 * direction (`TemperatureSetpoints.surplusC`).
 */
export function isSurplusLiftEngaged(
  dev: PlanInputDevice,
  config: ResolvedPriceOptimizationConfig,
  state: PlanEngineState,
): boolean {
  if (config.surplusLiftC <= 0) {
    // Not a real absorber (unwilling or no lift): drop any stale eligibility the
    // allocator no longer maintains.
    clearSurplusEligibility(state, dev.id);
    return false;
  }
  return state.surplusEligibilityByDevice[dev.id]?.eligible === true;
}
