import { phaseRoomFor, resolvePhaseRoomAxis, spendPhaseRoom, type PhaseRoomAxis } from '../phase/phaseRoom';
import { chargeWithinPhaseRoom } from './storagePhaseCharge';
import type { PhaseFootprint } from '../../../packages/planner-types/src/phaseFootprint';
/**
 * The home-battery stage that runs before shedding selection, every measured
 * cycle: it keeps, steps down or hands back the holds PELS already has, decides
 * the surplus claim, and tells shedding what a held battery's discharge still
 * owes (`StorageShedTerm`). Shedding selects any additional battery relief
 * (`lib/plan/shedding/storageCandidate.ts`), and the limit
 * step after selection (`storageLimit.ts`) turns the choice into a hold. A
 * limit hold is handed back by the restore lane, in priority order
 * (`lib/plan/restore/storageHandBack.ts`).
 *
 * Battery discharge never creates room for a resume. Admission withholds
 * existing discharge and charge increases not measured yet
 * (`withoutStorageWithheld`).
 *
 * The battery has no generic command authority (`isBatteryOrSolar`); the
 * storage stages alone decide a signed setpoint or a hand-back for it from its
 * storage cluster (`StoragePlanInputKind`), which the executor's storage lane
 * carries out (`lib/executor/batteryExecutor.ts`).
 *
 * **Limit hold.** Held where shedding put it: a capped charge stays capped. A
 * held discharge steps down within physical room, but only past the deadband
 * (`max(step, 200 W)`), no sooner than `STORAGE_DECREASE_MIN_INTERVAL_MS` after
 * the last step down, and never while an increase is still settling; once the
 * observed discharge fits entirely in that room it can step to 0 W. The
 * charge stays stopped until the restore lane hands the battery back.
 *
 * **Power-limit control off.** PELS never takes the battery over at all
 * (owner ruling, 2026-10-06): no charge cap, no discharge and no surplus
 * claim. Any hold it has is handed back at once (`limit_off`), and the
 * battery is no surplus claimant: its charge is household load, while its
 * discharge still stays out of the surplus pool through the home's separate
 * observed-discharge input.
 *
 * **Routine policy.** The ranked surplus allocator offers each battery
 * the solar left at its priority. A battery without a current economic
 * period charges within that offer and the measured room. Without a usable
 * charge it remains under PELS control at 0 W. Stored energy is excluded
 * from the surplus pool independently of the battery's control roster.
 *
 * **Credit.** A discharge increase is a commitment the meter cannot show yet.
 * For `STORAGE_RELIEF_SETTLE_WINDOW_MS` after it was decided, the part the
 * battery's OWN discharge has not delivered yet is credited to shedding as its
 * own term (`StorageShedTerm`): the measurement is never rewritten. A charge
 * the limit stopped is not credited here: the battery's own reading shows it
 * falling, so pending relief credits it (`lib/plan/shedding/pendingRelief.ts`),
 * and no watt is counted by both. Nothing is credited for a battery that is not
 * responding, re-probing, sign-inverted, being released or unreadable, so
 * shedding then behaves exactly as without a battery.
 *
 * **Release.** Any held battery is handed back when it is no longer admissible
 * (Managed off, its claim lost), when its Power-limit control is off, when it
 * is not responding or its sign is inverted, after `STORAGE_INPUT_MISSING_RELEASE_MS` without a reading, and on
 * meter silence (`releaseStorageOnSilentMeter`). The cycle that releases a
 * discharging battery counts that discharge as deficit only when hand-back
 * can be attempted, so shedding is ready before the import lands. A deferred
 * hand-back still withholds discharge from restore without adding a deficit.
 * In capacity simulation a held battery is read as if it followed its last
 * setpoint (`simulateFollowedHolds`); its owner refuses every claim, and hands a held one back.
 */
