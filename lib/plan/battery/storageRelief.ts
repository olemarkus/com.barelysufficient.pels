/**
 * The home-battery stage that runs before shedding selection, every measured
 * cycle: it keeps, steps down or hands back the holds PELS already has, decides
 * the surplus claim, and tells shedding what a held battery's discharge still
 * owes (`StorageShedTerm`). It never limits a battery for a deficit: that is
 * shedding's choice, at the battery's own place in the priority order (owner
 * ruling, 2026-10-06; `lib/plan/shedding/storageCandidate.ts`), and the limit
 * step after selection (`storageLimit.ts`) turns the choice into a hold. A
 * limit hold is handed back by the restore lane, in priority order
 * (`lib/plan/restore/storageHandBack.ts`).
 *
 * The battery protects the devices ranked above it. Its discharge never
 * creates headroom for restoring more: restore and admission see the headroom
 * less the discharge PELS holds, and less a charge increase not measured yet
 * (`withoutStorageWithheld`). Every uncertainty resolves toward shedding and
 * toward handing the battery back.
 *
 * The battery has no generic command authority (`isBatteryOrSolar`); the
 * storage stages alone decide a signed setpoint or a hand-back for it from its
 * storage cluster (`StoragePlanInputKind`), which the executor's storage lane
 * carries out (`lib/executor/batteryExecutor.ts`).
 *
 * **Limit hold.** Held where shedding put it: a capped charge stays capped. A
 * held discharge steps down on headroom, but only past the deadband
 * (`max(step, 200 W)`), no sooner than `STORAGE_DECREASE_MIN_INTERVAL_MS` after
 * the last step down, and never while an increase is still settling; once the
 * discharge needed falls below the deadband it steps to 0 W, the charge still
 * stopped, until the restore lane hands the battery back. Power-limit control
 * turned off hands it back at once (`limit_off`).
 *
 * **Surplus.** Surplus goes to the willing devices first, then the battery,
 * then export (owner ruling, 2026-10-05). A surplus claim exists only to give
 * a device power the battery's own mode would otherwise take; in every other
 * situation the battery runs its own mode, so its self-consumption, trading
 * and evening discharge keep working. The surplus pool counts the solar a
 * battery stores that PELS can free and never a battery's discharge
 * (`sumStorageSurplusW`). The allocator hands this stage what the devices left
 * for the battery (`SurplusLeftover`): the devices already running are in the
 * measurement, so only the smallest step of a device waiting to start is taken
 * out of it.
 *
 * - PELS claims a charging battery only while a device that is not running yet
 *   could be funded by its charge, and caps the charge to what the device
 *   leaves. It never claims a battery that is discharging, or one that stopped
 *   taking charge (a full battery, its charge ceiling about 0 W).
 * - A held charge follows the leftover, less half the deadband, within the
 *   charge ceiling and the headroom to the binding pace. A rise waits for a
 *   visible step and `SURPLUS_TRACK_STEP_MIN_INTERVAL_MS` after the last, like
 *   a tracking device's climb; a fall that eats the margin follows the leftover
 *   at once. On a deficit a charge raised past the own mode's drops to it at
 *   once (it would be grid charge), and a cap below it is kept where it is:
 *   shedding decides in priority order whether to limit the battery further.
 * - The claim is needed only while a device still wants surplus and the charge
 *   is held below what the battery's own mode charged when PELS took it (the
 *   cap doing its job). Without that for `STORAGE_SURPLUS_RELEASE_DWELL_MS` it
 *   is handed back (`surplus_dwell`), and at once if the battery stops taking
 *   charge (`full`).
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
 * (Managed off, its claim lost), when it is not responding or its sign is
 * inverted, after `STORAGE_INPUT_MISSING_RELEASE_MS` without a reading, and on
 * meter silence (`releaseStorageOnSilentMeter`). The cycle that releases a
 * discharging battery counts that discharge as deficit only when hand-back
 * can be attempted, so shedding is ready before the import lands. A deferred
 * hand-back still withholds discharge from restore without adding a deficit.
 * Capacity simulation writes nothing, so the planner decides nothing for a
 * battery then (`NO_STORAGE_RELIEF`); the battery's owner hands a held one
 * back itself.
 */
