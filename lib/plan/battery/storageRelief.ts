/**
 * Storage relief: a home battery spends stored energy against the deficit
 * BEFORE shedding selection spends the owner's comfort (owner ruling,
 * 2026-10-05). It relieves whichever pace binds — the measured headroom is
 * against `softLimit = min(capacity, daily)` — exhausted hour included.
 *
 * The battery protects devices that are ALREADY running. Its discharge never
 * creates headroom for restoring more: restore and admission see the headroom
 * less the discharge PELS holds, and less a charge increase not measured yet
 * (`withoutStorageWithheld`). Every uncertainty resolves toward shedding and
 * toward handing the battery back.
 *
 * The battery is never a shed candidate. It stays observe-only with no command
 * authority; this stage alone decides a signed setpoint or a hand-back for it
 * from its storage cluster (`StoragePlanInputKind`), which the executor's
 * storage lane carries out (`lib/executor/batteryExecutor.ts`). A deficit is
 * always answered first: the battery never charges while relief is needed.
 *
 * **Setpoint.** On a deficit the battery is asked for its own discharge plus
 * the deficit and half the deadband, bounded by its delivery ceiling and by the
 * house's draw less half the deadband (relief never tips the house into
 * export). A raise smaller than the setpoint tolerance
 * (`storageSetpointToleranceW`) is not made: it could not be told from noise,
 * and would be a write every reading. Increases are otherwise immediate, like
 * shedding. With headroom the setpoint steps down, but only past the deadband
 * (`max(step, 200 W)`), no sooner than `STORAGE_DECREASE_MIN_INTERVAL_MS` after
 * the last step down, and never while an increase is still settling; once the
 * discharge needed falls below the deadband it steps to 0 W, so the idle clock
 * runs.
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
 *   at once.
 * - The claim is needed only while a device still wants surplus and the charge
 *   is held below what the battery's own mode charged when PELS took it (the
 *   cap doing its job). Without that for `STORAGE_SURPLUS_RELEASE_DWELL_MS` it
 *   is handed back (`surplus_dwell`), and at once if the battery stops taking
 *   charge (`full`).
 *
 * **Credit.** An increase is a commitment the meter cannot show yet. For
 * `STORAGE_RELIEF_SETTLE_WINDOW_MS` after it was decided, the part the battery's
 * OWN signed power has not delivered yet is credited to shedding as its own
 * term (`StorageShedTerm`): the measurement is never rewritten. Nothing is
 * credited for a battery that is not responding, re-probing, sign-inverted,
 * being released or unreadable, so relief is an optional credit whose default
 * is zero and shedding then behaves exactly as without a battery. A further
 * increase inside the window keeps the window's stamp, and one after it is
 * credited only above what was already asked.
 *
 * **Release.** A battery held for relief is handed back when it has had
 * nothing to do for `STORAGE_IDLE_RELEASE_MS` (`idle`); one held for surplus as
 * above. Any held battery is handed back when it is no longer admissible
 * (opted out, its claim lost), when it is not responding or its sign is
 * inverted, after `STORAGE_INPUT_MISSING_RELEASE_MS` without a reading, and on
 * meter silence (`releaseStorageOnSilentMeter`). The cycle that releases a
 * discharging battery counts that discharge as deficit, so shedding is ready
 * before the import lands. Capacity simulation writes nothing, so the planner
 * decides nothing for a battery then (`NO_STORAGE_RELIEF`); the battery's owner
 * hands a held one back itself.
 */
