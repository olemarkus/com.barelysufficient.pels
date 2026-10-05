/**
 * Storage relief: a home battery spends stored energy against the deficit
 * BEFORE shedding selection spends the owner's comfort (owner ruling,
 * 2026-10-05). It relieves whichever pace binds — the measured headroom is
 * against `softLimit = min(capacity, daily)` — exhausted hour included.
 *
 * The battery protects devices that are ALREADY running. Its discharge never
 * creates headroom for restoring more: restore and admission see the headroom
 * less the discharge PELS holds (`withoutHeldStorageDischarge`). Every
 * uncertainty resolves toward shedding and toward handing the battery back.
 *
 * The battery is never a shed candidate. It stays observe-only with no command
 * authority; this stage alone reads its storage cluster (`StoragePlanInputKind`)
 * and decides a signed setpoint or a hand-back, which the executor's storage
 * lane carries out (`lib/executor/batteryExecutor.ts`).
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
 * runs. This slice never charges: a setpoint is at most 0 W.
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
 * **Release.** A held battery is handed back when it has had nothing to do for
 * `STORAGE_IDLE_RELEASE_MS`, when it is no longer admissible (opted out, its
 * claim lost), when it is not responding or its sign is inverted, after
 * `STORAGE_INPUT_MISSING_RELEASE_MS` without a reading, and on meter silence
 * (`releaseStorageOnSilentMeter`). The cycle that releases a discharging
 * battery counts that discharge as deficit, so shedding is ready before the
 * import lands. Capacity simulation writes nothing, so the planner decides
 * nothing for a battery then (`NO_STORAGE_RELIEF`); the battery's owner hands
 * a held one back itself.
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
import type { MeasuredPower } from '../planContext';
import type { StorageLeverState } from '../planState';
import type { DevicePlanDevice, PlanInputDevice } from '../planTypes';
import { NO_STORAGE_SHED_TERM, type StorageShedTerm } from '../shedding/types';

const logger = getLogger('plan/battery');

/** How long an increase's undelivered discharge is credited to shedding. */
export const STORAGE_RELIEF_SETTLE_WINDOW_MS = 30 * 1000;
/** How long a claimed battery may have nothing to do before it is handed back. */
export const STORAGE_IDLE_RELEASE_MS = 10 * 60 * 1000;
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

/** One battery as this cycle left it, for the state log. */
export type StorageStateSummary = {
  deviceId: string;
  reading: 'observed' | 'missing' | 'absent';
  claimHeld: boolean;
  decision: StorageDecision | { kind: 'none' };
  /** The discharge this cycle decided to hold, W. */
  dischargeW: number;
  creditW: number;
};

/** What the stage decided this cycle. */
export type StorageRelief = {
  decisions: ReadonlyMap<string, StorageDecision>;
  /** What shedding counts against the measured deficit. */
  shed: StorageShedTerm;
  /**
   * Discharge PELS holds or is handing back this cycle, kW: headroom restore
   * and admission must not spend, because it is stored energy, not room.
   */
  heldDischargeKw: number;
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
  heldDischargeKw: 0,
  levers: Object.freeze({}),
  batteries: [],
});

/**
 * A held battery this cycle has no reading for, as the plan carries it: not
 * planned at all (`absent`), planned without a storage cluster (`no_input`), or
 * planned with a cluster that reads `missing`.
 */
type UnreadCarrier = 'absent' | 'no_input' | MissingStorageInput;

/** The deficit still to cover and the headroom still to give back, W, as each battery takes its share. */
type StorageBalance = { deficitW: number; headroomW: number; drawW: number };

/** What the plan does with an observed battery this cycle. */
type ObservedStep = { kind: 'release'; reason: StorageReleaseReason } | { kind: 'hold'; lever: StorageLeverState };

const deadbandWFor = (storage: ObservedStorageInput): number => Math.max(storage.stepW, STORAGE_MIN_DEADBAND_W);