import type { StorageDischargeObservation } from '../../../packages/planner-types/src/storageDischarge';
import type { MissingStorageInput, ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import {
  type StorageDecision, type StoragePlanKind, type StorageReleaseReason, type StorageReleaseIntent,
} from '../../planContract/storageDecision';
import { floorStorageSetpointW } from '../../utils/storageSetpoint';
import { getLogger } from '../../logging/logger';
import {
  minLimitHeadroom, spendLimitHeadroom, type LimitHeadroom, type MeasuredPower,
} from '../planContext';
import { compareDeviceIdAsc } from '../planSort';
import type { StorageLeverState } from '../planState';
import type {
  StorageSurplusClaimant,
  StorageSurplusOffer,
} from '../planSurplusAbsorb';
import type { DevicePlanDevice, PlanInputDevice, StorageHold } from '../planTypes';
import { NO_STORAGE_SHED_TERM } from '../shedding/types';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS,
  deadbandWFor,
  drawMarginWFor,
  hasStorageInput,
  hasStorageLeverInput,
  ownChargeWOf,
  ownDischargeWOf,
  physicalDischargePreference,
  resolveStorageHoldBlock,
  supportedDischargeCeilingW, toSetpointW,
} from './storageLadder';

import type {
  StorageBalance, StorageRelief, StorageStateSummary,
} from './storageReliefTypes';
import {
  resolveClaimReason, summarizeHold, toSetpointDecision,
} from './storageHold';
import {
  baselineLever, baselineSolarChargeW, continuousLever, deferGridChargeIncrease, resolveEconomicResumeIncreaseW,
} from './storageContinuous';
export type { StorageRelief, StorageStateSummary } from './storageReliefTypes';
export { summarizeHold } from './storageHold';

const logger = getLogger('plan/battery');

/** The least time between two step-downs of a setpoint. */
export const STORAGE_DECREASE_MIN_INTERVAL_MS = 60 * 1000;
/** How long a held battery may go unread before it is handed back. */
export const STORAGE_INPUT_MISSING_RELEASE_MS = 2 * 60 * 1000;

/**
 * No battery decided, held or credited: the base of the silent-meter hand-back.
 */
export const NO_STORAGE_RELIEF: StorageRelief = Object.freeze({
  shed: NO_STORAGE_SHED_TERM,
  levers: Object.freeze({}),
  batteries: [],
  surplusOffers: new Map<string, StorageSurplusOffer>(),
});

/**
 * A held battery this cycle has no reading for, as the plan carries it: not
 * planned at all (`absent`), planned without a storage cluster (`no_input`), or
 * planned with a cluster that reads `missing`.
 */
type UnreadCarrier = 'absent' | 'no_input' | MissingStorageInput;

/** What the plan does with an observed battery this cycle. */
type ObservedStep = { kind: 'release'; reason: StorageReleaseReason } | { kind: 'hold'; lever: StorageLeverState };

/** Whether the battery takes charge at all: a full one has a charge ceiling of about 0 W. */

export const isStorageReliefCreditable = (storage: ObservedStorageInput): boolean => (
  storage.verdict === 'unverified' || storage.verdict === 'responding'
);

/** Whether a discharge increase this hold decided is still inside its credit's settle window. */
export const isSettling = (lever: StorageLeverState, nowTs: number): boolean => (
  nowTs - lever.increaseDecidedAtMs < STORAGE_RELIEF_SETTLE_WINDOW_MS
);

/**
 * A held battery's charge PELS can free, W: its observed charge, up to what
 * PELS asked (past that it is not following).
 */
const heldChargeAddBackW = (storage: ObservedStorageInput, lever: StorageLeverState): number => (
  Math.min(ownChargeWOf(storage), Math.max(0, lever.setpointW))
);

/**
 * The solar a battery in its own mode stores that PELS could free, W: its
 * charge less any import (a battery charging from the grid, as in cheap night
 * hours, stores no surplus).
 */
const ownModeChargeAddBackW = (storage: ObservedStorageInput, signedNetW: number): number => (
  Math.max(0, ownChargeWOf(storage) - Math.max(0, signedNetW))
);

/**
 * The charge of this battery the surplus pool counts as surplus, W: held or in
 * its own mode. The consumers ranked above it may claim it, and it reserves it
 * at its own turn. The allocator hands it back on the battery's offer
 * (`StorageSurplusOffer.addedBackW`), so the pool and this stage read one
 * number.
 */
const storageChargeAddBackW = (
  storage: ObservedStorageInput,
  lever: StorageLeverState | undefined,
  signedNetW: number,
): number => (
  lever === undefined ? ownModeChargeAddBackW(storage, signedNetW) : heldChargeAddBackW(storage, lever)
);