import type {
  MissingStorageInput,
  ObservedStorageInput,
} from '../../../packages/planner-types/src/planInputDevice';
import {
  type StorageDecision,
  type StoragePlanKind,
  type StorageReleaseReason,
  type StorageReleaseIntent,
} from '../../planContract/storageDecision';
import { floorStorageSetpointW } from '../../utils/storageSetpoint';
import { getLogger } from '../../logging/logger';
import { SURPLUS_TRACK_STEP_MIN_INTERVAL_MS } from '../admission';
import type { MeasuredPower } from '../planContext';
import type { StorageLeverState } from '../planState';
import type { SurplusDemand, SurplusLeftover } from '../planSurplusAbsorb';
import type { DevicePlanDevice, PlanInputDevice, StorageHold } from '../planTypes';
import { NO_STORAGE_SHED_TERM, type StorageShedTerm } from '../shedding/types';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS,
  deadbandWFor,
  drawMarginWFor,
  hasStorageInput,
  isRaiseVisible,
  ownChargeWOf,
  ownDischargeWOf,
  toSetpointW,
} from './storageLadder';

const logger = getLogger('plan/battery');

/** How long a battery held for surplus may go without a device needing the cap before it is handed back. */
export const STORAGE_SURPLUS_RELEASE_DWELL_MS = 2 * 60 * 1000;
/** The least time between two step-downs of a setpoint. */
export const STORAGE_DECREASE_MIN_INTERVAL_MS = 60 * 1000;
/** How long a held battery may go unread before it is handed back. */
export const STORAGE_INPUT_MISSING_RELEASE_MS = 2 * 60 * 1000;

/**
 * Why the plan holds a battery this cycle, for the state log and the
 * overview: `relief`, a limit hold discharging to hold the limit;
 * `charge_limit`, a limit hold capping its charge (0 W included);
 * `cap_for_device`, a surplus hold keeping its charge below what its own mode
 * charged so a device gets that power; `raise_charge`, a surplus hold charging
 * past that from a leftover; or `none` (not held).
 */
export type StorageClaimReason = 'none' | 'relief' | 'charge_limit' | 'cap_for_device' | 'raise_charge';

/** One battery as this cycle left it, for the state log. */
export type StorageStateSummary = {
  deviceId: string;
  reading: 'observed' | 'missing' | 'absent';
  claimHeld: boolean;
  /**
   * Its Power-limit control is off: PELS never limits it and uses it only to
   * store spare solar. False for a battery this cycle could not read.
   */
  solarOnly: boolean;
  claim: StorageClaimReason;
  decision: StorageDecision | { kind: 'none' };
  /** The signed power this cycle decided to hold, W: negative discharges, positive charges. */
  setpointW: number;
  /** Under a charge limit, the charge its own mode would take that the cap holds back, W; else 0. */
  heldBackChargeW: number;
  creditW: number;
  /** What restore and admission may not spend for this battery, W (`StorageRelief.withheldKw`). */
  withheldW: number;
};

/** What the stage decided this cycle. */
export type StorageRelief = {
  decisions: ReadonlyMap<string, StorageDecision>;
  /** What shedding counts against the measured deficit. */
  shed: StorageShedTerm;
  /**
   * Power restore and admission must not spend, kW: the discharge PELS holds
   * or is handing back (stored energy, not room), and a charge increase decided
   * this cycle that the measurement does not show yet.
   */
  withheldKw: number;
  /** The stage's holds after this cycle: the next `PlanEngineState.storageLeverByDevice`. */
  levers: Readonly<Record<string, StorageLeverState>>;
  batteries: readonly StorageStateSummary[];
};

/**
 * No battery decided, held or credited: capacity simulation (which writes
 * nothing, so the planner decides nothing for a battery), and the base of the
 * silent-meter hand-back.
 */
export const NO_STORAGE_RELIEF: StorageRelief = Object.freeze({
  decisions: new Map<string, StorageDecision>(),
  shed: NO_STORAGE_SHED_TERM,
  withheldKw: 0,
  levers: Object.freeze({}),
  batteries: [],
});

/**
 * A held battery this cycle has no reading for, as the plan carries it: not
 * planned at all (`absent`), planned without a storage cluster (`no_input`), or
 * planned with a cluster that reads `missing`.
 */
type UnreadCarrier = 'absent' | 'no_input' | MissingStorageInput;

/**
 * The headroom still to give back and the surplus still to store, W, as each
 * battery takes its share; and the deficit, which keeps a surplus hold where
 * it is for shedding to decide.
 */
type StorageBalance = { deficitW: number; headroomW: number; surplusW: number };