/** The signed setpoint for a discharge, W: its negation, and a plain 0 rather than -0. */
const toSetpointW = (dischargeW: number): number => (dischargeW === 0 ? 0 : -dischargeW);

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
 * The discharge a deficit asks of this battery, W: its own, plus the deficit
 * and half the deadband (the increase's hysteresis), within its delivery
 * ceiling and the house's draw less half the deadband.
 */
const resolveWantedDischargeW = (storage: ObservedStorageInput, balance: StorageBalance): number => {
  const halfDeadbandW = deadbandWFor(storage) / 2;
  const reliefW = Math.min(balance.deficitW + halfDeadbandW, Math.max(0, balance.drawW - halfDeadbandW));
  return Math.round(Math.min(storage.deliveryCeilingW, Math.max(0, -storage.signedPowerW + reliefW)));
};

/** Whether raising from `fromW` to `wantedW` is a step the battery could visibly answer. */
const isRaiseWorthIt = (storage: ObservedStorageInput, fromW: number, wantedW: number): boolean => (
  wantedW - fromW >= storageSetpointToleranceW(-wantedW, storage.stepW)
);

/**
 * Step the setpoint down, when pacing allows: to 0 W once the discharge the
 * house needs is under the deadband, else past the deadband, leaving the
 * deadband as headroom.
 */
const resolveLoweredDischargeW = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  nowTs: number,
): number => {
  if (isSettling(lever, nowTs) || nowTs - lever.lastDecreaseAtMs < STORAGE_DECREASE_MIN_INTERVAL_MS) {
    return lever.dischargeW;
  }
  const deadbandW = deadbandWFor(storage);
  const baseW = Math.min(lever.dischargeW, -storage.signedPowerW);
  if (baseW - balance.headroomW < deadbandW) return 0;
  if (balance.headroomW <= deadbandW) return lever.dischargeW;
  return Math.round(Math.max(0, Math.min(lever.dischargeW, baseW - (balance.headroomW - deadbandW))));
};

/** Start driving a battery on a deficit; with no relief to give, the battery is left alone (`idle`). */
const startLever = (storage: ObservedStorageInput, balance: StorageBalance, nowTs: number): ObservedStep => {
  const idle: ObservedStep = { kind: 'release', reason: 'idle' };
  if (balance.deficitW <= 0) return idle;
  const wantedW = resolveWantedDischargeW(storage, balance);
  // Relief exists when the setpoint asks visibly more than the battery does now
  // (a charging battery stopped at 0 W is relief too).
  if (!isRaiseWorthIt(storage, -storage.signedPowerW, wantedW)) return idle;
  return {
    kind: 'hold',
    lever: {
      dischargeW: wantedW,
      increaseDecidedAtMs: nowTs,
      creditBaseW: -storage.signedPowerW,
      lastDecreaseAtMs: nowTs,
      lastNeedAtMs: nowTs,
      preClaimSignedW: storage.signedPowerW,
      stepW: storage.stepW,
      reading: { kind: 'read' },
    },
  };
};

/** The next hold on a battery the plan is driving: raised on a deficit, lowered on headroom. */
const advanceLever = (
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  balance: StorageBalance,
  nowTs: number,
): StorageLeverState => {
  const reading = { ...lever, stepW: storage.stepW, reading: { kind: 'read' as const } };
  if (balance.deficitW > 0) {
    const wantedW = resolveWantedDischargeW(storage, balance);
    if (!isRaiseWorthIt(storage, lever.dischargeW, wantedW)) {
      return { ...reading, dischargeW: Math.min(lever.dischargeW, storage.deliveryCeilingW), lastNeedAtMs: nowTs };
    }
    // A new window only once the last one is over, and credited only above what
    // was already asked: an increase that never landed is not credited twice.
    const restamp = !isSettling(lever, nowTs);
    return {
      ...reading,
      dischargeW: wantedW,
      increaseDecidedAtMs: restamp ? nowTs : lever.increaseDecidedAtMs,
      creditBaseW: restamp ? Math.max(-storage.signedPowerW, lever.dischargeW) : lever.creditBaseW,
      lastNeedAtMs: nowTs,
    };
  }
  const loweredW = Math.min(resolveLoweredDischargeW(storage, lever, balance, nowTs), storage.deliveryCeilingW);
  // Needed through the cycle it stops discharging, and while it holds a battery
  // that was charging at 0 W in a house with no room for that charge again.
  const holdsBackCharge = loweredW === 0
    && balance.headroomW < Math.max(0, lever.preClaimSignedW) + deadbandWFor(storage);
  return {
    ...reading,
    dischargeW: loweredW,
    lastDecreaseAtMs: loweredW < lever.dischargeW ? nowTs : lever.lastDecreaseAtMs,
    lastNeedAtMs: loweredW > 0 || lever.dischargeW > 0 || holdsBackCharge ? nowTs : lever.lastNeedAtMs,
  };
};