/**
 * Claimable batteries in priority order, with the solar charge PELS can free.
 * A battery reserves its ranked solar allocation or current planned charge,
 * so consumers below it see only what it leaves. An unholdable battery has no
 * claimant: its charge remains household load. The builder receives discharge
 * separately from whole-home observations, including batteries outside this
 * planned roster, so Managed off never turns stored energy into solar surplus.
 */
export function resolveStorageSurplusClaimants(
  devices: readonly PlanInputDevice[],
  levers: Readonly<Record<string, StorageLeverState>>,
  signedNetW: number,
  nowTs: number,
): StorageSurplusClaimant[] {
  const observed = devices.flatMap((device) => (
    hasStorageInput(device) && device.storage.reading === 'observed' ? [{ device, storage: device.storage }] : []
  ));

  return observed
    .filter(({ storage }) => resolveStorageHoldBlock(storage) === 'holdable' && !storage.handBackDeferred)
    .map(({ device, storage }): StorageSurplusClaimant => {
      const lever = levers[device.id];
      const chargeW = storageChargeAddBackW(storage, lever, signedNetW);
      const economic = storage.continuousPlan !== undefined && storage.continuousPlan.validUntilMs > nowTs;
      return {
        deviceId: device.id,
        priority: device.priority,
        chargeW,
        reservedW: Math.max(chargeW, lever?.setpointW ?? 0),
        ...(!economic && lever?.purpose !== 'limit' ? {
          baseline: { storage, previous: lever, footprint: device.phaseFootprint },
        } : {}),
      };
    });
}

/** Stored energy never becomes solar surplus, including an unread held discharge. */
export function resolveStorageDischargeW(
  observations: ReadonlyMap<string, StorageDischargeObservation>,
  levers: Readonly<Record<string, StorageLeverState>>,
): number {
  let dischargeW = 0;
  for (const [deviceId, observation] of observations) {
    const heldW = observation.heldDischarge === 'reserved' ? -(levers[deviceId]?.setpointW ?? 0) : 0;
    dischargeW += Math.max(observation.dischargeW, heldW);
  }
  // A missing reading does not prove that a held discharge (including a sale)
  // stopped. Reserve it until observed again or its hold is released.
  for (const [deviceId, lever] of Object.entries(levers)) {
    if (!observations.has(deviceId)) dischargeW += Math.max(0, -lever.setpointW);
  }
  return dischargeW;
}

/**
 * Step a held discharge down, when pacing allows: to 0 W once the discharge
 * the house needs is under the deadband, else past the deadband, leaving the
 * deadband as headroom.
 */
const resolveLoweredDischargeW = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  room: LimitHeadroom,
  nowTs: number,
): number => {
  const heldW = -lever.setpointW;
  if (isSettling(lever, nowTs) || nowTs - lever.lastDecreaseAtMs < STORAGE_DECREASE_MIN_INTERVAL_MS) return heldW;
  if (room.kind === 'off') return 0;
  const headroomW = room.kw * 1000;
  const deadbandW = deadbandWFor(storage);
  const observedW = ownDischargeWOf(storage);
  if (headroomW <= 0) return heldW;
  if (!storage.canSetDischargePower) return observedW <= headroomW ? 0 : heldW;
  if (observedW <= headroomW && heldW - headroomW < deadbandW) return 0;
  if (headroomW <= deadbandW) return heldW;
  const targetW = Math.min(heldW, Math.max(0, observedW - headroomW + deadbandW));
  const roundedW = -floorStorageSetpointW(-targetW, storage.range);
  // A step across the exclude band can jump all the way to idle.
  return observedW - roundedW <= headroomW ? roundedW : heldW;
};

/** The hold as this cycle's reading of the battery leaves it. */
const readLever = (storage: ObservedStorageInput, lever: StorageLeverState): StorageLeverState => ({
  ...lever,
  stepW: storage.range.stepW,
  reading: { kind: 'read' },
});

/**
 * A limit hold, kept where shedding put it: a capped charge stays capped, and a
 * held discharge steps down on headroom (`resolveLoweredDischargeW`), within
 * the battery's delivery ceiling, until only the stopped charge is left.
 * The restore lane then returns the battery to its managed policy.
 */