/** What the plan does with an observed battery this cycle. */
type ObservedStep = { kind: 'release'; reason: StorageReleaseReason } | { kind: 'hold'; lever: StorageLeverState };

/**
 * The charge its own mode takes once handed back, W
 * (`StorageLeverState.ownModeChargeW`): what it charged when PELS claimed it,
 * within its charge ceiling; nothing when it was discharging then (its own
 * mode was covering the house, and gets that back); or its charge ceiling when
 * it was doing neither. One sample of a battery idle or ramping at the claim
 * is no evidence its own mode will not charge hard once handed back, and a
 * hand-back sized on it would recreate the deficit every restore cooldown.
 */
export const resolveOwnModeChargeW = (storage: ObservedStorageInput, preClaimSignedW: number): number => {
  const deadbandW = deadbandWFor(storage);
  if (preClaimSignedW <= -deadbandW) return 0;
  return preClaimSignedW >= deadbandW ? Math.min(preClaimSignedW, storage.chargeCeilingW) : storage.chargeCeilingW;
};

/** Whether the battery takes charge at all: a full one has a charge ceiling of about 0 W. */
const takesCharge = (storage: ObservedStorageInput): boolean => storage.chargeCeilingW >= deadbandWFor(storage);

const isCreditable = (storage: ObservedStorageInput): boolean => (
  storage.verdict === 'unverified' || storage.verdict === 'responding'
);

/** Why the plan may not hold this battery at all, or `holdable`. */
const resolveBlockedReason = (storage: ObservedStorageInput): StorageReleaseReason | 'holdable' => {
  if (storage.verdict === 'not_responding' || storage.verdict === 'sign_inverted') return storage.verdict;
  if (!storage.admissible) return 'not_admissible';
  return 'holdable';
};

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
 * hours, stores no surplus), and nothing for a battery PELS may not claim.
 * Capacity simulation makes no battery claimable, so it frees nothing then.
 */
const ownModeChargeAddBackW = (storage: ObservedStorageInput, signedNetW: number): number => (
  resolveBlockedReason(storage) === 'holdable' ? Math.max(0, ownChargeWOf(storage) - Math.max(0, signedNetW)) : 0
);

/**
 * The charge of this battery the surplus pool counts as surplus a device may
 * still claim, W (owner ruling, 2026-10-05: devices first, then the battery):
 * held or in its own mode. The pool and this stage ask it with the same
 * measurement and holds, so the two always agree on what was counted.
 */
const storageChargeAddBackW = (
  storage: ObservedStorageInput,
  lever: StorageLeverState | undefined,
  signedNetW: number,
): number => (
  lever === undefined ? ownModeChargeAddBackW(storage, signedNetW) : heldChargeAddBackW(storage, lever)
);

/**
 * The batteries' term in the surplus pool, W: the charge PELS can free
 * (`storageChargeAddBackW`), less every battery's own discharge, which is
 * stored energy and never surplus (a battery exporting in the evening, or a
 * held discharge stepping down). Resolved by the builder and handed to the
 * allocator as a number.
 */
export function sumStorageSurplusW(
  devices: readonly PlanInputDevice[],
  levers: Readonly<Record<string, StorageLeverState>>,
  signedNetW: number,
): number {
  let totalW = 0;
  for (const device of devices) {
    if (!hasStorageInput(device) || device.storage.reading !== 'observed') continue;
    const { storage } = device;
    totalW += storageChargeAddBackW(storage, levers[device.id], signedNetW) - ownDischargeWOf(storage);
  }
  return totalW;
}

/**
 * Step a held discharge down, when pacing allows: to 0 W once the discharge
 * the house needs is under the deadband, else past the deadband, leaving the
 * deadband as headroom.
 */
const resolveLoweredDischargeW = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  nowTs: number,
): number => {
  const heldW = -lever.setpointW;
  if (isSettling(lever, nowTs) || nowTs - lever.lastDecreaseAtMs < STORAGE_DECREASE_MIN_INTERVAL_MS) return heldW;
  const deadbandW = deadbandWFor(storage);
  const baseW = Math.min(heldW, ownDischargeWOf(storage));
  if (baseW - balance.headroomW < deadbandW) return 0;
  if (balance.headroomW <= deadbandW) return heldW;
  return -floorStorageSetpointW(-Math.max(0, Math.min(heldW, baseW - (balance.headroomW - deadbandW))), storage.range);
};

