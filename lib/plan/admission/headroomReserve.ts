import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';
import { getLogger } from '../../logging/logger';
import { MIN_ACTIVE_MEASURED_POWER_KW } from '../../observer/observedPower';
import { isSteppedLoadDevice, resolveStepAdmissionKw } from '../planSteppedLoad';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { getSteppedLoadLowestActiveStep, getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import { HEADROOM_RESERVE_MAX_MS, RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import { buildRestoreAdmissionMetrics, type RestoreAdmissionMetrics } from './reserve';

/**
 * Startup power reservation: a device carrying `reservesStartupPower` holds back the power it
 * needs to reach its LOWEST ACTIVE STEP from the admission of lower-priority devices, so cycling
 * loads cannot nibble away the contiguous block it needs to start.
 *
 * This is an ADMISSION term, not a selection decision — it only lowers the available-power figure
 * that restore admission already consumes. `reserveHeadroomForPendingRestores` used to do the same
 * for a device whose restore was in flight; it was removed on 2026-08-28 because its release
 * depended on seeing the load on the whole-home meter, which is a sum and cannot attribute
 * (`notes/state-management/actuation-clocks-and-settle.md`). This reserve does not share that
 * flaw: it is released by the holder reaching its own step, not by watching the main meter.
 *
 * A lower-priority device IS affected: it is not resumed, it classifies as a hold, and it ACCRUES
 * held-back time — `reservedForStart` counts on the starvation clock (it paused it until
 * 2026-08-08; the reserve is bounded, but boundedness is a property of the mechanism, not
 * something the held device feels). What makes that acceptable is mechanical rather than causal —
 * nothing is added to `shedSet`, no other device's `plannedState` is set from here, and no
 * actuation intent is produced (`reservedForStart` is in `RESTORE_ADMISSION_HOLD_REASON_CODES`).
 * See `lib/plan/AGENTS.md`, `notes/starvation/README.md`, and
 * `notes/deferred-load-objectives/preemptive-power-reservation.md`.
 *
 * Scope is deliberately step 1 only:
 *   - the reserve is EXACTLY the lowest active step's power — never the next or target step;
 *   - it exists only to get the device started (an EV charger onto its lowest current);
 *   - it dies the instant the device is confirmed at or above that step, so it places no
 *     constraint on anyone while the device climbs the ladder afterwards.
 *
 * Nothing here assists a step-up. Climbing above step 1 stays governed by ordinary admission, the
 * stepped shed invariant, and boost.
 */

const logger = getLogger('plan/headroom-reserve');

const DEFAULT_PRIORITY = 100;

// Fallback release test for devices with no step axis: a device counts as running once its
// OBSERVED draw reaches half its startup power — comfortably past standby/trickle, yet tolerant of
// measurement variance. A bare `> 0` would release on a few watts of standby.
const RELEASE_ACTIVE_FRACTION = 0.5;

export type HeadroomReserve = {
  deviceId: string;
  // Carried so a blocked device's card can name who the power is being kept for, without a
  // second lookup through the device map at the reject sites.
  deviceName: string;
  priority: number;
  kw: number;
};

type ReserveOutcome = 'armed' | 'expired' | 'satisfied' | 'not_startable' | 'unknown_device_power';

// Sentinel stored in place of an arming timestamp once a device has been seen to start. The
// reservation is a one-shot per grant: get the device going, then stay out of the way. Without the
// latch, any device whose only start evidence is instantaneous draw — a target-only thermostat has
// no binary handle and no step axis — alternates between satisfied and waiting as its element duty
// cycles, minting a fresh bound every time and holding lower-priority devices out indefinitely.
// Cleared when the permission goes away, since the record is rebuilt from the flagged devices.
const RELEASED = -1;

/**
 * Resolve this cycle's active startup reservations and re-stamp the arming clock.
 *
 * `state.headroomReserveArmedMs` is rebuilt from scratch each call rather than mutated in place,
 * so a device that leaves the snapshot or stops requesting a reserve cannot leave a stale stamp
 * behind. A reserve that expires keeps its stamp (it must stay expired, not re-arm and flap); one
 * that is satisfied or withdrawn drops its stamp, so a later start gets a fresh window.
 */
export function resolveHeadroomReserves(params: {
  devices: readonly DevicePlanDevice[];
  state: Pick<PlanEngineState, 'headroomReserveArmedMs'>;
  nowTs: number;
}): HeadroomReserve[] {
  const { devices, state, nowTs } = params;
  const previousArmedMs = state.headroomReserveArmedMs;
  const nextArmedMs: Record<string, number> = {};
  const reserves: HeadroomReserve[] = [];

  for (const device of devices) {
    if (device.reservesStartupPower !== true) continue;
    const decision = resolveReserveForDevice({
      device, armedMs: previousArmedMs[device.id] ?? null, nowTs,
    });
    if (decision.armedMs !== null) nextArmedMs[device.id] = decision.armedMs;
    if (decision.reserve) reserves.push(decision.reserve);
    logger.debug({
      event: 'headroom_reserve_decision',
      deviceId: device.id,
      deviceName: device.name,
      outcome: decision.outcome,
      startupKw: resolveStartupPowerKw(device),
      armedMs: decision.armedMs,
      ageMs: decision.armedMs === null ? null : nowTs - decision.armedMs,
    });
  }

  state.headroomReserveArmedMs = nextArmedMs;
  return reserves;
}

type ReserveDecision = {
  outcome: ReserveOutcome;
  // The arming stamp to carry into the next cycle, or null to drop it (so a later start gets a
  // fresh window). An expired reserve keeps its stamp so the lapse sticks instead of re-arming.
  armedMs: number | null;
  reserve: HeadroomReserve | null;
};

function resolveReserveForDevice(params: {
  device: DevicePlanDevice;
  armedMs: number | null;
  nowTs: number;
}): ReserveDecision {
  const { device, armedMs, nowTs } = params;

  // Already started once under this grant — stay released, whatever the meter says right now.
  if (armedMs === RELEASED) return { outcome: 'satisfied', armedMs: RELEASED, reserve: null };

  // Both of the next two gates read fields a flaky Homey poll can flip for a single cycle
  // (`steppedLoadProfile`, `available`, `commandableNow`). They withhold the reserve for that
  // cycle but KEEP the arming stamp: dropping it would restart the 15-minute bound on every blip,
  // and the bound is the only protection against a reserve that can never be satisfied. Only a
  // genuine start (`satisfied`) or a withdrawn permission clears the clock.
  const startupKw = resolveStartupPowerKw(device);
  // Cannot reason about its draw → no reserve.
  if (startupKw === null) return { outcome: 'unknown_device_power', armedMs, reserve: null };

  // The device will never start, so reserving on its behalf is pure cost to everyone else.
  if (!isStartable(device)) return { outcome: 'not_startable', armedMs, reserve: null };

  if (isStartupSatisfied(device, startupKw)) return { outcome: 'satisfied', armedMs: RELEASED, reserve: null };

  const armedSince = armedMs ?? nowTs;
  // Bounded so an unsatisfiable reserve — a priority-2 device behind an immovable priority-1 load,
  // say — cannot hold lower-priority devices off indefinitely.
  if (nowTs - armedSince > HEADROOM_RESERVE_MAX_MS) {
    return { outcome: 'expired', armedMs: armedSince, reserve: null };
  }

  return {
    outcome: 'armed',
    armedMs: armedSince,
    reserve: {
      deviceId: device.id,
      deviceName: device.name,
      priority: device.priority ?? DEFAULT_PRIORITY,
      kw: startupKw,
    },
  };
}

/**
 * The reserves claiming power ahead of this device: every reserve held by a device of STRICTLY
 * higher importance. Equal priority does not claim — a peer has no claim over a peer — and the
 * device's own reserve never claims against itself.
 */
function claimingReserves(
  dev: Pick<DevicePlanDevice, 'id' | 'priority'>,
  reserves: readonly HeadroomReserve[],
): HeadroomReserve[] {
  const devPriority = dev.priority ?? DEFAULT_PRIORITY;
  // lower number = more important
  return reserves.filter((reserve) => reserve.deviceId !== dev.id && reserve.priority < devPriority);
}

/**
 * Total power claimed ahead of this device. Reserves sum, because two devices each waiting for
 * their own block each need that block.
 */
export function resolveClaimedReserveKw(params: {
  dev: Pick<DevicePlanDevice, 'id' | 'priority'>;
  reserves: readonly HeadroomReserve[];
}): number {
  let claimedKw = 0;
  for (const reserve of claimingReserves(params.dev, params.reserves)) claimedKw += reserve.kw;
  return claimedKw;
}

/**
 * How a restore candidate fares once the startup reservations in play are taken off the table.
 *
 *  - `admitted`      — enough power after the reservations; proceed.
 *  - `blocked_by_reserve` — there is enough RAW power, it is just promised to a more important
 *                    device. The caller must stand down with `buildReservedForStartReason` and
 *                    must NOT fall through to the swap path: shedding a running device to take a
 *                    block that is already promised would defeat the reservation and issue the
 *                    very write it exists to avoid.
 *  - `insufficient`  — short of power regardless of any reservation; the caller's normal
 *                    shortfall/swap handling applies, against `reservedKw`-adjusted headroom so a
 *                    swap still cannot eat the promised block.
 *
 * One discriminated result rather than two parallel metric bundles: judging on the wrong one of
 * `admission` / `rawAdmission` was representable and silent.
 */
export type ReserveAdmission =
  | { kind: 'admitted'; admission: RestoreAdmissionMetrics; effectiveHeadroomKw: number; reservedKw: number }
  // Carries the holder's NAME, resolved here rather than re-derived by each
  // caller: this is the only branch on which a holder is guaranteed to exist
  // (it needs `claimedKw > 0`, i.e. a live claiming reserve), so resolving it in
  // the producer is what lets `reservedForStart.targetName` and
  // `reserveHolderName` be non-nullable downstream. Resolution belongs in the
  // producer (`docs/architecture.md`).
  | {
    kind: 'blocked_by_reserve';
    admission: RestoreAdmissionMetrics;
    effectiveHeadroomKw: number;
    reservedKw: number;
    holderName: string;
  }
  | { kind: 'insufficient'; admission: RestoreAdmissionMetrics; effectiveHeadroomKw: number; reservedKw: number };

export function resolveReserveAdmission(params: {
  dev: Pick<DevicePlanDevice, 'id' | 'priority'>;
  availableHeadroom: number;
  neededKw: number;
  reserves: readonly HeadroomReserve[];
}): ReserveAdmission {
  const { dev, availableHeadroom, neededKw, reserves } = params;
  const claimedKw = resolveClaimedReserveKw({ dev, reserves });

  // Signed, unclamped, on purpose. The reserve is an amount that must stay FREE, not a ceiling on
  // the available figure, so the subtraction has to survive both awkward cases:
  //   - `availableHeadroom` already negative (a large pending restore pushes it there): clamping
  //     at zero would return 0 > A and make a reservation MORE permissive than none at all;
  //   - the claim exceeding available power — the tight case the feature exists for: capping
  //     `reservedKw` at `availableHeadroom` would let a swap free just enough for itself and
  //     quietly eat the unaccounted remainder of the promised block.
  // Callers subtract `reservedKw` before handing headroom to the swap path, so a swap must free
  // enough for the candidate AND the whole reservation.
  const effectiveHeadroomKw = availableHeadroom - claimedKw;
  const reservedKw = claimedKw;

  const admission = buildRestoreAdmissionMetrics({ availableKw: effectiveHeadroomKw, neededKw });
  if (admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) {
    return { kind: 'admitted', admission, effectiveHeadroomKw, reservedKw };
  }
  // Branch on the claiming reserve itself, not on whether the two headroom figures happen to
  // differ: with `availableHeadroom === 0` and a live claim they are equal, and the reservation
  // would go unnamed. Holding the RESERVE (rather than testing `claimedKw > 0`) is what makes
  // `holderName` non-nullable structurally instead of by argument — the two predicates are
  // equivalent today only because `resolveStartupPowerKw` declines to reserve a non-positive
  // figure, and a future zero-kW reserve would leave the claim unnamed under the sum test.
  const holder = resolveClaimingReserveHolder({ dev, reserves });
  if (holder !== null) {
    const rawAdmission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw });
    if (rawAdmission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) {
      // Deliberately carries NO kW shortfall. This branch means raw power is
      // already sufficient — it is simply promised to a more important device —
      // so a gap derived from the post-reserve admission resolves to
      // `claimedKw + neededKw − availableHeadroom + 0.5`, i.e. it is dominated by
      // the OTHER device's reserved block. Prod-shaped example: 2.5 kW free, this
      // device needs 2.0 kW, holder reserves 3.6 kW → the card would read "3.6 kW
      // more needed". That states another device's quantity as this one's, the
      // same error `swapPending`/`swappedOut` avoid by not carrying the field.
      // The honest line here names the holder ("Waiting so X can start").
      return {
        kind: 'blocked_by_reserve',
        admission: rawAdmission,
        effectiveHeadroomKw,
        reservedKw,
        holderName: holder.deviceName,
      };
    }
    return { kind: 'insufficient', admission: rawAdmission, effectiveHeadroomKw, reservedKw };
  }
  return { kind: 'insufficient', admission, effectiveHeadroomKw, reservedKw };
}