const keepLimitLever = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  room: LimitHeadroom,
  nowTs: number,
): ObservedStep => {
  const reading = readLever(storage, lever);
  const heldDischargeW = -lever.setpointW;
  // Keep the export limit until the restore lane checks both directions.
  if (lever.exportPhase !== undefined) {
    const setpointW = toSetpointW(Math.min(heldDischargeW, supportedDischargeCeilingW(storage)));
    return { kind: 'hold', lever: {
      ...reading,
      setpointW,
      economicResumeIncreaseW: resolveEconomicResumeIncreaseW(storage, setpointW, nowTs),
    } };
  }
  if (heldDischargeW <= 0) return { kind: 'hold', lever: reading };
  const keptW = resolveLoweredDischargeW(storage, lever, room, nowTs);
  const dischargeW = Math.min(keptW, supportedDischargeCeilingW(storage));
  return {
    kind: 'hold',
    lever: {
      ...reading,
      setpointW: toSetpointW(dischargeW),
      lastDecreaseAtMs: dischargeW < heldDischargeW ? nowTs : lever.lastDecreaseAtMs,
    },
  };
};

/**
 * The discharge this battery was asked for and has not delivered yet, W,
 * while its increase settles. Measured against its own discharge only: a
 * charge it has not stopped yet is pending relief's credit, never this one.
 * A selling hold earns none.
 */
export const resolveCreditW = (storage: ObservedStorageInput, lever: StorageLeverState, nowTs: number): number => {
  if (!storage.canSetDischargePower || !isStorageReliefCreditable(storage) || !isSettling(lever, nowTs)) return 0;
  // A sale is no relief PELS may bank before it lands: its export creates no
  // speculative credit for shedding to spend.
  if (lever.continuousReason === 'export_energy') return 0;
  return Math.max(0, -lever.setpointW - Math.max(ownDischargeWOf(storage), lever.creditBaseW));
};

const NO_DECISION = {
  claim: 'none', decision: { kind: 'none' }, setpointW: 0, heldBackChargeW: 0, creditW: 0, withheldW: 0,
} as const;

function pendingWithdrawalKw(storage: ObservedStorageInput, setpointW: number): number {
  if (setpointW < 0 && !storage.canSetDischargePower) return 0;
  return Math.max(0, ownDischargeWOf(storage) - Math.max(0, -setpointW)) / 1000;
}

const pendingLimitWithdrawalKw = (storage: ObservedStorageInput, lever: StorageLeverState | undefined): number => (
  lever?.purpose === 'limit' ? pendingWithdrawalKw(storage, lever.setpointW) : 0
);

/** One cycle's decisions, accumulated battery by battery, and the relief they add up to. */
class StorageReliefCycle {
  readonly levers: Record<string, StorageLeverState> = {};
  readonly batteries: StorageStateSummary[] = [];
  private creditW = 0;
  private releasedDischargeW = 0;
  private drawMarginW = 0;
  private relieving = false;

  constructor(
    public balance: StorageBalance,
    /** What the allocator offered each battery at its place in the priority order. */
    private readonly offers: ReadonlyMap<string, StorageSurplusOffer>,
    private readonly nowTs: number,
    /** In simulation, last: what held batteries would deliver (or, charging, draw) that the reading misses. */
    private phaseRoom: PhaseRoomAxis, private readonly simulatedUndeliveredW: number,
    private physicalRoom: LimitHeadroom, private readonly hadDischarge: boolean,
  ) {}

  private release(
    reason: StorageReleaseReason,
    dischargeW: number,
    deferred: boolean,
    footprint: PhaseFootprint,
    reservedKw: number,
  ): { decision: StorageDecision; withheldW: number } {
    if (!deferred) {
      this.releasedDischargeW += dischargeW;
      this.reserveWithdrawal(footprint, dischargeW / 1000 - reservedKw);
    }
    return { decision: { kind: 'release', reason }, withheldW: dischargeW };
  }

  /** Reserve a return of import before another battery can spend it. */
  reserveWithdrawal(footprint: PhaseFootprint, importKw: number): void {
    if (importKw <= 0) return;
    this.physicalRoom = spendLimitHeadroom(this.physicalRoom, importKw);
    this.phaseRoom = spendPhaseRoom(this.phaseRoom, footprint, importKw);
  }