/** The discharge this battery was asked for and has not delivered yet, W, while its increase settles. */
const resolveCreditW = (storage: ObservedStorageInput, lever: StorageLeverState, nowTs: number): number => {
  if (!isCreditable(storage) || !isSettling(lever, nowTs)) return 0;
  return Math.max(0, lever.dischargeW - Math.max(-storage.signedPowerW, lever.creditBaseW));
};

const NO_DECISION = { decision: { kind: 'none' }, dischargeW: 0, creditW: 0 } as const;

/** One cycle's decisions, accumulated battery by battery, and the relief they add up to. */
class StorageReliefCycle {
  readonly decisions = new Map<string, StorageDecision>();
  readonly levers: Record<string, StorageLeverState> = {};
  readonly batteries: StorageStateSummary[] = [];
  private creditW = 0;
  private releasedDischargeW = 0;
  private heldDischargeW = 0;
  private drawMarginW = 0;

  constructor(public balance: StorageBalance, private readonly nowTs: number) {}

  release(deviceId: string, reason: StorageReleaseReason, dischargeW: number): StorageDecision {
    const decision: StorageDecision = { kind: 'release', reason };
    this.decisions.set(deviceId, decision);
    this.releasedDischargeW += Math.max(0, dischargeW);
    this.heldDischargeW += Math.max(0, dischargeW);
    return decision;
  }

  /** Keep the hold, and carry it to the battery as a setpoint. */
  holdSetpoint(deviceId: string, lever: StorageLeverState): StorageDecision {
    this.levers[deviceId] = lever;
    const setpointW = toSetpointW(lever.dischargeW);
    const decision: StorageDecision = { kind: 'setpoint', setpointW, stepW: lever.stepW };
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
    const step = this.resolveObservedStep(storage, previous);
    if (step.kind === 'release') {
      if (previous === undefined && !storage.claimHeld) return { ...summary, ...NO_DECISION };
      const decision = this.release(deviceId, step.reason, observedDischargeW);
      return { ...summary, decision, dischargeW: 0, creditW: 0 };
    }
    const next = step.lever;
    const decision = this.holdSetpoint(deviceId, next);
    const reliefW = Math.max(0, next.dischargeW - observedDischargeW);
    const creditW = resolveCreditW(storage, next, nowTs);
    this.balance = {
      deficitW: Math.max(0, this.balance.deficitW - reliefW),
      headroomW: Math.max(0, this.balance.headroomW - Math.max(0, (previous?.dischargeW ?? 0) - next.dischargeW)),
      drawW: this.balance.drawW - reliefW,
    };
    this.creditW += creditW;
    this.heldDischargeW += Math.max(next.dischargeW, observedDischargeW);
    if (next.dischargeW > 0) this.drawMarginW = Math.max(this.drawMarginW, deadbandWFor(storage) / 2);
    return { ...summary, decision, dischargeW: next.dischargeW, creditW };
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
    const sinceMs = previous.reading.kind === 'unread' ? previous.reading.sinceMs : this.nowTs;
    const expired = this.nowTs - sinceMs >= STORAGE_INPUT_MISSING_RELEASE_MS;
    const admissible = carrier === 'absent' || carrier === 'no_input' || carrier.admissible;
    if (carrier !== 'absent' && (!admissible || expired)) {
      const reason = admissible ? 'input_missing' : 'not_admissible';
      return { ...summary, decision: this.release(deviceId, reason, previous.dischargeW), dischargeW: 0, creditW: 0 };
    }
    const event = { deviceId, heldDischargeW: previous.dischargeW };
    if (previous.reading.kind === 'read') logger.warn({ event: 'storage_relief_input_missing', ...event });
    if (carrier === 'absent' && expired) {
      logger.warn({ event: 'storage_relief_hold_dropped', ...event });
      return { ...summary, ...NO_DECISION };
    }
    const lever: StorageLeverState = { ...previous, reading: { kind: 'unread', sinceMs } };
    this.heldDischargeW += lever.dischargeW;
    if (carrier === 'absent') {
      // No plan device carries a decision: the hold alone is kept.
      this.levers[deviceId] = lever;
      return { ...summary, decision: { kind: 'none' }, dischargeW: lever.dischargeW, creditW: 0 };
    }
    return { ...summary, decision: this.holdSetpoint(deviceId, lever), dischargeW: lever.dischargeW, creditW: 0 };
  }

