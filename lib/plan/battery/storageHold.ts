import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageClaimReason, StorageStateSummary } from './storageReliefTypes';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS, deadbandWFor, ownChargeWOf, ownDischargeWOf, resolveOwnModeChargeAboveHoldW,
} from './storageLadder';

export const resolveOwnModeChargeW = (storage: ObservedStorageInput, preClaimSignedW: number): number => {
  if (storage.continuousPlan !== undefined) return Math.max(0, storage.continuousPlan.setpointW);
  const deadbandW = deadbandWFor(storage);
  if (preClaimSignedW <= -deadbandW) return 0;
  return preClaimSignedW >= deadbandW ? Math.min(preClaimSignedW, storage.chargeCeilingW) : storage.chargeCeilingW;
};

export const claimSurplusLever = (
  storage: ObservedStorageInput,
  setpointW: number,
  nowTs: number,
): StorageLeverState => ({
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

export const resolveClaimReason = (lever: StorageLeverState): StorageClaimReason => {
  if (lever.purpose === 'limit') return lever.setpointW < 0 ? 'relief' : 'charge_limit';
  if (lever.purpose === 'continuous') {
    if (lever.setpointW < 0) return 'plan_supply';
    if (lever.setpointW <= 0) return 'plan_wait';
    return lever.continuousReason === 'store_solar' ? 'plan_solar' : 'plan_charge';
  }
  return lever.setpointW < Math.max(0, lever.preClaimSignedW) ? 'cap_for_device' : 'raise_charge';
};

const resolveHeldBackChargeW = (lever: StorageLeverState): number => (
  resolveClaimReason(lever) === 'charge_limit' ? resolveOwnModeChargeAboveHoldW(lever) : 0
);

const resolveWithheldW = (storage: ObservedStorageInput, setpointW: number): number => (
  Math.max(0, -setpointW, ownDischargeWOf(storage)) + Math.max(0, setpointW - ownChargeWOf(storage))
);

export const toSetpointDecision = (lever: StorageLeverState): StorageDecision => (
  { kind: 'setpoint', setpointW: lever.setpointW, stepW: lever.stepW }
);

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