/**
 * The reservation standing in this device's way — the most important claiming reserve (lowest
 * priority number). `null` when nothing claims against it. Byte-stable across plan cycles: the
 * name it yields carries no kW figures, so a card built from it does not churn.
 *
 * Private on purpose. The holder is resolved ONCE, on the `blocked_by_reserve` branch of
 * `resolveReserveAdmission`, and travels on that result — so the two lanes that name the holder
 * cannot disagree, and neither has to re-derive (or re-null-check) it. Those lanes are
 * `buildReservedForStartReason` below (the restore/hold lane, which may change the reason CODE
 * because it knows the shed has materialized) and `finalizeCeilingReason`
 * (`lib/plan/planReasons.ts`), which may only attach the name as a display field — it cannot tell
 * a materialized shed from an in-flight one, and `reservedForStart` builds no actuation intent.
 */
function resolveClaimingReserveHolder(params: {
  dev: Pick<DevicePlanDevice, 'id' | 'priority'>;
  reserves: readonly HeadroomReserve[];
}): HeadroomReserve | null {
  let holder: HeadroomReserve | null = null;
  for (const reserve of claimingReserves(params.dev, params.reserves)) {
    if (holder === null || reserve.priority < holder.priority) holder = reserve;
  }
  return holder;
}

export function buildReservedForStartReason(holderName: string): DeviceReason {
  return { code: PLAN_REASON_CODES.reservedForStart, targetName: holderName };
}

