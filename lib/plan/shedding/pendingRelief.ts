/**
 * Relief a recent shed counted on that the whole-home reading does not show yet.
 *
 * A shed decision spends relief against a deficit measured on one whole-home
 * reading. The next reading usually arrives before that relief shows on it, for
 * two independent reasons:
 *
 * - **The device has not delivered it yet.** An EV charger takes seconds to
 *   ramp to a new current, and it echoes the new setpoint before its draw
 *   moves. On 2026-10-01 at 22:25 (SHS) a charger stepped 20 A -> 14 A for a
 *   1.02 kW deficit still drew its 20 A three seconds later; the next reading
 *   re-priced it from that draw and cut it to 12 A, then the 14 A landed.
 * - **The meter has not caught up.** The aggregate lags the switch: a repeat of
 *   the pre-shed watts, or a jitter of a watt or two (4351 -> 4348, 2026-08-01),
 *   reads as a deficit the shed has already covered.
 *
 * Either way, deepening on that reading cuts load the owner ranked higher for a
 * deficit that is already answered. So for `PENDING_SHED_RELIEF_WINDOW_MS` after
 * a device's shed was decided, the relief that decision banked still counts, the
 * device is held where the decision put it, and only what the credit leaves open
 * is shed anew.
 *
 * The two causes are told apart per device, from the device's OWN meter
 * (`notes/state-management/actuation-clocks-and-settle.md`: whether a specific
 * device responded is read from that device, never from the whole-home sum):
 *
 * - **Undelivered** relief is the draw still above the state the decision put the
 *   device in: above the held rung for a step-down, all of it for a turn-off or
 *   a setback. It counts in full whatever the whole-home reading does — the
 *   command, once it lands, removes that draw however it got there.
 * - **Delivered** relief is the rest of what was credited. It counts only until
 *   the whole-home reading has fallen by half of it: a lagging aggregate shows a
 *   switch not at all, or (averaged across its interval) in part, while jitter
 *   moves it by watts. Past half, the reading has seen the shed and is believed
 *   as it stands. A device whose own meter overstated its draw frees less than
 *   it claimed (a water heater credited 2 kW freed 1.08 kW, 2026-08-01), and
 *   holding that gap open would stall a real deficit for the whole window.
 *   The sum cannot tell a lagging meter from a new load that masks the fall, so
 *   a load starting just as a shed lands is under-answered until the window
 *   ends: under an hourly-average cap that costs a few watt-hours, where cutting
 *   the next device costs the owner comfort or charge.
 *
 * Every device carries its own decision time, so a later residual shed never
 * extends an earlier device's credit: a command that has not shown up within
 * the window stops being credited and escalates, as an unconfirmed command
 * always has. That holds for the device itself too: choosing a held device
 * again restarts its window only once it has delivered what it was already
 * asked for. A device that has not moved keeps its first stamp, so a stuck
 * command cannot be renewed one rung at a time while nothing else is shed.
 *
 * Retirement is one-way. A decision whose relief the reading has shown, whose
 * device has left the snapshot or lost its meter, or whose rung is no longer on
 * the device's ladder, has no evidence left to credit and is dropped from the
 * latch the pass commits; a later rise in the reading, or the device coming
 * back, cannot revive it.
 *
 * This is bookkeeping about the planner's own decisions, not a settle verdict:
 * nothing here says whether a write landed, and no tolerance or timing is
 * applied to the device's reading. The executor still owns settle.
 */
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { ShedLatchDecision, ShedPlanLatch } from '../planState';
import type { MeteredPlanInputDevice, PlanInputDevice } from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { isSteppedLoadDevice, isSteppedLoadStepBelow, resolveSteppedLoadPlanningKw } from '../planSteppedLoad';
import { getSteppedLoadStep } from '../../../packages/shared-domain/src/deviceControlProfiles';
import type { ShedSelection } from './selection';
import { chooseShedRung } from './steppedCandidates';
import type { ShedCandidate, SteppedShedCandidate } from './types';

/**
 * How long a shed's relief is credited against readings that do not show it.
 * An EV charger takes 14-30 s to apply a step and the `homey_energy` poll runs
 * every 10 s, so 30 s covers a slow ramp and two polls. It is also
 * `OVERSHOOT_ESCALATION_INTERVAL_MS`, so a shed that achieved nothing escalates
 * on the same cadence as a stuck reading always has.
 */
const PENDING_SHED_RELIEF_WINDOW_MS = 30 * 1000;

