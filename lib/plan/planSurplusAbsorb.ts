import { resolveSurplusCeilingStepId, type PlanEngineState } from './planState';
import type { PlanInputDevice } from './planTypes';
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
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';
import { resolveBoostActive } from './planBoost';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import {
  isSteppedLoadDevice,
  resolveHighestStepWithinKw,
  resolveStepAdmissionKw,
} from './planSteppedLoad';

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
// settings-deps seam rather than lib/price's persistence type; optional fields
// keep non-solar blobs byte-identical.
export type PriceOptDeviceConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  surplusWilling?: boolean;
  surplusDelta?: number;
};

type SurplusConfig = {
  surplusWilling?: boolean;
  surplusDelta?: number;
};

// Local guard — kept off lib/utils so this new plan module stays self-contained
// (per the lib/plan ↛ lib/utils path rule).
const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const positiveOrZero = (value: unknown): number => (isFiniteNumber(value) && value > 0 ? value : 0);

// A device only absorbs surplus when it is willing AND has a real (finite, > 0)
// lift configured; a no-op (zero/absent/NaN delta) must not be admitted to the
// allocator, or it would reserve export it never draws and starve lower-priority
// devices.
const willingWithLift = (config: SurplusConfig | undefined): boolean => (
  config?.surplusWilling === true && isFiniteNumber(config.surplusDelta) && config.surplusDelta > 0
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
  surplusWilling: boolean | undefined;
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
  controllable: boolean;
  managed: boolean;
  // Producer-resolved: can this home's surplus pool ever be non-zero? False
  // means no surplus can arrive, so stamping the posture would hold the device
  // off indefinitely rather than merely leaving it idle.
  surplusPoolReachable: boolean;
}): boolean {
  return params.surplusWilling === true
    && params.surplusPoolReachable
    && params.hasBinaryControl
    && params.hasStandingDemand
    && !isSteppedLoadSnapshot(params)
    && params.plainBinaryControlModel
    && params.targets?.some((target) => target.id === 'target_temperature') !== true
    && params.controllable
    && params.managed !== false;
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
  surplusWilling: boolean | undefined;
  targets: readonly TargetCapabilitySnapshot[] | undefined;
  steppedLoadProfile: SteppedLoadProfile | undefined;
  controllable: boolean;
  managed: boolean;
  // Same producer-resolved question as the binary posture: can this home's
  // surplus pool ever be non-zero? False means stamping the posture would clamp
  // the device to its floor forever rather than merely leaving it unmodulated.
  surplusPoolReachable: boolean;
}): boolean {
  return params.surplusWilling === true
    && params.surplusPoolReachable
    && isSteppedLoadSnapshot(params)
    && params.targets?.some((target) => target.id === 'target_temperature') !== true
    && params.controllable
    && params.managed !== false;
}

// Hard-off: the release condition is unambiguous — the whole-home signal is
// lost, or the home is drawing sustained grid import beyond what a zero-export
// controller's standing import can explain. The gate may then release an
// engaged lift without waiting out the min dwell (the dwell only protects the
// passing-cloud dip, where net hovers near zero).
const isHardOffCondition = (powerOk: boolean, signedNetKw: number | null): boolean => (
  !powerOk || (isFiniteNumber(signedNetKw) && signedNetKw > SURPLUS_ABSORB_HARD_OFF_IMPORT_KW)
);