  decideObserved(
    deviceId: string,
    storage: ObservedStorageInput,
    previous: StorageLeverState | undefined,
    footprint: PhaseFootprint,
  ): StorageStateSummary {
    const observedDischargeW = ownDischargeWOf(storage);
    if (storage.handBackDeferred && resolveStorageHoldBlock(storage) === 'holdable') {
      if (previous !== undefined) this.levers[deviceId] = previous;
      if (previous !== undefined && previous.setpointW < 0 && observedDischargeW > 0) {
        this.relieving = true;
      }
      return {
        deviceId, reading: 'observed', claimHeld: storage.claimHeld, powerLimitOff: false,
        ...NO_DECISION, withheldW: observedDischargeW,
      };
    }
    const step = this.resolveObservedStep(deviceId, storage, previous, footprint);
    const reservedKw = pendingLimitWithdrawalKw(storage, previous);
    if (step.kind === 'release') {
      const summary = {
        deviceId, reading: 'observed' as const, claimHeld: storage.claimHeld, powerLimitOff: !storage.powerLimitControl,
      };
      if (previous === undefined && !storage.claimHeld) return { ...summary, ...NO_DECISION };
      const deferred = !storage.claimHeld || storage.handBackDeferred;
      // The observed discharge may stop as soon as native control resumes.
      const { decision, withheldW } = this.release(step.reason, observedDischargeW, deferred, footprint, reservedKw);
      return { ...summary, ...NO_DECISION, decision, withheldW };
    }
    const next = this.boundObservedHold(storage, footprint, step.lever);
    const withdrawalKw = pendingWithdrawalKw(storage, next.setpointW);
    this.reserveWithdrawal(footprint, withdrawalKw - reservedKw);
    // The charge bound already debited the positive charging share on its phases.
    const newChargeKw = Math.max(0, next.setpointW - ownChargeWOf(storage)) / 1000;
    this.physicalRoom = spendLimitHeadroom(this.physicalRoom, newChargeKw);
    return this.recordObservedHold(deviceId, storage, next, withdrawalKw);
  }

  private boundObservedHold(
    storage: ObservedStorageInput,
    footprint: PhaseFootprint,
    lever: StorageLeverState,
  ): StorageLeverState {
    const plannedW = lever.setpointW;
    const candidateW = lever.baseline === true && this.balance.headroomW !== null && plannedW > 0
      ? Math.min(plannedW, Math.max(0, storage.signedPowerW + this.balance.headroomW - drawMarginWFor(storage)))
      : plannedW;
    const ceilingW = candidateW < 0 ? storage.deliveryCeilingW : storage.chargeCeilingW;
    const ceiledW = Math.sign(candidateW) * Math.min(Math.abs(candidateW), ceilingW);
    const cappedW = floorStorageSetpointW(ceiledW, storage.range);
    const withinPhases = chargeWithinPhaseRoom(this.phaseRoom, storage, footprint, cappedW);
    this.phaseRoom = withinPhases.axis;
    return { ...lever, setpointW: withinPhases.setpointW };
  }

  private recordObservedHold(
    deviceId: string,
    storage: ObservedStorageInput,
    next: StorageLeverState,
    withdrawalKw: number,
  ): StorageStateSummary {
    this.levers[deviceId] = next;
    const nextDischargeW = -next.setpointW;
    const headroomDebitW = Math.max(0, next.setpointW - storage.signedPowerW);
    const creditW = resolveCreditW(storage, next, this.nowTs);
    this.balance = {
      ...this.balance,
      netImportW: this.balance.netImportW + next.setpointW - storage.signedPowerW,
      headroomW: this.balance.headroomW === null
        ? null
        : Math.max(0, this.balance.headroomW - headroomDebitW),
    };
    if (next.purpose === 'continuous') this.releasedDischargeW += withdrawalKw * 1000;
    this.creditW += creditW;
    if (nextDischargeW > 0 && (storage.canSetDischargePower || storage.signedPowerW < 0)) {
      this.relieving = true;
      this.drawMarginW = Math.max(this.drawMarginW, drawMarginWFor(storage));
    }
    return summarizeHold(deviceId, storage, next, creditW);
  }

