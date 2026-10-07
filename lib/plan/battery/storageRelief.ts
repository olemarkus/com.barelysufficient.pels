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
 * stopped, until the restore lane hands the battery back.
 *
 * **Power-limit control off.** PELS never takes the battery over at all
 * (owner ruling, 2026-10-06): no charge cap, no discharge and no surplus
 * claim. Any hold it has is handed back at once (`limit_off`), and the
 * battery is no surplus claimant: its charge is household load, while its
 * discharge still stays out of the surplus pool (`resolveStorageSurplus`).
 *
 * **Surplus.** Surplus goes to the consumers in priority order, and the
 * battery is one of them, at its own place (owner ruling, 2026-10-06; last,
 * the default, is devices, then the battery, then export). A surplus claim
 * exists only to give a device ranked above the battery power the battery's
 * own mode would otherwise take; in every other situation the battery runs its
 * own mode, so its self-consumption, trading and evening discharge keep
 * working. The surplus pool counts the solar a battery stores that PELS can
 * free and never a battery's discharge (`resolveStorageSurplus`). The
 * allocator hands this stage each battery's offer (`StorageSurplusOffer`):
 * what the consumers ranked above it left, and the strongest demand those
 * devices put on it. The devices already running are in the measurement, so
 * only the smallest step of a device waiting to start is taken out of it. A
 * device ranked below the battery is offered only what the battery leaves, so
 * it never takes the battery's charge, and its demand is not the battery's.
 *
 * - PELS claims a charging battery only while a device ranked above it that is
 *   not running yet could be funded by its charge, and caps the charge to what
 *   the device leaves. It never claims a battery that is discharging, or one
 *   that stopped taking charge (a full battery, its charge ceiling about 0 W),
 *   or one whose Power-limit control or Managed is off.
 * - A held charge follows its offer, less half the deadband, within the
 *   charge ceiling and the headroom to the binding pace. A rise waits for a
 *   visible step and `SURPLUS_TRACK_STEP_MIN_INTERVAL_MS` after the last, like
 *   a tracking device's climb; a fall that eats the margin follows the offer
 *   at once. On a deficit a charge raised past the own mode's drops to it at
 *   once (it would be grid charge), and a cap below it is kept where it is:
 *   shedding decides in priority order whether to limit the battery further.
 * - The claim is needed only while a device ranked above it still wants
 *   surplus and the charge is held below what the battery's own mode charged
 *   when PELS took it (the cap doing its job). Without that for
 *   `STORAGE_SURPLUS_RELEASE_DWELL_MS` it is handed back (`surplus_dwell`),
 *   and at once if the battery stops taking charge (`full`).
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
import type {
  StorageSurplus,
  StorageSurplusClaimant,
  StorageSurplusOffer,
  SurplusDemand,
} from '../planSurplusAbsorb';
import type { DevicePlanDevice, PlanInputDevice, StorageHold } from '../planTypes';
import { NO_STORAGE_SHED_TERM, type StorageShedTerm } from '../shedding/types';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS,
  deadbandWFor,
  drawMarginWFor,
  hasStorageInput,
  hasStorageLeverInput,
  isRaiseVisible,
  ownChargeWOf,
  ownDischargeWOf,
  resolveOwnModeChargeAboveHoldW,
  resolveStorageHoldBlock,
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
 * charged so a device ranked above it gets that power; `raise_charge`, a
 * surplus hold charging past that from what its offer leaves; or `none` (not
 * held).
 */
export type StorageClaimReason = 'none' | 'relief' | 'charge_limit' | 'cap_for_device' | 'raise_charge';

/** One battery as this cycle left it, for the state log. */
export type StorageStateSummary = {
  deviceId: string;
  reading: 'observed' | 'missing' | 'absent';
  claimHeld: boolean;
  /**
   * Its Power-limit control is off: PELS never takes it over, and its own app
   * is in charge. False for a battery this cycle could not read.
   */
  powerLimitOff: boolean;
  claim: StorageClaimReason;
  /** What the plan carries to the battery this cycle; `none` when it decides nothing for it. */
  decision: StorageDecision | { kind: 'none' };
  /** The signed power this cycle decided to hold, W: negative discharges, positive charges. */
  setpointW: number;
  /** Under a charge limit, the charge its own mode would take that the cap holds back, W; else 0. */
  heldBackChargeW: number;
  creditW: number;
  /**
   * What restore and admission may not spend for this battery, W: the
   * discharge PELS holds or is handing back (stored energy, not room), and a
   * charge increase decided this cycle that the measurement does not show yet
   * (`withoutStorageWithheld`).
   */
  withheldW: number;
};