  record(summary: StorageStateSummary): void {
    this.batteries.push(summary);
  }

  toRelief(): StorageRelief {
    return {
      decisions: this.decisions,
      shed: {
        netCreditKw: (this.creditW - this.releasedDischargeW) / 1000,
        relieving: Object.values(this.levers).some((lever) => lever.dischargeW > 0),
        drawMarginKw: this.drawMarginW / 1000,
      },
      heldDischargeKw: this.heldDischargeW / 1000,
      levers: this.levers,
      batteries: this.batteries,
    };
  }

  /**
   * Release a battery the plan may not hold, or that has had nothing to do for
   * `STORAGE_IDLE_RELEASE_MS`; otherwise its next hold.
   */
  private resolveObservedStep(storage: ObservedStorageInput, previous: StorageLeverState | undefined): ObservedStep {
    const blocked = resolveBlockedReason(storage);
    if (blocked !== 'holdable') return { kind: 'release', reason: blocked };
    if (previous === undefined) return startLever(storage, this.balance, this.nowTs);
    const next = advanceLever(storage, previous, this.balance, this.nowTs);
    const idle = next.dischargeW === 0 && this.nowTs - next.lastNeedAtMs >= STORAGE_IDLE_RELEASE_MS;
    return idle ? { kind: 'release', reason: 'idle' } : { kind: 'hold', lever: next };
  }
}

/**
 * Decide every battery's setpoint or hand-back for this measured cycle, and the
 * term shedding counts. Batteries take the deficit in plan order, each covering
 * what the ones before it left open.
 */
export function decideStorageRelief(
  devices: readonly PlanInputDevice[],
  power: MeasuredPower,
  levers: Readonly<Record<string, StorageLeverState>>,
  nowTs: number,
): StorageRelief {
  const cycle = new StorageReliefCycle({
    deficitW: Math.max(0, -power.headroomKw * 1000),
    headroomW: Math.max(0, power.headroomKw * 1000),
    drawW: power.drawKw * 1000,
  }, nowTs);
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
 * The measurement as restore and admission see it: the headroom less the
 * discharge PELS holds, so stored energy never admits a device. The draw stays
 * the measured one.
 */
export function withoutHeldStorageDischarge(power: MeasuredPower, relief: StorageRelief): MeasuredPower {
  const heldKw = relief.heldDischargeKw;
  if (heldKw <= 0) return power;
  return {
    ...power,
    headroomKw: power.headroomKw - heldKw,
    capacityHeadroomKw: power.capacityHeadroomKw - heldKw,
    budgetHeadroomKw: power.budgetHeadroomKw === null ? null : power.budgetHeadroomKw - heldKw,
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