/**
 * The charge the leftover funds on this battery, W: the leftover, less what
 * the pool already counted of its charge (`addedBackW`), plus its own charge,
 * less half the deadband; within its charge ceiling and the headroom to the
 * binding pace (its own charge is already in that measurement). Under the
 * deadband it is 0 W: too little to tell from noise.
 */
const resolveFundedChargeW = (storage: ObservedStorageInput, addedBackW: number, balance: StorageBalance): number => {
  const ownChargeW = ownChargeWOf(storage);
  const halfDeadbandW = deadbandWFor(storage) / 2;
  const fundedW = Math.min(
    storage.chargeCeilingW,
    balance.surplusW - addedBackW + ownChargeW - halfDeadbandW,
    ownChargeW + balance.headroomW - halfDeadbandW,
  );
  return fundedW < deadbandWFor(storage) ? 0 : floorStorageSetpointW(fundedW, storage.range);
};

/**
 * The charge to hold, W. A fall that eats the half deadband the funded charge
 * leaves follows it at once, so the battery never charges from the grid, or
 * from a device's share, for long. A rise must be a step the battery could
 * visibly answer, and waits `SURPLUS_TRACK_STEP_MIN_INTERVAL_MS` after the
 * last one, like a tracking device's climb (`paceCeilingClimb`).
 */
const resolvePacedChargeW = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  fundedW: number,
  nowTs: number,
): number => {
  const heldW = Math.max(0, lever.setpointW);
  if (fundedW < heldW - deadbandWFor(storage) / 2) return fundedW;
  if (!isRaiseVisible(storage, heldW, fundedW)) return heldW;
  return nowTs - lever.chargeRaisedAtMs < SURPLUS_TRACK_STEP_MIN_INTERVAL_MS ? heldW : fundedW;
};

/** A new surplus hold at this charge: it caps a charge, so it has no discharge to settle. */
const claimSurplusLever = (storage: ObservedStorageInput, setpointW: number, nowTs: number): StorageLeverState => ({
  setpointW,
  purpose: 'surplus',
  increaseDecidedAtMs: nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS,
  creditBaseW: 0,
  lastDecreaseAtMs: nowTs,
  chargeRaisedAtMs: nowTs,
  lastNeedAtMs: nowTs,
  preClaimSignedW: storage.signedPowerW,
  ownModeChargeW: resolveOwnModeChargeW(storage, storage.signedPowerW),
  stepW: storage.stepW,
  reading: { kind: 'read' },
});

/** Whether a surplus hold still does its job: a device wants surplus, and the charge is capped below the own mode's. */
const isCapNeeded = (lever: StorageLeverState, chargeW: number, deviceDemand: SurplusDemand): boolean => (
  deviceDemand !== 'none' && chargeW < Math.max(0, lever.preClaimSignedW)
);

/**
 * Start a surplus claim on a battery PELS does not hold: while a device that is
 * not running yet could be funded by the solar its own mode stores, cap that
 * charge to what the device leaves. A discharging battery, one that takes no
 * charge, or any battery while the house is short of its pace, is never
 * claimed for surplus. With nothing to do, the battery is left to its own mode
 * (`idle`).
 */
const startSurplusLever = (
  storage: ObservedStorageInput,
  balance: StorageBalance,
  deviceDemand: SurplusDemand,
  signedNetW: number,
  nowTs: number,
): ObservedStep => {
  const idle: ObservedStep = { kind: 'release', reason: 'idle' };
  if (balance.deficitW > 0 || deviceDemand !== 'waiting' || storage.signedPowerW < 0 || !takesCharge(storage)) {
    return idle;
  }
  const addedBackW = ownModeChargeAddBackW(storage, signedNetW);
  const chargeW = resolveFundedChargeW(storage, addedBackW, balance);
  // Only solar the pool offered: a battery charging from the grid is left alone.
  const caps = addedBackW > 0 && isRaiseVisible(storage, chargeW, ownChargeWOf(storage));
  return caps ? { kind: 'hold', lever: claimSurplusLever(storage, chargeW, nowTs) } : idle;
};

/** The hold as this cycle's reading of the battery leaves it. */
const readLever = (storage: ObservedStorageInput, lever: StorageLeverState): StorageLeverState => ({
  ...lever,
  ownModeChargeW: resolveOwnModeChargeW(storage, lever.preClaimSignedW),
  stepW: storage.stepW,
  reading: { kind: 'read' },
});

