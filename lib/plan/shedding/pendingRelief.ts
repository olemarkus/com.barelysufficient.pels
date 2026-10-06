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
 *   command, once it lands, removes that draw however it got there. A charger
 *   rung's nameplate is its current at nominal mains, so a charger that reads a
 *   little over its held rung has landed there (`resolveLandedRungAllowanceKw`).
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
 * The reading's fall is laid against the oldest decisions first. Commands land
 * in the order they were sent and a lagging meter shows them in that order, so
 * a fall that shows only an earlier step does not retire a later one; the
 * decisions taken on one reading share the half rule. A decision past its
 * window credits nothing, but keeps its claim on the fall while a newer one
 * stands, and a seen decision takes the fall it claimed with it when it is
 * dropped, so every decision is measured only against the fall it alone can
 * claim. A residual shed re-latches against its own reading, restating each
 * standing decision as what it still has to show there, so a partly seen
 * decision's half rule restarts on the remainder: a 1 kW step seen by 0.4 kW
 * needs 0.3 kW more, not 0.1 kW. Accepted: it errs toward crediting, and only
 * until that decision's own window ends.
 *
 * Every decision carries its own stamp, so a later residual shed never extends
 * an earlier one's credit: a command that has not shown up within the window
 * stops being credited and escalates, as an unconfirmed command always has.
 * That holds for one device's decisions too. A held device chosen again once it
 * has delivered what it was already asked for gets a new decision beside the
 * old one, which keeps its stamp and expires on it. Folding the old relief into
 * a restamped decision re-dated it: a charger walked down one rung per reading
 * under a ramping heat pump kept every step it had already given credited, and
 * the next device was never shed. A device that has not moved has the new
 * relief added to its newest decision on that decision's stamp, so a stuck
 * command cannot be renewed one rung at a time while nothing else is shed.
 *
 * Retirement is one-way. A decision whose relief the reading has shown, whose
 * device has left the snapshot or lost its meter, or whose rung is no longer on
 * the device's ladder, has no evidence left to credit and is dropped from the
 * latch the pass commits; a later rise in the reading, or the device coming
 * back, cannot revive it.
 *
 * A home battery chosen to cap its charge is credited here like any device:
 * its own signed power shows the charge falling, so its undelivered relief is
 * its charge above the setpoint PELS holds it at (`StorageLeverState`). Only
 * the charge it stops is banked here; a discharge it was asked for is the
 * storage term's credit (`StorageShedTerm`), so the two never count one watt
 * twice. A battery PELS no longer holds, or cannot read, has nothing to credit.
 *
 * This is bookkeeping about the planner's own decisions, not a settle verdict:
 * nothing here says whether a write landed, and no settle tolerance or timing is
 * applied to the device's reading; the one allowance is the mains-voltage one on
 * a charger's landed rung, which is about what that rung's nameplate means. The
 * executor still owns settle.
 */
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { ShedLatchDecision, ShedPlanLatch, StorageLeverState } from '../planState';
import type { MeteredPlanInputDevice, PlanInputDevice, SteppedPlanInputDevice } from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { isSteppedLoadDevice, isSteppedLoadStepBelow, resolveSteppedLoadPlanningKw } from '../planSteppedLoad';
import { getSteppedLoadStep, sortSteppedLoadSteps } from '../../../packages/shared-domain/src/deviceControlProfiles';
import type { ShedSelection } from './selection';
import { chooseShedRung } from './steppedCandidates';
import type { ShedCandidate, StorageSetpoint, SteppedShedCandidate } from './types';
import { hasStorageInput } from '../battery/storageLadder';

/** The holds PELS keeps on home batteries (`PlanEngineState.storageLeverByDevice`). */
type StorageLevers = Readonly<Record<string, StorageLeverState>>;

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

/**
 * How far above its held rung's nameplate an EV charger may draw and still have
 * landed there, as a share of that nameplate; see `resolveLandedRungAllowanceKw`.
 * 5% covers mains up to 241.5 V.
 */