// Compose the whole-home surplus budget: measured export + the add-back of
// already-absorbing willing devices + the producer-resolved inferred curtailed
// surplus (max(0, term)). Emits the `surplus_pool` composition record once per
// pass — the only place the inferred term is distinguishable from measured
// export (downstream sees only the flat pool).
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
const addsBackOwnDraw = (state: PlanEngineState, dev: PlanInputDevice): boolean => {
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

function composeSurplusPool(params: {
  willing: PlanInputDevice[];
  state: PlanEngineState;
  signedNetKw: number;
  inferredSurplusKw: number;
  debugStructured?: StructuredDebugEmitter;
}): number {
  let addBackKw = 0;
  for (const dev of params.willing) {
    if (addsBackOwnDraw(params.state, dev)) addBackKw += positiveOrZero(dev.currentDrawKw);
  }
  const measuredExportKw = -params.signedNetKw;
  // No clamp: the producer already answers a finite kW >= 0 for every state it
  // can be in, so re-guarding it here would be the hedging consumer AGENTS.md
  // rules out. The three components therefore sum to poolKw by construction.
  const inferredSurplusKw = params.inferredSurplusKw;
  const poolKw = measuredExportKw + addBackKw + inferredSurplusKw;
  params.debugStructured?.({
    event: 'surplus_pool',
    measuredExportKw,
    addBackKw,
    inferredSurplusKw,
    poolKw,
  });
  return poolKw;
}

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
function paceCeilingClimb(params: {
  dev: PlanInputDevice;
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
 * the device's MEASURED draw while stopped. A stop is a shed, and a shed parks
 * the device wherever its configured shed action says — which may still draw.
 * Reserving that keeps the pool honest for lower-priority devices, and pairs
 * with the add-back in {@link addsBackOwnDraw} so the draw is counted once.
 */
function claimForTrackingDevice(params: {
  dev: PlanInputDevice;
  state: PlanEngineState;
  poolKw: number;
  nowTs: number;
}): number {
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
    return 0;
  }
  if (dev.commandableNow !== true) {
    syncSurplusEligibilityState({
      state, deviceId: dev.id, willing: false, availableSurplusKw: null,
      expectedDrawKw: 0, hardOff, nowTs,
    });
    clearSurplusTracking(state, dev.id);
    return 0;
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
    return 0;
  }

  const floorStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
  if (!floorStep) {
    // No runnable rung: the ladder cannot express the posture. Leave the device
    // unclamped rather than inventing a decision out of an unusable profile.
    clearSurplusTracking(state, dev.id);
    return 0;
  }
  const floorKw = resolveStepAdmissionKw(dev, floorStep.id);

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
    const rungKw = resolveStepAdmissionKw(dev, paced.id);
    state.surplusTrackingByDevice[dev.id] = {
      kind: 'rung', stepId: paced.id, funded: rungKw <= poolKw,
    };
    return rungKw;
  }

  // The gate has released: the device stops. THAT is all this module decides —
  // what stopping means belongs to the configured shed action, reached through
  // the ordinary shed path (`resolveSteppedLoadDirectShedStepId`), so a solar
  // stop and a capacity stop park the device in the same place instead of this
  // module inventing a second answer out of the ladder's rungs.
  state.surplusTrackingByDevice[dev.id] = { kind: 'stopped' };
  return positiveOrZero(dev.currentDrawKw);
}

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
  dev: PlanInputDevice;
  state: PlanEngineState;
  poolKw: number;
  floorStep: SteppedLoadStep;
}): SteppedLoadStep {
  const { dev, state, poolKw, floorStep } = params;
  // What the pool would buy from scratch, reserve included.
  const affordable = resolveHighestStepWithinKw(dev, poolKw - SURPLUS_ABSORB_RESERVE_KW);
  const held = resolveHeldStep(dev, state);
  if (held && resolveStepAdmissionKw(dev, held.id) <= poolKw) {
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
  dev: PlanInputDevice,
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
 */
export function resolveSurplusEligibility(params: {
  devices: PlanInputDevice[];
  state: PlanEngineState;
  signedNetKw: number | null;
  // Producer-resolved inferred curtailed-surplus term (kW); null/undefined when
  // absent or currently suppressed. Folded into the pool as max(0, term) — it can
  // only ever ENLARGE the pool, and the `powerOk` gate below is unaffected: a
  // fresh measured meter is still required before any raise (never raise blind
  // on inference alone).
  inferredSurplusKw: number;
  getConfig: (deviceId: string) => SurplusConfig | undefined;
  // Smart-task precedence at the ALLOCATION stage (mirrors the hold exclusion):
  // a device an active deferred objective currently governs must never be
  // eligible for surplus and must never RESERVE the shared pool ahead of a
  // lower-priority willing device. Excluded devices are dropped from the willing
  // set below, and the lockstep cleanup then clears any latched eligibility so a
  // newly-governed device stops reserving immediately. Empty/absent in the common
  // case (no smart tasks) — byte-identical there.
  excludeIds?: ReadonlySet<string>;
  debugStructured?: StructuredDebugEmitter;
  nowTs?: number;
}): void {
  const { state, getConfig } = params;
  const excludeIds = params.excludeIds;
  // One timestamp for the whole admission pass, so a single plan build cannot
  // flip devices on different milliseconds at the settle/dwell threshold.
  const nowTs = params.nowTs ?? Date.now();
  const willing = params.devices.filter(
    (dev) => (excludeIds === undefined || !excludeIds.has(dev.id))
      && (dev.surplusOnly === true
        || dev.surplusTracking
        || (willingWithLift(getConfig(dev.id)) && supportsTemperatureLift(dev))),
  );

  pruneNonCandidateSurplusState(state, new Set(willing.map((dev) => dev.id)));

  if (willing.length === 0) return;

  // `signedNetKw` is already null when this cycle had no trustworthy total, so
  // finiteness is the only check left — there is no provenance to re-derive.
  const powerOk = isFiniteNumber(params.signedNetKw);
  const hardOff = isHardOffCondition(powerOk, params.signedNetKw);
  if (!powerOk) {
    // Power unknown/stale: no surplus to allocate — let every willing device release.
    for (const dev of willing) {
      syncSurplusEligibilityState({
        state,
        deviceId: dev.id,
        willing: true,
        availableSurplusKw: null,
        expectedDrawKw: getHighestKnownPowerKw(dev).kw,
        hardOff,
        nowTs,
      });
    }
    return;
  }

  let poolKw = composeSurplusPool({
    willing,
    state,
    signedNetKw: params.signedNetKw as number,
    inferredSurplusKw: params.inferredSurplusKw,
    debugStructured: params.debugStructured,
  });

  // Top priority first (PELS priority `1` is highest — ascending order).
  const ordered = [...willing].sort((a, b) => a.priority - b.priority);
  for (const dev of ordered) {
    if (dev.surplusTracking) {
      poolKw -= claimForTrackingDevice({ dev, state, poolKw, nowTs });
      continue;
    }
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
    // Reserve the draw of any device that is eligible OR settling toward engage, so
    // a lower-priority device cannot claim the same surplus.
    if (eligible || poolKw >= expectedDrawKw + SURPLUS_ABSORB_RESERVE_KW) {
      poolKw -= expectedDrawKw;
    }
  }
}

/**
 * Apply the surplus-absorb lift to a device's mode setpoint. Eligibility is
 * resolved up-front by {@link resolveSurplusEligibility}; this only reads the flat
 * bit. Capacity-independent — the capacity layer stays the ceiling. Raise-only,
 * and it outranks an expensive-hour reduction (surplus is free even on an
 * expensive grid hour), so the lift comes off the bare mode baseline and wins
 * against the price-adjusted target. Only ever called for a `mode`-seed
 * temperature device.
 */
export function applySurplusAbsorbDelta(params: {
  baseTarget: number;
  pricedTarget: number;
  dev: PlanInputDevice;
  config: SurplusConfig | undefined;
  state: PlanEngineState;
}): number {
  const { baseTarget, pricedTarget, dev, config, state } = params;
  // Finite guard: a corrupt persisted NaN/Infinity must never reach the setpoint.
  const surplusDelta = isFiniteNumber(config?.surplusDelta) ? config.surplusDelta : 0;
  if (config?.surplusWilling !== true || surplusDelta <= 0) {
    // Not a real absorber (unwilling or no lift): drop any stale eligibility the
    // allocator no longer maintains.
    clearSurplusEligibility(state, dev.id);
    return pricedTarget;
  }
  if (state.surplusEligibilityByDevice[dev.id]?.eligible !== true) return pricedTarget;
  return Math.max(pricedTarget, baseTarget + surplusDelta);
}