/**
 * A limit hold, kept where shedding put it: a capped charge stays capped, and a
 * held discharge steps down on headroom (`resolveLoweredDischargeW`), within
 * the battery's delivery ceiling, until only the stopped charge is left. Only
 * the restore lane hands it back, except a battery that was discharging in its
 * own mode when PELS claimed it: its discharge never steps below that own-mode
 * discharge, and once the hold would be no deeper than its own mode it is
 * handed back (`idle`) so its own mode covers the house again.
 */
const keepLimitLever = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  nowTs: number,
): ObservedStep => {
  const reading = readLever(storage, lever);
  const heldDischargeW = -lever.setpointW;
  if (heldDischargeW <= 0) return { kind: 'hold', lever: reading };
  const keptW = balance.deficitW > 0 ? heldDischargeW : resolveLoweredDischargeW(storage, lever, balance, nowTs);
  const dischargeW = Math.min(keptW, storage.deliveryCeilingW);
  const ownModeDischargeW = Math.max(0, -lever.preClaimSignedW);
  if (ownModeDischargeW >= deadbandWFor(storage) && dischargeW <= ownModeDischargeW) {
    return { kind: 'release', reason: 'idle' };
  }
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
 * The next surplus hold. On a deficit PELS drops what it added on top of the
 * battery's own mode at once (a charge raised past the own mode's, which is
 * grid charge now), and keeps the cap below it where it is: limiting the
 * battery further is shedding's choice, in priority order. Otherwise the
 * charge the leftover funds, paced.
 */
const advanceSurplusLever = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  deviceDemand: SurplusDemand,
  nowTs: number,
): StorageLeverState => {
  const reading = readLever(storage, lever);
  if (balance.deficitW > 0) {
    return { ...reading, setpointW: Math.min(lever.setpointW, Math.max(0, lever.preClaimSignedW)) };
  }
  const fundedW = resolveFundedChargeW(storage, heldChargeAddBackW(storage, lever), balance);
  const chargeW = resolvePacedChargeW(storage, lever, fundedW, nowTs);
  return {
    ...reading,
    setpointW: chargeW,
    chargeRaisedAtMs: chargeW > Math.max(0, lever.setpointW) ? nowTs : lever.chargeRaisedAtMs,
    lastNeedAtMs: isCapNeeded(lever, chargeW, deviceDemand) ? nowTs : lever.lastNeedAtMs,
  };
};

/**
 * The discharge this battery was asked for and has not delivered yet, W,
 * while its increase settles. Measured against its own discharge only: a
 * charge it has not stopped yet is pending relief's credit, never this one.
 */
export const resolveCreditW = (storage: ObservedStorageInput, lever: StorageLeverState, nowTs: number): number => {
  if (!isCreditable(storage) || !isSettling(lever, nowTs)) return 0;
  return Math.max(0, -lever.setpointW - Math.max(ownDischargeWOf(storage), lever.creditBaseW));
};

/** Why the plan holds the battery this cycle, for the state log and the overview. */
export const resolveClaimReason = (lever: StorageLeverState): StorageClaimReason => {
  if (lever.purpose === 'limit') return lever.setpointW < 0 ? 'relief' : 'charge_limit';
  return lever.setpointW < Math.max(0, lever.preClaimSignedW) ? 'cap_for_device' : 'raise_charge';
};

/** Under a charge limit, the charge it holds back, W; 0 under any other hold. */
export const resolveHeldBackChargeW = (lever: StorageLeverState): number => (
  resolveClaimReason(lever) === 'charge_limit' ? Math.max(0, lever.ownModeChargeW - Math.max(0, lever.setpointW)) : 0
);

/**
 * What restore and admission may not spend for a battery held at this
 * setpoint, W: the discharge it holds or still delivers, and a charge increase
 * the measurement does not show yet.
 */
export const resolveWithheldW = (storage: ObservedStorageInput, setpointW: number): number => (
  Math.max(0, -setpointW, ownDischargeWOf(storage)) + Math.max(0, setpointW - ownChargeWOf(storage))
);

const NO_DECISION = {
  claim: 'none', decision: { kind: 'none' }, setpointW: 0, heldBackChargeW: 0, creditW: 0, withheldW: 0,
} as const;

/** One cycle's decisions, accumulated battery by battery, and the relief they add up to. */
class StorageReliefCycle {
  readonly decisions = new Map<string, StorageDecision>();
  readonly levers: Record<string, StorageLeverState> = {};
  readonly batteries: StorageStateSummary[] = [];
  private creditW = 0;
  private releasedDischargeW = 0;
  private drawMarginW = 0;