/** How far the reading must fall, as a share of the delivered relief, to have seen it. */
const DELIVERED_RELIEF_SEEN_FRACTION = 0.5;

/** 1 W — below any real shed decision, above float drift in a derived deficit. */
export const PENDING_RELIEF_EPSILON_KW = 0.001;

export type PendingShedRelief = {
  readonly latch: ShedPlanLatch;
  /** This cycle's whole-home reading, which the credit is counted against. */
  readonly powerW: number;
  /**
   * The latched decisions that still stand: in their window, for a device still
   * in the snapshot with a meter and its decided rung, whose relief the reading
   * has not yet shown. What is held, and what a re-latch carries over.
   */
  readonly held: ReadonlyMap<string, ShedLatchDecision>;
  /** The latch with every retired decision dropped — what a pass that adds nothing commits. */
  readonly retained: ShedPlanLatch;
  /** Per held device, the relief still to show on `powerW`. */
  readonly outstandingKw: ReadonlyMap<string, number>;
  /** Per held device that banked relief, the part its own meter says it has not delivered yet. */
  readonly undeliveredKwByDevice: ReadonlyMap<string, number>;
  readonly totalKw: number;
  /** Credited relief the held devices have not delivered, by their own meters. */
  readonly undeliveredKw: number;
  /** Credited relief they have delivered, by their own meters. */
  readonly deliveredKw: number;
  /** How far the whole-home reading has fallen since the latched one. */
  readonly realisedKw: number;
};

/**
 * The latched decisions that still stand, and the relief to credit for them,
 * against this cycle's reading — or null when there is no latch, or this sample
 * carries no watts to count against. Nothing standing is an answer too: its
 * `retained` latch is what retires the rest for good.
 */
export function resolvePendingShedRelief(
  latch: ShedPlanLatch | null,
  devices: readonly PlanInputDevice[],
  powerW: number | null,
  nowTs: number,
): PendingShedRelief | null {
  if (latch === null || powerW === null) return null;
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const live = [...latch.decisions].filter(([deviceId, decision]) => (
    isWithinWindow(decision, nowTs)
    && isStillDecidable(devicesById.get(deviceId), latch.stepTargets.get(deviceId))
  ));
  const shares = live
    .filter(([, decision]) => decision.creditedKw > 0)
    .map(([deviceId, decision]) => {
      const undeliveredKw = resolveUndeliveredReliefKw(devicesById.get(deviceId), latch.stepTargets.get(deviceId));
      return { deviceId, undeliveredKw, deliveredKw: Math.max(0, decision.creditedKw - undeliveredKw) };
    });
  const undeliveredKw = sumKw(shares.map((share) => share.undeliveredKw));
  const deliveredKw = sumKw(shares.map((share) => share.deliveredKw));
  const realisedKw = (latch.powerW - powerW) / 1000;
  const unseenShare = resolveUnseenDeliveredShare(deliveredKw, realisedKw);
  const outstandingKw = new Map(shares
    .map((share) => [share.deviceId, share.undeliveredKw + share.deliveredKw * unseenShare] as const)
    .filter(([, kw]) => kw > PENDING_RELIEF_EPSILON_KW));
  // A credited decision with nothing left outstanding has been delivered and
  // seen: it is done, not held.
  const held = new Map(live.filter(([deviceId, decision]) => (
    decision.creditedKw <= 0 || outstandingKw.has(deviceId)
  )));
  return {
    latch,
    powerW,
    held,
    retained: {
      powerW: latch.powerW,
      decisions: held,
      stepTargets: new Map([...latch.stepTargets].filter(([deviceId]) => held.has(deviceId))),
    },
    outstandingKw,
    undeliveredKwByDevice: new Map(shares
      .filter((share) => held.has(share.deviceId))
      .map((share) => [share.deviceId, share.undeliveredKw] as const)),
    totalKw: sumKw([...outstandingKw.values()]),
    undeliveredKw,
    deliveredKw,
    realisedKw,
  };
}

function isWithinWindow(decision: ShedLatchDecision, nowTs: number): boolean {
  const sinceDecidedMs = nowTs - decision.decidedAtMs;
  return sinceDecidedMs >= 0 && sinceDecidedMs < PENDING_SHED_RELIEF_WINDOW_MS;
}

function isReadable(device: PlanInputDevice | undefined): device is MeteredPlanInputDevice {
  return device !== undefined && isMeteredPlanDevice(device);
}