  /**
   * A held battery with no reading this cycle: the last hold is kept,
   * uncredited, until it has gone unread for `STORAGE_INPUT_MISSING_RELEASE_MS`
   * or is no longer admissible, then released. Its discharge is counted as
   * handed back on the release cycle: whether it is still delivering is
   * unknown, and an unknown resolves toward shedding. An absent battery's
   * release travels on the plan itself. A planned device without a storage
   * cluster cannot say whether it is admissible: its hold is kept for the
   * window, then released. A sale is not kept even that long: unread, its
   * export is bounded by nothing PELS measures, so it steps to 0 W at once
   * (`keepUnreadLever`).
   */
  decideUnread(
    deviceId: string,
    carrier: UnreadCarrier,
    previous: StorageLeverState | undefined,
    footprint: PhaseFootprint,
  ): StorageStateSummary {
    const summary = { deviceId, reading: toUnreadReading(carrier), claimHeld: true, powerLimitOff: false };
    if (previous === undefined) return { ...summary, ...NO_DECISION };
    const heldDischargeW = Math.max(0, -previous.setpointW);
    const sinceMs = previous.reading.kind === 'unread' ? previous.reading.sinceMs : this.nowTs;
    const expired = this.nowTs - sinceMs >= STORAGE_INPUT_MISSING_RELEASE_MS;
    const admissible = carrier === 'absent' || carrier === 'no_input' || carrier.admissible;
    if (!admissible || expired) {
      const reason = carrier === 'absent' || !admissible ? 'not_admissible' : 'input_missing';
      const deferred = typeof carrier === 'object' && carrier.handBackDeferred;
      const { decision, withheldW } = this.release(reason, heldDischargeW, deferred, footprint, 0);
      return { ...summary, ...NO_DECISION, decision, withheldW };
    }
    const event = { deviceId, heldSetpointW: previous.setpointW };
    if (previous.reading.kind === 'read') logger.warn({ event: 'storage_relief_input_missing', ...event });
    const lever = keepUnreadLever(previous, sinceMs);
    if (lever.setpointW !== previous.setpointW) {
      if (carrier !== 'absent') this.reserveWithdrawal(footprint, heldDischargeW / 1000);
      logger.warn({ event: 'storage_relief_unread_sale_stopped', ...event });
    }
    this.levers[deviceId] = lever;
    return {
      ...summary,
      claim: resolveClaimReason(lever),
      // No plan device carries a decision for an absent battery: the hold alone is kept.
      decision: carrier === 'absent' ? { kind: 'none' } : toSetpointDecision(lever),
      setpointW: lever.setpointW,
      heldBackChargeW: 0,
      creditW: 0,
      withheldW: heldDischargeW,
    };
  }

  /**
   * What the allocator offered a battery this stage may hold. The allocator
   * ranks every such battery (`resolveStorageSurplusClaimants`), so a missing offer is
   * a broken producer, never a battery to decide on nothing.
   */
  private offerFor(deviceId: string): StorageSurplusOffer {
    const offer = this.offers.get(deviceId);
    if (offer === undefined) throw new Error(`No surplus offer for holdable battery ${deviceId}`);
    return offer;
  }

  record(summary: StorageStateSummary): void {
    this.batteries.push(summary);
  }

  toRelief(): StorageRelief {
    return {
      shed: {
        netCreditKw: (this.creditW + this.simulatedUndeliveredW - this.releasedDischargeW) / 1000,
        relieving: this.relieving,
        drawMarginKw: this.drawMarginW / 1000,
      },
      levers: this.levers,
      batteries: this.batteries,
      surplusOffers: this.offers,
    };
  }

  /**
   * A holdable battery keeps its limit, follows a live economic period or
   * uses the routine solar/idle policy. Only an ownership block releases it.
   */
  private resolveObservedStep(
    deviceId: string,
    storage: ObservedStorageInput,
    previous: StorageLeverState | undefined,
    footprint: PhaseFootprint,
  ): ObservedStep {
    const blocked = resolveStorageHoldBlock(storage);
    if (blocked !== 'holdable') return { kind: 'release', reason: blocked };
    const offer = this.offerFor(deviceId);
    if (previous?.purpose === 'limit') {
      const room = minLimitHeadroom(this.physicalRoom, phaseRoomFor(this.phaseRoom, footprint));
      return keepLimitLever(storage, previous, room, this.nowTs);
    }
    if (storage.continuousPlan !== undefined && storage.continuousPlan.validUntilMs > this.nowTs) {
      const lever = continuousLever(storage, previous, this.balance, offer, this.nowTs);
      return { kind: 'hold', lever: this.hadDischarge ? deferGridChargeIncrease(storage, lever, offer) : lever };
    }
    const setpointW = offer.baselineChargeW
      ?? baselineSolarChargeW(storage, previous, offer, this.balance.headroomW, this.nowTs);
    return { kind: 'hold', lever: baselineLever(storage, previous, setpointW, this.nowTs) };
  }
}

