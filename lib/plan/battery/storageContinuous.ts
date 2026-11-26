import type { ContinuousStoragePlan, ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageLeverState } from '../planState';
import type { StorageSurplusOffer } from '../planSurplusAbsorb';
import { floorStorageSetpointW } from '../../utils/storageSetpoint';
import { storageSetpointToleranceW } from '../../planContract/storageDecision';
import { startContinuousLever } from './storageHold';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS, deadbandWFor, drawMarginWFor, isRaiseVisible, ownChargeWOf, ownDischargeWOf,
} from './storageLadder';
import type { StorageBalance } from './storageReliefTypes';
import { SURPLUS_TRACK_STEP_MIN_INTERVAL_MS } from '../admission';

function dischargeCredit(
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  setpointW: number,
  nowTs: number,
): Pick<StorageLeverState, 'increaseDecidedAtMs' | 'creditBaseW'> {
  const observedW = ownDischargeWOf(storage);
  if (setpointW >= 0) return { increaseDecidedAtMs: nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS, creditBaseW: 0 };
  if (previous === undefined) return { increaseDecidedAtMs: nowTs, creditBaseW: observedW };
  const requestedW = Math.max(0, -previous.setpointW);
  const open = nowTs - previous.increaseDecidedAtMs < STORAGE_RELIEF_SETTLE_WINDOW_MS;
  const unanswered = requestedW - observedW > storageSetpointToleranceW(previous.setpointW, previous.stepW);
  if (-setpointW <= requestedW || open || unanswered) {
    return { increaseDecidedAtMs: previous.increaseDecidedAtMs, creditBaseW: previous.creditBaseW };
  }
  return { increaseDecidedAtMs: nowTs, creditBaseW: Math.max(observedW, requestedW) };
}

/**
 * The Main-meter export a period may add on top of covering the house, W. Only a
 * selling period carries the owner's ceiling; household supply stops at the
 * house's measured draw. Measured demand can take part or all of a planned
 * sale: the lever never raises discharge to keep a forecast export quantity.
 */
const exportAllowanceW = (plan: ContinuousStoragePlan): number => (
  plan.reason === 'export_energy' ? plan.netExportCeilingW : 0
);

/**
 * The most discharge a period's plan asks for, W. A household-supply period
 * asks for whatever the house draws: its planned power is the forecast of that
 * draw, and a house that draws more than forecast (an oven in an expensive
 * hour) is still the house the period decided to supply, so the measured draw,
 * the delivery ceiling and the reserve bound it instead. The next plan starts
 * from the level the battery reaches. A selling period keeps its planned
 * power: its export is a forecast quantity the lever never raises.
 */
const plannedDischargeW = (plan: ContinuousStoragePlan): number => (
  plan.reason === 'supply_house' ? Number.POSITIVE_INFINITY : -plan.setpointW
);

/** Maximum extra discharge the current economic period could resume after a phase hold. */
export function resolveEconomicResumeIncreaseW(
  storage: ObservedStorageInput,
  heldSetpointW: number,
  nowTs: number,
): number {
  const plan = storage.continuousPlan;
  if (plan === undefined || plan.validUntilMs <= nowTs || plan.setpointW >= 0) return 0;
  const requestedW = Math.min(plannedDischargeW(plan), storage.deliveryCeilingW);
  const alreadyDischargingW = Math.max(0, -Math.max(storage.signedPowerW, heldSetpointW));
  return Math.max(0, requestedW - alreadyDischargingW);
}

/**
 * A battery reading older than the meter sample by more than this, ms, lags it.
 * The house's draw without the battery is the meter less the battery's own
 * power; with a lagging battery reading that difference mixes two moments, and
 * a battery that has since cut its discharge would read as house demand.
 * Batteries report less often than meters, so a strict "older than" would
 * freeze discharge between battery reports.
 */
export const STORAGE_READING_LAG_TOLERANCE_MS = 15_000;

/**
 * The most discharge a plan may ask for this cycle, W. A lagging reading may
 * hold a discharge but never raise it: no more than the battery is observed
 * delivering. A battery that already sits at the setpoint PELS holds it to is
 * the exception: Homey stamps a reading only when it changes, so a battery
 * steady at its setpoint reads old while being exactly where it was put, and
 * bounding it would freeze its discharge for good.
 */
const laggingDischargeCeilingW = (
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  balance: StorageBalance,
): number => {
  if (balance.sampledAtMs - storage.observedAtMs <= STORAGE_READING_LAG_TOLERANCE_MS) return Number.POSITIVE_INFINITY;
  const atHeldSetpoint = previous !== undefined && Math.abs(storage.signedPowerW - previous.setpointW)
    <= storageSetpointToleranceW(previous.setpointW, previous.stepW);
  return atHeldSetpoint ? Number.POSITIVE_INFINITY : ownDischargeWOf(storage);
};

/**
 * What the battery's offer leaves for its charge, W: what the consumers ranked
 * above it left, less what the pool already counted of its own charge, plus
 * that charge, less the draw margin.
 */