/**
 * Whether there is still evidence to hold this decision against: the device is
 * in the snapshot with a meter, and a decided rung is still on its ladder — a
 * profile edit can remove it, and a rung that no longer exists can be neither
 * re-asserted nor priced.
 */
function isStillDecidable(device: PlanInputDevice | undefined, decidedStepId: string | undefined): boolean {
  if (!isReadable(device)) return false;
  if (decidedStepId === undefined) return true;
  return isSteppedLoadDevice(device) && getSteppedLoadStep(device.steppedLoadProfile, decidedStepId) !== null;
}

/**
 * The draw still above the state the decision put this device in: above the held rung, or all of it.
 * The rung is priced at its nameplate, like every capacity decision (`resolveStepChangeKw`): a learned
 * figure is never above it, so it could only credit relief that never comes.
 */
function resolveUndeliveredReliefKw(
  device: PlanInputDevice | undefined,
  heldStepId: string | undefined,
): number {
  if (!isReadable(device)) return 0;
  const drawKw = Math.max(0, device.currentDrawKw);
  if (heldStepId === undefined || !isSteppedLoadDevice(device)) return drawKw;
  return Math.max(0, drawKw - resolveSteppedLoadPlanningKw(device, heldStepId));
}

/** The share of delivered relief the reading has not shown, or 0 once it has seen half. */
function resolveUnseenDeliveredShare(deliveredKw: number, realisedKw: number): number {
  if (deliveredKw <= PENDING_RELIEF_EPSILON_KW) return 0;
  if (realisedKw >= deliveredKw * DELIVERED_RELIEF_SEEN_FRACTION) return 0;
  return Math.min(1, Math.max(0, (deliveredKw - realisedKw) / deliveredKw));
}

/**
 * The held decisions, re-asserted where they stand: every held device that is
 * still a candidate keeps its shed, and a stepped one stays at the rung it was
 * sent to rather than being re-priced from wherever it now reports. That
 * re-pricing walked an EV charger one rung deeper per held cycle against the
 * same deficit.
 *
 * Bounded by candidacy, as an ordinary cycle is: a device now confirmed off is
 * not a candidate and leaves the set — it needs no off command, and whether it
 * stays off is the restore lane's decision. Its delivered relief is still
 * credited until the reading shows it.
 */
export function holdPendingShedDecision(
  candidates: readonly ShedCandidate[],
  pending: PendingShedRelief,
  reason: DeviceReason,
): Omit<ShedSelection, 'creditedKw'> {
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, DeviceReason>();
  const shedStepTargets = new Map<string, string>();
  for (const candidate of candidates) {
    if (!pending.held.has(candidate.id)) continue;
    shedSet.add(candidate.id);
    shedReasons.set(candidate.id, reason);
    const heldStepId = resolveHeldStepId(candidate, pending.latch);
    if (heldStepId !== undefined) shedStepTargets.set(candidate.id, heldStepId);
  }
  return { shedSet, shedReasons, shedStepTargets };
}

/**
 * The candidates a cycle may still spend on once the pending relief is
 * credited. A held binary or setback device offers nothing more: its whole
 * relief is the decision already credited. A held stepped device can still go
 * deeper, but only for what the held rung leaves: each rung is re-priced net of
 * the undelivered relief, which the credit has already counted. Pricing it from
 * the meter alone counted those watts twice — the 22:25 charger priced 14 A ->
 * 12 A at 1.9 kW instead of 0.4 kW. A held decision that banked nothing (an
 * older command was still unconfirmed when it was taken) is held only: its
 * watts are neither credited nor offered net, and it escalates as such a
 * command always has.
 *
 * Kept in this cycle's ranking order. The ranking keys a held device on its
 * meter-priced relief, which over-states what is left below its rung; that can
 * only move it ahead of an equal-priority candidate, and what it is then spent
 * for is still sized net.
 */
export function candidatesBeyondPendingRelief(
  candidates: readonly ShedCandidate[],
  pending: PendingShedRelief,
): ShedCandidate[] {
  return candidates.flatMap((candidate): ShedCandidate[] => {
    const heldDecision = pending.held.get(candidate.id);
    if (heldDecision === undefined) return [candidate];
    if (candidate.kind !== 'stepped' || heldDecision.creditedKw <= 0) return [];
    const heldStepId = resolveHeldStepId(candidate, pending.latch);
    if (heldStepId === undefined) return [];
    const beyond = withReliefBelowHeldStep(candidate, heldStepId, pending.latch.stepTargets.get(candidate.id));
    return beyond === null ? [] : [beyond];
  });
}

