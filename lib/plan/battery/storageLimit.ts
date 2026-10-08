/**
 * The two battery steps around restore that turn the plan's choices into
 * holds: the limit shedding chose at the battery's place in the priority
 * order (`applyStorageLimits`), and the hand-back the restore lane admitted in
 * priority order (`applyStorageHandBacks`). Neither selects anything: shedding
 * and restore decided, and these only carry the decision onto the battery's
 * hold (`StorageLeverState`) and its `StorageDecision`, which the executor's
 * storage lane carries out unchanged.
 */
import { spendPowerHeadroom } from '../powerLimitMath';
import type { MeasuredPower } from '../planContext';
import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageSetpoint } from '../shedding/types';
import { STORAGE_RELIEF_SETTLE_WINDOW_MS, ownDischargeWOf } from './storageLadder';
import {
  isSettling,
  sumWithheldKw,
  resolveOwnModeChargeW,
  summarizeHold,
  type StorageRelief,
  type StorageStateSummary,
} from './storageRelief';

/**
 * The limit hold at the setpoint shedding chose. A discharge asked for opens
 * its credit's settle window, unless an earlier one is still settling: then it
 * keeps that window's stamp and base, so an increase that never landed is not
 * credited twice. Only discharge is credited this way (`creditBaseW` 0 or
 * more); a stopped charge is pending relief's. A hold that only caps the charge
 * has no discharge to settle. A surplus hold shedding chooses becomes a limit
 * hold, and keeps the charge its own mode took when PELS first claimed it.
 *
 * An unbanked ask (a re-probing battery, or one not following its limit)
 * credits nothing: its credit base is the discharge it now asks for, and it
 * keeps the last cycle shedding banked it, so a battery that does not follow
 * is never credited again by being asked again.
 */
const toLimitLever = (
  previous: StorageLeverState | undefined,
  chosen: StorageSetpoint,
  nowTs: number,
): StorageLeverState => {
  const { setpointW, banked, storage } = chosen;
  const preClaimSignedW = previous?.preClaimSignedW ?? storage.signedPowerW;
  return {
    setpointW,
    purpose: 'limit',
    ...resolveCreditWindow(previous, chosen, nowTs),
    lastDecreaseAtMs: previous?.lastDecreaseAtMs ?? nowTs,
    chargeRaisedAtMs: previous?.chargeRaisedAtMs ?? nowTs,
    lastNeedAtMs: banked ? nowTs : (previous?.lastNeedAtMs ?? nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS),
    preClaimSignedW,
    ownModeChargeW: resolveOwnModeChargeW(storage, preClaimSignedW),
    stepW: storage.range.stepW,
    reading: { kind: 'read' },
  };
};

/** The credit window a limit hold at this setpoint carries (`toLimitLever`). */
const resolveCreditWindow = (
  previous: StorageLeverState | undefined,
  chosen: StorageSetpoint,
  nowTs: number,
): Pick<StorageLeverState, 'increaseDecidedAtMs' | 'creditBaseW'> => {
  const closedAtMs = nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS;
  if (chosen.setpointW >= 0) return { increaseDecidedAtMs: closedAtMs, creditBaseW: 0 };
  if (!chosen.banked) {
    return { increaseDecidedAtMs: previous?.increaseDecidedAtMs ?? closedAtMs, creditBaseW: -chosen.setpointW };
  }
  if (previous !== undefined && previous.purpose === 'limit' && isSettling(previous, nowTs)) {
    return { increaseDecidedAtMs: previous.increaseDecidedAtMs, creditBaseW: previous.creditBaseW };
  }
  const heldDischargeW = previous === undefined ? 0 : Math.max(0, -previous.setpointW);
  return { increaseDecidedAtMs: nowTs, creditBaseW: Math.max(ownDischargeWOf(chosen.storage), heldDischargeW) };
};

/**
 * Hold every battery shedding chose this cycle at the setpoint it was spent
 * at (`SheddingPlan.storageSetpoints`), which carries the battery as its
 * candidate read it. A candidate is an observed battery, which the storage
 * stage summarized this cycle, so its summary is replaced in place.
 */
export function applyStorageLimits(
  relief: StorageRelief,
  storageSetpoints: ReadonlyMap<string, StorageSetpoint>,
  nowTs: number,
): StorageRelief {
  if (storageSetpoints.size === 0) return relief;
  const limits = new Map([...storageSetpoints].map(([deviceId, chosen]) => (
    [deviceId, { storage: chosen.storage, lever: toLimitLever(relief.levers[deviceId], chosen, nowTs) }] as const
  )));
  return {
    ...relief,
    levers: { ...relief.levers, ...Object.fromEntries([...limits].map(([deviceId, { lever }]) => [deviceId, lever])) },
    batteries: relief.batteries.map((battery): StorageStateSummary => {
      const limit = limits.get(battery.deviceId);
      // Selection banked this cycle's relief already: nothing more to credit now.
      return limit === undefined ? battery : summarizeHold(battery.deviceId, limit.storage, limit.lever, 0);
    }),
  };
}

/** Hand back every battery the restore lane admitted (`restored`). */
export function applyStorageHandBacks(
  relief: StorageRelief,
  handedBack: ReadonlySet<string>,
): StorageRelief {
  if (handedBack.size === 0) return relief;
  const released: StorageDecision = { kind: 'release', reason: 'restored' };
  return {
    ...relief,
    levers: Object.fromEntries(Object.entries(relief.levers).filter(([deviceId]) => !handedBack.has(deviceId))),
    batteries: relief.batteries.map((battery): StorageStateSummary => (handedBack.has(battery.deviceId)
      ? { ...battery, claim: 'none', decision: released, setpointW: 0, heldBackChargeW: 0, creditW: 0 }
      : battery)),
  };
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
    headroomKw: spendPowerHeadroom(power.headroomKw, withheldKw),
    capacityHeadroomKw: spendPowerHeadroom(power.capacityHeadroomKw, withheldKw),
    gridHeadroomKw: spendPowerHeadroom(power.gridHeadroomKw, withheldKw),
    budgetHeadroomKw: spendPowerHeadroom(power.budgetHeadroomKw, withheldKw),
  };
}