/**
 * The power the device draws once it reaches its lowest active step. Stepped devices read that
 * step's planning power; everything else reads the producer-resolved expected demand, which is
 * always positive. Only the stepped arm can still decline to reserve, and only because a device
 * with no usable step genuinely has nothing to size against.
 */
function resolveStartupPowerKw(device: DevicePlanDevice): number | null {
  if (isSteppedLoadDevice(device)) {
    const lowest = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
    if (!lowest) return null;
    // Reserve what the step will ACTUALLY draw, not its nameplate: the same calibrated figure the
    // admission gate downstream will judge against (`resolveStepAdmissionKw`). Reserving nameplate
    // for a charger whose lowest step really pulls more just lets the block get nibbled anyway.
    const admissionKw = resolveStepAdmissionKw(device, lowest.id);
    return isFiniteNumber(admissionKw) && admissionKw > 0 ? admissionKw : null;
  }
  return device.expectedPowerKw;
}

// A device PELS cannot start gets no reserve: an external off-hold, an unavailable device, or one
// that is not commandable right now will not reach step 1 this cycle no matter how much power is
// held for it, and the reserve is charged entirely to other devices.
// `externalOffHoldActive` is re-checked here as defence in depth: the producer already gates the
// flag on it, but this module must be correct on its own for any future setter of the bit.
function isStartable(device: DevicePlanDevice): boolean {
  // `plannedState` is already materialized when the restore pass resolves reserves, so a device
  // the shedding pass (or the decoration force-shed) put down this cycle is caught here: it is not
  // starting, so holding power for it is pure cost to everyone else.
  return device.plannedState !== 'shed'
    && device.plannedState !== 'inactive'
    && device.externalOffHoldActive !== true
    && device.available
    && device.commandableNow !== false;
}