/**
 * What the stage decided this cycle. `batteries` is the one list of what was
 * decided for each battery; its decisions and withheld power are read from it.
 */
export type StorageRelief = {
  /** What shedding counts against the measured deficit. */
  shed: StorageShedTerm;
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
  shed: NO_STORAGE_SHED_TERM,
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
 * The headroom still to give back, W, as each battery takes its share; and the
 * deficit, which keeps a surplus hold where it is for shedding to decide.
 */
type StorageBalance = { deficitW: number; headroomW: number };

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
 * The home batteries as the surplus allocator ranks them (owner ruling,
 * 2026-10-06: surplus by priority): every battery PELS may claim, at its
 * priority, with the charge PELS can free (`storageChargeAddBackW`), and every
 * battery's own discharge, which is stored energy and never surplus (a battery
 * exporting in the evening, or a held discharge stepping down). A held battery
 * keeps at its turn the setpoint PELS holds it at, or the charge its own mode
 * takes once handed back if that is more: a raise it has not followed yet, or
 * the charge a limit hold keeps from its own mode while restore waits to hand
 * it back, is its place in the order, not surplus for the consumers below it.
 * A battery PELS
 * may not hold (`resolveStorageHoldBlock`: Managed or Power-limit control off,
 * not responding, sign-inverted) is no claimant: its charge is ordinary
 * household load, and its discharge still counts. So does the discharge of a
 * battery PELS only watches (`WatchedStorageInput`), which is never a
 * claimant. Capacity simulation makes no battery
 * claimable, so it then carries only their discharge. Resolved by the builder
 * and handed to the allocator, which reads no battery.
 */
export function resolveStorageSurplus(
  devices: readonly PlanInputDevice[],
  levers: Readonly<Record<string, StorageLeverState>>,
  signedNetW: number,
): StorageSurplus {
  const observed = devices.flatMap((device) => (
    hasStorageInput(device) && device.storage.reading === 'observed' ? [{ device, storage: device.storage }] : []
  ));

  const claimants = observed
    .filter(({ storage }) => resolveStorageHoldBlock(storage) === 'holdable')
    .map(({ device, storage }): StorageSurplusClaimant => {
      const lever = levers[device.id];
      const chargeW = storageChargeAddBackW(storage, lever, signedNetW);
      return {
        deviceId: device.id,
        priority: device.priority,
        chargeW,
        reservedW: lever === undefined ? chargeW : Math.max(chargeW, lever.setpointW, lever.ownModeChargeW),
      };
    });
  // Every battery read this cycle: one PELS only watches is never a claimant,
  // but its discharge is stored energy all the same.
  const read = devices.flatMap((device) => (
    hasStorageInput(device) && device.storage.reading !== 'missing' ? [device.storage] : []
  ));
  return { claimants, dischargeW: read.reduce((totalW, storage) => totalW + ownDischargeWOf(storage), 0) };
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
 * The charge its offer funds on this battery, W: what the consumers above it
 * left, less what the pool already counted of its charge (`addedBackW`), plus
 * its own charge, less half the deadband; within its charge ceiling and the
 * headroom to the binding pace (its own charge is already in that
 * measurement). A raise past `ownModeChargeW`, the charge its own mode takes,
 * comes only out of what the consumers ranked below it do not take
 * (`StorageSurplusOffer.belowW`), so a watt they are offered is never funded
 * twice; a cap below it is not bounded so. Under the deadband it is 0 W: too
 * little to tell from noise.
 */
const resolveFundedChargeW = (
  storage: ObservedStorageInput,
  offer: StorageSurplusOffer,
  balance: StorageBalance,
  ownModeChargeW: number,
): number => {
  const ownChargeW = ownChargeWOf(storage);
  const halfDeadbandW = deadbandWFor(storage) / 2;
  const shareW = offer.availableW - offer.addedBackW + ownChargeW - halfDeadbandW;
  const unboundW = Math.min(storage.chargeCeilingW, shareW, ownChargeW + balance.headroomW - halfDeadbandW);
  const raisedW = Math.max(ownModeChargeW, Math.min(unboundW, shareW - offer.belowW));
  const fundedW = unboundW > ownModeChargeW ? raisedW : unboundW;
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
  stepW: storage.range.stepW,
  reading: { kind: 'read' },
});