  constructor(
    public balance: StorageBalance,
    private readonly deviceDemand: SurplusDemand,
    /** The measured whole-home net this cycle, W: what the pool's add-back was asked with. */
    private readonly signedNetW: number,
    private readonly nowTs: number,
  ) {}

  release(
    deviceId: string,
    reason: StorageReleaseReason,
    dischargeW: number,
    deferred: boolean,
  ): { decision: StorageDecision; withheldW: number } {
    const decision: StorageDecision = { kind: 'release', reason };
    this.decisions.set(deviceId, decision);
    if (!deferred) this.releasedDischargeW += Math.max(0, dischargeW);
    return { decision, withheldW: Math.max(0, dischargeW) };
  }

  /** Keep the hold, and carry it to the battery as a setpoint. */
  holdSetpoint(deviceId: string, lever: StorageLeverState): StorageDecision {
    this.levers[deviceId] = lever;
    const decision: StorageDecision = { kind: 'setpoint', setpointW: lever.setpointW, stepW: lever.stepW };
    this.decisions.set(deviceId, decision);
    return decision;
  }

  decideObserved(
    deviceId: string,
    storage: ObservedStorageInput,
    previous: StorageLeverState | undefined,
  ): StorageStateSummary {
    const { nowTs } = this;
    const observedDischargeW = ownDischargeWOf(storage);
    const summary = {
      deviceId, reading: 'observed' as const, claimHeld: storage.claimHeld, solarOnly: !storage.powerLimitControl,
    };
    const addedBackW = storageChargeAddBackW(storage, previous, this.signedNetW);
    const step = this.resolveObservedStep(storage, previous);
    if (step.kind === 'release') {
      // Left to its own mode, it keeps the charge the pool counted: none of it is left for the next battery.
      this.balance = { ...this.balance, surplusW: this.balance.surplusW - addedBackW };
      if (previous === undefined && !storage.claimHeld) return { ...summary, ...NO_DECISION };
      const deferred = !storage.claimHeld || storage.handBackDeferred;
      // A battery handed back to an own mode that discharges keeps covering
      // the house: only the discharge PELS held beyond that comes back as import.
      const ownModeDischargeW = previous === undefined ? 0 : Math.max(0, -previous.preClaimSignedW);
      const landingDischargeW = Math.max(0, observedDischargeW - ownModeDischargeW);
      const { decision, withheldW } = this.release(deviceId, step.reason, landingDischargeW, deferred);
      return { ...summary, ...NO_DECISION, decision, withheldW };
    }
    const candidateW = step.lever.setpointW;
    const ceilingW = candidateW < 0 ? storage.deliveryCeilingW : storage.chargeCeilingW;
    const next = {
      ...step.lever,
      setpointW: floorStorageSetpointW(Math.sign(candidateW) * Math.min(Math.abs(candidateW), ceilingW), storage.range),
    };
    const decision = this.holdSetpoint(deviceId, next);
    const nextDischargeW = -next.setpointW;
    const previousDischargeW = previous === undefined ? observedDischargeW : -previous.setpointW;
    const creditW = resolveCreditW(storage, next, nowTs);
    this.balance = {
      deficitW: this.balance.deficitW,
      headroomW: Math.max(0, this.balance.headroomW - Math.max(0, previousDischargeW - nextDischargeW)),
      // What this battery left of the leftover, for the next one.
      surplusW: this.balance.surplusW - addedBackW + ownChargeWOf(storage) - Math.max(0, next.setpointW),
    };
    this.creditW += creditW;
    if (nextDischargeW > 0) this.drawMarginW = Math.max(this.drawMarginW, drawMarginWFor(storage));
    return {
      ...summary,
      claim: resolveClaimReason(next),
      decision,
      setpointW: next.setpointW,
      heldBackChargeW: resolveHeldBackChargeW(next),
      creditW,
      withheldW: resolveWithheldW(storage, next.setpointW),
    };
  }

