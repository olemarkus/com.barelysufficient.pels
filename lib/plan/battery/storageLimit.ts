/**
 * The two battery steps around restore that turn the plan's choices into
 * holds: the limit shedding chose at the battery's place in the priority
 * order (`applyStorageLimits`), and the hand-back the restore lane admitted in
 * priority order (`applyStorageHandBacks`). Neither selects anything: shedding
 * and restore decided, and these only carry the decision onto the battery's
 * hold (`StorageLeverState`) and its `StorageDecision`, which the executor's
 * storage lane carries out unchanged.
 */
import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import type { StorageSetpoint } from '../shedding/types';
import { STORAGE_RELIEF_SETTLE_WINDOW_MS, hasStorageInput, ownDischargeWOf } from './storageLadder';
import {
  isSettling,
  resolveClaimReason,
  resolveHeldBackChargeW,
  resolveOwnModeChargeW,
  resolveWithheldW,
  sumWithheldKw,
  type StorageRelief,
  type StorageStateSummary,
} from './storageRelief';

/** An observed battery this cycle's plan carries, by id. */
const findObservedStorage = (
  devices: readonly PlanInputDevice[],
  deviceId: string,
): ObservedStorageInput | null => {
  const device = devices.find((entry) => entry.id === deviceId);
  if (device === undefined || !hasStorageInput(device) || device.storage.reading !== 'observed') return null;
  return device.storage;
};

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
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  chosen: StorageSetpoint,
  nowTs: number,
): StorageLeverState => {
  const { setpointW, banked } = chosen;
  const preClaimSignedW = previous?.preClaimSignedW ?? storage.signedPowerW;
  return {
    setpointW,
    purpose: 'limit',
    ...resolveCreditWindow(storage, previous, chosen, nowTs),
    lastDecreaseAtMs: previous?.lastDecreaseAtMs ?? nowTs,
    chargeRaisedAtMs: previous?.chargeRaisedAtMs ?? nowTs,
    lastNeedAtMs: banked ? nowTs : (previous?.lastNeedAtMs ?? nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS),
    preClaimSignedW,
    ownModeChargeW: resolveOwnModeChargeW(storage, preClaimSignedW),
    stepW: storage.stepW,
    reading: { kind: 'read' },
  };
};

/** The credit window a limit hold at this setpoint carries (`toLimitLever`). */
const resolveCreditWindow = (
  storage: ObservedStorageInput,
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
  return { increaseDecidedAtMs: nowTs, creditBaseW: Math.max(ownDischargeWOf(storage), heldDischargeW) };
};

/** A setpoint decision for a hold. */
const toSetpointDecision = (lever: StorageLeverState): StorageDecision => (
  { kind: 'setpoint', setpointW: lever.setpointW, stepW: lever.stepW }
);

/** The relief with some batteries' holds, decisions and summaries replaced. */
const withBatteries = (
  relief: StorageRelief,
  levers: Readonly<Record<string, StorageLeverState>>,
  decisions: ReadonlyMap<string, StorageDecision>,
  summaries: ReadonlyMap<string, StorageStateSummary>,
): StorageRelief => {
  const batteries = [
    ...relief.batteries.map((battery) => summaries.get(battery.deviceId) ?? battery),
    ...[...summaries.values()].filter((summary) => !relief.batteries.some((b) => b.deviceId === summary.deviceId)),
  ];
  return {
    ...relief,
    levers,
    decisions,
    batteries,
    withheldKw: sumWithheldKw(batteries),
  };
};

/**
 * Hold every battery shedding chose this cycle at the setpoint it was spent
 * at (`SheddingPlan.storageSetpoints`). Only a battery that was a candidate
 * this cycle can be chosen, so it is observed and holdable; one that is not is
 * left as the storage stage decided it.
 */
export function applyStorageLimits(
  relief: StorageRelief,
  devices: readonly PlanInputDevice[],
  storageSetpoints: ReadonlyMap<string, StorageSetpoint>,
  nowTs: number,
): StorageRelief {
  if (storageSetpoints.size === 0) return relief;
  const limits = [...storageSetpoints].flatMap(([deviceId, chosen]) => {
    const storage = findObservedStorage(devices, deviceId);
    if (storage === null) return [];
    const lever = toLimitLever(storage, relief.levers[deviceId], chosen, nowTs);
    const { setpointW } = chosen;
    const decision = toSetpointDecision(lever);
    const summary: StorageStateSummary = {
      deviceId,
      reading: 'observed',
      claimHeld: storage.claimHeld,
      // Limited, so its Power-limit control is on.
      solarOnly: false,
      claim: resolveClaimReason(lever),
      decision,
      setpointW,
      heldBackChargeW: resolveHeldBackChargeW(lever),
      // Selection banked this cycle's relief already: nothing more to credit now.
      creditW: 0,
      withheldW: resolveWithheldW(storage, setpointW),
    };
    return [{ lever, decision, summary }];
  });
  return withBatteries(
    relief,
    { ...relief.levers, ...Object.fromEntries(limits.map(({ lever, summary }) => [summary.deviceId, lever])) },
    new Map([...relief.decisions, ...limits.map(({ decision, summary }) => [summary.deviceId, decision] as const)]),
    new Map(limits.map(({ summary }) => [summary.deviceId, summary])),
  );
}

/** Hand back every battery the restore lane admitted (`restored`). */
export function applyStorageHandBacks(
  relief: StorageRelief,
  handedBack: ReadonlySet<string>,
): StorageRelief {
  if (handedBack.size === 0) return relief;
  const released: StorageDecision = { kind: 'release', reason: 'restored' };
  const summaries = relief.batteries
    .filter((battery) => handedBack.has(battery.deviceId))
    .map((battery): StorageStateSummary => ({
      ...battery, claim: 'none', decision: released, setpointW: 0, heldBackChargeW: 0, creditW: 0,
    }));
  return withBatteries(
    relief,
    Object.fromEntries(Object.entries(relief.levers).filter(([deviceId]) => !handedBack.has(deviceId))),
    new Map([...relief.decisions, ...summaries.map((summary) => [summary.deviceId, released] as const)]),
    new Map(summaries.map((summary) => [summary.deviceId, summary])),
  );
}