import type {
  MissingStorageInput,
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../../packages/planner-types/src/planInputDevice';
import {
  storageSetpointToleranceW,
  type StorageDecision,
  type StoragePlanKind,
  type StorageReleaseReason,
} from '../../planContract/storageDecision';
import { getLogger } from '../../logging/logger';
import { SURPLUS_TRACK_STEP_MIN_INTERVAL_MS } from '../admission';
import type { MeasuredPower } from '../planContext';
import type { StorageLeverState } from '../planState';
import type { SurplusDemand, SurplusLeftover } from '../planSurplusAbsorb';
import type { DevicePlanDevice, PlanInputDevice } from '../planTypes';
import { NO_STORAGE_SHED_TERM, type StorageShedTerm } from '../shedding/types';

const logger = getLogger('plan/battery');

/** How long an increase's undelivered discharge is credited to shedding. */
export const STORAGE_RELIEF_SETTLE_WINDOW_MS = 30 * 1000;
/** How long a battery held for relief may have nothing to do before it is handed back. */
export const STORAGE_IDLE_RELEASE_MS = 10 * 60 * 1000;
/** How long a battery held for surplus may go without a device needing the cap before it is handed back. */
export const STORAGE_SURPLUS_RELEASE_DWELL_MS = 2 * 60 * 1000;
/** The least time between two step-downs of a setpoint. */
export const STORAGE_DECREASE_MIN_INTERVAL_MS = 60 * 1000;
/** How long a held battery may go unread before it is handed back. */
export const STORAGE_INPUT_MISSING_RELEASE_MS = 2 * 60 * 1000;
/** The least headroom, W, that steps a setpoint down (also the headroom left behind). */
const STORAGE_MIN_DEADBAND_W = 200;

/** Type guard: the plan device carries a storage cluster (`StoragePlanInputKind`). */
export function hasStorageInput<T extends object>(device: T): device is T & StoragePlanInputKind {
  return 'storage' in device;
}

/**
 * Why the plan holds a battery this cycle, for the state log: `relief`
 * against a deficit, `cap_for_device` holding its charge below what its own
 * mode charged so a device gets that power, `raise_charge` charging past that
 * from a leftover, or `none` (not held).
 */
export type StorageClaimReason = 'none' | 'relief' | 'cap_for_device' | 'raise_charge';

/** One battery as this cycle left it, for the state log. */
export type StorageStateSummary = {
  deviceId: string;
  reading: 'observed' | 'missing' | 'absent';
  claimHeld: boolean;
  claim: StorageClaimReason;
  decision: StorageDecision | { kind: 'none' };
  /** The signed power this cycle decided to hold, W: negative discharges, positive charges. */
  setpointW: number;
  creditW: number;
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
 * The deficit still to cover, the headroom still to give back and the surplus
 * still to store, W, as each battery takes its share.
 */
type StorageBalance = { deficitW: number; headroomW: number; drawW: number; surplusW: number };

/** What the plan does with an observed battery this cycle. */
type ObservedStep = { kind: 'release'; reason: StorageReleaseReason } | { kind: 'hold'; lever: StorageLeverState };

const deadbandWFor = (storage: ObservedStorageInput): number => Math.max(storage.stepW, STORAGE_MIN_DEADBAND_W);

/** The signed setpoint for a discharge, W: its negation, and a plain 0 rather than -0. */
const toSetpointW = (dischargeW: number): number => (dischargeW === 0 ? 0 : -dischargeW);

/** The battery's own charge, W: 0 while it is idle or discharging. */
const ownChargeWOf = (storage: ObservedStorageInput): number => Math.max(0, storage.signedPowerW);

/** The battery's own discharge, W: 0 while it is idle or charging. */
const ownDischargeWOf = (storage: ObservedStorageInput): number => Math.max(0, -storage.signedPowerW);

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

const isSettling = (lever: StorageLeverState, nowTs: number): boolean => (
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
 * The discharge a deficit asks of this battery, W: its own, plus the deficit
 * and half the deadband (the increase's hysteresis), within its delivery
 * ceiling and the house's draw less half the deadband. A charging battery is
 * asked for at least 0 W: relief wins over charging.
 */
const resolveWantedDischargeW = (storage: ObservedStorageInput, balance: StorageBalance): number => {
  const halfDeadbandW = deadbandWFor(storage) / 2;
  const reliefW = Math.min(balance.deficitW + halfDeadbandW, Math.max(0, balance.drawW - halfDeadbandW));
  return Math.round(Math.min(storage.deliveryCeilingW, Math.max(0, -storage.signedPowerW + reliefW)));
};

/** Whether raising from `fromW` to `wantedW` (either side of 0 W) is a step the battery could visibly answer. */
const isRaiseWorthIt = (storage: ObservedStorageInput, fromW: number, wantedW: number): boolean => (
  wantedW - fromW >= storageSetpointToleranceW(wantedW, storage.stepW)
);

/**
 * Step the discharge down, when pacing allows: to 0 W once the discharge the
 * house needs is under the deadband, else past the deadband, leaving the
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
  const baseW = Math.min(heldW, -storage.signedPowerW);
  if (baseW - balance.headroomW < deadbandW) return 0;
  if (balance.headroomW <= deadbandW) return heldW;
  return Math.round(Math.max(0, Math.min(heldW, baseW - (balance.headroomW - deadbandW))));
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
  return fundedW < deadbandWFor(storage) ? 0 : Math.round(fundedW);
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
  if (!isRaiseWorthIt(storage, heldW, fundedW)) return heldW;
  return nowTs - lever.chargeRaisedAtMs < SURPLUS_TRACK_STEP_MIN_INTERVAL_MS ? heldW : fundedW;
};

/**
 * A new hold at this setpoint. Relief (a setpoint below the battery's own
 * power: more discharge, or a charge stopped) starts its credit's settle window
 * now; a surplus cap is no relief, so its window is already over.
 */
const claimLever = (
  storage: ObservedStorageInput,
  setpointW: number,
  purpose: StorageLeverState['purpose'],
  nowTs: number,
): StorageLeverState => ({
  setpointW,
  purpose,
  increaseDecidedAtMs: purpose === 'relief' ? nowTs : nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS,
  creditBaseW: -storage.signedPowerW,
  lastDecreaseAtMs: nowTs,
  chargeRaisedAtMs: nowTs,
  lastNeedAtMs: nowTs,
  preClaimSignedW: storage.signedPowerW,
  stepW: storage.stepW,
  reading: { kind: 'read' },
});

/** Whether a surplus hold still does its job: a device wants surplus, and the charge is capped below the own mode's. */
const isCapNeeded = (lever: StorageLeverState, chargeW: number, deviceDemand: SurplusDemand): boolean => (
  deviceDemand !== 'none' && chargeW < Math.max(0, lever.preClaimSignedW)
);

/**
 * Start driving a battery: on a deficit to discharge; or, while a device that
 * is not running yet could be funded by the solar its own mode stores, to cap
 * that charge to what the device leaves. A discharging battery, or one that
 * takes no charge, is never claimed for surplus. With nothing to do, the
 * battery is left to its own mode (`idle`).
 */
const startLever = (
  storage: ObservedStorageInput,
  balance: StorageBalance,
  deviceDemand: SurplusDemand,
  signedNetW: number,
  nowTs: number,
): ObservedStep => {
  const idle: ObservedStep = { kind: 'release', reason: 'idle' };
  if (balance.deficitW > 0) {
    const wantedW = resolveWantedDischargeW(storage, balance);
    // Relief exists when the setpoint asks visibly more than the battery does now
    // (a charging battery stopped at 0 W is relief too).
    if (!isRaiseWorthIt(storage, -storage.signedPowerW, wantedW)) return idle;
    return { kind: 'hold', lever: claimLever(storage, toSetpointW(wantedW), 'relief', nowTs) };
  }
  if (deviceDemand !== 'waiting' || storage.signedPowerW < 0 || !takesCharge(storage)) return idle;
  const addedBackW = ownModeChargeAddBackW(storage, signedNetW);
  const chargeW = resolveFundedChargeW(storage, addedBackW, balance);
  // Only solar the pool offered: a battery charging from the grid is left alone.
  const caps = addedBackW > 0 && isRaiseWorthIt(storage, chargeW, ownChargeWOf(storage));
  return caps ? { kind: 'hold', lever: claimLever(storage, chargeW, 'surplus', nowTs) } : idle;
};

/** The hold as this cycle's reading of the battery leaves it. */
const readLever = (storage: ObservedStorageInput, lever: StorageLeverState): StorageLeverState => (
  { ...lever, stepW: storage.stepW, reading: { kind: 'read' } }
);

/** On a deficit: the discharge raised, a held charge stopped first. Relief wins over charging. */
const raiseDischarge = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  nowTs: number,
): StorageLeverState => {
  const reading = { ...readLever(storage, lever), purpose: 'relief' as const };
  // Signed: negative while the plan holds a charge.
  const heldDischargeW = -lever.setpointW;
  const wantedW = resolveWantedDischargeW(storage, balance);
  if (!isRaiseWorthIt(storage, heldDischargeW, wantedW)) {
    const keptW = Math.min(Math.max(0, heldDischargeW), storage.deliveryCeilingW);
    return { ...reading, setpointW: toSetpointW(keptW), lastNeedAtMs: nowTs };
  }
  // A new window only once the last one is over, and credited only above what
  // was already asked: an increase that never landed is not credited twice.
  const restamp = !isSettling(lever, nowTs);
  return {
    ...reading,
    setpointW: toSetpointW(wantedW),
    increaseDecidedAtMs: restamp ? nowTs : lever.increaseDecidedAtMs,
    creditBaseW: restamp ? Math.max(-storage.signedPowerW, heldDischargeW) : lever.creditBaseW,
    lastNeedAtMs: nowTs,
  };
};

/**
 * The next hold on a battery the plan is driving: on a deficit, the discharge
 * raised (a charge stops first); otherwise a held discharge lowered, and once
 * none is left, the charge the leftover funds.
 */
const advanceLever = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  deviceDemand: SurplusDemand,
  nowTs: number,
): StorageLeverState => {
  if (balance.deficitW > 0) return raiseDischarge(storage, lever, balance, nowTs);
  const reading = readLever(storage, lever);
  const heldDischargeW = -lever.setpointW;
  if (heldDischargeW > 0) {
    const loweredW = Math.min(resolveLoweredDischargeW(storage, lever, balance, nowTs), storage.deliveryCeilingW);
    if (loweredW > 0) {
      return {
        ...reading,
        setpointW: -loweredW,
        lastDecreaseAtMs: loweredW < heldDischargeW ? nowTs : lever.lastDecreaseAtMs,
        lastNeedAtMs: nowTs,
      };
    }
  }
  const fundedW = resolveFundedChargeW(storage, heldChargeAddBackW(storage, lever), balance);
  const chargeW = resolvePacedChargeW(storage, lever, fundedW, nowTs);
  // A relief hold is needed through the cycle it stops discharging, and while
  // it holds a battery that was charging at 0 W in a house with no room for
  // that charge again. A surplus hold only while its cap does its job.
  const holdsBackCharge = chargeW === 0
    && balance.headroomW < Math.max(0, lever.preClaimSignedW) + deadbandWFor(storage);
  const needed = lever.purpose === 'relief'
    ? heldDischargeW > 0 || holdsBackCharge
    : isCapNeeded(lever, chargeW, deviceDemand);
  return {
    ...reading,
    setpointW: chargeW,
    lastDecreaseAtMs: heldDischargeW > 0 ? nowTs : lever.lastDecreaseAtMs,
    chargeRaisedAtMs: chargeW > Math.max(0, lever.setpointW) ? nowTs : lever.chargeRaisedAtMs,
    lastNeedAtMs: needed ? nowTs : lever.lastNeedAtMs,
  };
};

/** The discharge this battery was asked for and has not delivered yet, W, while its increase settles. */
const resolveCreditW = (storage: ObservedStorageInput, lever: StorageLeverState, nowTs: number): number => {
  if (!isCreditable(storage) || !isSettling(lever, nowTs)) return 0;
  return Math.max(0, -lever.setpointW - Math.max(-storage.signedPowerW, lever.creditBaseW));
};

/** Why the plan holds the battery this cycle, for the state log. */
const resolveClaimReason = (lever: StorageLeverState): StorageClaimReason => {
  if (lever.purpose === 'relief') return 'relief';
  return lever.setpointW < Math.max(0, lever.preClaimSignedW) ? 'cap_for_device' : 'raise_charge';
};

/** The release rule a hold that has had nothing to do answers to, and how long it waits. */
const resolveIdleRelease = (lever: StorageLeverState): { reason: StorageReleaseReason; afterMs: number } => (
  lever.purpose === 'relief'
    ? { reason: 'idle', afterMs: STORAGE_IDLE_RELEASE_MS }
    : { reason: 'surplus_dwell', afterMs: STORAGE_SURPLUS_RELEASE_DWELL_MS }
);

const NO_DECISION = { claim: 'none', decision: { kind: 'none' }, setpointW: 0, creditW: 0 } as const;

/** One cycle's decisions, accumulated battery by battery, and the relief they add up to. */
class StorageReliefCycle {
  readonly decisions = new Map<string, StorageDecision>();
  readonly levers: Record<string, StorageLeverState> = {};
  readonly batteries: StorageStateSummary[] = [];
  private creditW = 0;
  private releasedDischargeW = 0;
  private withheldW = 0;
  private drawMarginW = 0;

  constructor(
    public balance: StorageBalance,
    private readonly deviceDemand: SurplusDemand,
    /** The measured whole-home net this cycle, W: what the pool's add-back was asked with. */
    private readonly signedNetW: number,
    private readonly nowTs: number,
  ) {}

  release(deviceId: string, reason: StorageReleaseReason, dischargeW: number): StorageDecision {
    const decision: StorageDecision = { kind: 'release', reason };
    this.decisions.set(deviceId, decision);
    this.releasedDischargeW += Math.max(0, dischargeW);
    this.withheldW += Math.max(0, dischargeW);
    return decision;
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
    const observedDischargeW = -storage.signedPowerW;
    const summary = { deviceId, reading: 'observed' as const, claimHeld: storage.claimHeld };
    const addedBackW = storageChargeAddBackW(storage, previous, this.signedNetW);
    const step = this.resolveObservedStep(storage, previous);
    if (step.kind === 'release') {
      // Left to its own mode, it keeps the charge the pool counted: none of it is left for the next battery.
      this.balance = { ...this.balance, surplusW: this.balance.surplusW - addedBackW };
      if (previous === undefined && !storage.claimHeld) return { ...summary, ...NO_DECISION };
      const decision = this.release(deviceId, step.reason, observedDischargeW);
      return { ...summary, claim: 'none', decision, setpointW: 0, creditW: 0 };
    }
    const next = step.lever;
    const decision = this.holdSetpoint(deviceId, next);
    const nextDischargeW = -next.setpointW;
    const previousDischargeW = previous === undefined ? observedDischargeW : -previous.setpointW;
    const reliefW = Math.max(0, nextDischargeW - observedDischargeW);
    const creditW = resolveCreditW(storage, next, nowTs);
    this.balance = {
      deficitW: Math.max(0, this.balance.deficitW - reliefW),
      headroomW: Math.max(0, this.balance.headroomW - Math.max(0, previousDischargeW - nextDischargeW)),
      drawW: this.balance.drawW - reliefW,
      // What this battery left of the leftover, for the next one.
      surplusW: this.balance.surplusW - addedBackW + ownChargeWOf(storage) - Math.max(0, next.setpointW),
    };
    this.creditW += creditW;
    // Discharge held, and a charge increase the measurement does not show yet.
    this.withheldW += Math.max(0, nextDischargeW, observedDischargeW)
      + Math.max(0, next.setpointW - ownChargeWOf(storage));
    if (nextDischargeW > 0) this.drawMarginW = Math.max(this.drawMarginW, deadbandWFor(storage) / 2);
    return { ...summary, claim: resolveClaimReason(next), decision, setpointW: next.setpointW, creditW };
  }

  /**
   * A held battery with no reading this cycle: the last hold is kept,
   * uncredited, until it has gone unread for `STORAGE_INPUT_MISSING_RELEASE_MS`
   * or is no longer admissible, then released. Its discharge is counted as
   * handed back on the release cycle: whether it is still delivering is
   * unknown, and an unknown resolves toward shedding. Without a plan device to
   * carry a decision the hold is dropped once it expires, and said so. A
   * planned device without a storage cluster cannot say whether it is
   * admissible: its hold is kept for the window, then released.
   */
  decideUnread(
    deviceId: string,
    carrier: UnreadCarrier,
    previous: StorageLeverState | undefined,
  ): StorageStateSummary {
    const reading = carrier === 'absent' ? 'absent' as const : 'missing' as const;
    const summary = { deviceId, reading, claimHeld: true };
    if (previous === undefined) return { ...summary, ...NO_DECISION };
    const heldDischargeW = -previous.setpointW;
    const sinceMs = previous.reading.kind === 'unread' ? previous.reading.sinceMs : this.nowTs;
    const expired = this.nowTs - sinceMs >= STORAGE_INPUT_MISSING_RELEASE_MS;
    const admissible = carrier === 'absent' || carrier === 'no_input' || carrier.admissible;
    if (carrier !== 'absent' && (!admissible || expired)) {
      const reason = admissible ? 'input_missing' : 'not_admissible';
      const decision = this.release(deviceId, reason, heldDischargeW);
      return { ...summary, claim: 'none', decision, setpointW: 0, creditW: 0 };
    }
    const event = { deviceId, heldSetpointW: previous.setpointW };
    if (previous.reading.kind === 'read') logger.warn({ event: 'storage_relief_input_missing', ...event });
    if (carrier === 'absent' && expired) {
      logger.warn({ event: 'storage_relief_hold_dropped', ...event });
      return { ...summary, ...NO_DECISION };
    }
    const lever: StorageLeverState = { ...previous, reading: { kind: 'unread', sinceMs } };
    this.withheldW += Math.max(0, heldDischargeW);
    const held = { ...summary, claim: resolveClaimReason(lever), setpointW: lever.setpointW, creditW: 0 };
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
      withheldKw: this.withheldW / 1000,
      levers: this.levers,
      batteries: this.batteries,
    };
  }

  /**
   * Release a battery the plan may not hold, a surplus hold on a battery that
   * stopped taking charge, or one that has had nothing to do for its release
   * window (`resolveIdleRelease`); otherwise its next hold.
   */
  private resolveObservedStep(storage: ObservedStorageInput, previous: StorageLeverState | undefined): ObservedStep {
    const blocked = resolveBlockedReason(storage);
    if (blocked !== 'holdable') return { kind: 'release', reason: blocked };
    if (previous === undefined) {
      return startLever(storage, this.balance, this.deviceDemand, this.signedNetW, this.nowTs);
    }
    if (previous.purpose === 'surplus' && this.balance.deficitW <= 0 && !takesCharge(storage)) {
      return { kind: 'release', reason: 'full' };
    }
    const next = advanceLever(storage, previous, this.balance, this.deviceDemand, this.nowTs);
    const { reason, afterMs } = resolveIdleRelease(next);
    const idle = next.setpointW >= 0 && this.nowTs - next.lastNeedAtMs >= afterMs;
    return idle ? { kind: 'release', reason } : { kind: 'hold', lever: next };
  }
}

/**
 * Decide every battery's setpoint or hand-back for this measured cycle, and the
 * term shedding counts. Batteries take the deficit, and then the leftover
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
    drawW: power.drawKw * 1000,
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
  const decisions = new Map<string, StorageDecision>();
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
 * stage withholds (`StorageRelief.withheldKw`), so stored energy never admits
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
  if (relief.decisions.size === 0) return planDevices;
  return planDevices.map((device) => {
    const storageDecision = relief.decisions.get(device.id);
    if (storageDecision === undefined) return device;
    const decided: DevicePlanDevice & StoragePlanKind = { ...device, storageDecision };
    return decided;
  });
}