  /**
   * A held battery with no reading this cycle: the last hold is kept,
   * uncredited, until it has gone unread for `STORAGE_INPUT_MISSING_RELEASE_MS`
   * or is no longer admissible, then released. Its discharge is counted as
   * handed back on the release cycle: whether it is still delivering is
   * unknown, and an unknown resolves toward shedding. An absent battery's
   * release travels on the plan itself. A planned device without a storage
   * cluster cannot say whether it is admissible: its hold is kept for the
   * window, then released.
   */
  decideUnread(
    deviceId: string,
    carrier: UnreadCarrier,
    previous: StorageLeverState | undefined,
  ): StorageStateSummary {
    const reading = carrier === 'absent' ? 'absent' as const : 'missing' as const;
    const summary = { deviceId, reading, claimHeld: true, solarOnly: false };
    if (previous === undefined) return { ...summary, ...NO_DECISION };
    const heldDischargeW = Math.max(0, -previous.setpointW);
    const sinceMs = previous.reading.kind === 'unread' ? previous.reading.sinceMs : this.nowTs;
    const expired = this.nowTs - sinceMs >= STORAGE_INPUT_MISSING_RELEASE_MS;
    const admissible = carrier === 'absent' || carrier === 'no_input' || carrier.admissible;
    if (!admissible || expired) {
      const reason = carrier === 'absent' || !admissible ? 'not_admissible' : 'input_missing';
      const deferred = typeof carrier === 'object' && carrier.handBackDeferred;
      const { decision, withheldW } = this.release(deviceId, reason, heldDischargeW, deferred);
      return { ...summary, ...NO_DECISION, decision, withheldW };
    }
    const event = { deviceId, heldSetpointW: previous.setpointW };
    if (previous.reading.kind === 'read') logger.warn({ event: 'storage_relief_input_missing', ...event });
    const lever: StorageLeverState = { ...previous, reading: { kind: 'unread', sinceMs } };
    const held = {
      ...summary,
      claim: resolveClaimReason(lever),
      setpointW: lever.setpointW,
      heldBackChargeW: 0,
      creditW: 0,
      withheldW: heldDischargeW,
    };
    if (carrier === 'absent') {
      // No plan device carries a decision: the hold alone is kept.
      this.levers[deviceId] = lever;
      return { ...held, decision: { kind: 'none' } };
    }
    return { ...held, decision: this.holdSetpoint(deviceId, lever) };
  }

  record(summary: StorageStateSummary): void {
    this.batteries.push(summary);
  }

  toRelief(): StorageRelief {
    return {
      decisions: this.decisions,
      shed: {
        netCreditKw: (this.creditW - this.releasedDischargeW) / 1000,
        relieving: Object.values(this.levers).some((lever) => lever.setpointW < 0),
        drawMarginKw: this.drawMarginW / 1000,
      },
      withheldKw: sumWithheldKw(this.batteries),
      levers: this.levers,
      batteries: this.batteries,
    };
  }

  /**
   * Release a battery the plan may not hold, a limit hold whose Power-limit
   * control the owner turned off, a surplus hold on a battery that stopped
   * taking charge, or a surplus hold no device has needed for its dwell;
   * otherwise its next hold.
   */
  private resolveObservedStep(storage: ObservedStorageInput, previous: StorageLeverState | undefined): ObservedStep {
    const blocked = resolveBlockedReason(storage);
    if (blocked !== 'holdable') return { kind: 'release', reason: blocked };
    if (previous === undefined) {
      return startSurplusLever(storage, this.balance, this.deviceDemand, this.signedNetW, this.nowTs);
    }
    if (previous.purpose === 'limit') {
      if (!storage.powerLimitControl) return { kind: 'release', reason: 'limit_off' };
      return keepLimitLever(storage, previous, this.balance, this.nowTs);
    }
    if (!takesCharge(storage)) return { kind: 'release', reason: 'full' };
    const next = advanceSurplusLever(storage, previous, this.balance, this.deviceDemand, this.nowTs);
    const dwelled = this.nowTs - next.lastNeedAtMs >= STORAGE_SURPLUS_RELEASE_DWELL_MS;
    return dwelled ? { kind: 'release', reason: 'surplus_dwell' } : { kind: 'hold', lever: next };
  }
}

/** The batteries' withheld power, kW. */
export const sumWithheldKw = (batteries: readonly StorageStateSummary[]): number => (
  batteries.reduce((totalW, battery) => totalW + battery.withheldW, 0) / 1000
);

/**
 * Decide every battery's hold or hand-back for this measured cycle, and the
 * term shedding counts. Batteries take the headroom, and then the leftover
 * surplus, in plan order, each covering what the ones before it left open.
 */