/**
 * The hold an unread battery keeps. A selling hold's discharge was bounded
 * only by the house's measured draw plus the export ceiling; with no battery
 * reading that bound is gone, so it steps to 0 W and waits rather than resend
 * a sale for the whole missing-input window. Every other hold is kept as it was.
 */
const keepUnreadLever = (previous: StorageLeverState, sinceMs: number): StorageLeverState => {
  const reading = { kind: 'unread' as const, sinceMs };
  if (previous.purpose !== 'continuous' || previous.continuousReason !== 'export_energy') {
    return { ...previous, reading };
  }
  return { ...previous, setpointW: 0, continuousReason: 'hold_energy', reading };
};

/** How the state log names a battery this cycle could not read. */
const toUnreadReading = (carrier: UnreadCarrier): 'missing' | 'absent' => (carrier === 'absent' ? 'absent' : 'missing');

/** The batteries' withheld power, kW. */
export const sumWithheldKw = (batteries: readonly StorageStateSummary[]): number => (
  batteries.reduce((totalW, battery) => totalW + battery.withheldW, 0) / 1000
);

/** Decide releases and routine operation first, then ease hard discharge in reverse dispatch order. */
export function decideStorageRelief(
  devices: readonly PlanInputDevice[],
  power: MeasuredPower,
  levers: Readonly<Record<string, StorageLeverState>>,
  offers: ReadonlyMap<string, StorageSurplusOffer>,
  nowTs: number,
  /** In simulation, what held batteries deliver that the reading misses (`simulateFollowedHolds`), W. */
  simulatedUndeliveredW: number,
  physicalRoom: LimitHeadroom,
): StorageRelief {
  const cycle = new StorageReliefCycle({
    headroomW: power.headroom.kind === 'off' ? null : Math.max(0, power.headroom.kw * 1000 + simulatedUndeliveredW),
    netImportW: power.drawKw * 1000 - simulatedUndeliveredW,
    sampledAtMs: power.sampledAtMs,
  }, offers, nowTs, resolvePhaseRoomAxis(power.phase), simulatedUndeliveredW, physicalRoom,
  Object.values(levers).some(({ setpointW }) => setpointW < 0));
  const batteries = devices.filter(hasStorageLeverInput);
  for (const device of batteries) {
    if (device.storage.reading !== 'observed') continue;
    cycle.reserveWithdrawal(device.phaseFootprint, pendingLimitWithdrawalKw(device.storage, levers[device.id]));
  }
  const recovering = batteries
    .filter(({ id, storage }) => levers[id]?.purpose === 'limit' && levers[id].setpointW < 0
      && storage.reading === 'observed' && resolveStorageHoldBlock(storage) === 'holdable')
    .sort((left, right) => {
      const leftRank = left.storage.reading === 'observed'
        ? physicalDischargePreference(left.storage, levers[left.id]) : 0;
      const rightRank = right.storage.reading === 'observed'
        ? physicalDischargePreference(right.storage, levers[right.id]) : 0;
      return leftRank - rightRank || compareDeviceIdAsc(right, left);
    });
  const recoveringIds = new Set(recovering.map(({ id }) => id));
  const orderedBatteries = batteries.filter(({ id }) => !recoveringIds.has(id)).concat(recovering);
  const seen = new Set(batteries.map(({ id }) => id));
  for (const [deviceId, previous] of Object.entries(levers)) {
    if (seen.has(deviceId)) continue;
    const device = devices.find(({ id }) => id === deviceId);
    const carrier = device === undefined ? 'absent' : 'no_input';
    cycle.record(cycle.decideUnread(deviceId, carrier, previous, device?.phaseFootprint ?? { kind: 'unknown' }));
  }
  for (const device of orderedBatteries) {
    const { storage } = device;
    const previous = levers[device.id];
    cycle.record(storage.reading === 'observed'
      ? cycle.decideObserved(device.id, storage, previous, device.phaseFootprint)
      : cycle.decideUnread(device.id, storage, previous, device.phaseFootprint));
  }
  return cycle.toRelief();
}