/**
 * Release must key on step evidence, not on draw. The retired pause-hold lane used a draw proxy
 * (measured power at half the lowest step), which is wrong at exactly this boundary: an EV charger
 * correctly sitting on 6 A while it ramps, or a heater holding its lowest element at setpoint,
 * reads below that proxy and would keep a reservation alive long after the device had started.
 *
 * Has the device reached step 1? For a stepped device this is decided on CONFIRMED step evidence,
 * never on measured draw: a charger correctly sitting on 6 A while it ramps, or a heater holding
 * its lowest element at setpoint, reads well below half its nameplate step and a draw-only test
 * would keep the reserve alive long after the device had started — precisely the overreach this
 * design removes. Same rule and rationale as `isSwapTargetComplete` (`lib/plan/swap/completion.ts`).
 *
 * The draw test remains as a second, independent release path: it is the only signal a non-stepped
 * device has, and for a stepped device it can only release EARLIER than the step evidence would.
 */
function isStartupSatisfied(device: DevicePlanDevice, startupKw: number): boolean {
  if (isReportedAtOrAboveLowestActiveStep(device)) return true;
  // A device whose binary control is confirmed ON has started, full stop — whether or not it
  // happens to be drawing this instant. Without this the draw test alone loops forever on any
  // duty-cycling load: a water heater PELS keeps on draws its element power (satisfied, clock
  // cleared), cuts out at setpoint (0 W, clock re-armed from scratch), and `HEADROOM_RESERVE_MAX_MS`
  // never elapses, so its block is withheld from every lower-priority device for the whole window.
  // `currentOn` already folds the stepped-off step for binary+stepped devices, so a capped stepper
  // still reads off here and keeps its reserve.
  if (isBinaryPlanDevice(device) && device.currentOn) return true;
  const activeThresholdKw = Math.max(MIN_ACTIVE_MEASURED_POWER_KW, startupKw * RELEASE_ACTIVE_FRACTION);
  return device.currentDrawKw >= activeThresholdKw;
}

function isReportedAtOrAboveLowestActiveStep(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device)) return false;
  const lowestStep = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  // An absent/unknown `reportedStepId` yields null here, so an unconfirmed device is treated as
  // NOT started and keeps its reserve — the fail-safe direction.
  const reportedStep = getSteppedLoadStep(device.steppedLoadProfile, device.reportedStepId);
  if (!lowestStep || !reportedStep) return false;
  return reportedStep.planningPowerW >= lowestStep.planningPowerW;
}