const LANDED_RUNG_OVERDRAW_RATIO = 0.05;

/** The share of the gap to the rung above that the allowance never reaches. */
const LANDED_RUNG_GAP_FRACTION = 0.5;

/** 1 W — below any real shed decision, above float drift in a derived deficit. */
export const PENDING_RELIEF_EPSILON_KW = 0.001;

export type PendingShedRelief = {
  readonly latch: ShedPlanLatch;
  /** This cycle's whole-home reading, which the credit is counted against. */
  readonly powerW: number;
  /**
   * Per device, the latched decisions that still stand, oldest first: in their
   * window, for a device still in the snapshot with a meter and its decided
   * rung, whose relief the reading has not yet shown. What is held.
   */
  readonly held: ReadonlyMap<string, readonly ShedLatchDecision[]>;
  /**
   * The latch with every retired decision dropped — what a pass that adds
   * nothing commits. It keeps the latched reading, lowered by the fall the
   * dropped decisions claimed, and the expired decisions that still have a fall
   * to claim while a newer one stands.
   */
  readonly retained: ShedPlanLatch;
  /**
   * The retained decisions on their own stamps, each credited with what it
   * still has to show on `powerW`: what a re-latch against `powerW` carries over.
   */
  readonly rebased: ReadonlyMap<string, readonly RebasedDecision[]>;
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
 * A retained decision restated against this cycle's reading, with the part of
 * its credit that is already off the device: what it keeps if its device is
 * priced again from its meter.
 */
type RebasedDecision = ShedLatchDecision & { readonly unshownDeliveredKw: number };

/** One latched decision's relief, split by its device's own meter. */
type ReliefShare = {
  readonly deviceId: string;
  readonly decision: ShedLatchDecision;
  readonly undeliveredKw: number;
  readonly deliveredKw: number;
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
  storageLevers: StorageLevers,
): PendingShedRelief | null {
  if (latch === null || powerW === null) return null;
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  // A decision whose device has left the snapshot, or whose rung is gone, is
  // dropped with its claim: a later fall that shows its step goes to the newer
  // decisions. Accepted — there is nothing left to read the claim from.
  const shares = [...latch.decisions].flatMap(([deviceId, decisions]) => {
    const device = devicesById.get(deviceId);
    const taken = decisions.filter((decision) => decision.decidedAtMs <= nowTs);
    const storageUndeliveredKw = resolveStorageUndeliveredKw(device, storageLevers[deviceId]);
    if (storageUndeliveredKw === 'gone') return [];
    if (storageUndeliveredKw !== 'not_storage') return splitDeviceRelief(deviceId, taken, storageUndeliveredKw);
    const stepId = latch.stepTargets.get(deviceId);
    if (!isStillDecidable(device, stepId)) return [];
    return splitDeviceRelief(deviceId, taken, resolveUndeliveredReliefKw(device, stepId));
  });
  const realisedKw = (latch.powerW - powerW) / 1000;
  const attribution = attributeRealisedRelief(shares, realisedKw);
  const assessed = shares.map((share) => {
    const { unseenShare } = attribution.get(share.decision.decidedAtMs) ?? NOTHING_ATTRIBUTED;
    const unshownDeliveredKw = share.deliveredKw * unseenShare;
    return {
      share,
      live: isWithinWindow(share.decision, nowTs),
      seen: unseenShare === 0,
      unshownDeliveredKw,
      outstandingKw: share.undeliveredKw + unshownDeliveredKw,
    };
  });
  // A credited decision with nothing left outstanding has been delivered and
  // seen: it is done. One that banked nothing is held for its window only.
  const standing = assessed.filter(({ share, live, outstandingKw }) => (
    share.decision.creditedKw <= 0 ? live : outstandingKw > PENDING_RELIEF_EPSILON_KW
  ));
  const crediting = standing.filter(({ live }) => live);
  // An expired decision credits nothing, but while a newer one stands on the
  // same reading it keeps the fall its own step can claim: a lagging meter that
  // shows the older step late must not retire the newer one's credit.
  const kept = crediting.length > 0 ? standing : [];
  const held = groupByDevice(crediting.map(({ share }) => [share.deviceId, share.decision] as const));
  const outstandingKw = sumByDevice(crediting
    .filter(({ share }) => share.decision.creditedKw > 0)
    .map(({ share, outstandingKw: kw }) => [share.deviceId, kw] as const));
  const liveShares = assessed.filter(({ live }) => live).map(({ share }) => share);
  const retainedDecisions = groupByDevice(kept.map(({ share, seen }) => [share.deviceId, seen
    ? { decidedAtMs: share.decision.decidedAtMs, creditedKw: Math.min(share.decision.creditedKw, share.undeliveredKw) }
    : share.decision] as const));
  return {
    latch,
    powerW,
    held,
    retained: {
      powerW: latch.powerW - resolveSeenFallKw(attribution) * 1000,
      decisions: retainedDecisions,
      stepTargets: new Map([...latch.stepTargets].filter(([deviceId]) => retainedDecisions.has(deviceId))),
    },
    // A decision that banked nothing has nothing outstanding, so it carries 0.
    rebased: groupByDevice(kept.map(({ share, outstandingKw: kw, unshownDeliveredKw }) => [
      share.deviceId, { decidedAtMs: share.decision.decidedAtMs, creditedKw: kw, unshownDeliveredKw },
    ] as const)),
    outstandingKw,
    undeliveredKwByDevice: sumByDevice(crediting
      .filter(({ share }) => outstandingKw.has(share.deviceId))
      .map(({ share }) => [share.deviceId, share.undeliveredKw] as const)),
    totalKw: sumKw([...outstandingKw.values()]),
    undeliveredKw: sumKw(liveShares.map((share) => share.undeliveredKw)),
    deliveredKw: sumKw(liveShares.map((share) => share.deliveredKw)),
    realisedKw,
  };
}

/**
 * A home battery's charge above the setpoint PELS holds it at, kW, by its own
 * signed power. `gone` for a battery PELS no longer holds, or cannot read: its
 * decision has nothing left to credit and is dropped, like a load that left
 * the snapshot. `not_storage` for a load, whose decision
 * `resolveUndeliveredReliefKw` prices.
 */
function resolveStorageUndeliveredKw(
  device: PlanInputDevice | undefined,
  lever: StorageLeverState | undefined,
): number | 'gone' | 'not_storage' {
  if (device === undefined || !hasStorageInput(device)) return 'not_storage';
  if (lever === undefined || device.storage.reading !== 'observed') return 'gone';
  return Math.max(0, device.storage.signedPowerW - Math.max(0, lever.setpointW)) / 1000;
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
 * The draw above the state the decision put this device in: above the held rung, or all of it.
 * The rung is priced at its nameplate, like every capacity decision (`resolveStepChangeKw`): a learned
 * figure is never above it, so it could only credit relief that never comes. This is the figure a
 * deeper rung is priced net of: a charger landed above nominal mains draws as much over the lower
 * rung's nameplate too, so only the nameplate step between the two is sure to go.
 */
function resolveDrawAboveDecidedKw(
  device: PlanInputDevice | undefined,
  heldStepId: string | undefined,
): number {
  if (!isReadable(device)) return 0;
  const drawKw = Math.max(0, device.currentDrawKw);
  if (heldStepId === undefined || !isSteppedLoadDevice(device)) return drawKw;
  return Math.max(0, drawKw - resolveSteppedLoadPlanningKw(device, heldStepId));
}

/**
 * The relief this device has still to deliver, by its own meter: its draw above the decided state,
 * except a charger within the mains-voltage allowance of its held rung, which has landed there.
 */
function resolveUndeliveredReliefKw(
  device: PlanInputDevice | undefined,
  heldStepId: string | undefined,
): number {
  const aboveKw = resolveDrawAboveDecidedKw(device, heldStepId);
  if (!isReadable(device) || heldStepId === undefined || !isSteppedLoadDevice(device)) return aboveKw;
  return aboveKw > resolveLandedRungAllowanceKw(device, heldStepId) ? aboveKw : 0;
}

/**
 * How far over its held rung's nameplate a device may draw and still be on that rung. Only an EV
 * charger's ladder is a current, whose draw scales with mains voltage: its rung is the current at
 * 230 V, so at 240 V a landed 14 A step reads 3.36 kW against a 3.22 kW rung. Counted as
 * undelivered, that excess was credited for the whole window whatever the reading did and kept the
 * device from ever counting as delivered. Any other ladder is watts the owner chose, at whatever
 * spacing, so a draw over its rung is a step still to come.
 *
 * Watts alone cannot always tell a landed rung from the rung above: 32 A at 220 V reads 7.04 kW,
 * and 30 A at 240 V reads 7.2 kW. The allowance stays under half the gap to the rung above, so at
 * nominal mains a charger still on that rung is never read as landed. Under low mains it can be;
 * that relief then counts as delivered, which the reading still has to show, and choosing the
 * charger again opens a decision beside it rather than renewing it.
 */
function resolveLandedRungAllowanceKw(device: SteppedPlanInputDevice, heldStepId: string): number {
  if (!device.isEvCharger) return 0;
  const heldKw = resolveSteppedLoadPlanningKw(device, heldStepId);
  const ratioKw = heldKw * LANDED_RUNG_OVERDRAW_RATIO;
  const steps = sortSteppedLoadSteps(device.steppedLoadProfile.steps);
  const above = steps[steps.findIndex((step) => step.id === heldStepId) + 1];
  if (above === undefined) return ratioKw;
  const gapKw = resolveSteppedLoadPlanningKw(device, above.id) - heldKw;
  return Math.min(ratioKw, gapKw * LANDED_RUNG_GAP_FRACTION);
}

/**
 * One device's live decisions, oldest first, each with the share of its credit the device's own
 * meter says is still to come. Commands land in the order they were sent, so what is undelivered
 * is the newest decisions' relief; the newest credited one also carries any draw beyond everything
 * credited. A decision that banked nothing has no share of either.
 */
function splitDeviceRelief(
  deviceId: string,
  decisions: readonly ShedLatchDecision[],
  undeliveredKw: number,
): ReliefShare[] {
  const creditedKw = (decision: ShedLatchDecision): number => Math.max(0, decision.creditedKw);
  const totalCreditedKw = sumKw(decisions.map(creditedKw));
  let newestCreditedIndex = -1;
  for (const [index, decision] of decisions.entries()) {
    if (creditedKw(decision) > 0) newestCreditedIndex = index;
  }
  return decisions.map((decision, index) => {
    if (creditedKw(decision) <= 0) return { deviceId, decision, undeliveredKw: 0, deliveredKw: 0 };
    const newerKw = sumKw(decisions.slice(index + 1).map(creditedKw));
    const beyondCreditedKw = index === newestCreditedIndex ? Math.max(0, undeliveredKw - totalCreditedKw) : 0;
    const ownKw = Math.min(creditedKw(decision), Math.max(0, undeliveredKw - newerKw)) + beyondCreditedKw;
    return { deviceId, decision, undeliveredKw: ownKw, deliveredKw: Math.max(0, decision.creditedKw - ownKw) };
  });
}

/** One decision stamp's part of the reading's fall. */
type StampAttribution = {
  /** The share of the stamp's delivered relief the reading has not shown; 0 once it has seen half. */
  readonly unseenShare: number;
  /** The fall the stamp's decisions took. */
  readonly claimedKw: number;
};

const NOTHING_ATTRIBUTED: StampAttribution = { unseenShare: 0, claimedKw: 0 };

/**
 * Per decision stamp, its part of the fall since the latched reading. The fall
 * is laid against the oldest stamp first, and what one stamp's decisions claim,
 * up to what they delivered, is spent; decisions on one stamp were taken on one
 * reading and share it.
 */
function attributeRealisedRelief(
  shares: readonly ReliefShare[],
  realisedKw: number,
): Map<number, StampAttribution> {
  const stamps = [...new Set(shares.map((share) => share.decision.decidedAtMs))].sort((a, b) => a - b);
  const attribution = new Map<number, StampAttribution>();
  let unclaimedKw = Math.max(0, realisedKw);
  for (const stamp of stamps) {
    const deliveredKw = sumKw(shares
      .filter((share) => share.decision.decidedAtMs === stamp)
      .map((share) => share.deliveredKw));
    attribution.set(stamp, {
      unseenShare: resolveUnseenDeliveredShare(deliveredKw, unclaimedKw),
      claimedKw: Math.min(unclaimedKw, deliveredKw),
    });
    unclaimedKw = Math.max(0, unclaimedKw - deliveredKw);
  }
  return attribution;
}

/**
 * The fall the decisions the reading has seen took. A pass that adds nothing
 * lowers its latched reading by this much as it drops them, so the fall they
 * claimed is not laid again against the decisions still standing; each of those
 * keeps exactly the fall it could claim before. Rebasing onto this cycle's
 * reading instead would restate every partly seen credit as a fresh whole, and
 * a fall that arrives in parts would then never reach half of it.
 */
function resolveSeenFallKw(attribution: ReadonlyMap<number, StampAttribution>): number {
  return sumKw([...attribution.values()]
    .filter((stamp) => stamp.unseenShare === 0)
    .map((stamp) => stamp.claimedKw));
}

/** The share of delivered relief the reading has not shown, or 0 once it has seen half. */
function resolveUnseenDeliveredShare(deliveredKw: number, realisedKw: number): number {
  if (deliveredKw <= PENDING_RELIEF_EPSILON_KW) return 0;
  if (realisedKw >= deliveredKw * DELIVERED_RELIEF_SEEN_FRACTION) return 0;
  return Math.min(1, Math.max(0, (deliveredKw - realisedKw) / deliveredKw));
}

function sumByDevice(entries: readonly (readonly [string, number])[]): Map<string, number> {
  return new Map([...groupByDevice(entries)].map(([deviceId, kws]) => [deviceId, sumKw(kws)] as const));
}

function groupByDevice<T>(entries: readonly (readonly [string, T])[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const [deviceId, value] of entries) grouped.set(deviceId, (grouped.get(deviceId) ?? []).concat([value]));
  return grouped;
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
    // A held battery stays where its hold puts it: the hold itself persists
    // (`StorageLeverState`) until the restore lane hands it back.
    if (!pending.held.has(candidate.id) || candidate.kind === 'storage') continue;
    shedSet.add(candidate.id);
    shedReasons.set(candidate.id, reason);
    const heldStepId = resolveHeldStepId(candidate, pending.latch);
    if (heldStepId !== undefined) shedStepTargets.set(candidate.id, heldStepId);
  }
  return {
    shedSet, shedReasons, shedStepTargets, storageSetpoints: new Map<string, StorageSetpoint>(),
  };
}

/**
 * The candidates a cycle may still spend on once the pending relief is
 * credited. A held binary or setback device offers nothing more: its whole
 * relief is the decision already credited. A held stepped device can still go
 * deeper, but only for what the held rung leaves: each rung is re-priced net of
 * the draw above the held rung, which the credit has already counted. Pricing
 * it from the meter alone counted those watts twice — the 22:25 charger priced
 * 14 A -> 12 A at 1.9 kW instead of 0.4 kW. A held device that banked nothing (an
 * older command was still unconfirmed when it was taken) is held only: its
 * watts are neither credited nor offered net, and it escalates as such a
 * command always has.
 *
 * A held battery is priced from the setpoint it is held at already
 * (`StorageShedCandidate.baseW`), so what it offers is net by construction.
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
    const heldDecisions = pending.held.get(candidate.id);
    if (heldDecisions === undefined || candidate.kind === 'storage') return [candidate];
    const bankedKw = sumKw(heldDecisions.map((decision) => decision.creditedKw));
    if (candidate.kind !== 'stepped' || bankedKw <= 0) return [];
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
 * draw above the decided rung, with no mains-voltage allowance: a charger that
 * has landed over its rung's nameplate draws as much over the lower rung's, so
 * only the nameplate step between them is sure to go. A prepared-binary-off
 * candidate (no rungs) keeps its binary off, net the same way. What is left is
 * new relief, so it is banked.
 */
function withReliefBelowHeldStep(
  candidate: SteppedShedCandidate,
  heldStepId: string,
  decidedStepId: string | undefined,
): SteppedShedCandidate | null {
  if (!isSteppedLoadDevice(candidate)) return null;
  const aboveDecidedKw = resolveDrawAboveDecidedKw(candidate, decidedStepId);
  if (candidate.rungs.length === 0) {
    const offReliefKw = candidate.effectivePower - aboveDecidedKw;
    if (offReliefKw <= 0) return null;
    return { ...candidate, effectivePower: offReliefKw, unconfirmedRelief: false };
  }
  const rungs = candidate.rungs
    .filter((rung) => isSteppedLoadStepBelow(candidate, rung.toStepId, heldStepId))
    .map((rung) => ({ toStepId: rung.toStepId, reliefKw: rung.reliefKw - aboveDecidedKw }))
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
 * its own stamp — a later shed must not extend an earlier one's credit — and the
 * credit still outstanding against `powerW`. A device chosen this cycle gets a
 * decision of its own, stamped now, for what it freed, unless it was held and
 * has not delivered what it was already asked for: then the new relief is added
 * to its newest decision on that decision's stamp, so a stuck command is never
 * renewed however often it is deepened. A device given a new decision was
 * priced from its meter, which already counts every watt its earlier decisions
 * have not yet removed, so those keep only relief already off the device: a
 * charger whose expired step never landed, chosen again, must not have that
 * step's watts credited twice. A carried device keeps its rung, so its
 * undelivered relief is still measured against it while it is no longer a
 * candidate (a charger parked at its floor); a device chosen again takes the new
 * rung, or none for a binary off.
 */
export function latchShedDecision(
  chosen: ShedSelection,
  carried: PendingShedRelief | null,
  powerW: number,
  nowTs: number,
): ShedPlanLatch {
  const rebased = carried?.rebased ?? new Map<string, readonly RebasedDecision[]>();
  const decisions = new Map([...rebased].map(([deviceId, standing]) => [
    deviceId, standing.map(({ decidedAtMs, creditedKw }) => ({ decidedAtMs, creditedKw })),
  ] as const));
  const stepTargets = new Map<string, string>(carried?.retained.stepTargets ?? []);
  // A battery chosen is latched like a shed device: its stopped charge is what it banked.
  const chosenIds = [...chosen.shedSet, ...chosen.storageSetpoints.keys()];
  for (const deviceId of chosenIds) {
    const standing = decisions.get(deviceId) ?? [];
    const newest = standing[standing.length - 1];
    const newKw = chosen.creditedKw.get(deviceId) ?? 0;
    const stillUndelivered = (carried?.undeliveredKwByDevice.get(deviceId) ?? 0) > PENDING_RELIEF_EPSILON_KW;
    const offDevice = (rebased.get(deviceId) ?? [])
      .map(({ decidedAtMs, unshownDeliveredKw }) => ({ decidedAtMs, creditedKw: unshownDeliveredKw }))
      .filter((decision) => decision.creditedKw > PENDING_RELIEF_EPSILON_KW);
    decisions.set(deviceId, newest !== undefined && stillUndelivered
      ? standing.slice(0, -1).concat([{ decidedAtMs: newest.decidedAtMs, creditedKw: newest.creditedKw + newKw }])
      : offDevice.concat([{ decidedAtMs: nowTs, creditedKw: newKw }]));
    const stepId = chosen.shedStepTargets.get(deviceId);
    if (stepId === undefined) stepTargets.delete(deviceId);
    else stepTargets.set(deviceId, stepId);
  }
  return { powerW, decisions, stepTargets };
}

function sumKw(values: readonly number[]): number {
  return values.reduce((total, kw) => total + kw, 0);
}