/** A battery on a silent meter: handed back when PELS holds or drives it, else nothing decided. */
const toSilentMeterSummary = (
  deviceId: string,
  reading: StorageStateSummary['reading'],
  claimHeld: boolean,
  powerLimitOff: boolean,
  handedBack: boolean,
): StorageStateSummary => ({
  deviceId,
  reading,
  claimHeld,
  powerLimitOff,
  ...NO_DECISION,
  ...(handedBack ? { decision: { kind: 'release', reason: 'meter_silent' } as const } : {}),
});

/**
 * Meter silence: hand back every battery PELS holds or drives. Without a
 * measurement there is no deficit to relieve, and the fail-closed pass sheds
 * every load to its floor exactly as it does without a battery. Every battery
 * is summarized, as on a measured cycle, so the overview names each one.
 */
export function releaseStorageOnSilentMeter(
  devices: readonly PlanInputDevice[],
  levers: Readonly<Record<string, StorageLeverState>>,
): StorageRelief {
  const planned = devices.flatMap((device): StorageStateSummary[] => {
    if (!hasStorageLeverInput(device)) {
      return levers[device.id] === undefined ? [] : [toSilentMeterSummary(device.id, 'missing', true, false, true)];
    }
    const { storage } = device;
    const handedBack = levers[device.id] !== undefined || storage.claimHeld;
    const powerLimitOff = storage.reading === 'observed' && !storage.powerLimitControl;
    return [toSilentMeterSummary(device.id, storage.reading, storage.claimHeld, powerLimitOff, handedBack)];
  });
  const absent = Object.keys(levers)
    .filter((deviceId) => !devices.some((device) => device.id === deviceId))
    .map((deviceId) => toSilentMeterSummary(deviceId, 'absent', true, false, true));
  return { ...NO_STORAGE_RELIEF, batteries: [...planned, ...absent] };
}

/** Carry each battery's decision and hold onto its plan device. */
export function attachStorageDecisions(
  planDevices: DevicePlanDevice[],
  relief: StorageRelief,
): DevicePlanDevice[] {
  if (relief.batteries.length === 0) return planDevices;
  const byId = new Map(relief.batteries.map((battery) => [battery.deviceId, battery] as const));
  return planDevices.map((device) => {
    const battery = byId.get(device.id);
    if (battery === undefined) return device;
    const held = { ...device, storageHold: toStorageHold(battery) };
    if (battery.decision.kind === 'none') return held;
    const decided: DevicePlanDevice & StoragePlanKind = { ...held, storageDecision: battery.decision };
    return decided;
  });
}

/** Why PELS holds a battery after this cycle, or why it does not take one over, as the overview names it. */
const toStorageHold = (battery: StorageStateSummary): StorageHold => {
  switch (battery.claim) {
    case 'none': return battery.powerLimitOff ? { kind: 'power_limit_off' } : { kind: 'none' };
    case 'charge_limit': return {
      kind: 'charge_limit',
      heldBackKw: battery.heldBackChargeW / 1000,
      ...(battery.exportPhase === undefined ? {} : { exportPhase: battery.exportPhase }),
    };
    case 'relief': return {
      kind: 'relief', supplyKw: Math.max(0, -battery.setpointW) / 1000,
      ...(battery.exportPhase === undefined ? {} : { exportPhase: battery.exportPhase }),
    };
    default: return { kind: battery.claim };
  }
};

/** Preserve releases whose battery left the home's plan. */
export function collectAbsentStorageReleases(
  planDevices: readonly DevicePlanDevice[],
  relief: StorageRelief,
): StorageReleaseIntent[] {
  const present = new Set(planDevices.map((device) => device.id));
  return relief.batteries.flatMap(({ deviceId, decision }) => (
    decision.kind === 'release' && !present.has(deviceId) ? [{ deviceId, reason: decision.reason }] : []
  ));
}