const offeredChargeW = (
  storage: ObservedStorageInput,
  offer: Pick<StorageSurplusOffer, 'availableW' | 'addedBackW'>,
  marginW: number,
): number => (
  Math.max(0, offer.availableW - offer.addedBackW + ownChargeWOf(storage) - marginW)
);

/**
 * The measured export a supply or hold period stores instead of exporting, W.
 * The plan follows the solar forecast, so solar it did not expect would
 * otherwise leave the house while the battery waits or holds. Only when the
 * battery owner judged storing worth more than the export
 * (`storesSurplus`), and only a charge: it is a raise past the plan's own
 * (none in these periods), so it comes out of what the consumers ranked below
 * the battery do not take (`StorageSurplusOffer.belowW`), like any surplus
 * raise. Under the deadband it is 0 W, too little to tell from noise. The next
 * plan replans from the level the battery reaches.
 */
const absorbedExportW = (
  storage: ObservedStorageInput,
  plan: ContinuousStoragePlan,
  offer: StorageSurplusOffer,
  marginW: number,
): number => {
  if (plan.reason !== 'supply_house' && plan.reason !== 'hold_energy') return 0;
  if (!plan.storesSurplus) return 0;
  const absorbW = Math.min(storage.chargeCeilingW, offeredChargeW(storage, offer, marginW) - offer.belowW);
  return absorbW < deadbandWFor(storage) ? 0 : absorbW;
};

export const continuousLever = (
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  balance: StorageBalance,
  offer: StorageSurplusOffer,
  nowTs: number,
): StorageLeverState => {
  const plan = storage.continuousPlan;
  if (plan === undefined) throw new Error('A continuous hold requires a battery plan');
  const marginW = drawMarginWFor(storage);
  const importWithoutBatteryW = balance.netImportW - storage.signedPowerW;
  const dischargeRoomW = Math.min(
    Math.max(0, importWithoutBatteryW + exportAllowanceW(plan) - marginW),
    laggingDischargeCeilingW(storage, previous, balance),
  );
  const plannedW = plan.setpointW < 0
    ? -Math.min(plannedDischargeW(plan), storage.deliveryCeilingW, dischargeRoomW)
    : Math.min(plan.setpointW, storage.chargeCeilingW);
  // The offer counts the battery's own discharge out of the export, so there
  // is something to store only once the house needs no supply.
  const absorbW = plannedW <= 0 ? absorbedExportW(storage, plan, offer, marginW) : 0;
  const desiredW = absorbW > 0 ? absorbW : plannedW;
  // Replacing a discharge with charge must first pay back that discharge;
  // it is not measured room for a new charging load.
  const roomCeilingW = balance.headroomW === null
    ? desiredW
    : Math.max(0, storage.signedPowerW + balance.headroomW - marginW);
  const solarCeilingW = plan.reason === 'store_solar' || offer.demandAbove === 'waiting'
    ? offeredChargeW(storage, offer, marginW)
    : storage.chargeCeilingW;
  const boundedW = desiredW > 0
    ? Math.min(desiredW, roomCeilingW, solarCeilingW)
    : desiredW;
  const setpointW = floorStorageSetpointW(Math.max(-storage.deliveryCeilingW, boundedW), storage.range);
  const hold = startContinuousLever(storage, setpointW, nowTs);
  return {
    ...hold,
    continuousReason: plan.reason,
    ...dischargeCredit(storage, previous, setpointW, nowTs),
  };
};

/** The routine policy stores only spare solar, and otherwise keeps the claim at 0 W. */
export function baselineSolarChargeW(
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  offer: Pick<StorageSurplusOffer, 'availableW' | 'addedBackW'>,
  headroomW: number | null,
  nowTs: number,
): number {
  const marginW = drawMarginWFor(storage);
  const offeredW = offeredChargeW(storage, offer, marginW);
  const roomW = headroomW === null
    ? storage.chargeCeilingW
    : Math.max(0, storage.signedPowerW + headroomW - marginW);
  const fundedW = Math.min(storage.chargeCeilingW, offeredW, roomW);
  const targetW = fundedW < deadbandWFor(storage) ? 0 : floorStorageSetpointW(fundedW, storage.range);
  if (previous?.baseline !== true || targetW === 0) return targetW;

  const heldW = Math.max(0, previous.setpointW);
  if (targetW < heldW - marginW) return targetW;
  if (!isRaiseVisible(storage, heldW, targetW)) return heldW;
  return nowTs - previous.chargeRaisedAtMs < SURPLUS_TRACK_STEP_MIN_INTERVAL_MS ? heldW : targetW;
}

export function baselineLever(
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  setpointW: number,
  nowTs: number,
): StorageLeverState {
  const hold = startContinuousLever(storage, setpointW, nowTs);
  return {
    ...hold,
    baseline: true,
    chargeRaisedAtMs: previous?.baseline === true && setpointW <= previous.setpointW
      ? previous.chargeRaisedAtMs
      : nowTs,
    continuousReason: 'store_solar',
  };
}