export function decideStorageRelief(
  devices: readonly PlanInputDevice[],
  power: MeasuredPower,
  levers: Readonly<Record<string, StorageLeverState>>,
  surplus: SurplusLeftover,
  nowTs: number,
): StorageRelief {
  const cycle = new StorageReliefCycle({
    deficitW: Math.max(0, -power.headroomKw * 1000),
    headroomW: Math.max(0, power.headroomKw * 1000),
    surplusW: surplus.leftoverW,
  }, surplus.deviceDemand, power.drawKw * 1000, nowTs);
  const seen = new Set<string>();
  for (const device of devices) {
    if (!hasStorageInput(device)) continue;
    seen.add(device.id);
    const { storage } = device;
    const previous = levers[device.id];
    cycle.record(storage.reading === 'observed'
      ? cycle.decideObserved(device.id, storage, previous)
      : cycle.decideUnread(device.id, storage, previous));
  }
  for (const [deviceId, previous] of Object.entries(levers)) {
    if (seen.has(deviceId)) continue;
    const carrier = devices.some((device) => device.id === deviceId) ? 'no_input' : 'absent';
    cycle.record(cycle.decideUnread(deviceId, carrier, previous));
  }
  return cycle.toRelief();
}

/**
 * Meter silence: hand back every battery PELS holds or drives. Without a
 * measurement there is no deficit to relieve, and the fail-closed pass sheds
 * every load to its floor exactly as it does without a battery.
 */
export function releaseStorageOnSilentMeter(
  devices: readonly PlanInputDevice[],
  levers: Readonly<Record<string, StorageLeverState>>,
): StorageRelief {
  const decisions = new Map<string, StorageDecision>(
    Object.keys(levers).map((id) => [id, { kind: 'release', reason: 'meter_silent' }]),
  );
  for (const device of devices) {
    if (!hasStorageInput(device)) continue;
    if (levers[device.id] !== undefined || device.storage.claimHeld) {
      decisions.set(device.id, { kind: 'release', reason: 'meter_silent' });
    }
  }
  return { ...NO_STORAGE_RELIEF, decisions };
}

/**
 * The measurement as restore and admission see it: the headroom less what the
 * stages withhold (`StorageRelief.withheldKw`), so stored energy never admits
 * a device and a charge increase never meets a restore on the same room. The
 * draw stays the measured one.
 */
export function withoutStorageWithheld(power: MeasuredPower, relief: StorageRelief): MeasuredPower {
  const withheldKw = relief.withheldKw;
  if (withheldKw <= 0) return power;
  return {
    ...power,
    headroomKw: power.headroomKw - withheldKw,
    capacityHeadroomKw: power.capacityHeadroomKw - withheldKw,
    budgetHeadroomKw: power.budgetHeadroomKw === null ? null : power.budgetHeadroomKw - withheldKw,
  };
}

/** Carry each battery's decision onto its plan device. */
export function attachStorageDecisions(
  planDevices: DevicePlanDevice[],
  relief: StorageRelief,
): DevicePlanDevice[] {
  if (relief.decisions.size === 0 && relief.batteries.length === 0) return planDevices;
  const holds = new Map(relief.batteries.map((battery) => [battery.deviceId, toStorageHold(battery)] as const));
  return planDevices.map((device) => {
    const storageDecision = relief.decisions.get(device.id);
    const storageHold = holds.get(device.id);
    const held = storageHold === undefined ? device : { ...device, storageHold };
    if (storageDecision === undefined) return held;
    const decided: DevicePlanDevice & StoragePlanKind = { ...held, storageDecision };
    return decided;
  });
}

/** Why PELS holds a battery after this cycle, or how it may use one it does not hold, as the overview names it. */
const toStorageHold = (battery: StorageStateSummary): StorageHold => {
  switch (battery.claim) {
    case 'none': return battery.solarOnly ? { kind: 'solar_only' } : { kind: 'none' };
    case 'charge_limit': return { kind: 'charge_limit', heldBackKw: battery.heldBackChargeW / 1000 };
    case 'raise_charge': return { kind: 'surplus' };
    default: return { kind: battery.claim };
  }
};

/** Preserve releases whose battery left the home's plan. */
export function collectAbsentStorageReleases(
  planDevices: readonly DevicePlanDevice[],
  relief: StorageRelief,
): StorageReleaseIntent[] {
  const present = new Set(planDevices.map((device) => device.id));
  return [...relief.decisions].flatMap(([deviceId, decision]) => (
    decision.kind === 'release' && !present.has(deviceId) ? [{ deviceId, reason: decision.reason }] : []
  ));
}