/**
 * Where the latch keeps a stepped device: the rung it was sent to, or the
 * device's own step if it already sits lower — re-asserting the decided rung
 * there would be a climb. Undefined for a device the latch gave no rung (a
 * binary, setback, or prepared-binary-off decision).
 */
function resolveHeldStepId(candidate: ShedCandidate, latch: ShedPlanLatch): string | undefined {
  if (candidate.kind !== 'stepped' || !isSteppedLoadDevice(candidate)) return undefined;
  const decidedStepId = latch.stepTargets.get(candidate.id);
  if (decidedStepId === undefined) return undefined;
  return isSteppedLoadStepBelow(candidate, candidate.fromStepId, decidedStepId)
    ? candidate.fromStepId
    : decidedStepId;
}

/**
 * The candidate's relief beyond its held rung, or null when nothing is left.
 * Rungs at or above the held one are dropped; the rest are priced net of the
 * undelivered relief. A prepared-binary-off candidate (no rungs) keeps its
 * binary off, net the same way. What is left is new relief, so it is banked.
 */
function withReliefBelowHeldStep(
  candidate: SteppedShedCandidate,
  heldStepId: string,
  decidedStepId: string | undefined,
): SteppedShedCandidate | null {
  if (!isSteppedLoadDevice(candidate)) return null;
  const undeliveredKw = resolveUndeliveredReliefKw(candidate, decidedStepId);
  if (candidate.rungs.length === 0) {
    const offReliefKw = candidate.effectivePower - undeliveredKw;
    if (offReliefKw <= 0) return null;
    return { ...candidate, effectivePower: offReliefKw, unconfirmedRelief: false };
  }
  const rungs = candidate.rungs
    .filter((rung) => isSteppedLoadStepBelow(candidate, rung.toStepId, heldStepId))
    .map((rung) => ({ toStepId: rung.toStepId, reliefKw: rung.reliefKw - undeliveredKw }))
    .filter((rung) => rung.reliefKw > 0);
  const deepest = chooseShedRung(rungs, Number.POSITIVE_INFINITY);
  if (deepest === null) return null;
  return {
    ...candidate,
    fromStepId: heldStepId,
    rungs,
    effectivePower: deepest.reliefKw,
    unconfirmedRelief: false,
  };
}

/**
 * The latch a shed leaves behind: `chosen` is what this cycle newly decided,
 * `carried` the held decisions still in their window. A carried decision keeps
 * its own stamp — a later shed must not extend an earlier device's credit — and
 * the credit still outstanding against `powerW`. A device chosen this cycle
 * banks what it freed on top of anything it carried, and is stamped now unless
 * it was held and has not delivered what it was already asked for: a stuck
 * command keeps its first stamp however often it is deepened. A carried device
 * keeps its rung, so its undelivered relief is still measured against it while
 * it is no longer a candidate (a charger parked at its floor); a device chosen
 * again takes the new rung, or none for a binary off.
 */
export function latchShedDecision(
  chosen: ShedSelection,
  carried: PendingShedRelief | null,
  powerW: number,
  nowTs: number,
): ShedPlanLatch {
  const decisions = new Map<string, ShedLatchDecision>();
  const stepTargets = new Map<string, string>();
  if (carried !== null) {
    for (const [deviceId, decision] of carried.held) {
      decisions.set(deviceId, {
        decidedAtMs: decision.decidedAtMs,
        creditedKw: carried.outstandingKw.get(deviceId) ?? 0,
      });
      const stepId = carried.latch.stepTargets.get(deviceId);
      if (stepId !== undefined) stepTargets.set(deviceId, stepId);
    }
  }
  for (const deviceId of chosen.shedSet) {
    const carriedDecision = decisions.get(deviceId);
    const stillUndelivered = (carried?.undeliveredKwByDevice.get(deviceId) ?? 0) > PENDING_RELIEF_EPSILON_KW;
    decisions.set(deviceId, {
      decidedAtMs: carriedDecision !== undefined && stillUndelivered ? carriedDecision.decidedAtMs : nowTs,
      creditedKw: (carriedDecision?.creditedKw ?? 0) + (chosen.creditedKw.get(deviceId) ?? 0),
    });
    const stepId = chosen.shedStepTargets.get(deviceId);
    if (stepId === undefined) stepTargets.delete(deviceId);
    else stepTargets.set(deviceId, stepId);
  }
  return { powerW, decisions, stepTargets };
}

function sumKw(values: readonly number[]): number {
  return values.reduce((total, kw) => total + kw, 0);
}
