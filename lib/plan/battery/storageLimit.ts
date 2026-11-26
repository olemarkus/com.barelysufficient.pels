/** Materialize the signed limit and managed-idle restore selected by the planner. */
import type { PhaseFootprint } from '../../../packages/planner-types/src/phaseFootprint';
import type { PlanInputDevice } from '../planTypes';
import { withholdPhaseRoom } from '../phase/phasePower';
import { spendLimitHeadroom } from '../planContext';
import type { MeasuredPower } from '../planContext';
import type { StorageLeverState } from '../planState';
import type { StorageSetpoint } from '../shedding/types';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS, hasStorageLeverInput, isStorageDrivable, ownDischargeWOf,
} from './storageLadder';
import { baselineLever, resolveEconomicResumeIncreaseW } from './storageContinuous';
import {
  isSettling,
  sumWithheldKw,
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
 * hold, and keeps the timing of its prior requests.
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
  return {
    setpointW,
    purpose: 'limit',
    ...resolveCreditWindow(previous, chosen, nowTs),
    lastDecreaseAtMs: previous?.lastDecreaseAtMs ?? nowTs,
    chargeRaisedAtMs: previous?.chargeRaisedAtMs ?? nowTs,
    lastNeedAtMs: banked ? nowTs : (previous?.lastNeedAtMs ?? nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS),
    limitedChargeW: previous?.purpose === 'limit' ? previous.limitedChargeW : Math.max(0, storage.signedPowerW),
    stepW: storage.range.stepW,
    reading: { kind: 'read' },
    ...(chosen.exportPhase === undefined ? {} : {
      exportPhase: chosen.exportPhase,
      economicResumeIncreaseW: resolveEconomicResumeIncreaseW(storage, setpointW, nowTs),
    }),
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

/** Leave the capacity hold at idle. Routine solar or economic dispatch can
 * take over on the next measured cycle, through its normal admission gates.
 */
export function resumeStorageAfterLimit(
  relief: StorageRelief,
  restored: ReadonlySet<string>,
  devices: readonly PlanInputDevice[],
  nowTs: number,
): StorageRelief {
  if (restored.size === 0) return relief;
  const resumed = new Map(devices.flatMap((device) => {
    if (!restored.has(device.id) || !hasStorageLeverInput(device)
      || device.storage.reading !== 'observed' || !isStorageDrivable(device.storage)) return [];
    const lever = baselineLever(device.storage, relief.levers[device.id], 0, nowTs);
    return [[device.id, { storage: device.storage, lever }] as const];
  }));
  return {
    ...relief,
    levers: {
      ...relief.levers, ...Object.fromEntries([...resumed].map(([deviceId, { lever }]) => [deviceId, lever])),
    },
    batteries: relief.batteries.map((battery): StorageStateSummary => {
      const restoredBattery = resumed.get(battery.deviceId);
      if (restoredBattery === undefined) return battery;
      const summary = summarizeHold(battery.deviceId, restoredBattery.storage, restoredBattery.lever, 0);
      return {
        ...summary,
        decision: { kind: 'setpoint', setpointW: 0, stepW: restoredBattery.lever.stepW, restored: true },
      };
    }),
  };
}

/**
 * The measurement as restore and admission see it: the headroom less what the
 * batteries withhold (`StorageStateSummary.withheldW`), so stored energy never
 * admits a device and a charge increase never meets a restore on the same
 * room. The draw stays the measured one.
 */
export function withoutStorageWithheld(
  power: MeasuredPower,
  relief: StorageRelief,
  devices: readonly Pick<PlanInputDevice, 'id' | 'phaseFootprint'>[],
  /**
   * In capacity simulation, what the held batteries would deliver that the
   * reading does not show (`simulateFollowedHolds`), W: live control's reading
   * would already have that room, before its discharge is withheld. 0 live.
   */
  simulatedUndeliveredW: number,
): MeasuredPower {
  const withheldKw = sumWithheldKw(relief.batteries) - simulatedUndeliveredW / 1000;
  if (withheldKw === 0) return power;
  const footprintOf = (deviceId: string): PhaseFootprint => (
    devices.find((device) => device.id === deviceId)?.phaseFootprint ?? { kind: 'unknown' }
  );
  let { phase } = power;
  for (const battery of relief.batteries) {
    phase = withholdPhaseRoom(phase, footprintOf(battery.deviceId), battery.withheldW / 1000);
  }
  return {
    ...power,
    phase,
    headroom: spendLimitHeadroom(power.headroom, withheldKw),
    capacityHeadroom: spendLimitHeadroom(power.capacityHeadroom, withheldKw),
    gridHeadroom: spendLimitHeadroom(power.gridHeadroom, withheldKw),
    budgetHeadroom: spendLimitHeadroom(power.budgetHeadroom, withheldKw),
  };
}

/**
 * In capacity simulation nothing is sent, so a held battery never moves to its
 * setpoint and the reading never shows it. Each held battery is read as if it
 * had followed its last setpoint, as it would under live control, and the
 * difference is what the reading is missing, W: the storage stage's room and
 * import, and shedding's credit, count it as delivered. The battery's measured
 * reading stays as it is outside this cycle's storage and shedding stages.
 */
export function simulateFollowedHolds(
  devices: readonly PlanInputDevice[],
  levers: Readonly<Record<string, StorageLeverState>>,
): { devices: readonly PlanInputDevice[]; undeliveredW: number } {
  let undeliveredW = 0;
  const followed = devices.map((device) => {
    const lever = levers[device.id];
    if (lever === undefined || !hasStorageLeverInput(device) || device.storage.reading !== 'observed') return device;
    undeliveredW += device.storage.signedPowerW - lever.setpointW;
    return { ...device, storage: { ...device.storage, signedPowerW: lever.setpointW } };
  });
  return { devices: followed, undeliveredW };
}