/**
 * Whether a surplus hold still does its job: a device ranked above the battery
 * wants surplus, and the charge is capped below the own mode's.
 */
const isCapNeeded = (lever: StorageLeverState, chargeW: number, demandAbove: SurplusDemand): boolean => (
  demandAbove !== 'none' && chargeW < Math.max(0, lever.preClaimSignedW)
);

/**
 * Start a surplus claim on a battery PELS does not hold: while a device ranked
 * above it that is not running yet could be funded by the solar its own mode
 * stores, cap that charge to what the device leaves. A battery ranked above
 * every waiting device keeps its charge. A discharging battery, one that takes
 * no charge, or any battery while the house is short of its pace, is never
 * claimed for surplus. With nothing to do, the battery is left to its own mode
 * (`idle`).
 */
const startSurplusLever = (
  storage: ObservedStorageInput,
  balance: StorageBalance,
  offer: StorageSurplusOffer,
  nowTs: number,
): ObservedStep => {
  const idle: ObservedStep = { kind: 'release', reason: 'idle' };
  if (balance.deficitW > 0 || offer.demandAbove !== 'waiting' || storage.signedPowerW < 0 || !takesCharge(storage)) {
    return idle;
  }
  // A claim only ever starts as a cap: its own mode's charge is the most it funds.
  const chargeW = resolveFundedChargeW(storage, offer, balance, ownChargeWOf(storage));
  // Only solar the pool offered: a battery charging from the grid is left alone.
  const caps = offer.addedBackW > 0 && isRaiseVisible(storage, chargeW, ownChargeWOf(storage));
  return caps ? { kind: 'hold', lever: claimSurplusLever(storage, chargeW, nowTs) } : idle;
};

/** The hold as this cycle's reading of the battery leaves it. */
const readLever = (storage: ObservedStorageInput, lever: StorageLeverState): StorageLeverState => ({
  ...lever,
  ownModeChargeW: resolveOwnModeChargeW(storage, lever.preClaimSignedW),
  stepW: storage.range.stepW,
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
 * charge its offer funds, paced.
 */
const advanceSurplusLever = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  offer: StorageSurplusOffer,
  nowTs: number,
): StorageLeverState => {
  const reading = readLever(storage, lever);
  if (balance.deficitW > 0) {
    return { ...reading, setpointW: Math.min(lever.setpointW, Math.max(0, lever.preClaimSignedW)) };
  }
  const fundedW = resolveFundedChargeW(storage, offer, balance, Math.max(0, lever.preClaimSignedW));
  const chargeW = resolvePacedChargeW(storage, lever, fundedW, nowTs);
  return {
    ...reading,
    setpointW: chargeW,
    chargeRaisedAtMs: chargeW > Math.max(0, lever.setpointW) ? nowTs : lever.chargeRaisedAtMs,
    lastNeedAtMs: isCapNeeded(lever, chargeW, offer.demandAbove) ? nowTs : lever.lastNeedAtMs,
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
  resolveClaimReason(lever) === 'charge_limit' ? resolveOwnModeChargeAboveHoldW(lever) : 0
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

/** The setpoint decision that carries a hold to the battery. */
export const toSetpointDecision = (lever: StorageLeverState): StorageDecision => (
  { kind: 'setpoint', setpointW: lever.setpointW, stepW: lever.stepW }
);

/**
 * An observed battery as a hold leaves it this cycle, for the state log, the
 * overview and the plan: the hold's setpoint decision, why it is held, and
 * what restore and admission may not spend for it.
 */
export const summarizeHold = (
  deviceId: string,
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  creditW: number,
): StorageStateSummary => ({
  deviceId,
  reading: 'observed',
  claimHeld: storage.claimHeld,
  powerLimitOff: !storage.powerLimitControl,
  claim: resolveClaimReason(lever),
  decision: toSetpointDecision(lever),
  setpointW: lever.setpointW,
  heldBackChargeW: resolveHeldBackChargeW(lever),
  creditW,
  withheldW: resolveWithheldW(storage, lever.setpointW),
});

/** One cycle's decisions, accumulated battery by battery, and the relief they add up to. */
class StorageReliefCycle {
  readonly levers: Record<string, StorageLeverState> = {};
  readonly batteries: StorageStateSummary[] = [];
  private creditW = 0;
  private releasedDischargeW = 0;
  private drawMarginW = 0;

  constructor(
    public balance: StorageBalance,
    /** What the allocator offered each battery at its place in the priority order. */
    private readonly offers: ReadonlyMap<string, StorageSurplusOffer>,
    private readonly nowTs: number,
  ) {}

  release(
    reason: StorageReleaseReason,
    dischargeW: number,
    deferred: boolean,
  ): { decision: StorageDecision; withheldW: number } {
    if (!deferred) this.releasedDischargeW += Math.max(0, dischargeW);
    return { decision: { kind: 'release', reason }, withheldW: Math.max(0, dischargeW) };
  }

  decideObserved(
    deviceId: string,
    storage: ObservedStorageInput,
    previous: StorageLeverState | undefined,
  ): StorageStateSummary {
    const { nowTs } = this;
    const observedDischargeW = ownDischargeWOf(storage);
    const step = this.resolveObservedStep(deviceId, storage, previous);
    if (step.kind === 'release') {
      const summary = {
        deviceId, reading: 'observed' as const, claimHeld: storage.claimHeld, powerLimitOff: !storage.powerLimitControl,
      };
      if (previous === undefined && !storage.claimHeld) return { ...summary, ...NO_DECISION };
      const deferred = !storage.claimHeld || storage.handBackDeferred;
      // A battery handed back to an own mode that discharges keeps covering
      // the house: only the discharge PELS held beyond that comes back as import.
      const ownModeDischargeW = previous === undefined ? 0 : Math.max(0, -previous.preClaimSignedW);
      const landingDischargeW = Math.max(0, observedDischargeW - ownModeDischargeW);
      const { decision, withheldW } = this.release(step.reason, landingDischargeW, deferred);
      return { ...summary, ...NO_DECISION, decision, withheldW };
    }
    const candidateW = step.lever.setpointW;
    const ceilingW = candidateW < 0 ? storage.deliveryCeilingW : storage.chargeCeilingW;
    const next = {
      ...step.lever,
      setpointW: floorStorageSetpointW(Math.sign(candidateW) * Math.min(Math.abs(candidateW), ceilingW), storage.range),
    };
    this.levers[deviceId] = next;
    const nextDischargeW = -next.setpointW;
    const previousDischargeW = previous === undefined ? observedDischargeW : -previous.setpointW;
    const creditW = resolveCreditW(storage, next, nowTs);
    this.balance = {
      deficitW: this.balance.deficitW,
      headroomW: Math.max(0, this.balance.headroomW - Math.max(0, previousDischargeW - nextDischargeW)),
    };
    this.creditW += creditW;
    if (nextDischargeW > 0) this.drawMarginW = Math.max(this.drawMarginW, drawMarginWFor(storage));
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
   * window, then released.
   */
  decideUnread(
    deviceId: string,
    carrier: UnreadCarrier,
    previous: StorageLeverState | undefined,
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
      const { decision, withheldW } = this.release(reason, heldDischargeW, deferred);
      return { ...summary, ...NO_DECISION, decision, withheldW };
    }
    const event = { deviceId, heldSetpointW: previous.setpointW };
    if (previous.reading.kind === 'read') logger.warn({ event: 'storage_relief_input_missing', ...event });
    const lever: StorageLeverState = { ...previous, reading: { kind: 'unread', sinceMs } };
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
   * ranks every such battery (`resolveStorageSurplus`), so a missing offer is
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
        netCreditKw: (this.creditW - this.releasedDischargeW) / 1000,
        relieving: Object.values(this.levers).some((lever) => lever.setpointW < 0),
        drawMarginKw: this.drawMarginW / 1000,
      },
      levers: this.levers,
      batteries: this.batteries,
    };
  }

  /**
   * Release a battery the plan may not hold (`resolveStorageHoldBlock`; with
   * its Power-limit control off, `limit_off`), a surplus hold on a battery
   * that stopped taking charge, or a surplus hold no device ranked above it has
   * needed for its dwell; otherwise its next hold.
   */
  private resolveObservedStep(
    deviceId: string,
    storage: ObservedStorageInput,
    previous: StorageLeverState | undefined,
  ): ObservedStep {
    const blocked = resolveStorageHoldBlock(storage);
    if (blocked !== 'holdable') return { kind: 'release', reason: blocked };
    const offer = this.offerFor(deviceId);
    if (previous === undefined) return startSurplusLever(storage, this.balance, offer, this.nowTs);
    if (previous.purpose === 'limit') return keepLimitLever(storage, previous, this.balance, this.nowTs);
    if (!takesCharge(storage)) return { kind: 'release', reason: 'full' };
    const next = advanceSurplusLever(storage, previous, this.balance, offer, this.nowTs);
    const dwelled = this.nowTs - next.lastNeedAtMs >= STORAGE_SURPLUS_RELEASE_DWELL_MS;
    return dwelled ? { kind: 'release', reason: 'surplus_dwell' } : { kind: 'hold', lever: next };
  }
}

/** How the state log names a battery this cycle could not read. */
const toUnreadReading = (carrier: UnreadCarrier): 'missing' | 'absent' => (carrier === 'absent' ? 'absent' : 'missing');

/** The batteries' withheld power, kW. */
export const sumWithheldKw = (batteries: readonly StorageStateSummary[]): number => (
  batteries.reduce((totalW, battery) => totalW + battery.withheldW, 0) / 1000
);

/**
 * Decide every battery's hold or hand-back for this measured cycle, and the
 * term shedding counts. Batteries take the headroom in plan order, each
 * covering what the ones before it left open; each stores surplus from its own
 * offer, which the allocator already ranked in priority order.
 */
export function decideStorageRelief(
  devices: readonly PlanInputDevice[],
  power: MeasuredPower,
  levers: Readonly<Record<string, StorageLeverState>>,
  offers: ReadonlyMap<string, StorageSurplusOffer>,
  nowTs: number,
): StorageRelief {
  const cycle = new StorageReliefCycle({
    deficitW: Math.max(0, -power.headroomKw * 1000),
    headroomW: Math.max(0, power.headroomKw * 1000),
  }, offers, nowTs);
  const seen = new Set<string>();
  for (const device of devices) {
    // A battery PELS only watches is decided like one without a cluster: it
    // has nothing to hold, and a hold left on it is read as `no_input` below.
    if (!hasStorageLeverInput(device)) continue;
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

/**
 * The measurement as restore and admission see it: the headroom less what the
 * batteries withhold (`StorageStateSummary.withheldW`), so stored energy never
 * admits a device and a charge increase never meets a restore on the same
 * room. The draw stays the measured one.
 */
export function withoutStorageWithheld(power: MeasuredPower, relief: StorageRelief): MeasuredPower {
  const withheldKw = sumWithheldKw(relief.batteries);
  if (withheldKw <= 0) return power;
  return {
    ...power,
    headroomKw: power.headroomKw - withheldKw,
    capacityHeadroomKw: power.capacityHeadroomKw - withheldKw,
    budgetHeadroomKw: power.budgetHeadroomKw === null ? null : power.budgetHeadroomKw - withheldKw,
  };
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
  return relief.batteries.flatMap(({ deviceId, decision }) => (
    decision.kind === 'release' && !present.has(deviceId) ? [{ deviceId, reason: decision.reason }] : []
  ));
}
